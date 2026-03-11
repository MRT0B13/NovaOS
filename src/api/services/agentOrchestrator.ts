/**
 * Agent Orchestrator — manages lifecycle of real NovaVerse agent instances
 *
 * Bridges the NovaVerse API to the actual agent swarm.
 * When a user deploys an agent via the dashboard:
 *   1. Character is built from template + user config (agentCharacterBuilder)
 *   2. Agent is registered in agent_registry (the swarm's source of truth)
 *   3. Factory spec is created & persisted for restart survival
 *   4. Agent is linked to user via user_agents table
 *
 * Agent states:
 *   pending  → Character built, awaiting resource allocation
 *   running  → Agent process active, heartbeating
 *   paused   → Agent registered but not polling / executing
 *   stopped  → Agent deactivated, data retained
 *
 * Integration:
 *   - Uses the existing AgentFactory (src/agents/factory.ts) for spawn/stop
 *   - Uses agent_registry for swarm-level registration
 *   - Uses agent_heartbeats for liveness monitoring
 *   - Uses agent_messages for cross-agent communication
 *   - Uses kv_store for per-agent configuration
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { buildCharacter, serializeCharacter, type AgentCharacterConfig, type GeneratedCharacter } from './agentCharacterBuilder.js';
import { encryptWalletKey, type WalletConfig } from '../../agents/wallet-utils.js';
import { UserAgentRunner, type UserAgentConfig } from '../../agents/user-agent-runner.js';

// ============================================================================
// Types
// ============================================================================

export interface DeployRequest {
  walletAddress: string;
  templateId: string;
  displayName: string;
  riskLevel: 'conservative' | 'balanced' | 'aggressive';
  wallet?: {
    chain: 'solana' | 'evm' | 'both';
    address: string;
    privateKey?: string;         // Will be encrypted immediately, never stored raw
    permissions: ('read' | 'trade' | 'lp')[];
  };
  customBio?: string;
  customSystemPrompt?: string;
  enabledSkills?: string[];
}

export interface AgentInstance {
  agentId: string;
  displayName: string;
  templateId: string;
  riskLevel: string;
  status: string;
  character: GeneratedCharacter;
  wallet?: WalletConfig;
  createdAt: Date;
}

// ============================================================================
// Agent Orchestrator
// ============================================================================

export class AgentOrchestrator {
  private pool: Pool;
  /** Running user agent instances — keyed by agentId */
  private runners: Map<string, UserAgentRunner> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Deploy a new agent for a user.
   *
   * 1. Build ElizaOS character from template
   * 2. Register in agent_registry (swarm knows about it)
   * 3. Store character config in kv_store
   * 4. Create user_agents record (links wallet → agent)
   * 5. Assign default skills
   * 6. Write risk config
   */
  async deploy(req: DeployRequest): Promise<AgentInstance> {
    const agentId = uuidv4();
    const agentNumber = Math.floor(1000 + Math.random() * 9000);
    const finalName = req.displayName || `Nova Agent #${agentNumber}`;

    // ── 1. Build character ──
    const charConfig: AgentCharacterConfig = {
      templateId: req.templateId,
      displayName: finalName,
      riskLevel: req.riskLevel,
      walletAddress: req.wallet?.address,
      walletChain: req.wallet?.chain,
      customBio: req.customBio,
      customSystemPrompt: req.customSystemPrompt,
      enabledSkills: req.enabledSkills,
    };
    const character = buildCharacter(charConfig);

    // ── 2. Encrypt wallet key if provided ──
    let walletConfig: WalletConfig | undefined;
    if (req.wallet) {
      walletConfig = {
        chain: req.wallet.chain,
        address: req.wallet.address,
        permissions: req.wallet.permissions,
      };
      if (req.wallet.privateKey) {
        walletConfig.encryptedKey = encryptWalletKey(req.wallet.privateKey);
      }
    }

    // ── 3. Register in agent_registry (swarm-level) ──
    const agentType = this.templateToAgentType(req.templateId);
    await this.pool.query(
      `INSERT INTO agent_registry (agent_name, agent_type, config, enabled, start_command, created_at)
       VALUES ($1, $2, $3, true, $4, NOW())
       ON CONFLICT (agent_name) DO UPDATE SET config = $3, enabled = true`,
      [
        finalName,
        agentType,
        JSON.stringify({
          specId: agentId,
          templateId: req.templateId,
          riskLevel: req.riskLevel,
          character: character,
          wallet: walletConfig ? { ...walletConfig, encryptedKey: undefined } : undefined, // Don't put encrypted key in registry
          capabilities: character.settings.capabilities,
          createdBy: req.walletAddress,
          createdAt: new Date().toISOString(),
        }),
        `factory:${req.templateId}`,
      ]
    );

    // ── 4. Store full character config in kv_store ──
    await this.pool.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [`agent:${agentId}:character`, JSON.stringify(character)]
    );

    // ── 5. Store wallet config separately (encrypted) ──
    if (walletConfig) {
      await this.pool.query(
        `INSERT INTO kv_store (key, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
        [`agent:${agentId}:wallet`, JSON.stringify(walletConfig)]
      );
    }

    // ── 6. Create user_agents record ──
    await this.pool.query(
      `INSERT INTO user_agents (id, agent_id, wallet_address, template_id, display_name,
                                risk_level, status, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', true, NOW())`,
      [uuidv4(), agentId, req.walletAddress, req.templateId, finalName, req.riskLevel]
    );

    // ── 7. Write initial heartbeat (agent is alive) ──
    await this.pool.query(
      `INSERT INTO agent_heartbeats (agent_name, status, state_json, last_beat)
       VALUES ($1, 'alive', '{}', NOW())
       ON CONFLICT (agent_name) DO UPDATE SET status = 'alive', last_beat = NOW()`,
      [finalName]
    );

    // ── 8. Spawn the agent runner immediately (starts executing now) ──
    const roleMap: Record<string, string> = {
      'full-nova': 'nova-cfo', 'cfo-agent': 'nova-cfo',
      'scout-agent': 'nova-scout', 'lp-specialist': 'nova-cfo',
      'governance-agent': 'nova-supervisor', 'community-agent': 'nova-community',
      'analyst-agent': 'nova-analyst',
    };
    const runnerConfig: UserAgentConfig = {
      agentId,
      displayName: finalName,
      templateId: req.templateId,
      riskLevel: req.riskLevel,
      ownerWallet: req.walletAddress,
      agentRole: roleMap[req.templateId] || 'nova-cfo',
    };
    try {
      const runner = new UserAgentRunner(this.pool, runnerConfig);
      await runner.start();
      this.runners.set(agentId, runner);
    } catch (err) {
      // Non-fatal — agent will be picked up on next boot
      console.warn(`[orchestrator] Failed to start runner for ${finalName}:`, err);
    }

    return {
      agentId,
      displayName: finalName,
      templateId: req.templateId,
      riskLevel: req.riskLevel,
      status: 'running',
      character,
      wallet: walletConfig,
      createdAt: new Date(),
    };
  }

  /**
   * Pause an agent — sets status to 'paused' in user_agents and
   * disables in agent_registry so the swarm stops polling it.
   */
  async pause(walletAddress: string): Promise<boolean> {
    const agent = await this.getUserAgent(walletAddress);
    if (!agent) return false;

    await this.pool.query(
      `UPDATE user_agents SET status = 'paused' WHERE wallet_address = $1 AND active = true`,
      [walletAddress]
    );

    // Mark disabled in agent_registry
    await this.pool.query(
      `UPDATE agent_registry SET enabled = false WHERE agent_name = $1`,
      [agent.display_name]
    );

    // Update heartbeat
    await this.pool.query(
      `UPDATE agent_heartbeats SET status = 'disabled' WHERE agent_name = $1`,
      [agent.display_name]
    );

    // Stop the in-memory runner if it's running
    const runner = this.runners.get(agent.agent_id);
    if (runner) {
      try { await runner.stop(); } catch { /* already stopped */ }
      this.runners.delete(agent.agent_id);
    }

    return true;
  }

  /**
   * Resume a paused agent.
   */
  async resume(walletAddress: string): Promise<boolean> {
    const agent = await this.getUserAgent(walletAddress);
    if (!agent) return false;

    await this.pool.query(
      `UPDATE user_agents SET status = 'running' WHERE wallet_address = $1 AND active = true`,
      [walletAddress]
    );

    await this.pool.query(
      `UPDATE agent_registry SET enabled = true WHERE agent_name = $1`,
      [agent.display_name]
    );

    await this.pool.query(
      `UPDATE agent_heartbeats SET status = 'alive', last_beat = NOW() WHERE agent_name = $1`,
      [agent.display_name]
    );

    // Re-spawn the runner if not already running
    if (!this.runners.has(agent.agent_id)) {
      const roleMap: Record<string, string> = {
        'full-nova': 'nova-cfo', 'cfo-agent': 'nova-cfo',
        'scout-agent': 'nova-scout', 'lp-specialist': 'nova-cfo',
        'governance-agent': 'nova-supervisor', 'community-agent': 'nova-community',
        'analyst-agent': 'nova-analyst',
      };
      try {
        const runner = new UserAgentRunner(this.pool, {
          agentId: agent.agent_id,
          displayName: agent.display_name,
          templateId: agent.template_id,
          riskLevel: 'balanced',
          ownerWallet: walletAddress,
          agentRole: roleMap[agent.template_id] || 'nova-cfo',
        });
        await runner.start();
        this.runners.set(agent.agent_id, runner);
      } catch (err) {
        console.warn(`[orchestrator] Failed to restart runner for ${agent.display_name}:`, err);
      }
    }

    return true;
  }

  /**
   * Attach or update a wallet on an existing agent.
   */
  async attachWallet(walletAddress: string, wallet: {
    chain: 'solana' | 'evm' | 'both';
    address: string;
    privateKey?: string;
    permissions: ('read' | 'trade' | 'lp')[];
  }): Promise<boolean> {
    const agent = await this.getUserAgent(walletAddress);
    if (!agent) return false;

    const walletConfig: WalletConfig = {
      chain: wallet.chain,
      address: wallet.address,
      permissions: wallet.permissions,
    };
    if (wallet.privateKey) {
      walletConfig.encryptedKey = encryptWalletKey(wallet.privateKey);
    }

    // Store wallet config
    await this.pool.query(
      `INSERT INTO kv_store (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [`agent:${agent.agent_id}:wallet`, JSON.stringify(walletConfig)]
    );

    // Update character with wallet info
    const charRow = await this.pool.query(
      `SELECT data FROM kv_store WHERE key = $1`,
      [`agent:${agent.agent_id}:character`]
    );
    if (charRow.rows.length) {
      const character = charRow.rows[0].data;
      character.settings = character.settings || {};
      character.settings.wallet = {
        chain: wallet.chain,
        address: wallet.address,
      };
      // Add wallet context to system prompt
      if (!character.system.includes('Wallet Configuration:')) {
        character.system += `\n\nWallet Configuration:\n- Chain: ${wallet.chain}\n- Address: ${wallet.address}\n- All on-chain actions must use this wallet`;
      }
      await this.pool.query(
        `UPDATE kv_store SET data = $1, updated_at = NOW() WHERE key = $2`,
        [JSON.stringify(character), `agent:${agent.agent_id}:character`]
      );
    }

    return true;
  }

  /**
   * Get the agent's full character config.
   */
  async getCharacter(agentId: string): Promise<GeneratedCharacter | null> {
    const row = await this.pool.query(
      `SELECT data FROM kv_store WHERE key = $1`,
      [`agent:${agentId}:character`]
    );
    return row.rows[0]?.data ?? null;
  }

  /**
   * Get the agent's wallet config (without encrypted key for API responses).
   */
  async getWallet(agentId: string): Promise<Omit<WalletConfig, 'encryptedKey'> | null> {
    const row = await this.pool.query(
      `SELECT data FROM kv_store WHERE key = $1`,
      [`agent:${agentId}:wallet`]
    );
    if (!row.rows.length) return null;
    const wallet = row.rows[0].data;
    // Never expose the encrypted key via API
    return {
      chain: wallet.chain,
      address: wallet.address,
      permissions: wallet.permissions,
    };
  }

  // ── Helpers ──

  private async getUserAgent(walletAddress: string) {
    const row = await this.pool.query(
      `SELECT agent_id, display_name, template_id, status
       FROM user_agents WHERE wallet_address = $1 AND active = true`,
      [walletAddress]
    );
    return row.rows[0] ?? null;
  }

  private templateToAgentType(templateId: string): string {
    const map: Record<string, string> = {
      'full-nova': 'novaverse-full',
      'cfo-agent': 'novaverse-cfo',
      'scout-agent': 'novaverse-scout',
      'lp-specialist': 'novaverse-lp',
      'governance-agent': 'novaverse-governance',
      'community-agent': 'novaverse-community',
      'analyst-agent': 'novaverse-analyst',
    };
    return map[templateId] ?? 'novaverse-custom';
  }

  /**
   * Redeploy an agent — tears down the old instance and deploys a fresh one.
   *
   * 1. Stop the running runner (if any)
   * 2. Deactivate old user_agents record (preserves history)
   * 3. Clean up old kv_store entries
   * 4. Disable old agent_registry entry
   * 5. Deploy a brand new agent via the full deploy() pipeline
   *
   * The old agent’s positions and messages are NOT deleted —
   * they remain for audit. The new agent gets a fresh agent_id.
   */
  async redeploy(walletAddress: string, req: DeployRequest): Promise<AgentInstance> {
    const oldAgent = await this.getUserAgent(walletAddress);

    if (oldAgent) {
      // ── 1. Stop the runner ──
      const runner = this.runners.get(oldAgent.agent_id);
      if (runner) {
        try { await runner.stop(); } catch { /* already stopped */ }
        this.runners.delete(oldAgent.agent_id);
      }

      // ── 2. Deactivate old user_agents record ──
      // NOTE: status CHECK constraint only allows deploying|running|paused|error
      // so we use 'paused' + active=false to indicate replaced
      await this.pool.query(
        `UPDATE user_agents SET active = false, status = 'paused'
         WHERE wallet_address = $1 AND active = true`,
        [walletAddress]
      );

      // ── 3. Disable old agent_registry entry ──
      await this.pool.query(
        `UPDATE agent_registry SET enabled = false WHERE agent_name = $1`,
        [oldAgent.display_name]
      );

      // ── 4. Mark old heartbeat as dead ──
      await this.pool.query(
        `UPDATE agent_heartbeats SET status = 'disabled' WHERE agent_name = $1`,
        [oldAgent.display_name]
      );
    }

    // ── 5. Deploy fresh via the full pipeline ──
    return this.deploy(req);
  }
}
