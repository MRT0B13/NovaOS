/**
 * learningEngine.ts — Progressive Learning & Feedback Loop for CFO Agent
 * ========================================================================
 *
 * Closes the open-loop gap: queries past trade outcomes from cfo_positions
 * and dynamically adjusts decision parameters per strategy.
 *
 * Architecture:
 *   1. Retrospective pass — queries closed positions by strategy, computes
 *      win rate, avg PnL, Sharpe, Brier score (Polymarket), rebalance
 *      frequency (LP), and hold duration stats.
 *   2. Adaptive parameter generation — converts stats into multipliers
 *      that the decision engine applies on top of env-var base values.
 *   3. Persistence — stores learned parameters in kv_store so they
 *      survive restarts and can be inspected/overridden.
 *   4. Gradual adaptation — uses exponential moving averages (EMA) to
 *      blend new observations with historical knowledge, preventing
 *      sudden regime changes from a single bad trade.
 *
 * Strategies covered:
 *   - polymarket  → Kelly fraction, min edge, bet sizing
 *   - hyperliquid → stop-loss %, leverage bias, hedge ratio
 *   - orca_lp     → range width multiplier, pool selection scoring
 *   - evm_lp  → range width multiplier, chain preference, APR floor
 *   - kamino      → LTV target, borrow spread threshold
 *   - jito        → stake/unstake aggressiveness
 *   - hl_spot     → spot conviction floor, size multiplier, SL multiplier
 *   - hl_spot_swing / hl_spot_accumulation → per-style spot adaptations
 *
 * Refresh cadence: once per decision cycle (every 30 min by default).
 * The computation is cheap — a few SQL queries + arithmetic.
 */

import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export interface StrategyStats {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;              // 0–1
  avgPnlUsd: number;           // average realized PnL per closed position
  totalPnlUsd: number;         // sum of realized PnL
  avgHoldHours: number;        // average hold duration
  maxDrawdownUsd: number;      // worst single-trade loss
  sharpeApprox: number;        // simplified Sharpe (mean / stdev of returns)
  recentWinRate: number;       // win rate over last 10 trades (regime detection)
  recentAvgPnlUsd: number;    // avg PnL over last 10 trades
  lastUpdated: number;         // timestamp
}

export interface LPStats {
  strategy: 'orca_lp' | 'evm_lp';
  riskTier?: 'low' | 'medium' | 'high'; // per-tier breakdown (undefined = aggregate)
  totalPositions: number;
  avgFeesEarnedUsd: number;
  avgHoldHours: number;
  rebalanceCount: number;       // positions that were rebalanced (vs first open)
  outOfRangeRate: number;       // fraction of positions that went out of range
  avgPnlPerDayUsd: number;     // daily yield performance
  bestChains: number[];         // top-performing chain IDs (EVM LP)
  bestPairs: string[];          // top-performing pairs by PnL/day
}

export interface PolymarketCalibration {
  brierScore: number;          // 0 = perfect, 1 = terrible
  overconfidenceRate: number;  // fraction of bets where estimated prob was too high
  avgPredictedProb: number;    // mean estimated probability across bets
  avgOutcome: number;          // mean actual outcome (1=win, 0=loss)
  calibrationGap: number;     // predicted - actual (positive = overconfident)
}

/**
 * Adaptive parameters that override env-var defaults.
 * All values are multipliers (1.0 = no change) or absolute overrides.
 */
export interface AdaptiveParams {
  // Global
  confidenceLevel: number;      // 0–1, how much we trust learned params (based on sample size)
  globalRiskMultiplier: number; // <1 = risk-off (multiple strategies deteriorating), 1 = normal

  // Polymarket
  kellyMultiplier: number;      // multiply env kellyFraction by this (e.g. 0.8 = more conservative)
  minEdgeOverride: number;      // absolute override for minEdge based on calibration
  polyBetSizeMultiplier: number; // scale bet sizing
  polyCooldownMultiplier: number; // >1 = slower betting (poor calibration), <1 = faster

  // Hyperliquid (hedge)
  hlStopLossMultiplier: number; // tighter/wider stop loss (< 1 = tighter)
  hlLeverageBias: number;       // -1 to +1 adjustment on max leverage
  hlHedgeTargetMultiplier: number; // scale hedge target ratio based on hedge performance
  hlRebalanceThresholdMultiplier: number; // wider if frequent rebalance = churn losses

  // Hyperliquid (signal-driven perps)
  hlPerpConvictionFloor: number;    // raise if too many losing trades at low conviction
  hlPerpSizeMultiplier: number;     // scale position size based on trade outcomes
  hlPerpStopLossMultiplier: number; // tighter/wider SL for perps specifically
  hlPerpMaxPositionsAdj: number;    // -N to +N adjustment on max simultaneous positions

  // Hyperliquid perp per-style overrides (scalp/day/swing learn independently)
  hlPerpStyleSizeMultipliers: Record<string, number>;     // { scalp: 1.0, day: 1.0, swing: 1.0 }
  hlPerpStyleStopMultipliers: Record<string, number>;     // per-style SL multiplier
  hlPerpStyleConvictionFloors: Record<string, number>;    // per-style conviction floor
  hlPerpStyleLeverageMultipliers: Record<string, number>; // per-style leverage multiplier (scalp can go higher)

  // Hyperliquid perp session activity gate
  hlPerpSessionDampeningMult: number; // learned dampening strength for quiet sessions (default 1.0)

  // Hyperliquid spot (signal-driven + accumulation)
  hlSpotConvictionFloor: number;       // raise if too many losing spot trades at low conviction
  hlSpotSizeMultiplier: number;        // scale spot position size based on outcomes
  hlSpotStopLossMultiplier: number;    // tighter/wider SL for spot specifically
  hlSpotMaxPositionsAdj: number;       // -N to +N adjustment on max simultaneous spot positions
  // Per-style spot overrides (day/swing/accumulation learn independently)
  hlSpotStyleSizeMultipliers: Record<string, number>;       // { day: 1.0, swing: 1.0, accumulation: 1.0 }
  hlSpotStyleStopMultipliers: Record<string, number>;       // per-style SL multiplier
  hlSpotStyleConvictionFloors: Record<string, number>;      // per-style conviction floor

  // LP (Orca + EVM) — global
  lpRangeWidthMultiplier: number;  // wider/narrower ranges based on rebalance frequency
  lpMinAprAdjustment: number;      // increase min APR floor if LP positions underperform
  lpRebalanceTriggerMultiplier: number; // tighter if OOR rate high, looser if profitable

  // LP per-risk-tier overrides (multiplied on top of the relevant tier's base range)
  lpTierRangeMultipliers: Record<string, number>;   // { low: 1.0, medium: 1.0, high: 1.3 }
  lpTierMinAprAdjustments: Record<string, number>;  // per-tier APR floor nudges

  // LP pair intelligence (used for increase / remove gating)
  lpBestPairs: string[];           // top-performing LP pairs by daily PnL (combined Orca + EVM)
  lpTotalPositions: number;        // total historical LP positions (confidence gate)

  // Kamino
  kaminoLtvMultiplier: number;     // tighten/loosen LTV target
  kaminoSpreadFloorMultiplier: number; // raise spread floor if actual yield < projected

  // BorrowLP pipeline (Kamino borrow → Orca LP → fees → repay)
  borrowLpNetYield: number;         // net annualized yield (LP fees - borrow cost) from BorrowLP positions
  borrowLpCycleCount: number;       // completed borrow→LP→repay cycles (confidence gate)

  // AAVE BorrowLP pipeline (AAVE V3 borrow → EVM LP → fees → repay)
  aaveBorrowLpNetYield: number;     // net annualized yield (LP fees - borrow cost) from AAVE borrow-LP
  aaveBorrowLpCycleCount: number;   // completed AAVE borrow→LP→repay cycles

  // Profit Reinvestment
  reinvestEfficiency: number;       // ratio of reinvested USD that generated additional yield (0-1)
  reinvestSweepCount: number;       // total reinvestment sweeps executed

  // EVM Arb
  evmArbMinProfitMultiplier: number; // raise if slippage consistently eats profit

  // Operational
  feeDragPct: number;           // total fees / total volume — awareness of cost drag
  executionFailRates: Record<string, number>; // strategy → tx failure rate (0-1)

  // Strategy allocation preference (higher = more capital)
  strategyScores: Record<string, number>;  // strategy → relative performance score
  capitalWeights: Record<string, number>;  // strategy → allocation weight (0-1, sums to 1)

  // Portfolio-level
  portfolioSharpe: number;       // daily portfolio Sharpe ratio
  portfolioMaxDrawdownPct: number; // max drawdown from peak (0-1)
  regimeSignal: 'risk-on' | 'neutral' | 'risk-off'; // multi-strategy regime detection

  // Alerts
  alerts: string[];              // drift alerts, degradation warnings

  // Metadata
  sampleSizes: Record<string, number>;
  lastComputed: number;
}

// ============================================================================
// Constants
// ============================================================================

const KV_KEY = 'cfo_learning_params';
const EMA_ALPHA = 0.3;              // blend factor: 30% new data, 70% prior
const MIN_TRADES_FOR_CONFIDENCE = 5; // need 5+ closed trades before adapting
const LOOKBACK_DAYS = 90;            // analyze last 90 days of trade history

// ============================================================================
// Core: Compute strategy stats from DB
// ============================================================================

/** DB pool ref — set by refreshLearning() caller */
let _pool: any = null;

export function setLearningPool(pool: any): void {
  _pool = pool;
}

/**
 * Query closed positions for a strategy and compute stats.
 * For aggregate strategies (hl_perp, hl_spot) — includes all sub-strategies
 * (e.g. hl_perp also includes hl_perp_scalp, hl_perp_day, hl_perp_swing)
 * so the generic learning engine adapts from the full trade history.
 * Per-style stats (hl_perp_scalp etc.) still use exact match for fine-tuning.
 */
