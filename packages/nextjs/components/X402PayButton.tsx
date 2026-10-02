"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
// SDK-free on purpose — see the note in HederaPayButton. `lib/x402Checkout` brings the
// whole @x402 client stack (viem, the Hedera signer) and loads on click instead.
import { CheckoutError, hasBurnerSigner } from "~~/lib/checkoutCommon";

type X402PayButtonProps = {
  productId: string;
  priceUsd: string;
  /** False when no facilitator is configured, so the 402 could not be settled. */
  enabled: boolean;
};

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string; hint?: string };

/**
 * Drives the 402 → partially signed transfer → retry loop for the x402 rail.
 *
 * The twin of {@link HederaPayButton}, minus the wallet path: x402's `exact` scheme on
 * Hedera needs signed-but-unsubmitted bytes, so only the burner key at
 * `localStorage['burnerWallet.pk']` can sign it from a page (see `lib/x402Checkout.ts`).
 */
export const X402PayButton = ({ productId, priceUsd, enabled }: X402PayButtonProps) => {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [burnerAvailable, setBurnerAvailable] = useState(false);
  const [host, setHost] = useState("");

  // localStorage is unavailable during SSR, so probe after mount to keep hydration stable.
  // The host comes from the same effect: naming it is what makes the message actionable,
  // because the key is stored per origin and `localhost` is not `127.0.0.1`.
  useEffect(() => {
    setBurnerAvailable(hasBurnerSigner());
    setHost(window.location.host);
  }, []);

  const pay = useCallback(async () => {
    setStatus({ kind: "working", message: "Requesting an x402 challenge…" });
    try {
      const { payWithX402 } = await import("~~/lib/x402Checkout");
      const order = await payWithX402({
        productId,
        onProgress: message => setStatus({ kind: "working", message }),
      });
      if (order.receiptUrl) {
        router.push(order.receiptUrl);
        return;
      }
      // Settled on chain, but the server lost track of the order behind it.
      setStatus({
        kind: "error",
        message: "The payment settled but the server could not build a receipt page for it.",
        hint: order.transactionId ? `Transaction ${order.transactionId}` : undefined,
      });
    } catch (error) {
      if (error instanceof CheckoutError) {
        setStatus({ kind: "error", message: error.message, hint: error.hint });
      } else {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [productId, router]);

  const working = status.kind === "working";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn btn-primary btn-sm w-full"
        disabled={!enabled || !burnerAvailable || working}
        onClick={pay}
        data-testid="pay-with-x402"
      >
        {working ? <span className="loading loading-spinner loading-xs" /> : null}
        Pay {priceUsd} USDC via x402
      </button>

      {/* Only rendered when the facilitator IS configured — `enabled` is `hasX402()`. An
          unconfigured facilitator shows the rail as `demo mode` instead, so this is never
          about the facilitator: it is the buyer having no signer in this browser. Nothing
          else is needed either; the facilitator sponsors the fees and `/api/testnet/fund`
          tops the buyer up during the payment. */}
      {enabled && !burnerAvailable && (
        <p className="text-xs text-base-content/60 m-0">
          No signing key for <code className="bg-base-300 px-1 py-0.5 rounded text-[11px]">{host}</code> — run{" "}
          <code className="bg-base-300 px-1 py-0.5 rounded text-[11px]">yarn make:burner</code> and paste its line on
          this page.
        </p>
      )}

      {status.kind === "working" && (
        <p className="text-xs text-base-content/70 m-0" role="status">
          {status.message}
        </p>
      )}

      {status.kind === "error" && (
        <div className="alert alert-error alert-soft text-xs py-2" role="alert">
          <div>
            <p className="m-0 font-medium">{status.message}</p>
            {status.hint && <p className="m-0 opacity-80">{status.hint}</p>}
          </div>
        </div>
      )}
    </div>
  );
};
