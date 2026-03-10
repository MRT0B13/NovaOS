/**
 * Portfolio routes — positions, PnL, summary
 * Reads from cfo_positions, cfo_daily_snapshots, portfolio_snapshots, kv_store
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

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

    // Open positions from cfo_positions table
    const positions = await server.pg.query(
      `SELECT id, strategy, asset, description, chain,
              cost_basis_usd AS amount_usd,
              unrealized_pnl_usd AS pnl_usd,
              CASE WHEN cost_basis_usd > 0
                   THEN ROUND((unrealized_pnl_usd / cost_basis_usd * 100)::numeric, 2)
                   ELSE 0 END AS pnl_pct,
              entry_price, current_price, status,
              asset AS pool_name
       FROM cfo_positions
       WHERE (agent_id = $1 OR agent_id IS NULL) AND status = 'OPEN'
       ORDER BY cost_basis_usd DESC`,
      [agentId]
    );

    // Portfolio summary from kv_store
    const summary = await server.pg.query(
      `SELECT data FROM kv_store WHERE key = 'cfo:portfolio_summary'`
    );

    // NOVA token balance
    const nova = await server.pg.query(
      `SELECT balance, earned_month FROM nova_balances WHERE wallet_address = $1`,
      [address]
    );

    reply.send({
      positions: positions.rows,
      summary: summary.rows[0]?.data ?? null,
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
    if (!agentRow.rows.length) {
      // Fall back to cfo_daily_snapshots (shared, no agent_id)
      const rows = await server.pg.query(
        `SELECT date AS ts, total_portfolio_usd AS total_value_usd
         FROM cfo_daily_snapshots
         WHERE date > NOW() - INTERVAL '${days} days'
         ORDER BY date ASC`
      );
      return reply.send(rows.rows);
    }

    const agentId = agentRow.rows[0].agent_id;

    // Try hourly portfolio_snapshots first
    const rows = await server.pg.query(
      `SELECT date_trunc('hour', snapshot_at) AS ts, total_value_usd
       FROM portfolio_snapshots
       WHERE agent_id = $1
         AND snapshot_at > NOW() - INTERVAL '${days} days'
       ORDER BY ts ASC`,
      [agentId]
    );

    // Fall back to daily snapshots if no hourly data
    if (!rows.rows.length) {
      const daily = await server.pg.query(
        `SELECT date AS ts, total_portfolio_usd AS total_value_usd
         FROM cfo_daily_snapshots
         WHERE date > NOW() - INTERVAL '${days} days'
         ORDER BY date ASC`
      );
      return reply.send(daily.rows);
    }

    reply.send(rows.rows);
  });
}