async function computeStrategyStats(
  pool: any,
  strategy: string,
): Promise<StrategyStats> {
  const emptyStats: StrategyStats = {
    strategy,
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    avgPnlUsd: 0, totalPnlUsd: 0, avgHoldHours: 0,
    maxDrawdownUsd: 0, sharpeApprox: 0,
    recentWinRate: 0, recentAvgPnlUsd: 0,
    lastUpdated: Date.now(),
  };

  try {
    // For aggregate strategy keys, include all sub-strategies so the
    // generic HL perp/spot learning engine sees the full trade corpus.
    // e.g. 'hl_perp' → LIKE 'hl_perp%' matches hl_perp, hl_perp_scalp, hl_perp_day, hl_perp_swing
    const AGGREGATE_STRATEGIES = ['hl_perp', 'hl_spot'];
    const isAggregate = AGGREGATE_STRATEGIES.includes(strategy);
    const whereClause = isAggregate ? `strategy LIKE $1` : `strategy = $1`;
    const paramValue = isAggregate ? `${strategy}%` : strategy;

    // All closed positions for this strategy within lookback
    const res = await pool.query(
      `SELECT realized_pnl_usd, cost_basis_usd,
              EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600 AS hold_hours,
              closed_at
       FROM cfo_positions
       WHERE ${whereClause} AND status = 'CLOSED'
         AND closed_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY closed_at DESC`,
      [paramValue],
    );

    const rows = res.rows;
    if (rows.length === 0) return emptyStats;

    const pnls: number[] = rows.map((r: any) => Number(r.realized_pnl_usd));
    const holdHours: number[] = rows.map((r: any) => Number(r.hold_hours || 0));

    const wins = pnls.filter(p => p > 0).length;
    const losses = pnls.filter(p => p <= 0).length;
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const avgPnl = totalPnl / pnls.length;
    const maxDrawdown = Math.min(0, ...pnls);

    // Simplified Sharpe: mean / stdev
    const mean = avgPnl;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / Math.max(1, pnls.length - 1);
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? mean / stdev : 0;

    // Recent 10 trades (regime detection)
    const recent = pnls.slice(0, 10);
    const recentWins = recent.filter(p => p > 0).length;
    const recentAvg = recent.length > 0 ? recent.reduce((s, p) => s + p, 0) / recent.length : 0;

    return {
      strategy,
      totalTrades: rows.length,
      wins,
      losses,
      winRate: wins / rows.length,
      avgPnlUsd: avgPnl,
      totalPnlUsd: totalPnl,
      avgHoldHours: holdHours.reduce((s, h) => s + h, 0) / holdHours.length,
      maxDrawdownUsd: maxDrawdown,
      sharpeApprox: sharpe,
      recentWinRate: recent.length > 0 ? recentWins / recent.length : 0,
      recentAvgPnlUsd: recentAvg,
      lastUpdated: Date.now(),
    };
  } catch (err) {
    logger.debug(`[Learning] Error computing stats for ${strategy}:`, err);
    return emptyStats;
  }
}

/**
 * Compute LP-specific stats (rebalance frequency, out-of-range rate, per-chain/pair performance).
 * When riskTier is provided, only positions with matching metadata.riskTier are included.
 */
