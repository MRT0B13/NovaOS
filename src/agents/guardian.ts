/**
 * Guardian Agent
 *
 * Role: Safety monitoring — RugCheck scans, LP tracking, whale movement alerts.
 * Wraps rugcheck.ts service and adds proactive monitoring loops.
 *
 * Runs on a schedule:
 *   - Watched token re-scan: every 15 minutes
 *   - LP lock checks: every 30 minutes (for tokens with known mint addresses)
 *
 * Outgoing messages → Supervisor:
 *   - alert (critical): Rug detected, mint/freeze authority re-enabled, 50%+ supply dump
 *   - alert (high): New risk flag, LP unlocked, score degradation > 20 points
 *   - report (medium): Periodic safety summary, scan result on request
 *
 * Incoming commands ← Supervisor:
 *   - scan_token: Scan a specific token address and report back
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Lazy imports
let _scanToken: ((mint: string) => Promise<any>) | null = null;
let _isSafe: ((report: any) => boolean) | null = null;
let _formatReportForTelegram: ((report: any, ticker?: string) => string) | null = null;

async function loadRugcheck() {
  if (!_scanToken) {
    const mod = await import('../launchkit/services/rugcheck.ts');
    _scanToken = mod.scanToken;
    _isSafe = mod.isSafe;
    _formatReportForTelegram = mod.formatReportForTelegram;
  }
}

// ============================================================================
// Guardian Agent
// ============================================================================

interface WatchedToken {
  mint: string;
  ticker?: string;
  lastScore: number;
  lastCheckedAt: number;
  addedAt: number;
}

export class GuardianAgent extends BaseAgent {
  private watchList: Map<string, WatchedToken> = new Map();
  private rescanIntervalMs: number;
  private scanCount = 0;

  constructor(pool: Pool, opts?: { rescanIntervalMs?: number }) {
    super({
      agentId: 'nova-guardian',
      agentType: 'guardian',
      pool,
    });
    this.rescanIntervalMs = opts?.rescanIntervalMs ?? 15 * 60 * 1000; // 15 min
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Periodic re-scan of watched tokens
    this.addInterval(() => this.rescanWatchList(), this.rescanIntervalMs);

    // Listen for supervisor commands (scan requests)
    this.addInterval(() => this.processCommands(), 10_000);

    // Load initial watch list from DB (launched tokens)
    await this.loadWatchListFromDB();

    logger.info(`[guardian] Monitoring ${this.watchList.size} tokens, re-scan every ${this.rescanIntervalMs / 60000}m`);
  }

  // ── Watch List Management ────────────────────────────────────────

  /** Add a token to the watch list */
  addToWatchList(mint: string, ticker?: string): void {
    if (!this.watchList.has(mint)) {
      this.watchList.set(mint, {
        mint,
        ticker,
        lastScore: -1,
        lastCheckedAt: 0,
        addedAt: Date.now(),
      });
      logger.info(`[guardian] Added ${ticker || mint.slice(0, 8)} to watch list`);
    }
  }

  /** Remove a token from the watch list */
  removeFromWatchList(mint: string): void {
    this.watchList.delete(mint);
  }

  /** Load launched tokens from launchpack DB to auto-watch */
  private async loadWatchListFromDB(): Promise<void> {
    try {
      // Check if kv_store table exists before querying to avoid PG error log noise
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'kv_store' LIMIT 1`
      );
      if (tableCheck.rows.length === 0) {
        logger.debug('[guardian] No existing tokens to watch (kv_store not available)');
        return;
      }
      const result = await this.pool.query(
        `SELECT data FROM kv_store WHERE key LIKE 'launchpack:%'`,
      );
      for (const row of result.rows) {
        try {
          const pack = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          if (pack?.launch?.mint && pack?.launch?.status === 'launched') {
            this.addToWatchList(pack.launch.mint, pack.brand?.ticker || pack.brand?.name);
          }
        } catch { /* skip malformed */ }
      }
    } catch {
      // kv_store may not exist yet — that's fine
      logger.debug('[guardian] No existing tokens to watch (kv_store not available)');
    }
  }

  // ── Scanning ─────────────────────────────────────────────────────

  /** Scan a single token and assess safety */
  async scanAndAssess(mint: string, requestedBy?: string): Promise<any> {
    await loadRugcheck();
    const report = await _scanToken!(mint);
    if (!report) return null;

    this.scanCount++;
    const safe = _isSafe!(report);

    // Update watch list if we're tracking this token
    const watched = this.watchList.get(mint);
    if (watched) {
      const previousScore = watched.lastScore;
      watched.lastScore = report.score;
      watched.lastCheckedAt = Date.now();

      // Detect score degradation (higher score = riskier)
      if (previousScore >= 0 && report.score - previousScore > 20) {
        await this.reportToSupervisor('alert', 'high', {
          tokenAddress: mint,
          tokenName: watched.ticker,
          score: report.score,
          previousScore,
          alerts: [`Score degraded from ${previousScore} to ${report.score}`],
          degradation: report.score - previousScore,
        });
      }
    }

    // Critical alerts for dangerous findings
    if (report.isRugged || report.mintAuthority || report.freezeAuthority) {
      const alerts: string[] = [];
      if (report.isRugged) alerts.push('TOKEN IS RUGGED');
      if (report.mintAuthority) alerts.push('Mint authority still active');
      if (report.freezeAuthority) alerts.push('Freeze authority still active');

      await this.reportToSupervisor('alert', 'critical', {
        tokenAddress: mint,
        tokenName: watched?.ticker,
        score: report.score,
        riskLevel: report.riskLevel,
        alerts,
        isRugged: report.isRugged,
      });
    } else if (!safe) {
      // Non-critical but unsafe
      const alerts = report.risks?.map((r: any) => `${r.level}: ${r.name}`) || [];
      await this.reportToSupervisor('alert', 'high', {
        tokenAddress: mint,
        tokenName: watched?.ticker,
        score: report.score,
        riskLevel: report.riskLevel,
        alerts,
      });
    }

    // If scan was requested, send formatted report back
    if (requestedBy) {
      const formatted = _formatReportForTelegram!(report, watched?.ticker);
      await this.reportToSupervisor('report', 'medium', {
        requestedBy,
        report: {
          tokenName: watched?.ticker || mint.slice(0, 8),
          score: report.score,
          summary: formatted,
        },
      });
    }

    return report;
  }

  // ── Periodic Re-scan ─────────────────────────────────────────────

  private async rescanWatchList(): Promise<void> {
    if (!this.running || this.watchList.size === 0) return;

    await this.updateStatus('scanning');
    let scanned = 0;
    let alerts = 0;

    for (const [mint, token] of this.watchList) {
      // Skip recently scanned tokens (at most once per rescan interval)
      if (Date.now() - token.lastCheckedAt < this.rescanIntervalMs * 0.8) continue;

      try {
        const report = await this.scanAndAssess(mint);
        if (report) {
          scanned++;
          if (report.score > 500 || report.isRugged) alerts++;
        }

        // Rate limit: small delay between scans
        await new Promise(resolve => setTimeout(resolve, 2_000));
      } catch (err) {
        logger.warn(`[guardian] Failed to re-scan ${token.ticker || mint.slice(0, 8)}:`, err);
      }
    }

    if (scanned > 0) {
      logger.info(`[guardian] Re-scanned ${scanned}/${this.watchList.size} tokens, ${alerts} alerts`);
    }
    await this.updateStatus('alive');
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'request' && msg.payload?.action === 'scan_token') {
          const { tokenAddress, requestedBy } = msg.payload;
          logger.info(`[guardian] Scan requested for ${tokenAddress}`);
          await this.scanAndAssess(tokenAddress, requestedBy);
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      watchListSize: this.watchList.size,
      totalScans: this.scanCount,
      watchedTokens: Array.from(this.watchList.values()).map(t => ({
        mint: t.mint.slice(0, 8) + '...',
        ticker: t.ticker,
        score: t.lastScore,
        lastChecked: t.lastCheckedAt ? new Date(t.lastCheckedAt).toISOString() : null,
      })),
    };
  }
}
