import dotenv from "dotenv";
dotenv.config();

export interface Config {
  suiRpcUrl: string;
  walletMnemonic: string;
  minProfitUsd: number;
  maxTradeSizeSui: number;
  pollIntervalMs: number;
  slippageTolerance: number;
  gasBudget: number;
  dryRun: boolean;
  logLevel: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export function loadConfig(): Config {
  return {
    suiRpcUrl: getEnv(
      "SUI_RPC_URL",
      "https://fullnode.mainnet.sui.io:443"
    ),
    walletMnemonic: requireEnv("WALLET_MNEMONIC"),
    minProfitUsd: parseFloat(getEnv("MIN_PROFIT_USD", "1.0")),
    maxTradeSizeSui: parseFloat(getEnv("MAX_TRADE_SIZE_SUI", "100")),
    pollIntervalMs: parseInt(getEnv("POLL_INTERVAL_MS", "3000"), 10),
    slippageTolerance: parseFloat(getEnv("SLIPPAGE_TOLERANCE", "0.005")),
    gasBudget: parseInt(getEnv("GAS_BUDGET", "50000000"), 10),
    dryRun: getEnv("DRY_RUN", "true") === "true",
    logLevel: getEnv("LOG_LEVEL", "info"),
  };
}

// Well-known Sui token types
export const TOKENS = {
  SUI: "0x2::sui::SUI",
  USDC: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
  USDT: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
  CETUS: "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
  WETH: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN",
} as const;

export type TokenType = keyof typeof TOKENS;

// DEX identifiers
export const DEX_IDS = {
  CETUS: "cetus",
  TURBOS: "turbos",
  DEEPBOOK: "deepbook",
  FLOWX: "flowx",
  AFTERMATH: "aftermath",
  KRIYA: "kriya",
} as const;

export type DexId = (typeof DEX_IDS)[keyof typeof DEX_IDS];
