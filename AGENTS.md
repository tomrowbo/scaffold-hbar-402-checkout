# Agent instructions

Briefing for coding agents in this app (Cursor, Claude Code, Codex). Claude Code loads it through `CLAUDE.md`.

This is a **Hedera-native Next.js storefront** (MPP Checkout). There is **no Solidity workspace** — payments are intended to settle through native Hedera services, Stripe and x402 rather than contracts.

Use the package manager this project was created with (`packageManager` in the root `package.json`). Examples use `yarn`.

## Commands

```bash
yarn next:dev           # http://localhost:3000
yarn next:build
yarn next:check-types
yarn lint               # same as yarn next:lint
yarn format
```

## The hard rule: no credentials required

The store must boot and render every route with **no `.env` file and no environment variables at all**. Never gate the app, a route, or a shared layout on a single variable. Detection is per-integration: a developer with only Stripe keys gets a live card path and demo stubs elsewhere.

`packages/nextjs/lib/demo.ts` owns this and exports three independent predicates:

```ts
hasHedera()   // HEDERA_OPERATOR_ID && HEDERA_OPERATOR_KEY
hasStripe()   // STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY && STRIPE_NETWORK_ID
hasX402()     // AX402_FACILITATOR_URL
```

These read server-only variables, so call them from server components or route handlers and pass the booleans down to client components. When a predicate is false, render the affected control **disabled with a visible "demo mode" note** — never hide it and never throw.

## App overview

| Route | Purpose |
|---|---|
| `/` | Store — fixture product grid, each item linking to checkout |
| `/checkout` | Card, Hedera and x402 payment options; each disabled in demo mode |
| `/receipt/[id]` | Receipt view; an unknown id renders a demo receipt, not a 404 |
| `/api/pay` | One MPP 402 advertising **both** `hedera` and `stripe`, always. HTML for browsers: a real Stripe Elements form when `hasStripe()`, otherwise a disabled `demo mode` panel |
| `/api/pay/token` | Mints a Stripe Shared Payment Token for the card form; 503 in demo mode |
| `/api/testnet/fund` | Test-buyer USDC faucet; 403 unless the resolved network is testnet |

## Production switches — do not weaken

- `HEDERA_NETWORK` (`testnet` default, or `mainnet`) is read only through `resolvedNetwork()` in `lib/hederaOperator.ts`. `lib/mppx.ts` derives USDC id, Mirror Node and chain id from it.
- `/api/testnet/fund` checks `resolvedNetwork() === "testnet"` itself, before anything else. Keep that check in the handler.
- The `stripe` rail is advertised in the 402 even in demo mode (its `networkId` reads
  `demo`). This is deliberate: one challenge carrying both card and Hedera is the point
  of this template, and dropping the card rail without credentials would hide that from
  anyone running it unconfigured. Demo mode is made honest in the UI — the browser page
  renders a disabled `demo mode` panel — not by removing the offer.
- `lib/mppx.ts` throws at module load when the insecure default `MPP_SECRET_KEY` would be used on mainnet or with a live Stripe key.
- Import Stripe's method from `mppx/stripe/server/spt` and `Mppx` from `mppx/server/core`. The plain `mppx/server` and `mppx/stripe/server` entry points pull in Tempo, which fails to load against the pinned viem.

## Layout

```
packages/nextjs/
  app/                    App Router pages
    checkout/             Payment rail selection
    receipt/[id]/         Receipt view
  components/             ProductCard, PaymentOption, Header, Footer, …
  lib/
    demo.ts               Per-integration credential detection
    mppx.ts               MPP server: Hedera + Stripe charge methods, one challenge
    hederaOperator.ts     Operator client + resolvedNetwork() switch
    products.ts           Fixture catalogue (Product[])
  hooks/
    useHederaSigner.ts    Wallet + Hedera account identity
    scaffold-hbar/        Shared Scaffold-HBAR hooks (useTargetNetwork, …)
  public/products/        Local SVG placeholders — no remote image fetches
  utils/scaffold-hbar/    Hedera tx helpers, identity
  scaffold.config.ts      Target networks (testnet, mainnet), RPC, WalletConnect
  contracts/              deployedContracts.ts (empty — no Solidity workspace)
```

## Conventions

**Catalogue:** `lib/products.ts` exports `products: Product[]` where `Product = { id, name, priceUsd, image }`. Prices are decimal strings (`"12.00"`), never numbers — no float arithmetic on money. Images are local paths under `public/`; do not introduce remote image hosts, which break behind a firewall.

**Wallet + identity:** `useHederaSigner` wraps connection state and `requireProvider()` for mutations. Account IDs use `0.0.xxxxx` form; helpers in `utils/scaffold-hbar/hederaIdentity.ts` normalize EVM ↔ native identity. The burner connector must keep working — on-chain validation injects a key at `localStorage.burnerWallet.pk`.

**Keep the shell intact:** `Header.tsx`, `Footer.tsx`, `SwitchTheme.tsx`, `ThemeProvider.tsx`, `ScaffoldHbarAppWithProviders.tsx` and everything under `components/scaffold-hbar/` are the wallet and theme stack. Extend them; don't replace them.

## UI

Use `@scaffold-hbar-ui/components` for web3 UI (`Address`, `HederaAddressInput`, `Balance`, `HbarInput`, `HederaPortalFaucet`, etc.).

Use DaisyUI classes for layout and controls:

```tsx
<button className="btn btn-primary">Connect</button>
<div className="card bg-base-100 shadow-xl">...</div>
```

Import app code with the `~~` alias:

```tsx
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
```

## Networks

`packages/nextjs/scaffold.config.ts` — `hederaTestnet` and `hedera` mainnet. RPC overrides via `NEXT_PUBLIC_HEDERA_*_RPC_URL`. Default polling interval: 10s.

## Code style

| Style | Use for |
|---|---|
| `UpperCamelCase` | types, components, enums |
| `lowerCamelCase` | functions, variables, hooks |
| `CONSTANT_CASE` | constants |

Prefer `type` over `interface`. Comments only when they add non-obvious context.
