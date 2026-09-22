# Scaffold-HBAR — MPP Checkout

A merch storefront whose checkout offers three payment rails side by side: **Card** (Stripe), **Hedera** (native settlement) and **x402**. Next.js only — no Solidity workspace, no contract deploy.

**The store runs with no credentials and no `.env` at all.** Clone it, install, start it, and you get a working storefront. Each rail switches itself on independently once its own variables are present, so a developer holding only Stripe keys gets a live card path and demo stubs everywhere else.

General Scaffold-HBAR docs: [Scaffold HBAR on Hedera](https://docs.hedera.com/solutions/tools/scaffold-hbar/index).

## What's in this template

- **Next.js only** — no `packages/hardhat` or `packages/foundry`
- **Store** at `/` — a four-item fixture catalogue, each item linking to checkout
- **Checkout** at `/checkout` — Card, Hedera and x402 options, each disabled with a demo-mode note until its credentials are set
- **Receipt** at `/receipt/[id]` — an unknown reference renders a demo receipt rather than a 404
- **Per-integration detection** in `packages/nextjs/lib/demo.ts`
- Wallet connect, theming and the Scaffold-HBAR component stack, unchanged

Create a project:

```bash
npm create scaffold-hbar@latest -- --template mpp-checkout
```

## Quick start

### Prerequisites

- Node.js ≥ 20.18.3, Git
- Yarn (this template is Yarn-only)

No credentials are required to run the store.

### Install and run

```bash
yarn install
yarn next:dev    # http://localhost:3000
```

Browse the catalogue, pick an item, and walk through checkout. Every rail renders in demo mode until you configure it.

### Enabling a rail

Copy `packages/nextjs/.env.example` to `packages/nextjs/.env` and fill in only the rails you want. The predicates in `lib/demo.ts` are independent — setting one group never stubs out another.

| Rail | Variables | Predicate |
|---|---|---|
| Card | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_NETWORK_ID` | `hasStripe()` |
| Hedera | `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` | `hasHedera()` |
| x402 | `AX402_FACILITATOR_URL` | `hasX402()` |

Wallet connection additionally uses `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` ([Reown / WalletConnect Cloud](https://cloud.reown.com)).

Payment logic itself lands in a later increment — this one is the storefront shell.

## Scripts

| Command | Description |
|---|---|
| `yarn next:dev` | Dev server at http://localhost:3000 |
| `yarn next:build` | Production build |
| `yarn next:check-types` | TypeScript check |
| `yarn lint` / `yarn next:lint` | ESLint |
| `yarn format` | Prettier |

## Project layout

- **packages/nextjs/app** — App Router routes: `/`, `/checkout`, `/receipt/[id]`
- **packages/nextjs/lib** — `demo.ts` (per-rail credential detection), `products.ts` (fixture catalogue)
- **packages/nextjs/components** — storefront components plus the Scaffold-HBAR wallet and theme stack
- **packages/nextjs/public/products** — local SVG placeholders; nothing is fetched remotely

## Links

- [Scaffold HBAR docs](https://docs.hedera.com/solutions/tools/scaffold-hbar/index)
- [create-scaffold-hbar](https://github.com/hedera-dev/create-scaffold-hbar) — CLI
- [Hedera docs](https://docs.hedera.com/)
- [HashScan testnet](https://hashscan.io/testnet)
