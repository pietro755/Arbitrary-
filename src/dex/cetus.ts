import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
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
  private static readonly DEFAULT_FEE_RATE = 0.0025;
  private static readonly DEFAULT_FEE_RATE_PPM = 2500;

  // Cetus Clmm package on mainnet
  private static readonly PACKAGE =
    "0x1eabed72c53feb3805120a081dc15963c204dc8d0173814288a239a0690f3f8c";
  // GlobalConfig object
  private static readonly GLOBAL_CONFIG =
    "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8";

  // Known high-liquidity Cetus pools (bootstrapped list)
  private static readonly KNOWN_POOLS: PoolInfo[] = [
    {
      poolId:
        "0xaa020ad81e1621d98d4fb82c4acb80dc064722f24ef828ab633bef50fc28268b",
      dexId: DEX_IDS.CETUS,
      coinTypeA:
        "0x2::sui::SUI",
      coinTypeB:
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      name: "SUI/USDC",
    },
    {
      poolId:
        "0x06d8af9e6afd27262db436f0d37b304a041f710c3ea1fa4c3a9bab36b3569ad3",
      dexId: DEX_IDS.CETUS,
      coinTypeA:
        "0x2::sui::SUI",
      coinTypeB:
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
      name: "SUI/USDT",
    },
  ];

  async fetchPools(_client: SuiJsonRpcClient): Promise<PoolInfo[]> {
    try {
      const pools = [...CetusAdapter.KNOWN_POOLS];
      logger.info(`[Cetus] Using ${pools.length} known pools`);
      return pools;
    } catch (error) {
      logger.error("[Cetus] Failed to fetch pools", error);
      return [];
    }
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
    const currentSqrtPriceField = fields["current_sqrt_price"];
    const directCurrentSqrtPrice =
      typeof currentSqrtPriceField === "string" ||
      typeof currentSqrtPriceField === "number" ||
      typeof currentSqrtPriceField === "bigint"
        ? currentSqrtPriceField.toString()
        : null;

    const sqrtPriceCandidates: Array<[string, string | null]> = [
      [
        "current_sqrt_price",
        directCurrentSqrtPrice ?? this.readMoveFieldAsString(fields["current_sqrt_price"]),
      ],
      ["sqrt_price", this.readMoveFieldAsString(fields["sqrt_price"])],
      [
        "current_sqrt_price_x64",
        this.readMoveFieldAsString(fields["current_sqrt_price_x64"]),
      ],
      ["sqrt_price_x64", this.readMoveFieldAsString(fields["sqrt_price_x64"])],
    ];

    const sqrtPriceEntry = sqrtPriceCandidates.find(([, value]) => value !== null);
    if (!sqrtPriceEntry || !sqrtPriceEntry[1]) {
      throw new Error(`Missing sqrt price field for Cetus pool ${pool.poolId}`);
    }
    const [sqrtFieldName, sqrtPriceRaw] = sqrtPriceEntry;
    const sqrtPrice = this.readU128(sqrtPriceRaw);

    const feeRate =
      this.readNumber(fields["fee_rate"], CetusAdapter.DEFAULT_FEE_RATE_PPM) / 1_000_000;

    logger.debug(
      `[Cetus] Fetched sqrt price from ${sqrtFieldName}: ${sqrtPrice.toString()} (feeRate=${feeRate})`
    );

    // Derive spot price from sqrt_price (Q64.64 fixed-point)
    // price = (sqrt_price / 2^64)^2  =>  coinB per coinA
    const Q64 = BigInt("18446744073709551616"); // 2^64
    const priceB_per_A =
      Number((sqrtPrice * sqrtPrice) / Q64) / Number(Q64);
    if (!Number.isFinite(priceB_per_A) || priceB_per_A <= 0) {
      throw new Error(`Cetus pool ${pool.poolId} has invalid sqrt price: ${sqrtPrice.toString()}`);
    }

    const a2b = coinIn === pool.coinTypeA;
    const spotPrice = a2b ? priceB_per_A : 1 / priceB_per_A;
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      throw new Error(`Cetus pool ${pool.poolId} has invalid spot price: ${spotPrice}`);
    }
    const rawAmountOut = Math.floor(Number(amountIn) * spotPrice * (1 - feeRate));
    if (!Number.isFinite(rawAmountOut) || rawAmountOut < 0) {
      throw new Error(`Cetus pool ${pool.poolId} computed invalid amountOut: ${rawAmountOut}`);
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

  private readU128(value: unknown): bigint {
    if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
      return BigInt(value);
    }

    if (value && typeof value === "object") {
      const map = value as Record<string, unknown>;
      if ("bits" in map) return this.readU128(map.bits);
      if ("value" in map) return this.readU128(map.value);

      if ("fields" in map && map.fields && typeof map.fields === "object") {
        const nested = map.fields as Record<string, unknown>;
        if ("bits" in nested) return this.readU128(nested.bits);
        if ("value" in nested) return this.readU128(nested.value);
      }
    }

    throw new Error(`Unable to parse u128 value: ${String(value)}`);
  }

  private readNumber(value: unknown, fallback: number): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    if (typeof value === "bigint") return Number(value);

    if (value && typeof value === "object") {
      const map = value as Record<string, unknown>;
      if ("bits" in map) return this.readNumber(map.bits, fallback);
      if ("value" in map) return this.readNumber(map.value, fallback);
      if ("fields" in map && map.fields && typeof map.fields === "object") {
        const nested = map.fields as Record<string, unknown>;
        if ("bits" in nested) return this.readNumber(nested.bits, fallback);
        if ("value" in nested) return this.readNumber(nested.value, fallback);
      }
    }

    return fallback;
  }

  private readMoveFieldAsString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return value.toString();
    }

    if (value && typeof value === "object") {
      const map = value as Record<string, unknown>;
      if ("bits" in map) return this.readMoveFieldAsString(map.bits);
      if ("value" in map) return this.readMoveFieldAsString(map.value);
      if ("fields" in map && map.fields && typeof map.fields === "object") {
        const nested = map.fields as Record<string, unknown>;
        if ("bits" in nested) return this.readMoveFieldAsString(nested.bits);
        if ("value" in nested) return this.readMoveFieldAsString(nested.value);
      }
    }

    return null;
  }

  private shortName(coinType: string): string {
    const parts = coinType.split("::");
    return parts[parts.length - 1] ?? coinType;
  }
}
