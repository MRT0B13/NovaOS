/**
 * Scout Agent
 *
 * Role: Intelligence gathering — web research, narrative detection, trend cross-referencing.
 * Wraps novaResearch.ts functions and feeds intel to the Supervisor via agent_messages.
 *
 * Architecture (batched-digest model):
 *   - Scan cycle: every 30 min — runs 7 Tavily searches, cross-refs trend pool
 *   - Digest cycle: every 2 hours — summarises buffered intel → single report to Supervisor + CFO
 *   - Full research: every 8 hours — deep research cycle (novaResearch.runResearchCycle)
 *   - CROSS-CONFIRMED intel bypasses the digest and fires immediately (truly breaking)
 *
 * Outgoing messages → Supervisor:
 *   - intel (high):   Breaking signal (CROSS-CONFIRMED only — immediate)
 *   - intel (medium): Digest summary (batched, every 2h)
 *   - intel (medium): Full research cycle completed
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Run a quick scan NOW (used when Supervisor needs fresh data)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

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
  }> = [];
  private trendSnapshots: string[] = [];     // trend pool state at each scan
  private static MAX_BUFFER = 100;           // bound memory

  // ── Dedup ───────────────────────────────────────────────────────
  private seenHashes: Set<string> = new Set();
  private static MAX_SEEN = 200;

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
    this.researchIntervalMs = opts?.researchIntervalMs ?? 8 * 60 * 60 * 1000;  // 8 hours
    this.scanIntervalMs     = opts?.scanIntervalMs     ?? 30 * 60 * 1000;      // 30 minutes
    this.digestIntervalMs   = opts?.digestIntervalMs   ?? 2 * 60 * 60 * 1000;  // 2 hours
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
      await loadResearch();
      await loadTrendData();
      await this.updateStatus('scanning');

      // Pick 7 topics: rotate through the pool so each scan covers different ground
      const offset = (this.scanCount * 7) % ScoutAgent.TOPIC_POOL.length;
      const topics: string[] = [];
      for (let i = 0; i < 7 && topics.length < 7; i++) {
        topics.push(ScoutAgent.TOPIC_POOL[(offset + i) % ScoutAgent.TOPIC_POOL.length]);
      }

      const results: Array<{ query: string; result: string; crossConfirmed: boolean }> = [];

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
                r.result = `CROSS-CONFIRMED: "${trend.topic}" seen in pool(${trend.sources.join(',')}) + web search — ${r.result.slice(0, 200)}`;
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
        this.intelBuffer.push({ query: r.query, result: r.result, at: now, crossConfirmed: r.crossConfirmed });
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
        // Deduplicate by extracting the quoted topic from each CROSS-CONFIRMED result
        const seenTopics = new Set<string>();
        const uniqueItems: string[] = [];
        for (const r of crossConfirmed) {
          // Extract topic: CROSS-CONFIRMED: "TopicHere" ...
          const topicMatch = r.result.match(/CROSS-CONFIRMED: "([^"]+)"/);
          const key = topicMatch ? topicMatch[1].toLowerCase() : r.result.slice(0, 80).toLowerCase();
          if (!seenTopics.has(key)) {
            seenTopics.add(key);
            uniqueItems.push(r.result.slice(0, 200));
          }
        }
        // Cap at 3 items to prevent wall-of-text
        const breakingSummary = uniqueItems.slice(0, 3).join(' | ');
        logger.info(`[scout] 🚨 ${uniqueItems.length} unique CROSS-CONFIRMED signal(s) — sending immediate alert`);
        await this.reportToSupervisor('intel', 'high', {
          intel_type: 'narrative_shift',
          summary: breakingSummary,
          resultsCount: uniqueItems.length,
          trendPool: trendSummary || undefined,
          immediate: true,
        });
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
      this.lastDigestAt = now;

      // ── Build digest from buffer ──
      const totalItems = this.intelBuffer.length;
      const crossItems = this.intelBuffer.filter(i => i.crossConfirmed);

      // Group non-cross-confirmed items by query topic area for summary
      const nonCrossItems = this.intelBuffer.filter(i => !i.crossConfirmed);
      const byTopic: Record<string, string[]> = {};
      for (const item of nonCrossItems) {
        const topicKey = item.query.split(' ').slice(0, 3).join(' ');
        if (!byTopic[topicKey]) byTopic[topicKey] = [];
        byTopic[topicKey].push(item.result.slice(0, 150));
      }

      // Build summary lines (most interesting first)
      const summaryLines: string[] = [];

      // Cross-confirmed items first (highest value) — dedup by extracted topic
      if (crossItems.length > 0) {
        const seenCrossTopics = new Set<string>();
        const uniqueCross: typeof crossItems = [];
        for (const item of crossItems) {
          const tm = item.result.match(/CROSS-CONFIRMED: "([^"]+)"/);
          const key = tm ? tm[1].toLowerCase() : item.result.slice(0, 80).toLowerCase();
          if (!seenCrossTopics.has(key)) {
            seenCrossTopics.add(key);
            uniqueCross.push(item);
          }
        }
        summaryLines.push(`🔥 ${uniqueCross.length} cross-confirmed signal(s):`);
        for (const item of uniqueCross.slice(0, 3)) {
          summaryLines.push(`  • ${item.result.slice(0, 180)}`);
        }
      }

      // Topic-grouped summaries (cross-confirmed items already excluded above)
      for (const [topic, items] of Object.entries(byTopic)) {
        if (items.length > 0) {
          const best = items.sort((a, b) => b.length - a.length)[0];
          summaryLines.push(`📡 ${topic}: ${best.slice(0, 180)}`);
        }
      }

      // Trend pool snapshot
      const latestTrend = this.trendSnapshots[this.trendSnapshots.length - 1];
      if (latestTrend) {
        summaryLines.push(`📊 ${latestTrend}`);
      }

      const digestSummary = summaryLines.slice(0, 10).join('\n');

      // ── Determine priority ──
      // High only if we have cross-confirmed signals that haven't been sent immediately
      const hasBreaking = crossItems.some(i => !i.crossConfirmed); // (all cross-confirmed already sent)
      const priority = hasBreaking ? 'high' : 'medium';

      // ── Send single digest to supervisor (which forwards to CFO) ──
      await this.reportToSupervisor('intel', priority as any, {
        intel_type: 'intel_digest',
        summary: digestSummary,
        periodHours: periodH,
        scansInPeriod: this.scanCount,
        totalIntelItems: totalItems,
        crossConfirmedCount: crossItems.length,
        trendPool: latestTrend || undefined,
      });

      logger.info(
        `[scout] 📋 Digest sent: ${totalItems} items from ${this.scanCount} scans ` +
        `(${crossItems.length} cross-confirmed) | ${periodH}h window`
      );

      // Clear buffer for next digest window
      this.intelBuffer = [];
      this.scanCount = 0;
    } catch (err) {
      logger.error('[scout] Digest failed:', err);
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
    }>();
    if (!s) return;
    if (s.cycleCount)      this.cycleCount = s.cycleCount;
    if (s.scanCount)       this.scanCount = s.scanCount;
    if (s.lastResearchAt)  this.lastResearchAt = s.lastResearchAt;
    if (s.lastScanAt)      this.lastScanAt = s.lastScanAt;
    if (s.lastDigestAt)    this.lastDigestAt = s.lastDigestAt;
    if (s.seenHashes)      this.seenHashes = new Set(s.seenHashes);
    logger.info(`[scout] Restored: ${this.cycleCount} cycles, ${this.scanCount} scans, seenHashes=${this.seenHashes.size}`);
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
