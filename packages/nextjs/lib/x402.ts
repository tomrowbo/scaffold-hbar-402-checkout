/**
 * x402 comparison rail: the network-facing half of `hasX402()`.
 *
 * `hasX402()` in `lib/demo.ts` only says a facilitator URL is configured. Whether that
 * facilitator will actually settle on Hedera is a separate, network-dependent question, asked
 * here once per process and never allowed to throw: a third-party endpoint being slow, down,
 * or dropping Hedera must degrade this rail to demo mode and leave every other rail alone.
 *
 * Server-only: reads unprefixed environment variables. Import from route handlers only.
 */
import { hasX402 } from "./demo";
import { HEDERA_NETWORK } from "./mppx";

/**
 * The facilitator names Hedera with a CAIP-2-style namespace, not `eip155:296`. The chain-id
 * form silently matches nothing in `/supported`'s `kinds`. Follows `HEDERA_NETWORK` so the
 * offer never pairs a mainnet token with a testnet network; only testnet is supported by the
 * Ax402 facilitator this template targets, so mainnet resolves to demo mode.
 */
const X402_NETWORKS = { testnet: "hedera:testnet", mainnet: "hedera:mainnet" } as const;
export const X402_NETWORK = X402_NETWORKS[HEDERA_NETWORK];
export const X402_SCHEME = "exact";
export const X402_VERSION = 2;

const FACILITATOR_TIMEOUT_MS = 3_000;

export type X402Capability = { live: true } | { live: false; reason: string };

type SupportedKind = { scheme?: unknown; network?: unknown };

async function probeFacilitator(): Promise<X402Capability> {
  if (!hasX402()) return { live: false, reason: "AX402_FACILITATOR_URL is not set" };

  const url = `${process.env.AX402_FACILITATOR_URL!.trim().replace(/\/+$/, "")}/supported`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS) });
    if (response.status !== 200) return { live: false, reason: `facilitator /supported answered ${response.status}` };

    const body = (await response.json()) as { kinds?: unknown };
    if (!Array.isArray(body?.kinds)) return { live: false, reason: "facilitator /supported returned no kinds array" };

    const supported = (body.kinds as SupportedKind[]).some(
      kind => kind?.scheme === X402_SCHEME && kind?.network === X402_NETWORK,
    );
    return supported
      ? { live: true }
      : { live: false, reason: `facilitator does not list ${X402_SCHEME} on ${X402_NETWORK}` };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { live: false, reason: `facilitator /supported unreachable (${detail})` };
  }
}

let capability: Promise<X402Capability> | null = null;

/**
 * Whether the configured facilitator supports `exact` on Hedera. Probed on first use and
 * memoized for the life of the process — not a top-level `await`, which would stall module
 * evaluation for anything importing this file. Always resolves, never rejects.
 */
export function x402Capability(): Promise<X402Capability> {
  capability ??= probeFacilitator();
  return capability;
}

/** The one question route code should ask: configured, and the facilitator can settle Hedera. */
export async function canSettleX402(): Promise<boolean> {
  return hasX402() && (await x402Capability()).live;
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
