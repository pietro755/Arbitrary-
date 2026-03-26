import { SuiJsonRpcClient, DynamicFieldPage } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { DEX_IDS } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./types.js";

/**
 * Cetus Protocol adapter.
 *
 * Cetus is the leading concentrated-liquidity DEX on Sui.
 * Package: 0x1eabed72c53feb3805120a081dc15963c204dc8d0173814288a239a0690f...
 * (abbreviated - see https://cetus-1.gitbook.io/cetus-developer-docs)
 *
 * This adapter uses the Cetus on-chain Clmm pools. Prices are derived from
 * the current_sqrt_price stored in each pool object.
 */
export class CetusAdapter implements DexAdapter {
  readonly id = DEX_IDS.CETUS;
  readonly name = "Cetus";

  // Cetus Clmm package on mainnet
  private static readonly PACKAGE =
    "0x1eabed72c53feb3805120a081dc15963c204dc8d0173814288a239a0690f3f8c";
  // GlobalConfig object
  private static readonly GLOBAL_CONFIG =
    "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8";

  async fetchPools(client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    // Query dynamic fields of the Cetus pool registry to enumerate pools.
    // The registry stores all created pools as dynamic object fields.
    const registryId =
      "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0";

    const pools: PoolInfo[] = [];
    let cursor: string | null | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const page: DynamicFieldPage = await client.getDynamicFields({
        parentId: registryId,
        cursor,
        limit: 50,
      });

      for (const field of page.data) {
        try {
          const obj = await client.getObject({
            id: field.objectId,
            options: { showContent: true },
          });
          const content = obj.data?.content;
          if (!content || content.dataType !== "moveObject") continue;

          // Coin types are Move type parameters — they live in the object's
          // type string (e.g. "...::pool::Pool<CoinA, CoinB>"), not as plain
          // struct fields.  Extract them from the type string and normalise
          // the address prefix so they match the canonical short forms used
          // throughout the rest of the bot (e.g. "0x2::sui::SUI").
          const moveType = (content as { type: string }).type ?? "";
          const ltIdx = moveType.indexOf("<");
          const gtIdx = moveType.lastIndexOf(">");
          if (ltIdx < 0 || gtIdx < 0) continue;

          const typeArgs = this.splitTypeArgs(moveType.slice(ltIdx + 1, gtIdx));
          if (typeArgs.length < 2) continue;

          const coinTypeA = this.normalizeAddress(typeArgs[0]);
          const coinTypeB = this.normalizeAddress(typeArgs[1]);
          if (!coinTypeA || !coinTypeB) continue;

          pools.push({
            poolId: field.objectId,
            dexId: this.id,
            coinTypeA,
            coinTypeB,
            name: `${this.shortName(coinTypeA)}/${this.shortName(coinTypeB)}`,
          });
        } catch {
          // Skip unparseable pool objects
        }
      }

      if (page.hasNextPage && page.nextCursor) {
        cursor = page.nextCursor;
      } else {
        hasMore = false;
      }
    }

    logger.info(`[Cetus] Fetched ${pools.length} pools`);
    return pools;
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
      throw new Error(`Cannot read Cetus pool ${pool.poolId}`);
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;
    const sqrtPrice = BigInt(String(fields["current_sqrt_price"] ?? "0"));
    const feeRate = Number(fields["fee_rate"] ?? 3000) / 1_000_000;

    // Derive spot price from sqrt_price (Q64.64 fixed-point)
    // price = (sqrt_price / 2^64)^2  =>  coinB per coinA
    const Q64 = BigInt("18446744073709551616"); // 2^64
    const priceB_per_A =
      Number((sqrtPrice * sqrtPrice) / Q64) / Number(Q64);

    const a2b = coinIn === pool.coinTypeA;
    const spotPrice = a2b ? priceB_per_A : 1 / priceB_per_A;
    const amountOut = BigInt(
      Math.floor(Number(amountIn) * spotPrice * (1 - feeRate))
    );

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

    // Cetus swap_with_partner or flash_swap entry point
    tx.moveCall({
      target: `${CetusAdapter.PACKAGE}::pool_script::swap`,
      typeArguments: [pool.coinTypeA, pool.coinTypeB],
      arguments: [
        tx.object(CetusAdapter.GLOBAL_CONFIG),
        tx.object(pool.poolId),
        tx.pure.bool(a2b),
        tx.pure.bool(true), // by_amount_in
        tx.pure.u64(amountIn),
        tx.pure.u128(0), // sqrt_price_limit (0 = no limit)
        tx.pure.bool(false), // is_partner
        tx.object("0x6"), // clock
      ],
    });

    logger.debug(
      `[Cetus] Built swap tx: ${this.shortName(coinIn)} → ${this.shortName(
        a2b ? pool.coinTypeB : pool.coinTypeA
      )}, amountIn=${amountIn}, minOut=${minAmountOut}, sender=${senderAddress}`
    );
  }

  /**
   * Split a comma-separated list of Move type arguments, correctly handling
   * nested generic types (e.g. "Coin<X>, Balance<Y, Z>").
   */
  private splitTypeArgs(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "<") depth++;
      else if (s[i] === ">") depth--;
      else if (s[i] === "," && depth === 0) {
        parts.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(s.slice(start).trim());
    return parts;
  }

  /**
   * Normalise a Sui address prefix to its shortest form so that coin type
   * strings are comparable regardless of how the RPC returns them.
   * e.g. "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
   *   → "0x2::sui::SUI"
   * Keeps at least one hex digit so "0x0::..." stays "0x0::..." (never "0x::...").
   */
  private normalizeAddress(coinType: string): string {
    return coinType.replace(/^0x0*([0-9a-fA-F])/, "0x$1");
  }

  private shortName(coinType: string): string {
    const parts = coinType.split("::");
    return parts[parts.length - 1] ?? coinType;
  }
}
