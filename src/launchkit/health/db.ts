// src/health/db.ts
// Health Agent database operations
// Uses the same PostgreSQL connection as ElizaOS

import { Pool, PoolClient } from 'pg';
import {
  AgentHeartbeat,
  AgentError,
  ApiHealthEntry,
  CodeRepairRequest,
  CodeRepairResult,
  AgentStatus,
  ApiStatus,
  Severity,
  HealthReport,
} from './types';

export class HealthDB {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Expose pool for ad-hoc queries (e.g. agent_registry lookups) */
  getPool(): Pool {
    return this.pool;
  }

  // ============================================================
  // HEARTBEATS
  // ============================================================

  async upsertHeartbeat(heartbeat: Partial<AgentHeartbeat> & { agentName: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_heartbeats (agent_name, status, last_beat, memory_mb, cpu_percent, error_count_last_5min, current_task, version)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
       ON CONFLICT (agent_name) DO UPDATE SET
         status = COALESCE($2, agent_heartbeats.status),
         last_beat = NOW(),
         memory_mb = COALESCE($3, agent_heartbeats.memory_mb),
         cpu_percent = COALESCE($4, agent_heartbeats.cpu_percent),
         error_count_last_5min = COALESCE($5, agent_heartbeats.error_count_last_5min),
         current_task = $6,
         version = COALESCE($7, agent_heartbeats.version)`,
      [
        heartbeat.agentName,
        heartbeat.status || 'alive',
        heartbeat.memoryMb || 0,
        heartbeat.cpuPercent || 0,
        heartbeat.errorCountLast5Min || 0,
        heartbeat.currentTask || null,
        heartbeat.version || null,
      ]
    );
  }

  async getAllHeartbeats(): Promise<AgentHeartbeat[]> {
    const { rows } = await this.pool.query(
      `SELECT agent_name, status, last_beat, uptime_started, memory_mb, cpu_percent,
              error_count_last_5min, current_task, version
       FROM agent_heartbeats ORDER BY agent_name`
    );
    return rows.map(this.mapHeartbeat);
  }

  async getStaleAgents(deadThresholdMs: number, warnThresholdMs: number): Promise<AgentHeartbeat[]> {
    const { rows } = await this.pool.query(
      `SELECT agent_name, status, last_beat, uptime_started, memory_mb, cpu_percent,
              error_count_last_5min, current_task, version
       FROM agent_heartbeats
       WHERE status != 'disabled'
         AND last_beat < NOW() - INTERVAL '${warnThresholdMs} milliseconds'
       ORDER BY last_beat ASC`
    );
    return rows.map(this.mapHeartbeat);
  }

  async setAgentStatus(agentName: string, status: AgentStatus): Promise<void> {
    await this.pool.query(
      `UPDATE agent_heartbeats SET status = $1 WHERE agent_name = $2`,
      [status, agentName]
    );
  }

  // ============================================================
  // ERRORS
  // ============================================================

  async logError(error: AgentError): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_errors (agent_name, error_type, error_message, stack_trace, file_path, line_number, severity, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        error.agentName,
        error.errorType,
        error.errorMessage,
        error.stackTrace || null,
        error.filePath || null,
        error.lineNumber || null,
        error.severity,
        JSON.stringify(error.context || {}),
      ]
    );
    return rows[0].id;
  }

  async getRecentErrors(agentName: string, windowMs: number): Promise<AgentError[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_errors
       WHERE agent_name = $1 AND created_at > NOW() - INTERVAL '${windowMs} milliseconds'
       ORDER BY created_at DESC`,
      [agentName]
    );
    return rows;
  }

