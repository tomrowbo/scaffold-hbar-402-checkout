# Agent instructions

Briefing for coding agents in this app (Cursor, Claude Code, Codex). Claude Code loads it through `CLAUDE.md`.

This is a **Hedera-native Next.js storefront** (402 Checkout). There is **no Solidity workspace**, deliberately: `template.json` declares `solidityFramework: "none"` and payments settle as native HTS transfers verified against the Mirror Node, so there is nothing for a contract to hold. Do not add one to satisfy a layout expectation — see "Why there is no Solidity package" in the README.

Use the package manager this project was created with (`packageManager` in the root `package.json`). Examples use `yarn`.

## Commands

```bash
yarn next:dev           # http://127.0.0.1:3000
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
| `/llms.txt` → `/api/llms` | Agent-facing briefing in the llms.txt convention: catalogue, rails, token, network, how to pay. Rewritten in `next.config.ts` because the app router drops `name.ext` route segments |
| `/openapi.json` → `/api/openapi` | OpenAPI 3.1 for `/api/pay` and `/api/x402`, same rewrite. Both discovery docs answer with zero credentials and state demo mode honestly |
| `/api/testnet/fund` | Test-buyer USDC faucet; 403 unless the resolved network is testnet |
| `/api/x402` | x402 v2 payment-required `402` for the same product, amount, token and recipient as `/api/pay`, in the base64 `PAYMENT-REQUIRED` header **and** the body. `demo: true` + `X-MPP-Demo-Mode: x402` (and a disabled HTML panel for browsers) unless `canSettleX402()`. A `PAYMENT-SIGNATURE` retry is verified and settled through the facilitator; `200` carries `PAYMENT-RESPONSE` |

## Production switches — do not weaken

- `HEDERA_NETWORK` (`testnet` default, or `mainnet`) is read only through `resolvedNetwork()` in `lib/hederaOperator.ts`. `lib/mppx.ts` derives USDC id, Mirror Node and chain id from it.
- `/api/testnet/fund` checks `resolvedNetwork() === "testnet"` itself, before anything else. Keep that check in the handler.
- The `stripe` rail is advertised in the 402 even in demo mode (its `networkId` reads
  `demo`). This is deliberate: one challenge carrying both card and Hedera is the point
  of this template, and dropping the card rail without credentials would hide that from
  anyone running it unconfigured. Demo mode is made honest in the UI — the browser page
  renders a disabled `demo mode` panel — not by removing the offer.
- `lib/mppx.ts` throws at module load when the insecure default `MPP_SECRET_KEY` would be used on mainnet or with a live Stripe key. Route modules load lazily, so this surfaces as a 500 on the first request to a paid route, not as a failed startup — a deploy smoke test has to request one.
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
    x402.ts               Facilitator capability probe (memoized), canSettleX402(), verify/settle
    products.ts           Fixture catalogue (Product[])
  hooks/
    useHederaSigner.ts    Wallet + Hedera account identity
    scaffold-hbar/        Shared Scaffold-HBAR hooks (useTargetNetwork, …)
  public/products/        Local product photos — no remote image fetches
  utils/scaffold-hbar/    Hedera tx helpers, identity
  scaffold.config.ts      Target networks (testnet, mainnet), RPC, WalletConnect
  contracts/              deployedContracts.ts (empty — no Solidity workspace)
```

## Conventions

**Catalogue:** `lib/products.ts` exports `products: Product[]` where `Product = { id, name, priceUsd, image }`. Prices are decimal strings (`"0.50"`), never numbers — no float arithmetic on money. Images are local paths under `public/`; do not introduce remote image hosts, which break behind a firewall.

