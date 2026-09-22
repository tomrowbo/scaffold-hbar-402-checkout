/**
 * Per-integration credential detection.
 *
 * The storefront must run with an empty environment: clone, install, `yarn next:dev`,
 * working store. Each payment rail switches itself on independently, so a developer
 * holding only Stripe keys gets a live card path and demo stubs everywhere else.
 * Never gate the whole app on a single variable.
 *
 * These read server-only variables (no `NEXT_PUBLIC_` prefix), so call them from
 * server components or route handlers and pass the resulting booleans down.
 */

const isSet = (value: string | undefined): boolean => Boolean(value && value.trim());

/** Native Hedera rail: operator account able to sign and submit transactions. */
export function hasHedera(): boolean {
  return isSet(process.env.HEDERA_OPERATOR_ID) && isSet(process.env.HEDERA_OPERATOR_KEY);
}

/** Stripe card rail: secret + publishable keys and the Stripe network to settle on. */
export function hasStripe(): boolean {
  return (
    isSet(process.env.STRIPE_SECRET_KEY) &&
    isSet(process.env.STRIPE_PUBLISHABLE_KEY) &&
    isSet(process.env.STRIPE_NETWORK_ID)
  );
}

/** x402 rail: a facilitator endpoint to settle the 402 challenge against. */
export function hasX402(): boolean {
  return isSet(process.env.AX402_FACILITATOR_URL);
}
