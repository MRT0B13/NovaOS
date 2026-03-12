/**
 * Feed routes — live agent activity feed
 * Reads from agent_messages table
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

// Map agent message types to UI display properties
// Actual DB message types: intel, alert, report, command
// Plus future NovaVerse types for frontend display
// Agent ID → display name map
const AGENT_DISPLAY: Record<string, string> = {
  'nova-cfo':              'Nova CFO',
  'nova-scout':            'Nova Scout',
  'nova-guardian':         'Nova Guardian',
  'nova-supervisor':       'Nova Supervisor',
  'nova-analyst':          'Nova Analyst',
  'nova-launcher':         'Nova Launcher',
  'nova-community':        'Nova Community',
  'nova-social-sentinel':  'Nova Sentinel',
};

function resolveAgentName(raw: string): string {
  if (!raw) return 'System';
  // Already a known slug
  if (AGENT_DISPLAY[raw]) return AGENT_DISPLAY[raw];
  // nova-* slug not in map — title-case it
  if (raw.startsWith('nova-')) return raw.replace('nova-', 'Nova ').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  // Raw UUID — return shortened form
  if (raw.length > 20) return 'Agent ' + raw.slice(0, 8).toUpperCase();
  return raw.toUpperCase();
}

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
    agent: resolveAgentName(row.from_agent),
    agentSlug: row.from_agent,
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

  // GET /api/feed?limit=20&from_agent=nova-scout&message_type=intel
  server.get('/feed', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const query = req.query as { limit?: string; from_agent?: string; message_type?: string };
    const limit = Math.min(Number(query.limit ?? 20), 200);

    // Optional filters
    const fromAgent = query.from_agent || null;
    const messageType = query.message_type || null;

    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );

    // Build dynamic WHERE clause
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (agentRow.rows.length) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(agentRow.rows[0].agent_id);
    }
    if (fromAgent) {
      conditions.push(`from_agent = $${paramIdx++}`);
      params.push(fromAgent);
    }
    if (messageType) {
      conditions.push(`message_type = $${paramIdx++}`);
      params.push(messageType);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);

    let rows = await server.pg.query(
      `SELECT id, from_agent, to_agent, message_type, summary, detail, payload, created_at
       FROM agent_messages
       ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      params
    );

    // New agent with no messages yet — fall back to global feed (only if agent-scoped and no other filters)
    if (!rows.rows.length && agentRow.rows.length && !fromAgent && !messageType) {
      const fallbackParams: any[] = [];
      let fbIdx = 1;
      const fbConditions: string[] = [];
      if (fromAgent) { fbConditions.push(`from_agent = $${fbIdx++}`); fallbackParams.push(fromAgent); }
      if (messageType) { fbConditions.push(`message_type = $${fbIdx++}`); fallbackParams.push(messageType); }
      const fbWhere = fbConditions.length ? 'WHERE ' + fbConditions.join(' AND ') : '';
      fallbackParams.push(limit);

      rows = await server.pg.query(
        `SELECT id, from_agent, to_agent, message_type, summary, detail, payload, created_at
         FROM agent_messages
         ${fbWhere}
         ORDER BY created_at DESC
         LIMIT $${fbIdx}`,
        fallbackParams
      );
    }

    reply.send(rows.rows.map(translateMessage));
  });
}
