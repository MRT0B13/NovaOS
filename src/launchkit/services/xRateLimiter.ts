import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { PostgresScheduleRepository, type XUsageData } from '../db/postgresScheduleRepository.ts';

/**
 * X/Twitter Rate Limiter
 * 
 * Writes: Pay-per-use, ~$0.03 per tweet posted.
 * Reads: Pay-per-use, billed per POST CONSUMED (each tweet returned by the API),
 *        NOT per API call. A search returning 10 tweets = 10 posts consumed.
 *        Approximate cost: ~$0.015 per post consumed.
 *        Set X_READ_BUDGET_USD to control monthly spend.
 *        If X_READ_BUDGET_USD=0, falls back to X_MONTHLY_READ_LIMIT hard cap (default 100).
 * 
 * Example: X_READ_BUDGET_USD=5 → ~333 posts consumed/month → ~11 posts/day
 *
 * IMPORTANT: All callers (reply engine, KOL scanner, etc.) MUST call
 * recordSearchRead() or recordMentionRead() after each API call so the
 * budget tracker and cooldown clocks stay accurate.
 */

// PostgreSQL support
let pgRepo: PostgresScheduleRepository | null = null;
let usePostgres = false;

interface UsageData {
  month: string; // YYYY-MM format
  reads: number;
  writes: number;
  lastWrite: string | null;
  lastRead: string | null;
  writeHistory: { timestamp: string; text: string }[];
}

// In-memory usage tracking (persisted to file or PostgreSQL for durability)
let usageData: UsageData = {
  month: getCurrentMonth(),
  reads: 0,
  writes: 0,
  lastWrite: null,
  lastRead: null,
  writeHistory: [],
};

// Shared 429 backoff — when ANY component hits a Twitter 429, ALL posting pauses.
const BASE_RATE_LIMIT_BACKOFF_MS = 16 * 60 * 1000; // 16 minutes (> Twitter's 15-min window)
const MAX_RATE_LIMIT_BACKOFF_MS = 120 * 60 * 1000; // 2 hours max
let rateLimitedUntil = 0;
let consecutive429Count = 0; // Track consecutive 429s for exponential backoff
let last429At = 0; // When the last 429 occurred
// Separate read backoff — search/mentions 429 (free tier: 1 search per 15 min)
let readRateLimitedUntil = 0;
let readConsecutive429Count = 0;
let lastRead429At = 0;

// Per-endpoint read tracking — cooldowns to avoid hammering the API.
// PPU tier actual rate limits: 300/15min for both mentions and search.
// However, billing is per POST CONSUMED (~$0.015/post), not per API call.
// A search returning 10 tweets costs ~$0.15 per call. We use conservative
// cooldowns to keep monthly spend manageable.
const PPU_MENTION_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes — mentions are expensive (10 posts each)
const PPU_SEARCH_COOLDOWN_MS  = 10 * 60 * 1000;  // 10 minutes — search returns 10 posts (~$0.15 each call)
const FREE_ENDPOINT_COOLDOWN_MS = 16 * 60 * 1000; // 16 minutes (1 per 15 min)
let lastMentionReadAt = 0;
let lastSearchReadAt  = 0;

function getMentionCooldownMs(): number {
  return isPayPerUseReads() ? PPU_MENTION_COOLDOWN_MS : FREE_ENDPOINT_COOLDOWN_MS;
}
function getSearchCooldownMs(): number {
  return isPayPerUseReads() ? PPU_SEARCH_COOLDOWN_MS : FREE_ENDPOINT_COOLDOWN_MS;
}

// Daily write tracking — X pay-per-use enforces 17 tweets per 24h rolling window.
// We use 15 as a safety buffer (2 under the real limit of 17) to avoid 429s.
const DAILY_WRITE_LIMIT = 15; // x-app-limit-24hour-limit is 17, we use 15 for safety margin
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const recentWriteTimestamps: number[] = [];

