// Pays the card rail of /api/pay against the running dev server.
//
// The third sibling of e2e-charge.mjs and e2e-x402.mjs: same store, same product, the card
// leg of the same MPP 402. It walks the path a browser takes — read the `stripe` challenge,
// mint a Shared Payment Token for the card, retry with `{ spt }` as the credential — so a
// pass here means Stripe really confirmed a PaymentIntent, not that our code agrees with
// itself.
//
//   yarn e2e:stripe [product-id]
//
// Needs STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_NETWORK_ID on the server. Uses
// `pm_card_visa`, Stripe's shared test PaymentMethod, so it only works with an `sk_test_`
// key — a live key mints SPTs through Onelink and charges a real card.
import { Challenge, Credential } from "mppx";

const ORIGIN = process.env.E2E_ORIGIN?.trim() || "http://127.0.0.1:3000";
const PRODUCT = process.argv[2] ?? "hashgraph-mug";
const ENDPOINT = `${ORIGIN}/api/pay?product=${PRODUCT}`;
// Stripe's canonical test card (4242…4242). Test-mode only.
const TEST_PAYMENT_METHOD = "pm_card_visa";

const die = message => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
console.log("1. challenge status:", res.status);
if (res.status !== 402) die(`expected 402, got ${res.status}`);

const demoRails =
  res.headers
    .get("x-mpp-demo-mode")
    ?.split(",")
    .map(rail => rail.trim()) ?? [];
if (demoRails.includes("stripe")) {
  die("the card rail is in demo mode — set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_NETWORK_ID");
}

const challenge = Challenge.fromResponseList(res).find(c => c.method === "stripe");
if (!challenge) die("no stripe challenge in the WWW-Authenticate header");

const { amount, currency, methodDetails } = challenge.request;
const networkId = methodDetails?.networkId;
console.log("2. parsed:", { id: challenge.id, amount, currency, networkId });

// The card form posts to this route rather than minting the token in the browser: the SPT
// grant needs the secret key, and the route pins the network id to this merchant's own.
const expiresAt = Math.floor(Date.parse(challenge.expires) / 1000);
console.log("3. minting SPT for", TEST_PAYMENT_METHOD, "…");
const tokenRes = await fetch(`${ORIGIN}/api/pay/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentMethod: TEST_PAYMENT_METHOD, amount, currency, networkId, expiresAt }),
});
const tokenBody = await tokenRes.json();
if (!tokenRes.ok) die(`/api/pay/token ${tokenRes.status}: ${JSON.stringify(tokenBody)}`);
console.log("4. spt:", tokenBody.spt);

const credential = Credential.from({ challenge, payload: { spt: tokenBody.spt } });

console.log("5. retrying with the credential…");
const paid = await fetch(ENDPOINT, {
  headers: { Accept: "application/json", [Challenge.credentialHeader(challenge)]: Credential.serialize(credential) },
});
console.log("6. settled status:", paid.status);
console.log("   payment-receipt:", paid.headers.get("payment-receipt"));
const body = await paid.text();
console.log("   body:", body);
if (paid.status !== 200) die(`payment was not accepted (${paid.status})`);

// The PaymentIntent id the server settled with. Look it up in the Stripe Dashboard under
// Payments — that record, not this script's exit code, is the proof the card was charged.
const paymentIntent = JSON.parse(body)?.transactionId;
if (!paymentIntent?.startsWith("pi_")) die(`expected a PaymentIntent id, got ${paymentIntent}`);
console.log("\n\u2713 card payment settled:", paymentIntent);
console.log("  dashboard.stripe.com/test/payments/" + paymentIntent);
