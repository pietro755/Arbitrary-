import { PoolInfo, QuoteResult } from "../dex/types.js";
import { logger } from "../utils/logger.js";

export interface ArbitrageRoute {
  /** Human-readable description, e.g. "SUI → USDC (Cetus) → SUI (Turbos)" */
  description: string;
  /** Ordered list of swap legs */
  legs: SwapLeg[];
  /** Input amount (in base units of the starting token) */
  amountIn: bigint;
  /** Expected output amount (in base units of the starting token) */
  amountOut: bigint;
  /** Gross profit = amountOut - amountIn */
  grossProfit: bigint;
  /** Estimated profit in USD */
  estimatedProfitUsd: number;
}

export interface SwapLeg {
  pool: PoolInfo;
  coinIn: string;
  coinOut: string;
  amountIn: bigint;
  amountOut: bigint;
  quote: QuoteResult;
}

export interface ArbitrageOpportunity {
  route: ArbitrageRoute;
  profitable: boolean;
  profitAfterGasUsd: number;
}

export interface FindOpportunitiesResult {
  opportunities: ArbitrageOpportunity[];
  checkedCount: number;
  failedQuotes: number;
}

/**
 * Finds all two-leg arbitrage opportunities across a set of DEX pools.
 *
 * Strategy: For each token pair (A/B) that appears on at least two different
 * DEXes, check if buying A→B on the cheaper DEX and selling B→A on the more
 * expensive DEX yields a profit after fees.
 *
 * We also check three-leg triangular arbitrage: A→B→C→A.
 */
export class ArbitrageDetector {
  /**
   * @param gasCostUsd - estimated gas cost per arbitrage transaction in USD
   * @param minProfitUsd - minimum net profit required to flag as opportunity
   * @param suiPriceUsd - current SUI/USD price used for profit estimates
   */
  constructor(
    private readonly gasCostUsd: number = 0.05,
    private readonly minProfitUsd: number = 1.0,
    private readonly suiPriceUsd: number = 1.0
  ) {}

