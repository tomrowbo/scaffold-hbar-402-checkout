/**
 * x402 comparison endpoint: the same product, amount, token and recipient as `/api/pay`,
 * expressed in the x402 protocol instead of MPP.
 *
 * Unpaid requests answer 402 with an x402 v2 payment-required body — the offer lives in
 * `accepts[]`, not in a `WWW-Authenticate` header. `payTo`, `asset` and the base-unit amount
 * come from `lib/mppx.ts`, so the protocol envelope is the only thing that differs between
 * the two endpoints.
 *
 * `demo: true` and `X-MPP-Demo-Mode: x402` mark the challenge whenever `canSettleX402()` is
 * false (no facilitator configured, or it is unreachable or does not list `exact` on
 * Hedera). Browsers (`Accept: text/html`) then get a disabled demo panel, matching the card
 * rail's on `/api/pay`.
 *
 * Settlement (`POST /verify` + `POST /settle` against the facilitator, and a buyer-side
 * signing flow for the `exact` scheme on Hedera) is not wired in this template. A retried
 * request carrying `X-PAYMENT` against a live facilitator gets 501 rather than a receipt, so
 * nothing ever reports a payment this server did not verify.
 */
import { USDC_DECIMALS, USDC_TOKEN_ID, chargeRecipient } from "~~/lib/mppx";
import { Product, findProduct, products } from "~~/lib/products";
import { X402_NETWORK, X402_SCHEME, X402_VERSION, canSettleX402, toBaseUnits, x402Capability } from "~~/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TIMEOUT_SECONDS = 60;

/** Escapes text interpolated into `renderX402DemoPanel`'s HTML. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The single `accepts[]` entry: the Hedera rail's offer, in x402's vocabulary. */
function paymentRequirements(request: Request, product: Product) {
  const origin = new URL(request.url).origin;
  return {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    maxAmountRequired: toBaseUnits(product.priceUsd, USDC_DECIMALS),
    resource: `${origin}/api/x402?product=${encodeURIComponent(product.id)}`,
    description: `MPP Checkout — ${product.name}`,
    mimeType: "application/json",
    payTo: chargeRecipient(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: USDC_TOKEN_ID,
  };
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
    <title>MPP Checkout — x402 demo mode</title>
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

async function handlePayment(request: Request): Promise<Response> {
  const requestedId = new URL(request.url).searchParams.get("product") ?? "";
  // Same fallback as `/api/pay`: an unknown id serves the first fixture, never a 404.
  const product = findProduct(requestedId) ?? products[0];
  const accepts = [paymentRequirements(request, product)];
  const live = await canSettleX402();

  if (live && request.headers.has("X-PAYMENT")) {
    return Response.json(
      {
        x402Version: X402_VERSION,
        error: "x402 settlement is not implemented in this template; the challenge is served for comparison only",
        accepts,
      },
      { status: 501 },
    );
  }

  // In demo mode an `X-PAYMENT` header is ignored and the challenge reissued, as `/api/pay`
  // strips credentials for a rail that cannot settle.
  const headers = new Headers();
  if (!live) headers.set("X-MPP-Demo-Mode", "x402");

  const wantsHtml = request.headers.get("Accept")?.includes("text/html") ?? false;
  if (!live && wantsHtml) {
    const capability = await x402Capability();
    const reason = capability.live ? "the facilitator cannot settle yet" : capability.reason;
    return renderX402DemoPanel(product, reason, headers);
  }

  return Response.json(
    {
      x402Version: X402_VERSION,
      error: "X-PAYMENT header is required",
      accepts,
      ...(live ? {} : { demo: true }),
    },
    { status: 402, headers },
  );
}

export const GET = handlePayment;
export const POST = handlePayment;
