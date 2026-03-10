/**
 * Social Sentinel Agent
 *
 * Role: Polls mainstream social platforms (Reddit, Google Trends) for viral,
 * meme-worthy topics and feeds them into the TrendPool for reactive launches.
 *
 * Philosophy: This agent doesn't look for crypto — it looks for *culture*.
 * The crypto spin is the Idea Generator's job. SocialSentinel just finds the
 * weird, funny, absurd stuff the internet is obsessing over today.
 *
 * Data sources:
 *   - Reddit: /r/{sub}/hot.json — no auth needed, ~60 req/min
 *   - Google Trends: dailytrends API — unofficial but stable, no auth
 *
 * Personality: Playful, chaotic, thinks in memes. Reports to Supervisor
 * with snarky summaries. Not crypto-heavy.
 *
 * Lifecycle: Factory-spawned via `social_trending` capability.
 * No env vars needed — runs with zero config.
 *
 * Outgoing messages → Supervisor:
 *   - intel (medium): Batch of new social trends detected
 *   - report (low): Periodic summary of what's trending
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Force a fresh poll cycle
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import * as trendPool from '../launchkit/services/trendPool.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Subreddits to poll — mix of meme-heavy, pop culture, and viral content */
const DEFAULT_SUBREDDITS = [
  'all',              // Catch-all for mainstream viral content
  'memes',            // Classic meme factory
  'dankmemes',        // Edgier memes
  'me_irl',           // Relatable content
  'OutOfTheLoop',     // "What's happening?" signals
  'todayilearned',    // Interesting facts that sometimes go viral
  'nottheonion',      // Absurdist news
  'interestingasfuck', // Viral visuals / facts
];

/** Minimum Reddit score (upvotes) to consider a post "trending" */
const MIN_REDDIT_SCORE = 5000;

/** Minimum score to push to trend pool */
const MIN_TREND_POOL_SCORE = 45;

/** How many top posts to scan per subreddit */
const POSTS_PER_SUB = 10;

/** Poll interval: 20 minutes */
const POLL_INTERVAL_MS = 20 * 60 * 1000;

/** Max trends to push per cycle (avoid flooding) */
const MAX_TRENDS_PER_CYCLE = 6;

/** User-Agent for Reddit (they require one for API calls) */
const USER_AGENT = 'nova-social-sentinel/1.0 (trend monitoring bot)';

// ============================================================================
// Types
// ============================================================================

interface RedditPost {
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  url: string;
  permalink: string;
  createdUtc: number;
  upvoteRatio: number;
  isVideo: boolean;
  isSelf: boolean;
  distinguished: string | null;
}

interface GoogleTrend {
  title: string;
  formattedTraffic: string;  // e.g. "500K+"
  relatedQueries: string[];
  articles: { title: string; source: string }[];
}

interface ScoredCandidate {
  topic: string;
  source: 'reddit' | 'google_trends';
  rawScore: number;        // Source-specific score
  normalizedScore: number; // 0-100 for TrendPool
  context: string;         // Why this is trending
  metadata: Record<string, unknown>;
}

// ============================================================================
// Snarky quips for reports (because personality matters)
// ============================================================================

const QUIPS = [
  'the internet is at it again',
  'normies are eating this up',
  'timeline is UNHINGED today',
  'the algorithm blessed us',
  'culture is moving fast rn',
  'meme potential: off the charts',
  'the people have spoken (on reddit)',
  'google says everyone is searching THIS',
  'mainstream moment detected',
  'the vibes are immaculate',
  'front page energy right here',
  'this one\'s got legs',
];

function randomQuip(): string {
  return QUIPS[Math.floor(Math.random() * QUIPS.length)];
}

// ============================================================================
// Social Sentinel Agent
// ============================================================================

export class SocialSentinelAgent extends BaseAgent {
  private pollIntervalMs: number;
  private subreddits: string[];
  private cycleCount = 0;
  private totalTrendsPushed = 0;
  private lastPollAt = 0;
  private recentTopics: Set<string> = new Set(); // Dedup within session

  constructor(pool: Pool, opts?: {
    pollIntervalMs?: number;
    subreddits?: string[];
  }) {
    super({
      agentId: 'nova-social-sentinel',
      agentType: 'social_sentinel',
      pool,
    });
    this.pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.subreddits = opts?.subreddits ?? DEFAULT_SUBREDDITS;
  }

