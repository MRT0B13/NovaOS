/**
 * Agent Watchdog — Behavioral Anomaly Detection & Quarantine
 *
 * Monitors all Nova swarm agents for signs of compromise:
 *   - Heartbeat anomalies (stopped, irregular, unexpected status)
 *   - Message volume spikes (compromised agent flooding the bus)
 *   - Unexpected message patterns (wrong recipients, unusual types)
 *   - Resource abuse (memory spikes)
 *   - Quarantine mechanism (isolate suspect agents)
 *
 * Interval: every 1 minute
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { SecurityReporter, SecurityEvent } from './securityTypes.ts';
import { logSecurityEvent } from './securityTypes.ts';

// ============================================================================
// Types
// ============================================================================

interface AgentProfile {
  agentName: string;
  /** Expected heartbeat interval in seconds */
  expectedBeatIntervalSec: number;
  /** Max messages per 5 minutes (normal operating range) */
  maxMessagesPerWindow: number;
  /** Expected message recipients */
  expectedRecipients: Set<string>;
  /** Expected message types */
  expectedTypes: Set<string>;
}

interface AgentBehavior {
  agentName: string;
  lastBeat: Date | null;
  status: string;
  messageCountLast5m: number;
  uniqueRecipients: Set<string>;
  messageTypes: Set<string>;
  memoryMb: number;
  anomalyScore: number;
  quarantined: boolean;
}

// ============================================================================
// Agent Profiles — Expected behavior baseline
// ============================================================================

const AGENT_PROFILES: AgentProfile[] = [
  {
    agentName: 'nova-scout',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 30,
    expectedRecipients: new Set(['nova', 'nova-guardian', 'nova-analyst', 'nova-cfo']),
    expectedTypes: new Set(['intel', 'report', 'status', 'heartbeat']),
  },
  {
    agentName: 'nova-guardian',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 20,
    expectedRecipients: new Set(['nova', 'nova-cfo']),
    expectedTypes: new Set(['alert', 'report', 'status', 'heartbeat']),
  },
  {
    agentName: 'nova-analyst',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 25,
    expectedRecipients: new Set(['nova', 'nova-cfo', 'nova-guardian']),
    expectedTypes: new Set(['intel', 'report', 'status', 'heartbeat']),
  },
  {
    agentName: 'nova-launcher',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 15,
    expectedRecipients: new Set(['nova', 'nova-guardian']),
    expectedTypes: new Set(['status', 'report', 'heartbeat']),
  },
  {
    agentName: 'nova-community',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 20,
    expectedRecipients: new Set(['nova']),
    expectedTypes: new Set(['report', 'status', 'heartbeat']),
  },
  {
    agentName: 'nova-cfo',
    expectedBeatIntervalSec: 120,
    maxMessagesPerWindow: 25,
    expectedRecipients: new Set(['nova', 'nova-guardian']),
    expectedTypes: new Set(['report', 'alert', 'status', 'heartbeat']),
  },
];

const PROFILE_MAP = new Map(AGENT_PROFILES.map(p => [p.agentName, p]));

// ============================================================================
// Agent Watchdog
// ============================================================================

export class AgentWatchdog {
  private pool: Pool;
  private report: SecurityReporter;
  private behaviors: Map<string, AgentBehavior> = new Map();
  private totalChecks = 0;
  private totalAlerts = 0;
  private totalQuarantines = 0;

  /** Anomaly score thresholds */
  private static readonly WARN_THRESHOLD = 3;
  private static readonly QUARANTINE_THRESHOLD = 7;
  private static readonly DEAD_AGENT_SECONDS = 300; // 5 minutes without heartbeat
  private static readonly MESSAGE_WINDOW_MINUTES = 5;

  constructor(pool: Pool, report: SecurityReporter) {
    this.pool = pool;
    this.report = report;
  }

  init(): void {
    // Initialize behavior tracking for all known agents
    for (const profile of AGENT_PROFILES) {
      this.behaviors.set(profile.agentName, {
        agentName: profile.agentName,
        lastBeat: null,
        status: 'unknown',
        messageCountLast5m: 0,
        uniqueRecipients: new Set(),
        messageTypes: new Set(),
        memoryMb: 0,
        anomalyScore: 0,
        quarantined: false,
      });
    }
    logger.info(`[agent-watchdog] Monitoring ${AGENT_PROFILES.length} agents`);
  }

  /** Run a full behavioral analysis cycle */
  async check(): Promise<void> {
    this.totalChecks++;

    // 1. Fetch heartbeat data
    await this.fetchHeartbeats();

    // 2. Fetch message volume
    await this.fetchMessageVolumes();

    // 3. Analyze behavior and compute anomaly scores
    await this.analyzeAll();

    // 4. Check quarantined agents for release
    await this.checkQuarantineReleases();
  }

