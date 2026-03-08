/**
 * CFO Decision Engine — Autonomous Financial Brain
 *
 * The CFO doesn't wait for orders. It reads the portfolio, consults the swarm,
 * assesses risk, and makes financial decisions autonomously — then reports back.
 *
 * Decision loop (runs every CFO_DECISION_INTERVAL minutes):
 *
 *   1. GATHER  — snapshot portfolio: SOL balance, prices, HL positions, Jito, Kamino
 *   2. CONSULT — read latest intel from Scout, Guardian, Analyst agents
 *   3. ASSESS  — score risk (SOL exposure, concentration, liquidation proximity)
 *   4. DECIDE  — select actions from the rule set + apply approval tier
 *   5. EXECUTE — auto-execute low/medium, queue high-value for admin approval
 *   6. REPORT  — send results to supervisor + admin Telegram
 *
 * Approval Tiers:
 *   AUTO     — small/safe: execute immediately, log to audit trail
 *   NOTIFY   — medium: execute immediately, notify admin after
 *   APPROVAL — large/risky: queue for admin approval, do NOT execute until approved
 *
 * Tier thresholds (configurable via env):
 *   AUTO     < CFO_AUTO_TIER_USD     (default: $50)
 *   NOTIFY   < CFO_NOTIFY_TIER_USD   (default: $200)
 *   APPROVAL >= CFO_NOTIFY_TIER_USD  (or high-risk conditions)
 *
 * Inter-Agent Intelligence:
 *   - Scout: market sentiment, narrative shifts, bullish/bearish signal
 *   - Guardian: safety alerts, rug warnings, critical threats
 *   - Analyst: DeFi TVL changes, volume spikes, price alerts
 *   All intel influences hedge aggressiveness and stake decisions.
 *
 * Safety:
 *   - All trades gated by PositionManager exposure caps
 *   - CFO_DRY_RUN=true → log decisions without executing
 *   - CFO_AUTO_HEDGE=false → skip hedge decisions entirely
 *   - Max 3 decisions per cycle to prevent runaway loops
 *   - Cooldown between same-type decisions (hedge: 4h, stake: 6h, close: 1h)
 */

import { logger } from '@elizaos/core';
import { getCFOEnv, type CFOEnv } from './cfoEnv.ts';
import { refreshLearning, getAdaptiveParams, applyAdaptive, formatLearningSummary, setLearningPool, type AdaptiveParams } from './learningEngine.ts';
import * as swapSvc from './evmSwapService.ts';
import type { TradeStyle, MTFSignal } from './hlTechnicalAnalysis.ts';

// ============================================================================
// TA trade style tracker (in-memory — survives across cycles but not restarts)
// Key: "COIN-SIDE" e.g. "BTC-LONG", Value: { style, openedAt }
// Used by exit logic to apply style-specific SL/TP and hold-duration limits.
// ============================================================================
const _perpTradeStyles = new Map<string, { style: TradeStyle; openedAt: string }>();

/** Expose tracked trade styles for the lightweight scalp exit monitor in cfo.ts */
export function getTrackedTradeStyles(): Map<string, { style: TradeStyle; openedAt: string }> {
  return new Map(_perpTradeStyles);
}

