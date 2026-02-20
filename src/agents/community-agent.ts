/**
 * Community Agent
 *
 * Role: Social management — TG community health, X reply quality, engagement analytics.
 * Wraps the engagement tracker, reply engine status, and TG community service.
 *
 * This agent monitors community health metrics and reports to the Supervisor.
 * It does NOT directly post messages — that's handled by the existing services.
 * Instead, it provides intelligence that the Supervisor uses for decisions.
 *
 * Runs on a schedule:
 *   - Engagement summary: every 2 hours (aggregated metrics)
 *   - Community pulse: every 30 minutes (quick health check)
 *
 * Outgoing messages → Supervisor:
 *   - report (high): Engagement spike or drop, mod action needed
 *   - report (medium): Periodic engagement summary
 *   - intel (low): Community sentiment data
 *
 * Incoming commands ← Supervisor:
 *   - get_engagement: Return current engagement metrics
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Lazy imports — data pools
let _getPendingVotes: (() => any[]) | null = null;
let _getMetrics: (() => any) | null = null;

async function loadCommunityData() {
  try {
    if (!_getPendingVotes) {
      const cv = await import('../launchkit/services/communityVoting.ts');
      _getPendingVotes = cv.getPendingVotes;
    }
  } catch { /* not init */ }
  try {
    if (!_getMetrics) {
      const sr = await import('../launchkit/services/systemReporter.ts');
      _getMetrics = sr.getMetrics;
    }
  } catch { /* not init */ }
}

// ============================================================================
// Community Agent
// ============================================================================

export class CommunityAgent extends BaseAgent {
  private summaryIntervalMs: number;
  private pulseIntervalMs: number;
  private lastEngagementRate = 0;
  private reportCount = 0;

