/**
 * The half of the buyer-side primitives that needs no SDK.
 *
 * Split out of `lib/hederaBuyer.ts` for one reason: the pay buttons need `CheckoutError` and
 * `hasBurnerSigner` at render time, and importing them from a module that also pulls in
 * `@hiero-ledger/sdk` put the whole Hedera SDK — protobufjs, `long`, elliptic — into the
 * first load of `/checkout`, for every visitor, before anyone had clicked anything. Nothing
 * here imports an SDK, so the buttons can stay statically imported while the settlement code
 * behind them loads on click.
 *
 * Client-only — `readBurnerKey` touches `localStorage`.
 */

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
