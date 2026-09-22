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
 */
import { AccountId, TokenAssociateTransaction, TokenId, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import { operatorClient, resolvedNetwork } from "~~/lib/hederaOperator";
import { MIRROR_NODE_URL, USDC_DECIMALS, USDC_TOKEN_ID, canSettle } from "~~/lib/mppx";
import { products } from "~~/lib/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One top-up covers the priciest item, so a buyer never needs two rounds. */
function topUpBaseUnits(): number {
  const scale = 10 ** USDC_DECIMALS;
  const highest = products.reduce((max, product) => Math.max(max, Number(product.priceUsd)), 0);
  return Math.round(highest * scale);
}

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

type FundBody = { accountId?: string; associateTransaction?: string };

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

    if ((await usdcBalance(accountId)) >= BigInt(topUpBaseUnits())) {
      return Response.json({ funded: false, reason: "sufficient_balance", accountId, tokenId: USDC_TOKEN_ID });
    }

    const amount = topUpBaseUnits();
    const token = TokenId.fromString(USDC_TOKEN_ID);
    const transfer = await new TransferTransaction()
      .addTokenTransfer(token, AccountId.fromString(operatorId), -amount)
      .addTokenTransfer(token, AccountId.fromString(accountId), amount)
      .setTransactionMemo("mpp-checkout testnet buyer top-up")
      .execute(client);
    const receipt = await transfer.getReceipt(client);

    if (receipt.status.toString() !== "SUCCESS") {
      return Response.json({ error: "transfer_failed", detail: receipt.status.toString() }, { status: 502 });
    }

    return Response.json({ funded: true, accountId, tokenId: USDC_TOKEN_ID, amount: String(amount) });
  } catch (error) {
    return Response.json(
      { error: "fund_failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  } finally {
    client.close();
  }
}