  protected async onStart(): Promise<void> {
    // Restore persisted state from DB
    const saved = await this.restoreState<{
      cycleCount: number;
      totalTrendsPushed: number;
      recentTopics: string[];
    }>();
    if (saved) {
      this.cycleCount = saved.cycleCount || 0;
      this.totalTrendsPushed = saved.totalTrendsPushed || 0;
      if (saved.recentTopics) this.recentTopics = new Set(saved.recentTopics);
    }

    this.startHeartbeat(60_000);

    // Run first poll after a short warmup
    setTimeout(() => this.runPollCycle(), 30_000);

    // Schedule recurring polls
    this.addInterval(() => this.runPollCycle(), this.pollIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 30_000);

    logger.info(`[social-sentinel] 👁️ Online — polling ${this.subreddits.length} subreddits + Google Trends every ${this.pollIntervalMs / 60000}min`);
  }

  protected async onStop(): Promise<void> {
    await this.persistState();
    logger.info(`[social-sentinel] Stopped after ${this.cycleCount} cycles, ${this.totalTrendsPushed} trends pushed`);
  }

  // ── Main Poll Cycle ────────────────────────────────────────────

  private async runPollCycle(): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;
    await this.updateStatus('gathering');

    logger.info(`[social-sentinel] 🔍 Cycle #${cycleId} — scanning Reddit + Google Trends...`);

    const candidates: ScoredCandidate[] = [];

    // Fetch from both sources in parallel
    const [redditResults, googleResults] = await Promise.allSettled([
      this.fetchRedditTrends(),
      this.fetchGoogleTrends(),
    ]);

    if (redditResults.status === 'fulfilled') {
      candidates.push(...redditResults.value);
    } else {
      logger.warn(`[social-sentinel] Reddit fetch failed:`, redditResults.reason);
    }

    if (googleResults.status === 'fulfilled') {
      candidates.push(...googleResults.value);
    } else {
      logger.warn(`[social-sentinel] Google Trends fetch failed:`, googleResults.reason);
    }

    if (candidates.length === 0) {
      logger.debug(`[social-sentinel] Cycle #${cycleId}: no qualifying candidates`);
      await this.updateStatus('idle');
      return;
    }

    // Sort by normalized score, take top N
    candidates.sort((a, b) => b.normalizedScore - a.normalizedScore);
    const topCandidates = candidates.slice(0, MAX_TRENDS_PER_CYCLE);

    // Push to TrendPool
    let pushed = 0;
    for (const candidate of topCandidates) {
      // Dedup: skip if we recently pushed this topic
      const topicKey = candidate.topic.toLowerCase().slice(0, 60);
      if (this.recentTopics.has(topicKey)) continue;

      trendPool.upsertTrend({
        id: `social-${candidate.source}-${topicKey.replace(/\s+/g, '-').slice(0, 40)}`,
        topic: candidate.topic,
        source: candidate.source,
        score: candidate.normalizedScore,
        context: candidate.context,
        metadata: candidate.metadata,
      });

      this.recentTopics.add(topicKey);
      pushed++;
    }

    // Keep recentTopics bounded (last 200)
    if (this.recentTopics.size > 200) {
      const arr = Array.from(this.recentTopics);
      this.recentTopics = new Set(arr.slice(-150));
    }

    this.totalTrendsPushed += pushed;
    this.lastPollAt = Date.now();

    // Persist trend pool to disk
    trendPool.persist();

    // Report to supervisor
    if (pushed > 0) {
      const topTopics = topCandidates.slice(0, 3).map(c => c.topic.slice(0, 40));
      await this.reportToSupervisor('intel', 'medium', {
        action: 'social_trends_detected',
        summary: `🕵️ ${pushed} social trends pushed — ${randomQuip()}`,
        trends: topTopics,
        totalPushedLifetime: this.totalTrendsPushed,
        cycle: cycleId,
      });
    }

