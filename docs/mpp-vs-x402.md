# MPP and x402, against the same checkout

Two protocols answer HTTP `402` for machine buyers. This template serves the *same* product,
at the *same* price, to the *same* merchant account, over both — so the protocol envelope is
the only thing that differs between them. This document reads the two side by side.

**Where the author stands.** I wrote `mppx-hedera`, the native Hedera method for MPP, and
the two Hedera drafts in [`tempoxyz/mpp-specs`](https://github.com/tempoxyz/mpp-specs) —
`draft-hedera-charge-00` and `draft-hedera-session-00`, co-authored with Lindsay Walker of
Hedera / Swirlds Labs. So take the MPP enthusiasm with the appropriate salt. x402 has an
official Hedera facilitator, more deployed tooling, and an existing scaffold-hbar template;
this document says where it wins, because a comparison that only flatters one side is not
worth reading.

---

## 1. The same $24 purchase, two challenges

### MPP

Captured from this store, running with no credentials configured:

```console
$ curl -i -H 'Accept: application/json' 'http://localhost:3000/api/pay?product=hbar-tee'
HTTP/1.1 402 Payment Required
content-type: application/problem+json
www-authenticate: Payment id="-_xEH9…X6o", realm="localhost:3000", method="hedera",
  intent="charge", request="eyJhbW91bnQiOiIyNDAwMDAwMCIs…", description="MPP Checkout — HBAR Logo Tee",
  expires="2026-09-22T23:35:57.547Z", opaque="eyJhbW91bnRVc2Qi…",
  Payment id="x_FqL…ByWk", realm="localhost:3000", method="stripe",
  intent="charge", request="eyJhbW91bnQiOiIyNDAwIiw…", description="MPP Checkout — HBAR Logo Tee",
  expires="2026-09-22T23:35:57.556Z", opaque="eyJhbW91bnRVc2Qi…"
```

`request` is base64url JSON. Decoded, the two offers are:

```json
{ "amount": "24000000", "currency": "0.0.5449", "methodDetails": { "chainId": 296 }, "recipient": "0.0.0" }
{ "amount": "2400",     "currency": "usd",      "methodDetails": { "networkId": "demo", "paymentMethodTypes": ["card"] } }
```

The body is an RFC 9457 problem document — human- and machine-readable, but not where the
offer lives. The offer is in the header.

### x402

The same purchase expressed as an x402 v2 payment-required body, for the `exact` scheme on
`hedera:testnet`:

```json
{
  "x402Version": 2,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "hedera:testnet",
      "maxAmountRequired": "24000000",
      "resource": "http://localhost:3000/api/x402?product=hbar-tee",
      "description": "MPP Checkout — HBAR Logo Tee",
      "mimeType": "application/json",
      "payTo": "0.0.0",
      "maxTimeoutSeconds": 60,
      "asset": "0.0.5449"
    }
  ]
}
```

Same token, same base units, same recipient. The offer is in the body.

---

## 2. Header or body

| | MPP | x402 |
|---|---|---|
| Offer lives in | `WWW-Authenticate: Payment` (one per rail) | JSON response body, `accepts[]` |
| Credential | `Authorization: Payment <base64url>` | `X-PAYMENT` (v1/v2), `PAYMENT-SIGNATURE` in v2 |
| Receipt | `Payment-Receipt` response header | `PAYMENT-RESPONSE` header (v2) |
| Body on 402 | RFC 9457 problem document | the offer itself |

MPP is a registered-shape HTTP authentication scheme: a `402` plus `WWW-Authenticate`, a
retry with `Authorization`, exactly the challenge/response cycle `Basic` and `Bearer` use.
That has practical consequences. It composes with existing auth middleware, it survives
`HEAD` requests, and the resource's own response body is untouched by payment — a paid JSON
API returns its JSON, not a payment envelope wrapped around it.

x402 putting the offer in the body is simpler to read, simpler to log, and simpler to write
by hand. You can `curl` an x402 endpoint and see the whole offer without decoding anything,
which is worth more than it sounds when you are debugging at 2am. MPP's base64url `request`
blobs are not hostile, but they are one step removed from legible.

---

## 3. One challenge, several rails

This is MPP's structural advantage, and it is the reason this template exists.

`WWW-Authenticate` is defined to carry a list of challenges. MPP uses that: one `402` can
offer a card charge *and* an on-chain USDC transfer, and the client picks. The two offers
are not variants of one payment — they are different money with different units
(`2400` cents versus `24000000` USDC base units), different settlement systems, and
different failure modes, advertised together. A browser takes the card; an agent with a
Hedera key takes the token transfer. Neither needs to know the other exists.

x402's `accepts[]` is also a list, so it can also offer several options — but they are
`{scheme, network, asset}` triples. The array is built to express *"USDC on Base, or USDC on
Hedera, or USDC on Solana"*. There is no obvious place in an `accepts` entry for "Visa,
through Stripe", because the whole entry assumes an on-chain asset and a network id.

So: both protocols list alternatives; MPP's list is heterogeneous by construction, x402's is
homogeneous by construction. If your checkout only ever takes crypto, this difference costs
you nothing. See [`card-and-crypto.md`](card-and-crypto.md) for what it buys when it does
matter.

---

## 4. Settlement: facilitator or not

**x402 on Hedera settles through a facilitator.** Ax402 runs one at
`https://testnet.facilitator.ax402.io`, and it advertises what it supports:

```console
$ curl -s https://testnet.facilitator.ax402.io/supported | jq '.kinds[] | select(.network|startswith("hedera"))'
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "hedera:testnet",
  "extra": { "feePayer": "0.0.9839454" }
}
```

The merchant `POST`s to the facilitator's `/verify` and `/settle`; the facilitator does the
chain work. Note `network` is `hedera:testnet` — a CAIP-2-style namespace, *not*
`eip155:296`. The facilitator's EVM networks do use `eip155:` chain ids (Base Sepolia
`eip155:84532`, Flare Coston2 `eip155:114`), so the mismatch is easy to introduce and gets
debugged as a payment bug rather than a wrong constant.

