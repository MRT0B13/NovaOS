/**
 * Health Dashboard routes — exposes swarm health data to the frontend
 *
 * Surfaces data from:
 * - agent_heartbeats — live agent status
 * - agent_errors — error log with severity
 * - agent_restarts — restart history
 * - api_health — external API monitoring
 * - health_reports — periodic health snapshots
 * - code_repairs — self-healing attempts
 *
 * These give the Health Agent a dedicated dashboard space.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

export async function healthRoutes(server: FastifyInstance) {

  // GET /api/health/overview — compact swarm health summary
  server.get('/health/overview', { preHandler: requireAuth }, async (_req, reply) => {
    // Agent statuses — separate ecosystem vs user
    const agents = await server.pg.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'alive') AS alive,
         COUNT(*) FILTER (WHERE status = 'degraded') AS degraded,
         COUNT(*) FILTER (WHERE status = 'dead') AS dead,
         COUNT(*) FILTER (WHERE status = 'disabled') AS disabled,
         COUNT(*) FILTER (WHERE agent_category = 'ecosystem' OR agent_category IS NULL) AS ecosystem_count,
         COUNT(*) FILTER (WHERE agent_category = 'user') AS user_count,
         SUM(memory_mb) AS total_memory_mb,
         SUM(error_count_last_5min) AS total_errors_5min
       FROM agent_heartbeats`
    );

    // Unresolved errors (last 24h)
    const errors = await server.pg.query(
      `SELECT COUNT(*) AS count,
              COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'error') AS errors,
              COUNT(*) FILTER (WHERE severity = 'warning') AS warnings
       FROM agent_errors
       WHERE resolved = FALSE AND created_at > NOW() - INTERVAL '24 hours'`
    );

    // API health
    const apis = await server.pg.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'up') AS up,
         COUNT(*) FILTER (WHERE status = 'slow') AS slow,
         COUNT(*) FILTER (WHERE status = 'down') AS down
       FROM api_health`
    );

    // Restarts (last 24h)
    const restarts = await server.pg.query(
      `SELECT COUNT(*) AS count FROM agent_restarts
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    );

    const a = agents.rows[0] ?? {};
    const e = errors.rows[0] ?? {};
    const ap = apis.rows[0] ?? {};

    const health = Number(a.alive ?? 0) === Number(a.total ?? 0) && Number(e.critical ?? 0) === 0
      ? 'healthy'
      : Number(e.critical ?? 0) > 0 || Number(a.dead ?? 0) > 0
        ? 'critical'
        : 'degraded';

    reply.send({
      status: health,
      agents: {
        total: Number(a.total ?? 0),
        alive: Number(a.alive ?? 0),
        degraded: Number(a.degraded ?? 0),
        dead: Number(a.dead ?? 0),
        disabled: Number(a.disabled ?? 0),
        ecosystem: Number(a.ecosystem_count ?? 0),
        user: Number(a.user_count ?? 0),
        totalMemoryMb: Number(a.total_memory_mb ?? 0),
        totalErrors5min: Number(a.total_errors_5min ?? 0),
      },
      errors: {
        unresolved: Number(e.count ?? 0),
        critical: Number(e.critical ?? 0),
        errors: Number(e.errors ?? 0),
        warnings: Number(e.warnings ?? 0),
      },
      apis: {
        total: Number(ap.total ?? 0),
        up: Number(ap.up ?? 0),
        slow: Number(ap.slow ?? 0),
        down: Number(ap.down ?? 0),
      },
      restarts24h: Number(restarts.rows[0]?.count ?? 0),
      checkedAt: new Date().toISOString(),
    });
  });

  // GET /api/health/agents — detailed per-agent health
  // Query params: ?category=ecosystem|user to filter by agent category
  server.get('/health/agents', { preHandler: requireAuth }, async (req, reply) => {
    const { category } = req.query as { category?: string };

    let whereClause = '';
    const params: any[] = [];
    if (category === 'ecosystem' || category === 'user') {
      whereClause = `WHERE (h.agent_category = $1 OR (h.agent_category IS NULL AND $1 = 'ecosystem'))`;
      params.push(category);
    }

    const rows = await server.pg.query(
      `SELECT
         h.agent_name,
         h.display_name,
         h.agent_category,
         h.status,
         h.last_beat,
         h.uptime_started,
         h.memory_mb,
         h.cpu_percent,
         h.error_count_last_5min,
         h.current_task,
         h.version,
         h.state_json,
         EXTRACT(EPOCH FROM (NOW() - h.last_beat)) AS seconds_since_beat,
         EXTRACT(EPOCH FROM (NOW() - h.uptime_started)) AS uptime_seconds,
         r.enabled,
         r.auto_restart,
         r.agent_type
       FROM agent_heartbeats h
       LEFT JOIN agent_registry r ON r.agent_name = h.agent_name
       ${whereClause}
       ORDER BY h.agent_category ASC, h.agent_name`,
      params
    );

    reply.send(rows.rows.map((r: any) => {
      const uptimeSec = Number(r.uptime_seconds ?? 0);
      return {
        name: r.agent_name,
        displayName: r.display_name || r.agent_name,
        category: r.agent_category || 'ecosystem',
        status: r.status,
        lastBeat: r.last_beat,
        secondsSinceBeat: Math.round(Number(r.seconds_since_beat ?? 0)),
        uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
        memoryMb: r.memory_mb,
        cpuPercent: r.cpu_percent,
        errorsLast5min: r.error_count_last_5min,
        currentTask: r.current_task,
        version: r.version,
        enabled: r.enabled ?? true,
        autoRestart: r.auto_restart ?? true,
        agentType: r.agent_type ?? 'worker',
        alive: Number(r.seconds_since_beat) < 120,
      };
    }));
  });

  // DELETE /api/health/agents/:name — manually remove a stale heartbeat entry
  server.delete('/health/agents/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = await server.pg.query(
      `DELETE FROM agent_heartbeats WHERE agent_name = $1 RETURNING agent_name`,
      [name]
    );
    if (result.rowCount === 0) {
      return reply.status(404).send({ error: 'Agent not found in heartbeats' });
    }
    reply.send({ deleted: name });
  });

  // DELETE /api/health/agents — bulk cleanup: remove all disabled/dead agents
  // Query params: ?status=disabled|dead&category=user|ecosystem
  server.delete('/health/agents', { preHandler: requireAuth }, async (req, reply) => {
    const { status = 'disabled', category } = req.query as { status?: string; category?: string };

    const validStatuses = ['disabled', 'dead'];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    let query = `DELETE FROM agent_heartbeats WHERE status = $1`;
    const params: any[] = [status];

    if (category === 'ecosystem' || category === 'user') {
      query += ` AND (agent_category = $2 OR (agent_category IS NULL AND $2 = 'ecosystem'))`;
      params.push(category);
    }

    // Never clean up health-monitor
    query += ` AND agent_name NOT IN ('health-monitor', 'health-agent')`;

    const result = await server.pg.query(query + ' RETURNING agent_name', params);
    reply.send({
      deleted: result.rowCount,
      agents: result.rows.map((r: any) => r.agent_name),
    });
  });

  // GET /api/health/errors — recent error log
  server.get('/health/errors', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '50', severity, agent, unresolved = 'false' } = req.query as {
      limit?: string; severity?: string; agent?: string; unresolved?: string;
    };
    const cap = Math.min(Number(limit) || 50, 200);

    let conditions = [`created_at > NOW() - INTERVAL '7 days'`];
    const params: any[] = [];
    let paramIdx = 0;

    if (severity) {
      paramIdx++;
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
    }
    if (agent) {
      paramIdx++;
      conditions.push(`agent_name = $${paramIdx}`);
      params.push(agent);
    }
    if (unresolved === 'true') {
      conditions.push(`resolved = FALSE`);
    }

    paramIdx++;
    params.push(cap);

    const rows = await server.pg.query(
      `SELECT id, agent_name, error_type, error_message, severity, file_path,
              line_number, resolved, created_at
       FROM agent_errors
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      params
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      agent: r.agent_name,
      type: r.error_type,
      message: r.error_message,
      severity: r.severity,
      file: r.file_path,
      line: r.line_number,
      resolved: r.resolved,
      time: r.created_at,
    })));
  });

  // GET /api/health/apis — external API health status
  server.get('/health/apis', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await server.pg.query(
      `SELECT api_name, endpoint, status, response_time_ms,
              last_check, consecutive_failures, last_failure_reason
       FROM api_health
       ORDER BY
         CASE status WHEN 'down' THEN 0 WHEN 'slow' THEN 1 WHEN 'up' THEN 2 ELSE 3 END,
         api_name`
    );

    reply.send(rows.rows.map((r: any) => ({
      name: r.api_name,
      endpoint: r.endpoint,
      status: r.status,
      responseMs: r.response_time_ms,
      lastCheck: r.last_check,
      consecutiveFailures: r.consecutive_failures,
      lastFailure: r.last_failure_reason,
    })));
  });

  // GET /api/health/reports — periodic health reports
  server.get('/health/reports', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '20', type } = req.query as { limit?: string; type?: string };
    const cap = Math.min(Number(limit) || 20, 100);

    let whereExtra = '';
    const params: any[] = [cap];
    if (type) {
      whereExtra = ' AND report_type = $2';
      params.push(type);
    }

    const rows = await server.pg.query(
      `SELECT id, report_type, report_text, agent_statuses, api_statuses,
              metrics, posted_to, created_at
       FROM health_reports
       WHERE created_at > NOW() - INTERVAL '7 days'${whereExtra}
       ORDER BY created_at DESC
       LIMIT $1`,
      params
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      type: r.report_type,
      text: r.report_text,
      agentStatuses: r.agent_statuses,
      apiStatuses: r.api_statuses,
      metrics: r.metrics,
      postedTo: r.posted_to,
      time: r.created_at,
    })));
  });

  // GET /api/health/restarts — agent restart history
  server.get('/health/restarts', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '50', agent } = req.query as { limit?: string; agent?: string };
    const cap = Math.min(Number(limit) || 50, 100);

    let whereExtra = '';
    const params: any[] = [cap];
    if (agent) {
      whereExtra = ' AND agent_name = $2';
      params.push(agent);
    }

    const rows = await server.pg.query(
      `SELECT id, agent_name, reason, restart_type, success,
              recovery_time_ms, created_at
       FROM agent_restarts
       WHERE created_at > NOW() - INTERVAL '30 days'${whereExtra}
       ORDER BY created_at DESC
       LIMIT $1`,
      params
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      agent: r.agent_name,
      reason: r.reason,
      type: r.restart_type,
      success: r.success,
      recoveryMs: r.recovery_time_ms,
      time: r.created_at,
    })));
  });

  // GET /api/health/repairs — self-healing code repair attempts
  server.get('/health/repairs', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '20', pending = 'false' } = req.query as { limit?: string; pending?: string };
    const cap = Math.min(Number(limit) || 20, 50);

    let whereExtra = '';
    if (pending === 'true') {
      whereExtra = ' AND requires_approval = TRUE AND approved IS NULL';
    }

    const rows = await server.pg.query(
      `SELECT id, agent_name, file_path, error_type, error_message,
              diagnosis, repair_category, requires_approval, approved,
              applied, test_passed, rolled_back, created_at
       FROM code_repairs
       WHERE created_at > NOW() - INTERVAL '30 days'${whereExtra}
       ORDER BY created_at DESC
       LIMIT $1`,
      [cap]
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      agent: r.agent_name,
      file: r.file_path,
      errorType: r.error_type,
      errorMessage: r.error_message,
      diagnosis: r.diagnosis,
      category: r.repair_category,
      requiresApproval: r.requires_approval,
      approved: r.approved,
      applied: r.applied,
      testPassed: r.test_passed,
      rolledBack: r.rolled_back,
      time: r.created_at,
    })));
  });
}