async function computeLPStats(
  pool: any,
  strategy: 'orca_lp' | 'evm_lp',
  riskTier?: 'low' | 'medium' | 'high',
): Promise<LPStats> {
  const empty: LPStats = {
    strategy, riskTier, totalPositions: 0, avgFeesEarnedUsd: 0,
    avgHoldHours: 0, rebalanceCount: 0, outOfRangeRate: 0,
    avgPnlPerDayUsd: 0, bestChains: [], bestPairs: [],
  };

  try {
    // If riskTier filter is specified, filter in JS after fetch (metadata is JSONB, filtering in SQL
    // would require casting and is fragile). Volume is small so this is fine.
    const res = await pool.query(
      `SELECT realized_pnl_usd, cost_basis_usd, asset, chain, metadata,
              EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - opened_at)) / 3600 AS hold_hours
       FROM cfo_positions
       WHERE strategy = $1
         AND opened_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY opened_at DESC`,
      [strategy],
    );

    let rows = res.rows;
    // Filter by risk tier if specified (metadata.riskTier)
    if (riskTier && rows.length > 0) {
      rows = rows.filter((r: any) => {
        const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
        return meta.riskTier === riskTier;
      });
    }
    if (rows.length === 0) return empty;

    const holdHours: number[] = rows.map((r: any) => Number(r.hold_hours || 1));
    const pnls: number[] = rows.map((r: any) => Number(r.realized_pnl_usd));

    // Per-chain stats
    const chainPnl: Record<number, { total: number; count: number }> = {};
    // Per-pair stats
    const pairPnl: Record<string, { total: number; hours: number }> = {};

    let rebalanceCount = 0;
    let outOfRange = 0;

    for (const row of rows) {
      const meta = row.metadata || {};
      const chainId = Number(meta.chainNumericId || 0);
      const pair = String(row.asset || 'unknown');

      // Track chain performance
      if (chainId > 0) {
        if (!chainPnl[chainId]) chainPnl[chainId] = { total: 0, count: 0 };
        chainPnl[chainId].total += Number(row.realized_pnl_usd);
        chainPnl[chainId].count++;
      }

      // Track pair performance (PnL per day)
      const hours = Number(row.hold_hours || 1);
      if (!pairPnl[pair]) pairPnl[pair] = { total: 0, hours: 0 };
      pairPnl[pair].total += Number(row.realized_pnl_usd);
      pairPnl[pair].hours += hours;

      // Rebalance detection (metadata flag)
      if (meta.rebalanced || meta.rebalanceOf) rebalanceCount++;
      if (meta.outOfRange) outOfRange++;
    }

    // Sort chains by avg PnL per position
    const bestChains = Object.entries(chainPnl)
      .map(([id, { total, count }]) => ({ id: Number(id), avg: total / count }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 5)
      .map(c => c.id);

    // Sort pairs by daily PnL
    const bestPairs = Object.entries(pairPnl)
      .map(([pair, { total, hours }]) => ({ pair, dailyPnl: (total / Math.max(1, hours)) * 24 }))
      .sort((a, b) => b.dailyPnl - a.dailyPnl)
      .slice(0, 5)
      .map(p => p.pair);

    const avgHold = holdHours.reduce((s: number, h: number) => s + h, 0) / holdHours.length;
    const totalPnl = pnls.reduce((s: number, p: number) => s + p, 0);
    const totalHours = holdHours.reduce((s: number, h: number) => s + h, 0);

    return {
      strategy,
      totalPositions: rows.length,
      avgFeesEarnedUsd: totalPnl / rows.length,
      avgHoldHours: avgHold,
      rebalanceCount,
      outOfRangeRate: rows.length > 0 ? outOfRange / rows.length : 0,
      avgPnlPerDayUsd: totalHours > 0 ? (totalPnl / totalHours) * 24 : 0,
      bestChains,
      bestPairs,
    };
  } catch (err) {
    logger.debug(`[Learning] LP stats error for ${strategy}:`, err);
    return empty;
  }
}

/**
 * Compute Polymarket prediction calibration (Brier score).
 */
async function computePolyCalibration(pool: any): Promise<PolymarketCalibration> {
  const empty: PolymarketCalibration = {
    brierScore: 0.5, overconfidenceRate: 0.5,
    avgPredictedProb: 0.5, avgOutcome: 0.5, calibrationGap: 0,
  };

  try {
    // Positions store: metadata.estimatedProbability, realized_pnl > 0 = win
    const res = await pool.query(
      `SELECT realized_pnl_usd, metadata
       FROM cfo_positions
       WHERE strategy = 'polymarket' AND status = 'CLOSED'
         AND closed_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY closed_at DESC`,
    );

    const rows = res.rows;
    if (rows.length < 3) return empty;

    let sumBrier = 0;
    let overconfident = 0;
    let sumPred = 0;
    let sumOutcome = 0;
    let count = 0;

    for (const row of rows) {
      const meta = row.metadata || {};
      const pred = Number(meta.estimatedProbability ?? meta.probability ?? 0.5);
      const outcome = Number(row.realized_pnl_usd) > 0 ? 1 : 0;

      sumBrier += (pred - outcome) ** 2;
      if (pred > 0.6 && outcome === 0) overconfident++;
      sumPred += pred;
      sumOutcome += outcome;
      count++;
    }

    return {
      brierScore: count > 0 ? sumBrier / count : 0.5,
      overconfidenceRate: count > 0 ? overconfident / count : 0.5,
      avgPredictedProb: count > 0 ? sumPred / count : 0.5,
      avgOutcome: count > 0 ? sumOutcome / count : 0.5,
      calibrationGap: count > 0 ? (sumPred / count) - (sumOutcome / count) : 0,
    };
  } catch (err) {
    logger.debug('[Learning] Poly calibration error:', err);
    return empty;
  }
}

// ============================================================================
// Fee-drag & Execution Quality
// ============================================================================

interface FeeStats {
  totalFeesUsd: number;
  totalVolumeUsd: number;
  feeDragPct: number;             // fees / volume
  perStrategy: Record<string, { fees: number; volume: number; failRate: number }>;
}

async function computeFeeAndExecStats(pool: any): Promise<FeeStats> {
  const empty: FeeStats = { totalFeesUsd: 0, totalVolumeUsd: 0, feeDragPct: 0, perStrategy: {} };
  try {
    // Fee drag from transactions
    const feeRes = await pool.query(
      `SELECT strategy_tag,
              SUM(COALESCE(fee_usd, 0)) AS total_fees,
              SUM(COALESCE(amount_in, 0)) AS total_volume,
              COUNT(*) AS total_txns,
              SUM(CASE WHEN status = 'failed' OR error_message IS NOT NULL THEN 1 ELSE 0 END) AS failed_txns
       FROM cfo_transactions
       WHERE timestamp > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       GROUP BY strategy_tag`,
    );

    let totalFees = 0;
    let totalVol = 0;
    const perStrategy: Record<string, { fees: number; volume: number; failRate: number }> = {};

    for (const row of feeRes.rows) {
      const strat = String(row.strategy_tag);
      const fees = Number(row.total_fees || 0);
      const vol = Number(row.total_volume || 0);
      const total = Number(row.total_txns || 1);
      const failed = Number(row.failed_txns || 0);

      totalFees += fees;
      totalVol += vol;
      perStrategy[strat] = { fees, volume: vol, failRate: total > 0 ? failed / total : 0 };
    }

    return {
      totalFeesUsd: totalFees,
      totalVolumeUsd: totalVol,
      feeDragPct: totalVol > 0 ? (totalFees / totalVol) * 100 : 0,
      perStrategy,
    };
  } catch (err) {
    logger.debug('[Learning] Fee/exec stats error:', err);
    return empty;
  }
}

// ============================================================================
// Portfolio-level Intelligence
// ============================================================================

interface PortfolioLearning {
  sharpe: number;
  maxDrawdownPct: number;
  regimeSignal: 'risk-on' | 'neutral' | 'risk-off';
}

async function computePortfolioStats(
  pool: any,
  strategyStats: Record<string, StrategyStats>,
): Promise<PortfolioLearning> {
  const neutral: PortfolioLearning = { sharpe: 0, maxDrawdownPct: 0, regimeSignal: 'neutral' };

  try {
    // Daily portfolio returns from snapshots
    const snapRes = await pool.query(
      `SELECT date, total_portfolio_usd, realized_pnl_24h
       FROM cfo_daily_snapshots
       WHERE date > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY date ASC`,
    );

    const snaps = snapRes.rows;
    if (snaps.length < 3) return neutral;

    // Compute daily returns
    const dailyReturns: number[] = [];
    let peak = 0;
    let maxDrawdown = 0;

    for (let i = 1; i < snaps.length; i++) {
      const prev = Number(snaps[i - 1].total_portfolio_usd) || 1;
      const curr = Number(snaps[i].total_portfolio_usd) || 1;
      const ret = (curr - prev) / Math.max(1, prev);
      dailyReturns.push(ret);

      // Track drawdown from peak
      if (curr > peak) peak = curr;
      const dd = peak > 0 ? (peak - curr) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Portfolio Sharpe (daily, not annualized)
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? mean / stdev : 0;

    // Regime detection: if 3+ strategies show deteriorating recent performance, risk-off
    let deteriorating = 0;
    let improving = 0;
    for (const st of Object.values(strategyStats)) {
      if (st.totalTrades < 3) continue;
      if (st.recentWinRate < st.winRate - 0.1 && st.recentAvgPnlUsd < st.avgPnlUsd) {
        deteriorating++;
      } else if (st.recentWinRate > st.winRate + 0.1 && st.recentAvgPnlUsd > st.avgPnlUsd) {
        improving++;
      }
    }

    let regimeSignal: 'risk-on' | 'neutral' | 'risk-off' = 'neutral';
    if (deteriorating >= 3 || (maxDrawdown > 0.15 && sharpe < 0)) {
      regimeSignal = 'risk-off';
    } else if (improving >= 2 && sharpe > 0.3) {
      regimeSignal = 'risk-on';
    }

    return { sharpe, maxDrawdownPct: maxDrawdown, regimeSignal };
  } catch (err) {
    logger.debug('[Learning] Portfolio stats error:', err);
    return neutral;
  }
}

// ============================================================================
// Capital Allocation from Strategy Scores
// ============================================================================

function computeCapitalWeights(scores: Record<string, number>): Record<string, number> {
  const entries = Object.entries(scores).filter(([, s]) => s > 0);
  if (entries.length === 0) return {};

  const totalScore = entries.reduce((s, [, score]) => s + score, 0);
  if (totalScore === 0) return {};

  const weights: Record<string, number> = {};
  for (const [name, score] of entries) {
    weights[name] = score / totalScore;
  }
  return weights;
}

// ============================================================================
// Parameter Drift Detection & Alerts
// ============================================================================

function detectDriftAlerts(
  current: AdaptiveParams,
  prior: AdaptiveParams | null,
  strategyStats: Record<string, StrategyStats>,
  feeStats: FeeStats,
): string[] {
  const alerts: string[] = [];

  if (prior && prior.lastComputed > 0) {
    // Check for large parameter swings (>30% change in any multiplier)
    const drifts: Array<[string, number, number]> = [
      ['Kelly', current.kellyMultiplier, prior.kellyMultiplier],
      ['HL Stop', current.hlStopLossMultiplier, prior.hlStopLossMultiplier],
      ['LP Range', current.lpRangeWidthMultiplier, prior.lpRangeWidthMultiplier],
      ['Bet Size', current.polyBetSizeMultiplier, prior.polyBetSizeMultiplier],
      ['Hedge Target', current.hlHedgeTargetMultiplier, prior.hlHedgeTargetMultiplier],
      ['Perp Size', current.hlPerpSizeMultiplier, prior.hlPerpSizeMultiplier],
      ['Perp SL', current.hlPerpStopLossMultiplier, prior.hlPerpStopLossMultiplier],
    ];

    // Add per-style perp drift checks
    for (const style of ['scalp', 'day', 'swing'] as const) {
      const currSize = current.hlPerpStyleSizeMultipliers?.[style] ?? 1;
      const prevSize = prior.hlPerpStyleSizeMultipliers?.[style] ?? 1;
      if (prevSize !== 1 || currSize !== 1) {
        drifts.push([`Perp ${style} size`, currSize, prevSize]);
      }
      const currStop = current.hlPerpStyleStopMultipliers?.[style] ?? 1;
      const prevStop = prior.hlPerpStyleStopMultipliers?.[style] ?? 1;
      if (prevStop !== 1 || currStop !== 1) {
        drifts.push([`Perp ${style} SL`, currStop, prevStop]);
      }
    }

    for (const [name, curr, prev] of drifts) {
      if (prev === 0) continue;
      const changePct = Math.abs((curr - prev) / prev) * 100;
      if (changePct > 30) {
        const dir = curr > prev ? '↑' : '↓';
        alerts.push(`${dir} ${name} shifted ${changePct.toFixed(0)}% (${prev.toFixed(2)} → ${curr.toFixed(2)})`);
      }
    }
  }

  // Strategy degradation → describe what the engine is DOING about it (not "consider pausing")
  const GATE_THRESHOLD = 15; // matches MIN_STRATEGY_SCORE in decisionEngine
  for (const [name, st] of Object.entries(strategyStats)) {
    if (st.totalTrades < MIN_TRADES_FOR_CONFIDENCE) continue;

    const score = current.strategyScores[name] ?? 50;
    if (score < 25) {
      const isGated = score < GATE_THRESHOLD && st.totalTrades >= 5;

      // Build list of active adaptations for this strategy
      const adaptations: string[] = [];
      // Check for size/SL/conviction adjustments applied
      if (name === 'hyperliquid' || name.startsWith('hl_perp')) {
        if (current.hlPerpSizeMultiplier < 0.95) adaptations.push(`size×${current.hlPerpSizeMultiplier.toFixed(2)}`);
        if (current.hlPerpStopLossMultiplier < 0.95) adaptations.push(`SL tightened×${current.hlPerpStopLossMultiplier.toFixed(2)}`);
        if (current.hlPerpConvictionFloor > 0) adaptations.push(`conv floor↑${(current.hlPerpConvictionFloor * 100).toFixed(0)}%`);
        // Per-style
        const style = name.replace('hl_perp_', '') as 'scalp' | 'day' | 'swing';
        const styleSizeMult = current.hlPerpStyleSizeMultipliers?.[style];
        if (styleSizeMult !== undefined && styleSizeMult < 0.95) adaptations.push(`${style} size×${styleSizeMult.toFixed(2)}`);
      }
      if (name === 'hl_spot' || name.startsWith('hl_spot_')) {
        if (current.hlSpotSizeMultiplier < 0.95) adaptations.push(`size×${current.hlSpotSizeMultiplier.toFixed(2)}`);
      }

      const actionText = adaptations.length > 0
        ? `adapting: ${adaptations.join(', ')}`
        : isGated
          ? 'gated until performance improves'
          : 'learning from losses — will adapt with more data';

      alerts.push(
        `⚠️ ${name}: score=${score.toFixed(0)}, ` +
        `WR=${(st.winRate * 100).toFixed(0)}%, avgPnL=$${st.avgPnlUsd.toFixed(2)} — ${actionText}`,
      );
    }

    // Recent regime shift warning — only if significant
    if (st.recentWinRate < st.winRate - 0.25 && st.totalTrades >= 10) {
      alerts.push(
        `📉 ${name} regime shift: recent WR ${(st.recentWinRate * 100).toFixed(0)}% vs ` +
        `overall ${(st.winRate * 100).toFixed(0)}%`,
      );
    }
  }

  // High fee drag warning
  if (feeStats.feeDragPct > 2) {
    alerts.push(
      `💸 High fee drag: ${feeStats.feeDragPct.toFixed(1)}% of volume lost to fees ` +
      `($${feeStats.totalFeesUsd.toFixed(2)} on $${feeStats.totalVolumeUsd.toFixed(0)} volume)`,
    );
  }

  // High execution failure rate per strategy
  for (const [strat, info] of Object.entries(feeStats.perStrategy)) {
    if (info.failRate > 0.2) {
      alerts.push(
        `🔴 ${strat} execution failures: ${(info.failRate * 100).toFixed(0)}% of transactions failing`,
      );
    }
  }

  return alerts;
}

// ============================================================================
// Adaptive Parameter Computation
// ============================================================================

function computeAdaptiveParams(
  stats: Record<string, StrategyStats>,
  lpStats: Record<string, LPStats>,
  polyCal: PolymarketCalibration,
  prior: AdaptiveParams | null,
  feeStats: FeeStats,
  portfolio: PortfolioLearning,
  sessionDampMult: number = 1.0,
): AdaptiveParams {

  const blend = (newVal: number, priorVal: number | undefined): number => {
    if (priorVal === undefined || priorVal === 0) return newVal;
    return EMA_ALPHA * newVal + (1 - EMA_ALPHA) * priorVal;
  };

  // ── Polymarket adaptations ──────────────────────────────────────
  let kellyMult = 1.0;
  let minEdgeOvr = 0.05; // default
  let polyBetMult = 1.0;
  let polyCooldownMult = 1.0;
  const polySt = stats['polymarket'];

  if (polySt && polySt.totalTrades >= MIN_TRADES_FOR_CONFIDENCE) {
    // If win rate is low, reduce Kelly fraction
    if (polySt.winRate < 0.4) kellyMult = 0.5;
    else if (polySt.winRate < 0.5) kellyMult = 0.75;
    else if (polySt.winRate > 0.65) kellyMult = 1.2;

    // If recent performance is deteriorating, pull back
    if (polySt.recentWinRate < polySt.winRate - 0.15) {
      kellyMult *= 0.7; // regime shift: cut sizing
    }

    // Calibration: if overconfident, raise min edge requirement
    if (polyCal.calibrationGap > 0.1) {
      minEdgeOvr = 0.05 + polyCal.calibrationGap * 0.5;
    }
    if (polyCal.brierScore > 0.35) {
      polyBetMult = 0.6; // poor calibration → smaller bets
    }

    // Cooldown: slow down betting if poorly calibrated, speed up if well-calibrated
    if (polyCal.brierScore > 0.3 || polySt.winRate < 0.35) {
      polyCooldownMult = 1.5; // 50% longer cooldowns
    } else if (polyCal.brierScore < 0.2 && polySt.winRate > 0.55) {
      polyCooldownMult = 0.7; // bet more frequently when calibrated well
    }
  }

  // ── Hyperliquid adaptations ─────────────────────────────────────
  let hlStopMult = 1.0;
  let hlLevBias = 0;
  let hlHedgeTargetMult = 1.0;
  let hlRebalThreshMult = 1.0;
  const hlSt = stats['hyperliquid'];

  if (hlSt && hlSt.totalTrades >= MIN_TRADES_FOR_CONFIDENCE) {
    // Graduated stop-loss adaptation: even small persistent losses tighten stops slightly.
    // The worse the performance, the tighter the stops.
    if (hlSt.maxDrawdownUsd < -50 && Math.abs(hlSt.maxDrawdownUsd) > hlSt.avgPnlUsd * 5) {
      hlStopMult = 0.7;
    } else if (hlSt.avgPnlUsd < 0 && hlSt.sharpeApprox < 0) {
      // Losing strategy with negative Sharpe → graduated tightening
      // e.g. Sharpe=-0.46 → clamp(-0.46,-1,0)=0.46 → 1 - 0.46*0.3 = 0.86× SL
      const severity = Math.min(1, Math.abs(hlSt.sharpeApprox));
      hlStopMult = 1.0 - severity * 0.3; // range: 1.0 → 0.7
    } else if (hlSt.winRate > 0.6 && hlSt.sharpeApprox > 0.3) {
      hlStopMult = 1.15;
    }

    // Graduated leverage bias: proportional to avg PnL severity
    // Range: -2 to +2 (meaningful with env max 10)
    if (hlSt.avgPnlUsd < 0) {
      hlLevBias = Math.max(-2, hlSt.avgPnlUsd * 0.2); // e.g. -$5 → -1.0, -$10 → -2.0
    } else if (hlSt.avgPnlUsd > 5 && hlSt.sharpeApprox > 0.5) {
      // Graduated upward bias: Sharpe 0.5 → +0.5, Sharpe 1.0 → +1.0, cap +2
      hlLevBias = Math.min(2, hlSt.sharpeApprox);
    }

    // Recent regime shift
    if (hlSt.recentAvgPnlUsd < 0 && hlSt.avgPnlUsd > 0) {
      hlStopMult *= 0.8;
      hlLevBias -= 1; // stronger pullback during regime shift
    }

    // Hedge target: if hedging consistently loses money, reduce target
    if (hlSt.totalPnlUsd < -10 && hlSt.winRate < 0.3) {
      hlHedgeTargetMult = 0.7; // hedge less aggressively
    } else if (hlSt.totalPnlUsd > 0 && hlSt.winRate > 0.5) {
      hlHedgeTargetMult = 1.1; // hedges are working → lean in
    }

    // Rebalance threshold: if lots of churn (many open/close with losses), widen
    if (hlSt.avgHoldHours < 4 && hlSt.avgPnlUsd < 0) {
      hlRebalThreshMult = 1.3; // widen threshold to reduce churn
    }
  }

  // ── HL Perp (signal-driven) adaptations ─────────────────────────
  let perpConvFloor = 0;       // 0 = use env default, >0 = raise minimum conviction
  let perpSizeMult = 1.0;     // scale position sizes
  let perpStopMult = 1.0;     // tighter/wider SL
  let perpMaxPosAdj = 0;      // -N to +N on max positions
  const perpSt = stats['hl_perp'];

  if (perpSt && perpSt.totalTrades >= MIN_TRADES_FOR_CONFIDENCE) {
    // Graduated conviction floor based on how bad the win rate is
    if (perpSt.winRate < 0.5 && perpSt.totalPnlUsd < 0) {
      // Scale conviction floor linearly: 50% WR → floor 0.30, 35% WR → 0.45, 20% WR → 0.60
      perpConvFloor = Math.min(0.7, 0.30 + (0.5 - perpSt.winRate) * 1.0);
    }

    // Graduated position sizing: proportional to performance severity
    if (perpSt.avgPnlUsd < 0) {
      // e.g. -$0.49 → 0.95×, -$2 → 0.80×, -$5 → 0.60×
      const severity = Math.min(1, Math.abs(perpSt.avgPnlUsd) / 5);
      perpSizeMult = 1.0 - severity * 0.4; // range: 1.0 → 0.6
    } else if (perpSt.avgPnlUsd > 3 && perpSt.sharpeApprox > 0.5) {
      perpSizeMult = 1.3; // perps are working → lean in
    }

    // If max drawdown is severe, tighten stops
    if (perpSt.maxDrawdownUsd < -20 && Math.abs(perpSt.maxDrawdownUsd) > perpSt.avgPnlUsd * 3) {
      perpStopMult = 0.7; // tighter SL
    } else if (perpSt.winRate > 0.55 && perpSt.sharpeApprox > 0.3) {
      perpStopMult = 1.15; // let winners run slightly more
    }

    // If many losing trades, reduce max concurrent positions
    if (perpSt.recentWinRate < 0.3 && perpSt.recentAvgPnlUsd < 0) {
      perpMaxPosAdj = -1; // scale down from 3 → 2
    } else if (perpSt.recentWinRate > 0.6 && perpSt.recentAvgPnlUsd > 0) {
      perpMaxPosAdj = 1; // expand if printing
    }

    // Recent regime shift: perps suddenly deteriorating
    if (perpSt.recentAvgPnlUsd < -2 && perpSt.avgPnlUsd > 0) {
      perpSizeMult *= 0.7; // reduce exposure during regime shift
      perpStopMult *= 0.85;
    }
  }

  // ── Per-style HL perp adaptations (scalp/day/swing learn independently) ──
  // Mirrors the LP per-tier pattern: each style adapts its own size, SL, and conviction floor
  const perpStyleSizeMults: Record<string, number> = { scalp: 1.0, day: 1.0, swing: 1.0 };
  const perpStyleStopMults: Record<string, number> = { scalp: 1.0, day: 1.0, swing: 1.0 };
  const perpStyleConvFloors: Record<string, number> = { scalp: 0, day: 0, swing: 0 };
  const perpStyleLevMults: Record<string, number> = { scalp: 1.0, day: 1.0, swing: 1.0 };

  for (const style of ['scalp', 'day', 'swing'] as const) {
    const styleSt = stats[`hl_perp_${style}`];
    if (!styleSt || styleSt.totalTrades < MIN_TRADES_FOR_CONFIDENCE) continue;

    // Graduated size multiplier: proportional to performance, not binary
    if (styleSt.avgPnlUsd < 0) {
      const severity = Math.min(1, Math.abs(styleSt.avgPnlUsd) / 5);
      perpStyleSizeMults[style] = 1.0 - severity * 0.4; // 1.0 → 0.6
    } else if (styleSt.avgPnlUsd > 3 && styleSt.sharpeApprox > 0.5) {
      perpStyleSizeMults[style] = 1.3;
    }

    // SL multiplier: tighten if drawdowns severe, loosen if winning
    if (styleSt.maxDrawdownUsd < -20 && Math.abs(styleSt.maxDrawdownUsd) > styleSt.avgPnlUsd * 3) {
      perpStyleStopMults[style] = 0.7;
    } else if (styleSt.winRate > 0.55 && styleSt.sharpeApprox > 0.3) {
      perpStyleStopMults[style] = 1.15;
    }

    // Graduated conviction floor for styles
    if (styleSt.winRate < 0.5 && styleSt.totalPnlUsd < 0) {
      perpStyleConvFloors[style] = Math.min(0.7, 0.30 + (0.5 - styleSt.winRate) * 1.0);
    }

    // Leverage multiplier: scalps with tight SL benefit from higher leverage.
    // Learning-driven: ramp leverage proportionally to edge quality.
    // Range: 0.4× (cutting bad style hard) to 2.0× (double leverage for strong edge).
    if (styleSt.winRate > 0.6 && styleSt.sharpeApprox > 0.8 && styleSt.totalPnlUsd > 20) {
      // Strong consistent edge — ramp leverage aggressively (2.0× base)
      perpStyleLevMults[style] = 2.0;
    } else if (styleSt.winRate > 0.55 && styleSt.sharpeApprox > 0.3 && styleSt.totalPnlUsd > 0) {
      // Good edge — graduated increase based on Sharpe quality
      // Sharpe 0.3 → 1.3×, Sharpe 0.6 → 1.6×, Sharpe 1.0+ → 1.8×
      perpStyleLevMults[style] = Math.min(1.8, 1.0 + styleSt.sharpeApprox);
    } else if (styleSt.winRate < 0.35 && styleSt.totalPnlUsd < 0) {
      // Losing style — reduce leverage
      perpStyleLevMults[style] = 0.5;
    } else if (styleSt.avgPnlUsd < -5) {
      // Significant avg loss — cut leverage hard
      perpStyleLevMults[style] = 0.4;
    }

    // Regime shift within style
    if (styleSt.recentAvgPnlUsd < -2 && styleSt.avgPnlUsd > 0) {
      perpStyleSizeMults[style] *= 0.7;
      perpStyleStopMults[style] *= 0.85;
    }
  }

  // ── HL Spot adaptations (day/swing/accumulation) ────────────────
  let spotConvFloor = 0;
  let spotSizeMult = 1.0;
  let spotStopMult = 1.0;
  let spotMaxPosAdj = 0;
  const spotSt = stats['hl_spot'];

  if (spotSt && spotSt.totalTrades >= MIN_TRADES_FOR_CONFIDENCE) {
    // Graduated conviction floor
    if (spotSt.winRate < 0.5 && spotSt.totalPnlUsd < 0) {
      spotConvFloor = Math.min(0.7, 0.30 + (0.5 - spotSt.winRate) * 1.0);
    }

    // Graduated position sizing: proportional response
    if (spotSt.avgPnlUsd < 0) {
      const severity = Math.min(1, Math.abs(spotSt.avgPnlUsd) / 5);
      spotSizeMult = 1.0 - severity * 0.4;
    } else if (spotSt.avgPnlUsd > 3 && spotSt.sharpeApprox > 0.5) {
      spotSizeMult = 1.3;
    }

    // If max drawdown is severe, tighten stops
    if (spotSt.maxDrawdownUsd < -20 && Math.abs(spotSt.maxDrawdownUsd) > spotSt.avgPnlUsd * 3) {
      spotStopMult = 0.7;
    } else if (spotSt.winRate > 0.55 && spotSt.sharpeApprox > 0.3) {
      spotStopMult = 1.15;
    }

    // If many losing trades, reduce max concurrent positions
    if (spotSt.recentWinRate < 0.3 && spotSt.recentAvgPnlUsd < 0) {
      spotMaxPosAdj = -1;
    } else if (spotSt.recentWinRate > 0.6 && spotSt.recentAvgPnlUsd > 0) {
      spotMaxPosAdj = 1;
    }

    // Regime shift: spot suddenly deteriorating
    if (spotSt.recentAvgPnlUsd < -2 && spotSt.avgPnlUsd > 0) {
      spotSizeMult *= 0.7;
      spotStopMult *= 0.85;
    }
  }

  // ── Per-style HL spot adaptations (day/swing/accumulation learn independently) ──
  const spotStyleSizeMults: Record<string, number> = { day: 1.0, swing: 1.0, accumulation: 1.0 };
  const spotStyleStopMults: Record<string, number> = { day: 1.0, swing: 1.0, accumulation: 1.0 };
  const spotStyleConvFloors: Record<string, number> = { day: 0, swing: 0, accumulation: 0 };

  for (const style of ['day', 'swing', 'accumulation'] as const) {
    // hl_spot uses 'hl_spot' for day, 'hl_spot_swing' for swing, 'hl_spot_accumulation' for accum
    const stratKey = style === 'day' ? 'hl_spot' : `hl_spot_${style}`;
    const styleSt = stats[stratKey];
    if (!styleSt || styleSt.totalTrades < MIN_TRADES_FOR_CONFIDENCE) continue;

    // Graduated size multiplier for spot styles
    if (styleSt.avgPnlUsd < 0) {
      const severity = Math.min(1, Math.abs(styleSt.avgPnlUsd) / 5);
      spotStyleSizeMults[style] = 1.0 - severity * 0.4;
    } else if (styleSt.avgPnlUsd > 3 && styleSt.sharpeApprox > 0.5) {
      spotStyleSizeMults[style] = 1.3;
    }

    // SL multiplier
    if (styleSt.maxDrawdownUsd < -20 && Math.abs(styleSt.maxDrawdownUsd) > styleSt.avgPnlUsd * 3) {
      spotStyleStopMults[style] = 0.7;
    } else if (styleSt.winRate > 0.55 && styleSt.sharpeApprox > 0.3) {
      spotStyleStopMults[style] = 1.15;
    }

    // Graduated conviction floor for spot styles
    if (styleSt.winRate < 0.5 && styleSt.totalPnlUsd < 0) {
      spotStyleConvFloors[style] = Math.min(0.7, 0.30 + (0.5 - styleSt.winRate) * 1.0);
    }

    // Regime shift within style
    if (styleSt.recentAvgPnlUsd < -2 && styleSt.avgPnlUsd > 0) {
      spotStyleSizeMults[style] *= 0.7;
      spotStyleStopMults[style] *= 0.85;
    }
  }

  // ── LP adaptations (Orca + EVM) ─────────────────────────────
  let lpRangeMult = 1.0;
  let lpMinAprAdj = 0;
  let lpRebalTriggerMult = 1.0;

  const orcaLp = lpStats['orca_lp'];
  const evmLp = lpStats['evm_lp'];
  const allLp = [orcaLp, evmLp].filter(Boolean);

  for (const lp of allLp) {
    if (!lp || lp.totalPositions < 3) continue;

    // If out-of-range rate is high (>40%), widen ranges
    if (lp.outOfRangeRate > 0.4) {
      lpRangeMult = Math.max(lpRangeMult, 1.3);
      lpRebalTriggerMult = Math.max(lpRebalTriggerMult, 0.8); // tighter rebalance trigger
    } else if (lp.outOfRangeRate < 0.15 && lp.avgPnlPerDayUsd > 0) {
      // Positions are staying in range AND profitable → tighten more aggressively
      // Narrower ranges = higher fee concentration. Allow down to 0.65× (was 0.85).
      lpRangeMult = Math.min(lpRangeMult, lp.outOfRangeRate < 0.05 ? 0.65 : 0.75);
    }

    // If avg PnL per day is negative, raise APR floor
    if (lp.avgPnlPerDayUsd < 0) {
      lpMinAprAdj = Math.max(lpMinAprAdj, 10);
    }
  }

  // ── LP pair intelligence (combined Orca + EVM) ──────────────
  // Merge bestPairs from both providers, deduplicate, rank by appearance
  const combinedBestPairs = new Map<string, number>(); // pair → priority (lower = better)
  let lpTotalPos = 0;
  for (const lp of allLp) {
    if (!lp) continue;
    lpTotalPos += lp.totalPositions;
    for (let i = 0; i < lp.bestPairs.length; i++) {
      const pair = lp.bestPairs[i].toUpperCase();
      const existing = combinedBestPairs.get(pair) ?? Infinity;
      combinedBestPairs.set(pair, Math.min(existing, i)); // keep best rank
    }
  }
  const lpBestPairsComputed = [...combinedBestPairs.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 10)
    .map(([pair]) => pair);

  // ── Per-tier LP adaptations (both Orca and EVM risk tiers) ─────────
  // Each tier learns independently: high-risk OOR doesn't widen low-risk ranges
  const lpTierRangeMultipliers: Record<string, number> = { low: 1.0, medium: 1.0, high: 1.0 };
  const lpTierMinAprAdjustments: Record<string, number> = { low: 0, medium: 0, high: 0 };

  for (const tier of ['low', 'medium', 'high'] as const) {
    // Merge Orca + EVM per-tier data for combined learning
    const orcaTier = lpStats[`orca_lp_${tier}`];
    const evmLpTier = lpStats[`evm_lp_${tier}`];

    // Use whichever has more data, or combine if both have enough
    const tierCandidates = [orcaTier, evmLpTier].filter(t => t && t.totalPositions >= 2);
    if (tierCandidates.length === 0) continue;

    // Average stats across both LP providers for this tier
    const avgOorRate = tierCandidates.reduce((s, t) => s + (t?.outOfRangeRate ?? 0), 0) / tierCandidates.length;
    const avgPnlPerDay = tierCandidates.reduce((s, t) => s + (t?.avgPnlPerDayUsd ?? 0), 0) / tierCandidates.length;

    // Tier-specific range adaptation
    if (avgOorRate > 0.5) {
      lpTierRangeMultipliers[tier] = 1.4; // frequent OOR → widen this tier's range
    } else if (avgOorRate > 0.3) {
      lpTierRangeMultipliers[tier] = 1.2;
    } else if (avgOorRate < 0.1 && avgPnlPerDay > 0) {
      // Positions are consistently in-range AND profitable → tighten aggressively
      // for this tier. Lower multiplier = narrower range = more fee concentration.
      lpTierRangeMultipliers[tier] = avgOorRate < 0.03 ? 0.6 : 0.75;
    }

    // Tier-specific APR floor
    if (avgPnlPerDay < -0.5) {
      lpTierMinAprAdjustments[tier] = 15; // losing money → demand much higher APR
    } else if (avgPnlPerDay < 0) {
      lpTierMinAprAdjustments[tier] = 5;
    }
  }

  // ── Kamino adaptations ──────────────────────────────────────────
  let kaminoLtvMult = 1.0;
  let kaminoSpreadMult = 1.0;
  const kaminoSt = stats['kamino'];

  // ── BorrowLP pipeline yield ─────────────────────────────────────
  // Measure net yield of the combined borrow → LP → fee → repay cycle.
  // Uses orca_lp positions that were opened via KAMINO_BORROW_LP (metadata.borrowLp=true)
  // Falls back to comparing LP PnL rate vs kamino borrow costs if no metadata tag.
  let borrowLpNetYieldComputed = 0;
  let borrowLpCycles = 0;
  const orcaLpForBorrow = lpStats['orca_lp'];
  if (orcaLpForBorrow && orcaLpForBorrow.totalPositions >= 1 && kaminoSt) {
    // LP daily yield minus annualized borrow cost
    // LP daily → annualized
    const lpAnnualYieldPct = orcaLpForBorrow.avgPnlPerDayUsd > 0
      ? (orcaLpForBorrow.avgPnlPerDayUsd * 365) / Math.max(1, orcaLpForBorrow.totalPositions * 50) // rough per-position annual yield
      : 0;
    // Kamino borrow cost approximation from trade data
    const borrowCostPct = kaminoSt.avgPnlUsd < 0
      ? Math.abs(kaminoSt.avgPnlUsd) * 365 / Math.max(1, kaminoSt.avgHoldHours / 24 * kaminoSt.totalTrades * 50)
      : 0.08; // default 8% if no loss data
    borrowLpNetYieldComputed = lpAnnualYieldPct - borrowCostPct;
    borrowLpCycles = orcaLpForBorrow.totalPositions;
  }

  // ── AAVE BorrowLP pipeline yield ────────────────────────────────
  // Mirrors the Kamino borrow-LP logic but for EVM LP positions funded by AAVE.
  let aaveBorrowLpNetYieldComputed = 0;
  let aaveBorrowLpCycles = 0;
  const evmLpForBorrow = lpStats['evm_lp'];
  if (evmLpForBorrow && evmLpForBorrow.totalPositions >= 1) {
    const lpAnnualYieldPct = evmLpForBorrow.avgPnlPerDayUsd > 0
      ? (evmLpForBorrow.avgPnlPerDayUsd * 365) / Math.max(1, evmLpForBorrow.totalPositions * 50)
      : 0;
    // AAVE borrow cost — use aave_borrow_lp strategy stats if available
    const aaveBorrowSt = stats['aave_borrow_lp'];
    const borrowCostPct = aaveBorrowSt && aaveBorrowSt.avgPnlUsd < 0
      ? Math.abs(aaveBorrowSt.avgPnlUsd) * 365 / Math.max(1, aaveBorrowSt.avgHoldHours / 24 * aaveBorrowSt.totalTrades * 50)
      : 0.06; // default 6% AAVE borrow rate
    aaveBorrowLpNetYieldComputed = lpAnnualYieldPct - borrowCostPct;
    aaveBorrowLpCycles = evmLpForBorrow.totalPositions;
  }

  // ── Reinvestment efficiency ──────────────────────────────────────
  // Track how many reinvestment sweeps have been executed via the 'reinvest' strategy tag.
  const reinvestSt = stats['reinvest'];
  const reinvestSweepCount = reinvestSt ? reinvestSt.totalTrades : 0;
  const reinvestEfficiency = reinvestSt && reinvestSt.totalTrades > 0
    ? Math.max(0, Math.min(1, reinvestSt.winRate))
    : 0.5; // neutral default

  if (kaminoSt && kaminoSt.totalTrades >= 3) {
    if (kaminoSt.maxDrawdownUsd < -20) {
      kaminoLtvMult = 0.8;
    }
    if (kaminoSt.winRate > 0.7 && kaminoSt.avgPnlUsd > 0) {
      kaminoLtvMult = 1.05;
    }
    // If avg PnL is negative, actual yield < projected → raise spread floor
    if (kaminoSt.avgPnlUsd < 0) {
      kaminoSpreadMult = 1.3; // demand 30% higher borrow spread
    }
  }

  // ── EVM Arb adaptations ─────────────────────────────────────────
  let evmArbMinProfitMult = 1.0;
  const arbSt = stats['evm_flash_arb'];
  const arbExec = feeStats.perStrategy['evm_flash_arb'];

  if (arbSt && arbSt.totalTrades >= 3) {
    // If arb trades are mostly losers (slippage eats profit), raise min threshold
    if (arbSt.winRate < 0.5 && arbSt.avgPnlUsd < 0) {
      evmArbMinProfitMult = 1.5; // demand 50% higher min profit
    } else if (arbSt.winRate > 0.7 && arbSt.avgPnlUsd > 0) {
      evmArbMinProfitMult = 0.8; // can be more aggressive
    }
  }
  if (arbExec && arbExec.failRate > 0.3) {
    evmArbMinProfitMult = Math.max(evmArbMinProfitMult, 1.5); // high fail rate → need bigger edge
  }

  // ── Strategy scoring (relative performance) ─────────────────────
  const strategyScores: Record<string, number> = {};
  for (const [name, st] of Object.entries(stats)) {
    if (st.totalTrades < MIN_TRADES_FOR_CONFIDENCE) {
      strategyScores[name] = 50;
    } else {
      let score = 50;
      score += st.sharpeApprox * 20;
      score += (st.winRate - 0.5) * 30;
      score += st.avgPnlUsd > 0 ? 10 : -10;
      score += (st.recentWinRate - st.winRate) * 20;
      // Penalize strategies with high execution failure
      const execInfo = feeStats.perStrategy[name];
      if (execInfo && execInfo.failRate > 0.15) {
        score -= 15;
      }
      strategyScores[name] = Math.max(0, Math.min(100, score));
    }
  }

  // ── Capital allocation weights from scores ──────────────────────
  const capitalWeights = computeCapitalWeights(strategyScores);

  // ── Global risk multiplier from regime ──────────────────────────
  let globalRisk = 1.0;
  if (portfolio.regimeSignal === 'risk-off') {
    globalRisk = 0.6; // 40% position size reduction across the board
  } else if (portfolio.regimeSignal === 'risk-on') {
    globalRisk = 1.15; // slightly more aggressive
  }

  // ── Confidence level (based on total sample size) ───────────────
  // Skip sub-strategies from total to avoid double-counting: hl_perp already
  // aggregates hl_perp_scalp/day/swing, and hl_spot aggregates hl_spot_swing/accumulation.
  const SUB_STRATEGIES = new Set(['hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing', 'hl_spot_swing', 'hl_spot_accumulation']);
  const totalSamples = Object.entries(stats)
    .filter(([name]) => !SUB_STRATEGIES.has(name))
    .reduce((s, [, st]) => s + st.totalTrades, 0);
  const confidence = Math.min(1, totalSamples / 50);

  // ── Execution failure rates ─────────────────────────────────────
  const executionFailRates: Record<string, number> = {};
  for (const [strat, info] of Object.entries(feeStats.perStrategy)) {
    executionFailRates[strat] = info.failRate;
  }

  // ── Blend with prior using EMA ──────────────────────────────────
  const sampleSizes: Record<string, number> = {};
  for (const [name, st] of Object.entries(stats)) {
    sampleSizes[name] = st.totalTrades;
  }

  const params: AdaptiveParams = {
    confidenceLevel: confidence,
    globalRiskMultiplier: blend(globalRisk, prior?.globalRiskMultiplier),
    kellyMultiplier: blend(kellyMult, prior?.kellyMultiplier),
    minEdgeOverride: blend(minEdgeOvr, prior?.minEdgeOverride),
    polyBetSizeMultiplier: blend(polyBetMult, prior?.polyBetSizeMultiplier),
    polyCooldownMultiplier: blend(polyCooldownMult, prior?.polyCooldownMultiplier),
    hlStopLossMultiplier: blend(hlStopMult, prior?.hlStopLossMultiplier),
    hlLeverageBias: blend(hlLevBias, prior?.hlLeverageBias),
    hlHedgeTargetMultiplier: blend(hlHedgeTargetMult, prior?.hlHedgeTargetMultiplier),
    hlRebalanceThresholdMultiplier: blend(hlRebalThreshMult, prior?.hlRebalanceThresholdMultiplier),
    hlPerpConvictionFloor: blend(perpConvFloor, prior?.hlPerpConvictionFloor),
    hlPerpSizeMultiplier: blend(perpSizeMult, prior?.hlPerpSizeMultiplier),
    hlPerpStopLossMultiplier: blend(perpStopMult, prior?.hlPerpStopLossMultiplier),
    hlPerpMaxPositionsAdj: blend(perpMaxPosAdj, prior?.hlPerpMaxPositionsAdj),
    hlPerpStyleSizeMultipliers: {
      scalp: blend(perpStyleSizeMults.scalp, prior?.hlPerpStyleSizeMultipliers?.scalp),
      day: blend(perpStyleSizeMults.day, prior?.hlPerpStyleSizeMultipliers?.day),
      swing: blend(perpStyleSizeMults.swing, prior?.hlPerpStyleSizeMultipliers?.swing),
    },
    hlPerpStyleStopMultipliers: {
      scalp: blend(perpStyleStopMults.scalp, prior?.hlPerpStyleStopMultipliers?.scalp),
      day: blend(perpStyleStopMults.day, prior?.hlPerpStyleStopMultipliers?.day),
      swing: blend(perpStyleStopMults.swing, prior?.hlPerpStyleStopMultipliers?.swing),
    },
    hlPerpStyleConvictionFloors: {
      scalp: blend(perpStyleConvFloors.scalp, prior?.hlPerpStyleConvictionFloors?.scalp),
      day: blend(perpStyleConvFloors.day, prior?.hlPerpStyleConvictionFloors?.day),
      swing: blend(perpStyleConvFloors.swing, prior?.hlPerpStyleConvictionFloors?.swing),
    },
    hlPerpStyleLeverageMultipliers: {
      scalp: blend(perpStyleLevMults.scalp, prior?.hlPerpStyleLeverageMultipliers?.scalp),
      day: blend(perpStyleLevMults.day, prior?.hlPerpStyleLeverageMultipliers?.day),
      swing: blend(perpStyleLevMults.swing, prior?.hlPerpStyleLeverageMultipliers?.swing),
    },
    hlPerpSessionDampeningMult: blend(sessionDampMult, prior?.hlPerpSessionDampeningMult),
    hlSpotConvictionFloor: blend(spotConvFloor, prior?.hlSpotConvictionFloor),
    hlSpotSizeMultiplier: blend(spotSizeMult, prior?.hlSpotSizeMultiplier),
    hlSpotStopLossMultiplier: blend(spotStopMult, prior?.hlSpotStopLossMultiplier),
    hlSpotMaxPositionsAdj: blend(spotMaxPosAdj, prior?.hlSpotMaxPositionsAdj),
    hlSpotStyleSizeMultipliers: {
      day: blend(spotStyleSizeMults.day, prior?.hlSpotStyleSizeMultipliers?.day),
      swing: blend(spotStyleSizeMults.swing, prior?.hlSpotStyleSizeMultipliers?.swing),
      accumulation: blend(spotStyleSizeMults.accumulation, prior?.hlSpotStyleSizeMultipliers?.accumulation),
    },
    hlSpotStyleStopMultipliers: {
      day: blend(spotStyleStopMults.day, prior?.hlSpotStyleStopMultipliers?.day),
      swing: blend(spotStyleStopMults.swing, prior?.hlSpotStyleStopMultipliers?.swing),
      accumulation: blend(spotStyleStopMults.accumulation, prior?.hlSpotStyleStopMultipliers?.accumulation),
    },
    hlSpotStyleConvictionFloors: {
      day: blend(spotStyleConvFloors.day, prior?.hlSpotStyleConvictionFloors?.day),
      swing: blend(spotStyleConvFloors.swing, prior?.hlSpotStyleConvictionFloors?.swing),
      accumulation: blend(spotStyleConvFloors.accumulation, prior?.hlSpotStyleConvictionFloors?.accumulation),
    },
    lpRangeWidthMultiplier: blend(lpRangeMult, prior?.lpRangeWidthMultiplier),
    lpMinAprAdjustment: blend(lpMinAprAdj, prior?.lpMinAprAdjustment),
    lpRebalanceTriggerMultiplier: blend(lpRebalTriggerMult, prior?.lpRebalanceTriggerMultiplier),
    lpTierRangeMultipliers: {
      low: blend(lpTierRangeMultipliers.low, prior?.lpTierRangeMultipliers?.low),
      medium: blend(lpTierRangeMultipliers.medium, prior?.lpTierRangeMultipliers?.medium),
      high: blend(lpTierRangeMultipliers.high, prior?.lpTierRangeMultipliers?.high),
    },
    lpTierMinAprAdjustments: {
      low: blend(lpTierMinAprAdjustments.low, prior?.lpTierMinAprAdjustments?.low),
      medium: blend(lpTierMinAprAdjustments.medium, prior?.lpTierMinAprAdjustments?.medium),
      high: blend(lpTierMinAprAdjustments.high, prior?.lpTierMinAprAdjustments?.high),
    },
    lpBestPairs: lpBestPairsComputed,
    lpTotalPositions: lpTotalPos,
    kaminoLtvMultiplier: blend(kaminoLtvMult, prior?.kaminoLtvMultiplier),
    kaminoSpreadFloorMultiplier: blend(kaminoSpreadMult, prior?.kaminoSpreadFloorMultiplier),
    borrowLpNetYield: blend(borrowLpNetYieldComputed, prior?.borrowLpNetYield),
    borrowLpCycleCount: borrowLpCycles,
    aaveBorrowLpNetYield: blend(aaveBorrowLpNetYieldComputed, prior?.aaveBorrowLpNetYield),
    aaveBorrowLpCycleCount: aaveBorrowLpCycles,
    reinvestEfficiency: blend(reinvestEfficiency, prior?.reinvestEfficiency),
    reinvestSweepCount: reinvestSweepCount,
    evmArbMinProfitMultiplier: blend(evmArbMinProfitMult, prior?.evmArbMinProfitMultiplier),
    feeDragPct: feeStats.feeDragPct,
    executionFailRates,
    strategyScores,
    capitalWeights,
    portfolioSharpe: portfolio.sharpe,
    portfolioMaxDrawdownPct: portfolio.maxDrawdownPct,
    regimeSignal: portfolio.regimeSignal,
    alerts: [], // populated later by detectDriftAlerts
    sampleSizes,
    lastComputed: Date.now(),
  };

  // Generate alerts (needs the params object built first)
  params.alerts = detectDriftAlerts(params, prior, stats, feeStats);

  return params;
}

// ============================================================================
// Persistence (kv_store)
// ============================================================================

async function loadPrior(pool: any): Promise<AdaptiveParams | null> {
  try {
    const res = await pool.query(
      `SELECT data FROM kv_store WHERE key = $1`,
      [KV_KEY],
    );
    if (res.rows.length > 0) {
      return res.rows[0].data as AdaptiveParams;
    }
  } catch { /* first run — no prior */ }
  return null;
}

async function saveLearned(pool: any, params: AdaptiveParams): Promise<void> {
  try {
    // Save current params (latest)
    await pool.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [KV_KEY, JSON.stringify(params)],
    );

    // Save historical daily snapshot for trend analysis
    const dateKey = `${KV_KEY}_${new Date().toISOString().slice(0, 10)}`;
    await pool.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [dateKey, JSON.stringify(params)],
    ).catch(() => { /* non-critical */ });
  } catch (err) {
    logger.debug('[Learning] Failed to persist params:', err);
  }
}

