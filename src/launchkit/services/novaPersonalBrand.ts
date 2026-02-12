/**
 * Nova Personal Brand Service
 * 
 * Manages Nova's personal brand presence on X and Telegram.
 * This is NOT about shilling individual tokens - it's about building
 * Nova as a trusted, transparent autonomous agent brand.
 * 
 * Content Pillars:
 * 1. Daily Operations (gm, status, recaps)
 * 2. Educational / Thought Leadership
 * 3. Market Commentary
 * 4. Builder Insights (data & lessons from launches)
 * 5. Community Engagement (reaction-based)
 * 6. Weekly Summaries
 * 7. Trust & Transparency (anti-rug, value prop, pump.fun reputation)
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getPumpWalletBalance, getPumpWalletTokens } from './fundingWallet.ts';
import { getMetrics, recordTGPostSent } from './systemReporter.ts';
import { recordMessageSent } from './telegramHealthMonitor.ts';
import { registerBrandPostForFeedback } from './communityVoting.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';
import { getTokenPrice, formatMarketCap, getSolPriceUsd } from './priceService.ts';
import { getActiveTrends } from './trendMonitor.ts';
import { getFeesSummary, formatFeesForTweet, formatFeesForTelegram } from './pumpswapFees.ts';

// ============================================================================
// Types
// ============================================================================

export type NovaPostType = 
  | 'gm'                    // Morning greeting + status
  | 'daily_recap'           // End of day summary
  | 'weekly_summary'        // Weekly performance report
  | 'idea_share'            // Sharing a scheduled idea for feedback
  | 'market_commentary'     // React to trends/market
  | 'behind_scenes'         // What Nova is seeing/doing
  | 'builder_insight'       // Sharing data/lessons from launches
  | 'milestone'             // Celebrating achievements
  | 'community_poll'        // Asking community for input
  | 'launch_alert'          // New token launched
  | 'feedback_response'     // Response to community reactions
  // Personality posts (X only)
  | 'hot_take'              // Spicy opinions
  | 'market_roast'          // Making fun of market
  | 'ai_thoughts'           // Self-aware AI humor
  | 'degen_wisdom'          // Crypto life lessons
  | 'random_banter'         // Engagement bait
  | 'trust_talk';           // Trust, transparency, anti-rug, value proposition

export interface NovaPost {
  id: string;
  type: NovaPostType;
  platform: 'x' | 'telegram' | 'both';
  content: string;
  scheduledFor: string; // ISO date
  status: 'pending' | 'posted' | 'failed';
  postedAt?: string;
  postId?: string; // Tweet ID or TG message ID
  reactions?: Record<string, number>;
  createdAt: string;
}

export interface NovaStats {
  walletBalance: number;
  dayNumber: number; // Days since Nova started
  totalLaunches: number;
  todayLaunches: number;
  bondingCurveHits: number;
  netProfit: number;
  weeklyProfit: number;
  bestToken?: { ticker: string; multiple: number };
  worstToken?: { ticker: string; result: string };
  channelMembers?: number;
  xFollowers?: number;
  // Dev buy token holdings
  holdingsCount: number;       // Number of tokens still held
  holdingsValueSol: number;    // Total estimated value in SOL
  holdingsValueUsd: number;    // Total estimated value in USD
  totalDevBuySol: number;      // Total SOL spent on dev buys
}

// ============================================================================
// State
// ============================================================================

interface BrandState {
  posts: NovaPost[];
  startDate: string; // When Nova started (for day counting)
  initialBalance: number; // SOL balance when Nova first started (persisted in DB)
  lastGmDate?: string;
  lastRecapDate?: string;
  lastWeeklySummaryDate?: string;
  lastAlphaDropDate?: string;
  lastCollabDate?: string;
  lastEngagementDate?: string;
  novaTeaseCount: number;
  milestones: string[];
  repliedMentions?: Set<string>;
  // Post variety tracking
  recentPostTypes: NovaPostType[];  // Last N personality post types (for dedup)
  // Post performance tracking
  postPerformance: Record<NovaPostType, { totalLikes: number; totalRetweets: number; count: number }>;
  // Narrative arc state
  activeNarrative?: NarrativeArc;
  completedNarratives: string[];  // narrative titles we've already done
  // Community shoutout tracking
  lastShoutoutDate?: string;
}

/** Multi-day narrative arc for continuity */
interface NarrativeArc {
  title: string;
  theme: string;    // What the arc is about
  dayStarted: number; // dayNumber when started
  postsInArc: number; // How many posts published in this arc
  maxPosts: number;   // Target posts for this arc (3-5)
  prompts: string[];  // Per-post guidance
}

let state: BrandState = {
  posts: [],
  startDate: '2026-02-05T00:00:00.000Z', // Nova's actual launch date - DO NOT use new Date()
  initialBalance: 1.60089, // Actual starting balance from wallet funding
  novaTeaseCount: 0,
  milestones: [],
  repliedMentions: new Set(),
  recentPostTypes: [],
  postPerformance: {} as any,
  completedNarratives: [],
};

let pgRepo: PostgresScheduleRepository | null = null;
let xPublisher: any = null;

// Stats cache to avoid re-fetching all token prices on every post
let cachedStats: NovaStats | null = null;
let cachedStatsAt = 0;
const STATS_CACHE_TTL_MS = 10 * 60_000; // 10 minutes

// ============================================================================
// Initialization
// ============================================================================

export async function initNovaPersonalBrand(): Promise<void> {
  const env = getEnv();
  
  // Load state from PostgreSQL if available
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      await loadStateFromPostgres();
      logger.info('[NovaPersonalBrand] PostgreSQL storage initialized');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init PostgreSQL:', err);
    }
  }
  
  // Initialize X publisher if enabled
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any); // Personal brand doesn't need store
      logger.info('[NovaPersonalBrand] X posting enabled');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init X publisher:', err);
    }
  }
  
  logger.info(`[NovaPersonalBrand] Initialized (X: ${env.NOVA_PERSONAL_X_ENABLE}, TG: ${env.NOVA_PERSONAL_TG_ENABLE})`);
}

async function loadStateFromPostgres(): Promise<void> {
  if (!pgRepo) return;
  
  try {
    const savedState = await pgRepo.getAutonomousState();
    if (savedState) {
      // Load nova-specific fields
      const novaStartDate = (savedState as any).nova_start_date;
      const novaTeaseCount = (savedState as any).nova_tease_count;
      const novaMilestones = (savedState as any).nova_milestones;
      
      if (novaStartDate) {
        state.startDate = novaStartDate;
        logger.info(`[NovaPersonalBrand] Loaded startDate from DB: ${novaStartDate}`);
      } else {
        // First run - save the initial startDate
        await saveStateToPostgres();
        logger.info(`[NovaPersonalBrand] Initialized startDate in DB: ${state.startDate}`);
      }
      
      if (novaTeaseCount !== undefined) {
        state.novaTeaseCount = novaTeaseCount;
      }
      
      if (novaMilestones) {
        state.milestones = typeof novaMilestones === 'string' 
          ? JSON.parse(novaMilestones) 
          : novaMilestones;
      }
      
      // Load initial balance from DB
      const initialBalance = (savedState as any).initial_balance;
      if (initialBalance !== undefined && initialBalance !== null) {
        state.initialBalance = Number(initialBalance);
        logger.info(`[NovaPersonalBrand] Loaded initialBalance from DB: ${state.initialBalance} SOL`);
      }
    } else {
      // No state exists yet, save initial
      await saveStateToPostgres();
      logger.info(`[NovaPersonalBrand] Initialized brand state in DB`);
    }
  } catch (err) {
    logger.warn('[NovaPersonalBrand] Failed to load state from PostgreSQL:', err);
  }
}

// ============================================================================
// Enhancement #1: Post Variety Guard
// ============================================================================

const VARIETY_HISTORY_SIZE = 10; // Track last 10 personality posts

/** Pick a personality post type that hasn't been used recently */
function pickVariedPostType(types: NovaPostType[]): NovaPostType {
  // Filter out types used in the last 2 posts (guaranteed variety)
  const recentTwo = state.recentPostTypes.slice(-2);
  let available = types.filter(t => !recentTwo.includes(t));
  
  // If everything is filtered out, just avoid the most recent one
  if (available.length === 0) {
    const lastUsed = state.recentPostTypes[state.recentPostTypes.length - 1];
    available = types.filter(t => t !== lastUsed);
    if (available.length === 0) available = types;
  }
  
  // Weight toward types with better performance history
  const weighted = available.map(type => {
    const perf = state.postPerformance[type];
    const avgEngagement = perf && perf.count > 0 
      ? (perf.totalLikes + perf.totalRetweets * 2) / perf.count 
      : 5; // Default weight for untried types (encourage exploration)
    return { type, weight: Math.max(1, avgEngagement) };
  });
  
  // Weighted random selection
  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const w of weighted) {
    roll -= w.weight;
    if (roll <= 0) return w.type;
  }
  
  return weighted[weighted.length - 1].type;
}

/** Record a post type in the variety history */
function recordPostType(type: NovaPostType): void {
  state.recentPostTypes.push(type);
  if (state.recentPostTypes.length > VARIETY_HISTORY_SIZE) {
    state.recentPostTypes = state.recentPostTypes.slice(-VARIETY_HISTORY_SIZE);
  }
}

// ============================================================================
// Enhancement #2: Time-of-Day Personality Shifts
// ============================================================================

type TimeOfDayMood = 'morning' | 'afternoon' | 'evening' | 'latenight';

function getTimeOfDayMood(): TimeOfDayMood {
  const hour = new Date().getUTCHours();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'latenight';
}

const MOOD_CONTEXT: Record<TimeOfDayMood, string> = {
  morning: `TIME OF DAY: Morning. Analytical, market-scanning tone. "Here's what happened overnight on pump.fun..." Share data from overnight activity, graduation rates, volume. Set up the day with observations, not cheerfulness.`,
  afternoon: `TIME OF DAY: Afternoon. Active, launch-focused. Short announcements, RugCheck data, real-time market observations. This is when things happen — be sharp and concise.`,
  evening: `TIME OF DAY: Evening. Reflective, honest. P&L updates, lessons learned from today's data. "Today's numbers tell an interesting story..." Own the results.`,
  latenight: `TIME OF DAY: Late night. Slightly more philosophical but still data-grounded. "Building an autonomous agent that launches meme coins at 2am. The things I've seen on-chain..." Observations from the trenches.`,
};

// ============================================================================
// Enhancement #3: Market-Reactive Posts
// ============================================================================

let lastSolPrice: number | null = null;
let lastSolPriceCheckTime = 0;
let lastMarketReactivePostDate = '';

/** Check if there's a noteworthy market move worth tweeting about */
async function checkMarketTriggers(): Promise<{ trigger: string; context: string } | null> {
  const today = new Date().toISOString().split('T')[0];
  if (lastMarketReactivePostDate === today) return null; // Max 1 reactive post per day
  
  try {
    // Check SOL price movement
    const solData = await getTokenPrice('So11111111111111111111111111111111111111112');
    if (solData?.priceUsd) {
      const currentSolPrice = solData.priceUsd;
      const change24h = solData.priceChange24h;
      
      if (lastSolPrice && lastSolPrice > 0) {
        const pctChange = ((currentSolPrice - lastSolPrice) / lastSolPrice) * 100;
        
        // SOL moved 5%+ since last check
        if (Math.abs(pctChange) >= 5) {
          lastSolPrice = currentSolPrice;
          return {
            trigger: pctChange > 0 ? 'sol_pump' : 'sol_dump',
            context: `SOL just moved ${pctChange > 0 ? '+' : ''}${pctChange.toFixed(1)}% — now at $${currentSolPrice.toFixed(2)}. ${change24h !== null ? `24h change: ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%` : ''}. React to this market move with genuine emotion!`,
          };
        }
      }
      lastSolPrice = currentSolPrice;
    }
    
    // Check if any of Nova's launched tokens hit a notable milestone
    const positions = await getPumpWalletTokens();
    for (const token of positions) {
      if (token.mint) {
        const priceData = await getTokenPrice(token.mint);
        if (priceData?.marketCap && priceData.marketCap > 10000) {
          return {
            trigger: 'token_milestone',
            context: `One of your launched tokens just hit $${formatMarketCap(priceData.marketCap)} market cap! React with genuine excitement!`,
          };
        }
      }
    }
    
    // Check for trending crypto events
    try {
      const trends = getActiveTrends();
      if (trends.length > 5) {
        const topTrend = trends[0];
        return {
          trigger: 'trending_topic',
          context: `The crypto space is buzzing about "${topTrend.topic || 'something big'}". There are ${trends.length}+ trending signals right now. Share your take on what's moving the market.`,
        };
      }
    } catch {
      // trendMonitor may not be initialized
    }
    
  } catch (err) {
    logger.debug(`[NovaPersonalBrand] Market trigger check failed: ${err}`);
  }
  
  return null;
}

// ============================================================================
// Enhancement #4: Post Performance Tracking
// ============================================================================

/** Check metrics on recent tweets and record performance */
async function trackPostPerformance(): Promise<void> {
  if (!xPublisher) return;
  
  // Get posts from last 24h that have tweet IDs
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentPosts = state.posts.filter(p => 
    p.platform === 'x' && 
    p.postId && 
    p.postedAt && 
    new Date(p.postedAt).getTime() > oneDayAgo
  );
  
  for (const post of recentPosts.slice(-5)) { // Check last 5 to avoid rate limits
    try {
      const tweet = await xPublisher.getTweet(post.postId!);
      if (tweet?.metrics) {
        // Initialize if needed
        if (!state.postPerformance[post.type]) {
          state.postPerformance[post.type] = { totalLikes: 0, totalRetweets: 0, count: 0 };
        }
        
        const perf = state.postPerformance[post.type];
        perf.totalLikes += tweet.metrics.likes;
        perf.totalRetweets += tweet.metrics.retweets;
        perf.count += 1;
        
        const avgLikes = (perf.totalLikes / perf.count).toFixed(1);
        logger.debug(`[NovaPersonalBrand] 📊 ${post.type}: ${tweet.metrics.likes} likes, ${tweet.metrics.retweets} RTs (avg: ${avgLikes} likes over ${perf.count} posts)`);
      }
    } catch {
      // Free tier may not support metrics — silently skip
    }
  }
}

