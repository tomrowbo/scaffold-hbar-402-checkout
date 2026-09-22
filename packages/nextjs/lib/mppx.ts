/**
 * Machine Payments Protocol server for the native Hedera charge rail.
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
 */
import { hasHedera } from "./demo";
import { hedera } from "mppx-hedera/server";
import { Mppx } from "mppx/server/core";

/**
 * Hedera testnet USDC. `mppx-hedera` resolves this same id from the chain id, and it is
 * the token the documented operator actually holds. `0.0.429274` is a different testnet
 * token sharing the name and symbol — charges against it are unverifiable here.
 */
export const USDC_TOKEN_ID = "0.0.5449";
export const USDC_DECIMALS = 6;

/** Charges settle on testnet; `USDC_TOKEN_ID` and the Hashscan links below assume it. */
export const HEDERA_NETWORK = "testnet";
export const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

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

export const mppx = Mppx.create({
  methods: [
    hedera.charge({
      serverId: MPP_REALM,
      testnet: true,
      maxRetries: MIRROR_NODE_MAX_RETRIES,
      retryDelay: MIRROR_NODE_RETRY_DELAY_MS,
      // Pull mode: the buyer signs the transfer in the browser and the operator submits it,
      // so the page never needs gRPC-web. Absent these, only push-mode credentials (a
      // transaction id the buyer already broadcast) can be verified.
      operatorId: process.env.HEDERA_OPERATOR_ID,
      operatorKey: process.env.HEDERA_OPERATOR_KEY,
    }),
  ],
  realm: MPP_REALM,
  secretKey: process.env.MPP_SECRET_KEY ?? INSECURE_DEV_SECRET_KEY,
});

/** Options accepted by the Hedera charge intent, after mppx's request transform. */
export type ChargeOptions = {
  /** Human-readable decimal string, e.g. `"24.00"`. mppx scales it by `decimals`. */
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

/**
 * Narrow façade over the generated `mppx.charge` handler.
 *
 * `hedera.charge` is declared as an opaque `Method.AnyServer` in `types/mppx-hedera.d.ts`
 * (the package ships no types), so mppx cannot infer the per-intent handler signature.
 * Asserting it once here keeps the cast out of the route handler.
 */
export function charge(options: ChargeOptions): (request: Request) => Promise<ChargeResult> {
  const handlers = mppx as unknown as {
    charge: (options: ChargeOptions) => (request: Request) => Promise<ChargeResult>;
  };
  return handlers.charge(options);
}

/**
 * Hashscan link for a settled transaction id such as `0.0.1234@1758556800.123456789`.
 * `@` is a legal path character, so it is left intact and the id stays readable in the href.
 */
export function hashscanTransactionUrl(transactionId: string): string {
  return `https://hashscan.io/${HEDERA_NETWORK}/transaction/${transactionId}`;
}
