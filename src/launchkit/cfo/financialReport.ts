/**
 * CFO Financial Report Generator
 *
 * Produces periodic (weekly + monthly) financial reports summarising:
 *  - Portfolio value change (start → end)
 *  - P&L breakdown by strategy (wins, losses, total)
 *  - Debt / borrowing status (Kamino)
 *  - Learning engine adjustments made during the period
 *  - Fee drag / execution quality
 *  - Top trades (best & worst)
 *  - Capital allocation shifts
 *
 * Reports are sent to admin via Telegram and are also persisted in kv_store
 * so they can be reviewed later.
 *
 * Schedule (configurable via env):
 *  - Weekly:  Sunday 09:00 UTC  (CFO_WEEKLY_REPORT_ENABLE)
 *  - Monthly: 1st of month 09:00 UTC  (CFO_MONTHLY_REPORT_ENABLE)
 */

import { logger } from '@elizaos/core';
import type { Pool } from 'pg';
import type { CFOPosition, CFODailySnapshot } from './postgresCFORepository.ts';

// ============================================================================
// Types
// ============================================================================

interface StrategyBreakdown {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;           // 0–1
  realizedPnl: number;      // USD
  unrealizedPnl: number;    // USD
  feesCollected: number;    // USD (LP fee_collect revenue)
  feesPaid: number;         // USD (gas + execution costs)
  bestTrade: { asset: string; pnl: number } | null;
  worstTrade: { asset: string; pnl: number } | null;
}

interface DebtSnapshot {
  totalDepositsUsd: number;
  totalBorrowsUsd: number;
  netValueUsd: number;
  healthFactor: number;
  ltv: number;
}

interface PeriodReport {
  type: 'weekly' | 'monthly';
  periodStart: string;       // YYYY-MM-DD
  periodEnd: string;         // YYYY-MM-DD

  // Portfolio
  startPortfolioUsd: number;
  endPortfolioUsd: number;
  portfolioChangePct: number; // (end - start) / start

  // P&L
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFeesCollected: number; // LP fees, poly sells
  totalFeesPaid: number;      // gas costs
  netPnl: number;             // realized + fees_collected - fees_paid

  // Per-strategy
  strategies: StrategyBreakdown[];

  // Top trades
  bestTrades: Array<{ asset: string; strategy: string; pnl: number }>;
  worstTrades: Array<{ asset: string; strategy: string; pnl: number }>;

  // Snapshots
  portfolioHistory: Array<{ date: string; value: number }>;
  solPriceHistory: Array<{ date: string; price: number }>;

  // Debt
  currentDebt: DebtSnapshot | null;

  // Learning
  tradesAnalysed: number;
  portfolioSharpe: number;
  maxDrawdownPct: number;
  adjustmentsSummary: string[];
  capitalWeights: Record<string, number>;
  regimeSignal: string;

  // Counts
  totalTradesClosed: number;
  totalTradesOpened: number;
  openPositions: number;
}

// ============================================================================
// Strategy name mapping (shared with learningEngine)
// ============================================================================

const STRAT_NAMES: Record<string, string> = {
  hyperliquid: 'HL Hedge',
  hl_perp: 'HL Perps',
  kamino: 'Kamino',
  kamino_loop: 'Kamino Loop',
  orca_lp: 'Orca LP',
  krystal_lp: 'EVM LP',
  jito: 'Jito Staking',
  polymarket: 'Polymarket',
  evm_flash_arb: 'EVM Arb',
  jupiter_swap: 'Jupiter Swap',
};

function stratName(s: string): string {
  // Handle kamino_*_loop patterns
  if (s.startsWith('kamino_') && s.endsWith('_loop')) {
    const token = s.replace('kamino_', '').replace('_loop', '').toUpperCase();
    return `Kamino ${token} Loop`;
  }
  return STRAT_NAMES[s] ?? s;
}

// ============================================================================
// Data queries
// ============================================================================

/**
 * Get all positions closed within a date range.
 */