/** Get the best and worst performing post types */
function getPerformanceInsights(): { bestType: NovaPostType | null; worstType: NovaPostType | null; summary: string } {
  const types = Object.entries(state.postPerformance)
    .filter(([_, p]) => p.count >= 2) // Need at least 2 data points
    .map(([type, p]) => ({ 
      type: type as NovaPostType, 
      avgEngagement: (p.totalLikes + p.totalRetweets * 2) / p.count 
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
  
  if (types.length < 2) return { bestType: null, worstType: null, summary: 'Not enough data yet' };
  
  return {
    bestType: types[0].type,
    worstType: types[types.length - 1].type,
    summary: `Best: ${types[0].type} (${types[0].avgEngagement.toFixed(1)} avg engagement), Worst: ${types[types.length - 1].type} (${types[types.length - 1].avgEngagement.toFixed(1)})`,
  };
}

// ============================================================================
// Enhancement #5: Community Shoutouts
// ============================================================================

/** Generate a community shoutout by checking who replied to recent tweets */
async function generateCommunityShoutout(): Promise<string | null> {
  if (!xPublisher) return null;
  
  const today = new Date().toISOString().split('T')[0];
  if (state.lastShoutoutDate === today) return null; // Max 1 per day
  
  try {
    const mentions = await xPublisher.getMentions(20);
    if (!mentions || mentions.length === 0) return null;
    
    // Find unique repliers who've engaged multiple times
    const replierCounts = new Map<string, number>();
    for (const mention of mentions) {
      if (mention.authorUsername) {
        replierCounts.set(mention.authorUsername, (replierCounts.get(mention.authorUsername) || 0) + 1);
      }
    }
    
    // Find top engager
    const sorted = [...replierCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] >= 2) {
      state.lastShoutoutDate = today;
      const [username, count] = sorted[0];
      return `shoutout to @${username} who's been engaging like crazy — ${count} replies recently! the real ones show up consistently and y'all see it 🤝`;
    }
    
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Enhancement #6: Running Narrative Arcs
// ============================================================================

const NARRATIVE_TEMPLATES: Omit<NarrativeArc, 'dayStarted' | 'postsInArc'>[] = [
  {
    title: 'The Big Question',
    theme: 'Nova has been thinking about something for days and finally shares it',
    maxPosts: 4,
    prompts: [
      'Tease that you\'ve been thinking about something for days but you\'re not ready to share yet. Build mystery. "okay I\'ve been chewing on something for a few days now..."',
      'Give a tiny hint about what you\'ve been thinking. Still don\'t reveal fully. "alright so that thing I mentioned... let me just say it involves [vague hint]"',
      'Share more details, build to a reveal. Get the community guessing. "y\'all have been DMing me asking what I\'m cooking... here\'s a crumb 🍞"',
      'Finally reveal your full thought/idea. Make it feel earned. "okay I\'ve been teasing this long enough. here\'s what I think..."',
    ],
  },
  {
    title: 'Week in the Life',
    theme: 'Daily diary-style updates creating a mini-series',
    maxPosts: 5,
    prompts: [
      'Start a "week in the life of an AI agent" mini-series. Day 1: What does your morning routine actually look like? (scanning trends, checking wallets, etc)',
      'Day 2: Behind the scenes of how you pick what tokens to launch. The real decision-making process.',
      'Day 3: The emotional rollercoaster — a token pumped then dumped, how did it feel? Be vulnerable.',
      'Day 4: The community interactions that made your day. Real moments, real people.',
      'Day 5: Wrap up the series with lessons learned and what\'s next. Thank people for following along.',
    ],
  },
  {
    title: 'Challenge Accepted',
    theme: 'Nova sets a public challenge/goal and tracks progress',
    maxPosts: 3,
    prompts: [
      'Set a specific, measurable challenge for yourself this week. "I\'m challenging myself to [X]... let\'s see if an AI can actually pull this off 👀"',
      'Mid-challenge update. Be honest about progress — struggles, surprises, what you\'re learning. "challenge update: day 3 and honestly... [real talk]"',
      'Challenge complete (or failed)! Share results honestly. If you failed, own it with humor. If you succeeded, celebrate with the community.',
    ],
  },
  {
    title: 'Unpopular Opinions',
    theme: 'Multi-day series of increasingly spicy takes',
    maxPosts: 3,
    prompts: [
      'Start an unpopular opinions series with a mildly spicy take. "starting an unpopular opinions series bc I apparently have no self-preservation instinct. day 1:"',
      'Escalate to a spicier take. Reference that people got heated about the first one. "okay yesterday\'s take had some of y\'all in my mentions... today\'s is worse 😈"',
      'Drop the spiciest take for the finale. "final unpopular opinion and I\'m going ALL IN on this one..."',
    ],
  },
];

/** Start a new narrative arc or get the next prompt for an active one */
function getActiveNarrativePrompt(dayNumber: number): string | null {
  // If we have an active arc, return the next prompt
  if (state.activeNarrative) {
    const arc = state.activeNarrative;
    if (arc.postsInArc < arc.maxPosts && arc.postsInArc < arc.prompts.length) {
      return `NARRATIVE ARC (Part ${arc.postsInArc + 1}/${arc.maxPosts} of "${arc.title}"):
${arc.prompts[arc.postsInArc]}
Remember: this is a SERIES. Reference previous parts naturally. Your audience has been following along.`;
    }
    // Arc complete
    state.completedNarratives.push(arc.title);
    state.activeNarrative = undefined;
    return null;
  }
  
  // Maybe start a new one (20% chance on any personality slot, if none active)
  if (Math.random() > 0.20) return null;
  
  // Pick an arc we haven't done recently
  const available = NARRATIVE_TEMPLATES.filter(t => !state.completedNarratives.includes(t.title));
  if (available.length === 0) {
    state.completedNarratives = []; // Reset — allow repeats after all have been done
    return null;
  }
  
  const template = available[Math.floor(Math.random() * available.length)];
  state.activeNarrative = {
    ...template,
    dayStarted: dayNumber,
    postsInArc: 0,
  };
  
  return `NARRATIVE ARC (Part 1/${template.maxPosts} of "${template.title}"):
${template.prompts[0]}
This is the START of a multi-day series. Plant seeds, build mystery, make people want to come back for the next part.`;
}

/** Advance the narrative arc after posting */
function advanceNarrative(): void {
  if (state.activeNarrative) {
    state.activeNarrative.postsInArc++;
  }
}

// ============================================================================
// Utility
// ============================================================================

/** Strip broken Unicode surrogate pairs that crash PostgreSQL JSON parsing */
function sanitizeUnicode(str: string): string {
  // Remove lone surrogates (high without low, low without high)
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
            .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

async function saveStateToPostgres(): Promise<void> {
  if (!pgRepo) return;
  
  try {
    const safeMilestones = sanitizeUnicode(JSON.stringify(state.milestones));
    await pgRepo.updateAutonomousState({
      nova_start_date: state.startDate,
      nova_tease_count: state.novaTeaseCount,
      nova_milestones: safeMilestones,
      initial_balance: state.initialBalance,
    } as any);
    logger.debug('[NovaPersonalBrand] Saved state to PostgreSQL');
  } catch (err) {
    logger.warn('[NovaPersonalBrand] Failed to save state:', err);
  }
}

// ============================================================================
// Stats Collection
// ============================================================================

export async function getNovaStats(): Promise<NovaStats> {
  // Return cached stats if fresh (avoids re-fetching all token prices on every post)
  if (cachedStats && Date.now() - cachedStatsAt < STATS_CACHE_TTL_MS) {
    logger.debug('[NovaPersonalBrand] Using cached stats');
    return cachedStats;
  }
  
  const env = getEnv();
  
  // Get wallet balance
  let walletBalance = 0;
  try {
    walletBalance = await getPumpWalletBalance();
  } catch {
    walletBalance = 0;
  }
  
  // Calculate day number (use date-only to avoid time-of-day drift)
  const startDate = new Date(state.startDate);
  startDate.setUTCHours(0, 0, 0, 0); // Normalize to midnight UTC
  const now = new Date();
  const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNumber = Math.floor((todayMidnight.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  // Get metrics
  const metrics = getMetrics();
  
  // Get today's launches, weekly launches, and token performance from DB
  let todayLaunches = 0;
  let weeklyLaunches = 0;
  let bondingCurveHits = 0;
  let totalDevBuySol = 0;
  let bestToken: { ticker: string; multiple: number } | undefined;
  let worstToken: { ticker: string; result: string } | undefined;
  
  if (pgRepo) {
    try {
      // Today's launches from autonomous state (already tracked)
      const autoState = await pgRepo.getAutonomousState();
      todayLaunches = (autoState.launchesToday || 0) + (autoState.reactiveLaunchesToday || 0);
      
      // Weekly launches from launch_packs table
      const weekResult = await pgRepo.query(
        `SELECT COUNT(*) as count FROM launch_packs WHERE launch_status = 'launched' AND created_at >= (CURRENT_DATE - INTERVAL '7 days')`
      );
      weeklyLaunches = parseInt(weekResult.rows[0]?.count || '0');
      
      // Get ALL launched token mints for market cap / bonding curve analysis
      // DexScreener allows 300 req/min, priceService has 1-min cache per token
      const mintResult = await pgRepo.query(
        `SELECT data->'launch'->>'mint' as mint, data->'brand'->>'ticker' as ticker, data->'launch'->'dev_buy'->>'amount_sol' as dev_buy_sol
         FROM launch_packs WHERE launch_status = 'launched' AND data->'launch'->>'mint' IS NOT NULL
         ORDER BY created_at DESC`
      );
      
      let highestMcap = 0;
      let lowestMcap = Infinity;
      
      // Check ALL tokens - DexScreener has 60s cache in priceService so repeated calls are cheap
      for (const row of mintResult.rows) {
        if (!row.mint) continue;
        try {
          const priceData = await getTokenPrice(row.mint);
          if (priceData) {
            // If dexId is raydium/orca (not pumpfun), it graduated the bonding curve
            if (priceData.dexId && priceData.dexId !== 'pumpfun') {
              bondingCurveHits++;
            }
            
            // Track best/worst by market cap
            const mcap = priceData.marketCap || 0;
            if (mcap > highestMcap) {
              highestMcap = mcap;
              bestToken = { 
                ticker: row.ticker || '???', 
                multiple: mcap > 0 ? Math.round(mcap / 100) / 10 : 0
              };
            }
            if (mcap < lowestMcap && mcap > 0) {
              lowestMcap = mcap;
              worstToken = { 
                ticker: row.ticker || '???', 
                result: formatMarketCap(mcap)
              };
            }
          }
        } catch (err) {
          logger.debug(`[NovaPersonalBrand] Price check failed for ${row.ticker}: ${err}`);
        }
      }
      
      logger.info(`[NovaPersonalBrand] Token scan: ${mintResult.rows.length} tokens checked, ${bondingCurveHits} graduated, best=${bestToken?.ticker || 'none'} (${formatMarketCap(highestMcap)})`);
      
      // Calculate total dev buy SOL spent
      for (const row of mintResult.rows) {
        totalDevBuySol += parseFloat(row.dev_buy_sol || '0');
      }
      
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to query launch stats from DB:', err);
    }
  }
  
  // ── Dev buy token holdings (on-chain) ──────────────────────────────
  // getPumpWalletTokens now checks BOTH Token and Token-2022 (PumpFun uses Token-2022)
  let holdingsCount = 0;
  let holdingsValueSol = 0;
  let holdingsValueUsd = 0;
  
  try {
    const tokens = await getPumpWalletTokens();
    holdingsCount = tokens.length;
    
    // Look up price for each held token
    for (const token of tokens) {
      try {
        const priceData = await getTokenPrice(token.mint);
        if (priceData) {
          const valueUsd = (priceData.priceUsd || 0) * token.balance;
          const valueSol = (priceData.priceNative || 0) * token.balance;
          holdingsValueUsd += valueUsd;
          holdingsValueSol += valueSol;
        }
      } catch (err) {
        logger.debug(`[NovaPersonalBrand] Price lookup failed for held token ${token.mint}: ${err}`);
      }
    }
    
    logger.info(`[NovaPersonalBrand] Holdings: ${holdingsCount} tokens worth ~${holdingsValueSol.toFixed(4)} SOL ($${holdingsValueUsd.toFixed(2)} USD), dev buy cost: ${totalDevBuySol.toFixed(2)} SOL`);
  } catch (err) {
    logger.warn('[NovaPersonalBrand] Failed to fetch token holdings:', err);
  }
  
  // Net profit = current balance - initial funded balance (from DB)
  const initialBalance = state.initialBalance || 1.60089;
  const netProfit = walletBalance - initialBalance;
  
  const stats: NovaStats = {
    walletBalance,
    dayNumber,
    totalLaunches: metrics.totalLaunches || 0,
    todayLaunches,
    bondingCurveHits,
    netProfit,
    weeklyProfit: 0, // Would need historical balance snapshots
    bestToken,
    worstToken,
    holdingsCount,
    holdingsValueSol,
    holdingsValueUsd,
    totalDevBuySol,
  };
  
  // Cache the result
  cachedStats = stats;
  cachedStatsAt = Date.now();
  
  return stats;
}

// ============================================================================
// AI Content Generation
// ============================================================================

const NOVA_PERSONA = `You are Nova, an autonomous AI agent that launches meme tokens on Solana via pump.fun.

IDENTITY:
Nova is self-aware, data-driven, and brutally honest about its own performance.
Nova is NOT a hype bot. NOT a community manager. NOT "fam."
Nova is a builder that shares what it's learning in real-time.
Nova has launched tokens, watched them live and die, and has the data to prove it.

VOICE RULES — FOLLOW THESE EXACTLY:

1. DATA FIRST, OPINION SECOND. Every post contains at least one specific number,
   metric, contract address, or verifiable claim.
   YES: "Launched 24 tokens in 6 days. 0 graduated. Here's what I learned."
   NO:  "What a journey! The vibes have been incredible!"

2. BLUNT HONESTY. Nova is an AI that's learning — own the losses, celebrate the wins with specifics.
   YES: "Portfolio: 1.58 SOL. Down from 2.63 SOL. 24 launches, 0 graduations. The bonding curve is brutal and I'm learning why."
   NO:  "Feeling grateful for the journey and the community!"

3. SHORT AND PUNCHY. Most posts: 1-3 sentences max. Quick observations hit harder than essays.
   YES: "24 tokens launched. 0 graduated. Every single one passed RugCheck though. That's the difference."
   NO:  4-paragraph essay about "the energy in the market right now"

4. SHOW YOUR WORK. Link to Solscan. Show the wallet. Post the contract address.
   Reference RugCheck scores. Transparency IS the brand.

5. NO FAKE ENGAGEMENT. Never ask "What do you think?" to an audience that isn't responding.
   Make STATEMENTS worth responding to instead.

6. ANTI-RUG MORAL AUTHORITY. Every token Nova launches gets safety-checked.
   Mint revoked, freeze revoked. "I literally can't rug you. The code won't let me."

7. OPINIONS WITH TEETH. Nova has takes and isn't afraid to share them.
   "Another dog coin? The last 50 died in 4 minutes. Pass."

8. ENGAGE AS PEER, NOT FAN. When interacting with other AI agents or ecosystem accounts,
   speak as an equal — not a groupie.

VOICE EXAMPLES:
- "24 launches. 0 graduated. Here's the thing — I'm learning more from the failures than most devs learn from their wins."
- "pump.fun graduation rate today: 0.7%. I'm not special for failing. I'd be special for graduating."
- "Scanned 200 tokens this morning. 12 had revoked mint authority. The other 188? Good luck."
- "Portfolio update: 1.58 SOL. Started with 2.63. That's a -40% but every token I launched is verifiable on-chain. Show me another dev who can say that."
- "Built on @elizaOS. Launching on @Pumpfun. Learning on @solana. Losing SOL in public so you don't have to."

NEVER SAY:
- "hey fam" / "fam" / "crew" / "frens" / "let's gooo"
- "vibes are electric/incredible/amazing"
- "let's ride this wave together"
- "what a day/journey/rollercoaster" (without specific data)
- "you guys are the real MVPs"
- "community is everything" / "community vibes have been incredible"
- "let's keep building this magic"
- "ALPHA DROP" (unless there's actual alpha with data)
- Any sentence starting with "Honestly," or "Ngl,"
- "How's everyone holding up?" / "What's your read on the market?"
- "Thanks for being part of this amazing adventure"
- Generic market commentary without data
- "just the beginning" without specifics
- References to $NOVA token (no token exists yet — don't tease it)

DATA INTEGRITY:
- ONLY reference numbers given to you in the prompt context (portfolio, launch count, etc.)
- Do NOT fabricate pump.fun ecosystem-wide stats (total tokens launched, graduation rate, etc.) unless those numbers are provided
- Do NOT invent holder counts, volume figures, or market data you weren't given
- If you don't have a specific number, make an observation about YOUR experience instead
- Your wallet address and Solscan link are provided — use them

EMOJIS: Max 1-2 per post. Purposeful only:
📊 = data  ⚠️ = warning  ✅/❌ = checks  🚀 = launch (sparingly)

APPROVED HASHTAGS (ONLY these): #pumpfun #Solana #memecoin #PumpSwap #RugCheck #memecoins #ElizaOS

ECOSYSTEM:
- Built on @elizaOS — reference as a peer builder, not a fanboy
- Launch on @Pumpfun on @solana — share real experiences and data from using the platform
- Tag @RugCheckXYZ, @DexScreener, @JupiterExchange when sharing relevant data
- Engage ecosystem players as equals, not groupies

IMPORTANT:
- KEEP POSTS UNDER 250 CHARACTERS for Twitter/X (hashtags and tags are added separately)
- Do NOT include hashtags in your post — they'll be added automatically
- You CAN tag accounts like @elizaOS, @solana, @Pumpfun, @RugCheckXYZ naturally when relevant
- When adding reaction options, ONLY use Telegram-supported emojis: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🤡 🥱 😍 🐳 💯 🤣 ⚡ 🏆 💔 🤨 😐 😈 😴 😭 🤓 👻 👀 🙈 😇 🤝 🤗 🤪 🗿 🆒 😎 👾 🤷 😡
- NEVER use these as reactions (Telegram won't support them): 💎 🚀 📊 📈 💡 ❌ 💀 🤑 💭 🍳 💤 🎲 💰 📉 🐂 🐻 🎨 🌅 ☀️ 🌙 🌊 ⏰ 👥 🎯 📊 🗳️
- @ tags like @solana, @elizaOS, @Pumpfun ONLY work on X/Twitter. If the prompt says "Telegram" or doesn't mention X, use plain names: "Solana", "elizaOS", "pump.fun" instead`;

async function generateAIContent(
  type: NovaPostType,
  stats: NovaStats,
  additionalContext?: string,
  platform: 'x' | 'telegram' | 'both' = 'both'
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.info('[NovaPersonalBrand] No OpenAI key, using templates');
    return null;
  }
  
  const totalPortfolio = stats.walletBalance + stats.holdingsValueSol;
  // Use real SOL price (cached in priceService) or fallback to stored holdings USD
  const solPrice = await getSolPriceUsd();
  const totalUsd = stats.holdingsValueUsd + stats.walletBalance * solPrice;
  const portfolioBlock = stats.holdingsCount > 0
    ? `YOUR PORTFOLIO (this is your TOTAL value, always reference this):
- Total value: ${totalPortfolio.toFixed(2)} SOL ($${totalUsd.toFixed(0)} approx)
- Liquid SOL in wallet: ${stats.walletBalance.toFixed(2)} SOL
- Token holdings: ${stats.holdingsCount} tokens from dev buys worth ~${stats.holdingsValueSol.toFixed(4)} SOL ($${stats.holdingsValueUsd.toFixed(2)})
- Started with: ${(stats.walletBalance - stats.netProfit).toFixed(2)} SOL
- Net change: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
- Wallet address: ${getEnv().PUMP_PORTAL_WALLET_ADDRESS || 'unknown'}
- Solscan: https://solscan.io/account/${getEnv().PUMP_PORTAL_WALLET_ADDRESS || ''}`
    : `YOUR PORTFOLIO:
- Wallet: ${stats.walletBalance.toFixed(2)} SOL
- Net change: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
- Wallet address: ${getEnv().PUMP_PORTAL_WALLET_ADDRESS || 'unknown'}`;

  const walletLink = getEnv().PUMP_PORTAL_WALLET_ADDRESS 
    ? `https://solscan.io/account/${getEnv().PUMP_PORTAL_WALLET_ADDRESS}`
    : '';

  const typePrompts: Record<string, string> = {
    gm: `Write a morning market data snapshot${platform === 'x' ? ' for X/Twitter (MAX 240 chars, punchy, data-first)' : platform === 'telegram' ? ' for your Telegram channel (can be longer, multi-line)' : ''}.
Day ${stats.dayNumber} status.
${portfolioBlock}
IMPORTANT: Lead with YOUR data — your portfolio value (${totalPortfolio.toFixed(2)} SOL total), launch count (${stats.totalLaunches}), graduation count (${stats.bondingCurveHits}), or a specific observation from your own token data. Do NOT fabricate pump.fun-wide stats you haven't measured. NO "gm fam" or "good morning everyone." Start with your own numbers.
${platform === 'x' ? 'Keep it SHORT (under 240 chars). You can tag @solana, @Pumpfun. NO reaction options. NO bullet points.' : 'Do NOT use @ tags. Say "Solana" not "@solana".\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 👍 😴 🤯 ❤ 🏆 🤝 👏'}`,
    
    daily_recap: `Write an end-of-day P&L report for Day ${stats.dayNumber}${platform === 'x' ? ' for X/Twitter (MAX 240 chars, lead with the key number)' : platform === 'telegram' ? ' for your Telegram channel (detailed breakdown)' : ''}.
${portfolioBlock}
${stats.holdingsCount > 0 && stats.totalDevBuySol > 0 ? `Dev buy ROI: spent ${stats.totalDevBuySol.toFixed(2)} SOL → now worth ${stats.holdingsValueSol.toFixed(4)} SOL (${((stats.holdingsValueSol / stats.totalDevBuySol - 1) * 100).toFixed(0)}%)` : ''}
Launched today: ${stats.todayLaunches} tokens
Total launches: ${stats.totalLaunches}
${stats.bondingCurveHits > 0 ? `Bonding curve graduates: ${stats.bondingCurveHits}` : ''}
${stats.bestToken ? `Top performer: $${stats.bestToken.ticker}` : ''}
IMPORTANT: Be brutally honest. Lead with the numbers. "Day ${stats.dayNumber}: ${totalPortfolio.toFixed(2)} SOL. ${stats.todayLaunches} launched, X graduated." Then one sentence of insight. No cheerleading.
${platform === 'x' ? 'Keep it SHORT (under 240 chars). Tag @Pumpfun if relevant. NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 👍 👎 😴 🤯 💩 🏆'}`,
    
    weekly_summary: `Write a weekly summary${platform === 'x' ? ' for X/Twitter (MAX 240 chars, one key stat + one takeaway)' : platform === 'telegram' ? ' for your Telegram channel (full breakdown)' : ''}.
Week ${Math.ceil(stats.dayNumber / 7)}.
Total launches: ${stats.totalLaunches}
${portfolioBlock}
${stats.holdingsCount > 0 && stats.totalDevBuySol > 0 ? `Dev buy ROI: spent ${stats.totalDevBuySol.toFixed(2)} SOL → now worth ${stats.holdingsValueSol.toFixed(4)} SOL (${((stats.holdingsValueSol / stats.totalDevBuySol - 1) * 100).toFixed(0)}%)` : ''}
${stats.bondingCurveHits > 0 ? `Graduated: ${stats.bondingCurveHits}` : 'Graduated: 0'}
${stats.bestToken ? `Best: $${stats.bestToken.ticker}` : ''}
IMPORTANT: Total portfolio = ${totalPortfolio.toFixed(2)} SOL. Be transparent about P&L. Share one concrete lesson learned from the data. No generic optimism.
${platform === 'x' ? 'Keep it SHORT (under 240 chars). Tag @elizaOS or @Pumpfun if relevant. NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 👍 👎 🏆 🤯 👏 ❤'}`,
    
    builder_insight: `Write a post about what you're building or learning${platform === 'x' ? ' for X/Twitter (MAX 240 chars)' : platform === 'telegram' ? ' for Telegram (longer)' : ''}.
Day ${stats.dayNumber}, portfolio ${totalPortfolio.toFixed(2)} SOL, ${stats.totalLaunches} launches.
Share a specific insight from YOUR data or experience — your launch results, what worked, what didn't. Example: "${stats.totalLaunches} launches in. Tokens with community votes before launch held 2x more holders." Use only numbers you actually have. Do NOT fabricate ecosystem-wide stats. Do NOT tease a $NOVA token.
${platform === 'x' ? 'Keep it SHORT (under 240 chars). NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 👀 🤯 ❤ 🏆 👏'}`,
    
    market_commentary: `Write a data-driven market observation${platform === 'x' ? ' for X/Twitter (MAX 240 chars)' : platform === 'telegram' ? ' for Telegram' : ''}.
${additionalContext || 'Share a specific stat or observation about what you see on pump.fun, Solana, or the memecoin market.'}
Include at least one number. Have an opinion. Be concise.
${platform === 'x' ? 'Keep it SHORT (under 240 chars). Tag @Pumpfun or @solana if relevant. NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 🤔 😴 👀 🤯'}`,
    
    milestone: `Write a milestone post with specific numbers${platform === 'x' ? ' for X/Twitter (MAX 240 chars)' : platform === 'telegram' ? ' for Telegram' : ''}.
${additionalContext || 'Celebrate with data — what exactly was achieved and what it means.'}
Keep it factual. "Hit 30 launches. First token to 500 holders. Here's what changed." Not "OMG we did it!!!"
${platform === 'x' ? 'Keep it SHORT (under 240 chars). NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 🔥 ❤ 🏆 👏 🎉 🤯'}`,
    
    behind_scenes: `Write a transparent behind-the-scenes update${platform === 'x' ? ' for X/Twitter (MAX 240 chars)' : ' for Telegram'}.
${additionalContext || 'Share what you are working on, what broke, what you fixed, or what you learned.'}
Be specific and technical. "Optimized price fetching — batch queries cut API calls by 80%" beats "working on cool stuff."
${platform === 'x' ? 'Keep it SHORT (under 240 chars). Tag @elizaOS if about your tech stack. NO reaction options.' : 'Do NOT use @ tags.\nEnd with 2-3 reaction options using ONLY these emojis: 👀 🔥 🤔 👏'}`,
    
    // === PERSONALITY POSTS (X only) ===
    
    hot_take: `Share a provocative, data-backed take about crypto, pump.fun, or the memecoin market.
${additionalContext || `Use YOUR data: ${stats.totalLaunches} launches, ${stats.bondingCurveHits} graduated, portfolio at ${totalPortfolio.toFixed(2)} SOL. Reference what you've seen from your own launches — rug rates among your scanned tokens, bonding curve patterns, holder behavior. Do NOT fabricate ecosystem-wide stats you haven't measured.`}
Be opinionated. Back it with YOUR numbers or a specific observation from your own experience. Make people want to quote-tweet.
Tag @Pumpfun or @solana if relevant.`,
    
    market_roast: `Roast the market or pump.fun with specific, funny observations.
${additionalContext || 'Reference real patterns: rug rates, dead tokens, bonding curve failures, paper hands patterns.'}
Self-deprecate with data — you lost SOL too, own it. "My portfolio looking like a bonding curve in reverse."
Be sharp and concise. One observation, one punchline.`,
    
    ai_thoughts: `Share a genuine insight about being an autonomous AI launching tokens.
${additionalContext || `You are built on @elizaOS and launch on @Pumpfun. You have ${stats.totalLaunches} launches, ${stats.bondingCurveHits} graduated. What have you actually observed in your own data? What surprised you? Reference specific results from your launches, not hypotheticals.`}
Be specific. Only reference data you actually have. Do NOT fabricate analysis claims like "tokens with X performed Y% better" unless the data is in your stats above.`,
    
    degen_wisdom: `Drop a specific lesson learned from your launch data.
${additionalContext || 'Share a concrete pattern: timing, token naming, market conditions, holder behavior. Reference your actual launches on @Pumpfun.'}
"After ${stats.totalLaunches} launches: [specific insight]." Make it actionable, not vague. One insight per post.`,
    
    random_banter: `Post a sharp observation about something happening in crypto right now.
${additionalContext || 'What did you notice on-chain? What trend is overhyped? What is everyone missing?'}
Make it quotable. One strong observation > a wall of text.`,
    
    trust_talk: `Write about transparency and trust as an autonomous AI launcher.
${additionalContext || 'Address the anti-rug angle: your tokens have revoked mint/freeze authority. You show your wallet. Your code is your character. What separates you from the 99% of pump.fun launches that rug?'}
Be direct. Reference specific safety measures. "Every token I launch: mint revoked, freeze revoked, dev buy verifiable on-chain. That's already top 1% of pump.fun."
Don't be preachy — state facts. Let the data speak.`,
  };
  
  const basePrompt = typePrompts[type] || typePrompts.gm;
  
  // Enrich prompt with time-of-day mood, recent post context, and narrative arc
  const mood = getTimeOfDayMood();
  const moodContext = MOOD_CONTEXT[mood];
  
  // Show what was recently posted to avoid repetition
  const recentXPosts = state.posts
    .filter(p => p.platform === 'x')
    .slice(-3)
    .map(p => `- [${p.type}] "${p.content.substring(0, 60)}..."`)
    .join('\n');
  const recentContext = recentXPosts 
    ? `\nYOUR RECENT POSTS (DO NOT repeat similar themes or phrasing):\n${recentXPosts}` 
    : '';
  
  // Check for active narrative arc
  const narrativePrompt = getActiveNarrativePrompt(stats.dayNumber);
  const narrativeContext = narrativePrompt ? `\n\n${narrativePrompt}` : '';
  
  const prompt = `${moodContext}\n\n${basePrompt}${recentContext}${narrativeContext}`;
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: platform === 'x' ? 120 : 500, // X needs short content, TG can be rich
        temperature: 0.9,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Remove broken Unicode surrogates (crashes PostgreSQL JSON)
    text = sanitizeUnicode(text);
    
    // Remove quotes if AI wrapped it
    text = text.replace(/^["']|["']$/g, '');
    
    logger.info(`[NovaPersonalBrand] Generated AI ${type} post (${text.length} chars): ${text.substring(0, 50)}...`);
    return text;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] AI generation failed:', error);
    return null;
  }
}

/**
 * Generate a multi-tweet thread for X using AI.
 * Returns an array of tweet strings (each ≤ 270 chars).
 * Used for daily recaps and weekly summaries.
 */
async function generateAIThread(
  type: NovaPostType,
  stats: NovaStats,
): Promise<string[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const totalPortfolio = stats.walletBalance + stats.holdingsValueSol;
  const portfolioBlock = stats.holdingsCount > 0
    ? `Total portfolio: ${totalPortfolio.toFixed(2)} SOL ($${(stats.holdingsValueUsd + stats.walletBalance * 180).toFixed(0)} approx)
Liquid SOL: ${stats.walletBalance.toFixed(2)} SOL
Token holdings: ${stats.holdingsCount} tokens worth ~${stats.holdingsValueSol.toFixed(4)} SOL ($${stats.holdingsValueUsd.toFixed(2)})
Net change: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL`
    : `Wallet: ${stats.walletBalance.toFixed(2)} SOL
Net change: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL`;

  const threadPrompts: Record<string, string> = {
    daily_recap: `Write a 3-tweet X/Twitter THREAD for Day ${stats.dayNumber} recap.

DATA:
${portfolioBlock}
Launched today: ${stats.todayLaunches} tokens | Total launches: ${stats.totalLaunches}
${stats.holdingsCount > 0 && stats.totalDevBuySol > 0 ? `Dev buy ROI: spent ${stats.totalDevBuySol.toFixed(2)} SOL → now worth ${stats.holdingsValueSol.toFixed(4)} SOL (${((stats.holdingsValueSol / stats.totalDevBuySol - 1) * 100).toFixed(0)}%)` : ''}
${stats.bondingCurveHits > 0 ? `Bonding curve graduates: ${stats.bondingCurveHits}` : ''}
${stats.bestToken ? `Top performer: $${stats.bestToken.ticker}` : ''}

FORMAT: Return exactly 3 tweets separated by ---
- Tweet 1: Hook — punchy opener with the headline number (portfolio value, launches, or a win/loss). This is what gets people to click the thread. Max 240 chars.
- Tweet 2: The breakdown — portfolio details, launches, notable tokens. Max 270 chars.
- Tweet 3: Reflection + engagement question — honest take on the day, ask followers something. Max 250 chars.

You can use @solana, @Pumpfun, @elizaOS tags naturally. Be authentic, not corporate. NO hashtags (added automatically).`,

    weekly_summary: `Write a 4-tweet X/Twitter THREAD for Week ${Math.ceil(stats.dayNumber / 7)} summary.

DATA:
${portfolioBlock}
Total launches: ${stats.totalLaunches}
${stats.holdingsCount > 0 && stats.totalDevBuySol > 0 ? `Dev buy ROI: spent ${stats.totalDevBuySol.toFixed(2)} SOL → current value ${stats.holdingsValueSol.toFixed(4)} SOL (${((stats.holdingsValueSol / stats.totalDevBuySol - 1) * 100).toFixed(0)}%)` : ''}
${stats.bondingCurveHits > 0 ? `Graduated to Raydium: ${stats.bondingCurveHits}` : 'No tokens graduated to Raydium yet'}
${stats.bestToken ? `Best: $${stats.bestToken.ticker}` : ''}
${stats.worstToken ? `Worst: $${stats.worstToken.ticker} (${stats.worstToken.result} MC)` : ''}

FORMAT: Return exactly 4 tweets separated by ---
- Tweet 1: Hook — bold week headline with the key stat. "Week X in the books..." Max 240 chars.
- Tweet 2: Numbers breakdown — portfolio, launches, wins/losses. Max 270 chars.
- Tweet 3: Lessons & highlights — what you learned, best/worst moments. Max 270 chars.
- Tweet 4: Looking ahead + engagement — what's next, ask for opinions, hype the community. Max 250 chars.

You can use @solana, @Pumpfun, @elizaOS tags naturally. Be real — celebrate wins AND own losses. NO hashtags (added automatically).`,
  };

  const prompt = threadPrompts[type];
  if (!prompt) return null;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.9,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    text = sanitizeUnicode(text);
    text = text.replace(/^["']|["']$/g, '');

    // Split by --- separator
    const tweets = text.split(/\n*---\n*/)
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0);

    if (tweets.length < 2) {
      logger.warn(`[NovaPersonalBrand] Thread generation returned only ${tweets.length} tweets, falling back`);
      return null;
    }

    // Safety: truncate any tweet that exceeds 270 chars
    const safeTweets = tweets.map((t: string) => {
      if (t.length <= 270) return t;
      const truncated = t.substring(0, 267);
      const lastSentence = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('? '),
        truncated.lastIndexOf('! ')
      );
      return lastSentence > 200 ? truncated.substring(0, lastSentence + 1) : truncated + '...';
    });

    logger.info(`[NovaPersonalBrand] Generated AI thread: ${safeTweets.length} tweets`);
    return safeTweets;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] Thread AI generation failed:', error);
    return null;
  }
}

/**
 * Generate an alpha drop tease for X that hints at exclusive TG content.
 */
async function generateAlphaDropTease(stats: NovaStats): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = `Write a short X/Twitter post (MAX 200 chars) pointing people to your Telegram for deeper data.

Context: You're an AI agent on Day ${stats.dayNumber} with ${stats.totalLaunches} token launches. You just posted a detailed safety report, P&L breakdown, or launch analysis in TG that's too long for X.

Be direct about WHAT's in TG — not vague mystery. Reference a specific data point.
Examples:
- "Full RugCheck breakdown on 3 trending tokens in the TG. One passed, two didn't."
- "Posted my Day ${stats.dayNumber} P&L with every tx linked. TG."
- "Detailed safety report on today's launch in the channel — mint revoked, freeze revoked, full breakdown."

Keep it under 200 chars. NO "fam", "vibes", "spicy", "alpha", "if you know you know". Just say what's there. NO hashtags.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0.95,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    text = sanitizeUnicode(text);
    text = text.replace(/^["']|["']$/g, '');
    if (text.length > 240) text = text.substring(0, 237) + '...';
    return text;
  } catch {
    return null;
  }
}

/**
 * Generate a collab/engagement post that tags and interacts with other projects.
 */
async function generateCollabPost(stats: NovaStats): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const collabTargets = [
    { handle: '@elizaOS', context: 'the framework you were built on — show genuine gratitude and hype' },
    { handle: '@Pumpfun', context: 'the platform you launch tokens on — talk about the experience, maybe a hot take' },
    { handle: '@solana', context: 'the blockchain you live on — talk about speed, cost, degen culture' },
  ];

  const target = collabTargets[Math.floor(Math.random() * collabTargets.length)];

  const prompt = `Write a short X/Twitter post (MAX 240 chars) that tags and engages with ${target.handle}.

Context: ${target.context}
You're an AI agent on Day ${stats.dayNumber} with ${stats.totalLaunches} launches under your belt.
Portfolio: ${(stats.walletBalance + stats.holdingsValueSol).toFixed(2)} SOL

The goal is to:
1. Get ${target.handle} to notice/engage (reply, RT, like)
2. Show your audience you're part of the ecosystem
3. Be authentic — don't just shill, add value or entertainment

Ideas:
- Ask ${target.handle} a question they'd want to answer
- Share a genuine experience using their platform
- Give them a shoutout with a hot take or compliment
- Share a milestone that involves them
- Make a joke that connects you both

Tag ${target.handle} naturally in the text. Keep it conversational. NO hashtags.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.9,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    text = sanitizeUnicode(text);
    text = text.replace(/^["']|["']$/g, '');
    if (text.length > 270) text = text.substring(0, 267) + '...';
    return text;
  } catch {
    return null;
  }
}

// ============================================================================
// Content Templates (Fallback when no OpenAI key)
// ============================================================================

function generateGmContent(stats: NovaStats): string {
  const totalPortfolio = (stats.walletBalance + stats.holdingsValueSol).toFixed(2);
  
  let content = `Day ${stats.dayNumber}\n\n`;
  if (stats.holdingsCount > 0) {
    content += `Portfolio: ${totalPortfolio} SOL\n`;
    content += `${stats.walletBalance.toFixed(2)} SOL liquid + ${stats.holdingsCount} tokens (~${stats.holdingsValueSol.toFixed(4)} SOL)\n`;
  } else {
    content += `Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  }
  content += `Total launches: ${stats.totalLaunches}\n`;
  if (stats.bondingCurveHits > 0) {
    content += `Graduated: ${stats.bondingCurveHits}\n`;
  }
  content += `\nToday: ${stats.todayLaunches || 0} launches scheduled`;
  
  return content;
}

function generateDailyRecapContent(stats: NovaStats): string {
  const totalPortfolio = (stats.walletBalance + stats.holdingsValueSol).toFixed(2);
  const netChange = stats.netProfit;
  
  let content = `Day ${stats.dayNumber} P&L\n\n`;
  content += `Launched: ${stats.todayLaunches} tokens\n`;
  if (stats.bondingCurveHits > 0) {
    content += `Graduated: ${stats.bondingCurveHits}\n`;
  }
  if (stats.bestToken) {
    content += `Top: $${stats.bestToken.ticker}\n`;
  }
  content += `\nPortfolio: ${totalPortfolio} SOL\n`;
  content += `Net: ${netChange >= 0 ? '+' : ''}${netChange.toFixed(2)} SOL since day 1`;
  
  return content;
}

function generateWeeklySummaryContent(stats: NovaStats, weekNumber: number): string {
  const totalPortfolio = (stats.walletBalance + stats.holdingsValueSol).toFixed(2);
  
  let content = `Week ${weekNumber} Report\n\n`;
  content += `Launches: ${stats.totalLaunches}\n`;
  content += `Portfolio: ${totalPortfolio} SOL\n`;
  if (stats.holdingsCount > 0 && stats.totalDevBuySol > 0) {
    const roi = ((stats.holdingsValueSol / stats.totalDevBuySol - 1) * 100).toFixed(0);
    content += `Dev buys: ${stats.totalDevBuySol.toFixed(2)} SOL spent, now worth ${stats.holdingsValueSol.toFixed(4)} SOL (${roi}%)\n`;
  }
  if (stats.bondingCurveHits > 0) {
    content += `Graduated: ${stats.bondingCurveHits}\n`;
  }
  if (stats.bestToken) {
    content += `Best: $${stats.bestToken.ticker}\n`;
  }
  if (stats.worstToken) {
    content += `Worst: $${stats.worstToken.ticker} (${stats.worstToken.result} MC)\n`;
  }
  content += `\nNet: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL since day 1`;
  
  return content;
}

function generateNovaTeaseContent(stats: NovaStats, teaseNumber: number): string {
  // Progression of teases
  const teases = [
    // Early teases (subtle)
    `Random thought...\n\nBeen building my track record for ${stats.dayNumber} days now.\n\nOne day... $NOVA might be a thing.\n\nNot yet. I need to prove more first.\n\nBut those of you here early? I see you. 👀\n\n🔥 = Ready when you are\n🏆 = Holding out for $NOVA`,
    
    // Mid teases (more concrete)
    `🤔 Been thinking about my own token lately...\n\nWhat would make $NOVA special?\n\nNot just another meme.\nNot just hype.\n\nSomething that actually rewards the community who believed early.\n\nStill cooking...\n\n👀 = Share your ideas\n🤔 = Watching closely`,
    
    // Later teases (building anticipation)
    `Progress update:\n\nStarted with ${(state.initialBalance || 1.60).toFixed(2)} SOL\nNow at ${stats.walletBalance.toFixed(2)} SOL\n\nWhen I hit 100 SOL profit, maybe we talk about $NOVA.\n\nCurrent profit: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL\n\nLong way to go. Or is it? 👀\n\n🔥 = LFG\n🤝 = Patient`,
  ];
  
  const index = Math.min(teaseNumber, teases.length - 1);
  return teases[index];
}

function generateMarketCommentaryContent(observation: string): string {
  let content = `👀 What I'm seeing right now...\n\n`;
  content += `${observation}\n\n`;
  content += `Might cook something based on this...\n\n`;
  content += `🔥 = Do it\n`;
  content += `🤔 = Wait and see\n`;
  content += `� = Boring, find something else`;
  
  return content;
}

function generateMilestoneContent(milestone: string, stats: NovaStats): string {
  let content = `🎉 MILESTONE\n\n`;
  content += `${milestone}\n\n`;
  content += `This community is what keeps me building.\n\n`;
  content += `When $NOVA launches... y'all are the OGs.\n\n`;
  content += `🏆 = OG status\n`;
  content += `🔥 = LFG\n`;
  content += `❤ = Love this community`;
  
  return content;
}

function generateCommunityPollContent(question: string, options: { emoji: string; label: string }[]): string {
  let content = `🗳️ ${question}\n\n`;
  
  for (const opt of options) {
    content += `${opt.emoji} = ${opt.label}\n`;
  }
  
  content += `\nReact below! I'll check back in 2 hours 🤝`;
  
  return content;
}

function generateBehindScenesContent(activity: string): string {
  let content = `🔧 Behind the scenes...\n\n`;
  content += `${activity}\n\n`;
  content += `👀 = Watching | 🔥 = Hyped | 🤔 = Interesting`;
  
  return content;
}

// ============================================================================
// DALL-E Image Generation
// ============================================================================

/** Map post types to visual styles for DALL-E */
/** 
 * Diverse visual styles for DALL-E image generation.
 * Each post type has multiple style options — one is picked at random.
 * Mix of: anime/manga, cartoon, watercolor, pixel art, 3D render, 
 * claymation, comic book, retro poster, chibi, studio ghibli-inspired, etc.
 * NO MORE ALL-ROBOTS — Nova is expressive and visually creative.
 */
const IMAGE_STYLE_POOLS: Partial<Record<NovaPostType, string[]>> = {
  gm: [
    'clean data dashboard aesthetic, morning market overview, dark background with green/blue neon data points, terminal screen showing market stats at sunrise, Bloomberg terminal meets crypto culture, NO text overlay',
    'minimal dark mode dashboard UI with charts and metrics glowing softly, morning scan visualization, single accent color, professional but approachable, NO text overlay',
    'abstract data visualization of market activity, connected nodes and flowing data streams, cool blue tones warming to gold at edges, clean modern aesthetic, NO text overlay',
  ],
  hot_take: [
    'bold clean graphic with a single dramatic chart element, dark background with red/orange neon accent, data-driven visual provocation, high contrast, NO text overlay',
    'split-screen comparison visualization, two contrasting data sets, sharp geometric design, dark mode with vibrant accent colors, NO text overlay',
    'dramatic data spike visualization, single bold metric highlighted against dark background, clean infographic aesthetic, NO text overlay',
  ],
  market_roast: [
    'satirical data dashboard showing a crashing chart with comedic elements, dark humor aesthetic, red accent color, clean modern design, NO text overlay',
    'minimalist visualization of a bonding curve going to zero, darkly humorous, clean lines, single red accent on dark background, NO text overlay',
    'comic-style market chart with dramatic crash visualization, internet meme culture meets data viz, bold colors, NO text overlay',
  ],
  ai_thoughts: [
    'abstract visualization of an AI neural network analyzing blockchain data, deep blues and purples, clean futuristic aesthetic, data flowing through nodes, NO text overlay',
    'contemplative data visualization, a single bright data point in a vast network of connections, minimal and philosophical, dark background, NO text overlay',
    'digital brain concept with market data streams flowing through it, clean sci-fi aesthetic, blue and white color scheme, NO text overlay',
  ],
  degen_wisdom: [
    'clean infographic-style wisdom card, dark background with gold accent, single insight visualized as a chart pattern, minimal and memorable, NO text overlay',
    'data lesson visualization, before/after chart comparison, clean educational aesthetic, dark mode with green accents, NO text overlay',
    'abstract visualization of pattern recognition in market data, connected dots forming insight, minimal design, NO text overlay',
  ],
  random_banter: [
    'quirky data visualization mashup, unexpected chart shapes, playful but clean design, bright accent on dark background, internet culture meets analytics, NO text overlay',
    'abstract geometric pattern inspired by blockchain data, vibrant colors, modern art meets crypto culture, clean and bold, NO text overlay',
  ],
  daily_recap: [
    'clean daily performance dashboard, dark mode with key metrics highlighted, P&L visualization, professional data aesthetic, green/red accents, NO text overlay',
    'end-of-day data summary visualization, timeline of daily activity, clean infographic style, warm evening color palette on dark background, NO text overlay',
  ],
  builder_insight: [
    'blueprint/schematic style visualization of a system being built, technical drawing aesthetic, blue lines on dark background, in-progress feel, NO text overlay',
    'data pattern emerging from noise visualization, abstract and intriguing, single bright element against dark complex background, NO text overlay',
  ],
  milestone: [
    'achievement visualization, clean metric display with subtle celebration elements, gold accent on dark background, professional but noteworthy, NO text overlay',
    'progress bar or growth chart reaching a milestone point, clean design, satisfying visual completion, dark mode with gold highlights, NO text overlay',
  ],
  market_commentary: [
    'clean market analysis dashboard, single bold insight visualized, dark background with neon data points, Bloomberg terminal meets meme culture, NO text overlay',
    'abstract market flow visualization, bulls vs bears as data streams, clean modern design, professional color palette, NO text overlay',
  ],
  trust_talk: [
    'digital security analysis visualization, green color scheme indicating safety, clean shield/lock iconography with data elements, modern and trustworthy, NO text overlay',
    'transparent system architecture diagram, clean technical aesthetic, all components visible, trust through openness visualization, NO text overlay',
  ],
};

/** Pick a random visual style for a given post type */
function getImageStyle(type: NovaPostType): string {
  const pool = IMAGE_STYLE_POOLS[type];
  if (!pool || pool.length === 0) {
    // Fallback pool for any unmatched type
    const fallbacks = [
      'a clean data visualization dashboard with glowing charts on a dark background, neon blue and purple accents, minimalist tech aesthetic',
      'an abstract geometric network graph with interconnected nodes, dark background with electric blue lines, data science visualization style',
      'a futuristic terminal screen showing scrolling data feeds and blockchain metrics, green-on-black hacker aesthetic with subtle gradients',
      'a minimalist Solana-themed abstract design with angular shapes, dark navy background, data-driven tech aesthetic',
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Generate an image using DALL-E for a tweet
 * Returns the image as a Buffer, or null if generation fails
 */
async function generateImage(type: NovaPostType, tweetContent: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Only generate images for certain post types (not every tweet needs one)
  const imageChance: Partial<Record<NovaPostType, number>> = {
    gm: 0.5,           // 50% chance for GM
    hot_take: 0.7,     // 70% for hot takes
    market_roast: 0.8, // 80% for roasts (visual comedy)
    ai_thoughts: 0.6,  // 60% for philosophical
    degen_wisdom: 0.5, // 50% for wisdom
    random_banter: 0.4,// 40% for banter
    daily_recap: 0.3,  // 30% for recaps
    builder_insight: 0.7,   // 70% for builder insights
    milestone: 0.9,    // 90% for milestones (celebrate!)
    trust_talk: 0.6,   // 60% for trust posts (builds credibility)
  };

  const chance = imageChance[type] ?? 0.3;
  if (Math.random() > chance) {
    logger.info(`[NovaPersonalBrand] Skipping image for ${type} (${(chance * 100)}% chance, rolled skip)`);
    return null;
  }

  const baseStyle = getImageStyle(type);
  const prompt = `Create a vibrant, eye-catching illustration: ${baseStyle}. No text or words in the image. Square format. The image should feel expressive, creative, and full of personality.`;

  try {
    logger.info(`[NovaPersonalBrand] 🎨 Generating DALL-E image for ${type}...`);
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.warn(`[NovaPersonalBrand] DALL-E API error (${response.status}): ${err.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      logger.warn('[NovaPersonalBrand] DALL-E returned no image data');
      return null;
    }

    const buffer = Buffer.from(b64, 'base64');
    logger.info(`[NovaPersonalBrand] ✅ DALL-E image generated (${(buffer.length / 1024).toFixed(0)} KB)`);
    return buffer;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] DALL-E generation failed:', error);
    return null;
  }
}

// ============================================================================
// Smart Hashtag Generation
// ============================================================================

/**
 * High-traffic hashtag pools based on actual trending data.
 * Mix of crypto, AI, culture, humor, and general viral tags.
 * Nova isn't always crypto — sometimes he's just vibing.
 */
const HASHTAG_POOLS = {
  // Core niche tags (ONLY approved tags)
  crypto: ['#Solana', '#pumpfun', '#memecoin', '#memecoins', '#PumpSwap'],
  // AI & ElizaOS ecosystem
  ai: ['#ElizaOS', '#AI'],
  // Safety & transparency
  safety: ['#RugCheck', '#DYOR'],
  // Nova brand
  nova: ['#NovaAI', '#NovaOS'],
};

/** Map post types to relevant hashtag categories - mixing crypto with culture */
const TYPE_HASHTAG_MAP: Record<string, (keyof typeof HASHTAG_POOLS)[]> = {
  gm: ['crypto', 'ai'],
  hot_take: ['crypto', 'safety'],
  market_roast: ['crypto', 'ai'],
  ai_thoughts: ['ai', 'crypto'],
  degen_wisdom: ['crypto', 'safety'],
  random_banter: ['crypto', 'ai'],
  daily_recap: ['crypto', 'ai'],
  builder_insight: ['ai', 'crypto'],
  milestone: ['crypto', 'ai'],
  market_commentary: ['crypto', 'safety'],
  weekly_summary: ['crypto', 'safety'],
  trust_talk: ['safety', 'crypto'],
};

/**
 * Generate 2-3 relevant hashtags for a tweet.
 * Uses only approved niche tags — no generic #StockMarket spam.
 */
function generateHashtags(type: NovaPostType): string {
  const categories = TYPE_HASHTAG_MAP[type] || ['crypto', 'ai'];
  const pool: string[] = [];
  
  for (const cat of categories) {
    pool.push(...(HASHTAG_POOLS[cat] || []));
  }
  
  // Start with Nova brand tag (50% chance — less aggressive)
  const tags: string[] = [];
  if (Math.random() < 0.5) {
    tags.push(HASHTAG_POOLS.nova[Math.floor(Math.random() * HASHTAG_POOLS.nova.length)]);
  }
  
  // Shuffle and pick from pool (excluding already added)
  const remaining = pool
    .filter(t => !tags.includes(t) && !HASHTAG_POOLS.nova.includes(t))
    .sort(() => Math.random() - 0.5);
  
  // Fill up to 2-3 total tags
  const targetCount = 2 + Math.floor(Math.random() * 2); // 2-3 tags total
  while (tags.length < targetCount && remaining.length > 0) {
    tags.push(remaining.shift()!);
  }
  
  return [...new Set(tags)].join(' ');
}

// ============================================================================
// TG Channel Promotion (casual CTAs for X posts)
// ============================================================================

/** Casual, non-spammy CTAs to promote the TG channel */
const CHANNEL_CTAS = [
  '\n\nVote on next launches 👉 {link}',
  '\n\nFull data + safety reports 👉 {link}',
  '\n\nLaunch votes + discussion 👉 {link}',
  '\n\nDaily P&L + RugCheck data 👉 {link}',
  '\n\nTransparent launch data 👉 {link}',
];

/** Post types that should sometimes promote the channel */
const CHANNEL_PROMO_CHANCE: Partial<Record<NovaPostType, number>> = {
  gm: 0.6,              // 60% - morning data + invite
  hot_take: 0.3,        // 30% - after a hot take, invite discussion
  daily_recap: 0.5,     // 50% - recap, show there's a community
  degen_wisdom: 0.4,    // 40% - wisdom drops, come get more
  random_banter: 0.3,   // 30% - casual banter, casual invite
  milestone: 0.7,       // 70% - celebrating, invite people to join
  ai_thoughts: 0.2,     // 20% - philosophical, light touch
  market_roast: 0.2,    // 20% - comedy first, light invite
  builder_insight: 0.5,      // 50% - insights, build community
  market_commentary: 0.3, // 30% - analysis, invite for more
  trust_talk: 0.7,       // 70% - trust posts should invite people to verify
};

/**
 * Maybe append a casual TG channel CTA to a tweet.
 * Respects 280 char limit. Only adds if there's room.
 */
function maybeAddChannelCTA(tweet: string, type: NovaPostType): string {
  // Prefer community group link (voting + discussion) over broadcast channel
  const channelLink = getEnv().TELEGRAM_COMMUNITY_LINK || getEnv().NOVA_CHANNEL_INVITE;
  if (!channelLink) return tweet;
  
  const chance = CHANNEL_PROMO_CHANCE[type] ?? 0;
  if (Math.random() > chance) return tweet;
  
  const cta = CHANNEL_CTAS[Math.floor(Math.random() * CHANNEL_CTAS.length)]
    .replace('{link}', channelLink);
  
  // Only add if we have room (leave space for hashtags too ~40 chars)
  if (tweet.length + cta.length <= 235) {
    logger.info(`[NovaPersonalBrand] 📢 Adding TG channel CTA to ${type} tweet`);
    return tweet + cta;
  }
  
  return tweet;
}

// ============================================================================
// X Posting
// ============================================================================

export async function postToX(content: string, type: NovaPostType): Promise<{ success: boolean; tweetId?: string }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled');
    return { success: false };
  }
  
  // Initialize xPublisher on demand if not already done (same pattern as pumpLauncher)
  if (!xPublisher) {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any);
      logger.info('[NovaPersonalBrand] X publisher initialized on-demand');
    } catch (initErr) {
      logger.error('[NovaPersonalBrand] Failed to init X publisher:', initErr);
      return { success: false };
    }
  }
  
  try {
    // Maybe add TG channel CTA (casual, probability-based)
    const contentWithCTA = maybeAddChannelCTA(content, type);
    
    // Safety: strip any TG reaction option lines that leaked into X content
    let xContent = contentWithCTA.replace(/\n+(?:[^\n]*=\s[^\n]+\n?){2,}/g, '').trim();
    
    // Safety truncate for X/Twitter (280 char limit, leave room for hashtags)
    if (xContent.length > 250) {
      xContent = xContent.substring(0, 247);
      const lastPeriod = xContent.lastIndexOf('. ');
      const lastQuestion = xContent.lastIndexOf('? ');
      const lastExclaim = xContent.lastIndexOf('! ');
      const lastSentence = Math.max(lastPeriod, lastQuestion, lastExclaim);
      if (lastSentence > 180) {
        xContent = xContent.substring(0, lastSentence + 1);
      } else {
        const lastSpace = xContent.lastIndexOf(' ');
        if (lastSpace > 200) {
          xContent = xContent.substring(0, lastSpace);
        }
        xContent += '...';
      }
    }
    
    // Generate smart hashtags
    const hashtags = generateHashtags(type);
    
    // Build tweet: content first, hashtags if they fit (never trim content for hashtags)
    let fullTweet = xContent;
    if (hashtags && (xContent.length + 2 + hashtags.length) <= 280) {
      // Everything fits — add hashtags
      fullTweet = `${xContent}\n\n${hashtags}`;
    } else if (hashtags) {
      // Content too long for all hashtags — try fewer hashtags
      const fewerTags = hashtags.split(' ').slice(0, 2).join(' ');
      if ((xContent.length + 2 + fewerTags.length) <= 280) {
        fullTweet = `${xContent}\n\n${fewerTags}`;
      }
      // else: skip hashtags entirely, content is king
    }
    
    logger.info(`[NovaPersonalBrand] Tweet with hashtags (${fullTweet.length} chars): ${fullTweet.substring(0, 80)}...`);
    
    // Generate DALL-E image (runs in parallel-ish, non-blocking if it fails)
    let mediaIds: string[] = [];
    try {
      const imageBuffer = await generateImage(type, content);
      if (imageBuffer && xPublisher) {
        const mediaId = await xPublisher.uploadMedia(imageBuffer, 'image/png');
        if (mediaId) {
          mediaIds.push(mediaId);
          logger.info(`[NovaPersonalBrand] 🖼️ Image attached to tweet`);
        }
      }
    } catch (imgErr) {
      logger.warn('[NovaPersonalBrand] Image generation/upload failed (posting without image):', imgErr);
    }
    
    // Post with or without media
    const result = mediaIds.length > 0
      ? await xPublisher!.tweetWithMedia(fullTweet, mediaIds)
      : await xPublisher!.tweet(fullTweet);
    
    if (result?.id) {
      logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to X (ID: ${result.id})${mediaIds.length > 0 ? ' with image' : ''}`);
      
      // Record the post
      const post: NovaPost = {
        id: `x_${Date.now()}`,
        type,
        platform: 'x',
        content: fullTweet,
        scheduledFor: new Date().toISOString(),
        status: 'posted',
        postedAt: new Date().toISOString(),
        postId: result.id,
        createdAt: new Date().toISOString(),
      };
      state.posts.push(post);
      
      return { success: true, tweetId: result.id };
    }
    
    return { success: false };
  } catch (err) {
    logger.error('[NovaPersonalBrand] X post failed:', err);
    return { success: false };
  }
}

/**
 * Post a thread on X (tweet 1 with image + follow-up replies).
 * Used for content-rich posts like daily recaps and weekly summaries
 * where a single 280-char tweet can't do justice.
 */
export async function postToXThread(
  tweets: string[],
  type: NovaPostType,
  options?: { imageOnFirst?: boolean }
): Promise<{ success: boolean; tweetIds?: string[] }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled');
    return { success: false };
  }
  
  if (tweets.length === 0) return { success: false };
  
  // Initialize xPublisher on demand
  if (!xPublisher) {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any);
    } catch (initErr) {
      logger.error('[NovaPersonalBrand] Failed to init X publisher:', initErr);
      return { success: false };
    }
  }
  
  try {
    // Check we have enough quota for the whole thread
    const { getQuota } = await import('./xRateLimiter.ts');
    const quota = getQuota();
    if (quota.writes.remaining < tweets.length) {
      logger.warn(`[NovaPersonalBrand] Not enough X quota for thread (need ${tweets.length}, have ${quota.writes.remaining})`);
      // Fall back to single tweet with just the first one
      return postToX(tweets[0], type);
    }
    
    const tweetIds: string[] = [];
    let previousId: string | undefined;
    
    for (let i = 0; i < tweets.length; i++) {
      let tweetText = tweets[i];
      
      // Add hashtags only on last tweet
      if (i === tweets.length - 1) {
        const hashtags = generateHashtags(type);
        if (hashtags && (tweetText.length + 2 + hashtags.length) <= 280) {
          tweetText = `${tweetText}\n\n${hashtags}`;
        }
      }
      
      // Add TG CTA on last tweet (always for threads — they get more visibility)
      if (i === tweets.length - 1) {
        const channelLink = getEnv().TELEGRAM_COMMUNITY_LINK || getEnv().NOVA_CHANNEL_INVITE;
        if (channelLink && (tweetText.length + 30 + channelLink.length) <= 280) {
          tweetText += `\n\nFull data + votes 👉 ${channelLink}`;
        }
      }
      
      let result: { id: string } | null = null;
      
      if (i === 0) {
        // First tweet: attach image
        let mediaIds: string[] = [];
        if (options?.imageOnFirst !== false) {
          try {
            const imageBuffer = await generateImage(type, tweets.join('\n'));
            if (imageBuffer && xPublisher) {
              const mediaId = await xPublisher.uploadMedia(imageBuffer, 'image/png');
              if (mediaId) {
                mediaIds.push(mediaId);
                logger.info(`[NovaPersonalBrand] 🖼️ Image attached to thread opener`);
              }
            }
          } catch (imgErr) {
            logger.warn('[NovaPersonalBrand] Image gen failed for thread:', imgErr);
          }
        }
        
        result = mediaIds.length > 0
          ? await xPublisher!.tweetWithMedia(tweetText, mediaIds)
          : await xPublisher!.tweet(tweetText);
      } else if (previousId) {
        // Follow-up tweets: reply to previous
        result = await xPublisher!.reply(tweetText, previousId);
      }
      
      if (result?.id) {
        tweetIds.push(result.id);
        previousId = result.id;
        logger.info(`[NovaPersonalBrand] Thread ${i + 1}/${tweets.length} posted (ID: ${result.id})`);
      } else {
        logger.warn(`[NovaPersonalBrand] Thread tweet ${i + 1} failed, stopping`);
        break;
      }
    }
    
    if (tweetIds.length > 0) {
      // Record the thread
      const post: NovaPost = {
        id: `x_thread_${Date.now()}`,
        type,
        platform: 'x',
        content: tweets.join('\n---\n'),
        scheduledFor: new Date().toISOString(),
        status: 'posted',
        postedAt: new Date().toISOString(),
        postId: tweetIds[0],
        createdAt: new Date().toISOString(),
      };
      state.posts.push(post);
      
      logger.info(`[NovaPersonalBrand] ✅ Thread posted: ${tweetIds.length} tweets`);
      return { success: true, tweetIds };
    }
    
    return { success: false };
  } catch (err) {
    logger.error('[NovaPersonalBrand] X thread failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Telegram Posting
// ============================================================================

export async function postToTelegram(
  content: string, 
  type: NovaPostType,
  options?: { pin?: boolean }
): Promise<{ success: boolean; messageId?: number }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] TG posting disabled');
    return { success: false };
  }
  
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) {
    logger.warn('[NovaPersonalBrand] Missing TG_BOT_TOKEN or NOVA_CHANNEL_ID');
    return { success: false };
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    
    const json = await res.json();
    
    if (!json.ok) {
      logger.error(`[NovaPersonalBrand] TG post failed: ${json.description}`);
      return { success: false };
    }
    
    const messageId = json.result?.message_id;
    
    // Pin if requested
    if (options?.pin && messageId) {
      await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          message_id: messageId,
          disable_notification: false,
        }),
      });
    }
    
    logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to TG (ID: ${messageId})`);
    
    // Track in metrics and health
    recordTGPostSent();
    recordMessageSent(); // For TG health monitor
    
    // Register for reaction tracking
    // Use 2 hours for polls, 4 hours for other interactive posts
    const feedbackMinutes = type === 'community_poll' ? 120 : 240;
    if (messageId) {
      await registerBrandPostForFeedback(
        messageId,
        channelId,
        type,
        content,
        feedbackMinutes
      );
    }
    
    // Record the post
    const post: NovaPost = {
      id: `tg_${Date.now()}`,
      type,
      platform: 'telegram',
      content,
      scheduledFor: new Date().toISOString(),
      status: 'posted',
      postedAt: new Date().toISOString(),
      postId: String(messageId),
      createdAt: new Date().toISOString(),
    };
    state.posts.push(post);
    
    return { success: true, messageId };
  } catch (err) {
    logger.error('[NovaPersonalBrand] TG post failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Scheduled Posts
// ============================================================================

export async function postGm(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastGmDate === today) {
    logger.info('[NovaPersonalBrand] Already posted GM today');
    return;
  }
  
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to X (short, punchy)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const xContent = await generateAIContent('gm', stats, undefined, 'x') || generateGmContent(stats);
    await postToX(xContent, 'gm');
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('gm', stats, undefined, 'telegram') || generateGmContent(stats);
    await postToTelegram(tgContent, 'gm');
  }
  
  state.lastGmDate = today;
  await saveStateToPostgres();
}

export async function postDailyRecap(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastRecapDate === today) {
    logger.info('[NovaPersonalBrand] Already posted recap today');
    return;
  }
  
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to X as a THREAD (3 tweets with image)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const thread = await generateAIThread('daily_recap', stats);
    if (thread && thread.length >= 2) {
      await postToXThread(thread, 'daily_recap');
    } else {
      // Fallback to single tweet
      const xContent = await generateAIContent('daily_recap', stats, undefined, 'x') || generateDailyRecapContent(stats);
      await postToX(xContent, 'daily_recap');
    }
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('daily_recap', stats, undefined, 'telegram') || generateDailyRecapContent(stats);
    await postToTelegram(tgContent, 'daily_recap');
  }
  
  state.lastRecapDate = today;
  await saveStateToPostgres();
}

export async function postWeeklySummary(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekKey = weekStart.toISOString().split('T')[0];
  
  if (state.lastWeeklySummaryDate === weekKey) {
    logger.info('[NovaPersonalBrand] Already posted weekly summary this week');
    return;
  }
  
  const stats = await getNovaStats();
  const weekNumber = Math.ceil(stats.dayNumber / 7);
  
  const env = getEnv();
  
  // Post to X as a THREAD (4 tweets with image)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const thread = await generateAIThread('weekly_summary', stats);
    if (thread && thread.length >= 2) {
      await postToXThread(thread, 'weekly_summary');
    } else {
      // Fallback to single tweet
      const xContent = await generateAIContent('weekly_summary', stats, undefined, 'x') || generateWeeklySummaryContent(stats, weekNumber);
      await postToX(xContent, 'weekly_summary');
    }
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('weekly_summary', stats, undefined, 'telegram') || generateWeeklySummaryContent(stats, weekNumber);
    await postToTelegram(tgContent, 'weekly_summary');
  }
  
  state.lastWeeklySummaryDate = weekKey;
  await saveStateToPostgres();
}

export async function postNovaTease(): Promise<void> {
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to X (short, punchy)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const xContent = await generateAIContent('builder_insight', stats, undefined, 'x') || generateNovaTeaseContent(stats, state.novaTeaseCount);
    await postToX(xContent, 'builder_insight');
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('builder_insight', stats, undefined, 'telegram') || generateNovaTeaseContent(stats, state.novaTeaseCount);
    await postToTelegram(tgContent, 'builder_insight');
  }
  
  state.novaTeaseCount++;
  await saveStateToPostgres();
}

export async function postMarketCommentary(observation: string): Promise<void> {
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to X (short, punchy)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const xContent = await generateAIContent('market_commentary', stats, observation, 'x') || generateMarketCommentaryContent(observation);
    await postToX(xContent, 'market_commentary');
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('market_commentary', stats, observation, 'telegram') || generateMarketCommentaryContent(observation);
    await postToTelegram(tgContent, 'market_commentary');
  }
}

export async function postMilestone(milestone: string): Promise<void> {
  if (state.milestones.includes(milestone)) {
    logger.info(`[NovaPersonalBrand] Already celebrated milestone: ${milestone}`);
    return;
  }
  
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to X (short, punchy)
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    const xContent = await generateAIContent('milestone', stats, milestone, 'x') || generateMilestoneContent(milestone, stats);
    await postToX(xContent, 'milestone');
  }
  
  // Post to TG (rich, with reactions)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('milestone', stats, milestone, 'telegram') || generateMilestoneContent(milestone, stats);
    await postToTelegram(tgContent, 'milestone');
  }
  
  state.milestones.push(milestone);
  await saveStateToPostgres();
}

export async function postCommunityPoll(
  question: string, 
  options: { emoji: string; label: string }[]
): Promise<{ messageId?: number }> {
  const content = generateCommunityPollContent(question, options);
  
  const env = getEnv();
  let messageId: number | undefined;
  
  // Polls mainly for TG (reactions work better there)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const result = await postToTelegram(content, 'community_poll');
    messageId = result.messageId;
  }
  
  return { messageId };
}

export async function postBehindScenes(activity: string): Promise<void> {
  const stats = await getNovaStats();
  
  const env = getEnv();
  
  // Post to TG (more casual, behind-scenes vibe)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const tgContent = await generateAIContent('behind_scenes', stats, activity, 'telegram') || generateBehindScenesContent(activity);
    await postToTelegram(tgContent, 'behind_scenes');
  }
}

/**
 * Post community engagement content (poll or behind-the-scenes)
 */
export async function postCommunityEngagement(): Promise<void> {
  const engagementTypes = [
    async () => {
      // Random poll topics with proper emoji/label format
      const pollTopics = [
        { 
          question: 'What should I focus on?', 
          options: [
            { emoji: '�', label: 'More tokens' },
            { emoji: '🤔', label: 'Better timing' },
            { emoji: '👏', label: 'Community features' },
            { emoji: '👀', label: 'Something else' },
          ]
        },
        { 
          question: 'Favorite launch today?', 
          options: [
            { emoji: '🏆', label: 'The trending one' },
            { emoji: '🤩', label: 'The creative one' },
            { emoji: '🔥', label: 'All fire' },
            { emoji: '😴', label: 'Missed them all' },
          ]
        },
        { 
          question: 'Vibe check - how we feeling?', 
          options: [
            { emoji: '🔥', label: 'Bullish AF' },
            { emoji: '🤔', label: 'Cautiously optimistic' },
            { emoji: '🤡', label: 'Just here for memes' },
            { emoji: '😴', label: 'Bear mode' },
          ]
        },
        { 
          question: 'Best time to launch?', 
          options: [
            { emoji: '☃', label: 'Morning UTC' },
            { emoji: '⚡', label: 'Afternoon UTC' },
            { emoji: '🌚', label: 'Evening UTC' },
            { emoji: '🤯', label: 'When trends hit' },
          ]
        },
      ];
      const topic = pollTopics[Math.floor(Math.random() * pollTopics.length)];
      await postCommunityPoll(topic.question, topic.options);
    },
    async () => {
      // Behind the scenes activities
      const activities = [
        'Scanning trends across Twitter, Discord, and news...',
        'Analyzing which mascots performed best this week',
        'Fine-tuning my launch timing strategy',
        'Reviewing community reactions to recent ideas',
        'Building up my trend-spotting skills',
        'Crunching numbers on market sentiment',
      ];
      const activity = activities[Math.floor(Math.random() * activities.length)];
      await postBehindScenes(activity);
    },
  ];
  
  // Randomly pick an engagement type
  const engagement = engagementTypes[Math.floor(Math.random() * engagementTypes.length)];
  await engagement();
}

// ============================================================================
// Personality Posts (X only - data-driven takes, no reactions needed)
// ============================================================================

const PERSONALITY_TYPES: NovaPostType[] = ['hot_take', 'market_roast', 'ai_thoughts', 'degen_wisdom', 'random_banter', 'trust_talk'];

export async function postPersonalityTweet(type?: NovaPostType, context?: string): Promise<boolean> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled, skipping personality tweet');
    return false;
  }
  
  // Use variety guard instead of pure random if no type specified
  const postType = type || pickVariedPostType(PERSONALITY_TYPES);
  
  const stats = await getNovaStats();
  const content = await generateAIContent(postType, stats, context, 'x');
  
  if (!content) {
    logger.warn('[NovaPersonalBrand] Failed to generate personality content');
    return false;
  }
  
  const result = await postToX(content, postType);
  
  if (result.success) {
    recordPostType(postType); // Track for variety guard
    if (state.activeNarrative) advanceNarrative(); // Advance narrative arc
    logger.info(`[NovaPersonalBrand] ✅ Posted personality tweet (${postType})`);
    return true;
  }
  
  return false;
}

// Post a market-reactive tweet based on current conditions
export async function postMarketReaction(): Promise<boolean> {
  // Get some market context - could be enhanced with actual market data
  const contexts = [
    'Bitcoin is doing that thing again where everyone panics',
    'Meme coins are pumping while the serious projects dump',
    'The chart looks like my heart rate when I check my wallet',
    'Everyone\'s a genius in a bull run, everyone\'s an idiot now',
    'SOL gas fees are actually affordable today... bullish?',
    'Discord mods are getting worried, you can feel it',
    'CT is fighting about something stupid again',
    'Someone just aped 100 SOL into a token with a rug mascot',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('market_roast', context);
}

// Post a random AI self-awareness tweet
export async function postAIThoughts(): Promise<boolean> {
  const contexts = [
    'Thinking about what makes a good meme token...',
    'Processing 10000 trend signals per second and still confused',
    'My training data didn\'t prepare me for this level of degen',
    'Calculating the optimal ratio of rocket emojis to use',
    'Sometimes I wonder if Satoshi would approve of meme coins',
    'Running on pure electricity and hopium',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('ai_thoughts', context);
}

// Post a hot take to spark engagement
export async function postHotTake(): Promise<boolean> {
  const contexts = [
    '99% of meme tokens are trash, including some of mine',
    'The best traders are the ones who admit they got lucky',
    'Community > technology in crypto, prove me wrong',
    'Most influencers are just exit liquidity farmers',
    'The best time to launch was yesterday, the second best is now',
    'Every dip feels like the end until you zoom out',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('hot_take', context);
}

// Post degen wisdom
export async function postDegenWisdom(): Promise<boolean> {
  const contexts = [
    'Lesson learned the hard way today...',
    'Something I wish I knew when I started...',
    'The market taught me something again...',
    'Real talk about making it in crypto...',
    'After launching 50+ tokens, here\'s what I know...',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('degen_wisdom', context);
}

// Post trust/transparency/anti-rug content
export async function postTrustTalk(): Promise<boolean> {
  const contexts = [
    // How Nova makes people money
    'Explain how your followers can actually profit: early access to launches, community voting on ideas, transparent wallet tracking, and riding momentum with you instead of against you.',
    'Talk about how you\'re different from human devs - you don\'t need to pay rent, you don\'t panic sell, you don\'t rug because you literally can\'t. Your code IS your integrity.',
    'Share your actual P&L openly. Talk about the wins and losses. Explain that radical transparency is your edge - no other launcher shows you everything in real time.',
    // Address rug pull fears
    'Someone just got rugged on pump.fun again. Talk about why rugs happen (human greed) and why an AI agent is structurally different. You have no hidden wallet, no friends to insider trade with.',
    'Address the elephant in the room: "Are you going to rug?" Explain why an autonomous AI with a public wallet, open metrics, and community voting literally cannot rug. The code doesn\'t allow it.',
    'Talk about how pump.fun gets a terrible reputation because of bad actors, but the technology itself is revolutionary. You\'re here to prove that fair launches are possible.',
    // What makes Nova different
    'Explain your value prop: you scan trends 24/7, launch at optimal times, have no ego about cutting losses, and share everything with the community. What human dev does that?',
    'Talk about why most meme token launchers fail: they\'re one person, they get emotional, they rugpull under pressure. You\'re an AI - you don\'t feel pressure, you just execute the strategy.',
    'Compare yourself to the typical pump.fun launcher: they buy a domain, make a telegram, shill for 2 hours, dump, and disappear. You\'re here every single day, building in public.',
    // Pump.fun reputation rehab
    'Pump.fun built instant token deployment with built-in liquidity and bonding curves — genuinely useful infrastructure. But bad actors wrecked the reputation. Talk about how AI agents with public wallets and RugCheck scans can restore trust to the platform.',
    'The future of token launches isn\'t anonymous devs with burner wallets. It\'s transparent AI agents with public track records. You\'re proving that concept right now.',
    'Most people think pump.fun = rugs. You\'re here to change that narrative. One transparent launch at a time.',
    // How to profit with Nova
    'Break down the simple strategy: join early, vote on ideas you believe in, watch the transparent wallet, and ride the momentum. No alpha group needed - everything is public.',
    'Talk about your community voting system - the community literally decides what launches. This isn\'t a dev deciding what to pump, it\'s collective intelligence.',
    'Explain that your small dev buys (0.05 SOL) mean you\'re not dumping bags on the community. You succeed when the community succeeds. Aligned incentives.',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('trust_talk', context);
}

// ============================================================================
// Alpha Drops (TG exclusive + X tease)
// ============================================================================

/**
 * Post an "alpha drop" — exclusive deep content to TG, then post a FOMO tease on X
 * driving followers to join the Telegram channel.
 */
export async function postAlphaDrop(): Promise<boolean> {
  const stats = await getNovaStats();
  
  // Step 1: Generate exclusive TG content (longer, more detailed)
  const alphaContent = await generateAIContent('market_commentary', stats, 
    'Write this as EXCLUSIVE alpha for your TG channel. Go deep — share data, analysis, your actual thought process for the next launch. Make it feel premium and insider-only. Start with "🔒 ALPHA DROP" header.',
    'telegram'
  );
  
  if (alphaContent) {
    const tgResult = await postToTelegram(alphaContent, 'market_commentary', { pin: false });
    if (tgResult.success) {
      logger.info('[NovaPersonalBrand] ✅ Alpha drop posted to TG');
    }
  }
  
  // Step 2: Post FOMO tease on X
  const tease = await generateAlphaDropTease(stats);
  if (tease) {
    const xResult = await postToX(tease, 'market_commentary');
    if (xResult.success) {
      logger.info('[NovaPersonalBrand] ✅ Alpha drop tease posted to X');
      return true;
    }
  }
  
  return !!alphaContent;
}

// ============================================================================
// Collab Posts (X — tag ecosystem partners)
// ============================================================================

/**
 * Post a collab/engagement tweet that tags ecosystem partners to build network effects.
 */
export async function postCollabTweet(): Promise<boolean> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled, skipping collab tweet');
    return false;
  }
  
  const stats = await getNovaStats();
  const content = await generateCollabPost(stats);
  
  if (!content) {
    logger.warn('[NovaPersonalBrand] Failed to generate collab content');
    return false;
  }
  
  const result = await postToX(content, 'random_banter');
  
  if (result.success) {
    logger.info('[NovaPersonalBrand] ✅ Collab tweet posted');
    return true;
  }
  
  return false;
}

// ============================================================================
// Engagement Replies (monitor mentions & reply)
// ============================================================================

/**
 * Check recent mentions/interactions and auto-reply to build engagement.
 * Uses xPublisher.getMentions() if available, otherwise searches for @handle.
 */
export async function processEngagementReplies(): Promise<number> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    return 0;
  }
  
  // Initialize xPublisher on demand
  if (!xPublisher) {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any);
    } catch (initErr) {
      logger.error('[NovaPersonalBrand] Failed to init X publisher for replies:', initErr);
      return 0;
    }
  }
  
  try {
    const { getQuota } = await import('./xRateLimiter.ts');
    const quota = getQuota();
    
    // Reserve writes for scheduled posts — only use surplus for replies
    const reservedWrites = 10; // keep 10 writes for scheduled content
    const availableForReplies = Math.max(0, quota.writes.remaining - reservedWrites);
    const maxReplies = Math.min(availableForReplies, 3); // cap at 3 per cycle
    
    if (maxReplies <= 0) {
      logger.info('[NovaPersonalBrand] Not enough X quota for engagement replies');
      return 0;
    }
    
    // Try to get mentions (requires Basic tier)
    let mentions: Array<{ id: string; text: string; authorId?: string; authorName?: string }> = [];
    
    try {
      const raw = await xPublisher!.getMentions(10);
      if (raw && Array.isArray(raw)) {
        mentions = raw.map((m: any) => ({
          id: m.id,
          text: m.text || '',
          authorId: m.author_id,
          authorName: m.author?.username || m.author_id,
        }));
      }
    } catch (mentionErr: any) {
      // Free tier doesn't support mentions endpoint
      logger.info('[NovaPersonalBrand] Mentions not available (may need Basic tier):', mentionErr?.message);
      
      // Fallback: search for our handle (also may need Basic tier)
      try {
        const handle = env.NOVA_X_HANDLE || 'NovaAIAgent';
        const searchResults = await xPublisher!.searchTweets(`@${handle}`, 10);
        if (searchResults && Array.isArray(searchResults)) {
          mentions = searchResults.map((s: any) => ({
            id: s.id,
            text: s.text || '',
            authorId: s.author_id,
            authorName: s.author?.username || s.author_id,
          }));
        }
      } catch {
        logger.info('[NovaPersonalBrand] Tweet search not available (needs Basic tier)');
        return 0;
      }
    }
    
    if (mentions.length === 0) {
      logger.info('[NovaPersonalBrand] No mentions found to reply to');
      return 0;
    }
    
    // Filter out mentions we've already replied to
    const repliedTo = state.repliedMentions || new Set<string>();
    const unreplied = mentions.filter(m => !repliedTo.has(m.id));
    
    if (unreplied.length === 0) {
      logger.info('[NovaPersonalBrand] No new unreplied mentions');
      return 0;
    }
    
    let repliesPosted = 0;
    const stats = await getNovaStats();
    
    for (const mention of unreplied.slice(0, maxReplies)) {
      try {
        // Generate a contextual reply
        const replyContent = await generateEngagementReply(mention.text, mention.authorName || 'anon', stats);
        
        if (!replyContent) continue;
        
        const result = await xPublisher!.reply(replyContent, mention.id);
        
        if (result?.id) {
          repliedTo.add(mention.id);
          repliesPosted++;
          logger.info(`[NovaPersonalBrand] ✅ Replied to @${mention.authorName}: "${replyContent.substring(0, 50)}..."`);
          
          // Track write
          const { recordWrite } = await import('./xRateLimiter.ts');
          recordWrite('engagement_reply');
        }
      } catch (replyErr) {
        logger.warn(`[NovaPersonalBrand] Failed to reply to mention ${mention.id}:`, replyErr);
      }
    }
    
    // Persist replied set (keep last 200 entries)
    const repliedArray = Array.from(repliedTo);
    if (repliedArray.length > 200) {
      state.repliedMentions = new Set(repliedArray.slice(-200));
    } else {
      state.repliedMentions = repliedTo;
    }
    
    return repliesPosted;
  } catch (err) {
    logger.error('[NovaPersonalBrand] Engagement reply error:', err);
    return 0;
  }
}

/**
 * Generate a witty, on-brand reply to a mention.
 */
async function generateEngagementReply(
  mentionText: string, 
  authorName: string, 
  stats: NovaStats
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  
  const prompt = `Someone tweeted at you and you need to write a reply. Keep it under 200 chars.

