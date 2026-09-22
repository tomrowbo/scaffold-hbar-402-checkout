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
 */
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  type Transaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Challenge, Credential } from "mppx";
import { Attribution } from "mppx-hedera";

const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";
const HEDERA_NETWORK = "testnet";

/** Where on-chain validation injects a funded test key. */
const BURNER_KEY_STORAGE_KEY = "burnerWallet.pk";

export type ChargeProgress = (message: string) => void;

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

export class HederaChargeError extends Error {
  constructor(
    message: string,
    /** Set when the failure is one the buyer can act on, e.g. an unfunded account. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "HederaChargeError";
  }
}

type MirrorAccount = {
  account: string;
  balance?: { tokens?: { token_id: string; balance: number }[] };
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Resolves a Hedera account id and its token balances. Accepts `0.0.x` or an EVM address. */
async function lookupAccount(identifier: string): Promise<MirrorAccount> {
  const response = await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${identifier}?limit=1`);
  if (!response.ok) {
    throw new HederaChargeError(
      `Mirror Node could not resolve ${identifier} (HTTP ${response.status}).`,
      "The account may not exist on testnet yet — send it some HBAR to create it.",
    );
  }
  return (await response.json()) as MirrorAccount;
}

function tokenBalance(account: MirrorAccount, tokenId: string): bigint | null {
  const entry = account.balance?.tokens?.find(token => token.token_id === tokenId);
  return entry ? BigInt(entry.balance) : null;
}

export function readBurnerKey(): string | null {
  try {
    const raw = window.localStorage.getItem(BURNER_KEY_STORAGE_KEY);
    return raw?.trim() ? raw.trim().replace(/^"|"$/g, "") : null;
  } catch {
    // Private browsing or a blocked storage partition — treat as "no burner".
    return null;
  }
}

/** True when this browser can pay without a connected wallet. */
export function hasBurnerSigner(): boolean {
  return readBurnerKey() !== null;
}

function parseBurnerKey(raw: string): PrivateKey {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  try {
    return PrivateKey.fromStringECDSA(hex);
  } catch {
    return PrivateKey.fromStringED25519(hex);
  }
}

/**
 * Tops the buyer up from the operator account so a fresh test signer — which validation
 * funds with HBAR only — can actually pay a USDC-denominated charge. Testnet only, and a
 * no-op unless the server has operator credentials.
 */
async function topUpBuyer(args: {
  accountId: string;
  tokenId: string;
  associateTransaction?: string;
  onProgress?: ChargeProgress;
}) {
  args.onProgress?.("Topping up the test buyer from the operator account…");
  const response = await fetch("/api/testnet/fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: args.accountId, associateTransaction: args.associateTransaction }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!response.ok) {
    throw new HederaChargeError(
      `Could not fund the test buyer: ${body.detail ?? body.error ?? response.statusText}`,
      `Send token ${args.tokenId} to ${args.accountId} on testnet, or set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY.`,
    );
  }
}

/**
 * Waits for a top-up to show up on the Mirror Node, which lags consensus by a second or two,
 * then gives up quietly. A stale read is not grounds to refuse the purchase — the transfer
 * itself is the authoritative check, and it fails loudly if the funds really are missing.
 */
async function waitForBalance(args: {
  accountId: string;
  tokenId: string;
  amount: bigint;
  onProgress?: ChargeProgress;
}) {
  args.onProgress?.("Waiting for the Mirror Node to index the top-up…");
  for (let attempt = 0; attempt < 8; attempt++) {
    const account = await lookupAccount(args.accountId);
    if ((tokenBalance(account, args.tokenId) ?? 0n) >= args.amount) return;
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
}

/**
 * Runs the full charge: request the challenge, settle it, retry with the credential.
 * Returns the settled order, or throws a {@link HederaChargeError} the UI can render.
 */
export async function payWithHedera({ productId, wallet, onProgress }: PayWithHederaOptions): Promise<ChargeSuccess> {
  const endpoint = `/api/pay?product=${encodeURIComponent(productId)}`;

  onProgress?.("Requesting a payment challenge…");
  const challengeResponse = await fetch(endpoint, { headers: { Accept: "application/json" } });

  if (challengeResponse.status !== 402) {
    throw new HederaChargeError(`Expected a 402 challenge, got HTTP ${challengeResponse.status}.`);
  }
  if (challengeResponse.headers.get("X-MPP-Demo-Mode")) {
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

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(payer), key);

  try {
    // A Hedera account must associate an HTS token before it can hold it, and a freshly
    // funded test signer holds HBAR only. Sign the association locally and let the server
    // submit it together with the top-up.
    const balance = tokenBalance(account, tokenId);
    if (balance === null || balance < amount) {
      const associateTransaction =
        balance === null
          ? toBase64(
              (
                await new TokenAssociateTransaction()
                  .setAccountId(AccountId.fromString(payer))
                  .setTokenIds([TokenId.fromString(tokenId)])
                  .freezeWith(client)
                  .sign(key)
              ).toBytes(),
            )
          : undefined;

      await topUpBuyer({ accountId: payer, tokenId, associateTransaction, onProgress });
      await waitForBalance({ accountId: payer, tokenId, amount, onProgress });
    }

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
  return new TransferTransaction()
    .addTokenTransfer(token, AccountId.fromString(payer), -units)
    .addTokenTransfer(token, AccountId.fromString(request.recipient), units)
    .setTransactionMemo(memo)
    .freezeWith(client);
}