// Startup write cooldown — prevent burst-tweeting immediately after redeploy.
// The bot waits this long before allowing any writes after init.
const STARTUP_WRITE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
let startupTime = Date.now();

function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function resetIfNewMonth(): void {
  const currentMonth = getCurrentMonth();
  if (usageData.month !== currentMonth) {
    logger.info(`[X-RateLimiter] New month detected, resetting counters (${usageData.month} → ${currentMonth})`);
    usageData = {
      month: currentMonth,
      reads: 0,
      writes: 0,
      lastWrite: null,
      lastRead: null,
      writeHistory: [],
    };
    saveUsage();
  }
}

// Load/save usage from file for persistence across restarts
const USAGE_FILE = './data/x_usage.json';

/**
 * Initialize PostgreSQL if DATABASE_URL is available
 */
export async function initXRateLimiter(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      usePostgres = true;
      logger.info('[X-RateLimiter] PostgreSQL storage initialized');
    } catch (err) {
      logger.warn('[X-RateLimiter] Failed to init PostgreSQL, using file:', err);
      pgRepo = null;
      usePostgres = false;
    }
  }
  await loadUsage();
}

async function loadUsageFromFile(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const data = await fs.readFile(USAGE_FILE, 'utf-8');
    usageData = JSON.parse(data);
    logger.info(`[X-RateLimiter] Loaded usage from file: ${usageData.writes}/${getWriteLimit()} writes, ${usageData.reads}/${getReadLimit()} reads`);
  } catch {
    // File doesn't exist yet, use defaults
  }
}

async function saveUsageToFile(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.writeFile(USAGE_FILE, JSON.stringify(usageData, null, 2));
  } catch (err) {
    logger.warn('[X-RateLimiter] Failed to save usage data:', err);
  }
}

