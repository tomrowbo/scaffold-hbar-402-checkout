/**
 * Fixture catalogue. No database, no network calls — the store renders identically
 * on a machine with no credentials and no outbound connectivity.
 *
 * Images are local JPEGs under `public/products/`, rendered with next/image's
 * `unoptimized` flag, so nothing is fetched from a remote host at render time and
 * `sharp` is never invoked.
 *
 * Photo credits (Pexels, free for commercial use, no attribution required — listed
 * so you know what to swap out for your own product shots):
 *   hbar-tee         pexels.com/photo/12025472
 *   consensus-hoodie pexels.com/photo/6786666
 *   hashgraph-mug    pexels.com/photo/11075707
 *   validator-tote   pexels.com/photo/12025443
 */

export type Product = {
  id: string;
  name: string;
  priceUsd: string;
  image: string;
};

export const products: Product[] = [
  {
    id: "hbar-tee",
    name: "HBAR Logo Tee",
    priceUsd: "24.00",
    image: "/products/hbar-tee.jpg",
  },
  {
    id: "consensus-hoodie",
    name: "Consensus Hoodie",
    priceUsd: "64.00",
    image: "/products/consensus-hoodie.jpg",
  },
  {
    id: "hashgraph-mug",
    name: "Hashgraph Mug",
    priceUsd: "12.00",
    image: "/products/hashgraph-mug.jpg",
  },
  {
    id: "validator-tote",
    name: "Validator Tote",
    priceUsd: "28.00",
    image: "/products/validator-tote.jpg",
  },
];

export function findProduct(id: string): Product | undefined {
  return products.find(product => product.id === id);
}