**x402 is a separate protocol, not an MPP method.** It never goes into the `methods` array in `lib/mppx.ts` and never touches `/api/pay`. `/api/x402` reuses `chargeRecipient()`, `USDC_TOKEN_ID` and `USDC_DECIMALS` from `lib/mppx.ts` so the protocol envelope is the only difference between the two endpoints; keep it that way. `hasX402()` stays a synchronous env check — the network question ("does the facilitator list `exact` on `hedera:testnet`?") lives in `lib/x402.ts`'s `x402Capability()`, probed with a 3s timeout and never throwing; a live result is memoized for the process, a failed one is retried after 30s so a briefly slow facilitator cannot disable the rail permanently. Route code calls `canSettleX402()`. The network id is `hedera:testnet`, never `eip155:296`. Three v2 details are load-bearing and easy to regress: the declaration a client parses is the base64 `PAYMENT-REQUIRED` **header** (`@x402/core` only falls back to the body for v1); the offer field is `amount`, not v1's `maxAmountRequired`, with `resource` as a top-level object; and `accepts[].extra.feePayer` must be copied from the matching `/supported` kind, because `@x402/hedera`'s client signer refuses to build a transaction without it. Settlement runs `POST /verify` then `POST /settle` against the facilitator and returns `PAYMENT-RESPONSE`. A settled x402 payment is recorded through `recordX402Order()` in `lib/orders.ts`, which mints an `x402_…` id because x402 has no challenge id to key on, and `/receipt/[id]` renders it like any other order. The `PAYMENT-RESPONSE` header carries the facilitator's own receipt alongside it. `yarn e2e:x402 <buyer-key>` proves the rail with the official client.

**Wallet + identity:** `useHederaSigner` wraps connection state and `requireProvider()` for mutations. Account IDs use `0.0.xxxxx` form; helpers in `utils/scaffold-hbar/hederaIdentity.ts` normalize EVM ↔ native identity. Both on-chain rails sign with the connected wallet and the page holds no key. x402 needs `hedera_signTransaction` specifically — signed bytes, not submitted, because the facilitator is the fee payer named in the transaction id — which `lib/x402WalletSigner.ts` wraps as `@x402/hedera`'s `ClientHederaSigner`. Do not reach for `hedera_signAndExecuteTransaction` there; it submits, and the settlement is then unusable.

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

## Local host

Use `127.0.0.1`, never `localhost`. `localhost` resolves to `::1` before `127.0.0.1` on many
systems, so a Node client can get `ECONNREFUSED ::1:<port>` against a server that is up and
listening — the `yarn e2e:*` scripts hit exactly that. Every URL in this repo's docs and
scripts uses `127.0.0.1`; keep it that way.

## Networks

`packages/nextjs/scaffold.config.ts` — `hederaTestnet` and `hedera` mainnet. RPC overrides via `NEXT_PUBLIC_HEDERA_*_RPC_URL`. Default polling interval: 10s.

## Code style

| Style | Use for |
|---|---|
| `UpperCamelCase` | types, components, enums |
| `lowerCamelCase` | functions, variables, hooks |
| `CONSTANT_CASE` | constants |

Prefer `type` over `interface`. Comments only when they add non-obvious context.

## Paying this endpoint as an agent

This is what MPP is for: a program with a key, no browser, no human. The flow is three HTTP
steps — request, settle, retry — and the whole thing fits in a file.

### The protocol, in full

1. `GET /api/pay?product=<id>` with `Accept: application/json` → `402` and a
   `WWW-Authenticate` header carrying one `Payment` challenge per rail
   (`method="hedera"` and `method="stripe"`).
2. Pick the `hedera` challenge. Its base64url `request` decodes to
   `{ amount, currency, methodDetails: { chainId }, recipient }` — `amount` in USDC base
   units, `currency` the HTS token id (Circle's `0.0.429274` on testnet, or whatever
   `HEDERA_USDC_TOKEN_ID` names).
3. Build a `TransferTransaction` moving `amount` of `currency` from the agent to `recipient`,
   with the transaction memo set to `Attribution.encode({ challengeId, serverId })`. That
   32-byte memo is what binds the on-chain transfer to this specific challenge; `serverId`
   **must** be the challenge's `realm`, or the server's verification rejects it.
4. Submit it, take the transaction id, and wrap it in a credential.
5. Retry the same URL with `Authorization: Payment <credential>`. The server re-reads the
   transfer from the Mirror Node, then answers `200` with a `Payment-Receipt` header.

### Runnable

Run it from `packages/nextjs` (that is where `mppx` and `mppx-hedera` resolve from) against
a dev server started with `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` set. The agent account
needs HBAR for fees and USDC (`0.0.429274`) to spend, and must be a different account from the
merchant's `HEDERA_RECIPIENT_ID`.

```js
// pay-agent.mjs — node pay-agent.mjs <agent-account-id> <agent-ecdsa-key> [product-id]
import { AccountId, Client, PrivateKey, TokenId, TransferTransaction } from "@hiero-ledger/sdk";
import { Challenge, Credential } from "mppx";
import { Attribution } from "mppx-hedera";

const [accountId, privateKey, product = "hashgraph-mug"] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:3000/api/pay?product=${product}`;

