/**
 * x402 comparison endpoint: the same product, amount, token and recipient as `/api/pay`,
 * expressed in the x402 protocol instead of MPP.
 *
 * Unpaid requests answer 402 with an x402 **v2** payment-required declaration. Three things
 * about v2 are easy to get wrong, and all three make the challenge unpayable by a real client:
 *
 *  1. The declaration travels in the `PAYMENT-REQUIRED` **header**, base64-encoded, not in the
 *     body. `@x402/core`'s `getPaymentRequiredResponse` only falls back to the body for
 *     `x402Version: 1`; a v2 body with no header fails as `Invalid payment required response`.
 *     The body is still served — it is what makes the rail inspectable with `curl` — but it is
 *     a copy, not the contract.
 *  2. The offer field is `amount`, not v1's `maxAmountRequired`, and `resource` is a
 *     `ResourceInfo` object at the top level rather than a URL string inside `accepts[]`.
 *     `description` and `mimeType` move onto that object with it.
 *  3. `accepts[].extra.feePayer` is mandatory for Hedera `exact`: `@x402/hedera`'s client
 *     signer throws without it, because the buyer's transfer has to carry the facilitator's
 *     account as the transaction-id payer for fees to be sponsored. It comes from the matching
 *     `/supported` kind (see `x402Capability()`), never from local config.
 *
 * A paid retry carries `PAYMENT-SIGNATURE` (v2's header; `X-PAYMENT` is v1's and is accepted as
 * an alias). The route checks the echoed `accepted` against its own offer, then runs the
 * facilitator's `POST /verify` and `POST /settle`. On success it returns the resource with the
 * settlement in `PAYMENT-RESPONSE` (and `X-PAYMENT-RESPONSE` for older clients), and records
 * the payment in `lib/orders.ts` so it shows up on `/receipt/[id]` beside MPP charges.
 *
 * `demo: true` and `X-MPP-Demo-Mode: x402` mark the challenge whenever `canSettleX402()` is
 * false (no facilitator configured, or it is unreachable or does not list `exact` on
 * Hedera). Browsers (`Accept: text/html`) then get a disabled demo panel, matching the card
 * rail's on `/api/pay`. In demo mode a payment header is ignored and the challenge reissued,
 * exactly as `/api/pay` strips credentials for a rail that cannot settle.
 */
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { USDC_DECIMALS, USDC_TOKEN_ID, chargeRecipient, hashscanTransactionUrl } from "~~/lib/mppx";
import { recordX402Order } from "~~/lib/orders";
import { Product, findProduct, products } from "~~/lib/products";
import {
  X402_NETWORK,
  X402_SCHEME,
  X402_VERSION,
  canSettleX402,
  settlePayment,
  toBaseUnits,
  verifyPayment,
  x402Capability,
} from "~~/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TIMEOUT_SECONDS = 30;

/** v2's payment header. `X-PAYMENT` is v1's, accepted so a v1-era client still gets a verdict. */
const PAYMENT_HEADERS = ["PAYMENT-SIGNATURE", "X-PAYMENT"] as const;

/** Escapes text interpolated into `renderX402DemoPanel`'s HTML. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Canonical URL of the thing being sold — the `resource.url` buyers and facilitators see. */
function resourceUrl(request: Request, product: Product): string {
  const origin = new URL(request.url).origin;
  return `${origin}/api/x402?product=${encodeURIComponent(product.id)}`;
}

/**
 * The single `accepts[]` entry: the Hedera rail's offer, in x402 v2's vocabulary. `extra` is
 * the facilitator's own `/supported` metadata (`feePayer`), which the client signer requires.
 */
function paymentRequirements(product: Product, extra: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    amount: toBaseUnits(product.priceUsd, USDC_DECIMALS),
    asset: USDC_TOKEN_ID,
    payTo: chargeRecipient(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra,
  };
}

/** The complete v2 declaration: one offer, plus the resource it buys. */
function paymentRequired(
  request: Request,
  product: Product,
  extra: Record<string, unknown>,
  error?: string,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: {
      url: resourceUrl(request, product),
      description: `402 Checkout - ${product.name}`,
      mimeType: "application/json",
      serviceName: "402 Checkout",
    },
    accepts: [paymentRequirements(product, extra)],
  };
}

