/**
 * Browser half of the x402 rail: 402 → partially sign a USDC transfer → retry
 * with `PAYMENT-SIGNATURE`. Client-only, and the twin of `lib/hederaCheckout.ts` — same
 * buyer, same token, same merchant, the other protocol.
 *
 * Everything below `wrapFetchWithPayment` is the official `@x402` client stack, exactly as
 * `scripts/e2e-x402.mjs` drives it from Node. This module's own job is the three things that
 * stack does not do for you:
 *
 *  1. **Find the buyer.** x402's signer takes an account id and a key; the storefront has a
 *     key in `localStorage` and an EVM alias to resolve it from (see `lib/hederaBuyer.ts`).
 *  2. **Fund the buyer.** The offer is denominated in an HTS token a fresh test account has
 *     neither associated nor any balance of. Shared with the MPP rail.
 *  3. **Opt into the spend.** Two client-side controls reject this offer by default, and
 *     both are the buyer's policy rather than anything the server got wrong: `@x402/hedera`
 *     treats `0.0.429274` as the only testnet USDC while this store charges in `0.0.5449`,
 *     and `@x402/core` caps a single payment at $1. Allowing exactly the offered token at
 *     exactly the offered amount opts into this one purchase and nothing more.
 *
 * There is no connected-wallet path here, unlike the MPP rail. x402's `exact` scheme on
 * Hedera needs a *partially signed* transaction whose transaction id names the facilitator's
 * sponsored fee payer, and WalletConnect's Hedera methods sign-and-execute rather than
 * hand back signed bytes. A burner key is the only signer this rail can drive from a page.
 */
// Only the SDK-free half — the wallet signs, so nothing here needs @hiero-ledger/sdk and the
// buyer is never funded from the operator: they pay with what the wallet holds.
import { type ChargeProgress, CheckoutError } from "./checkoutCommon";
import { type WalletTransactionSigner, createWalletHederaSigner } from "./x402WalletSigner";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export class X402ChargeError extends CheckoutError {}

/** The `/api/x402` resource body, once it has been paid for. */
export type X402Success = {
  /** Null only if the server settled the payment but could not record an order for it. */
  orderId: string | null;
  receiptUrl: string | null;
  transactionId: string | null;
  hashscanUrl: string | null;
};

export type PayWithX402Options = {
  productId: string;
  onProgress?: ChargeProgress;
  /** The connected wallet. x402 needs a signer that does not submit — see x402WalletSigner. */
  wallet: { provider: WalletTransactionSigner; accountId: string; signerAccountId: string };
};

export async function payWithX402({ productId, wallet, onProgress }: PayWithX402Options): Promise<X402Success> {
  const endpoint = `/api/x402?product=${encodeURIComponent(productId)}`;

  onProgress?.("Requesting an x402 challenge…");
  const challengeResponse = await fetch(endpoint, { headers: { Accept: "application/json" } });

  if (challengeResponse.status !== 402) {
    throw new X402ChargeError(`Expected a 402 challenge, got HTTP ${challengeResponse.status}.`);
  }
  if (challengeResponse.headers.get("X-MPP-Demo-Mode")?.split(",").includes("x402")) {
    throw new X402ChargeError(
      "This challenge was issued in demo mode, so no facilitator can settle it.",
      "Set AX402_FACILITATOR_URL to a facilitator that lists `exact` on hedera:testnet.",
    );
  }

  // A v2 client reads the declaration from the header, never the body.
  const header = challengeResponse.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    throw new X402ChargeError("The x402 endpoint sent no PAYMENT-REQUIRED header, so there is nothing to pay.");
  }
  const offer = decodePaymentRequiredHeader(header).accepts[0] as PaymentRequirements | undefined;
  if (!offer) throw new X402ChargeError("The x402 challenge advertised no payment requirements.");

  const payer = wallet.accountId;
  if (payer === offer.payTo) {
    throw new X402ChargeError(
      `Buyer and merchant are the same account (${payer}).`,
      "Set HEDERA_RECIPIENT_ID to a merchant account distinct from the buyer.",
    );
  }

  const client = new x402Client();
  client.register(
    "hedera:*",
    new ExactHederaScheme(createWalletHederaSigner(wallet.provider, payer, wallet.signerAccountId)),
  );
  // The buyer's own spend controls, not something the server asked for. @x402/core caps a
  // single payment at $1 by default, and the catalogue goes above that, so the cap has to be
  // raised to take this offer. Scoping it to exactly the offered asset and amount opts into
  // this one purchase and nothing wider.
  //
  // Until the store moved to @x402/hedera's own default testnet token (0.0.429274) the
  // `allowedAssets` entry was also load-bearing: the client refused any other asset outright.
  client.setSpendControls({
    allowedAssets: [{ network: offer.network, asset: offer.asset, maxAmountPerPayment: offer.amount }],
  });
  // `fetch` must stay bound to the window, or the browser rejects the detached call.
  const payFetch = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), client);

  // Matches the Hedera rail's wording, because from here the buyer does the same thing on
  // both: approve a prompt in their wallet. The facilitator's part comes after, and saying so
  // up front described the plumbing rather than what the buyer has to do next.
  onProgress?.("Waiting for the wallet to sign the transfer…");
  const paidResponse = await payFetch(endpoint, { headers: { Accept: "application/json" } });
  onProgress?.("Settling through the facilitator…");

  if (paidResponse.status !== 200) {
    const detail = await paidResponse.text();
    throw new X402ChargeError(
      `The facilitator did not settle the payment (HTTP ${paidResponse.status}).`,
      detail.slice(0, 300),
    );
  }

  return (await paidResponse.json()) as X402Success;
}