// 1. Ask for the resource and get challenged.
const challenged = await fetch(endpoint, { headers: { Accept: "application/json" } });
if (challenged.status !== 402) throw new Error(`expected 402, got ${challenged.status}`);

// 2. One header, several offers. Take the Hedera one.
const offers = Challenge.fromResponseList(challenged);
console.log("offers:", offers.map(o => o.method)); //=> [ 'hedera', 'stripe' ]
const challenge = offers.find(o => o.method === "hedera");
const { amount, currency, recipient } = challenge.request;

// 3. The memo binds this transfer to this challenge. serverId must equal the realm.
const memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm });

// 4. Sign, submit, keep the transaction id (push mode — the agent pays its own fees).
const key = PrivateKey.fromStringECDSA(privateKey.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), key);
const token = TokenId.fromString(currency);
const submitted = await new TransferTransaction()
  .addTokenTransfer(token, AccountId.fromString(accountId), -Number(amount))
  .addTokenTransfer(token, AccountId.fromString(recipient), Number(amount))
  .setTransactionMemo(memo)
  .freezeWith(client)
  .execute(client);
const { status } = await submitted.getReceipt(client);
if (status.toString() !== "SUCCESS") throw new Error(`transfer failed: ${status}`);
const transactionId = submitted.transactionId.toString();
client.close();

// 5. Retry with the credential. `credentialHeader` is "Authorization" for this challenge.
const credential = Credential.from({
  challenge,
  payload: { type: "hash", transactionId },
  source: `did:pkh:hedera:testnet:${accountId}`,
});
const paid = await fetch(endpoint, {
  headers: {
    Accept: "application/json",
    [Challenge.credentialHeader(challenge)]: Credential.serialize(credential),
  },
});

console.log(paid.status, await paid.json());
console.log("receipt:", paid.headers.get("payment-receipt"));
console.log(`https://hashscan.io/testnet/transaction/${transactionId}`);
```

`packages/nextjs/scripts/e2e-charge.mjs` — run it with `yarn e2e:charge <burner-key>
[product]` — is the same flow in *pull* mode: the agent signs the transfer and the **server**
submits it through the operator account. Use pull mode when the payer cannot reach the Hedera
gRPC endpoints (a browser, a locked-down sandbox); the transaction id still names the payer's
account, so they still pay the fee.

That script lives inside the `packages/nextjs` workspace, and it has to. `.yarnrc.yml` sets
`nmHoistingLimits: workspaces`, so `mppx` and `mppx-hedera` are installed under
`packages/nextjs/node_modules` and never at the repo root. Node resolves bare specifiers by
walking up from the *script's own* directory, so a copy of this script at `<root>/scripts/`
fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'mppx'` no matter what the cwd is —
`NODE_PATH` does not apply to ESM either. Any new script that imports a workspace dependency
belongs in `packages/nextjs/scripts/`.

### Shorter, with the packaged client method

`mppx-hedera/client` packages steps 3–4:

```js
import { Challenge } from "mppx";
import { charge } from "mppx-hedera/client";

const method = charge({ operatorId, operatorKey, network: "testnet" }); // mode: "push" | "pull"
const challenge = Challenge.fromResponseList(challenged).find(o => o.method === "hedera");
const credential = await method.createCredential({ challenge }); // already serialized
```

Two caveats, both from reading the package: it resolves the token from
`methodDetails.chainId` rather than from the challenge's `currency` field (they agree here —
296 → `0.0.429274`), and it parses the key with `PrivateKey.fromStringECDSA` only, so an
ED25519 operator key throws. The longhand above has neither constraint.

### Do not import `mppx/client` in this repo

`mppx/client` re-exports the Tempo method, which imports `viem/tempo/chains`. That subpath
does not exist in the viem version wagmi pins here, so the import fails outright:

```
Error: Package subpath './tempo/chains' is not defined by "exports" in
  node_modules/viem/package.json imported from node_modules/mppx/dist/tempo/client/Subscription.js
```

This is the client-side twin of the `mppx/server` → `mppx/server/core` problem above. There
is no `mppx/client/core`, so an agent in this workspace composes the flow from the root
`mppx` exports (`Challenge`, `Credential`) plus `mppx-hedera`, exactly as the scripts above
do. Outside this repo, on a viem new enough to ship `viem/tempo`, `Mppx.create` from
`mppx/client` works normally.
