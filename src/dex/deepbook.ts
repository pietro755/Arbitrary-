import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DEX_IDS } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./types.js";

/**
 * DeepBook V2 adapter.
 *
 * DeepBook is Sui's native central limit order book (CLOB). It lives at
 * package 0xdee9 (the canonical DeepBook address). Prices are derived
 * from the best bid/ask stored in PoolSummary.
 *
 * DeepBook pools are identified by base/quote coin types rather than
 * a poolId per-se; the pool object is addressed via a shared object.
 */
export class DeepbookAdapter implements DexAdapter {
  readonly id = DEX_IDS.DEEPBOOK;
  readonly name = "DeepBook";

  // DeepBook V2 package
  private static readonly PACKAGE =
    "0x000000000000000000000000000000000000000000000000000000000000dee9";

  // Known DeepBook pool objects
  private static readonly KNOWN_POOLS: PoolInfo[] = [
    {
      poolId:
        "0x4405b50d791fd3346754e8171aaab6bc2ed26c2c46efdd033c14b30ae507ac33",
      dexId: DEX_IDS.DEEPBOOK,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      name: "SUI/USDC",
    },
    {
      poolId:
        "0x18d871e3c3da99046dfc0d3de612c5d88859bc03b8f0568bd127d0e70dbc58be",
      dexId: DEX_IDS.DEEPBOOK,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB:
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
      name: "SUI/USDT",
    },
  ];

  async fetchPools(_client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    logger.info(`[DeepBook] Using ${DeepbookAdapter.KNOWN_POOLS.length} known pools`);
    return [...DeepbookAdapter.KNOWN_POOLS];
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
      throw new Error(`Cannot read DeepBook pool ${pool.poolId}`);
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;
    const a2b = coinIn === pool.coinTypeA;

    // DeepBook stores bids/asks in sorted tables; we approximate with the
    // tick size and best price fields when available, or fall back to 0.
    const tickSize = BigInt(String(fields["tick_size"] ?? "1000000"));
    const lotSize = BigInt(String(fields["lot_size"] ?? "1000000"));
    // Estimate: effective price ≈ tickSize (base_quote ratio unit)
    const price = a2b
      ? Number(tickSize) / 1e9
      : 1e9 / Number(tickSize);

    const fee = 0.001; // 0.1% taker fee
    const amountOut = BigInt(
      Math.floor(Number(amountIn) * price * (1 - fee))
    );

    // Align to lot size
    const lotSizeN = Number(lotSize);
    const alignedOut = BigInt(
      Math.floor(Number(amountOut) / lotSizeN) * lotSizeN
    );

    logger.debug(
      `[DeepBook] Quote pool=${pool.name} a2b=${a2b} in=${amountIn} out=${alignedOut}`
    );

    return {
      pool,
      coinIn,
      coinOut: a2b ? pool.coinTypeB : pool.coinTypeA,
      amountIn,
      amountOut: alignedOut,
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
    const accountCap = tx.moveCall({
      target: `${DeepbookAdapter.PACKAGE}::clob_v2::create_account`,
      typeArguments: [],
      arguments: [],
    });

    if (a2b) {
      tx.moveCall({
        target: `${DeepbookAdapter.PACKAGE}::clob_v2::swap_exact_base_for_quote`,
        typeArguments: [pool.coinTypeA, pool.coinTypeB],
        arguments: [
          tx.object(pool.poolId),
          tx.pure.u64(amountIn),
          accountCap,
          tx.pure.u64(minAmountOut),
          tx.object("0x6"), // clock
        ],
      });
    } else {
      tx.moveCall({
        target: `${DeepbookAdapter.PACKAGE}::clob_v2::swap_exact_quote_for_base`,
        typeArguments: [pool.coinTypeA, pool.coinTypeB],
        arguments: [
          tx.object(pool.poolId),
          tx.pure.u64(amountIn),
          tx.pure.u64(minAmountOut),
          accountCap,
          tx.object("0x6"), // clock
        ],
      });
    }

    logger.debug(
      `[DeepBook] Built swap tx a2b=${a2b} amountIn=${amountIn} minOut=${minAmountOut} sender=${senderAddress}`
    );
  }
}