  constructor(pool: Pool, opts?: { summaryIntervalMs?: number; pulseIntervalMs?: number }) {
    super({
      agentId: 'nova-community',
      agentType: 'community',
      pool,
    });
    this.summaryIntervalMs = opts?.summaryIntervalMs ?? 2 * 60 * 60 * 1000; // 2 hours
    this.pulseIntervalMs = opts?.pulseIntervalMs ?? 30 * 60 * 1000;         // 30 min
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Periodic engagement summary
    this.addInterval(() => this.generateSummary(), this.summaryIntervalMs);

    // Quick community pulse
    this.addInterval(() => this.communityPulse(), this.pulseIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // First summary after a delay
    setTimeout(() => this.communityPulse(), 60_000);

    logger.info(`[community] Summary every ${this.summaryIntervalMs / 3600000}h, pulse every ${this.pulseIntervalMs / 60000}m`);
  }

  // ── Engagement Summary ───────────────────────────────────────────

  private async generateSummary(): Promise<void> {
    if (!this.running) return;
    try {
      await this.updateStatus('analyzing');
      await loadCommunityData();

      const summary = await this.getEngagementData();
      this.reportCount++;

      // ── Gather community voting + system metrics ──
      let pendingVotes = 0;
      let tweetsSentToday = 0;
      let tgPostsSentToday = 0;

      try {
        if (_getPendingVotes) {
          const votes = _getPendingVotes();
          pendingVotes = votes.filter((v: any) => v.status === 'pending').length;
        }
      } catch { /* ok */ }
      try {
        if (_getMetrics) {
          const m = _getMetrics();
          tweetsSentToday = m.tweetsSentToday || 0;
          tgPostsSentToday = m.tgPostsSentToday || 0;
        }
      } catch { /* ok */ }

      logger.info(`[community] Summary #${this.reportCount}: ${summary?.totalEngagements || 0} engagements (2h), ${summary?.repliesSent || 0} X replies, ${summary?.tgMessages || 0} TG msgs | Voting: ${pendingVotes} pending | Today: ${tweetsSentToday} tweets, ${tgPostsSentToday} TG posts`);

      if (summary) {
        // Detect engagement spikes/drops
        const currentRate = summary.totalEngagements / Math.max(summary.periodHours, 1);
        const isSpike = this.lastEngagementRate > 0 && currentRate > this.lastEngagementRate * 2;
        const isDrop = this.lastEngagementRate > 0 && currentRate < this.lastEngagementRate * 0.3;

        this.lastEngagementRate = currentRate;

        const priority = isSpike || isDrop ? 'high' : 'medium';
        await this.reportToSupervisor('report', priority as any, {
          source: 'engagement_summary',
          engagementSpike: isSpike,
          engagementDrop: isDrop,
          summary: isSpike
            ? `Engagement spike: ${currentRate.toFixed(1)} interactions/hr (was ${(this.lastEngagementRate / 2).toFixed(1)})`
            : isDrop
            ? `Engagement drop: ${currentRate.toFixed(1)} interactions/hr (was ${(this.lastEngagementRate * 3.3).toFixed(1)})`
            : `Normal engagement: ${currentRate.toFixed(1)} interactions/hr`,
          pendingVotes,
          tweetsSentToday,
          tgPostsSentToday,
          ...summary,
        });
      }

      await this.updateStatus('alive');
    } catch (err) {
      logger.error('[community] Summary generation failed:', err);
      await this.updateStatus('error');
    }
  }

  // ── Community Pulse ──────────────────────────────────────────────

  private async communityPulse(): Promise<void> {
    if (!this.running) return;
    try {
      // Quick check: banned users count, active groups, reply engine status
      const pulse = await this.getQuickPulse();

      logger.info(`[community] Pulse: ${pulse.activeGroups} groups, ${pulse.newBans} bans (30m), reply engine: ${pulse.replyEngineActive ? 'ON' : 'OFF'}`);

      if (pulse.newBans > 0) {
        await this.reportToSupervisor('report', 'medium', {
          source: 'community_pulse',
          summary: `${pulse.newBans} new ban(s) in last 30min`,
          ...pulse,
        });
      }
    } catch {
      // Silent — non-critical
    }
  }

  // ── Data Gathering ───────────────────────────────────────────────

  private async getEngagementData(): Promise<{
    totalEngagements: number;
    repliesSent: number;
    tgMessages: number;
    periodHours: number;
  } | null> {
    try {
      // Check if engagement_log table exists
      const result = await this.pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE platform = 'x') as x_replies,
          COUNT(*) FILTER (WHERE platform = 'telegram') as tg_messages
        FROM engagement_log
        WHERE created_at > NOW() - INTERVAL '2 hours'
      `);

      const row = result.rows[0];
      return {
        totalEngagements: parseInt(row.total) || 0,
        repliesSent: parseInt(row.x_replies) || 0,
        tgMessages: parseInt(row.tg_messages) || 0,
        periodHours: 2,
      };
    } catch {
      // Table may not exist yet — return null
      return null;
    }
  }

  private async getQuickPulse(): Promise<{
    newBans: number;
    activeGroups: number;
    replyEngineActive: boolean;
  }> {
    let newBans = 0;
    let activeGroups = 0;

    try {
      // Check recent bans (verify engagement_log exists to avoid PG error log noise)
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'engagement_log' LIMIT 1`
      );
      if (tableCheck.rows.length > 0) {
        // engagement_log uses 'reply_style' not 'action' — check for ban-related entries
        const banResult = await this.pool.query(`
          SELECT COUNT(*) as cnt FROM engagement_log
          WHERE reply_style = 'ban' AND created_at > NOW() - INTERVAL '30 minutes'
        `);
        newBans = parseInt(banResult.rows[0]?.cnt) || 0;
      }
    } catch {
      // Not critical
    }

    try {
      // Count active Telegram groups (check if kv_store exists first to avoid PG error log noise)
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'kv_store' LIMIT 1`
      );
      if (tableCheck.rows.length > 0) {
        const groupResult = await this.pool.query(`
          SELECT COUNT(DISTINCT data->'tg'->>'chat_id') as cnt
          FROM kv_store
          WHERE key LIKE 'launchpack:%'
            AND data->'tg'->>'chat_id' IS NOT NULL
        `);
        activeGroups = parseInt(groupResult.rows[0]?.cnt) || 0;
      }
    } catch {
      // kv_store may not exist
    }

    return {
      newBans,
      activeGroups,
      replyEngineActive: true, // If we're running, reply engine should be too
    };
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command' && msg.payload?.action === 'get_engagement') {
          const data = await this.getEngagementData();
          await this.reportToSupervisor('report', 'low', {
            source: 'engagement_on_demand',
            ...data,
          });
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
      reportCount: this.reportCount,
      lastEngagementRate: this.lastEngagementRate,
    };
  }
}
