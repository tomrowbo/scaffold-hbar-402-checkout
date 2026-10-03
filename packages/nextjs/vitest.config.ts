import { defineConfig } from "vitest/config";

/**
 * Unit tests for the pure logic — catalogue invariants, environment resolution, URL and
 * header shaping. Settlement itself is covered by `scripts/e2e-*.mjs`, which pay real
 * challenges on testnet and in Stripe; mocking a ledger would only test the mock.
 *
 * No jsdom: nothing here touches the DOM, and the browser halves of the two rails are driven
 * by a wallet rather than anything a unit test can stand in for.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
