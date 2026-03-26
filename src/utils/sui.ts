import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { logger } from "./logger.js";

/**
 * Derives an Ed25519 keypair from a BIP39 mnemonic phrase.
 */
export function keypairFromMnemonic(mnemonic: string): Ed25519Keypair {
  return Ed25519Keypair.deriveKeypair(mnemonic);
}

/**
 * Returns the SUI balance (in MIST) for the given address.
 */
export async function getSuiBalance(
  client: SuiJsonRpcClient,
  address: string
): Promise<bigint> {
  const balance = await client.getBalance({
    owner: address,
    coinType: "0x2::sui::SUI",
  });
  return BigInt(balance.totalBalance);
}

/**
 * Executes (or dry-runs) a transaction block and returns the digest.
 */
export async function executeTransaction(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  tx: Transaction,
  gasBudget: number,
  dryRun: boolean
): Promise<string | null> {
  tx.setGasBudget(gasBudget);

  if (dryRun) {
    const sender = keypair.getPublicKey().toSuiAddress();
    tx.setSender(sender);
    // Build the transaction bytes without a client (works for explicit move-call transactions)
    let bytes: Uint8Array;
    try {
      bytes = await tx.build();
    } catch (err) {
      logger.warn(`[DryRun] Could not build transaction bytes: ${err}`);
      return null;
    }
    const result = await client.dryRunTransactionBlock({
      transactionBlock: bytes,
    });
    const status = result.effects.status.status;
    logger.info(`[DryRun] Transaction status: ${status}`);
    if (status !== "success") {
      logger.warn(
        `[DryRun] Transaction would fail: ${result.effects.status.error ?? "unknown"}`
      );
      return null;
    }
    return "dry-run-ok";
  }

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showEvents: true,
    },
  });

  logger.info(`Transaction executed. Digest: ${result.digest}`);
  return result.digest;
}
