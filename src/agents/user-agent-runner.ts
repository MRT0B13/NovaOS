/**
 * User Agent Runner — executes NovaVerse user-deployed agents
 *
 * Each user agent deployed via the dashboard becomes a UserAgentRunner instance.
 * It extends BaseAgent to use the same message bus, heartbeat, and state
 * persistence as the core swarm agents.
 *
 * Lifecycle:
 *   1. initSwarm() scans agent_registry for user agents (type starts with 'novaverse-')
 *   2. A UserAgentRunner is instantiated with the agent's config from agent_registry
 *   3. On start, it loads its Character from kv_store, skills from agent_skills
 *   4. It runs a periodic decision cycle — reading messages, refreshing skill context,
 *      executing capability-specific tasks, and heartbeating
 *
 * Skills drive behaviour:
 *   - risk-framework   → position monitoring, exposure limit checks
 *   - hyperliquid-trader → hedge checks, stop-loss enforcement
 *   - orca-lp / evm-lp → LP health monitoring, rebalance checks
 *   - kamino-yield      → LTV monitoring, yield tracking
 *   - scout-intel-scoring → intel digest consumption
 *
 * The runner does NOT duplicate CFO/Scout logic — it delegates to the existing
 * shared services (decisionEngine, SkillsService, etc.) scoped to the user's
 * agent_id so positions/messages/configs stay isolated.
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent, type AgentConfig } from './types.ts';
import { SkillsService } from '../launchkit/services/skillsService.ts';
import type { GeneratedCharacter } from '../api/services/agentCharacterBuilder.js';

// ============================================================================
// Types
// ============================================================================

export interface UserAgentConfig {
  /** Unique agent ID (UUID from orchestrator) */
  agentId: string;
  /** Display name from user_agents */
  displayName: string;
  /** Template used (cfo-agent, scout-agent, etc.) */
  templateId: string;
  /** Risk level */
  riskLevel: string;
  /** Owner wallet address */
  ownerWallet: string;
  /** Agent role for skill lookups (maps to agent_skill_assignments.agent_role) */
  agentRole: string;
}

// ============================================================================
// User Agent Runner
// ============================================================================

export class UserAgentRunner extends BaseAgent {
  private character: GeneratedCharacter | null = null;
  private userConfig: UserAgentConfig;
  private skillsService: SkillsService;
  private cycleCount = 0;

  /** Decision cycle interval — user agents run less frequently than core swarm */
  private static CYCLE_INTERVAL_MS = 5 * 60_000;  // 5 minutes
  /** Message poll interval */
  private static MESSAGE_POLL_MS = 30_000;         // 30 seconds
  /** Heartbeat interval */
  private static HEARTBEAT_MS = 60_000;            // 1 minute

