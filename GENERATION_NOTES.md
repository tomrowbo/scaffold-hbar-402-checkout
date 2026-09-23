# Generation notes

## PRD 04 — x402 comparison route (2026-09-23)

- Added `packages/nextjs/lib/x402.ts`: `x402Capability()` probes
  `${AX402_FACILITATOR_URL}/supported` once per process (3s `AbortSignal.timeout`, `no-store`)
  and resolves `{ live }` / `{ live: false, reason }` without ever rejecting. It matches
  `{ scheme: "exact", network: "hedera:testnet" }`. `canSettleX402()` folds that with
  `hasX402()`. `toBaseUnits()` scales decimal price strings by moving digits, never through
  floats. `hasX402()` is unchanged.
- Added `packages/nextjs/app/api/x402/route.ts`: x402 v2 `402` body (`accepts[0]` reuses
  `chargeRecipient()`, `USDC_TOKEN_ID`, `USDC_DECIMALS`), same product fallback as
  `/api/pay`, `demo: true` + `X-MPP-Demo-Mode: x402` when it can't settle, and a disabled
  HTML demo panel for browsers.
- Stopped at the challenge side, per the PRD timebox. `X-PAYMENT` against a live facilitator
  returns `501`, and `lib/orders.ts` and the receipt page are untouched. `lib/mppx.ts`,
  `/api/pay` and the checkout page are unchanged.
- Verified on a dev server in three configurations: no env (demo JSON and HTML), the live Ax402
  testnet facilitator (non-demo 402, `X-PAYMENT` → 501), and an unreachable facilitator
  (timeout → demo, no 500, cached on the next call). `/api/pay` still returns the two-rail
  402 in every case.
- Docs: route table, layout and x402 conventions in `AGENTS.md`; x402 section and layout
  in `README.md`; §1/§9 of `docs/mpp-vs-x402.md`.
