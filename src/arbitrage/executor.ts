import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Config } from "../config/index.js";
import { DexAdapter } from "../dex/types.js";
import { logger } from "../utils/logger.js";
import { executeTransaction } from "../utils/sui.js";
import { ArbitrageOpportunity } from "./detector.js";

export class ArbitrageExecutor {
  constructor(
    private readonly client: SuiJsonRpcClient,
    private readonly keypair: Ed25519Keypair,
    private readonly config: Config,
    private readonly adapters: Map<string, DexAdapter>
  ) {}

  /**
   * Executes the best (most profitable) arbitrage opportunity.
   * Returns the transaction digest on success, null on failure or dry-run simulation.
   */
  async execute(opp: ArbitrageOpportunity): Promise<string | null> {
    const { route } = opp;

    logger.info(
      `[Executor] Executing arbitrage: ${route.description} ` +
        `| estimatedProfit ≈ $${opp.profitAfterGasUsd.toFixed(4)}`
    );

    const tx = new Transaction();
    const senderAddress = this.keypair.getPublicKey().toSuiAddress();

    for (const leg of route.legs) {
      const adapter = this.adapters.get(leg.pool.dexId);
      if (!adapter) {
        logger.error(`[Executor] No adapter registered for DEX: ${leg.pool.dexId}`);
        return null;
      }

      const minAmountOut = this.applySlippage(
        leg.amountOut,
        this.config.slippageTolerance
      );

      try {
        await adapter.buildSwapTx(
          tx,
          leg.pool,
          leg.coinIn,
          leg.amountIn,
          minAmountOut,
          senderAddress
        );
      } catch (err) {
        logger.error(`[Executor] Failed to build swap leg: ${err}`);
        return null;
      }
    }

    return executeTransaction(
      this.client,
      this.keypair,
      tx,
      this.config.gasBudget,
      this.config.dryRun
    );
  }

  private applySlippage(amount: bigint, slippage: number): bigint {
    return BigInt(Math.floor(Number(amount) * (1 - slippage)));
  }
}
