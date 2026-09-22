/**
 * Mints a Stripe Shared Payment Token (SPT) for the card form that `/api/pay` renders to
 * browsers. The form creates a card PaymentMethod with Stripe.js, posts it here, and retries
 * the 402 with the returned `{ spt }` as its payment credential.
 *
 * SPTs are in Stripe private preview and not in the SDK's typed surface, so this goes
 * through `rawRequest` with a preview API version — the same two endpoints the mppx CLI uses:
 * the test-helper grant for `sk_test_` keys, the issued-tokens API for live keys.
 */
import { hasStripe } from "~~/lib/demo";
import { stripeClient, stripeLivemode } from "~~/lib/mppx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must match the preview version mppx verifies SPT-backed PaymentIntents with. */
const STRIPE_PREVIEW_API_VERSION = "2026-07-29.preview";

type TokenBody = {
  paymentMethod?: unknown;
  amount?: unknown;
  currency?: unknown;
  networkId?: unknown;
  expiresAt?: unknown;
  metadata?: unknown;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export async function POST(request: Request): Promise<Response> {
  if (!hasStripe() || !stripeClient) {
    return Response.json(
      {
        error: "demo_mode",
        detail: "Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_NETWORK_ID to enable card payments.",
      },
      { status: 503 },
    );
  }

  let body: TokenBody;
  try {
    body = (await request.json()) as TokenBody;
  } catch {
    return Response.json({ error: "invalid_body", detail: "Expected a JSON object." }, { status: 400 });
  }

  const { paymentMethod, amount, currency, expiresAt, metadata } = body;
  if (
    !isNonEmptyString(paymentMethod) ||
    !isNonEmptyString(amount) ||
    !/^\d+$/.test(amount) ||
    !isNonEmptyString(currency) ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt)
  ) {
    return Response.json(
      { error: "invalid_body", detail: "Expected paymentMethod, amount (base units), currency and expiresAt." },
      { status: 400 },
    );
  }

  // The token is always granted to this merchant's own network profile. Taking it from the
  // body would let any caller mint SPTs against this Stripe account for someone else.
  const networkId = process.env.STRIPE_NETWORK_ID!.trim();
  if (body.networkId !== undefined && body.networkId !== networkId) {
    return Response.json(
      { error: "network_mismatch", detail: "networkId does not match this merchant." },
      { status: 400 },
    );
  }

  const livemode = stripeLivemode();
  const params: Record<string, unknown> = {
    payment_method: paymentMethod,
    usage_limits: { currency, max_amount: amount, expires_at: expiresAt },
    // Live issuance grants to a business profile (`profile_...`); the test helper takes a network id.
    seller_details: livemode ? { network_business_profile: networkId } : { network_id: networkId },
  };
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    params.metadata = Object.fromEntries(
      Object.entries(metadata as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
    );
  }

  try {
    const token = (await stripeClient.rawRequest(
      "POST",
      livemode ? "/v1/shared_payment/issued_tokens" : "/v1/test_helpers/shared_payment/granted_tokens",
      params,
      { apiVersion: STRIPE_PREVIEW_API_VERSION },
    )) as { id?: unknown };
    if (!isNonEmptyString(token.id)) {
      return Response.json({ error: "spt_failed", detail: "Stripe returned no token id." }, { status: 502 });
    }
    return Response.json({ spt: token.id });
  } catch (error) {
    return Response.json(
      { error: "spt_failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
