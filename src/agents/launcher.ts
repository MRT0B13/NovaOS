/**
 * Launcher Agent
 *
 * Role: Token launch pipeline — idea gen, art gen, pump.fun deploy, graduation monitoring.
 * Wraps PumpLauncherService, autonomousMode, and ideaGenerator.
 *
 * This agent does NOT autonomously launch tokens — it wraps the existing
 * autonomous-mode logic and reports status to the Supervisor. Actual launch
 * decisions are still gated by the existing guardrails in operatorGuardrails.ts.
 *
 * Outgoing messages → Supervisor:
 *   - status (high): Token launched / graduated
 *   - status (medium): Launch pipeline stage update
 *   - report (low): Periodic launch stats
 *
 * Incoming commands ← Supervisor:
 *   - launch_token: Initiate a launch with given config (still goes through guardrails)
 *   - get_status: Return current pipeline status
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Lazy imports
let _getAutonomousStatus: (() => any) | null = null;
let _triggerAutonomousLaunch: (() => Promise<{ success: boolean; error?: string }>) | null = null;
let _getPnLSummary: ((prices?: Record<string, number>) => Promise<any>) | null = null;

async function loadAutonomous() {
  if (!_getAutonomousStatus) {
    const mod = await import('../launchkit/services/autonomousMode.ts');
    _getAutonomousStatus = mod.getAutonomousStatus;
    _triggerAutonomousLaunch = mod.triggerAutonomousLaunch;
  }
}

async function loadPnL() {
  try {
    if (!_getPnLSummary) {
      const mod = await import('../launchkit/services/pnlTracker.ts');
      _getPnLSummary = mod.getPnLSummary;
    }
  } catch { /* not init */ }
}

// ============================================================================
// Launcher Agent
// ============================================================================

export class LauncherAgent extends BaseAgent {
  private statusCheckIntervalMs: number;
  private launchCount = 0;
  private lastLaunchAt = 0;
  private lastError: string | null = null;
  private lastKnownLaunchesToday = 0;
  private reportedGraduations: Set<string> = new Set();

  constructor(pool: Pool, opts?: { statusCheckIntervalMs?: number }) {
    super({
      agentId: 'nova-launcher',
      agentType: 'launcher',
      pool,
    });
    this.statusCheckIntervalMs = opts?.statusCheckIntervalMs ?? 5 * 60 * 1000; // 5 min
  }

