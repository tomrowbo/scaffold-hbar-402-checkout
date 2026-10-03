// Pays /api/pay as an AI agent, through Hedera Agent Kit.
//
// The fourth sibling of e2e-charge.mjs, e2e-x402.mjs and e2e-stripe.mjs, and the one that
// demonstrates what the storefront is actually for. The others drive a protocol client
// directly. This one hands the job to an *agent tool* — `mppx_hedera_charge_fetch_tool` from
// `hak-mppx-hedera-plugin`, the MPP plugin listed in Hedera Agent Kit's own docs — and the
// tool discovers the 402, decides whether the price is within budget, pays, and returns the
// goods. The storefront is not told an agent is calling and needs no agent-specific code.
//
//   yarn e2e:agent <buyer-key> [product-id]
//
// No LLM and no API key: Agent Kit tools expose `execute(client, context, params)`, so the
// tool runs the same code path an LLM-driven agent would without anything having to choose
// to call it. Giving a model the same tool is the only difference, and it is the model's
// business rather than this template's.
//
// The buyer needs an ECDSA key, HBAR for fees and USDC to spend — `yarn make:burner` creates
// one and POST /api/testnet/fund tops it up.
import { Client } from "@hiero-ledger/sdk";
import { ChargeFetchTool } from "hak-mppx-hedera-plugin";

const ORIGIN = process.env.E2E_ORIGIN?.trim() || "http://127.0.0.1:3000";
const KEY = (process.argv[2] ?? process.env.HEDERA_BUYER_KEY)?.trim();
const PRODUCT = process.argv[3] ?? "hashgraph-mug";
const ENDPOINT = `${ORIGIN}/api/pay?product=${PRODUCT}`;

/**
 * The agent's spend cap, in base units — 6 decimals, so 1000000 is $1.00. This is the whole
 * point of a budget: the tool reads the challenge, compares the price against this, and
 * refuses rather than paying whatever it is asked for. Lower it below a product's price and
 * the run ends with "Payment too expensive" and no transfer.
 */
const MAX_AMOUNT = process.env.AGENT_MAX_AMOUNT?.trim() || "1000000";

const die = message => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (!KEY) {
  die(
    "no buyer key. Pass one as the first argument or set HEDERA_BUYER_KEY.\n" +
      "  Create a funded testnet buyer with: yarn make:burner",
  );
}

// The plugin derives the account from the key's EVM alias, so only the key is required here.
const { PrivateKey } = await import("@hiero-ledger/sdk");
let accountId = process.env.HEDERA_BUYER_ID?.trim();
if (!accountId) {
  const evmAddress = PrivateKey.fromStringECDSA(KEY.startsWith("0x") ? KEY.slice(2) : KEY).publicKey.toEvmAddress();
  const lookup = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/0x${evmAddress}?limit=1`);
  if (!lookup.ok) {
    die(
      `Mirror Node could not resolve the buyer (HTTP ${lookup.status}). A key has no Hedera\n` +
        "  account until it receives HBAR — run yarn make:burner.",
    );
  }
  accountId = (await lookup.json()).account;
}

console.log("1. agent:", accountId);
console.log("2. tool: ", new ChargeFetchTool().method);
console.log("3. budget:", MAX_AMOUNT, "base units");
console.log("4. calling", ENDPOINT, "— the tool handles the 402 itself…");

const client = Client.forTestnet();
let result;
try {
  result = await new ChargeFetchTool().execute(
    client,
    { network: "testnet", accountId, privateKey: KEY },
    { url: ENDPOINT, method: "GET", maxAmount: MAX_AMOUNT },
  );
} finally {
  client.close();
}

console.log("\n5. tool result:", result.humanMessage);

// `raw.error` is the tool declining or failing; `raw.status` is the server's answer once it
// decided to pay. Both are reported rather than thrown, so check them rather than trusting
// a resolved promise.
if (result.raw?.error)
  die(`the agent did not pay: ${result.raw.error}${result.raw.detail ? ` — ${result.raw.detail}` : ""}`);
if (result.raw?.status !== 200)
  die(`paid, but the server answered ${result.raw?.status}: ${result.raw?.data ?? "(no body)"}`);

const body = JSON.parse(result.raw.data);
console.log("\n✓ the agent bought", `${body.product?.name}`, "for", `${body.product?.priceUsd} USDC`);
console.log("  transaction:", body.transactionId);
console.log("  hashscan:   ", body.hashscanUrl);
console.log("  receipt:    ", `${ORIGIN}${body.receiptUrl}`);
