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
import { Errors, type Method } from "mppx";
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
 *
 * Falls back to the incoming request's own `Host` header (see `realmFromRequest`) rather
 * than a fixed default, so a checkout served from anywhere other than `localhost:3000` — a
 * tunnel, a preview deployment, a LAN IP during a demo — gets a realm that actually matches
 * where it is running. `MPP_REALM` stays available as an explicit override for deployments
 * behind a proxy, where the `Host` header the app sees is not the public host buyers use.
 */
const DEFAULT_REALM = "localhost:3000";
const MPP_REALM_OVERRIDE = process.env.MPP_REALM?.trim() || undefined;

/** Realm for contexts with no request to read a `Host` header from (module-load-time checks). */
export const MPP_REALM = MPP_REALM_OVERRIDE ?? DEFAULT_REALM;

/**
 * The realm a given request should be challenged and verified against. `MPP_REALM_OVERRIDE`
 * wins when set; otherwise the request's `Host` header, so the realm always matches the host
 * the app is actually being served on. `DEFAULT_REALM` only applies to a request with no
 * `Host` header at all, which real HTTP clients do not send.
 */
export function realmFromRequest(request: Request): string {
  return MPP_REALM_OVERRIDE ?? request.headers.get("host")?.trim() ?? DEFAULT_REALM;
}

/**
 * Signs the challenge HMACs that let the server verify a returned credential matches a
 * challenge it issued. `Mppx.create` rejects anything under 32 bytes, so the no-credential
 * default below is padded to length. It is public knowledge and MUST be replaced in any
 * real deployment — generate one with `openssl rand -base64 32`.
 */
const INSECURE_DEV_SECRET_KEY = "402-checkout-dev-only-insecure-secret-do-not-deploy";

/**
 * Throws at module load when real money could be accepted against the public default: on
 * mainnet, or with a live Stripe key.
 *
 * Note what "module load" buys and what it does not. It guarantees no challenge is ever
 * signed with the public key and no request can slip past — but Next.js loads route modules
 * lazily, so the server still starts, reports ready and binds the port. The first request to
 * a route importing this module gets a 500. Nothing fails at boot, so a deploy check must hit
 * a paid route rather than trusting startup. See "Smoke-test a paid route" in the README.
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
  // Blank must mean "not set". `.env.example` ships `HEDERA_RECIPIENT_ID=`, and `??` only
  // falls through on null/undefined — so an untouched copy of that file used to advertise
  // `recipient: ""` in the challenge and fail deep inside the SDK with
  // `failed to parse entity id:` after the buyer had already been funded.
  const configured = [process.env.HEDERA_RECIPIENT_ID, process.env.HEDERA_OPERATOR_ID].find(value => value?.trim());
  return configured?.trim() ?? "0.0.0";
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

/**
 * What a failing Hedera receipt status means for the buyer, and what they can do about it.
 * Only the statuses a testnet checkout realistically produces; anything else is reported by
 * name alone rather than guessed at.
 */
const RECEIPT_STATUS_CAUSES: Record<string, string> = {
  INSUFFICIENT_TOKEN_BALANCE: `the buyer does not hold enough ${USDC_TOKEN_ID} to cover the charge; top it up with POST /api/testnet/fund, or send it the token directly`,
  TOKEN_NOT_ASSOCIATED_TO_ACCOUNT: `the buyer has not associated token ${USDC_TOKEN_ID}, so it cannot hold or spend it`,
  INSUFFICIENT_PAYER_BALANCE: "the buyer has no HBAR left to pay the transaction fee",
  INSUFFICIENT_ACCOUNT_BALANCE: "the buyer has no HBAR left to pay the transaction fee",
  TRANSACTION_EXPIRED: "the signed transfer reached the network more than 180 seconds after it was frozen",
  ACCOUNT_FROZEN_FOR_TOKEN: `the buyer is frozen for token ${USDC_TOKEN_ID}`,
};

/**
 * Re-raises whatever a method's `verify` threw as one of mppx's own payment errors.
 *
 * mppx turns anything else into a bare `InternalPaymentError` — `500` with the body
 * `"An internal payment error occurred."` and the cause left in the server log. `mppx-hedera`
 * raises named errors for most failures, but in pull mode the Hedera SDK throws first: a
 * submitted transfer that comes back with a failing receipt raises `ReceiptStatusError`
 * before the library's own status check runs. So the one failure a buyer actually hits — an
 * empty wallet — is the one that reaches them with nothing in it.
 *
 * `VerificationFailedError` is what `mppx-hedera` uses for every failure it does catch, and
 * it is the honest answer here too: the transfer was rejected, and a buyer who funds the
 * account can retry the same challenge.
 */
