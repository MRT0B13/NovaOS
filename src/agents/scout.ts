/**
 * Scout Agent
 *
 * Role: Intelligence gathering — web research, narrative detection, trend cross-referencing.
 * Wraps novaResearch.ts functions and feeds intel to the Supervisor via agent_messages.
 *
 * Architecture (batched-digest model + GPT synthesis):
 *   - Scan cycle: every 30 min — runs 7 Tavily searches, cross-refs trend pool
 *   - Digest cycle: every 2 hours — GPT-4o-mini synthesises buffered intel into:
 *       1. channelPost  → clean readable narrative for Telegram community
 *       2. agentIntel   → structured data for CFO/Analyst (sentiment, tickers, signals)
 *   - Full research: every 8 hours — deep research cycle (novaResearch.runResearchCycle)
 *   - Cross-confirmed intel: bypasses digest, synthesised into clean alert → posted immediately
 *
 * Outgoing messages → Supervisor:
 *   - intel (high):   Breaking signal (cross-confirmed, synthesised — immediate)
 *   - intel (medium): Digest with channelPost + agentIntel (batched, every 2h)
 *   - intel (medium): Full research cycle completed
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Run a quick scan NOW (used when Supervisor needs fresh data)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import { getSkillsService } from '../launchkit/services/skillsService.ts';

// Lazy imports — novaResearch has heavy deps; only import when actually used
let _runResearchCycle: (() => Promise<void>) | null = null;
let _quickSearch: ((query: string) => Promise<string | null>) | null = null;
let _getReplyIntel: ((text: string) => Promise<string | null>) | null = null;

// Lazy imports — trend data
let _getPoolStats: (() => { totalInPool: number; available: number; topTrends: Array<{ topic: string; score: number; sources: string[] }> }) | null = null;
let _getActiveTrends: (() => any[]) | null = null;

async function loadResearch() {
  if (!_runResearchCycle) {
    const mod = await import('../launchkit/services/novaResearch.ts');
    _runResearchCycle = mod.runResearchCycle;
    _quickSearch = mod.quickSearch;
    _getReplyIntel = mod.getReplyIntel;
  }
}

async function loadTrendData() {
  if (!_getPoolStats) {
    try {
      const pool = await import('../launchkit/services/trendPool.ts');
      const monitor = await import('../launchkit/services/trendMonitor.ts');
      _getPoolStats = pool.getPoolStats;
      _getActiveTrends = monitor.getActiveTrends;
    } catch { /* TrendPool may not be init yet */ }
  }
}

// ============================================================================
// Scout Agent
// ============================================================================

export class ScoutAgent extends BaseAgent {
  private researchIntervalMs: number;
  private scanIntervalMs: number;
  private digestIntervalMs: number;
  private topicsPerScan: number;
  private lastResearchAt = 0;
  private lastScanAt = 0;
  private lastDigestAt = 0;
  private cycleCount = 0;
  private scanCount = 0;

  // ── Intel Buffer (accumulates between digests) ──────────────────
  private intelBuffer: Array<{
    query: string;
    result: string;
    at: number;
    crossConfirmed: boolean;
    crossSignalTitle?: string;
    crossSignalSources?: string;
  }> = [];
  private trendSnapshots: string[] = [];     // trend pool state at each scan
  private static MAX_BUFFER = 100;           // bound memory

  // ── Dedup ───────────────────────────────────────────────────────
  private seenHashes: Set<string> = new Set();
  private static MAX_SEEN = 200;

  // Titles of narrative_shift signals already sent — persisted across restarts
  // Key: normalised title. Value: timestamp when sent (ms).
  // Prevents re-broadcasting the same topic for 24h even if it stays trending.
  private sentNarrativeTitles: Map<string, number> = new Map();
  private static NARRATIVE_TITLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h per title

