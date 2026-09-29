/**
 * Testnet convenience: top a buyer up with USDC from the operator account.
 *
 * On-chain validation funds a fresh test signer with HBAR only, and a Hedera account must
 * associate an HTS token before it can hold it — so without this a USDC charge has nothing
 * to spend. Testnet only, and inert unless the server holds operator credentials. It is a
 * development aid, not part of the payment protocol: no real value moves and nothing here
 * runs on mainnet.
 *
 * The network check is the first thing the handler does and reads `resolvedNetwork()`
 * directly. This route transfers operator USDC to any posted account id, so on mainnet it
 * would be an unauthenticated drain — no configuration may turn it on there.
 *
 * It is not, however, the first thing that runs: importing `~~/lib/mppx` below evaluates that
 * module's `MPP_SECRET_KEY` guard, so on mainnet with no secret key the request fails with a
 * 500 before this handler is entered. Both outcomes refuse; only the 403 is this route's.
 */
import { AccountId, TokenAssociateTransaction, TokenId, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import { operatorClient, resolvedNetwork } from "~~/lib/hederaOperator";
import { MIRROR_NODE_URL, USDC_DECIMALS, USDC_TOKEN_ID, canSettle } from "~~/lib/mppx";
import { findProduct, products } from "~~/lib/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USDC_SCALE = 10 ** USDC_DECIMALS;

/** Decimal string for an amount in USDC base units, e.g. `12000000` → `12.000000`. */
function formatUsdc(baseUnits: bigint | number): string {
  return (Number(baseUnits) / USDC_SCALE).toFixed(USDC_DECIMALS);
}

function toBaseUnits(priceUsd: string): number {
  return Math.round(Number(priceUsd) * USDC_SCALE);
}

/**
 * Ceiling on a single top-up: the priciest item in the catalogue. The caller says what the
 * buyer is about to spend (`amount` or `product`); this only bounds what an arbitrary caller
 * can ask the operator to part with, which is the same exposure this route has always had.
 */
function catalogueMaxBaseUnits(): number {
  return toBaseUnits(String(products.reduce((max, product) => Math.max(max, Number(product.priceUsd)), 0)));
}

/**
 * Where a developer actually gets testnet `0.0.5449`. There is no faucet for it:
 * `faucet.circle.com` hands out `0.0.429274`, a different testnet USDC that `mppx-hedera`
 * pins neither in its challenge nor in its Mirror Node check, so charges against it cannot
 * be verified here. Swapping portal HBAR on SaucerSwap's testnet deployment is the one
 * self-service route that yields this exact token. Kept in one place so this route, the
 * browser panel and the README cannot drift apart.
 */
const FUNDING_HELP =
  `Get testnet HBAR from https://portal.hedera.com/faucet and swap it for token ${USDC_TOKEN_ID} on ` +
  `https://testnet.saucerswap.finance (the USDC/HBAR pool). Circle's faucet at https://faucet.circle.com ` +
  `dispenses 0.0.429274 instead, a different testnet USDC this template cannot verify.`;

/**
 * Current USDC balance per the Mirror Node. Indexing lags consensus, so a fresh top-up may
 * still read as zero — that only risks funding a buyer twice on testnet, never under-funding.
 */
async function usdcBalance(accountId: string): Promise<bigint> {
  const response = await fetch(
    `${MIRROR_NODE_URL}/api/v1/accounts/${accountId}/tokens?token.id=${USDC_TOKEN_ID}&limit=1`,
  );
  if (!response.ok) return 0n;
  const body = (await response.json()) as { tokens?: { balance: number }[] };
  return BigInt(body.tokens?.[0]?.balance ?? 0);
}

type FundBody = {
  accountId?: string;
  /** USDC base units the buyer is about to spend, as a decimal string (`"12000000"`). */
  amount?: string;
  /** Catalogue id, as an alternative to `amount` — the route prices it. */
  product?: string;
  associateTransaction?: string;
};

type Requested = { baseUnits: number } | { error: Response };

/**
 * How much the buyer needs to end up holding.
 *
 * `amount` wins, then `product`. With neither, fall back to the priciest item — the only
 * safe answer when the caller has not said what is being bought. Both in-tree callers
 * (`lib/hederaBuyer.ts` and `scripts/e2e-charge.mjs`) pass the charge amount, so that
 * fallback is reached only by a hand-written request.
 */
function requestedBaseUnits(body: FundBody): Requested {
  const max = catalogueMaxBaseUnits();

  if (body.amount !== undefined) {
    if (!/^\d+$/.test(body.amount.trim())) {
      return {
        error: Response.json(
          { error: "invalid_amount", detail: `Expected USDC base units as digits, got "${body.amount}".` },
          { status: 400 },
        ),
      };
    }
    const baseUnits = Number(body.amount.trim());
    if (baseUnits <= 0 || baseUnits > max) {
      return {
        error: Response.json(
          {
            error: "invalid_amount",
            detail:
              `Requested ${formatUsdc(baseUnits)} USDC. A single top-up is capped at ` +
              `${formatUsdc(max)} — the priciest item in the catalogue.`,
          },
          { status: 400 },
        ),
      };
    }
    return { baseUnits };
  }

  if (body.product !== undefined) {
    const product = findProduct(body.product.trim());
    if (!product) {
      return {
        error: Response.json(
          { error: "unknown_product", detail: `No catalogue item with id "${body.product}".` },
          { status: 400 },
        ),
      };
    }
    return { baseUnits: toBaseUnits(product.priceUsd) };
  }

  return { baseUnits: max };
}

/** True for the receipt status a transfer gets when the operator's own USDC has run out. */
function isInsufficientTokenBalance(error: unknown): boolean {
  const status = (error as { status?: { toString(): string } } | null)?.status;
  const text = status ? status.toString() : error instanceof Error ? error.message : String(error);
  return text.includes("INSUFFICIENT_TOKEN_BALANCE");
}

/**
 * The operator is out of USDC. Name the balance, the shortfall and where more comes from —
 * the same standard `demo_mode`, `self_funding` and `faucet_disabled` already meet, and the
 * one failure a developer following the walkthrough is most likely to hit.
 */
async function operatorUnderfunded(operatorId: string, needed: number): Promise<Response> {
  const held = await usdcBalance(operatorId).catch(() => null);
  const balance = held === null ? "an unreadable balance of" : formatUsdc(held);
  return Response.json(
    {
      error: "operator_underfunded",
      detail:
        `Operator ${operatorId} holds ${balance} USDC (token ${USDC_TOKEN_ID}) on testnet, ` +
        `which is not enough to send the buyer the ${formatUsdc(needed)} this top-up needs. ` +
        `${FUNDING_HELP} ` +
        `If the operator can cover the item being bought but not this top-up, post "product" ` +
        `or "amount" so the faucet moves only what that purchase costs.`,
    },
    { status: 502 },
  );
}

export async function POST(request: Request): Promise<Response> {
  let network: string;
  try {
    network = resolvedNetwork();
  } catch {
    network = "invalid";
  }
  if (network !== "testnet") {
    return Response.json(
      { error: "faucet_disabled", detail: "The test-buyer faucet only runs on Hedera testnet." },
      { status: 403 },
    );
  }

  if (!canSettle()) {
    return Response.json(
      { error: "demo_mode", detail: "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY to fund a test buyer." },
      { status: 503 },
    );
  }

  let body: FundBody;
  try {
    body = (await request.json()) as FundBody;
  } catch {
    return Response.json({ error: "invalid_body", detail: "Expected a JSON object." }, { status: 400 });
  }

  const accountId = body.accountId?.trim();
  if (!accountId || !/^\d+\.\d+\.\d+$/.test(accountId)) {
    return Response.json(
      { error: "invalid_account", detail: "Expected an account id like 0.0.12345." },
      { status: 400 },
    );
  }

  const requested = requestedBaseUnits(body);
  if ("error" in requested) return requested.error;
  const needed = requested.baseUnits;

  const { client, accountId: operatorId } = operatorClient();
  try {
    if (accountId === operatorId) {
      return Response.json(
        { error: "self_funding", detail: "The buyer is the operator account; nothing to fund." },
        { status: 400 },
      );
    }

    if (body.associateTransaction) {
      // Relay the buyer's own signed association only. Anything else would make this a
      // general-purpose transaction relay signed off by the operator.
      const signed = Transaction.fromBytes(Buffer.from(body.associateTransaction, "base64"));
      if (!(signed instanceof TokenAssociateTransaction)) {
        return Response.json(
          { error: "unsupported_transaction", detail: "Only a TokenAssociateTransaction may be relayed." },
          { status: 400 },
        );
      }
      const associateReceipt = await (await signed.execute(client)).getReceipt(client);
      const status = associateReceipt.status.toString();
      // Re-running checkout after a successful purchase hits an already-associated account.
      if (status !== "SUCCESS" && status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
        return Response.json({ error: "association_failed", detail: status }, { status: 502 });
      }
    }

    const held = await usdcBalance(accountId);
    if (held >= BigInt(needed)) {
      return Response.json({
        funded: false,
        reason: "sufficient_balance",
        accountId,
        tokenId: USDC_TOKEN_ID,
        needed: String(needed),
      });
    }

    // Send the shortfall, not the whole target: the operator's testnet USDC is scarce and
    // hard to replace, and a buyer holding some already only needs the rest.
    const amount = needed - Number(held);
    const token = TokenId.fromString(USDC_TOKEN_ID);
    const transfer = await new TransferTransaction()
      .addTokenTransfer(token, AccountId.fromString(operatorId), -amount)
      .addTokenTransfer(token, AccountId.fromString(accountId), amount)
      .setTransactionMemo("402-checkout testnet buyer top-up")
      .execute(client);
    const receipt = await transfer.getReceipt(client);

    if (receipt.status.toString() !== "SUCCESS") {
      if (isInsufficientTokenBalance(receipt.status)) return operatorUnderfunded(operatorId, amount);
      return Response.json({ error: "transfer_failed", detail: receipt.status.toString() }, { status: 502 });
    }

    return Response.json({
      funded: true,
      accountId,
      tokenId: USDC_TOKEN_ID,
      amount: String(amount),
      needed: String(needed),
    });
  } catch (error) {
    // `getReceipt` throws on a failing receipt, so the operator running dry arrives here
    // rather than at the status check above.
    if (isInsufficientTokenBalance(error)) return operatorUnderfunded(operatorId, needed);
    return Response.json(
      { error: "fund_failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  } finally {
    client.close();
  }
}
