/**
 * Settled-order store.
 *
 * `/api/pay` verifies settlement, `/receipt/[id]` renders it, and the two only share a
 * process — so orders live in memory, keyed by the MPP challenge id. That is enough for a
 * template and for a single `next dev` / `next start` process, and it keeps the storefront
 * bootable with no database and no credentials. Swap `orderStore()` for a real store
 * (Redis, Postgres, `Store.Store` from mppx) before running more than one instance.
 */
import { USDC_TOKEN_ID, hashscanTransactionUrl, mppx } from "./mppx";
import { Challenge } from "mppx";

export type SettledOrder = {
  /** MPP challenge id — also the public order reference in `/receipt/[id]`. */
  id: string;
  productId: string;
  /** Human-readable price as shown in the catalogue, e.g. `"24.00"`. */
  amountUsd: string;
  /** Base-unit amount actually transferred, as recorded in the challenge. */
  amountBaseUnits: string;
  tokenId: string;
  recipient: string;
  /** Hedera transaction id, e.g. `0.0.1234@1758556800.123456789`. */
  transactionId: string;
  hashscanUrl: string;
  /** `did:pkh:hedera:testnet:0.0.x` identifier of the payer, when the credential carries one. */
  payer?: string;
  settledAt: string;
};

// Survives Next.js module reloads in dev so a receipt opened after an edit still resolves.
const globalStore = globalThis as typeof globalThis & { __mppCheckoutOrders?: Map<string, SettledOrder> };

function orders(): Map<string, SettledOrder> {
  // Checked rather than nullish-assigned: a reload can leave a value written by an older
  // shape of this module behind, and a settled purchase must not fail on stale state.
  if (!(globalStore.__mppCheckoutOrders instanceof Map)) {
    globalStore.__mppCheckoutOrders = new Map();
  }
  return globalStore.__mppCheckoutOrders;
}

export function recordOrder(order: SettledOrder): void {
  orders().set(order.id, order);
}

export function findOrder(id: string): SettledOrder | undefined {
  return orders().get(id);
}

/**
 * Records every verified charge. mppx emits `payment.success` only after the Mirror Node
 * confirms the token transfer and the attribution memo binds it to this challenge, so the
 * transaction id here is one the server checked rather than one the client asserted.
 */
export function attachOrderRecorder(): void {
  // The guard lives on the instance, not on a module- or global-scoped flag: a dev reload
  // builds a fresh `mppx` whose listeners are gone, and a flag outside it would suppress
  // re-registration and silently stop recording orders.
  const instance = mppx as typeof mppx & { __orderRecorderAttached?: boolean };
  if (instance.__orderRecorderAttached) return;
  instance.__orderRecorderAttached = true;

  mppx.onPaymentSuccess(context => {
    const meta = Challenge.meta(context.challenge);
    const request = context.challenge.request as {
      amount?: string;
      currency?: string;
      recipient?: string;
    };
    const transactionId = context.receipt.reference;

    recordOrder({
      id: context.challenge.id,
      productId: meta?.product ?? "",
      amountUsd: meta?.amountUsd ?? "",
      amountBaseUnits: request.amount ?? "",
      tokenId: request.currency ?? USDC_TOKEN_ID,
      recipient: request.recipient ?? "",
      transactionId,
      hashscanUrl: hashscanTransactionUrl(transactionId),
      payer: context.credential?.source,
      settledAt: context.receipt.timestamp,
    });
  });
}
