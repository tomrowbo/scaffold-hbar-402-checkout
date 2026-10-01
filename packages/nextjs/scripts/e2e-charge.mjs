// Mirrors lib/hederaCheckout.ts (pull path) against the running dev server.
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Challenge, Credential } from "mppx";
import { Attribution } from "mppx-hedera";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const BURNER_PK = process.argv[2];
const PRODUCT = process.argv[3] ?? "hashgraph-mug";
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3000";
const ENDPOINT = `${ORIGIN}/api/pay?product=${PRODUCT}`;

const b64 = bytes => Buffer.from(bytes).toString("base64");
const look = async id => {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${id}?limit=1`);
  if (!r.ok) throw new Error(`mirror ${r.status} for ${id}`);
  return r.json();
};
const bal = (acct, token) => {
  const e = acct.balance?.tokens?.find(t => t.token_id === token);
  return e ? BigInt(e.balance) : null;
};

const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
console.log("1. challenge status:", res.status);
console.log("   www-authenticate:", res.headers.get("www-authenticate")?.slice(0, 120), "...");
if (res.status !== 402) process.exit(1);

const challenge = Challenge.fromResponseList(res).find(c => c.method === "hedera");
const { amount: amtStr, currency: tokenId, recipient } = challenge.request;
const amount = BigInt(amtStr);
console.log("2. parsed:", { id: challenge.id, realm: challenge.realm, amount: amtStr, tokenId, recipient });

// Check the challenge BEFORE anything moves on chain. Step 5 funds the buyer from the
// operator; a recipient the SDK cannot parse only blows up at step 6, by which point the
// USDC is sitting in a throwaway account with no faucet to recover it from.
if (!/^\d+\.\d+\.\d+$/.test(recipient ?? "")) {
  console.error(
    `\n\u2717 the server advertised recipient ${JSON.stringify(recipient)}, which is not a Hedera account id.\n` +
      `  Set HEDERA_RECIPIENT_ID (or HEDERA_OPERATOR_ID) in packages/nextjs/.env and restart the server.\n` +
      `  Nothing has been sent on chain.`,
  );
  process.exit(1);
}

const memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm ?? "" });
console.log("3. memo:", memo);

const key = PrivateKey.fromStringECDSA(BURNER_PK.replace(/^0x/, ""));
let account = await look(`0x${key.publicKey.toEvmAddress()}`);
const payer = account.account;
console.log("4. buyer:", payer, "usdc:", String(bal(account, tokenId)));

const client = Client.forTestnet();
client.setOperator(AccountId.fromString(payer), key);

const have = bal(account, tokenId);
if (have === null || have < amount) {
  const associate =
    have === null
      ? b64(
          (
            await new TokenAssociateTransaction()
              .setAccountId(AccountId.fromString(payer))
              .setTokenIds([TokenId.fromString(tokenId)])
              .freezeWith(client)
              .sign(key)
          ).toBytes(),
        )
      : undefined;
  const f = await fetch(`${ORIGIN}/api/testnet/fund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Fund for *this* charge. Without an amount the faucet has to assume the priciest item
    // in the catalogue, which fails on an operator that could cover this purchase easily.
    body: JSON.stringify({ accountId: payer, amount: amtStr, associateTransaction: associate }),
  });
  const fundBody = await f.text();
  console.log("5. fund:", f.status, fundBody);
  // The buyer has nothing to spend, so a failed top-up is fatal. Signing and submitting
  // anyway buries the real error under a settlement failure three steps later.
  if (!f.ok) {
    let detail = fundBody;
    try {
      const parsed = JSON.parse(fundBody);
      detail = parsed.detail ?? parsed.error ?? fundBody;
    } catch {
      // Not JSON — print what the server sent.
    }
    console.error(`\n   Could not fund the buyer, and it holds ${String(bal(account, tokenId) ?? 0n)} of ${tokenId}.`);
    console.error(`   ${detail}`);
    client.close();
    process.exit(1);
  }
  account = await look(payer);
  console.log("   buyer usdc now:", String(bal(account, tokenId)));
}

const units = Number(amount);
const token = TokenId.fromString(tokenId);
const transfer = new TransferTransaction()
  .addTokenTransfer(token, AccountId.fromString(payer), -units)
  .addTokenTransfer(token, AccountId.fromString(recipient), units)
  .setTransactionMemo(memo)
  .freezeWith(client);
const signed = await transfer.sign(key);
console.log("6. signed transfer, submitting credential (pull mode)…");

const credential = Credential.from({
  challenge,
  payload: { type: "transaction", transaction: b64(signed.toBytes()) },
  source: `did:pkh:hedera:testnet:${payer}`,
});

const paid = await fetch(ENDPOINT, {
  headers: { Accept: "application/json", [Challenge.credentialHeader(challenge)]: Credential.serialize(credential) },
});
console.log("7. settled status:", paid.status);
console.log("   payment-receipt:", paid.headers.get("payment-receipt"));
console.log("   body:", await paid.text());
client.close();