  /**
   * Given a pool→quote map, find all profitable two-leg circular routes.
   *
   * @param pools - all known pools across all DEXes
   * @param quoteFetcher - async function to get a quote for a pool
   * @param amountIn - trade size in the native units of the start token
   * @param startToken - token to start and end with (typically SUI)
   */
  async findOpportunities(
    pools: PoolInfo[],
    quoteFetcher: (
      pool: PoolInfo,
      coinIn: string,
      amountIn: bigint
    ) => Promise<QuoteResult | null>,
    amountIn: bigint,
    startToken: string
  ): Promise<FindOpportunitiesResult> {
    const opportunities: ArbitrageOpportunity[] = [];
    let checkedRoutes = 0;
    let failedQuotes = 0;

    // Build a map from token-pair key → pools that trade that pair
    const pairMap = new Map<string, PoolInfo[]>();
    for (const pool of pools) {
      const key = this.pairKey(pool.coinTypeA, pool.coinTypeB);
      const existing = pairMap.get(key) ?? [];
      existing.push(pool);
      pairMap.set(key, existing);
    }

    // ── Two-leg arbitrage ─────────────────────────────────────────────────
    // For each pair that has ≥2 pools (possibly on different DEXes), try
    // buying on one and selling on the other.
    for (const [, pairPools] of pairMap) {
      if (pairPools.length < 2) continue;

      // Consider all ordered pairs of pools for this token pair
      for (let i = 0; i < pairPools.length; i++) {
        for (let j = 0; j < pairPools.length; j++) {
          if (i === j) continue;
          const buyPool = pairPools[i];
          const sellPool = pairPools[j];

          // Skip same-DEX pairs (usually no meaningful spread)
          if (buyPool.dexId === sellPool.dexId) continue;

          // Only consider routes starting from startToken
          const coinMid = buyPool.coinTypeA === startToken
            ? buyPool.coinTypeB
            : buyPool.coinTypeA;

          if (
            buyPool.coinTypeA !== startToken &&
            buyPool.coinTypeB !== startToken
          ) {
            continue;
          }

          try {
            checkedRoutes += 1;
            const leg1 = await quoteFetcher(buyPool, startToken, amountIn);
            if (!leg1) {
              failedQuotes += 1;
              continue;
            }
            if (leg1.amountOut === 0n) continue;

            const leg2 = await quoteFetcher(
              sellPool,
              coinMid,
              leg1.amountOut
            );
            if (!leg2) {
              failedQuotes += 1;
              continue;
            }
            if (leg2.amountOut === 0n) continue;

            if (leg2.coinOut !== startToken) continue;

            const grossProfit = leg2.amountOut - amountIn;
            const profitUsd = this.toUsd(grossProfit, startToken);
            const netProfitUsd = profitUsd - this.gasCostUsd;
            if (!Number.isFinite(netProfitUsd)) continue;

            const description =
              `${this.shortName(startToken)} → ${this.shortName(coinMid)}` +
              ` (${buyPool.dexId}) → ${this.shortName(startToken)} (${sellPool.dexId})`;

            const route: ArbitrageRoute = {
              description,
              legs: [
                {
                  pool: buyPool,
                  coinIn: startToken,
                  coinOut: coinMid,
                  amountIn,
                  amountOut: leg1.amountOut,
                  quote: leg1,
                },
                {
                  pool: sellPool,
                  coinIn: coinMid,
                  coinOut: startToken,
                  amountIn: leg1.amountOut,
                  amountOut: leg2.amountOut,
                  quote: leg2,
                },
              ],
              amountIn,
              amountOut: leg2.amountOut,
              grossProfit,
              estimatedProfitUsd: profitUsd,
            };

            opportunities.push({
              route,
              profitable: netProfitUsd > this.minProfitUsd,
              profitAfterGasUsd: netProfitUsd,
            });

            if (netProfitUsd > this.minProfitUsd) {
              logger.info(
                `[Arbitrage] ✅ Opportunity found: ${description} | ` +
                  `profit ≈ $${netProfitUsd.toFixed(4)}`
              );
            } else {
              logger.debug(
                `[Arbitrage] Route ${description} profit $${netProfitUsd.toFixed(4)} below threshold`
              );
            }
          } catch (err) {
            failedQuotes += 1;
            logger.debug(`[Arbitrage] Quote error for pair: ${err}`);
          }
        }
      }
    }

    // ── Three-leg triangular arbitrage ────────────────────────────────────
    // A→B→C→A across different DEXes
    const threeLegs = await this.findTriangularOpportunities(
      pools,
      quoteFetcher,
      amountIn,
      startToken,
      pairMap
    );
    checkedRoutes += threeLegs.checkedRoutes;
    failedQuotes += threeLegs.failedQuotes;
    opportunities.push(...threeLegs.opportunities);
    const profitableCount = opportunities.filter((o) => o.profitable).length;

    logger.info(
      `[Arbitrage] ${checkedRoutes} checked, ${failedQuotes} failed, ${profitableCount} profitable.`
    );

    // Sort by profit descending
    return {
      opportunities: opportunities.sort(
        (a, b) => b.profitAfterGasUsd - a.profitAfterGasUsd
      ),
      checkedCount: checkedRoutes,
      failedQuotes,
    };
  }

