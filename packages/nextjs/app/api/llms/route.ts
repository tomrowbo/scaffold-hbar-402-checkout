/**
 * `/llms.txt`: a plain-text brief for an agent deciding whether and how to buy here. This
 * template exists to demonstrate agent payments, so an agent reading the site should not have
 * to guess at the protocol from the OpenAPI document alone.
 *
 * Built from the same constants the routes it describes use — `products`, `USDC_TOKEN_ID`,
 * `chargeRecipient()`, `X402_NETWORK` — so it can't say something the routes don't actually do.
 */
import { HEDERA_NETWORK, USDC_TOKEN_ID, chargeRecipient, stripeDemoMode } from "~~/lib/mppx";
import { products } from "~~/lib/products";
import { X402_NETWORK, X402_SCHEME } from "~~/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handleLlmsTxt(request: Request): Response {
  const origin = new URL(request.url).origin;
  const catalogue = products.map(product => `  - ${product.id}: ${product.name}, $${product.priceUsd}`).join("\n");
  const cardLine = stripeDemoMode()
    ? "- stripe (card): advertised but stubbed in this deployment — the credential is dropped and the challenge reissued, never settled."
    : "- stripe (card): a Shared Payment Token against a live PaymentIntent.";

  const body = `# MPP Checkout (demo store)

This is a storefront selling the fixture products below. Payment is required before the
purchased response is returned: unpaid requests to the paid endpoints answer HTTP 402 with a
\`WWW-Authenticate: Payment\` challenge (the Machine Payments Protocol, MPP) naming one or more
payment methods. Retry the same request with an \`Authorization: Payment <credential>\` header
once you hold a valid credential for one of the advertised methods.

## Products
${catalogue}

## Endpoints
- GET/POST ${origin}/api/pay?product=<id> — MPP checkout. 402 until paid, then a JSON receipt.
- GET ${origin}/api/x402?product=<id> — the same product and amount, offered via the x402
  protocol instead of MPP, for comparison. Settlement is not implemented on this route; a
  retried request with X-PAYMENT gets 501, not a receipt.
- GET ${origin}/openapi.json — OpenAPI 3.1 discovery document with \`x-payment-info\` on every
  paid operation.

## Payment rails advertised on /api/pay
- hedera (native charge): pay in USDC on Hedera ${HEDERA_NETWORK} (token ${USDC_TOKEN_ID}) to
  recipient ${chargeRecipient()}, memo-attributed to the challenge per the MPP Hedera method.
${cardLine}

## Payment rail advertised on /api/x402
- x402 "${X402_SCHEME}" scheme on network "${X402_NETWORK}", same token and recipient as the
  hedera rail above.

## Docs
- Discovery document: ${origin}/openapi.json
- Storefront (human-readable): ${origin}/
`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

export const GET = handleLlmsTxt;
