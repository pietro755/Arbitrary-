# Sui Arbitrage Bot

An automated arbitrage bot for the **Sui blockchain** that monitors multiple DEXes for profitable cross-exchange opportunities and executes trades automatically.

## Supported DEXes

| DEX | Type | Notes |
|-----|------|-------|
| [Cetus](https://app.cetus.zone/) | Concentrated Liquidity (CLMM) | Leading Sui CLMM |
| [Turbos](https://app.turbos.finance/) | Concentrated Liquidity (CLMM) | Uniswap V3-style |
| [DeepBook V2](https://deepbook.tech/) | Central Limit Order Book (CLOB) | Native Sui order book |
| [FlowX Finance](https://flowx.finance/) | Constant Product AMM (x·y=k) | Uniswap V2-style |
| [Kriya DEX](https://www.kriya.finance/) | Constant Product AMM (x·y=k) | |

## Strategy

The bot searches for two strategies:

1. **Two-leg arbitrage**: Buy token A→B on DEX X, sell B→A on DEX Y (when the prices differ enough to yield profit after fees and gas).
2. **Three-leg triangular arbitrage**: A→B→C→A across multiple DEXes.

All opportunities are ranked by estimated profit (after gas costs), and only trades above the configured minimum profit threshold are executed.

## Prerequisites

- Node.js ≥ 18
- A funded Sui mainnet wallet
- (Optional) A private Sui RPC endpoint for lower latency

## Installation

```bash
git clone https://github.com/pietro755/Arbitrary-.git
cd Arbitrary-
npm install
```

## Configuration

Copy the example environment file and fill in your details:

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SUI_RPC_URL` | `https://fullnode.mainnet.sui.io:443` | Sui RPC endpoint |
| `WALLET_MNEMONIC` | *(required)* | BIP39 mnemonic phrase for your wallet |
| `MIN_PROFIT_USD` | `1.0` | Minimum net profit in USD to execute a trade |
| `MAX_TRADE_SIZE_SUI` | `100` | Maximum trade size in SUI |
| `POLL_INTERVAL_MS` | `3000` | How often to scan for opportunities (ms) |
| `SLIPPAGE_TOLERANCE` | `0.005` | Slippage tolerance (0.005 = 0.5%) |
| `GAS_BUDGET` | `50000000` | Gas budget in MIST (50,000,000 = 0.05 SUI) |
| `DRY_RUN` | `true` | Simulate trades without executing them |
| `LOG_LEVEL` | `info` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |

> ⚠️ **Security**: Never commit your `.env` file. It contains your private mnemonic phrase.

## Running

### Development (with live TypeScript)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## Architecture

```
src/
├── config/
│   └── index.ts          # Configuration loading, token/DEX constants
├── dex/
│   ├── types.ts           # DexAdapter interface, PoolInfo, QuoteResult types
│   ├── cetus.ts           # Cetus CLMM adapter
│   ├── turbos.ts          # Turbos Finance adapter
│   ├── deepbook.ts        # DeepBook V2 CLOB adapter
│   ├── flowx.ts           # FlowX Finance AMM adapter
│   ├── kriya.ts           # Kriya DEX AMM adapter
│   └── index.ts           # Re-exports
├── arbitrage/
│   ├── detector.ts        # Arbitrage path detection (2-leg + triangular)
│   ├── executor.ts        # Trade execution
│   └── index.ts           # Re-exports
├── utils/
│   ├── logger.ts          # Levelled logger
│   ├── price.ts           # CoinGecko price oracle
│   └── sui.ts             # Sui client helpers (balance, tx execution)
└── index.ts               # Main bot entry point
```

## Safety Features

- **Dry-run mode** (default `DRY_RUN=true`): Simulates all transactions without spending funds.
- **Balance check**: Skips trades if the wallet doesn't have enough SUI for the trade + gas.
- **Slippage protection**: Applies configurable slippage tolerance to all swap legs.
- **Gas budget cap**: All transactions are capped at the configured `GAS_BUDGET`.
- **Concurrent tick prevention**: If the previous scan is still running, the next tick is skipped.

## Disclaimer

This software is provided for educational and research purposes. Arbitrage trading carries significant financial risk. Always test thoroughly with `DRY_RUN=true` before enabling live trading. The authors are not responsible for any financial losses.
