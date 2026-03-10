/**
 * Arb Scanner Agent
 *
 * Role: Cross-DEX arbitrage opportunity detection on EVM chains.
 * Wraps the existing evmArbService for read-only scanning — spotting
 * price discrepancies across Uniswap V3, Camelot V3, PancakeSwap V3,
 * and Balancer on Arbitrum.
 *
 * Data sources:
 *   - evmArbService → DeFiLlama pool discovery + on-chain quoter calls
 *   - Krystal → Additional cross-chain pool data
 *
 * Key invariant: This agent NEVER executes trades. It only scans and
 * reports opportunities. The CFO decides whether to execute.
 *
 * Lifecycle: Factory-spawned via `arb_scanning` capability.
 *
 * Outgoing messages → Supervisor:
 *   - alert (high): Profitable arb opportunity detected (>$5 net profit)
 *   - intel (medium): Price discrepancies worth noting
 *   - report (low): Periodic arb landscape summary
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Force a scan cycle
 *   - refresh_pools: Force pool list refresh
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Default scan interval: 2 minutes (arb is time-sensitive) */
const DEFAULT_SCAN_INTERVAL_MS = 2 * 60 * 1000;

/** Minimum profit (USD) to report an opportunity */
const DEFAULT_MIN_PROFIT_USD = 5;

/** Pool refresh interval: 4 hours */
const POOL_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Max opportunities to report per cycle */
const MAX_OPPS_PER_CYCLE = 5;

/** Default ETH price fallback */
const DEFAULT_ETH_PRICE = 3000;

// ============================================================================
// Types
// ============================================================================

interface ArbSnapshot {
  timestamp: number;
  opportunity: ArbOppSummary | null;
  poolCount: number;
  scanTimeMs: number;
}

interface ArbOppSummary {
  buyDex: string;
  sellDex: string;
  token: string;
  spreadBps: number;
  estimatedProfitUsd: number;
  flashAmountUsd: number;
  pair: string;
}

// ============================================================================
// Arb Scanner Agent
// ============================================================================

export class ArbScannerAgent extends BaseAgent {
  private scanIntervalMs: number;
  private minProfitUsd: number;
  private cycleCount = 0;
  private totalOppsFound = 0;
  private consecutiveEmptyScans = 0;
  private lastPoolRefresh = 0;
  private recentOpps: ArbSnapshot[] = [];

  constructor(pool: Pool, opts?: {
    scanIntervalMs?: number;
    minProfitUsd?: number;
    wallet?: { chain: string; address: string; encryptedKey?: string; permissions: string[] };
  }) {
    super({
      agentId: 'nova-arb-scanner',
      agentType: 'analyst',
      pool,
    });
    this.scanIntervalMs = opts?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.minProfitUsd = opts?.minProfitUsd ?? DEFAULT_MIN_PROFIT_USD;
  }

  protected async onStart(): Promise<void> {
    const saved = await this.restoreState<{
      cycleCount: number;
      totalOppsFound: number;
      lastPoolRefresh: number;
    }>();
    if (saved) {
      this.cycleCount = saved.cycleCount || 0;
      this.totalOppsFound = saved.totalOppsFound || 0;
      this.lastPoolRefresh = saved.lastPoolRefresh || 0;
    }

    this.startHeartbeat(60_000);

    // Initialize pool list on startup
    setTimeout(() => this.ensurePools(), 20_000);

    // First scan after 60s warmup (pools need to load)
    setTimeout(() => this.runScanCycle(), 60_000);

    // Recurring scans — fast interval since arb is time-sensitive
    this.addInterval(() => this.runScanCycle(), this.scanIntervalMs);

    // Periodic pool refresh
    this.addInterval(() => this.refreshPoolsIfStale(), POOL_REFRESH_INTERVAL_MS);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 30_000);

