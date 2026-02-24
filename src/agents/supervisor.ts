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
import { ContentFilter, type ContentScanResult } from './security/contentFilter.ts';

// ============================================================================
// Types
// ============================================================================

type MessageHandler = (msg: AgentMessage) => Promise<void>;

export interface SupervisorCallbacks {
  onPostToX?: (content: string) => Promise<void>;
  onPostToTelegram?: (chatId: string, content: string) => Promise<void>;
  onLaunchToken?: (config: any) => Promise<void>;
  onPostToChannel?: (content: string) => Promise<void>;
  onPostToAdmin?: (content: string) => Promise<void>;
  onPostToFarcaster?: (content: string, channel: string) => Promise<void>;
}

// ============================================================================
// Supervisor
// ============================================================================

export class Supervisor extends BaseAgent {
  private handlers: Map<string, MessageHandler> = new Map();
  private pollIntervalMs: number;
  public callbacks: SupervisorCallbacks = {};
  private lastNarrativePostAt = 0;
  private static NARRATIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours between narrative posts

  // ── Outbound Content Filter ──────────────────────────────────
  private outboundFilter: ContentFilter | null = null;

  // ── X Post Dedup ─────────────────────────────────────────────
  // Track recently posted content to avoid duplicate X tweets
  private recentXPostHashes: Set<string> = new Set();
  private static MAX_X_POST_HISTORY = 20;

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
    // Restore persisted state from DB (survive restarts)
    await this.restorePersistedState();

    // Initialize outbound content filter (no-op reporter — just scan, don't report)
    try {
      this.outboundFilter = new ContentFilter(this.pool, async () => {});
    } catch {
      logger.warn('[supervisor] Could not initialize outbound content filter');
    }