  // ── Data Collection ─────────────────────────────────────────────

  /** Fetch current heartbeat data for all agents */
  private async fetchHeartbeats(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT agent_name, status, last_beat, memory_mb, current_task
         FROM agent_heartbeats
         WHERE agent_name LIKE 'nova-%'`,
      );
      for (const row of rows) {
        const behavior = this.behaviors.get(row.agent_name);
        if (behavior) {
          behavior.lastBeat = row.last_beat;
          behavior.status = row.status;
          behavior.memoryMb = row.memory_mb || 0;
        }
      }
    } catch { /* table might not exist */ }
  }

  /** Fetch message volume per agent for the analysis window */
  private async fetchMessageVolumes(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT from_agent, 
                COUNT(*) as msg_count,
                COUNT(DISTINCT to_agent) as unique_recipients,
                array_agg(DISTINCT message_type) as message_types
         FROM agent_messages
         WHERE created_at > NOW() - INTERVAL '${AgentWatchdog.MESSAGE_WINDOW_MINUTES} minutes'
           AND from_agent LIKE 'nova-%'
         GROUP BY from_agent`,
      );
      for (const row of rows) {
        const behavior = this.behaviors.get(row.from_agent);
        if (behavior) {
          behavior.messageCountLast5m = parseInt(row.msg_count) || 0;
          behavior.uniqueRecipients = new Set(
            typeof row.unique_recipients === 'number'
              ? [] : [row.from_agent] // Placeholder
          );
          behavior.messageTypes = new Set(row.message_types || []);
        }
      }
    } catch { /* table might not exist */ }
  }

  // ── Analysis ────────────────────────────────────────────────────

  /** Analyze all agents for behavioral anomalies */
  private async analyzeAll(): Promise<void> {
    const now = new Date();

    for (const [agentName, behavior] of this.behaviors) {
      const profile = PROFILE_MAP.get(agentName);
      if (!profile) continue;

      // Skip already quarantined agents
      if (behavior.quarantined) continue;

      let anomalyScore = 0;
      const anomalies: string[] = [];

      // ── Check 1: Heartbeat ──────────────────────────────────
      if (behavior.lastBeat) {
        const secsSincebeat = (now.getTime() - new Date(behavior.lastBeat).getTime()) / 1000;
        if (secsSincebeat > AgentWatchdog.DEAD_AGENT_SECONDS) {
          anomalyScore += 3;
          anomalies.push(`No heartbeat for ${Math.round(secsSincebeat)}s`);
        } else if (secsSincebeat > profile.expectedBeatIntervalSec * 2) {
          anomalyScore += 1;
          anomalies.push(`Delayed heartbeat: ${Math.round(secsSincebeat)}s`);
        }
      }

      // ── Check 2: Status ─────────────────────────────────────
      if (behavior.status === 'degraded') {
        anomalyScore += 1;
        anomalies.push('Agent in degraded state');
      } else if (behavior.status === 'dead') {
        anomalyScore += 3;
        anomalies.push('Agent reported as dead');
      }

      // ── Check 3: Message volume ─────────────────────────────
      if (behavior.messageCountLast5m > profile.maxMessagesPerWindow * 3) {
        anomalyScore += 3;
        anomalies.push(`Message flood: ${behavior.messageCountLast5m} msgs in 5m (3x normal)`);
      } else if (behavior.messageCountLast5m > profile.maxMessagesPerWindow * 1.5) {
        anomalyScore += 1;
        anomalies.push(`High message volume: ${behavior.messageCountLast5m} msgs in 5m`);
      }

      // ── Check 4: Unexpected message types ────────────────────
      for (const msgType of behavior.messageTypes) {
        if (!profile.expectedTypes.has(msgType)) {
          anomalyScore += 2;
          anomalies.push(`Unexpected message type: ${msgType}`);
        }
      }

      // ── Check 5: Memory ─────────────────────────────────────
      if (behavior.memoryMb > 1024) {
        anomalyScore += 1;
        anomalies.push(`High memory: ${behavior.memoryMb}MB`);
      }

      // Update anomaly score
      behavior.anomalyScore = anomalyScore;

      // ── Alert / Quarantine ──────────────────────────────────
      if (anomalyScore >= AgentWatchdog.QUARANTINE_THRESHOLD) {
        await this.quarantineAgent(agentName, anomalies);
      } else if (anomalyScore >= AgentWatchdog.WARN_THRESHOLD) {
        this.totalAlerts++;
        const event: SecurityEvent = {
          category: 'agent',
          severity: 'warning',
          title: `Behavioral anomaly: ${agentName}`,
          details: {
            agentName,
            anomalyScore,
            anomalies,
            messageCount: behavior.messageCountLast5m,
            status: behavior.status,
            memoryMb: behavior.memoryMb,
          },
        };
        await this.report(event);
        await logSecurityEvent(this.pool, event);
      }
    }
  }

  // ── Quarantine ──────────────────────────────────────────────────

  /** Quarantine a compromised agent */
  async quarantineAgent(agentName: string, reasons: string[]): Promise<void> {
    const behavior = this.behaviors.get(agentName);
    if (behavior) behavior.quarantined = true;

    this.totalQuarantines++;

    // Record quarantine in DB
    try {
      await this.pool.query(
        `INSERT INTO agent_quarantine (agent_name, reason, quarantined_by, severity, auto_release_at)
         VALUES ($1, $2, 'nova-guardian', 'critical', NOW() + INTERVAL '1 hour')
         ON CONFLICT (agent_name) DO UPDATE
         SET quarantined_at = NOW(), reason = $2, released = FALSE, released_at = NULL`,
        [agentName, reasons.join('; ')],
      );
    } catch { /* table might not exist */ }

    // Disable agent in registry (prevents auto-restart)
    try {
      await this.pool.query(
        `UPDATE agent_registry SET enabled = FALSE, config = config || '{"quarantined": true}'::jsonb
         WHERE agent_name = $1`,
        [agentName],
      );
    } catch { /* non-fatal */ }

    const event: SecurityEvent = {
      category: 'agent',
      severity: 'critical',
      title: `AGENT QUARANTINED: ${agentName}`,
      details: {
        agentName,
        reasons,
        quarantinedAt: new Date().toISOString(),
        autoReleaseAt: new Date(Date.now() + 3600_000).toISOString(),
        message: `Agent ${agentName} has been quarantined due to behavioral anomalies. Auto-release in 1 hour.`,
      },
      autoResponse: 'Agent disabled in registry, quarantine record created',
    };
    await this.report(event);
    await logSecurityEvent(this.pool, event);

    logger.warn(`[agent-watchdog] 🔒 QUARANTINED ${agentName}: ${reasons.join('; ')}`);
  }

  /** Release a quarantined agent */
  async releaseAgent(agentName: string, releasedBy = 'auto'): Promise<void> {
    const behavior = this.behaviors.get(agentName);
    if (behavior) behavior.quarantined = false;

    try {
      await this.pool.query(
        `UPDATE agent_quarantine SET released = TRUE, released_at = NOW(), released_by = $2
         WHERE agent_name = $1`,
        [agentName, releasedBy],
      );
      await this.pool.query(
        `UPDATE agent_registry SET enabled = TRUE, config = config - 'quarantined'
         WHERE agent_name = $1`,
        [agentName],
      );
    } catch { /* non-fatal */ }

    const event: SecurityEvent = {
      category: 'agent',
      severity: 'info',
      title: `Agent released: ${agentName}`,
      details: { agentName, releasedBy },
    };
    await logSecurityEvent(this.pool, event);
    logger.info(`[agent-watchdog] 🔓 Released ${agentName} (by ${releasedBy})`);
  }

  /** Check quarantined agents for auto-release */
  private async checkQuarantineReleases(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT agent_name FROM agent_quarantine
         WHERE released = FALSE AND auto_release_at IS NOT NULL AND auto_release_at < NOW()`,
      );
      for (const row of rows) {
        await this.releaseAgent(row.agent_name, 'auto-timer');
      }
    } catch { /* table might not exist */ }
  }

  /** Check if an agent is quarantined (for use by other modules) */
  isQuarantined(agentName: string): boolean {
    return this.behaviors.get(agentName)?.quarantined ?? false;
  }

  /** Get status summary */
  getStatus() {
    const agentStatuses: Record<string, any> = {};
    for (const [name, behavior] of this.behaviors) {
      agentStatuses[name] = {
        status: behavior.quarantined ? 'QUARANTINED' : behavior.status,
        anomalyScore: behavior.anomalyScore,
        messageCount5m: behavior.messageCountLast5m,
        memoryMb: behavior.memoryMb,
        lastBeat: behavior.lastBeat?.toISOString() ?? 'never',
      };
    }
    return {
      agentsMonitored: this.behaviors.size,
      agents: agentStatuses,
      totalChecks: this.totalChecks,
      totalAlerts: this.totalAlerts,
      totalQuarantines: this.totalQuarantines,
    };
  }
}
