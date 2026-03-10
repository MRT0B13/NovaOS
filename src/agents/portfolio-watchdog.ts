/**
 * Portfolio Watchdog Agent
 *
 * Role: Multi-chain portfolio monitoring with PnL tracking and alerts.
 * Aggregates positions across Solana (Jupiter, Orca, Kamino, Jito) and
 * EVM (Krystal LP, Polymarket, Hyperliquid) — surfaces gains, losses,
 * and rebalance opportunities.
 *
 * Data sources:
 *   - portfolioService → Aggregated portfolio snapshot
 *   - positionManager → Active positions across all strategies
 *   - krystalService → EVM LP positions + multi-chain balances
 *   - pnlTracker → Historical PnL data
 *   - Pyth Oracle → Real-time prices
 *
 * Philosophy: The CFO manages the portfolio. Portfolio Watchdog just
 * watches and alerts. Like a financial health dashboard that reports
 * anomalies, drawdowns, and rebalance signals.
 *
 * Alert triggers:
 *   - Portfolio value drops > X% in a single check
 *   - Single position PnL exceeds loss threshold
 *   - Portfolio concentration too heavy in one strategy
 *   - Unrealized gains exceed take-profit threshold
 *
 * Lifecycle: Factory-spawned via `portfolio_monitoring` capability.
 *
 * Outgoing messages → Supervisor:
 *   - alert (high): Portfolio drawdown or loss threshold hit
 *   - intel (medium): Rebalance opportunity, concentration warning
 *   - report (low): Periodic portfolio health summary
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Force a portfolio check
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import type { WalletConfig } from './wallet-utils.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Default check interval: 10 minutes */
const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Portfolio drawdown alert threshold (%) */
const DEFAULT_DRAWDOWN_THRESHOLD = 5;

/** Single position loss alert threshold (%) */
const DEFAULT_POSITION_LOSS_THRESHOLD = 15;

/** Strategy concentration warning threshold (%) */
const DEFAULT_CONCENTRATION_THRESHOLD = 40;

/** Unrealized gain take-profit signal threshold (%) */
const DEFAULT_TP_SIGNAL_THRESHOLD = 25;

/** Periodic report interval: 6 hours */
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

interface PortfolioState {
  totalValueUsd: number;
  solanaValueUsd: number;
  evmValueUsd: number;
  positionCount: number;
  strategyBreakdown: Record<string, {
    valueUsd: number;
    pctOfTotal: number;
    positionCount: number;
  }>;
  timestamp: number;
}

interface PortfolioAlert {
  type: 'drawdown' | 'position_loss' | 'concentration' | 'tp_signal' | 'health';
  severity: 'high' | 'medium' | 'low';
  description: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Portfolio Watchdog Agent
// ============================================================================

export class PortfolioWatchdogAgent extends BaseAgent {
  private checkIntervalMs: number;
  private drawdownThreshold: number;
  private positionLossThreshold: number;
  private concentrationThreshold: number;
  private tpSignalThreshold: number;
  private cycleCount = 0;
  private totalAlerts = 0;
  private lastReportAt = 0;
  private previousState: PortfolioState | null = null;
  private walletConfig?: WalletConfig;
  private allTimeHigh = 0; // Track portfolio ATH for drawdown calc

  constructor(pool: Pool, opts?: {
    checkIntervalMs?: number;
    drawdownThreshold?: number;
    positionLossThreshold?: number;
    concentrationThreshold?: number;
    wallet?: { chain: string; address: string; encryptedKey?: string; permissions: string[] };
  }) {
    super({
      agentId: 'nova-portfolio-watchdog',
      agentType: 'analyst',
      pool,
    });
    this.checkIntervalMs = opts?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.drawdownThreshold = opts?.drawdownThreshold ?? DEFAULT_DRAWDOWN_THRESHOLD;
    this.positionLossThreshold = opts?.positionLossThreshold ?? DEFAULT_POSITION_LOSS_THRESHOLD;
    this.concentrationThreshold = opts?.concentrationThreshold ?? DEFAULT_CONCENTRATION_THRESHOLD;
    this.tpSignalThreshold = DEFAULT_TP_SIGNAL_THRESHOLD;
    this.walletConfig = opts?.wallet as WalletConfig | undefined;
  }

  protected async onStart(): Promise<void> {
    const saved = await this.restoreState<{
      cycleCount: number;
      totalAlerts: number;
      allTimeHigh: number;
      lastReportAt: number;
      previousState: PortfolioState | null;
    }>();
    if (saved) {
      this.cycleCount = saved.cycleCount || 0;
      this.totalAlerts = saved.totalAlerts || 0;
      this.allTimeHigh = saved.allTimeHigh || 0;
      this.lastReportAt = saved.lastReportAt || 0;
      this.previousState = saved.previousState || null;
    }

    this.startHeartbeat(60_000);

    // First check after 60s warmup (portfolio services need time to initialize)
    setTimeout(() => this.runCheckCycle(), 60_000);

    // Recurring checks
    this.addInterval(() => this.runCheckCycle(), this.checkIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 30_000);

    logger.info(
      `[portfolio-watchdog] 📊 Online — monitoring portfolio every ${this.checkIntervalMs / 60000}min ` +
      `(drawdown: ${this.drawdownThreshold}%, position loss: ${this.positionLossThreshold}%)`
    );
  }