// ============================================================================
// Public API
// ============================================================================

/** In-memory cache refreshed each cycle */
let _cachedParams: AdaptiveParams | null = null;
let _lastRefreshMs = 0;
let _lastAlertFingerprint = ''; // dedup: only log alerts when they change
const REFRESH_INTERVAL_MS = 15 * 60_000; // 15 min

/**
 * Run the learning retrospective and return adaptive parameters.
 * Called once per decision cycle. Results are cached for 15 min.
 */
export async function refreshLearning(pool?: any): Promise<AdaptiveParams> {
  // Skip if recently refreshed
  if (_cachedParams && Date.now() - _lastRefreshMs < REFRESH_INTERVAL_MS) {
    return _cachedParams;
  }

  const dbPool = pool ?? _pool;
  if (!dbPool) {
    logger.debug('[Learning] No DB pool available — using neutral params');
    return getDefaultParams();
  }

  try {
    // 1. Load prior parameters (for EMA blending)
    const prior = await loadPrior(dbPool);

    // 2. Compute stats for each strategy
    const strategies = ['polymarket', 'hyperliquid', 'hl_perp', 'hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing', 'hl_spot', 'hl_spot_swing', 'hl_spot_accumulation', 'kamino', 'jito', 'orca_lp', 'evm_lp', 'evm_flash_arb'];
    const statsEntries = await Promise.all(
      strategies.map(async s => [s, await computeStrategyStats(dbPool, s)] as const),
    );
    const stats: Record<string, StrategyStats> = Object.fromEntries(statsEntries);

    // 3. LP-specific stats (aggregate + per-tier for both Orca and EVM)
    const [
      orcaLpStats, orcaLow, orcaMed, orcaHigh,
      evmLpStats, evmLpLow, evmLpMed, evmLpHigh,
    ] = await Promise.all([
      computeLPStats(dbPool, 'orca_lp'),
      computeLPStats(dbPool, 'orca_lp', 'low'),
      computeLPStats(dbPool, 'orca_lp', 'medium'),
      computeLPStats(dbPool, 'orca_lp', 'high'),
      computeLPStats(dbPool, 'evm_lp'),
      computeLPStats(dbPool, 'evm_lp', 'low'),
      computeLPStats(dbPool, 'evm_lp', 'medium'),
      computeLPStats(dbPool, 'evm_lp', 'high'),
    ]);
    const lpStats: Record<string, LPStats> = {
      orca_lp: orcaLpStats,
      orca_lp_low: orcaLow,
      orca_lp_medium: orcaMed,
      orca_lp_high: orcaHigh,
      evm_lp: evmLpStats,
      evm_lp_low: evmLpLow,
      evm_lp_medium: evmLpMed,
      evm_lp_high: evmLpHigh,
    };

    // 4. Polymarket calibration
    const polyCal = await computePolyCalibration(dbPool);

    // 5. Fee-drag & execution quality
    const feeStats = await computeFeeAndExecStats(dbPool);

    // 6. Portfolio-level intelligence (regime detection, Sharpe)
    const portfolio = await computePortfolioStats(dbPool, stats);

    // 6b. Session activity dampening — compare quiet vs active perp trades
    let sessionDampMult = 1.0;
    try {
      const sessionRes = await dbPool.query(
        `SELECT
           metadata->>'sessionQuiet' AS session_quiet,
           COUNT(*) AS cnt,
           AVG(realized_pnl_usd) AS avg_pnl,
           SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS wr
         FROM cfo_positions
         WHERE strategy LIKE 'hl_perp%' AND status = 'CLOSED'
           AND closed_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
           AND metadata->>'sessionQuiet' IS NOT NULL
         GROUP BY metadata->>'sessionQuiet'`,
      );
      const quietRow = sessionRes.rows.find((r: any) => r.session_quiet === 'true');
      const activeRow = sessionRes.rows.find((r: any) => r.session_quiet === 'false');
      if (quietRow && Number(quietRow.cnt) >= 3 && activeRow && Number(activeRow.cnt) >= 3) {
        const quietWR = Number(quietRow.wr);
        const quietPnl = Number(quietRow.avg_pnl);
        const activeWR = Number(activeRow.wr);
        const activePnl = Number(activeRow.avg_pnl);
        if (quietWR < activeWR - 0.10 || (quietPnl < 0 && activePnl > 0)) {
          const wrGap = Math.max(0, activeWR - quietWR);
          sessionDampMult = Math.min(1.5, 1.0 + wrGap * 2);
        } else if (quietWR >= activeWR - 0.02 && quietPnl >= 0) {
          sessionDampMult = 0.7;
        }
        logger.debug(
          `[Learning] Session gate: quiet(${quietRow.cnt} trades, WR=${(quietWR * 100).toFixed(0)}%, avg=$${quietPnl.toFixed(2)}) ` +
          `vs active(${activeRow.cnt} trades, WR=${(activeWR * 100).toFixed(0)}%, avg=$${activePnl.toFixed(2)}) → damp×${sessionDampMult.toFixed(2)}`,
        );
      }
    } catch {
      // Non-fatal — session metadata may not exist yet on early trades
    }

    // 7. Compute adaptive params (now with fee + portfolio inputs)
    const params = computeAdaptiveParams(stats, lpStats, polyCal, prior, feeStats, portfolio, sessionDampMult);

    // 8. Persist (current + daily snapshot)
    await saveLearned(dbPool, params);

    // 9. Log summary
    const totalTrades = Object.values(stats).reduce((s, st) => s + st.totalTrades, 0);
    const topStrategy = Object.entries(params.strategyScores)
      .sort(([, a], [, b]) => b - a)[0];

    logger.info(
      `[Learning] Retrospective: ${totalTrades} trades | ` +
      `confidence: ${(params.confidenceLevel * 100).toFixed(0)}% | ` +
      `regime: ${params.regimeSignal} | ` +
      `risk×${params.globalRiskMultiplier.toFixed(2)} | ` +
      `kelly×${params.kellyMultiplier.toFixed(2)} | ` +
      `hlStop×${params.hlStopLossMultiplier.toFixed(2)} | ` +
      `hedge×${params.hlHedgeTargetMultiplier.toFixed(2)} | ` +
      `perpSize×${params.hlPerpSizeMultiplier.toFixed(2)} | ` +
      `perpSL×${params.hlPerpStopLossMultiplier.toFixed(2)} | ` +
      `perpStyles: S×${params.hlPerpStyleSizeMultipliers?.scalp?.toFixed(2) ?? '1'} D×${params.hlPerpStyleSizeMultipliers?.day?.toFixed(2) ?? '1'} W×${params.hlPerpStyleSizeMultipliers?.swing?.toFixed(2) ?? '1'} | ` +
      `sessionDamp×${params.hlPerpSessionDampeningMult.toFixed(2)} | ` +
      `spotSize×${params.hlSpotSizeMultiplier.toFixed(2)} spotSL×${params.hlSpotStopLossMultiplier.toFixed(2)} | ` +
      `spotStyles: D×${params.hlSpotStyleSizeMultipliers?.day?.toFixed(2) ?? '1'} W×${params.hlSpotStyleSizeMultipliers?.swing?.toFixed(2) ?? '1'} A×${params.hlSpotStyleSizeMultipliers?.accumulation?.toFixed(2) ?? '1'} | ` +
      `lpRange×${params.lpRangeWidthMultiplier.toFixed(2)} | ` +
      `lpTiers: L×${params.lpTierRangeMultipliers.low?.toFixed(2) ?? '1'} M×${params.lpTierRangeMultipliers.medium?.toFixed(2) ?? '1'} H×${params.lpTierRangeMultipliers.high?.toFixed(2) ?? '1'} | ` +
      `arbMin×${params.evmArbMinProfitMultiplier.toFixed(2)} | ` +
      `feeDrag=${params.feeDragPct.toFixed(1)}% | ` +
      `pSharpe=${params.portfolioSharpe.toFixed(2)} | ` +
      `best: ${topStrategy?.[0] ?? 'n/a'}(${topStrategy?.[1]?.toFixed(0) ?? '?'})`,
    );

    // Log alerts — deduplicated so the same alerts don't spam every cycle.
    // Only log if alerts changed from last cycle.
    const alertFingerprint = params.alerts.join('|');
    if (params.alerts.length > 0 && alertFingerprint !== _lastAlertFingerprint) {
      logger.warn(`[Learning] 🚨 ALERTS (${params.alerts.length}):`);
      for (const alert of params.alerts) {
        logger.warn(`[Learning]   ${alert}`);
      }
      // Only forward truly new alerts to admin TG (not repeat degradation notices)
      const criticalAlerts = params.alerts.filter(a => a.includes('🔴') || a.includes('💸'));
      if (criticalAlerts.length > 0) {
        try {
          const { notifyAdmin } = await import('../services/adminNotify.ts');
          const alertMsg = `🧠 *Learning Alerts:*\n${criticalAlerts.map(a => `  • ${a}`).join('\n')}`;
          await notifyAdmin(alertMsg, 'system');
        } catch { /* non-fatal */ }
      }
    } else if (params.alerts.length > 0) {
      // Same alerts as last cycle — log at debug to reduce spam
      logger.debug(`[Learning] Alerts unchanged (${params.alerts.length}) — suppressing repeat log`);
    }
    _lastAlertFingerprint = alertFingerprint;

    // Log per-strategy detail at debug level
    for (const [name, st] of Object.entries(stats)) {
      if (st.totalTrades > 0) {
        logger.debug(
          `[Learning]   ${name}: ${st.totalTrades} trades | ` +
          `WR=${(st.winRate * 100).toFixed(0)}% | ` +
          `avgPnL=$${st.avgPnlUsd.toFixed(2)} | ` +
          `Sharpe=${st.sharpeApprox.toFixed(2)} | ` +
          `recentWR=${(st.recentWinRate * 100).toFixed(0)}%`,
        );
      }
    }

    _cachedParams = params;
    _lastRefreshMs = Date.now();
    return params;
  } catch (err) {
    logger.error('[Learning] Retrospective failed (using defaults):', err);
    const fallback = await loadPrior(dbPool).catch(() => null);
    return fallback ?? getDefaultParams();
  }
}

