import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DEX_IDS } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./types.js";

/**
 * FlowX Finance adapter.
 *
 * FlowX is a constant-product (xy=k) AMM on Sui similar to Uniswap V2.
 * Pool objects store reserve_x and reserve_y fields from which the spot
 * price is derived directly.
 *
 * Package: https://suiscan.xyz/mainnet/object/0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0
 */
export class FlowxAdapter implements DexAdapter {
  readonly id = DEX_IDS.FLOWX;
  readonly name = "FlowX";

  private static readonly PACKAGE =
    "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0";
  private static readonly CONTAINER =
    "0xd23f78c2decc5e6d7a1db51af9a7df27c91f8b4785a5285e9e2e4b0ce07c8534";

  private static readonly KNOWN_POOLS: PoolInfo[] = [
    {
      poolId:
        "0x8c9fa05e1055a52e4b0f67dd2e63c68d0be5c2e0b946e70791e4bcb72ab879a3",
      dexId: DEX_IDS.FLOWX,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      name: "SUI/USDC",
    },
    {
      poolId:
        "0x5a2cc5ecb2f3a5d55218e8d0e5a95d7a95b2a5de8e5dab8fae70dcd8e9aacfa3",
      dexId: DEX_IDS.FLOWX,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB:
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
      name: "SUI/USDT",
    },
  ];

  async fetchPools(_client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    logger.info(`[FlowX] Using ${FlowxAdapter.KNOWN_POOLS.length} known pools`);
    return [...FlowxAdapter.KNOWN_POOLS];
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
      throw new Error(`Cannot read FlowX pool ${pool.poolId}`);
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;
    const reserveA = BigInt(String(fields["reserve_x"] ?? fields["coin_a"] ?? "0"));
    const reserveB = BigInt(String(fields["reserve_y"] ?? fields["coin_b"] ?? "0"));

    if (reserveA === 0n || reserveB === 0n) {
      throw new Error(`FlowX pool ${pool.poolId} has zero reserves`);
    }

    const a2b = coinIn === pool.coinTypeA;
    const fee = 0.003; // 0.3% standard AMM fee

    // Constant product formula: amountOut = reserveOut * amountIn * (1-fee) / (reserveIn + amountIn * (1-fee))
    const amountInAfterFee = BigInt(Math.floor(Number(amountIn) * (1 - fee)));
    const reserveIn = a2b ? reserveA : reserveB;
    const reserveOut = a2b ? reserveB : reserveA;
    const amountOut =
      (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    const price = Number(reserveOut) / Number(reserveIn);

    logger.debug(
      `[FlowX] Quote pool=${pool.name} a2b=${a2b} in=${amountIn} out=${amountOut}`
    );

    return {
      pool,
      coinIn,
      coinOut: a2b ? pool.coinTypeB : pool.coinTypeA,
      amountIn,
      amountOut,
      price,
      fee,
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

    tx.moveCall({
      target: `${FlowxAdapter.PACKAGE}::router::swap_exact_input`,
      typeArguments: a2b
        ? [pool.coinTypeA, pool.coinTypeB]
        : [pool.coinTypeB, pool.coinTypeA],
      arguments: [
        tx.object(FlowxAdapter.CONTAINER),
        tx.pure.u64(amountIn),
        tx.pure.u64(minAmountOut),
        tx.pure.address(senderAddress),
        tx.pure.u64(BigInt(Date.now() + 60_000)), // deadline
      ],
    });

    logger.debug(
      `[FlowX] Built swap tx a2b=${a2b} amountIn=${amountIn} minOut=${minAmountOut}`
    );
  }
}