**MPP on Hedera in this template settles with no facilitator.** The buyer transfers USDC
directly to the merchant account with a 32-byte attribution memo derived from the challenge
id, and the server reads that transfer back from the public Mirror Node:

```console
$ curl -s 'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10672305-1790118570-306232317' \
  | jq '.transactions[0] | {result, name, token_transfers}'
{ "result": "SUCCESS", "name": "CRYPTOTRANSFER",
  "token_transfers": [
    { "token_id": "0.0.5449", "account": "0.0.8569027",  "amount": 24000000 },
    { "token_id": "0.0.5449", "account": "0.0.10672305", "amount": -24000000 } ] }
```

Nothing sits between merchant and ledger. No third party can censor the payment, go down
during a sale, change its fee, or learn the merchant's order book. The merchant's trust
assumption is the Hedera Mirror Node — which is public, replicated, and something they can
run themselves.

The honest counterweight: a facilitator is doing real work for you. It abstracts the chain,
it can pay gas on the buyer's behalf (note `extra.feePayer` above), it hides per-chain
signing differences, and it means a merchant integrating four chains writes one integration
instead of four. "No facilitator" also means "no one to call". If your team has no chain
expertise and no desire to acquire any, a facilitator is a feature, not a tax.

---

## 5. Standards position

MPP's core wire format is an IETF Internet-Draft:
[`draft-ryan-httpauth-payment`](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/)
("The 'Payment' HTTP Authentication Scheme", currently `-01`), with intents — `charge`,
`session`, `subscription` — and per-method drafts specified alongside it in
[`tempoxyz/mpp-specs`](https://github.com/tempoxyz/mpp-specs). Stripe and Tempo are behind
it.

x402 has a substantial IETF presence too, but a different shape: around twenty individual
drafts *extending* x402 — receipt formats, DNS discovery, RFC 9421 message-signature
binding, post-quantum credential binding — while the core protocol itself is specified and
versioned by its implementers rather than as an I-D.

Neither is a working-group document. Both are individual submissions at this stage, and
being an Internet-Draft is not the same as being a standard — anyone can publish one. What
it does buy MPP is a wire format defined in the HTTP authentication framework's own terms
and reviewable through an established process. Weigh that as you like.

---

## 6. Where x402 is the better choice

- **It is simpler.** A JSON body, a base64 header, a facilitator call. You can implement a
  client against it in an afternoon without reading an auth-scheme spec.
- **It has an official Hedera facilitator today.** Ax402 is live, and the `/supported`
  response above is real. MPP's Hedera path is newer.
- **It has more mileage.** More deployed endpoints, more client libraries, more people who
  have hit the failure modes before you.
- **It already has a scaffold-hbar template.** If you want an x402 store on Hedera, that
  path is paved.
- **It spans chains through one abstraction.** Its facilitator model is genuinely good at
  "the same endpoint, payable on four chains".

## 7. Where MPP is the better choice

- **Heterogeneous rails in one challenge.** Card and on-chain USDC advertised together, in
  one header, to one client. x402 has no natural way to express the card.
- **No facilitator in the settlement path.** Direct transfer, direct Mirror Node
  verification — fewer parties, fewer failure modes, no per-transaction intermediary.
- **It is an HTTP auth scheme.** The resource's own body stays the resource's own body;
  payment lives entirely in the auth headers, composing with what is already there.
- **Intents beyond one-shot charges.** `session` (escrow plus signed vouchers — thousands of
  calls, one on-chain transaction) and `subscription` are specified, not just imagined.
  `mppx-hedera` implements `session` today.
- **Its core is on the IETF track**, for whatever weight your organisation puts on that.

## 8. Picking one

- Selling to browsers *and* agents, or taking cards *and* tokens → MPP. That is the only one
  of the two that expresses it.
- Metered API calls, many small charges to the same client → MPP's `session` intent, which
  has no x402 equivalent.
- One crypto rail, several chains, minimal integration effort, ship this week → x402 with a
  facilitator.
- Hedera-only, and you want nothing between you and the ledger → MPP's native Hedera method.
- Already have an x402 endpoint that works → there is no urgent reason to move it. These
  protocols coexist on the same host; this template runs both.

---

## 9. What this repository actually runs

Precision here, because a comparison that overstates its own implementation is worthless:

- **MPP is fully implemented and settled on testnet.** `/api/pay` issues the two-rail
  challenge above with no configuration; with `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`
  set it verifies real USDC transfers against the Mirror Node and returns `Payment-Receipt`.
  Transaction `0.0.10672305@1790118570.306232317` is one it settled
  ([HashScan](https://hashscan.io/testnet/transaction/0.0.10672305@1790118570.306232317)).
- **The Stripe card rail** is a second MPP method on that same challenge, live once the
  three `STRIPE_*` variables are set.
- **x402 is the comparison rail.** It is gated on `AX402_FACILITATOR_URL` through `hasX402()`
  in `lib/demo.ts` and shown as a third option on `/checkout`, disabled with a demo-mode note
  until that variable is set. The x402 challenge body in §1 is the shape this store serves
  for the same product; the facilitator `/supported` output in §4 is captured live. x402
  settlement is not wired end to end in this template — it would mean `POST /verify` and
  `POST /settle` against the facilitator plus a buyer-side signing flow for the `exact`
  scheme on `hedera:testnet`, which is a second payment integration, not a corner of this
  one.

A related data point, from reading the `mppx` package itself: its own x402 adapter
(`mppx/x402`) is EVM-only — `evmNetworkPrefix` is `'eip155:'` and its network type is
`` `eip155:${number}` ``. It cannot express `hedera:testnet` either. Hedera's non-EVM
CAIP-2 namespace is currently something you reach through the Ax402 facilitator or through a
native method, not through the generic tooling of either protocol.

---

## Sources

- `draft-ryan-httpauth-payment-01`, *The "Payment" HTTP Authentication Scheme* —
  <https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/>
- MPP specs, including `specs/methods/hedera/draft-hedera-charge-00.md` and
  `draft-hedera-session-00.md` — <https://github.com/tempoxyz/mpp-specs>
- Ax402 testnet facilitator `/supported` — <https://testnet.facilitator.ax402.io/supported>
  (captured 2026-09-23)
- Hedera Mirror Node REST API — <https://testnet.mirrornode.hedera.com/api/v1/docs/>
- `mppx` 0.10.1 and `mppx-hedera` 0.2.2, as pinned in `packages/nextjs/package.json`