/**
 * Get current adaptive params without triggering a refresh.
 * Returns cached or default.
 */
export function getAdaptiveParams(): AdaptiveParams {
  return _cachedParams ?? getDefaultParams();
}

/**
 * Neutral defaults (no adaptation — multiply by 1.0).
 */
export function getDefaultParams(): AdaptiveParams {
  return {
    confidenceLevel: 0,
    globalRiskMultiplier: 1.0,
    kellyMultiplier: 1.0,
    minEdgeOverride: 0.05,
    polyBetSizeMultiplier: 1.0,
    polyCooldownMultiplier: 1.0,
    hlStopLossMultiplier: 1.0,
    hlLeverageBias: 0,
    hlHedgeTargetMultiplier: 1.0,
    hlRebalanceThresholdMultiplier: 1.0,
    hlPerpConvictionFloor: 0,
    hlPerpSizeMultiplier: 1.0,
    hlPerpStopLossMultiplier: 1.0,
    hlPerpMaxPositionsAdj: 0,
    hlPerpStyleSizeMultipliers: { scalp: 1.0, day: 1.0, swing: 1.0 },
    hlPerpStyleStopMultipliers: { scalp: 1.0, day: 1.0, swing: 1.0 },
    hlPerpStyleConvictionFloors: { scalp: 0, day: 0, swing: 0 },
    hlPerpStyleLeverageMultipliers: { scalp: 1.0, day: 1.0, swing: 1.0 },
    hlPerpSessionDampeningMult: 1.0,
    hlSpotConvictionFloor: 0,
    hlSpotSizeMultiplier: 1.0,
    hlSpotStopLossMultiplier: 1.0,
    hlSpotMaxPositionsAdj: 0,
    hlSpotStyleSizeMultipliers: { day: 1.0, swing: 1.0, accumulation: 1.0 },
    hlSpotStyleStopMultipliers: { day: 1.0, swing: 1.0, accumulation: 1.0 },
    hlSpotStyleConvictionFloors: { day: 0, swing: 0, accumulation: 0 },
    lpRangeWidthMultiplier: 1.0,
    lpMinAprAdjustment: 0,
    lpRebalanceTriggerMultiplier: 1.0,
    lpTierRangeMultipliers: { low: 1.0, medium: 1.0, high: 1.0 },
    lpTierMinAprAdjustments: { low: 0, medium: 0, high: 0 },
    lpBestPairs: [],
    lpTotalPositions: 0,
    kaminoLtvMultiplier: 1.0,
    kaminoSpreadFloorMultiplier: 1.0,
    borrowLpNetYield: 0,
    borrowLpCycleCount: 0,
    aaveBorrowLpNetYield: 0,
    aaveBorrowLpCycleCount: 0,
    reinvestEfficiency: 0.5,
    reinvestSweepCount: 0,
    evmArbMinProfitMultiplier: 1.0,
    feeDragPct: 0,
    executionFailRates: {},
    strategyScores: {},
    capitalWeights: {},
    portfolioSharpe: 0,
    portfolioMaxDrawdownPct: 0,
    regimeSignal: 'neutral',
    alerts: [],
    sampleSizes: {},
    lastComputed: 0,
  };
}

