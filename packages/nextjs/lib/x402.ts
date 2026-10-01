/**
 * x402 rail: the network-facing half of `hasX402()`.
 *
 * `hasX402()` in `lib/demo.ts` only says a facilitator URL is configured. Whether that
 * facilitator will actually settle on Hedera is a separate, network-dependent question, asked
 * here once per process and never allowed to throw: a third-party endpoint being slow, down,
 * or dropping Hedera must degrade this rail to demo mode and leave every other rail alone.
 *
 * `verifyPayment` and `settlePayment` are the two calls that actually move money. They are
 * deliberately *not* memoized and deliberately *do* throw — a failed settlement must surface,
 * not silently downgrade to demo mode.
 *
 * Server-only: reads unprefixed environment variables. Import from route handlers only.
 */
import { hasX402 } from "./demo";
import { HEDERA_NETWORK } from "./mppx";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

/**
 * The facilitator names Hedera with a CAIP-2-style namespace, not `eip155:296`. The chain-id
 * form silently matches nothing in `/supported`'s `kinds`. Follows `HEDERA_NETWORK` so the
 * offer never pairs a mainnet token with a testnet network; only testnet is supported by the
 * Ax402 facilitator this template targets, so mainnet resolves to demo mode.
 */
const X402_NETWORKS = { testnet: "hedera:testnet", mainnet: "hedera:mainnet" } as const;
export const X402_NETWORK: Network = X402_NETWORKS[HEDERA_NETWORK];
export const X402_SCHEME = "exact";
export const X402_VERSION = 2;

/** Capability probe: cheap, run on every unpaid request, must not stall the challenge. */
const FACILITATOR_TIMEOUT_MS = 3_000;
/**
 * Settlement submits a `TransferTransaction` and waits for its Hedera receipt, so it is on a
 * different order of magnitude from the probe. 30s matches the `maxTimeoutSeconds` the offer
 * advertises.
 */
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * `extra` on a live capability is the matched `/supported` kind's own `extra`, verbatim. For
 * Hedera `exact` it carries `feePayer` — the account the facilitator sponsors fees from, and
 * the account `@x402/hedera`'s client signer requires in `paymentRequirements.extra` before it
 * will build a transaction at all. Without it no x402 client can pay this rail.
 */
export type X402Capability = { live: true; extra: Record<string, unknown> } | { live: false; reason: string };

/** Configured facilitator base URL with any trailing slashes removed, or `null` in demo mode. */
export function facilitatorUrl(): string | null {
  const configured = process.env.AX402_FACILITATOR_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

async function probeFacilitator(): Promise<X402Capability> {
  const base = facilitatorUrl();
  if (!base) return { live: false, reason: "AX402_FACILITATOR_URL is not set" };

  try {
    const response = await fetch(`${base}/supported`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
    if (response.status !== 200) return { live: false, reason: `facilitator /supported answered ${response.status}` };

    const body = (await response.json()) as Partial<SupportedResponse>;
    if (!Array.isArray(body?.kinds)) return { live: false, reason: "facilitator /supported returned no kinds array" };

    // Match the protocol version too: a facilitator listing `exact` on Hedera for v1 only
    // cannot settle the v2 payload this route issues.
    const kind = (body.kinds as SupportedKind[]).find(
      candidate =>
        candidate?.scheme === X402_SCHEME &&
        candidate?.network === X402_NETWORK &&
        candidate?.x402Version === X402_VERSION,
    );
    return kind
      ? { live: true, extra: kind.extra ?? {} }
      : { live: false, reason: `facilitator does not list ${X402_SCHEME} v${X402_VERSION} on ${X402_NETWORK}` };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { live: false, reason: `facilitator /supported unreachable (${detail})` };
  }
}

let cached: { value: X402Capability; at: number } | null = null;
let inFlight: Promise<X402Capability> | null = null;

/**
 * How long a *failed* probe is trusted before the next request re-asks. A success is kept for
 * the life of the process; a failure must not be, which is what this constant is for.
 *
 * The probe has a 3s budget on the request path, and the first request to this route is also
 * the one that waits out the cold webpack compile in `yarn next:dev`. On a loaded machine the
 * event loop can be starved past 3s even though the facilitator answers in well under a
 * second — so the first probe can lose a race it would normally win by a wide margin. Caching
 * that permanently left a correctly configured rail dead until the process restarted, while
 * the UI told the operator to set a variable that was already set.
 */
const FAILED_PROBE_TTL_MS = 30_000;

/**
 * Whether the configured facilitator supports `exact` on Hedera. Probed on first use, not at
 * module scope — a top-level `await` would stall module evaluation for anything importing
 * this file. Always resolves, never rejects.
 *
 * A live result is memoized for the life of the process. A failure is retried after
 * `FAILED_PROBE_TTL_MS`, so a third party that was briefly slow does not disable the rail
 * permanently. Concurrent callers share one in-flight probe either way.
 */
export function x402Capability(): Promise<X402Capability> {
  if (cached && (cached.value.live || Date.now() - cached.at < FAILED_PROBE_TTL_MS)) {
    return Promise.resolve(cached.value);
  }
  inFlight ??= probeFacilitator().then(value => {
    cached = { value, at: Date.now() };
    inFlight = null;
    return value;
  });
  return inFlight;
}

/** The probe's last verdict, for error messages that would otherwise misdirect. */
export function x402LastProbeReason(): string | null {
  return cached && !cached.value.live ? cached.value.reason : null;
}

/** The one question route code should ask: configured, and the facilitator can settle Hedera. */
export async function canSettleX402(): Promise<boolean> {
  return hasX402() && (await x402Capability()).live;
}

/**
 * `POST /verify` or `POST /settle`. The wire body is the one `@x402/core`'s own
 * `HTTPFacilitatorClient` sends, so a facilitator that works with the reference resource
 * server works with this one.
 *
 * Throws on anything that is not a well-formed JSON response — a facilitator that is down,
 * slow or answering HTML is a 502 from this route, never a silent pass.
 */
async function facilitatorPost<T>(
  operation: "verify" | "settle",
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<T> {
  const base = facilitatorUrl();
  if (!base) throw new Error("AX402_FACILITATOR_URL is not set");

  const response = await fetch(`${base}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`facilitator /${operation} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  // A rejected payment is a normal outcome reported in the body (`isValid: false` /
  // `success: false`), and the facilitator may send it with a 4xx. Pass those through so the
  // route can report the reason; only a body that carries no verdict at all is an error.
  const hasVerdict =
    typeof body === "object" && body !== null && (operation === "verify" ? "isValid" : "success") in body;
  if (!response.ok && !hasVerdict) {
    throw new Error(`facilitator /${operation} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return body as T;
}

/** Asks the facilitator whether a payment payload satisfies the requirements it names. */
export function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return facilitatorPost<VerifyResponse>("verify", paymentPayload, paymentRequirements);
}

/** Asks the facilitator to broadcast the payment. On success the response names the transaction. */
export function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  return facilitatorPost<SettleResponse>("settle", paymentPayload, paymentRequirements);
}

/**
 * Scales a decimal money string to integer base units by moving digits, never through a
 * float: `("24.00", 6)` → `"24000000"`. Throws on a malformed price or one more precise than
 * the token — both are catalogue bugs, not runtime conditions.
 */
export function toBaseUnits(amount: string, decimals: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Not a decimal amount: ${amount}`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) throw new Error(`${amount} has more than ${decimals} decimal places`);
  return (whole + fraction.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
}
