/**
 * A `ClientHederaSigner` for `@x402/hedera` backed by a connected wallet.
 *
 * x402's `exact` scheme on Hedera is gasless for the buyer: the facilitator pays the HBAR
 * fee, and on Hedera the fee payer is named *inside* the transaction id, which has to be set
 * before freezing. So the buyer has to produce a transaction that is signed but **not
 * submitted** — the facilitator adds its own signature and broadcasts.
 *
 * `hedera_signAndExecuteTransaction` cannot do that: it submits, and the wallet ends up
 * paying the fee under its own transaction id. `hedera_signTransaction` can — it returns a
 * signed `Transaction` and broadcasts nothing. That is the whole difference, and it is why
 * this rail works from a wallet rather than needing a local key.
 *
 * The transaction built here is byte-identical in shape to the one `createClientHederaSigner`
 * builds from a raw private key, because the facilitator validates the shape before it will
 * settle: same transfer pair, same `TransactionId.generate(feePayer)`, same serialisation.
 */
import {
  AccountId,
  Client,
  Hbar,
  TokenId,
  type Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "@x402/core/types";

/** The slice of `HederaProvider` this needs — sign, and do not submit. */
export type WalletTransactionSigner = {
  hedera_signTransaction(params: { signerAccountId: string; transactionBody: Transaction }): Promise<Transaction>;
};

/** `hbar` rather than a token id means a native transfer; this template only charges tokens. */
function isHbarAsset(asset: string): boolean {
  return asset.trim().toLowerCase() === "hbar";
}

/**
 * @param accountId Buyer's Hedera account id (`0.0.x`), as the wallet reports it.
 * @param signerAccountId The CAIP-10 form the wallet expects for `signerAccountId`.
 */
export function createWalletHederaSigner(
  provider: WalletTransactionSigner,
  accountId: string,
  signerAccountId: string,
) {
  return {
    accountId,
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required in paymentRequirements.extra");
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("amount must be greater than zero");

      const payer = AccountId.fromString(accountId);
      const payTo = AccountId.fromString(requirements.payTo);
      const transaction = new TransferTransaction();
      if (isHbarAsset(requirements.asset)) {
        transaction.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        transaction.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const token = TokenId.fromString(requirements.asset);
        transaction.addTokenTransfer(token, payer, -amount);
        transaction.addTokenTransfer(token, payTo, amount);
      }
      // The facilitator sponsors the fee, so the transaction id must name *its* account.
      transaction.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      // Freezing needs a client only for its node list; nothing is submitted through it.
      const client = requirements.network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
      try {
        transaction.freezeWith(client);
      } finally {
        client.close();
      }

      const signed = await provider.hedera_signTransaction({ signerAccountId, transactionBody: transaction });
      const bytes = (signed as Transaction | undefined)?.toBytes?.();
      if (!bytes) {
        throw new Error("The wallet returned no signed transaction. It may not support hedera_signTransaction.");
      }
      return Buffer.from(bytes).toString("base64");
    },
  };
}