    this.startHeartbeat(60_000);
    this.addInterval(() => this.pollMessages(), this.pollIntervalMs);
    // Also periodically check agent health (separate from Health Agent's deeper checks)
    this.checkAgentStatuses(); // immediate first check
    this.addInterval(() => this.checkAgentStatuses(), 5 * 60 * 1000); // every 5 min
    // Periodic swarm briefing — digest of all agent activity
    this.addInterval(() => this.publishBriefing(), this.briefingIntervalMs);
    // Periodic DB cleanup — prune stale kv_store entries and old agent_messages
    this.addInterval(() => this.cleanupStaleData(), 6 * 60 * 60 * 1000); // every 6 hours
    logger.info(`[supervisor] Polling every ${this.pollIntervalMs}ms, briefing every ${this.briefingIntervalMs / 3600000}h`);
  }

  /**
   * Scan outbound content before publishing to X/TG/Channel.
   * Returns the original text if clean, or null if threats detected (blocked).
   */
  private scanOutboundSafe(text: string, destination: string): string | null {
    if (!this.outboundFilter) return text; // no filter = pass through
    try {
      const result: ContentScanResult = this.outboundFilter.scanOutbound(text, destination);
      if (!result.clean) {
        const critical = result.threats.filter(t => t.severity === 'critical');
        if (critical.length > 0) {
          logger.error(`[supervisor] BLOCKED outbound ${destination}: ${critical.map(t => t.description).join('; ')}`);
          return null; // block critical threats (leaked secrets, etc.)
        }
        // Non-critical threats: log warning but allow
        logger.warn(`[supervisor] Outbound ${destination} has warnings: ${result.threats.map(t => t.description).join('; ')}`);
      }
      return text;
    } catch {
      return text; // on error, don't block
    }
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
      // Persist counters after processing a batch (survive restarts)
      if (messages.length > 0) await this.persistState();
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
      const { intel_type, source, narratives, summary } = msg.payload;
      const intelSource = intel_type ?? source; // intel_type is the canonical field; source is legacy/agent-id

      if (intelSource === 'narrative_shift' && msg.priority === 'high') {
        // Rate-limit narrative posts — max once per 2 hours
        const now = Date.now();
        if (now - this.lastNarrativePostAt < Supervisor.NARRATIVE_COOLDOWN_MS) {
          logger.debug(`[supervisor] Skipping narrative post (cooldown: ${Math.round((Supervisor.NARRATIVE_COOLDOWN_MS - (now - this.lastNarrativePostAt)) / 60_000)}m remaining)`);
        } else {
          // Use synthesised fields if available, fall back to legacy summary
          const xContent = msg.payload.xSummary || summary || narratives?.summary || 'Check thread for details';
          const channelContent = msg.payload.channelSummary || summary || narratives?.summary || 'Check thread for details';

          const xPrefix = '📡 Narrative shift detected: ';
          const fullChannelContent = `${xPrefix}${channelContent}`;

          // Truncated content for X (280 char limit)
          const maxBody = 280 - xPrefix.length;
          let xPost: string;
          if (xContent.length > maxBody) {
            const cutoff = maxBody - 3;
            const lastSpace = xContent.lastIndexOf(' ', cutoff);
            const breakAt = lastSpace > cutoff * 0.5 ? lastSpace : cutoff;
            xPost = `${xPrefix}${xContent.slice(0, breakAt)}...`;
          } else {
            xPost = `${xPrefix}${xContent}`;
          }

          // Content dedup — hash on topic keywords, not synthesised text
          // (GPT produces different wording for the same event → text hash misses duplicates)
          const rawTopic = (msg.payload.xSummary || msg.payload.channelSummary || fullChannelContent)
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, '')
            .trim()
            // Keep only first 8 significant words as the "topic fingerprint"
            .split(/\s+/)
            .filter((w: string) => w.length >= 4)
            .slice(0, 8)
            .join(' ');
          const contentHash = rawTopic || fullChannelContent.toLowerCase().replace(/[^a-z ]/g, '').trim().slice(0, 80);
          if (this.recentXPostHashes.has(contentHash)) {
            logger.debug(`[supervisor] Skipping duplicate narrative post (same content already posted)`);
          } else {
            // Scan outbound content before publishing
            const safeXContent = this.scanOutboundSafe(xPost, 'x-post');
            const safeFullContent = this.scanOutboundSafe(fullChannelContent, 'tg-channel');
            if (safeXContent && this.callbacks.onPostToX) await this.callbacks.onPostToX(safeXContent);
            if (safeFullContent && this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(safeFullContent);
            if (safeFullContent && this.callbacks.onPostToFarcaster) {
              await this.callbacks.onPostToFarcaster(safeFullContent, 'ai-agents');
              await this.callbacks.onPostToFarcaster(safeFullContent, 'solana');
            }
            this.recentXPostHashes.add(contentHash);
            // Keep set bounded
            if (this.recentXPostHashes.size > Supervisor.MAX_X_POST_HISTORY) {
              const first = this.recentXPostHashes.values().next().value;
              if (first) this.recentXPostHashes.delete(first);
            }
            this.lastNarrativePostAt = now;
            logger.info(`[supervisor] High-priority intel posted: ${intelSource}`);
            // Persist immediately so cooldown survives restart
            await this.persistState().catch(err =>
              logger.debug('[supervisor] Persist after narrative post failed (non-fatal):', err)
            );
          }
        }
      }
      // Low-priority intel is stored in messages table — used for future content generation

      // ── Intel Digest (batched summary from scout — every 2h) ──
      if (intelSource === 'intel_digest') {
        const { channelPost, agentIntel, periodHours, totalIntelItems, crossConfirmedCount, scansInPeriod } = msg.payload;
        const displayContent = channelPost || msg.payload.summary || 'No notable signals';
        logger.info(
          `[supervisor] 📋 Scout digest: ${totalIntelItems} items from ${scansInPeriod} scans ` +
          `(${crossConfirmedCount} cross-confirmed) | ${periodHours}h window`
        );
        // Don't post digests to community/X — they're operational intel for CFO + admin only
        if (this.callbacks.onPostToAdmin && totalIntelItems > 0) {
          const digestMsg = `📋 <b>Scout Digest</b> (${periodHours}h)\n\n${displayContent}`;
          await this.callbacks.onPostToAdmin(digestMsg);
        }

        // Forward structured agent intel to CFO separately (not the channel post)
        if (agentIntel) {
          try {
            await this.sendMessage('nova-cfo', 'intel', 'low', {
              command: 'scout_intel',
              intel_type: 'structured_digest',
              forwardedBy: 'supervisor',
              originalFrom: 'nova-scout',
              ...agentIntel,
            });
          } catch (err) {
            logger.debug(`[supervisor] Failed to forward structured intel to CFO:`, err);
          }
        }
      }

      // Forward all scout intel to CFO for trading decisions
      try {
        await this.sendMessage('nova-cfo', 'intel', msg.priority, {
          ...msg.payload,
          command: 'scout_intel',
          forwardedBy: 'supervisor',
          originalFrom: 'nova-scout',
        });
      } catch (err) {
        logger.debug(`[supervisor] Failed to forward intel to CFO (non-fatal):`, err);
      }
    });

    // ── Guardian Alerts ──
    this.handlers.set('nova-guardian:alert', async (msg) => {
      const { tokenAddress, tokenName, score, alerts, securityEvent, category, severity, title, details } = msg.payload;

      // Security events from Guardian's security modules → route to admin
      if (securityEvent) {
        const secMsg = `🛡️ SECURITY ${(severity || 'ALERT').toUpperCase()}\n\n${title || 'Security Event'}\n${details?.message || JSON.stringify(details || {}).slice(0, 200)}`;
        if (severity === 'emergency' || msg.priority === 'critical') {
          if (this.callbacks.onPostToAdmin) await this.callbacks.onPostToAdmin(secMsg);
          logger.warn(`[supervisor] 🛡️ Security ${severity}: ${title}`);
        } else {
          logger.info(`[supervisor] 🛡️ Security ${severity}: ${title}`);
        }
        return;
      }

      const warning = this.formatSafetyWarning(tokenName || tokenAddress, score, alerts || [], payload.type);

      if (msg.priority === 'critical') {
        // CRITICAL: Post warning to X + TG + Farcaster immediately
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(warning);
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(warning);
        if (this.callbacks.onPostToFarcaster) await this.callbacks.onPostToFarcaster(warning, 'defi');
        logger.warn(`[supervisor] CRITICAL safety alert posted for ${tokenName || tokenAddress}`);

        // Forward critical alerts to CFO for emergency exit evaluation
        await this.sendMessage('nova-cfo', 'alert', 'critical', {
          command: 'market_crash',
          source: 'guardian',
          tokenAddress,
          tokenName,
          score,
          alerts,
          message: `Guardian CRITICAL: ${tokenName || tokenAddress} — ${(alerts || []).join(', ')}`,
        });
      } else if (msg.priority === 'high') {
        // HIGH: Post to TG channel only
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(warning);
        logger.info(`[supervisor] High safety alert posted for ${tokenName || tokenAddress}`);

        // Forward LP drain / price crash events to CFO as market_crash
        // so CFO can pause trading or close positions defensively
        const alertTypes = (alerts || []).map((a: string) => a.toLowerCase());
        const hasLpDrain = alertTypes.some((a: string) => a.includes('lp') || a.includes('liquidity') || a.includes('drain'));
        const hasCrash = alertTypes.some((a: string) => a.includes('crash') || a.includes('dump') || a.includes('plunge'));
        if (hasLpDrain || hasCrash) {
          await this.sendMessage('nova-cfo', 'alert', 'high', {
            command: 'market_crash',
            source: 'guardian',
            tokenAddress,
            tokenName,
            score,
            alerts,
            message: `Guardian HIGH (LP drain/crash): ${tokenName || tokenAddress} — ${(alerts || []).join(', ')}`,
          });
          logger.warn(`[supervisor] Forwarded guardian HIGH alert to CFO as market_crash: ${tokenName || tokenAddress}`);
        }
      }
      // Medium/low alerts are logged but not posted (available in DB for reference)
    });

    // ── Guardian Scan Reports ──
    this.handlers.set('nova-guardian:report', async (msg) => {
      const { requestedBy, report } = msg.payload;
      if (this.callbacks.onPostToTelegram && requestedBy) {
        const formatted = this.formatScanReport(report || {});
        const safe = this.scanOutboundSafe(formatted, 'tg-direct');
        if (safe) await this.callbacks.onPostToTelegram(requestedBy, safe);
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

        // Forward DeFi metrics to CFO for yield/allocation decisions
        await this.sendMessage('nova-cfo', 'intel', 'low', {
          command: 'defi_snapshot',
          solanaTvl, chainTvl, dexVolume24h, chainVolume,
          topProtocols, topDexes, tokenPrices,
        });
      }
      if (source === 'volume_spike') {
        // Volume spike — high priority intel, post to channel + X
        const content = `🚀 ${msg.payload.summary}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(content);

        // Forward to CFO — volume spikes can signal hedging/allocation changes
        await this.sendMessage('nova-cfo', 'intel', 'medium', {
          command: 'narrative_update',
          source: 'volume_spike',
          summary: msg.payload.summary,
        });
      }
      if (source === 'price_alert') {
        // Significant price move — post to channel + X
        const content = `📊 <b>Price Alert</b>\n${msg.payload.summary}`;
        if (this.callbacks.onPostToChannel) await this.callbacks.onPostToChannel(content);
        if (this.callbacks.onPostToX) await this.callbacks.onPostToX(msg.payload.summary);
        logger.info(`[supervisor] Price alert posted: ${msg.payload.summary}`);

        // Forward to CFO — price moves impact SOL treasury/hedge decisions
        await this.sendMessage('nova-cfo', 'intel', 'medium', {
          command: 'narrative_update',
          source: 'price_alert',
          summary: msg.payload.summary,
        });
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

    // ── CFO Reports ──
    this.handlers.set('nova-cfo:report', async (msg) => {
      const { source, summary } = msg.payload;
      if (source === 'daily_digest' && summary) {
        // CFO daily digest — could post to channel or just log
        logger.info(`[supervisor] CFO daily digest received: ${typeof summary === 'string' ? summary.slice(0, 200) : 'object'}`);
      } else if (source === 'emergency_exit') {
        // CFO triggered emergency exit — notify admin only (not community)
        const content = `🚨 CFO Emergency: ${msg.payload.message || 'Positions being closed'}`;
        if (this.callbacks.onPostToAdmin) await this.callbacks.onPostToAdmin(content);
        logger.warn(`[supervisor] CFO emergency exit: ${content}`);
      } else {
        logger.debug(`[supervisor] CFO report: ${source || 'unknown'}`);
      }
    });

    // ── CFO Alerts (admin-only — never post financial alerts to community) ──
    this.handlers.set('nova-cfo:alert', async (msg) => {
      const { source, message } = msg.payload;
      if (msg.priority === 'critical') {
        const content = `🏦 CFO Alert: ${message || JSON.stringify(msg.payload).slice(0, 200)}`;
        if (this.callbacks.onPostToAdmin) await this.callbacks.onPostToAdmin(content);
        logger.warn(`[supervisor] CFO critical alert: ${content}`);
      }
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
        // Forward severe crashes (>60% drop) to CFO for emergency evaluation
        if (changePercent && Math.abs(Number(changePercent)) >= 60) {
          await this.sendMessage('nova-cfo', 'alert', 'high', {
            command: 'market_crash',
            source: 'token_child',
            tokenAddress,
            tokenSymbol,
            changePercent,
            message: `Token crash: $${tokenSymbol} dropped ${changePercent}%`,
          });
        }
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

    // ── Health Monitor Commands ── (accepts from both 'health-monitor' and legacy 'health-agent')
    const healthCommandHandler = async (msg: any) => {
      const { action, agentName, reason } = msg.payload;

      if (action === 'deactivate_child') {
        const addr = this.findChildAddressByName(agentName);
        if (addr) {
          const deactivated = await this.deactivateChild(addr);
          if (deactivated) {
            logger.info(`[supervisor] Health monitor requested deactivation of ${agentName}: ${reason}`);
          }
        } else {
          logger.debug(`[supervisor] Health monitor requested deactivation of ${agentName} but child not found (may already be stopped)`);
        }
      }
    };
    this.handlers.set('health-monitor:command', healthCommandHandler);
    this.handlers.set('health-agent:command', healthCommandHandler); // legacy compat
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
         WHERE agent_name NOT IN ('health-agent', 'health-monitor', 'nova-main')
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

  // ── DB Cleanup (TTL for kv_store, agent_messages, etc.) ──────────

  private async cleanupStaleData(): Promise<void> {
    try {
      // 1. Clean old cfo_decision_* entries from kv_store (>30 days)
      const kvResult = await this.pool.query(
        `DELETE FROM kv_store WHERE key LIKE 'cfo_decision_%' AND updated_at < NOW() - INTERVAL '30 days'`
      );
      const kvDeleted = (kvResult as any).rowCount || 0;

      // 2. Clean old processed agent_messages (>7 days, already acknowledged)
      const msgResult = await this.pool.query(
        `DELETE FROM agent_messages WHERE processed_at IS NOT NULL AND created_at < NOW() - INTERVAL '7 days'`
      );
      const msgDeleted = (msgResult as any).rowCount || 0;

      // 3. Clean old agent heartbeat history (keep last 24h only in logs)
      const hbResult = await this.pool.query(
        `DELETE FROM agent_heartbeats WHERE last_beat < NOW() - INTERVAL '7 days' AND status = 'stopped'`
      );
      const hbDeleted = (hbResult as any).rowCount || 0;

      // 4. Clean expired agent_messages
      const expResult = await this.pool.query(
        `DELETE FROM agent_messages WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );
      const expDeleted = (expResult as any).rowCount || 0;

      if (kvDeleted + msgDeleted + hbDeleted + expDeleted > 0) {
        logger.info(`[supervisor] DB cleanup: kv=${kvDeleted}, messages=${msgDeleted}, heartbeats=${hbDeleted}, expired=${expDeleted}`);
      }
    } catch {
      // Tables may not exist yet — silent
    }
  }

  // ── Formatting Helpers ───────────────────────────────────────────

  private formatSafetyWarning(tokenName: string, score: number | null | undefined, alerts: string[], alertType?: string): string {
    const typePrefix = alertType === 'lp_drain' ? '💧 LP Alert'
      : alertType === 'price_crash' ? '📉 Price Alert'
      : alertType === 'volume_spike' ? '📊 Volume Alert'
      : '🚨 Safety Alert';
    const scoreLine = score != null ? `\nRugCheck Score: ${score}` : '';
    const alertLines = alerts.map(a => `⚠️ ${a}`).join('\n');
    return `${typePrefix}: ${tokenName}${scoreLine}\n${alertLines}`;
  }

  private formatScanReport(report: Record<string, any>): string {
    return `🛡️ RugCheck Report: ${report.tokenName || 'Unknown'}\nScore: ${report.score || '?'}\n${report.summary || 'Scan complete.'}`;
  }

  // ── Swarm Briefing ───────────────────────────────────────────────

  /** Publish periodic digest — admin gets detailed ops, community gets friendly summary */
  private async publishBriefing(): Promise<void> {
    try {
      const now = Date.now();
      const periodHours = this.lastBriefingAt
        ? Math.round((now - this.lastBriefingAt) / 3600000)
        : 4;
      this.lastBriefingAt = now;

      // ── Gather data ──
      await this.checkAgentStatuses();
      const activeAgents = Array.from(this.agentStatuses.entries())
        .filter(([, v]) => v.status === 'active' || v.status === 'alive')
        .map(([name]) => name.replace('nova-', ''));

      const recentIntel = this.intelBuffer.filter(
        i => i.at.getTime() > now - (periodHours * 3600000 + 60000),
      );

      const byAgent: Record<string, number> = {};
      const highlightSet = new Set<string>();          // deduplicate
      const criticalItems: string[] = [];
      const highItems: string[] = [];
      const lowItems: string[] = [];

      for (const item of recentIntel) {
        const agent = item.from.replace('nova-', '');
        byAgent[agent] = (byAgent[agent] || 0) + 1;

        // Deduplicate: normalise text, skip if already seen
        const normSummary = item.summary.trim().slice(0, 100);
        if (highlightSet.has(normSummary)) continue;
        highlightSet.add(normSummary);

        if (item.priority === 'critical') criticalItems.push(`🔴 ${normSummary}`);
        else if (item.priority === 'high') highItems.push(`🟡 ${normSummary}`);
        else lowItems.push(normSummary);
      }

      const agentActivity = Object.entries(byAgent)
        .map(([name, count]) => `${name}: ${count} msgs`)
        .join(', ') || 'No messages';

      // ── Pull live data from Nova data pools ──
      let trendLine = '';
      let pnlLine = '';
      let metricsLine = '';
      let trendCount = 0;
      let topTrendNames = '';
      try {
        const { getPoolStats } = await import('../launchkit/services/trendPool.ts');
        const stats = getPoolStats();
        trendCount = stats.available;
        topTrendNames = stats.topTrends.slice(0, 3).map(t => t.topic.slice(0, 25)).join(', ');
        trendLine = `🔥 Trends: ${stats.available} available${topTrendNames ? ` (${topTrendNames})` : ''}`;
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

      // ================================================================
      // 1. ADMIN BRIEFING — detailed ops + routed intel
      // ================================================================
      const adminLines: string[] = [
        `🐝 <b>Nova Admin Briefing</b> (${periodHours}h)`,
        '',
        `<b>Swarm Status</b>`,
        `⏱ Online: ${activeAgents.length > 0 ? activeAgents.join(', ') : 'checking...'}`,
        `📨 Messages: ${this.messagesProcessed}`,
        `📊 Activity: ${agentActivity}`,
        `👶 Child agents: ${this.children.size}`,
      ];

      if (trendLine) adminLines.push(trendLine);
      if (pnlLine) adminLines.push(pnlLine);
      if (metricsLine) adminLines.push(metricsLine);

      // Agent-level breakdown
      adminLines.push('', '<b>Agent Details</b>');
      for (const [name, info] of this.agentStatuses) {
        const shortName = name.replace('nova-', '');
        const ago = Math.round((now - info.lastSeen.getTime()) / 60000);
        const status = ago < 5 ? '🟢' : ago < 15 ? '🟡' : '🔴';
        adminLines.push(`${status} ${shortName}: ${info.status} (${ago}m ago)${info.lastMessage ? ` — ${info.lastMessage}` : ''}`);
      }

      // Key Intel — deduplicated, grouped by severity
      if (criticalItems.length > 0 || highItems.length > 0) {
        adminLines.push('', '<b>Key Intel</b>');
        if (criticalItems.length > 0) adminLines.push(...criticalItems.slice(0, 5));
        if (highItems.length > 0) adminLines.push(...highItems.slice(0, 5));
      }

      // Low-priority summary (just count, don't list)
      if (lowItems.length > 0) {
        adminLines.push(`ℹ️ ${lowItems.length} routine updates processed`);
      }

      const adminBriefing = adminLines.join('\n');

      // Send admin briefing via adminNotify (goes to ADMIN_CHAT_ID directly)
      if (this.callbacks.onPostToAdmin) {
        await this.callbacks.onPostToAdmin(adminBriefing);
      }

      // ================================================================
      // 2. COMMUNITY BRIEFING — friendly, vibe-check style
      // ================================================================
      const greetings = ['🐝 Bzz! Nova hive check-in', '🐝 Hive update!', '🐝 The swarm is busy', '🐝 Nova checking in'];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const communityLines: string[] = [
        `${greeting} 🍯`,
        '',
      ];

      // Agent count in friendly language
      const agentCount = activeAgents.length;
      if (agentCount >= 6) communityLines.push(`✅ All ${agentCount} agents are online and working`);
      else if (agentCount >= 4) communityLines.push(`✅ ${agentCount} agents active`);
      else communityLines.push(`⚠️ Only ${agentCount} agents online — some may be resting`);

      // Trends in casual language
      if (trendCount > 0) {
        communityLines.push(`👀 Watching ${trendCount} trends${topTrendNames ? ` — hot: ${topTrendNames}` : ''}`);
      }

      // Performance blurb
      if (pnlLine) communityLines.push(pnlLine);

      // Activity numbers in friendly format
      if (metricsLine) communityLines.push(metricsLine);

      // Highlight only the most interesting intel for community (1-2 items max)
      const communityHighlights = [...criticalItems, ...highItems].slice(0, 2);
      if (communityHighlights.length > 0) {
        communityLines.push('', '📡 <b>What we noticed:</b>');
        communityLines.push(...communityHighlights);
      }

      communityLines.push('', '🔗 Stay tuned for more updates from the swarm!');

      const communityBriefing = communityLines.join('\n');

      // Post community briefing to channel
      if (this.callbacks.onPostToChannel) {
        await this.callbacks.onPostToChannel(communityBriefing);
      }

      // Log
      logger.info(`[supervisor] 🐝 Briefings sent: admin (${criticalItems.length + highItems.length} intel) + community | ${activeAgents.length} agents, ${this.messagesProcessed} msgs`);

      // Reset
      this.messagesProcessed = 0;
    } catch (err) {
      logger.warn('[supervisor] Briefing failed:', err);
    }
  }

  // ── State Persistence (survive restarts) ─────────────────────────

  async persistState(): Promise<void> {
    await this.saveState({
      messagesProcessed: this.messagesProcessed,
      lastBriefingAt: this.lastBriefingAt,
      lastNarrativePostAt: this.lastNarrativePostAt,
      recentXPostHashes: [...this.recentXPostHashes],
    });
  }

  private async restorePersistedState(): Promise<void> {
    const s = await this.restoreState<{
      messagesProcessed?: number;
      lastBriefingAt?: number;
      lastNarrativePostAt?: number;
      recentXPostHashes?: string[];
    }>();
    if (!s) return;
    if (s.messagesProcessed)    this.messagesProcessed = s.messagesProcessed;
    if (s.lastBriefingAt)       this.lastBriefingAt = s.lastBriefingAt;
    if (s.lastNarrativePostAt)  this.lastNarrativePostAt = s.lastNarrativePostAt;
    if (s.recentXPostHashes)    this.recentXPostHashes = new Set(s.recentXPostHashes);
    logger.info(
      `[supervisor] Restored: ${this.messagesProcessed} msgs processed | ` +
      `lastNarrative=${this.lastNarrativePostAt ? new Date(this.lastNarrativePostAt).toISOString() : 'never'} | ` +
      `postHashes=${this.recentXPostHashes.size}`
    );
  }

  // ── Public API ───────────────────────────────────────────────────

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      messagesProcessed: this.messagesProcessed,
      lastBriefingAt: this.lastBriefingAt,
      intelBufferSize: this.intelBuffer.length,
      activeChildren: this.children.size,
    };
  }
}
