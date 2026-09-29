/**
 * Buyer-side primitives shared by both browser payment rails.
 *
 * `lib/hederaCheckout.ts` (MPP) and `lib/x402Checkout.ts` (x402) settle different protocols
 * but face the same buyer: a key in `localStorage`, an account that has to be resolved from
 * its EVM alias, and an HTS token the account may not hold or even be associated with yet.
 * That part is protocol-agnostic, so it lives here and neither rail owns it.
 *
 * Client-only — it reads `localStorage` and the Hedera SDK's browser build.
 */
import { AccountId, Client, PrivateKey, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";

export const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";
export const HEDERA_NETWORK = "testnet";

/** Where on-chain validation injects a funded test key. */
const BURNER_KEY_STORAGE_KEY = "burnerWallet.pk";

export type ChargeProgress = (message: string) => void;

/**
 * A failure a buyer can be shown. `hint` carries the actionable half — the variable to set,
 * the account to fund — so the UI can render it under the message instead of in it.
 *
 * Each rail subclasses this so a caller can still tell the two apart, and so a `catch` that
 * only knows about `CheckoutError` keeps the hint either way.
 */
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export type MirrorAccount = {
  account: string;
  balance?: { tokens?: { token_id: string; balance: number }[] };
};

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Resolves a Hedera account id and its token balances. Accepts `0.0.x` or an EVM address. */
export async function lookupAccount(identifier: string): Promise<MirrorAccount> {
  const response = await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${identifier}?limit=1`);
  if (!response.ok) {
    throw new CheckoutError(
      `Mirror Node could not resolve ${identifier} (HTTP ${response.status}).`,
      "The account may not exist on testnet yet — send it some HBAR to create it.",
    );
  }
  return (await response.json()) as MirrorAccount;
}

export function tokenBalance(account: MirrorAccount, tokenId: string): bigint | null {
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
    throw new CheckoutError(
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
