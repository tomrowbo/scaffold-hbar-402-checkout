/**
 * `mppx-hedera@0.2.2` ships JavaScript with source maps but no `.d.ts` files, so
 * TypeScript cannot resolve its subpaths. These ambient declarations cover only the
 * surface this storefront uses — the charge intent, the attribution memo helpers and
 * the constants — and are deliberately narrow so an upgrade that changes the shape
 * fails loudly instead of silently type-checking.
 */

declare module "mppx-hedera/server" {
  import type { Method, Store } from "mppx";

  /** Server-side options for the charge intent (`HederaChargeServerOptions`). */
  export type HederaChargeServerOptions = {
    /** Server identity fingerprinted into the attribution memo. Must equal the challenge realm. */
    serverId: string;
    /** Default recipient. Rejected by mppx 0.10's request schema — pass `recipient` to the charge call instead. */
    recipient?: string;
    /** Testnet (chainId 296) when true, mainnet (295) otherwise. */
    testnet?: boolean;
    mirrorNodeUrl?: string;
    store?: Store.Store;
    /** Mirror Node poll attempts before giving up. */
    maxRetries?: number;
    /** Delay between Mirror Node polls, in milliseconds. */
    retryDelay?: number;
    /** Only needed for pull mode, where the server submits the buyer's signed transaction. */
    operatorId?: string;
    operatorKey?: string;
  };

  export const hedera: {
    charge(options: HederaChargeServerOptions): Method.AnyServer;
    session(options: Record<string, unknown>): Method.AnyServer;
  };
}

declare module "mppx-hedera" {
  /** 32-byte MPP attribution memo that binds a transfer to one challenge. */
  export namespace Attribution {
    /** Returns the memo as a `0x`-prefixed hex string. */
    function encode(params: { challengeId: string; serverId: string; clientId?: string }): string;
    function decode(memo: string): { version: number; serverId: string; clientId: string; nonce: string };
    function isMppMemo(memo: string): boolean;
    function verifyServer(memo: string, serverId: string): boolean;
    function verifyChallengeBinding(memo: string, challengeId: string): boolean;
  }

  export const USDC_DECIMALS: number;
  /** EVM alias of a testnet USDC, not the native `0.0.x` token id a charge intent uses. */
  export const USDC_TESTNET: string;
  /** EVM alias of mainnet USDC (`0x…6f89a`), not the `0.0.456858` native token id. */
  export const USDC_MAINNET: string;
}
