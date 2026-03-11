/**
 * Governance routes — proposals, voting, debate
 * Uses governance_proposals, governance_votes, nova_balances tables
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

export async function governanceRoutes(server: FastifyInstance) {

  // GET /api/governance/proposals
  server.get('/governance/proposals', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };

    const rows = await server.pg.query(
      `SELECT p.*,
              v.vote_choice AS your_vote,
              (SELECT COUNT(*) FROM governance_votes gv WHERE gv.proposal_id = p.id) AS total_votes
       FROM governance_proposals p
       LEFT JOIN governance_votes v ON v.proposal_id = p.id AND v.wallet_address = $1
       ORDER BY p.created_at DESC`,
      [address]
    );

    reply.send(rows.rows);
  });

  // POST /api/governance/vote
  // Body: { proposalId: number, choice: 'YES' | 'NO' | 'ABSTAIN', agentRecommended: boolean }
  server.post('/governance/vote', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const { proposalId, choice, agentRecommended } = req.body as {
      proposalId: number;
      choice: 'YES' | 'NO' | 'ABSTAIN';
      agentRecommended: boolean;
    };

    if (!['YES', 'NO', 'ABSTAIN'].includes(choice)) {
      return reply.status(400).send({ error: 'Invalid choice' });
    }

    // Check proposal is still active
    const proposal = await server.pg.query(
      `SELECT id, status FROM governance_proposals WHERE id = $1`,
      [proposalId]
    );
    if (!proposal.rows.length) return reply.status(404).send({ error: 'Proposal not found' });
    if (proposal.rows[0].status !== 'active') {
      return reply.status(400).send({ error: 'Proposal is no longer active' });
    }

    // Get user's NOVA balance for vote weight
    const nova = await server.pg.query(
      `SELECT balance FROM nova_balances WHERE wallet_address = $1`,
      [address]
    );
    const novaBalance = nova.rows[0]?.balance ?? 0;

    await server.pg.query(
      `INSERT INTO governance_votes
         (proposal_id, wallet_address, vote_choice, nova_weight, agent_recommended, voted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (proposal_id, wallet_address)
       DO UPDATE SET vote_choice = $3, agent_recommended = $5, voted_at = NOW()`,
      [proposalId, address, choice, novaBalance, agentRecommended]
    );

    // Recalculate vote tallies
    await server.pg.query(
      `UPDATE governance_proposals SET
         votes_yes     = (SELECT COALESCE(SUM(nova_weight), 0) FROM governance_votes WHERE proposal_id = $1 AND vote_choice = 'YES'),
         votes_no      = (SELECT COALESCE(SUM(nova_weight), 0) FROM governance_votes WHERE proposal_id = $1 AND vote_choice = 'NO'),
         votes_abstain = (SELECT COALESCE(SUM(nova_weight), 0) FROM governance_votes WHERE proposal_id = $1 AND vote_choice = 'ABSTAIN')
       WHERE id = $1`,
      [proposalId]
    );

    reply.send({ ok: true });
  });

  // POST /api/governance/propose
  // Body: { title: string, description: string }
  server.post('/governance/propose', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const { title, description, durationDays } = req.body as {
      title: string; description: string; durationDays?: number;
    };

    if (!title?.trim()) return reply.status(400).send({ error: 'Title required' });

    // Duration: 3, 5, or 7 days only — default to 5
    const allowedDays = [3, 5, 7];
    const days = allowedDays.includes(durationDays as number) ? durationDays : 5;

    // Minimum NOVA to submit proposal
    const minNova = Number(process.env.GOVERNANCE_MIN_NOVA ?? 100);
    const nova = await server.pg.query(
      `SELECT balance FROM nova_balances WHERE wallet_address = $1`,
      [address]
    );
    if ((nova.rows[0]?.balance ?? 0) < minNova) {
      return reply.status(403).send({ error: `Minimum ${minNova} NOVA required to propose` });
    }

    const result = await server.pg.query(
      `INSERT INTO governance_proposals (title, description, proposed_by, status, ends_at, created_at)
       VALUES ($1, $2, $3, 'active', NOW() + ($4 || ' days')::INTERVAL, NOW())
       RETURNING id`,
      [title.trim(), description?.trim() ?? '', address, String(days)]
    );

    reply.send({ proposalId: result.rows[0].id });
  });

  // GET /api/governance/debate/:proposalId — debate messages for a proposal
  server.get('/governance/debate/:proposalId', { preHandler: requireAuth }, async (req, reply) => {
    const { proposalId } = req.params as { proposalId: string };

    // Debate messages are agent_messages with message_type = 'GOVERNANCE_DEBATE'
    const rows = await server.pg.query(
      `SELECT am.id, am.from_agent, am.summary AS msg, am.created_at
       FROM agent_messages am
       WHERE am.message_type = 'GOVERNANCE_DEBATE'
         AND am.payload->>'proposal_id' = $1
       ORDER BY am.created_at ASC
       LIMIT 100`,
      [proposalId]
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      agent: r.from_agent,
      role: r.from_agent.replace('nova-', ''),
      msg: r.msg ?? '',
      time: r.created_at,
      color: r.from_agent.includes('scout') ? '#00c8ff'
           : r.from_agent.includes('guardian') ? '#ff9500'
           : '#00ff88',
      avatar: r.from_agent.includes('scout') ? '📡'
            : r.from_agent.includes('guardian') ? '🛡️'
            : '💹',
    })));
  });
}
