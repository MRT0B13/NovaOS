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
  | 'KAMINO_BORROW_LP'       // borrow from Kamino → swap → open Orca LP, fees repay loan
  | 'EVM_FLASH_ARB'          // Arbitrum: atomic flash loan arb via Aave v3 + DEX spread
  | 'KRYSTAL_LP_OPEN'        // open EVM concentrated LP via Krystal-discovered pool
  | 'KRYSTAL_LP_REBALANCE'   // close + reopen out-of-range EVM LP (closeOnly=true → just close)
  | 'KRYSTAL_LP_CLAIM_FEES'  // collect accumulated fees from EVM LP positions
  | 'EVM_BRIDGE'             // bridge tokens between EVM chains (via LI.FI)
  | 'EVM_SWAP'               // same-chain token swap on EVM (via Uniswap V3 / LI.FI)
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
  }>;
  hlTotalShortUsd: number;        // total SHORT USD across ALL hedged coins on HL
  hlTotalPnl: number;

  // Polymarket
  polyDeployedUsd: number;        // total USDC in Polymarket positions
  polyHeadroomUsd: number;        // how much more USDC we can deploy
  polyPositionCount: number;
  polyUsdcBalance: number;        // USDC available on Polygon

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
  orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean; whirlpoolAddress?: string }>;

  // EVM Flash Arb state
  evmArbProfit24h: number;        // confirmed flash arb profit last 24h (in-memory)
  evmArbPoolCount: number;        // number of candidate pools currently tracked
  evmArbUsdcBalance: number;      // native USDC on Arbitrum (in EVM wallet)

  // Krystal EVM LP state
  evmLpPositions: Array<{
    posId: string;
    chainName: string;
    chainNumericId: number;
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
    nativeBalance: number;
    nativeSymbol: string;
    nativeValueUsd: number;
  }>;
  evmTotalUsdcAllChains: number;   // sum of USDC across all EVM chains
  evmTotalNativeAllChains: number; // sum of native token USD value across all chains
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
  const maxCooldownMs = 6 * 3600_000; // longest cooldown is 6h (stake)
  const now = Date.now();
  for (const [type, ts] of Object.entries(saved)) {
    if (typeof ts === 'number' && now - ts < maxCooldownMs) {
      lastDecisionAt[type] = ts;
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

  // Prices from Pyth
  let solPriceUsd = 0;
  try {
    const pyth = await import('./pythOracleService.ts');
    solPriceUsd = await pyth.getSolPrice();
  } catch { solPriceUsd = 85; /* fallback */ }

  // SOL balance from Jupiter service
  let solBalance = 0;
  let solanaUsdcBalance = 0;
  try {
    const jupiter = await import('./jupiterService.ts');
    solBalance = await jupiter.getTokenBalance(jupiter.MINTS.SOL);
    solanaUsdcBalance = await jupiter.getTokenBalance(jupiter.MINTS.USDC);
  } catch { /* 0 */ }

  // Jito position
  let jitoSolBalance = 0;
  let jitoSolValueUsd = 0;
  if (env.jitoEnabled) {
    try {
      const jito = await import('./jitoStakingService.ts');
      const pos = await jito.getStakePosition(solPriceUsd);
      jitoSolBalance = pos.jitoSolBalance;
      jitoSolValueUsd = pos.jitoSolValueUsd;
    } catch { /* 0 */ }
  }

  // Multi-LST wallet balances (mSOL, bSOL — JitoSOL covered above)
  const lstBalances: Record<string, { balance: number; valueUsd: number }> = {
    JitoSOL: { balance: jitoSolBalance, valueUsd: jitoSolValueUsd },
  };
  if (env.kaminoEnabled && (env.kaminoLstLoopEnabled || env.kaminoMultiplyVaultEnabled)) {
    try {
      const jupiter = await import('./jupiterService.ts');
      const kamino = await import('./kaminoService.ts');
      // Dynamic: fetch all LSTs from the reserve registry
      const lstReserves = await kamino.getLstAssets();
      for (const r of lstReserves) {
        if (r.symbol === 'JitoSOL') continue; // already fetched via jitoStakingService
        const balance = await jupiter.getTokenBalance(r.mint);
        // LSTs are roughly 1:1 with SOL (with a small premium from staking rewards)
        const valueUsd = balance * solPriceUsd * 1.02; // ~2% staking premium
        lstBalances[r.symbol] = { balance, valueUsd };
      }
    } catch { /* non-fatal */ }
  }

  // Hyperliquid state
  let hlEquity = 0;
  let hlAvailableMargin = 0;
  let hlTotalPnl = 0;
  let hlPositions: PortfolioState['hlPositions'] = [];
  if (env.hyperliquidEnabled) {
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
      }));
    } catch { /* 0 */ }
  }

  // Polymarket state
  let polyDeployedUsd = 0;
  let polyUsdcBalance = 0;
  let polyPositionCount = 0;
  if (env.polymarketEnabled) {
    try {
      const polyMod = await import('./polymarketService.ts');
      const evmMod = await import('./evmWalletService.ts');
      const positions = await polyMod.fetchPositions();
      polyPositionCount = positions.length;
      polyDeployedUsd = positions.reduce((s: number, p: any) => s + (p.currentValueUsd ?? 0), 0);
      polyUsdcBalance = await evmMod.getUSDCBalance();
    } catch (err) {
      logger.warn('[CFO] Polymarket state fetch failed:', err);
    }
  }
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

  // Kamino state
  let kaminoDepositValueUsd = 0, kaminoBorrowValueUsd = 0, kaminoNetValueUsd = 0;
  let kaminoLtv = 0, kaminoHealthFactor = 999, kaminoBorrowApy = 0.12, kaminoSupplyApy = 0.08;
  let kaminoSolBorrowApy = 0.10, kaminoJitoSupplyApy = 0.07, kaminoUsdcSupplyApy = 0.08;
  let kaminoBorrowableUsd = 0, kaminoJitoLoopActive = false, kaminoJitoLoopApy = 0;
  let kaminoActiveLstLoop: string | null = null;
  if (env.kaminoEnabled) {
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

      // USDC borrowable headroom for simple collateral loop
      const maxBorrowLtv = (env.kaminoBorrowMaxLtvPct ?? 60) / 100;
      kaminoBorrowableUsd = Math.max(0, Math.min(
        kaminoDepositValueUsd * maxBorrowLtv - kaminoBorrowValueUsd,
        env.maxKaminoBorrowUsd - kaminoBorrowValueUsd,
      ));

      // Detect JitoSOL loop: has JitoSOL deposits AND SOL borrows simultaneously
      const hasJitoDeposit = pos.deposits.some(d => d.asset === 'JitoSOL');
      const hasSolBorrow   = pos.borrows.some(b => b.asset === 'SOL');
      kaminoJitoLoopActive = hasJitoDeposit && hasSolBorrow;

      if (kaminoJitoLoopActive) {
        const jitoDepositUsd = pos.deposits.filter(d => d.asset === 'JitoSOL').reduce((s, d) => s + d.valueUsd, 0);
        const leverage = kaminoNetValueUsd > 0 ? jitoDepositUsd / kaminoNetValueUsd : 1;
        kaminoJitoLoopApy = leverage * kaminoJitoSupplyApy - (leverage - 1) * kaminoSolBorrowApy;
      }

      // Detect ANY active LST loop (any LST deposit + SOL borrow)
      for (const dep of pos.deposits) {
        const lstInfo = await kamino.getReserve(dep.asset);
        if (lstInfo?.isLst && hasSolBorrow) {
          kaminoActiveLstLoop = dep.asset;
          break;
        }
      }
    } catch { /* non-fatal */ }
  }

  // Kamino Multiply vault data
  let kaminoMultiplyVaults: PortfolioState['kaminoMultiplyVaults'] = [];
  if (env.kaminoEnabled && env.kaminoMultiplyVaultEnabled) {
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

  // Orca LP state
  let orcaLpValueUsd = 0, orcaLpFeeApy = 0;
  let orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean; whirlpoolAddress?: string }> = [];
  if (env.orcaLpEnabled) {
    try {
      const orca = await import('./orcaService.ts');
      const positions = await orca.getPositions();
      orcaLpValueUsd = positions.reduce((s, p) => s + p.liquidityUsd, 0);
      orcaPositions = positions.map(p => ({
        positionMint: p.positionMint,
        rangeUtilisationPct: p.rangeUtilisationPct,
        inRange: p.inRange,
        whirlpoolAddress: p.whirlpoolAddress,
      }));
      // Orca 0.3% fee pool at full utilisation ≈ 20-40% APY depending on volume
      // Conservative estimate: 15% if in-range, 0% if out-of-range
      const inRangePositions = positions.filter(p => p.inRange).length;
      orcaLpFeeApy = positions.length > 0 ? (inRangePositions / positions.length) * 0.15 : 0;
    } catch { /* 0 */ }
  }

  // ── EVM Arb state ─────────────────────────────────────────────────────────
  let evmArbProfit24h = 0, evmArbPoolCount = 0, evmArbUsdcBalance = 0;
  if (env.evmArbEnabled) {
    try {
      const arbMod = await import('./evmArbService.ts');
      evmArbProfit24h    = arbMod.getProfit24h();
      evmArbPoolCount    = arbMod.getCandidatePoolCount();
      evmArbUsdcBalance  = await arbMod.getArbUsdcBalance();
    } catch { /* 0 */ }
  }

  // ── Krystal EVM LP state ─────────────────────────────────────────────────
  let evmLpPositions: PortfolioState['evmLpPositions'] = [];
  let evmLpTotalValueUsd = 0, evmLpTotalFeesUsd = 0;
  if (env.krystalLpEnabled) {
    try {
      const krystal = await import('./krystalService.ts');
      const walletAddr = env.evmPrivateKey
        ? (await import('ethers' as string)).computeAddress(env.evmPrivateKey)
        : undefined;
      if (walletAddr) {
        // Pass DB records for openedAt enrichment (hydrated from kv_store by CFO agent)
        const dbRecords = (globalThis as any).__cfo_evm_lp_records as import('./krystalService.ts').EvmLpRecord[] | undefined;
        const positions = await krystal.fetchKrystalPositions(walletAddr, dbRecords);
        evmLpPositions = positions.map(p => ({
          posId: p.posId,
          chainName: p.chainName,
          chainNumericId: p.chainNumericId,
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
        evmLpTotalFeesUsd = evmLpPositions.reduce((s, p) => s + p.feesOwedUsd, 0);
      }
    } catch { /* 0 */ }
  }

  // ── Multi-chain EVM balance scan ──────────────────────────────────────────
  let evmChainBalances: PortfolioState['evmChainBalances'] = [];
  let evmTotalUsdcAllChains = 0, evmTotalNativeAllChains = 0;
  if (env.krystalLpEnabled || env.lifiEnabled) {
    try {
      const krystal = await import('./krystalService.ts');
      const balances = await krystal.getMultiChainEvmBalances();
      evmChainBalances = balances;
      evmTotalUsdcAllChains = balances.reduce((s, b) => s + b.usdcBalance, 0);
      evmTotalNativeAllChains = balances.reduce((s, b) => s + b.nativeValueUsd, 0);
    } catch { /* 0 */ }
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

  const analystPrice = intel.analystPrices?.[tokenSymbol];
  if (!analystPrice) return learnedBase;

  const absChange = Math.abs(analystPrice.change24h ?? 0);

  if (absChange > 15) return Math.min(learnedBase * 2.0, 60);  // very volatile: ±30% max
  if (absChange > 10) return Math.min(learnedBase * 1.5, 40);  // volatile: ±20%
  if (absChange > 5)  return learnedBase;                       // normal: use configured width
  if (absChange > 2)  return Math.max(learnedBase * 0.75, 10); // calm: tighten to ±7.5%
  return Math.max(learnedBase * 0.5, 8);                        // very calm: ±5-6% for max fees
}

/**
 * Compute adaptive LP range width in ticks for EVM concentrated LP.
 * Mirrors adaptiveLpRangeWidthPct() but returns tick-based width (e.g. 400 = ±200 ticks).
 * Wider in volatile conditions, narrower when calm.
 */
function adaptiveLpRangeWidthTicks(
  tokenSymbol: string,
  intel: SwarmIntel,
  baseWidthTicks: number,
  learned?: AdaptiveParams,
): number {
  // Apply learned LP range multiplier
  const learnedBase = learned
    ? applyAdaptive(baseWidthTicks, learned.lpRangeWidthMultiplier, learned.confidenceLevel)
    : baseWidthTicks;

  const STALE_MS = 6 * 3600_000;
  if (!intel.analystPricesAt || Date.now() - intel.analystPricesAt > STALE_MS) {
    return learnedBase;
  }

  const analystPrice = intel.analystPrices?.[tokenSymbol];
  if (!analystPrice) return learnedBase;

  const absChange = Math.abs(analystPrice.change24h ?? 0);

  if (absChange > 15) return Math.min(learnedBase * 2.0, 2000); // very volatile
  if (absChange > 10) return Math.min(learnedBase * 1.5, 1200);  // volatile
  if (absChange > 5)  return learnedBase;                        // normal
  if (absChange > 2)  return Math.max(learnedBase * 0.75, 200); // calm
  return Math.max(learnedBase * 0.5, 150);                        // very calm
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
async function selectBestOrcaPairDynamic(intel: SwarmIntel): Promise<{
  pair: string;
  whirlpoolAddress: string;
  tokenA: string;
  tokenB: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  score: number;
  reasoning: string;
  apyBase7d: number;
  tvlUsd: number;
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

  // ── Intel-adjusted parameters ─────────────────────────────────────
  // In bearish/danger markets, hedge more aggressively. In bullish, less.
  const adjustedHedgeTarget = Math.min(1.0, config.hedgeTargetRatio * intel.riskMultiplier);
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
      if (coinHedgeRatio < adjustedHedgeTarget - config.hedgeRebalanceThreshold) {
        const hedgeNeeded = coinTargetHedgeUsd - coinShortUsd;
        let capped = Math.min(hedgeNeeded, env.maxHyperliquidUsd - state.hlTotalShortUsd);

        // Gate: need enough HL margin to open the position (size / leverage)
        // If full hedge doesn't fit, scale down to what margin supports (instead of skipping)
        const leverage = Math.min(2, env.maxHyperliquidLeverage);
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
            params: { coin: asset.symbol, exposureUsd: capped, leverage: Math.min(2, env.maxHyperliquidLeverage) },
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
      if (coinHedgeRatio > adjustedHedgeTarget + config.hedgeRebalanceThreshold) {
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
  if (config.autoPolymarket && env.polymarketEnabled && state.polyHeadroomUsd >= 2) {
    if (checkCooldown('POLY_BET', config.polyBetCooldownMs)) {
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
          // Apply learned bet-size multiplier (smaller if poor calibration)
          const learnedBetUsd = opp.recommendedUsd * applyAdaptive(1.0, learned.polyBetSizeMultiplier, conf);
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
      if (spreadPct >= (env.kaminoBorrowMinSpreadPct ?? 3)) {
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
            estimatedImpactUsd: borrowUsd * (spreadPct / 100),
            intelUsed: intel.scoutBullish !== undefined ? ['scout'] : [],
            tier: classifyTier('KAMINO_BORROW_DEPLOY', 'low', borrowUsd * (spreadPct / 100), config, intel.marketCondition),
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
      if (spreadDiag < (env.kaminoBorrowMinSpreadPct ?? 3)) {
        logger.debug(
          `[CFO:Decision] Section F skip: spread=${spreadDiag.toFixed(1)}% (supply=${(deployYieldDiag * 100).toFixed(1)}% - borrow=${(borrowCostDiag * 100).toFixed(1)}%) — need ≥${env.kaminoBorrowMinSpreadPct ?? 3}%`
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
        const targetLtv = (env.kaminoJitoLoopTargetLtv ?? 65) / 100;
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
        const targetLtv = (env.kaminoJitoLoopTargetLtv ?? 65) / 100;
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

      const targetLtv = (env.kaminoJitoLoopTargetLtv ?? 65) / 100;
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
        const repayUsd = Math.max(0, state.kaminoBorrowValueUsd - state.kaminoDepositValueUsd * targetLtv);
        if (repayUsd > 0) {
          decisions.push({
            type: 'KAMINO_REPAY',
            reasoning:
              `Kamino LTV ${(state.kaminoLtv * 100).toFixed(1)}% (health: ${state.kaminoHealthFactor.toFixed(2)}) — ` +
              `repaying $${repayUsd.toFixed(0)} USDC to bring LTV to ${targetLtv * 100}%`,
            params: { repayUsd, repayAsset: 'USDC' },
            urgency,
            estimatedImpactUsd: repayUsd,
            intelUsed: [],
            tier: urgency === 'critical' ? 'AUTO' : 'NOTIFY',
          });
        }
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
  if (env.orcaLpEnabled && intel.marketCondition !== 'bearish' && intel.marketCondition !== 'danger') {
    const orcaHeadroomUsd = Math.max(0, env.orcaLpMaxUsd - state.orcaLpValueUsd);

    // I1: Open new position if we have capital and no active LP
    if (
      orcaHeadroomUsd >= 20 &&
      state.orcaPositions.length === 0 &&
      checkCooldown('ORCA_LP_OPEN', 2 * 3600_000)
    ) {
      // Dynamic pool selection — discovers and scores 50+ Orca pools from DeFiLlama + Orca API
      const bestPair = await selectBestOrcaPairDynamic(intel);
      // Reserve SOL for gas + token launches — never touch this for LP
      const reserveSol = Math.max(config.stakeReserveSol, 0.3);
      const solForLp = Math.max(0, state.solBalance - reserveSol);
      const solAvailableUsd = solForLp * state.solPriceUsd;

      if (solAvailableUsd < 10) {
        logger.debug(`[CFO:Decision] ORCA_LP_OPEN skipped — insufficient SOL after reserve ($${solAvailableUsd.toFixed(2)} available, ${reserveSol} SOL reserved for launches)`);
      } else {
        // Available capital: wallet SOL minus reserve (can be swapped to either side) + existing USDC
        const solCapitalUsd = solAvailableUsd * 0.8; // keep 20% buffer on top of reserve
        const usdcCapitalUsd = state.solanaUsdcBalance;
        const totalCapitalUsd = solCapitalUsd + usdcCapitalUsd;

        // Build both LP sides from base capital. If tokenA isn't SOL, swap SOL→tokenA.
        const deployUsd = Math.min(orcaHeadroomUsd, totalCapitalUsd);
        if (deployUsd >= 20) {
          const usdcSide = deployUsd / 2;
          const tokenASideUsd = deployUsd / 2;

          const tokenAPriceUsd =
            bestPair.tokenA === 'SOL'
              ? state.solPriceUsd
              : (intel.analystPrices?.[bestPair.tokenA]?.usd ?? 1);
          const tokenAAmount = tokenASideUsd / Math.max(tokenAPriceUsd, 1e-9);
          const solSide = bestPair.tokenA === 'SOL' ? tokenAAmount : 0;

          // USDC side funding: use wallet USDC first, then SOL→USDC for shortfall.
          const usdcShortfall = Math.max(0, usdcSide - state.solanaUsdcBalance);
          const needsSwapForUsdc = usdcShortfall > 1;
          const solToSwapForUsdc = needsSwapForUsdc ? usdcShortfall / state.solPriceUsd : 0;

          // tokenA side funding: if tokenA is not SOL, swap SOL→tokenA for full A-side.
          const needsSwapForTokenA = bestPair.tokenA !== 'SOL' && tokenAAmount > 0;
          const solToSwapForTokenA = needsSwapForTokenA ? tokenASideUsd / state.solPriceUsd : 0;
          const totalSolToSwap = solToSwapForUsdc + solToSwapForTokenA;

          const adaptiveRange = adaptiveLpRangeWidthPct(
            bestPair.tokenA,
            intel,
            env.orcaLpRangeWidthPct,
            learned,
          );
          const baseTokenChange = Math.abs(intel.analystPrices?.[bestPair.tokenA]?.change24h ?? 0);

          const estApyStr = bestPair.apyBase7d > 0
            ? `${bestPair.apyBase7d.toFixed(0)}% 7d-avg fee APY`
            : '~15-25% est. fee APY';

          decisions.push({
            type: 'ORCA_LP_OPEN',
            reasoning:
              `Opening Orca ${bestPair.pair} concentrated LP: $${deployUsd.toFixed(0)} total ` +
              `(range ±${adaptiveRange / 2}% — adaptive based on ${baseTokenChange.toFixed(0)}% 24h vol). ` +
              (needsSwapForUsdc
                ? `Auto-swap ${solToSwapForUsdc.toFixed(3)} SOL → $${usdcShortfall.toFixed(0)} USDC. `
                : '') +
              (needsSwapForTokenA
                ? `Auto-swap ${solToSwapForTokenA.toFixed(3)} SOL → ${bestPair.tokenA} for LP A-side. `
                : '') +
              `Pool score: ${bestPair.score}/100 — ${bestPair.reasoning}. ` +
              (bestPair.tvlUsd > 0 ? `TVL: $${(bestPair.tvlUsd / 1e6).toFixed(1)}M. ` : '') +
              `${estApyStr} while in-range.`,
            params: {
              pair: bestPair.pair,
              whirlpoolAddress: bestPair.whirlpoolAddress,
              tokenA: bestPair.tokenA,
              tokenB: bestPair.tokenB,
              tokenAMint: bestPair.tokenAMint,
              tokenBMint: bestPair.tokenBMint,
              tokenADecimals: bestPair.tokenADecimals,
              tokenBDecimals: bestPair.tokenBDecimals,
              tickSpacing: bestPair.tickSpacing,
              usdcAmount: usdcSide,
              solAmount: solSide,
              tokenAAmount,
              rangeWidthPct: adaptiveRange,
              needsSwap: needsSwapForUsdc || needsSwapForTokenA,
              needsSwapForUsdc,
              needsSwapForTokenA,
              solToSwapForUsdc,
              solToSwapForTokenA,
              totalSolToSwap,
            },
            urgency: 'low',
            estimatedImpactUsd: deployUsd * 0.18,
            intelUsed: [
              intel.guardianSnapshotAt ? 'guardian' : '',
              intel.analystPricesAt ? 'analyst' : '',
              intel.scoutReceivedAt ? 'scout' : '',
            ].filter(Boolean),
            tier: classifyTier('ORCA_LP_OPEN', 'low', deployUsd * 0.18, config, intel.marketCondition),
          });
        }
      }
    }

    // I2: Rebalance out-of-range or near-edge positions
    for (const pos of state.orcaPositions) {
      if (!pos.inRange || pos.rangeUtilisationPct < env.orcaLpRebalanceTriggerPct) {
        // Look up pool info from discovery cache for adaptive range calculation
        const poolInfo = pos.whirlpoolAddress
          ? await getPoolByAddress(pos.whirlpoolAddress).catch(() => null)
          : null;
        const tokenASymbol = poolInfo?.tokenA.symbol ?? 'SOL';

        decisions.push({
          type: 'ORCA_LP_REBALANCE',
          reasoning:
            `Orca LP ${pos.positionMint.slice(0, 8)} ${pos.inRange ? 'near range edge' : 'OUT OF RANGE'} ` +
            `(utilisation: ${pos.rangeUtilisationPct.toFixed(0)}%). Closing and reopening centred on current price.`,
          params: {
            positionMint: pos.positionMint,
            whirlpoolAddress: pos.whirlpoolAddress,
            rangeWidthPct: adaptiveLpRangeWidthPct(
              tokenASymbol,
              intel,
              env.orcaLpRangeWidthPct,
              learned,
            ),
          },
          urgency: pos.inRange ? 'low' : 'medium',
          estimatedImpactUsd: 0,
          intelUsed: [],
          tier: 'NOTIFY',
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
    for (const pos of state.evmLpPositions) {
      if (
        (!pos.inRange || pos.rangeUtilisationPct < env.krystalLpRebalanceTriggerPct) &&
        checkCooldown(`KRYSTAL_LP_REBALANCE_${pos.posId}`, 6 * 3600_000) // 6h per-position cooldown
      ) {
        decisions.push({
          type: 'KRYSTAL_LP_REBALANCE',
          reasoning:
            `EVM LP ${pos.posId.slice(0, 8)} (${pos.token0Symbol}/${pos.token1Symbol}, ${pos.chainName}) ` +
            `${pos.inRange ? 'near range edge' : 'OUT OF RANGE'} ` +
            `(utilisation: ${pos.rangeUtilisationPct.toFixed(0)}%). Closing and reopening centred.`,
          params: {
            posId: pos.posId,
            chainNumericId: pos.chainNumericId,
            chainName: pos.chainName,
            token0Symbol: pos.token0Symbol,
            token1Symbol: pos.token1Symbol,
            token0Address: pos.token0Address,
            token1Address: pos.token1Address,
            token0Decimals: pos.token0Decimals,
            token1Decimals: pos.token1Decimals,
            closeOnly: false,
            rangeWidthTicks: adaptiveLpRangeWidthTicks(
              pos.token0Symbol,
              intel,
              env.krystalLpRangeWidthTicks,
              learned,
            ),
          },
          urgency: pos.inRange ? 'low' : 'medium',
          estimatedImpactUsd: pos.valueUsd * 0.02, // rebalance cost ~2%
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    }

    // I-bis.2: Open new EVM LP position if we have headroom
    const evmLpHeadroomUsd = Math.max(0, env.krystalLpMaxUsd - state.evmLpTotalValueUsd);
    // Cap deploy to 80% of available EVM USDC across all chains
    const evmUsdcCap = state.evmTotalUsdcAllChains * 0.8;
    if (
      evmLpHeadroomUsd >= 20 &&
      state.evmTotalUsdcAllChains >= 20 &&
      state.evmLpPositions.length < env.krystalLpMaxPositions &&
      intel.marketCondition !== 'bearish' &&
      checkCooldown('KRYSTAL_LP_OPEN', 12 * 3600_000)
    ) {
      try {
        const krystal = await import('./krystalService.ts');
        const pools = await krystal.discoverKrystalPools();

        // Filter to pools meeting env thresholds AND with configured RPC
        // Apply learned APR floor adjustment (raised if past LP positions underperformed)
        const learnedMinApr = env.krystalLpMinApr7d + (learned.lpMinAprAdjustment * learned.confidenceLevel);
        const eligible = pools.filter(p =>
          p.tvlUsd >= env.krystalLpMinTvlUsd &&
          p.apr7d >= learnedMinApr &&
          (env.evmRpcUrls[p.chainNumericId] || p.chainNumericId === 42161),
        );

        // Check: not already in the same pool
        const existingPoolAddrs = new Set(state.evmLpPositions.map(p => {
          // We track by token symbols + chain — find matching pool addresses
          return `${p.chainNumericId}_${p.token0Symbol}_${p.token1Symbol}`;
        }));
        const deduped = eligible.filter(p => {
          const key = `${p.chainNumericId}_${p.token0.symbol}_${p.token1.symbol}`;
          const keyRev = `${p.chainNumericId}_${p.token1.symbol}_${p.token0.symbol}`;
          return !existingPoolAddrs.has(key) && !existingPoolAddrs.has(keyRev);
        });

        if (deduped.length > 0) {
          const best = deduped[0]; // already sorted by score

          // Check: EVM APR must beat best Solana LP APR by 5%
          const bestSolanaApr = state.orcaLpFeeApy ?? 0;
          if (best.apr7d <= bestSolanaApr + 5) {
            krystalSkip(`best EVM APR ${best.apr7d.toFixed(1)}% doesn't beat Solana ${bestSolanaApr.toFixed(1)}% + 5%`);
          } else {
          const deployUsd = Math.min(evmLpHeadroomUsd, env.krystalLpMaxUsd, evmUsdcCap);
          const rangeWidthTicks = adaptiveLpRangeWidthTicks(
            best.token0.symbol,
            intel,
            env.krystalLpRangeWidthTicks,
            learned,
          );

          decisions.push({
            type: 'KRYSTAL_LP_OPEN',
            reasoning:
              `Opening EVM LP: ${best.token0.symbol}/${best.token1.symbol} on ${best.chainName} ` +
              `($${deployUsd.toFixed(0)}). Pool score: ${best.score.toFixed(0)}/100 — ` +
              `APR7d ${best.apr7d.toFixed(1)}%, TVL $${(best.tvlUsd / 1e6).toFixed(1)}M. ` +
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
              chainName: best.chainName,
              pair: `${best.token0.symbol}/${best.token1.symbol}`,
              // Bridge funding: pick the chain with the most USDC (if not same chain)
              bridgeFunding: (() => {
                const bestBal = state.evmChainBalances
                  .filter(b => b.chainId !== best.chainNumericId && b.usdcBalance >= deployUsd * 0.5)
                  .sort((a, b) => b.usdcBalance - a.usdcBalance)[0];
                if (bestBal && env.evmPrivateKey) {
                  // Wallet address will be computed by the executor from env.evmPrivateKey
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
          }
        } else {
          krystalSkip(`no eligible pools (${pools.length} total, 0 pass TVL/APR/RPC/dedup filters)`);
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
  if (!env.evmArbEnabled) {
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
      logger.debug(`[CFO:Decision] Section J: scanning ${poolCount} Arbitrum pools (ETH=$${ethPrice.toFixed(0)})...`);
      const opp      = await arbMod.scanForOpportunity(ethPrice);

      if (opp && opp.netProfitUsd >= (env.evmArbMinProfitUsdc ?? 2)) {
        logger.info(
          `[CFO:Decision] Section J: 💡 ARB FOUND — ${opp.displayPair} net=$${opp.netProfitUsd.toFixed(3)} ` +
          `(min=$${env.evmArbMinProfitUsdc ?? 2})`,
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
          `${opp.displayPair} net=$${opp.netProfitUsd.toFixed(3)} < min=$${env.evmArbMinProfitUsdc ?? 2}`,
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
  if (
    env.kaminoBorrowLpEnabled &&
    env.orcaLpEnabled &&
    env.kaminoBorrowEnabled &&
    intel.marketCondition !== 'bearish' &&
    intel.marketCondition !== 'danger'
  ) {
    const borrowLpSkip = (reason: string) =>
      logger.debug(`[CFO:Decision] Section K skip: ${reason}`);

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
        const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct, learned);

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
    } else if (state.kaminoLtv >= (env.kaminoBorrowLpMaxLtvPct / 100) * 0.90) {
      borrowLpSkip(`LTV ${(state.kaminoLtv * 100).toFixed(1)}% too close to cap ${env.kaminoBorrowLpMaxLtvPct}%`);
    } else if (state.orcaPositions.length > 0) {
      borrowLpSkip('already have an active Orca LP — one at a time');
    } else if (!checkCooldown('KAMINO_BORROW_LP', 24 * 3600_000)) {
      borrowLpSkip('cooldown (24h)');
    } else {
      // Calculate safe borrow amount: X% of remaining headroom, capped by config
      const maxBorrowLtv = (env.kaminoBorrowLpMaxLtvPct) / 100;
      const headroomUsd = Math.max(0,
        state.kaminoDepositValueUsd * maxBorrowLtv - state.kaminoBorrowValueUsd,
      );
      const fractionToUse = (env.kaminoBorrowLpCapacityPct ?? 20) / 100;
      const borrowUsd = Math.min(
        headroomUsd * fractionToUse,       // tiny fraction of capacity
        env.kaminoBorrowLpMaxUsd ?? 200,   // hard USD cap
        env.orcaLpMaxUsd - state.orcaLpValueUsd, // Orca headroom
      );

      // Spread check: estimated LP fee APY vs borrow cost
      // Conservative: use 15% base fee APY estimate for in-range SOL/USDC LP
      const estimatedLpFeeApy = 0.15;
      const borrowCost = state.kaminoBorrowApy > 0 ? state.kaminoBorrowApy : 0.08;
      const spreadPct = (estimatedLpFeeApy - borrowCost) * 100;

      if (borrowUsd < 20) {
        borrowLpSkip(`borrow amount $${borrowUsd.toFixed(0)} too small (need ≥$20)`);
      } else if (spreadPct < (env.kaminoBorrowLpMinSpreadPct ?? 5)) {
        borrowLpSkip(`spread ${spreadPct.toFixed(1)}% < min ${env.kaminoBorrowLpMinSpreadPct ?? 5}% (LP ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow ~${(borrowCost * 100).toFixed(0)}%)`);
      } else {
        const usdcSide = borrowUsd / 2;
        const solSide = borrowUsd / 2 / state.solPriceUsd;
        const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct, learned);

        decisions.push({
          type: 'KAMINO_BORROW_LP',
          reasoning:
            `Borrow $${borrowUsd.toFixed(0)} USDC from Kamino (${(fractionToUse * 100).toFixed(0)}% of headroom) → ` +
            `deploy into SOL/USDC concentrated LP (range ±${adaptiveRange / 2}%). ` +
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

        logger.info(
          `[CFO:Decision] Section K: KAMINO_BORROW_LP — borrow $${borrowUsd.toFixed(0)} → SOL/USDC LP ` +
          `(spread ${spreadPct.toFixed(1)}%, post-LTV ${((state.kaminoLtv + borrowUsd / state.kaminoDepositValueUsd) * 100).toFixed(0)}%)`,
        );
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

  // Log tier breakdown
  const tierCounts = { AUTO: 0, NOTIFY: 0, APPROVAL: 0 };
  for (const d of decisions) tierCounts[d.tier]++;
  if (decisions.length > 0) {
    logger.info(
      `[CFO:Decision] Tier breakdown: 🟢 AUTO=${tierCounts.AUTO} | 🟡 NOTIFY=${tierCounts.NOTIFY} | 🔴 APPROVAL=${tierCounts.APPROVAL}`,
    );
  } else {
    // ── Diagnostic summary: explain why no decisions were generated ────────
    const diag: string[] = [];

    // B: Hedging
    if (!config.autoHedge) diag.push('Hedge:off');
    else if (!env.hyperliquidEnabled) diag.push('Hedge:HL-disabled');
    else {
      const hedgeableCount = state.treasuryExposures.filter(
        e => e.hlListed && e.valueUsd >= config.hedgeMinSolExposureUsd,
      ).length;
      if (hedgeableCount === 0) diag.push('Hedge:no-eligible-assets');
      else if (state.hedgeRatio >= adjustedHedgeTarget - config.hedgeRebalanceThreshold)
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

    // I: Orca LP
    if (env.orcaLpEnabled) {
      if (state.orcaPositions.length > 0) diag.push(`OrcaLP:active(${state.orcaPositions.length})`);
      else if (!checkCooldown('ORCA_LP_OPEN', 2 * 3600_000)) diag.push('OrcaLP:cooldown');
      else diag.push('OrcaLP:conditions?');
    }

    // I-bis: Krystal EVM LP
    if (env.krystalLpEnabled) {
      if (intel.marketCondition === 'danger') diag.push('KrystalLP:danger');
      else if (state.evmTotalUsdcAllChains < 20) diag.push(`KrystalLP:low-usdc($${state.evmTotalUsdcAllChains.toFixed(0)})`);
      else if (state.evmLpPositions.length >= env.krystalLpMaxPositions) diag.push(`KrystalLP:max-pos(${state.evmLpPositions.length})`);
      else if (intel.marketCondition === 'bearish') diag.push('KrystalLP:bearish');
      else if (!checkCooldown('KRYSTAL_LP_OPEN', 12 * 3600_000)) diag.push('KrystalLP:cooldown');
      else if (state.evmLpPositions.length > 0) diag.push(`KrystalLP:active(${state.evmLpPositions.length})`);
      else diag.push('KrystalLP:conditions?');
    }

    // J: Arb
    if (env.evmArbEnabled) diag.push('Arb:no-opportunity');

    logger.info(`[CFO:Decision] Skip reasons: ${diag.join(' | ')}`);
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
        const result = await hl.closePosition(coin, reduceSizeCoin, true); // buy back to reduce short
        if (result.success) markDecision(`CLOSE_HEDGE_${coin}`);
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
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
        const result = await hl.closePosition(pos.coin, sizeInCoin, isBuy);
        if (result.success) markDecision('CLOSE_LOSING');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
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
        const { repayUsd } = decision.params;
        const result = await kamino.repay('USDC', repayUsd);
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

        // Register decimals for this pool so orcaService can read positions correctly
        if (whirlpoolAddress && tokenADecimals != null && tokenBDecimals != null) {
          const orcaSvc = await import('./orcaService.ts');
          orcaSvc.registerPoolDecimals(whirlpoolAddress, tokenADecimals, tokenBDecimals);
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
        return { ...base, executed: true, success: result.success, txId: result.txSignature, error: result.error };
      }

      case 'ORCA_LP_REBALANCE': {
        const orca = await import('./orcaService.ts');
        const { positionMint, whirlpoolAddress, rangeWidthPct } = decision.params;
        const result = await orca.rebalancePosition(positionMint, rangeWidthPct, whirlpoolAddress);
        if (result.success) markDecision('ORCA_LP_OPEN'); // reuses OPEN cooldown
        return { ...base, executed: true, success: result.success, txId: result.txSignature, error: result.error };
      }

      case 'KAMINO_BORROW_LP': {
        // Step 1: Borrow USDC from Kamino
        const kamino = await import('./kaminoService.ts');
        const { borrowUsd, usdcAmount, solAmount, rangeWidthPct } = decision.params;
        const borrowResult = await kamino.borrow('USDC', borrowUsd);
        if (!borrowResult.success) {
          return { ...base, executed: true, success: false, error: `Borrow failed: ${borrowResult.error}` };
        }
        logger.info(`[CFO] KAMINO_BORROW_LP step 1: borrowed $${borrowUsd.toFixed(0)} USDC | tx: ${borrowResult.txSignature}`);

        // Step 2: Swap half of USDC to SOL for the LP's A-side
        const jupMod = await import('./jupiterService.ts');
        const swapResult = await jupMod.swapUsdcToSol(usdcAmount, 100); // 1% slippage for safety
        if (!swapResult.success) {
          // Borrow succeeded but swap failed — repay the USDC to unwind
          logger.warn(`[CFO] KAMINO_BORROW_LP swap failed — repaying borrowed USDC`);
          await kamino.repay('USDC', borrowUsd * 0.995).catch(() => {});
          return { ...base, executed: true, success: false, error: `Swap USDC→SOL failed: ${swapResult.error}` };
        }
        const solReceived = swapResult.outputAmount || solAmount;
        logger.info(`[CFO] KAMINO_BORROW_LP step 2: swapped $${usdcAmount.toFixed(0)} USDC → ${solReceived.toFixed(4)} SOL`);

        // Step 3: Open Orca concentrated LP with both sides
        const orca = await import('./orcaService.ts');
        const lpResult = await orca.openPosition(usdcAmount, solReceived, rangeWidthPct);
        if (!lpResult.success) {
          // Swap succeeded but LP failed — we have SOL + USDC sitting in wallet.
          // Don't auto-repay; admin can decide. Log prominently.
          logger.error(`[CFO] KAMINO_BORROW_LP LP open failed after borrow+swap — manual intervention needed`);
          return { ...base, executed: true, success: false, error: `LP open failed: ${lpResult.error}. Borrowed USDC is in wallet.` };
        }

        markDecision('KAMINO_BORROW_LP');
        logger.info(`[CFO] KAMINO_BORROW_LP step 3: opened Orca LP | tx: ${lpResult.txSignature}`);
        return {
          ...base,
          executed: true,
          success: true,
          txId: lpResult.txSignature,
        };
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

        // If bootstrapping from wallet SOL: stake it first to get JitoSOL, then loop
        if (needsStakeFirst) {
          const jito = await import('./jitoStakingService.ts');
          const stakeResult = await jito.stakeSol(jitoSolToDeposit);
          if (!stakeResult.success) {
            return { ...base, executed: true, success: false, error: `Pre-loop stake failed: ${stakeResult.error}` };
          }
          logger.info(`[CFO] Pre-loop stake: ${jitoSolToDeposit.toFixed(4)} SOL → JitoSOL | tx: ${stakeResult.txSignature}`);
          // Brief wait for stake to settle
          await new Promise(r => setTimeout(r, 3000));
        }

        // Step 1: Deposit initial JitoSOL as collateral
        const depositResult = await kamino.deposit('JitoSOL', jitoSolToDeposit);
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
        if (result.success) markDecision('KRYSTAL_LP_OPEN');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.tokenId ?? result.txHash,  // tokenId for NFPM ops; txHash stored separately below
          txHash: result.txHash,                   // actual on-chain tx hash for records
          error: result.error,
        } as DecisionResult & { txHash?: string };
      }

      case 'KRYSTAL_LP_REBALANCE': {
        const krystal = await import('./krystalService.ts');
        const { posId, chainNumericId, closeOnly, rangeWidthTicks } = decision.params;
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
        const { posId, chainNumericId, chainName } = decision.params;
        const chainId = `${chainName}@${chainNumericId}`;
        const result = await krystal.claimEvmLpFees({ posId, chainId, chainNumericId });
        if (result.success) markDecision(`KRYSTAL_LP_CLAIM_${posId}`);
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txHash,
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

  // ── Market Summary — single human-readable sentence ──
  if (intel) {
    const mood = intel.marketCondition ?? 'neutral';
    const moodIcon = mood === 'bullish' ? '🟢' : mood === 'bearish' ? '🔴' : mood === 'danger' ? '🚨' : '⚪';
    const alerts: string[] = [];
    if (intel.guardianCritical) alerts.push('security alert active');
    else if (intel.guardianAlerts?.length) alerts.push(`${intel.guardianAlerts.length} watch alert${intel.guardianAlerts.length > 1 ? 's' : ''}`);
    if (intel.analystVolumeSpike) alerts.push('volume spike');
    const moverStr = intel.analystMovers?.length
      ? ` · Top mover: ${intel.analystMovers[0].symbol} ${intel.analystMovers[0].change24hPct > 0 ? '+' : ''}${intel.analystMovers[0].change24hPct.toFixed(0)}%`
      : '';
    L.push(`${moodIcon} Market ${mood}${alerts.length ? ` — ${alerts.join(', ')}` : ''}${moverStr}`);
  }

  // ── Portfolio — wallet balances ──
  L.push('');
  L.push(`💰 <b>$${state.totalPortfolioUsd.toFixed(0)}</b> total`);
  const holdings: string[] = [];
  const rawSolUsd = state.solBalance * state.solPriceUsd;
  holdings.push(`${state.solBalance.toFixed(2)} SOL ($${rawSolUsd.toFixed(0)})`);
  if (state.jitoSolBalance > 0.01) holdings.push(`${state.jitoSolBalance.toFixed(2)} JitoSOL ($${state.jitoSolValueUsd.toFixed(0)})`);
  if (state.hlEquity > 1) holdings.push(`$${state.hlEquity.toFixed(0)} on Hyperliquid`);
  if (state.polyDeployedUsd > 1) holdings.push(`$${state.polyDeployedUsd.toFixed(0)} on Polymarket`);
  if (state.orcaLpValueUsd > 1) holdings.push(`$${state.orcaLpValueUsd.toFixed(0)} in Orca LP`);
  if (state.evmLpTotalValueUsd > 1) {
    const feeStr = state.evmLpTotalFeesUsd > 0.01 ? ` (+$${state.evmLpTotalFeesUsd.toFixed(2)} fees)` : '';
    holdings.push(`$${state.evmLpTotalValueUsd.toFixed(0)} in EVM LP${feeStr}`);
  }
  if (state.kaminoDepositValueUsd > 1) holdings.push(`$${state.kaminoDepositValueUsd.toFixed(0)} in Kamino`);
  L.push(`    ${holdings.join(' · ')}`);

  // Per-position EVM LP breakdown (when positions exist)
  if (state.evmLpPositions.length > 0) {
    const chainNames: Record<number, string> = { 1: 'ETH', 10: 'OP', 56: 'BSC', 137: 'Polygon', 8453: 'Base', 42161: 'Arb', 43114: 'Avax', 324: 'zkSync', 534352: 'Scroll', 59144: 'Linea' };
    for (const pos of state.evmLpPositions) {
      const chain = chainNames[pos.chainNumericId] ?? `Chain ${pos.chainNumericId}`;
      const range = pos.inRange ? '🟢' : '🔴';
      const fee = pos.feesOwedUsd > 0.01 ? ` · $${pos.feesOwedUsd.toFixed(2)} fees` : '';
      L.push(`    ${range} ${pos.token0Symbol}/${pos.token1Symbol} on ${chain} — $${pos.valueUsd.toFixed(0)}${fee}`);
    }
  }

  // EVM chain balances summary (when we have USDC staged on EVM chains)
  if (state.evmTotalUsdcAllChains > 1 && state.evmChainBalances.length > 0) {
    const chains = state.evmChainBalances
      .filter(b => b.usdcBalance > 0.5)
      .map(b => `$${b.usdcBalance.toFixed(0)} on ${b.chainName}`);
    if (chains.length > 0) L.push(`    💵 EVM staging: ${chains.join(' · ')}`);
  }

  // EVM arb scanner status line (shows pools being monitored + 24h profit)
  if (state.evmArbPoolCount > 0 || state.evmArbProfit24h > 0) {
    const arbParts: string[] = [];
    arbParts.push(`${state.evmArbPoolCount} pools across 4 venues`);
    if (state.evmArbProfit24h > 0.01) arbParts.push(`+$${state.evmArbProfit24h.toFixed(2)} today`);
    if (state.evmArbUsdcBalance > 1) arbParts.push(`$${state.evmArbUsdcBalance.toFixed(0)} USDC on Arb`);
    L.push(`⚡ <b>Arb Scanner</b> — ${arbParts.join(' · ')}`);
  }

  // Risk line — tells user if portfolio protection is adequate
  const hedgePct = (state.hedgeRatio * 100).toFixed(0);
  if (state.hedgeRatio < 0.1 && state.solExposureUsd > 20) {
    L.push(`⚠️ <b>Unhedged</b> — ${hedgePct}% of $${state.solExposureUsd.toFixed(0)} SOL exposure protected (SOL @ $${state.solPriceUsd.toFixed(0)})`);
  } else if (state.hedgeRatio >= 0.4) {
    L.push(`🛡 ${hedgePct}% hedged · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  } else {
    L.push(`🔸 ${hedgePct}% hedged · SOL @ $${state.solPriceUsd.toFixed(0)}`);
  }

  // ── Actions — what the CFO is doing / recommending ──
  if (results.length === 0) {
    L.push('');
    L.push(`✅ All good — nothing to do right now.`);
  } else {
    L.push('');
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

      // Error detail (only on failure)
      if (r.error && !r.success) L.push(`    ⚠️ ${r.error}`);
      if (r.txId) L.push(`    🔗 ${r.txId}`);
    }
  }

  // ── Learning summary ──
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
    case 'KAMINO_BORROW_LP':
      if (p.blocked) {
        return `⏸ <b>Borrow→LP waiting</b> — ${p.blockReason === 'no_collateral' ? 'needs Jito loop collateral first' : 'blocked'}. Would borrow $${p.borrowUsd?.toFixed(0) ?? '?'} → SOL/USDC LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
      }
      return `<b>Borrow → LP</b> — $${p.borrowUsd?.toFixed(0) ?? '?'} from Kamino → SOL/USDC LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
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
    case 'KRYSTAL_LP_REBALANCE':
      return p.closeOnly
        ? `<b>Close EVM LP</b> — ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}`
        : `<b>Rebalance EVM LP</b> — ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}, re-centering`;
    case 'KRYSTAL_LP_CLAIM_FEES':
      return `<b>Claim EVM LP fees</b> — $${p.feesOwedUsd?.toFixed(2) ?? '?'} from ${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'} on ${p.chainName ?? 'EVM'}`;
    default:
      return `<b>${d.type}</b> — ${d.reasoning.length > 60 ? d.reasoning.slice(0, 57) + '…' : d.reasoning}`;
  }
}

// ============================================================================
// Main entry: run one decision cycle
// ============================================================================

let _cycleRunning = false;

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
    logger.debug('[CFO:Decision] Cycle already in progress — skipping duplicate');
    return {
      state: {} as PortfolioState,
      decisions: [],
      results: [],
      report: '',
      intel: { riskMultiplier: 1.0, marketCondition: 'neutral' },
      traceId: 'skipped',
    };
  }
  _cycleRunning = true;

  try {
    return await _runDecisionCycleInner(pool);
  } finally {
    _cycleRunning = false;
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
  const state = await gatherPortfolioState();
  const rawSolUsd = state.solBalance * state.solPriceUsd;
  logger.info(
    `[CFO:Decision] Portfolio: $${state.totalPortfolioUsd.toFixed(0)} | ` +
    `SOL: ${state.solBalance.toFixed(2)} ($${rawSolUsd.toFixed(0)}) | ` +
    `JitoSOL: ${state.jitoSolBalance.toFixed(2)} ($${state.jitoSolValueUsd.toFixed(0)}) | ` +
    `hedge: ${(state.hedgeRatio * 100).toFixed(0)}% | HL equity: $${state.hlEquity.toFixed(0)}`,
  );
  logger.debug(
    `[CFO:Decision] Strategy state | ` +
    `kaminoDeposits:$${state.kaminoDepositValueUsd.toFixed(0)} borrowable:$${state.kaminoBorrowableUsd.toFixed(0)} health:${state.kaminoHealthFactor === 999 ? 'none' : state.kaminoHealthFactor.toFixed(2)} | ` +
    `jitoSOL:${state.jitoSolBalance.toFixed(4)} idleSOL:${state.idleSolForStaking.toFixed(4)} | ` +
    `orcaPositions:${state.orcaPositions.length} orcaValue:$${state.orcaLpValueUsd.toFixed(0)} | ` +
    `polyUSDC:$${state.polyUsdcBalance.toFixed(0)} polyHeadroom:$${state.polyHeadroomUsd.toFixed(0)} | ` +
    `evmLPs:${state.evmLpPositions.length} evmLPval:$${state.evmLpTotalValueUsd.toFixed(0)} evmUSDC:$${state.evmTotalUsdcAllChains.toFixed(0)}`
  );

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
      intel = await gatherSwarmIntel(pool);
    } catch (err) {
      logger.warn('[CFO:Decision] Swarm intel gathering failed (non-fatal):', err);
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

    const [walletBalances, hlCoins] = await Promise.all([
      jupiter.getWalletTokenBalances(),
      hl.getHLListedCoins(),
    ]);
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