/** Remove a tracked trade style after the position is closed (from scalp monitor or external close) */
export function clearTradeStyle(key: string): void {
  _perpTradeStyles.delete(key);
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maps SOL LST (Liquid Staking Token) symbols to their underlying HL-tradeable asset.
 * During treasury enrichment, LSTs are folded into the underlying entry so the hedge
 * engine sees combined SOL-equivalent exposure and hedges via SOL-PERP (not JITOSOL-PERP
 * which doesn't exist on Hyperliquid).
 */
const SOL_LST_UNDERLYING: Record<string, string> = {
  JITOSOL: 'SOL',
  MSOL: 'SOL',
  BSOL: 'SOL',
  JUPSOL: 'SOL',
  VSOL: 'SOL',
  HUBSOL: 'SOL',
  COMPASSSOL: 'SOL',
  INFINITYSOL: 'SOL',
  BONKSOL: 'SOL',
  LAINESOL: 'SOL',
  EDGESOL: 'SOL',
  PATHSOL: 'SOL',
};

// ============================================================================
// Types
// ============================================================================

export type DecisionType =
  | 'OPEN_HEDGE'       // SHORT any coin on HL to protect treasury
  | 'CLOSE_HEDGE'      // close or reduce a hedge position
  | 'AUTO_STAKE'       // stake idle SOL into Jito
  | 'UNSTAKE_JITO'     // pull SOL out of Jito for runway
  | 'CLOSE_LOSING'     // close HL position hitting stop-loss
  | 'REBALANCE_HEDGE'  // adjust hedge size to match current SOL exposure
  | 'POLY_BET'         // place a Polymarket prediction bet
  | 'POLY_EXIT'        // exit a Polymarket position (stop-loss / expiry)
  | 'KAMINO_BORROW_DEPLOY'   // borrow USDC from Kamino and deploy into yield opportunity
  | 'KAMINO_REPAY'           // repay Kamino borrow (scheduled, or LTV rising)
  | 'KAMINO_JITO_LOOP'       // JitoSOL/SOL Multiply — leverage staking yield 2-3x
  | 'KAMINO_JITO_UNWIND'     // unwind the JitoSOL loop (SOL borrow + JitoSOL position)
  | 'KAMINO_LST_LOOP'        // Generic LST/SOL Multiply — best-spread among JitoSOL/mSOL/bSOL
  | 'KAMINO_LST_UNWIND'      // unwind a generic LST loop
  | 'KAMINO_MULTIPLY_VAULT'  // deposit into a Kamino Multiply vault (managed auto-leverage)
  | 'ORCA_LP_OPEN'           // open a new concentrated LP position
  | 'ORCA_LP_REBALANCE'      // close out-of-range position and reopen centred on new price
  | 'ORCA_LP_CLOSE'          // close Orca LP position without reopening (capital withdrawal)
  | 'ORCA_LP_CLAIM_FEES'     // collect accumulated fees from Orca LP positions (without closing)
  | 'KAMINO_BORROW_LP'       // borrow from Kamino → swap → open Orca LP, fees repay loan
  | 'EVM_FLASH_ARB'          // Arbitrum: atomic flash loan arb via Aave v3 + DEX spread
  | 'KRYSTAL_LP_OPEN'        // open EVM concentrated LP via Krystal-discovered pool
  | 'KRYSTAL_LP_INCREASE'    // add liquidity to an existing EVM LP position (avoid duplicate mints)
  | 'KRYSTAL_LP_REBALANCE'   // close + reopen out-of-range EVM LP (closeOnly=true → just close)
  | 'KRYSTAL_LP_CLAIM_FEES'  // collect accumulated fees from EVM LP positions
  | 'EVM_BRIDGE'             // bridge tokens between EVM chains (via LI.FI)
  | 'EVM_SWAP'               // same-chain token swap on EVM (via Uniswap V3 / LI.FI)
  | 'HL_PERP_OPEN'           // open a directional perp trade (LONG or SHORT) based on signals
  | 'HL_PERP_CLOSE'          // close an existing perp trade (TP/SL hit or signal reversed)
  | 'HL_PERP_NEWS'           // news-reactive perp trade (fast entry, tight stops)
  | 'SKIP';            // no action taken (for logging)

/** Approval tier determines whether CFO executes immediately or waits for admin */
export type ApprovalTier = 'AUTO' | 'NOTIFY' | 'APPROVAL';

export interface Decision {
  type: DecisionType;
  reasoning: string;        // human-readable explanation
  params: Record<string, any>;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  estimatedImpactUsd: number;
  tier: ApprovalTier;       // how this decision gets gated
  intelUsed: string[];      // which agent intel influenced this decision
}

export interface DecisionResult {
  decision: Decision;
  executed: boolean;
  success: boolean;
  txId?: string;
  error?: string;
  receivedUsd?: number;       // actual USD received (for sell/exit operations)
  hlUnrealizedPnl?: number;  // HL exchange ground-truth PnL (for perp closes)
  dryRun: boolean;
  pendingApproval?: boolean;  // true if queued for admin approval
  traceId?: string;           // correlation ID linking all decisions in one cycle
}

// ============================================================================
// Inter-Agent Intelligence
// ============================================================================

/** Intel gathered from other agents in the swarm */
export interface SwarmIntel {
  // From Scout (narrative/sentiment)
  scoutBullish?: boolean;             // market sentiment from scout
  scoutNarratives?: string[];         // trending narratives
  scoutConfidence?: number;           // 0-1 confidence in sentiment reading
  scoutReceivedAt?: number;

  // From Guardian (safety/risk)
  guardianAlerts?: string[];          // active safety warnings
  guardianCritical?: boolean;         // any critical threats active?
  guardianReceivedAt?: number;
  // Enriched watchlist data (from broadcastWatchlistSnapshot)
  guardianTokens?: Array<{
    mint: string;
    ticker: string;
    priceUsd: number;
    liquidityUsd: number;
    volume24h: number;
    rugScore: number | null;
    safe: boolean;
  }>;
  guardianSnapshotAt?: number;

  // From Analyst (DeFi data)
  analystSolanaTvl?: number;          // Solana ecosystem TVL
  analystVolumeSpike?: boolean;       // significant volume increase?
  analystPriceAlert?: string;         // price movement summary
  analystReceivedAt?: number;
  // Enriched token price intel (from broadcastTokenIntel)
  analystPrices?: Record<string, { usd: number; change24h: number }>;
  analystMovers?: Array<{ symbol: string; usd: number; change24hPct: number }>;
  analystTrending?: string[];         // CoinGecko trending tickers
  analystPricesAt?: number;
  analystArbitrumVolume24h?: number;  // Arbitrum DEX 24h volume USD (DeFiLlama via Analyst)

  // From Analyst — Krystal EVM LP opportunities
  analystEvmLpOpportunities?: any[];  // top Krystal pools from analyst
  analystEvmLpAt?: number;

  // Composite score (computed)
  riskMultiplier: number;             // 0.5 (bullish) to 2.0 (danger) — scales hedge aggressiveness
  marketCondition: 'bullish' | 'neutral' | 'bearish' | 'danger';
}

export interface PortfolioState {
  // Solana
  solBalance: number;             // SOL in funding wallet
  solPriceUsd: number;
  solExposureUsd: number;         // ALL SOL-correlated exposure: raw SOL + JitoSOL + other LSTs
  solanaUsdcBalance: number;       // USDC available in Solana funding wallet
  jitoSolBalance: number;
  jitoSolValueUsd: number;

  // Multi-LST balances (wallet token balances, not Kamino deposits)
  lstBalances: Record<string, { balance: number; valueUsd: number }>; // JitoSOL, mSOL, bSOL

  // Hyperliquid
  hlEquity: number;
  hlAvailableMargin: number;
  hlPositions: Array<{
    coin: string;
    side: 'LONG' | 'SHORT';
    sizeUsd: number;
    unrealizedPnlUsd: number;
    leverage: number;
    liquidationPrice: number;
    markPrice: number;
    marginUsed: number;
  }>;
  hlTotalShortUsd: number;        // total SHORT USD across ALL hedged coins on HL
  hlTotalPnl: number;

  // Polymarket
  polyDeployedUsd: number;        // total USDC in Polymarket positions
  polyHeadroomUsd: number;        // how much more USDC we can deploy
  polyPositionCount: number;
  polyUsdcBalance: number;        // USDC available on Polygon
  polyPositions: Array<{          // individual Polymarket bets
    question: string;
    outcome: string;
    costBasisUsd: number;
    currentValueUsd: number;
    unrealizedPnlUsd: number;
    currentPrice: number;
  }>;

  // Computed
  totalPortfolioUsd: number;
  hedgeRatio: number;             // hlTotalShortUsd / totalHedgeableUsd (0 = unhedged, 1 = fully hedged)
  idleSolForStaking: number;      // SOL above reserve that could be staked
  timestamp: number;

  // Treasury token exposures (dynamic — all wallet tokens with prices)
  treasuryExposures: Array<{
    symbol: string;       // HL coin name (e.g. 'SOL', 'JUP', 'WIF')
    mint: string;         // Solana mint address
    balance: number;      // token units
    valueUsd: number;     // balance * price
    hlListed: boolean;    // true if tradeable as perp on HL
  }>;

  // Kamino lending state
  kaminoDepositValueUsd: number;     // total deposited collateral value
  kaminoBorrowValueUsd: number;      // total outstanding borrows
  kaminoNetValueUsd: number;         // deposit - borrow (net equity in Kamino)
  kaminoLtv: number;                 // current LTV (0-1)
  kaminoHealthFactor: number;        // health factor (>1.5 is safe, <1.2 is danger)
  kaminoBorrowApy: number;           // current USDC borrow APY
  kaminoSolBorrowApy: number;        // SOL borrow APY (for JitoSOL loop profitability)
  kaminoJitoSupplyApy: number;       // JitoSOL supply APY (for loop profitability check)
  kaminoUsdcSupplyApy: number;       // USDC supply APY (for simple loop deploy yield)
  kaminoSupplyApy: number;           // current USDC supply APY (legacy alias)
  kaminoBorrowableUsd: number;       // how much more we can borrow at max LTV
  kaminoJitoLoopActive: boolean;     // true when JitoSOL deposits + SOL borrows are both present
  kaminoJitoLoopApy: number;         // estimated current loop APY (0 if loop not active)
  kaminoActiveLstLoop: string | null; // which LST is in an active loop ('JitoSOL', 'mSOL', 'bSOL', or null)

  // Kamino Multiply Vault state
  kaminoMultiplyVaults: Array<{
    name: string;
    collateralToken: string;
    apy: number;
    tvl: number;
    leverage: number;
    address: string;
  }>;

  // Orca concentrated LP state
  orcaLpValueUsd: number;            // total value in Orca LP positions
  orcaLpFeeApy: number;              // estimated fee APY on current LP positions
  orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean; whirlpoolAddress?: string; riskTier?: string; tokenA?: string; tokenB?: string; valueUsd?: number; feesUsd?: number }>;

  // EVM Flash Arb state
  evmArbProfit24h: number;        // confirmed flash arb profit last 24h (in-memory)
  evmArbPoolCount: number;        // number of candidate pools currently tracked
  evmArbUsdcBalance: number;      // native USDC on Arbitrum (in EVM wallet)

  // Krystal EVM LP state
  evmLpPositions: Array<{
    posId: string;
    chainName: string;
    chainNumericId: number;
    protocol: string; // e.g. 'Uniswap V3', 'PancakeSwap V3', 'Aerodrome Concentrated'
    poolAddress: string;
    token0Symbol: string;
    token1Symbol: string;
    token0Address: string;
    token1Address: string;
    token0Decimals: number;
    token1Decimals: number;
    valueUsd: number;
    inRange: boolean;
    rangeUtilisationPct: number;
    feesOwedUsd: number;
    openedAt: number;
  }>;
  evmLpTotalValueUsd: number;     // total value in EVM LP positions
  evmLpTotalFeesUsd: number;      // total uncollected fees across positions

  // Multi-chain EVM balances (scanned from configured chains)
  evmChainBalances: Array<{
    chainId: number;
    chainName: string;
    usdcBalance: number;
    usdcBridgedBalance: number;
    usdtBalance: number;
    totalStableUsd: number;
    wethBalance: number;
    wethValueUsd: number;
    nativeBalance: number;
    nativeSymbol: string;
    nativeValueUsd: number;
    totalValueUsd: number;
  }>;
  evmTotalUsdcAllChains: number;   // sum of all stablecoins across EVM chains
  evmTotalNativeAllChains: number; // sum of native + WETH USD value across all chains
}

// ============================================================================
// Config (from env)
// ============================================================================

export interface DecisionConfig {
  enabled: boolean;           // CFO_AUTO_DECISIONS
  intervalMinutes: number;    // CFO_DECISION_INTERVAL (default: 30)

  // Approval tier thresholds
  autoTierMaxUsd: number;             // below this: execute silently (default: $50)
  notifyTierMaxUsd: number;           // below this: execute + notify admin (default: $200)
  // >= notifyTierMaxUsd or high-risk: APPROVAL required
  approvalExpiryMinutes: number;      // how long before queued approval expires (default: 30)
  criticalBypassApproval: boolean;    // true = critical urgency executes immediately (stop-loss, liquidation)

  // Hedge thresholds
  autoHedge: boolean;                   // CFO_AUTO_HEDGE
  hedgeTargetRatio: number;             // target hedge ratio (default: 0.50 = hedge 50% of SOL)
  hedgeMinSolExposureUsd: number;       // don't bother hedging below this (default: 100)
  hedgeRebalanceThreshold: number;      // rebalance if actual ratio drifts >X from target (default: 0.15)

  // Staking
  autoStake: boolean;                   // CFO_AUTO_STAKE
  stakeReserveSol: number;              // keep this much SOL unstaked for gas + launches (default: 0.5)
  stakeMinAmountSol: number;            // minimum SOL to stake in one go (default: 0.1)

  // Stop-loss
  hlStopLossPct: number;               // close HL position if loss > X% of margin (default: 25)
  hlLiquidationWarningPct: number;      // alert + close if within X% of liquidation (default: 15)

  // Polymarket
  autoPolymarket: boolean;              // CFO_AUTO_POLYMARKET (default: true if polymarket enabled)
  polyBetCooldownMs: number;            // min time between new bets (default: 2h)

  // Rate limits
  maxDecisionsPerCycle: number;         // (default: 3)
  hedgeCooldownMs: number;              // min time between hedge decisions (default: 4h)
  stakeCooldownMs: number;              // min time between stake decisions (default: 6h)
  closeCooldownMs: number;              // min time between close decisions (default: 1h)

  // Perp trading (signal-driven)
  hlPerpTradingEnabled: boolean;        // master switch for HL perp trading
  hlPerpMinConviction: number;          // min conviction score to trade (0-1, default: 0.4)
  hlPerpCooldownMs: number;             // min time between perp trades per coin
  hlPerpNewsEnabled: boolean;           // enable news-reactive perp trades
  hlPerpNewsCooldownMs: number;         // cooldown for news-reactive trades

  // Multi-timeframe TA
  hlPerpTaEnabled: boolean;             // master switch for TA-driven entries
  hlPerpScalpEnabled: boolean;          // enable scalp style (5m/1h)
  hlPerpDayEnabled: boolean;            // enable day style (1h/1d)
  hlPerpSwingEnabled: boolean;          // enable swing style (1d/1h)
  hlPerpScalpCooldownMs: number;        // cooldown for scalp entries per coin
}

export function getDecisionConfig(): DecisionConfig {
  return {
    enabled:                    process.env.CFO_AUTO_DECISIONS === 'true',
    intervalMinutes:            Number(process.env.CFO_DECISION_INTERVAL ?? 30),
    autoTierMaxUsd:             Number(process.env.CFO_AUTO_TIER_USD ?? 50),
    notifyTierMaxUsd:           Number(process.env.CFO_NOTIFY_TIER_USD ?? 200),
    approvalExpiryMinutes:      Number(process.env.CFO_APPROVAL_EXPIRY_MINUTES ?? 30),
    criticalBypassApproval:     process.env.CFO_CRITICAL_BYPASS_APPROVAL !== 'false', // default ON
    autoHedge:                  process.env.CFO_AUTO_HEDGE !== 'false',  // default ON when auto_decisions on
    hedgeTargetRatio:           Number(process.env.CFO_HEDGE_TARGET_RATIO ?? 0.50),
    hedgeMinSolExposureUsd:     Number(process.env.CFO_HEDGE_MIN_SOL_USD ?? 100),
    hedgeRebalanceThreshold:    Number(process.env.CFO_HEDGE_REBALANCE_THRESHOLD ?? 0.15),
    autoStake:                  process.env.CFO_AUTO_STAKE !== 'false',
    stakeReserveSol:            Number(process.env.CFO_STAKE_RESERVE_SOL ?? 0.5),
    stakeMinAmountSol:          Number(process.env.CFO_STAKE_MIN_SOL ?? 0.1),
    hlStopLossPct:              Number(process.env.CFO_HL_STOP_LOSS_PCT ?? 25),
    hlLiquidationWarningPct:    Number(process.env.CFO_HL_LIQUIDATION_WARNING_PCT ?? 15),
    autoPolymarket:             process.env.CFO_AUTO_POLYMARKET !== 'false', // default ON when polymarket enabled
    polyBetCooldownMs:          Number(process.env.CFO_POLY_BET_COOLDOWN_HOURS ?? 2) * 3600_000,
    maxDecisionsPerCycle:       Number(process.env.CFO_MAX_DECISIONS_PER_CYCLE ?? 3),
    hedgeCooldownMs:            Number(process.env.CFO_HEDGE_COOLDOWN_HOURS ?? 4) * 3600_000,
    stakeCooldownMs:            Number(process.env.CFO_STAKE_COOLDOWN_HOURS ?? 6) * 3600_000,
    closeCooldownMs:            Number(process.env.CFO_CLOSE_COOLDOWN_HOURS ?? 1) * 3600_000,

    // Perp trading (reads from env via cfoEnv)
    hlPerpTradingEnabled:       process.env.CFO_HL_PERP_TRADING_ENABLE === 'true',
    hlPerpMinConviction:        Math.max(0, Math.min(1, Number(process.env.CFO_HL_PERP_MIN_CONVICTION ?? 0.4))),
    hlPerpCooldownMs:           Number(process.env.CFO_HL_PERP_COOLDOWN_HOURS ?? 4) * 3600_000,
    hlPerpNewsEnabled:          process.env.CFO_HL_PERP_NEWS_ENABLE === 'true',
    hlPerpNewsCooldownMs:       Number(process.env.CFO_HL_PERP_NEWS_COOLDOWN_HOURS ?? 2) * 3600_000,

    // Multi-timeframe TA
    hlPerpTaEnabled:            process.env.CFO_HL_PERP_TA_ENABLE === 'true',
    hlPerpScalpEnabled:         process.env.CFO_HL_PERP_SCALP_ENABLE !== 'false',
    hlPerpDayEnabled:           process.env.CFO_HL_PERP_DAY_ENABLE !== 'false',
    hlPerpSwingEnabled:         process.env.CFO_HL_PERP_SWING_ENABLE !== 'false',
    hlPerpScalpCooldownMs:      Number(process.env.CFO_HL_PERP_SCALP_COOLDOWN_MIN ?? 10) * 60_000,
  };
}

// ============================================================================
// Cooldown tracker
// ============================================================================

const lastDecisionAt: Record<string, number> = {};

/**
 * Dry-run cooldown: shorter (2h) to prevent immediate repeats without
 * going silent for the full 24h production cooldown window.
 */
const _dryRunCooldowns: Record<string, number> = {};
const DRY_RUN_COOLDOWN_MS = 2 * 3600_000; // 2 hours

function checkCooldown(type: string, cooldownMs: number): boolean {
  const last = lastDecisionAt[type] ?? 0;
  if (Date.now() - last < cooldownMs) return false;

  // Also check dry-run cooldowns (shorter window)
  const dryLast = _dryRunCooldowns[type] ?? 0;
  if (Date.now() - dryLast < DRY_RUN_COOLDOWN_MS) return false;

  return true;
}

function markDecision(type: string): void {
  lastDecisionAt[type] = Date.now();
}

/**
 * Track recently selected LP pairs for diversity rotation.
 * Key = whirlpoolAddress, value = timestamp when last selected.
 * Any pair selected within RECENCY_WINDOW gets a score penalty so
 * the agent naturally rotates through different pools each cycle.
 */
const RECENCY_WINDOW_MS = 72 * 3600_000; // 72 hours
const RECENCY_PENALTY  = 25;             // points deducted for recently-selected pairs

const _lpPairLastSelected: Record<string, number> = {};

/** Record that a pair was selected this cycle */
export function markLpPairSelected(whirlpoolAddress: string): void {
  _lpPairLastSelected[whirlpoolAddress] = Date.now();
}

/** Get recency penalty — RECENCY_PENALTY if selected within the window, 0 otherwise */
export function getLpRecencyPenalty(whirlpoolAddress: string): number {
  const lastSelected = _lpPairLastSelected[whirlpoolAddress];
  if (!lastSelected) return 0;
  if (Date.now() - lastSelected > RECENCY_WINDOW_MS) return 0;
  return RECENCY_PENALTY;
}

/** Export cooldown state so CFO can persist it across restarts */
export function getCooldownState(): Record<string, number> {
  return { ...lastDecisionAt };
}

/** Restore cooldown state from DB on restart — skip entries older than the longest cooldown */
export function restoreCooldownState(saved: Record<string, number>): void {
  const maxCooldownMs = 24 * 3600_000; // longest cooldown to honor on restart (24h covers all)
  const now = Date.now();
  for (const [type, ts] of Object.entries(saved)) {
    if (typeof ts === 'number' && now - ts < maxCooldownMs) {
      lastDecisionAt[type] = ts;
    }
  }
}

/** Export LP pair recency state so CFO can persist across restarts */
export function getLpRecencyState(): Record<string, number> {
  return { ..._lpPairLastSelected };
}

/** Restore LP pair recency state from DB on restart — skip entries older than recency window */
export function restoreLpRecencyState(saved: Record<string, number>): void {
  const now = Date.now();
  for (const [addr, ts] of Object.entries(saved)) {
    if (typeof ts === 'number' && now - ts < RECENCY_WINDOW_MS) {
      _lpPairLastSelected[addr] = ts;
    }
  }
}

// ============================================================================
// Approval tier classification
// ============================================================================

/**
 * Determine which approval tier a decision falls into.
 *
 * Rules:
 *  - CRITICAL urgency + criticalBypassApproval → AUTO (stop-loss can't wait for approval)
 *  - impactUsd < autoTierMaxUsd → AUTO (small, routine)
 *  - impactUsd < notifyTierMaxUsd → NOTIFY (medium, execute + tell admin)
 *  - impactUsd >= notifyTierMaxUsd → APPROVAL (large, wait for admin)
 *  - danger market condition → bump up one tier (medium→approval, to be extra cautious)
 *  - CLOSE_LOSING is always at least NOTIFY (admin should know about losses)
 */
export function classifyTier(
  type: DecisionType,
  urgency: Decision['urgency'],
  impactUsd: number,
  config: DecisionConfig,
  marketCondition: SwarmIntel['marketCondition'],
): ApprovalTier {
  // Critical stop-loss / liquidation prevention — execute immediately to save capital
  if (urgency === 'critical' && config.criticalBypassApproval) {
    return 'AUTO';
  }

  // Losing position closures always notify admin (even if small)
  if (type === 'CLOSE_LOSING') {
    const absImpact = Math.abs(impactUsd);
    return absImpact >= config.notifyTierMaxUsd ? 'APPROVAL' : 'NOTIFY';
  }

  // Base tier from dollar amount
  const absImpact = Math.abs(impactUsd);
  let tier: ApprovalTier;
  if (absImpact < config.autoTierMaxUsd) {
    tier = 'AUTO';
  } else if (absImpact < config.notifyTierMaxUsd) {
    tier = 'NOTIFY';
  } else {
    tier = 'APPROVAL';
  }

  // In danger conditions, bump up one tier for extra safety
  if (marketCondition === 'danger') {
    if (tier === 'AUTO') tier = 'NOTIFY';
    else if (tier === 'NOTIFY') tier = 'APPROVAL';
  }

  return tier;
}

// ============================================================================
// STEP 1.5: Gather swarm intelligence
// ============================================================================

/**
 * Read the latest intel from other agents via the shared DB message bus.
 * This is called by the CFO agent and passes the pool for DB queries.
 */
export async function gatherSwarmIntel(pool: any): Promise<SwarmIntel> {
  const intel: SwarmIntel = {
    riskMultiplier: 1.0,
    marketCondition: 'neutral',
  };

  try {
    // Read recent messages from swarm agents to CFO (last 4 hours — wider window for price/LP context)
    const cutoff = new Date(Date.now() - 4 * 3600_000).toISOString();
    const result = await pool.query(
      `SELECT from_agent, payload, created_at
       FROM agent_messages
       WHERE to_agent IN ('nova-cfo', 'broadcast')
         AND created_at > $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [cutoff],
    );

    for (const row of result.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const from = row.from_agent;
      const ts = new Date(row.created_at).getTime();

      // ── Scout intel ──
      if (from === 'nova-scout' || from === 'nova' /* forwarded by supervisor */) {
        const cmd = payload.command ?? payload.intel_type ?? payload.source;
        if (cmd === 'scout_intel' || cmd === 'narrative_shift' || cmd === 'quick_scan' || cmd === 'narrative_update' || cmd === 'research_cycle') {
          if (!intel.scoutReceivedAt || ts > intel.scoutReceivedAt) {
            // Accept explicit cryptoBullish OR infer from summary text
            let bullish = payload.cryptoBullish;
            if (bullish === undefined && payload.summary) {
              const lower = (payload.summary as string).toLowerCase();
              const bullWords = ['surge', 'bullish', 'rally', 'breakout', 'pump', 'trending', 'viral', 'moon', 'ath'];
              const bearWords = ['crash', 'bearish', 'dump', 'fear', 'sell-off', 'capitulation', 'plunge'];
              const bullHits = bullWords.filter(w => lower.includes(w)).length;
              const bearHits = bearWords.filter(w => lower.includes(w)).length;
              bullish = bullHits >= bearHits; // default neutral-bullish if no signal
            }
            intel.scoutBullish = bullish ?? true;
            intel.scoutNarratives = payload.topNarratives ?? payload.narratives
              ?? (payload.summary ? (payload.summary as string).split(' | ') : []);
            intel.scoutConfidence = payload.confidence ?? (payload.source === 'narrative_shift' ? 0.7 : 0.5);
            intel.scoutReceivedAt = ts;
          }
        }
      }

      // ── Guardian alerts ──
      if (from === 'nova-guardian' || (from === 'nova' && payload.source === 'guardian')) {
        if (!intel.guardianReceivedAt || ts > intel.guardianReceivedAt) {
          intel.guardianAlerts = intel.guardianAlerts ?? [];
          intel.guardianAlerts.push(payload.message ?? payload.warning ?? 'Unknown alert');
          intel.guardianCritical = intel.guardianCritical || payload.priority === 'critical' || payload.command === 'market_crash';
          intel.guardianReceivedAt = ts;
        }
      }

      // ── Analyst data ──
      if (from === 'nova-analyst' || (from === 'nova' && (payload.command === 'defi_snapshot' || payload.source === 'volume_spike' || payload.source === 'price_alert'))) {
        if (!intel.analystReceivedAt || ts > intel.analystReceivedAt) {
          intel.analystSolanaTvl = payload.solanaTvl ?? payload.chainTvl?.solana;
          intel.analystVolumeSpike = payload.source === 'volume_spike';
          intel.analystPriceAlert = payload.summary;
          intel.analystReceivedAt = ts;
        }
      }

      // ── Guardian watchlist snapshot (enriched token data) ──
      if (from === 'nova-guardian' && payload.source === 'watchlist_snapshot') {
        if (!intel.guardianSnapshotAt || ts > intel.guardianSnapshotAt) {
          intel.guardianTokens = payload.tokens ?? [];
          intel.guardianSnapshotAt = ts;
        }
      }

      // ── Analyst token intel (enriched price data) ──
      if (from === 'nova-analyst' && payload.source === 'token_intel') {
        if (!intel.analystPricesAt || ts > intel.analystPricesAt) {
          intel.analystPrices = payload.prices ?? {};
          intel.analystMovers = payload.movers ?? [];
          intel.analystTrending = payload.trending ?? [];
          intel.analystPricesAt = ts;
          intel.analystArbitrumVolume24h = payload.arbitrumVolume24h;
          // Krystal EVM LP opportunities (from analyst fetchKrystalLpIntel)
          if (payload.evmLpOpportunities) {
            intel.analystEvmLpOpportunities = payload.evmLpOpportunities;
            intel.analystEvmLpAt = ts;
          }
        }
      }
    }
  } catch (err) {
    logger.debug('[CFO:Decision] Failed to gather swarm intel (non-fatal):', err);
  }

  // ── Compute composite risk multiplier ──
  // Lower = more aggressive (bullish), Higher = more defensive (bearish/danger)
  let multiplier = 1.0;
  const intelAge = (field: number | undefined) => field ? (Date.now() - field) / 3600_000 : 999; // hours

  // Scout sentiment (if recent enough — within 4h)
  if (intelAge(intel.scoutReceivedAt) < 4) {
    if (intel.scoutBullish === true) multiplier -= 0.2;      // bullish → less hedging needed
    else if (intel.scoutBullish === false) multiplier += 0.3; // bearish → more hedging
  }

  // Guardian critical alerts → max defensiveness
  if (intel.guardianCritical) {
    multiplier += 0.5;
  } else if (intel.guardianAlerts && intel.guardianAlerts.length > 0) {
    multiplier += 0.2;
  }

  // Volume spike → increased volatility → more hedge
  if (intel.analystVolumeSpike && intelAge(intel.analystReceivedAt) < 2) {
    multiplier += 0.15;
  }

  // Clamp
  intel.riskMultiplier = Math.max(0.5, Math.min(2.0, multiplier));

  // Determine market condition
  if (intel.guardianCritical) {
    intel.marketCondition = 'danger';
  } else if (multiplier >= 1.3) {
    intel.marketCondition = 'bearish';
  } else if (multiplier <= 0.7) {
    intel.marketCondition = 'bullish';
  } else {
    intel.marketCondition = 'neutral';
  }

  return intel;
}

// ============================================================================
// STEP 1: Gather portfolio state
// ============================================================================

export async function gatherPortfolioState(): Promise<PortfolioState> {
  const env = getCFOEnv();

  // ── Stage 0: SOL price + SOL/USDC balances (needed for LST valuations) ──
  // Run price + balances in parallel since they're independent
  let solPriceUsd = 0;
  let solBalance = 0;
  let solanaUsdcBalance = 0;
  {
    const [priceResult, balanceResult] = await Promise.allSettled([
      import('./pythOracleService.ts').then(pyth => pyth.getSolPrice()),
      import('./jupiterService.ts').then(async jupiter => ({
        sol: await jupiter.getTokenBalance(jupiter.MINTS.SOL),
        usdc: await jupiter.getTokenBalance(jupiter.MINTS.USDC),
      })),
    ]);
    solPriceUsd = priceResult.status === 'fulfilled' ? priceResult.value : 85;
    if (balanceResult.status === 'fulfilled') {
      solBalance = balanceResult.value.sol;
      solanaUsdcBalance = balanceResult.value.usdc;
    }
  }

  // ── Stage 1: Jito + LSTs (need solPriceUsd), HL, Poly, Kamino, Orca — ALL IN PARALLEL ──
  // These are independent of each other — only share solPriceUsd from Stage 0.
  let jitoSolBalance = 0;
  let jitoSolValueUsd = 0;
  const lstBalances: Record<string, { balance: number; valueUsd: number }> = {};

  // Hyperliquid state
  let hlEquity = 0;
  let hlAvailableMargin = 0;
  let hlTotalPnl = 0;
  let hlPositions: PortfolioState['hlPositions'] = [];
  // ── Stage 1: Jito/LSTs, HL, Poly — all in parallel (only need solPriceUsd) ──
  const parallelJobs: Promise<void>[] = [];

  // Job A: Jito + LSTs
  parallelJobs.push((async () => {
    if (env.jitoEnabled) {
      try {
        const jito = await import('./jitoStakingService.ts');
        const pos = await jito.getStakePosition(solPriceUsd);
        jitoSolBalance = pos.jitoSolBalance;
        jitoSolValueUsd = pos.jitoSolValueUsd;
      } catch { /* 0 */ }
    }
    lstBalances.JitoSOL = { balance: jitoSolBalance, valueUsd: jitoSolValueUsd };
    if (env.kaminoEnabled && (env.kaminoLstLoopEnabled || env.kaminoMultiplyVaultEnabled)) {
      try {
        const jupiter = await import('./jupiterService.ts');
        const kamino = await import('./kaminoService.ts');
        const lstReserves = await kamino.getLstAssets();
        for (const r of lstReserves) {
          if (r.symbol === 'JitoSOL') continue;
          const balance = await jupiter.getTokenBalance(r.mint);
          const valueUsd = balance * solPriceUsd * 1.02;
          lstBalances[r.symbol] = { balance, valueUsd };
        }
      } catch { /* non-fatal */ }
    }
  })());

  // Job B: Hyperliquid
  if (env.hyperliquidEnabled) {
    parallelJobs.push((async () => {
      try {
        const hl = await import('./hyperliquidService.ts');
        const summary = await hl.getAccountSummary();
        hlEquity = summary.equity;
        hlAvailableMargin = summary.availableMargin;
        hlTotalPnl = summary.totalPnl;
        hlPositions = summary.positions.map((p) => ({
          coin: p.coin,
          side: p.side,
          sizeUsd: p.sizeUsd,
          unrealizedPnlUsd: p.unrealizedPnlUsd,
          leverage: p.leverage,
          liquidationPrice: p.liquidationPrice,
          markPrice: p.markPrice,
          marginUsed: p.marginUsed,
        }));
      } catch { /* 0 */ }
    })());
  }

  // Job C: Polymarket state
  let polyDeployedUsd = 0;
  let polyUsdcBalance = 0;
  let polyPositionCount = 0;
  let polyPositions: PortfolioState['polyPositions'] = [];
  if (env.polymarketEnabled) {
    parallelJobs.push((async () => {
      try {
        const polyMod = await import('./polymarketService.ts');
        const evmMod = await import('./evmWalletService.ts');
        const positions = await polyMod.fetchPositions();
        polyPositionCount = positions.length;
        polyDeployedUsd = positions.reduce((s: number, p: any) => s + (p.currentValueUsd ?? 0), 0);
        polyPositions = positions.map((p: any) => ({
          question: p.question ?? 'Unknown',
          outcome: p.outcome ?? '?',
          costBasisUsd: p.costBasisUsd ?? 0,
          currentValueUsd: p.currentValueUsd ?? 0,
          unrealizedPnlUsd: p.unrealizedPnlUsd ?? 0,
          currentPrice: p.currentPrice ?? 0,
        }));
        polyUsdcBalance = await evmMod.getUSDCBalance();
      } catch (err) {
        logger.warn('[CFO] Polymarket state fetch failed:', err);
      }
    })());
  }

  // ── Wait for all Stage 1 parallel jobs ──
  await Promise.allSettled(parallelJobs);

  const polyHeadroomUsd = Math.min(polyUsdcBalance, env.maxPolymarketUsd - polyDeployedUsd);

  // SOL-correlated exposure = raw SOL + all LSTs (JitoSOL, mSOL, bSOL, etc.)
  const rawSolUsd = solBalance * solPriceUsd;
  const lstTotalUsd = Object.values(lstBalances).reduce((s, v) => s + v.valueUsd, 0);
  const solExposureUsd = rawSolUsd + lstTotalUsd;

  // Total SHORT across ALL treasury coins (not just SOL)
  const hlTotalShortUsd = hlPositions
    .filter((p) => p.side === 'SHORT')
    .reduce((s, p) => s + p.sizeUsd, 0);

  // Treasury exposures will be populated later (needs intel for prices)
  // Start with SOL as minimum fallback
  let treasuryExposures: PortfolioState['treasuryExposures'] = [{
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    balance: solBalance,
    valueUsd: solExposureUsd, // includes LSTs
    hlListed: true,
  }];

  // hedgeable exposure = sum of all treasury tokens that are HL-listed (updated after scan)
  const totalHedgeableUsd = solExposureUsd; // initial; overwritten after treasury scan in cycle

  // Preliminary total — Kamino & Orca not yet known; patched below after gathering
  // Note: lstTotalUsd already includes jitoSolValueUsd via lstBalances
  let totalPortfolioUsd = solExposureUsd + hlEquity + polyDeployedUsd + polyUsdcBalance;
  const hedgeRatio = totalHedgeableUsd > 0 ? hlTotalShortUsd / totalHedgeableUsd : 0;

  // Idle SOL available for staking (above reserve)
  const reserveNeeded = Number(process.env.CFO_STAKE_RESERVE_SOL ?? 0.5);
  const idleSolForStaking = Math.max(0, solBalance - reserveNeeded);

  // ── Stage 2: Kamino + Orca + EVM in parallel ──────────────────────────
  let kaminoDepositValueUsd = 0, kaminoBorrowValueUsd = 0, kaminoNetValueUsd = 0;
  let kaminoLtv = 0, kaminoHealthFactor = 999, kaminoBorrowApy = 0.12, kaminoSupplyApy = 0.08;
  let kaminoSolBorrowApy = 0.10, kaminoJitoSupplyApy = 0.07, kaminoUsdcSupplyApy = 0.08;
  let kaminoBorrowableUsd = 0, kaminoJitoLoopActive = false, kaminoJitoLoopApy = 0;
  let kaminoActiveLstLoop: string | null = null;
  let kaminoMultiplyVaults: PortfolioState['kaminoMultiplyVaults'] = [];
  let orcaLpValueUsd = 0, orcaLpFeeApy = 0;
  let orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean; whirlpoolAddress?: string; riskTier?: string; tokenA?: string; tokenB?: string; valueUsd?: number; feesUsd?: number }> = [];
  let evmArbProfit24h = 0, evmArbPoolCount = 0, evmArbUsdcBalance = 0;
  let evmLpPositions: PortfolioState['evmLpPositions'] = [];
  let evmLpTotalValueUsd = 0, evmLpTotalFeesUsd = 0;
  let evmChainBalances: PortfolioState['evmChainBalances'] = [];
  let evmTotalUsdcAllChains = 0, evmTotalNativeAllChains = 0;

  {
    const stage2Jobs: Promise<void>[] = [];

    // ── Job A: Kamino ──────────────────────────────────────────────────
    if (env.kaminoEnabled) {
      stage2Jobs.push((async () => {
        try {
          const kamino = await import('./kaminoService.ts');
          const [pos, apys] = await Promise.all([kamino.getPosition(), kamino.getApys()]);
          kaminoDepositValueUsd = pos.deposits.reduce((s, d) => s + d.valueUsd, 0);
          kaminoBorrowValueUsd  = pos.borrows.reduce((s, b) => s + b.valueUsd, 0);
          kaminoNetValueUsd     = pos.netValueUsd;
          kaminoLtv             = pos.ltv;
          kaminoHealthFactor    = pos.healthFactor;
          kaminoBorrowApy       = apys.USDC?.borrowApy    ?? 0.12;
          kaminoSolBorrowApy    = apys.SOL?.borrowApy     ?? 0.10;
          kaminoJitoSupplyApy   = apys.JitoSOL?.supplyApy ?? 0.07;
          kaminoUsdcSupplyApy   = apys.USDC?.supplyApy    ?? 0.08;
          kaminoSupplyApy       = kaminoUsdcSupplyApy;

          const maxBorrowLtv = (env.kaminoBorrowMaxLtvPct ?? 60) / 100;
          kaminoBorrowableUsd = Math.max(0, Math.min(
            kaminoDepositValueUsd * maxBorrowLtv - kaminoBorrowValueUsd,
            env.maxKaminoBorrowUsd - kaminoBorrowValueUsd,
          ));

          const hasJitoDeposit = pos.deposits.some(d => d.asset === 'JitoSOL');
          const hasSolBorrow   = pos.borrows.some(b => b.asset === 'SOL');
          kaminoJitoLoopActive = hasJitoDeposit && hasSolBorrow;

          if (kaminoJitoLoopActive) {
            const jitoDepositUsd = pos.deposits.filter(d => d.asset === 'JitoSOL').reduce((s, d) => s + d.valueUsd, 0);
            const leverage = kaminoNetValueUsd > 0 ? jitoDepositUsd / kaminoNetValueUsd : 1;
            kaminoJitoLoopApy = leverage * kaminoJitoSupplyApy - (leverage - 1) * kaminoSolBorrowApy;
          }

          for (const dep of pos.deposits) {
            const lstInfo = await kamino.getReserve(dep.asset);
            if (lstInfo?.isLst && hasSolBorrow) {
              kaminoActiveLstLoop = dep.asset;
              break;
            }
          }
        } catch { /* non-fatal */ }

        // Kamino Multiply vaults (nested inside same job to reuse kamino import)
        if (env.kaminoMultiplyVaultEnabled) {
          try {
            const kamino = await import('./kaminoService.ts');
            const vaults = await kamino.getMultiplyVaults();
            kaminoMultiplyVaults = vaults.slice(0, 5).map(v => ({
              name: v.name,
              collateralToken: v.collateralToken,
              apy: v.apy,
              tvl: v.tvl,
              leverage: v.leverage,
              address: v.address,
            }));
          } catch { /* non-fatal */ }
        }
      })());
    }

    // ── Job B: Orca LP ─────────────────────────────────────────────────
    if (env.orcaLpEnabled) {
      stage2Jobs.push((async () => {
        try {
          const orca = await import('./orcaService.ts');
          const positions = await orca.getPositions();
          logger.info(`[CFO] Orca on-chain scan returned ${positions.length} position(s)`);
          orcaLpValueUsd = positions.reduce((s, p) => s + p.liquidityUsd, 0);

          const dbTierMap = new Map<string, { tier?: string; tokenA?: string; tokenB?: string }>();
          try {
            const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
            if (dbUrl) {
              const { Pool } = await import('pg');
              const pgPool = new Pool({ connectionString: dbUrl, max: 1 });
              try {
                const orcaDbRes = await pgPool.query(
                  `SELECT asset, metadata FROM cfo_positions WHERE strategy = 'orca_lp' AND status = 'OPEN'`,
                );
                for (const row of orcaDbRes.rows) {
                  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                  const wp = meta?.whirlpoolAddress;
                  if (wp) dbTierMap.set(wp, { tier: meta?.riskTier, tokenA: meta?.tokenA, tokenB: meta?.tokenB });
                }
              } finally {
                pgPool.end().catch(() => {});
              }
            }
          } catch (dbErr) {
            logger.debug('[CFO] Orca DB tier enrichment failed (non-fatal):', dbErr instanceof Error ? dbErr.message : dbErr);
          }

          let discoveryCache: Map<string, { tier?: string; tokenA?: string; tokenB?: string }> | null = null;
          try {
            const { getCachedPools } = await import('./orcaPoolDiscovery.ts');
            const cached = getCachedPools();
            if (cached.length > 0) {
              discoveryCache = new Map();
              for (const c of cached) {
                discoveryCache.set(c.whirlpoolAddress, { tier: c.riskTier, tokenA: c.tokenA.symbol, tokenB: c.tokenB.symbol });
              }
            }
          } catch { /* non-fatal */ }

          orcaPositions = positions.map(p => {
            const dbInfo = p.whirlpoolAddress ? dbTierMap.get(p.whirlpoolAddress) : undefined;
            const discInfo = p.whirlpoolAddress && discoveryCache ? discoveryCache.get(p.whirlpoolAddress) : undefined;
            const feesUsd = (p.unclaimedFeesA ?? p.unclaimedFeesSol ?? 0) * (p.tokenAPriceUsd ?? solPriceUsd)
                          + (p.unclaimedFeesB ?? p.unclaimedFeesUsdc ?? 0) * (p.tokenBPriceUsd ?? 1);
            return {
              positionMint: p.positionMint,
              rangeUtilisationPct: p.rangeUtilisationPct,
              inRange: p.inRange,
              whirlpoolAddress: p.whirlpoolAddress,
              riskTier: p.riskTier ?? dbInfo?.tier ?? discInfo?.tier,
              tokenA: p.tokenA ?? dbInfo?.tokenA ?? discInfo?.tokenA,
              tokenB: p.tokenB ?? dbInfo?.tokenB ?? discInfo?.tokenB,
              valueUsd: p.liquidityUsd,
              feesUsd,
            };
          });
          const inRangePositions = positions.filter(p => p.inRange).length;
          orcaLpFeeApy = positions.length > 0 ? (inRangePositions / positions.length) * 0.15 : 0;
        } catch (orcaErr) {
          logger.warn('[CFO] Orca position fetch failed:', orcaErr instanceof Error ? orcaErr.message : orcaErr);
        }
      })());
    }

    // ── Job C: EVM (Arb + Krystal LP + Multi-chain balances) ───────────
    stage2Jobs.push((async () => {
      const evmJobs: Promise<void>[] = [];

      if (env.evmArbEnabled) {
        evmJobs.push((async () => {
          try {
            const arbMod = await import('./evmArbService.ts');
            evmArbProfit24h   = arbMod.getProfit24h();
            evmArbPoolCount   = arbMod.getCandidatePoolCount();
            evmArbUsdcBalance = await arbMod.getArbUsdcBalance();
          } catch { /* 0 */ }
        })());
      }

      // Job 2: Krystal EVM LP positions
      if (env.krystalLpEnabled) {
        evmJobs.push((async () => {
          try {
            const krystal = await import('./krystalService.ts');
            const walletAddr = env.evmPrivateKey
              ? (await import('ethers' as string)).computeAddress(env.evmPrivateKey)
              : undefined;
            if (walletAddr) {
            const dbRecords = (globalThis as any).__cfo_evm_lp_records as import('./krystalService.ts').EvmLpRecord[] | undefined;
            const positions = await krystal.fetchKrystalPositions(walletAddr, dbRecords);

            // Clean up positions confirmed closed on-chain (0 liquidity)
            if (positions.closedOnChainPosIds?.length) {
              for (const closedPosId of positions.closedOnChainPosIds) {
                const existing = ((globalThis as any).__cfo_evm_lp_records ?? []) as import('./krystalService.ts').EvmLpRecord[];
                (globalThis as any).__cfo_evm_lp_records = existing.filter(r => r.posId !== closedPosId);
              }
              // Clean kv_store so they don't rehydrate on restart
              try {
                const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
                if (dbUrl) {
                  const { Pool: PgPool } = await import('pg');
                  const kvPool = new PgPool({ connectionString: dbUrl, max: 1 });
                  try {
                    for (const closedPosId of positions.closedOnChainPosIds) {
                      // Key format is cfo_evm_lp_<posId>_<chainNumericId> — use LIKE wildcard
                      await kvPool.query(`DELETE FROM kv_store WHERE key LIKE $1`, [`cfo_evm_lp_${closedPosId}_%`]);
                      // Also close the cfo_positions row if it exists (metadata.nfpmTokenId matches posId)
                      await kvPool.query(
                        `UPDATE cfo_positions SET status = 'CLOSED', realized_pnl_usd = 0,
                         unrealized_pnl_usd = 0, current_value_usd = 0,
                         exit_tx_hash = 'closed-on-chain', closed_at = NOW(), updated_at = NOW()
                         WHERE strategy = 'krystal_lp' AND status = 'OPEN'
                         AND metadata->>'nfpmTokenId' = $1`,
                        [closedPosId],
                      );
                    }
                    logger.info(`[CFO:Decision] Cleaned ${positions.closedOnChainPosIds.length} closed-on-chain EVM LP position(s) from kv_store + cfo_positions`);
                  } finally { kvPool.end().catch(() => {}); }
                }
              } catch { /* non-fatal */ }
            }

            evmLpPositions = positions.map(p => ({
              posId: p.posId,
              chainName: p.chainName,
              chainNumericId: p.chainNumericId,
              protocol: p.protocol,
              poolAddress: p.poolAddress,
              token0Symbol: p.token0.symbol,
              token1Symbol: p.token1.symbol,
              token0Address: p.token0.address,
              token1Address: p.token1.address,
              token0Decimals: p.token0.decimals,
              token1Decimals: p.token1.decimals,
              valueUsd: p.valueUsd,
              inRange: p.inRange,
              rangeUtilisationPct: p.rangeUtilisationPct,
              feesOwedUsd: p.feesOwedUsd,
              openedAt: p.openedAt,
            }));
            evmLpTotalValueUsd = evmLpPositions.reduce((s, p) => s + p.valueUsd, 0);
            evmLpTotalFeesUsd  = evmLpPositions.reduce((s, p) => s + p.feesOwedUsd, 0);
          }
        } catch { /* 0 */ }
      })());
    }

    // Job 3: Multi-chain EVM balance scan
      if (env.krystalLpEnabled || env.lifiEnabled) {
        evmJobs.push((async () => {
          try {
            const krystal = await import('./krystalService.ts');
            const balances = await krystal.getMultiChainEvmBalances();
            evmChainBalances        = balances;
            evmTotalUsdcAllChains   = balances.reduce((s, b) => s + b.totalStableUsd, 0);
            evmTotalNativeAllChains = balances.reduce((s, b) => s + b.nativeValueUsd + b.wethValueUsd, 0);
          } catch { /* 0 */ }
        })());
      }

      await Promise.all(evmJobs);
    })());

    await Promise.allSettled(stage2Jobs);
  }

  // Patch totalPortfolioUsd with Kamino + Orca + EVM LP values gathered above
  totalPortfolioUsd += kaminoNetValueUsd + orcaLpValueUsd + evmLpTotalValueUsd;

  return {
    solBalance,
    solPriceUsd,
    solExposureUsd,
    solanaUsdcBalance,
    jitoSolBalance,
    jitoSolValueUsd,
    lstBalances,
    hlEquity,
    hlAvailableMargin,
    hlPositions,
    hlTotalShortUsd,
    hlTotalPnl,
    polyDeployedUsd,
    polyHeadroomUsd,
    polyPositionCount,
    polyUsdcBalance,
    polyPositions,
    totalPortfolioUsd,
    hedgeRatio,
    idleSolForStaking,
    timestamp: Date.now(),
    kaminoDepositValueUsd,
    kaminoBorrowValueUsd,
    kaminoNetValueUsd,
    kaminoLtv,
    kaminoHealthFactor,
    kaminoBorrowApy,
    kaminoSolBorrowApy,
    kaminoJitoSupplyApy,
    kaminoUsdcSupplyApy,
    kaminoSupplyApy,
    kaminoBorrowableUsd,
    kaminoJitoLoopActive,
    kaminoJitoLoopApy,
    kaminoActiveLstLoop,
    kaminoMultiplyVaults,
    orcaLpValueUsd,
    orcaLpFeeApy,
    orcaPositions,
    evmArbProfit24h,
    evmArbPoolCount,
    evmArbUsdcBalance,
    evmLpPositions,
    evmLpTotalValueUsd,
    evmLpTotalFeesUsd,
    evmChainBalances,
    evmTotalUsdcAllChains,
    evmTotalNativeAllChains,
    treasuryExposures,
  };
}

// ============================================================================
// STEP 2 + 3: Assess risk & decide
// ============================================================================

// ── Dynamic Orca pool discovery (replaces hardcoded ORCA_WHIRLPOOLS) ─────
// Pool list fetched from DeFiLlama yields API + Orca whirlpool API.
// See orcaPoolDiscovery.ts for scoring, cross-referencing, and caching.
import {
  discoverOrcaPools,
  selectBestPool as selectBestOrcaPool,
  getPoolByAddress,
  type OrcaPoolCandidate,
  type PoolSelection,
} from './orcaPoolDiscovery.ts';
import { registerPoolDecimalsBulk } from './orcaService.ts';

/**
 * Compute an adaptive LP range width based on 24h price change of the base token.
 * Wider range in volatile conditions (less rebalancing), narrower when calm (more fees).
 * Returns total range width as a percentage (e.g. 20 = ±10%).
 */
function adaptiveLpRangeWidthPct(
  tokenSymbol: string,
  intel: SwarmIntel,
  baseWidthPct: number,
  learned?: AdaptiveParams,
  token1Symbol?: string,
): number {
  // Apply learned LP range multiplier (wider if high OOR rate, tighter if profitable)
  const learnedBase = learned
    ? applyAdaptive(baseWidthPct, learned.lpRangeWidthMultiplier, learned.confidenceLevel)
    : baseWidthPct;

  // Gate: if analyst prices are stale (>6h), don't tighten range — use default width
  const STALE_MS = 6 * 3600_000;
  if (!intel.analystPricesAt || Date.now() - intel.analystPricesAt > STALE_MS) {
    return learnedBase; // stale or missing — safe default
  }

  // Try primary symbol first, then fallback to token1 (e.g. when token0=USDC)
  const analystPrice = intel.analystPrices?.[tokenSymbol]
    ?? (token1Symbol ? intel.analystPrices?.[token1Symbol] : undefined);
  if (!analystPrice) return learnedBase;

  const absChange = Math.abs(analystPrice.change24h ?? 0);

  if (absChange > 15) return Math.min(learnedBase * 2.0, 60);  // very volatile: ±30% max
  if (absChange > 10) return Math.min(learnedBase * 1.5, 40);  // volatile: ±20%
  if (absChange > 5)  return learnedBase;                       // normal: use configured width
  if (absChange > 2)  return Math.max(learnedBase * 0.7, 6);   // calm: tighten aggressively
  return Math.max(learnedBase * 0.45, 4);                       // very calm: ±2-3% for max fees
}

/**
 * Compute adaptive LP range width in ticks for EVM concentrated LP.
 * Mirrors adaptiveLpRangeWidthPct() but returns tick-based width (e.g. 400 = ±200 ticks).
 * Wider in volatile conditions, narrower when calm.
 *
 * @param tokenSymbol  Primary token symbol (usually the volatile side, e.g. WETH)
 * @param intel        Swarm intel with analyst prices
 * @param baseWidthTicks  Pre-computed base width (already includes tier × learned tier multipliers)
 * @param learned      Learning engine adaptive params
 * @param token1Symbol Optional second token symbol — if token0 has no analyst data, try token1
 */
function adaptiveLpRangeWidthTicks(
  tokenSymbol: string,
  intel: SwarmIntel,
  baseWidthTicks: number,
  learned?: AdaptiveParams,
  token1Symbol?: string,
): number {
  // Apply learned LP range multiplier
  const learnedBase = learned
    ? applyAdaptive(baseWidthTicks, learned.lpRangeWidthMultiplier, learned.confidenceLevel)
    : baseWidthTicks;

  const STALE_MS = 6 * 3600_000;
  if (!intel.analystPricesAt || Date.now() - intel.analystPricesAt > STALE_MS) {
    return learnedBase;
  }

  // Try token0 first, then token1 — this handles cases where token0
  // is a stable (USDC) with no analyst price but token1 (cbBTC, WETH) does.
  const analystPrice = intel.analystPrices?.[tokenSymbol]
    ?? (token1Symbol ? intel.analystPrices?.[token1Symbol] : undefined);
  if (!analystPrice) return learnedBase;

  const absChange = Math.abs(analystPrice.change24h ?? 0);

  // Tighter floors than before — concentrated liquidity earns more fees
  // at narrower ranges when volatility is low. Old floor of 150 was too
  // conservative and left significant fee revenue on the table.
  if (absChange > 15) return Math.min(learnedBase * 2.0, 2000); // very volatile
  if (absChange > 10) return Math.min(learnedBase * 1.5, 1200);  // volatile
  if (absChange > 5)  return learnedBase;                        // normal
  if (absChange > 2)  return Math.max(learnedBase * 0.7, 80);   // calm: tighter (was 0.75/200)
  return Math.max(learnedBase * 0.45, 60);                        // very calm: much tighter (was 0.5/150)
}

/**
 * Select the best Orca LP pool using dynamic discovery + multi-factor scoring.
 *
 * Replaces the old hardcoded 4-pool selectBestOrcaPair().
 * Now discovers 50+ eligible pools from DeFiLlama + Orca API,
 * scores them on APY, volume, TVL, ML predictions, volatility, IL risk,
 * and adjusts for market conditions + swarm intel.
 *
 * Fallback: if discovery fails, returns a SOL/USDC hardcoded entry.
 */
async function selectBestOrcaPairDynamic(
  intel: SwarmIntel,
  orcaLpRiskTiers?: Set<string>,
): Promise<{
  pair: string;
  whirlpoolAddress: string;
  tokenA: string;
  tokenB: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  tickSpacing?: number;
  score: number;
  reasoning: string;
  apyBase7d: number;
  tvlUsd: number;
  riskTier: 'low' | 'medium' | 'high';
}> {
  const fallback = {
    pair: 'SOL/USDC',
    whirlpoolAddress: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
    tokenA: 'SOL',
    tokenB: 'USDC',
    tokenAMint: 'So11111111111111111111111111111111111111112',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenADecimals: 9,
    tokenBDecimals: 6,
    tickSpacing: 64,
    score: 50,
    reasoning: 'Fallback SOL/USDC — pool discovery unavailable',
    apyBase7d: 0,
    tvlUsd: 0,
    riskTier: 'medium' as const,
  };

  try {
    // Gate: if analyst prices are stale (>6h), fall back to SOL/USDC — don't trust old intel
    const STALE_MS = 6 * 3600_000;
    if (intel.analystPricesAt && Date.now() - intel.analystPricesAt > STALE_MS) {
      logger.warn('[CFO:Decision] Analyst prices stale (>6h) — falling back to SOL/USDC');
      return fallback;
    }

    // Run discovery (cached — only fetches every 2h)
    const pools = await discoverOrcaPools();

    // Register decimals for all discovered pools so orcaService can read them
    registerPoolDecimalsBulk(pools);

    // Select best pool using market condition + swarm intel
    const selection = await selectBestOrcaPool({
      marketCondition: intel.marketCondition,
      guardianTokens: intel.guardianTokens,
      analystPrices: intel.analystPrices,
      analystTrending: intel.analystTrending,
      orcaLpRiskTiers,
    });

    if (!selection) {
      logger.warn('[CFO:Decision] Pool selection returned null — using SOL/USDC fallback');
      return fallback;
    }

    // ── Diversity rotation: apply recency penalty to all pools, pick best effective score ──
    const ranked = pools
      .filter(p => p.score >= 20)
      .map(p => {
        const recency = getLpRecencyPenalty(p.whirlpoolAddress);
        return { pool: p, recency, effective: p.score - recency };
      })
      .sort((a, b) => b.effective - a.effective);

    // Use the top-ranked pool after recency adjustment (falls back to selectBestPool winner if no recency applies)
    const pick = ranked[0] ?? { pool: selection.pool, recency: 0, effective: selection.score };

    if (pick.recency > 0) {
      logger.info(
        `[CFO:Decision] Diversity rotation: ${selection.pool.pair} (score ${selection.score}) penalized -${RECENCY_PENALTY} (recently used). ` +
        `Picked ${pick.pool.pair} (base ${pick.pool.score}, effective ${pick.effective})`,
      );
    } else if (pick.pool.whirlpoolAddress !== selection.pool.whirlpoolAddress) {
      logger.info(`[CFO:Decision] Pool ${pick.pool.pair} chosen over ${selection.pool.pair} after recency adjustment`);
    }

    markLpPairSelected(pick.pool.whirlpoolAddress);

    const p = pick.pool;
    return {
      pair: p.pair,
      whirlpoolAddress: p.whirlpoolAddress,
      tokenA: p.tokenA.symbol,
      tokenB: p.tokenB.symbol,
      tokenAMint: p.tokenA.mint,
      tokenBMint: p.tokenB.mint,
      tokenADecimals: p.tokenA.decimals,
      tokenBDecimals: p.tokenB.decimals,
      tickSpacing: p.tickSpacing,
      score: pick.effective,
      reasoning: `${p.reasoning.slice(0, 6).join(', ')}${pick.recency > 0 ? ' (diversity rotation)' : ''} (${ranked.length} pools evaluated)`,
      apyBase7d: p.apyBase7d,
      tvlUsd: p.tvlUsd,
      riskTier: p.riskTier,
    };
  } catch (err) {
    logger.warn('[CFO:Decision] Dynamic pool selection failed:', err);
    return fallback;
  }
}

/**
 * Adjust Polymarket market probability estimates using live token intel.
 * Returns an adjusted probability and reasoning behind the adjustment.
 */
function adjustPolyProbabilityWithIntel(
  question: string,
  marketProb: number,
  intel: SwarmIntel,
): { adjustedProb: number; confidence: number; reasoning: string } {
  let prob = marketProb;
  let confidence = 0.3;
  const factors: string[] = [];

  const q = question.toLowerCase();

  // ── SOL price questions ──
  if (q.includes('sol') && (q.includes('above') || q.includes('reach') || q.includes('hit') || q.includes('exceed'))) {
    const solPrice = intel.analystPrices?.['SOL']?.usd ?? intel.guardianTokens?.find(t => t.ticker === 'SOL')?.priceUsd;
    if (solPrice) {
      const match = question.match(/\$?(\d[\d,]*(?:\.\d+)?)/);
      if (match) {
        const target = parseFloat(match[1].replace(',', ''));
        const distancePct = (target - solPrice) / solPrice;
        if (distancePct > 0 && distancePct < 0.1) {
          prob = Math.min(prob + 0.1, 0.9);
          factors.push(`SOL $${solPrice.toFixed(0)} is ${(distancePct * 100).toFixed(0)}% from target`);
        } else if (distancePct < 0) {
          prob = Math.min(prob + 0.15, 0.95);
          factors.push(`SOL already above target ($${solPrice.toFixed(0)})`);
        } else if (distancePct > 0.3) {
          prob = Math.max(prob - 0.1, 0.05);
          factors.push(`SOL far from target (${(distancePct * 100).toFixed(0)}% away)`);
        }
        confidence += 0.2;
      }
    }

    const solChange = intel.analystPrices?.['SOL']?.change24h;
    if (solChange !== undefined) {
      if (solChange > 5 && q.includes('above')) { prob = Math.min(prob + 0.08, 0.9); confidence += 0.1; factors.push(`SOL trending +${solChange.toFixed(1)}%`); }
      else if (solChange < -5 && q.includes('above')) { prob = Math.max(prob - 0.08, 0.05); confidence += 0.1; factors.push(`SOL falling ${solChange.toFixed(1)}%`); }
    }
  }

  // ── BTC price questions ──
  if (q.includes('btc') || q.includes('bitcoin')) {
    const btcChange = intel.analystPrices?.['BTC']?.change24h;
    if (btcChange !== undefined && Math.abs(btcChange) > 3) {
      const bullishQuestion = q.includes('above') || q.includes('reach') || q.includes('hit');
      if ((btcChange > 0) === bullishQuestion) {
        prob = Math.min(prob + 0.07, 0.9); confidence += 0.1;
        factors.push(`BTC ${btcChange > 0 ? '+' : ''}${btcChange.toFixed(1)}% 24h`);
      }
    }
  }

  // ── Meme token questions (BONK, WIF, POPCAT etc.) ──
  const memeTokens = ['bonk', 'wif', 'popcat', 'dogwifhat'];
  for (const meme of memeTokens) {
    if (q.includes(meme)) {
      const ticker = meme === 'dogwifhat' ? 'WIF' : meme.toUpperCase();
      const change = intel.analystPrices?.[ticker]?.change24h;
      const isGuardianToken = intel.guardianTokens?.find(t => t.ticker === ticker);
      if (change !== undefined) {
        if (change > 20) { prob = Math.min(prob + 0.12, 0.9); confidence += 0.15; factors.push(`${ticker} surging +${change.toFixed(0)}%`); }
        else if (change < -20) { prob = Math.max(prob - 0.10, 0.05); confidence += 0.1; factors.push(`${ticker} dropping ${change.toFixed(0)}%`); }
      }
      if (isGuardianToken && isGuardianToken.volume24h > 500_000) {
        confidence += 0.1;
        factors.push(`${ticker} high volume $${(isGuardianToken.volume24h / 1e6).toFixed(1)}M`);
      }
    }
  }

  // ── Scout sentiment modifier ──
  if (intel.scoutBullish === true && (intel.scoutConfidence ?? 0) > 0.6) {
    if (q.includes('above') || q.includes('bull') || q.includes('up')) {
      prob = Math.min(prob + 0.05, 0.9); confidence += 0.05;
      factors.push(`Scout bullish (${((intel.scoutConfidence ?? 0) * 100).toFixed(0)}% confidence)`);
    }
  }

  return {
    adjustedProb: Math.round(prob * 100) / 100,
    confidence: Math.min(confidence, 0.9),
    reasoning: factors.length > 0 ? factors.join(' | ') : 'No token intel available for this market',
  };
}

export async function generateDecisions(
  state: PortfolioState,
  config: DecisionConfig,
  env: CFOEnv,
  intel: SwarmIntel = { riskMultiplier: 1.0, marketCondition: 'neutral' },
  learned: AdaptiveParams = getAdaptiveParams(),
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  const conf = learned.confidenceLevel;

  // ── Strategy score gate — skip capital-deploying sections for poorly performing strategies ──
  // MIN_SAMPLES prevents gating strategies that haven't been tried enough.
  // Risk-management sections (stop-loss, repay, emergency unstake) are NEVER gated.
  const MIN_STRATEGY_SCORE = 15;
  const MIN_SAMPLES_FOR_GATE = 5;
  const isStrategyGated = (key: string): boolean => {
    const score = learned.strategyScores[key];
    const samples = learned.sampleSizes[key] ?? 0;
    return samples >= MIN_SAMPLES_FOR_GATE && score !== undefined && score < MIN_STRATEGY_SCORE;
  };

  // ── Global risk from learning (regime detection) ──────────────────
  const globalRisk = applyAdaptive(1.0, learned.globalRiskMultiplier, conf);

  // ── Intel-adjusted parameters ─────────────────────────────────────
  // Hedge target: base × intel × learned hedge performance × global regime
  const learnedHedgeTarget = applyAdaptive(config.hedgeTargetRatio, learned.hlHedgeTargetMultiplier, conf);
  const adjustedHedgeTarget = Math.min(1.0, learnedHedgeTarget * intel.riskMultiplier * globalRisk);
  // Hedge rebalance threshold: widen if churn detected
  const adjustedRebalThreshold = applyAdaptive(config.hedgeRebalanceThreshold, learned.hlRebalanceThresholdMultiplier, conf);
  // Apply learned stop-loss multiplier (tighter if past trades show large drawdowns)
  const learnedStopLoss = applyAdaptive(config.hlStopLossPct, learned.hlStopLossMultiplier, conf);
  const adjustedStopLoss = learnedStopLoss / intel.riskMultiplier; // then intel-adjust

  // Track which agents contributed to each decision
  const intelSources: string[] = [];
  if (intel.scoutReceivedAt) intelSources.push('scout');
  if (intel.guardianReceivedAt) intelSources.push('guardian');
  if (intel.analystReceivedAt) intelSources.push('analyst');

  // ── A) Stop-loss: close losing HL positions ───────────────────────
  for (const pos of state.hlPositions) {
    if (pos.unrealizedPnlUsd >= 0) continue; // winning, skip

    const marginUsed = pos.sizeUsd / pos.leverage;
    const lossPct = Math.abs(pos.unrealizedPnlUsd) / marginUsed * 100;

    // Check liquidation proximity
    if (pos.liquidationPrice > 0 && pos.markPrice > 0) {
      const distancePct = Math.abs(pos.markPrice - pos.liquidationPrice) / pos.markPrice * 100;
      if (distancePct < config.hlLiquidationWarningPct) {
        const d: Decision = {
          type: 'CLOSE_LOSING',
          reasoning:
            `${pos.coin} ${pos.side} is ${distancePct.toFixed(1)}% from liquidation ` +
            `(mark: $${pos.markPrice.toFixed(2)}, liq: $${pos.liquidationPrice.toFixed(2)}). ` +
            `Closing to prevent liquidation loss.`,
          params: { coin: pos.coin, side: pos.side, sizeUsd: pos.sizeUsd },
          urgency: 'critical',
          estimatedImpactUsd: pos.unrealizedPnlUsd,
          intelUsed: intel.guardianCritical ? ['guardian'] : [],
          tier: 'AUTO', // will be set below
        };
        d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
        decisions.push(d);
        continue;
      }
    }

    // Regular stop-loss check (uses intel-adjusted threshold)
    if (lossPct > adjustedStopLoss) {
      const d: Decision = {
        type: 'CLOSE_LOSING',
        reasoning:
          `${pos.coin} ${pos.side} lost ${lossPct.toFixed(1)}% of margin ` +
          `($${Math.abs(pos.unrealizedPnlUsd).toFixed(2)} loss on $${marginUsed.toFixed(2)} margin). ` +
          `Exceeds ${adjustedStopLoss.toFixed(1)}% stop-loss${intel.riskMultiplier !== 1.0 ? ` (adjusted from ${config.hlStopLossPct}% by swarm intel)` : ''}.`,
        params: { coin: pos.coin, side: pos.side, sizeUsd: pos.sizeUsd },
        urgency: 'high',
        estimatedImpactUsd: pos.unrealizedPnlUsd,
        intelUsed: intelSources,
        tier: 'AUTO', // will be set below
      };
      d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
      decisions.push(d);
    }
  }

  // ── B) Hedging decisions — per-asset treasury hedge (uses intel-adjusted target) ──
  if (config.autoHedge && env.hyperliquidEnabled) {
    const hedgeableAssets = state.treasuryExposures.filter((e) => {
      if (!e.hlListed) return false;
      if (e.valueUsd < config.hedgeMinSolExposureUsd) return false;
      // If whitelist is set, only hedge those coins
      if (env.hlHedgeCoins.length > 0 && !env.hlHedgeCoins.includes(e.symbol)) return false;
      return true;
    });

    // Total exposure across all hedgeable assets
    const totalHedgeableUsd = hedgeableAssets.reduce((s, e) => s + e.valueUsd, 0);

    for (const asset of hedgeableAssets) {
      // Per-coin HL position
      const coinShortUsd = state.hlPositions
        .filter((p) => p.coin === asset.symbol && p.side === 'SHORT')
        .reduce((s, p) => s + p.sizeUsd, 0);

      // Per-coin target hedge proportional to its share of total hedgeable
      const assetWeight = totalHedgeableUsd > 0 ? asset.valueUsd / totalHedgeableUsd : 0;
      const coinTargetHedgeUsd = asset.valueUsd * adjustedHedgeTarget;
      const coinHedgeRatio = asset.valueUsd > 0 ? coinShortUsd / asset.valueUsd : 0;
      const coinDrift = Math.abs(coinHedgeRatio - adjustedHedgeTarget);

      const cooldownKeyOpen = `OPEN_HEDGE_${asset.symbol}`;
      const cooldownKeyClose = `CLOSE_HEDGE_${asset.symbol}`;

      // Case 1: Under-hedged — need to open/increase SHORT
      if (coinHedgeRatio < adjustedHedgeTarget - adjustedRebalThreshold) {
        const hedgeNeeded = coinTargetHedgeUsd - coinShortUsd;
        // Apply global risk + capital weight scaling to hedge size
        let capped = Math.min(hedgeNeeded * globalRisk, env.maxHyperliquidUsd - state.hlTotalShortUsd);

        // Gate: need enough HL margin to open the position (size / leverage)
        // If full hedge doesn't fit, scale down to what margin supports (instead of skipping)
        // Apply learned leverage bias: negative = reduce, positive = increase (clamped)
        const learnedMaxLev = Math.max(1, Math.min(5, env.maxHyperliquidLeverage + applyAdaptive(0, learned.hlLeverageBias, conf)));
        const leverage = Math.min(2, learnedMaxLev);
        const marginRequired = capped / leverage;
        if (state.hlAvailableMargin < marginRequired) {
          // Scale hedge down to what we can afford: affordableSize = margin × leverage × 80% (buffer)
          const affordableHedge = state.hlAvailableMargin * leverage * 0.8;
          if (affordableHedge >= 10) {
            logger.info(`[CFO:Hedge] Scaling OPEN_HEDGE ${asset.symbol} from $${capped.toFixed(0)} → $${affordableHedge.toFixed(0)} (margin: $${state.hlAvailableMargin.toFixed(0)})`);
            capped = affordableHedge;
          } else {
            logger.info(`[CFO:Hedge] Skip OPEN_HEDGE ${asset.symbol} — margin $${state.hlAvailableMargin.toFixed(0)} too low (need ~$${(10 / leverage).toFixed(0)} for min $10 hedge)`);
          }
        }
        if (capped > 10 && checkCooldown(cooldownKeyOpen, config.hedgeCooldownMs)) {
          const d: Decision = {
            type: 'OPEN_HEDGE',
            reasoning:
              `${asset.symbol} exposure: $${asset.valueUsd.toFixed(0)} (${asset.balance.toFixed(4)} ${asset.symbol} @ wallet). ` +
              `Current hedge: $${coinShortUsd.toFixed(0)} (${(coinHedgeRatio * 100).toFixed(0)}%). ` +
              `Target: ${(adjustedHedgeTarget * 100).toFixed(0)}%${adjustedHedgeTarget !== config.hedgeTargetRatio ? ` (adjusted from ${(config.hedgeTargetRatio * 100).toFixed(0)}% — market: ${intel.marketCondition})` : ''}. ` +
              `Opening SHORT $${capped.toFixed(0)} ${asset.symbol}-PERP to protect downside.`,
            params: { coin: asset.symbol, exposureUsd: capped, leverage },      // uses learned leverage
            urgency: coinDrift > 0.3 ? 'high' : 'medium',
            estimatedImpactUsd: capped,
            intelUsed: intelSources,
            tier: 'AUTO',
          };
          d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
          decisions.push(d);
        }
      }

      // Case 2: Over-hedged — reduce SHORT
      if (coinHedgeRatio > adjustedHedgeTarget + adjustedRebalThreshold) {
        const excessHedgeUsd = coinShortUsd - coinTargetHedgeUsd;

        if (excessHedgeUsd > 10 && checkCooldown(cooldownKeyClose, config.hedgeCooldownMs)) {
          const d: Decision = {
            type: 'CLOSE_HEDGE',
            reasoning:
              `Over-hedged ${asset.symbol}: $${coinShortUsd.toFixed(0)} SHORT vs $${asset.valueUsd.toFixed(0)} exposure ` +
              `(${(coinHedgeRatio * 100).toFixed(0)}% vs target ${(adjustedHedgeTarget * 100).toFixed(0)}%). ` +
              `Reducing ${asset.symbol}-PERP hedge by $${excessHedgeUsd.toFixed(0)} to rebalance.`,
            params: { coin: asset.symbol, reduceUsd: excessHedgeUsd },
            urgency: 'medium',
            estimatedImpactUsd: excessHedgeUsd,
            intelUsed: intelSources,
            tier: 'AUTO',
          };
          d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
          decisions.push(d);
        }
      }
    }
  }

  // ── C) Auto-staking idle SOL into Jito ────────────────────────────
  if (config.autoStake && env.jitoEnabled) {
    if (state.idleSolForStaking >= config.stakeMinAmountSol
        && checkCooldown('AUTO_STAKE', config.stakeCooldownMs)) {
      // Don't stake everything — leave a buffer
      const toStake = Math.min(state.idleSolForStaking * 0.8, env.maxJitoSol - state.jitoSolBalance);

      if (toStake >= config.stakeMinAmountSol) {
        const d: Decision = {
          type: 'AUTO_STAKE',
          reasoning:
            `${state.solBalance.toFixed(2)} SOL in wallet, ${config.stakeReserveSol} SOL reserved. ` +
            `${state.idleSolForStaking.toFixed(2)} SOL idle → staking ${toStake.toFixed(2)} SOL into Jito ` +
            `(current JitoSOL: ${state.jitoSolBalance.toFixed(4)}, ~7% APY).`,
          params: { amount: toStake },
          urgency: 'low',
          estimatedImpactUsd: toStake * state.solPriceUsd,
          intelUsed: [],
          tier: 'AUTO',
        };
        d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
        decisions.push(d);
      }
    }
  }

  // ── D) Emergency unstake if SOL balance critically low ────────────
  if (config.autoStake && env.jitoEnabled && state.jitoSolBalance > 0.1) {
    // If SOL balance drops below half the reserve, pull from Jito
    if (state.solBalance < config.stakeReserveSol * 0.5) {
      const pullAmount = Math.min(
        config.stakeReserveSol - state.solBalance,
        state.jitoSolBalance,
      );
      if (pullAmount > 0.05) {
        const d: Decision = {
          type: 'UNSTAKE_JITO',
          reasoning:
            `SOL balance critically low: ${state.solBalance.toFixed(3)} SOL ` +
            `(reserve: ${config.stakeReserveSol} SOL). ` +
            `Unstaking ${pullAmount.toFixed(3)} JitoSOL → SOL for operational runway.`,
          params: { amount: pullAmount },
          urgency: 'high',
          estimatedImpactUsd: pullAmount * state.solPriceUsd,
          intelUsed: [],
          tier: 'AUTO',
        };
        d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
        decisions.push(d);
      }
    }
  }

  // ── E) Polymarket prediction bets (using scout intel) ─────────────
  if (isStrategyGated('polymarket')) {
    logger.info(`[CFO:Decision] Section E skip: polymarket strategy score below ${MIN_STRATEGY_SCORE} (${learned.strategyScores['polymarket']?.toFixed(0) ?? '?'}/100, ${learned.sampleSizes['polymarket'] ?? 0} trades)`);
  } else if (config.autoPolymarket && env.polymarketEnabled && state.polyHeadroomUsd >= 2) {
    // Apply learned cooldown multiplier (slower if poorly calibrated, faster if well-calibrated)
    const effectiveCooldown = config.polyBetCooldownMs * applyAdaptive(1.0, learned.polyCooldownMultiplier, conf);
    if (checkCooldown('POLY_BET', effectiveCooldown)) {
      // Build scout context for probability estimation
      const scoutCtx = intel.scoutReceivedAt
        ? { cryptoBullish: intel.scoutBullish, btcAbove: undefined, relevantNarratives: intel.scoutNarratives ?? [] }
        : undefined;

      try {
        const polyMod = await import('./polymarketService.ts');

        // Use a floor bankroll of $100 for Kelly sizing so small wallet balances still
        // produce sensible bet fractions. Actual bets are always capped to what's available.
        const kellyBankroll = Math.max(state.polyHeadroomUsd, 100);
        const opps = await polyMod.scanOpportunities(kellyBankroll, scoutCtx);

        // Take top 2 opportunities and create decisions
        for (const opp of opps.slice(0, 2)) {
          // Adjust probability estimate using live token intel
          const intelAdj = adjustPolyProbabilityWithIntel(opp.market.question, opp.ourProb, intel);
          const adjustedOurProb = intelAdj.adjustedProb;
          const adjustedEdge = adjustedOurProb - opp.marketProb;

          // Skip if intel adjustment killed the edge
          // Apply learned minEdge (higher if model has been overconfident)
          const effectiveMinEdge = applyAdaptive(env.minEdge, learned.minEdgeOverride / env.minEdge, conf);
          if (adjustedEdge < Math.max(0.03, effectiveMinEdge)) continue;

          // Cap to actual available balance — kelly reference bankroll is just for sizing math
          // Apply learned bet-size multiplier (smaller if poor calibration) + global risk
          const learnedBetUsd = opp.recommendedUsd * applyAdaptive(1.0, learned.polyBetSizeMultiplier, conf) * globalRisk;
          const betUsd = Math.min(learnedBetUsd, state.polyHeadroomUsd, env.maxSingleBetUsd);
          if (betUsd < 1) continue;   // lowered from $2 — small wallet shouldn't kill all bets

          const d: Decision = {
            type: 'POLY_BET',
            reasoning:
              `Polymarket: "${opp.market.question.slice(0, 80)}" — ` +
              `edge: ${(adjustedEdge * 100).toFixed(1)}% ` +
              `(our: ${(adjustedOurProb * 100).toFixed(0)}% [adj from ${(opp.ourProb * 100).toFixed(0)}%] ` +
              `vs market: ${(opp.marketProb * 100).toFixed(0)}%) | ` +
              `${opp.rationale}` +
              (intelAdj.reasoning !== 'No token intel available for this market' ? ` | Intel: ${intelAdj.reasoning}` : '') +
              (intel.scoutBullish !== undefined ? ` | Scout: ${intel.scoutBullish ? 'bullish' : 'bearish'}` : ''),
            params: {
              conditionId: opp.market.conditionId,
              tokenId: opp.targetToken.tokenId,
              side: opp.targetToken.outcome,
              pricePerShare: opp.marketProb,
              sizeUsd: betUsd,
              marketQuestion: opp.market.question,
              kellyFraction: opp.kellyFraction,
              edge: adjustedEdge,
              adjustedOurProb,
              intelConfidence: intelAdj.confidence,
            },
            urgency: 'low',
            estimatedImpactUsd: betUsd,
            intelUsed: [
              intel.scoutReceivedAt ? 'scout' : '',
              intel.analystPricesAt ? 'analyst' : '',
              intel.guardianSnapshotAt ? 'guardian' : '',
            ].filter(Boolean),
            tier: 'AUTO',
          };
          d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
          decisions.push(d);
        }
      } catch (err) {
        logger.debug('[CFO:Decision] Polymarket scan failed (non-fatal):', err);
      }
    }
  }

  // ── F) Simple collateral loop — borrow USDC, deploy for spread ───────────
  // Fetch alt market APY upfront (used for both decision and diagnostics)
  let altMarketUsdcApy = state.kaminoUsdcSupplyApy; // fallback to main market
  if (env.kaminoEnabled && env.kaminoBorrowEnabled) {
    try {
      const kamino = await import('./kaminoService.ts');
      altMarketUsdcApy = await kamino.fetchAltMarketUsdcApy();
    } catch { /* use fallback */ }
  }

  if (
    env.kaminoEnabled && env.kaminoBorrowEnabled &&
    !state.kaminoJitoLoopActive &&           // don't double up — one active strategy at a time
    state.kaminoBorrowableUsd >= 10 &&
    state.kaminoHealthFactor > 1.8 &&
    state.kaminoLtv < (env.kaminoBorrowMaxLtvPct / 100) * 0.85
  ) {
    if (checkCooldown('KAMINO_BORROW_DEPLOY', 6 * 3600_000)) {
      const borrowCost = state.kaminoBorrowApy;

      const estimatedDeployYield = intel.scoutBullish && env.polymarketEnabled && state.polyHeadroomUsd > 5
        ? Math.max(altMarketUsdcApy, 0.18) // Polymarket expected ~18% if bullish
        : altMarketUsdcApy;

      const spreadPct = (estimatedDeployYield - borrowCost) * 100;
      // Apply learned Kamino spread floor (higher if actual yield < projected)
      const effectiveMinSpread = applyAdaptive(env.kaminoBorrowMinSpreadPct ?? 3, learned.kaminoSpreadFloorMultiplier, conf);
      if (spreadPct >= effectiveMinSpread) {
        const borrowUsd = Math.min(state.kaminoBorrowableUsd * 0.6, env.maxKaminoBorrowUsd * 0.5);
        if (borrowUsd >= 10) {
          const deployTarget = intel.scoutBullish && env.polymarketEnabled && state.polyHeadroomUsd >= borrowUsd
            ? 'polymarket' : 'kamino_supply';
          decisions.push({
            type: 'KAMINO_BORROW_DEPLOY',
            reasoning:
              `Collateral loop: borrow $${borrowUsd.toFixed(0)} USDC at ${(borrowCost * 100).toFixed(1)}% → ` +
              `deploy into ${deployTarget} at ~${(estimatedDeployYield * 100).toFixed(1)}%. ` +
              `Spread: ${spreadPct.toFixed(1)}% | LTV: ${(state.kaminoLtv * 100).toFixed(1)}% | Health: ${state.kaminoHealthFactor.toFixed(2)}`,
            params: { borrowUsd, deployTarget, borrowApy: borrowCost, deployApy: estimatedDeployYield, spreadPct },
            urgency: 'low',
            estimatedImpactUsd: borrowUsd,
            intelUsed: intel.scoutBullish !== undefined ? ['scout'] : [],
            tier: 'APPROVAL',   // ALWAYS require admin approval for borrowing (was auto-approving based on spread profit)
          });
        }
      }
    }
  }

  // Section F skip diagnostics
  if (env.kaminoEnabled && env.kaminoBorrowEnabled) {
    if (state.kaminoDepositValueUsd < 1 && state.jitoSolBalance >= 0.1) {
      logger.debug(
        `[CFO:Decision] Section F skip: no Kamino collateral deposited yet. ` +
        `JitoSOL in wallet: ${state.jitoSolBalance.toFixed(4)} ($${state.jitoSolValueUsd.toFixed(0)}). ` +
        `Section G (Jito Loop) will deposit it automatically if spread is profitable.`
      );
    } else if (state.kaminoBorrowableUsd < 10) {
      logger.debug(`[CFO:Decision] Section F skip: kaminoBorrowableUsd=$${state.kaminoBorrowableUsd.toFixed(0)} (need ≥$10) | deposits=$${state.kaminoDepositValueUsd.toFixed(0)}`);
    } else if (state.kaminoHealthFactor <= 1.8) {
      logger.debug(`[CFO:Decision] Section F skip: healthFactor=${state.kaminoHealthFactor.toFixed(2)} (need >1.8)`);
    } else {
      const borrowCostDiag = state.kaminoBorrowApy;
      const deployYieldDiag = altMarketUsdcApy ?? state.kaminoUsdcSupplyApy;
      const spreadDiag = (deployYieldDiag - borrowCostDiag) * 100;
      const diagMinSpread = applyAdaptive(env.kaminoBorrowMinSpreadPct ?? 3, learned.kaminoSpreadFloorMultiplier, conf);
      if (spreadDiag < diagMinSpread) {
        logger.debug(
          `[CFO:Decision] Section F skip: spread=${spreadDiag.toFixed(1)}% (supply=${(deployYieldDiag * 100).toFixed(1)}% - borrow=${(borrowCostDiag * 100).toFixed(1)}%) — need ≥${diagMinSpread.toFixed(1)}%`
        );
      }
    }
  } else if (env.kaminoEnabled && !env.kaminoBorrowEnabled) {
    logger.debug('[CFO:Decision] Section F skip: CFO_KAMINO_BORROW_ENABLE=false');
  }

  // ── G) JitoSOL/SOL Multiply loop ─────────────────────────────────────────
  // NOTE: If the dynamic multi-LST loop (G2) is enabled, skip this section —
  // G2 already evaluates JitoSOL alongside all other LSTs and picks the best spread.
  // Available JitoSOL: already staked OR can stake from wallet this cycle
  const jitoSolAvailable = state.jitoSolBalance >= 0.1
    ? state.jitoSolBalance
    : state.idleSolForStaking >= 0.1
      ? state.idleSolForStaking * 0.9   // 90% of idle wallet SOL (leave buffer)
      : 0;

  if (
    env.kaminoEnabled && env.kaminoBorrowEnabled && env.kaminoJitoLoopEnabled &&
    !env.kaminoLstLoopEnabled &&          // skip if dynamic LST loop covers JitoSOL
    !state.kaminoJitoLoopActive &&
    jitoSolAvailable >= 0.1 &&              // JitoSOL staked OR enough wallet SOL to stake
    state.kaminoHealthFactor > 2.0 &&
    intel.marketCondition !== 'danger'
  ) {
    if (checkCooldown('KAMINO_JITO_LOOP', 2 * 3600_000)) {
      // JitoSOL value = staking rewards (~7% base + 1-2% MEV tips).
      // The Kamino supply APY (kaminoJitoSupplyApy) only reflects the lending pool rate
      // (people paying to borrow JitoSOL), NOT the staking yield the token accrues.
      // Real return = MAX(kamino_supply_apy, staking_yield).
      // Use the dynamic registry instead of a hardcoded 8% constant.
      const kamino = await import('./kaminoService.ts');
      const jitoReserve = await kamino.getReserve('JitoSOL');
      const jitoStakingYield = jitoReserve?.baseStakingYield ?? 0.08;
      const effectiveJitoApy = Math.max(state.kaminoJitoSupplyApy, jitoStakingYield);
      const loopSpread = effectiveJitoApy - state.kaminoSolBorrowApy;
      if (loopSpread > 0.01) { // need at least 1% spread
        const targetLtv = applyAdaptive((env.kaminoJitoLoopTargetLtv ?? 65) / 100, learned.kaminoLtvMultiplier, conf);
        const leverage = 1 / (1 - targetLtv);
        const estimatedApy = leverage * effectiveJitoApy - (leverage - 1) * state.kaminoSolBorrowApy;
        const jitoSolToCommit = jitoSolAvailable;
        const needsStakeFirst = state.jitoSolBalance < 0.1; // stake from wallet before looping

        decisions.push({
          type: 'KAMINO_JITO_LOOP',
          reasoning:
            `JitoSOL/SOL Multiply: deposit ${jitoSolToCommit.toFixed(3)} JitoSOL + loop to ${(targetLtv * 100).toFixed(0)}% LTV ` +
            `(~${leverage.toFixed(1)}x leverage). ` +
            `JitoSOL yield: ${(effectiveJitoApy * 100).toFixed(1)}% (staking+MEV), ` +
            `SOL borrow: ${(state.kaminoSolBorrowApy * 100).toFixed(1)}%, ` +
            `est. loop APY: ${(estimatedApy * 100).toFixed(1)}% ` +
            `(vs ${(effectiveJitoApy * 100).toFixed(1)}% unlevered). ` +
            `Market: ${intel.marketCondition}`,
          params: {
            jitoSolToDeposit: jitoSolToCommit,
            needsStakeFirst,
            targetLtv,
            maxLoops: env.kaminoJitoLoopMaxLoops ?? 3,
            solPriceUsd: state.solPriceUsd,
            estimatedApy,
          },
          urgency: 'low',
          estimatedImpactUsd: state.jitoSolValueUsd * (estimatedApy - state.kaminoJitoSupplyApy),
          intelUsed: [],
          tier: classifyTier('KAMINO_JITO_LOOP', 'low', state.jitoSolValueUsd * (estimatedApy - state.kaminoJitoSupplyApy), config, intel.marketCondition),
        });
      } else if (env.dryRun) {
        // ── Dry-run simulation: show what Kamino WOULD do if rates were favourable ──
        // This gives visibility into the full pipeline even when spread is negative.
        const targetLtv = applyAdaptive((env.kaminoJitoLoopTargetLtv ?? 65) / 100, learned.kaminoLtvMultiplier, conf);
        const leverage = 1 / (1 - targetLtv);
        const estimatedApy = leverage * effectiveJitoApy - (leverage - 1) * state.kaminoSolBorrowApy;
        const jitoSolToCommit = jitoSolAvailable;
        const needsStakeFirst = state.jitoSolBalance < 0.1;
        const breakEvenBorrowRate = effectiveJitoApy - 0.01; // rate at which spread = +1%

        decisions.push({
          type: 'KAMINO_JITO_LOOP',
          reasoning:
            `⏸ BLOCKED — spread is ${(loopSpread * 100).toFixed(1)}% (need >1%). ` +
            `JitoSOL yield: ${(effectiveJitoApy * 100).toFixed(1)}%, SOL borrow: ${(state.kaminoSolBorrowApy * 100).toFixed(1)}%. ` +
            `WOULD deposit ${jitoSolToCommit.toFixed(3)} JitoSOL ($${state.jitoSolValueUsd.toFixed(0)}) as collateral` +
            `${needsStakeFirst ? ' (stake SOL→JitoSOL first)' : ''}, ` +
            `loop to ${(targetLtv * 100).toFixed(0)}% LTV (~${leverage.toFixed(1)}x). ` +
            `At current rates the loop APY would be ${(estimatedApy * 100).toFixed(1)}% (negative — losing money). ` +
            `Break-even: SOL borrow needs to drop below ${(breakEvenBorrowRate * 100).toFixed(1)}%.`,
          params: {
            jitoSolToDeposit: jitoSolToCommit,
            needsStakeFirst,
            targetLtv,
            maxLoops: env.kaminoJitoLoopMaxLoops ?? 3,
            solPriceUsd: state.solPriceUsd,
            estimatedApy,
            blocked: true,
            blockReason: 'negative_spread',
            currentSpreadPct: loopSpread * 100,
            breakEvenBorrowRate,
          },
          urgency: 'low',
          estimatedImpactUsd: 0,
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    }
  }

  // Section G skip diagnostics
  if (env.kaminoEnabled && env.kaminoJitoLoopEnabled && !env.kaminoLstLoopEnabled && !state.kaminoJitoLoopActive) {
    const kaminoDiag = await import('./kaminoService.ts');
    const jitoReserveDiag = await kaminoDiag.getReserve('JitoSOL');
    const jitoStakingYieldDiag = jitoReserveDiag?.baseStakingYield ?? 0.08;
    const effectiveJitoApyDiag = Math.max(state.kaminoJitoSupplyApy, jitoStakingYieldDiag);
    const loopSpreadDiag = effectiveJitoApyDiag - state.kaminoSolBorrowApy;
    if (jitoSolAvailable < 0.1) {
      logger.debug(`[CFO:Decision] Section G skip: jitoSolBalance=${state.jitoSolBalance.toFixed(4)}, idleSol=${state.idleSolForStaking.toFixed(4)} (need ≥0.1 combined)`);
    } else if (state.kaminoHealthFactor <= 2.0) {
      logger.debug(`[CFO:Decision] Section G skip: healthFactor=${state.kaminoHealthFactor.toFixed(2)} (need >2.0)`);
    } else if (loopSpreadDiag <= 0.01) {
      logger.debug(`[CFO:Decision] Section G skip: spread=${(loopSpreadDiag * 100).toFixed(2)}% (jitoApy=${(effectiveJitoApyDiag * 100).toFixed(1)}% - solBorrow=${(state.kaminoSolBorrowApy * 100).toFixed(1)}%) — need >1%`);
    } else {
      logger.debug(`[CFO:Decision] Section G skip: cooldown not elapsed (24h between loop attempts)`);
    }
  }

  // ── G2) Multi-LST loop comparison — pick best spread among ALL Kamino LSTs ──
  // Only runs when CFO_KAMINO_LST_LOOP_ENABLE=true. Dynamically discovers all LSTs
  // from the Kamino reserve registry and picks the one with the best
  // (yield - SOL borrow cost) spread.
  if (
    env.kaminoEnabled && env.kaminoBorrowEnabled && env.kaminoLstLoopEnabled &&
    !state.kaminoActiveLstLoop &&     // no LST loop already active
    state.kaminoHealthFactor > 2.0 &&
    intel.marketCondition !== 'danger' &&
    checkCooldown('KAMINO_LST_LOOP', 2 * 3600_000)
  ) {
    try {
      const kamino = await import('./kaminoService.ts');
      const apys = await kamino.getApys();
      const lstReserves = await kamino.getLstAssets();

      // Evaluate each LST: find best spread
      type LstCandidate = {
        lst: string; balance: number; valueUsd: number;
        effectiveYield: number; spread: number; estimatedApy: number;
        needsSwap: boolean; // true if we need to swap SOL → LST first
      };

      const targetLtv = applyAdaptive((env.kaminoJitoLoopTargetLtv ?? 65) / 100, learned.kaminoLtvMultiplier, conf);
      const leverage = 1 / (1 - targetLtv);
      const solBorrowApy = apys.SOL?.borrowApy ?? state.kaminoSolBorrowApy;

      const candidates: LstCandidate[] = [];

      for (const r of lstReserves) {
        const lst = r.symbol;
        const walletBal = state.lstBalances[lst];
        const balance = walletBal?.balance ?? 0;
        const valueUsd = walletBal?.valueUsd ?? 0;

        // Can use wallet LST balance OR idle SOL (swap to LST)
        const available = balance >= 0.1
          ? balance
          : state.idleSolForStaking >= 0.1
            ? state.idleSolForStaking * 0.9
            : 0;

        if (available < 0.1) continue;
        // Skip LSTs without a reserve address (can't deposit into Kamino)
        if (!r.reserveAddress) continue;

        const baseYield = r.baseStakingYield;
        const kaminoSupply = apys[lst]?.supplyApy ?? 0;
        const effectiveYield = Math.max(kaminoSupply, baseYield);
        const spread = effectiveYield - solBorrowApy;
        const estimatedApy = leverage * effectiveYield - (leverage - 1) * solBorrowApy;

        candidates.push({
          lst, balance: available,
          valueUsd: available * state.solPriceUsd * 1.02,
          effectiveYield, spread, estimatedApy,
          needsSwap: balance < 0.1, // need to swap SOL → LST
        });
      }

      // Sort by spread descending — pick the best
      candidates.sort((a, b) => b.spread - a.spread);

      if (candidates.length > 0) {
        const best = candidates[0];
        const comparison = candidates.map(c =>
          `${c.lst}: ${(c.spread * 100).toFixed(1)}% spread (${(c.effectiveYield * 100).toFixed(1)}% yield)`
        ).join(', ');

        if (best.spread > 0.01) {
          // Profitable — create a KAMINO_LST_LOOP decision
          decisions.push({
            type: 'KAMINO_LST_LOOP',
            reasoning:
              `Best LST loop: ${best.lst}/SOL Multiply — deposit ${best.balance.toFixed(3)} ${best.lst} ` +
              `(~$${best.valueUsd.toFixed(0)}) + loop to ${(targetLtv * 100).toFixed(0)}% LTV (~${leverage.toFixed(1)}x). ` +
              `${best.lst} yield: ${(best.effectiveYield * 100).toFixed(1)}%, SOL borrow: ${(solBorrowApy * 100).toFixed(1)}%, ` +
              `est. loop APY: ${(best.estimatedApy * 100).toFixed(1)}%. ` +
              `Compared: ${comparison}. Market: ${intel.marketCondition}`,
            params: {
              lst: best.lst,
              lstAmount: best.balance,
              needsSwap: best.needsSwap,
              targetLtv,
              maxLoops: env.kaminoJitoLoopMaxLoops ?? 3,
              solPriceUsd: state.solPriceUsd,
              estimatedApy: best.estimatedApy,
              allCandidates: candidates.map(c => ({ lst: c.lst, spread: c.spread, apy: c.estimatedApy })),
            },
            urgency: 'low',
            estimatedImpactUsd: best.valueUsd * (best.estimatedApy - best.effectiveYield),
            intelUsed: [],
            tier: classifyTier('KAMINO_LST_LOOP', 'low', best.valueUsd * (best.estimatedApy - best.effectiveYield), config, intel.marketCondition),
          });
        } else if (env.dryRun) {
          // Dry-run: show the comparison even when all spreads are negative
          const breakEvenRate = best.effectiveYield - 0.01;
          decisions.push({
            type: 'KAMINO_LST_LOOP',
            reasoning:
              `⏸ BLOCKED — best spread is ${(best.spread * 100).toFixed(1)}% (${best.lst}, need >1%). ` +
              `All spreads: ${comparison}. SOL borrow: ${(solBorrowApy * 100).toFixed(1)}%. ` +
              `Break-even: SOL borrow needs to drop below ${(breakEvenRate * 100).toFixed(1)}%.`,
            params: {
              lst: best.lst,
              lstAmount: best.balance,
              blocked: true,
              blockReason: 'negative_spread',
              currentSpreadPct: best.spread * 100,
              breakEvenBorrowRate: breakEvenRate,
              allCandidates: candidates.map(c => ({ lst: c.lst, spread: c.spread, apy: c.estimatedApy })),
            },
            urgency: 'low',
            estimatedImpactUsd: 0,
            intelUsed: [],
            tier: 'NOTIFY',
          });
        }
      } else {
        logger.debug('[CFO:Decision] Section G2 skip: no LST available (JitoSOL, mSOL, bSOL all < 0.1)');
      }
    } catch (err) {
      logger.debug('[CFO:Decision] Section G2 scan failed (non-fatal):', err);
    }
  }

  // ── G3) Kamino Multiply Vault — managed auto-leveraged deposit ────────────
  // Alternative to manual loop: Kamino manages the leverage automatically.
  // We pick the best vault by APY and suggest depositing LST into it.
  if (
    env.kaminoEnabled && env.kaminoMultiplyVaultEnabled &&
    !state.kaminoActiveLstLoop &&       // don't double up with manual loop
    state.kaminoHealthFactor > 2.0 &&
    intel.marketCondition !== 'danger' &&
    checkCooldown('KAMINO_MULTIPLY_VAULT', 24 * 3600_000)
  ) {
    const bestVault = state.kaminoMultiplyVaults.find(
      v => v.tvl >= 100_000 && v.apy > 0.05,
    );
    if (bestVault) {
      // Find matching LST in wallet
      const lstKey = bestVault.collateralToken as keyof typeof state.lstBalances;
      const walletLst = state.lstBalances[lstKey];
      const lstAvailable = walletLst?.balance ?? 0;
      const canUseIdleSol = state.idleSolForStaking >= 0.1;

      if (lstAvailable >= 0.1 || canUseIdleSol) {
        const depositAmt = lstAvailable >= 0.1 ? lstAvailable : state.idleSolForStaking * 0.9;
        const depositValueUsd = depositAmt * state.solPriceUsd * 1.02;
        const needsSwap = lstAvailable < 0.1;

        const vaultSummary = state.kaminoMultiplyVaults.slice(0, 3).map(
          v => `${v.name} ${(v.apy * 100).toFixed(1)}% APY ($${(v.tvl / 1e6).toFixed(1)}M TVL)`,
        ).join(' | ');

        decisions.push({
          type: 'KAMINO_MULTIPLY_VAULT',
          reasoning:
            `Kamino Multiply vault: deposit ${depositAmt.toFixed(3)} ${bestVault.collateralToken} ` +
            `(~$${depositValueUsd.toFixed(0)}) into "${bestVault.name}" — ` +
            `${(bestVault.apy * 100).toFixed(1)}% APY at ${bestVault.leverage.toFixed(1)}x leverage, ` +
            `$${(bestVault.tvl / 1e6).toFixed(1)}M TVL. ` +
            `Kamino auto-manages rebalancing${needsSwap ? ` (swap SOL→${bestVault.collateralToken} first)` : ''}. ` +
            `Top vaults: ${vaultSummary}`,
          params: {
            vaultAddress: bestVault.address,
            vaultName: bestVault.name,
            collateralToken: bestVault.collateralToken,
            depositAmount: depositAmt,
            needsSwap,
            estimatedApy: bestVault.apy,
            leverage: bestVault.leverage,
            tvl: bestVault.tvl,
          },
          urgency: 'low',
          estimatedImpactUsd: depositValueUsd * bestVault.apy,
          intelUsed: [],
          tier: classifyTier('KAMINO_LST_LOOP', 'low', depositValueUsd * bestVault.apy, config, intel.marketCondition),
        });
      } else {
        logger.debug(`[CFO:Decision] Section G3 skip: no ${bestVault.collateralToken} in wallet and no idle SOL`);
      }
    } else if (state.kaminoMultiplyVaults.length > 0) {
      logger.debug(`[CFO:Decision] Section G3 skip: no vault with TVL≥$100k and APY>5% found (${state.kaminoMultiplyVaults.length} vaults checked)`);
    } else {
      logger.debug('[CFO:Decision] Section G3 skip: no multiply vault data available');
    }
  }

  // ── H) Auto-repay / unwind — LTV breached or loop unprofitable ────────────
  if (env.kaminoEnabled) {
    // Use separate thresholds for each strategy:
    // LST loop (JitoSOL/mSOL/bSOL) targets 65-72% LTV with ~95% liquidation threshold — 1.5 health factor is normal
    // Simple USDC loop targets <60% LTV with ~75% liquidation threshold — 1.5 is a real warning
    const anyLstLoopActive = state.kaminoJitoLoopActive || !!state.kaminoActiveLstLoop;
    const ltvBreached = anyLstLoopActive
      ? state.kaminoLtv > (env.kaminoJitoLoopMaxLtvPct / 100)
      : state.kaminoLtv > (env.kaminoBorrowMaxLtvPct / 100);
    const healthDanger = anyLstLoopActive
      ? state.kaminoHealthFactor < 1.2   // LST loop: danger is ~77% LTV (0.90/0.77 ≈ 1.17)
      : state.kaminoHealthFactor < 1.5;  // simple loop: tighter — liquidation is at 75%
    const loopUnprofitable = anyLstLoopActive && state.kaminoJitoLoopApy < 0;

    if ((ltvBreached || healthDanger) && state.kaminoBorrowValueUsd > 0) {
      const urgency: Decision['urgency'] = state.kaminoHealthFactor < 1.3 ? 'critical' : 'high';

      if (anyLstLoopActive) {
        // LST loop: correct response is full unwind (can't just repay USDC — borrow is SOL)
        const activeLst = state.kaminoActiveLstLoop ?? 'JitoSOL';
        const unwindType = state.kaminoJitoLoopActive ? 'KAMINO_JITO_UNWIND' : 'KAMINO_LST_UNWIND';
        decisions.push({
          type: unwindType as DecisionType,
          reasoning:
            `${activeLst} loop health degrading — LTV ${(state.kaminoLtv * 100).toFixed(1)}%, ` +
            `health factor ${state.kaminoHealthFactor.toFixed(2)}. Unwinding loop.`,
          params: { lst: activeLst },
          urgency,
          estimatedImpactUsd: state.kaminoBorrowValueUsd,
          intelUsed: [],
          tier: urgency === 'critical' ? 'AUTO' : 'NOTIFY',
        });
      } else {
        // Simple loop: repay USDC to bring LTV back to 40%
        const targetLtv = 0.40;
        const idealRepayUsd = Math.max(0, state.kaminoBorrowValueUsd - state.kaminoDepositValueUsd * targetLtv);
        if (idealRepayUsd > 0) {
          const walletUsdc = state.solanaUsdcBalance ?? 0;
          if (walletUsdc < 1) {
            // Wallet has no USDC — likely orphaned tokens from a failed borrow LP.
            // Generate a recovery-mode repay that swaps orphaned tokens → USDC first.
            if (checkCooldown('KAMINO_REPAY_RECOVER', 2 * 3600_000)) {
              decisions.push({
                type: 'KAMINO_REPAY',
                reasoning:
                  `Kamino LTV ${(state.kaminoLtv * 100).toFixed(1)}% (health: ${state.kaminoHealthFactor.toFixed(2)}) — ` +
                  `wallet has $${walletUsdc.toFixed(2)} USDC but borrow outstanding ($${state.kaminoBorrowValueUsd.toFixed(0)}). ` +
                  `Recovery mode: scanning wallet for orphaned tokens from failed borrow LP to swap → USDC → repay.`,
                params: { repayUsd: idealRepayUsd, repayAsset: 'USDC', recoverTokens: true },
                urgency,
                estimatedImpactUsd: idealRepayUsd,
                intelUsed: [],
                tier: 'AUTO',
              });
            } else {
              logger.debug(
                `[CFO:Decision] Kamino recovery repay on cooldown — wallet $${walletUsdc.toFixed(2)} USDC, ` +
                `borrow $${state.kaminoBorrowValueUsd.toFixed(0)}`,
              );
            }
          } else {
            // Cap repay to what the wallet actually has (keep 5% for gas/fees)
            const repayUsd = Math.min(idealRepayUsd, walletUsdc * 0.95);
            if (repayUsd < 0.50) {
              logger.warn(
                `[CFO:Decision] Kamino repay needed ($${idealRepayUsd.toFixed(0)}) but wallet only has $${walletUsdc.toFixed(2)} USDC — ` +
                `repay amount $${repayUsd.toFixed(2)} too small, skipping`,
              );
            } else {
              decisions.push({
                type: 'KAMINO_REPAY',
                reasoning:
                  `Kamino LTV ${(state.kaminoLtv * 100).toFixed(1)}% (health: ${state.kaminoHealthFactor.toFixed(2)}) — ` +
                  `repaying $${repayUsd.toFixed(0)} USDC to bring LTV toward ${targetLtv * 100}%` +
                  (repayUsd < idealRepayUsd ? ` (capped to wallet balance $${walletUsdc.toFixed(0)})` : ''),
                params: { repayUsd, repayAsset: 'USDC' },
                urgency,
                estimatedImpactUsd: repayUsd,
                intelUsed: [],
                tier: urgency === 'critical' ? 'AUTO' : 'NOTIFY',
              });
            }
          }
        }
      }
    // H-bis: Proactive repay — if wallet has USDC from LP fees/closes and Kamino has
    // an active borrow, repay some to reduce interest drag and free borrow capacity.
    // This is separate from the emergency LTV-breach repay above.
    } else if (
      state.kaminoBorrowValueUsd > 5 &&
      state.solanaUsdcBalance > 10 &&
      !ltvBreached && !healthDanger &&
      checkCooldown('KAMINO_REPAY_PROACTIVE', 6 * 3600_000)
    ) {
      // Repay up to 80% of wallet USDC (keep some for gas/fees)
      const repayUsd = Math.min(state.solanaUsdcBalance * 0.8, state.kaminoBorrowValueUsd);
      if (repayUsd > 5) {
        decisions.push({
          type: 'KAMINO_REPAY',
          reasoning:
            `Proactive repay — $${repayUsd.toFixed(0)} USDC in wallet from LP fees. ` +
            `Active borrow: $${state.kaminoBorrowValueUsd.toFixed(0)}. ` +
            `Repaying to reduce interest drag and free capacity for more BorrowLP.`,
          params: { repayUsd, repayAsset: 'USDC', proactive: true },
          urgency: 'low',
          estimatedImpactUsd: repayUsd * (state.kaminoBorrowApy ?? 0.08),
          intelUsed: [],
          tier: 'AUTO',  // small amounts, proactive = safe to auto-execute
        });
      }
    } else if (loopUnprofitable && checkCooldown('KAMINO_JITO_UNWIND', 12 * 3600_000)) {
      const activeLst = state.kaminoActiveLstLoop ?? 'JitoSOL';
      const unwindType = state.kaminoJitoLoopActive ? 'KAMINO_JITO_UNWIND' : 'KAMINO_LST_UNWIND';
      decisions.push({
        type: unwindType as DecisionType,
        reasoning:
          `${activeLst} loop unprofitable — current APY ${(state.kaminoJitoLoopApy * 100).toFixed(1)}% ` +
          `(SOL borrow rate exceeds ${activeLst} staking yield). Unwinding.`,
        params: { lst: activeLst },
        urgency: 'low',
        estimatedImpactUsd: 0,
        intelUsed: [],
        tier: 'NOTIFY',
      });
    }
  }

  // ── I) Orca Concentrated LP ───────────────────────────────────────────────
  // NOTE: New LP positions are opened via Section K (KAMINO_BORROW_LP) which
  // borrows USDC from Kamino rather than spending wallet SOL. Wallet SOL is
  // reserved for staking (Section C) and the Kamino leverage loop (Section G).
  // Section I only handles rebalancing existing positions + fee claims.
  // Gate on 'danger' only (not 'bearish') — existing positions still need
  // rebalancing in bearish markets to avoid drifting out of range.
  if (env.orcaLpEnabled && intel.marketCondition !== 'danger') {

    // ── Tier-based range width multipliers (mirrored from Krystal) ──
    const ORCA_TIER_RANGE_MULT: Record<string, number> = {
      low: 0.3,    // stables barely move → narrow range captures more fees
      medium: 0.8, // tighter than old 1.0 — earn more fees while near-price
      high: 1.5,   // volatile pairs need wide range but 2.0 was too generous
    };
    const ORCA_TIER_REBALANCE_MULT: Record<string, number> = {
      low: 0.8,    // stables rebalance sooner (tight range)
      medium: 1.0,
      high: 1.3,   // volatile pairs tolerate more drift
    };

    // I2: Rebalance out-of-range or near-edge positions
    for (const pos of state.orcaPositions) {
      const posTier = pos.riskTier ?? 'medium';
      const tierRebalMult = ORCA_TIER_REBALANCE_MULT[posTier] ?? 1.0;
      const tierRangeMult = ORCA_TIER_RANGE_MULT[posTier] ?? 1.0;
      const learnedTierMult = learned.lpTierRangeMultipliers?.[posTier] ?? 1.0;
      // Apply learned LP rebalance trigger (tighter if OOR rate high from learning)
      const effectiveRebalTrigger = applyAdaptive(env.orcaLpRebalanceTriggerPct * tierRebalMult, learned.lpRebalanceTriggerMultiplier, conf);
      if (!pos.inRange || pos.rangeUtilisationPct < effectiveRebalTrigger) {
        // Look up pool info from discovery cache for adaptive range calculation
        const poolInfo = pos.whirlpoolAddress
          ? await getPoolByAddress(pos.whirlpoolAddress).catch(() => null)
          : null;
        const tokenASymbol = pos.tokenA ?? poolInfo?.tokenA.symbol ?? 'SOL';
        const tokenBSymbol = pos.tokenB ?? poolInfo?.tokenB?.symbol ?? 'USDC';

        decisions.push({
          type: 'ORCA_LP_REBALANCE',
          reasoning:
            `[${posTier.toUpperCase()} risk] Orca LP ${pos.positionMint.slice(0, 8)} ${pos.inRange ? 'near range edge' : 'OUT OF RANGE'} ` +
            `(utilisation: ${pos.rangeUtilisationPct.toFixed(0)}%). Closing and reopening centred on current price.`,
          params: {
            positionMint: pos.positionMint,
            whirlpoolAddress: pos.whirlpoolAddress,
            riskTier: posTier,
            tokenA: pos.tokenA,
            tokenB: pos.tokenB,
            pair: pos.tokenA && pos.tokenB ? `${pos.tokenA}/${pos.tokenB}` : undefined,
            rangeWidthPct: adaptiveLpRangeWidthPct(
              tokenASymbol,
              intel,
              env.orcaLpRangeWidthPct * tierRangeMult * learnedTierMult,
              learned,
              tokenBSymbol,
            ),
          },
          urgency: pos.inRange ? 'low' : 'medium',
          estimatedImpactUsd: 0,
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    }

    // I3: Claim accumulated fees from existing Orca positions
    // Fees sit uncollected on-chain until position is closed/rebalanced.
    // Claiming proactively liberates USDC (→ repay Kamino borrow) and SOL (→ Jito stake).
    for (const pos of state.orcaPositions) {
      const feesUsd = pos.feesUsd ?? 0;
      if (feesUsd >= 2 && checkCooldown(`ORCA_LP_CLAIM_${pos.positionMint}`, 4 * 3600_000)) {
        decisions.push({
          type: 'ORCA_LP_CLAIM_FEES',
          reasoning:
            `Collecting $${feesUsd.toFixed(2)} unclaimed fees from ` +
            `${pos.tokenA ?? 'SOL'}/${pos.tokenB ?? 'USDC'} Orca LP — ` +
            `USDC proceeds → Kamino repay, SOL → Jito stake.`,
          params: {
            positionMint: pos.positionMint,
            tokenA: pos.tokenA,
            tokenB: pos.tokenB,
            feesUsd,
          },
          urgency: 'low',
          estimatedImpactUsd: feesUsd,
          intelUsed: [],
          tier: 'AUTO',
        });
      }
    }
  }

  // ── I-bis) Krystal EVM Concentrated LP ────────────────────────────────────
  //
  // Mirrors Section I (Orca LP) but on EVM chains, powered by Krystal Cloud API
  // for pool discovery and Uniswap V3 NonfungiblePositionManager for execution.
  //
  if (env.krystalLpEnabled && intel.marketCondition !== 'danger') {
    const krystalSkip = (reason: string) =>
      logger.debug(`[CFO:Decision] Section I-bis skip: ${reason}`);

    // I-bis.0: Claim accumulated fees from existing positions
    for (const pos of state.evmLpPositions) {
      if (pos.feesOwedUsd >= 2 && checkCooldown(`KRYSTAL_LP_CLAIM_${pos.posId}`, 4 * 3600_000)) {
        decisions.push({
          type: 'KRYSTAL_LP_CLAIM_FEES',
          reasoning:
            `Collecting $${pos.feesOwedUsd.toFixed(2)} unclaimed fees from ` +
            `${pos.token0Symbol}/${pos.token1Symbol} LP on ${pos.chainName}.`,
          params: {
            posId: pos.posId,
            chainNumericId: pos.chainNumericId,
            chainName: pos.chainName,
            protocol: pos.protocol,
            token0Symbol: pos.token0Symbol,
            token1Symbol: pos.token1Symbol,
            feesOwedUsd: pos.feesOwedUsd,
          },
          urgency: 'low',
          estimatedImpactUsd: pos.feesOwedUsd,
          intelUsed: [],
          tier: 'AUTO',
        });
      }
    }

    // I-bis.1: Rebalance out-of-range or near-edge EVM LP positions
    // Infer risk tier from token composition → use tier-specific range widths
    const _stableSet = new Set(['USDC', 'USDT', 'DAI', 'USDG', 'FRAX', 'TUSD', 'BUSD', 'USDCE', 'USDC.E']);
    const _inferTier = (t0: string, t1: string): 'low' | 'medium' | 'high' => {
      const s0 = _stableSet.has(t0.toUpperCase()), s1 = _stableSet.has(t1.toUpperCase());
      return s0 && s1 ? 'low' : (s0 || s1) ? 'medium' : 'high';
    };
    const _tierRangeMults: Record<string, number> = { low: 0.3, medium: 0.8, high: 1.5 };

    for (const pos of state.evmLpPositions) {
      const posTier = _inferTier(pos.token0Symbol, pos.token1Symbol);
      const tierMult = _tierRangeMults[posTier] ?? 1.0;
      const learnedTierMult = learned.lpTierRangeMultipliers?.[posTier] ?? 1.0;
      if (
        (!pos.inRange || pos.rangeUtilisationPct < env.krystalLpRebalanceTriggerPct) &&
        checkCooldown(`KRYSTAL_LP_REBALANCE_${pos.posId}`, 6 * 3600_000) // 6h per-position cooldown
      ) {
        decisions.push({
          type: 'KRYSTAL_LP_REBALANCE',
          reasoning:
            `[${posTier.toUpperCase()} risk] EVM LP ${pos.posId.slice(0, 8)} (${pos.token0Symbol}/${pos.token1Symbol}, ${pos.chainName}) ` +
            `${pos.inRange ? 'near range edge' : 'OUT OF RANGE'} ` +
            `(utilisation: ${pos.rangeUtilisationPct.toFixed(0)}%). Closing and reopening centred.`,
          params: {
            posId: pos.posId,
            chainNumericId: pos.chainNumericId,
            chainName: pos.chainName,
            protocol: pos.protocol,
            poolAddress: pos.poolAddress,
            token0Symbol: pos.token0Symbol,
            token1Symbol: pos.token1Symbol,
            token0Address: pos.token0Address,
            token1Address: pos.token1Address,
            token0Decimals: pos.token0Decimals,
            token1Decimals: pos.token1Decimals,
            closeOnly: false,
            riskTier: posTier,
            rangeWidthTicks: Math.round(adaptiveLpRangeWidthTicks(
              pos.token0Symbol,
              intel,
              env.krystalLpRangeWidthTicks * tierMult * learnedTierMult,
              learned,
              pos.token1Symbol,
            )),
          },
          urgency: pos.inRange ? 'low' : 'medium',
          estimatedImpactUsd: pos.valueUsd * 0.02, // rebalance cost ~2%
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    }

    // I-bis.2: Open new EVM LP position(s) — 3-tier risk system
    // Enabled tiers: env.krystalLpRiskTiers (e.g. ['low','medium','high'])
    // Each tier picks the best pool of its class so the portfolio gets diversified
    // exposure across risk levels.
    //
    //   low    = stable/stable (USDC/USDT)  → narrow range, minimal IL
    //   medium = volatile/stable (WETH/USDC) → normal range
    //   high   = volatile/volatile (WETH/ARB) → wide range, high APR, high IL
    //
    const evmLpHeadroomUsd = Math.max(0, env.krystalLpMaxUsd - state.evmLpTotalValueUsd);
    // Cap deploy to 80% of total deployable EVM value (stables + WETH + native).
    // The execution code (Phase 2b/3) handles swapping WETH/native → pool tokens,
    // so we should not gate on stablecoins alone.
    const evmTotalDeployableUsd = state.evmTotalUsdcAllChains + state.evmTotalNativeAllChains;
    const evmDeployCap = evmTotalDeployableUsd * 0.8;
    if (
      evmLpHeadroomUsd >= 20 &&
      evmTotalDeployableUsd >= 20 &&
      state.evmLpPositions.length < env.krystalLpMaxPositions &&
      intel.marketCondition !== 'bearish' &&
      checkCooldown('KRYSTAL_LP_OPEN', env.krystalLpOpenCooldownMs)
    ) {
      try {
        const krystal = await import('./krystalService.ts');
        const pools = await krystal.discoverKrystalPools();

        // Apply learned APR floor adjustment (raised if past LP positions underperformed)
        const learnedMinApr = env.krystalLpMinApr7d + (learned.lpMinAprAdjustment * learned.confidenceLevel);

        // Build set of chains where we actually have deployable value (stables + native + WETH >= $10)
        // OR chains we can bridge to from a funded chain (any configured RPC chain)
        const fundedChainIds = new Set(
          state.evmChainBalances
            .filter(b => b.totalValueUsd >= 10)
            .map(b => b.chainId),
        );
        // If any chain has enough to bridge, all configured chains are reachable
        const totalCrossChainValue = state.evmChainBalances.reduce((s, b) => s + b.totalValueUsd, 0);
        const bridgeReachable = totalCrossChainValue >= 20 && env.lifiEnabled;
        const deployableChainIds = bridgeReachable
          ? new Set([...fundedChainIds, ...Object.keys(env.evmRpcUrls).map(Number)])
          : fundedChainIds;

        // Build set of chains with enough native gas for LP operations (approve×2 + swap + mint).
        // 0.003 ETH ~= $6 — covers multi-step txs on all EVM chains comfortably.
        const MIN_GAS_NATIVE = 0.003;
        const gasReadyChainIds = new Set(
          state.evmChainBalances
            .filter(b => b.nativeBalance >= MIN_GAS_NATIVE)
            .map(b => b.chainId),
        );

        const eligible = pools.filter(p =>
          p.tvlUsd >= env.krystalLpMinTvlUsd &&
          p.apr7d >= learnedMinApr &&
          (env.evmRpcUrls[p.chainNumericId] || p.chainNumericId === 42161) &&
          deployableChainIds.has(p.chainNumericId) && // deploy on funded chains OR bridge-reachable chains
          gasReadyChainIds.has(p.chainNumericId) &&   // must have enough native gas on target chain
          env.krystalLpRiskTiers.has(p.riskTier) &&
          // Skip pools with known-unswappable tokens (populated by pre-flight failures, TTL 2h)
          !swapSvc.hasSwapFailure(p.chainNumericId, p.token0.address) &&
          !swapSvc.hasSwapFailure(p.chainNumericId, p.token1.address),
        );

        // Build a map from normalised pair key → existing position (for increase-liquidity)
        // Case-insensitive symbol comparison prevents duplicates from mismatched casing (cbBTC vs CBBTC)
        const existingPairMap = new Map<string, { posId: string; inRange: boolean; valueUsd: number }>();
        for (const p of state.evmLpPositions) {
          const k = `${p.chainNumericId}_${p.token0Symbol.toUpperCase()}_${p.token1Symbol.toUpperCase()}`;
          const kRev = `${p.chainNumericId}_${p.token1Symbol.toUpperCase()}_${p.token0Symbol.toUpperCase()}`;
          const val = { posId: p.posId, inRange: p.inRange, valueUsd: p.valueUsd };
          existingPairMap.set(k, val);
          existingPairMap.set(kRev, val);
        }

        // Separate eligible pools into new vs existing-pair
        const newPools: typeof eligible = [];
        const increasePools: Array<{ pool: typeof eligible[0]; existing: { posId: string; inRange: boolean; valueUsd: number } }> = [];
        for (const p of eligible) {
          const key = `${p.chainNumericId}_${p.token0.symbol.toUpperCase()}_${p.token1.symbol.toUpperCase()}`;
          const existing = existingPairMap.get(key);
          if (existing) {
            // Only add to in-range positions (out-of-range → let rebalance handle it)
            if (existing.inRange) increasePools.push({ pool: p, existing });
          } else {
            newPools.push(p);
          }
        }

        // ── Tier-based range width multipliers ──
        // Tighter ranges = more concentrated liquidity = higher fee capture.
        // Only widen for genuinely volatile pairs, and even then keep it moderate.
        const TIER_RANGE_MULT: Record<string, number> = {
          low: 0.3,    // stables barely move → very narrow range captures max fees
          medium: 0.8, // major-volatile/stable pairs → moderately narrow (was 1.0)
          high: 1.5,   // volatile pairs need wider range but not 2x (was 2.0)
        };

        // ── Tier-based rebalance trigger adjustments (lower = more sensitive) ──
        const TIER_REBALANCE_MULT: Record<string, number> = {
          low: 0.8,    // stables rebalance sooner (tight range = less tolerance)
          medium: 1.0,
          high: 1.3,   // volatile pairs tolerate more drift before rebalance
        };

        // Split headroom across enabled tiers (equal share)
        const enabledTiers = env.krystalLpRiskTiers;
        const perTierMaxUsd = evmLpHeadroomUsd / Math.max(enabledTiers.size, 1);

        // Group eligible pools by tier and pick the best from each
        const bestSolanaApr = state.orcaLpFeeApy ?? 0;
        let tiersOpened = 0;

        // Track pairs already selected for OPEN this cycle to prevent duplicate
        // positions for the same pair across tiers (e.g. WETH/USDC appearing in
        // both 'medium' and 'high' tiers from different DEXes).
        const pairsSelectedThisCycle = new Set<string>();

        for (const tier of enabledTiers) {
          // Respect max positions (could have filled up from another tier)
          if (state.evmLpPositions.length + tiersOpened >= env.krystalLpMaxPositions) break;

          // Exclude pools whose pair was already selected in another tier this cycle
          const tierPools = newPools.filter(p =>
            p.riskTier === tier &&
            !pairsSelectedThisCycle.has(`${p.chainNumericId}_${p.token0.symbol.toUpperCase()}_${p.token1.symbol.toUpperCase()}`) &&
            !pairsSelectedThisCycle.has(`${p.chainNumericId}_${p.token1.symbol.toUpperCase()}_${p.token0.symbol.toUpperCase()}`),
          );
          if (tierPools.length === 0) {
            krystalSkip(`no ${tier}-risk NEW pools pass filters (${newPools.length} new, ${increasePools.length} increase-eligible)`);
            continue;
          }

          const best = tierPools[0]; // already sorted by score

          // Check: EVM APR must beat best Solana LP APR by 5% (skip this check for high-risk — APR compensates)
          if (tier !== 'high' && best.apr7d <= bestSolanaApr + 5) {
            krystalSkip(`${tier} tier: best EVM APR ${best.apr7d.toFixed(1)}% doesn't beat Solana ${bestSolanaApr.toFixed(1)}% + 5%`);
            continue;
          }

          // Cap deploy to available value: target chain local value + bridgeable value from other chains
          const targetChainBal = state.evmChainBalances.find(b => b.chainId === best.chainNumericId);
          const targetChainLocalValue = targetChainBal?.totalValueUsd ?? 0;
          // If target chain is underfunded, consider bridgeable funds from other chains (minus ~3% for bridge fees)
          const otherChainsValue = bridgeReachable
            ? state.evmChainBalances
                .filter(b => b.chainId !== best.chainNumericId && b.totalValueUsd >= 5)
                .reduce((s, b) => s + b.totalValueUsd, 0) * 0.97
            : 0;
          const effectiveValue = targetChainLocalValue + otherChainsValue;
          const deployUsd = Math.min(perTierMaxUsd, env.krystalLpMaxUsd, evmDeployCap, effectiveValue * 0.9);

          if (deployUsd < 15) {
            krystalSkip(`${tier} tier: deploy amount too small ($${deployUsd.toFixed(0)}, local=$${targetChainLocalValue.toFixed(0)}, bridgeable=$${otherChainsValue.toFixed(0)})`);
            continue;
          }

          // Tier-specific range width (base × tier multiplier × learned tier multiplier)
          const tierRangeMult = TIER_RANGE_MULT[tier] ?? 1.0;
          const learnedTierMult = learned.lpTierRangeMultipliers?.[tier] ?? 1.0;
          const rangeWidthTicks = Math.round(adaptiveLpRangeWidthTicks(
            best.token0.symbol,
            intel,
            env.krystalLpRangeWidthTicks * tierRangeMult * learnedTierMult,
            learned,
            best.token1.symbol,
          ));

          decisions.push({
            type: 'KRYSTAL_LP_OPEN',
            reasoning:
              `Opening [${tier.toUpperCase()} risk] EVM LP: ${best.token0.symbol}/${best.token1.symbol} on ${best.chainName} ` +
              `($${deployUsd.toFixed(0)}) [risk: ${best.riskTier}]. Pool score: ${best.score.toFixed(0)}/100 — ` +
              `APR7d ${best.apr7d.toFixed(1)}%, TVL $${(best.tvlUsd / 1e6).toFixed(1)}M, ` +
              `range ${rangeWidthTicks} ticks. ` +
              `${best.reasoning.join(', ')}.`,
            params: {
              pool: {
                chainId: best.chainId,
                chainNumericId: best.chainNumericId,
                poolAddress: best.poolAddress,
                token0: best.token0,
                token1: best.token1,
                protocol: best.protocol,
                feeTier: best.feeTier,
              },
              deployUsd,
              rangeWidthTicks,
              riskTier: tier,
              chainName: best.chainName,
              pair: `${best.token0.symbol}/${best.token1.symbol}`,
              // Bridge funding: pick the chain with the most total value (stables + native + WETH)
              bridgeFunding: (() => {
                const bestBal = state.evmChainBalances
                  .filter(b => b.chainId !== best.chainNumericId && b.totalValueUsd >= deployUsd * 0.5)
                  .sort((a, b) => b.totalValueUsd - a.totalValueUsd)[0];
                if (bestBal && env.evmPrivateKey) {
                  return { sourceChainId: bestBal.chainId, walletAddress: '' };
                }
                return undefined;
              })(),
            },
            urgency: 'low',
            estimatedImpactUsd: deployUsd * (best.apr7d / 100 / 52), // weekly yield estimate
            intelUsed: [
              intel.analystEvmLpAt ? 'analyst' : '',
              intel.guardianReceivedAt ? 'guardian' : '',
            ].filter(Boolean),
            tier: classifyTier('KRYSTAL_LP_OPEN', 'low', deployUsd, config, intel.marketCondition),
          });
          tiersOpened++;

          // Mark this pair as selected so no other tier can open it again this cycle
          const pairKey0 = `${best.chainNumericId}_${best.token0.symbol.toUpperCase()}_${best.token1.symbol.toUpperCase()}`;
          const pairKey1 = `${best.chainNumericId}_${best.token1.symbol.toUpperCase()}_${best.token0.symbol.toUpperCase()}`;
          pairsSelectedThisCycle.add(pairKey0);
          pairsSelectedThisCycle.add(pairKey1);
          // Also add to existingPairMap so INCREASE section doesn't double-up
          existingPairMap.set(pairKey0, { posId: 'pending', inRange: true, valueUsd: deployUsd });
          existingPairMap.set(pairKey1, { posId: 'pending', inRange: true, valueUsd: deployUsd });
        }

        // ── KRYSTAL_LP_INCREASE: add liquidity to existing in-range positions ──
        // Instead of opening duplicate positions, route funds to existing ones.
        // Gated by: cooldown, learning engine pair performance, and minimum APR.
        // Doesn't count toward tiersOpened or max positions.
        if (checkCooldown('KRYSTAL_LP_INCREASE', 6 * 3600_000)) {
          // Only increase positions whose pair is in the learning engine's "bestPairs"
          // or has too few data points to judge (benefit of the doubt).
          const learnedBestPairs = new Set(
            (learned.lpBestPairs ?? []).map((p: string) => p.toUpperCase()),
          );
          const hasEnoughLearningData = (learned.lpTotalPositions ?? 0) >= 3;

          for (const { pool: incPool, existing } of increasePools) {
            const pairKey = `${incPool.token0.symbol}/${incPool.token1.symbol}`.toUpperCase();
            const pairKeyRev = `${incPool.token1.symbol}/${incPool.token0.symbol}`.toUpperCase();

            // Learning gate: skip pairs that are performing badly (known, not in bestPairs)
            if (hasEnoughLearningData && learnedBestPairs.size > 0 &&
                !learnedBestPairs.has(pairKey) && !learnedBestPairs.has(pairKeyRev)) {
              krystalSkip(`increase: ${pairKey} not in learned bestPairs — waiting for more data`);
              continue;
            }

            // Cap deploy per increase to per-tier budget
            const targetChainBal = state.evmChainBalances.find(b => b.chainId === incPool.chainNumericId);
            const localValue = targetChainBal?.totalValueUsd ?? 0;
            const deployUsd = Math.min(perTierMaxUsd, env.krystalLpMaxUsd, evmDeployCap, localValue * 0.9);
            if (deployUsd < 10) continue; // too small to bother

            decisions.push({
              type: 'KRYSTAL_LP_INCREASE',
              reasoning:
                `Adding $${deployUsd.toFixed(0)} to existing ${incPool.token0.symbol}/${incPool.token1.symbol} LP #${existing.posId} on ${incPool.chainName} ` +
                `(current $${existing.valueUsd.toFixed(0)}, in-range). APR7d ${incPool.apr7d.toFixed(1)}%.`,
              params: {
                pool: {
                  chainId: incPool.chainId,
                  chainNumericId: incPool.chainNumericId,
                  poolAddress: incPool.poolAddress,
                  token0: incPool.token0,
                  token1: incPool.token1,
                  protocol: incPool.protocol,
                  feeTier: incPool.feeTier,
                },
                deployUsd,
                rangeWidthTicks: 0, // not used for increase — uses existing range
                riskTier: incPool.riskTier ?? 'medium',
                chainName: incPool.chainName,
                pair: `${incPool.token0.symbol}/${incPool.token1.symbol}`,
                existingPosId: existing.posId,
              },
              urgency: 'low',
              estimatedImpactUsd: deployUsd * (incPool.apr7d / 100 / 52),
              intelUsed: [
                intel.analystEvmLpAt ? 'analyst' : '',
                intel.guardianReceivedAt ? 'guardian' : '',
              ].filter(Boolean),
              tier: classifyTier('KRYSTAL_LP_INCREASE', 'low', deployUsd, config, intel.marketCondition),
            });
          }
        }

        if (tiersOpened === 0 && newPools.length === 0 && increasePools.length === 0) {
          krystalSkip('no eligible pools (' + pools.length + ' total, 0 pass filters' +
            ' — allowed tiers: ' + [...env.krystalLpRiskTiers].join(',') + ')');
        }
      } catch (err) {
        logger.debug('[CFO:Decision] Krystal pool discovery failed:', err);
      }
    }
  }

  // Sort by urgency: critical > high > medium > low
  const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  decisions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  // ── J) EVM Flash Arbitrage (Arbitrum) ─────────────────────────────────────
  // Uses dynamic pool list from DeFiLlama. On-chain quotes only — no API latency.
  // AUTO tier: worst case is a reverted tx (~$0.05 gas). No capital at risk.
  if (isStrategyGated('evm_flash_arb')) {
    logger.info(`[CFO:Decision] Section J skip: evm_flash_arb strategy score below ${MIN_STRATEGY_SCORE} (${learned.strategyScores['evm_flash_arb']?.toFixed(0) ?? '?'}/100)`);
  } else if (!env.evmArbEnabled) {
    logger.info('[CFO:Decision] Section J skip: evmArbEnabled=false');
  } else if (!env.evmArbReceiverAddress) {
    logger.debug('[CFO:Decision] Section J skip: no receiver contract address (CFO_EVM_ARB_RECEIVER_ADDRESS)');
  } else if (intel.guardianCritical) {
    logger.debug('[CFO:Decision] Section J skip: guardian critical alert active');
  } else if (intel.marketCondition === 'danger') {
    logger.debug('[CFO:Decision] Section J skip: market condition = danger');
  } else if (!checkCooldown('EVM_FLASH_ARB', 60_000)) {
    logger.debug('[CFO:Decision] Section J skip: cooldown (scanned <60s ago)');
  } else {
    try {
      const arbMod   = await import('./evmArbService.ts');
      const ethPrice = intel.analystPrices?.['ETH']?.usd ?? 3000;
      const poolCount = arbMod.getCandidatePoolCount();
      // Apply learned arb min profit multiplier (higher if slippage eats profits)
      const effectiveArbMinProfit = applyAdaptive(env.evmArbMinProfitUsdc ?? 2, learned.evmArbMinProfitMultiplier, conf);
      logger.debug(`[CFO:Decision] Section J: scanning ${poolCount} Arbitrum pools (ETH=$${ethPrice.toFixed(0)}, minProfit=$${effectiveArbMinProfit.toFixed(2)})...`);
      const opp      = await arbMod.scanForOpportunity(ethPrice);

      if (opp && opp.netProfitUsd >= effectiveArbMinProfit) {
        logger.info(
          `[CFO:Decision] Section J: 💡 ARB FOUND — ${opp.displayPair} net=$${opp.netProfitUsd.toFixed(3)} ` +
          `(min=$${effectiveArbMinProfit.toFixed(2)}${learned.evmArbMinProfitMultiplier !== 1 ? ` [learned×${learned.evmArbMinProfitMultiplier.toFixed(2)}]` : ''})`,
        );
        decisions.push({
          type: 'EVM_FLASH_ARB',
          reasoning:
            `Flash arb: ${opp.displayPair} | buy ${opp.buyPool.dex} sell ${opp.sellPool.dex} | ` +
            `flash $${opp.flashAmountUsd.toLocaleString()} | ` +
            `gross $${opp.expectedGrossUsd.toFixed(3)} − Aave $${opp.aaveFeeUsd.toFixed(3)} ` +
            `− gas $${opp.gasEstimateUsd.toFixed(3)} = net $${opp.netProfitUsd.toFixed(3)}`,
          params: { opportunity: opp, ethPriceUsd: ethPrice },
          urgency: 'medium',
          estimatedImpactUsd: opp.netProfitUsd,
          tier: 'AUTO',
          intelUsed: [
            intel.analystPricesAt   ? 'analyst'  : '',
            intel.guardianReceivedAt ? 'guardian' : '',
          ].filter(Boolean),
        });
      } else if (opp) {
        logger.debug(
          `[CFO:Decision] Section J: opportunity found but below threshold — ` +
          `${opp.displayPair} net=$${opp.netProfitUsd.toFixed(3)} < min=$${effectiveArbMinProfit.toFixed(2)}`,
        );
      } else {
        logger.debug(`[CFO:Decision] Section J: no profitable arb found this cycle (${poolCount} pools scanned)`);
      }
    } catch (err) {
      logger.debug('[CFO:Decision] Section J: scan failed (non-fatal):', err);
    }
  }

  // ── K) Kamino-funded Orca LP — borrow USDC → SOL/USDC LP, fees repay loan ──
  //
  // Prerequisite: Kamino has active collateral (from Section G jito-loop or deposits).
  // Borrows a CONSERVATIVE fraction of remaining capacity and deploys into Orca LP.
  // LP fee yield (~15-25% in-range) should comfortably exceed borrow cost (~3-8%).
  // Safety: tiny capacity fraction (20%), strict LTV cap, large spread requirement,
  //         APPROVAL tier. The CFO should never go crazy with borrowed money.
  //
  let _borrowLpLastSkip = '';
  if (isStrategyGated('orca_lp')) {
    logger.info(`[CFO:Decision] Section K skip: orca_lp strategy score below ${MIN_STRATEGY_SCORE} (${learned.strategyScores['orca_lp']?.toFixed(0) ?? '?'}/100, ${learned.sampleSizes['orca_lp'] ?? 0} trades)`);
  } else if (
    env.kaminoBorrowLpEnabled &&
    env.orcaLpEnabled &&
    env.kaminoBorrowEnabled &&
    intel.marketCondition !== 'bearish' &&
    intel.marketCondition !== 'danger'
  ) {
    const borrowLpSkip = (reason: string) => {
      _borrowLpLastSkip = reason;
      logger.debug(`[CFO:Decision] Section K skip: ${reason}`);
    };

    const anyLoopActive = state.kaminoJitoLoopActive || !!state.kaminoActiveLstLoop;
    if (!anyLoopActive && state.kaminoDepositValueUsd < 10) {
      borrowLpSkip('no Kamino collateral — deposit or start LST loop first');
      // Dry-run: simulate the full borrow→LP pipeline so the user can see the plan
      if (env.dryRun && state.jitoSolValueUsd > 20) {
        const simulatedCollateral = state.jitoSolValueUsd;
        const maxBorrowLtv = (env.kaminoBorrowLpMaxLtvPct) / 100;
        const simulatedHeadroom = simulatedCollateral * maxBorrowLtv;
        const fractionToUse = (env.kaminoBorrowLpCapacityPct ?? 20) / 100;
        const borrowUsd = Math.min(
          simulatedHeadroom * fractionToUse,
          env.kaminoBorrowLpMaxUsd ?? 200,
          env.orcaLpMaxUsd,
        );
        const estimatedLpFeeApy = 0.15;
        const borrowCost = state.kaminoBorrowApy > 0 ? state.kaminoBorrowApy : 0.08;
        const spreadPct = (estimatedLpFeeApy - borrowCost) * 100;
        const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct, learned, 'USDC');

        decisions.push({
          type: 'KAMINO_BORROW_LP',
          reasoning:
            `⏸ BLOCKED — needs Kamino collateral first (LST loop must run). ` +
            `Full pipeline: deposit ${state.jitoSolBalance.toFixed(3)} JitoSOL ($${simulatedCollateral.toFixed(0)}) → ` +
            `borrow $${borrowUsd.toFixed(0)} USDC (${(fractionToUse * 100).toFixed(0)}% of $${simulatedHeadroom.toFixed(0)} headroom) → ` +
            `SOL/USDC LP (±${adaptiveRange / 2}%). ` +
            `LP yield ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow ~${(borrowCost * 100).toFixed(0)}% = ${spreadPct.toFixed(1)}% spread. ` +
            `Waiting for LST loop to activate first — currently blocked by negative spread.`,
          params: {
            borrowUsd,
            rangeWidthPct: adaptiveRange,
            estimatedLpApy: estimatedLpFeeApy,
            borrowApy: borrowCost,
            spreadPct,
            blocked: true,
            blockReason: 'no_collateral',
            prerequisite: 'KAMINO_LST_LOOP',
          },
          urgency: 'low',
          estimatedImpactUsd: 0,
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    } else if (state.kaminoHealthFactor < 2.0) {
      borrowLpSkip(`health factor ${state.kaminoHealthFactor.toFixed(2)} < 2.0 — too risky to borrow more`);
    } else if ((learned.borrowLpCycleCount ?? 0) >= 3 && (learned.borrowLpNetYield ?? 0) < -5) {
      borrowLpSkip(`learning: borrowLpNetYield=${(learned.borrowLpNetYield ?? 0).toFixed(1)}% after ${learned.borrowLpCycleCount} cycles — pausing until profitable`);
    } else if (state.kaminoLtv >= (env.kaminoBorrowLpMaxLtvPct / 100) * 0.90) {
      borrowLpSkip(`LTV ${(state.kaminoLtv * 100).toFixed(1)}% too close to cap ${env.kaminoBorrowLpMaxLtvPct}%`);
    } else if (state.orcaPositions.length >= env.orcaLpMaxPositions) {
      borrowLpSkip(`already at max Orca LP positions (${state.orcaPositions.length}/${env.orcaLpMaxPositions})`);
    } else if (!checkCooldown('KAMINO_BORROW_LP', 4 * 3600_000)) {
      borrowLpSkip('cooldown (4h)');
    } else {
      // Calculate safe borrow amount: X% of remaining headroom, capped by config
      const maxBorrowLtv = (env.kaminoBorrowLpMaxLtvPct) / 100;
      const headroomUsd = Math.max(0,
        state.kaminoDepositValueUsd * maxBorrowLtv - state.kaminoBorrowValueUsd,
      );
      const fractionToUse = (env.kaminoBorrowLpCapacityPct ?? 20) / 100;
      const totalBorrowBudget = Math.min(
        headroomUsd * fractionToUse,       // tiny fraction of capacity
        env.kaminoBorrowLpMaxUsd ?? 200,   // hard USD cap
        env.orcaLpMaxUsd - state.orcaLpValueUsd, // Orca headroom
      );

      // Spread check: estimated LP fee APY vs borrow cost
      // Conservative: use 15% base fee APY estimate for in-range SOL/USDC LP
      const estimatedLpFeeApy = 0.15;
      const borrowCost = state.kaminoBorrowApy > 0 ? state.kaminoBorrowApy : 0.08;
      const spreadPct = (estimatedLpFeeApy - borrowCost) * 100;

      if (totalBorrowBudget < 10) {
        borrowLpSkip(`borrow amount $${totalBorrowBudget.toFixed(0)} too small (need ≥$10)`);
      } else if (spreadPct < (env.kaminoBorrowLpMinSpreadPct ?? 5)) {
        borrowLpSkip(`spread ${spreadPct.toFixed(1)}% < min ${env.kaminoBorrowLpMinSpreadPct ?? 5}% (LP ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow ~${(borrowCost * 100).toFixed(0)}%)`);
      } else {
        // ── 3-tier risk system: discover pools, use classifier tiers, open one per enabled tier ──
        const ORCA_TIER_RANGE_MULT_K: Record<string, number> = { low: 0.3, medium: 0.8, high: 1.5 };

        // Get discovered pools (cached — refreshes every 2h)
        // Pools already carry riskTier from classifyOrcaPoolRisk() in orcaPoolDiscovery.ts
        let discoveredPools: any[] = [];
        try {
          discoveredPools = await discoverOrcaPools();
        } catch { /* fallback below */ }

        // Build set of existing Orca LP pool addresses to avoid duplicates
        const existingOrcaPools = new Set(state.orcaPositions.map(p => p.whirlpoolAddress).filter(Boolean));

        // Filter duplicates only — riskTier is already set by the pool discovery classifier.
        // Non-USDC pools (e.g. SOL/jitoSOL, BONK/SOL) are allowed: the execution handler
        // now swaps USDC→tokenB in step 2b when tokenB ≠ USDC.
        const tieredPools = discoveredPools
          .filter(p => !existingOrcaPools.has(p.whirlpoolAddress));

        const enabledTiers = env.orcaLpRiskTiers;
        const slotsAvailable = env.orcaLpMaxPositions - state.orcaPositions.length;
        const perTierBudget = totalBorrowBudget / Math.max(enabledTiers.size, 1);
        let tiersOpened = 0;
        let budgetUsed = 0;   // track actual spend, not pre-allocated slots

        for (const tier of enabledTiers) {
          if (tiersOpened >= slotsAvailable) break;

          // Apply diversity recency penalty so we rotate through different pools
          const tierPools = tieredPools
            .filter(p => p.riskTier === tier)
            .map(p => {
              const recency = getLpRecencyPenalty(p.whirlpoolAddress);
              return { ...p, effectiveScore: p.score - recency, _recency: recency };
            })
            .sort((a, b) => b.effectiveScore - a.effectiveScore);

          // Fallback: if no discovered pools for this tier, use selectBestOrcaPairDynamic for medium tier
          let selectedPool: any = tierPools[0];
          if (selectedPool?._recency > 0) {
            logger.info(
              `[CFO:Decision] Section K diversity: ${selectedPool.pair} penalized -${selectedPool._recency} (recently used). ` +
              `Effective score ${selectedPool.effectiveScore} (base ${selectedPool.score}). ${tierPools.length} ${tier}-tier pools available.`,
            );
          }
          if (!selectedPool && tier === 'medium') {
            try {
              const dynamicPick = await selectBestOrcaPairDynamic(intel, env.orcaLpRiskTiers);
              if (dynamicPick && !existingOrcaPools.has(dynamicPick.whirlpoolAddress)) {
                selectedPool = dynamicPick;
              }
            } catch { /* skip */ }
          }

          if (!selectedPool) {
            borrowLpSkip(`no ${tier}-risk Orca pools available (${tieredPools.length} total)`);
            continue;
          }

          const tierRangeMult = ORCA_TIER_RANGE_MULT_K[tier] ?? 1.0;
          const learnedTierMult = learned.lpTierRangeMultipliers?.[tier] ?? 1.0;
          // Budget: use per-tier share OR all remaining budget (rolls over from skipped tiers)
          const remainingBudget = totalBorrowBudget - budgetUsed;
          const borrowUsd = Math.min(perTierBudget, remainingBudget);
          if (borrowUsd < 10) {
            borrowLpSkip(`${tier} tier: borrow amount $${borrowUsd.toFixed(0)} too small`);
            continue;
          }

          const usdcSide = borrowUsd / 2;
          const solSide = borrowUsd / 2 / state.solPriceUsd;
          const tokenA = selectedPool.tokenA?.symbol ?? selectedPool.tokenA ?? 'SOL';
          const tokenB = selectedPool.tokenB?.symbol ?? selectedPool.tokenB ?? 'USDC';
          const pair = selectedPool.pair ?? `${tokenA}/${tokenB}`;
          const adaptiveRange = adaptiveLpRangeWidthPct(
            tokenA,
            intel,
            env.orcaLpRangeWidthPct * tierRangeMult * learnedTierMult,
            learned,
            tokenB,
          );

          decisions.push({
            type: 'KAMINO_BORROW_LP',
            reasoning:
              `[${tier.toUpperCase()} risk] Borrow $${borrowUsd.toFixed(0)} USDC from Kamino (${(fractionToUse * 100).toFixed(0)}% of headroom) → ` +
              `deploy into ${pair} concentrated LP [risk: ${selectedPool.riskTier ?? tier}] (range ±${adaptiveRange / 2}%). ` +
              `Est. LP fee yield ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow cost ~${(borrowCost * 100).toFixed(0)}% ` +
              `= ${spreadPct.toFixed(1)}% spread. Post-borrow LTV: ~${((state.kaminoLtv + borrowUsd / state.kaminoDepositValueUsd) * 100).toFixed(0)}%. ` +
              `LP fees accrue → close LP → repay borrow → keep profit.`,
            params: {
              borrowUsd,
              usdcAmount: usdcSide,
              solAmount: solSide,
              rangeWidthPct: adaptiveRange,
              estimatedLpApy: estimatedLpFeeApy,
              borrowApy: borrowCost,
              spreadPct,
              riskTier: tier,
              pair,
              tokenA,
              tokenB,
              whirlpoolAddress: selectedPool.whirlpoolAddress,
              tokenAMint: selectedPool.tokenA?.mint ?? selectedPool.tokenAMint,
              tokenBMint: selectedPool.tokenB?.mint ?? selectedPool.tokenBMint,
              tokenADecimals: selectedPool.tokenA?.decimals ?? selectedPool.tokenADecimals,
              tokenBDecimals: selectedPool.tokenB?.decimals ?? selectedPool.tokenBDecimals,
              tickSpacing: selectedPool.tickSpacing,
              postBorrowLtv: state.kaminoLtv + borrowUsd / Math.max(state.kaminoDepositValueUsd, 1),
            },
            urgency: 'low',
            estimatedImpactUsd: borrowUsd * (estimatedLpFeeApy - borrowCost),
            intelUsed: [
              intel.guardianReceivedAt ? 'guardian' : '',
              intel.analystPricesAt ? 'analyst' : '',
            ].filter(Boolean),
            tier: 'APPROVAL',   // ALWAYS require admin approval for borrowed money
          });
          tiersOpened++;
          budgetUsed += borrowUsd;

          // Mark this pool as recently selected so diversity rotation works next cycle
          if (selectedPool.whirlpoolAddress) {
            markLpPairSelected(selectedPool.whirlpoolAddress);
          }

          logger.info(
            `[CFO:Decision] Section K: KAMINO_BORROW_LP [${tier}] — borrow $${borrowUsd.toFixed(0)} → ${pair} LP ` +
            `(spread ${spreadPct.toFixed(1)}%, post-LTV ${((state.kaminoLtv + borrowUsd / state.kaminoDepositValueUsd) * 100).toFixed(0)}%)`,
          );
        }

        if (tiersOpened === 0 && discoveredPools.length === 0) {
          // Fallback: no discovery available, open SOL/USDC (medium tier) as before
          const borrowUsd = totalBorrowBudget;
          const usdcSide = borrowUsd / 2;
          const solSide = borrowUsd / 2 / state.solPriceUsd;
          const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct, learned, 'USDC');

          decisions.push({
            type: 'KAMINO_BORROW_LP',
            reasoning:
              `[MEDIUM risk] Borrow $${borrowUsd.toFixed(0)} USDC from Kamino → ` +
              `deploy into SOL/USDC concentrated LP (range ±${adaptiveRange / 2}%). ` +
              `Est. LP fee yield ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow cost ~${(borrowCost * 100).toFixed(0)}% ` +
              `= ${spreadPct.toFixed(1)}% spread (pool discovery unavailable — fallback).`,
            params: {
              borrowUsd,
              usdcAmount: usdcSide,
              solAmount: solSide,
              rangeWidthPct: adaptiveRange,
              estimatedLpApy: estimatedLpFeeApy,
              borrowApy: borrowCost,
              spreadPct,
              riskTier: 'medium',
              pair: 'SOL/USDC',
              tokenA: 'SOL',
              tokenB: 'USDC',
              postBorrowLtv: state.kaminoLtv + borrowUsd / Math.max(state.kaminoDepositValueUsd, 1),
            },
            urgency: 'low',
            estimatedImpactUsd: borrowUsd * (estimatedLpFeeApy - borrowCost),
            intelUsed: [
              intel.guardianReceivedAt ? 'guardian' : '',
              intel.analystPricesAt ? 'analyst' : '',
            ].filter(Boolean),
            tier: 'APPROVAL',
          });
          tiersOpened = 1;
        }

        // Mark cooldown at generation time so the same KAMINO_BORROW_LP decision
        // doesn't regenerate every cycle while waiting for admin approval.
        // If the admin approves and execution succeeds, markDecision is called again 
        // in the execution handler (updating the timestamp).
        if (tiersOpened > 0) {
          markDecision('KAMINO_BORROW_LP');
        }
      }
    }
  } else if (env.kaminoBorrowLpEnabled) {
    const missing: string[] = [];
    if (!env.orcaLpEnabled) missing.push('orcaLpEnabled=false');
    if (!env.kaminoBorrowEnabled) missing.push('kaminoBorrowEnabled=false');
    if (intel.marketCondition === 'bearish' || intel.marketCondition === 'danger') missing.push(`market=${intel.marketCondition}`);
    if (missing.length > 0) {
      logger.debug(`[CFO:Decision] Section K skip: prerequisite not met — ${missing.join(', ')}`);
    }
  }

  // ── K-bis) Standalone Orca LP — use wallet USDC when Kamino borrow is unavailable ──
  // Fallback path: if Kamino borrow is not possible (no collateral, disabled, etc.)
  // but the wallet has USDC and Orca LP is enabled, open a position with own funds.
  if (
    env.orcaLpEnabled &&
    !isStrategyGated('orca_lp') &&
    (!env.kaminoBorrowLpEnabled || state.kaminoDepositValueUsd < 10) &&
    state.orcaPositions.length < env.orcaLpMaxPositions &&
    state.solanaUsdcBalance >= 20 &&
    intel.marketCondition !== 'danger' &&
    checkCooldown('ORCA_LP_OPEN', 4 * 3600_000)
  ) {
    const deployUsd = Math.min(
      state.solanaUsdcBalance * 0.3,  // deploy up to 30% of wallet USDC
      env.orcaLpMaxUsd - state.orcaLpValueUsd,
    );
    if (deployUsd >= 20) {
      const usdcSide = deployUsd / 2;
      const solSide = deployUsd / 2 / state.solPriceUsd;

      // Try to use discovered pools
      let selectedPool: any = null;
      try {
        const pools = await discoverOrcaPools();
        const existingPools = new Set(state.orcaPositions.map(p => p.whirlpoolAddress).filter(Boolean));
        const candidates = pools
          .filter(p => !existingPools.has(p.whirlpoolAddress) && p.riskTier === 'medium')
          .sort((a, b) => b.score - a.score);
        selectedPool = candidates[0];
      } catch { /* fallback to SOL/USDC */ }

      const pair = selectedPool?.pair ?? 'SOL/USDC';
      const tokenA = selectedPool?.tokenA?.symbol ?? 'SOL';
      const tokenB = selectedPool?.tokenB?.symbol ?? 'USDC';
      const adaptiveRange = adaptiveLpRangeWidthPct(tokenA, intel, env.orcaLpRangeWidthPct, learned, tokenB);

      decisions.push({
        type: 'ORCA_LP_OPEN',
        reasoning:
          `Standalone LP (no Kamino borrow): deploy $${deployUsd.toFixed(0)} wallet USDC into ${pair} ` +
          `concentrated LP (range ±${adaptiveRange / 2}%). No borrow cost — pure fee yield.`,
        params: {
          usdcAmount: usdcSide,
          solAmount: solSide,
          tokenAAmount: solSide,
          rangeWidthPct: adaptiveRange,
          riskTier: 'medium',
          pair,
          tokenA,
          tokenB,
          whirlpoolAddress: selectedPool?.whirlpoolAddress,
          tokenADecimals: selectedPool?.tokenA?.decimals ?? 9,
          tokenBDecimals: selectedPool?.tokenB?.decimals ?? 6,
          tickSpacing: selectedPool?.tickSpacing,
          needsSwapForUsdc: true,
          solToSwapForUsdc: usdcSide / state.solPriceUsd,
          needsSwapForTokenA: tokenA !== 'SOL',
          solToSwapForTokenA: tokenA !== 'SOL' ? solSide : 0,
          tokenAMint: selectedPool?.tokenA?.mint,
        },
        urgency: 'low',
        estimatedImpactUsd: deployUsd * 0.15, // ~15% APY estimate
        intelUsed: intel.scoutReceivedAt ? ['scout'] : [],
        tier: 'APPROVAL',
      });
      logger.info(`[CFO:Decision] Section K-bis: standalone ORCA_LP_OPEN $${deployUsd.toFixed(0)} into ${pair} (no Kamino borrow)`);
    }
  }

  // ── Section M) Signal-driven HL Perp Trading ─────────────────────────────
  // Phase 1: Directional trades based on scout sentiment + analyst price momentum.
  // Phase 2: Multi-asset universe — score each eligible coin by composite signals.
  // Phase 3: News-reactive fast trades — wired to analyst trending + guardian alerts.
  //
  // NOT tied to wallet balances — uses HL equity/margin for sizing.
  // Completely independent of the hedge logic in Section B.
  // ──────────────────────────────────────────────────────────────────────────
  if (config.hlPerpTradingEnabled && env.hyperliquidEnabled) {
    // Build dynamic coin universe: configured base list + any coin that is:
    //   1. Tracked by the analyst (has price data)
    //   2. Listed on Hyperliquid (tradeable as perp)
    // This means if the analyst starts tracking DOGE and HL lists DOGE-PERP,
    // the CFO will automatically score and potentially trade it — no config change needed.

    // Fetch the canonical HL listing — single source of truth for tradeable coins
    const hl = await import('./hyperliquidService.ts');
    const hlListedCoins = new Set(await hl.getHLListedCoins());

    const baseCoins = new Set<string>();

    // 1. Configured base coins (only if HL-listed)
    for (const c of env.hlPerpTradingCoins) {
      if (hlListedCoins.has(c)) baseCoins.add(c);
    }

    // 2. Analyst-tracked coins that are HL-listed
    if (intel.analystPrices) {
      for (const sym of Object.keys(intel.analystPrices)) {
        const upper = sym.toUpperCase();
        if (['USDC', 'USDT', 'DAI', 'BUSD'].includes(upper)) continue;
        if (hlListedCoins.has(upper)) baseCoins.add(upper);
      }
    }

    // 3. Analyst top movers — only if HL-listed
    if (intel.analystMovers) {
      for (const m of intel.analystMovers) {
        const upper = m.symbol.toUpperCase();
        if (['USDC', 'USDT', 'DAI', 'BUSD'].includes(upper)) continue;
        if (hlListedCoins.has(upper)) baseCoins.add(upper);
      }
    }

    // 4. CoinGecko trending — only if HL-listed
    if (intel.analystTrending) {
      for (const t of intel.analystTrending) {
        const upper = t.toUpperCase();
        if (hlListedCoins.has(upper)) baseCoins.add(upper);
      }
    }

    // Also ensure existing HL positions are scored (they're definitely listed)
    for (const pos of state.hlPositions) baseCoins.add(pos.coin);

    const perpCoins = [...baseCoins];
    if (perpCoins.length > env.hlPerpTradingCoins.length) {
      logger.debug(
        `[CFO:Decision] Section M: dynamic perp universe ${perpCoins.length} coins ` +
        `(base: ${env.hlPerpTradingCoins.join(',')} + ${perpCoins.length - env.hlPerpTradingCoins.length} discovered)`,
      );
    }
    const maxPosUsd = applyAdaptive(env.hlPerpMaxPositionUsd, learned.hlPerpSizeMultiplier, conf);
    const maxTotalUsd = applyAdaptive(env.hlPerpMaxTotalUsd, learned.hlPerpSizeMultiplier, conf);
    const maxPositions = Math.max(1, env.hlPerpMaxPositions + Math.round(learned.hlPerpMaxPositionsAdj * conf));
    const minConviction = Math.max(
      config.hlPerpMinConviction,
      learned.hlPerpConvictionFloor * conf, // learning can raise floor but never lower it
    );
    const learnedPerpSL = applyAdaptive(env.hlPerpStopLossPct, learned.hlPerpStopLossMultiplier, conf);
    const learnedPerpTP = env.hlPerpTakeProfitPct; // TP not yet adapted

    // Current perp positions (excluding hedge shorts)
    // Hedge positions are tagged by the OPEN_HEDGE cooldown key convention;
    // perp trades use HL_PERP_* keys. Distinguish by checking if it's a hedge coin.
    const existingPerpPositions = state.hlPositions.filter(p => {
      // If the coin is in hedge list and position is SHORT, it's likely a hedge
      const isHedge = p.side === 'SHORT' && state.treasuryExposures.some(e => e.symbol === p.coin);
      return !isHedge;
    });
    const existingPerpCount = existingPerpPositions.length;
    const existingPerpTotalUsd = existingPerpPositions.reduce((s, p) => s + p.sizeUsd, 0);

    // ── Phase 1 + 2: Score each eligible coin ────────────────────────────────
    // Conviction = f(sentiment, momentum, risk, market condition)
    // Range [0, 1] — higher = stronger signal. Side determined by net direction.
    type CoinSignal = {
      coin: string;
      side: 'LONG' | 'SHORT';
      conviction: number;
      reasoning: string;
      sources: string[];
      // TA-specific fields (undefined = sentiment signal)
      tradeStyle?: TradeStyle;
      taStopLossPct?: number;
      taTakeProfitPct?: number;
      taMaxHoldHours?: number;
      taLeverage?: number;          // per-style leverage from StyleConfig × learned multiplier
    };

    const signals: CoinSignal[] = [];

    for (const coin of perpCoins) {
      // Skip coins with trading halted on HL (remembered for 30 min after a halt error)
      if (hl.isHalted(coin)) continue;

      let bullScore = 0;
      let bearScore = 0;
      const reasons: string[] = [];
      const sources: string[] = [];

      // ── Signal 1: Scout sentiment (macro market direction) ──────────────
      const scoutFresh = intel.scoutReceivedAt && (Date.now() - intel.scoutReceivedAt) < 4 * 3600_000;
      if (scoutFresh) {
        if (intel.scoutBullish === true) {
          bullScore += 0.25;
          reasons.push('scout:bullish');
        } else if (intel.scoutBullish === false) {
          bearScore += 0.25;
          reasons.push('scout:bearish');
        }
        const conf = intel.scoutConfidence ?? 0.5;
        if (conf > 0.7) {
          // Strong confidence amplifies direction
          if (intel.scoutBullish) bullScore += 0.10;
          else bearScore += 0.10;
          reasons.push(`scout-conf:${(conf * 100).toFixed(0)}%`);
        }
        sources.push('scout');
      }

      // ── Signal 2: Price momentum (analyst 24h change) ──────────────────
      const priceData = intel.analystPrices?.[coin];
      const priceFresh = intel.analystPricesAt && (Date.now() - intel.analystPricesAt) < 30 * 60_000;
      if (priceData && priceFresh) {
        const change24h = typeof priceData === 'object' ? priceData.change24h : 0;
        if (change24h > 5) {
          bullScore += 0.20;
          reasons.push(`momentum:+${change24h.toFixed(1)}%`);
        } else if (change24h > 2) {
          bullScore += 0.10;
          reasons.push(`momentum:+${change24h.toFixed(1)}%`);
        } else if (change24h < -5) {
          bearScore += 0.20;
          reasons.push(`momentum:${change24h.toFixed(1)}%`);
        } else if (change24h < -2) {
          bearScore += 0.10;
          reasons.push(`momentum:${change24h.toFixed(1)}%`);
        }
        sources.push('analyst');
      }

      // ── Signal 3: CoinGecko trending (social heat) ─────────────────────
      if (intel.analystTrending?.includes(coin)) {
        bullScore += 0.10;
        reasons.push('trending');
        sources.push('trending');
      }

      // ── Signal 4: Top mover (strong recent move confirms direction) ────
      const mover = intel.analystMovers?.find(m => m.symbol === coin);
      if (mover) {
        if (mover.change24hPct > 8) {
          bullScore += 0.15;
          reasons.push(`top-mover:+${mover.change24hPct.toFixed(0)}%`);
        } else if (mover.change24hPct < -8) {
          bearScore += 0.15;
          reasons.push(`top-mover:${mover.change24hPct.toFixed(0)}%`);
        }
        sources.push('mover');
      }

      // ── Signal 5: Market condition (global risk overlay) ───────────────
      if (intel.marketCondition === 'bullish') {
        bullScore += 0.10;
        reasons.push('market:bullish');
      } else if (intel.marketCondition === 'bearish') {
        bearScore += 0.15;
        reasons.push('market:bearish');
      } else if (intel.marketCondition === 'danger') {
        bearScore += 0.30;
        reasons.push('market:DANGER');
      }

      // ── Signal 6: Guardian risk (coin-specific safety degradation) ─────
      const guardianToken = intel.guardianTokens?.find(t => t.ticker === coin);
      if (guardianToken && !guardianToken.safe) {
        bearScore += 0.20;
        reasons.push('guardian:unsafe');
        sources.push('guardian');
      }

      // ── Signal 7: Volume spike (macro volatility — directional bias) ───
      if (intel.analystVolumeSpike) {
        // Volume spike + bullish = momentum. Volume spike + bearish = capitulation.
        if (bullScore > bearScore) bullScore += 0.05;
        else bearScore += 0.05;
        reasons.push('volume-spike');
      }

      // ── Compute net conviction ─────────────────────────────────────────
      const netBull = bullScore - bearScore;
      const conviction = Math.min(1.0, Math.abs(netBull));
      const side: 'LONG' | 'SHORT' = netBull >= 0 ? 'LONG' : 'SHORT';

      if (conviction >= minConviction && reasons.length >= 2) {
        signals.push({
          coin,
          side,
          conviction,
          reasoning: reasons.join(', '),
          sources: [...new Set(sources)],
        });
      }
    }

    // ── Phase 2b: TA-driven signals (multi-timeframe analysis) ──────────────
    // Scalp (5m trigger + 1h filter), Day (1h trigger + 1d filter), Swing (1d trigger + 1h confirm).
    // TA signals are merged into the same signal pool as sentiment so they compete
    // fairly for position slots by conviction — no separate phase, no starvation.
    // Sentiment signal for the same coin boosts/penalises TA conviction.
    // ──────────────────────────────────────────────────────────────────────────
    let taSignalCount = 0;
    let taNeutralCount = 0;
    let taStyleConvRejects = 0;
    let taDangerRejects = 0;
    if (config.hlPerpTaEnabled) {
      const ta = await import('./hlTechnicalAnalysis.ts');
      const enabledStyles: TradeStyle[] = [];
      if (config.hlPerpScalpEnabled) enabledStyles.push('scalp');
      if (config.hlPerpDayEnabled)   enabledStyles.push('day');
      if (config.hlPerpSwingEnabled) enabledStyles.push('swing');

      if (enabledStyles.length > 0) {
        const taRawSignals = await ta.scoreCoins(perpCoins, enabledStyles);
        taSignalCount = taRawSignals.length;

        for (const taSig of taRawSignals) {
          if (taSig.bias === 'NEUTRAL') { taNeutralCount++; continue; }

          // ── Danger market gate — skip new longs in danger mode ────────
          if (intel.marketCondition === 'danger' && taSig.bias === 'LONG') { taDangerRejects++; continue; }

          // ── Per-style learning: conviction floor ─────────────────────
          const styleConvFloor = learned.hlPerpStyleConvictionFloors?.[taSig.style] ?? 0;
          const effectiveStyleConvFloor = styleConvFloor * conf;
          if (effectiveStyleConvFloor > 0 && taSig.conviction < effectiveStyleConvFloor) { taStyleConvRejects++; continue; }

          // ── Blend TA conviction with sentiment ────────────────────────
          let finalConviction = taSig.conviction;
          const sentimentSig = signals.find(s => s.coin === taSig.coin);
          if (sentimentSig) {
            if (sentimentSig.side === taSig.bias) {
              finalConviction = Math.min(1.0, finalConviction + sentimentSig.conviction * 0.2);
            } else if (sentimentSig.conviction > 0.5) {
              finalConviction *= 0.6; // sentiment disagrees → dampen
            }
          }
          if (finalConviction < minConviction) { taStyleConvRejects++; continue; }

          // ── TA-specific params ────────────────────────────────────────
          const styleSizeMult = learned.hlPerpStyleSizeMultipliers?.[taSig.style] ?? 1.0;
          const styleStopMult = learned.hlPerpStyleStopMultipliers?.[taSig.style] ?? 1.0;
          const styleLevMult = learned.hlPerpStyleLeverageMultipliers?.[taSig.style] ?? 1.0;
          const styleConfig = ta.getStyleConfig(taSig.style);
          const learnedStyleSL = applyAdaptive(styleConfig.stopLossPct, styleStopMult, conf);
          // Per-style leverage: StyleConfig base × learned multiplier, capped at env max
          const styleLevBase = styleConfig.defaultLeverage ?? env.hlPerpDefaultLeverage;
          const learnedStyleLev = Math.min(
            env.maxHyperliquidLeverage,
            Math.max(1, Math.round(applyAdaptive(styleLevBase, styleLevMult, conf))),
          );

          signals.push({
            coin: taSig.coin,
            side: taSig.bias,
            conviction: finalConviction,
            reasoning: `[TA:${taSig.style}] ${taSig.reasoning}${sentimentSig ? ` + sentiment ${sentimentSig.side}` : ''}`,
            sources: sentimentSig ? [...sentimentSig.sources, `ta-${taSig.style}`] : [`ta-${taSig.style}`],
            tradeStyle: taSig.style,
            taStopLossPct: learnedStyleSL,
            taTakeProfitPct: styleConfig.takeProfitPct,
            taMaxHoldHours: styleConfig.maxHoldHours,
            taLeverage: learnedStyleLev,
          });
        }

        logger.info(
          `[CFO:Decision] Section M/TA: scored ${perpCoins.length} coins × ${enabledStyles.length} styles → ` +
          `${taSignalCount} raw, ${taSignalCount - taNeutralCount - taStyleConvRejects - taDangerRejects} merged into signal pool ` +
          `(neutral=${taNeutralCount}, styleConv=${taStyleConvRejects}, danger=${taDangerRejects})`,
        );
      }
    }

    // Sort by conviction descending — strongest signals first (sentiment + TA mixed)
    signals.sort((a, b) => b.conviction - a.conviction);

    // ── Generate decisions from top signals (sentiment + TA unified) ─────
    let sentimentAccepted = 0;
    let taAccepted = 0;
    const taRejects = { slots: 0, usdCap: 0, margin: 0, cooldown: 0, duplicate: 0, tooSmall: 0 };
    for (const sig of signals) {
      // Check position limits (including pending opens from this loop)
      const pendingOpens = decisions.filter(d => d.type === 'HL_PERP_OPEN' || d.type === 'HL_PERP_NEWS');
      const pendingCloses = decisions.filter(d => d.type === 'HL_PERP_CLOSE');
      const openCount = existingPerpCount + pendingOpens.length - pendingCloses.length;
      if (openCount >= maxPositions) {
        if (sig.tradeStyle) taRejects.slots++;
        continue; // continue, not break — higher-conviction TA signals for same coin may be skipped but later ones might fit if a close freed a slot
      }
      const openUsd = existingPerpTotalUsd + pendingOpens.reduce((s, d) => s + (d.params.sizeUsd ?? 0), 0);
      if (openUsd >= maxTotalUsd) {
        if (sig.tradeStyle) taRejects.usdCap++;
        continue;
      }

      // Check margin
      if (state.hlAvailableMargin < 10) {
        if (sig.tradeStyle) taRejects.margin++;
        break; // margin is global, no point continuing
      }

      // Check cooldown per coin (TA uses per-style cooldown)
      const cooldownKey = sig.tradeStyle
        ? `HL_PERP_TA_${sig.coin}_${sig.tradeStyle}`
        : `HL_PERP_${sig.coin}`;
      const cooldownMs = sig.tradeStyle === 'scalp'
        ? config.hlPerpScalpCooldownMs
        : config.hlPerpCooldownMs;
      if (!checkCooldown(cooldownKey, cooldownMs)) {
        if (sig.tradeStyle) taRejects.cooldown++;
        continue;
      }

      // Already have a position in this coin? Skip (don't double up)
      if (existingPerpPositions.some(p => p.coin === sig.coin)) {
        if (sig.tradeStyle) taRejects.duplicate++;
        continue;
      }
      // Also skip if another signal for same coin already accepted this cycle
      if (pendingOpens.some(d => d.params.coin === sig.coin)) {
        if (sig.tradeStyle) taRejects.duplicate++;
        continue;
      }

      // ── Leverage: TA signals carry per-style leverage, sentiment uses default ──
      const effectiveLeverage = sig.taLeverage ?? env.hlPerpDefaultLeverage;

      // ── Size: TA uses per-style learned multiplier, sentiment uses base ──
      const effectiveSizeMult = sig.tradeStyle
        ? (learned.hlPerpStyleSizeMultipliers?.[sig.tradeStyle] ?? 1.0)
        : 1.0;
      const effectiveMaxPosUsd = applyAdaptive(maxPosUsd, effectiveSizeMult, conf);
      const sizeUsd = Math.min(
        effectiveMaxPosUsd * sig.conviction,
        maxTotalUsd - openUsd,
        state.hlAvailableMargin * effectiveLeverage * 0.8,
      );

      if (sizeUsd < 10) {
        if (sig.tradeStyle) taRejects.tooSmall++;
        continue;
      }

      // ── Build decision ──────────────────────────────────────────────────
      const effectiveSL = sig.taStopLossPct ?? learnedPerpSL;
      const effectiveTP = sig.taTakeProfitPct ?? learnedPerpTP;

      const d: Decision = {
        type: 'HL_PERP_OPEN',
        reasoning:
          `${sig.side} ${sig.coin}-PERP: conviction ${(sig.conviction * 100).toFixed(0)}% ` +
          `[${sig.reasoning}]. ` +
          `Size: $${sizeUsd.toFixed(0)} at ${effectiveLeverage}x. ` +
          `SL: ${effectiveSL.toFixed(1)}% / TP: ${effectiveTP}%.` +
          `${sig.taMaxHoldHours ? ` maxHold: ${sig.taMaxHoldHours}h.` : ''} ` +
          `HL margin: $${state.hlAvailableMargin.toFixed(0)}. ` +
          `Perp positions: ${existingPerpCount}/${maxPositions}, total: $${existingPerpTotalUsd.toFixed(0)}/$${maxTotalUsd}.`,
        params: {
          coin: sig.coin,
          side: sig.side,
          sizeUsd,
          leverage: effectiveLeverage,
          stopLossPct: effectiveSL,
          takeProfitPct: effectiveTP,
          signal: sig.sources.join('+'),
          conviction: sig.conviction,
          ...(sig.tradeStyle ? { tradeStyle: sig.tradeStyle } : {}),
        },
        urgency: sig.conviction > 0.7 ? 'medium' : 'low',
        estimatedImpactUsd: sizeUsd,
        intelUsed: sig.sources,
        tier: 'AUTO',
      };
      d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
      decisions.push(d);

      if (sig.tradeStyle) {
        taAccepted++;
        logger.info(
          `[CFO:Decision] Section M: [TA:${sig.tradeStyle}] ${sig.side} ${sig.coin}-PERP ` +
          `$${sizeUsd.toFixed(0)} conviction=${(sig.conviction * 100).toFixed(0)}% ` +
          `SL=${effectiveSL.toFixed(1)}% TP=${effectiveTP}% maxHold=${sig.taMaxHoldHours ?? '-'}h`,
        );
      } else {
        sentimentAccepted++;
        logger.info(
          `[CFO:Decision] Section M: ${sig.side} ${sig.coin}-PERP $${sizeUsd.toFixed(0)} ` +
          `conviction=${(sig.conviction * 100).toFixed(0)}% [${sig.reasoning}]`,
        );
      }
    }

    // TA rejection summary (if TA was enabled and produced signals)
    if (taSignalCount > 0) {
      const merged = taSignalCount - taNeutralCount - taStyleConvRejects - taDangerRejects;
      if (taAccepted === 0 && merged > 0) {
        const parts: string[] = [];
        if (taRejects.slots > 0)     parts.push(`slots_full=${taRejects.slots}`);
        if (taRejects.usdCap > 0)    parts.push(`usd_cap=${taRejects.usdCap}`);
        if (taRejects.margin > 0)    parts.push(`margin=${taRejects.margin}`);
        if (taRejects.cooldown > 0)  parts.push(`cooldown=${taRejects.cooldown}`);
        if (taRejects.duplicate > 0) parts.push(`dup_coin=${taRejects.duplicate}`);
        if (taRejects.tooSmall > 0)  parts.push(`size<$10=${taRejects.tooSmall}`);
        logger.info(
          `[CFO:Decision] Section M/TA: 0/${merged} eligible TA signals accepted — rejections: ${parts.join(', ')} ` +
          `(maxPos=${maxPositions}, existing=${existingPerpCount}, margin=$${state.hlAvailableMargin.toFixed(0)})`,
        );
      } else {
        logger.info(
          `[CFO:Decision] Section M/TA: ${taAccepted}/${merged} TA signals accepted, ${sentimentAccepted} sentiment accepted ` +
          `(total signals: ${signals.length}, slots: ${existingPerpCount}/${maxPositions})`,
        );
      }
    }

    // ── Close existing perp positions if signal reversed / SL / TP / hold expired ─
    for (const pos of existingPerpPositions) {
      const currentSignal = signals.find(s => s.coin === pos.coin);
      // Close if: signal reversed to opposite side, or conviction dropped to 0
      const signalReversed = currentSignal && currentSignal.side !== pos.side && currentSignal.conviction >= minConviction;

      // Look up TA trade style (if this position was opened by TA)
      const styleKey = `${pos.coin}-${pos.side}`;
      const styleInfo = _perpTradeStyles.get(styleKey);

      // Style-specific SL/TP overrides
      let posSL = learnedPerpSL;
      let posTP = learnedPerpTP;
      if (styleInfo) {
        const ta = await import('./hlTechnicalAnalysis.ts');
        const sc = ta.getStyleConfig(styleInfo.style);
        posSL = sc.stopLossPct;
        posTP = sc.takeProfitPct;
      }

      // Also close if P&L stop-loss breached (check unrealized PnL vs margin)
      const marginPct = pos.marginUsed > 0 ? (pos.unrealizedPnlUsd / pos.marginUsed) * 100 : 0;
      const stopHit = marginPct < -posSL;
      // Take profit
      const tpHit = marginPct > posTP;

      // Hold duration expired (TA styles only — scalp: 1h, day: 24h, swing: 7d)
      let holdExpired = false;
      if (styleInfo) {
        const ta = await import('./hlTechnicalAnalysis.ts');
        holdExpired = ta.isHoldExpired(styleInfo.style, styleInfo.openedAt);
      }

      if (signalReversed || stopHit || tpHit || holdExpired) {
        const reason = stopHit
          ? `stop-loss hit (${marginPct.toFixed(1)}% loss on margin, SL=${posSL}%${styleInfo ? ` [${styleInfo.style}]` : ''})`
          : tpHit
            ? `take-profit hit (${marginPct.toFixed(1)}% gain on margin, TP=${posTP}%${styleInfo ? ` [${styleInfo.style}]` : ''})`
            : holdExpired
              ? `hold duration expired (${styleInfo!.style}: opened ${styleInfo!.openedAt}, PnL: ${marginPct.toFixed(1)}%)`
              : `signal reversed to ${currentSignal!.side} (conviction: ${(currentSignal!.conviction * 100).toFixed(0)}%)`;

        const d: Decision = {
          type: 'HL_PERP_CLOSE',
          reasoning: `Close ${pos.side} ${pos.coin}-PERP ($${pos.sizeUsd.toFixed(0)}): ${reason}`,
          params: {
            coin: pos.coin,
            side: pos.side,
            sizeUsd: pos.sizeUsd,
            unrealizedPnl: pos.unrealizedPnlUsd,
            tradeStyle: styleInfo?.style,
          },
          urgency: stopHit ? 'high' : 'medium',
          estimatedImpactUsd: pos.sizeUsd,
          intelUsed: currentSignal?.sources ?? [],
          tier: 'AUTO',
        };
        d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
        decisions.push(d);
        logger.info(`[CFO:Decision] Section M: CLOSE ${pos.side} ${pos.coin}-PERP — ${reason}`);
      }
    }

    // ── Phase 3: News-reactive fast trades ──────────────────────────────────
    // Triggered by analyst trending + large movers — tighter stops, smaller size
    if (config.hlPerpNewsEnabled && env.hlPerpNewsReactiveEnabled) {
      const newsMaxUsd = env.hlPerpNewsMaxUsd;
      const topMovers = (intel.analystMovers ?? [])
        .filter(m => Math.abs(m.change24hPct) >= 10) // only big moves
        .filter(m => perpCoins.includes(m.symbol))    // only tradeable coins
        .filter(m => !existingPerpPositions.some(p => p.coin === m.symbol)) // no existing position
        .filter(m => !signals.some(s => s.coin === m.symbol && s.conviction >= minConviction)); // not already covered by Phase 1

      for (const mover of topMovers.slice(0, 2)) { // max 2 news trades per cycle
        if (!checkCooldown(`HL_PERP_NEWS_${mover.symbol}`, config.hlPerpNewsCooldownMs)) continue;
        if (state.hlAvailableMargin < 10) break;

        // Trend-following: big up → LONG, big down → SHORT
        const side: 'LONG' | 'SHORT' = mover.change24hPct > 0 ? 'LONG' : 'SHORT';
        const sizeUsd = Math.min(newsMaxUsd, state.hlAvailableMargin * env.hlPerpDefaultLeverage * 0.5);
        if (sizeUsd < 10) continue;

        const d: Decision = {
          type: 'HL_PERP_NEWS',
          reasoning:
            `News-reactive ${side} ${mover.symbol}-PERP: ${mover.change24hPct > 0 ? '+' : ''}${mover.change24hPct.toFixed(1)}% 24h move. ` +
            `Quick entry $${sizeUsd.toFixed(0)} with tight 3% SL. ` +
            `Source: analyst top mover.`,
          params: {
            coin: mover.symbol,
            side,
            sizeUsd,
            leverage: env.hlPerpDefaultLeverage,
            stopLossPct: 3, // tighter SL for news trades
            takeProfitPct: 6,
            signal: 'news-mover',
            conviction: Math.min(1.0, Math.abs(mover.change24hPct) / 20), // normalize 10-20% → 0.5-1.0
            change24hPct: mover.change24hPct,
          },
          urgency: 'medium',
          estimatedImpactUsd: sizeUsd,
          intelUsed: ['analyst', 'mover'],
          tier: 'AUTO',
        };
        d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
        decisions.push(d);
        logger.info(
          `[CFO:Decision] Section M/News: ${side} ${mover.symbol}-PERP $${sizeUsd.toFixed(0)} ` +
          `(${mover.change24hPct > 0 ? '+' : ''}${mover.change24hPct.toFixed(1)}% move)`,
        );
      }
    }
  }

  // Log tier breakdown
  const tierCounts = { AUTO: 0, NOTIFY: 0, APPROVAL: 0 };
  for (const d of decisions) tierCounts[d.tier]++;
  if (decisions.length > 0) {
    logger.info(
      `[CFO:Decision] Tier breakdown: 🟢 AUTO=${tierCounts.AUTO} | 🟡 NOTIFY=${tierCounts.NOTIFY} | 🔴 APPROVAL=${tierCounts.APPROVAL}`,
    );
  }

  // ── Section evaluation summary — ALWAYS log at info level ────────
  // Shows which strategies were considered and why they were skipped,
  // so "just opening LP" is never a mystery.
  {
    const diag: string[] = [];

    // B: Hedging
    if (!config.autoHedge) diag.push('Hedge:off');
    else if (!env.hyperliquidEnabled) diag.push('Hedge:HL-disabled');
    else {
      const hedgeableCount = state.treasuryExposures.filter(
        e => e.hlListed && e.valueUsd >= config.hedgeMinSolExposureUsd,
      ).length;
      if (hedgeableCount === 0) diag.push('Hedge:no-eligible-assets');
      else if (state.hedgeRatio >= adjustedHedgeTarget - adjustedRebalThreshold)
        diag.push(`Hedge:OK(${(state.hedgeRatio * 100).toFixed(0)}%)`);
      else if (state.hlAvailableMargin < 10)
        diag.push(`Hedge:margin($${state.hlAvailableMargin.toFixed(0)})`);
      else if (!checkCooldown('OPEN_HEDGE_SOL', config.hedgeCooldownMs))
        diag.push('Hedge:cooldown');
    }

    // C: Staking
    if (config.autoStake && env.jitoEnabled) {
      if (state.idleSolForStaking < config.stakeMinAmountSol)
        diag.push(`Stake:idle=${state.idleSolForStaking.toFixed(2)}<${config.stakeMinAmountSol}`);
      else if (!checkCooldown('AUTO_STAKE', config.stakeCooldownMs))
        diag.push('Stake:cooldown');
    } else {
      diag.push('Stake:off');
    }

    // E: Polymarket
    if (config.autoPolymarket && env.polymarketEnabled) {
      if (state.polyHeadroomUsd < 2) diag.push(`Poly:headroom($${state.polyHeadroomUsd.toFixed(0)})`);
      else if (!checkCooldown('POLY_BET', config.polyBetCooldownMs)) diag.push('Poly:cooldown');
      else diag.push('Poly:no-edge');
    } else {
      diag.push('Poly:off');
    }

    // G/G2: Kamino loops
    if (env.kaminoEnabled && env.kaminoBorrowEnabled) {
      const loopKey = env.kaminoLstLoopEnabled ? 'KAMINO_LST_LOOP' : 'KAMINO_JITO_LOOP';
      const loopLabel = env.kaminoLstLoopEnabled ? 'LSTloop' : 'JitoLoop';
      if (state.kaminoJitoLoopActive || state.kaminoActiveLstLoop)
        diag.push(`${loopLabel}:active`);
      else if (!checkCooldown(loopKey, 2 * 3600_000)) diag.push(`${loopLabel}:cooldown`);
      else diag.push(`${loopLabel}:spread?`);
    }

    // I: Orca LP (new positions via Section K / Kamino borrow; this tracks rebalance only)
    if (env.orcaLpEnabled) {
      const orcaTierTag = [...env.orcaLpRiskTiers].join('/');
      if (state.orcaPositions.length > 0) diag.push(`OrcaLP:active(${state.orcaPositions.length})[${orcaTierTag}]`);
      else if (env.kaminoBorrowLpEnabled) diag.push(`OrcaLP:via-kamino-borrow(K)[${orcaTierTag}]`);
      else diag.push('OrcaLP:needs-borrow-enable');
    }

    // I-bis: Krystal EVM LP (3-tier risk system)
    if (env.krystalLpEnabled) {
      const tierTag = [...env.krystalLpRiskTiers].join('/');
      if (state.evmLpPositions.length > 0) diag.push(`KrystalLP:active(${state.evmLpPositions.length})[${tierTag}]`);
      else if (intel.marketCondition === 'danger') diag.push('KrystalLP:danger');
      else if (state.evmTotalUsdcAllChains + state.evmTotalNativeAllChains < 20) diag.push(`KrystalLP:low-funds($${(state.evmTotalUsdcAllChains + state.evmTotalNativeAllChains).toFixed(0)})`);
      else if (state.evmLpPositions.length >= env.krystalLpMaxPositions) diag.push(`KrystalLP:max-pos(${state.evmLpPositions.length})`);
      else if (intel.marketCondition === 'bearish') diag.push('KrystalLP:bearish');
      else if (!checkCooldown('KRYSTAL_LP_OPEN', env.krystalLpOpenCooldownMs)) diag.push('KrystalLP:cooldown');
      else diag.push(`KrystalLP:seeking[${tierTag}]`);
    }

    // J: Arb
    if (env.evmArbEnabled) {
      if (decisions.some(d => d.type === 'EVM_FLASH_ARB')) diag.push('Arb:✓');
      else diag.push('Arb:no-opportunity');
    }

    // K: Kamino-funded Orca LP
    if (env.kaminoBorrowLpEnabled) {
      if (decisions.some(d => d.type === 'KAMINO_BORROW_LP')) diag.push('BorrowLP:✓');
      else if (!env.orcaLpEnabled) diag.push('BorrowLP:orca-off');
      else if (!env.kaminoBorrowEnabled) diag.push('BorrowLP:borrow-off');
      else if (intel.marketCondition === 'bearish' || intel.marketCondition === 'danger') diag.push(`BorrowLP:market-${intel.marketCondition}`);
      else if (_borrowLpLastSkip) diag.push(`BorrowLP:${_borrowLpLastSkip}`);
      else diag.push('BorrowLP:skip(unknown)');
    }

    // M: HL Perp Trading (signal-driven)
    if (config.hlPerpTradingEnabled && env.hyperliquidEnabled) {
      const perpDecisions = decisions.filter(d => d.type === 'HL_PERP_OPEN' || d.type === 'HL_PERP_CLOSE' || d.type === 'HL_PERP_NEWS');
      // Count dynamic coin universe (base + discovered from analyst/trending)
      const baseCoinCount = env.hlPerpTradingCoins.length;
      const dynamicCoinSources: string[] = [];
      if (intel.analystPrices) dynamicCoinSources.push('analyst');
      if (intel.analystMovers?.length) dynamicCoinSources.push('movers');
      if (intel.analystTrending?.length) dynamicCoinSources.push('trending');
      const coinLabel = dynamicCoinSources.length > 0
        ? `${baseCoinCount}+${dynamicCoinSources.join('+')}` : `${baseCoinCount}`;
      if (perpDecisions.length > 0) {
        diag.push(`Perps(${coinLabel}):${perpDecisions.map(d => `${d.params.side?.[0]}${d.params.coin}`).join(',')}`);
      } else {
        const existingPerps = state.hlPositions.filter(p => {
          const isHedge = p.side === 'SHORT' && state.treasuryExposures.some(e => e.symbol === p.coin);
          return !isHedge;
        });
        if (existingPerps.length > 0) {
          diag.push(`Perps:hold(${existingPerps.map(p => `${p.side[0]}${p.coin}`).join(',')})`);
        } else if (state.hlAvailableMargin < 10) {
          diag.push(`Perps:low-margin($${state.hlAvailableMargin.toFixed(0)})`);
        } else {
          diag.push('Perps:no-signal');
        }
      }
    } else if (env.hyperliquidEnabled) {
      diag.push('Perps:off');
    }

    // Add active decisions to summary
    const activeTypes = decisions.map(d => `${d.type}[${d.tier}]`);
    if (activeTypes.length > 0) diag.push(`→ DECIDED: ${activeTypes.join(', ')}`);

    logger.info(`[CFO:Decision] Sections: ${diag.join(' | ')}`);
  }

  // Cap to maxDecisionsPerCycle
  return decisions.slice(0, config.maxDecisionsPerCycle);
}

