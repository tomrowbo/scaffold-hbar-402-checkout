# Generation notes

## 01 — Replace the seed demo with the storefront shell

Replaced the seeded `hedera-demo` proof wall with a merch storefront. No payment logic
yet — this increment is the shell only.

**Removed.** The PRD-listed seed files (`app/admin`, `app/my-proofs`, `app/api/hedera/**`,
and the `BadgeDisplay` / `ProofCard` / `ProofWall` / `SubmitProofForm` / `TopicSelector`
components), plus the modules that only those files imported and that would otherwise
have been left as dead code pointing at deleted API routes:
`hooks/{useBadgeTokens,useCreateToken,useCreateTopic,useSubmitProof,useTopicMessages}.ts`,
`services/{badgeService,hederaClient,mirrorNode}.ts`, `config/proofWallConfig.ts`,
`types/hederaFetchJson.ts`, and the three `utils/scaffold-hbar/*TransactionId*` /
`topicIdByTransaction` resolvers.

**Kept.** The wallet and theme stack untouched — `Header`, `Footer`, `SwitchTheme`,
`ThemeProvider`, `ScaffoldHbarAppWithProviders`, all of `components/scaffold-hbar/`,
`hooks/useHederaSigner.ts` and `utils/scaffold-hbar/{hederaIdentity,hederaTxUtils}.ts`
(the last two are still imported by `NativeTransactionSignerBridge`, so the burner
connector and `localStorage.burnerWallet.pk` injection keep working). `Header` menu links
now point at Store and Checkout.

**Added.**
- `lib/demo.ts` — three independent predicates (`hasHedera`, `hasStripe`, `hasX402`).
  They read server-only vars, so pages call them server-side and pass booleans down.
- `lib/products.ts` — four-item fixture catalogue, prices as decimal strings.
- `public/products/*.svg` — local placeholders, so nothing is fetched remotely.
- `/` (product grid, links to checkout), `/checkout` (Card / Hedera / x402, each disabled
  with a demo-mode note when its predicate is false), `/receipt/[id]` (unknown id renders
  a demo receipt, so `/receipt/demo-1` is a 200).

**Notes.**
- `/` is `force-dynamic` so rail status reflects the running process's env rather than
  being baked in at build time.
- Images use `next/image` with `unoptimized` — the optimizer refuses SVG by default, and
  this keeps the image pipeline offline.
- The receipt timestamp is a fixed constant rather than `new Date()`, so the page renders
  identically on every run.
- `.env.example` drops the two proof-wall vars and documents the three rails.
- The daisyUI `@import` ordering warning during `next:build` is pre-existing in
  `styles/globals.css` and untouched here.

**Verified.** `yarn lint` clean, `yarn next:build` succeeds, and all three routes return
200 with the expected visible text under a real browser, five runs in a row, with no
`.env` present. Per-integration detection confirmed by booting a second dev server with
only the three `STRIPE_*` variables set: Card flipped to live and enabled while Hedera and
x402 stayed disabled in demo mode.

**Pre-existing behaviour worth knowing when reading a failing gate.** The app renders
entirely client-side — the wallet provider shell suspends during SSR, so the initial HTML
is a shell and `curl` sees no page text. Assert on visible text after hydration, not on
the raw HTML. Two related quirks, both inherited and both untouched: the footer's HBAR
price fetch to `api.coingecko.com` fails offline (console noise only), and the first
request to each route under `next dev` blocks on compilation for 5-15s.
