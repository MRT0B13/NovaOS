/**
 * Feed routes — live agent activity feed
 * Reads from agent_messages table
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

// Map agent message types to UI display properties
function translateMessage(row: any) {
  const typeMap: Record<string, { icon: string; color: string }> = {
    TRADE_OPENED:    { icon: '💹', color: '#00ff88' },
    TRADE_CLOSED:    { icon: '💹', color: '#00ff88' },
    LP_OPENED:       { icon: '💹', color: '#00ff88' },
    LP_REBALANCED:   { icon: '💹', color: '#00ff88' },
    LP_CLOSED:       { icon: '💹', color: '#00ff88' },
    YIELD_UPDATE:    { icon: '🏦', color: '#00ff88' },
    INTEL_SIGNAL:    { icon: '📡', color: '#00c8ff' },
    NARRATIVE_ALERT: { icon: '📡', color: '#00c8ff' },
    HEALTH_CHECK:    { icon: '🛡️', color: '#ff9500' },
    SECURITY_ALERT:  { icon: '🛡️', color: '#ff4444' },
    GOVERNANCE_VOTE: { icon: '🗳️', color: '#c084fc' },
    APPROVAL_NEEDED: { icon: '⚠️', color: '#ff9500' },
    CFO_DECISION:    { icon: '💹', color: '#00ff88' },
    SCOUT_INTEL:     { icon: '📡', color: '#00c8ff' },
    SUPERVISOR_CMD:  { icon: '⚙️', color: '#888' },
  };

  const meta = typeMap[row.message_type] ?? { icon: '🤖', color: '#888' };

  return {
    id: row.id,
    time: new Date(row.created_at).toLocaleTimeString('en-GB', { hour12: false }),
    type: row.message_type,
    agent: row.from_agent.replace('nova-', '').toUpperCase(),
    icon: meta.icon,
    color: meta.color,
    msg: row.summary ?? row.message_type,
    detail: row.detail ?? '',
    raw: row.payload,
  };
}

export async function feedRoutes(server: FastifyInstance) {

  // GET /api/feed?limit=20
  server.get('/feed', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const limit = Math.min(Number((req.query as any).limit ?? 20), 100);

    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );

    let rows;
    if (agentRow.rows.length) {
      const agentId = agentRow.rows[0].agent_id;
      // Scoped to user's agent
      rows = await server.pg.query(
        `SELECT id, from_agent, to_agent, message_type, summary, detail, payload, created_at
         FROM agent_messages
         WHERE agent_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [agentId, limit]
      );
    } else {
      // No agent assigned — show all recent messages (shared view)
      rows = await server.pg.query(
        `SELECT id, from_agent, to_agent, message_type, summary, detail, payload, created_at
         FROM agent_messages
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
    }

    reply.send(rows.rows.map(translateMessage));
  });
}
