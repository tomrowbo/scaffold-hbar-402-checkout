/**
 * Environment resolution for the charge config.
 *
 * Every case here is a bug this template actually shipped and had to fix, and each one was
 * expensive to find because none of them throws — a blank variable resolved to a well-formed
 * challenge that advertised the wrong thing, and the failure surfaced only on chain. They are
 * module-level constants, so each test re-imports the module under a different environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Variables that steer the module, cleared before each case so nothing leaks between them. */
const STEERING = [
  "HEDERA_NETWORK",
  "HEDERA_USDC_TOKEN_ID",
  "HEDERA_RECIPIENT_ID",
  "HEDERA_OPERATOR_ID",
  "MPP_REALM",
  "MPP_SECRET_KEY",
] as const;

/**
 * Any 32+ byte private value. Mainnet refuses to load with the public dev default, which is
 * the point of that guard — so a mainnet case has to supply one or it never reaches the
 * assertion.
 */
const TEST_SECRET = "unit-test-secret-key-of-ample-length-0123456789";

async function loadWith(env: Record<string, string>) {
  vi.resetModules();
  for (const key of STEERING) vi.stubEnv(key, undefined as unknown as string);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("./mppx");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("USDC_TOKEN_ID", () => {
  it("defaults testnet to Circle's token, the one their faucet dispenses", async () => {
    // Hedera testnet carries two tokens called "USD Coin", symbol USDC, 6 decimals, differing
    // only in treasury. Defaulting to the other one meant a buyer funded from
    // faucet.circle.com held the wrong USDC and got `insufficient_balance` naming a token
    // they could see in their wallet.
    const { USDC_TOKEN_ID } = await loadWith({ HEDERA_NETWORK: "testnet" });
    expect(USDC_TOKEN_ID).toBe("0.0.429274");
  });

  it("defaults mainnet to Circle's mainnet token", async () => {
    const { USDC_TOKEN_ID } = await loadWith({ HEDERA_NETWORK: "mainnet", MPP_SECRET_KEY: TEST_SECRET });
    expect(USDC_TOKEN_ID).toBe("0.0.456858");
  });

  it("honours a configured token id", async () => {
    const { USDC_TOKEN_ID } = await loadWith({ HEDERA_USDC_TOKEN_ID: "0.0.5449" });
    expect(USDC_TOKEN_ID).toBe("0.0.5449");
  });

  it("treats a blank configured token id as unset", async () => {
    // `.env.example` ships `HEDERA_USDC_TOKEN_ID=`. Read with `??` that is an empty string
    // rather than a fallback, and the store advertises a challenge with no token at all.
    const { USDC_TOKEN_ID } = await loadWith({ HEDERA_USDC_TOKEN_ID: "   " });
    expect(USDC_TOKEN_ID).toBe("0.0.429274");
  });
});

describe("chargeRecipient", () => {
  it("prefers the configured recipient", async () => {
    const { chargeRecipient } = await loadWith({
      HEDERA_RECIPIENT_ID: "0.0.1111",
      HEDERA_OPERATOR_ID: "0.0.2222",
    });
    expect(chargeRecipient()).toBe("0.0.1111");
  });

  it("falls back to the operator so one configured account is enough", async () => {
    const { chargeRecipient } = await loadWith({ HEDERA_OPERATOR_ID: "0.0.2222" });
    expect(chargeRecipient()).toBe("0.0.2222");
  });

  it("falls back to 0.0.0 with no environment at all", async () => {
    const { chargeRecipient } = await loadWith({});
    expect(chargeRecipient()).toBe("0.0.0");
  });

  it("treats a blank recipient as unset rather than advertising an empty one", async () => {
    // The original bug: an untouched `.env.example` advertised `recipient: ""`, which failed
    // deep inside the SDK with `failed to parse entity id:` — after the buyer had been funded.
    const { chargeRecipient } = await loadWith({ HEDERA_RECIPIENT_ID: "", HEDERA_OPERATOR_ID: "0.0.2222" });
    expect(chargeRecipient()).toBe("0.0.2222");
  });

  it("never returns an empty string, whatever the environment says", async () => {
    const { chargeRecipient } = await loadWith({ HEDERA_RECIPIENT_ID: "  ", HEDERA_OPERATOR_ID: "  " });
    expect(chargeRecipient()).toBe("0.0.0");
  });

  it("trims a recipient so a trailing newline cannot reach the ledger", async () => {
    const { chargeRecipient } = await loadWith({ HEDERA_RECIPIENT_ID: " 0.0.3333\n" });
    expect(chargeRecipient()).toBe("0.0.3333");
  });
});

describe("realmFromRequest", () => {
  it("uses the request host so one deployment can serve several", async () => {
    const { realmFromRequest } = await loadWith({});
    const request = new Request("https://shop.example/api/pay", { headers: { host: "shop.example" } });
    expect(realmFromRequest(request)).toBe("shop.example");
  });

  it("lets MPP_REALM override the host", async () => {
    const { realmFromRequest } = await loadWith({ MPP_REALM: "pinned.example" });
    const request = new Request("https://shop.example/api/pay", { headers: { host: "shop.example" } });
    expect(realmFromRequest(request)).toBe("pinned.example");
  });

  it("falls back to a default when the request carries no host", async () => {
    const { realmFromRequest } = await loadWith({});
    expect(realmFromRequest(new Request("https://shop.example/api/pay"))).toBeTruthy();
  });
});

describe("hashscanTransactionUrl", () => {
  it("leaves `@` intact so the id stays readable in the href", async () => {
    // HashScan accepts `@` as a path character. Encoding it to %40 also works but makes the
    // link unreadable in the receipt, and the Mirror Node's hyphenated form does not resolve.
    const { hashscanTransactionUrl } = await loadWith({ HEDERA_NETWORK: "testnet" });
    expect(hashscanTransactionUrl("0.0.10827845@1790966342.370842370")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.10827845@1790966342.370842370",
    );
  });

  it("points at the configured network", async () => {
    const { hashscanTransactionUrl } = await loadWith({ HEDERA_NETWORK: "mainnet", MPP_SECRET_KEY: TEST_SECRET });
    expect(hashscanTransactionUrl("0.0.1@1.2")).toContain("/mainnet/");
  });
});

describe("the mainnet secret-key guard", () => {
  it("refuses to load on mainnet with the insecure dev default", async () => {
    // Real money, public signing key. The throw is deliberate: better a 500 on the paid route
    // than challenges anyone can forge. It fires at module load, so importing is the test.
    await expect(loadWith({ HEDERA_NETWORK: "mainnet" })).rejects.toThrow(/MPP_SECRET_KEY/);
  });

  it("loads on mainnet once a private key is set", async () => {
    const { HEDERA_NETWORK } = await loadWith({ HEDERA_NETWORK: "mainnet", MPP_SECRET_KEY: TEST_SECRET });
    expect(HEDERA_NETWORK).toBe("mainnet");
  });

  it("allows the dev default on testnet, so the template runs with no environment", async () => {
    const { HEDERA_NETWORK } = await loadWith({});
    expect(HEDERA_NETWORK).toBe("testnet");
  });
});
