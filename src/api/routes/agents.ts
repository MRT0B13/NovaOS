/**
 * Agents routes — deploy, pause, resume, configure agent instances
 * Uses user_agents, agent_skills, agent_skill_assignments, kv_store tables
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const TEMPLATES: Record<string, { agents: string[]; defaultSkills: string[] }> = {
  'full-nova': {
    agents: ['nova-cfo', 'nova-scout', 'nova-guardian', 'nova-supervisor'],
    defaultSkills: ['risk-framework', 'hyperliquid-trader', 'polymarket-edge',
                    'kamino-yield', 'orca-lp', 'krystal-lp'],
  },
  'cfo-agent': {
    agents: ['nova-cfo', 'nova-guardian'],
    defaultSkills: ['risk-framework', 'hyperliquid-trader', 'kamino-yield',
                    'orca-lp', 'krystal-lp'],
  },
  'scout-agent': {
    agents: ['nova-scout'],
    defaultSkills: ['intel-framework', 'kol-monitoring'],
  },
  'lp-specialist': {
    agents: ['nova-cfo'],
    defaultSkills: ['risk-framework', 'orca-lp', 'krystal-lp'],
  },
};

// Risk level → initial config values
const RISK_CONFIGS: Record<string, Record<string, string>> = {
  conservative: {
    'CFO_ORCA_LP_MAX_USD': '80',
    'CFO_AUTO_TIER_USD': '20',
    'CFO_KELLY_FRACTION': '0.15',
    'CFO_KAMINO_JITO_LOOP_MAX_LOOPS': '2',
  },
  balanced: {
    'CFO_ORCA_LP_MAX_USD': '130',
    'CFO_AUTO_TIER_USD': '40',
    'CFO_KELLY_FRACTION': '0.22',
    'CFO_KAMINO_JITO_LOOP_MAX_LOOPS': '2',
  },
  aggressive: {
    'CFO_ORCA_LP_MAX_USD': '180',
    'CFO_AUTO_TIER_USD': '60',
    'CFO_KELLY_FRACTION': '0.30',
    'CFO_KAMINO_JITO_LOOP_MAX_LOOPS': '3',
  },
};

// Whitelist of user-editable config keys
const EDITABLE_KEYS = [
  'CFO_ORCA_LP_MAX_USD', 'CFO_KRYSTAL_LP_MAX_USD', 'CFO_AUTO_TIER_USD',
  'CFO_KELLY_FRACTION', 'CFO_KAMINO_JITO_LOOP_MAX_LOOPS',
  'CFO_ORCA_LP_RANGE_WIDTH_PCT', 'CFO_MAX_DECISIONS_PER_CYCLE',
];

export async function agentsRoutes(server: FastifyInstance) {

  // GET /api/agents/templates — list available templates
  server.get('/agents/templates', async (_req, reply) => {
    reply.send(Object.entries(TEMPLATES).map(([id, t]) => ({
      id,
      name: id.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      agents: t.agents,
      skillCount: t.defaultSkills.length,
      defaultSkills: t.defaultSkills,
    })));
  });

  // POST /api/agents/deploy
  // Body: { templateId: string, name: string, riskLevel: 'conservative'|'balanced'|'aggressive' }
  server.post('/agents/deploy', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const { templateId, name, riskLevel } = req.body as {
      templateId: string;
      name: string;
      riskLevel: 'conservative' | 'balanced' | 'aggressive';
    };

    const template = TEMPLATES[templateId];
    if (!template) return reply.status(400).send({ error: 'Unknown template' });
    if (!RISK_CONFIGS[riskLevel]) return reply.status(400).send({ error: 'Invalid risk level' });

    // Check user doesn't already have an active agent
    const existing = await server.pg.query(
      `SELECT id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (existing.rows.length) {
      return reply.status(409).send({ error: 'Agent already deployed. Pause it before deploying a new one.' });
    }

    const agentId = uuidv4();
    const agentNumber = Math.floor(1000 + Math.random() * 9000);

    // Create user_agents record
    await server.pg.query(
      `INSERT INTO user_agents (id, agent_id, wallet_address, template_id, display_name,
                                risk_level, status, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', true, NOW())`,
      [uuidv4(), agentId, address, templateId,
       name || `Nova CFO #${agentNumber}`, riskLevel]
    );

    // Assign default skills via agent_skill_assignments (uses agent_role, skill_id)
    const primaryRole = template.agents[0]; // e.g. 'nova-cfo'
    for (const skillName of template.defaultSkills) {
      // Check skill exists in registry
      const skill = await server.pg.query(
        `SELECT skill_id FROM agent_skills WHERE skill_id = $1 OR name = $1`,
        [skillName]
      );
      if (skill.rows.length) {
        await server.pg.query(
          `INSERT INTO agent_skill_assignments (agent_role, skill_id, priority, assigned_at)
           VALUES ($1, $2, 50, NOW())
           ON CONFLICT (agent_role, skill_id) DO NOTHING`,
          [primaryRole, skill.rows[0].skill_id]
        );
      }
    }

    // Write initial kv_store config based on risk level
    // kv_store uses key TEXT PRIMARY KEY, data JSONB
    for (const [key, val] of Object.entries(RISK_CONFIGS[riskLevel])) {
      await server.pg.query(
        `INSERT INTO kv_store (key, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
        [`config:${key}`, JSON.stringify(val)]
      );
    }

    reply.send({ agentId, agentNumber, status: 'running' });
  });

  // PATCH /api/agents/pause — pause active agent
  server.patch('/agents/pause', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    await server.pg.query(
      `UPDATE user_agents SET status = 'paused' WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    reply.send({ ok: true });
  });

  // PATCH /api/agents/resume
  server.patch('/agents/resume', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    await server.pg.query(
      `UPDATE user_agents SET status = 'running' WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    reply.send({ ok: true });
  });

  // GET /api/agents/me — current agent info
  server.get('/agents/me', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const row = await server.pg.query(
      `SELECT ua.*,
              (SELECT COUNT(*) FROM agent_skill_assignments asa
               WHERE asa.agent_role = (
                 CASE ua.template_id
                   WHEN 'full-nova' THEN 'nova-cfo'
                   WHEN 'cfo-agent' THEN 'nova-cfo'
                   WHEN 'scout-agent' THEN 'nova-scout'
                   WHEN 'lp-specialist' THEN 'nova-cfo'
                   ELSE 'nova-cfo'
                 END
               )) AS active_skills,
              (SELECT COUNT(*) FROM agent_messages am
               WHERE am.agent_id = ua.agent_id
               AND am.created_at > NOW() - INTERVAL '24 hours') AS messages_24h
       FROM user_agents ua
       WHERE ua.wallet_address = $1 AND ua.active = true`,
      [address]
    );
    reply.send(row.rows[0] ?? null);
  });

  // PATCH /api/agents/config — update a config value on the user's agent
  // Body: { key: string, value: string }
  server.patch('/agents/config', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const { key, value } = req.body as { key: string; value: string };

    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.status(404).send({ error: 'No agent' });

    if (!EDITABLE_KEYS.includes(key)) {
      return reply.status(403).send({ error: 'Key not editable from dashboard' });
    }

    // kv_store: key TEXT PK, data JSONB
    await server.pg.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [`config:${key}`, JSON.stringify(value)]
    );

    reply.send({ ok: true });
  });
}
