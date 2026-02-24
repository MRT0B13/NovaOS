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

// ============================================================================
// Types
// ============================================================================

export type DecisionType =
  | 'OPEN_HEDGE'       // SHORT SOL on HL to protect treasury
  | 'CLOSE_HEDGE'      // close or reduce SOL hedge
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
  | 'ORCA_LP_OPEN'           // open a new concentrated LP position
  | 'ORCA_LP_REBALANCE'      // close out-of-range position and reopen centred on new price
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

  // From Analyst (DeFi data)
  analystSolanaTvl?: number;          // Solana ecosystem TVL
  analystVolumeSpike?: boolean;       // significant volume increase?
  analystPriceAlert?: string;         // price movement summary
  analystReceivedAt?: number;

  // Composite score (computed)
  riskMultiplier: number;             // 0.5 (bullish) to 2.0 (danger) — scales hedge aggressiveness
  marketCondition: 'bullish' | 'neutral' | 'bearish' | 'danger';
}

export interface PortfolioState {
  // Solana
  solBalance: number;             // SOL in funding wallet
  solPriceUsd: number;
  solExposureUsd: number;         // solBalance * solPriceUsd
  jitoSolBalance: number;
  jitoSolValueUsd: number;

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
  hlTotalShortUsd: number;        // total SHORT SOL exposure on HL
  hlTotalPnl: number;

  // Polymarket
  polyDeployedUsd: number;        // total USDC in Polymarket positions
  polyHeadroomUsd: number;        // how much more USDC we can deploy
  polyPositionCount: number;
  polyUsdcBalance: number;        // USDC available on Polygon

  // Computed
  totalPortfolioUsd: number;
  hedgeRatio: number;             // hlTotalShortUsd / solExposureUsd (0 = unhedged, 1 = fully hedged)
  idleSolForStaking: number;      // SOL above reserve that could be staked
  timestamp: number;

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

  // Orca concentrated LP state
  orcaLpValueUsd: number;            // total value in Orca LP positions
  orcaLpFeeApy: number;              // estimated fee APY on current LP positions
  orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean }>;
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

function checkCooldown(type: DecisionType, cooldownMs: number): boolean {
  const last = lastDecisionAt[type] ?? 0;
  return Date.now() - last >= cooldownMs;
}

