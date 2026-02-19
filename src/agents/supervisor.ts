/**
 * Nova Supervisor
 *
 * Nova IS the supervisor. This module runs INSIDE Nova's main ElizaOS process
 * (not as a separate agent). It polls agent_messages and makes decisions
 * based on incoming intel/alerts from the 6 sub-agents.
 *
 * Architecture:
 *   Nova (Supervisor) ← reads from agent_messages
 *     ├── Scout     → sends intel (KOL data, narrative shifts)
 *     ├── Guardian  → sends alerts (rug flags, LP unlocked, whale moves)
 *     ├── Analyst   → sends reports (DeFi metrics, on-chain data)
 *     ├── Launcher  → sends status (token launches, graduation events)
 *     ├── Community → sends reports (engagement metrics, mod actions)
 *     └── Health    → sends reports (swarm status, repair actions) [already built]
 *
 * Decision flow:
 *   1. Scout sends narrative shift → Supervisor decides whether to tweet/post
 *   2. Guardian sends safety alert → Supervisor decides whether to warn community
 *   3. Analyst sends DeFi update → Supervisor incorporates into next content cycle
 *   4. Launcher sends graduation → Supervisor posts celebration
 *   5. Community sends engagement spike → Supervisor adjusts reply frequency
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent, type AgentMessage, type MessageType } from './types.ts';
import { TokenChildAgent, type TokenChildConfig } from './token-child.ts';

// ============================================================================
// Types
// ============================================================================

type MessageHandler = (msg: AgentMessage) => Promise<void>;

export interface SupervisorCallbacks {
  onPostToX?: (content: string) => Promise<void>;
  onPostToTelegram?: (chatId: string, content: string) => Promise<void>;
  onLaunchToken?: (config: any) => Promise<void>;
  onPostToChannel?: (content: string) => Promise<void>;
  onPostToFarcaster?: (content: string, channel: string) => Promise<void>;
}

// ============================================================================
// Supervisor
// ============================================================================

export class Supervisor extends BaseAgent {
  private handlers: Map<string, MessageHandler> = new Map();
  private pollIntervalMs: number;
  public callbacks: SupervisorCallbacks = {};

  // Active token child agents
  private children: Map<string, TokenChildAgent> = new Map();

  // Track agent status for dashboard
  private agentStatuses: Map<string, { status: string; lastSeen: Date; lastMessage?: string }> = new Map();

  constructor(pool: Pool, pollIntervalMs: number = 5_000) {
    super({
      agentId: 'nova',
      agentType: 'supervisor',
      pool,
    });
    this.pollIntervalMs = pollIntervalMs;
    this.registerDefaultHandlers();
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);
    this.addInterval(() => this.pollMessages(), this.pollIntervalMs);
    // Also periodically check agent health (separate from Health Agent's deeper checks)
    this.addInterval(() => this.checkAgentStatuses(), 5 * 60 * 1000); // every 5 min
    logger.info(`[supervisor] Polling every ${this.pollIntervalMs}ms`);
  }

  protected async onStop(): Promise<void> {
    // Gracefully shut down all token child agents
    if (this.children.size > 0) {
      logger.info(`[supervisor] Stopping ${this.children.size} child agents...`);
      const stopPromises = Array.from(this.children.values()).map(c =>
        c.stop().catch(e => logger.warn(`[supervisor] Error stopping child: ${e.message}`))
      );
      await Promise.allSettled(stopPromises);
      this.children.clear();
    }
  }

  // ── Wire callbacks from Nova's main process ──────────────────────

  setCallbacks(callbacks: SupervisorCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // ── Message Polling ──────────────────────────────────────────────

  private async pollMessages(): Promise<void> {
    try {
      const messages = await this.readMessages(10);
      for (const msg of messages) {
        await this.handleMessage(msg);
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch (err) {
      logger.error('[supervisor] Poll failed:', err);
    }
  }

  private async handleMessage(msg: AgentMessage): Promise<void> {
    // Update agent status tracking
    this.agentStatuses.set(msg.from_agent, {
      status: 'active',
      lastSeen: new Date(),
      lastMessage: msg.message_type,
    });

    // Find handler: try specific (agent:type), then wildcard (*:type)
    const key = `${msg.from_agent}:${msg.message_type}`;
    const handler = this.handlers.get(key) || this.handlers.get(`*:${msg.message_type}`);

    if (handler) {
      try {
        await handler(msg);
      } catch (err) {
        logger.error(`[supervisor] Handler failed for ${key}:`, err);
      }
    } else {
      logger.debug(`[supervisor] No handler for ${key}`);
    }
  }

  // ── Default Message Handlers ─────────────────────────────────────

  private registerDefaultHandlers(): void {
    // ── Scout Intel ──
    this.handlers.set('nova-scout:intel', async (msg) => {
      const { source, narratives, summary } = msg.payload;

      if (source === 'narrative_shift' && msg.priority === 'high') {
        // Significant narrative shift — post to X + TG channel + Farcaster
        const content = `📡 Narrative shift detected: ${summary || narratives?.summary || 'Check thread for details'}`;
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(content);
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToFarcaster) {
          await this.callbacks.onPostToFarcaster(content, 'ai-agents');
          await this.callbacks.onPostToFarcaster(content, 'solana');
        }
        logger.info(`[supervisor] High-priority intel posted: ${source}`);
      }
      // Low-priority intel is stored in messages table — used for future content generation
    });

    // ── Guardian Alerts ──
    this.handlers.set('nova-guardian:alert', async (msg) => {
      const { tokenAddress, tokenName, score, alerts } = msg.payload;
      const warning = this.formatSafetyWarning(tokenName || tokenAddress, score, alerts || []);

      if (msg.priority === 'critical') {
        // CRITICAL: Post warning to X + TG + Farcaster immediately
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(warning);
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(warning);
        if (this.callbacks.onPostToFarcaster) await this.callbacks.onPostToFarcaster(warning, 'defi');
        logger.warn(`[supervisor] CRITICAL safety alert posted for ${tokenName || tokenAddress}`);
      } else if (msg.priority === 'high') {
        // HIGH: Post to TG channel only
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(warning);
        logger.info(`[supervisor] High safety alert posted for ${tokenName || tokenAddress}`);
      }
      // Medium/low alerts are logged but not posted (available in DB for reference)
    });

    // ── Guardian Scan Reports ──
    this.handlers.set('nova-guardian:report', async (msg) => {
      const { requestedBy, report } = msg.payload;
      if (this.callbacks.onPostToTelegram && requestedBy) {
        const formatted = this.formatScanReport(report || {});
        await this.callbacks.onPostToTelegram(requestedBy, formatted);
      }
    });

    // ── Analyst Reports ──
    this.handlers.set('nova-analyst:report', async (msg) => {
      const { source, summary } = msg.payload;
      if (msg.priority === 'high' && summary) {
        if (this.callbacks.onPostToChannel) {
          await this.callbacks.onPostToChannel(`📊 ${summary}`);
        }
      }
    });

    // ── Launcher Status ──
    this.handlers.set('nova-launcher:status', async (msg) => {
      const { event, tokenName, tokenSymbol, mint } = msg.payload;
      if (event === 'graduated' && this.callbacks.onPostToX) {
        await this.callbacks.onPostToX(
          `🎓 ${tokenName || tokenSymbol} just graduated on pump.fun! ${mint ? `CA: ${mint.slice(0, 8)}...` : ''}`
        );
      }
      if (event === 'launched') {
        const launchMsg = `🚀 New launch: ${tokenName || tokenSymbol}${mint ? ` — ${mint.slice(0, 8)}...` : ''}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(launchMsg);
        if (this.callbacks.onPostToFarcaster) {
          await this.callbacks.onPostToFarcaster(launchMsg, 'solana');
          await this.callbacks.onPostToFarcaster(launchMsg, 'defi');
        }
        // Auto-spawn a token child agent to monitor the new launch
        if (mint) {
          try {
            await this.spawnChild({
              tokenAddress: mint,
              tokenName: tokenName || tokenSymbol || 'Unknown',
              tokenSymbol: tokenSymbol || '???',
              chatId: msg.payload.chatId,
            });
          } catch (err: any) {
            logger.warn(`[supervisor] Failed to spawn child for ${mint}: ${err.message}`);
          }
        }
      }
    });

    // ── Community Reports ──
    this.handlers.set('nova-community:report', async (msg) => {
      const { summary, engagementSpike } = msg.payload;
      if (engagementSpike && msg.priority === 'high') {
        logger.info(`[supervisor] Community engagement spike: ${summary}`);
        // Could adjust reply frequency or trigger a community post
      }
    });

    // ── Wildcard: any agent status update ──
    this.handlers.set('*:status', async (msg) => {
      logger.debug(`[supervisor] Agent ${msg.from_agent} status: ${JSON.stringify(msg.payload)}`);
    });

    // ── Health Agent Commands ──
    this.handlers.set('health-agent:command', async (msg) => {
      const { action, agentName, reason } = msg.payload;

      if (action === 'deactivate_child') {
        // Health Agent detected a dead token-child — deactivate it
        const addr = this.findChildAddressByName(agentName);
        if (addr) {
          const deactivated = await this.deactivateChild(addr);
          if (deactivated) {
            logger.info(`[supervisor] Health Agent requested deactivation of ${agentName}: ${reason}`);
          }
        } else {
          logger.debug(`[supervisor] Health Agent requested deactivation of ${agentName} but child not found (may already be stopped)`);
        }
      }
    });
  }

  /** Resolve a child's token address from its agent name (child-SYMBOL) */
  private findChildAddressByName(agentName: string): string | undefined {
    for (const [addr, child] of this.children) {
      if (child.getAgentId() === agentName) return addr;
    }
    return undefined;
  }

  // ── Token Child Agent Management ───────────────────────────────

  /** Spawn a child agent for a newly launched token */
  async spawnChild(config: Omit<TokenChildConfig, 'launchedAt' | 'autoDeactivateAfterHours'> & { autoDeactivateAfterHours?: number }): Promise<TokenChildAgent> {
    const fullConfig: TokenChildConfig = {
      ...config,
      launchedAt: new Date(),
      autoDeactivateAfterHours: config.autoDeactivateAfterHours ?? 24,
    };

    const child = new TokenChildAgent(this.pool, fullConfig);
    await child.start();
    this.children.set(config.tokenAddress, child);

    logger.info(`[supervisor] Spawned child agent for $${config.tokenSymbol} (${this.children.size} active children)`);
    return child;
  }

  /** Deactivate a specific child agent */
  async deactivateChild(tokenAddress: string): Promise<boolean> {
    const child = this.children.get(tokenAddress);
    if (!child) return false;
    await child.stop();
    this.children.delete(tokenAddress);
    logger.info(`[supervisor] Deactivated child for ${tokenAddress.slice(0, 8)}... (${this.children.size} remaining)`);
    return true;
  }

  /** Get all active child agents */
  getActiveChildren(): Map<string, TokenChildAgent> {
    return new Map(this.children);
  }

  // ── Request Dispatch ─────────────────────────────────────────────

  /** Request Guardian to scan a specific token */
  async requestScan(tokenAddress: string, requestedBy: string): Promise<void> {
    await this.sendMessage('nova-guardian', 'request', 'medium', {
      action: 'scan_token',
      tokenAddress,
      requestedBy,
    });
  }

  /** Request Scout to do an immediate KOL scan */
  async requestIntelScan(): Promise<void> {
    await this.sendMessage('nova-scout', 'command', 'medium', {
      action: 'immediate_scan',
    });
  }

  /** Request Launcher to start a token launch */
  async requestLaunch(config: Record<string, any>): Promise<void> {
    await this.sendMessage('nova-launcher', 'command', 'high', {
      action: 'launch_token',
      ...config,
    });
  }

  // ── Agent Status ─────────────────────────────────────────────────

  getAgentStatuses(): Map<string, { status: string; lastSeen: Date; lastMessage?: string }> {
    return new Map(this.agentStatuses);
  }

  private async checkAgentStatuses(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT agent_name, status, last_beat, current_task
         FROM agent_heartbeats
         WHERE agent_name != 'health-agent'
         ORDER BY agent_name`,
      );
      for (const row of result.rows) {
        this.agentStatuses.set(row.agent_name, {
          status: row.status,
          lastSeen: row.last_beat,
          lastMessage: row.current_task,
        });
      }
    } catch {
      // Silent — health agent handles deeper monitoring
    }
  }

  // ── Formatting Helpers ───────────────────────────────────────────

  private formatSafetyWarning(tokenName: string, score: number, alerts: string[]): string {
    const alertLines = alerts.map(a => `⚠️ ${a}`).join('\n');
    return `🚨 Safety Alert: ${tokenName}\nRugCheck Score: ${score}/100\n${alertLines}`;
  }

  private formatScanReport(report: Record<string, any>): string {
    return `🛡️ RugCheck Report: ${report.tokenName || 'Unknown'}\nScore: ${report.score || '?'}/100\n${report.summary || 'Scan complete.'}`;
  }
}
