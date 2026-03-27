import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DEX_IDS } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./types.js";

/**
 * Turbos Finance adapter.
 *
 * Turbos is a concentrated-liquidity AMM on Sui. Its pool objects store
 * a sqrt_price_x96 field (Uniswap V3-style, Q64.96 format).
 *
 * Package: https://suiscan.xyz/mainnet/object/0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1
 */
export class TurbosAdapter implements DexAdapter {
  readonly id = DEX_IDS.TURBOS;
  readonly name = "Turbos";

  private static readonly PACKAGE =
    "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1";
  private static readonly VERSIONED =
    "0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f";

  // Known high-liquidity Turbos pools (bootstrapped list)
  private static readonly KNOWN_POOLS: PoolInfo[] = [
    {
      poolId:
        "0x5eb2dfcdd1b15d2021328258f6d5ec081e9a0cdcfa9e13a0eaeb9b5f7505ca78",
      dexId: DEX_IDS.TURBOS,
      coinTypeA:
        "0x2::sui::SUI",
      coinTypeB:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      name: "SUI/USDC",
    },
    {
      poolId:
        "0x7f526b1263c4b91b43c9e646419b5696f424de28dda3c1e6658cc0a54558baa7",
      dexId: DEX_IDS.TURBOS,
      coinTypeA:
        "0x2::sui::SUI",
      coinTypeB:
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
      name: "SUI/USDT",
    },
  ];

  async fetchPools(_client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    // Return the known pools list; a production bot would additionally query
    // the Turbos PoolCreated events on-chain to discover new pools.
    logger.info(`[Turbos] Using ${TurbosAdapter.KNOWN_POOLS.length} known pools`);
    return [...TurbosAdapter.KNOWN_POOLS];
  }

  async getQuote(
    client: SuiJsonRpcClient,
    pool: PoolInfo,
    coinIn: string,
    amountIn: bigint
  ): Promise<QuoteResult> {
    const obj = await client.getObject({
      id: pool.poolId,
      options: { showContent: true },
    });

    const content = obj.data?.content;
    if (!content || content.dataType !== "moveObject") {
      throw new Error(`Cannot read Turbos pool ${pool.poolId}`);
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;

    // sqrt_price stored as Q64.96 (96 fractional bits)
    const sqrtPriceX96 = BigInt(String(fields["sqrt_price"] ?? "0"));
    if (sqrtPriceX96 === 0n) {
      throw new Error(`Turbos pool ${pool.poolId} has zero sqrt price`);
    }
    const Q96 = BigInt(2) ** BigInt(96);
    // price = (sqrtPriceX96 / 2^96)^2
    const priceFloat = Number(sqrtPriceX96) / Number(Q96);
    if (!Number.isFinite(priceFloat) || priceFloat <= 0) {
      throw new Error(`Turbos pool ${pool.poolId} has invalid sqrt price: ${sqrtPriceX96.toString()}`);
    }
    const priceB_per_A = priceFloat * priceFloat;
    if (!Number.isFinite(priceB_per_A) || priceB_per_A <= 0) {
      throw new Error(`Turbos pool ${pool.poolId} has invalid derived price: ${priceB_per_A}`);
    }

    const feeRate = Number(fields["fee"] ?? 3000) / 1_000_000;
    const a2b = coinIn === pool.coinTypeA;
    const spotPrice = a2b ? priceB_per_A : 1 / priceB_per_A;
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      throw new Error(`Turbos pool ${pool.poolId} has invalid spot price: ${spotPrice}`);
    }
    const rawAmountOut = Math.floor(Number(amountIn) * spotPrice * (1 - feeRate));
    if (!Number.isFinite(rawAmountOut) || rawAmountOut < 0) {
      throw new Error(`Turbos pool ${pool.poolId} computed invalid amountOut: ${rawAmountOut}`);
    }
    const amountOut = BigInt(rawAmountOut);

    return {
      pool,
      coinIn,
      coinOut: a2b ? pool.coinTypeB : pool.coinTypeA,
      amountIn,
      amountOut,
      price: spotPrice,
      fee: feeRate,
    };
  }

  async buildSwapTx(
    tx: Transaction,
    pool: PoolInfo,
    coinIn: string,
    amountIn: bigint,
    minAmountOut: bigint,
    senderAddress: string
  ): Promise<void> {
    const a2b = coinIn === pool.coinTypeA;
    const sqrtPriceLimit = a2b
      ? BigInt("4295048016") // MIN_SQRT_PRICE
      : BigInt("79226673515401279992447579055"); // MAX_SQRT_PRICE

    tx.moveCall({
      target: `${TurbosAdapter.PACKAGE}::swap_router::swap`,
      typeArguments: [pool.coinTypeA, pool.coinTypeB, `${TurbosAdapter.PACKAGE}::fee3000::FEE3000`],
      arguments: [
        tx.object(pool.poolId),
        tx.pure.u64(amountIn),
        tx.pure.u64(minAmountOut),
        tx.pure.bool(a2b),
        tx.pure.address(senderAddress),
        tx.pure.u128(sqrtPriceLimit),
        tx.pure.u64(BigInt(Date.now() + 60_000)), // deadline
        tx.object(TurbosAdapter.VERSIONED),
        tx.object("0x6"), // clock
      ],
    });

    logger.debug(
      `[Turbos] Built swap tx a2b=${a2b} amountIn=${amountIn} minOut=${minAmountOut}`
    );
  }
}