// ============================================================================
// STEP 4: Execute decisions
// ============================================================================

export async function executeDecision(decision: Decision, env: CFOEnv): Promise<DecisionResult> {
  const base: DecisionResult = {
    decision,
    executed: false,
    success: false,
    dryRun: env.dryRun,
  };

  // ── APPROVAL tier → don't execute, return pendingApproval for the CFO agent to queue
  if (decision.tier === 'APPROVAL') {
    logger.info(
      `[CFO:Decision] 🔴 APPROVAL REQUIRED — ${decision.type}: $${Math.abs(decision.estimatedImpactUsd).toFixed(0)} ` +
      `exceeds auto-execute threshold. Queuing for admin approval.`,
    );
    return { ...base, executed: false, success: true, pendingApproval: true };
  }

  // Dry run — log but don't execute.
  // Mark a separate dry-run cooldown (2h) so we don't re-recommend the same
  // action every 30-min cycle. This is shorter than production cooldowns (24h)
  // to ensure varied recommendations without going completely silent.
  if (env.dryRun) {
    logger.info(
      `[CFO:Decision] DRY RUN — ${decision.type} [${decision.tier}]: ${decision.reasoning}`,
    );
    const cooldownKey =
      (decision.type === 'OPEN_HEDGE' || decision.type === 'CLOSE_HEDGE')
        ? `${decision.type}_${decision.params.coin ?? 'SOL'}`
        : (decision.type === 'HL_PERP_OPEN' || decision.type === 'HL_PERP_CLOSE' || decision.type === 'HL_PERP_NEWS')
          ? `${decision.type}_${decision.params.coin ?? '?'}`
          : decision.type;
    _dryRunCooldowns[cooldownKey] = Date.now();
    return { ...base, executed: false, success: true };
  }

  try {
    switch (decision.type) {
      case 'OPEN_HEDGE': {
        const hl = await import('./hyperliquidService.ts');
        const coin = decision.params.coin ?? 'SOL';
        const exposureUsd = decision.params.exposureUsd ?? decision.params.solExposureUsd;
        const result = await hl.hedgeTreasury({
          coin,
          exposureUsd,
          leverage: decision.params.leverage,
        });
        if (result.success) markDecision(`OPEN_HEDGE_${coin}`);
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          error: result.error,
        };
      }

      case 'CLOSE_HEDGE': {
        // Find the coin's SHORT position and reduce it
        const hl = await import('./hyperliquidService.ts');
        const coin = decision.params.coin ?? 'SOL';
        const summary = await hl.getAccountSummary();
        const coinShort = summary.positions.find(
          (p) => p.coin === coin && p.side === 'SHORT',
        );
        if (!coinShort) {
          return { ...base, executed: false, error: `No ${coin} SHORT position found to reduce` };
        }

        const reduceUsd = Math.min(decision.params.reduceUsd, coinShort.sizeUsd);
        const reduceSizeCoin = reduceUsd / coinShort.markPrice;
        // Capture HL ground-truth PnL BEFORE closing (proportional to close fraction)
        const closeFraction = coinShort.sizeUsd > 0 ? reduceUsd / coinShort.sizeUsd : 1;
        const hlPnlForClose = (coinShort.unrealizedPnlUsd ?? 0) * closeFraction;
        const result = await hl.closePosition(coin, reduceSizeCoin, true); // buy back to reduce short
        if (result.success) markDecision(`CLOSE_HEDGE_${coin}`);
        // Use marginUsed (collateral), not sizeUsd (notional) — proportional to close fraction
        const marginReturned = coinShort.marginUsed * closeFraction;
        const closeReceivedUsd = marginReturned + hlPnlForClose;
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          receivedUsd: result.success ? Math.max(0, closeReceivedUsd) : undefined,
          hlUnrealizedPnl: result.success ? hlPnlForClose : undefined,
          error: result.error,
        };
      }

      case 'CLOSE_LOSING': {
        const hl = await import('./hyperliquidService.ts');
        const summary = await hl.getAccountSummary();
        const pos = summary.positions.find(
          (p) => p.coin === decision.params.coin && p.side === decision.params.side,
        );
        if (!pos) {
          return { ...base, executed: false, error: `Position ${decision.params.coin} ${decision.params.side} not found` };
        }

        const sizeInCoin = pos.sizeUsd / pos.markPrice;
        const isBuy = pos.side === 'SHORT'; // buy to close short, sell to close long
        // Capture HL ground-truth PnL BEFORE closing
        const hlPnlForLoss = pos.unrealizedPnlUsd ?? 0;
        // Actual return = margin + unrealized PnL (use marginUsed, NOT sizeUsd/notional)
        const closeReceivedUsd = Math.max(0, pos.marginUsed + hlPnlForLoss);
        const result = await hl.closePosition(pos.coin, sizeInCoin, isBuy);
        if (result.success) markDecision('CLOSE_LOSING');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          receivedUsd: result.success ? closeReceivedUsd : undefined,
          hlUnrealizedPnl: result.success ? hlPnlForLoss : undefined,
          error: result.error,
        };
      }

      case 'AUTO_STAKE': {
        const jito = await import('./jitoStakingService.ts');
        const result = await jito.stakeSol(decision.params.amount);
        if (result.success) markDecision('AUTO_STAKE');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txSignature,
          error: result.error,
        };
      }

      case 'UNSTAKE_JITO': {
        const jito = await import('./jitoStakingService.ts');
        const result = await jito.instantUnstake(decision.params.amount);
        if (result.success) markDecision('UNSTAKE_JITO');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txSignature,
          error: result.error,
        };
      }

      case 'REBALANCE_HEDGE':
        // Composite: close excess + open new — handled by OPEN_HEDGE/CLOSE_HEDGE
        return { ...base, executed: false, error: 'REBALANCE not directly executed — split into OPEN/CLOSE' };

      case 'POLY_BET': {
        const polyMod = await import('./polymarketService.ts');
        const evmMod = await import('./evmWalletService.ts');
        // Pre-flight gas check
        const gas = await evmMod.checkGas();
        if (!gas.ok) {
          return { ...base, executed: false, error: `Polygon gas too low: ${gas.warning}` };
        }
        // Fetch the full market + token objects needed by placeBuyOrder
        const market = await polyMod.fetchMarket(decision.params.conditionId);
        if (!market) {
          return { ...base, executed: false, error: 'Polymarket market not found' };
        }
        // Primary: match by tokenId. Fallback: match by outcome (Yes/No side).
        // The Gamma API may return different tokenId formats between list and
        // single-market endpoints (legacy tokens[] vs flat clobTokenIds), so
        // exact tokenId from scan time may not match at execution time.
        let token = market.tokens.find((t: any) => t.tokenId === decision.params.tokenId);
        if (!token && decision.params.side) {
          const sideNorm = String(decision.params.side).toLowerCase();
          token = market.tokens.find(
            (t: any) => t.outcome.toLowerCase() === (sideNorm === 'yes' ? 'yes' : 'no'),
          );
          if (token) {
            logger.warn(
              `[CFO:POLY_BET] tokenId mismatch — stored=${decision.params.tokenId}, ` +
              `resolved via outcome='${decision.params.side}' → tokenId=${token.tokenId}`,
            );
            // If resolved token has no price, use scan-time price from decision params
            if (!token.price || token.price <= 0) {
              const scanPrice = decision.params.pricePerShare;
              if (scanPrice && scanPrice > 0 && scanPrice < 1) {
                logger.warn(
                  `[CFO:POLY_BET] Resolved token has price=${token.price}, ` +
                  `using scan-time price=${scanPrice}`,
                );
                token = { ...token, price: scanPrice };
              }
            }
          }
        }
        if (!token) {
          logger.error(
            `[CFO:POLY_BET] Token not found — conditionId=${decision.params.conditionId}, ` +
            `storedTokenId=${decision.params.tokenId}, side=${decision.params.side}, ` +
            `available=[${market.tokens.map((t: any) => `${t.outcome}:${t.tokenId}`).join(', ')}]`,
          );
          return { ...base, executed: false, error: 'Polymarket token not found in market' };
        }
        const order = await polyMod.placeBuyOrder(market, token, decision.params.sizeUsd);
        const polyBetSuccess = order.status === 'LIVE' || order.status === 'MATCHED';
        if (polyBetSuccess) markDecision('POLY_BET');
        return {
          ...base,
          executed: true,
          success: polyBetSuccess,
          txId: order.transactionHash ?? order.orderId,
          error: polyBetSuccess ? undefined : `Order status: ${order.status}`,
        };
      }

      case 'POLY_EXIT': {
        const polyMod = await import('./polymarketService.ts');
        const positions = await polyMod.fetchPositions();
        const pos = positions.find((p: any) => p.tokenId === decision.params.tokenId);
        if (!pos) {
          return { ...base, executed: false, error: 'Polymarket position not found for exit' };
        }
        const exitOrder = await polyMod.exitPosition(pos, 1.0);
        const polyExitSuccess = exitOrder.status === 'LIVE' || exitOrder.status === 'MATCHED';
        if (polyExitSuccess) markDecision('POLY_EXIT');
        return {
          ...base,
          executed: true,
          success: polyExitSuccess,
          txId: exitOrder.transactionHash ?? exitOrder.orderId,
          receivedUsd: exitOrder.status === 'MATCHED' ? exitOrder.sizeUsd : undefined,
          error: polyExitSuccess ? undefined : `Exit order status: ${exitOrder.status}`,
        };
      }

      case 'SKIP':
        return { ...base, executed: false, success: true };

      case 'KAMINO_BORROW_DEPLOY': {
        const kamino = await import('./kaminoService.ts');
        const { borrowUsd, deployTarget } = decision.params;

        // Step 1: Borrow USDC from Kamino
        const borrowResult = await kamino.borrow('USDC', borrowUsd);
        if (!borrowResult.success) {
          return { ...base, executed: true, success: false, error: `Borrow failed: ${borrowResult.error}` };
        }

        // Step 2: Deploy borrowed USDC
        let deploySuccess = false;
        let deployTxId: string | undefined;

        if (deployTarget === 'kamino_supply') {
          // Supply USDC into Kamino Altcoin Market (separate obligation from Main Market
          // where we borrowed — avoids same-asset supply+borrow conflict)
          const depositResult = await kamino.depositToAltMarket('USDC', borrowUsd * 0.995); // small buffer for fees
          deploySuccess = depositResult.success;
          deployTxId = depositResult.txSignature;
        } else if (deployTarget === 'polymarket') {
          // Route to Polymarket — the decision engine will pick up USDC headroom on next cycle
          // USDC is now in the wallet ready for Polymarket deployment
          deploySuccess = true;
          deployTxId = borrowResult.txSignature;
          logger.info(`[CFO:KAMINO_BORROW_DEPLOY] $${borrowUsd} USDC borrowed and ready for Polymarket deployment`);
        }

        if (deploySuccess) {
          markDecision('KAMINO_BORROW_DEPLOY');
        } else {
          // Deploy failed — auto-repay borrowed USDC so it doesn't sit idle in wallet
          logger.warn(`[CFO:KAMINO_BORROW_DEPLOY] Deploy to ${deployTarget} failed — auto-repaying $${borrowUsd} USDC`);
          const repayResult = await kamino.repay('USDC', borrowUsd * 0.995).catch((err: any) => {
            logger.error(`[CFO:KAMINO_BORROW_DEPLOY] Auto-repay also failed: ${err}`);
            return { success: false } as { success: boolean };
          });
          if (repayResult.success) {
            logger.info(`[CFO:KAMINO_BORROW_DEPLOY] Auto-repay succeeded — borrowed USDC returned to Kamino`);
          }
        }
        return {
          ...base,
          executed: true,
          success: deploySuccess,
          txId: deployTxId,
          error: deploySuccess ? undefined : 'Borrow succeeded but deploy failed — auto-repay attempted',
        };
      }

      case 'KAMINO_REPAY': {
        const kamino = await import('./kaminoService.ts');
        const jupBal = await import('./jupiterService.ts');
        const { repayUsd, recoverTokens } = decision.params;

        // Pre-flight: check wallet USDC balance
        let usdcBal = await jupBal.getTokenBalance(jupBal.MINTS.USDC);

        // Recovery mode: wallet has orphaned non-USDC tokens from a failed borrow LP.
        // Swap them to USDC first, then proceed with repay.
        if (recoverTokens && usdcBal < repayUsd * 0.50) {
          // Pre-check: need enough SOL for swap tx fees (~0.01 SOL per swap)
          const solBal = await jupBal.getTokenBalance(jupBal.MINTS.SOL);
          if (solBal < 0.005) {
            logger.warn(`[CFO] KAMINO_REPAY recovery skipped — SOL balance ${solBal.toFixed(4)} too low for swap tx fees`);
          } else {
          logger.info(`[CFO] KAMINO_REPAY recovery mode — scanning wallet for orphaned tokens to swap to USDC (SOL: ${solBal.toFixed(4)})`);
          try {
            const walletTokens = await jupBal.getWalletTokenBalances(0);
            const SOL_RESERVE = 0.05;
            let totalRecovered = 0;
            for (const tok of walletTokens) {
              // Skip SOL (gas reserve), USDC (already target), dust amounts
              if (tok.mint === jupBal.MINTS.SOL) continue;
              if (tok.mint === jupBal.MINTS.USDC) continue;
              if (tok.balance <= 0) continue;
              // Skip tokens with very small balances (< $0.10 not worth the gas)
              // We don't have price here, so swap anything with balance > 0
              // Jupiter will fail gracefully on worthless tokens
              try {
                const quote = await jupBal.getQuote(tok.mint, jupBal.MINTS.USDC, tok.balance, 200);
                if (!quote) continue;
                // Skip if output < $0.50 (not worth gas)
                const outputUsd = (quote as any).outAmount
                  ? Number((quote as any).outAmount) / 1e6 // USDC has 6 decimals
                  : 0;
                if (outputUsd < 0.50) {
                  logger.debug(`[CFO] KAMINO_REPAY recovery: skip ${tok.symbol ?? tok.mint.slice(0, 8)} — output $${outputUsd.toFixed(2)} too small`);
                  continue;
                }
                const swap = await jupBal.executeSwap(quote);
                if (swap.success) {
                  const recovered = swap.outputAmount ?? 0;
                  totalRecovered += recovered;
                  logger.info(`[CFO] KAMINO_REPAY recovery: swapped ${tok.balance.toFixed(4)} ${tok.symbol ?? tok.mint.slice(0, 8)} → $${recovered.toFixed(2)} USDC`);
                } else {
                  logger.warn(`[CFO] KAMINO_REPAY recovery: swap ${tok.symbol ?? tok.mint.slice(0, 8)} failed: ${swap.error}`);
                }
              } catch (swapErr) {
                logger.warn(`[CFO] KAMINO_REPAY recovery: swap ${tok.symbol ?? tok.mint.slice(0, 8)} error:`, swapErr);
              }
            }
            if (totalRecovered > 0) {
              // Re-check USDC balance after swaps
              usdcBal = await jupBal.getTokenBalance(jupBal.MINTS.USDC);
              logger.info(`[CFO] KAMINO_REPAY recovery: recovered $${totalRecovered.toFixed(2)} USDC total. Wallet now: $${usdcBal.toFixed(2)} USDC`);
            } else {
              logger.warn(`[CFO] KAMINO_REPAY recovery: no tokens recovered — wallet has no swappable assets`);
            }
          } catch (recoverErr) {
            logger.error(`[CFO] KAMINO_REPAY recovery scan failed:`, recoverErr);
          }
          } // end SOL balance gate
        }

        if (usdcBal < 0.50) {
          logger.warn(`[CFO] KAMINO_REPAY skipped — wallet USDC $${usdcBal.toFixed(2)} insufficient (need $${repayUsd.toFixed(2)})`);
          return { ...base, executed: false, success: false, error: `Insufficient wallet USDC ($${usdcBal.toFixed(2)}) for repay ($${repayUsd.toFixed(2)})` };
        }
        // Cap to actual balance with small buffer for rounding
        const cappedRepay = Math.min(repayUsd, usdcBal * 0.995);
        const result = await kamino.repay('USDC', cappedRepay);
        if (result.success) markDecision('KAMINO_REPAY');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txSignature,
          error: result.error,
        };
      }

      case 'ORCA_LP_OPEN': {
        const {
          tokenA,
          tokenAMint,
          usdcAmount,
          solAmount,
          tokenAAmount,
          rangeWidthPct,
          whirlpoolAddress,
          tokenADecimals,
          tokenBDecimals,
          tickSpacing: poolTickSpacing,
          needsSwapForUsdc: lpNeedsSwapForUsdc,
          needsSwapForTokenA: lpNeedsSwapForTokenA,
          solToSwapForUsdc: lpSolToSwapForUsdc,
          solToSwapForTokenA: lpSolToSwapForTokenA,
        } = decision.params;

        // Register decimals + symbols for this pool so orcaService can read positions correctly
        if (whirlpoolAddress && tokenADecimals != null && tokenBDecimals != null) {
          const orcaSvc = await import('./orcaService.ts');
          orcaSvc.registerPoolDecimals(whirlpoolAddress, tokenADecimals, tokenBDecimals, tokenA, decision.params.tokenB);
        }

        const jupMod = await import('./jupiterService.ts');

        // Step 1: Auto-swap SOL → USDC for B-side shortfall
        if (lpNeedsSwapForUsdc && lpSolToSwapForUsdc > 0) {
          const swapResult = await jupMod.swapSolToUsdc(lpSolToSwapForUsdc, 100); // 1% slippage
          if (!swapResult.success) {
            return { ...base, executed: true, success: false, error: `Auto-swap SOL→USDC failed: ${swapResult.error}` };
          }
          logger.info(`[CFO] ORCA_LP_OPEN: swapped ${lpSolToSwapForUsdc.toFixed(4)} SOL → $${(swapResult.outputAmount ?? usdcAmount).toFixed(2)} USDC`);
        }

        // Step 2: Auto-swap SOL → tokenA when selected pool A-side is non-SOL
        let tokenAInputAmount = tokenAAmount ?? solAmount;
        if (tokenA !== 'SOL' && lpNeedsSwapForTokenA && lpSolToSwapForTokenA > 0 && tokenAMint) {
          const quote = await jupMod.getQuote(jupMod.MINTS.SOL, tokenAMint, lpSolToSwapForTokenA, 100);
          if (!quote) {
            return { ...base, executed: true, success: false, error: `Auto-swap SOL→${tokenA} quote failed` };
          }
          const swapResult = await jupMod.executeSwap(quote, { maxPriceImpactPct: 3 });
          if (!swapResult.success) {
            return { ...base, executed: true, success: false, error: `Auto-swap SOL→${tokenA} failed: ${swapResult.error}` };
          }
          tokenAInputAmount = swapResult.outputAmount;
          logger.info(`[CFO] ORCA_LP_OPEN: swapped ${lpSolToSwapForTokenA.toFixed(4)} SOL → ${tokenAInputAmount.toFixed(4)} ${tokenA}`);
        }

        // Step 3: Open the LP position
        const orca = await import('./orcaService.ts');
        const result = await orca.openPosition(usdcAmount, tokenAInputAmount, rangeWidthPct, whirlpoolAddress, tokenADecimals ?? 9, tokenBDecimals ?? 6, poolTickSpacing);
        if (result.success) markDecision('ORCA_LP_OPEN');
        return {
          ...base,
          executed: true,
          success: result.success,
          // Use positionMint as txId so cfo.ts externalId matches what rebalance looks up
          txId: result.positionMint ?? result.txSignature,
          txHash: result.txSignature,
          positionMint: result.positionMint,
          error: result.error,
        } as DecisionResult & { txHash?: string; positionMint?: string };
      }

      case 'ORCA_LP_REBALANCE': {
        const orca = await import('./orcaService.ts');
        const { positionMint, whirlpoolAddress, rangeWidthPct } = decision.params;
        const result = await orca.rebalancePosition(positionMint, rangeWidthPct, whirlpoolAddress);
        if (result.success) markDecision('ORCA_LP_OPEN'); // reuses OPEN cooldown
        return {
          ...base,
          executed: true,
          success: result.success,
          // Use newPositionMint as txId so cfo.ts can create new position record with correct externalId
          txId: result.newPositionMint ?? result.txSignature,
          txHash: result.txSignature,
          valueRecoveredUsd: result.valueRecoveredUsd,
          newPositionMint: result.newPositionMint,
          usdcReceived: result.usdcReceived,
          solReceived: result.solReceived,
          error: result.error,
        } as DecisionResult & { txHash?: string; valueRecoveredUsd?: number; newPositionMint?: string; usdcReceived?: number; solReceived?: number };
      }

      case 'ORCA_LP_CLAIM_FEES': {
        const orca = await import('./orcaService.ts');
        const { positionMint } = decision.params;
        const claimResult = await orca.claimFees(positionMint);
        if (claimResult.success) markDecision(`ORCA_LP_CLAIM_${positionMint}`);
        let solPriceForClaim = 85;
        try { const pyth = await import('./pythOracleService.ts'); solPriceForClaim = await pyth.getSolPrice(); } catch { /* fallback */ }
        const claimedUsd = (claimResult.solClaimed * solPriceForClaim) + claimResult.usdcClaimed;
        return {
          ...base,
          executed: true,
          success: claimResult.success,
          txId: claimResult.txSignature,
          solClaimed: claimResult.solClaimed,
          usdcClaimed: claimResult.usdcClaimed,
          claimedUsd,
          error: claimResult.error,
        } as DecisionResult & { solClaimed?: number; usdcClaimed?: number; claimedUsd?: number };
      }

      case 'ORCA_LP_CLOSE': {
        const orca = await import('./orcaService.ts');
        const { positionMint } = decision.params;
        const closeResult = await orca.closePosition(positionMint);
        if (closeResult.success) markDecision('ORCA_LP_CLOSE');
        // Compute recovered value for PnL tracking
        let solPrice = 85;
        try { const pyth = await import('./pythOracleService.ts'); solPrice = await pyth.getSolPrice(); } catch { /* fallback */ }
        const recoveredUsd = (closeResult.usdcReceived ?? 0) + (closeResult.solReceived ?? 0) * solPrice;
        return {
          ...base,
          executed: true,
          success: closeResult.success,
          txId: closeResult.txSignature,
          valueRecoveredUsd: recoveredUsd,
          error: closeResult.error,
        } as DecisionResult & { valueRecoveredUsd?: number };
      }

      case 'KAMINO_BORROW_LP': {
        // Step 1: Borrow USDC from Kamino
        const kamino = await import('./kaminoService.ts');
        const {
          borrowUsd, usdcAmount, solAmount, rangeWidthPct,
          tokenA, tokenAMint, tokenB, tokenBMint,
          whirlpoolAddress, tokenADecimals, tokenBDecimals, tickSpacing: poolTickSpacing,
          pair,
        } = decision.params;
        const borrowResult = await kamino.borrow('USDC', borrowUsd);
        if (!borrowResult.success) {
          return { ...base, executed: true, success: false, error: `Borrow failed: ${borrowResult.error}` };
        }
        logger.info(`[CFO] KAMINO_BORROW_LP step 1: borrowed $${borrowUsd.toFixed(0)} USDC | tx: ${borrowResult.txSignature}`);

        // Register decimals + symbols for this pool so orcaService can read positions correctly
        if (whirlpoolAddress && tokenADecimals != null && tokenBDecimals != null) {
          const orcaSvc = await import('./orcaService.ts');
          orcaSvc.registerPoolDecimals(whirlpoolAddress, tokenADecimals, tokenBDecimals, tokenA, tokenB);
        }

        // Step 2: Swap half of USDC → tokenA for the LP's A-side.
        // tokenA might be SOL, KMNO, BONK, WIF, etc. — use the correct swap path.
        const jupMod = await import('./jupiterService.ts');
        const isTokenASol = !tokenAMint || tokenA === 'SOL' || tokenAMint === jupMod.MINTS.SOL;
        let tokenAReceived: number;

        if (isTokenASol) {
          // Classic path: USDC → SOL
          const swapResult = await jupMod.swapUsdcToSol(usdcAmount, 100);
          if (!swapResult.success) {
            logger.warn(`[CFO] KAMINO_BORROW_LP swap USDC→SOL failed — repaying borrowed USDC`);
            await kamino.repay('USDC', borrowUsd * 0.995).catch(() => {});
            return { ...base, executed: true, success: false, error: `Swap USDC→SOL failed: ${swapResult.error}` };
          }
          tokenAReceived = swapResult.outputAmount || solAmount;
          logger.info(`[CFO] KAMINO_BORROW_LP step 2: swapped $${usdcAmount.toFixed(0)} USDC → ${tokenAReceived.toFixed(4)} SOL`);
        } else {
          // Non-SOL tokenA (KMNO, BONK, WIF, etc.) — swap USDC → tokenA via Jupiter generic route
          const quote = await jupMod.getQuote(jupMod.MINTS.USDC, tokenAMint, usdcAmount, 100);
          if (!quote) {
            logger.warn(`[CFO] KAMINO_BORROW_LP swap USDC→${tokenA} quote failed — repaying borrowed USDC`);
            await kamino.repay('USDC', borrowUsd * 0.995).catch(() => {});
            return { ...base, executed: true, success: false, error: `Swap USDC→${tokenA} quote failed` };
          }
          const swapResult = await jupMod.executeSwap(quote, { maxPriceImpactPct: 3 });
          if (!swapResult.success) {
            logger.warn(`[CFO] KAMINO_BORROW_LP swap USDC→${tokenA} failed — repaying borrowed USDC`);
            await kamino.repay('USDC', borrowUsd * 0.995).catch(() => {});
            return { ...base, executed: true, success: false, error: `Swap USDC→${tokenA} failed: ${swapResult.error}` };
          }
          tokenAReceived = swapResult.outputAmount;
          logger.info(`[CFO] KAMINO_BORROW_LP step 2: swapped $${usdcAmount.toFixed(0)} USDC → ${tokenAReceived.toFixed(4)} ${tokenA}`);
        }

        // Step 2b: If tokenB is not USDC, also swap USDC → tokenB to fund that side.
        // e.g. SOL/jitoSOL pools — both tokens must be obtained from the borrowed USDC.
        const USDC_MINT_KBLP = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const isTokenBUsdc = !tokenBMint || tokenBMint === USDC_MINT_KBLP;
        const isTokenBSol = tokenB === 'SOL' || tokenBMint === jupMod.MINTS.SOL;
        let tokenBDepositAmount = usdcAmount; // default: remaining borrowed USDC funds tokenB directly

        if (!isTokenBUsdc) {
          logger.info(`[CFO] KAMINO_BORROW_LP step 2b: tokenB=${tokenB} ≠ USDC — swapping $${usdcAmount.toFixed(2)} USDC → ${tokenB}`);
          let swapBSuccess = false;
          let swapBOutput = 0;
          let swapBError = 'unknown';
          if (isTokenBSol) {
            const swapB = await jupMod.swapUsdcToSol(usdcAmount, 100);
            swapBSuccess = swapB.success; swapBOutput = swapB.outputAmount ?? 0; swapBError = swapB.error ?? '';
          } else {
            const quoteB = await jupMod.getQuote(jupMod.MINTS.USDC, tokenBMint!, usdcAmount, 100);
            if (!quoteB) {
              swapBError = `no Jupiter quote for USDC→${tokenB}`;
            } else {
              const swapB = await jupMod.executeSwap(quoteB, { maxPriceImpactPct: 3 });
              swapBSuccess = swapB.success; swapBOutput = swapB.outputAmount ?? 0; swapBError = swapB.error ?? '';
            }
          }
          if (!swapBSuccess) {
            markDecision('KAMINO_BORROW_LP');
            logger.warn(`[CFO] KAMINO_BORROW_LP step 2b: USDC→${tokenB} failed — unwinding tokenA, repaying`);
            let unwindNote = 'Unwind not attempted';
            try {
              // Use actual wallet balance instead of tokenAReceived*0.99 to avoid dust
              const SOL_FEE_RESERVE_2B = 0.05;
              const aMintForBal = isTokenASol ? jupMod.MINTS.SOL : tokenAMint!;
              let unwindAmtA2 = await jupMod.getTokenBalance(aMintForBal);
              if (isTokenASol) unwindAmtA2 = Math.max(0, unwindAmtA2 - SOL_FEE_RESERVE_2B);
              const jupUnwindA = unwindAmtA2 > 0
                ? isTokenASol
                  ? await jupMod.swapSolToUsdc(unwindAmtA2, 100)
                  : await (async () => {
                      const q = await jupMod.getQuote(tokenAMint!, jupMod.MINTS.USDC, unwindAmtA2, 100);
                      if (!q) return { success: false as const, outputAmount: 0 };
                      return jupMod.executeSwap(q);
                    })()
                : { success: false as const, outputAmount: 0 };
              // tokenB swap failed so the second USDC half is still in wallet
              const totalUsdc = (jupUnwindA.success ? jupUnwindA.outputAmount ?? 0 : 0) + usdcAmount;
              const repay = await kamino.repay('USDC', Math.min(totalUsdc, borrowUsd) * 0.995).catch(() => ({ success: false, error: 'threw' }));
              unwindNote = (repay as any).success ? `Unwind OK` : `Repay failed: ${(repay as any).error}`;
            } catch (e) { unwindNote = `Unwind error: ${(e as Error).message}`; }
            logger.error(`[CFO] KAMINO_BORROW_LP step2b ${unwindNote}`);
            return { ...base, executed: true, success: false, error: `USDC→${tokenB} swap failed: ${swapBError}. ${unwindNote}` };
          }
          tokenBDepositAmount = swapBOutput;
          logger.info(`[CFO] KAMINO_BORROW_LP step 2b: swapped $${usdcAmount.toFixed(2)} USDC → ${tokenBDepositAmount.toFixed(4)} ${tokenB}`);
        }

        // Step 3: Open Orca concentrated LP on the target pool (not hardcoded SOL/USDC)
        const orca = await import('./orcaService.ts');
        const lpResult = await orca.openPosition(
          tokenBDepositAmount, tokenAReceived, rangeWidthPct,
          whirlpoolAddress, tokenADecimals ?? 9, tokenBDecimals ?? 6, poolTickSpacing,
        );
        if (!lpResult.success) {
          // Swap succeeded but LP failed — we have SOL + USDC sitting in wallet.
          // Mark cooldown immediately so the next cycle doesn't borrow again on top.
          markDecision('KAMINO_BORROW_LP');
          logger.error(`[CFO] KAMINO_BORROW_LP LP open failed after borrow+swap — attempting auto-unwind`);
          // Attempt to unwind: swap tokens back to USDC using ACTUAL wallet balance
          // (not the recorded swap amount) so we don't leave $1+ of dust behind.
          let unwindNote = 'Unwind not attempted';
          const SOL_FEE_RESERVE = 0.05; // keep for tx fees
          try {
            // Unwind: swap tokenA back to USDC — use real balance, not tokenAReceived*0.99
            const tokenAMintForBal = isTokenASol ? jupMod.MINTS.SOL : tokenAMint!;
            let unwindAmtA = await jupMod.getTokenBalance(tokenAMintForBal);
            if (isTokenASol) unwindAmtA = Math.max(0, unwindAmtA - SOL_FEE_RESERVE);
            const jupUnwind = unwindAmtA > 0
              ? isTokenASol
                ? await jupMod.swapSolToUsdc(unwindAmtA, 100)
                : await (async () => {
                    const q = await jupMod.getQuote(tokenAMint!, jupMod.MINTS.USDC, unwindAmtA, 100);
                    if (!q) return { success: false, inputMint: tokenAMint!, outputMint: jupMod.MINTS.USDC, inputAmount: unwindAmtA, outputAmount: 0, priceImpactPct: 0, error: 'No unwind quote' } as typeof jupMod extends { swapSolToUsdc: (...a: any[]) => Promise<infer R> } ? R : never;
                    return jupMod.executeSwap(q);
                  })()
              : { success: false as const, outputAmount: 0, error: 'zero balance' };
            if (jupUnwind.success) {
              let usdcRecovered = jupUnwind.outputAmount ?? 0;
              // If tokenB was swapped from USDC (non-USDC pool), also unwind tokenB → USDC
              if (!isTokenBUsdc && tokenBDepositAmount > 0) {
                try {
                  const tokenBMintForBal = isTokenBSol ? jupMod.MINTS.SOL : tokenBMint!;
                  let unwindAmtB = await jupMod.getTokenBalance(tokenBMintForBal);
                  if (isTokenBSol) unwindAmtB = Math.max(0, unwindAmtB - SOL_FEE_RESERVE);
                  if (unwindAmtB > 0) {
                    const unwindB = isTokenBSol
                      ? await jupMod.swapSolToUsdc(unwindAmtB, 100)
                      : await (async () => {
                          const q = await jupMod.getQuote(tokenBMint!, jupMod.MINTS.USDC, unwindAmtB, 100);
                          if (!q) return { success: false as const, outputAmount: 0 };
                          return jupMod.executeSwap(q);
                        })();
                    usdcRecovered += unwindB.success ? (unwindB.outputAmount ?? 0) : 0;
                  }
                } catch (tokenBErr) {
                  logger.error(`[CFO] KAMINO_BORROW_LP tokenB unwind failed:`, tokenBErr);
                }
              } else {
                usdcRecovered += usdcAmount; // tokenB side was USDC, still in wallet
              }
              const repayAmt = Math.min(usdcRecovered, borrowUsd);
              const repay = await kamino.repay('USDC', repayAmt * 0.995); // tiny fee buffer
              unwindNote = repay.success
                ? `Auto-unwind OK: repaid $${repayAmt.toFixed(2)} USDC`
                : `Swap OK but repay failed: ${repay.error} — manual repay needed`;
            } else {
              unwindNote = `Unwind swap failed: ${jupUnwind.error} — tokens remain in wallet, manual repay needed`;
            }
          } catch (unwindErr) {
            unwindNote = `Unwind error: ${(unwindErr as Error).message} — manual repay needed`;
          }
          logger.error(`[CFO] KAMINO_BORROW_LP ${unwindNote}`);
          // Alert admin if borrow is outstanding and rollback failed
          if (!unwindNote.startsWith('Auto-unwind OK')) {
            try {
              const { notifyAdminForce } = await import('../services/adminNotify.ts');
              await notifyAdminForce(
                `⚠️ KAMINO_BORROW_LP rollback incomplete\n` +
                `Borrowed $${borrowUsd.toFixed(0)} USDC but LP open failed.\n` +
                `${unwindNote}\n` +
                `Action needed: manually swap tokens back to USDC and repay Kamino.`,
              );
            } catch { /* admin notify best-effort */ }
          }
          return { ...base, executed: true, success: false, error: `LP open failed: ${lpResult.error}. ${unwindNote}` };
        }

        markDecision('KAMINO_BORROW_LP');
        logger.info(`[CFO] KAMINO_BORROW_LP step 3: opened Orca LP ${lpResult.positionMint?.slice(0, 8)} | tx: ${lpResult.txSignature}`);

        // Step 4: Sweep dust — the LP rarely consumes 100% of both tokens.
        // Swap any leftover tokenA/tokenB back to USDC so small balances
        // (KMNO, bSOL, INF etc.) don't accumulate in the wallet.
        try {
          // Sweep tokenA dust (skip if SOL — that's the gas/launch reserve)
          if (!isTokenASol && tokenAMint) {
            const dustA = await jupMod.getTokenBalance(tokenAMint);
            if (dustA > 0) {
              const quoteA = await jupMod.getQuote(tokenAMint, jupMod.MINTS.USDC, dustA, 200);
              if (quoteA) {
                const sweepA = await jupMod.executeSwap(quoteA);
                if (sweepA.success) {
                  logger.info(`[CFO] KAMINO_BORROW_LP dust sweep: ${dustA.toFixed(6)} ${tokenA} → $${(sweepA.outputAmount ?? 0).toFixed(2)} USDC`);
                }
              }
            }
          }

          // Sweep tokenB dust (skip if USDC — already the target; skip if SOL — gas reserve)
          if (!isTokenBUsdc && !isTokenBSol && tokenBMint) {
            const dustB = await jupMod.getTokenBalance(tokenBMint);
            if (dustB > 0) {
              const quoteB = await jupMod.getQuote(tokenBMint, jupMod.MINTS.USDC, dustB, 200);
              if (quoteB) {
                const sweepB = await jupMod.executeSwap(quoteB);
                if (sweepB.success) {
                  logger.info(`[CFO] KAMINO_BORROW_LP dust sweep: ${dustB.toFixed(6)} ${tokenB} → $${(sweepB.outputAmount ?? 0).toFixed(2)} USDC`);
                }
              }
            }
          }
        } catch (dustErr) {
          logger.debug(`[CFO] KAMINO_BORROW_LP dust sweep failed (non-critical):`, dustErr);
        }

        return {
          ...base,
          executed: true,
          success: true,
          // Use positionMint as txId so cfo.ts externalId matches
          txId: lpResult.positionMint ?? lpResult.txSignature,
          txHash: lpResult.txSignature,
          positionMint: lpResult.positionMint,
        } as DecisionResult & { txHash?: string; positionMint?: string };
      }

      case 'EVM_FLASH_ARB': {
        const arb = await import('./evmArbService.ts');
        const { opportunity, ethPriceUsd } = decision.params;
        const result = await arb.executeFlashArb(opportunity, ethPriceUsd ?? 3000);
        if (result.success) markDecision('EVM_FLASH_ARB');
        if (result.success && result.profitUsd) arb.recordProfit(result.profitUsd);
        return { ...base, executed: true, success: result.success, txId: result.txHash, error: result.error };
      }

      case 'KAMINO_JITO_LOOP': {
        const kamino = await import('./kaminoService.ts');
        const { jitoSolToDeposit, needsStakeFirst, targetLtv, maxLoops, solPriceUsd } = decision.params;
        let actualJitoSolToDeposit = jitoSolToDeposit;

        // If bootstrapping from wallet SOL: stake it first to get JitoSOL, then loop
        if (needsStakeFirst) {
          const jito = await import('./jitoStakingService.ts');

          // Pre-check: earlier decisions (e.g. AUTO_STAKE) may have already consumed
          // some wallet SOL. Re-check actual balance before attempting to stake.
          let solToStake = jitoSolToDeposit;
          try {
            const jupMod = await import('./jupiterService.ts');
            const freshSol = await jupMod.getTokenBalance(jupMod.MINTS.SOL);
            const reserveSol = 0.3; // always keep gas reserve
            const availableSol = Math.max(0, freshSol - reserveSol);
            if (availableSol < 0.05) {
              return { ...base, executed: true, success: false, error: `Insufficient SOL for pre-loop stake: ${freshSol.toFixed(4)} SOL (reserve ${reserveSol})` };
            }
            if (availableSol < solToStake) {
              logger.info(`[CFO] Pre-loop stake adjusted: ${solToStake.toFixed(4)} → ${availableSol.toFixed(4)} SOL (wallet balance changed)`);
              solToStake = availableSol;
            }
          } catch (err) {
            logger.warn(`[CFO] Could not pre-check SOL balance for loop stake: ${err}`);
          }

          const stakeResult = await jito.stakeSol(solToStake);
          if (!stakeResult.success) {
            return { ...base, executed: true, success: false, error: `Pre-loop stake failed: ${stakeResult.error}` };
          }
          logger.info(`[CFO] Pre-loop stake: ${solToStake.toFixed(4)} SOL → JitoSOL | tx: ${stakeResult.txSignature}`);
          // Brief wait for stake to settle
          await new Promise(r => setTimeout(r, 3000));

          // Re-check actual JitoSOL balance — staking exchange rate means
          // we get fewer JitoSOL than SOL we staked (currently ~1:0.88).
          // Using the stale pre-computed amount would cause "insufficient balance".
          try {
            const { getStakePosition } = await import('./jitoStakingService.ts');
            const pos = await getStakePosition(solPriceUsd);
            if (pos.jitoSolBalance > 0) {
              actualJitoSolToDeposit = pos.jitoSolBalance * 0.98; // leave tiny buffer
              logger.info(`[CFO] Post-stake JitoSOL balance: ${pos.jitoSolBalance.toFixed(4)}, depositing ${actualJitoSolToDeposit.toFixed(4)}`);
            }
          } catch (err) {
            logger.warn(`[CFO] Could not re-check JitoSOL balance, using computed: ${jitoSolToDeposit.toFixed(4)}`);
          }
        }

        // Step 1: Deposit initial JitoSOL as collateral
        const depositResult = await kamino.deposit('JitoSOL', actualJitoSolToDeposit);
        if (!depositResult.success) {
          return { ...base, executed: true, success: false, error: `Initial JitoSOL deposit failed: ${depositResult.error}` };
        }

        // Step 2: Execute the multiply loop
        const loopResult = await kamino.loopJitoSol(targetLtv, maxLoops, solPriceUsd);
        if (loopResult.success) markDecision('KAMINO_JITO_LOOP');
        return {
          ...base,
          executed: true,
          success: loopResult.success,
          txId: loopResult.txSignatures?.[loopResult.txSignatures.length - 1],
          error: loopResult.error,
        };
      }

      case 'KAMINO_JITO_UNWIND': {
        const kamino = await import('./kaminoService.ts');
        const unwindResult = await kamino.unwindJitoSolLoop();
        if (unwindResult.success) markDecision('KAMINO_JITO_UNWIND');
        return {
          ...base,
          executed: true,
          success: unwindResult.success,
          txId: unwindResult.txSignatures?.[unwindResult.txSignatures.length - 1],
          error: unwindResult.error,
        };
      }

      case 'KAMINO_LST_LOOP': {
        const kamino = await import('./kaminoService.ts');
        const { lst, lstAmount, needsSwap, targetLtv, maxLoops, solPriceUsd } = decision.params;
        const lstAsset = lst as import('./kaminoService.ts').LstAsset;

        // If we need to acquire the LST first (swap SOL → LST via Jupiter)
        if (needsSwap && lstAsset !== 'JitoSOL') {
          // For JitoSOL, loopLst handles Jito staking internally
          // For mSOL/bSOL, loopLst handles Jupiter swap internally
          logger.info(`[CFO] LST loop: will acquire ${lstAmount.toFixed(4)} ${lst} via swap`);
        }

        // Deposit initial LST as collateral, then loop
        const depositResult = await kamino.deposit(lstAsset, lstAmount);
        if (!depositResult.success) {
          return { ...base, executed: true, success: false, error: `Initial ${lst} deposit failed: ${depositResult.error}` };
        }

        const loopResult = await kamino.loopLst(lstAsset, targetLtv, maxLoops, solPriceUsd);
        if (loopResult.success) markDecision('KAMINO_LST_LOOP');
        return {
          ...base,
          executed: true,
          success: loopResult.success,
          txId: loopResult.txSignatures?.[loopResult.txSignatures.length - 1],
          error: loopResult.error,
        };
      }

      case 'KAMINO_LST_UNWIND': {
        const kamino = await import('./kaminoService.ts');
        const lstAsset = (decision.params.lst ?? 'JitoSOL') as import('./kaminoService.ts').LstAsset;
        const unwindResult = await kamino.unwindLstLoop(lstAsset);
        if (unwindResult.success) markDecision('KAMINO_LST_UNWIND');
        return {
          ...base,
          executed: true,
          success: unwindResult.success,
          txId: unwindResult.txSignatures?.[unwindResult.txSignatures.length - 1],
          error: unwindResult.error,
        };
      }

      case 'KAMINO_MULTIPLY_VAULT': {
        // Multiply vault deposits require the Kamino SDK — log-only for now
        logger.info(`[CFO] Multiply vault opportunity: ${decision.params.vaultName} — ${(decision.params.estimatedApy * 100).toFixed(1)}% APY (execution pending SDK integration)`);
        markDecision('KAMINO_MULTIPLY_VAULT');
        return {
          ...base,
          executed: true,
          success: true,
          error: 'Vault deposit not yet implemented — logged opportunity',
        };
      }

      case 'KRYSTAL_LP_OPEN': {
        const krystal = await import('./krystalService.ts');
        const { pool, deployUsd, rangeWidthTicks, bridgeFunding } = decision.params;

        // Compute wallet address for bridge funding if needed
        let resolvedBridgeFunding = bridgeFunding;
        if (bridgeFunding && !bridgeFunding.walletAddress && env.evmPrivateKey) {
          const ethers = await import('ethers' as string);
          resolvedBridgeFunding = {
            ...bridgeFunding,
            walletAddress: ethers.computeAddress(env.evmPrivateKey),
          };
        }

        const result = await krystal.openEvmLpPosition(pool, deployUsd, rangeWidthTicks, resolvedBridgeFunding);
        if (result.success) {
          markDecision('KRYSTAL_LP_OPEN');
        } else {
          // Mark cooldown on deterministic/repeatable failures to prevent
          // hammering the same doomed open every cycle (insufficient funds,
          // one-sided zap, pool not on factory, gas issues, etc.)
          const err = String(result.error ?? '').toLowerCase();
          if (
            err.includes('insufficient funding') ||
            err.includes('zap swap failed') ||
            err.includes('cannot mint') ||
            err.includes('no token0 or token1') ||
            err.includes('not on') ||  // "Pool not on X factory"
            err.includes('no gas') ||
            err.includes('no nfpm') ||
            err.includes('no swap route') ||
            err.includes('would revert') || // pre-flight simulation failure (STF, etc.)
            err.includes('stf')              // SafeTransferFrom — token contract blocking transfers
          ) {
            markDecision('KRYSTAL_LP_OPEN');
            logger.info(`[CFO:Decision] KRYSTAL_LP_OPEN failed (deterministic) — marking cooldown to avoid retry: ${err.slice(0, 80)}`);
          }
        }
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.tokenId ?? result.txHash,  // tokenId for NFPM ops; txHash stored separately below
          txHash: result.txHash,                   // actual on-chain tx hash for records
          error: result.error,
        } as DecisionResult & { txHash?: string };
      }

      case 'KRYSTAL_LP_INCREASE': {
        const krystal = await import('./krystalService.ts');
        const { pool, deployUsd, existingPosId } = decision.params;

        if (!existingPosId) {
          return { ...base, executed: false, error: 'KRYSTAL_LP_INCREASE missing existingPosId' };
        }

        // Reuse openEvmLpPosition with existingTokenId → calls increaseLiquidity instead of mint
        const result = await krystal.openEvmLpPosition(pool, deployUsd, 0, undefined, existingPosId);
        if (result.success) {
          markDecision('KRYSTAL_LP_INCREASE');
        } else {
          const err = String(result.error ?? '').toLowerCase();
          // Deterministic failures (ownership/metadata/revert preflight) should not be retried every cycle.
          if (
            err.includes('cannot increase #') ||
            err.includes('would revert') ||
            err.includes('position has zero liquidity') ||
            err.includes('owner')
          ) {
            markDecision('KRYSTAL_LP_INCREASE');
          }
        }
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: existingPosId,                     // keep same posId for record updates
          txHash: result.txHash,
          error: result.error,
        } as DecisionResult & { txHash?: string };
      }

      case 'KRYSTAL_LP_REBALANCE': {
        const krystal = await import('./krystalService.ts');
        const { posId, chainNumericId, closeOnly, rangeWidthTicks, protocol: rebalProto } = decision.params;
        const chainId = decision.params.chainName
          ? `${decision.params.chainName}@${chainNumericId}`
          : String(chainNumericId);

        // Look up token info from params for USD value estimation
        const token0 = decision.params.token0Address
          ? { address: decision.params.token0Address, symbol: decision.params.token0Symbol ?? '?', decimals: decision.params.token0Decimals ?? 18 }
          : undefined;
        const token1 = decision.params.token1Address
          ? { address: decision.params.token1Address, symbol: decision.params.token1Symbol ?? '?', decimals: decision.params.token1Decimals ?? 18 }
          : undefined;

        // Use standalone rebalance function
        const { closeResult, openResult } = await krystal.rebalanceEvmLpPosition({
          posId,
          chainId,
          chainNumericId,
          rangeWidthTicks,
          closeOnly,
          token0,
          token1,
          protocol: rebalProto,
          originalPoolAddress: decision.params.poolAddress,
        });

        if (!closeResult.success) {
          return { ...base, executed: true, success: false, error: `Close failed: ${closeResult.error}` };
        }
        logger.info(`[CFO] KRYSTAL_LP_REBALANCE: closed posId=${posId} | tx=${closeResult.txHash}`);

        if (openResult?.success) {
          markDecision('KRYSTAL_LP_OPEN');
          return {
            ...base,
            executed: true,
            success: true,
            txId: openResult.tokenId ?? openResult.txHash,
            txHash: openResult.txHash,
          } as DecisionResult & { txHash?: string };
        }

        markDecision('KRYSTAL_LP_REBALANCE');
        return { ...base, executed: true, success: true, txId: closeResult.txHash };
      }

      case 'KRYSTAL_LP_CLAIM_FEES': {
        const krystal = await import('./krystalService.ts');
        const { posId, chainNumericId, chainName, protocol: claimProto } = decision.params;
        const chainId = `${chainName}@${chainNumericId}`;
        const result = await krystal.claimEvmLpFees({ posId, chainId, chainNumericId, protocol: claimProto });
        if (result.success) markDecision(`KRYSTAL_LP_CLAIM_${posId}`);
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txHash,
          error: result.error,
        };
      }

      // ── Signal-driven perp trading ──────────────────────────────────
      case 'HL_PERP_OPEN':
      case 'HL_PERP_NEWS': {
        const hl = await import('./hyperliquidService.ts');
        const { coin, side, sizeUsd, leverage, stopLossPct, takeProfitPct, signal, conviction, tradeStyle } = decision.params;
        const result = await hl.openPerpTrade({
          coin,
          side,
          sizeUsd,
          leverage,
          stopLossPct,
          takeProfitPct,
          signal,
          conviction,
        });
        if (result.success) {
          const cooldownKey = decision.type === 'HL_PERP_NEWS'
            ? `HL_PERP_NEWS_${coin}`
            : tradeStyle
              ? `HL_PERP_TA_${coin}_${tradeStyle}`
              : `HL_PERP_${coin}`;
          markDecision(cooldownKey);

          // Track trade style for exit logic (style-specific SL/TP + hold limits)
          if (tradeStyle) {
            _perpTradeStyles.set(`${coin}-${side}`, {
              style: tradeStyle as TradeStyle,
              openedAt: new Date().toISOString(),
            });
            logger.debug(`[CFO:Decision] Tracking TA style: ${coin}-${side} → ${tradeStyle}`);
          }
        }
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          error: result.error,
        };
      }

      case 'HL_PERP_CLOSE': {
        const hl = await import('./hyperliquidService.ts');
        const { coin, side } = decision.params;
        const summary = await hl.getAccountSummary();
        const pos = summary.positions.find(
          (p) => p.coin === coin && p.side === side,
        );
        if (!pos) {
          return { ...base, executed: false, error: `No ${side} ${coin} position found to close` };
        }
        const sizeInCoin = pos.sizeUsd / pos.markPrice;
        const isBuy = side === 'SHORT'; // buy back to close short, sell to close long
        // Capture HL's unrealizedPnl BEFORE closing — this is the exchange ground truth.
        // Using costBasis/receivedUsd math is fragile (margin vs notional mismatch).
        const hlUnrealizedPnl = pos.unrealizedPnlUsd ?? 0;
        const result = await hl.closePosition(coin, sizeInCoin, isBuy);
        if (result.success) {
          markDecision(`HL_PERP_CLOSE_${coin}`);
          // Clean up trade style tracker
          _perpTradeStyles.delete(`${coin}-${side}`);
        }
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          receivedUsd: result.success ? pos.sizeUsd : undefined,
          hlUnrealizedPnl: result.success ? hlUnrealizedPnl : undefined,
          error: result.error,
        };
      }

      default:
        return { ...base, executed: false, error: `Unknown decision type: ${decision.type}` };
    }
  } catch (err) {
    logger.error(`[CFO:Decision] Execute error for ${decision.type}:`, err);
    return { ...base, executed: false, success: false, error: (err as Error).message };
  }
}

