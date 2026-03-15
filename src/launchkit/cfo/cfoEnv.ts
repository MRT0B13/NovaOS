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

  /** Arbitrum RPC — used for Hyperliquid + arb monitor */
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

  // ── Hyperliquid Perp Trading (signal-driven) ──────────────────────
  hlPerpTradingEnabled: boolean;                 // master switch for directional perp trades (default: false)
  hlPerpTradingCoins: string[];                  // coins eligible for perp trading (default: BTC,ETH,SOL)
  hlPerpMaxPositionUsd: number;                  // max single perp position size (default: 100)
  hlPerpMaxTotalUsd: number;                     // max total perp exposure (all coins combined, default: 300)
  hlPerpMaxPositions: number;                    // max simultaneous perp positions (default: 3)
  hlPerpDefaultLeverage: number;                 // default leverage for perp trades (default: 2)
  hlPerpStopLossPct: number;                     // default stop-loss % (default: 5)
  hlPerpTakeProfitPct: number;                   // default take-profit % (default: 10)
  hlPerpCooldownMs: number;                      // min time between perp trade decisions per coin (default: 4h)
  hlPerpMinConviction: number;                   // minimum conviction score to trade (0-1, default: 0.4)
  hlPerpNewsReactiveEnabled: boolean;            // Phase 3: enable news-reactive trades (default: false)
  hlPerpNewsMaxUsd: number;                      // max per-trade for news-reactive entries (default: 50)
  hlPerpNewsCooldownMs: number;                  // cooldown for news-reactive trades (default: 2h)

  // ── Hyperliquid Perp: Multi-Timeframe TA ──────────────────────────────
  hlPerpTaEnabled: boolean;                      // master switch for TA-driven perp entries (default: false)
  hlPerpScalpEnabled: boolean;                   // enable scalp style 5m/1h (default: true when TA on)
  hlPerpDayEnabled: boolean;                     // enable day-trade style 1h/1d (default: true when TA on)
  hlPerpSwingEnabled: boolean;                   // enable swing style 1d/1h (default: true when TA on)
  hlPerpScalpCooldownMs: number;                 // cooldown between scalp entries per coin (default: 10m)

  // ── Hyperliquid Perp: Session Activity Gate ──────────────────────────
  hlPerpSessionGateEnabled: boolean;              // volume-based session activity gate (default: true)
  hlPerpSessionQuietThreshold: number;            // activity score below which dampening applies (0-1, default: 0.30)

  // ── Hyperliquid Spot Trading ──────────────────────────────────────────
  hlSpotTradingEnabled: boolean;                 // master switch for spot trades (default: false)
  hlSpotTaEnabled: boolean;                      // enable TA-driven spot entries (default: true when spot on)
  hlSpotAccumulationEnabled: boolean;            // enable treasury accumulation mode (default: false)
  hlSpotMaxPositionUsd: number;                  // max single spot position (default: 200)
  hlSpotMaxTotalUsd: number;                     // max total spot exposure (default: 500)
  hlSpotMaxPositions: number;                    // max simultaneous spot positions (default: 5)
  hlSpotStopLossPct: number;                     // software SL % (default: 8 — wider than perps, no liq risk)
  hlSpotTakeProfitPct: number;                   // software TP % (default: 15)
  hlSpotCooldownMs: number;                      // cooldown between spot entries per coin (default: 4h)
  hlSpotMinConviction: number;                   // min conviction to trade (0-1, default: 0.4)
  hlSpotAccumulationCoins: string[];             // coins for treasury accumulation (default: HYPE,PURR — HL native tokens)
  hlSpotAccumulationMinConviction: number;       // lower bar for accumulation (default: 0.25)
  hlSpotAccumulationMaxPerCoin: number;          // max accumulation per coin (default: 300)

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
  orcaLpMaxPositions: number;                     // max concurrent Orca LP positions (default 3)
  orcaLpRiskTiers: Set<string>;                    // enabled risk tiers: low,medium,high (default: low,medium)

  // ── EVM Concentrated LP ──────────────────────────────────────────
  evmLpEnabled: boolean;                          // enable EVM LP (default false) — accepts CFO_KRYSTAL_LP_ENABLE as fallback
  evmLpMinUsd: number;                            // min USD to deploy (default 20) — skip if wallet balance below this
  evmLpMaxUsd: number;                            // max USD per position (default 200)
  evmLpMinTvlUsd: number;                         // min pool TVL filter (default 500000)
  evmLpMinApr7d: number;                          // min 7d APR filter (default 15)
  evmLpMaxPositions: number;                      // max concurrent EVM LP positions (default 3)
  evmLpRangeWidthTicks: number;                   // range width in ticks (default 300, ±150 ticks ≈ ±1.5%)
  evmLpRebalanceTriggerPct: number;               // rebalance when utilisation drops below X% (default 10)
  evmLpRiskTiers: Set<string>;                    // enabled risk tiers: low,medium,high (default: low,medium)
  evmLpOpenCooldownMs: number;                    // cooldown between EVM_LP_OPEN decisions (default 4h)
  evmRpcUrls: Record<number, string>;             // chainId → RPC URL mapping

  // ── Kamino-funded LP (borrow → LP → fees repay loan) ─────────────
  kaminoBorrowLpEnabled: boolean;                 // enable borrow-for-LP strategy (default false)
  kaminoBorrowLpMaxUsd: number;                   // max USD borrowed for LP (default 200 — conservative)
  kaminoBorrowLpMinSpreadPct: number;             // LP fee APY must beat borrow cost by this % (default 5)
  kaminoBorrowLpMaxLtvPct: number;                // won't borrow if post-borrow LTV exceeds this (default 55)
  kaminoBorrowLpCapacityPct: number;              // use at most X% of remaining borrow headroom (default 20)

  // ── AAVE-funded LP (EVM borrow → LP → fees repay loan) ─────────────
  aaveBorrowLpEnabled: boolean;                   // enable AAVE borrow-for-LP strategy (default false)
  aaveBorrowLpMaxUsd: number;                     // max USD borrowed for LP (default 200)
  aaveBorrowLpMinSpreadPct: number;               // LP fee APY must beat borrow cost by this % (default 5)
  aaveBorrowLpMaxLtvPct: number;                  // won't borrow if post-borrow LTV exceeds this (default 55)
  aaveBorrowLpCapacityPct: number;                // use at most X% of remaining borrow headroom (default 20)
  aaveBorrowLpChains: string;                     // comma-separated chains: "arbitrum,base" (default "arbitrum")

  // ── EVM Flash Arbitrage (multi-chain) ──────────────────────────────────
  evmArbEnabled: boolean;              // enable arb scanning + execution (default false)
  evmArbChains: string;                // comma-separated chain list: "arbitrum,base,polygon,optimism" (default "arbitrum")
  evmArbMinProfitUsdc: number;         // minimum net profit per trade in USD (default 2)
  evmArbMaxFlashUsd: number;           // max flash loan size in USD (default 50000)
  evmArbReceiverAddress: string | undefined;  // deployed ArbFlashReceiver contract address (Arbitrum)
  evmArbReceiverBase: string | undefined;     // ArbFlashReceiver on Base
  evmArbReceiverPolygon: string | undefined;  // ArbFlashReceiver on Polygon
  evmArbReceiverOptimism: string | undefined; // ArbFlashReceiver on Optimism
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
  x402PriceTrend: number;                         // USDC per trend report
  x402PriceScoutDigest: number;                   // USDC per scout digest
  x402PriceNarrativeShift: number;                // USDC per narrative shift report
  x402PriceLpPositions: number;                   // USDC per LP positions snapshot
  x402BaseUrl: string;                            // Nova's public API base URL

  // ── Helius ────────────────────────────────────────────────────────
  heliusApiKey: string | undefined;

  // ── Pyth ─────────────────────────────────────────────────────────
  pythEnabled: boolean;

  // ── Profit Reinvestment ──────────────────────────────────────────
  reinvestEnabled: boolean;                       // enable automatic profit reinvestment (default true)
  reinvestMinUsd: number;                         // min USD to trigger reinvestment (default 10)
  reinvestSweepIntervalH: number;                 // hours between accumulated-profit sweeps (default 0.5 = 30 min)
  reinvestPreferVolatile: boolean;                // bias reinvestment toward high-fee volatile pools (default true)

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

