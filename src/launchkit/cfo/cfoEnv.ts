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

  // ── Kamino ────────────────────────────────────────────────────────
  maxKaminoUsd: number;
  kaminoMaxLtvPct: number;                        // never borrow above this LTV (default 60)

  // ── Jito ─────────────────────────────────────────────────────────
  maxJitoSol: number;                             // max SOL to stake in Jito

  // ── Wormhole / LI.FI ─────────────────────────────────────────────
  lifiEnabled: boolean;
  maxBridgeUsd: number;

  // ── x402 Micropayments ────────────────────────────────────────────
  x402PriceRugcheck: number;                      // USDC per rug-check report
  x402PriceSignal: number;                        // USDC per KOL signal
  x402PriceTrend: number;                         // USDC per trend report
  x402BaseUrl: string;                            // Nova's public API base URL

  // ── Helius ────────────────────────────────────────────────────────
  heliusApiKey: string | undefined;

  // ── Pyth ─────────────────────────────────────────────────────────
  pythEnabled: boolean;
}

// ── Validation helpers ────────────────────────────────────────────

function isValidEvmKey(key: string | undefined): boolean {
  return !!key && key.startsWith('0x') && key.length === 66;
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

    maxKaminoUsd: Number(process.env.CFO_MAX_KAMINO_USD ?? 1000),
    kaminoMaxLtvPct: Number(process.env.CFO_KAMINO_MAX_LTV_PCT ?? 60),

    maxJitoSol: Number(process.env.CFO_MAX_JITO_SOL ?? 5),

    lifiEnabled,
    maxBridgeUsd: Number(process.env.CFO_MAX_BRIDGE_USD ?? 200),

    x402PriceRugcheck: Number(process.env.CFO_X402_PRICE_RUGCHECK ?? 0.02),
    x402PriceSignal: Number(process.env.CFO_X402_PRICE_SIGNAL ?? 0.001),
    x402PriceTrend: Number(process.env.CFO_X402_PRICE_TREND ?? 0.10),
    x402BaseUrl: process.env.CFO_X402_BASE_URL ?? 'http://localhost:8787',

    heliusApiKey: process.env.CFO_HELIUS_API_KEY,

    pythEnabled,
  };

  return _cached;
}
