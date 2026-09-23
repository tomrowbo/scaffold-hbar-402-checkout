# Scaffold-HBAR — MPP Checkout

A merch storefront whose `/api/pay` endpoint answers `402` with **one Machine Payments
Protocol challenge that advertises two rails at once** — a Stripe card charge and a native
Hedera USDC transfer — plus an x402 rail beside it so the two 402 protocols can be compared
against the same store, the same product and the same amount.

It boots with **no `.env` file and no environment variables at all**. Each rail switches
itself on independently once its own variables are present, so a developer holding only
Stripe keys gets a live card path and honest demo stubs everywhere else.

## Create a project

```bash
npm create scaffold-hbar@latest -- --template mpp-checkout
```

## Run it with no credentials

```bash
yarn install
yarn next:dev    # http://localhost:3000
```

That is the whole setup. Open <http://localhost:3000>, pick an item, and walk through
checkout. `/`, `/checkout` and `/receipt/[id]` all render; every payment control shows a
disabled **demo mode** panel naming the variables that would enable it. Nothing 404s, nothing
throws, and an unknown receipt id renders a demo receipt rather than an error.

The protocol is live even in demo mode. Ask the endpoint for a challenge:

```console
$ curl -i -H 'Accept: application/json' 'http://localhost:3000/api/pay?product=hbar-tee'
HTTP/1.1 402 Payment Required
content-type: application/problem+json
www-authenticate: Payment id="-_xEH9nHBj52K3idMY3JbZKLzk2WyzZhHqb_srQ9X6o", realm="localhost:3000",
  method="hedera", intent="charge", request="eyJhbW91bnQiOiIyNDAwMDAwMCIsImN1cnJlbmN5IjoiMC4wLjU0NDkiLCJtZXRob2REZXRhaWxzIjp7ImNoYWluSWQiOjI5Nn0sInJlY2lwaWVudCI6IjAuMC4wIn0",
  description="MPP Checkout — HBAR Logo Tee", expires="2026-09-22T23:35:57.547Z",
  opaque="eyJhbW91bnRVc2QiOiIyNC4wMCIsInByb2R1Y3QiOiJoYmFyLXRlZSJ9",
  Payment id="x_FqLNbLofS75N7jKaDnBRfZa3svPhh6ZJ_X6i2ByWk", realm="localhost:3000",
  method="stripe", intent="charge", request="eyJhbW91bnQiOiIyNDAwIiwiY3VycmVuY3kiOiJ1c2QiLCJtZXRob2REZXRhaWxzIjp7Im5ldHdvcmtJZCI6ImRlbW8iLCJwYXltZW50TWV0aG9kVHlwZXMiOlsiY2FyZCJdfX0",
  description="MPP Checkout — HBAR Logo Tee", expires="2026-09-22T23:35:57.556Z",
  opaque="eyJhbW91bnRVc2QiOiIyNC4wMCIsInByb2R1Y3QiOiJoYmFyLXRlZSJ9"
x-mpp-demo-mode: hedera,stripe
```

(Header folded here for reading; it is one line on the wire.)

That is **one `WWW-Authenticate` header carrying two `Payment` challenges**. Base64url-decode
the two `request` blobs and the same $24.00 purchase appears priced on two different rails:

```json
{ "amount": "24000000", "currency": "0.0.5449", "methodDetails": { "chainId": 296 }, "recipient": "0.0.0" }
{ "amount": "2400",     "currency": "usd",      "methodDetails": { "networkId": "demo", "paymentMethodTypes": ["card"] } }
```

USDC base units on Hedera testnet token `0.0.5449`; cents in USD on Stripe. `recipient`
is `0.0.0` and `networkId` is `demo` because nothing is configured yet —
`x-mpp-demo-mode: hedera,stripe` says exactly which rails are stubbed. Configure a rail and
its half of this header becomes real, independently of the other.

## Rail: Hedera USDC (native, no facilitator)

