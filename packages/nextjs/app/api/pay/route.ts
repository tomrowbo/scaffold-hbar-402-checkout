/**
 * Checkout charge endpoint: one 402 for every configured rail.
 *
 * Unpaid requests answer 402 with a `WWW-Authenticate: Payment` challenge naming
 * `method="hedera", intent="charge"` and one naming `method="stripe"`. Browsers
 * (`Accept: text/html`) get Stripe's card form instead of JSON — a disabled one with a
 * demo-mode note when Stripe is not configured.
 *
 * Hedera: the buyer transfers USDC with the 32-byte attribution memo from the challenge and
 * retries with `Authorization: Payment <credential>`; mppx-hedera confirms the transfer
 * against the Mirror Node. Stripe: the credential carries a Shared Payment Token and mppx
 * confirms a PaymentIntent. Either way the route then returns 200 with `Payment-Receipt`.
 */
import { Credential } from "mppx";
import { USDC_DECIMALS, USDC_TOKEN_ID, canSettle, charge, chargeRecipient, stripeDemoMode } from "~~/lib/mppx";
import { attachOrderRecorder, findOrder } from "~~/lib/orders";
import { findProduct, products } from "~~/lib/products";

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

/** Flags a challenge as demo-issued without touching status or `WWW-Authenticate`. */
function markDemoMode(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-MPP-Demo-Mode", "settlement-stubbed");
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

function wantsHtml(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * Browser view of the 402 when Stripe is not configured: the card form Stripe Elements would
 * render, disabled, with the demo-mode note. Status and `WWW-Authenticate` stay the challenge's.
 */
function demoCardPage(challenge: Response, product: { name: string; priceUsd: string }): Response {
  const title = escapeHtml(`MPP Checkout — ${product.name}`);
  const body = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Payment Required — ${title}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f4f5; margin: 0; padding: 3rem 1rem; color: #18181b; }
  main { max-width: 26rem; margin: 0 auto; background: #fff; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 1px 3px rgb(0 0 0 / 0.1); }
  h1 { font-size: 1.125rem; margin: 0 0 0.25rem; }
  .amount { font-size: 1.75rem; font-weight: 700; margin: 0 0 1rem; }
  .badge { display: inline-block; font-size: 0.75rem; border: 1px solid #d4d4d8; border-radius: 999px; padding: 0.1rem 0.5rem; margin-left: 0.5rem; }
  label { display: block; font-size: 0.875rem; margin: 0.75rem 0 0.25rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; border: 1px solid #d4d4d8; border-radius: 0.5rem; font-size: 1rem; background: #fafafa; }
  .row { display: flex; gap: 0.75rem; }
  .row > div { flex: 1; }
  button { width: 100%; margin-top: 1.25rem; padding: 0.75rem; border: 0; border-radius: 0.5rem; font-size: 1rem; background: #a1a1aa; color: #fff; cursor: not-allowed; }
  .note { font-size: 0.8125rem; color: #52525b; margin-top: 1rem; }
  code { font-size: 0.75rem; }
</style>
</head>
<body>
<main>
  <h1>${title}<span class="badge">demo mode</span></h1>
  <p class="amount">$${escapeHtml(product.priceUsd)}</p>
  <form aria-label="Card payment" onsubmit="return false">
    <fieldset disabled style="border:0;padding:0;margin:0">
      <label for="card-number">Card number</label>
      <input id="card-number" name="cardnumber" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" />
      <div class="row">
        <div><label for="card-expiry">Expiry</label><input id="card-expiry" name="exp-date" autocomplete="cc-exp" placeholder="MM / YY" /></div>
        <div><label for="card-cvc">CVC</label><input id="card-cvc" name="cvc" autocomplete="cc-csc" placeholder="CVC" /></div>
      </div>
      <button type="submit">Pay with Card</button>
    </fieldset>
  </form>
  <p class="note">Running in <strong>demo mode</strong> — set <code>STRIPE_SECRET_KEY</code>
  <code>STRIPE_PUBLISHABLE_KEY</code> <code>STRIPE_NETWORK_ID</code> in <code>packages/nextjs/.env</code>
  to render the live Stripe Elements card form. Agents requesting JSON receive the same 402 challenge.</p>
  <p class="note"><a href="/checkout">Back to checkout</a></p>
</main>
</body>
</html>`;
  const headers = new Headers(challenge.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.delete("Content-Length");
  return new Response(body, { status: challenge.status, statusText: challenge.statusText, headers });
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
      description: `MPP Checkout — ${product.name}`,
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
    const challenge = demoMode || cardDemoMode ? markDemoMode(result.challenge) : result.challenge;
    return cardDemoMode && wantsHtml(request) ? demoCardPage(challenge, product) : challenge;
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
