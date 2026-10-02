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

// Matches resolvedNetwork() in lib/hederaOperator.ts: blank means testnet, so an untouched
// copy of .env.example (which ships `HEDERA_NETWORK=`) works. `??` would not do this — an
// empty string is a present value to it.
const network = process.env.HEDERA_NETWORK?.trim().toLowerCase() || "testnet";
if (network !== "testnet") {
  console.error(`make:burner is testnet-only, but HEDERA_NETWORK is "${network}". Unset it or set it to testnet.`);
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
// Follow E2E_ORIGIN like the e2e scripts do. These lines are meant to be pasted, and one of
// them pastes a private key into a browser console — naming the wrong port tells the reader
// to hand that key to whatever else is listening on 3000.
const origin = process.env.E2E_ORIGIN?.trim() || "http://127.0.0.1:3000";
const originPrefix = origin === "http://127.0.0.1:3000" ? "" : `E2E_ORIGIN=${origin} `;

// localStorage is partitioned per origin, and `localhost` and `127.0.0.1` are different
// origins even on the same port. Pasting the key under one and browsing the other leaves the
// page reporting no signing key, with nothing to suggest why — so print both and say so,
// rather than naming one and hoping it is the one in the address bar.
const { hostname, port, protocol } = new URL(origin);
const sibling =
  hostname === "localhost"
    ? `${protocol}//127.0.0.1${port ? `:${port}` : ""}`
    : hostname === "127.0.0.1"
      ? `${protocol}//localhost${port ? `:${port}` : ""}`
      : null;

console.log("");
console.log("Pay with it from the command line:");
console.log(`  ${originPrefix}yarn e2e:charge ${burner.toStringRaw()} hashgraph-mug`);
console.log("");
console.log("Or pay in the browser. Open the store, then paste this into the DevTools console");
console.log("ON THE PAGE ITSELF — the key is stored per origin, so it has to be the same host");
console.log("you are browsing:");
console.log("");
console.log(`  localStorage.setItem("burnerWallet.pk", "0x${burner.toStringRaw()}"); location.reload();`);
console.log("");
if (sibling) {
  console.log(`  Works on ${origin} or ${sibling} — but only the one you paste it on.`);
  console.log("  Those are separate origins to the browser, so a key set on one is invisible");
  console.log("  on the other, and the checkout will say it has no signing key.");
} else {
  console.log(`  Paste it on ${origin}, the origin this key was printed for.`);
}
if (!process.env.E2E_ORIGIN) {
  console.log("");
  console.log("  (Server on another port? Re-run with E2E_ORIGIN=http://127.0.0.1:<port> to");
  console.log("   print commands that point at it.)");
}
