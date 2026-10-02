# One challenge, two rails

A merchant who wants to take both a Visa card and an on-chain stablecoin normally builds two
checkouts. This template builds one: a single `402` whose `WWW-Authenticate` header carries a
Stripe card offer *and* a native Hedera USDC offer, and lets the client pick.

This document covers how that works, and the constraint that makes it worth building.

## The constraint

`mppx/stripe` — Stripe's own MPP integration — supports exactly three crypto networks:

```ts
// node_modules/mppx/dist/stripe/server/Methods.d.ts
export declare namespace stripe {
  type Network = 'tempo' | 'base' | 'solana';
  ...
  type DepositAddress<N extends Network = Network> = string & { ... };
}

findOrCreateDepositAddress: <N extends stripe.Network>(network: N) => Promise<stripe.DepositAddress<N>>;
```

Tempo, Base, Solana. **Not Hedera.** That type is not cosmetic: a Stripe MPP merchant gets
their on-chain rail by asking Stripe for a deposit address on one of those three networks,
and `stripe.base.charge({ recipient })` will only accept a `DepositAddress<'base'>`. There is
no Hedera branch to ask for.

The gap is not Stripe-specific either. `mppx`'s own x402 adapter is EVM-only —
`evmNetworkPrefix` is `'eip155:'` and its network type is `` `eip155:${number}` `` — so it
cannot express Hedera's `hedera:testnet` namespace either.

So: **a merchant standing on Stripe's own MPP rails cannot accept Hedera today.** They can
take a card through Stripe and they can take USDC on Base, but Hedera is not in the set.

This template is that gap closed. It uses Stripe for what Stripe is for — the card — and
pairs it with a native Hedera method from `mppx-hedera` that settles directly against the
ledger. Both are advertised in the same challenge.

## How two rails fit in one 402

`WWW-Authenticate` is defined to carry a list of challenges, so MPP can put one `Payment`
challenge per method in it. Two things in `packages/nextjs/lib/mppx.ts` do the work.

**First, both methods are registered on one `Mppx` instance:**

```ts
const methods: Method.AnyServer[] = [
  hedera.charge({
    serverId: MPP_REALM,
    testnet: HEDERA_NETWORK === "testnet",
    mirrorNodeUrl: MIRROR_NODE_URL,
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
  }),
];

methods.push(
  stripeClient
    ? stripe.charge({
        client: stripeClient,
        networkId: process.env.STRIPE_NETWORK_ID!.trim(),
        paymentMethodTypes: ["card"],
        html: { publishableKey: ..., createTokenUrl: "/api/pay/token" },
      })
    : stripe.charge({ secretKey: STRIPE_DEMO_SECRET_KEY, networkId: "demo", paymentMethodTypes: ["card"] }),
);

export const mppx = Mppx.create({ methods, realm: MPP_REALM, secretKey: mppSecretKey() });
```

**Second, the two offers are composed with their own options**, because they are priced in
different money:

```ts
export function charge(options: ChargeOptions): Handler {
  return handlers.compose(
    ["hedera/charge", options],                                       // USDC base units, token 0.0.5449
    ["stripe/charge", { amount: options.amount, currency: "usd", decimals: 2, ... }],  // cents, USD
  );
}
```

That is the part the implicit `mppx.charge(...)` shorthand cannot express. One shorthand call
gives every method the same request options; here the Hedera offer needs
`currency: "0.0.5449", decimals: 6` and the card offer needs `currency: "usd", decimals: 2`.
`compose` gives each method its own.

The result on the wire, for a $0.75 item:

```json
{ "amount": "750000", "currency": "0.0.5449", "methodDetails": { "chainId": 296 }, "recipient": "0.0.…" }
{ "amount": "2400",     "currency": "usd",      "methodDetails": { "networkId": "…", "paymentMethodTypes": ["card"] } }
```

Both scaled from the *same* catalogue string, `"0.75"`. Prices in `lib/products.ts` are
decimal strings and never numbers — mppx scales each offer by its own `decimals`, and no
float arithmetic touches money anywhere in the path.

## How a client picks

The offers are a list, so a client filters for the one it can pay:

```ts
const challenge = Challenge.fromResponseList(response).find(offer => offer.method === "hedera");
```

That is `lib/hederaCheckout.ts`, and it is all the rail selection there is. A browser that
asks for `text/html` never sees this — it gets the Stripe Elements card form that mppx
renders from the `stripe/charge` method's `html` config, served from the same URL. Agents
asking for JSON get the challenge list. One endpoint, two audiences.

Settlement then diverges completely. The card credential carries a Shared Payment Token and
mppx confirms a Stripe PaymentIntent. The Hedera credential carries a transaction id or a
signed transaction, and `mppx-hedera` confirms the transfer — and its 32-byte attribution
memo — against the Hedera Mirror Node. Two payment systems, two verification paths, one
`Payment-Receipt` header out the other side.

## Why the card rail is advertised even in demo mode

With no `STRIPE_*` variables set, the 402 *still* carries a `stripe` challenge, with
`networkId: "demo"`. This is deliberate, and it is the one place the template shows you
something it cannot actually do.

The reasoning: the two-rail challenge is the entire point of this template. A developer who
clones it, runs `yarn next:dev` with no credentials, and curls `/api/pay` should *see* two
rails in that header — that is how they learn what the template is. Dropping the card offer
when Stripe is unconfigured would hide the feature from precisely the person who needs to
see it.

So the offer stays, and the honesty is delivered elsewhere:

- **`X-MPP-Demo-Mode`** names which rails are stubbed, comma-separated:
  `hedera`, `stripe`, or `hedera,stripe`. Per rail, so a fully configured Hedera rail is
  never blocked by an unconfigured card rail, and vice versa.
- **The route never lets a demo credential reach `verify`.** `/api/pay` strips the payment
  credential for a rail in demo mode, so mppx re-issues a challenge instead of pretending to
  verify something. A card credential is stripped only when *Stripe* is in demo mode; a
  Hedera credential only when *Hedera* is.
- **The browser gets a disabled panel, not a broken form.** In demo mode `lib/mppx.ts`
  configures no `html` for the Stripe method — there is no publishable key to mount Stripe
  Elements against, and a placeholder key mounts a card form that 401s on submit, which looks
  broken rather than stubbed. The route renders a plain panel with a `demo mode` badge, the
  product and price, a disabled **Pay** button, and the three variable names to set.
- **`/api/pay/token` returns 503** with the same three variable names, before it would ever
  touch a placeholder key.

The rule generalises across the template: *never hide a control because it is unconfigured;
render it disabled and say what would enable it.* `lib/demo.ts` keeps the three predicates
independent (`hasHedera()`, `hasStripe()`, `hasX402()`) so no rail's absence can switch off
another.

## What this gets you

One endpoint that a browser with a Visa card and an agent with a Hedera account can both pay,
without either knowing the other exists, and without the merchant running two checkouts. The
card half is Stripe's, the Hedera half settles directly against the ledger with no
facilitator, and the choice between them is four lines of client code.

See [`mpp-vs-x402.md`](mpp-vs-x402.md) for how the same purchase looks under the other 402
protocol, and [`../AGENTS.md`](../AGENTS.md) for a runnable agent that pays the Hedera rail.