/**
 * 402 carrying the declaration in both places a client might look: the `PAYMENT-REQUIRED`
 * header (what `@x402/core` actually parses) and the JSON body (what a human reading `curl`
 * output reads). `demo: true` is body-only — it is this template's own annotation, not part of
 * the x402 wire format, so it never reaches the header a real client parses.
 */
function challengeResponse(declaration: PaymentRequired, demo: boolean, demoReason?: string): Response {
  const headers = new Headers({
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(declaration),
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
  });
  if (demo) headers.set("X-MPP-Demo-Mode", "x402");
  return Response.json(
    { ...declaration, ...(demo ? { demo: true, ...(demoReason ? { demoReason } : {}) } : {}) },
    { status: 402, headers },
  );
}

/**
 * Plain fallback page for `Accept: text/html` when the x402 rail is in demo mode — the x402
 * twin of `/api/pay`'s card demo panel. States demo mode and why, names the variable that
 * turns the rail on, and disables the pay control so it cannot pass for a working form.
 */
function renderX402DemoPanel(product: Product, reason: string, headers: Headers): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>402 Checkout — x402 demo mode</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
      .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: #eee; color: #555; border-radius: 999px; padding: 0.15rem 0.6rem; margin-bottom: 1rem; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; margin: 1rem 0; }
      dt { color: #666; }
      dd { margin: 0; font-weight: 600; }
      code { background: #f0f0f0; padding: 0.1rem 0.35rem; border-radius: 0.25rem; font-size: 0.85em; }
      button { width: 100%; padding: 0.75rem; font-size: 1rem; border-radius: 0.5rem; border: none; background: #ccc; color: #666; cursor: not-allowed; margin-top: 1rem; }
      p.note { font-size: 0.85rem; color: #666; }
    </style>
  </head>
  <body>
    <span class="badge">demo mode</span>
    <h1>x402 payment</h1>
    <dl>
      <dt>Item</dt>
      <dd>${escapeHtml(product.name)}</dd>
      <dt>Amount</dt>
      <dd>${escapeHtml(product.priceUsd)} USDC</dd>
      <dt>Network</dt>
      <dd>${escapeHtml(X402_NETWORK)}</dd>
    </dl>
    <button type="button" disabled>Pay with x402</button>
    <p class="note">
      Running in <strong>demo mode</strong> — ${escapeHtml(reason)}. Set
      <code>AX402_FACILITATOR_URL</code> in <code>packages/nextjs/.env</code> to a facilitator
      that lists <code>${X402_SCHEME}</code> on <code>${escapeHtml(X402_NETWORK)}</code> to enable this rail.
    </p>
  </body>
</html>`;
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 402, headers });
}

/** The payment payload a request carries, or `null` if it carries none. Throws if it is unreadable. */
function readPaymentPayload(request: Request): PaymentPayload | null {
  for (const name of PAYMENT_HEADERS) {
    const value = request.headers.get(name);
    if (value) return decodePaymentSignatureHeader(value.trim());
  }
  return null;
}

/**
 * The buyer echoes back the offer they are paying against, so every field that decides where
 * the money goes has to be checked against the offer this server actually made. An unchecked
 * `accepted` lets a client name its own `amount` or `payTo` and have the facilitator honour it.
 * `extra` is excluded on purpose — it is facilitator metadata the client is allowed to relay.
 */
function mismatchedField(accepted: PaymentRequirements | undefined, offered: PaymentRequirements): string | null {
  if (!accepted) return "accepted";
  const fields = ["scheme", "network", "amount", "asset", "payTo"] as const;
  return fields.find(field => accepted[field] !== offered[field]) ?? null;
}

/**
 * 200 with the purchased resource, and the settlement in the header a client reads it from.
 *
 * The settlement is recorded in the shared order store first, so the buyer gets an order
 * reference back in the body and `/receipt/[id]` can render the payment exactly as it renders
 * an MPP one. `orderId`/`receiptUrl` are this template's own additions to the resource — the
 * protocol's own record of the payment is the `PAYMENT-RESPONSE` header, which is unchanged.
 */
function settledResponse(product: Product, offered: PaymentRequirements, settlement: SettleResponse): Response {
  const receipt = encodePaymentResponseHeader(settlement);
  const orderId = settlement.transaction
    ? recordX402Order({
        productId: product.id,
        amountUsd: product.priceUsd,
        amountBaseUnits: offered.amount,
        tokenId: offered.asset,
        recipient: offered.payTo,
        transactionId: settlement.transaction,
        payer: settlement.payer,
      })
    : null;
  return Response.json(
    {
      product: { id: product.id, name: product.name, priceUsd: product.priceUsd },
      payer: settlement.payer ?? null,
      transactionId: settlement.transaction,
      hashscanUrl: settlement.transaction ? hashscanTransactionUrl(settlement.transaction) : null,
      network: settlement.network,
      orderId,
      receiptUrl: orderId ? `/receipt/${orderId}` : null,
    },
    {
      headers: {
        "PAYMENT-RESPONSE": receipt,
        // x402 v1's spelling. `@x402/core` reads either, older clients only this one.
        "X-PAYMENT-RESPONSE": receipt,
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
      },
    },
  );
}

async function handlePayment(request: Request): Promise<Response> {
  const requestedId = new URL(request.url).searchParams.get("product") ?? "";
  // Same fallback as `/api/pay`: an unknown id serves the first fixture, never a 404.
  const product = findProduct(requestedId) ?? products[0];
  const capability = await x402Capability();
  const live = await canSettleX402();

  if (!live) {
    // No facilitator, so no `feePayer` to advertise: the offer is well-formed and inspectable
    // but not payable, which is what demo mode means on every other rail too.
    const declaration = paymentRequired(request, product, {}, "payment is required");
    const reason = capability.live ? "the facilitator cannot settle yet" : capability.reason;
    const wantsHtml = request.headers.get("Accept")?.includes("text/html") ?? false;
    if (wantsHtml) {
      const headers = new Headers({ "X-MPP-Demo-Mode": "x402", "Cache-Control": "no-store" });
      headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(declaration));
      return renderX402DemoPanel(product, reason, headers);
    }
    // Carry the reason in the JSON too. Without it a caller only learns the rail is in demo
    // mode, and the obvious guess — "the facilitator URL is unset" — is wrong whenever the
    // probe failed for any other cause.
    return challengeResponse(declaration, true, reason);
  }

  const extra = capability.live ? capability.extra : {};
  const offered = paymentRequirements(product, extra);

  let payload: PaymentPayload | null;
  try {
    payload = readPaymentPayload(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return challengeResponse(paymentRequired(request, product, extra, `unreadable payment header: ${detail}`), false);
  }

  if (!payload) {
    return challengeResponse(paymentRequired(request, product, extra, "payment is required"), false);
  }

  if (payload.x402Version !== X402_VERSION) {
    const error = `this resource speaks x402 v${X402_VERSION}; received a v${payload.x402Version} payload`;
    return challengeResponse(paymentRequired(request, product, extra, error), false);
  }

  const mismatch = mismatchedField(payload.accepted, offered);
  if (mismatch) {
    const error = `payment payload does not match the offer (\`${mismatch}\`)`;
    return challengeResponse(paymentRequired(request, product, extra, error), false);
  }

  // The facilitator is checked against the *server's* offer, never the client's echo of it.
  let verification;
  try {
    verification = await verifyPayment(payload, offered);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "facilitator_unavailable", detail }, { status: 502 });
  }
  if (!verification.isValid) {
    const reason = verification.invalidMessage ?? verification.invalidReason ?? "payment is not valid";
    return challengeResponse(paymentRequired(request, product, extra, reason), false);
  }

  let settlement: SettleResponse;
  try {
    settlement = await settlePayment(payload, offered);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "settlement_failed", detail }, { status: 502 });
  }
  if (!settlement.success) {
    const reason = settlement.errorMessage ?? settlement.errorReason ?? "settlement failed";
    return challengeResponse(paymentRequired(request, product, extra, reason), false);
  }

  return settledResponse(product, offered, settlement);
}

export const GET = handlePayment;
export const POST = handlePayment;
