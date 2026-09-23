/**
 * Server-side Hedera operator client. Import from route handlers only — it reads the
 * unprefixed operator variables and opens a gRPC client.
 */
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

export type HederaNetwork = "testnet" | "mainnet";

/**
 * The one production switch for the Hedera rail: `HEDERA_NETWORK=mainnet`. Unset means
 * testnet, so an empty environment stays a working demo. Anything else is rejected rather
 * than guessed at — a typo must not quietly land on either network. `lib/mppx.ts` derives
 * its token id and Mirror Node from this too, so the two cannot drift.
 */
export function resolvedNetwork(): HederaNetwork {
  const raw = process.env.HEDERA_NETWORK?.trim().toLowerCase();
  if (!raw || raw === "testnet") return "testnet";
  if (raw === "mainnet") return "mainnet";
  throw new Error(`HEDERA_NETWORK must be "testnet" or "mainnet", got "${process.env.HEDERA_NETWORK}"`);
}

/**
 * Accepts the formats a Hedera operator key is normally distributed in: `0x`-prefixed
 * ECDSA hex, bare ECDSA hex, DER, and ED25519.
 */
export function parseOperatorKey(raw: string): PrivateKey {
  const value = raw.trim();
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  const attempts = [
    () => (hex.length === 64 ? PrivateKey.fromStringECDSA(hex) : PrivateKey.fromStringDer(value)),
    () => PrivateKey.fromStringECDSA(hex),
    () => PrivateKey.fromStringED25519(hex),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error("HEDERA_OPERATOR_KEY is not a recognised Hedera private key");
}

/**
 * Builds a client for the configured operator on the resolved network. Callers own the
 * client and must `close()` it — leaving them open leaks gRPC connections across hot reloads.
 */
export function operatorClient(): { client: Client; accountId: string; key: PrivateKey } {
  const accountId = process.env.HEDERA_OPERATOR_ID?.trim();
  const rawKey = process.env.HEDERA_OPERATOR_KEY?.trim();
  if (!accountId || !rawKey) {
    throw new Error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
  }
  const key = parseOperatorKey(rawKey);
  const client = resolvedNetwork() === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), key);
  return { client, accountId, key };
}
