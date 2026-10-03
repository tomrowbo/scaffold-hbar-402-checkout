/**
 * The order store and the one classification the receipt page depends on.
 */
import type { SettledOrder } from "./orders";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  // The store hangs off globalThis to survive Next.js module reloads in dev, so a reset alone
  // does not clear it — the key has to go too.
  delete (globalThis as Record<string, unknown>).__mppCheckoutOrders;
  vi.resetModules();
  return import("./orders");
}

describe("isOnChain", () => {
  it("is true for both Hedera protocols, not just the native one", async () => {
    // The receipt renders a HashScan link for on-chain orders. x402 settles an HTS transfer
    // exactly as the MPP rail does, so treating only "hedera" as on-chain hid the link on
    // half the orders that had one.
    const { isOnChain } = await freshStore();
    expect(isOnChain("hedera")).toBe(true);
    expect(isOnChain("x402")).toBe(true);
  });

  it("is false for cards, which have no transaction to link", async () => {
    const { isOnChain } = await freshStore();
    expect(isOnChain("stripe")).toBe(false);
  });
});

describe("recordOrder and findOrder", () => {
  // Shaped from the real MPP settlement recorded on testnet, so the fixture cannot drift into
  // something the route would never produce.
  const order: SettledOrder = {
    id: "challenge-abc",
    method: "hedera",
    productId: "hashgraph-mug",
    amountUsd: "0.50",
    amountBaseUnits: "500000",
    tokenId: "0.0.429274",
    recipient: "0.0.8569027",
    transactionId: "0.0.10827845@1790966342.370842370",
    hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.10827845@1790966342.370842370",
    payer: "did:pkh:hedera:testnet:0.0.10827845",
    settledAt: "2026-10-02T19:00:00.000Z",
  };

  beforeEach(async () => {
    await freshStore();
  });

  it("round-trips an order by id", async () => {
    const { recordOrder, findOrder } = await freshStore();
    recordOrder(order);
    expect(findOrder("challenge-abc")).toEqual(order);
  });

  it("returns undefined for an unknown id so the receipt route can 404", async () => {
    const { findOrder } = await freshStore();
    expect(findOrder("never-recorded")).toBeUndefined();
  });

  it("keeps orders across a module reload, as dev edits require", async () => {
    const first = await freshStore();
    first.recordOrder(order);
    // Re-import without clearing the global: this is what a Next.js dev-server edit does.
    vi.resetModules();
    const second = await import("./orders");
    expect(second.findOrder("challenge-abc")).toEqual(order);
  });
});