  protected async onStart(): Promise<void> {
    // Restore persisted counters from DB (survive restarts)
    await this.restorePersistedState();

    this.startHeartbeat(60_000);

    // Periodic status check + graduation monitoring
    this.addInterval(() => this.checkPipelineStatus(), this.statusCheckIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // Monitor launched tokens for graduation (check kv_store for status changes)
    this.addInterval(() => this.monitorGraduations(), 10 * 60 * 1000); // every 10 min

    logger.info('[launcher] Started — wrapping autonomous mode pipeline');
  }

  // ── Pipeline Status Check ────────────────────────────────────────

  private async checkPipelineStatus(): Promise<void> {
    if (!this.running) return;
    try {
      await loadAutonomous();
      const status = _getAutonomousStatus!();
      const totalLaunches = (status.launchesToday || 0) + (status.reactiveLaunchesToday || 0);

      await this.updateStatus(status.enabled ? 'active' : 'idle');

      const nextStr = status.nextScheduledTime
        ? new Date(status.nextScheduledTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
        : 'none';
      logger.info(`[launcher] Pipeline: enabled=${status.enabled}, dryRun=${status.dryRun}, launches today=${totalLaunches}, next=${nextStr} UTC`);

      // Detect new launches by comparing today's count
      if (totalLaunches > this.lastKnownLaunchesToday) {
        const newLaunches = totalLaunches - this.lastKnownLaunchesToday;
        this.lastKnownLaunchesToday = totalLaunches;
        this.launchCount += newLaunches;
        this.lastLaunchAt = Date.now();

        await this.reportToSupervisor('status', 'high', {
          event: 'launched',
          tokenName: status.pendingIdea?.name || 'Unknown',
          launchNumber: this.launchCount,
          dryRun: status.dryRun,
        });
      } else {
        this.lastKnownLaunchesToday = totalLaunches;
      }
    } catch (err) {
      logger.debug('[launcher] Status check failed:', err);
    }
  }

  // ── Graduation Monitoring ────────────────────────────────────────

  private async monitorGraduations(): Promise<void> {
    if (!this.running) return;
    try {
      // Check if kv_store exists before querying to avoid PG error log noise
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'kv_store' LIMIT 1`
      );
      if (tableCheck.rows.length === 0) return;

      const result = await this.pool.query(
        `SELECT data FROM kv_store WHERE key LIKE 'launchpack:%'`,
      );

      for (const row of result.rows) {
        try {
          const pack = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          const mint = pack?.launch?.mint;
          if (pack?.launch?.graduated && mint && !this.reportedGraduations.has(mint)) {
            this.reportedGraduations.add(mint);
            await this.reportToSupervisor('status', 'high', {
              event: 'graduated',
              tokenName: pack.brand?.name,
              tokenSymbol: pack.brand?.ticker,
              mint,
            });

            logger.info(`[launcher] Graduation detected: ${pack.brand?.name || pack.brand?.ticker}`);
          }
        } catch { /* skip malformed */ }
      }
    } catch {
      // kv_store may not exist
    }
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command') {
          switch (msg.payload?.action) {
            case 'launch_token':
              await this.handleLaunchRequest(msg.payload);
              break;
            case 'get_status':
              await this.reportCurrentStatus();
              break;
          }
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  private async handleLaunchRequest(payload: Record<string, any>): Promise<void> {
    try {
      await loadAutonomous();
      logger.info('[launcher] Launch requested via supervisor command');

      const result = await _triggerAutonomousLaunch!();

      if (result.success) {
        this.launchCount++;
        this.lastLaunchAt = Date.now();
        await this.persistState();
        await this.reportToSupervisor('status', 'high', {
          event: 'launch_initiated',
          success: true,
        });
      } else {
        this.lastError = result.error || 'Unknown error';
        await this.reportToSupervisor('status', 'medium', {
          event: 'launch_failed',
          success: false,
          error: this.lastError,
        });
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error('[launcher] Launch failed:', err);
    }
  }

  private async reportCurrentStatus(): Promise<void> {
    await loadAutonomous();
    await loadPnL();
    const status = _getAutonomousStatus!();

    let pnl: { totalPnl: number; activePositions: number; winRate: number } | undefined;
    try {
      if (_getPnLSummary) {
        const summary = await _getPnLSummary();
        pnl = { totalPnl: summary.totalPnl, activePositions: summary.activePositions, winRate: summary.winRate };
      }
    } catch { /* ok */ }

    await this.reportToSupervisor('report', 'low', {
      source: 'launcher_status',
      enabled: status.enabled,
      dryRun: status.dryRun,
      totalLaunches: this.launchCount,
      launchesToday: status.launchesToday,
      reactiveLaunchesToday: status.reactiveLaunchesToday,
      lastLaunchAt: this.lastLaunchAt ? new Date(this.lastLaunchAt).toISOString() : null,
      lastError: this.lastError,
      nextScheduled: status.nextScheduledTime,
      pnl,
    });
  }

  // ── State Persistence (survive restarts) ─────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      launchCount: this.launchCount,
      lastLaunchAt: this.lastLaunchAt,
      reportedGraduations: [...this.reportedGraduations],
    });
  }

  private async restorePersistedState(): Promise<void> {
    const s = await this.restoreState<{
      launchCount?: number;
      lastLaunchAt?: number;
      reportedGraduations?: string[];
    }>();
    if (!s) return;
    if (s.launchCount)           this.launchCount = s.launchCount;
    if (s.lastLaunchAt)          this.lastLaunchAt = s.lastLaunchAt;
    if (s.reportedGraduations)   this.reportedGraduations = new Set(s.reportedGraduations);
    logger.info(`[launcher] Restored: ${this.launchCount} launches, ${this.reportedGraduations.size} graduations`);
  }

  // ── Public API ───────────────────────────────────────────────────

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      launchCount: this.launchCount,
      lastLaunchAt: this.lastLaunchAt ? new Date(this.lastLaunchAt).toISOString() : null,
      lastError: this.lastError,
      graduationCount: this.reportedGraduations.size,
    };
  }
}
