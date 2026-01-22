import { logger } from '@elizaos/core';
import { canWrite, getQuota, recordWrite, getPostingAdvice } from './xRateLimiter.ts';
import { generateAITweet, generateTweet, suggestTweetType, type TokenContext, type TweetType, type GeneratedTweet } from './xMarketing.ts';
import type { LaunchPack } from '../model/launchPack.ts';
import { getTokenPrice } from './priceService.ts';

/**
 * X Tweet Scheduler
 * 
 * Manages scheduled marketing tweets for launched tokens
 * Respects rate limits and budgets quota intelligently
 */

export interface ScheduledTweet {
  id: string;
  tokenTicker: string;
  tokenMint: string;
  launchPackId: string;
  type: TweetType;
  text: string;
  scheduledFor: string; // ISO date
  status: 'pending' | 'posted' | 'failed' | 'skipped';
  postedAt?: string;
  tweetId?: string;
  error?: string;
  createdAt: string;
}

export interface MarketingSchedule {
  launchPackId: string;
  tokenTicker: string;
  enabled: boolean;
  tweetsPerWeek: number;
  lastTweetAt?: string;
  totalTweeted: number;
  createdAt: string;
}

// In-memory storage (persisted to file)
let scheduledTweets: ScheduledTweet[] = [];
let marketingSchedules: MarketingSchedule[] = [];

const STORAGE_FILE = './data/x_scheduled_tweets.json';
const SCHEDULES_FILE = './data/x_marketing_schedules.json';

/**
 * Load scheduled tweets from file
 */
async function loadScheduledTweets(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const data = await fs.readFile(STORAGE_FILE, 'utf-8');
    scheduledTweets = JSON.parse(data);
    logger.info(`[XScheduler] Loaded ${scheduledTweets.length} scheduled tweets`);
  } catch {
    scheduledTweets = [];
  }
}

async function saveScheduledTweets(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.writeFile(STORAGE_FILE, JSON.stringify(scheduledTweets, null, 2));
  } catch (err) {
    logger.warn('[XScheduler] Failed to save scheduled tweets:', err);
  }
}

async function loadSchedules(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const data = await fs.readFile(SCHEDULES_FILE, 'utf-8');
    marketingSchedules = JSON.parse(data);
    logger.info(`[XScheduler] Loaded ${marketingSchedules.length} marketing schedules`);
  } catch {
    marketingSchedules = [];
  }
}

async function saveSchedules(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(marketingSchedules, null, 2));
  } catch (err) {
    logger.warn('[XScheduler] Failed to save schedules:', err);
  }
}

// Initialize
loadScheduledTweets();
loadSchedules();

/**
 * Create a marketing schedule for a launched token
 */
export async function createMarketingSchedule(
  launchPack: LaunchPack,
  tweetsPerWeek: number = 3
): Promise<MarketingSchedule> {
  const existing = marketingSchedules.find(s => s.launchPackId === launchPack.id);
  if (existing) {
    existing.tweetsPerWeek = tweetsPerWeek;
    existing.enabled = true;
    await saveSchedules();
    return existing;
  }
  
  const schedule: MarketingSchedule = {
    launchPackId: launchPack.id,
    tokenTicker: launchPack.brand?.ticker || 'UNKNOWN',
    enabled: true,
    tweetsPerWeek,
    totalTweeted: 0,
    createdAt: new Date().toISOString(),
  };
  
  marketingSchedules.push(schedule);
  await saveSchedules();
  
  logger.info(`[XScheduler] Created marketing schedule for $${schedule.tokenTicker} (${tweetsPerWeek} tweets/week)`);
  return schedule;
}

/**
 * Schedule a tweet for a specific time
 */