  private async findTriangularOpportunities(
    pools: PoolInfo[],
    quoteFetcher: (
      pool: PoolInfo,
      coinIn: string,
      amountIn: bigint
    ) => Promise<QuoteResult | null>,
    amountIn: bigint,
    startToken: string,
    _pairMap: Map<string, PoolInfo[]>
  ): Promise<{ opportunities: ArbitrageOpportunity[]; checkedRoutes: number; failedQuotes: number }> {
    const opps: ArbitrageOpportunity[] = [];
    let checkedRoutes = 0;
    let failedQuotes = 0;

    // Find all pools containing startToken as leg1
    const leg1Pools = pools.filter(
      (p) => p.coinTypeA === startToken || p.coinTypeB === startToken
    );

    for (const pool1 of leg1Pools) {
      const tokenB =
        pool1.coinTypeA === startToken ? pool1.coinTypeB : pool1.coinTypeA;

      // Find pools containing tokenB (but not startToken) for leg2
      const leg2Pools = pools.filter(
        (p) =>
          (p.coinTypeA === tokenB || p.coinTypeB === tokenB) &&
          p.coinTypeA !== startToken &&
          p.coinTypeB !== startToken
      );

      for (const pool2 of leg2Pools) {
        const tokenC =
          pool2.coinTypeA === tokenB ? pool2.coinTypeB : pool2.coinTypeA;

        // Find pools containing tokenC and startToken for leg3
        const leg3Pools = pools.filter(
          (p) =>
            (p.coinTypeA === tokenC && p.coinTypeB === startToken) ||
            (p.coinTypeB === tokenC && p.coinTypeA === startToken)
        );

        for (const pool3 of leg3Pools) {
          // Require at least 2 different DEXes involved for meaningful arbitrage
          const dexSet = new Set([pool1.dexId, pool2.dexId, pool3.dexId]);
          if (dexSet.size < 2) continue;

          try {
            checkedRoutes += 1;
            const q1 = await quoteFetcher(pool1, startToken, amountIn);
            if (!q1) {
              failedQuotes += 1;
              continue;
            }
            if (q1.amountOut === 0n) continue;

            const q2 = await quoteFetcher(pool2, tokenB, q1.amountOut);
            if (!q2) {
              failedQuotes += 1;
              continue;
            }
            if (q2.amountOut === 0n) continue;

            const q3 = await quoteFetcher(pool3, tokenC, q2.amountOut);
            if (!q3) {
              failedQuotes += 1;
              continue;
            }
            if (q3.amountOut === 0n) continue;

            if (q3.coinOut !== startToken) continue;

            const grossProfit = q3.amountOut - amountIn;
            const profitUsd = this.toUsd(grossProfit, startToken);
            const netProfitUsd = profitUsd - this.gasCostUsd;
            if (!Number.isFinite(netProfitUsd)) continue;

            const desc =
              `${this.shortName(startToken)}→${this.shortName(tokenB)}(${pool1.dexId})` +
              `→${this.shortName(tokenC)}(${pool2.dexId})` +
              `→${this.shortName(startToken)}(${pool3.dexId})`;

            opps.push({
              route: {
                description: desc,
                legs: [
                  { pool: pool1, coinIn: startToken, coinOut: tokenB, amountIn, amountOut: q1.amountOut, quote: q1 },
                  { pool: pool2, coinIn: tokenB, coinOut: tokenC, amountIn: q1.amountOut, amountOut: q2.amountOut, quote: q2 },
                  { pool: pool3, coinIn: tokenC, coinOut: startToken, amountIn: q2.amountOut, amountOut: q3.amountOut, quote: q3 },
                ],
                amountIn,
                amountOut: q3.amountOut,
                grossProfit,
                estimatedProfitUsd: profitUsd,
              },
              profitable: netProfitUsd > this.minProfitUsd,
              profitAfterGasUsd: netProfitUsd,
            });

            if (netProfitUsd > this.minProfitUsd) {
              logger.info(`[Arbitrage] ✅ Triangular: ${desc} | profit ≈ $${netProfitUsd.toFixed(4)}`);
            }
          } catch (err) {
            failedQuotes += 1;
            logger.debug(`[Arbitrage] Triangular quote error: ${err}`);
          }
        }
      }
    }

    return {
      opportunities: opps,
      checkedRoutes,
      failedQuotes,
    };
  }

  private pairKey(coinA: string, coinB: string): string {
    return [coinA, coinB].sort().join("|");
  }

  private shortName(coinType: string): string {
    const parts = coinType.split("::");
    return parts[parts.length - 1] ?? coinType;
  }

  private toUsd(amount: bigint, coinType: string): number {
    const SUI =
      "0x2::sui::SUI";
    const USDC =
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";
    const USDT =
      "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN";

    const amountFloat = Number(amount);
    if (!Number.isFinite(amountFloat) || amountFloat < 0) {
      return 0;
    }

    if (coinType === SUI) {
      // SUI has 9 decimals
      return (amountFloat / 1e9) * this.suiPriceUsd;
    }
    if (coinType === USDC || coinType === USDT) {
      // USDC/USDT have 6 decimals
      return amountFloat / 1e6;
    }
    // Unknown token: approximate as SUI
    return (amountFloat / 1e9) * this.suiPriceUsd;
  }
}
