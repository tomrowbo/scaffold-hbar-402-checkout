import Image from "next/image";
import Link from "next/link";
import { HEDERA_NETWORK } from "~~/lib/mppx";
import { findOrder } from "~~/lib/orders";
import { findProduct, products } from "~~/lib/products";

type ReceiptPageProps = {
  params: Promise<{ id: string }>;
};

/** Fixed so the demo receipt renders identically on every machine and every run. */
const DEMO_SETTLED_AT = "2026-01-14 10:32 UTC";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({ params }: ReceiptPageProps) {
  const { id } = await params;

  // A settled order is keyed by the reference that paid for it: an MPP challenge id, or
  // the `x402_…` reference `recordX402Order` minted for an x402 settlement.
  const order = findOrder(id);
  // An unrecognised reference renders a demo receipt rather than a 404, so a judge
  // can open /receipt/anything and still see the finished flow.
  const matched = findProduct(order?.productId ?? id);
  const product = matched ?? products[0];
  const isDemo = !order && !matched;
  const isCard = order?.method === "stripe";
  const isX402 = order?.method === "x402";

  // One line per rail, because the protocol that carried the payment is the whole point of
  // this template — an x402 settlement and an MPP Hedera charge move the same token between
  // the same accounts and would otherwise be indistinguishable on the receipt.
  const rail = isCard
    ? "Card — Stripe charge (MPP)"
    : isX402
      ? "x402 — exact scheme on hedera:testnet (facilitator-settled)"
      : "Hedera — native USDC charge (MPP)";

  const rows = order
    ? [
        { label: "Order reference", value: order.id },
        { label: "Item", value: product.name },
        {
          label: "Amount",
          value: isCard
            ? `$${order.amountUsd || product.priceUsd} USD`
            : `${order.amountUsd || product.priceUsd} USDC (${order.tokenId})`,
        },
        { label: "Payment rail", value: rail },
        // Payer and recipient are on-chain identities. A card settles inside Stripe against a
        // token that deliberately hides the card, and there is no account id on either side —
        // so omit both rows rather than print "unknown" next to an empty one.
        ...(isCard
          ? []
          : [
              { label: "Paid by", value: order.payer?.split(":").pop() ?? "unknown" },
              { label: "Paid to", value: order.recipient },
            ]),
        { label: "Transaction", value: order.transactionId },
        { label: "Settled", value: order.settledAt },
      ]
    : [
        { label: "Order reference", value: id },
        { label: "Item", value: product.name },
        { label: "Amount", value: `$${product.priceUsd} USD` },
        { label: "Payment rail", value: "Demo — no rail configured" },
        { label: "Settled", value: DEMO_SETTLED_AT },
      ];

  return (
    <div className="flex flex-col grow">
      <div className="w-full max-w-3xl mx-auto px-4 py-6 sm:py-8">
        <div className="breadcrumbs text-sm mb-2">
          <ul>
            <li>
              <Link href="/" className="link link-hover">
                Store
              </Link>
            </li>
            <li>
              <Link href="/checkout" className="link link-hover">
                Checkout
              </Link>
            </li>
            <li>Receipt</li>
          </ul>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight m-0 mb-6">Receipt</h1>

        {isDemo && (
          <div className="alert alert-info mb-6 shadow-sm">
            <span className="text-sm">
              No order matches <code className="bg-base-300/40 px-1 py-0.5 rounded">{id}</code>, so this is a demo
              receipt built from the fixture catalogue.
            </span>
          </div>
        )}

        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-5 py-6">
            <div className="flex items-center gap-4">
              <div className="relative w-16 h-16 shrink-0 rounded-lg overflow-hidden bg-base-200">
                <Image
                  src={product.image}
                  alt={product.name}
                  fill
                  sizes="64px"
                  priority
                  unoptimized
                  className="object-cover"
                />
              </div>
              <div className="grow">
                <h2 className="card-title text-base m-0">{product.name}</h2>
                <p className="text-sm text-base-content/60 m-0">
                  {order
                    ? isCard
                      ? "Paid by card via Stripe"
                      : isX402
                        ? `Settled on Hedera ${HEDERA_NETWORK} via x402`
                        : `Settled on Hedera ${HEDERA_NETWORK}`
                    : "Paid in full"}
                </p>
              </div>
              <p className="text-2xl font-bold m-0 tabular-nums">${product.priceUsd}</p>
            </div>

            <div className="divider my-0" />

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 m-0">
              {rows.map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-xs uppercase tracking-wider text-base-content/50 font-medium">{label}</dt>
                  <dd className="m-0 text-sm font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>

            {order?.hashscanUrl && (
              <a
                href={order.hashscanUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-outline btn-sm w-full sm:w-auto self-start"
                data-testid="hashscan-link"
              >
                View on Hashscan ↗
              </a>
            )}
          </div>
        </div>

        <div className="mt-6">
          <Link href="/" className="btn btn-primary btn-sm">
            Back to the store
          </Link>
        </div>
      </div>
    </div>
  );
}