export async function scheduleTweet(
  launchPack: LaunchPack,
  type: TweetType,
  scheduledFor: Date,
  customText?: string
): Promise<ScheduledTweet> {
  const context = await buildTokenContext(launchPack);
  
  let text = customText;
  if (!text) {
    const generated = await generateAITweet(context, type);
    text = generated.text;
  }
  
  const tweet: ScheduledTweet = {
    id: crypto.randomUUID(),
    tokenTicker: launchPack.brand?.ticker || 'UNKNOWN',
    tokenMint: launchPack.launch?.mint || '',
    launchPackId: launchPack.id,
    type,
    text,
    scheduledFor: scheduledFor.toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  
  scheduledTweets.push(tweet);
  await saveScheduledTweets();
  
  logger.info(`[XScheduler] Scheduled tweet for $${tweet.tokenTicker} at ${scheduledFor.toLocaleString()}`);
  return tweet;
}

/**
 * Schedule a series of marketing tweets after launch
 */
export async function schedulePostLaunchMarketing(
  launchPack: LaunchPack,
  daysToSchedule: number = 7
): Promise<ScheduledTweet[]> {
  const scheduled: ScheduledTweet[] = [];
  const quota = getQuota();
  
  // Budget: allocate quota across days
  const tweetsToSchedule = Math.min(daysToSchedule * 2, Math.floor(quota.writes.remaining * 0.3));
  
  if (tweetsToSchedule < 1) {
    logger.warn('[XScheduler] Insufficient quota for marketing schedule');
    return [];
  }
  
  const context = await buildTokenContext(launchPack);
  const tweetTypes: TweetType[] = [
    'chart_callout',      // Day 1
    'community_shoutout', // Day 1
    'daily_update',       // Day 2
    'engagement_bait',    // Day 2
    'milestone_holders',  // Day 3
    'meme',               // Day 4
    'chart_callout',      // Day 5
    'daily_update',       // Day 6
    'community_shoutout', // Day 7
  ];
  
  for (let i = 0; i < Math.min(tweetsToSchedule, tweetTypes.length); i++) {
    // Spread tweets: 1 per day, random time between 9am-7pm
    const dayOffset = i; // 1 tweet per day
    
    const scheduleDate = new Date();
    scheduleDate.setDate(scheduleDate.getDate() + dayOffset + 1); // Start tomorrow
    // Random hour between 9am and 7pm for natural posting
    const randomHour = 9 + Math.floor(Math.random() * 10); // 9-18
    scheduleDate.setHours(randomHour, Math.floor(Math.random() * 45), 0, 0);
    
    const tweet = await scheduleTweet(launchPack, tweetTypes[i], scheduleDate);
    scheduled.push(tweet);
  }
  
  logger.info(`[XScheduler] Scheduled ${scheduled.length} marketing tweets for $${launchPack.brand?.ticker}`);
  return scheduled;
}

/**
 * Get pending scheduled tweets
 */
export function getPendingTweets(): ScheduledTweet[] {
  return scheduledTweets
    .filter(t => t.status === 'pending')
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
}

/**
 * Get tweets due to be posted now
 */
export function getDueTweets(): ScheduledTweet[] {
  const now = new Date();
  return scheduledTweets.filter(t => 
    t.status === 'pending' && 
    new Date(t.scheduledFor) <= now
  );
}

/**
 * Mark a tweet as posted
 */
export async function markTweetPosted(id: string, tweetId: string): Promise<void> {
  const tweet = scheduledTweets.find(t => t.id === id);
  if (tweet) {
    tweet.status = 'posted';
    tweet.postedAt = new Date().toISOString();
    tweet.tweetId = tweetId;
    await saveScheduledTweets();
    
    // Update schedule stats
    const schedule = marketingSchedules.find(s => s.launchPackId === tweet.launchPackId);
    if (schedule) {
      schedule.totalTweeted++;
      schedule.lastTweetAt = tweet.postedAt;
      await saveSchedules();
    }
  }
}

/**
 * Mark a tweet as failed
 */
export async function markTweetFailed(id: string, error: string): Promise<void> {
  const tweet = scheduledTweets.find(t => t.id === id);
  if (tweet) {
    tweet.status = 'failed';
    tweet.error = error;
    await saveScheduledTweets();
  }
}

/**
 * Skip a tweet (e.g., when quota is low)
 */
export async function skipTweet(id: string, reason: string): Promise<void> {
  const tweet = scheduledTweets.find(t => t.id === id);
  if (tweet) {
    tweet.status = 'skipped';
    tweet.error = reason;
    await saveScheduledTweets();
  }
}

/**
 * Cancel all pending tweets for a token
 */
export async function cancelTokenTweets(launchPackId: string): Promise<number> {
  let cancelled = 0;
  for (const tweet of scheduledTweets) {
    if (tweet.launchPackId === launchPackId && tweet.status === 'pending') {
      tweet.status = 'skipped';
      tweet.error = 'Cancelled by user';
      cancelled++;
    }
  }
  await saveScheduledTweets();
  return cancelled;
}

/**
 * Get marketing schedule summary
 */
export function getScheduleSummary(): {
  totalScheduled: number;
  pending: number;
  posted: number;
  failed: number;
  byToken: Record<string, { pending: number; posted: number }>;
} {
  const byToken: Record<string, { pending: number; posted: number }> = {};
  
  for (const tweet of scheduledTweets) {
    if (!byToken[tweet.tokenTicker]) {
      byToken[tweet.tokenTicker] = { pending: 0, posted: 0 };
    }
    if (tweet.status === 'pending') byToken[tweet.tokenTicker].pending++;
    if (tweet.status === 'posted') byToken[tweet.tokenTicker].posted++;
  }
  
  return {
    totalScheduled: scheduledTweets.length,
    pending: scheduledTweets.filter(t => t.status === 'pending').length,
    posted: scheduledTweets.filter(t => t.status === 'posted').length,
    failed: scheduledTweets.filter(t => t.status === 'failed').length,
    byToken,
  };
}

/**
 * Build token context from LaunchPack (with live price data)
 */
async function buildTokenContext(launchPack: LaunchPack): Promise<TokenContext> {
  const xHandle = launchPack.x?.handle;
  const mint = launchPack.launch?.mint || '';
  
  // Debug log to verify xHandle is being read
  if (xHandle) {
    logger.info(`[XScheduler] Token $${launchPack.brand?.ticker} has xHandle: ${xHandle}`);
  } else {
    logger.warn(`[XScheduler] Token $${launchPack.brand?.ticker} has NO xHandle set. x object: ${JSON.stringify(launchPack.x)}`);
  }
  
  // Fetch live price data from DexScreener
  let marketCap: number | undefined;
  let volume24h: number | undefined;
  let priceUsd: number | undefined;
  let priceChange24h: number | undefined;
  
  if (mint) {
    try {
      const priceData = await getTokenPrice(mint);
      if (priceData) {
        marketCap = priceData.marketCap ?? undefined;
        volume24h = priceData.volume24h ?? undefined;
        priceUsd = priceData.priceUsd ?? undefined;
        priceChange24h = priceData.priceChange24h ?? undefined;
        logger.info(`[XScheduler] Price data for $${launchPack.brand?.ticker}: MC=$${marketCap} Vol=$${volume24h} Price=$${priceUsd}`);
      }
    } catch (error) {
      logger.warn(`[XScheduler] Failed to fetch price data for ${mint}:`, error);
    }
  }
  
  return {
    name: launchPack.brand?.name || 'Unknown Token',
    ticker: launchPack.brand?.ticker || 'TOKEN',
    mint,
    pumpUrl: mint
      ? `https://pump.fun/coin/${mint}`
      : '',
    description: launchPack.brand?.description,
    mascot: (launchPack as any).brand?.mascot,
    xHandle: xHandle, // Token's X/Twitter handle
    telegramUrl: launchPack.tg?.invite_link, // Use tg.invite_link from schema
    websiteUrl: launchPack.links?.website, // Website URL from links
    launchDate: launchPack.launch?.launched_at,
    // Live stats from DexScreener
    holders: undefined, // DexScreener doesn't provide this
    marketCap,
    volume24h,
    priceUsd,
    priceChange24h,
  };
}

/**
 * Process scheduled tweets (run periodically)
 */
export async function processScheduledTweets(
  tweetFn: (text: string) => Promise<string | null>
): Promise<{ posted: number; skipped: number; failed: number }> {
  const results = { posted: 0, skipped: 0, failed: 0 };
  
  const dueTweets = getDueTweets();
  if (dueTweets.length === 0) return results;
  
  logger.info(`[XScheduler] Processing ${dueTweets.length} due tweets...`);
  
  const advice = getPostingAdvice();
  
  for (const tweet of dueTweets) {
    // Check quota before each tweet
    if (!canWrite()) {
      await skipTweet(tweet.id, 'Monthly quota exhausted');
      results.skipped++;
      continue;
    }
    
    // If quota is very low, only post critical content
    if (advice.urgency === 'high' && !['launch_announcement', 'milestone_mcap'].includes(tweet.type)) {
      await skipTweet(tweet.id, 'Quota low - saving for critical tweets');
      results.skipped++;
      continue;
    }
    
    try {
      const tweetId = await tweetFn(tweet.text);
      if (tweetId) {
        await markTweetPosted(tweet.id, tweetId);
        await recordWrite(tweet.text);
        results.posted++;
        logger.info(`[XScheduler] ✅ Posted: ${tweet.text.substring(0, 50)}...`);
      } else {
        await markTweetFailed(tweet.id, 'No tweet ID returned');
        results.failed++;
      }
    } catch (error: any) {
      const errorCode = error?.code || 'UNKNOWN';
      const errorMsg = error?.message || String(error);
      await markTweetFailed(tweet.id, errorMsg);
      results.failed++;
      
      // Log gracefully based on error type
      if (errorCode === 'X_DUPLICATE') {
        logger.warn(`[XScheduler] ⚠️ Skipped duplicate: ${tweet.text.substring(0, 40)}...`);
      } else if (errorCode === 'X_FORBIDDEN') {
        logger.warn(`[XScheduler] ⚠️ Permission denied: ${errorMsg}`);
      } else if (errorCode === 'X_RATE_LIMIT') {
        logger.warn(`[XScheduler] ⚠️ Rate limited - will retry later`);
      } else {
        logger.error(`[XScheduler] ❌ Tweet failed: ${errorMsg}`);
      }
    }
    
    // Small delay between tweets to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }
  
  logger.info(`[XScheduler] Processed: ${results.posted} posted, ${results.skipped} skipped, ${results.failed} failed`);
  return results;
}

/**
 * Recover marketing schedules from LaunchPack database
 * This ensures we don't lose marketing tracking even if JSON files are lost
 */
export async function recoverMarketingFromStore(
  store: { list: () => Promise<LaunchPack[]>; update: (id: string, data: any) => Promise<any> }
): Promise<{ recovered: number; rescheduled: number }> {
  const results = { recovered: 0, rescheduled: 0 };
  
  try {
    const allPacks = await store.list();
    const launchedPacks = allPacks.filter(p => p.launch?.status === 'launched');
    
    for (const pack of launchedPacks) {
      const hasMarketing = pack.ops?.x_marketing_enabled;
      const existingSchedule = marketingSchedules.find(s => s.launchPackId === pack.id);
      
      // If pack has marketing enabled but no schedule in memory, recover it
      if (hasMarketing && !existingSchedule) {
        const schedule: MarketingSchedule = {
          launchPackId: pack.id,
          tokenTicker: pack.brand?.ticker || 'TOKEN',
          enabled: true,
          tweetsPerWeek: pack.ops?.x_marketing_tweets_per_week || 3,
          lastTweetAt: pack.ops?.x_marketing_last_tweet_at,
          totalTweeted: pack.ops?.x_marketing_total_tweeted || 0,
          createdAt: pack.ops?.x_marketing_created_at || new Date().toISOString(),
        };
        marketingSchedules.push(schedule);
        results.recovered++;
        logger.info(`[XScheduler] Recovered marketing schedule for $${pack.brand?.ticker}`);
      }
      
      // If launched but no marketing at all, schedule it now (recovery mode)
      if (!hasMarketing && pack.launch?.launched_at) {
        const launchDate = new Date(pack.launch.launched_at);
        const daysSinceLaunch = (Date.now() - launchDate.getTime()) / (1000 * 60 * 60 * 24);
        
        // Only auto-schedule if launched within last 14 days
        if (daysSinceLaunch <= 14) {
          try {
            const remaining = Math.max(1, 7 - Math.floor(daysSinceLaunch));
            const scheduled = await schedulePostLaunchMarketing(pack, remaining);
            if (scheduled.length > 0) {
              // Mark in database that marketing is now enabled
              await store.update(pack.id, {
                ops: {
                  ...(pack.ops || {}),
                  x_marketing_enabled: true,
                  x_marketing_tweets_per_week: 3,
                  x_marketing_total_tweeted: 0,
                  x_marketing_created_at: new Date().toISOString(),
                  x_marketing_scheduled_count: scheduled.length,
                },
              });
              results.rescheduled++;
              logger.info(`[XScheduler] Auto-scheduled ${scheduled.length} tweets for $${pack.brand?.ticker} (recovery)`);
            }
          } catch (err) {
            logger.warn(`[XScheduler] Could not reschedule for $${pack.brand?.ticker}: ${(err as Error).message}`);
          }
        }
      }
    }
    
    if (results.recovered > 0 || results.rescheduled > 0) {
      await saveSchedules();
      logger.info(`[XScheduler] Recovery complete: ${results.recovered} recovered, ${results.rescheduled} rescheduled`);
    }
  } catch (err) {
    logger.error('[XScheduler] Recovery failed:', err);
  }
  
  return results;
}

/**
 * Sync marketing stats back to LaunchPack database
 * Call this after posting tweets to keep DB in sync
 */
export async function syncMarketingToStore(
  store: { update: (id: string, data: any) => Promise<any> },
  launchPackId: string
): Promise<void> {
  const schedule = marketingSchedules.find(s => s.launchPackId === launchPackId);
  if (!schedule) return;
  
  const pending = scheduledTweets.filter(t => 
    t.launchPackId === launchPackId && t.status === 'pending'
  ).length;
  
  try {
    await store.update(launchPackId, {
      ops: {
        x_marketing_enabled: schedule.enabled,
        x_marketing_tweets_per_week: schedule.tweetsPerWeek,
        x_marketing_total_tweeted: schedule.totalTweeted,
        x_marketing_last_tweet_at: schedule.lastTweetAt,
        x_marketing_scheduled_count: pending,
      },
    });
  } catch (err) {
    logger.warn(`[XScheduler] Failed to sync marketing stats: ${(err as Error).message}`);
  }
}

/**
 * Regenerate pending tweet text with fresh AI generation
 * Use this to fix tweets that were scheduled with broken URLs
 */
export async function regeneratePendingTweets(
  store: { get: (id: string) => Promise<LaunchPack | null> }
): Promise<{ regenerated: number; failed: number }> {
  const results = { regenerated: 0, failed: 0 };
  
  const pendingTweets = scheduledTweets.filter(t => t.status === 'pending');
  logger.info(`[XScheduler] Regenerating ${pendingTweets.length} pending tweets...`);
  
  for (const tweet of pendingTweets) {
    try {
      const launchPack = await store.get(tweet.launchPackId);
      if (!launchPack) {
        logger.warn(`[XScheduler] Could not find LaunchPack for tweet ${tweet.id}`);
        results.failed++;
        continue;
      }
      
      const context = await buildTokenContext(launchPack);
      const generated = await generateAITweet(context, tweet.type);
      
      // Update the tweet text
      tweet.text = generated.text;
      logger.info(`[XScheduler] Regenerated tweet for $${tweet.tokenTicker}: ${generated.text.substring(0, 50)}...`);
      results.regenerated++;
    } catch (err) {
      logger.error(`[XScheduler] Failed to regenerate tweet ${tweet.id}:`, err);
      results.failed++;
    }
  }
  
  await saveScheduledTweets();
  logger.info(`[XScheduler] Regeneration complete: ${results.regenerated} regenerated, ${results.failed} failed`);
  return results;
}

// ============================================================================
// AUTO-REFILL SCHEDULER (Similar to TG Scheduler)
// ============================================================================

const AUTO_TWEETS_PER_DAY = 2; // Tweets per day per token (conservative for X rate limits)
const MIN_PENDING_TWEETS = 5; // Auto-refill when below this
const REFILL_DAYS = 3; // Days to schedule ahead

let xSchedulerInterval: ReturnType<typeof setInterval> | null = null;
let xRefillInterval: ReturnType<typeof setInterval> | null = null;
let xStore: { list: () => Promise<LaunchPack[]> } | null = null;

/**
 * Auto-refill X marketing queue for all launched tokens
 */
async function autoRefillXMarketing(): Promise<void> {
  if (!xStore) {
    logger.warn('[XScheduler] Store not initialized, skipping auto-refill');
    return;
  }
  
  // Check quota first
  const quota = getQuota();
  if (quota.writes.remaining < 5) {
    logger.info('[XScheduler] Quota too low for auto-refill, skipping');
    return;
  }
  
  try {
    const allPacks = await xStore.list();
    
    // Find launched tokens
    const launchedPacks = allPacks.filter((p: LaunchPack) => 
      p.launch?.mint || p.launch?.status === 'launched'
    );
    
    if (launchedPacks.length === 0) {
      return;
    }
    
    for (const pack of launchedPacks) {
      const ticker = pack.brand?.ticker || 'UNKNOWN';
      const pendingForToken = scheduledTweets.filter(t => 
        t.launchPackId === pack.id && t.status === 'pending'
      );
      
      if (pendingForToken.length < MIN_PENDING_TWEETS) {
        logger.info(`[XScheduler] Auto-refilling tweets for $${ticker} (${pendingForToken.length} pending)`);
        
        try {
          const newTweets = await schedulePostLaunchMarketing(pack, REFILL_DAYS);
          logger.info(`[XScheduler] ✅ Auto-scheduled ${newTweets.length} tweets for $${ticker}`);
        } catch (err) {
          logger.warn(`[XScheduler] Failed to auto-refill for $${ticker}:`, err);
        }
      }
    }
  } catch (err) {
    logger.error('[XScheduler] Auto-refill error:', err);
  }
}

/**
 * Start the X scheduler with auto-refill
 */
export function startXScheduler(
  store: { list: () => Promise<LaunchPack[]> },
  tweetFn: (text: string) => Promise<string | null>
): void {
  xStore = store;
  
  if (xSchedulerInterval) {
    logger.info('[XScheduler] Scheduler already running');
    return;
  }
  
  // Check for due tweets every 5 minutes
  xSchedulerInterval = setInterval(async () => {
    try {
      const pending = getPendingTweets();
      if (pending.length === 0) return;
      
      const results = await processScheduledTweets(tweetFn);
      if (results.posted > 0 || results.failed > 0) {
        logger.info(`[XScheduler] Processed: ${results.posted} posted, ${results.skipped} skipped, ${results.failed} failed`);
      }
    } catch (err) {
      logger.error('[XScheduler] Processing error:', err);
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  // Auto-refill every 2 hours (less aggressive than TG due to X rate limits)
  xRefillInterval = setInterval(async () => {
    try {
      await autoRefillXMarketing();
    } catch (err) {
      logger.error('[XScheduler] Auto-refill error:', err);
    }
  }, 2 * 60 * 60 * 1000); // 2 hours
  
  // Initial refill after 30 seconds
  setTimeout(async () => {
    logger.info('[XScheduler] Running initial auto-refill...');
    await autoRefillXMarketing();
  }, 30000);
  
  logger.info('[XScheduler] ✅ Auto-tweet scheduler started (checking every 5 min, refill every 2 hours)');
}

/**
 * Stop the X scheduler
 */
export function stopXScheduler(): void {
  if (xSchedulerInterval) {
    clearInterval(xSchedulerInterval);
    xSchedulerInterval = null;
  }
  if (xRefillInterval) {
    clearInterval(xRefillInterval);
    xRefillInterval = null;
  }
  xStore = null;
  logger.info('[XScheduler] Stopped auto-tweet scheduler');
}

export default {
  createMarketingSchedule,
  scheduleTweet,
  schedulePostLaunchMarketing,
  getPendingTweets,
  getDueTweets,
  getScheduleSummary,
  cancelTokenTweets,
  processScheduledTweets,
  recoverMarketingFromStore,
  syncMarketingToStore,
  regeneratePendingTweets,
  startXScheduler,
  stopXScheduler,
};