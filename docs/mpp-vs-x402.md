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

The same purchase as an x402 v2 payment-required declaration, for the `exact` scheme on
`hedera:testnet`, captured from `/api/x402?product=hbar-tee` on the same store (with no
facilitator configured the body also carries `"demo": true`, and the response carries
`X-MPP-Demo-Mode: x402`):

```json
{
  "x402Version": 2,
  "error": "payment is required",
  "resource": {
    "url": "http://localhost:3000/api/x402?product=hbar-tee",
    "description": "MPP Checkout - HBAR Logo Tee",
    "mimeType": "application/json",
    "serviceName": "MPP Checkout"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "hedera:testnet",
      "amount": "24000000",
      "asset": "0.0.5449",
      "payTo": "0.0.0",
      "maxTimeoutSeconds": 30,
      "extra": {}
    }
  ]
}
```

Same token, same base units, same recipient.

Two things about that shape are worth pinning down, because both are v1 habits that a v2
client rejects outright. The amount field is `amount`; v1 called it `maxAmountRequired`. And
`resource` is an object at the top level — in v1 it was a URL string inside each `accepts[]`
entry, carrying `description` and `mimeType` with it.

The third is subtler: **v2 does not put the offer in the body at all.** The declaration above
also travels base64-encoded in a `PAYMENT-REQUIRED` response header, and that header is what
`@x402/core`'s client reads. Its `getPaymentRequiredResponse` falls back to the body only when
`x402Version` is `1`, so a v2 body served without the header fails as
`Invalid payment required response` — a perfectly shaped offer that no real client can see.
The body is served here anyway, because a legible `curl` is the whole point of the comparison,
but it is a copy rather than the contract.

With a facilitator configured, `accepts[0].extra` carries its `feePayer` (the account it
sponsors fees from), copied verbatim from the matching `/supported` kind. `@x402/hedera`'s
client signer throws without it, since the buyer's transfer has to name that account as its
transaction-id payer for sponsorship to apply.

---

## 2. Header or body

| | MPP | x402 |
|---|---|---|
| Offer lives in | `WWW-Authenticate: Payment` (one per rail) | `PAYMENT-REQUIRED` header, base64 JSON (body in v1) |
| Credential | `Authorization: Payment <base64url>` | `PAYMENT-SIGNATURE` in v2, `X-PAYMENT` in v1 |
| Receipt | `Payment-Receipt` response header | `PAYMENT-RESPONSE` header (v2) |
| Body on 402 | RFC 9457 problem document | the offer, repeated for legibility |

MPP is a registered-shape HTTP authentication scheme: a `402` plus `WWW-Authenticate`, a
retry with `Authorization`, exactly the challenge/response cycle `Basic` and `Bearer` use.
That has practical consequences. It composes with existing auth middleware, it survives
`HEAD` requests, and the resource's own response body is untouched by payment — a paid JSON
API returns its JSON, not a payment envelope wrapped around it.

x402 v1 put the offer in the body, which was simpler to read, simpler to log and simpler to
write by hand: you could `curl` an endpoint and see the whole offer without decoding anything,
worth more than it sounds when you are debugging at 2am. v2 gave that up — the declaration
moved into a base64 `PAYMENT-REQUIRED` header, so both protocols now hand you an opaque blob
and both are one step removed from legible. A server is free to repeat the offer in the body,
and this one does, but nothing in the protocol makes that copy authoritative.

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
- **x402 is the comparison rail, and it settles too.** It is gated on `AX402_FACILITATOR_URL`
  through `hasX402()` in `lib/demo.ts` and shown as a third option on `/checkout`, disabled
  with a demo-mode note until that variable is set. `/api/x402` serves the declaration in §1 —
  in the `PAYMENT-REQUIRED` header and, as a copy, in the body — built from the same
  `chargeRecipient()`, `USDC_TOKEN_ID` and `USDC_DECIMALS` as the Hedera offer on `/api/pay`.
  `lib/x402.ts` asks the facilitator's `/supported` once per process whether it lists `exact`
  on `hedera:testnet`; if it doesn't, or it can't be reached, the route stays in demo mode
  rather than failing.

  A retry carrying `PAYMENT-SIGNATURE` is checked against the offer this server made — scheme,
  network, amount, asset and `payTo`, so a client cannot name its own terms — then run through
  `POST /verify` and `POST /settle` against the facilitator. A successful settlement returns
  `200` with the receipt in `PAYMENT-RESPONSE` and `X-PAYMENT-RESPONSE`. Transaction
  `0.0.9839454@1790610422.322440321` is one it settled: 24 USDC of `0.0.5449` from buyer
  `0.0.10762329` to `0.0.8569027`, fees sponsored by the facilitator's `feePayer`
  ([HashScan](https://hashscan.io/testnet/transaction/0.0.9839454@1790610422.322440321)). The
  buyer in that run was the official `@x402/fetch` client, not this repository's code —
  `yarn e2e:x402 <buyer-key>` is the script.

  It is also bought from the storefront. The `/checkout` page's x402 card carries an
  `X402PayButton`, the twin of `HederaPayButton`: it reads the 402, signs the transfer in the
  browser with the burner key at `localStorage['burnerWallet.pk']`, and settles through
  `@x402/fetch` + `@x402/hedera` — the same client stack `yarn e2e:x402` drives from Node,
  running in the page. Transaction `0.0.9839454@1790678082.125912158` is one that button
  settled: 12 USDC of `0.0.5449` from `0.0.10775007` to `0.0.8569027`
  ([HashScan](https://hashscan.io/testnet/transaction/0.0.9839454@1790678082.125912158)).

  A settlement is recorded too. `recordX402Order` in `lib/orders.ts` writes it to the same
  store MPP charges land in and mints an `x402_…` order reference — x402 has no challenge id
  to key on — which `/api/x402` returns as `orderId`/`receiptUrl` in the 200 body alongside the
  protocol's own `PAYMENT-RESPONSE` header. `/receipt/[id]` renders it exactly as it renders an
  MPP charge, naming the rail as x402 and linking the transaction on HashScan.

  What is **partial**: the x402 button has no connected-wallet path, where `HederaPayButton`
  does. x402's `exact` scheme on Hedera needs a *partially signed* transaction whose
  transaction id names the facilitator's sponsored fee payer, and WalletConnect's Hedera
  methods sign and execute rather than return signed bytes — so from a page, only an injected
  burner key can pay this rail. The order store is also still in-memory and per-process, for
  both protocols.

  One thing a buyer has to opt into, and it is the client's policy rather than this server's:
  `@x402/hedera` treats `0.0.429274` as testnet USDC, while this store charges in `0.0.5449`
  (see `lib/mppx.ts` for why), and `@x402/core`'s default spend cap is $1 per payment. Both
  reject the offer client-side until `spendControls` allows the token and the amount.

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
