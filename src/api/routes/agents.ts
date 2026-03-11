/**
 * Agents routes — deploy, pause, resume, configure, wallet attachment
 *
 * Uses AgentOrchestrator for real agent lifecycle management:
 * - Builds ElizaOS Character from template + user config
 * - Registers in agent_registry (swarm integration)
 * - Stores character + wallet config in kv_store
 * - Links user wallet → agent via user_agents
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { AgentOrchestrator } from '../services/agentOrchestrator.js';
import { Pool } from 'pg';

const TEMPLATES: Record<string, { agents: string[]; defaultSkills: string[]; description: string }> = {
  'full-nova': {
    agents: ['nova-cfo', 'nova-scout', 'nova-guardian', 'nova-supervisor'],
    defaultSkills: ['risk-framework', 'hyperliquid-trader', 'polymarket-edge',
                    'kamino-yield', 'orca-lp', 'krystal-lp'],
    description: 'Full-spectrum DeFi operations: trading, intel, safety, yield, LP management',
  },
  'cfo-agent': {
    agents: ['nova-cfo', 'nova-guardian'],
    defaultSkills: ['risk-framework', 'hyperliquid-trader', 'kamino-yield',
                    'orca-lp', 'krystal-lp'],
    description: 'Autonomous CFO: portfolio management, yield strategies, risk control',
  },
  'scout-agent': {
    agents: ['nova-scout'],
    defaultSkills: ['intel-framework', 'kol-monitoring'],
    description: 'Market intelligence: KOL tracking, narrative detection, alpha signals',
  },
  'lp-specialist': {
    agents: ['nova-cfo'],
    defaultSkills: ['risk-framework', 'orca-lp', 'krystal-lp'],
    description: 'LP specialist: concentrated liquidity on Orca, Kamino, Krystal',
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
  // Create orchestrator with a Pool from the same connection string
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require'
      ? { rejectUnauthorized: false } : undefined,
  });
  const orchestrator = new AgentOrchestrator(pool);

  // GET /api/agents/templates — list available templates
  server.get('/agents/templates', async (_req, reply) => {
    reply.send(Object.entries(TEMPLATES).map(([id, t]) => ({
      id,
      name: id.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      description: t.description,
      agents: t.agents,
      skillCount: t.defaultSkills.length,
      defaultSkills: t.defaultSkills,
    })));
  });

  // POST /api/agents/deploy
  // Body: { templateId, name?, riskLevel, wallet?, customBio?, customSystemPrompt? }
  server.post('/agents/deploy', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const body = req.body as {
      templateId: string;
      name?: string;
      riskLevel: 'conservative' | 'balanced' | 'aggressive';
      wallet?: {
        chain: 'solana' | 'evm' | 'both';
        address: string;
        privateKey?: string;
        permissions: ('read' | 'trade' | 'lp')[];
      };
      customBio?: string;
      customSystemPrompt?: string;
    };

    if (!TEMPLATES[body.templateId]) return reply.status(400).send({ error: 'Unknown template' });
    if (!RISK_CONFIGS[body.riskLevel]) return reply.status(400).send({ error: 'Invalid risk level' });

    // Check user doesn't already have an active agent
    const existing = await server.pg.query(
      `SELECT id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (existing.rows.length) {
      return reply.status(409).send({ error: 'Agent already deployed. Pause it before deploying a new one.' });
    }

    try {
      // Deploy via orchestrator — builds character, registers in swarm, creates records
      const instance = await orchestrator.deploy({
        walletAddress: address,
        templateId: body.templateId,
        displayName: body.name || '',
        riskLevel: body.riskLevel,
        wallet: body.wallet,
        customBio: body.customBio,
        customSystemPrompt: body.customSystemPrompt,
      });

      // Also assign default skills (retained from original flow)
      const template = TEMPLATES[body.templateId];
      const primaryRole = template.agents[0];
      for (const skillName of template.defaultSkills) {
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

      // Write risk configs
      for (const [key, val] of Object.entries(RISK_CONFIGS[body.riskLevel])) {
        await server.pg.query(
          `INSERT INTO kv_store (key, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
          [`agent:${instance.agentId}:config:${key}`, JSON.stringify(val)]
        );
      }

      reply.send({
        agentId: instance.agentId,
        displayName: instance.displayName,
        templateId: instance.templateId,
        riskLevel: instance.riskLevel,
        status: instance.status,
        hasCharacter: true,
        hasWallet: !!instance.wallet,
        capabilities: instance.character.settings.capabilities,
      });
    } catch (err: any) {
      server.log.error({ err }, 'Agent deploy failed');
      reply.status(500).send({ error: 'Deploy failed: ' + (err.message || 'unknown') });
    }
  });

  // PATCH/POST /api/agents/pause — pause active agent
  const pauseHandler = async (req: any, reply: any) => {
    try {
      const { address } = req.user as { address: string };
      const ok = await orchestrator.pause(address);
      if (!ok) return reply.status(404).send({ error: 'No active agent found to pause' });
      reply.send({ ok });
    } catch (err: any) {
      server.log.error({ err }, 'Pause failed');
      reply.status(500).send({ error: 'Pause failed: ' + (err.message || 'unknown') });
    }
  };
  server.patch('/agents/pause', { preHandler: requireAuth }, pauseHandler);
  server.post('/agents/pause', { preHandler: requireAuth }, pauseHandler);

  // PATCH/POST /api/agents/resume
  const resumeHandler = async (req: any, reply: any) => {
    try {
      const { address } = req.user as { address: string };
      const ok = await orchestrator.resume(address);
      if (!ok) return reply.status(404).send({ error: 'No agent found to resume' });
      reply.send({ ok });
    } catch (err: any) {
      server.log.error({ err }, 'Resume failed');
      reply.status(500).send({ error: 'Resume failed: ' + (err.message || 'unknown') });
    }
  };
  server.patch('/agents/resume', { preHandler: requireAuth }, resumeHandler);
  server.post('/agents/resume', { preHandler: requireAuth }, resumeHandler);

  // POST /api/agents/redeploy — tear down existing agent and deploy fresh
  // Body: { templateId, name?, riskLevel, wallet?, customBio?, customSystemPrompt? }
  // Works for both pre-existing agents (no character) and current agents.
  server.post('/agents/redeploy', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const body = req.body as {
      templateId: string;
      name?: string;
      riskLevel: 'conservative' | 'balanced' | 'aggressive';
      wallet?: {
        chain: 'solana' | 'evm' | 'both';
        address: string;
        privateKey?: string;
        permissions: ('read' | 'trade' | 'lp')[];
      };
      customBio?: string;
      customSystemPrompt?: string;
    };

    if (!TEMPLATES[body.templateId]) return reply.status(400).send({ error: 'Unknown template' });
    if (!RISK_CONFIGS[body.riskLevel]) return reply.status(400).send({ error: 'Invalid risk level' });

    try {
      const instance = await orchestrator.redeploy(address, {
        walletAddress: address,
        templateId: body.templateId,
        displayName: body.name || '',
        riskLevel: body.riskLevel,
        wallet: body.wallet,
        customBio: body.customBio,
        customSystemPrompt: body.customSystemPrompt,
      });

      // Assign default skills
      const template = TEMPLATES[body.templateId];
      const primaryRole = template.agents[0];
      for (const skillName of template.defaultSkills) {
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

      // Write risk configs
      for (const [key, val] of Object.entries(RISK_CONFIGS[body.riskLevel])) {
        await server.pg.query(
          `INSERT INTO kv_store (key, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
          [`agent:${instance.agentId}:config:${key}`, JSON.stringify(val)]
        );
      }

      reply.send({
        agentId: instance.agentId,
        displayName: instance.displayName,
        templateId: instance.templateId,
        riskLevel: instance.riskLevel,
        status: instance.status,
        hasCharacter: true,
        hasWallet: !!instance.wallet,
        capabilities: instance.character.settings.capabilities,
        redeployed: true,
      });
    } catch (err: any) {
      server.log.error({ err }, 'Agent redeploy failed');
      reply.status(500).send({ error: 'Redeploy failed: ' + (err.message || 'unknown') });
    }
  });

  // POST /api/agents/wallet — attach or update wallet on agent
  // Body: { chain: 'solana'|'evm'|'both', address: string, privateKey?: string, permissions: string[] }
  server.post('/agents/wallet', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const wallet = req.body as {
      chain: 'solana' | 'evm' | 'both';
      address: string;
      privateKey?: string;
      permissions: ('read' | 'trade' | 'lp')[];
    };

    if (!wallet.address || !wallet.chain) {
      return reply.status(400).send({ error: 'chain and address are required' });
    }
    if (!wallet.permissions?.length) {
      wallet.permissions = ['read']; // default to read-only
    }

    const ok = await orchestrator.attachWallet(address, wallet);
    if (!ok) return reply.status(404).send({ error: 'No active agent found' });
    reply.send({ ok: true });
  });

  // GET /api/agents/wallet — get agent's wallet config (no private keys)
  server.get('/agents/wallet', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.send(null);
    const wallet = await orchestrator.getWallet(agentRow.rows[0].agent_id);
    reply.send(wallet);
  });

  // GET /api/agents/character — get agent's ElizaOS character config
  server.get('/agents/character', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.user as { address: string };
    const agentRow = await server.pg.query(
      `SELECT agent_id FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [address]
    );
    if (!agentRow.rows.length) return reply.send(null);
    const character = await orchestrator.getCharacter(agentRow.rows[0].agent_id);
    reply.send(character);
  });

  // GET /api/agents/me — current agent info + wallet + character summary
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
    if (!row.rows.length) return reply.send(null);

    const agent = row.rows[0];
    // Attach wallet info (without keys)
    const wallet = await orchestrator.getWallet(agent.agent_id);
    // Attach character summary
    const character = await orchestrator.getCharacter(agent.agent_id);

    reply.send({
      ...agent,
      wallet: wallet ?? null,
      character: character ? {
        name: character.name,
        bio: character.bio,
        capabilities: character.settings?.capabilities ?? [],
        model: character.settings?.model ?? null,
        riskLevel: character.settings?.riskLevel ?? null,
      } : null,
    });
  });

  // PATCH /api/agents/config — update a config value on the user's agent
  // Body: { key: string, value: string }
  const configHandler = async (req: any, reply: any) => {
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

    const agentId = agentRow.rows[0].agent_id;
    await server.pg.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [`agent:${agentId}:config:${key}`, JSON.stringify(value)]
    );

    reply.send({ ok: true });
  };
  server.patch('/agents/config', { preHandler: requireAuth }, configHandler);
  server.post('/agents/config', { preHandler: requireAuth }, configHandler);
}
