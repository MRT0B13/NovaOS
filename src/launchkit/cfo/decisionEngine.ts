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
  | 'KAMINO_LST_LOOP'        // Generic LST/SOL Multiply — best-spread among JitoSOL/mSOL/bSOL
  | 'KAMINO_LST_UNWIND'      // unwind a generic LST loop
  | 'KAMINO_MULTIPLY_VAULT'  // deposit into a Kamino Multiply vault (managed auto-leverage)
  | 'ORCA_LP_OPEN'           // open a new concentrated LP position
  | 'ORCA_LP_REBALANCE'      // close out-of-range position and reopen centred on new price
  | 'KAMINO_BORROW_LP'       // borrow from Kamino → swap → open Orca LP, fees repay loan
  | 'EVM_FLASH_ARB'          // Arbitrum: atomic flash loan arb via Aave v3 + DEX spread
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
      polyDeployedUsd = await polyMod.getTotalDeployed();
      polyUsdcBalance = await evmMod.getUSDCBalance();
      polyPositionCount = (await polyMod.fetchPositions()).length;
    } catch { /* 0 */ }
  }
  const polyHeadroomUsd = Math.min(polyUsdcBalance, env.maxPolymarketUsd - polyDeployedUsd);

  // SOL-correlated exposure = raw SOL + all LSTs (JitoSOL, mSOL, bSOL, etc.)
  const rawSolUsd = solBalance * solPriceUsd;
  const lstTotalUsd = Object.values(lstBalances).reduce((s, v) => s + v.valueUsd, 0);
  const solExposureUsd = rawSolUsd + lstTotalUsd;

  const hlTotalShortUsd = hlPositions
    .filter((p) => p.coin === 'SOL' && p.side === 'SHORT')
    .reduce((s, p) => s + p.sizeUsd, 0);

  // Preliminary total — Kamino & Orca not yet known; patched below after gathering
  // Note: lstTotalUsd already includes jitoSolValueUsd via lstBalances
  let totalPortfolioUsd = solExposureUsd + hlEquity + polyDeployedUsd + polyUsdcBalance;
  const hedgeRatio = solExposureUsd > 0 ? hlTotalShortUsd / solExposureUsd : 0;

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

  // Patch totalPortfolioUsd with Kamino + Orca values gathered above
  totalPortfolioUsd += kaminoNetValueUsd + orcaLpValueUsd;

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
  };
}

// ============================================================================
// STEP 2 + 3: Assess risk & decide
// ============================================================================

