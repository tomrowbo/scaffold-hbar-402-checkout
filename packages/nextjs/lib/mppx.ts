/**
 * Machine Payments Protocol server for the checkout: one 402 challenge advertising the
 * native Hedera USDC charge and a Stripe card charge (a placeholder offer in demo mode).
 *
 * Server-only: this module reads unprefixed environment variables and instantiates a
 * long-lived MPP handler, so import it from route handlers and server components only.
 *
 * Two things about `mppx@0.10.1` + `mppx-hedera@0.2.2` are easy to get wrong:
 *
 *  1. Import from `mppx/server/core`, not `mppx/server`. The latter re-exports the
 *     built-in Tempo method, which imports `viem/tempo` — a subpath that does not
 *     exist in the viem version wagmi pins here, so the whole module fails to load.
 *     `core` is the same `Mppx` factory without the bundled methods.
 *  2. `recipient` belongs on the `mppx.charge({ ... })` call, not on
 *     `hedera.charge({ ... })`. mppx 0.10 validates the request schema before the
 *     method's own `request()` hook can fill the default in, so configuring it at
 *     construction throws `ZodError: recipient: expected string`. The README shipped
 *     with mppx-hedera still shows the old (0.5) placement.
 *  3. Import Stripe from `mppx/stripe/server/spt`, not `mppx/stripe/server`. The latter
 *     pulls in the Tempo method through `Methods.js` and fails exactly like (1). `spt`
 *     exports the same `charge` without it.
 */
import { hasHedera, hasStripe } from "./demo";
import { resolvedNetwork } from "./hederaOperator";
import type { Method } from "mppx";
import { hedera } from "mppx-hedera/server";
import { Mppx } from "mppx/server/core";
import { stripe } from "mppx/stripe/server/spt";
import Stripe from "stripe";

/**
 * Production switch: `HEDERA_NETWORK=mainnet`. Token id and Mirror Node follow it, so the
 * charge, the settlement check and the Hashscan links always agree on the network.
 *
 * Testnet USDC is `0.0.5449`: `mppx-hedera` resolves this same id from the chain id, and it
 * is the token the documented operator actually holds. `0.0.429274` is a different testnet
 * token sharing the name and symbol — charges against it are unverifiable here.
 */
const NETWORK_CONFIG = {
  testnet: { usdcTokenId: "0.0.5449", mirrorNodeUrl: "https://testnet.mirrornode.hedera.com" },
  mainnet: { usdcTokenId: "0.0.456858", mirrorNodeUrl: "https://mainnet.mirrornode.hedera.com" },
} as const;

export const HEDERA_NETWORK = resolvedNetwork();
export const USDC_TOKEN_ID = NETWORK_CONFIG[HEDERA_NETWORK].usdcTokenId;
export const USDC_DECIMALS = 6;
export const MIRROR_NODE_URL = NETWORK_CONFIG[HEDERA_NETWORK].mirrorNodeUrl;

/** Card charges are priced in the same USD amounts as the catalogue. */
const STRIPE_CURRENCY = "usd";
const STRIPE_DECIMALS = 2;

/** Stripe's documented pattern: the key prefix alone decides test vs live. */
export function stripeLivemode(): boolean {
  return !process.env.STRIPE_SECRET_KEY?.includes("_test_");
}

/**
 * Mirror Node indexing is usually sub-second but can lag a few seconds behind consensus.
 * 15 polls at 2s gives settlement a 30s budget; `mppx-hedera` retries on 404 rather than
 * failing on the first miss.
 */
const MIRROR_NODE_MAX_RETRIES = 15;
const MIRROR_NODE_RETRY_DELAY_MS = 2_000;

/**
 * Fingerprinted into every attribution memo and echoed as the challenge realm, so the two
 * must agree. Buyers sign a memo derived from the realm they were challenged with; a realm
 * that does not match `serverId` fails verification.
 */
export const MPP_REALM = process.env.MPP_REALM ?? "localhost:3000";

/**
 * Signs the challenge HMACs that let the server verify a returned credential matches a
 * challenge it issued. `Mppx.create` rejects anything under 32 bytes, so the no-credential
 * default below is padded to length. It is public knowledge and MUST be replaced in any
 * real deployment — generate one with `openssl rand -base64 32`.
 */
const INSECURE_DEV_SECRET_KEY = "mpp-checkout-dev-only-insecure-secret-do-not-deploy";

/**
 * Throws at module load — so `next start` / the first import fails, not some later request —
 * when real money could be accepted against the public default: on mainnet, or with a live
 * Stripe key.
 */
function mppSecretKey(): string {
  const configured = process.env.MPP_SECRET_KEY?.trim();
  const secure = Boolean(configured) && configured !== INSECURE_DEV_SECRET_KEY;
  const production = HEDERA_NETWORK === "mainnet" || (hasStripe() && stripeLivemode());
  if (production && !secure) {
    throw new Error(
      "MPP_SECRET_KEY must be set to a private value of 32+ bytes on mainnet or with a live Stripe key " +
        "(generate one with `openssl rand -base64 32`). Refusing to start with the insecure default.",
    );
  }
  return configured || INSECURE_DEV_SECRET_KEY;
}

/**
 * Merchant account that receives the USDC. Falls back to the operator so a developer with a
 * single configured account gets a working rail, then to `0.0.0` so the route still issues a
 * well-formed challenge with no environment at all.
 */
