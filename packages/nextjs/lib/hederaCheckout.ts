/**
 * Browser half of the Hedera charge rail: 402 → sign a USDC transfer → retry with the
 * credential. Client-only — it reads `localStorage` and the Hedera SDK's browser build.
 *
 * Two signing paths, because the storefront has two kinds of buyer:
 *
 *  - **Connected wallet (push):** the wallet executes the transfer and hands back a
 *    transaction id. The server confirms it on the Mirror Node.
 *  - **Injected burner key (pull):** the browser freezes and signs the transfer locally and
 *    the server submits it with the operator account. No gRPC-web from the page, which is
 *    the fragile part of driving Hedera from a browser, and the buyer still pays the fee
 *    because the frozen transaction id names their account.
 *
 * Either way the server re-reads the transfer from the Mirror Node before issuing a receipt,
 * so a client-supplied hash on its own buys nothing.
 *
 * Account resolution, the burner key and the testnet top-up are shared with the x402 rail
 * and live in `lib/hederaBuyer.ts`.
 */
import {
  type ChargeProgress,
  CheckoutError,
  HEDERA_NETWORK,
  ensureBuyerFunded,
  lookupAccount,
  parseBurnerKey,
  readBurnerKey,
  toBase64,
} from "./hederaBuyer";
import { AccountId, Client, TokenId, type Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { Challenge, Credential } from "mppx";
import { Attribution } from "mppx-hedera";

export { hasBurnerSigner, readBurnerKey } from "./hederaBuyer";
export type { ChargeProgress } from "./hederaBuyer";

export type ChargeSuccess = {
  /** Null only if the server settled the charge but could not resolve the order behind it. */
  orderId: string | null;
  receiptUrl: string | null;
  transactionId: string | null;
  hashscanUrl: string | null;
};

/**
 * Signs and executes the frozen transfer, e.g. a connected WalletConnect wallet, and
 * resolves to the Hedera transaction id. Encoding stays with the caller so it can reuse the
 * app's existing wallet bridge.
 */
export type WalletExecutor = (transaction: Transaction) => Promise<string>;

export type PayWithHederaOptions = {
  productId: string;
  /** Present when a Hedera wallet is connected; takes precedence over the burner key. */
  wallet?: { accountId: string; execute: WalletExecutor };
  onProgress?: ChargeProgress;
};

export class HederaChargeError extends CheckoutError {}

/**
 * Runs the full charge: request the challenge, settle it, retry with the credential.
 * Returns the settled order, or throws a {@link CheckoutError} the UI can render.
 */
export async function payWithHedera({ productId, wallet, onProgress }: PayWithHederaOptions): Promise<ChargeSuccess> {
  const endpoint = `/api/pay?product=${encodeURIComponent(productId)}`;

  onProgress?.("Requesting a payment challenge…");
  const challengeResponse = await fetch(endpoint, { headers: { Accept: "application/json" } });

  if (challengeResponse.status !== 402) {
    throw new HederaChargeError(`Expected a 402 challenge, got HTTP ${challengeResponse.status}.`);
  }
  // `X-MPP-Demo-Mode` names which rail(s) are stubbed, comma-separated (e.g. `stripe`,
  // `hedera`, or `hedera,stripe`). Only bail here when Hedera itself is the stubbed rail —
  // Stripe being unconfigured must not disable a fully configured Hedera settlement path.
  const demoRails = challengeResponse.headers.get("X-MPP-Demo-Mode")?.split(",") ?? [];
  if (demoRails.includes("hedera")) {
    throw new HederaChargeError(
      "This challenge was issued in demo mode, so there is no merchant account to settle against.",
      "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (or HEDERA_RECIPIENT_ID) to enable settlement.",
    );
  }

  // With Stripe configured the same 402 also carries a card challenge; pick ours.
  const challenge = Challenge.fromResponseList(challengeResponse).find(offer => offer.method === "hedera");
  if (!challenge) throw new HederaChargeError("The payment endpoint did not offer a Hedera charge.");
  const request = challenge.request as { amount: string; currency: string; recipient: string };
  const amount = BigInt(request.amount);
  const tokenId = request.currency;

  const memo = Attribution.encode({
    challengeId: challenge.id,
    serverId: challenge.realm ?? "",
  });

  const payload = wallet
    ? await settleWithWallet({ wallet, request, amount, tokenId, memo, onProgress })
    : await settleWithBurner({ request, amount, tokenId, memo, onProgress });

  onProgress?.("Confirming settlement on the Mirror Node…");
  const credential = Credential.from({
    challenge,
    payload: payload.payload,
    source: `did:pkh:hedera:${HEDERA_NETWORK}:${payload.payer}`,
  });

  const settledResponse = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      [Challenge.credentialHeader(challenge)]: Credential.serialize(credential),
    },
  });

  if (settledResponse.status !== 200) {
    const detail = await settledResponse.text();
    throw new HederaChargeError(
      `The server did not accept the payment (HTTP ${settledResponse.status}).`,
      detail.slice(0, 300),
    );
  }

  return (await settledResponse.json()) as ChargeSuccess;
}

