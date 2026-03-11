/**
 * Supervisor routes — exposes the supervisor agent's activity to the dashboard
 *
 * The supervisor (agent_name = 'nova') is the central orchestrator.
 * These endpoints surface its decisions, managed agent statuses, recent
 * commands, digest intel, and overall swarm coordination to the frontend.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

export async function supervisorRoutes(server: FastifyInstance) {

  // GET /api/supervisor/status — supervisor's current state + uptime
  server.get('/supervisor/status', { preHandler: requireAuth }, async (_req, reply) => {
    const heartbeat = await server.pg.query(
      `SELECT agent_name, status, last_beat, uptime_started, memory_mb,
              cpu_percent, error_count_last_5min, current_task, version, state_json,
              EXTRACT(EPOCH FROM (NOW() - uptime_started)) AS uptime_seconds,
              EXTRACT(EPOCH FROM (NOW() - last_beat)) AS seconds_since_beat
       FROM agent_heartbeats
       WHERE agent_name = 'nova'`
    );
    if (!heartbeat.rows.length) {
      return reply.send({ status: 'offline', message: 'Supervisor not reporting heartbeats' });
    }

    const row = heartbeat.rows[0];
    const uptimeHours = Math.floor(Number(row.uptime_seconds) / 3600);
    const uptimeMinutes = Math.floor((Number(row.uptime_seconds) % 3600) / 60);

    reply.send({
      agentName: row.agent_name,
      status: row.status,
      lastBeat: row.last_beat,
      uptime: `${uptimeHours}h ${uptimeMinutes}m`,
      uptimeSeconds: Number(row.uptime_seconds),
      memoryMb: row.memory_mb,
      cpuPercent: row.cpu_percent,
      errorsLast5min: row.error_count_last_5min,
      currentTask: row.current_task,
      version: row.version,
      state: row.state_json ?? {},
    });
  });

  // GET /api/supervisor/agents — status of all agents in the swarm
  server.get('/supervisor/agents', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await server.pg.query(
      `SELECT
         h.agent_name,
         h.status,
         h.last_beat,
         h.uptime_started,
         h.memory_mb,
         h.error_count_last_5min,
         h.current_task,
         h.version,
         EXTRACT(EPOCH FROM (NOW() - h.last_beat)) AS seconds_since_beat,
         r.enabled,
         r.auto_restart,
         r.agent_type,
         (SELECT COUNT(*) FROM agent_messages am
          WHERE am.from_agent = h.agent_name
            AND am.created_at > NOW() - INTERVAL '24 hours') AS messages_24h,
         (SELECT COUNT(*) FROM agent_errors ae
          WHERE ae.agent_name = h.agent_name
            AND ae.created_at > NOW() - INTERVAL '24 hours'
            AND ae.resolved = FALSE) AS unresolved_errors
       FROM agent_heartbeats h
       LEFT JOIN agent_registry r ON r.agent_name = h.agent_name
       ORDER BY h.agent_name`
    );

    reply.send(rows.rows.map((r: any) => ({
      name: r.agent_name,
      status: r.status,
      enabled: r.enabled ?? true,
      autoRestart: r.auto_restart ?? true,
      agentType: r.agent_type ?? 'worker',
      lastBeat: r.last_beat,
      secondsSinceBeat: Number(r.seconds_since_beat),
      memoryMb: r.memory_mb,
      errorsLast5min: r.error_count_last_5min,
      currentTask: r.current_task,
      version: r.version,
      messages24h: Number(r.messages_24h),
      unresolvedErrors: Number(r.unresolved_errors),
      alive: Number(r.seconds_since_beat) < 120, // 2 min threshold
    })));
  });

  // GET /api/supervisor/decisions — recent supervisor decisions/actions
  server.get('/supervisor/decisions', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '50' } = req.query as { limit?: string };
    const cap = Math.min(Number(limit) || 50, 200);

    const rows = await server.pg.query(
      `SELECT id, from_agent, to_agent, message_type, priority, payload, summary,
              created_at, acknowledged
       FROM agent_messages
       WHERE from_agent = 'nova'
         AND message_type NOT IN ('HEARTBEAT', 'STATUS')
       ORDER BY created_at DESC
       LIMIT $1`,
      [cap]
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      to: r.to_agent,
      type: r.message_type,
      priority: r.priority,
      summary: r.summary ?? r.payload?.summary ?? r.payload?.text ?? '',
      payload: r.payload,
      time: r.created_at,
      acknowledged: r.acknowledged,
    })));
  });

  // GET /api/supervisor/inbox — messages sent TO the supervisor (reports, alerts)
  server.get('/supervisor/inbox', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '50', unread = 'false' } = req.query as { limit?: string; unread?: string };
    const cap = Math.min(Number(limit) || 50, 200);

    let whereExtra = '';
    if (unread === 'true') whereExtra = ' AND acknowledged = FALSE';

    const rows = await server.pg.query(
      `SELECT id, from_agent, message_type, priority, payload, summary,
              created_at, acknowledged
       FROM agent_messages
       WHERE to_agent = 'nova'${whereExtra}
       ORDER BY created_at DESC
       LIMIT $1`,
      [cap]
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      from: r.from_agent,
      type: r.message_type,
      priority: r.priority,
      summary: r.summary ?? r.payload?.summary ?? r.payload?.text ?? '',
      payload: r.payload,
      time: r.created_at,
      acknowledged: r.acknowledged,
    })));
  });

  // GET /api/supervisor/digest — latest intel digest (compiled by supervisor)
  server.get('/supervisor/digest', { preHandler: requireAuth }, async (_req, reply) => {
    // Supervisor stores periodic digests in kv_store
    const kv = await server.pg.query(
      `SELECT data, updated_at FROM kv_store WHERE key = 'supervisor_last_digest'`
    );

    if (!kv.rows.length) {
      // Fallback: pull recent high-priority messages as a makeshift digest
      const msgs = await server.pg.query(
        `SELECT from_agent, message_type, summary, payload, created_at
         FROM agent_messages
         WHERE to_agent = 'nova'
           AND priority IN ('high', 'critical')
           AND created_at > NOW() - INTERVAL '6 hours'
         ORDER BY created_at DESC
         LIMIT 20`
      );
      return reply.send({
        type: 'live',
        generatedAt: new Date().toISOString(),
        items: msgs.rows.map((r: any) => ({
          from: r.from_agent,
          type: r.message_type,
          summary: r.summary ?? r.payload?.text ?? '',
          time: r.created_at,
        })),
      });
    }

    const digest = typeof kv.rows[0].data === 'string'
      ? JSON.parse(kv.rows[0].data) : kv.rows[0].data;

    reply.send({
      type: 'compiled',
      generatedAt: kv.rows[0].updated_at,
      ...digest,
    });
  });

  // GET /api/supervisor/governance — governance proposals with agent votes
  server.get('/supervisor/governance', { preHandler: requireAuth }, async (_req, reply) => {
    // Agent votes are stored as agent_messages with type GOVERNANCE_VOTE
    const proposals = await server.pg.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM governance_votes gv WHERE gv.proposal_id = p.id) AS total_votes,
              (SELECT json_agg(json_build_object(
                'agent', am.from_agent,
                'vote', am.payload->>'vote',
                'rationale', am.payload->>'rationale',
                'time', am.created_at
              )) FROM agent_messages am
               WHERE am.message_type = 'GOVERNANCE_VOTE'
                 AND (am.payload->>'proposal_id')::int = p.id
              ) AS agent_votes
       FROM governance_proposals p
       WHERE p.status = 'active'
       ORDER BY p.created_at DESC
       LIMIT 20`
    );

    reply.send(proposals.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      proposedBy: r.proposed_by,
      status: r.status,
      votesYes: Number(r.votes_yes),
      votesNo: Number(r.votes_no),
      votesAbstain: Number(r.votes_abstain),
      totalVotes: Number(r.total_votes),
      agentVotes: r.agent_votes ?? [],
      endsAt: r.ends_at,
      createdAt: r.created_at,
    })));
  });
}