  protected async onStop(): Promise<void> {
    await this.persistState();
    logger.info(`[portfolio-watchdog] Stopped after ${this.cycleCount} checks, ${this.totalAlerts} alerts`);
  }

  // ── Main Check Cycle ───────────────────────────────────────────

  private async runCheckCycle(): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;
    await this.updateStatus('gathering');

    logger.debug(`[portfolio-watchdog] 📊 Cycle #${cycleId} — checking portfolio health...`);

    const alerts: PortfolioAlert[] = [];

    try {
      // Gather portfolio state from multiple sources
      const currentState = await this.gatherPortfolioState();

      if (!currentState) {
        logger.warn(`[portfolio-watchdog] Cycle #${cycleId}: Failed to gather portfolio state`);
        await this.updateStatus('degraded');
        return;
      }

      // Update ATH
      if (currentState.totalValueUsd > this.allTimeHigh) {
        this.allTimeHigh = currentState.totalValueUsd;
      }

      // Check 1: Portfolio drawdown from ATH
      if (this.allTimeHigh > 0) {
        const drawdownPct = ((this.allTimeHigh - currentState.totalValueUsd) / this.allTimeHigh) * 100;
        if (drawdownPct >= this.drawdownThreshold) {
          alerts.push({
            type: 'drawdown',
            severity: drawdownPct >= this.drawdownThreshold * 2 ? 'high' : 'medium',
            description: `Portfolio down ${drawdownPct.toFixed(1)}% from ATH ($${this.allTimeHigh.toFixed(0)} → $${currentState.totalValueUsd.toFixed(0)})`,
            details: { drawdownPct, ath: this.allTimeHigh, current: currentState.totalValueUsd },
          });
        }
      }

      // Check 2: Sudden value drop since last check
      if (this.previousState && this.previousState.totalValueUsd > 0) {
        const deltaPct = ((this.previousState.totalValueUsd - currentState.totalValueUsd) / this.previousState.totalValueUsd) * 100;
        if (deltaPct >= this.drawdownThreshold) {
          alerts.push({
            type: 'drawdown',
            severity: 'high',
            description: `Portfolio dropped ${deltaPct.toFixed(1)}% since last check ($${this.previousState.totalValueUsd.toFixed(0)} → $${currentState.totalValueUsd.toFixed(0)})`,
            details: { deltaPct, previous: this.previousState.totalValueUsd, current: currentState.totalValueUsd },
          });
        }
      }

      // Check 3: Strategy concentration
      for (const [strategy, data] of Object.entries(currentState.strategyBreakdown)) {
        if (data.pctOfTotal >= this.concentrationThreshold) {
          alerts.push({
            type: 'concentration',
            severity: 'medium',
            description: `${strategy} is ${data.pctOfTotal.toFixed(1)}% of portfolio ($${data.valueUsd.toFixed(0)}) — consider rebalancing`,
            details: { strategy, pctOfTotal: data.pctOfTotal, valueUsd: data.valueUsd },
          });
        }
      }

      // Check 4: Individual position PnL (from position manager)
      const positionAlerts = await this.checkPositionPnl();
      alerts.push(...positionAlerts);

      // Update state
      this.previousState = currentState;

      // Report alerts
      if (alerts.length > 0) {
        this.totalAlerts += alerts.length;

        const highAlerts = alerts.filter(a => a.severity === 'high');
        const otherAlerts = alerts.filter(a => a.severity !== 'high');

        if (highAlerts.length > 0) {
          await this.reportToSupervisor('alert', 'high', {
            type: 'portfolio_alert',
            cycle: cycleId,
            alerts: highAlerts,
            portfolioValue: currentState.totalValueUsd,
            summary: `🚨 Portfolio alert: ${highAlerts.map(a => a.description).join(' | ')}`,
          });
        }

        if (otherAlerts.length > 0) {
          await this.reportToSupervisor('intel', 'medium', {
            type: 'portfolio_warning',
            cycle: cycleId,
            alerts: otherAlerts,
            portfolioValue: currentState.totalValueUsd,
            summary: `📊 Portfolio check: ${otherAlerts.map(a => a.description).join(' | ')}`,
          });
        }
      }

      // Periodic health report
      if (Date.now() - this.lastReportAt > REPORT_INTERVAL_MS) {
        await this.sendPeriodicReport(currentState);
        this.lastReportAt = Date.now();
      }

      await this.updateStatus('alive');

      if (alerts.length > 0 || cycleId % 10 === 0) {
        logger.info(
          `[portfolio-watchdog] Cycle #${cycleId}: $${currentState.totalValueUsd.toFixed(0)} total ` +
          `(${currentState.positionCount} positions, ${alerts.length} alerts)`
        );
      }

    } catch (err: any) {
      logger.warn(`[portfolio-watchdog] Cycle #${cycleId} failed: ${err.message}`);
      await this.updateStatus('degraded');
    }

