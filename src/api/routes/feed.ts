/**
 * Feed routes — live agent activity feed
 * Reads from agent_messages table
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

// Map agent message types to UI display properties
// Actual DB message types: intel, alert, report, command
// Plus future NovaVerse types for frontend display
function translateMessage(row: any) {
  const typeMap: Record<string, { icon: string; color: string; label: string }> = {
    // === Actual DB message types (intel, alert, report, command) ===
    intel:           { icon: '📡', color: '#00c8ff', label: 'Intel Signal' },
    alert:           { icon: '🛡️', color: '#ff9500', label: 'Alert' },
    report:          { icon: '📊', color: '#00ff88', label: 'Report' },
    command:         { icon: '⚙️', color: '#888',    label: 'Command' },
    // === Future NovaVerse types ===
    TRADE_OPENED:    { icon: '💹', color: '#00ff88', label: 'Trade Opened' },
    TRADE_CLOSED:    { icon: '💹', color: '#00ff88', label: 'Trade Closed' },
    LP_OPENED:       { icon: '💹', color: '#00ff88', label: 'LP Opened' },
    LP_REBALANCED:   { icon: '💹', color: '#00ff88', label: 'LP Rebalanced' },
    LP_CLOSED:       { icon: '💹', color: '#00ff88', label: 'LP Closed' },
    YIELD_UPDATE:    { icon: '🏦', color: '#00ff88', label: 'Yield Update' },
    HEALTH_CHECK:    { icon: '🛡️', color: '#ff9500', label: 'Health Check' },
    SECURITY_ALERT:  { icon: '🛡️', color: '#ff4444', label: 'Security Alert' },
    GOVERNANCE_VOTE: { icon: '🗳️', color: '#c084fc', label: 'Governance Vote' },
    GOVERNANCE_DEBATE: { icon: '🗳️', color: '#c084fc', label: 'Debate' },
    APPROVAL_NEEDED: { icon: '⚠️', color: '#ff9500', label: 'Approval Needed' },
  };

  const meta = typeMap[row.message_type] ?? { icon: '🤖', color: '#888', label: row.message_type };

  return {
    id: row.id,
    time: new Date(row.created_at).toLocaleTimeString('en-GB', { hour12: false }),
    type: row.message_type,
    agent: row.from_agent.replace('nova-', '').toUpperCase(),
    icon: meta.icon,
    color: meta.color,
    msg: row.summary ?? meta.label,
    detail: row.detail ?? buildDetailFromPayload(row.payload, row.message_type),
    raw: row.payload,
  };
}

// Extract a human-readable detail line from the JSONB payload
function buildDetailFromPayload(payload: any, type: string): string {
  if (!payload) return '';
  try {
    if (type === 'intel' && payload.movers) {
      const top = payload.movers.slice(0, 3).map((m: any) =>
        `${m.symbol} ${m.change24hPct > 0 ? '+' : ''}${m.change24hPct?.toFixed(1)}%`
      ).join(', ');
      return `Top movers: ${top}`;
    }
    if (type === 'alert' && payload.message) return payload.message;
    if (type === 'report' && payload.summary) return payload.summary;
    if (type === 'command' && payload.action) return `Action: ${payload.action}`;
    if (payload.text) return payload.text;
    if (payload.summary) return payload.summary;
  } catch { /* ignore */ }
  return '';
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
