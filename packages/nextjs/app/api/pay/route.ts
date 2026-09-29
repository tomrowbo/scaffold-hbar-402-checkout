/**
 * Checkout charge endpoint: one 402 for every configured rail.
 *
 * Unpaid requests answer 402 with a `WWW-Authenticate: Payment` challenge naming
 * `method="hedera", intent="charge"` and one naming `method="stripe"`. Browsers
 * (`Accept: text/html`) get mppx's Stripe Elements card form instead of JSON when Stripe is
 * configured. Without real Stripe credentials there is no publishable key to mount that form
 * against, so `lib/mppx.ts` configures no `html` for the demo `stripe/charge` method and this
 * route renders a plain, disabled demo panel in its place — an honestly stubbed card rail,
 * not a live-looking form that silently cannot submit.
 *
 * `X-MPP-Demo-Mode` names which rail(s) are stubbed (`hedera`, `stripe`, or both) so a
 * client settling one rail is never blocked by the other rail's demo mode.
 *
 * Hedera: the buyer transfers USDC with the 32-byte attribution memo from the challenge and
 * retries with `Authorization: Payment <credential>`; mppx-hedera confirms the transfer
 * against the Mirror Node. Stripe: the credential carries a Shared Payment Token and mppx
 * confirms a PaymentIntent. Either way the route then returns 200 with `Payment-Receipt`.
 */
import { Credential } from "mppx";
import { USDC_DECIMALS, USDC_TOKEN_ID, canSettle, charge, chargeRecipient, stripeDemoMode } from "~~/lib/mppx";
import { attachOrderRecorder, findOrder } from "~~/lib/orders";
import { Product, findProduct, products } from "~~/lib/products";

/** mppx-hedera settles through the Hedera SDK and the Mirror Node REST API. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

attachOrderRecorder();

/**
 * Drops the payment credential so mppx issues a fresh challenge instead of verifying it.
 * Used only in demo mode, where the recipient is a placeholder and there is nothing on
 * chain to verify — the protocol stays inspectable, settlement is the part that is stubbed.
 */
function withoutCredential(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("payment-authorization");
  return new Request(request.url, { method: request.method, headers });
}

/**
 * Flags a challenge as demo-issued without touching status or `WWW-Authenticate`. The value
 * names which rail(s) are stubbed, so a client settling one rail is not blocked by the other
 * rail's demo mode — Stripe being unconfigured must not disable Hedera settlement, and vice
 * versa (see AGENTS.md's per-integration rule).
 */
