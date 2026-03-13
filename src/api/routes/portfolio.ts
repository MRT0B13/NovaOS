/**
 * Portfolio routes — positions, PnL, summary
 * Reads from cfo_positions, cfo_daily_snapshots, portfolio_snapshots, kv_store
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

const POSITION_COLS = `id, strategy, asset, description, chain,
              cost_basis_usd AS amount_usd,
              unrealized_pnl_usd AS pnl_usd,
              CASE WHEN cost_basis_usd > 0
                   THEN ROUND((unrealized_pnl_usd / cost_basis_usd * 100)::numeric, 2)
                   ELSE 0 END AS pnl_pct,
              entry_price, current_price, status,
              asset AS pool_name, opened_at`;

export async function portfolioRoutes(server: FastifyInstance) {

  // GET /api/portfolio
  // Returns portfolio summary + open positions for the authenticated user's agent
  server.get('/portfolio', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };

    // Get the agent assigned to this wallet
    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.send({ positions: [], summary: null, nova: { balance: 0, earned_month: 0 } });
    const agentId = agentRow.rows[0].agent_id;

    // Open positions — try agent-scoped first, fall back to all (system CFO trades)
    let positions = await server.pg.query(
      `SELECT ${POSITION_COLS}
       FROM cfo_positions
       WHERE agent_id = $1 AND status = 'OPEN'
       ORDER BY cost_basis_usd DESC`,
      [agentId]
    );
    if (!positions.rows.length) {
      positions = await server.pg.query(
        `SELECT ${POSITION_COLS}
         FROM cfo_positions
         WHERE status = 'OPEN'
         ORDER BY cost_basis_usd DESC`
      );
    }

    // Portfolio summary — try agent-scoped key first, fall back to global
    const agentSummaryKey = `agent:${agentId}:portfolio_summary`;
    let summary = await server.pg.query(
      `SELECT data FROM kv_store WHERE key = $1`,
      [agentSummaryKey]
    );
    // Fall back to global only if agent has no summary yet
    if (!summary.rows.length) {
      summary = await server.pg.query(
        `SELECT data FROM kv_store WHERE key = 'cfo:portfolio_summary'`
      );
    }

    // Compute live summary from open positions as final fallback
    const liveSummary = positions.rows.length > 0 ? {
      total_value_usd: positions.rows.reduce((sum: number, p: any) =>
        sum + Number(p.amount_usd || 0), 0),
      position_count: positions.rows.length,
      computed: true,
    } : null;

    // NOVA token balance
    const nova = await server.pg.query(
      `SELECT balance, earned_month FROM nova_balances WHERE wallet_address = $1`,
      [address]
    );

    reply.send({
      positions: positions.rows,
      summary: summary.rows[0]?.data ?? liveSummary ?? null,
      nova: nova.rows[0] ?? { balance: 0, earned_month: 0 },
    });
  });

  // GET /api/portfolio/pnl?period=7d
  server.get('/portfolio/pnl', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const period = (req.query as any).period ?? '7d';
    const days = period === '30d' ? 30 : period === '7d' ? 7 : 1;

    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.send([]);

    const agentId = agentRow.rows[0].agent_id;

    // Try agent-scoped snapshots first
    let rows = await server.pg.query(
      `SELECT date_trunc('hour', snapshot_at) AS ts, total_value_usd
       FROM portfolio_snapshots
       WHERE agent_id = $1
         AND snapshot_at > NOW() - INTERVAL '${days} days'
       ORDER BY ts ASC`,
      [agentId]
    );

    // Fall back to all snapshots if agent has none
    if (!rows.rows.length) {
      rows = await server.pg.query(
        `SELECT date_trunc('hour', snapshot_at) AS ts,
                SUM(total_value_usd) AS total_value_usd
         FROM portfolio_snapshots
         WHERE snapshot_at > NOW() - INTERVAL '${days} days'
         GROUP BY 1
         ORDER BY 1 ASC`
      );
    }

    reply.send(rows.rows);
  });
}
