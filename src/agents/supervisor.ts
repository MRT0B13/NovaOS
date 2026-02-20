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

  // ── Intel Accumulator (for periodic briefings) ────────────
  private intelBuffer: Array<{ from: string; source: string; summary: string; priority: string; at: Date }> = [];
  private briefingIntervalMs = 4 * 60 * 60 * 1000; // 4 hours
  private lastBriefingAt = 0;
  private messagesProcessed = 0;

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
    // Periodic swarm briefing — digest of all agent activity
    this.addInterval(() => this.publishBriefing(), this.briefingIntervalMs);
    logger.info(`[supervisor] Polling every ${this.pollIntervalMs}ms, briefing every ${this.briefingIntervalMs / 3600000}h`);
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
    this.messagesProcessed++;

    // Update agent status tracking
    this.agentStatuses.set(msg.from_agent, {
      status: 'active',
      lastSeen: new Date(),
      lastMessage: msg.message_type,
    });

    // Accumulate intel for periodic briefing
    const summary = msg.payload?.summary || msg.payload?.source || msg.message_type;
    this.intelBuffer.push({
      from: msg.from_agent,
      source: msg.payload?.source || msg.message_type,
      summary: typeof summary === 'string' ? summary.slice(0, 120) : String(summary),
      priority: msg.priority,
      at: new Date(),
    });
    // Keep buffer bounded
    if (this.intelBuffer.length > 200) this.intelBuffer = this.intelBuffer.slice(-100);

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
      const { source, summary, anomalies } = msg.payload;
      if (msg.priority === 'high' && summary) {
        // Anomaly detected — post to channel immediately
        if (this.callbacks.onPostToChannel) {
          await this.callbacks.onPostToChannel(`📊 Market Alert: ${summary}`);
        }
      }
    });

    // ── Analyst DeFi Snapshots (low/medium priority) ──
    this.handlers.set('nova-analyst:intel', async (msg) => {
      const { source, solanaTvl, chainTvl, dexVolume24h, chainVolume, topProtocols, topDexes, tokenPrices } = msg.payload;
      if (source === 'defi_snapshot' && (solanaTvl || chainTvl)) {
        // Post a concise multi-chain DeFi update to the channel
        const formatUSD = (v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : `$${(v/1e3).toFixed(0)}K`;

        // Chain TVL line
        const tvlParts: string[] = [];
        if (chainTvl) {
          for (const [chain, tvl] of Object.entries(chainTvl as Record<string, number>)) {
            if (tvl > 0) tvlParts.push(`${chain}: ${formatUSD(tvl)}`);
          }
        } else if (solanaTvl) {
          tvlParts.push(`Solana: ${formatUSD(solanaTvl)}`);
        }
        const tvlLine = tvlParts.length > 0 ? `TVL: ${tvlParts.join(' | ')}` : '';

        // Volume line
        const volParts: string[] = [];
        if (chainVolume) {
          for (const [chain, vol] of Object.entries(chainVolume as Record<string, number>)) {
            if (vol > 0) volParts.push(`${chain}: ${formatUSD(vol)}`);
          }
        } else if (dexVolume24h) {
          volParts.push(`Solana: ${formatUSD(dexVolume24h)}`);
        }
        const volLine = volParts.length > 0 ? `\n24h Vol: ${volParts.join(' | ')}` : '';

        // Token prices line
        let pricesLine = '';
        if (tokenPrices && Object.keys(tokenPrices).length > 0) {
          const priceParts = Object.entries(tokenPrices as Record<string, number>)
            .slice(0, 5)
            .map(([sym, p]) => `${sym}=$${p < 1 ? p.toFixed(6) : p.toFixed(2)}`);
          pricesLine = `\n💰 ${priceParts.join(', ')}`;
        }

        const protos = topProtocols?.length > 0 ? `\nTop: ${topProtocols.slice(0, 5).join(', ')}` : '';
        const dexes = topDexes?.length > 0 ? `\nDEXs: ${topDexes.slice(0, 5).join(', ')}` : '';
        const content = `📈 <b>DeFi Pulse</b>\n\n${tvlLine}${volLine}${pricesLine}${protos}${dexes}`;
        if (this.callbacks.onPostToChannel) {
          await this.callbacks.onPostToChannel(content);
        }
        logger.info(`[supervisor] Analyst DeFi snapshot posted: ${tvlParts.join(', ')}`);
      }
      if (source === 'volume_spike') {
        // Volume spike — high priority intel, post to channel + X
        const content = `🚀 ${msg.payload.summary}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(content);
      }
      if (source === 'price_alert') {
        // Significant price move — post to channel + X
        const content = `📊 <b>Price Alert</b>\n${msg.payload.summary}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(msg.payload.summary);
        logger.info(`[supervisor] Price alert posted: ${msg.payload.summary}`);
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
      const { summary, engagementSpike, engagementDrop, pendingVotes, tweetsSentToday, tgPostsSentToday, newBans } = msg.payload;

      if (engagementSpike && msg.priority === 'high') {
        // Engagement surge — notify channel and ramp up activity
        const content = `📈 Community Surge: ${summary}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        logger.info(`[supervisor] Community engagement spike posted: ${summary}`);
      } else if (engagementDrop && msg.priority === 'high') {
        // Engagement drop — log and potentially trigger content
        logger.warn(`[supervisor] Community engagement drop: ${summary}`);
      }

      // Log ban activity for awareness
      if (newBans && newBans > 3) {
        const banMsg = `🛡️ Moderation: ${newBans} bans in last 30min`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(banMsg);
      }
    });

    // ── Launcher Reports (pipeline status, PnL) ──
    this.handlers.set('nova-launcher:report', async (msg) => {
      const { source, enabled, dryRun, totalLaunches, launchesToday, pnl, lastError } = msg.payload;
      logger.info(`[supervisor] Launcher report: enabled=${enabled}, dryRun=${dryRun}, launches=${totalLaunches}, today=${launchesToday}${pnl ? `, PnL=${pnl.totalPnl?.toFixed(4)} SOL` : ''}${lastError ? `, lastErr=${lastError}` : ''}`);
    });

    // ── Wildcard: any agent status update ──
    this.handlers.set('*:status', async (msg) => {
      // Token child deactivation — log it
      if (msg.from_agent.startsWith('child-') && (msg.payload?.event === 'deactivated' || msg.payload?.event === 'auto_deactivated')) {
        logger.info(`[supervisor] Token child ${msg.payload.tokenSymbol || msg.from_agent} deactivated: ${msg.payload.reason || 'unknown'}`);
      } else {
        logger.debug(`[supervisor] Agent ${msg.from_agent} status: ${JSON.stringify(msg.payload)}`);
      }
    });

    // ── Wildcard: any agent alert (catches token child alerts) ──
    this.handlers.set('*:alert', async (msg) => {
      // Primarily handles token child alerts (price spikes, crashes, mcap milestones)
      // Specific agent alerts (guardian, etc.) have their own handlers and won't hit this
      const { event, tokenSymbol, tokenAddress, changePercent, milestone, currentMcap } = msg.payload;

      if (event === 'price_spike') {
        const content = `🚀 $${tokenSymbol} surged +${changePercent}%!${tokenAddress ? ` CA: ${tokenAddress.slice(0, 8)}...` : ''}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(content);
        logger.info(`[supervisor] Token child price spike: ${content}`);
      } else if (event === 'price_crash') {
        const content = `⚠️ $${tokenSymbol} dropped ${changePercent}%${tokenAddress ? ` — CA: ${tokenAddress.slice(0, 8)}...` : ''}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        logger.warn(`[supervisor] Token child price crash: ${content}`);
      } else if (event === 'mcap_milestone') {
        const formatMcap = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`;
        const content = `🎯 $${tokenSymbol} hit ${formatMcap(milestone)} market cap!`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(content);
        logger.info(`[supervisor] Token child mcap milestone: ${content}`);
      } else {
        // Generic alert from unknown agent
        logger.info(`[supervisor] Alert from ${msg.from_agent}: ${JSON.stringify(msg.payload).slice(0, 200)}`);
      }
    });

    // ── Wildcard: any agent report (catches token child metrics) ──
    this.handlers.set('*:report', async (msg) => {
      // Token child periodic metrics — just track, don't post
      if (msg.from_agent.startsWith('child-')) {
        const { tokenSymbol, metrics } = msg.payload;
        logger.debug(`[supervisor] Token child ${tokenSymbol}: price=$${metrics?.price || 0}, vol=$${metrics?.volume24h || 0}, mcap=$${metrics?.mcap || 0}`);
      } else {
        logger.debug(`[supervisor] Report from ${msg.from_agent}: ${msg.payload?.source || msg.message_type}`);
      }
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

  // ── Swarm Briefing ───────────────────────────────────────────────

  /** Publish a periodic digest of all swarm activity to the channel */
  private async publishBriefing(): Promise<void> {
    try {
      const now = Date.now();
      const periodHours = this.lastBriefingAt
        ? Math.round((now - this.lastBriefingAt) / 3600000)
        : 4;
      this.lastBriefingAt = now;

      // Gather agent status
      await this.checkAgentStatuses();
      const activeAgents = Array.from(this.agentStatuses.entries())
        .filter(([, v]) => v.status === 'active' || v.status === 'alive')
        .map(([name]) => name.replace('nova-', ''));

      // Summarize recent intel
      const recentIntel = this.intelBuffer.filter(
        i => i.at.getTime() > now - (periodHours * 3600000 + 60000),
      );
      const byAgent: Record<string, number> = {};
      const highlights: string[] = [];
      for (const item of recentIntel) {
        const agent = item.from.replace('nova-', '');
        byAgent[agent] = (byAgent[agent] || 0) + 1;
        if (item.priority === 'high' || item.priority === 'critical') {
          highlights.push(`• ${item.summary}`);
        }
      }

      const agentActivity = Object.entries(byAgent)
        .map(([name, count]) => `${name}: ${count} msgs`)
        .join(', ') || 'No messages';

      // ── Pull live data from Nova data pools ──
      let trendLine = '';
      let pnlLine = '';
      let metricsLine = '';
      try {
        const { getPoolStats } = await import('../launchkit/services/trendPool.ts');
        const stats = getPoolStats();
        const topNames = stats.topTrends.slice(0, 3).map(t => t.topic.slice(0, 25)).join(', ');
        trendLine = `🔥 Trends: ${stats.available} available${topNames ? ` (${topNames})` : ''}`;
      } catch { /* not init */ }
      try {
        const { getPnLSummary } = await import('../launchkit/services/pnlTracker.ts');
        const pnl = await getPnLSummary();
        if (pnl.activePositions > 0 || pnl.totalTrades > 0) {
          pnlLine = `💰 PnL: ${pnl.totalPnl >= 0 ? '+' : ''}${pnl.totalPnl.toFixed(4)} SOL | ${pnl.activePositions} positions | ${(pnl.winRate * 100).toFixed(0)}% win rate`;
        }
      } catch { /* not init */ }
      try {
        const { getMetrics } = await import('../launchkit/services/systemReporter.ts');
        const m = getMetrics();
        metricsLine = `📱 Today: ${m.tweetsSentToday || 0} tweets, ${m.tgPostsSentToday || 0} TG posts, ${m.trendsDetectedToday || 0} trends`;
      } catch { /* not init */ }

      // Build briefing
      const lines: string[] = [
        `🐝 <b>Nova Swarm Briefing</b> (${periodHours}h)`,
        '',
        `⏱ Agents online: ${activeAgents.length > 0 ? activeAgents.join(', ') : 'checking...'}`,
        `📨 Messages processed: ${this.messagesProcessed}`,
        `📊 Activity: ${agentActivity}`,
        `👶 Child agents: ${this.children.size}`,
      ];

      if (trendLine) lines.push(trendLine);
      if (pnlLine) lines.push(pnlLine);
      if (metricsLine) lines.push(metricsLine);

      if (highlights.length > 0) {
        lines.push('', '🔥 <b>Key Intel:</b>');
        lines.push(...highlights.slice(0, 5));
      }

      const briefing = lines.join('\n');

      // Post to channel
      if (this.callbacks.onPostToChannel) {
        await this.callbacks.onPostToChannel(briefing);
      }

      // Always log
      logger.info(`[supervisor] 🐝 Swarm Briefing: ${activeAgents.length} agents, ${this.messagesProcessed} msgs, ${recentIntel.length} intel items, ${highlights.length} highlights`);

      // Clear processed count (keeps rolling)
      this.messagesProcessed = 0;
    } catch (err) {
      logger.warn('[supervisor] Briefing failed:', err);
    }
  }
}