function markDecision(type: DecisionType): void {
  lastDecisionAt[type] = Date.now();
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
    // Read recent messages from swarm agents to CFO (last 2 hours)
    const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
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

  logger.info(
    `[CFO:Intel] Market: ${intel.marketCondition} (risk×${intel.riskMultiplier.toFixed(2)}) | ` +
    `Scout: ${intel.scoutBullish !== undefined ? (intel.scoutBullish ? '🟢 bullish' : '🔴 bearish') : '⚪ no data'} | ` +
    `Guardian: ${intel.guardianCritical ? '🚨 CRITICAL' : (intel.guardianAlerts?.length ? `⚠️ ${intel.guardianAlerts.length} alert(s)` : '✅ clear')} | ` +
    `Analyst: ${intel.analystVolumeSpike ? '📊 volume spike' : (intel.analystPriceAlert ? '📉 price alert' : '📊 normal')}`,
  );

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
  try {
    const jupiter = await import('./jupiterService.ts');
    solBalance = await jupiter.getTokenBalance(jupiter.MINTS.SOL);
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
      polyDeployedUsd = await polyMod.getTotalDeployed();
      polyUsdcBalance = await evmMod.getUSDCBalance();
      polyPositionCount = (await polyMod.fetchPositions()).length;
    } catch { /* 0 */ }
  }
  const polyHeadroomUsd = Math.min(polyUsdcBalance, env.maxPolymarketUsd - polyDeployedUsd);

  const solExposureUsd = solBalance * solPriceUsd;
  const hlTotalShortUsd = hlPositions
    .filter((p) => p.coin === 'SOL' && p.side === 'SHORT')
    .reduce((s, p) => s + p.sizeUsd, 0);

  const totalPortfolioUsd = solExposureUsd + jitoSolValueUsd + hlEquity + polyDeployedUsd;
  const hedgeRatio = solExposureUsd > 0 ? hlTotalShortUsd / solExposureUsd : 0;

  // Idle SOL available for staking (above reserve)
  const reserveNeeded = Number(process.env.CFO_STAKE_RESERVE_SOL ?? 0.5);
  const idleSolForStaking = Math.max(0, solBalance - reserveNeeded);

  // Kamino state
  let kaminoDepositValueUsd = 0, kaminoBorrowValueUsd = 0, kaminoNetValueUsd = 0;
  let kaminoLtv = 0, kaminoHealthFactor = 999, kaminoBorrowApy = 0.12, kaminoSupplyApy = 0.08;
  let kaminoSolBorrowApy = 0.10, kaminoJitoSupplyApy = 0.07, kaminoUsdcSupplyApy = 0.08;
  let kaminoBorrowableUsd = 0, kaminoJitoLoopActive = false, kaminoJitoLoopApy = 0;
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
    } catch { /* non-fatal */ }
  }

  // Orca LP state
  let orcaLpValueUsd = 0, orcaLpFeeApy = 0;
  let orcaPositions: Array<{ positionMint: string; rangeUtilisationPct: number; inRange: boolean }> = [];
  if (env.orcaLpEnabled) {
    try {
      const orca = await import('./orcaService.ts');
      const positions = await orca.getPositions();
      orcaLpValueUsd = positions.reduce((s, p) => s + p.liquidityUsd, 0);
      orcaPositions = positions.map(p => ({
        positionMint: p.positionMint,
        rangeUtilisationPct: p.rangeUtilisationPct,
        inRange: p.inRange,
      }));
      // Orca 0.3% fee pool at full utilisation ≈ 20-40% APY depending on volume
      // Conservative estimate: 15% if in-range, 0% if out-of-range
      const inRangePositions = positions.filter(p => p.inRange).length;
      orcaLpFeeApy = positions.length > 0 ? (inRangePositions / positions.length) * 0.15 : 0;
    } catch { /* 0 */ }
  }

  return {
    solBalance,
    solPriceUsd,
    solExposureUsd,
    jitoSolBalance,
    jitoSolValueUsd,
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
    orcaLpValueUsd,
    orcaLpFeeApy,
    orcaPositions,
  };
}

// ============================================================================
// STEP 2 + 3: Assess risk & decide
// ============================================================================

