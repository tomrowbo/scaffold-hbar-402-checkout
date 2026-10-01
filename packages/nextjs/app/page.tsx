import Image from "next/image";
import { ProductCard } from "~~/components/ProductCard";
import { hasHedera, hasStripe, hasX402 } from "~~/lib/demo";
import { products } from "~~/lib/products";

// Rail status is read from the running process's environment, so a developer who adds
// keys and restarts sees the change without a rebuild.
export const dynamic = "force-dynamic";

export default function StorePage() {
  const rails = [
    { label: "Card", enabled: hasStripe() },
    { label: "Hedera", enabled: hasHedera() },
    { label: "x402", enabled: hasX402() },
  ];

  return (
    <div className="flex flex-col grow">
      <div className="w-full max-w-5xl mx-auto px-4 py-6 sm:py-8">
        <header className="hero rounded-2xl hedera-gradient text-white shadow-lg mb-6 sm:mb-8 overflow-hidden">
          <div className="hero-content w-full flex-col md:flex-row items-start md:items-center justify-between gap-4 py-7 sm:py-8">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight m-0">Hedera Merch Store</h1>
              <p className="text-white/90 mt-2 mb-0 max-w-2xl">Card, Hedera and x402, behind one payment endpoint.</p>
            </div>
            <Image
              src="/Hedera-Icon-White.svg"
              alt="Hedera"
              width={64}
              height={64}
              className="hidden sm:block opacity-90"
            />
          </div>
        </header>

        <div className="stats stats-vertical sm:stats-horizontal w-full shadow-sm border border-base-300 bg-base-100 mb-6">
          {rails.map(({ label, enabled }) => (
            <div className="stat" key={label}>
              <div className="stat-title">{label}</div>
              <div className="stat-value text-base sm:text-lg">{enabled ? "Live" : "Demo mode"}</div>
            </div>
          ))}
        </div>

        <section aria-label="Products" className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((product, index) => (
            // The first card is the LCP element on a cold load; preload only that one.
            <ProductCard key={product.id} product={product} priority={index === 0} />
          ))}
        </section>
      </div>
    </div>
  );
}
