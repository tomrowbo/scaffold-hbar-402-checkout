import Image from "next/image";
import Link from "next/link";
import type { Product } from "~~/lib/products";

export const ProductCard = ({ product }: { product: Product }) => {
  return (
    <div className="card bg-base-100 border border-base-300 shadow-sm hover:shadow-md transition-shadow">
      <figure className="bg-base-200 aspect-square relative">
        {/* Local SVG placeholder — `unoptimized` keeps the image pipeline offline. */}
        <Image src={product.image} alt={product.name} fill unoptimized className="object-cover" />
      </figure>
      <div className="card-body gap-3 py-5">
        <h2 className="card-title text-base m-0">{product.name}</h2>
        <p className="text-2xl font-bold m-0 tabular-nums">${product.priceUsd}</p>
        <div className="card-actions">
          <Link href={`/checkout?product=${product.id}`} className="btn btn-primary btn-sm w-full">
            Checkout
          </Link>
        </div>
      </div>
    </div>
  );
};
