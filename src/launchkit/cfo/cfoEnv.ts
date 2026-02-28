/**
 * CFO Agent — Complete Environment Configuration
 *
 * Covers all CFO sub-services:
 *   Polymarket   — prediction market trading (Polygon)
 *   Hyperliquid  — perpetual futures (Arbitrum)
 *   Kamino       — lending + vaults (Solana)
 *   Jito         — liquid staking (Solana)
 *   Wormhole     — cross-chain bridging
 *   LI.FI        — bridge aggregator fallback
 *   x402         — micropayment seller (sell Nova's intel)
 *   Pyth         — price oracle (Solana)
 *   Helius       — on-chain analytics + webhooks
 *
 * Env var naming convention: CFO_<SERVICE>_<PARAM>
 * All vars are optional unless CFO_ENABLE=true AND the relevant service flag is true.
 */

export interface CFOEnv {
  // ── Core ─────────────────────────────────────────────────────────
  cfoEnabled: boolean;
  dryRun: boolean;
  dailyReportHour: number;

  // ── Feature flags ─────────────────────────────────────────────────
  polymarketEnabled: boolean;
  hyperliquidEnabled: boolean;
  kaminoEnabled: boolean;
  jitoEnabled: boolean;
  wormholeEnabled: boolean;
  x402Enabled: boolean;
  heliusEnabled: boolean;

  // ── EVM wallets ───────────────────────────────────────────────────
  /** Primary EVM private key — used for Polymarket (Polygon) */
  evmPrivateKey: string | undefined;
  polygonRpcUrl: string;

  /** Arbitrum RPC — used for Hyperliquid */
  arbitrumRpcUrl: string;

  // ── Polymarket ────────────────────────────────────────────────────
  polymarketApiKey: string | undefined;
  polymarketApiSecret: string | undefined;
  polymarketPassphrase: string | undefined;
  maxPolymarketUsd: number;
  maxSingleBetUsd: number;
  kellyFraction: number;
  minEdge: number;

  // ── Hyperliquid ───────────────────────────────────────────────────
  hyperliquidApiWalletKey: string | undefined;   // API wallet private key from HL UI
  hyperliquidTestnet: boolean;
  maxHyperliquidUsd: number;
  maxHyperliquidLeverage: number;                // hard cap (architecture doc: 5x)
  hlHedgeCoins: string[];                        // coins eligible for hedging (default: auto from treasury + HL listing)
  hlHedgeMinExposureUsd: number;                 // minimum USD exposure per coin to bother hedging (default: 50)

  // ── Kamino ────────────────────────────────────────────────────────
  maxKaminoUsd: number;
  kaminoMaxLtvPct: number;                        // never borrow above this LTV (default 60)
  kaminoBorrowEnabled: boolean;                   // enable/disable borrowing (default false)
  kaminoBorrowMaxLtvPct: number;                  // max LTV when borrowing (default 50 — tighter than deposit cap)
  kaminoBorrowMinSpreadPct: number;               // minimum yield spread to justify borrowing (default 3%)
  maxKaminoBorrowUsd: number;                     // hard cap on total borrowed value in USD (default 500)
  kaminoJitoLoopEnabled: boolean;                  // enable JitoSOL/SOL Multiply loop (default false)
  kaminoJitoLoopTargetLtv: number;                 // target LTV % for the loop (default 65)
  kaminoJitoLoopMaxLoops: number;                  // max iterations (default 3, ~2.85x leverage at 65% LTV)
  kaminoJitoLoopMaxLtvPct: number;                 // max LTV for the JitoSOL/SOL loop (default 72 — well below 95% liq threshold)
  kaminoLstLoopEnabled: boolean;                   // enable multi-LST loop comparison — picks best spread among JitoSOL/mSOL/bSOL (default false)
  kaminoMultiplyVaultEnabled: boolean;             // enable Kamino Multiply vault deposits — managed auto-leveraged vaults (default false)
  // ── Orca Concentrated LP ──────────────────────────────────────────
  orcaLpEnabled: boolean;                         // enable Orca concentrated LP (default false)
  orcaLpRangeWidthPct: number;                    // range width as % of current price (default 20%)
  orcaLpMaxUsd: number;                           // max USD deployed into Orca LP (default 500)
  orcaLpRebalanceTriggerPct: number;              // rebalance when price within X% of range edge (default 5%)