function asPaymentError(error: unknown): unknown {
  if (error instanceof Errors.PaymentError) return error;

  const receipt = error as { status?: { toString(): string }; transactionId?: { toString(): string } } | null;
  const status = receipt?.status?.toString();
  if (!status) {
    return new Errors.VerificationFailedError({
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const cause = RECEIPT_STATUS_CAUSES[status];
  const transactionId = receipt?.transactionId?.toString();
  return new Errors.VerificationFailedError({
    reason:
      `the Hedera network rejected the transfer with ${status}` +
      (cause ? ` — ${cause}` : "") +
      (transactionId ? ` (transaction ${transactionId})` : ""),
  });
}

/** Wraps a method's `verify` so a raw throw never reaches the buyer as a bare 500. */
function withNamedFailures(method: Method.AnyServer): Method.AnyServer {
  const verify = (method as { verify?: (parameters: unknown) => Promise<unknown> }).verify;
  if (typeof verify !== "function") return method;
  return {
    ...method,
    verify: async (parameters: unknown) => {
      try {
        return await verify(parameters);
      } catch (error) {
        throw asPaymentError(error);
      }
    },
  } as Method.AnyServer;
}

/**
 * Builds the two charge methods for a given realm. `hedera.charge`'s `serverId` is
 * fingerprinted into the attribution memo and must equal the challenge realm (see
 * `MPP_REALM` above), so the realm cannot be fixed at module load — it has to be rebuilt per
 * realm, one per distinct `Host` header the app is actually served behind.
 */
function buildMethods(realm: string): Method.AnyServer[] {
  const methods: Method.AnyServer[] = [
    withNamedFailures(
      hedera.charge({
        serverId: realm,
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
    ),
  ];

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

  return methods;
}

/** True when the advertised card offer is a placeholder that cannot settle. */
export function stripeDemoMode(): boolean {
  return !stripeClient;
}

type MppxInstance = ReturnType<typeof Mppx.create>;

/**
 * One mppx instance per realm, built on first use and reused after that — constructing a
 * `hedera.charge`/`stripe.charge` pair is pure setup (no I/O), but there is no reason to
 * repeat it for every request against the same host.
 *
 * The realm comes from a client-controlled `Host` header (`realmFromRequest`), so the cache
 * key is not trusted input — capped and reset rather than left to grow without bound against
 * a stream of made-up hosts.
 */
const mppxInstances = new Map<string, MppxInstance>();
const MAX_MPPX_INSTANCES = 64;

/**
 * Callbacks run against every instance, present and future — how `attachOrderRecorder()` in
 * `lib/orders.ts` gets its `onPaymentSuccess` listener onto all of them.
 *
 * mppx listeners are per-instance, and there is one instance per realm, so a listener
 * registered against the default instance alone would silently stop recording orders the
 * moment the app was served from anything other than `MPP_REALM` — a tunnel, a preview
 * deployment, a LAN IP during a demo, or just a second `next dev` on port 3001.
 */
type MppxInstanceListener = (instance: MppxInstance) => void;
const instanceListeners: MppxInstanceListener[] = [];

/** Registers `listener` against every mppx instance this process builds, including existing ones. */
export function onMppxInstance(listener: MppxInstanceListener): void {
  instanceListeners.push(listener);
  for (const instance of mppxInstances.values()) listener(instance);
}

function mppxForRealm(realm: string): MppxInstance {
  let instance = mppxInstances.get(realm);
  if (!instance) {
    if (mppxInstances.size >= MAX_MPPX_INSTANCES) mppxInstances.clear();
    instance = Mppx.create({ methods: buildMethods(realm), realm, secretKey: mppSecretKey() });
    mppxInstances.set(realm, instance);
    for (const listener of instanceListeners) listener(instance);
  }
  return instance;
}

/** The mppx instance a request's challenge or credential should be handled against. */
export function mppxForRequest(request: Request): MppxInstance {
  return mppxForRealm(realmFromRequest(request));
}

/**
 * Default instance for contexts with no request (module-load-time secret-key validation
 * below fails fast against this one). Request-scoped code should go through
 * `mppxForRequest` instead.
 */
export const mppx = mppxForRealm(MPP_REALM);

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

/** A composed handler still carrying mppx's discovery metadata (`generate()` in `mppx/discovery` reads offers off it). */
type DiscoveryCapableHandler = Handler & { _internal?: unknown };

/**
 * Composes both charge methods against a specific mppx instance into one handler.
 *
 * Both methods share the `charge` intent, so they are composed into one 402 carrying a
 * `WWW-Authenticate: Payment` challenge per method. Each gets its own
 * options — the Hedera offer is in USDC base units, the card offer in cents — which the
 * implicit `mppx.charge` shorthand cannot express.
 *
 * `hedera.charge` is declared as an opaque `Method.AnyServer` in `types/mppx-hedera.d.ts`
 * (the package ships no types), so mppx cannot infer the per-intent handler signatures.
 * Asserting them once here keeps the cast out of callers.
 */
function composeCharge(instance: MppxInstance, options: ChargeOptions): DiscoveryCapableHandler {
  const handlers = instance as unknown as {
    compose: (...entries: [string, Record<string, unknown>][]) => DiscoveryCapableHandler;
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
 * Charge handler for a route: resolves the request's realm (see `realmFromRequest`) to the
 * matching mppx instance before composing, so the challenge and the verification it is later
 * checked against always agree on which realm they are for.
 */
export function charge(options: ChargeOptions): Handler {
  return (request: Request) => composeCharge(mppxForRequest(request), options)(request);
}

/**
 * The same composed handler `charge` builds, minus the request wrapper, so the discovery
 * route (`app/openapi.json/route.ts`) can read its `_internal` metadata — mppx's own
 * `generate()` turns that into the `x-payment-info` offers, instead of a hand-written
 * document duplicating what `charge` already advertises.
 */
export function chargeHandlerForDiscovery(request: Request, options: ChargeOptions): DiscoveryCapableHandler {
  return composeCharge(mppxForRequest(request), options);
}

/**
 * Hashscan link for a settled transaction id such as `0.0.1234@1758556800.123456789`.
 * `@` is a legal path character, so it is left intact and the id stays readable in the href.
 */
export function hashscanTransactionUrl(transactionId: string): string {
  return `https://hashscan.io/${HEDERA_NETWORK}/transaction/${transactionId}`;
}
