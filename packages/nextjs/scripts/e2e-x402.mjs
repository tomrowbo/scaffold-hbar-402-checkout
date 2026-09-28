// Pays /api/x402 with a real x402 v2 client against the running dev server.
//
// The twin of e2e-charge.mjs: same store, same product, same USDC — the other protocol.
// Everything below the `wrapFetchWithPayment` call is the official @x402 client stack, so a
// pass here means a real x402 client can buy from this template, not that our own code agrees
// with itself.
//
//   yarn e2e:x402 <buyer-ecdsa-private-key> [product-id]
//
// The buyer needs ECDSA (its EVM alias is how the account id is resolved) and a little USDC;
// the server's testnet faucet tops it up when it is short.
import { AccountId, Client, PrivateKey, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3000";
const BUYER_PK = process.argv[2] ?? process.env.X402_BUYER_KEY;
const PRODUCT = process.argv[3] ?? "hashgraph-mug";
const ENDPOINT = `${ORIGIN}/api/x402?product=${PRODUCT}`;

// CAIP-2, not the bare "testnet": @x402/hedera's assertSupportedHederaNetwork rejects the latter.
const NETWORK = "hedera:testnet";

if (!BUYER_PK) {
  console.error("usage: yarn e2e:x402 <buyer-ecdsa-private-key> [product-id]");
  process.exit(1);
}

const look = async id => {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${id}?limit=1`);
  if (!r.ok) throw new Error(`mirror ${r.status} for ${id}`);
  return r.json();
};
const bal = (acct, token) => {
  const e = acct.balance?.tokens?.find(t => t.token_id === token);
  return e ? BigInt(e.balance) : null;
};
/** `0.0.5@1759.123` → `0.0.5-1759-123`, the form the Mirror Node's /transactions/{id} takes. */
const mirrorTxId = id => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");

// 1. The unpaid challenge. A v2 client reads PAYMENT-REQUIRED, not the body, so check both.
const challenge = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
console.log("1. challenge status:", challenge.status);
const header = challenge.headers.get("PAYMENT-REQUIRED");
console.log("   payment-required header:", header ? `${header.slice(0, 32)}… (${header.length} chars)` : "MISSING");
if (challenge.status !== 402) process.exit(1);
if (!header) {
  console.error("   no PAYMENT-REQUIRED header — @x402/fetch cannot parse this challenge");
  process.exit(1);
}
const declared = decodePaymentRequiredHeader(header);
const offer = declared.accepts[0];
console.log("2. offer:", JSON.stringify({ ...offer, resource: declared.resource.url }));
if (challenge.headers.get("X-MPP-Demo-Mode")) {
  console.error("   server is in x402 demo mode — set AX402_FACILITATOR_URL and restart it");
  process.exit(1);
}

// 3. Resolve the buyer from its EVM alias, and make sure it can cover the offer.
const key = PrivateKey.fromStringECDSA(BUYER_PK.replace(/^0x/, ""));
let account = await look(`0x${key.publicKey.toEvmAddress()}`);
const payer = account.account;
console.log("3. buyer:", payer, "usdc:", String(bal(account, offer.asset)));

const amount = BigInt(offer.amount);
const have = bal(account, offer.asset);
if (have === null || have < amount) {
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(payer), key);
  const associate =
    have === null
      ? Buffer.from(
          (
            await new TokenAssociateTransaction()
              .setAccountId(AccountId.fromString(payer))
              .setTokenIds([TokenId.fromString(offer.asset)])
              .freezeWith(client)
              .sign(key)
          ).toBytes(),
        ).toString("base64")
      : undefined;
  client.close();
  const funded = await fetch(`${ORIGIN}/api/testnet/fund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: payer, associateTransaction: associate }),
  });
  console.log("4. fund:", funded.status, await funded.text());
  account = await look(payer);
  console.log("   buyer usdc now:", String(bal(account, offer.asset)));
}

// 5. The official client stack. It re-fetches, signs the transfer against the facilitator's
// sponsored feePayer, and retries with PAYMENT-SIGNATURE — none of that is our code.
const signer = await createClientHederaSigner(payer, key, { network: NETWORK });
const client = new x402Client();
client.register("hedera:*", new ExactHederaScheme(signer));
// Two client-side spend controls would otherwise reject this offer, and both are the buyer's
// policy rather than anything the server got wrong:
//   - @x402/hedera's only "default asset" on testnet is 0.0.429274. This store charges in
//     0.0.5449 (see lib/mppx.ts for why), so the buyer has to allow that token explicitly.
//   - the default per-payment cap is $1, well under the catalogue's prices.
// Allowing exactly the offered token, capped at exactly the offered amount, opts into this one
// purchase and nothing more.
client.setSpendControls({
  allowedAssets: [{ network: offer.network, asset: offer.asset, maxAmountPerPayment: offer.amount }],
});
const payFetch = wrapFetchWithPayment(fetch, client);

console.log("5. paying with @x402/fetch…");
const paid = await payFetch(ENDPOINT, { headers: { Accept: "application/json" } });
console.log("6. paid status:", paid.status);
const body = await paid.text();
console.log("   body:", body);

const receipt = paid.headers.get("PAYMENT-RESPONSE") ?? paid.headers.get("X-PAYMENT-RESPONSE");
if (paid.status !== 200 || !receipt) {
  console.error("   no settlement receipt — payment did not settle");
  process.exit(1);
}
const settlement = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
console.log("7. settlement:", JSON.stringify(settlement));

// 8. Consensus, independent of anything the server or the facilitator told us.
//
// One transaction id can list several entries: the CRYPTOTRANSFER itself is `nonce: 0`, and
// any child it triggered (an auto token association, say) follows at higher nonces with no
// token transfers of its own. The payment is the parent.
const txId = mirrorTxId(settlement.transaction);
let record = null;
for (let attempt = 0; attempt < 15 && !record; attempt++) {
  const r = await fetch(`${MIRROR}/api/v1/transactions/${txId}`);
  if (r.ok) {
    const entries = (await r.json()).transactions ?? [];
    record = entries.find(entry => entry.nonce === 0) ?? null;
  }
  if (!record) await new Promise(resolve => setTimeout(resolve, 2_000));
}
if (!record) {
  console.error(`8. mirror node has no record of ${txId}`);
  process.exit(1);
}
console.log("8. mirror node:", JSON.stringify({ result: record.result, name: record.name }));
console.log("   token_transfers:", JSON.stringify(record.token_transfers));
console.log(`   https://hashscan.io/testnet/transaction/${settlement.transaction}`);

const credited = (record.token_transfers ?? []).some(
  t => t.token_id === offer.asset && t.account === offer.payTo && String(t.amount) === offer.amount,
);
if (record.result !== "SUCCESS" || !credited) {
  console.error(`   consensus does not show ${offer.amount} of ${offer.asset} credited to ${offer.payTo}`);
  process.exit(1);
}
console.log("   ✓ merchant credited on chain");