async function loadUsage(): Promise<void> {
  if (usePostgres && pgRepo) {
    const data = await pgRepo.getXUsage(getCurrentMonth());
    if (data) {
      usageData = data as UsageData;
      logger.info(`[X-RateLimiter] Loaded usage from PostgreSQL: ${usageData.writes}/${getWriteLimit()} writes`);
    }
  } else {
    await loadUsageFromFile();
  }
  resetIfNewMonth();

  // Restore the 24h rolling window from Postgres (primary) or writeHistory (fallback).
  // Without this, every restart would reset the daily counter and cause 429s.
  const cutoff = Date.now() - DAILY_WINDOW_MS;
  recentWriteTimestamps.length = 0;

  if (usePostgres && pgRepo) {
    try {
      const pgTimestamps = await pgRepo.getDailyWriteTimestamps();
      for (const ts of pgTimestamps) {
        if (ts > cutoff) recentWriteTimestamps.push(ts);
      }
      logger.info(`[X-RateLimiter] Loaded ${recentWriteTimestamps.length} daily timestamps from PostgreSQL`);
    } catch (err) {
      logger.warn('[X-RateLimiter] Failed to load daily timestamps from PG, falling back to writeHistory:', err);
    }

    // Fallback: if PG returned 0 timestamps (new column, post-migration, or 429-blocked),
    // rebuild from writeHistory so we don't burst-post on restart.
    if (recentWriteTimestamps.length === 0 && usageData.writeHistory?.length) {
      for (const entry of usageData.writeHistory) {
        const ts = new Date(entry.timestamp).getTime();
        if (ts > cutoff && !isNaN(ts)) recentWriteTimestamps.push(ts);
      }
      if (recentWriteTimestamps.length > 0) {
        logger.info(`[X-RateLimiter] Rebuilt ${recentWriteTimestamps.length} daily timestamps from writeHistory fallback`);
        // Back-fill the PG column so next restart loads cleanly
        saveDailyTimestampsToPg().catch(() => {});
      }
    }
  } else {
    // File-based: rebuild from writeHistory
    for (const entry of usageData.writeHistory || []) {
      const ts = new Date(entry.timestamp).getTime();
      if (ts > cutoff && !isNaN(ts)) recentWriteTimestamps.push(ts);
    }
  }

  recentWriteTimestamps.sort((a, b) => a - b);
  const dailyUsed = recentWriteTimestamps.length;
  const dailyRemaining = Math.max(0, DAILY_WRITE_LIMIT - dailyUsed);
  logger.info(`[X-RateLimiter] 24h window: ${dailyUsed} tweets sent, ${dailyRemaining} daily remaining`);

  if (dailyRemaining <= 0) {
    // Oldest tweet that will age out of the 24h window:
    const oldestTs = recentWriteTimestamps[0];
    const resumeAt = oldestTs ? new Date(oldestTs + DAILY_WINDOW_MS).toISOString() : 'unknown';
    logger.warn(`[X-RateLimiter] ⚠️ DAILY QUOTA EXHAUSTED on restart (${dailyUsed}/${DAILY_WRITE_LIMIT}). All X writes blocked until ${resumeAt}`);
  } else if (dailyRemaining <= 3) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW DAILY QUOTA on restart: ${dailyRemaining} tweets remaining`);
  }

  // Reset startup cooldown clock
  startupTime = Date.now();
  logger.info(`[X-RateLimiter] Startup write cooldown active for ${STARTUP_WRITE_COOLDOWN_MS / 1000}s`);
}

async function saveUsage(): Promise<void> {
  if (usePostgres && pgRepo) {
    await pgRepo.saveXUsage(usageData as XUsageData);
  } else {
    await saveUsageToFile();
  }
}

/** Persist the 24h write timestamps to Postgres */
async function saveDailyTimestampsToPg(): Promise<void> {
  if (usePostgres && pgRepo) {
    try {
      await pgRepo.saveDailyWriteTimestamps([...recentWriteTimestamps]);
    } catch (err) {
      logger.warn('[X-RateLimiter] Failed to persist daily timestamps to PG:', err);
    }
  }
}

/**
 * Get configured limits from env (defaults to free tier)
 */
function getWriteLimit(): number {
  const env = getEnv();
  return (env as any).X_MONTHLY_WRITE_LIMIT || 500;
}

// X API bills per POST CONSUMED (~$0.015/post). Each API call can return
// multiple posts (up to max_results). We track "reads" as posts consumed,
// not API calls, so that budget math is accurate.
const X_POST_COST_USD = 0.015; // ~$0.015 per post consumed (X pay-per-use)

function getReadLimit(): number {
  const env = getEnv();
  const budget = (env as any).X_READ_BUDGET_USD || 0;
  if (budget > 0) {
    // Budget mode: derive max posts consumed from dollar budget
    return Math.floor(budget / X_POST_COST_USD);
  }
  // Fallback: hard cap (old free-tier style)
  return (env as any).X_MONTHLY_READ_LIMIT || 100;
}

/**
 * Get current read spend in USD this month (based on posts consumed)
 */
export function getReadSpendUsd(): number {
  resetIfNewMonth();
  return usageData.reads * X_POST_COST_USD;
}

/**
 * Check if reads are using the pay-per-use budget model
 */
export function isPayPerUseReads(): boolean {
  const env = getEnv();
  return ((env as any).X_READ_BUDGET_USD || 0) > 0;
}

/**
 * Check if we can make a write (post/tweet)
 * Checks both monthly cap and 24h rolling window (17/day on pay-per-use)
 */
export function canWrite(): boolean {
  resetIfNewMonth();
  // Startup cooldown — don't tweet for 2 min after boot to avoid burst
  if (Date.now() - startupTime < STARTUP_WRITE_COOLDOWN_MS) return false;
  if (usageData.writes >= getWriteLimit()) return false;
  // Check 24h rolling window
  const cutoff = Date.now() - DAILY_WINDOW_MS;
  const writesInWindow = recentWriteTimestamps.filter(t => t > cutoff).length;
  return writesInWindow < DAILY_WRITE_LIMIT;
}

/**
 * Get remaining daily tweet budget (24h rolling window)
 */
export function getDailyWritesRemaining(): number {
  const cutoff = Date.now() - DAILY_WINDOW_MS;
  const writesInWindow = recentWriteTimestamps.filter(t => t > cutoff).length;
  return Math.max(0, DAILY_WRITE_LIMIT - writesInWindow);
}

/**
 * Check if we can make a read (respects both monthly quota and 429 backoff)
 */
export function canRead(): boolean {
  resetIfNewMonth();
  if (isReadRateLimited()) return false;
  return usageData.reads < getReadLimit();
}

/**
 * Get remaining quota
 */
export function getQuota(): { 
  writes: { used: number; limit: number; remaining: number };
  reads: { used: number; limit: number; remaining: number };
  month: string;
  lastWrite: string | null;
} {
  resetIfNewMonth();
  return {
    writes: {
      used: usageData.writes,
      limit: getWriteLimit(),
      remaining: getWriteLimit() - usageData.writes,
    },
    reads: {
      used: usageData.reads,
      limit: getReadLimit(),
      remaining: getReadLimit() - usageData.reads,
    },
    month: usageData.month,
    lastWrite: usageData.lastWrite,
  };
}

/**
 * Record a write operation
 */
export async function recordWrite(tweetText?: string): Promise<void> {
  resetIfNewMonth();
  usageData.writes++;
  usageData.lastWrite = new Date().toISOString();
  recentWriteTimestamps.push(Date.now());
  // Prune old timestamps (older than 24h)
  const cutoff = Date.now() - DAILY_WINDOW_MS;
  while (recentWriteTimestamps.length > 0 && recentWriteTimestamps[0] < cutoff) {
    recentWriteTimestamps.shift();
  }
  if (tweetText) {
    usageData.writeHistory.push({
      timestamp: usageData.lastWrite,
      text: tweetText.slice(0, 100),
    });
    // Keep only last 50 entries
    if (usageData.writeHistory.length > 50) {
      usageData.writeHistory = usageData.writeHistory.slice(-50);
    }
  }
  await saveUsage();
  await saveDailyTimestampsToPg(); // persist 24h window to Postgres
  
  // Successful tweet — reset consecutive 429 counter
  consecutive429Count = 0;
  
  const dailyRemaining = getDailyWritesRemaining();
  const monthlyRemaining = getWriteLimit() - usageData.writes;
  logger.info(`[X-RateLimiter] Tweet sent. ${dailyRemaining} daily / ${monthlyRemaining} monthly writes remaining.`);
  
  if (dailyRemaining <= 3) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW DAILY QUOTA: Only ${dailyRemaining} tweets left in 24h window!`);
    import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_daily_quota',
      `Only <b>${dailyRemaining}</b> tweets left in 24h rolling window (limit: ${DAILY_WRITE_LIMIT}).`
    )).catch(() => {});
  }
  if (monthlyRemaining <= 50) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW MONTHLY QUOTA: Only ${monthlyRemaining} tweets remaining this month!`);
    import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_monthly_quota',
      `Only <b>${monthlyRemaining}</b> tweets remaining this month (limit: ${getWriteLimit()}).`
    )).catch(() => {});
  }
}

/**
 * Record a read operation
 */
export async function recordRead(): Promise<void> {
  resetIfNewMonth();
  usageData.reads++;
  usageData.lastRead = new Date().toISOString();
  await saveUsage();
}

/**
 * Get usage summary for the agent
 */
export function getUsageSummary(): string {
  const quota = getQuota();
  const writePct = Math.round((quota.writes.used / quota.writes.limit) * 100);
  const readPct = Math.round((quota.reads.used / quota.reads.limit) * 100);
  
  let status = '✅';
  if (quota.writes.remaining <= 50) status = '⚠️';
  if (quota.writes.remaining <= 10) status = '🚨';
  if (quota.writes.remaining <= 0) status = '❌';
  
  const readLine = isPayPerUseReads()
    ? `📖 Posts consumed: ${quota.reads.used} (~$${getReadSpendUsd().toFixed(2)} / $${((getEnv() as any).X_READ_BUDGET_USD || 0).toFixed(2)} budget)`
    : `📖 Posts consumed: ${quota.reads.used}/${quota.reads.limit} (${readPct}% used)`;
  
  return `${status} X/Twitter Usage (${quota.month}):