  // ── Krystal EVM Concentrated LP ──────────────────────────────────
  krystalLpEnabled: boolean;                      // enable Krystal EVM LP (default false)
  krystalApiKey: string | undefined;              // Krystal Cloud API key
  krystalLpMaxUsd: number;                        // max USD per position (default 200)
  krystalLpMinTvlUsd: number;                     // min pool TVL filter (default 500000)
  krystalLpMinApr7d: number;                      // min 7d APR filter (default 15)
  krystalLpMaxPositions: number;                  // max concurrent EVM LP positions (default 3)
  krystalLpRangeWidthTicks: number;               // range width in ticks (default 400)
  krystalLpRebalanceTriggerPct: number;           // rebalance when utilisation drops below X% (default 10)
  evmRpcUrls: Record<number, string>;             // chainId → RPC URL mapping

  // ── Kamino-funded LP (borrow → LP → fees repay loan) ─────────────
  kaminoBorrowLpEnabled: boolean;                 // enable borrow-for-LP strategy (default false)
  kaminoBorrowLpMaxUsd: number;                   // max USD borrowed for LP (default 200 — conservative)
  kaminoBorrowLpMinSpreadPct: number;             // LP fee APY must beat borrow cost by this % (default 5)
  kaminoBorrowLpMaxLtvPct: number;                // won't borrow if post-borrow LTV exceeds this (default 55)
  kaminoBorrowLpCapacityPct: number;              // use at most X% of remaining borrow headroom (default 20)

  // ── EVM Flash Arbitrage (Arbitrum) ─────────────────────────────────────
  evmArbEnabled: boolean;              // enable arb scanning + execution (default false)
  evmArbMinProfitUsdc: number;         // minimum net profit per trade in USD (default 2)
  evmArbMaxFlashUsd: number;           // max flash loan size in USD (default 50000)
  evmArbReceiverAddress: string | undefined;  // deployed ArbFlashReceiver contract address
  evmArbScanIntervalMs: number;        // how often to scan for opportunities (default 30000)
  evmArbPoolRefreshMs: number;         // how often to refresh pool list from DeFiLlama (default 14400000)

  // ── Jito ─────────────────────────────────────────────────────────
  maxJitoSol: number;                             // max SOL to stake in Jito

  // ── Wormhole / LI.FI ─────────────────────────────────────────────
  lifiEnabled: boolean;
  maxBridgeUsd: number;

  // ── x402 Micropayments ────────────────────────────────────────────
  x402PriceRugcheck: number;                      // USDC per rug-check report
  x402PriceSignal: number;                        // USDC per KOL signal
  x402PriceTrend: number;                         // USDC per trend report  x402PriceScoutDigest: number;                   // USDC per scout digest
  x402PriceNarrativeShift: number;                // USDC per narrative shift report
  x402PriceLpPositions: number;                   // USDC per LP positions snapshot  x402BaseUrl: string;                            // Nova's public API base URL

  // ── Helius ────────────────────────────────────────────────────────
  heliusApiKey: string | undefined;

  // ── Pyth ─────────────────────────────────────────────────────────
  pythEnabled: boolean;

  // ── Emergency ─────────────────────────────────────────────────────
  /** Minutes to auto-resume after emergency pause (default 240 = 4h) */
  emergencyCooldownMinutes: number;
}

// ── Validation helpers ────────────────────────────────────────────

function isValidEvmKey(key: string | undefined): boolean {
  return !!key && key.startsWith('0x') && key.length === 66;
}

/** Alchemy chain slug → numeric chainId mapping.
 *  All these chains use the pattern: https://{slug}.g.alchemy.com/v2/{KEY} */
