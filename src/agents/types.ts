/**
 * Nova Agent Architecture — Shared Types
 *
 * Nova is the SUPERVISOR. 6 agents report to it via the agent_messages table:
 *   1. Scout     — KOL scanning, narrative detection, social intel
 *   2. Guardian  — RugCheck safety, LP monitoring, whale alerts
 *   3. Analyst   — DeFiLlama data, on-chain metrics, narrative scoring
 *   4. Launcher  — pump.fun token creation, art gen, deploy
 *   5. Community — TG management, X replies, onboarding
 *   6. Health    — Self-healing, auto-repair, swarm monitoring (already built)
 *
 * All agents communicate through the shared PostgreSQL `agent_messages` table.
 * All agents register in `agent_registry` and send heartbeats via `agent_heartbeats`.
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';

// ============================================================================
// Agent Types
// ============================================================================

export type AgentType = 'scout' | 'guardian' | 'analyst' | 'launcher' | 'community' | 'health' | 'supervisor' | 'cfo';

export type MessagePriority = 'low' | 'medium' | 'high' | 'critical';

export type MessageType =
  | 'intel'       // Intelligence data from Scout/Analyst
  | 'alert'       // Safety alert from Guardian
  | 'report'      // Periodic report or scan result
  | 'request'     // Request for action (scan, launch, post)
  | 'command'     // Supervisor command to agent
  | 'status'      // Agent status update
  | 'heartbeat';  // Keep-alive

export interface AgentMessage {
  id?: number;
  from_agent: string;
  to_agent: string;
  message_type: MessageType;
  priority: MessagePriority;
  payload: Record<string, any>;
  acknowledged?: boolean;
  acknowledged_at?: Date;
  expires_at?: Date;
  created_at?: Date;
}

export interface AgentConfig {
  agentId: string;
  agentType: AgentType;
  pool: Pool;
  scanIntervalMs?: number;
  enabled?: boolean;
}

// ============================================================================
// Base Agent Class
// ============================================================================

export abstract class BaseAgent {
  protected pool: Pool;
  protected agentId: string;
  protected agentType: AgentType;
  protected running = false;
  protected intervals: NodeJS.Timeout[] = [];
  private _stateColumnEnsured = false;

  // Shared across all agent instances — avoids repeated failing queries + PG error log spam
  private static _hasRetryCount: boolean | null = null;

  constructor(config: AgentConfig) {
    this.pool = config.pool;
    this.agentId = config.agentId;
    this.agentType = config.agentType;
  }

  /** Get this agent's unique identifier */
  getAgentId(): string {
    return this.agentId;
  }

  /** Start the agent — register, start loops */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.register();
    await this.onStart();
    logger.info(`[${this.agentId}] Started`);
  }

  /** Stop the agent */
  async stop(): Promise<void> {
    this.running = false;
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    await this.updateStatus('stopped');
    await this.onStop();
    logger.info(`[${this.agentId}] Stopped`);
  }

  /** Override in subclass — called after registration */
  protected abstract onStart(): Promise<void>;

  /** Override in subclass — called on shutdown */
  protected async onStop(): Promise<void> {}

  // ── Registration & Heartbeat ──────────────────────────────────────

  protected async register(): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO agent_registry (agent_name, agent_type, enabled, config, updated_at)
         VALUES ($1, $2, true, $3, NOW())
         ON CONFLICT (agent_name) DO UPDATE
         SET agent_type = $2, enabled = true, updated_at = NOW()`,
        [this.agentId, this.agentType, JSON.stringify({ startedAt: new Date().toISOString() })],
      );
    } catch (err) {
      logger.warn(`[${this.agentId}] Registration failed (non-fatal):`, err);
    }
  }

  protected async updateStatus(status: string): Promise<void> {
    // Map task-specific statuses to valid DB column values
    // DB CHECK constraint only allows: 'alive', 'degraded', 'dead', 'disabled'
    const VALID_DB_STATUSES = new Set(['alive', 'degraded', 'dead', 'disabled']);
    const dbStatus = VALID_DB_STATUSES.has(status) ? status
      : (status === 'error' ? 'degraded'
        : (status === 'stopped' ? 'disabled'
          : 'alive'));  // researching, analyzing, idle, gathering, active → alive
    try {
      await this.pool.query(
        `INSERT INTO agent_heartbeats (agent_name, status, current_task, last_beat)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (agent_name) DO UPDATE
         SET status = $2, current_task = $3, last_beat = NOW()`,
        [this.agentId, dbStatus, status],
      );
    } catch (err) {
      // Silent — health agent will notice missing heartbeats
    }
  }

  protected startHeartbeat(intervalMs: number = 60_000): void {
    this.intervals.push(
      setInterval(() => this.updateStatus('alive'), intervalMs),
    );
    this.updateStatus('alive');
  }

  // ── State Persistence (survive restarts) ────────────────────────

  /** Ensure the state_json column exists (idempotent, runs once per agent lifecycle) */
  private async ensureStateColumn(): Promise<void> {
    if (this._stateColumnEnsured) return;
    try {
      await this.pool.query(
        `ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS state_json JSONB DEFAULT '{}'`,
      );
      this._stateColumnEnsured = true;
    } catch {
      // Column might already exist or table might not exist yet — both fine
      this._stateColumnEnsured = true;
    }
  }

  /**
   * Save agent state to DB so it survives restarts.
   * Call this periodically (e.g. after each cycle) or in heartbeat.
   * Subclasses override `getPersistedState()` to define what to persist.
   */
  protected async saveState(state: Record<string, any>): Promise<void> {
    try {
      await this.ensureStateColumn();
      await this.pool.query(
        `UPDATE agent_heartbeats SET state_json = $2 WHERE agent_name = $1`,
        [this.agentId, JSON.stringify(state)],
      );
    } catch (err) {
      logger.warn(`[${this.agentId}] Failed to save state:`, err);
    }
  }

  /**
   * Restore agent state from DB after a restart.
   * Returns the saved state or null if none exists.
   */
  protected async restoreState<T = Record<string, any>>(): Promise<T | null> {
    try {
      await this.ensureStateColumn();
      const { rows } = await this.pool.query(
        `SELECT state_json FROM agent_heartbeats WHERE agent_name = $1`,
        [this.agentId],
      );
      if (rows.length > 0 && rows[0].state_json && Object.keys(rows[0].state_json).length > 0) {
        logger.info(`[${this.agentId}] Restored state from DB`);
        return rows[0].state_json as T;
      }
    } catch (err) {
      logger.warn(`[${this.agentId}] Failed to restore state:`, err);
    }
    return null;
  }

  // ── Message Bus ───────────────────────────────────────────────────

  /** Send a message to another agent (or supervisor) */
  protected async sendMessage(
    toAgent: string,
    type: MessageType,
    priority: MessagePriority,
    payload: Record<string, any>,
    expiresInMs?: number,
  ): Promise<void> {
    try {
      const expiresAt = expiresInMs ? new Date(Date.now() + expiresInMs) : null;
      await this.pool.query(
        `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.agentId, toAgent, type, priority, JSON.stringify(payload), expiresAt],
      );
    } catch (err) {
      logger.warn(`[${this.agentId}] Failed to send message to ${toAgent}:`, err);
    }
  }

  /** Report to the supervisor (convenience method) */
  protected async reportToSupervisor(
    type: MessageType,
    priority: MessagePriority,
    payload: Record<string, any>,
  ): Promise<void> {
    await this.sendMessage('nova', type, priority, {
      ...payload,
      source: this.agentId,
      timestamp: new Date().toISOString(),
    });
  }

  /** Read pending messages addressed to this agent (or broadcast) */
  protected async readMessages(limit: number = 10): Promise<AgentMessage[]> {
    // On first call, try to ensure retry_count column exists (idempotent ALTER)
    if (BaseAgent._hasRetryCount === null) {
      try {
        await this.pool.query(
          `ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`,
        );
        BaseAgent._hasRetryCount = true;
      } catch {
        BaseAgent._hasRetryCount = false;
      }
    }

    try {
      if (BaseAgent._hasRetryCount) {
        const result = await this.pool.query(
          `SELECT id, from_agent, to_agent, message_type, priority, payload, created_at,
                  COALESCE(retry_count, 0) as retry_count
           FROM agent_messages
           WHERE (to_agent = $1 OR to_agent = 'broadcast') AND acknowledged = false
             AND (expires_at IS NULL OR expires_at > NOW())
             AND COALESCE(retry_count, 0) < 5
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'medium' THEN 2
               WHEN 'low' THEN 3
             END,
             created_at ASC
           LIMIT $2`,
          [this.agentId, limit],
        );
        // Increment retry_count for each message read (tracks processing attempts)
        for (const row of result.rows) {
          await this.pool.query(
            `UPDATE agent_messages SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = $1`,
            [row.id],
          ).catch(() => {});
        }
        return result.rows;
      }

      // Fallback: retry_count column doesn't exist
      const result = await this.pool.query(
        `SELECT id, from_agent, to_agent, message_type, priority, payload, created_at
         FROM agent_messages
         WHERE (to_agent = $1 OR to_agent = 'broadcast') AND acknowledged = false
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             WHEN 'low' THEN 3
           END,
           created_at ASC
         LIMIT $2`,
        [this.agentId, limit],
      );
      return result.rows;
    } catch (err) {
      logger.warn(`[${this.agentId}] Failed to read messages:`, err);
      return [];
    }
  }

  /** Acknowledge a message (mark as processed) */
  protected async acknowledgeMessage(messageId: number): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE agent_messages SET acknowledged = true, acknowledged_at = NOW(), processed_at = NOW() WHERE id = $1`,
        [messageId],
      );
    } catch (err) {
      // Fallback if processed_at column doesn't exist
      try {
        await this.pool.query(
          `UPDATE agent_messages SET acknowledged = true, acknowledged_at = NOW() WHERE id = $1`,
          [messageId],
        );
      } catch { /* Silent */ }
    }
  }

  /** Move a message to dead-letter queue (exceeded max retries or unprocessable) */
  protected async deadLetterMessage(messageId: number, reason: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE agent_messages SET acknowledged = true, acknowledged_at = NOW(),
         payload = jsonb_set(COALESCE(payload::jsonb, '{}'::jsonb), '{_dlq_reason}', $2::jsonb)
         WHERE id = $1`,
        [messageId, JSON.stringify(reason)],
      );
      logger.warn(`[${this.agentId}] Message ${messageId} moved to DLQ: ${reason}`);
    } catch {
      // Fallback: just acknowledge it
      await this.acknowledgeMessage(messageId);
    }
  }

  /** Add a recurring interval (tracked for cleanup).
   *  Wraps async callbacks with .catch() to prevent unhandled rejections
   *  from crashing the Node process (Node 15+ terminates on unhandled rejection). */
  protected addInterval(fn: () => void | Promise<void>, ms: number): void {
    this.intervals.push(setInterval(() => {
      try {
        const result = fn();
        // If fn returns a promise, swallow any rejection
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            logger.warn(`[${this.agentId}] Interval callback rejected:`, err);
          });
        }
      } catch (err) {
        logger.warn(`[${this.agentId}] Interval callback threw:`, err);
      }
    }, ms));
  }
}