function markDemoMode(response: Response, rails: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set("X-MPP-Demo-Mode", rails.join(","));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Method named by the request's payment credential, if it carries a parseable one. */
function credentialMethod(request: Request): string | null {
  try {
    return Credential.fromRequest(request).challenge.method;
  } catch {
    return null;
  }
}

/** Escapes text interpolated into `renderStripeDemoPanel`'s HTML. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The three variables that switch the card rail on, per `hasStripe()` in `lib/demo.ts`. */
const STRIPE_ENV_VARS = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_NETWORK_ID"];

/**
 * Plain fallback page for `Accept: text/html` when the card rail is in demo mode.
 *
 * `lib/mppx.ts` configures no `html` for the demo `stripe/charge` method — there is no
 * publishable key to mount Stripe Elements against — so mppx has no HTML to render for this
 * challenge. Render an honest, inert panel instead of leaving the browser with nothing: it
 * states demo mode, names the env vars that turn it on, and disables the pay control so it
 * cannot be mistaken for a working form. Reuses `challenge`'s headers (`WWW-Authenticate`
 * included) so the protocol stays inspectable even through this page.
 */
function renderStripeDemoPanel(challenge: Response, product: Product): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>402 Checkout — demo mode</title>
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
    <h1>Card payment</h1>
    <dl>
      <dt>Item</dt>
      <dd>${escapeHtml(product.name)}</dd>
      <dt>Amount</dt>
      <dd>$${escapeHtml(product.priceUsd)} USD</dd>
    </dl>
    <button type="button" disabled>Pay</button>
    <p class="note">
      Running in <strong>demo mode</strong> — there is no publishable key to mount a real
      card form. Set
      ${STRIPE_ENV_VARS.map(name => `<code>${name}</code>`).join(", ")}
      in <code>packages/nextjs/.env</code> to enable this rail.
    </p>
  </body>
</html>`;
  const headers = new Headers(challenge.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: challenge.status, statusText: challenge.statusText, headers });
}

async function handlePayment(request: Request): Promise<Response> {
  const requestedId = new URL(request.url).searchParams.get("product") ?? "";
  // An unknown id falls back to the first fixture rather than 404-ing, so the endpoint is
  // always inspectable — `/api/pay` on its own returns a valid challenge.
  const product = findProduct(requestedId) ?? products[0];
  const demoMode = !canSettle();
  const cardDemoMode = stripeDemoMode();
  // Each rail's demo mode strips only its own credentials: the placeholder card offer can
  // never settle, and Hedera's demo mode must not swallow a card credential when Stripe is live.
  const isCardCredential = credentialMethod(request) === "stripe";
  const stripCredential = isCardCredential ? cardDemoMode : demoMode;

  let result;
  try {
    result = await charge({
      amount: product.priceUsd,
      currency: USDC_TOKEN_ID,
      decimals: USDC_DECIMALS,
      recipient: chargeRecipient(),
      description: `402 Checkout — ${product.name}`,
      meta: { product: product.id, amountUsd: product.priceUsd },
    })(stripCredential ? withoutCredential(request) : request);
  } catch (error) {
    // Settlement verification can fail for reasons outside the protocol (Mirror Node
    // unreachable, token not associated). Report it as JSON rather than an HTML 500 page.
    return Response.json(
      { error: "settlement_failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  if (result.status === 402) {
    const demoRails = [demoMode ? "hedera" : null, cardDemoMode ? "stripe" : null].filter(
      (rail): rail is string => rail !== null,
    );
    // mppx renders the `stripe/charge` method's own `html` config for `Accept: text/html`, so
    // the browser gets the real Stripe Elements card form here when Stripe is configured.
    // In demo mode `lib/mppx.ts` configures no `html` for that method (no publishable key to
    // mount it against), so mppx has nothing to render for a browser request — substitute the
    // disabled demo panel instead of leaving the response without a card form at all.
    const wantsHtml = request.headers.get("Accept")?.includes("text/html") ?? false;
    const challenge = wantsHtml && cardDemoMode ? renderStripeDemoPanel(result.challenge, product) : result.challenge;
    return demoRails.length > 0 ? markDemoMode(challenge, demoRails) : challenge;
  }

  // Verification succeeded, so `payment.success` has already recorded the order against the
  // challenge the credential was issued for. The buyer has paid by this point, so bookkeeping
  // must never cost them the `Payment-Receipt` header — degrade to a bare receipt instead.
  let orderId: string | null = null;
  let order: ReturnType<typeof findOrder>;
  try {
    orderId = Credential.fromRequest(request).challenge.id;
    order = findOrder(orderId);
  } catch (error) {
    console.error("Settled a charge but could not resolve its order", error);
  }

  // A browser got here through mppx's card form, which replays the request from a service
  // worker and reloads the page — so whatever this returns is what the buyer ends up looking
  // at. Send them to the storefront's own receipt rather than leaving them on raw JSON.
  // Agents (`Accept: application/json`, or no Accept at all) still get the JSON body.
  const wantsHtml = request.headers.get("Accept")?.includes("text/html") ?? false;
  if (wantsHtml && orderId) {
    return result.withReceipt(new Response(null, { status: 303, headers: { Location: `/receipt/${orderId}` } }));
  }

  return result.withReceipt(
    Response.json({
      orderId,
      receiptUrl: orderId ? `/receipt/${orderId}` : null,
      product: { id: product.id, name: product.name, priceUsd: product.priceUsd },
      transactionId: order?.transactionId ?? null,
      hashscanUrl: order?.hashscanUrl ?? null,
    }),
  );
}

export const GET = handlePayment;
export const POST = handlePayment;
