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
 *   - krystal_lp  → range width multiplier, chain preference, APR floor
 *   - kamino      → LTV target, borrow spread threshold
 *   - jito        → stake/unstake aggressiveness
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
  strategy: 'orca_lp' | 'krystal_lp';
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

  // Hyperliquid
  hlStopLossMultiplier: number; // tighter/wider stop loss (< 1 = tighter)
  hlLeverageBias: number;       // -1 to +1 adjustment on max leverage
  hlHedgeTargetMultiplier: number; // scale hedge target ratio based on hedge performance
  hlRebalanceThresholdMultiplier: number; // wider if frequent rebalance = churn losses

  // LP (Orca + Krystal) — global
  lpRangeWidthMultiplier: number;  // wider/narrower ranges based on rebalance frequency
  lpMinAprAdjustment: number;      // increase min APR floor if LP positions underperform
  lpRebalanceTriggerMultiplier: number; // tighter if OOR rate high, looser if profitable

  // LP per-risk-tier overrides (multiplied on top of the relevant tier's base range)
  lpTierRangeMultipliers: Record<string, number>;   // { low: 1.0, medium: 1.0, high: 1.3 }
  lpTierMinAprAdjustments: Record<string, number>;  // per-tier APR floor nudges

  // Kamino
  kaminoLtvMultiplier: number;     // tighten/loosen LTV target
  kaminoSpreadFloorMultiplier: number; // raise spread floor if actual yield < projected

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
    // All closed positions for this strategy within lookback
    const res = await pool.query(
      `SELECT realized_pnl_usd, cost_basis_usd,
              EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600 AS hold_hours,
              closed_at
       FROM cfo_positions
       WHERE strategy = $1 AND status = 'CLOSED'
         AND closed_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY closed_at DESC`,
      [strategy],
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
  strategy: 'orca_lp' | 'krystal_lp',
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
    ];

    for (const [name, curr, prev] of drifts) {
      if (prev === 0) continue;
      const changePct = Math.abs((curr - prev) / prev) * 100;
      if (changePct > 30) {
        const dir = curr > prev ? '↑' : '↓';
        alerts.push(`${dir} ${name} shifted ${changePct.toFixed(0)}% (${prev.toFixed(2)} → ${curr.toFixed(2)})`);
      }
    }
  }

  // Strategy degradation alerts
  for (const [name, st] of Object.entries(strategyStats)) {
    if (st.totalTrades < MIN_TRADES_FOR_CONFIDENCE) continue;

    const score = current.strategyScores[name] ?? 50;
    if (score < 25) {
      alerts.push(
        `⚠️ ${name} degraded: score=${score.toFixed(0)}, ` +
        `WR=${(st.winRate * 100).toFixed(0)}%, Sharpe=${st.sharpeApprox.toFixed(2)}, ` +
        `avgPnL=$${st.avgPnlUsd.toFixed(2)} — consider pausing`,
      );
    }

    // Recent regime shift warning
    if (st.recentWinRate < st.winRate - 0.2) {
      alerts.push(
        `📉 ${name} regime shift: recent WR ${(st.recentWinRate * 100).toFixed(0)}% vs ` +
        `overall ${(st.winRate * 100).toFixed(0)}% — deteriorating`,
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
    // If max drawdown is severe relative to avg PnL, tighten stops
    if (hlSt.maxDrawdownUsd < -50 && Math.abs(hlSt.maxDrawdownUsd) > hlSt.avgPnlUsd * 5) {
      hlStopMult = 0.7;
    }

    // If win rate is high with positive Sharpe, slightly loosen
    if (hlSt.winRate > 0.6 && hlSt.sharpeApprox > 0.3) {
      hlStopMult = 1.15;
    }

    // Leverage bias: negative avg PnL → reduce leverage
    if (hlSt.avgPnlUsd < -2) hlLevBias = -0.5;
    else if (hlSt.avgPnlUsd > 5 && hlSt.sharpeApprox > 0.5) hlLevBias = 0.3;

    // Recent regime shift
    if (hlSt.recentAvgPnlUsd < 0 && hlSt.avgPnlUsd > 0) {
      hlStopMult *= 0.8;
      hlLevBias -= 0.3;
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

  // ── LP adaptations (Orca + Krystal) ─────────────────────────────
  let lpRangeMult = 1.0;
  let lpMinAprAdj = 0;
  let lpRebalTriggerMult = 1.0;

  const orcaLp = lpStats['orca_lp'];
  const krystalLp = lpStats['krystal_lp'];
  const allLp = [orcaLp, krystalLp].filter(Boolean);

  for (const lp of allLp) {
    if (!lp || lp.totalPositions < 3) continue;

    // If out-of-range rate is high (>40%), widen ranges
    if (lp.outOfRangeRate > 0.4) {
      lpRangeMult = Math.max(lpRangeMult, 1.3);
      lpRebalTriggerMult = Math.max(lpRebalTriggerMult, 0.8); // tighter rebalance trigger
    } else if (lp.outOfRangeRate < 0.15 && lp.avgPnlPerDayUsd > 0) {
      lpRangeMult = Math.min(lpRangeMult, 0.85);
    }

    // If avg PnL per day is negative, raise APR floor
    if (lp.avgPnlPerDayUsd < 0) {
      lpMinAprAdj = Math.max(lpMinAprAdj, 10);
    }
  }

  // ── Per-tier LP adaptations (Krystal risk tiers) ────────────────
  // Each tier learns independently: high-risk OOR doesn't widen low-risk ranges
  const lpTierRangeMultipliers: Record<string, number> = { low: 1.0, medium: 1.0, high: 1.0 };
  const lpTierMinAprAdjustments: Record<string, number> = { low: 0, medium: 0, high: 0 };

  for (const tier of ['low', 'medium', 'high'] as const) {
    const tierLp = lpStats[`krystal_lp_${tier}`];
    if (!tierLp || tierLp.totalPositions < 2) continue;

    // Tier-specific range adaptation
    if (tierLp.outOfRangeRate > 0.5) {
      lpTierRangeMultipliers[tier] = 1.4; // frequent OOR → widen this tier's range
    } else if (tierLp.outOfRangeRate > 0.3) {
      lpTierRangeMultipliers[tier] = 1.2;
    } else if (tierLp.outOfRangeRate < 0.1 && tierLp.avgPnlPerDayUsd > 0) {
      lpTierRangeMultipliers[tier] = 0.85; // always in range + profitable → tighten for more fees
    }

    // Tier-specific APR floor
    if (tierLp.avgPnlPerDayUsd < -0.5) {
      lpTierMinAprAdjustments[tier] = 15; // losing money → demand much higher APR
    } else if (tierLp.avgPnlPerDayUsd < 0) {
      lpTierMinAprAdjustments[tier] = 5;
    }
  }

  // ── Kamino adaptations ──────────────────────────────────────────
  let kaminoLtvMult = 1.0;
  let kaminoSpreadMult = 1.0;
  const kaminoSt = stats['kamino'];

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
  const totalSamples = Object.values(stats).reduce((s, st) => s + st.totalTrades, 0);
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
    kaminoLtvMultiplier: blend(kaminoLtvMult, prior?.kaminoLtvMultiplier),
    kaminoSpreadFloorMultiplier: blend(kaminoSpreadMult, prior?.kaminoSpreadFloorMultiplier),
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
    const strategies = ['polymarket', 'hyperliquid', 'kamino', 'jito', 'orca_lp', 'krystal_lp', 'evm_flash_arb'];
    const statsEntries = await Promise.all(
      strategies.map(async s => [s, await computeStrategyStats(dbPool, s)] as const),
    );
    const stats: Record<string, StrategyStats> = Object.fromEntries(statsEntries);

    // 3. LP-specific stats (aggregate + per-tier for Krystal)
    const [orcaLpStats, krystalLpStats, krystalLow, krystalMed, krystalHigh] = await Promise.all([
      computeLPStats(dbPool, 'orca_lp'),
      computeLPStats(dbPool, 'krystal_lp'),
      computeLPStats(dbPool, 'krystal_lp', 'low'),
      computeLPStats(dbPool, 'krystal_lp', 'medium'),
      computeLPStats(dbPool, 'krystal_lp', 'high'),
    ]);
    const lpStats: Record<string, LPStats> = {
      orca_lp: orcaLpStats,
      krystal_lp: krystalLpStats,
      krystal_lp_low: krystalLow,
      krystal_lp_medium: krystalMed,
      krystal_lp_high: krystalHigh,
    };

    // 4. Polymarket calibration
    const polyCal = await computePolyCalibration(dbPool);

    // 5. Fee-drag & execution quality
    const feeStats = await computeFeeAndExecStats(dbPool);

    // 6. Portfolio-level intelligence (regime detection, Sharpe)
    const portfolio = await computePortfolioStats(dbPool, stats);

    // 7. Compute adaptive params (now with fee + portfolio inputs)
    const params = computeAdaptiveParams(stats, lpStats, polyCal, prior, feeStats, portfolio);

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
      `lpRange×${params.lpRangeWidthMultiplier.toFixed(2)} | ` +
      `lpTiers: L×${params.lpTierRangeMultipliers.low?.toFixed(2) ?? '1'} M×${params.lpTierRangeMultipliers.medium?.toFixed(2) ?? '1'} H×${params.lpTierRangeMultipliers.high?.toFixed(2) ?? '1'} | ` +
      `arbMin×${params.evmArbMinProfitMultiplier.toFixed(2)} | ` +
      `feeDrag=${params.feeDragPct.toFixed(1)}% | ` +
      `pSharpe=${params.portfolioSharpe.toFixed(2)} | ` +
      `best: ${topStrategy?.[0] ?? 'n/a'}(${topStrategy?.[1]?.toFixed(0) ?? '?'})`,
    );

    // Log alerts
    if (params.alerts.length > 0) {
      logger.warn(`[Learning] 🚨 ALERTS (${params.alerts.length}):`);
      for (const alert of params.alerts) {
        logger.warn(`[Learning]   ${alert}`);
      }
    }

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
    lpRangeWidthMultiplier: 1.0,
    lpMinAprAdjustment: 0,
    lpRebalanceTriggerMultiplier: 1.0,
    lpTierRangeMultipliers: { low: 1.0, medium: 1.0, high: 1.0 },
    lpTierMinAprAdjustments: { low: 0, medium: 0, high: 0 },
    kaminoLtvMultiplier: 1.0,
    kaminoSpreadFloorMultiplier: 1.0,
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

  const totalSamples = Object.values(params.sampleSizes).reduce((s, n) => s + n, 0);
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
    hyperliquid: 'Hyperliquid', kamino: 'Kamino', jito: 'Jito Staking',
    orca_lp: 'Orca LP', krystal_lp: 'EVM LP', evm_flash_arb: 'Arb Scanner',
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
