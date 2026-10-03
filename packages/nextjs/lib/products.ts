/**
 * Fixture catalogue. No database, no network calls — the store renders identically
 * on a machine with no credentials and no outbound connectivity.
 *
 * Images are local JPEGs under `public/products/`, rendered with next/image's
 * `unoptimized` flag, so nothing is fetched from a remote host at render time and
 * `sharp` is never invoked.
 *
 * Prices are deliberately tiny. The testnet USDC this template settles in is Circle's
 * `0.0.429274`, and `faucet.circle.com` rations it, so a catalogue priced like real merch
 * lets you test each rail about once. At these prices a few USDC covers dozens of runs
 * across all three rails. Put real prices back when you fork this.
 *
 * `0.50` is the floor, not a style choice: Stripe's minimum charge is 50 cents, and below it
 * mppx's `canOffer` stops advertising the card rail entirely rather than failing loudly.
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
    priceUsd: "0.75",
    image: "/products/hbar-tee.jpg",
  },
  {
    id: "consensus-hoodie",
    name: "Consensus Hoodie",
    priceUsd: "2.00",
    image: "/products/consensus-hoodie.jpg",
  },
  {
    id: "hashgraph-mug",
    name: "Hashgraph Mug",
    priceUsd: "0.50",
    image: "/products/hashgraph-mug.jpg",
  },
  {
    id: "validator-tote",
    name: "Validator Tote",
    priceUsd: "1.00",
    image: "/products/validator-tote.jpg",
  },
];

export function findProduct(id: string): Product | undefined {
  return products.find(product => product.id === id);
}