/**
 * Apply confidence-weighted blending.
 * At 0% confidence → returns baseValue unchanged.
 * At 100% confidence → fully applies adaptive multiplier.
 */
export function applyAdaptive(
  baseValue: number,
  multiplier: number,
  confidence: number,
): number {
  const effectiveMultiplier = 1.0 + (multiplier - 1.0) * confidence;
  return baseValue * effectiveMultiplier;
}

/**
 * Format a human-readable learning summary for admin reports.
 */
export function formatLearningSummary(params: AdaptiveParams): string {
  if (params.lastComputed === 0) return '🧠 <b>Learning:</b> No data yet — need 5+ closed trades to start adapting.';

  // Skip sub-strategies from total — they're already included in their parent aggregates
  const _subStrats = new Set(['hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing', 'hl_spot_swing', 'hl_spot_accumulation']);
  const totalSamples = Object.entries(params.sampleSizes)
    .filter(([name]) => !_subStrats.has(name))
    .reduce((s, [, n]) => s + n, 0);
  const L: string[] = [];

  // Header with overall confidence
  const confPct = (params.confidenceLevel * 100).toFixed(0);
  const confLabel = params.confidenceLevel >= 0.7 ? 'high' : params.confidenceLevel >= 0.4 ? 'moderate' : 'low';
  L.push(`━━━ <b>Learning</b> ━━━`);
  L.push(`   ${totalSamples} trades analysed · ${confLabel} confidence (${confPct}%) · ${params.regimeSignal} regime`);

  // Portfolio performance
  const sharpeLabel = params.portfolioSharpe >= 1.5 ? '(excellent)' : params.portfolioSharpe >= 1.0 ? '(good)' : params.portfolioSharpe >= 0.5 ? '(fair)' : params.portfolioSharpe >= 0 ? '(poor)' : '(losing)';
  const ddLabel = params.portfolioMaxDrawdownPct <= 0.1 ? '' : params.portfolioMaxDrawdownPct <= 0.25 ? '' : params.portfolioMaxDrawdownPct <= 0.4 ? ' ⚠️' : ' 🔴';
  L.push(`   Performance: Sharpe ${params.portfolioSharpe.toFixed(2)} ${sharpeLabel} · max drawdown ${(params.portfolioMaxDrawdownPct * 100).toFixed(0)}%${ddLabel}`);

  // Best/worst strategies with names expanded
  const stratNameMap: Record<string, string> = {
    hyperliquid: 'HL Hedge', hl_perp: 'HL Perps',
    hl_perp_scalp: 'HL Scalp', hl_perp_day: 'HL Day', hl_perp_swing: 'HL Swing',
    hl_spot: 'HL Spot', hl_spot_swing: 'HL Spot Swing', hl_spot_accumulation: 'HL Spot Accum',
    kamino: 'Kamino', jito: 'Jito Staking',
    orca_lp: 'Orca LP', evm_lp: 'EVM LP', evm_flash_arb: 'Arb Scanner',
    polymarket: 'Polymarket',
  };
  const sorted = Object.entries(params.strategyScores)
    .filter(([name]) => (params.sampleSizes[name] ?? 0) > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length > 0) {
    const best = sorted[0];
    const bestName = stratNameMap[best[0]] ?? best[0];
    const bestTrades = params.sampleSizes[best[0]] ?? 0;
    L.push(`   Best strategy: ${bestName} (score ${best[1].toFixed(0)}/100, ${bestTrades} trades)`);
    if (sorted.length > 1) {
      const worst = sorted[sorted.length - 1];
      const worstName = stratNameMap[worst[0]] ?? worst[0];
      const worstTrades = params.sampleSizes[worst[0]] ?? 0;
      if (worst[1] < 30) {
        L.push(`   Worst strategy: ${worstName} (score ${worst[1].toFixed(0)}/100, ${worstTrades} trades)`);
      }
    }
  }

  // Per-style HL perp breakdown (if any style-tagged trades exist)
  const perpStyleBreakdown = ['scalp', 'day', 'swing']
    .map(s => ({ style: s, n: params.sampleSizes[`hl_perp_${s}`] ?? 0 }))
    .filter(s => s.n > 0);
  if (perpStyleBreakdown.length > 0) {
    const perpTotal = params.sampleSizes['hl_perp'] ?? 0;
    const breakdown = perpStyleBreakdown.map(s => `${s.style}=${s.n}`).join(' · ');
    L.push(`   HL Perps: ${perpTotal} total (${breakdown})`);
  }

  // Active adjustments — explained in plain English
  const adj: string[] = [];
  if (Math.abs(params.kellyMultiplier - 1) > 0.05) {
    const dir = params.kellyMultiplier > 1 ? 'Increased' : 'Reduced';
    adj.push(`${dir} bet sizing to ${(params.kellyMultiplier * 100).toFixed(0)}%`);
  }
  if (Math.abs(params.hlStopLossMultiplier - 1) > 0.05) {
    adj.push(`Stop losses ${params.hlStopLossMultiplier > 1 ? 'widened' : 'tightened'}`);
  }
  if (Math.abs(params.hlHedgeTargetMultiplier - 1) > 0.05) {
    adj.push(`Hedge target ${params.hlHedgeTargetMultiplier > 1 ? 'increased' : 'decreased'}`);
  }
  // Per-style perp adjustments
  if (params.hlPerpStyleSizeMultipliers) {
    const styleAdj: string[] = [];
    for (const [style, mult] of Object.entries(params.hlPerpStyleSizeMultipliers)) {
      if (Math.abs(mult - 1) > 0.05) {
        styleAdj.push(`${style} size ×${mult.toFixed(2)}`);
      }
    }
    for (const [style, mult] of Object.entries(params.hlPerpStyleStopMultipliers ?? {})) {
      if (Math.abs(mult - 1) > 0.05) {
        styleAdj.push(`${style} SL ×${mult.toFixed(2)}`);
      }
    }
    if (styleAdj.length > 0) adj.push(`Perp styles: ${styleAdj.join(', ')}`);
  }
  // Session activity dampening
  if (Math.abs(params.hlPerpSessionDampeningMult - 1) > 0.05) {
    const dir = params.hlPerpSessionDampeningMult > 1 ? 'Quiet-hour dampening increased' : 'Quiet-hour dampening relaxed';
    adj.push(`${dir} (×${params.hlPerpSessionDampeningMult.toFixed(2)})`);
  }
  // Per-style spot adjustments
  if (params.hlSpotStyleSizeMultipliers) {
    const spotAdj: string[] = [];
    for (const [style, mult] of Object.entries(params.hlSpotStyleSizeMultipliers)) {
      if (Math.abs(mult - 1) > 0.05) {
        spotAdj.push(`${style} size ×${mult.toFixed(2)}`);
      }
    }
    for (const [style, mult] of Object.entries(params.hlSpotStyleStopMultipliers ?? {})) {
      if (Math.abs(mult - 1) > 0.05) {
        spotAdj.push(`${style} SL ×${mult.toFixed(2)}`);
      }
    }
    if (spotAdj.length > 0) adj.push(`Spot styles: ${spotAdj.join(', ')}`);
  }
  if (Math.abs(params.lpRangeWidthMultiplier - 1) > 0.05) {
    adj.push(`LP ranges ${params.lpRangeWidthMultiplier > 1 ? 'widened' : 'tightened'}`);
  }
  if (params.lpMinAprAdjustment > 0) {
    adj.push(`Min APR raised by ${params.lpMinAprAdjustment.toFixed(0)}%`);
  }
  // Per-tier LP adjustments
  if (params.lpTierRangeMultipliers) {
    const tierAdj: string[] = [];
    for (const [tier, mult] of Object.entries(params.lpTierRangeMultipliers)) {
      if (Math.abs(mult - 1) > 0.05) {
        tierAdj.push(`${tier} ×${mult.toFixed(2)}`);
      }
    }
    if (tierAdj.length > 0) adj.push(`LP tier ranges: ${tierAdj.join(', ')}`);
  }
  if (Math.abs(params.evmArbMinProfitMultiplier - 1) > 0.05) {
    adj.push(`Arb min profit ${params.evmArbMinProfitMultiplier > 1 ? 'raised' : 'lowered'}`);
  }
  if (params.globalRiskMultiplier < 0.9) {
    adj.push(`🛡️ Risk-off mode (×${params.globalRiskMultiplier.toFixed(2)})`);
  } else if (params.globalRiskMultiplier > 1.1) {
    adj.push(`🚀 Risk-on mode (×${params.globalRiskMultiplier.toFixed(2)})`);
  }
  if (params.feeDragPct > 1) {
    adj.push(`Fees eating ${params.feeDragPct.toFixed(1)}% of returns`);
  }

  if (adj.length > 0) {
    L.push(`   Adjustments: ${adj.join(' · ')}`);
  }

  // Capital allocation — only if not equal
  const weightEntries = Object.entries(params.capitalWeights)
    .filter(([, w]) => w > 0.05)
    .sort(([, a], [, b]) => b - a);
  const allEqual = weightEntries.length > 0 && weightEntries.every(([, w]) => Math.abs(w - weightEntries[0][1]) < 0.02);
  if (weightEntries.length > 0 && !allEqual) {
    L.push(`   Capital split: ${weightEntries.map(([n, w]) => `${stratNameMap[n] ?? n} ${(w * 100).toFixed(0)}%`).join(', ')}`);
  } else if (weightEntries.length > 0) {
    L.push(`   Capital split: equal across ${weightEntries.length} strategies (not enough data to optimise)`);
  }

  // Alerts — with clearer language
  if (params.alerts.length > 0) {
    L.push('');
    for (const alert of params.alerts.slice(0, 3)) {
      L.push(`   ⚠️ ${alert}`);
    }
    if (params.alerts.length > 3) {
      L.push(`   ... +${params.alerts.length - 3} more`);
    }
  }

  return L.join('\n');
}
