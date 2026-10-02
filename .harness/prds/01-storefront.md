# 01 — Replace the seed demo with the storefront shell

This project was seeded from scaffold-hbar's `hedera-demo` template, which
ships an HCS/HTS "proof wall" demo. Replace it with a merch storefront. No
payments yet.

## Remove the seed demo

Delete: `app/admin/page.tsx`, `app/my-proofs/page.tsx`, everything under
`app/api/hedera/`, and components `BadgeDisplay.tsx`, `ProofCard.tsx`,
`ProofWall.tsx`, `SubmitProofForm.tsx`, `TopicSelector.tsx`.

Keep the wallet and theme stack: `Header.tsx`, `Footer.tsx`, `SwitchTheme.tsx`,
`ThemeProvider.tsx`, `ScaffoldHbarAppWithProviders.tsx`, and everything under
`components/scaffold-hbar/`. The burner connector must keep working — later
on-chain validation injects a key at `localStorage.burnerWallet.pk`.

Update `.env.example`: drop `NEXT_PUBLIC_PROOF_WALL_TOPIC_ID` and
`NEXT_PUBLIC_PROOF_WALL_BADGE_TOKEN_ID`; keep the wallet-connect and RPC vars.

## Must work with no credentials and no .env

This is the hard requirement. A stranger who clones this repo and runs
`yarn install && yarn next:dev` must get a working store with no setup.

Create `lib/demo.ts` exporting three independent predicates:

    export function hasHedera(): boolean   // HEDERA_OPERATOR_ID && HEDERA_OPERATOR_KEY
    export function hasStripe(): boolean   // STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY
                                           //   && STRIPE_NETWORK_ID
    export function hasX402(): boolean     // AX402_FACILITATOR_URL

Detection is per-integration. A developer with only Stripe keys gets a live
card path and stubs elsewhere. Never gate the whole app on one variable.

## Fixture catalogue

`lib/products.ts` exports `products: Product[]` with four items:

    type Product = { id: string; name: string; priceUsd: string; image: string }

Prices as decimal strings, e.g. "0.50". Use local image files in
`public/` — no remote image fetches, which would break a judge behind a
firewall.

## Routes

- `/` — product grid, each item linking to checkout. Must contain "Checkout".
- `/checkout` — shows three payment options labelled "Card", "Hedera", "x402".
  Each renders disabled with a "demo mode" note when its predicate is false.
- `/receipt/[id]` — receipt view. For an unknown id, render a demo receipt
  rather than a 404, so `/receipt/demo-1` returns 200.

## Out of scope

No payment logic, no SDK calls, no network requests. Later increments add them.