/** Free public RPCs for chains Alchemy doesn't support (or as fallback) */
const PUBLIC_FALLBACK_RPCS: Record<number, string> = {
  56:    'https://bsc-dataseed1.binance.org',                // BSC
  43114: 'https://avalanche-c-chain-rpc.publicnode.com',     // Avalanche
  250:   'https://rpc.ankr.com/fantom',                      // Fantom
  8453:  'https://mainnet.base.org',                         // Base
  1:     'https://eth.drpc.org',                             // Ethereum
  42161: 'https://arb1.arbitrum.io/rpc',                     // Arbitrum
  10:    'https://mainnet.optimism.io',                      // Optimism
  137:   'https://polygon-rpc.com',                          // Polygon
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
    maxHyperliquidLeverage: Math.min(10, Number(process.env.CFO_MAX_HYPERLIQUID_LEVERAGE ?? 3)),
    hlHedgeCoins: (process.env.CFO_HL_HEDGE_COINS ?? '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    hlHedgeMinExposureUsd: Number(process.env.CFO_HL_HEDGE_MIN_EXPOSURE_USD ?? 50),

    // Perp trading (signal-driven)
    hlPerpTradingEnabled: process.env.CFO_HL_PERP_TRADING_ENABLE === 'true',
    hlPerpTradingCoins: (process.env.CFO_HL_PERP_TRADING_COINS ?? 'BTC,ETH,SOL')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    hlPerpMaxPositionUsd: Number(process.env.CFO_HL_PERP_MAX_POSITION_USD ?? 100),
    hlPerpMaxTotalUsd: Number(process.env.CFO_HL_PERP_MAX_TOTAL_USD ?? 300),
    hlPerpMaxPositions: Number(process.env.CFO_HL_PERP_MAX_POSITIONS ?? 3),
    hlPerpDefaultLeverage: Math.min(10, Number(process.env.CFO_HL_PERP_DEFAULT_LEVERAGE ?? 2)),
    hlPerpStopLossPct: Number(process.env.CFO_HL_PERP_STOP_LOSS_PCT ?? 5),
    hlPerpTakeProfitPct: Number(process.env.CFO_HL_PERP_TAKE_PROFIT_PCT ?? 10),
    hlPerpCooldownMs: Number(process.env.CFO_HL_PERP_COOLDOWN_HOURS ?? 4) * 3600_000,
    hlPerpMinConviction: Math.max(0, Math.min(1, Number(process.env.CFO_HL_PERP_MIN_CONVICTION ?? 0.4))),
    hlPerpNewsReactiveEnabled: process.env.CFO_HL_PERP_NEWS_ENABLE === 'true',
    hlPerpNewsMaxUsd: Number(process.env.CFO_HL_PERP_NEWS_MAX_USD ?? 50),
    hlPerpNewsCooldownMs: Number(process.env.CFO_HL_PERP_NEWS_COOLDOWN_HOURS ?? 2) * 3600_000,

    // Multi-timeframe TA
    hlPerpTaEnabled: process.env.CFO_HL_PERP_TA_ENABLE === 'true',
    hlPerpScalpEnabled: process.env.CFO_HL_PERP_SCALP_ENABLE !== 'false',   // default ON when TA enabled
    hlPerpDayEnabled: process.env.CFO_HL_PERP_DAY_ENABLE !== 'false',
    hlPerpSwingEnabled: process.env.CFO_HL_PERP_SWING_ENABLE !== 'false',
    hlPerpScalpCooldownMs: Number(process.env.CFO_HL_PERP_SCALP_COOLDOWN_MIN ?? 10) * 60_000,

    // Session activity gate
    hlPerpSessionGateEnabled: process.env.CFO_HL_PERP_SESSION_GATE_ENABLE !== 'false', // default ON
    hlPerpSessionQuietThreshold: Math.max(0, Math.min(1, Number(process.env.CFO_HL_PERP_SESSION_QUIET_THRESHOLD ?? 0.30))),

    // Spot trading (accept both ENABLE and ENABLED suffixes)
    hlSpotTradingEnabled: (process.env.CFO_HL_SPOT_TRADING_ENABLED ?? process.env.CFO_HL_SPOT_TRADING_ENABLE) === 'true',
    hlSpotTaEnabled: (process.env.CFO_HL_SPOT_TA_ENABLED ?? process.env.CFO_HL_SPOT_TA_ENABLE) !== 'false',        // default ON when spot enabled
    hlSpotAccumulationEnabled: (process.env.CFO_HL_SPOT_ACCUMULATION_ENABLED ?? process.env.CFO_HL_SPOT_ACCUMULATION_ENABLE) === 'true',
    hlSpotMaxPositionUsd: Number(process.env.CFO_HL_SPOT_MAX_POSITION_USD ?? 200),
    hlSpotMaxTotalUsd: Number(process.env.CFO_HL_SPOT_MAX_TOTAL_USD ?? 500),
    hlSpotMaxPositions: Number(process.env.CFO_HL_SPOT_MAX_POSITIONS ?? 5),
    hlSpotStopLossPct: Number(process.env.CFO_HL_SPOT_STOP_LOSS_PCT ?? 8),
    hlSpotTakeProfitPct: Number(process.env.CFO_HL_SPOT_TAKE_PROFIT_PCT ?? 15),
    hlSpotCooldownMs: Number(process.env.CFO_HL_SPOT_COOLDOWN_HOURS ?? 4) * 3600_000,
    hlSpotMinConviction: Math.max(0, Math.min(1, Number(process.env.CFO_HL_SPOT_MIN_CONVICTION ?? 0.4))),
    hlSpotAccumulationCoins: (process.env.CFO_HL_SPOT_ACCUMULATION_COINS ?? 'HYPE,PURR')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    hlSpotAccumulationMinConviction: Math.max(0, Math.min(1, Number(process.env.CFO_HL_SPOT_ACCUMULATION_MIN_CONVICTION ?? 0.25))),
    hlSpotAccumulationMaxPerCoin: Number(process.env.CFO_HL_SPOT_ACCUMULATION_MAX_PER_COIN ?? 300),

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
    orcaLpRangeWidthPct: Number(process.env.CFO_ORCA_LP_RANGE_WIDTH_PCT ?? 15),  // tightened from 20% for better fee capture
    orcaLpMaxUsd: Number(process.env.CFO_ORCA_LP_MAX_USD ?? 500),
    orcaLpRebalanceTriggerPct: Number(process.env.CFO_ORCA_LP_REBALANCE_TRIGGER_PCT ?? 5),
    orcaLpMaxPositions: Number(process.env.CFO_ORCA_LP_MAX_POSITIONS ?? 3),
    orcaLpRiskTiers: new Set(
      (process.env.CFO_ORCA_LP_RISK_TIERS ?? 'low,medium,high')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    ),

    evmLpEnabled: (process.env.CFO_EVM_LP_ENABLE ?? process.env.CFO_KRYSTAL_LP_ENABLE) === 'true',
    evmLpMinUsd: Number(process.env.CFO_EVM_LP_MIN_USD ?? 20),
    evmLpMaxUsd: Number(process.env.CFO_EVM_LP_MAX_USD ?? process.env.CFO_KRYSTAL_LP_MAX_USD ?? 200),
    evmLpMinTvlUsd: Number(process.env.CFO_EVM_LP_MIN_TVL_USD ?? process.env.CFO_KRYSTAL_LP_MIN_TVL_USD ?? 500_000),
    evmLpMinApr7d: Number(process.env.CFO_EVM_LP_MIN_APR_7D ?? process.env.CFO_KRYSTAL_LP_MIN_APR_7D ?? 15),
    evmLpMaxPositions: Number(process.env.CFO_EVM_LP_MAX_POSITIONS ?? process.env.CFO_KRYSTAL_LP_MAX_POSITIONS ?? 3),
    evmLpRangeWidthTicks: Number(process.env.CFO_EVM_LP_RANGE_WIDTH_TICKS ?? process.env.CFO_KRYSTAL_LP_RANGE_WIDTH_TICKS ?? 300),
    evmLpRebalanceTriggerPct: Number(process.env.CFO_EVM_LP_REBALANCE_TRIGGER_PCT ?? process.env.CFO_KRYSTAL_LP_REBALANCE_TRIGGER_PCT ?? 10),
    evmLpRiskTiers: new Set(
      (process.env.CFO_EVM_LP_RISK_TIERS ?? process.env.CFO_KRYSTAL_LP_RISK_TIERS ?? 'low,medium,high')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    ),
    evmLpOpenCooldownMs: Number(process.env.CFO_EVM_LP_OPEN_COOLDOWN_HOURS ?? process.env.CFO_KRYSTAL_LP_OPEN_COOLDOWN_HOURS ?? 4) * 3600_000,
    evmRpcUrls: parseEvmRpcUrls(),

    kaminoBorrowLpEnabled: process.env.CFO_KAMINO_BORROW_LP_ENABLE === 'true',
    kaminoBorrowLpMaxUsd: Number(process.env.CFO_KAMINO_BORROW_LP_MAX_USD ?? 200),
    kaminoBorrowLpMinSpreadPct: Number(process.env.CFO_KAMINO_BORROW_LP_MIN_SPREAD_PCT ?? 5),
    kaminoBorrowLpMaxLtvPct: Number(process.env.CFO_KAMINO_BORROW_LP_MAX_LTV_PCT ?? 55),
    kaminoBorrowLpCapacityPct: Number(process.env.CFO_KAMINO_BORROW_LP_CAPACITY_PCT ?? 20),

    aaveBorrowLpEnabled: process.env.CFO_AAVE_BORROW_LP_ENABLE === 'true',
    aaveBorrowLpMaxUsd: Number(process.env.CFO_AAVE_BORROW_LP_MAX_USD ?? 200),
    aaveBorrowLpMinSpreadPct: Number(process.env.CFO_AAVE_BORROW_LP_MIN_SPREAD_PCT ?? 5),
    aaveBorrowLpMaxLtvPct: Number(process.env.CFO_AAVE_BORROW_LP_MAX_LTV_PCT ?? 55),
    aaveBorrowLpCapacityPct: Number(process.env.CFO_AAVE_BORROW_LP_CAPACITY_PCT ?? 20),
    aaveBorrowLpChains: process.env.CFO_AAVE_BORROW_LP_CHAINS ?? 'arbitrum',

    evmArbEnabled:          process.env.CFO_EVM_ARB_ENABLE === 'true',
    evmArbChains:           process.env.CFO_EVM_ARB_CHAINS ?? 'arbitrum',
    evmArbMinProfitUsdc:    Number(process.env.CFO_EVM_ARB_MIN_PROFIT_USDC ?? 2),
    evmArbMaxFlashUsd:      Number(process.env.CFO_EVM_ARB_MAX_FLASH_USD ?? 50_000),
    evmArbReceiverAddress:  process.env.CFO_EVM_ARB_RECEIVER_ADDRESS,
    evmArbReceiverBase:     process.env.CFO_EVM_ARB_RECEIVER_BASE,
    evmArbReceiverPolygon:  process.env.CFO_EVM_ARB_RECEIVER_POLYGON,
    evmArbReceiverOptimism: process.env.CFO_EVM_ARB_RECEIVER_OPTIMISM,
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

    // ── Profit Reinvestment ──
    reinvestEnabled: process.env.CFO_REINVEST_ENABLE !== 'false',            // default ON
    reinvestMinUsd: Number(process.env.CFO_REINVEST_MIN_USD ?? 10),
    reinvestSweepIntervalH: Number(process.env.CFO_REINVEST_SWEEP_INTERVAL_H ?? 0.5),
    reinvestPreferVolatile: process.env.CFO_REINVEST_PREFER_VOLATILE !== 'false', // default ON

    emergencyCooldownMinutes: Number(process.env.CFO_EMERGENCY_COOLDOWN_MINUTES ?? 240),
  };

  return _cached!;
}