const ALCHEMY_CHAINS: Record<string, number> = {
  'eth-mainnet':     1,
  'opt-mainnet':     10,
  'polygon-mainnet': 137,
  'arb-mainnet':     42161,
  'base-mainnet':    8453,
  'zksync-mainnet':  324,
  'scroll-mainnet':  534352,
  'linea-mainnet':   59144,
};

/** Free public RPCs for chains Alchemy doesn't support */
const PUBLIC_FALLBACK_RPCS: Record<number, string> = {
  56:    'https://bsc-dataseed1.binance.org',   // BSC
  43114: 'https://api.avax.network/ext/bc/C/rpc', // Avalanche
  250:   'https://rpc.ftm.tools',                // Fantom
};

/** Build EVM RPC URL map. Priority (highest first):
 *  1. CFO_EVM_RPC_URLS explicit JSON overrides
 *  2. Legacy CFO_POLYGON_RPC_URL / CFO_ARBITRUM_RPC_URL
 *  3. Auto-generated from CFO_ALCHEMY_API_KEY (all Alchemy-supported chains)
 *  4. Free public RPCs for BSC, Avalanche, Fantom */
function parseEvmRpcUrls(): Record<number, string> {
  const result: Record<number, string> = {};

  // Layer 4: Public fallback RPCs (lowest priority)
  for (const [chainId, url] of Object.entries(PUBLIC_FALLBACK_RPCS)) {
    result[Number(chainId)] = url;
  }

  // Layer 3: Auto-generate from Alchemy API key
  const alchemyKey = process.env.CFO_ALCHEMY_API_KEY;
  if (alchemyKey) {
    for (const [slug, chainId] of Object.entries(ALCHEMY_CHAINS)) {
      result[chainId] = `https://${slug}.g.alchemy.com/v2/${alchemyKey}`;
    }
  }

  // Layer 2: Legacy polygon/arbitrum RPC URLs
  if (process.env.CFO_POLYGON_RPC_URL) {
    result[137] = process.env.CFO_POLYGON_RPC_URL;
  }
  if (process.env.CFO_ARBITRUM_RPC_URL) {
    result[42161] = process.env.CFO_ARBITRUM_RPC_URL;
  }

  // Layer 1: Explicit JSON overrides (highest priority)
  const raw = process.env.CFO_EVM_RPC_URLS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[Number(k)] = v;
      }
    } catch { /* ignore malformed JSON */ }
  }

  return result;
}

// ── Factory ───────────────────────────────────────────────────────

let _cached: CFOEnv | null = null;