type SettleArgs = {
  request: { recipient: string };
  amount: bigint;
  tokenId: string;
  memo: string;
  onProgress?: ChargeProgress;
};

/** Push mode: the connected wallet signs and submits, and returns the transaction id. */
async function settleWithWallet({
  wallet,
  request,
  amount,
  tokenId,
  memo,
  onProgress,
}: SettleArgs & { wallet: NonNullable<PayWithHederaOptions["wallet"]> }) {
  const client = Client.forTestnet();
  try {
    const transaction = buildTransfer({ client, payer: wallet.accountId, request, amount, tokenId, memo });
    onProgress?.("Waiting for the wallet to sign the transfer…");
    const transactionId = await wallet.execute(transaction);
    return { payload: { type: "hash" as const, transactionId }, payer: wallet.accountId };
  } finally {
    client.close();
  }
}

/** Pull mode: sign locally with the injected burner key and let the server submit. */
async function settleWithBurner({ request, amount, tokenId, memo, onProgress }: SettleArgs) {
  const rawKey = readBurnerKey();
  if (!rawKey) {
    throw new HederaChargeError(
      "No Hedera signer available.",
      "Connect a Hedera wallet, or inject a test key at localStorage['burnerWallet.pk'].",
    );
  }

  const key = parseBurnerKey(rawKey);
  onProgress?.("Resolving the buyer account…");
  const evmAddress = `0x${key.publicKey.toEvmAddress()}`;
  const account = await lookupAccount(evmAddress);
  const payer = account.account;

  await ensureBuyerFunded({ key, payer, account, tokenId, amount, onProgress });

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(payer), key);
  try {
    onProgress?.("Signing the USDC transfer…");
    const transaction = buildTransfer({ client, payer, request, amount, tokenId, memo });
    const signed = await transaction.sign(key);
    return { payload: { type: "transaction" as const, transaction: toBase64(signed.toBytes()) }, payer };
  } finally {
    client.close();
  }
}

function buildTransfer({
  client,
  payer,
  request,
  amount,
  tokenId,
  memo,
}: SettleArgs & { client: Client; payer: string }) {
  if (payer === request.recipient) {
    throw new HederaChargeError(
      `Buyer and merchant are the same account (${payer}).`,
      "Set HEDERA_RECIPIENT_ID to a merchant account distinct from the buyer.",
    );
  }
  const token = TokenId.fromString(tokenId);
  const units = Number(amount);
  return (
    new TransferTransaction()
      .addTokenTransfer(token, AccountId.fromString(payer), -units)
      .addTokenTransfer(token, AccountId.fromString(request.recipient), units)
      .setTransactionMemo(memo)
      // Name the transaction id explicitly rather than letting `freezeWith` derive it from
      // the client's operator. The burner path sets an operator, but the wallet path cannot —
      // the key lives in the wallet — so freezing there failed with the SDK's own
      // "`transactionId` must be set or `client` must be provided" before any balance was
      // checked, which made every wallet payment look like a funding problem.
      .setTransactionId(TransactionId.generate(AccountId.fromString(payer)))
      .freezeWith(client)
  );
}