export function chargeRecipient(): string {
  return process.env.HEDERA_RECIPIENT_ID ?? process.env.HEDERA_OPERATOR_ID ?? "0.0.0";
}

/** True when settlement can actually be verified against a real merchant account. */
export function canSettle(): boolean {
  return hasHedera() || Boolean(process.env.HEDERA_RECIPIENT_ID?.trim());
}

/**
 * Stripe SDK client, or `null` in demo mode. `stripe.charge()` throws without a usable
 * client, so the card method is only constructed — and only advertised — when all three
 * `STRIPE_*` variables are present.
 */
export const stripeClient: Stripe | null = hasStripe() ? new Stripe(process.env.STRIPE_SECRET_KEY!.trim()) : null;

const methods: Method.AnyServer[] = [
  hedera.charge({
    serverId: MPP_REALM,
    testnet: HEDERA_NETWORK === "testnet",
    mirrorNodeUrl: MIRROR_NODE_URL,
    maxRetries: MIRROR_NODE_MAX_RETRIES,
    retryDelay: MIRROR_NODE_RETRY_DELAY_MS,
    // Pull mode: the buyer signs the transfer in the browser and the operator submits it,
    // so the page never needs gRPC-web. Absent these, only push-mode credentials (a
    // transaction id the buyer already broadcast) can be verified.
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
  }),
];

/**
 * The card offer is always advertised so one 402 names both rails. In demo mode it carries a
 * placeholder network and secret key: the route never lets a card credential reach `verify`
 * (see `stripeDemoMode()`) and `/api/pay/token` 503s before it would ever use that key.
 *
 * `html` is only configured when a real publishable key exists. There is no publishable key
 * to give mppx's Stripe Elements template in demo mode — a placeholder key just makes
 * Stripe.js reject it (401, `loaderror`) after mounting a card form that can never submit,
 * which looks broken rather than intentionally stubbed. Demo mode omits `html` here so mppx
 * never attempts to build that iframe; the route handler renders its own plain, disabled
 * demo panel for `Accept: text/html` instead (see `app/api/pay/route.ts`).
 */
const STRIPE_DEMO_NETWORK_ID = "demo";
const STRIPE_DEMO_SECRET_KEY = "sk_test_demo00000000000000000000000000000000000000000000";

methods.push(
  stripeClient
    ? stripe.charge({
        client: stripeClient,
        networkId: process.env.STRIPE_NETWORK_ID!.trim(),
        paymentMethodTypes: ["card"],
        // Browsers (`Accept: text/html`) get a Stripe Elements card form on the same URL;
        // agents get the challenge JSON. The form mints its SPT through `createTokenUrl`.
        html: {
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!.trim(),
          createTokenUrl: "/api/pay/token",
        },
      })
    : stripe.charge({
        secretKey: STRIPE_DEMO_SECRET_KEY,
        networkId: STRIPE_DEMO_NETWORK_ID,
        paymentMethodTypes: ["card"],
      }),
);

/** True when the advertised card offer is a placeholder that cannot settle. */
export function stripeDemoMode(): boolean {
  return !stripeClient;
}

export const mppx = Mppx.create({
  methods,
  realm: MPP_REALM,
  secretKey: mppSecretKey(),
});

/** Options accepted by the Hedera charge intent, after mppx's request transform. */
export type ChargeOptions = {
  /**
   * Human-readable decimal string, e.g. `"24.00"`. mppx scales it by `decimals`. The card
   * offer reuses it as a USD amount — USDC and the catalogue are both dollar-denominated.
   */
  amount: string;
  currency: string;
  decimals: number;
  recipient: string;
  description?: string;
  /** Server-defined correlation data, serialized into the challenge as `opaque`. */
  meta?: Record<string, string>;
};

export type ChargeResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt: (response: Response) => Response };

type Handler = (request: Request) => Promise<ChargeResult>;

/**
 * Narrow façade over the generated mppx handlers.
 *
 * Both methods share the `charge` intent, so they are composed into one 402 carrying a
 * `WWW-Authenticate: Payment` challenge per method. Each gets its own
 * options — the Hedera offer is in USDC base units, the card offer in cents — which the
 * implicit `mppx.charge` shorthand cannot express.
 *
 * `hedera.charge` is declared as an opaque `Method.AnyServer` in `types/mppx-hedera.d.ts`
 * (the package ships no types), so mppx cannot infer the per-intent handler signatures.
 * Asserting them once here keeps the cast out of the route handler.
 */
export function charge(options: ChargeOptions): Handler {
  const handlers = mppx as unknown as {
    compose: (...entries: [string, Record<string, unknown>][]) => Handler;
  };
  return handlers.compose(
    ["hedera/charge", options],
    [
      "stripe/charge",
      {
        amount: options.amount,
        currency: STRIPE_CURRENCY,
        decimals: STRIPE_DECIMALS,
        description: options.description,
        meta: options.meta,
      },
    ],
  );
}

/**
 * Hashscan link for a settled transaction id such as `0.0.1234@1758556800.123456789`.
 * `@` is a legal path character, so it is left intact and the id stays readable in the href.
 */
export function hashscanTransactionUrl(transactionId: string): string {
  return `https://hashscan.io/${HEDERA_NETWORK}/transaction/${transactionId}`;
}
