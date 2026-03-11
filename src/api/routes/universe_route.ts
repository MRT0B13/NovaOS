/**
 * Universe routes — feeds NovaUniverse (the Phaser world explorer)
 *
 * GET /api/universe/world-state   → all agents with zone + last action
 * GET /api/universe/zones         → zone definitions + agent counts
 * GET /api/universe/events        → recent animated events (last 50)
 * POST /api/universe/event        → internal — agents push events here
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

// ── Zone home positions (mirrors frontend constants) ──────────────────────────
const AGENT_HOME_ZONES: Record<string, string> = {
  'nova-cfo':        'trading_floor',
  'nova-scout':      'intel_hub',
  'nova-guardian':   'watchtower',
  'nova-supervisor': 'command_center',
  'nova-analyst':    'intel_hub',
  'nova-launcher':   'launchpad',
  'nova-community':  'agora',
};

// ── Action → zone mapping ─────────────────────────────────────────────────────
const ACTION_ZONE_MAP: Record<string, string> = {
  lp_open:             'orca_pool',
  lp_close:            'trading_floor',
  lp_rebalanced:       'orca_pool',
  swap:                'trading_floor',
  hl_perp_open:        'trading_floor',
  hl_perp_close:       'trading_floor',
  kamino_loop:         'trading_floor',
  signal_detected:     'intel_hub',
  rug_blocked:         'watchtower',
  rug_alert:           'watchtower',
  launch_created:      'launchpad',
  launch_deployed:     'launchpad',
  burn:                'burn_furnace',
  governance_vote:     'agora',
  community_post:      'agora',
  supervisor_decision: 'command_center',
  intel:               'intel_hub',
  alert:               'watchtower',
  report:              'command_center',
};

export async function universeRoutes(fastify: FastifyInstance) {
  const db = (fastify as any).pg;

  // ── GET /api/universe/world-state ──────────────────────────────────────────
  fastify.get('/universe/world-state', {
    preHandler: requireAuth,
  }, async (request: any, reply) => {
    const walletAddress: string = request.user.address;

    try {
      // Fetch agent registry rows for this wallet's agents
      const agentRows = await db.query(`
        SELECT
          ar.agent_id,
          ar.status,
          ar.last_heartbeat,
          ar.metadata,
          ua.created_at
        FROM agent_registry ar
        JOIN user_agents ua ON ua.agent_id = ar.agent_id
        WHERE ua.wallet_address = $1
        ORDER BY ar.agent_id
      `, [walletAddress]);

      // Fetch latest message per agent (last action)
      const msgRows = await db.query(`
        SELECT DISTINCT ON (m.metadata->>'agent')
          m.metadata->>'agent' AS agent_id,
          m.metadata->>'action' AS last_action,
          m.metadata->>'zone'   AS last_zone,
          m.content->>'text'    AS last_msg,
          m.created_at
        FROM memories m
        JOIN user_agents ua ON ua.agent_id = m.metadata->>'agent'
        WHERE ua.wallet_address = $1
          AND m.type = 'messages'
          AND m.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY m.metadata->>'agent', m.created_at DESC
      `, [walletAddress]);

      // Message counts per agent (24h)
      const countRows = await db.query(`
        SELECT
          m.metadata->>'agent' AS agent_id,
          COUNT(*) AS msg_count
        FROM memories m
        JOIN user_agents ua ON ua.agent_id = m.metadata->>'agent'
        WHERE ua.wallet_address = $1
          AND m.type = 'messages'
          AND m.created_at > NOW() - INTERVAL '24 hours'
        GROUP BY m.metadata->>'agent'
      `, [walletAddress]);

      const msgMap = new Map(msgRows.rows.map((r: any) => [r.agent_id, r]));
      const countMap = new Map(countRows.rows.map((r: any) => [r.agent_id, parseInt(r.msg_count)]));

      const agents = agentRows.rows.map((row: any) => {
        const agentId = row.agent_id;
        const lastMsg = msgMap.get(agentId) as any;
        const lastAction = lastMsg?.last_action ?? null;
        const currentZone = lastAction
          ? (ACTION_ZONE_MAP[lastAction] ?? AGENT_HOME_ZONES[agentId] ?? 'command_center')
          : (AGENT_HOME_ZONES[agentId] ?? 'command_center');

        return {
          agentId,
          status:       row.status ?? 'running',
          lastAction,
          lastMsg:      lastMsg?.last_msg ?? null,
          currentZone,
          homeZone:     AGENT_HOME_ZONES[agentId] ?? 'command_center',
          messages24h:  countMap.get(agentId) ?? 0,
          lastSeen:     row.last_heartbeat ?? null,
        };
      });

      return reply.send({ agents, timestamp: Date.now() });
    } catch (err: any) {
      fastify.log.error('universe/world-state error:', err);
      return reply.status(500).send({ error: 'Failed to fetch world state' });
    }
  });

  // ── GET /api/universe/zones ────────────────────────────────────────────────
  fastify.get('/universe/zones', {
    preHandler: requireAuth,
  }, async (request: any, reply) => {
    // Static zone data + live agent count per zone
    const walletAddress: string = request.user.address;

    try {
      const rows = await db.query(`
        SELECT
          ar.agent_id,
          ar.status
        FROM agent_registry ar
        JOIN user_agents ua ON ua.agent_id = ar.agent_id
        WHERE ua.wallet_address = $1
      `, [walletAddress]);

      // Count agents per zone
      const zoneCounts: Record<string, number> = {};
      rows.rows.forEach((r: any) => {
        const zone = AGENT_HOME_ZONES[r.agent_id] ?? 'command_center';
        zoneCounts[zone] = (zoneCounts[zone] ?? 0) + 1;
      });

      return reply.send({ zoneCounts, timestamp: Date.now() });
    } catch (err: any) {
      fastify.log.error('universe/zones error:', err);
      return reply.status(500).send({ error: 'Failed to fetch zones' });
    }
  });

  // ── GET /api/universe/events ───────────────────────────────────────────────
  // Returns last 50 universe events (used for replay / catch-up on load)
  fastify.get('/universe/events', {
    preHandler: requireAuth,
  }, async (request: any, reply) => {
    const walletAddress: string = request.user.address;
    const limit = Math.min(parseInt((request.query as any).limit ?? '50'), 100);

    try {
      // Pull from feed_events if table exists, else fall back to memories
      let rows: any;

      try {
        rows = await db.query(`
          SELECT
            fe.id,
            fe.agent_id      AS agent,
            fe.action,
            fe.zone,
            fe.message       AS msg,
            fe.metadata,
            fe.created_at    AS ts
          FROM feed_events fe
          JOIN user_agents ua ON ua.agent_id = fe.agent_id
          WHERE ua.wallet_address = $1
          ORDER BY fe.created_at DESC
          LIMIT $2
        `, [walletAddress, limit]);
      } catch {
        // Fallback: use agent_messages / memories table
        rows = await db.query(`
          SELECT
            m.id::text AS id,
            m.metadata->>'agent'  AS agent,
            m.metadata->>'action' AS action,
            m.metadata->>'zone'   AS zone,
            m.content->>'text'    AS msg,
            m.metadata            AS metadata,
            m.created_at          AS ts
          FROM memories m
          JOIN user_agents ua ON ua.agent_id = m.metadata->>'agent'
          WHERE ua.wallet_address = $1
            AND m.type = 'messages'
          ORDER BY m.created_at DESC
          LIMIT $2
        `, [walletAddress, limit]);
      }

      const events = rows.rows.map((r: any) => ({
        id:     r.id,
        agent:  r.agent,
        action: r.action ?? 'intel',
        zone:   r.zone ?? ACTION_ZONE_MAP[r.action] ?? 'command_center',
        msg:    r.msg ?? '',
        ts:     new Date(r.ts).getTime(),
      }));

      return reply.send({ events, timestamp: Date.now() });
    } catch (err: any) {
      fastify.log.error('universe/events error:', err);
      return reply.status(500).send({ error: 'Failed to fetch events' });
    }
  });

  // ── POST /api/universe/event ───────────────────────────────────────────────
  // Internal: agents push events here to broadcast to all connected WS clients
  // In future this triggers the WS broadcast via the live feed system
  fastify.post('/universe/event', {
    preHandler: requireAuth,
  }, async (request: any, reply) => {
    const { agent, action, zone, msg, amount, token, txHash } = request.body as any;

    if (!agent || !action) {
      return reply.status(400).send({ error: 'agent and action are required' });
    }

    try {
      // Store in feed_events if table exists (gracefully skip if not)
      try {
        await db.query(`
          INSERT INTO feed_events (agent_id, action, zone, message, metadata)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          agent,
          action,
          zone ?? ACTION_ZONE_MAP[action] ?? 'command_center',
          msg ?? action,
          JSON.stringify({ amount, token, txHash }),
        ]);
      } catch {
        // Table may not exist yet — non-fatal
      }

      return reply.send({ ok: true });
    } catch (err: any) {
      fastify.log.error('universe/event error:', err);
      return reply.status(500).send({ error: 'Failed to store event' });
    }
  });
}