    // Persist state every 10 cycles
    if (this.cycleCount % 10 === 0) {
      await this.persistState();
    }
  }

  // ── Portfolio State Gathering ──────────────────────────────────

  private async gatherPortfolioState(): Promise<PortfolioState | null> {
    let totalValueUsd = 0;
    let solanaValueUsd = 0;
    let evmValueUsd = 0;
    let positionCount = 0;
    const strategyBreakdown: Record<string, { valueUsd: number; pctOfTotal: number; positionCount: number }> = {};

    try {
      // Try portfolioService first (aggregated view)
      try {
        const { getPortfolioSnapshot } = await import('../launchkit/cfo/portfolioService.ts');
        const snap = await getPortfolioSnapshot() as any;

        if (snap && (snap.totalPortfolioUsd || snap.totalWalletUsd || 0) > 0) {
          totalValueUsd = snap.totalPortfolioUsd || snap.totalWalletUsd || 0;

          // Extract chain-level breakdowns
          const chains = snap.chains || [];
          for (const chain of chains) {
            const chainValue = chain.totalUsd || 0;
            if (chain.chain === 'solana') solanaValueUsd += chainValue;
            else evmValueUsd += chainValue;
            if (chainValue > 0) {
              strategyBreakdown[`wallet-${chain.chain}`] = {
                valueUsd: chainValue,
                pctOfTotal: 0,
                positionCount: 1,
              };
            }
          }

          // Strategy-level positions
          const strategies = snap.strategies || [];
          for (const strat of strategies) {
            const value = strat.valueUsd || strat.deployedUsd || 0;
            if (value > 0) {
              strategyBreakdown[strat.name || strat.strategy || 'unknown'] = {
                valueUsd: value,
                pctOfTotal: 0,
                positionCount: strat.positionCount || 1,
              };
              positionCount += strat.positionCount || 1;
            }
          }
        }
      } catch {
        // portfolioService may not be initialized — gather manually
      }

      // Add EVM balances from Krystal
      try {
        const { getMultiChainEvmBalances } = await import('../launchkit/cfo/krystalService.ts');
        const evmBalances = await getMultiChainEvmBalances();

        for (const cb of evmBalances) {
          evmValueUsd += cb.totalValueUsd;
          const chainKey = `evm-${cb.chainName || cb.chainId}`;
          if (cb.totalValueUsd > 0) {
            if (!strategyBreakdown[chainKey]) {
              strategyBreakdown[chainKey] = { valueUsd: 0, pctOfTotal: 0, positionCount: 0 };
            }
            strategyBreakdown[chainKey].valueUsd += cb.totalValueUsd;
            strategyBreakdown[chainKey].positionCount++;
          }
        }

        // Update total if portfolio service didn't capture EVM
        if (totalValueUsd === 0) {
          totalValueUsd = solanaValueUsd + evmValueUsd;
        }
      } catch {
        // EVM not configured — that's fine
      }

      // Add Krystal LP positions
      try {
        const { fetchKrystalPositions } = await import('../launchkit/cfo/krystalService.ts');

        // Prefer user wallet config, fall back to system CFO env
        let walletAddress: string | null = null;
        if (this.walletConfig?.address && (this.walletConfig.chain === 'evm' || this.walletConfig.chain === 'both')) {
          walletAddress = this.walletConfig.address;
        } else {
          try {
            const { getCFOEnv } = await import('../launchkit/cfo/cfoEnv.ts');
            const env = getCFOEnv();
            if (env.evmPrivateKey) {
              const ethers = await import('ethers' as string);
              walletAddress = ethers.computeAddress(env.evmPrivateKey);
            }
          } catch { /* no CFO env */ }
        }

        if (walletAddress) {
          const positions = await fetchKrystalPositions(walletAddress) as any[];
          if (positions && Array.isArray(positions)) {
            for (const pos of positions) {
              const value = (pos as any).totalValueUsd || (pos as any).valueUsd || 0;
              if (value > 0) {
                if (!strategyBreakdown['evm-lp']) {
                  strategyBreakdown['evm-lp'] = { valueUsd: 0, pctOfTotal: 0, positionCount: 0 };
                }
                strategyBreakdown['evm-lp'].valueUsd += value;
                strategyBreakdown['evm-lp'].positionCount++;
                positionCount++;
                evmValueUsd += value;
              }
            }
          }
        }
      } catch {
        // LP positions not available
      }

      // Calculate percentages
      if (totalValueUsd > 0) {
        for (const data of Object.values(strategyBreakdown)) {
          data.pctOfTotal = (data.valueUsd / totalValueUsd) * 100;
        }
      }

      if (totalValueUsd === 0 && evmValueUsd === 0) {
        return null; // No portfolio data available
      }

      return {
        totalValueUsd: Math.max(totalValueUsd, solanaValueUsd + evmValueUsd),
        solanaValueUsd,
        evmValueUsd,
        positionCount,
        strategyBreakdown,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      logger.warn(`[portfolio-watchdog] State gathering failed: ${err.message}`);
      return null;
    }
  }

  // ── Position PnL Checks ────────────────────────────────────────

  private async checkPositionPnl(): Promise<PortfolioAlert[]> {
    const alerts: PortfolioAlert[] = [];

    try {
      // Check positions from DB
      const { rows } = await this.pool.query(
        `SELECT id, strategy, entry_price_usd, current_price_usd, size_usd, pnl_usd, pnl_pct, metadata
         FROM cfo_positions
         WHERE status = 'open' AND entry_price_usd > 0
         ORDER BY ABS(COALESCE(pnl_pct, 0)) DESC
         LIMIT 20`,
      );

      for (const pos of rows) {
        const pnlPct = pos.pnl_pct || 0;
        const pnlUsd = pos.pnl_usd || 0;

        // Loss alert
        if (pnlPct <= -this.positionLossThreshold) {
          alerts.push({
            type: 'position_loss',
            severity: pnlPct <= -this.positionLossThreshold * 2 ? 'high' : 'medium',
            description: `${pos.strategy} position down ${Math.abs(pnlPct).toFixed(1)}% ($${Math.abs(pnlUsd).toFixed(0)} loss)`,
            details: { positionId: pos.id, strategy: pos.strategy, pnlPct, pnlUsd, sizeUsd: pos.size_usd },
          });
        }

        // Take-profit signal
        if (pnlPct >= this.tpSignalThreshold) {
          alerts.push({
            type: 'tp_signal',
            severity: 'low',
            description: `${pos.strategy} position up ${pnlPct.toFixed(1)}% ($${pnlUsd.toFixed(0)} unrealized gain) — consider taking profit`,
            details: { positionId: pos.id, strategy: pos.strategy, pnlPct, pnlUsd, sizeUsd: pos.size_usd },
          });
        }
      }
    } catch {
      // cfo_positions table may not exist — that's fine for non-CFO setups
    }

    return alerts;
  }

  // ── Periodic Report ────────────────────────────────────────────

  private async sendPeriodicReport(state: PortfolioState): Promise<void> {
    const strategies = Object.entries(state.strategyBreakdown)
      .sort((a, b) => b[1].valueUsd - a[1].valueUsd)
      .map(([name, data]) => `${name}: $${data.valueUsd.toFixed(0)} (${data.pctOfTotal.toFixed(1)}%)`)
      .join('\n  ');

    await this.reportToSupervisor('report', 'low', {
      type: 'portfolio_health',
      portfolioValue: state.totalValueUsd,
      solanaValue: state.solanaValueUsd,
      evmValue: state.evmValueUsd,
      positionCount: state.positionCount,
      ath: this.allTimeHigh,
      drawdownFromAth: this.allTimeHigh > 0
        ? ((this.allTimeHigh - state.totalValueUsd) / this.allTimeHigh * 100).toFixed(1) + '%'
        : 'N/A',
      breakdown: state.strategyBreakdown,
      summary: `📊 Portfolio Health Report\n` +
        `  Total: $${state.totalValueUsd.toFixed(0)} (ATH: $${this.allTimeHigh.toFixed(0)})\n` +
        `  Solana: $${state.solanaValueUsd.toFixed(0)} | EVM: $${state.evmValueUsd.toFixed(0)}\n` +
        `  Positions: ${state.positionCount}\n` +
        `  ${strategies}`,
    });
  }

  // ── Command Processing ─────────────────────────────────────────

  private async processCommands(): Promise<void> {
    const messages = await this.readMessages(5);
    for (const msg of messages) {
      const payload = msg.payload;
      if (payload?.command === 'immediate_scan') {
        logger.info('[portfolio-watchdog] Received immediate_scan command');
        await this.runCheckCycle();
      }
      await this.acknowledgeMessage(msg.id!);
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      totalAlerts: this.totalAlerts,
      allTimeHigh: this.allTimeHigh,
      lastReportAt: this.lastReportAt,
      previousState: this.previousState,
    });
  }
}
