import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { loadConfig, TOKENS } from "./config/index.js";
import {
  CetusAdapter,
  TurbosAdapter,
  DeepbookAdapter,
  FlowxAdapter,
  KriyaAdapter,
} from "./dex/index.js";
import { DexAdapter, PoolInfo, QuoteResult } from "./dex/types.js";
import { ArbitrageDetector, ArbitrageExecutor } from "./arbitrage/index.js";
import { logger, setLogLevel, LogLevel } from "./utils/logger.js";
import { keypairFromMnemonic, getSuiBalance } from "./utils/sui.js";
import { fetchSuiPrice } from "./utils/price.js";

async function main(): Promise<void> {
  // ── Configuration ─────────────────────────────────────────────────────
  const config = loadConfig();
  setLogLevel(config.logLevel as LogLevel);

  logger.info("=== Sui Arbitrage Bot ===");
  logger.info(`RPC: ${config.suiRpcUrl}`);
  logger.info(`Dry-run: ${config.dryRun}`);
  logger.info(`Min profit: $${config.minProfitUsd}`);
  logger.info(`Max trade size: ${config.maxTradeSizeSui} SUI`);
  logger.info(`Poll interval: ${config.pollIntervalMs}ms`);

  // ── Client & Wallet ───────────────────────────────────────────────────
  const client = new SuiJsonRpcClient({ url: config.suiRpcUrl, network: "mainnet" });
  const keypair = keypairFromMnemonic(config.walletMnemonic);
  const address = keypair.getPublicKey().toSuiAddress();
  logger.info(`Wallet address: ${address}`);

  const balanceMist = await getSuiBalance(client, address);
  const balanceSui = Number(balanceMist) / 1e9;
  logger.info(`SUI balance: ${balanceSui.toFixed(4)} SUI`);

  if (balanceSui < 0.1) {
    logger.warn("Low SUI balance — ensure you have enough for gas and trades.");
  }

  // ── DEX Adapters ──────────────────────────────────────────────────────
  const adapterList: DexAdapter[] = [
    new CetusAdapter(),
    new TurbosAdapter(),
    new DeepbookAdapter(),
    new FlowxAdapter(),
    new KriyaAdapter(),
  ];

  const adapterMap = new Map<string, DexAdapter>(
    adapterList.map((a) => [a.id, a])
  );

  // ── Fetch pools (once at startup, refresh every 10 minutes) ──────────
  let allPools: PoolInfo[] = [];
  let lastPoolRefresh = 0;
  const POOL_REFRESH_INTERVAL = 10 * 60 * 1000;

  const hasPoolsForStartToken = (): boolean =>
    allPools.some(
      (p) => p.coinTypeA === TOKENS.SUI || p.coinTypeB === TOKENS.SUI
    );

  async function refreshPools(): Promise<void> {
    logger.info("[Bot] Refreshing pool list from all DEXes…");
    const poolArrays = await Promise.allSettled(
      adapterList.map((a) => a.fetchPools(client))
    );
    allPools = [];
    for (const result of poolArrays) {
      if (result.status === "fulfilled") {
        allPools.push(...result.value);
      } else {
        logger.warn(`[Bot] Failed to fetch pools: ${result.reason}`);
      }
    }
    logger.info(`[Bot] Total pools loaded: ${allPools.length}`);

    if (allPools.length === 0) {
      logger.warn("[Bot] No pools loaded — will retry immediately.");
      lastPoolRefresh = 0;
      return;
    }

    if (!hasPoolsForStartToken()) {
      logger.warn(
        "[Bot] No pools contain the start token (SUI) — will retry immediately."
      );
      lastPoolRefresh = 0;
      return;
    }

    // Only mark refresh time once we have usable pools for the start token.
    lastPoolRefresh = Date.now();
  }

  await refreshPools();

  // ── Price Oracle ──────────────────────────────────────────────────────
  let suiPriceUsd = await fetchSuiPrice();
  logger.info(`[Bot] SUI price: $${suiPriceUsd.toFixed(4)}`);

  // Refresh SUI price every 60 seconds
  setInterval(async () => {
    const price = await fetchSuiPrice();
    if (price > 0) suiPriceUsd = price;
  }, 60_000);

  // ── Trade size in MIST ────────────────────────────────────────────────
  const tradeSizeMist = BigInt(
    Math.floor(config.maxTradeSizeSui * 1e9)
  );

  // ── Main Loop ─────────────────────────────────────────────────────────
  const detector = new ArbitrageDetector(
    0.05, // gas cost USD estimate
    config.minProfitUsd,
    suiPriceUsd
  );

  const executor = new ArbitrageExecutor(client, keypair, config, adapterMap);

  let isRunning = false;

  async function tick(): Promise<void> {
    if (isRunning) return; // Skip if previous tick is still running
    isRunning = true;

    try {
      // Refresh pool list periodically
      if (Date.now() - lastPoolRefresh > POOL_REFRESH_INTERVAL) {
        await refreshPools();
      }

      if (allPools.length === 0 || !hasPoolsForStartToken()) {
        logger.warn("[Bot] No pools available for the start token — attempting immediate refresh before skipping.");
        await refreshPools();
        if (allPools.length === 0 || !hasPoolsForStartToken()) {
          logger.warn("[Bot] No pools available after retry — skipping scan.");
          return;
        }
      }

      // Quote fetcher function passed to the detector
      const quoteFetcher = async (
        pool: PoolInfo,
        coinIn: string,
        amountIn: bigint
      ): Promise<QuoteResult | null> => {
        const adapter = adapterMap.get(pool.dexId);
        if (!adapter) {
          logger.error("[Bot] Quote fetch failed: no adapter", {
            dexId: pool.dexId,
            poolId: pool.poolId,
          });
          return null;
        }
        try {
          return await adapter.getQuote(client, pool, coinIn, amountIn);
        } catch (err) {
          logger.error("[Bot] Quote fetch failed", {
            dexId: pool.dexId,
            poolId: pool.poolId,
            coinIn,
            amountIn: amountIn.toString(),
            error: String(err),
          });
          return null;
        }
      };

      const { opportunities, checkedCount, failedQuotes } = await detector.findOpportunities(
        allPools,
        quoteFetcher,
        tradeSizeMist,
        TOKENS.SUI
      );

      const profitable = opportunities.filter((o: { profitable: boolean }) => o.profitable);
      logger.info(
        `[Bot] Scan complete — ${checkedCount} checked, ${failedQuotes} failed, ${profitable.length} profitable.`
      );

      if (profitable.length > 0) {
        const best = profitable[0];
        logger.info(
          `[Bot] Best opportunity: ${best.route.description} | ` +
            `profit ≈ $${best.profitAfterGasUsd.toFixed(4)}`
        );

        // Verify wallet still has enough balance for the trade
        const currentBalance = await getSuiBalance(client, address);
        const requiredMist =
          tradeSizeMist + BigInt(config.gasBudget);
        if (currentBalance < requiredMist) {
          logger.warn(
            `[Bot] Insufficient balance (${Number(currentBalance) / 1e9} SUI). Skipping.`
          );
          return;
        }

        const digest = await executor.execute(best);
        if (digest) {
          logger.info(`[Bot] Trade executed. Digest: ${digest}`);
        } else {
          logger.warn("[Bot] Trade execution returned null (failed or dry-run).");
        }
      }
    } catch (err) {
      logger.error(`[Bot] Tick error: ${err}`);
    } finally {
      isRunning = false;
    }
  }

  logger.info(`[Bot] Starting polling every ${config.pollIntervalMs}ms…`);
  // Run first tick immediately, then schedule
  await tick();
  setInterval(tick, config.pollIntervalMs);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
