/**
 * Settled-order store.
 *
 * `/api/pay` and `/api/x402` verify settlement, `/receipt/[id]` renders it, and they only
 * share a process — so orders live in memory. That is enough for a template and for a single
 * `next dev` / `next start` process, and it keeps the storefront bootable with no database
 * and no credentials. Swap `orders()` for a real store (Redis, Postgres, `Store.Store` from
 * mppx) before running more than one instance.
 *
 * Both protocols land in the same map, but they bring different keys. An MPP order is keyed
 * by its challenge id, which is the reference the buyer already holds. x402 has no such
 * id — a payment is identified by the transaction the facilitator broadcast, and nothing in
 * the protocol is reused as an order reference — so `recordX402Order` mints one.
 */
import { USDC_TOKEN_ID, hashscanTransactionUrl, onMppxInstance } from "./mppx";
import { Challenge } from "mppx";
import { randomUUID } from "node:crypto";

export type SettledOrder = {
  /** Public order reference in `/receipt/[id]`: an MPP challenge id, or a minted `x402_…`. */
  id: string;
  /** How it settled: MPP's `"hedera"` or `"stripe"`, or `"x402"` for the x402 rail. */
  method: OrderMethod;
  productId: string;
  /** Human-readable price as shown in the catalogue, e.g. `"0.75"`. */
  amountUsd: string;
  /** Base-unit amount actually transferred, as recorded in the challenge. */
  amountBaseUnits: string;
  tokenId: string;
  recipient: string;
  /** Hedera transaction id (`0.0.1234@1758556800.123456789`) or Stripe PaymentIntent id. */
  transactionId: string;
  /** Null for card payments — there is no ledger transaction to link to. */
  hashscanUrl: string | null;
  /** The payer: `did:pkh:hedera:testnet:0.0.x` from an MPP credential, or a bare x402 account id. */
  payer?: string;
  settledAt: string;
};

export type OrderMethod = "hedera" | "stripe" | "x402";

/** True when the order settled as a token transfer on Hedera, whichever protocol carried it. */
export function isOnChain(method: OrderMethod): boolean {
  return method === "hedera" || method === "x402";
}

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
 * confirms the token transfer and the attribution memo binds it to this challenge (or, for
 * cards, after Stripe confirms the PaymentIntent), so the reference here is one the server
 * checked rather than one the client asserted.
 *
 * Attached through `onMppxInstance` rather than to the default instance, because there is one
 * mppx instance per realm (see `lib/mppx.ts`) and the realm follows the request's `Host`
 * header. Listening on the default instance alone records nothing whenever the app is served
 * from anything other than `MPP_REALM`.
 */
export function attachOrderRecorder(): void {
  onMppxInstance(mppxInstance => {
    // The guard lives on the instance, not on a module- or global-scoped flag: a dev reload
    // builds fresh instances whose listeners are gone, and a flag outside them would suppress
    // re-registration and silently stop recording orders.
    const instance = mppxInstance as typeof mppxInstance & { __orderRecorderAttached?: boolean };
    if (instance.__orderRecorderAttached) return;
    instance.__orderRecorderAttached = true;

    instance.onPaymentSuccess(context => {
      const method = context.challenge.method as OrderMethod;
      const meta = Challenge.meta(context.challenge);
      const request = context.challenge.request as {
        amount?: string;
        currency?: string;
        recipient?: string;
      };
      const transactionId = context.receipt.reference;

      recordOrder({
        id: context.challenge.id,
        method,
        productId: meta?.product ?? "",
        amountUsd: meta?.amountUsd ?? "",
        amountBaseUnits: request.amount ?? "",
        tokenId: request.currency ?? (method === "hedera" ? USDC_TOKEN_ID : ""),
        recipient: request.recipient ?? "",
        transactionId,
        hashscanUrl: isOnChain(method) ? hashscanTransactionUrl(transactionId) : null,
        payer: context.credential?.source,
        settledAt: context.receipt.timestamp,
      });
    });
  });
}

/**
 * Records a settled x402 payment, which reaches the store by a different route than an MPP
 * charge does.
 *
 * MPP orders arrive through `mppx.onPaymentSuccess` above, after mppx has verified the
 * transfer itself. x402 has no such hook: `/api/x402` asks the facilitator to `POST /settle`
 * and the facilitator is the one that broadcasts and confirms the transfer, so the route
 * calls this directly with the `SettleResponse` it got back. Both are server-side records of
 * a settlement somebody checked — neither is a client assertion.
 *
 * The id is minted here because x402 has nothing to key on: its transaction id contains `@`
 * and `.`, which makes an unfriendly receipt URL, and there is no challenge id to reuse.
 *
 * @returns The order reference to send the buyer to, at `/receipt/{id}`.
 */
export function recordX402Order(settlement: {
  productId: string;
  amountUsd: string;
  amountBaseUnits: string;
  tokenId: string;
  recipient: string;
  transactionId: string;
  payer?: string;
}): string {
  const id = `x402_${randomUUID()}`;
  recordOrder({
    id,
    method: "x402",
    productId: settlement.productId,
    amountUsd: settlement.amountUsd,
    amountBaseUnits: settlement.amountBaseUnits,
    tokenId: settlement.tokenId,
    recipient: settlement.recipient,
    transactionId: settlement.transactionId,
    hashscanUrl: hashscanTransactionUrl(settlement.transactionId),
    payer: settlement.payer,
    settledAt: new Date().toISOString(),
  });
  return id;
}