    logger.info(
      `[arb-scanner] ⚡ Online — scanning Arbitrum DEXs every ${this.scanIntervalMs / 1000}s ` +
      `(min profit: $${this.minProfitUsd})`
    );
  }

  protected async onStop(): Promise<void> {
    await this.persistState();
    logger.info(`[arb-scanner] Stopped after ${this.cycleCount} scans, ${this.totalOppsFound} opps found`);
  }

  // ── Pool Management ────────────────────────────────────────────

  private async ensurePools(): Promise<void> {
    try {
      const { refreshCandidatePools, getCandidatePoolCount } = await import('../launchkit/cfo/evmArbService.ts');

      const count = getCandidatePoolCount();
      if (count === 0 || Date.now() - this.lastPoolRefresh > POOL_REFRESH_INTERVAL_MS) {
        logger.info('[arb-scanner] Refreshing candidate pool list...');
        const pools = await refreshCandidatePools();
        this.lastPoolRefresh = Date.now();
        logger.info(`[arb-scanner] Loaded ${pools.length} candidate pools`);
      }
    } catch (err: any) {
      logger.warn(`[arb-scanner] Pool refresh failed: ${err.message}`);
    }
  }

  private async refreshPoolsIfStale(): Promise<void> {
    if (Date.now() - this.lastPoolRefresh > POOL_REFRESH_INTERVAL_MS) {
      await this.ensurePools();
    }
  }

  // ── Main Scan Cycle ────────────────────────────────────────────

  private async runScanCycle(): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;
    const scanStart = Date.now();

    try {
      await this.updateStatus('gathering');

      const { scanForOpportunity, getCandidatePoolCount } = await import('../launchkit/cfo/evmArbService.ts');

      const poolCount = getCandidatePoolCount();
      if (poolCount === 0) {
        // No pools loaded — try refreshing
        await this.ensurePools();
        if (getCandidatePoolCount() === 0) {
          logger.debug(`[arb-scanner] Cycle #${cycleId}: No candidate pools available`);
          return;
        }
      }

      // Get ETH price for profit calculation
      let ethPrice = DEFAULT_ETH_PRICE;
      try {
        const { getEthPrice } = await import('../launchkit/cfo/pythOracleService.ts');
        ethPrice = await getEthPrice();
      } catch { /* use fallback */ }

      // Scan for opportunities
      const opp = await scanForOpportunity(ethPrice) as any;

      const scanTimeMs = Date.now() - scanStart;

      if (opp && (opp.netProfitUsd ?? opp.estimatedProfitUsd ?? 0) >= this.minProfitUsd) {
        this.totalOppsFound++;
        this.consecutiveEmptyScans = 0;

        const profitUsd = opp.netProfitUsd ?? opp.estimatedProfitUsd ?? 0;
        const summary: ArbOppSummary = {
          buyDex: opp.buyPool?.dex || 'unknown',
          sellDex: opp.sellPool?.dex || 'unknown',
          token: opp.tokenOut?.symbol || opp.flashLoanSymbol || 'unknown',
          spreadBps: opp.spreadBps || 0,
          estimatedProfitUsd: profitUsd,
          flashAmountUsd: opp.flashAmountUsd || 0,
          pair: opp.displayPair || `${opp.flashLoanSymbol || '?'}/USDC`,
        };

        // Track recent opportunities
        this.recentOpps.push({
          timestamp: Date.now(),
          opportunity: summary,
          poolCount,
          scanTimeMs,
        });
        if (this.recentOpps.length > 20) this.recentOpps = this.recentOpps.slice(-15);

        // Report to supervisor
        const priority = (summary.estimatedProfitUsd >= 50) ? 'high' as const : 'medium' as const;
        await this.reportToSupervisor('alert', priority, {
          type: 'arb_opportunity',
          cycle: cycleId,
          opportunity: summary,
          poolCount,
          scanTimeMs,
          ethPrice,
          summary: `⚡ Arb detected: Buy ${summary.token} on ${summary.buyDex}, sell on ${summary.sellDex} ` +
            `→ ${summary.spreadBps}bps spread, ~$${summary.estimatedProfitUsd.toFixed(2)} profit ` +
            `(flash: $${(summary.flashAmountUsd / 1000).toFixed(1)}k)`,
        });

        logger.info(
          `[arb-scanner] Cycle #${cycleId}: ⚡ OPP FOUND — ${summary.buyDex}→${summary.sellDex} ` +
          `${summary.token} ${summary.spreadBps}bps $${summary.estimatedProfitUsd.toFixed(2)} profit ` +
          `(${scanTimeMs}ms, ${poolCount} pools)`
        );
      } else {
        this.consecutiveEmptyScans++;

        // Periodic summary when nothing found (every 30 empty scans ≈ 1hr at 2min interval)
        if (this.consecutiveEmptyScans % 30 === 0) {
          await this.reportToSupervisor('report', 'low', {
            type: 'arb_scan_summary',
            cyclesSinceLastOpp: this.consecutiveEmptyScans,
            totalOppsFound: this.totalOppsFound,
            poolCount,
            recentOpps: this.recentOpps.slice(-5),
            summary: `Arb scanner: ${this.consecutiveEmptyScans} scans with no opportunity. ` +
              `${poolCount} pools monitored, ${this.totalOppsFound} total opps found all-time.`,
          });
        }

        if (cycleId % 10 === 0) { // Log every 10th cycle to avoid spam
          logger.debug(`[arb-scanner] Cycle #${cycleId}: No arb found (${poolCount} pools, ${scanTimeMs}ms)`);
        }
      }

      await this.updateStatus('alive');
    } catch (err: any) {
      logger.warn(`[arb-scanner] Cycle #${cycleId} failed: ${err.message}`);
      await this.updateStatus('degraded');
    }

    // Persist state every 50 cycles
    if (this.cycleCount % 50 === 0) {
      await this.persistState();
    }
  }

  // ── Command Processing ─────────────────────────────────────────

  private async processCommands(): Promise<void> {
    const messages = await this.readMessages(5);
    for (const msg of messages) {
      const payload = msg.payload;
      if (payload?.command === 'immediate_scan') {
        logger.info('[arb-scanner] Received immediate_scan command');
        await this.runScanCycle();
      } else if (payload?.command === 'refresh_pools') {
        logger.info('[arb-scanner] Received refresh_pools command');
        this.lastPoolRefresh = 0; // Force refresh
        await this.ensurePools();
      }
      await this.acknowledgeMessage(msg.id!);
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      totalOppsFound: this.totalOppsFound,
      lastPoolRefresh: this.lastPoolRefresh,
    });
  }
}
