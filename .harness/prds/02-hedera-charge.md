# 02 — Hedera charge path

Add native Hedera USDC payments via MPP to the storefront from increment 01.

## The endpoint

Create `app/api/pay/route.ts`. Create `lib/mppx.ts` exporting a configured
server:

    import { Mppx } from 'mppx/server'
    import { hedera } from 'mppx-hedera/server'

**VERIFIED 2026-09-22 against mppx@0.10.1 + mppx-hedera@0.2.2** (smoke-tested end
to end; a valid 402 was produced and its payload decoded). Two things to get right:

- **`recipient` MUST be passed to the `mppx.charge({...})` call, NOT to
  `hedera.charge({...})`.** Passing it at method construction — the pattern in
  mppx-hedera's own README — throws a ZodError (`recipient: expected string`)
  on mppx 0.10. This is a silent breaking change between mppx 0.5 and 0.10.
- **`secretKey` must be at least 32 bytes.** Short strings are rejected at
  `Mppx.create`. Generate with `openssl rand -base64 32`.

A verified-working construction, producing
`Payment ... method="hedera", intent="charge"` with decoded payload
`{amount:"10000", currency:"0.0.5449", methodDetails:{chainId:296}, recipient:"0.0.8569027"}`:

    import { Mppx } from 'mppx/server'
    import { hedera } from 'mppx-hedera/server'

    export const mppx = Mppx.create({
      methods: [hedera.charge({ serverId: process.env.MPP_REALM ?? 'localhost:3000', testnet: true })],
      realm: process.env.MPP_REALM ?? 'localhost:3000',
      secretKey: process.env.MPP_SECRET_KEY ?? '<32+ byte dev default>',
    })

    // recipient goes HERE, not on hedera.charge()
    const result = await mppx.charge({
      amount, currency: '0.0.5449', decimals: 6, recipient,
    })(request)

The original shape below is kept for reference but the recipient placement above wins:

    export const mppx = Mppx.create({
      methods: [
        hedera.charge({
          // Merchant account receiving payment. Falls back to the operator so
          // the template works with a single configured account.
          recipient: process.env.HEDERA_RECIPIENT_ID
            ?? process.env.HEDERA_OPERATOR_ID
            ?? '0.0.0',
          testnet: true,
        }),
      ],
      realm: process.env.MPP_REALM ?? 'localhost:3000',
      // Signs challenge HMACs. A fixed literal keeps demo mode working with no
      // .env; it MUST be overridden in any real deployment, and the README must
      // say so in the deployment section.
      secretKey: process.env.MPP_SECRET_KEY ?? 'dev-only-insecure-secret',
    })

Handler shape:

    const result = await mppx.charge({ amount, currency, decimals: 6 })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json({ ... }))

## Settlement and verification

- USDC testnet token `0.0.5449`, 6 decimals. This is the token `mppx-hedera`
  documents and the one the operator actually holds (verified 2026-09-22:
  balance 210.26). Do NOT use `0.0.429274` — a different testnet USDC with the
  same name and symbol, of which the operator holds none.
- Verify settlement by reading the Mirror Node and matching the ERC-20
  Transfer log — do not trust a client-supplied hash alone.
- Mirror Node indexing is usually sub-second but can lag 2–5s. Poll with a
  30s timeout; never fail on the first miss.
- Bind every charge with the 32-byte Attribution memo for replay protection.

## Demo mode still applies

When `hasHedera()` is false the route still returns a well-formed 402 challenge
so the protocol is inspectable without credentials; only settlement is stubbed.

## Out of scope

Session intent. Charge only. Do not wire the escrow contract.
