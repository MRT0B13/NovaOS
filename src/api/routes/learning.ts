/**
 * Learning Engine routes — exposes CFO adaptive learning data to the dashboard
 *
 * The learning engine (src/launchkit/cfo/learningEngine.ts) computes per-strategy
 * stats from cfo_positions and persists adaptive parameters in kv_store.
 * These endpoints surface that data so the dashboard can show learning progress,
 * strategy performance, risk regime, and calibration quality.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

export async function learningRoutes(server: FastifyInstance) {

  // GET /api/learning/params — current adaptive parameters
  server.get('/learning/params', { preHandler: requireAuth }, async (_req, reply) => {
    const kv = await server.pg.query(
      `SELECT data, updated_at FROM kv_store WHERE key = 'cfo_learning_params'`
    );

    if (!kv.rows.length) {
      return reply.send({
        status: 'no-data',
        message: 'Learning engine has not yet computed parameters. Needs closed positions.',
      });
    }

    const params = typeof kv.rows[0].data === 'string'
      ? JSON.parse(kv.rows[0].data) : kv.rows[0].data;

    reply.send({
      status: 'active',
      lastComputed: params.lastComputed ?? kv.rows[0].updated_at,
      confidenceLevel: params.confidenceLevel ?? 0,
      regimeSignal: params.regimeSignal ?? 'neutral',
      globalRiskMultiplier: params.globalRiskMultiplier ?? 1.0,
      // Key strategy multipliers
      strategies: {
        polymarket: {
          kellyMultiplier: params.kellyMultiplier ?? 1.0,
          minEdgeOverride: params.minEdgeOverride ?? null,
          betSizeMultiplier: params.polyBetSizeMultiplier ?? 1.0,
        },
        hyperliquid: {
          stopLossMultiplier: params.hlStopLossMultiplier ?? 1.0,
          leverageBias: params.hlLeverageBias ?? 0,
          hedgeTargetMultiplier: params.hlHedgeTargetMultiplier ?? 1.0,
          perpConvictionFloor: params.hlPerpConvictionFloor ?? null,
          perpSizeMultiplier: params.hlPerpSizeMultiplier ?? 1.0,
          spotSizeMultiplier: params.hlSpotSizeMultiplier ?? 1.0,
        },
        lp: {
          rangeWidthMultiplier: params.lpRangeWidthMultiplier ?? 1.0,
          minAprAdjustment: params.lpMinAprAdjustment ?? 0,
          rebalanceTriggerMultiplier: params.lpRebalanceTriggerMultiplier ?? 1.0,
          tierMultipliers: params.lpTierRangeMultipliers ?? {},
          bestPairs: params.lpBestPairs ?? [],
        },
        kamino: {
          ltvMultiplier: params.kaminoLtvMultiplier ?? 1.0,
          spreadFloorMultiplier: params.kaminoSpreadFloorMultiplier ?? 1.0,
        },
      },
      // Portfolio-level
      portfolio: {
        sharpe: params.portfolioSharpe ?? null,
        maxDrawdownPct: params.portfolioMaxDrawdownPct ?? null,
        feeDragPct: params.feeDragPct ?? null,
      },
      // Capital allocation
      capitalWeights: params.capitalWeights ?? {},
      strategyScores: params.strategyScores ?? {},
      // Alerts from learning engine
      alerts: params.alerts ?? [],
      // Sample sizes (for confidence display)
      sampleSizes: params.sampleSizes ?? {},
    });
  });

  // GET /api/learning/stats — per-strategy performance stats
  server.get('/learning/stats', { preHandler: requireAuth }, async (_req, reply) => {
    // Pull trade stats directly from cfo_positions
    const strategyStats = await server.pg.query(
      `SELECT
         strategy,
         COUNT(*) AS total_trades,
         COUNT(*) FILTER (WHERE realized_pnl_usd > 0) AS wins,
         COUNT(*) FILTER (WHERE realized_pnl_usd <= 0) AS losses,
         ROUND(AVG(realized_pnl_usd)::numeric, 2) AS avg_pnl_usd,
         ROUND(SUM(realized_pnl_usd)::numeric, 2) AS total_pnl_usd,
         ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600)::numeric, 1) AS avg_hold_hours,
         ROUND(MIN(realized_pnl_usd)::numeric, 2) AS worst_trade,
         ROUND(MAX(realized_pnl_usd)::numeric, 2) AS best_trade,
         MAX(closed_at) AS last_closed
       FROM cfo_positions
       WHERE status = 'CLOSED'
         AND closed_at > NOW() - INTERVAL '90 days'
       GROUP BY strategy
       ORDER BY total_pnl_usd DESC`
    );

    // Compute win rates
    const stats = strategyStats.rows.map((r: any) => ({
      strategy: r.strategy,
      totalTrades: Number(r.total_trades),
      wins: Number(r.wins),
      losses: Number(r.losses),
      winRate: Number(r.total_trades) > 0
        ? Math.round((Number(r.wins) / Number(r.total_trades)) * 100) : 0,
      avgPnlUsd: Number(r.avg_pnl_usd),
      totalPnlUsd: Number(r.total_pnl_usd),
      avgHoldHours: Number(r.avg_hold_hours),
      worstTrade: Number(r.worst_trade),
      bestTrade: Number(r.best_trade),
      lastClosed: r.last_closed,
    }));

    // Overall summary
    const totalPnl = stats.reduce((sum: number, s: any) => sum + s.totalPnlUsd, 0);
    const totalTrades = stats.reduce((sum: number, s: any) => sum + s.totalTrades, 0);
    const totalWins = stats.reduce((sum: number, s: any) => sum + s.wins, 0);

    reply.send({
      period: '90d',
      summary: {
        totalTrades,
        wins: totalWins,
        losses: totalTrades - totalWins,
        winRate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0,
        totalPnlUsd: Math.round(totalPnl * 100) / 100,
      },
      strategies: stats,
    });
  });

  // GET /api/learning/regime — current risk regime signal
  server.get('/learning/regime', { preHandler: requireAuth }, async (_req, reply) => {
    const kv = await server.pg.query(
      `SELECT data, updated_at FROM kv_store WHERE key = 'cfo_learning_params'`
    );

    if (!kv.rows.length) {
      return reply.send({ regime: 'neutral', confidence: 0, message: 'No learning data yet' });
    }

    const params = typeof kv.rows[0].data === 'string'
      ? JSON.parse(kv.rows[0].data) : kv.rows[0].data;

    // Also pull recent position activity for context
    const recentActivity = await server.pg.query(
      `SELECT
         COUNT(*) AS positions_24h,
         COUNT(*) FILTER (WHERE realized_pnl_usd > 0) AS wins_24h,
         ROUND(SUM(realized_pnl_usd)::numeric, 2) AS pnl_24h
       FROM cfo_positions
       WHERE status = 'CLOSED' AND closed_at > NOW() - INTERVAL '24 hours'`
    );

    const activity = recentActivity.rows[0] ?? {};

    reply.send({
      regime: params.regimeSignal ?? 'neutral',
      confidence: params.confidenceLevel ?? 0,
      globalRiskMultiplier: params.globalRiskMultiplier ?? 1.0,
      lastComputed: params.lastComputed ?? kv.rows[0].updated_at,
      recent24h: {
        positions: Number(activity.positions_24h ?? 0),
        wins: Number(activity.wins_24h ?? 0),
        pnlUsd: Number(activity.pnl_24h ?? 0),
      },
      alerts: params.alerts ?? [],
    });
  });

  // GET /api/learning/history — learning parameter snapshots over time
  server.get('/learning/history', { preHandler: requireAuth }, async (req, reply) => {
    const { days = '30' } = req.query as { days?: string };
    const d = Math.min(Number(days) || 30, 90);

    // Learning engine saves snapshots in kv_store with date-keyed entries
    const snapshots = await server.pg.query(
      `SELECT key, data, updated_at
       FROM kv_store
       WHERE key LIKE 'cfo_learning_snapshot_%'
         AND updated_at > NOW() - INTERVAL '${d} days'
       ORDER BY updated_at DESC
       LIMIT 100`
    );

    if (!snapshots.rows.length) {
      // Fall back to just the current params
      const current = await server.pg.query(
        `SELECT data, updated_at FROM kv_store WHERE key = 'cfo_learning_params'`
      );
      if (!current.rows.length) return reply.send({ snapshots: [] });

      const params = typeof current.rows[0].data === 'string'
        ? JSON.parse(current.rows[0].data) : current.rows[0].data;
      return reply.send({
        snapshots: [{
          date: current.rows[0].updated_at,
          regime: params.regimeSignal ?? 'neutral',
          confidence: params.confidenceLevel ?? 0,
          globalRisk: params.globalRiskMultiplier ?? 1.0,
          portfolioSharpe: params.portfolioSharpe ?? null,
        }],
      });
    }

    reply.send({
      snapshots: snapshots.rows.map((r: any) => {
        const p = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        return {
          date: r.updated_at,
          regime: p.regimeSignal ?? 'neutral',
          confidence: p.confidenceLevel ?? 0,
          globalRisk: p.globalRiskMultiplier ?? 1.0,
          portfolioSharpe: p.portfolioSharpe ?? null,
        };
      }),
    });
  });
}