📝 Tweets: ${quota.writes.used}/${quota.writes.limit} (${writePct}% used, ${quota.writes.remaining} remaining)
${readLine}
${quota.lastWrite ? `Last tweet: ${new Date(quota.lastWrite).toLocaleString()}` : 'No tweets this month'}`;
}

/**
 * Report a Twitter 429 rate limit hit. Any component (reply engine,
 * brand posts, marketing) should call this when it receives a 429.
 * Uses exponential backoff: 16 min → 32 min → 64 min → 2h max.
 * Consecutive 429 counter resets after 1 hour of no 429s.
 */
export function reportRateLimit(): void {
  const now = Date.now();
  // Reset consecutive counter if it's been > 1 hour since the last 429
  if (now - last429At > 60 * 60 * 1000) {
    consecutive429Count = 0;
  }
  consecutive429Count++;
  last429At = now;
  
  // Exponential backoff: 16 min * 2^(consecutive-1), capped at 2 hours
  const backoffMs = Math.min(
    BASE_RATE_LIMIT_BACKOFF_MS * Math.pow(2, consecutive429Count - 1),
    MAX_RATE_LIMIT_BACKOFF_MS
  );
  rateLimitedUntil = now + backoffMs;
  const resumeAt = new Date(rateLimitedUntil).toISOString();
  const backoffMin = Math.round(backoffMs / 60000);
  logger.warn(`[X-RateLimiter] ⚠️ Twitter 429 #${consecutive429Count} — ALL posting paused until ${resumeAt} (${backoffMin} min backoff)`);
  import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_429_write',
    `Twitter <b>429 rate limit</b> hit (#${consecutive429Count}).\nAll posting paused until <code>${resumeAt}</code> (${backoffMin} min backoff).`
  )).catch(() => {});
}