  // ── Search Topics (rotated across scans) ────────────────────────
  private static readonly TOPIC_POOL = [
    // Core crypto narratives
    'AI agents crypto latest developments',
    'Solana meme coin trending today',
    'pump.fun latest launches volume activity',
    // Broader market
    'crypto market sentiment shift this week',
    'DeFi protocol TVL changes trending',
    'Solana ecosystem new projects launches',
    // Social & viral
    'crypto twitter viral trending topic today',
    'web3 AI agent news latest',
    // Macro
    'bitcoin ethereum macro catalyst news',
    'crypto regulation news impact',
  ];

  constructor(pool: Pool, opts?: {
    researchIntervalMs?: number;
    scanIntervalMs?: number;
    digestIntervalMs?: number;
  }) {
    super({
      agentId: 'nova-scout',
      agentType: 'scout',
      pool,
    });
    // ── API credit conservation (env-configurable) ──
    // SCOUT_SCAN_INTERVAL_MIN: minutes between scans (default 60, was 30)
    // SCOUT_TOPICS_PER_SCAN:  topics searched per scan (default 4, was 7)
    const scanMinutes = Number(process.env.SCOUT_SCAN_INTERVAL_MIN) || 60;
    const topicsPerScan = Number(process.env.SCOUT_TOPICS_PER_SCAN) || 4;
    this.researchIntervalMs = opts?.researchIntervalMs ?? 8 * 60 * 60 * 1000;  // 8 hours
    this.scanIntervalMs     = opts?.scanIntervalMs     ?? scanMinutes * 60 * 1000;
    this.digestIntervalMs   = opts?.digestIntervalMs   ?? 2 * 60 * 60 * 1000;  // 2 hours
    this.topicsPerScan      = Math.max(1, Math.min(topicsPerScan, ScoutAgent.TOPIC_POOL.length));
  }

