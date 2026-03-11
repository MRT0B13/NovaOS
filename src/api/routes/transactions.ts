/**
 * Transactions routes — query cfo_transactions + aggregate summaries
 *
 * Scopes results to the user's active agent when one exists,
 * otherwise returns global (unscoped) data.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

export async function transactionsRoutes(server: FastifyInstance) {

  // ── Helper: resolve the user's agent_id (if they have an active agent) ──
  async function resolveAgentId(address: string): Promise<string | null> {
    const row = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    return row.rows[0]?.agent_id ?? null;
  }

  // ── GET /api/transactions — paginated list with optional filters ──
  server.get('/transactions', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const query = req.query as {
      limit?: string;
      offset?: string;
      strategy?: string;
      chain?: string;
    };

    const limit = Math.min(Number(query.limit) || 50, 500);
    const offset = Number(query.offset) || 0;

    // Always resolve from authenticated wallet — never accept agent_id from request
    const agentId = await resolveAgentId(address);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (agentId) {
      // Try to scope by wallet_address associated with the agent
      const walletRow = await server.pg.query(
        `SELECT wallet_address FROM user_agents WHERE agent_id = $1 AND active = true`,
        [agentId]
      );
      if (walletRow.rows.length) {
        conditions.push(`wallet_address = $${paramIdx++}`);
        params.push(walletRow.rows[0].wallet_address);
      }
    } else {
      // No agent — fallback: match transactions by wallet_address directly
      conditions.push(`(wallet_address = $${paramIdx++} OR wallet_address IS NULL)`);
      params.push(address);
    }

    if (query.strategy) {
      conditions.push(`strategy_tag = $${paramIdx++}`);
      params.push(query.strategy);
    }
    if (query.chain) {
      conditions.push(`chain = $${paramIdx++}`);
      params.push(query.chain);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const rows = await server.pg.query(
      `SELECT id, timestamp, chain, strategy_tag, tx_type,
              token_in, amount_in, token_out, amount_out,
              fee_usd, tx_hash, status, position_id
       FROM cfo_transactions
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );

    reply.send(rows.rows);
  });

  // ── GET /api/transactions/summary — aggregate stats (last 30 days) ──
  server.get('/transactions/summary', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const agentId = await resolveAgentId(address);

    // Build agent scope
    let walletCondition = '';
    const params: any[] = [];
    if (agentId) {
      const walletRow = await server.pg.query(
        `SELECT wallet_address FROM user_agents WHERE agent_id = $1 AND active = true`,
        [agentId]
      );
      if (walletRow.rows.length) {
        walletCondition = 'AND wallet_address = $1';
        params.push(walletRow.rows[0].wallet_address);
      }
    }

    const totals = await server.pg.query(
      `SELECT
         COALESCE(SUM(fee_usd), 0)::float AS total_fees_usd,
         COALESCE(SUM(COALESCE(amount_in, 0) + COALESCE(amount_out, 0)), 0)::float AS total_volume_usd
       FROM cfo_transactions
       WHERE timestamp > NOW() - INTERVAL '30 days' ${walletCondition}`,
      params
    );

    const byStrategy = await server.pg.query(
      `SELECT strategy_tag, COUNT(*)::int AS count
       FROM cfo_transactions
       WHERE timestamp > NOW() - INTERVAL '30 days' ${walletCondition}
       GROUP BY strategy_tag
       ORDER BY count DESC`,
      params
    );

    const byChain = await server.pg.query(
      `SELECT chain, COUNT(*)::int AS count
       FROM cfo_transactions
       WHERE timestamp > NOW() - INTERVAL '30 days' ${walletCondition}
       GROUP BY chain
       ORDER BY count DESC`,
      params
    );

    const strategyMap: Record<string, number> = {};
    for (const r of byStrategy.rows) strategyMap[r.strategy_tag || 'unknown'] = r.count;

    const chainMap: Record<string, number> = {};
    for (const r of byChain.rows) chainMap[r.chain || 'unknown'] = r.count;

    reply.send({
      total_fees_usd: totals.rows[0]?.total_fees_usd ?? 0,
      total_volume_usd: totals.rows[0]?.total_volume_usd ?? 0,
      tx_count_by_strategy: strategyMap,
      tx_count_by_chain: chainMap,
    });
  });
}
