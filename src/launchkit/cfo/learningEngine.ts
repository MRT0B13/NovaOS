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

  // Polymarket
  kellyMultiplier: number;      // multiply env kellyFraction by this (e.g. 0.8 = more conservative)
  minEdgeOverride: number;      // absolute override for minEdge based on calibration
  polyBetSizeMultiplier: number; // scale bet sizing

  // Hyperliquid
  hlStopLossMultiplier: number; // tighter/wider stop loss (< 1 = tighter)
  hlLeverageBias: number;       // -1 to +1 adjustment on max leverage

  // LP (Orca + Krystal)
  lpRangeWidthMultiplier: number;  // wider/narrower ranges based on rebalance frequency
  lpMinAprAdjustment: number;      // increase min APR floor if LP positions underperform

  // Kamino
  kaminoLtvMultiplier: number;     // tighten/loosen LTV target

  // Strategy allocation preference (higher = more capital)
  strategyScores: Record<string, number>;  // strategy → relative performance score

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
 */
async function computeLPStats(pool: any, strategy: 'orca_lp' | 'krystal_lp'): Promise<LPStats> {
  const empty: LPStats = {
    strategy, totalPositions: 0, avgFeesEarnedUsd: 0,
    avgHoldHours: 0, rebalanceCount: 0, outOfRangeRate: 0,
    avgPnlPerDayUsd: 0, bestChains: [], bestPairs: [],
  };

  try {
    const res = await pool.query(
      `SELECT realized_pnl_usd, cost_basis_usd, asset, chain, metadata,
              EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - opened_at)) / 3600 AS hold_hours
       FROM cfo_positions
       WHERE strategy = $1
         AND opened_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
       ORDER BY opened_at DESC`,
      [strategy],
    );

    const rows = res.rows;
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
// Adaptive Parameter Computation
// ============================================================================

function computeAdaptiveParams(
  stats: Record<string, StrategyStats>,
  lpStats: Record<string, LPStats>,
  polyCal: PolymarketCalibration,
  prior: AdaptiveParams | null,
): AdaptiveParams {

  const blend = (newVal: number, priorVal: number | undefined): number => {
    if (priorVal === undefined || priorVal === 0) return newVal;
    return EMA_ALPHA * newVal + (1 - EMA_ALPHA) * priorVal;
  };

  // ── Polymarket adaptations ──────────────────────────────────────
  let kellyMult = 1.0;
  let minEdgeOvr = 0.05; // default
  let polyBetMult = 1.0;
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
      minEdgeOvr = 0.05 + polyCal.calibrationGap * 0.5; // e.g. +0.05 for 0.1 gap
    }
    if (polyCal.brierScore > 0.35) {
      polyBetMult = 0.6; // poor calibration → smaller bets
    }
  }

  // ── Hyperliquid adaptations ─────────────────────────────────────
  let hlStopMult = 1.0;
  let hlLevBias = 0;
  const hlSt = stats['hyperliquid'];

  if (hlSt && hlSt.totalTrades >= MIN_TRADES_FOR_CONFIDENCE) {
    // If max drawdown is severe relative to avg PnL, tighten stops
    if (hlSt.maxDrawdownUsd < -50 && Math.abs(hlSt.maxDrawdownUsd) > hlSt.avgPnlUsd * 5) {
      hlStopMult = 0.7; // tighter stop
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
      hlStopMult *= 0.8; // things are getting worse → tighten
      hlLevBias -= 0.3;
    }
  }

  // ── LP adaptations (Orca + Krystal) ─────────────────────────────
  let lpRangeMult = 1.0;
  let lpMinAprAdj = 0;

  const orcaLp = lpStats['orca_lp'];
  const krystalLp = lpStats['krystal_lp'];

  // Combine LP stats for range width learning
  const allLp = [orcaLp, krystalLp].filter(Boolean);

  for (const lp of allLp) {
    if (!lp || lp.totalPositions < 3) continue;

    // If out-of-range rate is high (>40%), widen ranges
    if (lp.outOfRangeRate > 0.4) {
      lpRangeMult = Math.max(lpRangeMult, 1.3);
    } else if (lp.outOfRangeRate < 0.15 && lp.avgPnlPerDayUsd > 0) {
      // Low OOR + profitable → can tighten for more fees
      lpRangeMult = Math.min(lpRangeMult, 0.85);
    }

    // If avg PnL per day is negative, raise APR floor
    if (lp.avgPnlPerDayUsd < 0) {
      lpMinAprAdj = Math.max(lpMinAprAdj, 10); // +10% APR floor
    }
  }

  // ── Kamino adaptations ──────────────────────────────────────────
  let kaminoLtvMult = 1.0;
  const kaminoSt = stats['kamino'];

  if (kaminoSt && kaminoSt.totalTrades >= 3) {
    // If liquidation losses detected, aggressively lower LTV
    if (kaminoSt.maxDrawdownUsd < -20) {
      kaminoLtvMult = 0.8;
    }
    // If consistently profitable, can be slightly more aggressive
    if (kaminoSt.winRate > 0.7 && kaminoSt.avgPnlUsd > 0) {
      kaminoLtvMult = 1.05;
    }
  }

  // ── Strategy scoring (relative performance) ─────────────────────
  const strategyScores: Record<string, number> = {};
  for (const [name, st] of Object.entries(stats)) {
    if (st.totalTrades < MIN_TRADES_FOR_CONFIDENCE) {
      strategyScores[name] = 50; // neutral score for insufficient data
    } else {
      // Score = base 50 + Sharpe contribution + win rate contribution
      let score = 50;
      score += st.sharpeApprox * 20;                    // Sharpe: -2 to +2 → -40 to +40
      score += (st.winRate - 0.5) * 30;                 // WR: 0.3–0.7 → -6 to +6
      score += st.avgPnlUsd > 0 ? 10 : -10;            // profitable bonus
      score += (st.recentWinRate - st.winRate) * 20;    // improving trend bonus
      strategyScores[name] = Math.max(0, Math.min(100, score));
    }
  }

  // ── Confidence level (based on total sample size) ───────────────
  const totalSamples = Object.values(stats).reduce((s, st) => s + st.totalTrades, 0);
  const confidence = Math.min(1, totalSamples / 50); // full confidence at 50+ trades

  // ── Blend with prior using EMA ──────────────────────────────────
  const sampleSizes: Record<string, number> = {};
  for (const [name, st] of Object.entries(stats)) {
    sampleSizes[name] = st.totalTrades;
  }

  const params: AdaptiveParams = {
    confidenceLevel: confidence,
    kellyMultiplier: blend(kellyMult, prior?.kellyMultiplier),
    minEdgeOverride: blend(minEdgeOvr, prior?.minEdgeOverride),
    polyBetSizeMultiplier: blend(polyBetMult, prior?.polyBetSizeMultiplier),
    hlStopLossMultiplier: blend(hlStopMult, prior?.hlStopLossMultiplier),
    hlLeverageBias: blend(hlLevBias, prior?.hlLeverageBias),
    lpRangeWidthMultiplier: blend(lpRangeMult, prior?.lpRangeWidthMultiplier),
    lpMinAprAdjustment: blend(lpMinAprAdj, prior?.lpMinAprAdjustment),
    kaminoLtvMultiplier: blend(kaminoLtvMult, prior?.kaminoLtvMultiplier),
    strategyScores,
    sampleSizes,
    lastComputed: Date.now(),
  };

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
    await pool.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [KV_KEY, JSON.stringify(params)],
    );
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

    // 3. LP-specific stats
    const [orcaLpStats, krystalLpStats] = await Promise.all([
      computeLPStats(dbPool, 'orca_lp'),
      computeLPStats(dbPool, 'krystal_lp'),
    ]);
    const lpStats: Record<string, LPStats> = {
      orca_lp: orcaLpStats,
      krystal_lp: krystalLpStats,
    };

    // 4. Polymarket calibration
    const polyCal = await computePolyCalibration(dbPool);

    // 5. Compute adaptive params
    const params = computeAdaptiveParams(stats, lpStats, polyCal, prior);

    // 6. Persist
    await saveLearned(dbPool, params);

    // 7. Log summary
    const totalTrades = Object.values(stats).reduce((s, st) => s + st.totalTrades, 0);
    const topStrategy = Object.entries(params.strategyScores)
      .sort(([, a], [, b]) => b - a)[0];

    logger.info(
      `[Learning] Retrospective: ${totalTrades} trades analysed | ` +
      `confidence: ${(params.confidenceLevel * 100).toFixed(0)}% | ` +
      `kelly×${params.kellyMultiplier.toFixed(2)} | ` +
      `hlStop×${params.hlStopLossMultiplier.toFixed(2)} | ` +
      `lpRange×${params.lpRangeWidthMultiplier.toFixed(2)} | ` +
      `best: ${topStrategy?.[0] ?? 'n/a'}(${topStrategy?.[1]?.toFixed(0) ?? '?'})`,
    );

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
    kellyMultiplier: 1.0,
    minEdgeOverride: 0.05,
    polyBetSizeMultiplier: 1.0,
    hlStopLossMultiplier: 1.0,
    hlLeverageBias: 0,
    lpRangeWidthMultiplier: 1.0,
    lpMinAprAdjustment: 0,
    kaminoLtvMultiplier: 1.0,
    strategyScores: {},
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
  if (params.lastComputed === 0) return '🧠 Learning: No data yet (need 5+ closed trades)';

  const totalSamples = Object.values(params.sampleSizes).reduce((s, n) => s + n, 0);
  const top3 = Object.entries(params.strategyScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, score]) => `${name}(${score.toFixed(0)})`)
    .join(', ');

  const adjustments: string[] = [];
  if (Math.abs(params.kellyMultiplier - 1) > 0.05) {
    adjustments.push(`Kelly ${params.kellyMultiplier > 1 ? '↑' : '↓'}${(params.kellyMultiplier * 100).toFixed(0)}%`);
  }
  if (Math.abs(params.hlStopLossMultiplier - 1) > 0.05) {
    adjustments.push(`HLstop ${params.hlStopLossMultiplier > 1 ? 'wider' : 'tighter'}`);
  }
  if (Math.abs(params.lpRangeWidthMultiplier - 1) > 0.05) {
    adjustments.push(`LP range ${params.lpRangeWidthMultiplier > 1 ? 'wider' : 'tighter'}`);
  }
  if (params.lpMinAprAdjustment > 0) {
    adjustments.push(`APR floor +${params.lpMinAprAdjustment.toFixed(0)}%`);
  }

  return (
    `🧠 Learning: ${totalSamples} trades | confidence ${(params.confidenceLevel * 100).toFixed(0)}%\n` +
    `   Top strategies: ${top3 || 'n/a'}\n` +
    (adjustments.length > 0 ? `   Adjustments: ${adjustments.join(', ')}` : '   No adjustments yet (building data)')
  );
}