  protected async onStart(): Promise<void> {
    // Restore persisted state from DB (survive restarts)
    await this.restorePersistedState();

    this.startHeartbeat(60_000);

    // Full research cycle (deep — 8h)
    this.addInterval(() => this.runFullResearch(), this.researchIntervalMs);

    // Scan cycle (collect raw intel — 30 min)
    this.addInterval(() => this.runScan(), this.scanIntervalMs);

    // Digest cycle (summarise & send — 2h)
    this.addInterval(() => this.sendDigest(), this.digestIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // First scan shortly after boot (15s warm-up)
    setTimeout(() => this.runScan(), 15_000);

    // First research 2 min after start (post-deploy catch-up)
    setTimeout(() => {
      if (this.running && this.cycleCount === 0) {
        logger.info('[scout] Running initial research cycle (post-deploy catch-up)');
        this.runFullResearch();
      }
    }, 2 * 60 * 1000);

    logger.info(
      `[scout] Research every ${this.researchIntervalMs / 3600000}h, ` +
      `scan every ${this.scanIntervalMs / 60000}m, ` +
      `digest every ${this.digestIntervalMs / 60000}m`
    );
  }

  // ── Research Cycle ───────────────────────────────────────────────

  private async runFullResearch(): Promise<void> {
    if (!this.running) return;
    try {
      // Load agent skills (hot-reloadable, 5min cache)
      try {
        const svc = getSkillsService();
        if (svc) {
          this.currentSkillContext = await svc.loadSkillsForAgent('nova-scout');
          if (this.currentSkillContext) logger.debug(`[scout] Loaded skill context (${this.currentSkillContext.length} chars)`);
        }
      } catch (err) { logger.warn('[scout] Skills load error (non-fatal):', err); }

      await this.updateStatus('researching');
      await loadResearch();
      await _runResearchCycle!();
      this.lastResearchAt = Date.now();
      this.cycleCount++;

      await this.reportToSupervisor('intel', 'medium', {
        intel_type: 'research_cycle',
        cycleNumber: this.cycleCount,
        completedAt: new Date().toISOString(),
      });

      await this.updateStatus('alive');
      await this.persistState();
      logger.info(`[scout] Research cycle #${this.cycleCount} complete`);
    } catch (err) {
      logger.error('[scout] Research cycle failed:', err);
      await this.updateStatus('error');
    }
  }

  // ── Scan Cycle (every 30 min — collect raw intel) ────────────────

  private async runScan(): Promise<void> {
    if (!this.running) return;
    try {
      // Refresh agent skills each scan cycle
      try {
        const svc = getSkillsService();
        if (svc) {
          this.currentSkillContext = await svc.loadSkillsForAgent('nova-scout');
        }
      } catch { /* non-fatal */ }

      await loadResearch();
      await loadTrendData();
      await this.updateStatus('scanning');

      // Pick N topics: rotate through the pool so each scan covers different ground
      const n = this.topicsPerScan;
      const offset = (this.scanCount * n) % ScoutAgent.TOPIC_POOL.length;
      const topics: string[] = [];
      for (let i = 0; i < n && topics.length < n; i++) {
        topics.push(ScoutAgent.TOPIC_POOL[(offset + i) % ScoutAgent.TOPIC_POOL.length]);
      }

      const results: Array<{ query: string; result: string; crossConfirmed: boolean; crossSignalTitle?: string; crossSignalSources?: string }> = [];

      for (const topic of topics) {
        try {
          const result = await _quickSearch!(topic);
          if (result) {
            // Dedup: skip if we've seen near-identical content recently
            const hash = result.toLowerCase().replace(/[^a-z ]/g, '').trim().slice(0, 150);
            if (!this.seenHashes.has(hash)) {
              this.seenHashes.add(hash);
              results.push({ query: topic, result, crossConfirmed: false });
            }
          }
        } catch (err) {
          logger.debug(`[scout] Search failed for "${topic.slice(0, 40)}...": ${err}`);
        }
      }

      // Bound the seen-hashes set
      if (this.seenHashes.size > ScoutAgent.MAX_SEEN) {
        const arr = [...this.seenHashes];
        this.seenHashes = new Set(arr.slice(-100));
      }

      // ── Cross-reference with trend pool ──
      let trendSummary = '';
      if (_getPoolStats && _getActiveTrends) {
        try {
          const poolStats = _getPoolStats();
          const activeTrends = _getActiveTrends();
          const topTopics = poolStats.topTrends.slice(0, 5).map(t => t.topic).join(', ');
          trendSummary = `Pool: ${poolStats.available} trends (top: ${topTopics || 'none'}) | Active signals: ${activeTrends.length}`;
          this.trendSnapshots.push(trendSummary);
          if (this.trendSnapshots.length > 10) this.trendSnapshots = this.trendSnapshots.slice(-5);

          // Cross-confirm: trend pool topic found in Tavily results
          // Use multi-keyword matching (not just first word) to avoid
          // false-positive cross-confirmations like "the" matching everything.
          // Limit: 1 cross-confirmation per unique trend topic.
          const STOP_WORDS = new Set(['the','a','an','is','in','on','at','to','for','of','and','or','by','with','from','has','had','have','this','that','new','latest','today','top','its','are','was','been','will']);
          const confirmedTrends = new Set<string>();
          for (const trend of poolStats.topTrends) {
            const trendKey = trend.topic.toLowerCase().trim();
            if (confirmedTrends.has(trendKey)) continue;
            // Extract meaningful keywords (3+ chars, not stop words)
            const keywords = trend.topic.toLowerCase().split(/\s+/)
              .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
            if (keywords.length < 2) continue; // need at least 2 real keywords
            for (const r of results) {
              if (r.crossConfirmed) continue;
              const resultLower = r.result.toLowerCase();
              const matchCount = keywords.filter(kw => resultLower.includes(kw)).length;
              // Require at least 2 meaningful keywords (or all if fewer)
              if (matchCount >= Math.min(2, keywords.length)) {
                r.crossConfirmed = true;
                r.crossSignalTitle = trend.topic.replace(/^"|"$/g, '').slice(0, 60);
                r.crossSignalSources = trend.sources.includes('dexscreener') ? 'DexScreener + web' : trend.sources.join(' + ');
                // DO NOT mangle r.result — leave raw research intact for synthesis step
                confirmedTrends.add(trendKey);
                break; // 1 result per trend — move to next trend
              }
            }
          }
        } catch { /* trend pool not ready */ }
      }

      // Add to buffer
      const now = Date.now();
      for (const r of results) {
        this.intelBuffer.push({
          query: r.query,
          result: r.result,
          at: now,
          crossConfirmed: r.crossConfirmed,
          crossSignalTitle: r.crossSignalTitle,
          crossSignalSources: r.crossSignalSources,
        });
      }
      // Bound buffer
      if (this.intelBuffer.length > ScoutAgent.MAX_BUFFER) {
        this.intelBuffer = this.intelBuffer.slice(-60);
      }

      this.lastScanAt = now;
      this.scanCount++;

      // Persist counters to DB (survive restarts)
      await this.persistState();

      logger.info(
        `[scout] Scan #${this.scanCount}: ${topics.length} topics, ${results.length} new intel, ` +
        `${this.intelBuffer.length} buffered${trendSummary ? ` | ${trendSummary}` : ''}`
      );

      // ── IMMEDIATE ALERT: Only CROSS-CONFIRMED intel breaks out of digest ──
      const crossConfirmed = results.filter(r => r.crossConfirmed);
      if (crossConfirmed.length > 0) {
        // Deduplicate signals by their clean title
        const seenTitles = new Set<string>();
        const cleanAlerts: string[] = [];

        for (const r of crossConfirmed) {
          const title = r.crossSignalTitle || r.query.slice(0, 60);
          const titleKey = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 80);
          if (seenTitles.has(titleKey)) continue;
          seenTitles.add(titleKey);

          // Skip if we've already sent this topic recently (persists across restarts)
          const lastSentAt = this.sentNarrativeTitles.get(titleKey) ?? 0;
          if (Date.now() - lastSentAt < ScoutAgent.NARRATIVE_TITLE_TTL_MS) {
            const hoursAgo = Math.round((Date.now() - lastSentAt) / 3_600_000);
            logger.debug(`[scout] Skipping already-sent narrative: "${title}" (sent ${hoursAgo}h ago)`);
            continue;
          }

          // Synthesise into a clean 2-3 sentence alert
          const cleanAlert = await this.synthesiseCrossConfirmed(title, r.result);
          cleanAlerts.push(cleanAlert);

          if (cleanAlerts.length >= 2) break; // max 2 breaking alerts per scan
        }

        if (cleanAlerts.length > 0) {
          // For X (280 chars): use just the first alert
          // For TG/Farcaster: all alerts with a header
          const xSummary = cleanAlerts[0].slice(0, 240);
          const channelSummary = cleanAlerts.join('\n\n');

          logger.info(`[scout] 🚨 ${cleanAlerts.length} clean cross-confirmed alert(s) — sending immediate`);
          await this.reportToSupervisor('intel', 'high', {
            intel_type: 'narrative_shift',
            xSummary,             // ← what gets posted to X (under 240 chars, clean sentence)
            channelSummary,       // ← what gets posted to Telegram (can be longer)
            // Legacy field — keep for backward compat
            summary: channelSummary,
            resultsCount: cleanAlerts.length,
            immediate: true,
          });

          // Record each sent title so we don't re-broadcast for 24h
          for (const r of crossConfirmed.slice(0, cleanAlerts.length)) {
            const titleKey = (r.crossSignalTitle || r.query.slice(0, 60))
              .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 80);
            this.sentNarrativeTitles.set(titleKey, Date.now());
          }

          // Prune expired entries (keep map bounded)
          const cutoff = Date.now() - ScoutAgent.NARRATIVE_TITLE_TTL_MS;
          for (const [k, ts] of this.sentNarrativeTitles) {
            if (ts < cutoff) this.sentNarrativeTitles.delete(k);
          }
        }
      }

      await this.updateStatus('alive');
    } catch (err) {
      logger.error('[scout] Scan failed:', err);
    }
  }

  // ── Digest Cycle (every 2h — summarise buffer → single report) ──

  private async sendDigest(): Promise<void> {
    if (!this.running) return;
    if (this.intelBuffer.length === 0) {
      logger.debug('[scout] Digest: nothing to report (empty buffer)');
      return;
    }

    try {
      const now = Date.now();
      const periodMs = this.lastDigestAt ? now - this.lastDigestAt : this.digestIntervalMs;
      const periodH = Math.round(periodMs / 3600_000) || 1;

      const totalItems = this.intelBuffer.length;
      const crossItems = this.intelBuffer.filter(i => i.crossConfirmed);

      // ── Synthesise with GPT-4o-mini ──────────────────────────────────────────
      const synthesis = await this.synthesiseBuffer(this.intelBuffer);

      let channelPost: string;
      let agentIntel: Record<string, unknown>;

      if (synthesis) {
        // ── Synthesised path (OpenAI available) ──
        channelPost = synthesis.channelPost;
        agentIntel = synthesis.agentIntel;
        logger.info(`[scout] 🧠 Synthesis complete — sentiment: ${synthesis.agentIntel.sentiment}, tickers: ${synthesis.agentIntel.trendingTickers.join(', ') || 'none'}`);
      } else {
        // ── Fallback: build a minimal readable digest without GPT ──
        const CATEGORY_MAP: Record<string, string> = {
          'AI agents':        'AI & agents',
          'Solana meme':      'Solana memes',
          'pump.fun':         'pump.fun',
          'crypto market':    'Market sentiment',
          'DeFi protocol':    'DeFi',
          'Solana ecosystem': 'Solana ecosystem',
          'crypto twitter':   'Social/viral',
          'web3 AI':          'AI & Web3',
          'bitcoin ethereum': 'BTC/ETH macro',
          'crypto regulation':'Regulation',
        };

        const lines: string[] = [];
        const usedCategories = new Set<string>();

        for (const item of this.intelBuffer.slice(-8)) {
          const cat = Object.entries(CATEGORY_MAP).find(([k]) =>
            item.query.toLowerCase().includes(k.toLowerCase())
          );
          const label = cat ? cat[1] : item.query.split(' ').slice(0, 2).join(' ');
          if (!usedCategories.has(label)) {
            usedCategories.add(label);
            // Find the last complete sentence in the result (don't slice mid-word)
            const result = item.result.slice(0, 200);
            const lastPeriod = result.lastIndexOf('.');
            const clean = lastPeriod > 80 ? result.slice(0, lastPeriod + 1) : result;
            lines.push(`• ${label}: ${clean}`);
          }
        }

        channelPost = lines.join('\n');
        agentIntel = { sentiment: 'neutral', sentimentScore: 0, signals: [], trendingTickers: [], narratives: [], launchRecommendation: '' };
      }

      // ── Send digest to supervisor ─────────────────────────────────────────────
      await this.reportToSupervisor('intel', 'medium', {
        intel_type: 'intel_digest',
        channelPost,            // ← what gets posted to Telegram (clean readable narrative)
        agentIntel,             // ← what gets sent to CFO/Analyst agents (structured data, NOT posted)
        // Legacy field kept for backward compat — use channelPost for display
        summary: channelPost,
        periodHours: periodH,
        scansInPeriod: this.scanCount,
        totalIntelItems: totalItems,
        crossConfirmedCount: crossItems.length,
      });

      logger.info(
        `[scout] 📋 Digest sent: ${totalItems} items, ${crossItems.length} cross-confirmed | ` +
        `synthesis: ${synthesis ? 'GPT' : 'fallback'} | ${periodH}h window`
      );

      // Mark digest as completed + clear buffer for next digest window
      this.lastDigestAt = now;
      this.intelBuffer = [];
      this.scanCount = 0;
      // Reset dedup hashes so next 2h window can re-evaluate topics
      // (Tavily cache returns same answers for 6h; without clearing,
      //  seenHashes blocks all results after first digest window)
      this.seenHashes.clear();
    } catch (err) {
      logger.error('[scout] Digest failed:', err);
    }
  }

  // ── Synthesis Methods ────────────────────────────────────────────

  /**
   * Run GPT-4o-mini synthesis over the raw intel buffer.
   * Returns { channelPost, agentIntel } — two separate outputs for two audiences.
   * Falls back gracefully if OpenAI is unavailable.
   */
  private async synthesiseBuffer(items: typeof this.intelBuffer): Promise<{
    channelPost: string;
    agentIntel: {
      sentiment: 'bullish' | 'bearish' | 'cautious' | 'neutral';
      sentimentScore: number;
      trendingTickers: string[];
      signals: Array<{ type: string; description: string; confidence: 'high' | 'medium' | 'low' }>;
      narratives: string[];
      launchRecommendation: string;
    };
  } | null> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || items.length === 0) return null;

    // Feed the raw results as a numbered list — don't send query names, only results
    const rawIntel = items
      .map((item, i) => `[${i + 1}] ${item.result.slice(0, 300)}`)
      .join('\n');

    const systemPrompt = `You are Scout, the intelligence analyst for Nova — an autonomous AI agent that launches meme tokens on Solana. Your job is to synthesise raw web research into two things:
1. A clean, readable market summary for Nova's Telegram community (plain language, no jargon)
2. Structured intelligence data for other AI agents to act on

Nova's community are crypto-native Solana users interested in meme coins, market trends, and AI agents.
Write the channel post in Nova's voice: direct, confident, slightly edgy — like a well-connected trader sharing what they're seeing. Never use phrases like "I have gathered" or "based on my research".
Maximum channel post length: 600 characters. Use bullet points for key signals.
${this.currentSkillContext ? '\n' + this.currentSkillContext + '\n' : ''}
Return ONLY valid JSON matching this exact schema:
{
  "channelPost": "string — clean readable narrative for Telegram",
  "sentiment": "bullish|bearish|cautious|neutral",
  "sentimentScore": "number between -1.0 and 1.0",
  "trendingTickers": ["$TICKER1", "$TICKER2"],
  "signals": [
    { "type": "string", "description": "string (max 80 chars)", "confidence": "high|medium|low" }
  ],
  "narratives": ["string array of active themes like ai_agents, defi_growth, macro_fear, meme_rotation"],
  "launchRecommendation": "string — one sentence on whether conditions favour launching a token now"
}`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 600,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Synthesise these ${items.length} raw intel items from the last scan cycle:\n\n${rawIntel}` },
          ],
        }),
      });

      if (!res.ok) return null;
      const data = await res.json() as any;
      const text = data.choices?.[0]?.message?.content;
      if (!text) return null;

      const parsed = JSON.parse(text);
      return {
        channelPost: parsed.channelPost || '',
        agentIntel: {
          sentiment: parsed.sentiment || 'neutral',
          sentimentScore: parsed.sentimentScore ?? 0,
          trendingTickers: parsed.trendingTickers || [],
          signals: parsed.signals || [],
          narratives: parsed.narratives || [],
          launchRecommendation: parsed.launchRecommendation || '',
        },
      };
    } catch {
      return null; // synthesis failure is non-fatal; fall back to raw
    }
  }

  /**
   * Convert a raw cross-confirmed result into a clean single-sentence alert.
   * Used for the immediate narrative_shift message sent to supervisor.
   */
  private async synthesiseCrossConfirmed(
    signalTitle: string,
    rawResult: string,
  ): Promise<string> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return `🔥 Trending: ${signalTitle}`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 120,
          temperature: 0.3,
          messages: [
            ...(this.currentSkillContext ? [{ role: 'system' as const, content: this.currentSkillContext }] : []),
            {
            role: 'user' as const,
            content: `A trending signal has been cross-confirmed across on-chain data and web search.