async function getClosedPositionsInPeriod(
  pool: Pool,
  start: string,
  end: string,
): Promise<CFOPosition[]> {
  const res = await pool.query(
    `SELECT * FROM cfo_positions
     WHERE status IN ('CLOSED', 'STOP_HIT', 'EXPIRED')
       AND closed_at >= $1::timestamptz
       AND closed_at < $2::timestamptz
     ORDER BY closed_at DESC`,
    [`${start}T00:00:00Z`, `${end}T23:59:59Z`],
  );
  return res.rows.map(rowToPosition);
}

/**
 * Get all positions opened within a date range.
 */
async function getOpenedPositionsInPeriod(
  pool: Pool,
  start: string,
  end: string,
): Promise<CFOPosition[]> {
  const res = await pool.query(
    `SELECT * FROM cfo_positions
     WHERE opened_at >= $1::timestamptz
       AND opened_at < $2::timestamptz
     ORDER BY opened_at DESC`,
    [`${start}T00:00:00Z`, `${end}T23:59:59Z`],
  );
  return res.rows.map(rowToPosition);
}

/**
 * Get currently open positions.
 */
async function getCurrentOpenPositions(pool: Pool): Promise<CFOPosition[]> {
  const res = await pool.query(
    `SELECT * FROM cfo_positions WHERE status IN ('OPEN', 'PARTIAL_EXIT') ORDER BY opened_at DESC`,
  );
  return res.rows.map(rowToPosition);
}

/**
 * Get transaction fees + revenue for a period.
 */
async function getTransactionSummary(
  pool: Pool,
  start: string,
  end: string,
): Promise<{ feesPaid: number; feesCollected: number; byStrategy: Record<string, { feesPaid: number; feesCollected: number }> }> {
  const res = await pool.query(
    `SELECT strategy_tag,
            COALESCE(SUM(fee_usd), 0) AS total_fees,
            COALESCE(SUM(CASE WHEN tx_type IN ('fee_collect', 'prediction_sell') THEN amount_out ELSE 0 END), 0) AS revenue
     FROM cfo_transactions
     WHERE timestamp >= $1::timestamptz
       AND timestamp < $2::timestamptz
       AND status = 'confirmed'
     GROUP BY strategy_tag`,
    [`${start}T00:00:00Z`, `${end}T23:59:59Z`],
  );

  let feesPaid = 0;
  let feesCollected = 0;
  const byStrategy: Record<string, { feesPaid: number; feesCollected: number }> = {};

  for (const row of res.rows) {
    const strat = row.strategy_tag;
    const fp = Number(row.total_fees);
    const fc = Number(row.revenue);
    feesPaid += fp;
    feesCollected += fc;
    byStrategy[strat] = { feesPaid: fp, feesCollected: fc };
  }

  return { feesPaid, feesCollected, byStrategy };
}

/**
 * Get daily snapshots for a date range.
 */
async function getSnapshotsInRange(
  pool: Pool,
  start: string,
  end: string,
): Promise<CFODailySnapshot[]> {
  const res = await pool.query(
    `SELECT * FROM cfo_daily_snapshots
     WHERE date >= $1::date AND date <= $2::date
     ORDER BY date ASC`,
    [start, end],
  );
  return res.rows.map((r: any) => ({
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    totalPortfolioUsd: Number(r.total_portfolio_usd),
    solPriceUsd: Number(r.sol_price_usd),
    byStrategy: typeof r.by_strategy === 'string' ? JSON.parse(r.by_strategy) : r.by_strategy,
    realizedPnl24h: Number(r.realized_pnl_24h),
    unrealizedPnl: Number(r.unrealized_pnl),
    yieldEarned24h: Number(r.yield_earned_24h),
    x402Revenue24h: Number(r.x402_revenue_24h),
    polymarketPnl24h: Number(r.polymarket_pnl_24h),
    openPositions: Number(r.open_positions),
  }));
}

/**
 * Load learning params from kv_store.
 */
