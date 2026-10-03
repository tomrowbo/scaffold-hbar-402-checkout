/**
 * Catalogue invariants. Every one of these corresponds to a way the store broke during
 * development, which is the only reason to assert something about four hard-coded objects.
 */
import { findProduct, products } from "./products";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Stripe rejects a USD PaymentIntent under 50 cents. The card rail advertises `priceUsd`
 * verbatim as a USD amount, so a cheaper item would 402 forever on that rail alone while
 * both Hedera rails kept working — a failure that only shows up when you try to pay by card.
 */
const STRIPE_MINIMUM_USD = 0.5;

describe("catalogue", () => {
  it("is not empty", () => {
    expect(products.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = products.map(product => product.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(products)("$id is priced at or above Stripe's floor", product => {
    expect(Number(product.priceUsd)).toBeGreaterThanOrEqual(STRIPE_MINIMUM_USD);
  });

  it.each(products)("$id has a price mppx can scale to USDC's 6 decimals", product => {
    // mppx multiplies the decimal string by 10^decimals. More than six decimal places would
    // truncate silently, so the challenge would advertise an amount nobody charged.
    expect(product.priceUsd).toMatch(/^\d+\.\d{1,6}$/);
  });

  it.each(products)("$id ships the image it references", product => {
    // `next/image` with `unoptimized` serves these straight from `public/`, so a typo here is
    // a broken image in the storefront rather than a build error.
    expect(product.image.startsWith("/")).toBe(true);
    expect(existsSync(join(process.cwd(), "public", product.image))).toBe(true);
  });
});

describe("findProduct", () => {
  it("finds every catalogue id", () => {
    for (const product of products) expect(findProduct(product.id)).toBe(product);
  });

  it("returns undefined for an unknown id rather than a default product", () => {
    // The pay routes branch on undefined to 404. Returning products[0] instead would charge
    // for the wrong item.
    expect(findProduct("no-such-product")).toBeUndefined();
    expect(findProduct("")).toBeUndefined();
  });
});
