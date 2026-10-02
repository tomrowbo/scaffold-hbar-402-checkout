/**
 * Buyer-side primitives that need the Hedera SDK.
 *
 * `lib/hederaCheckout.ts` (MPP) and `lib/x402Checkout.ts` (x402) settle different protocols
 * but face the same buyer: a key in `localStorage`, an account that has to be resolved from
 * its EVM alias, and an HTS token the account may not hold or even be associated with yet.
 * That part is protocol-agnostic, so it lives here and neither rail owns it.
 *
 * The SDK-free half is in `lib/checkoutCommon.ts` and re-exported below, so callers keep one
 * import. Anything rendered before a click should import from that module directly — pulling
 * it through here drags `@hiero-ledger/sdk` into the bundle with it.
 *
 * Client-only — it reads `localStorage` and the Hedera SDK's browser build.
 */
import {
  type ChargeProgress,
  CheckoutError,
  type MirrorAccount,
  lookupAccount,
  toBase64,
  tokenBalance,
} from "./checkoutCommon";
import { AccountId, Client, PrivateKey, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";

export {
  CheckoutError,
  HEDERA_NETWORK,
  MIRROR_NODE_URL,
  hasBurnerSigner,
  lookupAccount,
  readBurnerKey,
  toBase64,
  tokenBalance,
} from "./checkoutCommon";
export type { ChargeProgress, MirrorAccount } from "./checkoutCommon";

export function parseBurnerKey(raw: string): PrivateKey {
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
 *
 * `amount` is the charge this buyer is about to pay. Without it the faucet has to assume the
 * priciest item in the catalogue, which fails on an operator that could comfortably cover
 * the item actually being bought.
 */
async function topUpBuyer(args: {
  accountId: string;
  tokenId: string;
  amount: bigint;
  associateTransaction?: string;
  onProgress?: ChargeProgress;
}) {
  args.onProgress?.("Topping up the test buyer from the operator account…");
  const response = await fetch("/api/testnet/fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: args.accountId,
      amount: String(args.amount),
      associateTransaction: args.associateTransaction,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!response.ok) {
    // The server's detail is already a complete sentence aimed at a human, so do not wrap it
    // in a second one. The hint stays short: anything longer belongs in the README.
    throw new CheckoutError(
      body.detail ?? body.error ?? `Could not fund the test buyer (${response.statusText}).`,
      `Nothing was charged. See "Getting testnet USDC" in the README.`,
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
 * Makes sure the buyer holds enough of `tokenId` to cover `amount`, associating the token
 * first when the account has never held it.
 *
 * A Hedera account must associate an HTS token before it can hold it, and a freshly funded
 * test signer holds HBAR only. The association is signed here, in the browser, and relayed
 * through the server's testnet faucet so the page never needs gRPC-web — the same split the
 * MPP rail uses for the transfer itself.
 */
export async function ensureBuyerFunded(args: {
  key: PrivateKey;
  payer: string;
  /** Mirror Node snapshot of the buyer, already fetched by the caller. */
  account: MirrorAccount;
  tokenId: string;
  amount: bigint;
  onProgress?: ChargeProgress;
}): Promise<void> {
  const balance = tokenBalance(args.account, args.tokenId);
  if (balance !== null && balance >= args.amount) return;

  let associateTransaction: string | undefined;
  if (balance === null) {
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(args.payer), args.key);
    try {
      const signed = await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(args.payer))
        .setTokenIds([TokenId.fromString(args.tokenId)])
        .freezeWith(client)
        .sign(args.key);
      associateTransaction = toBase64(signed.toBytes());
    } finally {
      client.close();
    }
  }

  await topUpBuyer({
    accountId: args.payer,
    tokenId: args.tokenId,
    amount: args.amount,
    associateTransaction,
    onProgress: args.onProgress,
  });
  await waitForBalance({
    accountId: args.payer,
    tokenId: args.tokenId,
    amount: args.amount,
    onProgress: args.onProgress,
  });
}
