/**
 * Creates a throwaway testnet "burner" buyer and prints its credentials.
 *
 * A burner is just an ECDSA key whose Hedera account you do not care about. The checkout
 * needs one because the buyer cannot be the merchant — a transfer from an account to itself
 * is rejected before it is submitted — and the Hedera Portal hands a new developer exactly
 * one account. Generating the key is trivial; the part worth scripting is everything after
 * it: a key has no Hedera account until somebody sends HBAR to its EVM alias, and the buyer
 * needs HBAR of its own to pay transaction fees.
 *
 * Testnet only, and it spends the operator's HBAR, so it refuses to run on mainnet.
 *
 * Usage: yarn make:burner [hbar]        (default 10 HBAR)
 *
 * The printed key is a secret in the trivial sense only — it holds testnet HBAR and test
 * USDC. Do not reuse it for anything else.
 */
import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const HBAR_AMOUNT = Number(process.argv[2] ?? 10);

const network = (process.env.HEDERA_NETWORK ?? "testnet").trim().toLowerCase();
if (network !== "testnet") {
  console.error(`make:burner is testnet-only (HEDERA_NETWORK=${network}).`);
  process.exit(1);
}

const operatorId = process.env.HEDERA_OPERATOR_ID?.trim();
const operatorKey = process.env.HEDERA_OPERATOR_KEY?.trim();
if (!operatorId || !operatorKey) {
  console.error("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (packages/nextjs/.env) first.");
  process.exit(1);
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(operatorId),
  PrivateKey.fromStringECDSA(operatorKey.replace(/^0x/, "")),
);

const burner = PrivateKey.generateECDSA();
const evmAddress = `0x${burner.publicKey.toEvmAddress()}`;

// Hedera auto-creates an account the first time HBAR lands on an EVM alias.
const submitted = await new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(operatorId), new Hbar(-HBAR_AMOUNT))
  .addHbarTransfer(AccountId.fromEvmAddress(0, 0, evmAddress), new Hbar(HBAR_AMOUNT))
  .setTransactionMemo("402-checkout burner buyer")
  .execute(client);
const status = (await submitted.getReceipt(client)).status.toString();
client.close();
if (status !== "SUCCESS") {
  console.error(`funding the burner failed: ${status}`);
  process.exit(1);
}

// Consensus is reached before the Mirror Node has indexed the new account id.
let accountId;
for (let attempt = 0; attempt < 15 && !accountId; attempt++) {
  const response = await fetch(`${MIRROR}/api/v1/accounts/${evmAddress}`);
  if (response.ok) accountId = (await response.json()).account ?? undefined;
  if (!accountId) await new Promise(resolve => setTimeout(resolve, 2_000));
}

console.log(`account   ${accountId ?? "(not indexed yet — check the Mirror Node in a moment)"}`);
console.log(`evm       ${evmAddress}`);
console.log(`hbar      ${HBAR_AMOUNT}`);
console.log(`key       ${burner.toStringRaw()}`);
console.log("");
console.log("Pay with it from the command line:");
console.log(`  yarn e2e:charge ${burner.toStringRaw()} hashgraph-mug`);
console.log("");
console.log("Or in the browser, from the DevTools console on http://localhost:3000:");
console.log(`  localStorage.setItem("burnerWallet.pk", "0x${burner.toStringRaw()}"); location.reload();`);
