/**
 * MPP discovery document: an OpenAPI 3.1 document carrying `x-payment-info` on every paid
 * operation, as the MPP spec requires. Generated with mppx's own discovery helper
 * (`mppx/discovery`'s `generate()`) from the real `charge()` handler `app/api/pay/route.ts`
 * calls, not a hand-written copy of it — the offers here can't drift from what that route
 * actually issues, because they come from the same composed handler.
 *
 * `/api/x402` isn't an mppx method (x402 is a competing protocol, not one of `lib/mppx.ts`'s
 * registered charge methods), so `generate()` has nothing to introspect for it. That entry is
 * assembled by hand below, from the same constants `app/api/x402/route.ts` builds its
 * `accepts[]` entry from — `USDC_TOKEN_ID`, `USDC_DECIMALS`, `chargeRecipient()` — and
 * validated against mppx's own `PaymentInfo` schema so it has to match the shape `generate()`
 * produces.
 *
 * A representative product (the catalogue's first fixture) stands in for `?product=`, which
 * both `/api/pay` and `/api/x402` accept but neither requires — same fallback those routes
 * use for an unrecognized id.
 */
import type { DiscoveryHandler } from "mppx/discovery";
import { PaymentInfo, generate } from "mppx/discovery";
import { USDC_DECIMALS, USDC_TOKEN_ID, chargeRecipient, chargeHandlerForDiscovery, mppxForRequest } from "~~/lib/mppx";
import { products } from "~~/lib/products";
import { X402_NETWORK, X402_SCHEME, toBaseUnits } from "~~/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOC_HEADERS = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" };

function handleDiscovery(request: Request): Response {
  const product = products[0];
  const instance = mppxForRequest(request);
  const origin = new URL(request.url).origin;

  const payHandler = chargeHandlerForDiscovery(request, {
    amount: product.priceUsd,
    currency: USDC_TOKEN_ID,
    decimals: USDC_DECIMALS,
    recipient: chargeRecipient(),
    description: `MPP Checkout — ${product.name}`,
    meta: { product: product.id, amountUsd: product.priceUsd },
  }) as unknown as DiscoveryHandler;

  const doc = generate(instance, {
    info: { title: "MPP Checkout", version: "1.0.0" },
    serviceInfo: {
      categories: ["e-commerce"],
      docs: { homepage: `${origin}/`, llms: `${origin}/llms.txt` },
    },
    routes: [
      {
        handler: payHandler,
        method: "GET",
        path: "/api/pay",
        summary: "Buy a product — 402 challenge advertising a native Hedera USDC charge and a Stripe card charge",
      },
      {
        handler: payHandler,
        method: "POST",
        path: "/api/pay",
        summary: "Buy a product — 402 challenge advertising a native Hedera USDC charge and a Stripe card charge",
      },
    ],
  }) as { paths?: Record<string, Record<string, unknown>> };

  // `/api/x402` is not an mppx method, so its offer is hand-built from the same constants
  // `app/api/x402/route.ts` uses, then run through mppx's own `PaymentInfo` schema — the same
  // validation and `{ offers: [...] }` normalization `generate()` applies above.
  doc.paths ??= {};
  doc.paths["/api/x402"] = {
    get: {
      responses: { "402": { description: "Payment Required" }, "200": { description: "Successful response" } },
      summary: "x402 comparison rail — same product, amount and recipient as /api/pay, in the x402 protocol",
      "x-payment-info": PaymentInfo.parse({
        amount: toBaseUnits(product.priceUsd, USDC_DECIMALS),
        currency: USDC_TOKEN_ID,
        description: `MPP Checkout — ${product.name}`,
        intent: "charge",
        method: "x402",
        network: X402_NETWORK,
        scheme: X402_SCHEME,
        recipient: chargeRecipient(),
      }),
    },
  };

  return new Response(JSON.stringify(doc, null, 2), { headers: DOC_HEADERS });
}

export const GET = handleDiscovery;