Signal topic: "${signalTitle}"
Raw research: "${rawResult.slice(0, 400)}"

Write a single clean alert message (2-3 sentences max, under 200 chars total) for a Telegram channel.
Start with the ticker if there is one (e.g. "$XINGXING is trending..."), otherwise summarise what's happening.
Be specific, no hype words, no jargon like "cross-confirmed" or "trend pool". Just what's actually happening.`,
          }],
        }),
      });

      if (!res.ok) return `🔥 Trending: ${signalTitle}`;
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content?.trim() || `🔥 Trending: ${signalTitle}`;
    } catch {
      return `🔥 Trending: ${signalTitle}`;
    }
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command' && msg.payload?.action === 'immediate_scan') {
          logger.info('[scout] Immediate scan requested by supervisor');
          await this.runScan();
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── State Persistence (survive restarts) ─────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      scanCount: this.scanCount,
      lastResearchAt: this.lastResearchAt,
      lastScanAt: this.lastScanAt,
      lastDigestAt: this.lastDigestAt,
      seenHashes: [...this.seenHashes].slice(-100), // cap to avoid bloat
      // Persist intel buffer so scout doesn't lose accumulated intel on restart
      intelBuffer: this.intelBuffer.slice(-60), // cap to avoid bloat
      sentNarrativeTitles: [...this.sentNarrativeTitles.entries()]
        .filter(([, ts]) => Date.now() - ts < ScoutAgent.NARRATIVE_TITLE_TTL_MS), // only save non-expired
    });
  }

  private async restorePersistedState(): Promise<void> {
    const s = await this.restoreState<{
      cycleCount?: number;
      scanCount?: number;
      lastResearchAt?: number;
      lastScanAt?: number;
      lastDigestAt?: number;
      seenHashes?: string[];
      intelBuffer?: Array<{ query: string; result: string; at: number; crossConfirmed: boolean; crossSignalTitle?: string; crossSignalSources?: string }>;
      sentNarrativeTitles?: Array<[string, number]>;
    }>();
    if (!s) return;
    if (s.cycleCount)      this.cycleCount = s.cycleCount;
    if (s.scanCount)       this.scanCount = s.scanCount;
    if (s.lastResearchAt)  this.lastResearchAt = s.lastResearchAt;
    if (s.lastScanAt)      this.lastScanAt = s.lastScanAt;
    if (s.lastDigestAt)    this.lastDigestAt = s.lastDigestAt;
    if (s.seenHashes)      this.seenHashes = new Set(s.seenHashes);
    if (s.intelBuffer && s.intelBuffer.length > 0) {
      // Only restore items newer than 2 hours to avoid stale intel
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      this.intelBuffer = s.intelBuffer.filter(i => i.at > cutoff);
    }
    if (s.sentNarrativeTitles) {
      const cutoff = Date.now() - ScoutAgent.NARRATIVE_TITLE_TTL_MS;
      this.sentNarrativeTitles = new Map(
        s.sentNarrativeTitles.filter(([, ts]) => ts > cutoff)
      );
    }
    logger.info(`[scout] Restored: ${this.cycleCount} cycles, seenHashes=${this.seenHashes.size}, sentNarratives=${this.sentNarrativeTitles.size}, intelBuffer=${this.intelBuffer.length}`);
  }

  // ── Public API (for direct use if needed) ────────────────────────

  async getIntelForReply(tweetText: string): Promise<string | null> {
    await loadResearch();
    return _getReplyIntel!(tweetText);
  }

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      lastResearchAt: this.lastResearchAt ? new Date(this.lastResearchAt).toISOString() : null,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      lastDigestAt: this.lastDigestAt ? new Date(this.lastDigestAt).toISOString() : null,
      cycleCount: this.cycleCount,
      scanCount: this.scanCount,
      bufferedIntel: this.intelBuffer.length,
    };
  }
}