/**
 * Check if we're currently in a 429 backoff window.
 */
export function isRateLimited(): boolean {
  return rateLimitedUntil > Date.now();
}

/**
 * Report a Twitter 429 on read/search.
 * Uses exponential backoff: 16 min → 32 min → 64 min → 2h max.
 * Consecutive counter resets after 1 hour of no read 429s.
 */
export function reportReadRateLimit(): void {
  const now = Date.now();
  // Reset consecutive counter if it's been > 1 hour since the last read 429
  if (now - lastRead429At > 60 * 60 * 1000) {
    readConsecutive429Count = 0;
  }
  readConsecutive429Count++;
  lastRead429At = now;

  const backoffMs = Math.min(
    BASE_RATE_LIMIT_BACKOFF_MS * Math.pow(2, readConsecutive429Count - 1),
    MAX_RATE_LIMIT_BACKOFF_MS
  );
  readRateLimitedUntil = now + backoffMs;
  const resumeAt = new Date(readRateLimitedUntil).toISOString();
  const backoffMin = Math.round(backoffMs / 60000);
  logger.warn(`[X-RateLimiter] ⚠️ Read 429 #${readConsecutive429Count} — reads paused until ${resumeAt} (${backoffMin} min backoff)`);
  import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_429_read',
    `Twitter <b>429 rate limit</b> hit on reads (#${readConsecutive429Count}).\nReads paused until <code>${resumeAt}</code> (${backoffMin} min backoff).`
  )).catch(() => {});
}

