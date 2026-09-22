# 03 — Stripe card path

Add the Stripe card rail to the *same* `/api/pay` challenge from increment 02,
so one 402 advertises both `hedera` and `stripe`. Then wire the documented
production flip: this is a starter template, so it must keep booting with
zero credentials, but going live must be a switch, not an exercise left to
the reader.

## One challenge, two rails

In `lib/mppx.ts`, add `stripe.charge()` to the existing `methods` array
alongside the current `hedera.charge({...})` entry. Do **not** create a
second endpoint or a second `Mppx.create()` — one 402 must advertise both
methods so the client (human or agent) chooses.

**VERIFIED 2026-09-22 against mppx@0.10.1 in this repo — the obvious import is
broken here, use this one instead:**

`lib/mppx.ts` already imports `Mppx` from `'mppx/server/core'` rather than
`'mppx/server'`, because `mppx/server`'s index re-exports the built-in Tempo
method, which imports the `viem/tempo` subpath — a subpath this project's
pinned `viem@2.39.0` does not define, so the whole module throws at import
time (`ERR_PACKAGE_PATH_NOT_EXPORTED`), not just when Tempo is used.

`mppx/stripe/server` has the **identical** problem, for the identical reason:
its `index.js` does `export { stripe } from './Methods.js'`, and that
`Methods.js` (the one under `stripe/server/`, not the one directly under
`stripe/`) unconditionally imports `tempo/server/Charge.js`, which imports
`viem/tempo`. Confirmed by direct test in this workspace:

    import('mppx/stripe/server')
    // throws: Package subpath './tempo' is not defined by "exports" in
    // .../node_modules/viem/package.json imported from
    // .../node_modules/mppx/dist/tempo/server/Charge.js

Use `mppx/stripe/server/spt` instead — also a real, documented export
(`package.json#exports["./stripe/server/spt"]`), and confirmed working in
this workspace. It re-exports the exact same `charge` function without
pulling in `Methods.js`/Tempo:

    import Stripe from "stripe";
    import { hedera } from "mppx-hedera/server";
    import { stripe } from "mppx/stripe/server/spt";
    import { Mppx } from "mppx/server/core";

    export const mppx = Mppx.create({
      methods: [
        hedera.charge({ /* unchanged from increment 02 */ }),
        stripe.charge({
          client: new Stripe(process.env.STRIPE_SECRET_KEY!),
          networkId: process.env.STRIPE_NETWORK_ID!,
          livemode: !process.env.STRIPE_SECRET_KEY?.includes("_test_"),
          paymentMethodTypes: ["card"],
          html: {
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
            createTokenUrl: "/api/pay/token",
          },
        }),
      ],
      // ...unchanged realm/secretKey from increment 02
    });

Only build `stripe.charge(...)` when `hasStripe()` is true, and push it onto
the `methods` array conditionally — the array must contain only `hedera` when
Stripe credentials are absent (see Demo mode below). `stripe.charge()` throws
if constructed without a usable `client`/`secretKey`, so it cannot simply be
included with empty env strings.

Add `stripe` (the real npm package, for `new Stripe(...)`) as a dependency of
`packages/nextjs` — it is not currently installed. `mppx`'s `StripeClient`
type is duck-typed and doesn't strictly require it, but the wiring above
constructs a real client with it.

`stripe.charge` here is the same underlying function as `stripe.spt` (the
`stripe/server/spt` module literally does `export const stripe = { charge,
spt: charge }`), so either name is correct; use `.charge` to match this PRD
and the product story ("charge", not "session").

## Browser vs agent

The `html` option renders a Stripe Elements card form when the request
carries `Accept: text/html`, and returns the machine-readable challenge JSON
otherwise — same URL, same route, no branching needed in `app/api/pay/route.ts`
beyond what already exists.

That embedded page calls `POST {createTokenUrl}` client-side to mint a Stripe
Shared Payment Token (SPT) before retrying the challenge. Confirmed from the
shipped bundle (`mppx/dist/stripe/server/internal/html.gen.js`): it does

    fetch(createTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod, amount, currency, networkId, expiresAt, metadata }),
    })

and expects a JSON response shaped `{ spt: string }` (any other shape, or a
non-2xx status, surfaces as a page error).

Create `app/api/pay/token/route.ts` implementing that contract: accept the
POST body above, use the installed `stripe` SDK client to create a Shared
Payment Token for the given `paymentMethod` against `networkId` (the Stripe
Business Network profile), and respond `{ spt: <token id> }`. Consult the
installed `stripe` package's own TypeScript types for the exact v2 network
API call — this PRD specifies the contract (request/response shape), not the
Stripe SDK method name, since that surface isn't pinned down elsewhere in this
repo. Return 503 (matching the shape of other demo-mode-off responses in this
codebase) if `hasStripe()` is false, so this route never has to guess at a
missing client.

