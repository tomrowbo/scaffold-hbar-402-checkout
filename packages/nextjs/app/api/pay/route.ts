/**
 * Checkout charge endpoint: one 402 for every configured rail.
 *
 * Unpaid requests answer 402 with a `WWW-Authenticate: Payment` challenge naming
 * `method="hedera", intent="charge"`, plus a `method="stripe"` challenge when Stripe is
 * configured. Browsers (`Accept: text/html`) get Stripe's card form instead of JSON.
 *
 * Hedera: the buyer transfers USDC with the 32-byte attribution memo from the challenge and
 * retries with `Authorization: Payment <credential>`; mppx-hedera confirms the transfer
 * against the Mirror Node. Stripe: the credential carries a Shared Payment Token and mppx
 * confirms a PaymentIntent. Either way the route then returns 200 with `Payment-Receipt`.
 */
import { Credential } from "mppx";
import { USDC_DECIMALS, USDC_TOKEN_ID, canSettle, charge, chargeRecipient } from "~~/lib/mppx";
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

async function handlePayment(request: Request): Promise<Response> {
  const requestedId = new URL(request.url).searchParams.get("product") ?? "";
  // An unknown id falls back to the first fixture rather than 404-ing, so the endpoint is
  // always inspectable — `/api/pay` on its own returns a valid challenge.
  const product = findProduct(requestedId) ?? products[0];
  const demoMode = !canSettle();
  // Hedera's demo mode must not swallow a card credential when Stripe itself is live.
  const stripCredential = demoMode && credentialMethod(request) !== "stripe";

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
    return demoMode ? markDemoMode(result.challenge) : result.challenge;
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
