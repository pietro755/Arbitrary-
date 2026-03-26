import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DexId } from "../config/index.js";

export interface PoolInfo {
  /** Unique pool object ID on Sui */
  poolId: string;
  /** DEX this pool belongs to */
  dexId: DexId;
  /** Coin type A */
  coinTypeA: string;
  /** Coin type B */
  coinTypeB: string;
  /** Human-readable name, e.g. "SUI/USDC" */
  name: string;
}

export interface QuoteResult {
  pool: PoolInfo;
  /** Input coin type */
  coinIn: string;
  /** Output coin type */
  coinOut: string;
  /** Amount of input (in base units) */
  amountIn: bigint;
  /** Estimated amount of output (in base units) */
  amountOut: bigint;
  /** Effective price: amountOut / amountIn (as a float) */
  price: number;
  /** Fee fraction, e.g. 0.003 for 0.3% */
  fee: number;
}

export interface DexAdapter {
  readonly id: DexId;
  readonly name: string;

  /**
   * Fetches all known pools from this DEX.
   */
  fetchPools(client: SuiJsonRpcClient): Promise<PoolInfo[]>;

  /**
   * Gets a swap quote: how much `coinOut` you receive for `amountIn` of `coinIn`.
   */
  getQuote(
    client: SuiJsonRpcClient,
    pool: PoolInfo,
    coinIn: string,
    amountIn: bigint
  ): Promise<QuoteResult>;

  /**
   * Builds a swap transaction for the given quote (with slippage applied).
   */
  buildSwapTx(
    tx: Transaction,
    pool: PoolInfo,
    coinIn: string,
    amountIn: bigint,
    minAmountOut: bigint,
    senderAddress: string
  ): Promise<void>;
}