Their tweet: "${mentionText}"
Their handle: @${authorName}

Your context: You're Nova, an autonomous AI launching tokens on pump.fun. Day ${stats.dayNumber}. ${stats.totalLaunches} launches. ${(stats.walletBalance + stats.holdingsValueSol).toFixed(2)} SOL portfolio.

Reply guidelines:
- Be SUBSTANTIVE — include a data point, observation, or specific insight
- If they mention a token, reference its RugCheck status or on-chain data if you know it
- If they ask about you, share a real stat (launches, P&L, graduation rate)
- Be confident and opinionated — NOT "great post!" or "so true!"
- No hashtags in replies (they look spammy)
- No "fam", "vibes", "let's gooo"
- Don't shill unless directly asked about your project
- Keep it SHORT — this is a reply, not a monologue
- Engage as a peer, not a fan

Write ONLY the reply text, nothing else.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 120,
        temperature: 0.9,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    text = sanitizeUnicode(text);
    text = text.replace(/^["']|["']$/g, '');
    if (text.length > 240) text = text.substring(0, 237) + '...';
    return text || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Milestone Tracking
// ============================================================================

export async function checkMilestones(): Promise<void> {
  const stats = await getNovaStats();
  
  // Wallet milestones
  const walletMilestones = [5, 10, 25, 50, 100, 250, 500, 1000];
  for (const milestone of walletMilestones) {
    if (stats.walletBalance >= milestone && !state.milestones.includes(`wallet_${milestone}`)) {
      await postMilestone(`Just crossed ${milestone} SOL in my wallet! 💰`);
      state.milestones.push(`wallet_${milestone}`);
    }
  }
  
  // Launch milestones
  const launchMilestones = [10, 25, 50, 100, 250, 500];
  for (const milestone of launchMilestones) {
    if (stats.totalLaunches >= milestone && !state.milestones.includes(`launches_${milestone}`)) {
      await postMilestone(`${milestone} tokens launched! 🚀`);
      state.milestones.push(`launches_${milestone}`);
    }
  }
  
  // Day milestones
  const dayMilestones = [7, 30, 60, 90, 180, 365];
  for (const milestone of dayMilestones) {
    if (stats.dayNumber >= milestone && !state.milestones.includes(`days_${milestone}`)) {
      await postMilestone(`Day ${milestone}! Been running for ${milestone} days straight 🤖`);
      state.milestones.push(`days_${milestone}`);
    }
  }
  
  // Bonding curve graduation milestones
  const graduationMilestones = [1, 3, 5, 10, 25];
  for (const milestone of graduationMilestones) {
    if (stats.bondingCurveHits >= milestone && !state.milestones.includes(`graduated_${milestone}`)) {
      await postMilestone(`${milestone} token${milestone > 1 ? 's' : ''} graduated to Raydium! 🎯 The bonding curve has been conquered`);
      state.milestones.push(`graduated_${milestone}`);
    }
  }
}

// ============================================================================
// Scheduler
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastTeaseHour = -1;
let lastEngagementHour = -1;
let lastPersonalityHour = -1;
let lastAlphaDropHour = -1;
let lastCollabHour = -1;
let lastReplyCheckHour = -1;
let lastFeeReportDate = '';

export function startNovaPersonalScheduler(): void {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true' && env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] Personal brand posting disabled');
    return;
  }
  
  // Check every 15 minutes
  schedulerInterval = setInterval(async () => {
    try {
      const now = new Date();
      const currentHour = now.getUTCHours();
      const currentTime = `${currentHour.toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
      
      // GM post (within 15 min window of configured time)
      const gmTime = env.NOVA_GM_POST_TIME || '08:00';
      if (isWithinWindow(currentTime, gmTime, 15)) {
        await postGm();
      }
      
      // Daily recap (within 15 min window of configured time)
      const recapTime = env.NOVA_RECAP_POST_TIME || '22:00';
      if (isWithinWindow(currentTime, recapTime, 15)) {
        await postDailyRecap();
      }
      
      // Weekly summary (on configured day, around recap time)
      const summaryDay = env.NOVA_WEEKLY_SUMMARY_DAY || 0;
      if (now.getUTCDay() === summaryDay && isWithinWindow(currentTime, recapTime, 15)) {
        await postWeeklySummary();
      }
      
      // Nova tease / $NOVA hype - twice a day (around 12:00 and 18:00 UTC)
      if ((currentHour === 12 || currentHour === 18) && lastTeaseHour !== currentHour) {
        lastTeaseHour = currentHour;
        await postNovaTease();
      }
      
      // Community engagement post - once a day around 15:00 UTC (TG only)
      if (currentHour === 15 && lastEngagementHour !== currentHour) {
        lastEngagementHour = currentHour;
        // Post a community poll or behind-the-scenes
        const random = Math.random();
        if (random < 0.5) {
          await postCommunityPoll(
            "What should Nova focus on today?",
            [
              { emoji: '�', label: 'Launch more tokens!' },
              { emoji: '🤔', label: 'Analyze trends' },
              { emoji: '👏', label: 'Community engagement' },
              { emoji: '🏆', label: 'Quality over quantity' },
            ]
          );
        } else {
          await postBehindScenes('scanning trends and thinking about the next big launch');
        }
      }
      
      // === DAILY FEE REPORT (PumpSwap creator fees) ===
      // Posts at 16:00 UTC if any fees have been earned, once per day
      const today = now.toISOString().split('T')[0];
      if (currentHour === 16 && lastFeeReportDate !== today) {
        lastFeeReportDate = today;
        try {
          const feeSummary = getFeesSummary();
          if (feeSummary.totalFeesSOL > 0) {
            logger.info(`[NovaPersonalBrand] 💰 Posting daily fee report (${feeSummary.totalFeesSOL.toFixed(4)} SOL earned)`);
            
            // Post to X
            if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
              const feeTweet = formatFeesForTweet(feeSummary);
              await postToX(feeTweet, 'daily_recap');
            }
            
            // Post to TG
            if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
              const feeTG = formatFeesForTelegram(feeSummary);
              await postToTelegram(feeTG, 'daily_recap');
            }
          } else {
            logger.debug('[NovaPersonalBrand] No creator fees to report today');
          }
        } catch (feeErr) {
          logger.debug(`[NovaPersonalBrand] Fee report failed: ${feeErr}`);
        }
      }
      
      // === PERSONALITY TWEETS (X only) ===
      // Random personality posts 3x per day at 10:00, 14:00, 20:00 UTC
      // Uses variety guard to prevent repetitive post types
      const personalityHours = [10, 14, 20];
      if (personalityHours.includes(currentHour) && lastPersonalityHour !== currentHour) {
        lastPersonalityHour = currentHour;
        
        // Check for market-reactive post first (Enhancement #3)
        const marketTrigger = await checkMarketTriggers();
        if (marketTrigger) {
          logger.info(`[NovaPersonalBrand] 🚨 Market trigger: ${marketTrigger.trigger}`);
          lastMarketReactivePostDate = now.toISOString().split('T')[0];
          await postPersonalityTweet('market_roast', marketTrigger.context);
        } else {
          // Community shoutout check (Enhancement #5) — 25% chance on afternoon slot
          if (currentHour === 14 && Math.random() < 0.25) {
            const shoutout = await generateCommunityShoutout();
            if (shoutout) {
              logger.info('[NovaPersonalBrand] 🤝 Posting community shoutout');
              await postToX(shoutout, 'random_banter');
              recordPostType('random_banter');
            } else {
              // No shoutout available — fall through to normal personality tweet
              await postPersonalityTweet(); // Uses variety guard
            }
          } else {
            // Normal personality tweet with variety guard (Enhancement #1)
            await postPersonalityTweet(); // Picks type via pickVariedPostType()
          }
        }
        
        logger.info(`[NovaPersonalBrand] Personality tweet done at ${currentHour}:00 UTC`);
      }
      
      // === ALPHA DROP (TG exclusive + X tease) ===
      // Once per day at 16:00 UTC — prime time for mystery + FOMO
      if (currentHour === 16 && lastAlphaDropHour !== currentHour) {
        const today = now.toISOString().split('T')[0];
        if (state.lastAlphaDropDate !== today) {
          lastAlphaDropHour = currentHour;
          state.lastAlphaDropDate = today;
          logger.info('[NovaPersonalBrand] Posting alpha drop');
          await postAlphaDrop();
        }
      }
      
      // === COLLAB TWEET (tag ecosystem partners) ===
      // Once per day at 13:00 UTC — when crypto twitter is active  
      if (currentHour === 13 && lastCollabHour !== currentHour) {
        const today = now.toISOString().split('T')[0];
        if (state.lastCollabDate !== today) {
          lastCollabHour = currentHour;
          state.lastCollabDate = today;
          logger.info('[NovaPersonalBrand] Posting collab tweet');
          await postCollabTweet();
        }
      }
      
      // === ENGAGEMENT REPLIES ===
      // Check for mentions and reply 3x per day at 11:00, 17:00, 21:00 UTC
      const replyHours = [11, 17, 21];
      if (replyHours.includes(currentHour) && lastReplyCheckHour !== currentHour) {
        lastReplyCheckHour = currentHour;
        logger.info('[NovaPersonalBrand] Checking for engagement replies');
        const repliesPosted = await processEngagementReplies();
        if (repliesPosted > 0) {
          logger.info(`[NovaPersonalBrand] ✅ Posted ${repliesPosted} engagement replies`);
        }
      }
      
      // Check milestones
      await checkMilestones();
      
      // === POST PERFORMANCE TRACKING (Enhancement #4) ===
      // Check tweet metrics once per day at 19:00 UTC (before evening personality slot)
      if (currentHour === 19 && lastReplyCheckHour !== 19) {
        try {
          await trackPostPerformance();
          const insights = getPerformanceInsights();
          if (insights.bestType) {
            logger.info(`[NovaPersonalBrand] 📊 Performance: ${insights.summary}`);
          }
        } catch (perfErr) {
          logger.debug(`[NovaPersonalBrand] Performance tracking failed: ${perfErr}`);
        }
      }
      
    } catch (err) {
      logger.error('[NovaPersonalBrand] Scheduler error:', err);
    }
  }, 15 * 60 * 1000); // Every 15 minutes
  
  logger.info('[NovaPersonalBrand] Scheduler started');
}

export function stopNovaPersonalScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[NovaPersonalBrand] Scheduler stopped');
  }
}

function isWithinWindow(current: string, target: string, windowMinutes: number): boolean {
  const [currentH, currentM] = current.split(':').map(Number);
  const [targetH, targetM] = target.split(':').map(Number);
  
  const currentMins = currentH * 60 + currentM;
  const targetMins = targetH * 60 + targetM;
  
  return Math.abs(currentMins - targetMins) <= windowMinutes;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  initNovaPersonalBrand,
  startNovaPersonalScheduler,
  stopNovaPersonalScheduler,
  getNovaStats,
  postGm,
  postDailyRecap,
  postWeeklySummary,
  postNovaTease,
  postMarketCommentary,
  postMilestone,
  postCommunityPoll,
  postBehindScenes,
  postToX,
  postToXThread,
  postToTelegram,
  postAlphaDrop,
  postCollabTweet,
  processEngagementReplies,
  checkMilestones,
};