/**
 * Check if reads are currently in a 429 backoff window.
 */
export function isReadRateLimited(): boolean {
  return readRateLimitedUntil > Date.now();
}

// ────────────────────────────────────────────────────────────────────────────
// Per-endpoint read gating (prevents 429s proactively)
// Pay-per-use: mentions 5/15min (4 min cooldown), search 60/15min (1 min cooldown)
// Free tier: 1/15min per endpoint (16 min cooldown)
// ────────────────────────────────────────────────────────────────────────────

/** Check if enough time has passed since the last mentions read */
export function canReadMentions(): boolean {
  if (Date.now() - startupTime < STARTUP_WRITE_COOLDOWN_MS) return false; // boot cooldown
  if (isReadRateLimited()) return false;
  if (!canRead()) return false;
  return Date.now() - lastMentionReadAt >= getMentionCooldownMs();
}

/** Check if enough time has passed since the last search read */
export function canReadSearch(): boolean {
  if (Date.now() - startupTime < STARTUP_WRITE_COOLDOWN_MS) return false; // boot cooldown
  if (isReadRateLimited()) return false;
  if (!canRead()) return false;
  return Date.now() - lastSearchReadAt >= getSearchCooldownMs();
}

/** How many seconds until mentions endpoint is available again */
export function mentionsCooldownRemaining(): number {
  const remaining = (lastMentionReadAt + getMentionCooldownMs()) - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** How many seconds until search endpoint is available again */
export function searchCooldownRemaining(): number {
  const remaining = (lastSearchReadAt + getSearchCooldownMs()) - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Record a mentions read — sets the cooldown clock.
 * @param postsConsumed Number of tweets actually returned (default 10)
 */
export async function recordMentionRead(postsConsumed = 10): Promise<void> {
  lastMentionReadAt = Date.now();
  readConsecutive429Count = 0; // Successful read — reset backoff
  // Record each post consumed individually for accurate budget tracking
  for (let i = 0; i < postsConsumed; i++) await recordRead();
  const cdMin = (getMentionCooldownMs() / 60000).toFixed(0);
  const cost = (postsConsumed * X_POST_COST_USD).toFixed(3);
  logger.info(`[X-RateLimiter] Mentions read: ${postsConsumed} posts consumed (~$${cost}). Next in ${cdMin}m`);
}

/**
 * Record a search read — sets the cooldown clock.
 * @param postsConsumed Number of tweets actually returned (default 10)
 */
export async function recordSearchRead(postsConsumed = 10): Promise<void> {
  lastSearchReadAt = Date.now();
  readConsecutive429Count = 0; // Successful read — reset backoff
  // Record each post consumed individually for accurate budget tracking
  for (let i = 0; i < postsConsumed; i++) await recordRead();
  const cdMin = (getSearchCooldownMs() / 60000).toFixed(0);
  const cost = (postsConsumed * X_POST_COST_USD).toFixed(3);
  logger.info(`[X-RateLimiter] Search read: ${postsConsumed} posts consumed (~$${cost}). Next in ${cdMin}m`);
}

/**
 * Check if posting is advisable based on usage patterns
 * Returns recommendation for the agent
 */
export function getPostingAdvice(): { 
  canPost: boolean; 
  shouldPost: boolean; 
  reason: string;
  urgency: 'high' | 'medium' | 'low' | 'none';
} {
  // Startup cooldown — don't tweet for 2 min after boot
  if (Date.now() - startupTime < STARTUP_WRITE_COOLDOWN_MS) {
    const remainSec = Math.ceil((startupTime + STARTUP_WRITE_COOLDOWN_MS - Date.now()) / 1000);
    return {
      canPost: false,
      shouldPost: false,
      reason: `Startup cooldown — writes paused for ${remainSec}s after boot.`,
      urgency: 'none',
    };
  }

  // Check shared 429 backoff first — blocks ALL posting
  if (isRateLimited()) {
    const remainMin = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
    return {
      canPost: false,
      shouldPost: false,
      reason: `Twitter rate limited (429). Resuming in ~${remainMin}m.`,
      urgency: 'none',
    };
  }

  // Check daily 24h rolling window (17 tweets/day on pay-per-use)
  const dailyRemaining = getDailyWritesRemaining();
  if (dailyRemaining <= 0) {
    return {
      canPost: false,
      shouldPost: false,
      reason: `Daily tweet limit reached (${DAILY_WRITE_LIMIT}/24h). Wait for oldest tweet to age out.`,
      urgency: 'none',
    };
  }

  const quota = getQuota();
  
  if (!canWrite()) {
    return {
      canPost: false,
      shouldPost: false,
      reason: `Monthly tweet limit reached (${quota.writes.limit}). Wait until ${getNextMonthDate()}.`,
      urgency: 'none',
    };
  }
  
  // Use the tighter of daily or monthly remaining
  const effectiveRemaining = Math.min(dailyRemaining, quota.writes.remaining);
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const currentDay = new Date().getDate();
  const daysRemaining = daysInMonth - currentDay;
  const tweetsPerDay = daysRemaining > 0 ? quota.writes.remaining / daysRemaining : 0;
  
  if (dailyRemaining <= 3) {
    return {
      canPost: true,
      shouldPost: false,
      reason: `Only ${dailyRemaining} tweets left in 24h window! Save for critical posts only.`,
      urgency: 'high',
    };
  }
  
  if (effectiveRemaining <= 10) {
    return {
      canPost: true,
      shouldPost: false,
      reason: `Only ${quota.writes.remaining} tweets left! Save for critical announcements only.`,
      urgency: 'high',
    };
  }
  
  if (quota.writes.remaining <= 50) {
    return {
      canPost: true,
      shouldPost: true,
      reason: `${quota.writes.remaining} tweets remaining. Post selectively (~${tweetsPerDay.toFixed(1)}/day budget).`,
      urgency: 'medium',
    };
  }
  
  return {
    canPost: true,
    shouldPost: true,
    reason: `${quota.writes.remaining} tweets available. ~${tweetsPerDay.toFixed(1)} tweets/day budget.`,
    urgency: 'low',
  };
}

function getNextMonthDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toLocaleDateString();
}

/**
 * Wrapper for safe tweeting that respects rate limits
 */
export async function safeTweet(
  tweetFn: () => Promise<any>,
  tweetText: string
): Promise<{ success: boolean; result?: any; error?: string }> {
  const advice = getPostingAdvice();
  
  if (!advice.canPost) {
    logger.warn(`[X-RateLimiter] Tweet blocked: ${advice.reason}`);
    import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_tweet_blocked',
      `Tweet blocked: ${advice.reason}`
    )).catch(() => {});
    return { success: false, error: advice.reason };
  }
  
  if (advice.urgency === 'high') {
    logger.warn(`[X-RateLimiter] ⚠️ High urgency warning: ${advice.reason}`);
    import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_high_urgency',
      `High urgency: ${advice.reason}`
    )).catch(() => {});
  }
  
  try {
    const result = await tweetFn();
    await recordWrite(tweetText);
    return { success: true, result };
  } catch (error) {
    logger.error('[X-RateLimiter] Tweet failed:', error);
    return { success: false, error: (error as Error).message };
  }
}

export default {
  canWrite,
  canRead,
  getQuota,
  recordWrite,
  recordRead,
  getUsageSummary,
  getPostingAdvice,
  safeTweet,
  getReadSpendUsd,
  isPayPerUseReads,
  reportRateLimit,
  isRateLimited,
  reportReadRateLimit,
  isReadRateLimited,
  canReadMentions,
  canReadSearch,
  recordMentionRead,
  recordSearchRead,
  mentionsCooldownRemaining,
  searchCooldownRemaining,
  getDailyWritesRemaining,
};
