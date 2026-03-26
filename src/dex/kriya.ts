import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DEX_IDS } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./types.js";

/**
 * Kriya DEX adapter.
 *
 * Kriya is a constant-product AMM on Sui with a 0.3% fee.
 * Pool objects store token_x and token_y reserve fields.
 *
 * Package: https://suiscan.xyz/mainnet/object/0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66
 */
export class KriyaAdapter implements DexAdapter {
  readonly id = DEX_IDS.KRIYA;
  readonly name = "Kriya";

  private static readonly PACKAGE =
    "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66";

  private static readonly KNOWN_POOLS: PoolInfo[] = [
    {
      poolId:
        "0x5af4976b871fa1813362f352fa4cada3883a96191dc2fe84de4f929c64a30dd1",
      dexId: DEX_IDS.KRIYA,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      name: "SUI/USDC",
    },
    {
      poolId:
        "0x6e4a8d53a7bf9ac94f4b671f1e86abd4f5d2ec5b1cbf60ef3d87a6d4cb8a6fa2",
      dexId: DEX_IDS.KRIYA,
      coinTypeA:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      coinTypeB:
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
      name: "USDC/USDT",
    },
  ];

  async fetchPools(_client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    logger.info(`[Kriya] Using ${KriyaAdapter.KNOWN_POOLS.length} known pools`);
    return [...KriyaAdapter.KNOWN_POOLS];
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
      throw new Error(`Cannot read Kriya pool ${pool.poolId}`);
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;
    const reserveA = BigInt(String(fields["token_x"] ?? "0"));
    const reserveB = BigInt(String(fields["token_y"] ?? "0"));

    if (reserveA === 0n || reserveB === 0n) {
      throw new Error(`Kriya pool ${pool.poolId} has zero reserves`);
    }

    const a2b = coinIn === pool.coinTypeA;
    const fee = 0.003;

    const amountInAfterFee = BigInt(Math.floor(Number(amountIn) * (1 - fee)));
    const reserveIn = a2b ? reserveA : reserveB;
    const reserveOut = a2b ? reserveB : reserveA;
    const amountOut =
      (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    const price = Number(reserveOut) / Number(reserveIn);

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
      target: `${KriyaAdapter.PACKAGE}::spot_dex::swap_token_x`,
      typeArguments: a2b
        ? [pool.coinTypeA, pool.coinTypeB]
        : [pool.coinTypeB, pool.coinTypeA],
      arguments: [
        tx.object(pool.poolId),
        tx.pure.u64(amountIn),
        tx.pure.u64(minAmountOut),
        tx.pure.address(senderAddress),
      ],
    });

    logger.debug(
      `[Kriya] Built swap tx a2b=${a2b} amountIn=${amountIn} minOut=${minAmountOut}`
    );
  }
}