async function getLearnedParams(pool: Pool): Promise<any | null> {
  try {
    const res = await pool.query(
      `SELECT value FROM kv_store WHERE key = 'cfo_learning_params'`,
    );
    if (res.rows.length === 0) return null;
    const raw = res.rows[0].value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ============================================================================
// Report builder
// ============================================================================

/**
 * Generate a financial report for a given period.
 */
export async function generateReport(
  pool: Pool,
  type: 'weekly' | 'monthly',
  periodStart: string,
  periodEnd: string,
): Promise<PeriodReport> {
  // Parallel data queries
  const [closedPositions, openedPositions, openPositions, txSummary, snapshots, learnedParams] =
    await Promise.all([
      getClosedPositionsInPeriod(pool, periodStart, periodEnd),
      getOpenedPositionsInPeriod(pool, periodStart, periodEnd),
      getCurrentOpenPositions(pool),
      getTransactionSummary(pool, periodStart, periodEnd),
      getSnapshotsInRange(pool, periodStart, periodEnd),
      getLearnedParams(pool),
    ]);

  // ── Portfolio change ──
  const startSnap = snapshots[0];
  const endSnap = snapshots[snapshots.length - 1];
  const startValue = startSnap?.totalPortfolioUsd ?? 0;
  const endValue = endSnap?.totalPortfolioUsd ?? 0;
  const changePct = startValue > 0 ? (endValue - startValue) / startValue : 0;

  // ── Per-strategy breakdown ──
  const stratMap = new Map<string, StrategyBreakdown>();
  const ensureStrat = (s: string): StrategyBreakdown => {
    if (!stratMap.has(s)) {
      stratMap.set(s, {
        strategy: s,
        trades: 0, wins: 0, losses: 0, winRate: 0,
        realizedPnl: 0, unrealizedPnl: 0,
        feesCollected: 0, feesPaid: 0,
        bestTrade: null, worstTrade: null,
      });
    }
    return stratMap.get(s)!;
  };

  for (const pos of closedPositions) {
    const sb = ensureStrat(pos.strategy);
    sb.trades++;
    const pnl = pos.realizedPnlUsd;
    sb.realizedPnl += pnl;
    if (pnl > 0) sb.wins++;
    else sb.losses++;
    if (!sb.bestTrade || pnl > sb.bestTrade.pnl) sb.bestTrade = { asset: pos.asset, pnl };
    if (!sb.worstTrade || pnl < sb.worstTrade.pnl) sb.worstTrade = { asset: pos.asset, pnl };
  }

  // Add unrealized PnL from open positions
  for (const pos of openPositions) {
    const sb = ensureStrat(pos.strategy);
    sb.unrealizedPnl += pos.unrealizedPnlUsd;
  }

  // Merge tx fees
  for (const [strat, fees] of Object.entries(txSummary.byStrategy)) {
    const sb = ensureStrat(strat);
    sb.feesPaid += fees.feesPaid;
    sb.feesCollected += fees.feesCollected;
  }

  // Compute win rates
  for (const sb of stratMap.values()) {
    sb.winRate = sb.trades > 0 ? sb.wins / sb.trades : 0;
  }

  const strategies = Array.from(stratMap.values()).sort((a, b) => b.realizedPnl - a.realizedPnl);

  // ── Totals ──
  const totalRealizedPnl = closedPositions.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const totalUnrealizedPnl = openPositions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const netPnl = totalRealizedPnl + txSummary.feesCollected - txSummary.feesPaid;

  // ── Top trades ──
  const allClosedSorted = [...closedPositions].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  const bestTrades = allClosedSorted.slice(0, 3).filter(t => t.realizedPnlUsd > 0)
    .map(t => ({ asset: t.asset, strategy: t.strategy, pnl: t.realizedPnlUsd }));
  const worstTrades = allClosedSorted.slice(-3).filter(t => t.realizedPnlUsd < 0).reverse()
    .map(t => ({ asset: t.asset, strategy: t.strategy, pnl: t.realizedPnlUsd }));

  // ── Debt snapshot (Kamino) ──
  let currentDebt: DebtSnapshot | null = null;
  try {
    const { getPosition: getKaminoPos } = await import('./kaminoService.ts');
    const kp = await getKaminoPos();
    if (kp) {
      currentDebt = {
        totalDepositsUsd: kp.deposits.reduce((s: number, d: any) => s + d.valueUsd, 0),
        totalBorrowsUsd: kp.borrows.reduce((s: number, b: any) => s + b.valueUsd, 0),
        netValueUsd: kp.netValueUsd,
        healthFactor: kp.healthFactor,
        ltv: kp.ltv,
      };
    }
  } catch {
    // Kamino not available
  }

  // ── Learning engine ──
  const lp = learnedParams ?? {};
  const adjustmentsSummary: string[] = [];
  if (Math.abs((lp.kellyMultiplier ?? 1) - 1) > 0.05) {
    adjustmentsSummary.push(`Bet sizing ${(lp.kellyMultiplier ?? 1) > 1 ? 'increased' : 'reduced'} to ${((lp.kellyMultiplier ?? 1) * 100).toFixed(0)}%`);
  }
  if (Math.abs((lp.hlStopLossMultiplier ?? 1) - 1) > 0.05) {
    adjustmentsSummary.push(`Stop losses ${(lp.hlStopLossMultiplier ?? 1) > 1 ? 'widened' : 'tightened'}`);
  }
  if (Math.abs((lp.hlHedgeTargetMultiplier ?? 1) - 1) > 0.05) {
    adjustmentsSummary.push(`Hedge target ${(lp.hlHedgeTargetMultiplier ?? 1) > 1 ? 'increased' : 'decreased'}`);
  }
  if (Math.abs((lp.lpRangeWidthMultiplier ?? 1) - 1) > 0.05) {
    adjustmentsSummary.push(`LP ranges ${(lp.lpRangeWidthMultiplier ?? 1) > 1 ? 'widened' : 'tightened'}`);
  }
  if (Math.abs((lp.hlPerpSizeMultiplier ?? 1) - 1) > 0.05) {
    adjustmentsSummary.push(`Perp sizing ${(lp.hlPerpSizeMultiplier ?? 1) > 1 ? 'increased' : 'reduced'} to ${((lp.hlPerpSizeMultiplier ?? 1) * 100).toFixed(0)}%`);
  }
  if ((lp.globalRiskMultiplier ?? 1) < 0.9) {
    adjustmentsSummary.push(`Risk-off mode (×${(lp.globalRiskMultiplier ?? 1).toFixed(2)})`);
  } else if ((lp.globalRiskMultiplier ?? 1) > 1.1) {
    adjustmentsSummary.push(`Risk-on mode (×${(lp.globalRiskMultiplier ?? 1).toFixed(2)})`);
  }
  if ((lp.feeDragPct ?? 0) > 1) {
    adjustmentsSummary.push(`Fee drag: ${(lp.feeDragPct ?? 0).toFixed(1)}% of returns`);
  }

  // ── Snapshot histories ──
  const portfolioHistory = snapshots.map(s => ({ date: s.date, value: s.totalPortfolioUsd }));
  const solPriceHistory = snapshots.map(s => ({ date: s.date, price: s.solPriceUsd }));

  return {
    type,
    periodStart,
    periodEnd,
    startPortfolioUsd: startValue,
    endPortfolioUsd: endValue,
    portfolioChangePct: changePct,
    totalRealizedPnl: totalRealizedPnl,
    totalUnrealizedPnl,
    totalFeesCollected: txSummary.feesCollected,
    totalFeesPaid: txSummary.feesPaid,
    netPnl,
    strategies,
    bestTrades,
    worstTrades,
    portfolioHistory,
    solPriceHistory,
    currentDebt,
    tradesAnalysed: lp.sampleSizes ? (Object.values(lp.sampleSizes) as number[]).reduce((s, n) => s + Number(n), 0) : 0,
    portfolioSharpe: lp.portfolioSharpe ?? 0,
    maxDrawdownPct: lp.portfolioMaxDrawdownPct ?? 0,
    adjustmentsSummary,
    capitalWeights: lp.capitalWeights ?? {},
    regimeSignal: lp.regimeSignal ?? 'unknown',
    totalTradesClosed: closedPositions.length,
    totalTradesOpened: openedPositions.length,
    openPositions: openPositions.length,
  };
}

// ============================================================================
// HTML formatter (Telegram)
// ============================================================================

function pnlSign(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function pctSign(n: number): string {
  const pct = (n * 100).toFixed(1);
  return n >= 0 ? `+${pct}%` : `${pct}%`;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const bars = '▁▂▃▄▅▆▇█';
  return values.map(v => bars[Math.min(bars.length - 1, Math.floor(((v - min) / range) * (bars.length - 1)))]).join('');
}

/**
 * Format report as Telegram HTML message.
 */
export function formatReportHTML(report: PeriodReport): string {
  const L: string[] = [];
  const icon = report.type === 'weekly' ? '📊' : '📈';
  const title = report.type === 'weekly' ? 'Weekly Financial Report' : 'Monthly Financial Report';
  const dates = `${report.periodStart} → ${report.periodEnd}`;

  L.push(`${icon} <b>${title}</b>`);
  L.push(`<i>${dates}</i>`);
  L.push('');

  // ── Portfolio Overview ──
  const changeEmoji = report.portfolioChangePct >= 0 ? '🟢' : '🔴';
  L.push(`━━━ <b>Portfolio</b> ━━━`);
  L.push(`   ${changeEmoji} $${report.startPortfolioUsd.toFixed(2)} → $${report.endPortfolioUsd.toFixed(2)} (${pctSign(report.portfolioChangePct)})`);
  if (report.portfolioHistory.length > 2) {
    L.push(`   ${sparkline(report.portfolioHistory.map(h => h.value))}`);
  }
  L.push('');

  // ── P&L Summary ──
  L.push(`━━━ <b>Profit & Loss</b> ━━━`);
  L.push(`   Realized P&L: <b>${pnlSign(report.totalRealizedPnl)}</b>`);
  L.push(`   Unrealized P&L: ${pnlSign(report.totalUnrealizedPnl)}`);
  L.push(`   Fees collected: +$${report.totalFeesCollected.toFixed(2)}`);
  L.push(`   Gas / fees paid: -$${report.totalFeesPaid.toFixed(2)}`);
  L.push(`   <b>Net P&L: ${pnlSign(report.netPnl)}</b>`);
  L.push('');

  // ── Trades ──
  const totalW = report.strategies.reduce((s, st) => s + st.wins, 0);
  const totalL = report.strategies.reduce((s, st) => s + st.losses, 0);
  const totalWR = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(0) : '—';
  L.push(`━━━ <b>Trades</b> ━━━`);
  L.push(`   Opened: ${report.totalTradesOpened} | Closed: ${report.totalTradesClosed} | Open: ${report.openPositions}`);
  L.push(`   Win rate: ${totalWR}% (${totalW}W / ${totalL}L)`);
  L.push('');

  // ── Per-Strategy Breakdown ──
  if (report.strategies.length > 0) {
    L.push(`━━━ <b>By Strategy</b> ━━━`);
    for (const s of report.strategies) {
      if (s.trades === 0 && s.unrealizedPnl === 0 && s.feesCollected === 0) continue;
      const name = stratName(s.strategy);
      const wr = s.trades > 0 ? `${(s.winRate * 100).toFixed(0)}%` : '—';
      const emoji = s.realizedPnl >= 0 ? '✅' : '❌';
      L.push(`   ${emoji} <b>${name}</b>: ${pnlSign(s.realizedPnl)} (${s.trades} trades, ${wr} WR)`);
      // Show fees collected if meaningful
      if (s.feesCollected > 0.01) {
        L.push(`      Fees earned: +$${s.feesCollected.toFixed(2)}`);
      }
      if (s.unrealizedPnl !== 0) {
        L.push(`      Unrealized: ${pnlSign(s.unrealizedPnl)}`);
      }
    }
    L.push('');
  }

  // ── Top Trades ──
  if (report.bestTrades.length > 0 || report.worstTrades.length > 0) {
    L.push(`━━━ <b>Notable Trades</b> ━━━`);
    for (const t of report.bestTrades) {
      L.push(`   🏆 ${t.asset} (${stratName(t.strategy)}): ${pnlSign(t.pnl)}`);
    }
    for (const t of report.worstTrades) {
      L.push(`   💀 ${t.asset} (${stratName(t.strategy)}): ${pnlSign(t.pnl)}`);
    }
    L.push('');
  }

  // ── Debt / Borrowing ──
  if (report.currentDebt) {
    const d = report.currentDebt;
    const hfEmoji = d.healthFactor > 1.5 ? '🟢' : d.healthFactor > 1.2 ? '🟡' : '🔴';
    L.push(`━━━ <b>Debt (Kamino)</b> ━━━`);
    L.push(`   Deposits: $${d.totalDepositsUsd.toFixed(2)}`);
    L.push(`   Borrows: $${d.totalBorrowsUsd.toFixed(2)}`);
    L.push(`   Net value: $${d.netValueUsd.toFixed(2)}`);
    L.push(`   LTV: ${(d.ltv * 100).toFixed(1)}% | ${hfEmoji} Health: ${d.healthFactor.toFixed(2)}`);
    L.push('');
  }

  // ── Learning & Adjustments ──
  L.push(`━━━ <b>Learning Engine</b> ━━━`);
  L.push(`   Trades analysed: ${report.tradesAnalysed} | Regime: ${report.regimeSignal}`);
  const sharpeLabel = report.portfolioSharpe >= 1.5 ? 'excellent' : report.portfolioSharpe >= 1.0 ? 'good' : report.portfolioSharpe >= 0.5 ? 'fair' : report.portfolioSharpe >= 0 ? 'poor' : 'losing';
  const ddEmoji = report.maxDrawdownPct <= 0.25 ? '' : report.maxDrawdownPct <= 0.4 ? ' ⚠️' : ' 🔴';
  L.push(`   Sharpe: ${report.portfolioSharpe.toFixed(2)} (${sharpeLabel}) | Max DD: ${(report.maxDrawdownPct * 100).toFixed(0)}%${ddEmoji}`);

  if (report.adjustmentsSummary.length > 0) {
    L.push(`   Adjustments: ${report.adjustmentsSummary.join(' · ')}`);
  } else {
    L.push(`   No adjustments — parameters at defaults`);
  }

  // Capital weights
  const weights = Object.entries(report.capitalWeights)
    .filter(([, w]) => w > 0.05)
    .sort(([, a], [, b]) => b - a);
  if (weights.length > 0) {
    L.push(`   Capital: ${weights.map(([n, w]) => `${stratName(n)} ${(w * 100).toFixed(0)}%`).join(', ')}`);
  }

  // SOL price trend
  if (report.solPriceHistory.length > 1) {
    const solStart = report.solPriceHistory[0].price;
    const solEnd = report.solPriceHistory[report.solPriceHistory.length - 1].price;
    const solChange = solStart > 0 ? (solEnd - solStart) / solStart : 0;
    L.push('');
    L.push(`<i>SOL: $${solStart.toFixed(2)} → $${solEnd.toFixed(2)} (${pctSign(solChange)})</i>`);
  }

  return L.join('\n');
}

// ============================================================================
// Date helpers
// ============================================================================

/** Get the Monday of the current week (or previous if today is Sunday) */
function getWeekStart(now: Date): string {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  // Go back to previous Monday. If Sunday (0), go back 6 days.
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/** Get the previous week's date range (Mon → Sun) */
function getPreviousWeekRange(now: Date): { start: string; end: string } {
  const d = new Date(now);
  const day = d.getUTCDay();
  // End = last Sunday
  const endDiff = day === 0 ? 0 : day;
  const endDate = new Date(d);
  endDate.setUTCDate(d.getUTCDate() - endDiff);
  // Start = Monday of that week
  const startDate = new Date(endDate);
  startDate.setUTCDate(endDate.getUTCDate() - 6);
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

/** Get the previous month's date range */
function getPreviousMonthRange(now: Date): { start: string; end: string } {
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth(); // 1-indexed
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  // Last day of month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// ============================================================================
// Scheduler
// ============================================================================

let _reportTimer: ReturnType<typeof setInterval> | null = null;
let _lastWeeklyDate = '';
let _lastMonthlyDate = '';

/**
 * Start the financial report scheduler.
 * Checks hourly whether a weekly/monthly report is due.
 */
export function startFinancialReportScheduler(pool: Pool): void {
  if (_reportTimer) return; // already running

  const weeklyEnabled = process.env.CFO_WEEKLY_REPORT_ENABLE !== 'false';   // default: on
  const monthlyEnabled = process.env.CFO_MONTHLY_REPORT_ENABLE !== 'false'; // default: on
  const reportHour = parseInt(process.env.CFO_REPORT_HOUR_UTC ?? '9', 10);  // default: 9 AM UTC

  if (!weeklyEnabled && !monthlyEnabled) {
    logger.info('[FinancialReport] Both weekly and monthly reports disabled — skipping');
    return;
  }

  logger.info(`[FinancialReport] ✅ Scheduler started (weekly: ${weeklyEnabled}, monthly: ${monthlyEnabled}, hour: ${reportHour}:00 UTC)`);

  const check = async () => {
    try {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay = now.getUTCDay();    // 0=Sun
      const utcDate = now.getUTCDate();  // 1-31
      const today = now.toISOString().slice(0, 10);

      // Weekly: Sunday at reportHour
      if (weeklyEnabled && utcDay === 0 && utcHour >= reportHour && _lastWeeklyDate !== today) {
        _lastWeeklyDate = today;
        const { start, end } = getPreviousWeekRange(now);
        logger.info(`[FinancialReport] Generating weekly report for ${start} → ${end}`);
        const report = await generateReport(pool, 'weekly', start, end);
        const html = formatReportHTML(report);
        await sendReport(pool, html, 'weekly', start, end);
      }

      // Monthly: 1st of month at reportHour
      if (monthlyEnabled && utcDate === 1 && utcHour >= reportHour && _lastMonthlyDate !== today) {
        _lastMonthlyDate = today;
        const { start, end } = getPreviousMonthRange(now);
        logger.info(`[FinancialReport] Generating monthly report for ${start} → ${end}`);
        const report = await generateReport(pool, 'monthly', start, end);
        const html = formatReportHTML(report);
        await sendReport(pool, html, 'monthly', start, end);
      }
    } catch (err) {
      logger.error('[FinancialReport] Scheduler error:', err);
    }
  };

  // Check every hour
  _reportTimer = setInterval(check, 60 * 60 * 1000);

  // Also run immediately (catches missed reports after redeploy)
  setTimeout(check, 30_000);
}

/**
 * Stop the financial report scheduler.
 */
export function stopFinancialReportScheduler(): void {
  if (_reportTimer) {
    clearInterval(_reportTimer);
    _reportTimer = null;
  }
}

/**
 * Manually trigger a report for testing or on-demand use.
 */
export async function triggerReport(
  pool: Pool,
  type: 'weekly' | 'monthly',
): Promise<string> {
  const now = new Date();
  const { start, end } = type === 'weekly'
    ? getPreviousWeekRange(now)
    : getPreviousMonthRange(now);

  const report = await generateReport(pool, type, start, end);
  const html = formatReportHTML(report);
  await sendReport(pool, html, type, start, end);
  return html;
}

// ============================================================================
// Delivery
// ============================================================================

async function sendReport(
  pool: Pool,
  html: string,
  type: string,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  // Send via Telegram
  try {
    const { notifyAdminForce } = await import('../services/adminNotify.ts');
    await notifyAdminForce(html);
    logger.info(`[FinancialReport] ${type} report sent to admin (${periodStart} → ${periodEnd})`);
  } catch (err) {
    logger.error('[FinancialReport] Failed to send report via Telegram:', err);
  }

  // Persist in kv_store for later retrieval
  try {
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`cfo_report_${type}_${periodEnd}`, html],
    );
  } catch (err) {
    logger.debug('[FinancialReport] Failed to persist report in kv_store:', err);
  }
}

// ============================================================================
// Row mapper (shared with postgresCFORepository)
// ============================================================================

function rowToPosition(r: any): CFOPosition {
  return {
    id: r.id,
    strategy: r.strategy,
    asset: r.asset,
    description: r.description,
    chain: r.chain,
    status: r.status,
    entryPrice: Number(r.entry_price),
    currentPrice: Number(r.current_price),
    sizeUnits: Number(r.size_units),
    costBasisUsd: Number(r.cost_basis_usd),
    currentValueUsd: Number(r.current_value_usd),
    realizedPnlUsd: Number(r.realized_pnl_usd),
    unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
    entryTxHash: r.entry_tx_hash ?? undefined,
    exitTxHash: r.exit_tx_hash ?? undefined,
    externalId: r.external_id ?? undefined,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {},
    openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at,
    closedAt: r.closed_at ? (r.closed_at instanceof Date ? r.closed_at.toISOString() : r.closed_at) : undefined,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}
