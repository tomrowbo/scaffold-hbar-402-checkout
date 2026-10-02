import Image from "next/image";
import Link from "next/link";
import { CardPayButton } from "~~/components/CardPayButton";
import { HederaPayButton } from "~~/components/HederaPayButton";
import { PaymentOption } from "~~/components/PaymentOption";
import { X402PayButton } from "~~/components/X402PayButton";
import { hasStripe, hasX402 } from "~~/lib/demo";
import { USDC_TOKEN_ID, canSettle } from "~~/lib/mppx";
import { findProduct, products } from "~~/lib/products";

type CheckoutPageProps = {
  searchParams: Promise<{ product?: string | string[] }>;
};

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const { product: productParam } = await searchParams;
  const requestedId = Array.isArray(productParam) ? productParam[0] : productParam;
  const product = (requestedId ? findProduct(requestedId) : undefined) ?? products[0];

  const hederaEnabled = canSettle();
  // Config-only, like `canSettle()` above: a facilitator that is configured but unreachable
  // is reported by the button when it reads the 402, not by greying the card out at render.
  const x402Enabled = hasX402();

  const cardEnabled = hasStripe();

  const paymentOptions = [
    {
      label: "Card",
      description: "Settled by Stripe.",
      envVars: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_NETWORK_ID"],
      enabled: cardEnabled,
      action: <CardPayButton productId={product.id} priceUsd={product.priceUsd} enabled={cardEnabled} />,
    },
    {
      // Labelled by protocol, to sit against x402. The card offer rides the same MPP 402, so
      // the distinction a buyer is choosing between here is really the rail, not the protocol
      // — the description carries that.
      label: "Hedera MPP",
      description: `Native USDC (${USDC_TOKEN_ID}) transfer on Hedera.`,
      envVars: ["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY"],
      enabled: hederaEnabled,
      action: <HederaPayButton productId={product.id} priceUsd={product.priceUsd} enabled={hederaEnabled} />,
    },
    {
      label: "x402",
      description: "Same USDC, settled over x402.",
      envVars: ["AX402_FACILITATOR_URL"],
      enabled: x402Enabled,
      action: <X402PayButton productId={product.id} priceUsd={product.priceUsd} enabled={x402Enabled} />,
    },
  ];

  return (
    <div className="flex flex-col grow">
      <div className="w-full max-w-5xl mx-auto px-4 py-6 sm:py-8">
        <div className="breadcrumbs text-sm mb-2">
          <ul>
            <li>
              <Link href="/" className="link link-hover">
                Store
              </Link>
            </li>
            <li>Checkout</li>
          </ul>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight m-0 mb-6">Checkout</h1>

        <div className="card border border-base-300 bg-base-100 shadow-sm mb-8">
          <div className="card-body flex-row items-center gap-4 py-5">
            <div className="relative w-20 h-20 shrink-0 rounded-lg overflow-hidden bg-base-200">
              <Image
                src={product.image}
                alt={product.name}
                fill
                sizes="80px"
                priority
                unoptimized
                className="object-cover"
              />
            </div>
            <div className="grow">
              <h2 className="card-title text-base m-0">{product.name}</h2>
              <p className="text-sm text-base-content/60 m-0 font-mono">{product.id}</p>
            </div>
            <p className="text-2xl font-bold m-0 tabular-nums">${product.priceUsd}</p>
          </div>
        </div>

        <h2 className="text-xl font-semibold m-0 mb-5">Payment options</h2>

        <section aria-label="Payment options" className="grid gap-5 grid-cols-1 md:grid-cols-3">
          {paymentOptions.map(option => (
            <PaymentOption key={option.label} {...option} />
          ))}
        </section>
      </div>
    </div>
  );
}