The buyer transfers USDC directly to the merchant account with a 32-byte MPP attribution
memo derived from the challenge id. The server re-reads that transfer from the Hedera Mirror
Node before it issues a receipt. There is no facilitator and no escrow contract in the path.

```bash
# packages/nextjs/.env
HEDERA_OPERATOR_ID=0.0.xxxxxxx
HEDERA_OPERATOR_KEY=0x...
HEDERA_RECIPIENT_ID=0.0.yyyyyyy   # optional; defaults to the operator
```

Get a testnet account and key from the [Hedera Portal](https://portal.hedera.com/).
`HEDERA_OPERATOR_KEY` accepts `0x`-prefixed ECDSA hex, bare ECDSA hex, DER, or ED25519 —
see `parseOperatorKey` in `packages/nextjs/lib/hederaOperator.ts`.

Set `HEDERA_RECIPIENT_ID` to something other than the operator if you intend to pay from the
operator account itself: a transfer from an account to itself is rejected up front with
*"Buyer and merchant are the same account"* rather than being submitted and failing on chain.

**Verify it.** Restart `yarn next:dev` and request a challenge again. `recipient` in the
decoded Hedera `request` is now your account, and `x-mpp-demo-mode` no longer lists `hedera`:

```console
$ curl -sI -H 'Accept: application/json' 'http://localhost:3000/api/pay?product=hbar-tee' | grep -i x-mpp-demo-mode
x-mpp-demo-mode: stripe
```

Then buy something. Open `/checkout`, connect a Hedera wallet (or let the burner signer at
`localStorage['burnerWallet.pk']` pay), and click **Pay with Hedera**. The flow is: 402 →
sign a USDC transfer carrying the attribution memo → retry with
`Authorization: Payment <credential>` → `200` with a `Payment-Receipt` header.

A settlement from this template on Hedera testnet:

```
transaction  0.0.10672305@1790118570.306232317
hashscan     https://hashscan.io/testnet/transaction/0.0.10672305@1790118570.306232317
```

Confirm it yourself against the Mirror Node — no trust in this README required:

```console
$ curl -s 'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10672305-1790118570-306232317' \
  | jq '.transactions[0] | {result, name, token_transfers}'
{
  "result": "SUCCESS",
  "name": "CRYPTOTRANSFER",
  "token_transfers": [
    { "token_id": "0.0.5449", "account": "0.0.8569027",  "amount": 24000000,  "is_approval": false },
    { "token_id": "0.0.5449", "account": "0.0.10672305", "amount": -24000000, "is_approval": false }
  ]
}
```

24.000000 USDC (`0.0.5449`, 6 decimals) moved from buyer to merchant, and the retried
request returned `200` with a matching `Payment-Receipt`. Note the Mirror Node's
transaction-id form uses hyphens (`0.0.x-seconds-nanos`) where the protocol and HashScan
use `@`.

> Testnet USDC in this template is **`0.0.5449`**. `0.0.429274` is a *different* testnet
> token with the same name, symbol and decimals — charges against it cannot be verified here.

## Rail: Card (Stripe)

The card rail is a second MPP method on the same challenge. Browsers requesting `/api/pay`
with `Accept: text/html` get a real Stripe Elements form; agents asking for JSON get the
challenge. The form mints a Shared Payment Token through `/api/pay/token` and retries the
402 with it.

```bash
# packages/nextjs/.env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_NETWORK_ID=...            # your Stripe MPP network id
```

All three are required — `hasStripe()` in `packages/nextjs/lib/demo.ts` is an AND.

**Verify it.** With Stripe unconfigured the token endpoint refuses in a readable way:

```console
$ curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:3000/api/pay/token
{"error":"demo_mode","detail":"Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_NETWORK_ID to enable card payments."}
```

Configure the three variables, restart, and check two things: `x-mpp-demo-mode` drops
`stripe`, and `curl -H 'Accept: text/html' 'http://localhost:3000/api/pay?product=hbar-tee'`
returns a Stripe Elements card form instead of the inert demo panel. Pay with Stripe's
`4242 4242 4242 4242` test card and `/receipt/[id]` renders the settled order.

The card offer is advertised in the 402 **even when Stripe is unconfigured** — deliberately,
so that a developer running this template with no keys still sees the two-rail challenge that
is the point of it. Demo mode is made honest in the UI (a disabled `demo mode` panel), not by
deleting the offer. See [`docs/card-and-crypto.md`](docs/card-and-crypto.md).

## Rail: x402

x402 is a different protocol, not another MPP method: a JSON-body 402 that settles through a
facilitator. It sits beside the MPP endpoint so the two can be read against the same store.

```bash
# packages/nextjs/.env
AX402_FACILITATOR_URL=https://testnet.facilitator.ax402.io
```

**Verify it.** Check that the facilitator will actually settle on Hedera before you rely on
it — its `/supported` endpoint advertises what it can do:

```console
$ curl -s https://testnet.facilitator.ax402.io/supported \
  | jq '.kinds[] | select(.network | startswith("hedera"))'
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "hedera:testnet",
  "extra": { "feePayer": "0.0.9839454" }
}
```

The Hedera network identifier is **`hedera:testnet`**, not `eip155:296`. Passing the chain-id
form silently matches nothing in `kinds` and gets debugged as a payment bug rather than a
wrong constant.

`/api/x402` serves the same purchase as an x402 v2 challenge: same product, same USDC base
units, same `payTo` and `asset` as the Hedera offer on `/api/pay`. It follows the same
product-fallback rule and the same `X-MPP-Demo-Mode` convention:

```console
$ curl -si -H 'Accept: application/json' 'http://localhost:3000/api/x402?product=hbar-tee'
HTTP/1.1 402 Payment Required
x-mpp-demo-mode: x402

{"x402Version":2,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact",
 "network":"hedera:testnet","maxAmountRequired":"24000000","resource":"http://localhost:3000/api/x402?product=hbar-tee",
 "description":"MPP Checkout — HBAR Logo Tee","mimeType":"application/json","payTo":"0.0.0",
 "maxTimeoutSeconds":60,"asset":"0.0.5449"}],"demo":true}
```

With `AX402_FACILITATOR_URL` set, the server asks the facilitator's `/supported` once, on the
first request (3s timeout), and caches the answer for the life of the process. If
`exact` on `hedera:testnet` is listed, `demo` and the header go away. If the facilitator
is unreachable or doesn't list Hedera, the route stays in demo mode instead of failing, and
the other rails are unaffected. The x402 option on `/checkout` leaves demo mode whenever
the variable is set.

**Scope:** only the challenge side is implemented. Settlement (`/verify` and `/settle`
against the facilitator, plus a buyer-side signing flow) is not wired, so a retried
`X-PAYMENT` against a live facilitator gets `501 Not Implemented`, never a fake receipt.
[`docs/mpp-vs-x402.md`](docs/mpp-vs-x402.md) compares the two challenge formats line by line.

## Going to production

| Switch | Effect |
|---|---|
| `HEDERA_NETWORK=mainnet` | Moves network, USDC token id (`0.0.456858`) and Mirror Node **together**, so the charge, the settlement check and the HashScan links can never disagree. Read only through `resolvedNetwork()` in `lib/hederaOperator.ts`; any value other than `testnet`/`mainnet` throws rather than being guessed at. |
| `STRIPE_SECRET_KEY=sk_live_...` | Stripe `livemode` derives from the key prefix alone. Live keys mint SPTs through the issued-tokens API rather than the test helper. |
| `MPP_SECRET_KEY` | **Required** on mainnet or with a live Stripe key. `lib/mppx.ts` throws at module load — so startup fails, not some later request — if real money could be taken against the public default. Generate one with `openssl rand -base64 32`. |
| `/api/testnet/fund` | The test-buyer USDC faucet. It checks `resolvedNetwork() === "testnet"` as the first thing it does and returns `403` on mainnet. No configuration turns it back on. |

Orders are held in an in-memory `Map` keyed by challenge id (`lib/orders.ts`). That is fine
for one `next start` process; swap `orderStore()` for Redis, Postgres or mppx's
`Store.Store` before running more than one instance.

## Paying as an agent

The endpoint is built for programmatic buyers, and paying it from Node is about 30 lines.
[`AGENTS.md`](AGENTS.md) has a runnable script: request the challenge, sign the USDC
transfer, retry with the credential, read the receipt.

## Scripts

| Command | Description |
|---|---|
| `yarn install` | Install (Yarn 3.2.3; this template is Yarn-only) |
| `yarn next:dev` | Dev server at <http://localhost:3000> |
| `yarn next:build` | Production build |
| `yarn next:check-types` | TypeScript check |
| `yarn lint` | ESLint |
| `yarn format` | Prettier |
| `node scripts/e2e-charge.mjs <burner-key> [product]` | End-to-end charge against a running dev server: 402 → sign → retry → receipt. Needs `HEDERA_OPERATOR_*` set and `yarn next:dev` running |

## Project layout

```
packages/nextjs/
  app/
    page.tsx              Store — fixture catalogue
    checkout/             Card, Hedera and x402 options, each independently gated
    receipt/[id]/         Receipt view; an unknown id renders a demo receipt
    api/pay/              One MPP 402 advertising both hedera and stripe
    api/pay/token/        Mints a Stripe Shared Payment Token; 503 in demo mode
    api/testnet/fund/     Test-buyer USDC faucet; 403 unless the network is testnet
    api/x402/             The same offer as an x402 v2 challenge (challenge side only)
  lib/
    demo.ts               hasHedera() / hasStripe() / hasX402() — per-rail detection
    mppx.ts               MPP server: both charge methods, one challenge
    hederaCheckout.ts     Browser half of the Hedera rail (402 → sign → retry)
    hederaOperator.ts     Operator client and resolvedNetwork()
    orders.ts             Settled-order store, keyed by challenge id
    x402.ts               Facilitator capability probe and canSettleX402()
    products.ts           Fixture catalogue (prices are decimal strings, never floats)
  components/             Storefront components + the Scaffold-HBAR wallet/theme stack
  public/products/        Local SVG placeholders — nothing is fetched remotely
scripts/
  e2e-charge.mjs          Exercises the pull-mode Hedera payment path end to end
```

Prerequisites: Node.js ≥ 20.18.3, Git, Yarn. Wallet connection additionally uses
`NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` from [Reown / WalletConnect Cloud](https://cloud.reown.com).
`packages/nextjs/.env.example` lists every variable.

## Further reading

- [`docs/mpp-vs-x402.md`](docs/mpp-vs-x402.md) — the two 402 protocols against an identical
  checkout: challenge formats side by side, facilitator versus no facilitator, where each one
  is the better fit.
- [`docs/card-and-crypto.md`](docs/card-and-crypto.md) — how one challenge carries a fiat
  rail and an on-chain rail, and why a merchant on Stripe's own MPP rails cannot accept
  Hedera today.
- [`AGENTS.md`](AGENTS.md) — architecture, the no-credentials rule, and paying the endpoint
  as an agent.

## Links

- [Scaffold HBAR docs](https://docs.hedera.com/solutions/tools/scaffold-hbar/index)
- [create-scaffold-hbar](https://github.com/hedera-dev/create-scaffold-hbar) — the CLI
- [MPP](https://mpp.dev/) · [`draft-ryan-httpauth-payment`](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/) · [mppx](https://github.com/wevm/mppx)
- [Hedera docs](https://docs.hedera.com/) · [HashScan testnet](https://hashscan.io/testnet)
