/**
 * The buyer-side primitives the pay buttons need at render time.
 *
 * Split out so the buttons can be statically imported without dragging
 * `@hiero-ledger/sdk` — protobufjs, `long`, elliptic — into the first load of `/checkout` for
 * every visitor before anyone has clicked anything. Nothing here imports an SDK; the
 * settlement code behind the buttons loads on click.
 */

export const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";
export const HEDERA_NETWORK = "testnet";

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