    logger.info(`[social-sentinel] Cycle #${cycleId}: ${candidates.length} candidates → ${pushed} pushed to trend pool (${this.totalTrendsPushed} lifetime)`);
    await this.updateStatus('idle');
    await this.persistState();
  }

  // ── Reddit Fetch ───────────────────────────────────────────────

  private async fetchRedditTrends(): Promise<ScoredCandidate[]> {
    const candidates: ScoredCandidate[] = [];

    // Fetch subreddits sequentially to be nice to Reddit's rate limits
    for (const sub of this.subreddits) {
      try {
        const posts = await this.fetchSubreddit(sub);
        for (const post of posts) {
          // Skip stickied/mod posts
          if (post.distinguished) continue;

          // Only consider posts above the score threshold
          if (post.score < MIN_REDDIT_SCORE) continue;

          // Normalize score: Reddit scores can go into hundreds of thousands
          // Map 5K-100K+ into our 0-100 scale
          const normalized = this.normalizeRedditScore(post.score, post.numComments, post.upvoteRatio);

          if (normalized < MIN_TREND_POOL_SCORE) continue;

          candidates.push({
            topic: this.cleanRedditTitle(post.title),
            source: 'reddit',
            rawScore: post.score,
            normalizedScore: normalized,
            context: `Hot on r/${post.subreddit} (${this.formatNumber(post.score)} upvotes, ${this.formatNumber(post.numComments)} comments)`,
            metadata: {
              subreddit: post.subreddit,
              upvotes: post.score,
              comments: post.numComments,
              upvoteRatio: post.upvoteRatio,
              permalink: `https://reddit.com${post.permalink}`,
              isVideo: post.isVideo,
            },
          });
        }
      } catch (err) {
        logger.debug(`[social-sentinel] Failed to fetch r/${sub}: ${(err as Error).message}`);
      }
    }

    return candidates;
  }

  private async fetchSubreddit(sub: string): Promise<RedditPost[]> {
    const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${POSTS_PER_SUB}&raw_json=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Reddit r/${sub}: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    const children = data?.data?.children ?? [];

    return children.map((child: any) => {
      const d = child.data;
      return {
        title: d.title || '',
        subreddit: d.subreddit || sub,
        score: d.score || 0,
        numComments: d.num_comments || 0,
        url: d.url || '',
        permalink: d.permalink || '',
        createdUtc: d.created_utc || 0,
        upvoteRatio: d.upvote_ratio || 0,
        isVideo: d.is_video || false,
        isSelf: d.is_self || false,
        distinguished: d.distinguished || null,
      } satisfies RedditPost;
    });
  }

  /**
   * Normalize Reddit score into 0-100 range for TrendPool.
   *
   * Scoring:
   * - Base: log scale of upvotes (5K=45, 10K=55, 50K=75, 100K=85)
   * - Comment boost: high comment ratio = more discussion = more memeable
   * - Upvote ratio boost: 95%+ = universal appeal
   */
  private normalizeRedditScore(upvotes: number, comments: number, upvoteRatio: number): number {
    // Log scale base (log10(5000)=3.7, log10(100000)=5)
    const logBase = Math.log10(Math.max(upvotes, 1));
    let score = Math.min(85, (logBase - 3.0) * 25); // 3.0->0, 3.7->17.5, 5.0->50

    // Comment engagement boost (comments/upvotes ratio)
    const commentRatio = comments / Math.max(upvotes, 1);
    if (commentRatio > 0.1) score += 10;       // Very high discussion
    else if (commentRatio > 0.05) score += 5;  // Good discussion

    // High agreement boost
    if (upvoteRatio >= 0.95) score += 5;

    // Raw upvote tiers
    if (upvotes >= 50_000) score += 10;
    else if (upvotes >= 20_000) score += 5;

    return Math.min(100, Math.max(0, Math.round(score)));
  }

  /**
   * Clean Reddit title — remove subreddit-specific prefixes, emoji noise, etc.
   * We want a clean topic string for the Idea Generator.
   */
  private cleanRedditTitle(title: string): string {
    return title
      .replace(/^\[.*?\]\s*/, '')     // Remove [tag] prefixes
      .replace(/^(TIL|TIFU|ELI5|CMV|DAE)\s+/i, '') // Remove Reddit-specific prefixes
      .replace(/\s+/g, ' ')           // Normalize whitespace
      .trim()
      .slice(0, 120);                 // Cap length
  }

  // ── Google Trends Fetch ────────────────────────────────────────

  private async fetchGoogleTrends(): Promise<ScoredCandidate[]> {
    const candidates: ScoredCandidate[] = [];

    try {
      // Use the unofficial daily trends API (US geo, English)
      const url = 'https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-300&geo=US&ns=15';
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`Google Trends: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      // Google prefixes the response with ")]}'" to prevent XSSI
      const jsonStr = text.replace(/^\)\]\}'\n/, '');
      const data = JSON.parse(jsonStr);

      const trendingDays = data?.default?.trendingSearchesDays ?? [];
      
      for (const day of trendingDays.slice(0, 2)) { // Today + yesterday
        const searches = day.trendingSearches ?? [];
        
        for (const search of searches.slice(0, 15)) { // Top 15 per day
          const title = search.title?.query || '';
          if (!title) continue;

          // Parse traffic number (e.g. "500K+" → 500000)
          const traffic = this.parseTrafficNumber(search.formattedTraffic || '');
          
          // Extract related articles for context
          const articles = (search.articles || []).slice(0, 3).map((a: any) => ({
            title: a.title || '',
            source: a.source || '',
          }));

          const relatedQueries = (search.relatedQueries || []).map((q: any) => q.query || '').filter(Boolean);

          const normalized = this.normalizeGoogleScore(traffic, articles.length, relatedQueries.length);
          
          if (normalized < MIN_TREND_POOL_SCORE) continue;

          const contextParts = [`Trending on Google (${search.formattedTraffic || '?'} searches)`];
          if (articles.length > 0) {
            contextParts.push(`Headlines: ${articles.map((a: any) => a.title).join('; ').slice(0, 120)}`);
          }

          candidates.push({
            topic: title,
            source: 'google_trends',
            rawScore: traffic,
            normalizedScore: normalized,
            context: contextParts.join(' | '),
            metadata: {
              formattedTraffic: search.formattedTraffic,
              articles,
              relatedQueries: relatedQueries.slice(0, 5),
            },
          });
        }
      }
    } catch (err) {
      logger.warn(`[social-sentinel] Google Trends fetch failed: ${(err as Error).message}`);
    }

    return candidates;
  }

  /**
   * Parse Google Trends traffic strings like "500K+", "2M+", "100K+"
   */
  private parseTrafficNumber(formatted: string): number {
    const cleaned = formatted.replace(/[+,]/g, '').trim().toUpperCase();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(K|M|B)?$/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const multiplier = match[2] === 'B' ? 1_000_000_000 : match[2] === 'M' ? 1_000_000 : match[2] === 'K' ? 1_000 : 1;
    return num * multiplier;
  }

  /**
   * Normalize Google Trends score into 0-100 range.
   *
   * Google Trends volume can vary wildly. We use a tiered approach:
   * - 100K+ searches → base 50
   * - 500K+ → base 65
   * - 1M+ → base 75
   * - Related articles boost = deeper story = more meme material
   */
  private normalizeGoogleScore(traffic: number, articleCount: number, relatedQueryCount: number): number {
    let score = 0;

    // Traffic tiers
    if (traffic >= 1_000_000) score = 75;
    else if (traffic >= 500_000) score = 65;
    else if (traffic >= 200_000) score = 55;
    else if (traffic >= 100_000) score = 50;
    else if (traffic >= 50_000) score = 45;
    else return 30; // Below threshold

    // Article coverage boost (news coverage = lasting relevance)
    if (articleCount >= 3) score += 10;
    else if (articleCount >= 1) score += 5;

    // Related queries boost (connected topics = richer meme potential)
    if (relatedQueryCount >= 3) score += 5;

    return Math.min(100, score);
  }

  // ── Command Processing ─────────────────────────────────────────

  private async processCommands(): Promise<void> {
    const messages = await this.readMessages(5);

    for (const msg of messages) {
      try {
        if (msg.payload?.action === 'immediate_scan') {
          logger.info('[social-sentinel] Received immediate_scan command');
          await this.runPollCycle();
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      } catch (err) {
        logger.warn(`[social-sentinel] Error processing command:`, err);
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      totalTrendsPushed: this.totalTrendsPushed,
      lastPollAt: this.lastPollAt,
      recentTopics: Array.from(this.recentTopics).slice(-100), // Last 100 to save space
    });
  }

  // ── Utilities ──────────────────────────────────────────────────

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  // ── Public API (for supervisor/factory) ────────────────────────

  getStats(): { cycles: number; totalPushed: number; lastPollAt: number; subreddits: string[] } {
    return {
      cycles: this.cycleCount,
      totalPushed: this.totalTrendsPushed,
      lastPollAt: this.lastPollAt,
      subreddits: this.subreddits,
    };
  }
}