export async function generateDecisions(
  state: PortfolioState,
  config: DecisionConfig,
  env: CFOEnv,
  intel: SwarmIntel = { riskMultiplier: 1.0, marketCondition: 'neutral' },
): Promise<Decision[]> {
  const decisions: Decision[] = [];

  // ── Intel-adjusted parameters ─────────────────────────────────────
  // In bearish/danger markets, hedge more aggressively. In bullish, less.
  const adjustedHedgeTarget = Math.min(1.0, config.hedgeTargetRatio * intel.riskMultiplier);
  const adjustedStopLoss = config.hlStopLossPct / intel.riskMultiplier; // tighter stops in bad markets

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

  // ── B) Hedging decisions (uses intel-adjusted target) ─────────────
  if (config.autoHedge && env.hyperliquidEnabled) {
    const targetHedgeUsd = state.solExposureUsd * adjustedHedgeTarget;
    const currentHedgeUsd = state.hlTotalShortUsd;
    const drift = Math.abs(state.hedgeRatio - adjustedHedgeTarget);

    // Only hedge if SOL exposure is significant enough
    if (state.solExposureUsd >= config.hedgeMinSolExposureUsd) {

      // Case 1: Under-hedged — need to open/increase SHORT
      if (state.hedgeRatio < adjustedHedgeTarget - config.hedgeRebalanceThreshold) {
        const hedgeNeeded = targetHedgeUsd - currentHedgeUsd;
        const capped = Math.min(hedgeNeeded, env.maxHyperliquidUsd - currentHedgeUsd);

        // Gate: need enough HL margin to open the position (size / leverage)
        const marginRequired = capped / Math.min(2, env.maxHyperliquidLeverage);
        if (state.hlAvailableMargin < marginRequired) {
          logger.debug(`[CFO:Hedge] Skipping OPEN_HEDGE — need $${marginRequired.toFixed(0)} margin but only $${state.hlAvailableMargin.toFixed(0)} available on HL`);
        } else if (capped > 10 && checkCooldown('OPEN_HEDGE', config.hedgeCooldownMs)) {
          const d: Decision = {
            type: 'OPEN_HEDGE',
            reasoning:
              `SOL treasury: $${state.solExposureUsd.toFixed(0)} (${state.solBalance.toFixed(2)} SOL @ $${state.solPriceUsd.toFixed(0)}). ` +
              `Current hedge: $${currentHedgeUsd.toFixed(0)} (${(state.hedgeRatio * 100).toFixed(0)}%). ` +
              `Target: ${(adjustedHedgeTarget * 100).toFixed(0)}%${adjustedHedgeTarget !== config.hedgeTargetRatio ? ` (adjusted from ${(config.hedgeTargetRatio * 100).toFixed(0)}% — market: ${intel.marketCondition})` : ''}. ` +
              `Opening SHORT $${capped.toFixed(0)} SOL-PERP to protect downside.`,
            params: { solExposureUsd: capped, leverage: Math.min(2, env.maxHyperliquidLeverage) },
            urgency: drift > 0.3 ? 'high' : 'medium',
            estimatedImpactUsd: capped,
            intelUsed: intelSources,
            tier: 'AUTO',
          };
          d.tier = classifyTier(d.type, d.urgency, d.estimatedImpactUsd, config, intel.marketCondition);
          decisions.push(d);
        }
      }

      // Case 2: Over-hedged — reduce SHORT (SOL balance dropped or hedge grew)
      if (state.hedgeRatio > adjustedHedgeTarget + config.hedgeRebalanceThreshold) {
        const excessHedgeUsd = currentHedgeUsd - targetHedgeUsd;

        if (excessHedgeUsd > 10 && checkCooldown('CLOSE_HEDGE', config.hedgeCooldownMs)) {
          const d: Decision = {
            type: 'CLOSE_HEDGE',
            reasoning:
              `Over-hedged: $${currentHedgeUsd.toFixed(0)} SHORT vs $${state.solExposureUsd.toFixed(0)} SOL exposure ` +
              `(${(state.hedgeRatio * 100).toFixed(0)}% vs target ${(adjustedHedgeTarget * 100).toFixed(0)}%). ` +
              `Reducing hedge by $${excessHedgeUsd.toFixed(0)} to rebalance.`,
            params: { reduceUsd: excessHedgeUsd },
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
        const opps = await polyMod.scanOpportunities(state.polyHeadroomUsd, scoutCtx);

        // Take top 2 opportunities and create decisions
        for (const opp of opps.slice(0, 2)) {
          const betUsd = Math.min(opp.recommendedUsd, env.maxSingleBetUsd);
          if (betUsd < 2) continue;

          const d: Decision = {
            type: 'POLY_BET',
            reasoning:
              `Polymarket: "${opp.market.question.slice(0, 80)}" — ` +
              `edge: ${(opp.edge * 100).toFixed(1)}% (our: ${(opp.ourProb * 100).toFixed(0)}% vs market: ${(opp.marketProb * 100).toFixed(0)}%) | ` +
              `${opp.rationale}` +
              (intel.scoutBullish !== undefined ? ` | Scout: ${intel.scoutBullish ? 'bullish' : 'bearish'}` : ''),
            params: {
              conditionId: opp.market.conditionId,
              tokenId: opp.targetToken.tokenId,
              side: opp.targetToken.outcome,
              pricePerShare: opp.marketProb,
              sizeUsd: betUsd,
              marketQuestion: opp.market.question,
              kellyFraction: opp.kellyFraction,
              edge: opp.edge,
            },
            urgency: 'low',
            estimatedImpactUsd: betUsd,
            intelUsed: intel.scoutReceivedAt ? ['scout'] : [],
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
        ? Math.max(state.kaminoUsdcSupplyApy, 0.18) // Polymarket expected ~18% if bullish
        : state.kaminoUsdcSupplyApy;

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
            tier: 'APPROVAL',
          });
        }
      }
    }
  }

  // ── G) JitoSOL/SOL Multiply loop ─────────────────────────────────────────
  if (
    env.kaminoEnabled && env.kaminoBorrowEnabled && env.kaminoJitoLoopEnabled &&
    !state.kaminoJitoLoopActive &&
    state.jitoSolBalance >= 0.1 &&          // need JitoSOL to start
    state.kaminoHealthFactor > 2.0 &&       // comfortable position before leveraging
    intel.marketCondition !== 'danger'       // don't lever up during market crises
  ) {
    if (checkCooldown('KAMINO_JITO_LOOP', 24 * 3600_000)) {
      // Only initiate when spread is profitable
      const loopSpread = state.kaminoJitoSupplyApy - state.kaminoSolBorrowApy;
      if (loopSpread > 0.01) { // need at least 1% spread
        const targetLtv = (env.kaminoJitoLoopTargetLtv ?? 65) / 100;
        const leverage = 1 / (1 - targetLtv);
        const estimatedApy = leverage * state.kaminoJitoSupplyApy - (leverage - 1) * state.kaminoSolBorrowApy;
        const jitoSolToCommit = state.jitoSolBalance * 0.9; // leave 10% in wallet as buffer

        decisions.push({
          type: 'KAMINO_JITO_LOOP',
          reasoning:
            `JitoSOL/SOL Multiply: deposit ${jitoSolToCommit.toFixed(3)} JitoSOL + loop to ${(targetLtv * 100).toFixed(0)}% LTV ` +
            `(~${leverage.toFixed(1)}x leverage). ` +
            `JitoSOL supply: ${(state.kaminoJitoSupplyApy * 100).toFixed(1)}%, ` +
            `SOL borrow: ${(state.kaminoSolBorrowApy * 100).toFixed(1)}%, ` +
            `est. loop APY: ${(estimatedApy * 100).toFixed(1)}% ` +
            `(vs ${(state.kaminoJitoSupplyApy * 100).toFixed(1)}% unlevered). ` +
            `Market: ${intel.marketCondition}`,
          params: {
            jitoSolToDeposit: jitoSolToCommit,
            targetLtv,
            maxLoops: env.kaminoJitoLoopMaxLoops ?? 3,
            solPriceUsd: state.solPriceUsd,
            estimatedApy,
          },
          urgency: 'low',
          estimatedImpactUsd: state.jitoSolValueUsd * (estimatedApy - state.kaminoJitoSupplyApy),
          intelUsed: [],
          tier: 'APPROVAL',
        });
      }
    }
  }

  // ── H) Auto-repay / unwind — LTV breached or loop unprofitable ────────────
  if (env.kaminoEnabled) {
    const ltvBreached      = state.kaminoLtv > (env.kaminoBorrowMaxLtvPct / 100);
    const healthDanger     = state.kaminoHealthFactor < 1.5;
    const loopUnprofitable = state.kaminoJitoLoopActive && state.kaminoJitoLoopApy < 0;

    if ((ltvBreached || healthDanger) && state.kaminoBorrowValueUsd > 0) {
      const urgency: Decision['urgency'] = state.kaminoHealthFactor < 1.3 ? 'critical' : 'high';

      if (state.kaminoJitoLoopActive) {
        // JitoSOL loop: correct response is full unwind (can't just repay USDC — borrow is SOL)
        decisions.push({
          type: 'KAMINO_JITO_UNWIND',
          reasoning:
            `JitoSOL loop health degrading — LTV ${(state.kaminoLtv * 100).toFixed(1)}%, ` +
            `health factor ${state.kaminoHealthFactor.toFixed(2)}. Unwinding loop.`,
          params: {},
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
      decisions.push({
        type: 'KAMINO_JITO_UNWIND',
        reasoning:
          `JitoSOL loop unprofitable — current APY ${(state.kaminoJitoLoopApy * 100).toFixed(1)}% ` +
          `(SOL borrow rate exceeds JitoSOL staking yield). Unwinding.`,
        params: {},
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
      checkCooldown('ORCA_LP_OPEN', 24 * 3600_000)
    ) {
      const deployUsd = Math.min(orcaHeadroomUsd, state.polyUsdcBalance * 0.3);
      if (deployUsd >= 20) {
        const solSide = deployUsd / 2 / state.solPriceUsd;
        const usdcSide = deployUsd / 2;
        decisions.push({
          type: 'ORCA_LP_OPEN',
          reasoning:
            `Opening Orca SOL/USDC concentrated LP: $${deployUsd.toFixed(0)} total ` +
            `(${usdcSide.toFixed(0)} USDC + ${solSide.toFixed(3)} SOL) at ±${env.orcaLpRangeWidthPct / 2}% range. ` +
            `Estimated fee APY: ~15-25% while in-range.`,
          params: { usdcAmount: usdcSide, solAmount: solSide, rangeWidthPct: env.orcaLpRangeWidthPct },
          urgency: 'low',
          estimatedImpactUsd: deployUsd * 0.18,
          intelUsed: [],
          tier: 'APPROVAL',
        });
      }
    }

    // I2: Rebalance out-of-range or near-edge positions
    for (const pos of state.orcaPositions) {
      if (!pos.inRange || pos.rangeUtilisationPct < env.orcaLpRebalanceTriggerPct) {
        decisions.push({
          type: 'ORCA_LP_REBALANCE',
          reasoning:
            `Orca LP ${pos.positionMint.slice(0, 8)} ${pos.inRange ? 'near range edge' : 'OUT OF RANGE'} ` +
            `(utilisation: ${pos.rangeUtilisationPct.toFixed(0)}%). Closing and reopening centred on current price.`,
          params: { positionMint: pos.positionMint, rangeWidthPct: env.orcaLpRangeWidthPct },
          urgency: pos.inRange ? 'low' : 'medium',
          estimatedImpactUsd: 0,
          intelUsed: [],
          tier: 'NOTIFY',
        });
      }
    }
  }

  // Sort by urgency: critical > high > medium > low
  const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  decisions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  // Log tier breakdown
  const tierCounts = { AUTO: 0, NOTIFY: 0, APPROVAL: 0 };
  for (const d of decisions) tierCounts[d.tier]++;
  if (decisions.length > 0) {
    logger.info(
      `[CFO:Decision] Tier breakdown: 🟢 AUTO=${tierCounts.AUTO} | 🟡 NOTIFY=${tierCounts.NOTIFY} | 🔴 APPROVAL=${tierCounts.APPROVAL}`,
    );
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

  // Dry run — log but don't execute
  if (env.dryRun) {
    logger.info(
      `[CFO:Decision] DRY RUN — ${decision.type} [${decision.tier}]: ${decision.reasoning}`,
    );
    return { ...base, executed: false, success: true };
  }

  try {
    switch (decision.type) {
      case 'OPEN_HEDGE': {
        const hl = await import('./hyperliquidService.ts');
        const result = await hl.hedgeSolTreasury({
          solExposureUsd: decision.params.solExposureUsd,
          leverage: decision.params.leverage,
        });
        markDecision('OPEN_HEDGE');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.orderId?.toString(),
          error: result.error,
        };
      }

      case 'CLOSE_HEDGE': {
        // Find the SOL SHORT position and reduce it
        const hl = await import('./hyperliquidService.ts');
        const summary = await hl.getAccountSummary();
        const solShort = summary.positions.find(
          (p) => p.coin === 'SOL' && p.side === 'SHORT',
        );
        if (!solShort) {
          return { ...base, executed: false, error: 'No SOL SHORT position found to reduce' };
        }

        const reduceUsd = Math.min(decision.params.reduceUsd, solShort.sizeUsd);
        const reduceSizeCoin = reduceUsd / solShort.markPrice;
        const result = await hl.closePosition('SOL', reduceSizeCoin, true); // buy back to reduce short
        markDecision('CLOSE_HEDGE');
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
        markDecision('CLOSE_LOSING');
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
        markDecision('AUTO_STAKE');
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
        markDecision('UNSTAKE_JITO');
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
        markDecision('POLY_BET');
        const polyBetSuccess = order.status === 'LIVE' || order.status === 'MATCHED';
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
        markDecision('POLY_EXIT');
        const polyExitSuccess = exitOrder.status === 'LIVE' || exitOrder.status === 'MATCHED';
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
          // Re-deposit the borrowed USDC back into Kamino USDC supply (recursive yield — valid strategy)
          const depositResult = await kamino.deposit('USDC', borrowUsd * 0.995); // small buffer for fees
          deploySuccess = depositResult.success;
          deployTxId = depositResult.txSignature;
        } else if (deployTarget === 'polymarket') {
          // Route to Polymarket — the decision engine will pick up USDC headroom on next cycle
          // USDC is now in the wallet ready for Polymarket deployment
          deploySuccess = true;
          deployTxId = borrowResult.txSignature;
          logger.info(`[CFO:KAMINO_BORROW_DEPLOY] $${borrowUsd} USDC borrowed and ready for Polymarket deployment`);
        }

        markDecision('KAMINO_BORROW_DEPLOY');
        return {
          ...base,
          executed: true,
          success: deploySuccess,
          txId: deployTxId,
          error: deploySuccess ? undefined : 'Borrow succeeded but deploy failed — USDC is in wallet, repay manually if needed',
        };
      }

      case 'KAMINO_REPAY': {
        const kamino = await import('./kaminoService.ts');
        const { repayUsd } = decision.params;
        const result = await kamino.repay('USDC', repayUsd);
        markDecision('KAMINO_REPAY');
        return {
          ...base,
          executed: true,
          success: result.success,
          txId: result.txSignature,
          error: result.error,
        };
      }

      case 'ORCA_LP_OPEN': {
        const orca = await import('./orcaService.ts');
        const { usdcAmount, solAmount, rangeWidthPct } = decision.params;
        const result = await orca.openPosition(usdcAmount, solAmount, rangeWidthPct);
        markDecision('ORCA_LP_OPEN');
        return { ...base, executed: true, success: result.success, txId: result.txSignature, error: result.error };
      }

      case 'ORCA_LP_REBALANCE': {
        const orca = await import('./orcaService.ts');
        const { positionMint, rangeWidthPct } = decision.params;
        // Step 1: close existing
        const closeResult = await orca.closePosition(positionMint);
        if (!closeResult.success) {
          return { ...base, executed: true, success: false, error: `Close failed: ${closeResult.error}` };
        }
        // Step 2: reopen centred on current price — use same USD value from close
        const usdcReceived = closeResult.usdcReceived ?? 0;
        const solReceived = closeResult.solReceived ?? 0;
        if (usdcReceived > 0 || solReceived > 0) {
          const openResult = await orca.openPosition(usdcReceived, solReceived, rangeWidthPct);
          markDecision('ORCA_LP_OPEN'); // reuses OPEN cooldown
          return { ...base, executed: true, success: openResult.success, txId: openResult.txSignature, error: openResult.error };
        }
        markDecision('ORCA_LP_OPEN');
        return { ...base, executed: true, success: true, txId: closeResult.txSignature };
      }

      case 'KAMINO_JITO_LOOP': {
        const kamino = await import('./kaminoService.ts');
        const { jitoSolToDeposit, targetLtv, maxLoops, solPriceUsd } = decision.params;

        // Step 1: Deposit initial JitoSOL as collateral
        const depositResult = await kamino.deposit('JitoSOL', jitoSolToDeposit);
        if (!depositResult.success) {
          return { ...base, executed: true, success: false, error: `Initial JitoSOL deposit failed: ${depositResult.error}` };
        }

        // Step 2: Execute the multiply loop
        const loopResult = await kamino.loopJitoSol(targetLtv, maxLoops, solPriceUsd);
        markDecision('KAMINO_JITO_LOOP');
        return {
          ...base,
          executed: true,
          success: loopResult.success,
          txId: loopResult.txSignatures?.[0],
          error: loopResult.error,
        };
      }

      case 'KAMINO_JITO_UNWIND': {
        const kamino = await import('./kaminoService.ts');
        const unwindResult = await kamino.unwindJitoSolLoop();
        markDecision('KAMINO_JITO_UNWIND');
        return {
          ...base,
          executed: true,
          success: unwindResult.success,
          txId: unwindResult.txSignatures?.[0],
          error: unwindResult.error,
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

  // ── Human-readable type names ──
  const typeName: Record<string, string> = {
    OPEN_HEDGE: 'Open Hedge',
    CLOSE_HEDGE: 'Close Hedge',
    REBALANCE_HEDGE: 'Rebalance Hedge',
    AUTO_STAKE: 'Stake SOL',
    UNSTAKE_JITO: 'Unstake JitoSOL',
    POLY_BET: 'Prediction Bet',
    POLY_EXIT: 'Close Prediction',
    KAMINO_BORROW_DEPLOY: 'Kamino Borrow+Deploy',
    KAMINO_REPAY: 'Kamino Repay',
    KAMINO_JITO_LOOP: 'JitoSOL Multiply Loop',
    KAMINO_JITO_UNWIND: 'JitoSOL Loop Unwind',
    ORCA_LP_OPEN: 'Orca LP Open',
    ORCA_LP_REBALANCE: 'Orca LP Rebalance',
    SKIP: 'No Action',
  };

  // ── Header ──
  L.push(`🧠 *CFO Report*${dryRun ? '  _(simulation)_' : ''}`);

  // ── Intel (compact, only if present) ──
  if (intel && (intel.scoutReceivedAt || intel.guardianReceivedAt || intel.analystReceivedAt)) {
    const parts: string[] = [];
    if (intel.scoutReceivedAt) parts.push(`Scout ${intel.scoutBullish ? 'bullish' : 'bearish'}`);
    if (intel.guardianReceivedAt) parts.push(`Guard ${intel.guardianCritical ? 'alert' : 'clear'}`);
    if (intel.analystReceivedAt) parts.push(`Analyst ${intel.analystVolumeSpike ? 'spike' : 'normal'}`);
    L.push(`📡 ${intel.marketCondition} · risk ×${intel.riskMultiplier.toFixed(1)} · ${parts.join(' · ')}`);
  }

  // ── Portfolio ──
  const bal: string[] = [`SOL ${state.solBalance.toFixed(2)} ($${state.solExposureUsd.toFixed(0)})`];
  if (state.jitoSolBalance > 0) bal.push(`JitoSOL $${state.jitoSolValueUsd.toFixed(0)}`);
  if (state.hlEquity > 0) bal.push(`HL $${state.hlEquity.toFixed(0)}`);
  if (state.polyDeployedUsd > 0 || state.polyPositionCount > 0) bal.push(`Poly $${state.polyDeployedUsd.toFixed(0)}`);
  L.push(`💰 *$${state.totalPortfolioUsd.toFixed(0)}* — ${bal.join(' · ')}`);
  L.push(`🛡 Hedge ${(state.hedgeRatio * 100).toFixed(0)}% · SOL @ $${state.solPriceUsd.toFixed(0)}`);

  // ── Decisions ──
  if (results.length === 0) {
    L.push(`\n✅ Portfolio balanced — no actions required.`);
  } else {
    L.push('');
    for (const r of results) {
      const d = r.decision;
      const name = typeName[d.type] ?? d.type;
      const icon = r.pendingApproval ? '⏳' : r.success ? (r.executed ? '✅' : '📋') : '❌';

      const status = r.pendingApproval
        ? 'awaiting approval'
        : r.dryRun ? 'simulated'
          : r.executed ? (r.success ? 'complete' : 'failed') : 'skipped';

      L.push(`${icon} *${name}* — ${status}`);

      // Detail line: amount + short reason
      const reason = _shortReason(d);
      const amt = Math.abs(d.estimatedImpactUsd);
      if (amt > 0) {
        L.push(`     $${amt.toFixed(0)} · ${reason}`);
      } else {
        L.push(`     ${reason}`);
      }

      // Error line (only on failure)
      if (r.error && !r.success) L.push(`     ⚠️ ${r.error}`);
      if (r.txId) L.push(`     🔗 ${r.txId}`);
    }
  }

  return L.join('\n');
}

/** Shorten reasoning to one clean line */
function _shortReason(d: Decision): string {
  const t = d.type;
  const p = d.params ?? {};
  switch (t) {
    case 'OPEN_HEDGE':
      return `Short SOL-PERP → ${p.targetHedgeRatio ? (p.targetHedgeRatio * 100).toFixed(0) + '% hedge' : 'hedge'}`;
    case 'CLOSE_HEDGE':
      return `Reduce hedge exposure`;
    case 'AUTO_STAKE':
      return `${p.amount?.toFixed(2) ?? '?'} SOL → JitoSOL (≈7% APY)`;
    case 'UNSTAKE_JITO':
      return `${p.amount?.toFixed(2) ?? '?'} JitoSOL → SOL`;
    case 'POLY_BET': {
      const q = (p.marketQuestion ?? '').slice(0, 55);
      const edge = p.edge ? `${(p.edge * 100).toFixed(0)}% edge` : '';
      return q ? `${q}${edge ? ` · ${edge}` : ''}` : edge || 'Prediction bet';
    }
    case 'POLY_EXIT':
      return `Exit prediction position`;
    case 'KAMINO_BORROW_DEPLOY': {
      const target = p.deployTarget === 'polymarket' ? 'Polymarket' : 'Kamino supply';
      return `Borrow $${p.borrowUsd?.toFixed(0) ?? '?'} USDC → ${target} (spread ${p.spreadPct?.toFixed(1) ?? '?'}%)`;
    }
    case 'KAMINO_REPAY':
      return `Repay $${p.repayUsd?.toFixed(0) ?? '?'} USDC (LTV management)`;
    case 'KAMINO_JITO_LOOP':
      return `JitoSOL loop ${p.jitoSolToDeposit?.toFixed(2) ?? '?'} JitoSOL → ${((p.targetLtv ?? 0.65) * 100).toFixed(0)}% LTV (est. ${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY)`;
    case 'KAMINO_JITO_UNWIND':
      return `Unwind JitoSOL/SOL multiply loop`;
    case 'ORCA_LP_OPEN':
      return `SOL/USDC LP $${((p.usdcAmount ?? 0) * 2).toFixed(0)} ±${(p.rangeWidthPct ?? 20) / 2}% range`;
    case 'ORCA_LP_REBALANCE':
      return `Rebalance LP ${(p.positionMint ?? '').slice(0, 8)} to current price`;
    default:
      return d.reasoning.length > 80 ? d.reasoning.slice(0, 77) + '…' : d.reasoning;
  }
}

// ============================================================================
// Main entry: run one decision cycle
// ============================================================================

export async function runDecisionCycle(pool?: any): Promise<{
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
  logger.info(
    `[CFO:Decision] Portfolio: $${state.totalPortfolioUsd.toFixed(0)} | ` +
    `SOL: ${state.solBalance.toFixed(2)} ($${state.solExposureUsd.toFixed(0)}) | ` +
    `hedge: ${(state.hedgeRatio * 100).toFixed(0)}% | HL equity: $${state.hlEquity.toFixed(0)}`,
  );

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

  // 2+3. Assess + Decide (with intel)
  const decisions = await generateDecisions(state, config, env, intel);
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