  async getErrorRate(agentName: string, windowMs: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE severity IN ('error', 'critical')) as error_count,
         COUNT(*) as total_count
       FROM agent_errors
       WHERE agent_name = $1 AND created_at > NOW() - INTERVAL '${windowMs} milliseconds'`,
      [agentName]
    );
    const total = parseInt(rows[0].total_count);
    if (total === 0) return 0;
    return parseInt(rows[0].error_count) / total;
  }

  async resolveError(errorId: number, resolvedBy: string, method: string, notes?: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_errors SET resolved = TRUE, resolved_by = $1, resolved_at = NOW(),
              resolution_method = $2, resolution_notes = $3
       WHERE id = $4`,
      [resolvedBy, method, notes || null, errorId]
    );
  }

  async getUnresolvedErrors(agentName?: string): Promise<AgentError[]> {
    const query = agentName
      ? `SELECT * FROM agent_errors WHERE resolved = FALSE AND agent_name = $1 ORDER BY created_at DESC LIMIT 50`
      : `SELECT * FROM agent_errors WHERE resolved = FALSE ORDER BY created_at DESC LIMIT 50`;
    const params = agentName ? [agentName] : [];
    const { rows } = await this.pool.query(query, params);
    return rows;
  }

  // ============================================================
  // RESTARTS
  // ============================================================

  async logRestart(
    agentName: string,
    reason: string,
    restartType: string = 'full',
    errorId?: number
  ): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_restarts (agent_name, reason, restart_type, error_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [agentName, reason, restartType, errorId || null]
    );
    return rows[0].id;
  }

  async updateRestartResult(restartId: number, success: boolean, recoveryTimeMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE agent_restarts SET success = $1, recovery_time_ms = $2 WHERE id = $3`,
      [success, recoveryTimeMs, restartId]
    );
  }

  async getRestartsInWindow(agentName: string, windowMs: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) as count FROM agent_restarts
       WHERE agent_name = $1 AND created_at > NOW() - INTERVAL '${windowMs} milliseconds'`,
      [agentName]
    );
    return parseInt(rows[0].count);
  }

  // ============================================================
  // API HEALTH
  // ============================================================

  async upsertApiHealth(entry: Partial<ApiHealthEntry> & { apiName: string; endpoint: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_health (api_name, endpoint, status, response_time_ms, last_check, consecutive_failures, last_failure_reason)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6)
       ON CONFLICT (api_name) DO UPDATE SET
         status = $3, response_time_ms = $4, last_check = NOW(),
         consecutive_failures = $5, last_failure_reason = $6`,
      [
        entry.apiName,
        entry.endpoint,
        entry.status || 'unknown',
        entry.responseTimeMs || 0,
        entry.consecutiveFailures || 0,
        entry.lastFailureReason || null,
      ]
    );
  }

  async getAllApiHealth(): Promise<ApiHealthEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT api_name, endpoint, status, response_time_ms, consecutive_failures, last_failure_reason
       FROM api_health ORDER BY api_name`
    );
    return rows.map(r => ({
      apiName: r.api_name,
      endpoint: r.endpoint,
      status: r.status,
      responseTimeMs: r.response_time_ms,
      consecutiveFailures: r.consecutive_failures,
      lastFailureReason: r.last_failure_reason,
    }));
  }

  // ============================================================
  // CODE REPAIRS
  // ============================================================

  async logRepairAttempt(
    request: CodeRepairRequest,
    result: CodeRepairResult,
    llmModel: string,
    llmPrompt: string,
    llmResponse: string
  ): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO code_repairs
         (error_id, agent_name, file_path, error_type, error_message,
          diagnosis, repair_category, original_code, repaired_code,
          llm_model_used, llm_prompt, llm_response, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        request.errorId,
        request.agentName,
        request.filePath,
        request.errorType,
        request.errorMessage,
        result.diagnosis,
        result.repairCategory,
        result.originalCode,
        result.repairedCode,
        llmModel,
        llmPrompt,
        llmResponse,
        result.requiresApproval,
      ]
    );
    return rows[0].id;
  }

  async approveRepair(repairId: number, approvedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE code_repairs SET approved = TRUE, approved_by = $1, approved_at = NOW() WHERE id = $2`,
      [approvedBy, repairId]
    );
  }

  async rejectRepair(repairId: number, approvedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE code_repairs SET approved = FALSE, approved_by = $1, approved_at = NOW() WHERE id = $2`,
      [approvedBy, repairId]
    );
  }

  async markRepairApplied(repairId: number, testPassed: boolean, testOutput?: string): Promise<void> {
    await this.pool.query(
      `UPDATE code_repairs SET applied = TRUE, applied_at = NOW(), test_passed = $1, test_output = $2 WHERE id = $3`,
      [testPassed, testOutput || null, repairId]
    );
  }

  async markRepairRolledBack(repairId: number, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE code_repairs SET rolled_back = TRUE, rolled_back_at = NOW(), rollback_reason = $1 WHERE id = $2`,
      [reason, repairId]
    );
  }

  async getPendingRepairs(): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM code_repairs WHERE requires_approval = TRUE AND approved IS NULL ORDER BY created_at`
    );
    return rows;
  }

  // ============================================================
  // HEALTH REPORTS
  // ============================================================

  async saveReport(report: HealthReport, postedTo: string[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO health_reports (report_type, report_text, agent_statuses, api_statuses, metrics, posted_to)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        report.metrics.overallStatus === 'critical' ? 'incident' : 'periodic',
        report.text,
        JSON.stringify(report.agents),
        JSON.stringify(report.apis),
        JSON.stringify(report.metrics),
        postedTo,
      ]
    );
  }

  // ============================================================
  // METRICS
  // ============================================================

  async get24hMetrics(): Promise<{
    totalErrors: number;
    totalRestarts: number;
    totalRepairs: number;
    pendingRepairs: number;
  }> {
    const [errors, restarts, repairs, pending] = await Promise.all([
      this.pool.query(`SELECT COUNT(*) as c FROM agent_errors WHERE created_at > NOW() - INTERVAL '24 hours'`),
      this.pool.query(`SELECT COUNT(*) as c FROM agent_restarts WHERE created_at > NOW() - INTERVAL '24 hours'`),
      this.pool.query(`SELECT COUNT(*) as c FROM code_repairs WHERE created_at > NOW() - INTERVAL '24 hours'`),
      this.pool.query(`SELECT COUNT(*) as c FROM code_repairs WHERE requires_approval = TRUE AND approved IS NULL`),
    ]);
    return {
      totalErrors: parseInt(errors.rows[0].c),
      totalRestarts: parseInt(restarts.rows[0].c),
      totalRepairs: parseInt(repairs.rows[0].c),
      pendingRepairs: parseInt(pending.rows[0].c),
    };
  }

  // ============================================================
  // AGENT MESSAGES (Inter-agent bus)
  // ============================================================

  async sendMessage(
    fromAgent: string,
    toAgent: string,
    messageType: string,
    payload: Record<string, any>,
    priority: string = 'medium',
    expiresInMs?: number
  ): Promise<void> {
    const expiresAt = expiresInMs ? new Date(Date.now() + expiresInMs) : null;
    await this.pool.query(
      `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fromAgent, toAgent, messageType, priority, JSON.stringify(payload), expiresAt]
    );
  }

  async getMessages(agentName: string, limit: number = 20): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_messages
       WHERE (to_agent = $1 OR to_agent = 'broadcast')
         AND acknowledged = FALSE
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT $2`,
      [agentName, limit]
    );
    return rows;
  }

  async acknowledgeMessage(messageId: number): Promise<void> {
    await this.pool.query(
      `UPDATE agent_messages SET acknowledged = TRUE, acknowledged_at = NOW() WHERE id = $1`,
      [messageId]
    );
  }

  async cleanupExpiredMessages(): Promise<void> {
    await this.pool.query(`DELETE FROM agent_messages WHERE expires_at < NOW()`);
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private mapHeartbeat(row: any): AgentHeartbeat {
    return {
      agentName: row.agent_name,
      status: row.status,
      lastBeat: new Date(row.last_beat),
      uptimeStarted: new Date(row.uptime_started),
      memoryMb: row.memory_mb,
      cpuPercent: row.cpu_percent,
      errorCountLast5Min: row.error_count_last_5min,
      currentTask: row.current_task,
      version: row.version,
    };
  }
}
