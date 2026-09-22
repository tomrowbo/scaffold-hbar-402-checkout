/**
 * Server-side Hedera operator client. Import from route handlers only — it reads the
 * unprefixed operator variables and opens a gRPC client.
 */
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

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
 * Builds a testnet client for the configured operator. Callers own the client and must
 * `close()` it — leaving them open leaks gRPC connections across hot reloads.
 */
export function operatorClient(): { client: Client; accountId: string; key: PrivateKey } {
  const accountId = process.env.HEDERA_OPERATOR_ID?.trim();
  const rawKey = process.env.HEDERA_OPERATOR_KEY?.trim();
  if (!accountId || !rawKey) {
    throw new Error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
  }
  const key = parseOperatorKey(rawKey);
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), key);
  return { client, accountId, key };
}