// Known Orca Whirlpool addresses for CFO-approved pairs (0.3% fee tier)
// NOTE: Verify addresses against https://orca.so/pools before deploying.
// SOL/USDC is confirmed. Others must be verified against live on-chain data.
const ORCA_WHIRLPOOLS: Record<string, { address: string; tokenA: string; tokenB: string; tokenADecimals: number; minLiquidityUsd: number }> = {
  'SOL/USDC':  { address: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', tokenA: 'SOL',  tokenB: 'USDC', tokenADecimals: 9, minLiquidityUsd: 500_000 },
  'BONK/USDC': { address: 'Fy6SnHPbDxMhVj8j7BNKMiNaVVesCzK8qcFNmRKokFgT', tokenA: 'BONK', tokenB: 'USDC', tokenADecimals: 5, minLiquidityUsd: 100_000 },
  'WIF/USDC':  { address: 'ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq', tokenA: 'WIF',  tokenB: 'USDC', tokenADecimals: 6, minLiquidityUsd: 50_000  },
  'JUP/USDC':  { address: 'BoG9sBfBBsGJBJbUqsFPRrmGCJF5i4kk5mMHPzSnVBa4', tokenA: 'JUP',  tokenB: 'USDC', tokenADecimals: 6, minLiquidityUsd: 50_000  },
};

/**
 * Compute an adaptive LP range width based on 24h price change of the base token.
 * Wider range in volatile conditions (less rebalancing), narrower when calm (more fees).
 * Returns total range width as a percentage (e.g. 20 = ±10%).
 */
function adaptiveLpRangeWidthPct(
  tokenSymbol: string,
  intel: SwarmIntel,
  baseWidthPct: number,
): number {
  const analystPrice = intel.analystPrices?.[tokenSymbol];
  if (!analystPrice) return baseWidthPct;

  const absChange = Math.abs(analystPrice.change24h ?? 0);

  if (absChange > 15) return Math.min(baseWidthPct * 2.0, 60);  // very volatile: ±30% max
  if (absChange > 10) return Math.min(baseWidthPct * 1.5, 40);  // volatile: ±20%
  if (absChange > 5)  return baseWidthPct;                       // normal: use configured width
  if (absChange > 2)  return Math.max(baseWidthPct * 0.75, 10); // calm: tighten to ±7.5%
  return Math.max(baseWidthPct * 0.5, 8);                        // very calm: ±5-6% for max fees
}

/**
 * Select the best Orca LP pair given current swarm intel.
 * Scoring: 40% volume momentum, 30% price trend, 20% liquidity depth, 10% rug safety
 */
function selectBestOrcaPair(intel: SwarmIntel): {
  pair: string;
  whirlpool: typeof ORCA_WHIRLPOOLS[string];
  score: number;
  reasoning: string;
} {
  const defaultPair = {
    pair: 'SOL/USDC',
    whirlpool: ORCA_WHIRLPOOLS['SOL/USDC'],
    score: 50,
    reasoning: 'Default SOL/USDC — no enriched intel available',
  };

  if (!intel.guardianTokens?.length && !intel.analystPrices) {
    return defaultPair;
  }

  const candidates: Array<{ pair: string; score: number; reasoning: string[] }> = [];

  for (const [pairName, pool] of Object.entries(ORCA_WHIRLPOOLS)) {
    const tokenSymbol = pool.tokenA;
    let score = 0;
    const reasons: string[] = [];

    // ── Volume score (from Guardian watchlist) ──
    const guardianToken = intel.guardianTokens?.find(t => t.ticker === tokenSymbol);
    if (guardianToken) {
      if (guardianToken.volume24h > 1_000_000) { score += 40; reasons.push(`high vol $${(guardianToken.volume24h / 1e6).toFixed(1)}M`); }
      else if (guardianToken.volume24h > 100_000) { score += 20; reasons.push(`vol $${(guardianToken.volume24h / 1e3).toFixed(0)}k`); }
      else if (guardianToken.volume24h > 10_000) { score += 10; }

      // Liquidity depth
      if (guardianToken.liquidityUsd >= pool.minLiquidityUsd) {
        score += 20; reasons.push(`liq $${(guardianToken.liquidityUsd / 1e3).toFixed(0)}k`);
      } else {
        score -= 20;
        reasons.push('low liq');
      }

      // Rug safety
      if (tokenSymbol === 'SOL') {
        score += 10;
      } else if (!guardianToken.safe) {
        score -= 30;
        reasons.push('rug risk');
      } else {
        score += 10; reasons.push('clean');
      }
    }

    // ── Price trend score (from Analyst) ──
    const analystPrice = intel.analystPrices?.[tokenSymbol];
    if (analystPrice) {
      const change = analystPrice.change24h;
      if (change > 10) { score += 30; reasons.push(`+${change.toFixed(0)}% 24h`); }
      else if (change > 5) { score += 20; reasons.push(`+${change.toFixed(0)}% 24h`); }
      else if (change > 0) { score += 10; }
      else if (change < -10) { score -= 15; reasons.push(`${change.toFixed(0)}% 24h`); }
    }

    // ── Trending bonus (from Analyst CoinGecko trending) ──
    if (intel.analystTrending?.includes(tokenSymbol)) {
      score += 15; reasons.push('trending');
    }

    // ── Market condition modifier ──
    if (intel.marketCondition === 'bearish' || intel.marketCondition === 'danger') {
      if (tokenSymbol !== 'SOL') score -= 20;
    }

    candidates.push({ pair: pairName, score, reasoning: reasons });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 30) return defaultPair;

  return {
    pair: best.pair,
    whirlpool: ORCA_WHIRLPOOLS[best.pair],
    score: best.score,
    reasoning: best.reasoning.join(', '),
  };
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
              `SOL exposure: $${state.solExposureUsd.toFixed(0)} (${state.solBalance.toFixed(2)} SOL + ${state.jitoSolBalance.toFixed(2)} JitoSOL + LSTs @ $${state.solPriceUsd.toFixed(0)}). ` +
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
          if (adjustedEdge < 0.03) continue;

          // Cap to actual available balance — kelly reference bankroll is just for sizing math
          const betUsd = Math.min(opp.recommendedUsd, state.polyHeadroomUsd, env.maxSingleBetUsd);
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
      const deployYieldDiag = state.kaminoUsdcSupplyApy;
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
    if (checkCooldown('KAMINO_JITO_LOOP', 24 * 3600_000)) {
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
          tier: 'APPROVAL',
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
    checkCooldown('KAMINO_LST_LOOP', 24 * 3600_000)
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
            tier: 'APPROVAL',
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
          tier: 'APPROVAL',
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
      checkCooldown('ORCA_LP_OPEN', 24 * 3600_000)
    ) {
      const bestPair = selectBestOrcaPair(intel);
      const needsSol = bestPair.whirlpool.tokenA === 'SOL';
      const solAvailableUsd = state.solBalance * state.solPriceUsd;

      // For SOL/USDC: need SOL for the A-side. For token pairs (BONK/WIF/JUP): no SOL required.
      if (needsSol && solAvailableUsd < 10) {
        logger.debug(`[CFO:Decision] ORCA_LP_OPEN skipped — insufficient SOL ($${solAvailableUsd.toFixed(2)} available, need >$10 for SOL/USDC LP)`);
      } else {
        const deployUsd = Math.min(
          orcaHeadroomUsd,
          state.solanaUsdcBalance * 0.4,  // use up to 40% of Solana USDC for LP
          needsSol ? solAvailableUsd * 2 * 0.8 : Infinity, // cap to 80% of available SOL×2 for SOL/USDC
        );
        if (deployUsd >= 20) {
          const usdcSide = deployUsd / 2;
          const solSide = deployUsd / 2 / state.solPriceUsd;
          const tokenAAmount = bestPair.whirlpool.tokenA !== 'SOL'
            ? deployUsd / 2 / (intel.analystPrices?.[bestPair.whirlpool.tokenA]?.usd ?? 1)
            : solSide;

          const adaptiveRange = adaptiveLpRangeWidthPct(
            bestPair.whirlpool.tokenA,
            intel,
            env.orcaLpRangeWidthPct,
          );
          const baseTokenChange = Math.abs(intel.analystPrices?.[bestPair.whirlpool.tokenA]?.change24h ?? 0);

          decisions.push({
            type: 'ORCA_LP_OPEN',
            reasoning:
              `Opening Orca ${bestPair.pair} concentrated LP: $${deployUsd.toFixed(0)} total ` +
              `(range ±${adaptiveRange / 2}% — adaptive based on ${baseTokenChange.toFixed(0)}% 24h vol). ` +
              `Pair selected because: ${bestPair.reasoning}. Est. fee APY: ~15-25% while in-range.`,
            params: {
              pair: bestPair.pair,
              whirlpoolAddress: bestPair.whirlpool.address,
              tokenA: bestPair.whirlpool.tokenA,
              tokenADecimals: bestPair.whirlpool.tokenADecimals,
              usdcAmount: usdcSide,
              solAmount: bestPair.whirlpool.tokenA === 'SOL' ? solSide : 0,
              tokenAAmount,
              rangeWidthPct: adaptiveRange,
            },
            urgency: 'low',
            estimatedImpactUsd: deployUsd * 0.18,
            intelUsed: [
              intel.guardianSnapshotAt ? 'guardian' : '',
              intel.analystPricesAt ? 'analyst' : '',
              intel.scoutReceivedAt ? 'scout' : '',
            ].filter(Boolean),
            tier: 'APPROVAL',
          });
        }
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
          params: {
            positionMint: pos.positionMint,
            whirlpoolAddress: pos.whirlpoolAddress,
            rangeWidthPct: adaptiveLpRangeWidthPct(
              Object.values(ORCA_WHIRLPOOLS).find(w => w.address === pos.whirlpoolAddress)?.tokenA ?? 'SOL',
              intel,
              env.orcaLpRangeWidthPct,
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
          params: { opportunity: opp },
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

    if (!state.kaminoJitoLoopActive && state.kaminoDepositValueUsd < 10) {
      borrowLpSkip('no Kamino collateral — deposit or start Jito loop first');
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
        const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct);

        decisions.push({
          type: 'KAMINO_BORROW_LP',
          reasoning:
            `⏸ BLOCKED — needs Kamino collateral first (Jito loop must run). ` +
            `Full pipeline: deposit ${state.jitoSolBalance.toFixed(3)} JitoSOL ($${simulatedCollateral.toFixed(0)}) → ` +
            `borrow $${borrowUsd.toFixed(0)} USDC (${(fractionToUse * 100).toFixed(0)}% of $${simulatedHeadroom.toFixed(0)} headroom) → ` +
            `SOL/USDC LP (±${adaptiveRange / 2}%). ` +
            `LP yield ~${(estimatedLpFeeApy * 100).toFixed(0)}% vs borrow ~${(borrowCost * 100).toFixed(0)}% = ${spreadPct.toFixed(1)}% spread. ` +
            `Waiting for Section G (Jito loop) to activate first — currently blocked by negative spread.`,
          params: {
            borrowUsd,
            rangeWidthPct: adaptiveRange,
            estimatedLpApy: estimatedLpFeeApy,
            borrowApy: borrowCost,
            spreadPct,
            blocked: true,
            blockReason: 'no_collateral',
            prerequisite: 'KAMINO_JITO_LOOP',
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
        const adaptiveRange = adaptiveLpRangeWidthPct('SOL', intel, env.orcaLpRangeWidthPct);

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
        const { usdcAmount, solAmount, tokenAAmount, rangeWidthPct, whirlpoolAddress, tokenADecimals } = decision.params;
        // Use tokenA amount if available (for non-SOL pairs), otherwise fall back to solAmount
        const amountA = tokenAAmount ?? solAmount;
        const result = await orca.openPosition(usdcAmount, amountA, rangeWidthPct, whirlpoolAddress, tokenADecimals ?? 9);
        markDecision('ORCA_LP_OPEN');
        return { ...base, executed: true, success: result.success, txId: result.txSignature, error: result.error };
      }

      case 'ORCA_LP_REBALANCE': {
        const orca = await import('./orcaService.ts');
        const { positionMint, whirlpoolAddress, rangeWidthPct } = decision.params;
        const result = await orca.rebalancePosition(positionMint, rangeWidthPct, whirlpoolAddress);
        markDecision('ORCA_LP_OPEN'); // reuses OPEN cooldown
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
        const { opportunity } = decision.params;
        const result = await arb.executeFlashArb(opportunity);
        markDecision('EVM_FLASH_ARB');
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
        markDecision('KAMINO_JITO_LOOP');
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
        markDecision('KAMINO_JITO_UNWIND');
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
        markDecision('KAMINO_LST_LOOP');
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
        markDecision('KAMINO_LST_UNWIND');
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
  L.push(`🧠 *CFO Report*${dryRun ? '  _(dry run)_' : ''}`);

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
  L.push(`💰 *$${state.totalPortfolioUsd.toFixed(0)}* total`);
  const holdings: string[] = [];
  const rawSolUsd = state.solBalance * state.solPriceUsd;
  holdings.push(`${state.solBalance.toFixed(2)} SOL ($${rawSolUsd.toFixed(0)})`);
  if (state.jitoSolBalance > 0.01) holdings.push(`${state.jitoSolBalance.toFixed(2)} JitoSOL ($${state.jitoSolValueUsd.toFixed(0)})`);
  if (state.hlEquity > 1) holdings.push(`$${state.hlEquity.toFixed(0)} on Hyperliquid`);
  if (state.polyDeployedUsd > 1) holdings.push(`$${state.polyDeployedUsd.toFixed(0)} on Polymarket`);
  if (state.orcaLpValueUsd > 1) holdings.push(`$${state.orcaLpValueUsd.toFixed(0)} in Orca LP`);
  if (state.kaminoDepositValueUsd > 1) holdings.push(`$${state.kaminoDepositValueUsd.toFixed(0)} in Kamino`);
  L.push(`    ${holdings.join(' · ')}`);

  // Risk line — tells user if portfolio protection is adequate
  const hedgePct = (state.hedgeRatio * 100).toFixed(0);
  if (state.hedgeRatio < 0.1 && state.solExposureUsd > 20) {
    L.push(`⚠️ *Unhedged* — ${hedgePct}% of $${state.solExposureUsd.toFixed(0)} SOL exposure protected (SOL @ $${state.solPriceUsd.toFixed(0)})`);
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

      L.push(`${icon} ${what}${amtStr} — _${tag}_`);

      // Error detail (only on failure)
      if (r.error && !r.success) L.push(`    ⚠️ ${r.error}`);
      if (r.txId) L.push(`    🔗 ${r.txId}`);
    }
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
    case 'OPEN_HEDGE':
      return `*Hedge SOL* — short $${Math.abs(d.estimatedImpactUsd).toFixed(0)} SOL-PERP to protect $${state.solExposureUsd.toFixed(0)} SOL exposure (${state.solBalance.toFixed(1)} SOL + ${state.jitoSolBalance.toFixed(1)} JitoSOL)`;
    case 'CLOSE_HEDGE':
      return `*Reduce hedge* — SOL exposure dropped, closing excess short`;
    case 'REBALANCE_HEDGE':
      return `*Rebalance hedge* — adjusting short size to match current SOL`;
    case 'CLOSE_LOSING':
      return `*Close losing position* — cutting loss before it gets worse`;
    case 'AUTO_STAKE':
      return `*Stake ${p.amount?.toFixed(2) ?? '?'} SOL* → JitoSOL for ~7% APY`;
    case 'UNSTAKE_JITO':
      return `*Unstake ${p.amount?.toFixed(2) ?? '?'} JitoSOL* → SOL (need runway)`;
    case 'POLY_BET': {
      const q = (p.marketQuestion ?? '').slice(0, 50);
      return `*Prediction bet* — ${q || 'placing bet'}`;
    }
    case 'POLY_EXIT':
      return `*Close prediction* — exiting position`;
    case 'KAMINO_BORROW_DEPLOY':
      return `*Borrow & deploy* — $${p.borrowUsd?.toFixed(0) ?? '?'} USDC from Kamino → yield (${p.spreadPct?.toFixed(1) ?? '?'}% spread)`;
    case 'KAMINO_REPAY':
      return `*Repay loan* — $${p.repayUsd?.toFixed(0) ?? '?'} USDC back to Kamino`;
    case 'KAMINO_JITO_LOOP':
      if (p.blocked) {
        const jitoYieldPct = p.estimatedApy != null
          ? ((state.kaminoJitoSupplyApy || 0.08) * 100).toFixed(1)
          : '8.0';
        return `⏸ *Jito Loop waiting* — spread is ${p.currentSpreadPct?.toFixed(1) ?? '?'}% (need >1%). SOL borrow ${(state.kaminoSolBorrowApy * 100).toFixed(1)}% > JitoSOL yield ${jitoYieldPct}%. Break-even at ${((p.breakEvenBorrowRate ?? 0) * 100).toFixed(1)}%`;
      }
      return `*Leverage JitoSOL* — deposit ${p.jitoSolToDeposit?.toFixed(2) ?? '?'} JitoSOL, loop to ${((p.targetLtv ?? 0.65) * 100).toFixed(0)}% LTV for ~${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY`;
    case 'KAMINO_JITO_UNWIND':
      return `*Unwind JitoSOL loop* — closing leveraged position`;
    case 'KAMINO_LST_LOOP': {
      if (p.blocked) {
        const spreads = (p.allCandidates ?? []).map((c: any) => `${c.lst} ${(c.spread * 100).toFixed(1)}%`).join(', ');
        return `⏸ *LST Loop waiting* — best spread is ${p.currentSpreadPct?.toFixed(1) ?? '?'}% (${p.lst ?? '?'}, need >1%). All: ${spreads}`;
      }
      const runners = (p.allCandidates ?? []).filter((c: any) => c.lst !== p.lst).map((c: any) => `${c.lst} ${(c.spread * 100).toFixed(1)}%`).join(', ');
      return `*Leverage ${p.lst ?? '?'}* — deposit ${p.lstAmount?.toFixed(2) ?? '?'} ${p.lst ?? 'LST'}, loop to ${((p.targetLtv ?? 0.65) * 100).toFixed(0)}% LTV for ~${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY${runners ? ` (vs ${runners})` : ''}`;
    }
    case 'KAMINO_LST_UNWIND':
      return `*Unwind ${p.lst ?? 'LST'} loop* — closing leveraged ${p.lst ?? 'LST'}/SOL position`;
    case 'KAMINO_MULTIPLY_VAULT':
      return `*Kamino Vault* — deposit ${p.depositAmount?.toFixed(2) ?? '?'} ${p.collateralToken ?? 'LST'} into "${p.vaultName ?? 'Multiply'}" (${((p.estimatedApy ?? 0) * 100).toFixed(1)}% APY, ${p.leverage?.toFixed(1) ?? '?'}x)${p.needsSwap ? ' (swap SOL first)' : ''}`;
    case 'ORCA_LP_OPEN':
      return `*Open LP* — $${((p.usdcAmount ?? 0) * 2).toFixed(0)} in ${p.pair ?? 'SOL/USDC'} (±${(p.rangeWidthPct ?? 20) / 2}% range)`;
    case 'ORCA_LP_REBALANCE':
      return `*Rebalance LP* — price moved out of range, re-centering`;
    case 'KAMINO_BORROW_LP':
      if (p.blocked) {
        return `⏸ *Borrow→LP waiting* — ${p.blockReason === 'no_collateral' ? 'needs Jito loop collateral first' : 'blocked'}. Would borrow $${p.borrowUsd?.toFixed(0) ?? '?'} → SOL/USDC LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
      }
      return `*Borrow → LP* — $${p.borrowUsd?.toFixed(0) ?? '?'} from Kamino → SOL/USDC LP (${p.spreadPct?.toFixed(0) ?? '?'}% spread)`;
    case 'EVM_FLASH_ARB':
      return `*Flash arb* — atomic arb on Arbitrum`;
    default:
      return `*${d.type}* — ${d.reasoning.length > 60 ? d.reasoning.slice(0, 57) + '…' : d.reasoning}`;
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
  logger.info(
    `[CFO:Decision] Portfolio: $${state.totalPortfolioUsd.toFixed(0)} | ` +
    `SOL: ${state.solBalance.toFixed(2)} ($${state.solExposureUsd.toFixed(0)}) | ` +
    `hedge: ${(state.hedgeRatio * 100).toFixed(0)}% | HL equity: $${state.hlEquity.toFixed(0)}`,
  );
  logger.debug(
    `[CFO:Decision] Strategy state | ` +
    `kaminoDeposits:$${state.kaminoDepositValueUsd.toFixed(0)} borrowable:$${state.kaminoBorrowableUsd.toFixed(0)} health:${state.kaminoHealthFactor === 999 ? 'none' : state.kaminoHealthFactor.toFixed(2)} | ` +
    `jitoSOL:${state.jitoSolBalance.toFixed(4)} idleSOL:${state.idleSolForStaking.toFixed(4)} | ` +
    `orcaPositions:${state.orcaPositions.length} orcaValue:$${state.orcaLpValueUsd.toFixed(0)} | ` +
    `polyUSDC:$${state.polyUsdcBalance.toFixed(0)} polyHeadroom:$${state.polyHeadroomUsd.toFixed(0)}`
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

  logger.info(`[CFO:Intel] Market: ${intel.marketCondition} (risk×${intel.riskMultiplier.toFixed(2)})`);

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