// ============================================================================
// STEP 5: Format report for supervisor + Telegram
// ============================================================================

export function formatDecisionReport(
  state: PortfolioState,
  results: DecisionResult[],
  dryRun: boolean,
  intel?: SwarmIntel,
): string {
  const L: string[] = [];

  // ── Header ──
  L.push(`🧠 <b>CFO Report</b>`);

  // ── Market ──
  if (intel) {
    const mood = intel.marketCondition ?? 'neutral';
    const moodIcon = mood === 'bullish' ? '🟢' : mood === 'bearish' ? '🔴' : mood === 'danger' ? '🚨' : '⚪';

    // Alerts detail
    const alertParts: string[] = [];
    if (intel.guardianCritical) alertParts.push('🚨 Security alert active');
    if (intel.guardianAlerts?.length) {
      for (const a of intel.guardianAlerts.slice(0, 2)) {
        alertParts.push(`⚠️ ${typeof a === 'string' ? a : (a as any).summary ?? (a as any).message ?? 'watch alert'}`);
      }
    }
    if (intel.analystVolumeSpike) alertParts.push('📊 Volume spike detected');

    const moverStr = intel.analystMovers?.length
      ? `\n   Top mover: ${intel.analystMovers[0].symbol} ${intel.analystMovers[0].change24hPct > 0 ? '+' : ''}${intel.analystMovers[0].change24hPct.toFixed(0)}%`
      : '';

    L.push(`${moodIcon} <b>Market:</b> ${mood}${moverStr}`);
    if (alertParts.length) L.push(alertParts.map(a => `   ${a}`).join('\n'));
  }

  // ── Holdings ──
  L.push('');
  L.push(`━━━ <b>Holdings — $${state.totalPortfolioUsd.toFixed(0)}</b> ━━━`);

  const rawSolUsd = state.solBalance * state.solPriceUsd;
  L.push(`   Wallet: ${state.solBalance.toFixed(2)} SOL ($${rawSolUsd.toFixed(0)})`);
  if (state.jitoSolBalance > 0.01) L.push(`   Staked: ${state.jitoSolBalance.toFixed(2)} JitoSOL ($${state.jitoSolValueUsd.toFixed(0)})`);
  if (state.hlEquity > 1) L.push(`   Hyperliquid: $${state.hlEquity.toFixed(0)}`);
  if (state.polyDeployedUsd > 1) L.push(`   Polymarket: $${state.polyDeployedUsd.toFixed(0)}`);
  if (state.kaminoDepositValueUsd > 1) L.push(`   Kamino: $${state.kaminoDepositValueUsd.toFixed(0)}`);
  if (state.orcaLpValueUsd > 1) L.push(`   Orca LP: $${state.orcaLpValueUsd.toFixed(0)}`);

  // EVM LP (summary only — per-position detail shown in Krystal LP section of system report)
  if (state.evmLpTotalValueUsd > 1) {
    const inRange = state.evmLpPositions.filter(p => p.inRange).length;
    const feeStr = state.evmLpTotalFeesUsd > 0.01 ? ` (+$${state.evmLpTotalFeesUsd.toFixed(2)} fees)` : '';
    L.push(`   Krystal LP: $${state.evmLpTotalValueUsd.toFixed(0)} (${inRange}/${state.evmLpPositions.length} in-range)${feeStr}`);
  }

  // EVM chain balances (all assets per chain)
  if (state.evmChainBalances.length > 0) {
    const chainsWithValue = state.evmChainBalances.filter(b => b.totalValueUsd > 1);
    if (chainsWithValue.length > 0) {
      const chainParts = chainsWithValue.map(b => {
        const parts: string[] = [];
        if (b.totalStableUsd > 0.5) parts.push(`$${b.totalStableUsd.toFixed(0)} stables`);
        if (b.wethValueUsd > 0.5) parts.push(`$${b.wethValueUsd.toFixed(0)} W${b.nativeSymbol}`);
        if (b.nativeValueUsd > 0.5) parts.push(`$${b.nativeValueUsd.toFixed(0)} ${b.nativeSymbol}`);
        return `${b.chainName}: ${parts.join(' + ')} ($${b.totalValueUsd.toFixed(0)})`;
      });
      L.push(`   EVM wallets: ${chainParts.join(' · ')}`);
    }
  }

  // ── Strategies ──
  // Arb scanner
  if (state.evmArbPoolCount > 0 || state.evmArbProfit24h > 0) {
    L.push('');
    const arbParts: string[] = [];
    arbParts.push(`scanning ${state.evmArbPoolCount} pools`);
    if (state.evmArbProfit24h > 0.01) arbParts.push(`+$${state.evmArbProfit24h.toFixed(2)} today`);
    if (state.evmArbUsdcBalance > 1) arbParts.push(`$${state.evmArbUsdcBalance.toFixed(0)} USDC deployed`);
    L.push(`⚡ <b>Arb Scanner:</b> ${arbParts.join(' · ')}`);
  }

  // ── Risk ──
  L.push('');
  const hedgePct = (state.hedgeRatio * 100).toFixed(0);
  if (state.hedgeRatio > 1.05) {
    L.push(`🛡 <b>Risk:</b> ${hedgePct}% hedged (over-hedged) · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  } else if (state.hedgeRatio >= 0.4) {
    L.push(`🛡 <b>Risk:</b> ${hedgePct}% hedged · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  } else if (state.hedgeRatio < 0.1 && state.solExposureUsd > 20) {
    L.push(`⚠️ <b>Risk: Unhedged!</b> Only ${hedgePct}% of $${state.solExposureUsd.toFixed(0)} SOL exposure is protected · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  } else {
    L.push(`🔸 <b>Risk:</b> ${hedgePct}% hedged · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  }

  // ── Actions ──
  L.push('');
  if (results.length === 0) {
    L.push(`✅ <b>Actions:</b> Nothing to do — all good.`);
  } else {
    L.push(`━━━ <b>Actions</b> ━━━`);
    for (const r of results) {
      const d = r.decision;
      const icon = r.pendingApproval ? '⏳' : r.success ? (r.executed ? '✅' : '📋') : '❌';

      const tag = r.pendingApproval ? 'needs approval'
        : r.dryRun ? 'dry run'
        : r.executed ? (r.success ? 'done' : 'failed')
        : 'skipped';

      const what = _humanAction(d, state);
      const amt = Math.abs(d.estimatedImpactUsd);
      const amtStr = amt >= 1 ? ` · $${amt.toFixed(0)}` : '';

      L.push(`${icon} ${what}${amtStr} — ${tag}`);

      if (r.error && !r.success) L.push(`      ⚠️ ${r.error}`);
      if (r.txId) L.push(`      🔗 ${r.txId}`);
    }
  }

  // ── Learning ──
  const learnedParams = getAdaptiveParams();
  if (learnedParams.lastComputed > 0) {
    L.push('');
    L.push(formatLearningSummary(learnedParams));
  }

  return L.join('\n');
}

/**
 * Turn a Decision into a single plain-English sentence that
 * explains WHAT and WHY to a non-technical admin.
 */
function _humanAction(d: Decision, state: PortfolioState): string {
  const p = d.params ?? {};
  switch (d.type) {
    case 'OPEN_HEDGE': {
      const coin = p.coin ?? 'SOL';
      return `<b>Hedge ${coin}</b> — short $${Math.abs(d.estimatedImpactUsd).toFixed(0)} ${coin}-PERP to protect $${(state.treasuryExposures?.find(e => e.symbol === coin)?.valueUsd ?? state.solExposureUsd).toFixed(0)} ${coin} exposure`;
    }
    case 'CLOSE_HEDGE': {
      const coin = p.coin ?? 'SOL';
      return `<b>Reduce ${coin} hedge</b> — ${coin} exposure changed, closing excess short`;
    }
    case 'REBALANCE_HEDGE': {
      const coin = p.coin ?? 'SOL';
      return `<b>Rebalance ${coin} hedge</b> — adjusting short size to match current ${coin}`;
    }
    case 'CLOSE_LOSING':
      return `<b>Close losing position</b> — cutting loss before it gets worse`;
    case 'AUTO_STAKE':
      return `<b>Stake ${p.amount?.toFixed(2) ?? '?'} SOL</b> → JitoSOL for ~7% APY`;
    case 'UNSTAKE_JITO':
      return `<b>Unstake ${p.amount?.toFixed(2) ?? '?'} JitoSOL</b> → SOL (need runway)`;
    case 'POLY_BET': {
      const q = (p.marketQuestion ?? '').slice(0, 50);
      return `<b>Prediction bet</b> — ${q || 'placing bet'}`;
    }
    case 'POLY_EXIT':
      return `<b>Close prediction</b> — exiting position`;
    case 'KAMINO_BORROW_DEPLOY':
      return `<b>Borrow &amp; deploy</b> — $${p.borrowUsd?.toFixed(0) ?? '?'} USDC from Kamino → yield (${p.spreadPct?.toFixed(1) ?? '?'}% spread)`;
    case 'KAMINO_REPAY':
      return `<b>Repay loan</b> — $${p.repayUsd?.toFixed(0) ?? '?'} USDC back to Kamino`;
    case 'KAMINO_JITO_LOOP':
      if (p.blocked) {
        const jitoYieldPct = p.estimatedApy != null
          ? ((state.kaminoJitoSupplyApy || 0.08) * 100).toFixed(1)
          : '8.0';
        return `⏸ <b>Jito Loop waiting</b> — spread is ${p.currentSpreadPct?.toFixed(1) ?? '?'}% (need >1%). SOL borrow ${(state.kaminoSolBorrowApy * 100).toFixed(1)}% > JitoSOL yield ${jitoYieldPct}%. Break-even at ${((p.breakEvenBorrowRate ?? 0) * 100).toFixed(1)}%`;
      }
      return `<b>Leverage JitoSOL</b> — deposit ${p.jitoSolToDeposit?.toFixed(2) ?? '?'} JitoSOL, loop to ${((p.targetLtv ?? 0.65) * 100).toFixed(0)}% LTV for ~${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY`;
    case 'KAMINO_JITO_UNWIND':
      return `<b>Unwind JitoSOL loop</b> — closing leveraged position`;
    case 'KAMINO_LST_LOOP': {
      if (p.blocked) {
        const spreads = (p.allCandidates ?? []).map((c: any) => `${c.lst} ${(c.spread * 100).toFixed(1)}%`).join(', ');
        return `⏸ <b>LST Loop waiting</b> — best spread is ${p.currentSpreadPct?.toFixed(1) ?? '?'}% (${p.lst ?? '?'}, need >1%). All: ${spreads}`;
      }
      const runners = (p.allCandidates ?? []).filter((c: any) => c.lst !== p.lst).map((c: any) => `${c.lst} ${(c.spread * 100).toFixed(1)}%`).join(', ');
      return `<b>Leverage ${p.lst ?? '?'}</b> — deposit ${p.lstAmount?.toFixed(2) ?? '?'} ${p.lst ?? 'LST'}, loop to ${((p.targetLtv ?? 0.65) * 100).toFixed(0)}% LTV for ~${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY${runners ? ` (vs ${runners})` : ''}`;
    }
    case 'KAMINO_LST_UNWIND':
      return `<b>Unwind ${p.lst ?? 'LST'} loop</b> — closing leveraged ${p.lst ?? 'LST'}/SOL position`;
    case 'KAMINO_MULTIPLY_VAULT':
      return `<b>Kamino Vault</b> — deposit ${p.depositAmount?.toFixed(2) ?? '?'} ${p.collateralToken ?? 'LST'} into "${p.vaultName ?? 'Multiply'}" (${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY, ${p.leverage?.toFixed(1) ?? '?'}x)${p.needsSwap ? ' (swap SOL first)' : ''}`;
    case 'ORCA_LP_OPEN':
      return `<b>Open LP</b> — $${((p.usdcAmount ?? 0) * 2).toFixed(0)} in ${p.pair ?? 'SOL/USDC'} (±${(p.rangeWidthPct ?? 20) / 2}% range)${p.needsSwap ? ' (auto-swap)' : ''}`;
    case 'ORCA_LP_REBALANCE':
      return `<b>Rebalance LP</b> — price moved out of range, re-centering`;
    case 'ORCA_LP_CLAIM_FEES':
      return `<b>Claim Orca LP fees</b> — $${p.feesUsd?.toFixed(2) ?? '?'} from ${p.tokenA ?? 'SOL'}/${p.tokenB ?? 'USDC'}`;
    case 'ORCA_LP_CLOSE':
      return `<b>Close Orca LP</b> — withdrawing ${p.pair ?? 'LP'} position`;
    case 'KAMINO_BORROW_LP':
      if (p.blocked) {
        return `⏸ <b>Borrow→LP waiting</b> — ${p.blockReason === 'no_collateral' ? 'needs Jito loop collateral first' : 'blocked'}. Would borrow $${p.borrowUsd?.toFixed(0) ?? '?'} → ${p.pair ?? 'SOL/USDC'} LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
      }
      return `<b>Borrow → LP</b> — $${p.borrowUsd?.toFixed(0) ?? '?'} from Kamino → ${p.pair ?? 'SOL/USDC'} LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
    case 'EVM_FLASH_ARB': {
      const pair = p.opportunity?.displayPair ?? p.displayPair ?? '?/?';
      const buyDex = (p.opportunity?.buyPool?.dex ?? p.buyDex ?? '?').replace('_v3', ' V3').replace('_', ' ');
      const sellDex = (p.opportunity?.sellPool?.dex ?? p.sellDex ?? '?').replace('_v3', ' V3').replace('_', ' ');
      const flash = p.opportunity?.flashAmountUsd ?? p.flashAmountUsd ?? 0;
      const net = p.opportunity?.netProfitUsd ?? p.netProfitUsd ?? 0;
      return `<b>Flash arb</b> — ${pair} buy ${buyDex} → sell ${sellDex}` +
        (flash > 0 ? ` · flash $${flash.toLocaleString()}` : '') +
        (net > 0 ? ` · net $${net.toFixed(2)}` : '');
    }
    case 'KRYSTAL_LP_OPEN':
      return `<b>Open EVM LP</b> — $${p.deployUsd?.toFixed(0) ?? '?'} in ${p.pair ?? '?/?'} on ${p.chainName ?? 'EVM'} (${p.rangeWidthTicks ?? 400} tick range)`;
    case 'KRYSTAL_LP_INCREASE':
      return `<b>Add to EVM LP</b> — $${p.deployUsd?.toFixed(0) ?? '?'} → ${p.pair ?? '?/?'} #${p.existingPosId ?? '?'} on ${p.chainName ?? 'EVM'}`;
    case 'KRYSTAL_LP_REBALANCE':
      return p.closeOnly
        ? `<b>Close EVM LP</b> — ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}`
        : `<b>Rebalance EVM LP</b> — ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}, re-centering`;
    case 'KRYSTAL_LP_CLAIM_FEES':
      return `<b>Claim EVM LP fees</b> — $${p.feesOwedUsd?.toFixed(2) ?? '?'} from ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}`;
    case 'HL_PERP_OPEN': {
      const styleTag = p.tradeStyle ? `[${p.tradeStyle}] ` : '';
      return `<b>${styleTag}${p.side ?? 'LONG'} ${p.coin ?? '?'}-PERP</b> — $${p.sizeUsd?.toFixed(0) ?? '?'} at ${p.leverage ?? 2}x (conviction: ${((p.conviction ?? 0) * 100).toFixed(0)}%, SL: ${p.stopLossPct ?? 5}%, TP: ${p.takeProfitPct ?? 10}%)`;
    }
    case 'HL_PERP_NEWS':
      return `<b>📰 ${p.side ?? 'LONG'} ${p.coin ?? '?'}-PERP</b> — news-reactive $${p.sizeUsd?.toFixed(0) ?? '?'} (${p.change24hPct != null ? `${p.change24hPct > 0 ? '+' : ''}${p.change24hPct.toFixed(1)}%` : 'big move'}, SL: 3%)`;
    case 'HL_PERP_CLOSE': {
      const pnlStr = p.unrealizedPnl != null
        ? ` (PnL: ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)})`
        : '';
      return `<b>Close ${p.side ?? '?'} ${p.coin ?? '?'}-PERP</b> — $${p.sizeUsd?.toFixed(0) ?? '?'}${pnlStr}`;
    }
    default:
      return `<b>${d.type}</b> — ${d.reasoning.length > 60 ? d.reasoning.slice(0, 57) + '…' : d.reasoning}`;
  }
}

// ============================================================================
// Main entry: run one decision cycle
// ============================================================================

let _cycleRunning = false;
let _cycleStartedAt: number | null = null;
const CYCLE_LOCK_TIMEOUT_MS = 10 * 60_000; // 10 minutes — if cycle hangs longer, force-reset
const CYCLE_INNER_TIMEOUT_MS = 5 * 60_000; // 5 minutes — hard timeout for inner cycle execution

/** Race a promise against a timeout — rejects with Error if timeout fires first */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(0)}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function runDecisionCycle(pool?: any): Promise<{
  state: PortfolioState;
  decisions: Decision[];
  results: DecisionResult[];
  report: string;
  intel: SwarmIntel;
  traceId: string;
}> {
  // Prevent concurrent / duplicate cycles (e.g. SIGTERM race, timer overlap)
  if (_cycleRunning) {
    // If the lock has been held for >10 minutes, the previous cycle is hung — force-reset
    if (_cycleStartedAt && Date.now() - _cycleStartedAt > CYCLE_LOCK_TIMEOUT_MS) {
      logger.warn(`[CFO:Decision] Cycle lock stuck for ${((Date.now() - _cycleStartedAt) / 60_000).toFixed(1)}min — force-resetting`);
      _cycleRunning = false;
      _cycleStartedAt = null;
    } else {
      const elapsed = _cycleStartedAt ? ((Date.now() - _cycleStartedAt) / 1000).toFixed(0) : '?';
      logger.debug(`[CFO:Decision] Cycle already in progress (${elapsed}s) — skipping duplicate`);
      return {
        state: {} as PortfolioState,
        decisions: [],
        results: [],
        report: '',
        intel: { riskMultiplier: 1.0, marketCondition: 'neutral' },
        traceId: 'skipped',
      };
    }
  }
  _cycleRunning = true;
  _cycleStartedAt = Date.now();

  try {
    // Race inner cycle against a hard 5-minute timeout — prevents indefinite hangs
    // from stuck DB queries, RPC calls, or API fetches
    return await raceTimeout(
      _runDecisionCycleInner(pool),
      CYCLE_INNER_TIMEOUT_MS,
      'Decision cycle inner',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[CFO:Decision] Cycle failed: ${msg}`);
    // Return empty result so callers don't blow up
    return {
      state: {} as PortfolioState,
      decisions: [],
      results: [],
      report: `Cycle failed: ${msg}`,
      intel: { riskMultiplier: 1.0, marketCondition: 'neutral' },
      traceId: 'error',
    };
  } finally {
    _cycleRunning = false;
    _cycleStartedAt = null;
  }
}

async function _runDecisionCycleInner(pool?: any): Promise<{
  state: PortfolioState;
  decisions: Decision[];
  results: DecisionResult[];
  report: string;
  intel: SwarmIntel;
  traceId: string;
}> {
  const env = getCFOEnv();
  const config = getDecisionConfig();

  // Generate a unique trace ID for this decision cycle
  const traceId = `cfo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info(`[CFO:Decision] Starting decision cycle (traceId=${traceId})...`);

  // 1. Gather portfolio state
  const state = await raceTimeout(gatherPortfolioState(), 60_000, 'gatherPortfolioState');
  const rawSolUsd = state.solBalance * state.solPriceUsd;
  // Build optional segments so the log line only shows relevant info
  const _pSegments: string[] = [
    `$${state.totalPortfolioUsd.toFixed(0)}`,
    `SOL: ${state.solBalance.toFixed(2)} ($${rawSolUsd.toFixed(0)})`,
  ];
  if (state.jitoSolBalance >= 0.01) _pSegments.push(`JitoSOL: ${state.jitoSolBalance.toFixed(2)} ($${state.jitoSolValueUsd.toFixed(0)})`);
  if (state.kaminoDepositValueUsd > 0) _pSegments.push(`Kamino: dep $${state.kaminoDepositValueUsd.toFixed(0)} borrow $${state.kaminoBorrowValueUsd.toFixed(0)} HF=${state.kaminoHealthFactor === 999 ? 'none' : state.kaminoHealthFactor.toFixed(2)}`);
  if (state.orcaPositions.length > 0) _pSegments.push(`Orca: ${state.orcaPositions.length} pos $${state.orcaLpValueUsd.toFixed(0)}`);
  if (state.evmLpPositions.length > 0) _pSegments.push(`EVM LP: ${state.evmLpPositions.length} pos $${state.evmLpTotalValueUsd.toFixed(0)}`);
  if (state.evmTotalUsdcAllChains > 0) _pSegments.push(`EVM USDC: $${state.evmTotalUsdcAllChains.toFixed(0)}`);
  _pSegments.push(`hedge: ${(state.hedgeRatio * 100).toFixed(0)}%`);
  if (state.hlEquity > 0) _pSegments.push(`HL equity: $${state.hlEquity.toFixed(0)}`);
  if (state.polyUsdcBalance > 0) _pSegments.push(`Poly USDC: $${state.polyUsdcBalance.toFixed(0)}`);
  logger.info(`[CFO:Decision] Portfolio: ${_pSegments.join(' | ')}`);

  // 1.5. Hydrate EVM arb profit from DB (survives process restarts)
  if (env.evmArbEnabled && pool) {
    try {
      const arbMod = await import('./evmArbService.ts');
      await arbMod.hydrateProfit24hFromDb(pool);
    } catch { /* non-fatal */ }
  }

  // 1.4. Progressive learning — retrospective on past trades
  if (pool) setLearningPool(pool);
  let learned: AdaptiveParams = getAdaptiveParams();
  try {
    learned = await refreshLearning(pool);
  } catch (err) {
    logger.debug('[CFO:Learning] Retrospective failed (using cached/defaults):', err);
  }

  // 1.5. Consult swarm — gather intel from scout, guardian, analyst
  let intel: SwarmIntel = { riskMultiplier: 1.0, marketCondition: 'neutral' };
  if (pool) {
    try {
      intel = await raceTimeout(gatherSwarmIntel(pool), 30_000, 'gatherSwarmIntel');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[CFO:Decision] Swarm intel gathering failed (non-fatal): ${msg}`);
    }
  } else {
    logger.debug('[CFO:Decision] No DB pool provided — skipping swarm intel');
  }

  logger.info(`[CFO:Intel] Market: ${intel.marketCondition} (risk×${intel.riskMultiplier.toFixed(2)})`);

  // 1.8. Enrich treasury exposures with multi-asset scan
  // (needs intel for price resolution & HL listing check)
  try {
    const jupiter = await import('./jupiterService.ts');
    const hl = await import('./hyperliquidService.ts');

    const [walletBalances, hlCoins] = await raceTimeout(
      Promise.all([
        jupiter.getWalletTokenBalances(),
        hl.getHLListedCoins(),
      ]),
      30_000,
      'Treasury enrichment (walletBalances + hlCoins)',
    );
    const hlCoinSet = new Set(hlCoins.map((c: string) => c.toUpperCase()));

    // Build price map from analyst/guardian intel + known prices
    const priceMap: Record<string, number> = { SOL: state.solPriceUsd };
    if (intel.analystPrices) {
      for (const [sym, info] of Object.entries(intel.analystPrices)) {
        const price = typeof info === 'number' ? info : info?.usd;
        if (typeof price === 'number' && price > 0) priceMap[sym.toUpperCase()] = price;
      }
    }
    if (intel.guardianTokens) {
      for (const gt of intel.guardianTokens) {
        const sym = (gt.ticker ?? '').toUpperCase();
        if (sym && gt.priceUsd > 0) priceMap[sym] = gt.priceUsd;
      }
    }

    // Push analyst prices to krystalService for native token pricing (gas estimates, LP value)
    try {
      const krystal = await import('./krystalService.ts');
      krystal.setAnalystPrices(priceMap);
    } catch { /* non-fatal */ }

    // Build enriched treasury exposures
    // SOL LSTs (JitoSOL, mSOL, bSOL, etc.) are folded into the underlying SOL entry
    // so the hedge engine sees combined SOL-equivalent exposure and hedges via SOL-PERP.
    // Min-exposure filter is applied AFTER aggregation so $41 SOL + $225 JitoSOL = $266
    // passes the $50 threshold even though each token alone might not.
    const exposures: PortfolioState['treasuryExposures'] = [];
    const lstContributions: string[] = []; // track LST details for logging
    for (const wb of walletBalances) {
      if (!wb.symbol) continue; // skip unknown tokens
      const sym = wb.symbol.toUpperCase();
      // Skip stablecoins — not hedgeable
      if (['USDC', 'USDT', 'DAI', 'BUSD'].includes(sym)) continue;
      // Skip dust
      if (wb.balance < 0.000001) continue;

      // Resolve USD value
      let valueUsd = 0;
      if (sym === 'SOL') {
        valueUsd = wb.balance * state.solPriceUsd;
      } else if (priceMap[sym]) {
        valueUsd = wb.balance * priceMap[sym];
      }

      if (valueUsd < 1) continue; // skip true dust

      // Fold SOL LSTs into their underlying asset for correct hedge aggregation
      const underlying = SOL_LST_UNDERLYING[sym];
      if (underlying) {
        lstContributions.push(`${wb.balance.toFixed(4)} ${sym}($${valueUsd.toFixed(0)})`);
        const idx = exposures.findIndex(e => e.symbol === underlying);
        if (idx >= 0) {
          exposures[idx].valueUsd += valueUsd;
          exposures[idx].balance += valueUsd / state.solPriceUsd; // SOL-equivalent units
        } else {
          exposures.push({
            symbol: underlying,
            mint: wb.mint,
            balance: valueUsd / state.solPriceUsd, // SOL-equivalent units
            valueUsd,
            hlListed: hlCoinSet.has(underlying),
          });
        }
        continue;
      }

      // For raw SOL, merge with any existing SOL entry (may have been created by an LST above)
      if (sym === 'SOL') {
        const idx = exposures.findIndex(e => e.symbol === 'SOL');
        if (idx >= 0) {
          exposures[idx].valueUsd += valueUsd;
          exposures[idx].balance += wb.balance;
          continue;
        }
      }

      exposures.push({
        symbol: sym,
        mint: wb.mint,
        balance: wb.balance,
        valueUsd,
        hlListed: hlCoinSet.has(sym),
      });
    }

    // Apply min-exposure filter AFTER LST aggregation
    const filteredExposures = exposures.filter(e => e.valueUsd >= env.hlHedgeMinExposureUsd);

    // Sort by value descending — highest exposure first
    filteredExposures.sort((a, b) => b.valueUsd - a.valueUsd);

    // Only override if we got results; keep SOL fallback otherwise
    if (filteredExposures.length > 0) {
      state.treasuryExposures = filteredExposures;

      // Recalculate hedgeRatio with enriched data
      const totalHedgeable = filteredExposures
        .filter((e) => e.hlListed)
        .reduce((s, e) => s + e.valueUsd, 0);
      if (totalHedgeable > 0) {
        (state as any).hedgeRatio = state.hlTotalShortUsd / totalHedgeable;
      }
    }

    const lstSuffix = lstContributions.length > 0 ? ` [LST→SOL: ${lstContributions.join(' + ')}]` : '';
    logger.info(
      `[CFO:Treasury] ${state.treasuryExposures.length} asset(s): ` +
      state.treasuryExposures.map((e) => `${e.symbol}=$${e.valueUsd.toFixed(0)}${e.hlListed ? '(HL)' : ''}`).join(', ') +
      lstSuffix,
    );
  } catch (err) {
    logger.warn('[CFO:Treasury] Multi-asset scan failed (falling back to SOL-only):', err);
    // treasuryExposures retains the SOL-only fallback from gatherPortfolioState
  }

  // 2+3. Assess + Decide (with intel + learned params)
  const decisions = await generateDecisions(state, config, env, intel, learned);
  if (decisions.length === 0) {
    logger.info('[CFO:Decision] No actions needed');
  } else {
    logger.info(`[CFO:Decision] ${decisions.length} decision(s): ${decisions.map((d) => `${d.type}[${d.tier}]`).join(', ')}`);
  }

  // 4. Execute (AUTO and NOTIFY tiers only — APPROVAL returns pendingApproval)
  const results: DecisionResult[] = [];
  for (const decision of decisions) {
    const result = await executeDecision(decision, env);
    result.traceId = traceId;
    results.push(result);

    // Small delay between executions to avoid rate limits
    if (results.length < decisions.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 5. Report (includes swarm intel summary)
  const report = formatDecisionReport(state, results, env.dryRun, intel);

  return { state, decisions, results, report, intel, traceId };
}
