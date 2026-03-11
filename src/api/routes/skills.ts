/**
 * Skills routes — agent skill management
 * Uses agent_skills + agent_skill_assignments tables
 *
 * NOTE: The existing schema uses agent_role VARCHAR(50) not agent_id UUID
 * in agent_skill_assignments. The API maps user's agent template to role.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';

// Map template_id to the primary agent_role used by the skill system
function templateToRole(templateId: string): string {
  const map: Record<string, string> = {
    'full-nova':     'nova-cfo',
    'cfo-agent':     'nova-cfo',
    'scout-agent':   'nova-scout',
    'lp-specialist': 'nova-cfo',
  };
  return map[templateId] ?? 'nova-cfo';
}

export async function skillsRoutes(server: FastifyInstance) {

  // GET /api/skills — list skills assigned to user's agent role
  server.get('/skills', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };

    const agentRow = await server.pg.query(
      `SELECT agent_id, template_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.send([]);
    const role = templateToRole(agentRow.rows[0].template_id);

    // agent_skill_assignments uses agent_role + skill_id (VARCHAR references)
    const rows = await server.pg.query(
      `SELECT s.id, s.skill_id, s.name, s.description, s.category,
              asa.priority,
              s.status = 'active' AS enabled
       FROM agent_skill_assignments asa
       JOIN agent_skills s ON s.skill_id = asa.skill_id
       WHERE asa.agent_role = $1
       ORDER BY asa.priority ASC`,
      [role]
    );

    reply.send(rows.rows);
  });

  // PATCH/POST /api/skills/:skillId/toggle — toggle a skill on or off
  // Body: { enabled: boolean }
  const toggleHandler = async (req: any, reply: any) => {
    const { address } = req.user as { address: string };
    const { skillId } = req.params as { skillId: string };
    const { enabled } = req.body as { enabled: boolean };

    const agentRow = await server.pg.query(
      `SELECT agent_id, template_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.status(404).send({ error: 'No agent found' });
    const role = templateToRole(agentRow.rows[0].template_id);

    // Toggle by updating the skill status
    await server.pg.query(
      `UPDATE agent_skills SET status = $1, updated_at = NOW() WHERE skill_id = $2`,
      [enabled ? 'active' : 'disabled', skillId]
    );

    reply.send({ ok: true });
  };
  server.patch('/skills/:skillId', { preHandler: requireAuth }, toggleHandler);
  server.post('/skills/:skillId/toggle', { preHandler: requireAuth }, toggleHandler);

  // GET /api/skills/registry — all available skills
  server.get('/skills/registry', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await server.pg.query(
      `SELECT id, skill_id, name, description, category, source_url, created_at
       FROM agent_skills
       WHERE status = 'active'
       ORDER BY category ASC, name ASC`
    );
    reply.send(rows.rows);
  });

  // POST /api/skills/assign — add a skill from registry to user's agent
  // Body: { skillId: string }
  server.post('/skills/assign', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const { skillId } = req.body as { skillId: string };

    const agentRow = await server.pg.query(
      `SELECT agent_id, template_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.status(404).send({ error: 'No agent found' });
    const role = templateToRole(agentRow.rows[0].template_id);

    await server.pg.query(
      `INSERT INTO agent_skill_assignments (agent_role, skill_id, priority, assigned_at)
       VALUES ($1, $2, 50, NOW())
       ON CONFLICT (agent_role, skill_id) DO NOTHING`,
      [role, skillId]
    );

    reply.send({ ok: true });
  });
}