## Demo mode

`hasStripe()` in `lib/demo.ts` already requires all three of
`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_NETWORK_ID` — leave
it as-is unless you find it no longer does, and fix it here if so.

When `hasStripe()` is false: omit the `stripe.charge()` entry from `methods`
entirely (a single `hedera`-only challenge is still well-formed), and leave
`app/checkout/page.tsx`'s existing "Card" `PaymentOption` — already gated on
`hasStripe()` — alone; it already renders the option disabled. Hedera and
x402 must be completely unaffected by Stripe's presence or absence —
per-integration, never global, matching the pattern `lib/demo.ts` already
documents.

## Production flip

This template ships demo-first — it must keep booting and every rail must
keep rendering with zero credentials. Going live is one documented switch,
not an exercise left to the reader:

| Rail | Demo (default) | Production |
|---|---|---|
| Hedera | `HEDERA_NETWORK=testnet` (default), USDC `0.0.5449` | `HEDERA_NETWORK=mainnet`, USDC `0.0.456858` |
| Stripe | `sk_test_` key -> `livemode: false` | `sk_live_` key -> `livemode: true` |
| MPP secret | insecure literal default | `MPP_SECRET_KEY`, 32+ bytes, required |
| Faucet route | enabled | hard-disabled |

Implement all four rows:

1. **`lib/hederaOperator.ts` must stop hardcoding `Client.forTestnet()`.**
   Read `process.env.HEDERA_NETWORK` (default `"testnet"`) and select
   `Client.forTestnet()` / `Client.forMainnet()`. Export a small helper (e.g.
   `resolvedNetwork(): "testnet" | "mainnet"`) that both this file and
   `lib/mppx.ts` use, so they cannot drift.

2. **`lib/mppx.ts`'s `USDC_TOKEN_ID`, `HEDERA_NETWORK`, and `MIRROR_NODE_URL`
   must follow the same switch**, and be passed through to
   `hedera.charge({ testnet: ..., mirrorNodeUrl: ... })` (mppx-hedera's
   `testnet: boolean` option controls chain id 296 vs 295 internally, per
   `types/mppx-hedera.d.ts`; `mirrorNodeUrl` is not currently passed and
   defaults to testnet's, so it must be passed explicitly once mainnet is
   reachable). Confirmed mainnet mirror node REST base:
   `https://mainnet.mirrornode.hedera.com` (Hedera docs, `operators/mirror-node`
   — do not use an unverified `mainnet-public...` host).

3. **CRITICAL — `app/api/testnet/fund/route.ts` must refuse with 403 unless
   the resolved network is testnet, checked in the route itself**, not
   inferred from `canSettle()` or any other proxy. Today its only protection
   is a comment plus a hardcoded `Client.forTestnet()` elsewhere; once mainnet
   is a supported setting, an unauthenticated faucet that transfers operator
   USDC to any posted account id is a live hazard. It must be impossible to
   enable the faucet on mainnet by configuration alone — the guard belongs in
   the route handler, checked before any operator client is constructed.

4. **The app must refuse to start on mainnet with the insecure default
   `MPP_SECRET_KEY`.** The literal fallback in `lib/mppx.ts`
   (`INSECURE_DEV_SECRET_KEY`) exists so demo mode works with an empty
   `.env`; on a mainnet-resolved network, falling back to it must be a hard
   error thrown at module init (module load, not a warning, not deferred to
   first request) — a starter template must fail loudly rather than silently
   accept card/Hedera payments signed with a public, checked-in secret.

`livemode` for Stripe is derived from the key prefix, matching Stripe's
documented pattern: `!process.env.STRIPE_SECRET_KEY.includes("_test_")` — do
not add a separate `STRIPE_LIVEMODE` variable.

The bounty gate requires testnet, so shipped defaults stay testnet and demo —
none of this asks a judge to configure anything. Document the flip in a
follow-up increment; this one only has to make it a working switch.

## Out of scope

Stripe's own crypto rails (`tempo`, `base`, `solana` via
`stripe.create().defaultMethods()`). Hedera is not among them, which is the
entire point of this template — do not attempt to use them, and do not import
`mppx/stripe/server` (only `mppx/stripe/server/spt`, per above). Writing the
user-facing flip documentation (README / deployment section) — that is a
later increment; this one only has to make the switch work correctly when
the documented env vars are set.