export function getCFOEnv(bust = false): CFOEnv {
  if (_cached && !bust) return _cached;

  const cfoEnabled = process.env.CFO_ENABLE === 'true';
  const polymarketEnabled = process.env.CFO_POLYMARKET_ENABLE === 'true';
  const hyperliquidEnabled = process.env.CFO_HYPERLIQUID_ENABLE === 'true';
  const kaminoEnabled = process.env.CFO_KAMINO_ENABLE === 'true';
  const jitoEnabled = process.env.CFO_JITO_ENABLE !== 'false';   // default ON if CFO enabled
  const wormholeEnabled = process.env.CFO_WORMHOLE_ENABLE === 'true';
  const lifiEnabled = process.env.CFO_LIFI_ENABLE === 'true';
  const x402Enabled = process.env.CFO_X402_ENABLE === 'true';
  const heliusEnabled = !!process.env.CFO_HELIUS_API_KEY;
  const pythEnabled = process.env.CFO_PYTH_ENABLE !== 'false';   // default ON

  // Validate keys when services are enabled
  if (cfoEnabled && polymarketEnabled && !isValidEvmKey(process.env.CFO_EVM_PRIVATE_KEY)) {
    throw new Error('[CFO] CFO_EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string when Polymarket is enabled');
  }
  if (cfoEnabled && hyperliquidEnabled && !process.env.CFO_HYPERLIQUID_API_WALLET_KEY) {
    throw new Error('[CFO] CFO_HYPERLIQUID_API_WALLET_KEY required when Hyperliquid is enabled');
  }

  _cached = {
    cfoEnabled,
    dryRun: process.env.CFO_DRY_RUN === 'true',
    dailyReportHour: Number(process.env.CFO_DAILY_REPORT_HOUR ?? 8),

    polymarketEnabled,
    hyperliquidEnabled,
    kaminoEnabled,
    jitoEnabled,
    wormholeEnabled,
    x402Enabled,
    heliusEnabled,

    evmPrivateKey: process.env.CFO_EVM_PRIVATE_KEY,
    polygonRpcUrl: process.env.CFO_POLYGON_RPC_URL ?? 'https://polygon-rpc.com',
    arbitrumRpcUrl: process.env.CFO_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',

    polymarketApiKey: process.env.CFO_POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.CFO_POLYMARKET_API_SECRET,
    polymarketPassphrase: process.env.CFO_POLYMARKET_PASSPHRASE,
    maxPolymarketUsd: Number(process.env.CFO_MAX_POLYMARKET_USD ?? 200),
    maxSingleBetUsd: Number(process.env.CFO_MAX_SINGLE_BET_USD ?? 50),
    kellyFraction: Math.max(0.01, Math.min(1, Number(process.env.CFO_KELLY_FRACTION ?? 0.25))),
    minEdge: Math.max(0.01, Number(process.env.CFO_MIN_EDGE ?? 0.05)),

    hyperliquidApiWalletKey: process.env.CFO_HYPERLIQUID_API_WALLET_KEY,
    hyperliquidTestnet: process.env.CFO_HYPERLIQUID_TESTNET === 'true',
    maxHyperliquidUsd: Number(process.env.CFO_MAX_HYPERLIQUID_USD ?? 500),
    maxHyperliquidLeverage: Math.min(5, Number(process.env.CFO_MAX_HYPERLIQUID_LEVERAGE ?? 3)),
    hlHedgeCoins: (process.env.CFO_HL_HEDGE_COINS ?? '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    hlHedgeMinExposureUsd: Number(process.env.CFO_HL_HEDGE_MIN_EXPOSURE_USD ?? 50),

    maxKaminoUsd: Number(process.env.CFO_MAX_KAMINO_USD ?? 1000),
    kaminoMaxLtvPct: Number(process.env.CFO_KAMINO_MAX_LTV_PCT ?? 60),
    kaminoBorrowEnabled: process.env.CFO_KAMINO_BORROW_ENABLE === 'true',
    kaminoBorrowMaxLtvPct: Number(process.env.CFO_KAMINO_BORROW_MAX_LTV_PCT ?? 50),
    kaminoBorrowMinSpreadPct: Number(process.env.CFO_KAMINO_BORROW_MIN_SPREAD_PCT ?? 3),
    maxKaminoBorrowUsd: Number(process.env.CFO_MAX_KAMINO_BORROW_USD ?? 500),
    kaminoJitoLoopEnabled: process.env.CFO_KAMINO_JITO_LOOP_ENABLE === 'true',
    kaminoJitoLoopTargetLtv: Number(process.env.CFO_KAMINO_JITO_LOOP_TARGET_LTV ?? 65),
    kaminoJitoLoopMaxLoops: Number(process.env.CFO_KAMINO_JITO_LOOP_MAX_LOOPS ?? 3),
    kaminoJitoLoopMaxLtvPct: Number(process.env.CFO_KAMINO_JITO_LOOP_MAX_LTV_PCT ?? 72),
    kaminoLstLoopEnabled: process.env.CFO_KAMINO_LST_LOOP_ENABLE === 'true',
    kaminoMultiplyVaultEnabled: process.env.CFO_KAMINO_MULTIPLY_VAULT_ENABLE === 'true',
    orcaLpEnabled: process.env.CFO_ORCA_LP_ENABLE === 'true',
    orcaLpRangeWidthPct: Number(process.env.CFO_ORCA_LP_RANGE_WIDTH_PCT ?? 20),
    orcaLpMaxUsd: Number(process.env.CFO_ORCA_LP_MAX_USD ?? 500),
    orcaLpRebalanceTriggerPct: Number(process.env.CFO_ORCA_LP_REBALANCE_TRIGGER_PCT ?? 5),

    krystalLpEnabled: process.env.CFO_KRYSTAL_LP_ENABLE === 'true',
    krystalApiKey: process.env.CFO_KRYSTAL_API_KEY,
    krystalLpMaxUsd: Number(process.env.CFO_KRYSTAL_LP_MAX_USD ?? 200),
    krystalLpMinTvlUsd: Number(process.env.CFO_KRYSTAL_LP_MIN_TVL_USD ?? 500_000),
    krystalLpMinApr7d: Number(process.env.CFO_KRYSTAL_LP_MIN_APR_7D ?? 15),
    krystalLpMaxPositions: Number(process.env.CFO_KRYSTAL_LP_MAX_POSITIONS ?? 3),
    krystalLpRangeWidthTicks: Number(process.env.CFO_KRYSTAL_LP_RANGE_WIDTH_TICKS ?? 400),
    krystalLpRebalanceTriggerPct: Number(process.env.CFO_KRYSTAL_LP_REBALANCE_TRIGGER_PCT ?? 10),
    evmRpcUrls: parseEvmRpcUrls(),

    kaminoBorrowLpEnabled: process.env.CFO_KAMINO_BORROW_LP_ENABLE === 'true',
    kaminoBorrowLpMaxUsd: Number(process.env.CFO_KAMINO_BORROW_LP_MAX_USD ?? 200),
    kaminoBorrowLpMinSpreadPct: Number(process.env.CFO_KAMINO_BORROW_LP_MIN_SPREAD_PCT ?? 5),
    kaminoBorrowLpMaxLtvPct: Number(process.env.CFO_KAMINO_BORROW_LP_MAX_LTV_PCT ?? 55),
    kaminoBorrowLpCapacityPct: Number(process.env.CFO_KAMINO_BORROW_LP_CAPACITY_PCT ?? 20),

    evmArbEnabled:          process.env.CFO_EVM_ARB_ENABLE === 'true',
    evmArbMinProfitUsdc:    Number(process.env.CFO_EVM_ARB_MIN_PROFIT_USDC ?? 2),
    evmArbMaxFlashUsd:      Number(process.env.CFO_EVM_ARB_MAX_FLASH_USD ?? 50_000),
    evmArbReceiverAddress:  process.env.CFO_EVM_ARB_RECEIVER_ADDRESS,
    evmArbScanIntervalMs:   Number(process.env.CFO_EVM_ARB_SCAN_INTERVAL_MS ?? 30_000),
    evmArbPoolRefreshMs:    Number(process.env.CFO_EVM_ARB_POOL_REFRESH_MS ?? 4 * 3600_000),

    maxJitoSol: Number(process.env.CFO_MAX_JITO_SOL ?? 5),

    lifiEnabled,
    maxBridgeUsd: Number(process.env.CFO_MAX_BRIDGE_USD ?? 200),

    x402PriceRugcheck: Number(process.env.CFO_X402_PRICE_RUGCHECK ?? 0.02),
    x402PriceSignal: Number(process.env.CFO_X402_PRICE_SIGNAL ?? 0.001),
    x402PriceTrend: Number(process.env.CFO_X402_PRICE_TREND ?? 0.10),
    x402PriceScoutDigest: Number(process.env.CFO_X402_PRICE_SCOUT_DIGEST ?? 0.05),
    x402PriceNarrativeShift: Number(process.env.CFO_X402_PRICE_NARRATIVE_SHIFT ?? 0.03),
    x402PriceLpPositions: Number(process.env.CFO_X402_PRICE_LP_POSITIONS ?? 0.05),
    x402BaseUrl: process.env.CFO_X402_BASE_URL ?? 'http://localhost:8787',

    heliusApiKey: process.env.CFO_HELIUS_API_KEY,

    pythEnabled,

    emergencyCooldownMinutes: Number(process.env.CFO_EMERGENCY_COOLDOWN_MINUTES ?? 240),
  };

  return _cached;
}
