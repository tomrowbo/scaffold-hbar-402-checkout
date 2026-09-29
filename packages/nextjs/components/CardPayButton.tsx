import Link from "next/link";

type CardPayButtonProps = {
  productId: string;
  priceUsd: string;
  /** False when the Stripe variables are unset, so the card form has no publishable key. */
  enabled: boolean;
};

/**
 * Sends the buyer to the card form for this product.
 *
 * Unlike {@link HederaPayButton} and {@link X402PayButton} there is no client-side payment
 * loop to run: mppx renders a Stripe Elements form for `Accept: text/html` straight off the
 * same `/api/pay` challenge, collects the card, mints a Shared Payment Token through
 * `/api/pay/token` and replays the request with it. So this is a plain link to the endpoint —
 * the whole card rail lives server-side, which is the point of doing it over MPP.
 */
export const CardPayButton = ({ productId, priceUsd, enabled }: CardPayButtonProps) => {
  if (!enabled) {
    return (
      <button type="button" className="btn btn-primary btn-sm w-full" disabled>
        Pay ${priceUsd} by card
      </button>
    );
  }

  return (
    <Link
      href={`/api/pay?product=${encodeURIComponent(productId)}`}
      className="btn btn-primary btn-sm w-full"
      data-testid="pay-with-card"
    >
      Pay ${priceUsd} by card
    </Link>
  );
};