  constructor(pool: Pool, config: UserAgentConfig) {
    super({
      pool,
      agentId: `user-agent-${config.agentId}`,
      agentType: 'cfo',  // Closest match in AgentType union
      displayName: config.displayName,
      agentCategory: 'user',
    });
    this.userConfig = config;
    this.skillsService = new SkillsService(pool);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  protected async onStart(): Promise<void> {
    logger.info(`[${this.agentId}] Starting user agent "${this.userConfig.displayName}" (${this.userConfig.templateId})`);

    // 1. Load character from kv_store
    await this.loadCharacter();

    // 2. Load initial skill context
    await this.refreshSkills();

    // 3. Announce existence to supervisor
    await this.reportToSupervisor('status', 'low', {
      event: 'agent_started',
      displayName: this.userConfig.displayName,
      templateId: this.userConfig.templateId,
      riskLevel: this.userConfig.riskLevel,
      owner: this.userConfig.ownerWallet,
      skills: this.character?.skills ?? [],
    });

    // 4. Start loops
    this.startHeartbeat(UserAgentRunner.HEARTBEAT_MS);
    this.addInterval(() => this.pollMessages(), UserAgentRunner.MESSAGE_POLL_MS);
    this.addInterval(() => this.runCycle(), UserAgentRunner.CYCLE_INTERVAL_MS);

    // 5. Run first cycle immediately (after a 10s warmup)
    setTimeout(() => this.runCycle(), 10_000);

    logger.info(`[${this.agentId}] ✅ User agent running — cycle every ${UserAgentRunner.CYCLE_INTERVAL_MS / 1000}s`);
  }

  protected async onStop(): Promise<void> {
    logger.info(`[${this.agentId}] Stopping user agent "${this.userConfig.displayName}"`);
    await this.reportToSupervisor('status', 'low', {
      event: 'agent_stopped',
      displayName: this.userConfig.displayName,
    });
  }

  // ── Character & Skills ──────────────────────────────────────────

  private async loadCharacter(): Promise<void> {
    try {
      const row = await this.pool.query(
        `SELECT data FROM kv_store WHERE key = $1`,
        [`agent:${this.userConfig.agentId}:character`],
      );
      if (row.rows.length) {
        this.character = row.rows[0].data as GeneratedCharacter;
        logger.info(`[${this.agentId}] Loaded character: ${this.character.name} (${this.character.skills?.length ?? 0} skills)`);
      } else {
        logger.warn(`[${this.agentId}] No character config found in kv_store`);
      }
    } catch (err) {
      logger.error(`[${this.agentId}] Failed to load character:`, err);
    }
  }

  private async refreshSkills(): Promise<void> {
    try {
      this.currentSkillContext = await this.skillsService.loadSkillsForAgent(this.userConfig.agentRole);
      if (this.currentSkillContext) {
        logger.debug(`[${this.agentId}] Loaded skill context (${this.currentSkillContext.length} chars)`);
      }
    } catch (err) {
      logger.warn(`[${this.agentId}] Failed to refresh skills:`, err);
    }
  }

  // ── Message Handling ────────────────────────────────────────────

  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    const messages = await this.readMessages(20);
    for (const msg of messages) {
      try {
        await this.handleMessage(msg);
        await this.acknowledgeMessage(msg.id!);
      } catch (err) {
        logger.warn(`[${this.agentId}] Failed to handle message ${msg.id}:`, err);
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    const { message_type, payload } = msg;

    switch (message_type) {
      case 'command':
        await this.handleCommand(payload);
        break;
      case 'intel':
        // Intel from scout — log and consider for next cycle
        await this.logActivity('intel_received', {
          from: msg.from_agent,
          signal: payload.signal ?? payload.summary ?? 'unknown',
        });
        break;
      case 'alert':
        // Safety alert from guardian — high priority
        await this.logActivity('alert_received', {
          from: msg.from_agent,
          alert: payload.alert ?? payload.message ?? 'unknown',
          severity: msg.priority,
        });
        break;
      default:
        logger.debug(`[${this.agentId}] Unhandled message type: ${message_type}`);
    }
  }

  private async handleCommand(payload: any): Promise<void> {
    const { command } = payload;
    switch (command) {
      case 'pause':
        await this.stop();
        break;
      case 'refresh_skills':
        await this.refreshSkills();
        break;
      case 'reload_character':
        await this.loadCharacter();
        break;
      default:
        logger.debug(`[${this.agentId}] Unknown command: ${command}`);
    }
  }

  // ── Decision Cycle ──────────────────────────────────────────────

  /**
   * Main execution cycle — runs every CYCLE_INTERVAL_MS.
   *
   * What the agent does each cycle depends on its assigned skills:
   *   - Check portfolio health (if risk-framework skill)
   *   - Monitor positions (if trading/lp skills)
   *   - Process intel digests (if intel skill)
   *   - Report status to supervisor
   */
  private async runCycle(): Promise<void> {
    if (!this.running) return;
    this.cycleCount++;

    await this.updateStatus('alive');

    try {
      // Refresh skills periodically (every 10 cycles = ~50 min)
      if (this.cycleCount % 10 === 0) {
        await this.refreshSkills();
      }

      const capabilities = this.character?.settings?.capabilities ?? [];
      const skills = this.character?.skills ?? [];

      // ── Portfolio Health Check ──
      if (skills.includes('risk-framework') || capabilities.includes('treasury')) {
        await this.checkPortfolioHealth();
      }

      // ── Position Monitoring ──
      if (capabilities.includes('lp') || skills.includes('orca-lp') || skills.includes('evm-lp')) {
        await this.checkLpPositions();
      }

      // ── PnL Tracking ──
      if (capabilities.includes('trading') || skills.includes('hyperliquid-trader')) {
        await this.checkTradingPositions();
      }

      // ── Intel Consumption ──
      if (capabilities.includes('intel') || skills.includes('scout-intel-scoring')) {
        await this.consumeIntelDigest();
      }

      // ── Periodic status report to supervisor (every 6 cycles = ~30 min) ──
      if (this.cycleCount % 6 === 0) {
        await this.reportStatus();
      }

      // Save state after each cycle
      await this.saveState({
        cycleCount: this.cycleCount,
        lastCycleAt: new Date().toISOString(),
        capabilities,
        skills,
      });

    } catch (err) {
      logger.error(`[${this.agentId}] Cycle ${this.cycleCount} failed:`, err);
      await this.updateStatus('degraded');
    }
  }

  // ── Capability Handlers ─────────────────────────────────────────

  private async checkPortfolioHealth(): Promise<void> {
    try {
      // Read positions scoped to this agent
      const positions = await this.pool.query(
        `SELECT asset, side, entry_price, current_price, quantity, unrealized_pnl, status
         FROM cfo_positions
         WHERE agent_id = $1 AND status = 'OPEN'
         ORDER BY ABS(unrealized_pnl) DESC
         LIMIT 20`,
        [this.userConfig.agentId],
      );

      if (!positions.rows.length) return;

      // Load risk config
      const riskConfig = await this.loadConfig('CFO_MAX_DECISIONS_PER_CYCLE');
      const totalUnrealized = positions.rows.reduce(
        (sum: number, p: any) => sum + (Number(p.unrealized_pnl) || 0), 0
      );

      // Alert if portfolio drawdown exceeds threshold
      const drawdownThreshold = this.userConfig.riskLevel === 'conservative' ? -8
        : this.userConfig.riskLevel === 'balanced' ? -15 : -25;

      if (totalUnrealized < drawdownThreshold) {
        await this.reportToSupervisor('alert', 'high', {
          event: 'drawdown_alert',
          totalUnrealized,
          threshold: drawdownThreshold,
          riskLevel: this.userConfig.riskLevel,
          positionCount: positions.rows.length,
          owner: this.userConfig.ownerWallet,
        });

        await this.logActivity('drawdown_alert', {
          totalUnrealized,
          threshold: drawdownThreshold,
        });
      }

      // Log portfolio snapshot
      await this.logActivity('portfolio_check', {
        openPositions: positions.rows.length,
        totalUnrealized,
        topPosition: positions.rows[0]?.asset,
      });

    } catch (err) {
      logger.warn(`[${this.agentId}] Portfolio health check failed:`, err);
    }
  }

  private async checkLpPositions(): Promise<void> {
    try {
      const lpPositions = await this.pool.query(
        `SELECT asset, quantity, entry_price, current_price, unrealized_pnl, metadata
         FROM cfo_positions
         WHERE agent_id = $1 AND status = 'OPEN'
           AND (asset LIKE 'orca-lp-%' OR asset LIKE 'evm-lp-%')
         ORDER BY created_at DESC`,
        [this.userConfig.agentId],
      );

      if (!lpPositions.rows.length) return;

      for (const pos of lpPositions.rows) {
        const metadata = pos.metadata || {};
        // Check if position is out of range
        if (metadata.outOfRange) {
          await this.logActivity('lp_out_of_range', {
            asset: pos.asset,
            unrealizedPnl: pos.unrealized_pnl,
          });
        }
      }

      await this.logActivity('lp_check', {
        lpPositionCount: lpPositions.rows.length,
        totalLpPnl: lpPositions.rows.reduce(
          (sum: number, p: any) => sum + (Number(p.unrealized_pnl) || 0), 0
        ),
      });
    } catch (err) {
      logger.warn(`[${this.agentId}] LP position check failed:`, err);
    }
  }

  private async checkTradingPositions(): Promise<void> {
    try {
      const trades = await this.pool.query(
        `SELECT asset, side, entry_price, current_price, quantity, unrealized_pnl, metadata
         FROM cfo_positions
         WHERE agent_id = $1 AND status = 'OPEN'
           AND asset NOT LIKE 'orca-lp-%' AND asset NOT LIKE 'evm-lp-%'
         ORDER BY created_at DESC`,
        [this.userConfig.agentId],
      );

      if (!trades.rows.length) return;

      // Check for stop-loss triggers
      for (const trade of trades.rows) {
        const pnlPct = trade.entry_price > 0
          ? ((trade.current_price - trade.entry_price) / trade.entry_price) * 100
          : 0;

        // Hard stop-loss check
        if (pnlPct < -10) {
          await this.reportToSupervisor('alert', 'critical', {
            event: 'stop_loss_trigger',
            asset: trade.asset,
            pnlPct: pnlPct.toFixed(2),
            side: trade.side,
            owner: this.userConfig.ownerWallet,
          });
        }
      }

      await this.logActivity('trading_check', {
        openTrades: trades.rows.length,
        totalTradePnl: trades.rows.reduce(
          (sum: number, p: any) => sum + (Number(p.unrealized_pnl) || 0), 0
        ),
      });
    } catch (err) {
      logger.warn(`[${this.agentId}] Trading position check failed:`, err);
    }
  }

  private async consumeIntelDigest(): Promise<void> {
    try {
      // Check for recent intel messages from scout agents
      const intel = await this.pool.query(
        `SELECT payload, created_at FROM agent_messages
         WHERE to_agent = $1 AND message_type = 'intel'
           AND acknowledged = false
           AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC LIMIT 5`,
        [this.agentId],
      );

      for (const row of intel.rows) {
        await this.logActivity('intel_consumed', {
          signal: row.payload?.signal ?? row.payload?.summary ?? 'unknown',
          source: row.payload?.source ?? 'unknown',
        });
        // Acknowledge so it's not re-read
        if (row.id) await this.acknowledgeMessage(row.id);
      }
    } catch (err) {
      logger.warn(`[${this.agentId}] Intel digest consumption failed:`, err);
    }
  }

  // ── Reporting ───────────────────────────────────────────────────

  private async reportStatus(): Promise<void> {
    try {
      const posCount = await this.pool.query(
        `SELECT COUNT(*) as count FROM cfo_positions WHERE agent_id = $1 AND status = 'OPEN'`,
        [this.userConfig.agentId],
      );
      const msgCount = await this.pool.query(
        `SELECT COUNT(*) as count FROM agent_messages
         WHERE (from_agent = $1 OR to_agent = $1)
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [this.agentId],
      );

      await this.reportToSupervisor('report', 'low', {
        event: 'periodic_status',
        displayName: this.userConfig.displayName,
        templateId: this.userConfig.templateId,
        owner: this.userConfig.ownerWallet,
        cycleCount: this.cycleCount,
        openPositions: Number(posCount.rows[0]?.count ?? 0),
        messages24h: Number(msgCount.rows[0]?.count ?? 0),
        skills: this.character?.skills ?? [],
      });
    } catch (err) {
      logger.warn(`[${this.agentId}] Status report failed:`, err);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async loadConfig(key: string): Promise<string | null> {
    try {
      const row = await this.pool.query(
        `SELECT data FROM kv_store WHERE key = $1`,
        [`agent:${this.userConfig.agentId}:config:${key}`],
      );
      return row.rows[0]?.data ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Log an activity as an agent_message from this agent to itself.
   * This feeds the dashboard feed and provides audit trail.
   */
  private async logActivity(event: string, data: Record<string, any>): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload, agent_id)
         VALUES ($1, $2, 'report', 'low', $3, $4)`,
        [
          this.agentId,
          this.agentId,
          JSON.stringify({ event, ...data, timestamp: new Date().toISOString() }),
          this.userConfig.agentId,
        ],
      );
    } catch {
      // agent_messages might not have agent_id column — fall back
      try {
        await this.pool.query(
          `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
           VALUES ($1, $2, 'report', 'low', $3)`,
          [
            this.agentId,
            this.agentId,
            JSON.stringify({ event, ...data, timestamp: new Date().toISOString() }),
          ],
        );
      } catch (err) {
        logger.warn(`[${this.agentId}] logActivity failed:`, err);
      }
    }
  }
}

// ============================================================================
// Discovery — scan agent_registry for user-deployed agents
// ============================================================================

/**
 * Scan agent_registry for user-deployed agents and return runner configs.
 * Called by initSwarm() to discover agents that should be started.
 */
export async function discoverUserAgents(pool: Pool): Promise<UserAgentConfig[]> {
  try {
    const result = await pool.query(
      `SELECT ar.agent_name, ar.agent_type, ar.config, ar.enabled,
              ua.agent_id, ua.template_id, ua.risk_level, ua.wallet_address, ua.display_name
       FROM agent_registry ar
       JOIN user_agents ua ON ua.display_name = ar.agent_name AND ua.active = true
       WHERE ar.agent_type LIKE 'novaverse-%'
         AND ar.enabled = true
         AND ua.status = 'running'`,
    );

    return result.rows.map((row: any) => {
      const config = row.config || {};
      // Map template to agent_role for skill lookups
      const roleMap: Record<string, string> = {
        'full-nova': 'nova-cfo',
        'cfo-agent': 'nova-cfo',
        'scout-agent': 'nova-scout',
        'lp-specialist': 'nova-cfo',
      };

      return {
        agentId: row.agent_id,
        displayName: row.display_name || row.agent_name,
        templateId: row.template_id || config.templateId || 'cfo-agent',
        riskLevel: row.risk_level || config.riskLevel || 'balanced',
        ownerWallet: row.wallet_address || config.createdBy || '',
        agentRole: roleMap[row.template_id] || 'nova-cfo',
      };
    });
  } catch (err) {
    logger.warn('[UserAgentRunner] Failed to discover user agents:', err);
    return [];
  }
}

/**
 * Start all discovered user agents and return their runner instances.
 */
export async function startUserAgents(pool: Pool): Promise<UserAgentRunner[]> {
  const configs = await discoverUserAgents(pool);
  if (!configs.length) {
    logger.info('[UserAgentRunner] No user agents to start');
    return [];
  }

  logger.info(`[UserAgentRunner] Discovered ${configs.length} user agent(s) to start`);
  const runners: UserAgentRunner[] = [];

  for (const config of configs) {
    try {
      const runner = new UserAgentRunner(pool, config);
      await runner.start();
      runners.push(runner);
      logger.info(`[UserAgentRunner] ✅ Started: ${config.displayName} (${config.templateId})`);
    } catch (err) {
      logger.warn(`[UserAgentRunner] Failed to start agent ${config.displayName}:`, err);
    }
  }

  return runners;
}
