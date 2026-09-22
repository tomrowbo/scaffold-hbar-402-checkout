"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Transaction } from "@hiero-ledger/sdk";
import { useHederaSigner } from "~~/hooks/useHederaSigner";
import { HederaChargeError, hasBurnerSigner, payWithHedera } from "~~/lib/hederaCheckout";
import { hederaCaipId } from "~~/utils/scaffold-hbar/hederaIdentity";
import { transactionToBase64String } from "~~/utils/scaffold-hbar/hederaTxUtils";

type HederaPayButtonProps = {
  productId: string;
  priceUsd: string;
  /** False when the server has no merchant account, so settlement would have nothing to verify. */
  enabled: boolean;
};

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string; hint?: string };

/**
 * Drives the 402 → transfer → retry loop for the native Hedera rail.
 *
 * Signs with a connected wallet when there is one, and otherwise with the burner key
 * on-chain validation injects at `localStorage['burnerWallet.pk']`.
 */
export const HederaPayButton = ({ productId, priceUsd, enabled }: HederaPayButtonProps) => {
  const router = useRouter();
  const { provider, accountId } = useHederaSigner();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [burnerAvailable, setBurnerAvailable] = useState(false);

  // localStorage is unavailable during SSR, so probe after mount to keep hydration stable.
  useEffect(() => setBurnerAvailable(hasBurnerSigner()), []);

  const pay = useCallback(async () => {
    setStatus({ kind: "working", message: "Requesting a payment challenge…" });
    try {
      const wallet =
        provider && accountId
          ? {
              accountId,
              execute: async (transaction: Transaction) => {
                const result = await provider.hedera_signAndExecuteTransaction({
                  signerAccountId: hederaCaipId(accountId),
                  transactionList: transactionToBase64String(transaction),
                });
                if (!result?.transactionId) throw new Error("The wallet returned no transaction id");
                return result.transactionId;
              },
            }
          : undefined;

      const order = await payWithHedera({
        productId,
        wallet,
        onProgress: message => setStatus({ kind: "working", message }),
      });
      if (order.receiptUrl) {
        router.push(order.receiptUrl);
        return;
      }
      // Paid and receipted, but the server lost track of the order behind it.
      setStatus({
        kind: "error",
        message: "The payment settled but the server could not build a receipt page for it.",
        hint: order.transactionId ? `Transaction ${order.transactionId}` : undefined,
      });
    } catch (error) {
      if (error instanceof HederaChargeError) {
        setStatus({ kind: "error", message: error.message, hint: error.hint });
      } else {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [accountId, productId, provider, router]);

  const hasSigner = Boolean(accountId) || burnerAvailable;
  const working = status.kind === "working";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn btn-primary btn-sm w-full"
        disabled={!enabled || !hasSigner || working}
        onClick={pay}
        data-testid="pay-with-hedera"
      >
        {working ? <span className="loading loading-spinner loading-xs" /> : null}
        Pay {priceUsd} USDC on Hedera
      </button>

      {enabled && !hasSigner && (
        <p className="text-xs text-base-content/60 m-0">Connect a Hedera wallet to pay with USDC.</p>
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
