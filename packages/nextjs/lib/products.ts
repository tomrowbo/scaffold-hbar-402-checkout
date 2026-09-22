/**
 * Fixture catalogue. No database, no network calls — the store renders identically
 * on a machine with no credentials and no outbound connectivity.
 *
 * Images are local SVG placeholders under `public/products/`, so nothing is fetched
 * from a remote host at render time.
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
    image: "/products/hbar-tee.svg",
  },
  {
    id: "consensus-hoodie",
    name: "Consensus Hoodie",
    priceUsd: "64.00",
    image: "/products/consensus-hoodie.svg",
  },
  {
    id: "hashgraph-mug",
    name: "Hashgraph Mug",
    priceUsd: "12.00",
    image: "/products/hashgraph-mug.svg",
  },
  {
    id: "validator-cap",
    name: "Validator Cap",
    priceUsd: "28.00",
    image: "/products/validator-cap.svg",
  },
];

export function findProduct(id: string): Product | undefined {
  return products.find(product => product.id === id);
}
