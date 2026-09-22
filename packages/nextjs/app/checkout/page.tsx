import Image from "next/image";
import Link from "next/link";
import { PaymentOption } from "~~/components/PaymentOption";
import { hasHedera, hasStripe, hasX402 } from "~~/lib/demo";
import { findProduct, products } from "~~/lib/products";

type CheckoutPageProps = {
  searchParams: Promise<{ product?: string | string[] }>;
};

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const { product: productParam } = await searchParams;
  const requestedId = Array.isArray(productParam) ? productParam[0] : productParam;
  const product = (requestedId ? findProduct(requestedId) : undefined) ?? products[0];

  const paymentOptions = [
    {
      label: "Card",
      description: "Stripe settles the card and answers the 402 challenge on the buyer's behalf.",
      envVars: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_NETWORK_ID"],
      enabled: hasStripe(),
    },
    {
      label: "Hedera",
      description: "Native USDC transfer on Hedera, signed by the operator account and confirmed on Mirror Node.",
      envVars: ["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY"],
      enabled: hasHedera(),
    },
    {
      label: "x402",
      description: "The same purchase routed through an x402 facilitator, for protocol comparison.",
      envVars: ["AX402_FACILITATOR_URL"],
      enabled: hasX402(),
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
              <Image src={product.image} alt={product.name} fill unoptimized className="object-cover" />
            </div>
            <div className="grow">
              <h2 className="card-title text-base m-0">{product.name}</h2>
              <p className="text-sm text-base-content/60 m-0 font-mono">{product.id}</p>
            </div>
            <p className="text-2xl font-bold m-0 tabular-nums">${product.priceUsd}</p>
          </div>
        </div>

        <h2 className="text-xl font-semibold m-0 mb-1">Payment options</h2>
        <p className="text-sm text-base-content/70 m-0 mb-5">
          Detection is per-integration — configuring one rail does not stub out the others.
        </p>

        <section aria-label="Payment options" className="grid gap-5 grid-cols-1 md:grid-cols-3">
          {paymentOptions.map(option => (
            <PaymentOption key={option.label} {...option} />
          ))}
        </section>

        <div className="alert mt-8 border border-base-300 bg-base-100 shadow-sm">
          <span className="text-sm">
            No payment logic runs yet. Follow a completed order to a{" "}
            <Link href={`/receipt/${product.id}`} className="link link-primary font-medium">
              sample receipt
            </Link>
            .
          </span>
        </div>
      </div>
    </div>
  );
}
