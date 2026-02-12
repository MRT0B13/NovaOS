import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { PostgresScheduleRepository, type XUsageData } from '../db/postgresScheduleRepository.ts';

/**
 * X/Twitter Rate Limiter
 * 
 * Writes: Free tier (500/month, no charge)
 * Reads: Pay-per-use at $0.005/read. Set X_READ_BUDGET_USD to control monthly spend.
 *        If X_READ_BUDGET_USD=0, falls back to X_MONTHLY_READ_LIMIT hard cap (default 100).
 * 
 * Example: X_READ_BUDGET_USD=5 → ~1000 reads/month → ~33 reads/day
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
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
let rateLimitedUntil = 0;
// Separate read backoff — search/mentions 429 (free tier: 1 search per 15 min)
let readRateLimitedUntil = 0;

// Per-endpoint read tracking — pay-per-use allows 1 call per 15-min window per endpoint.
// We use a 16-min cooldown to add safety margin.
const READ_ENDPOINT_COOLDOWN_MS = 16 * 60 * 1000; // 16 minutes
let lastMentionReadAt = 0;
let lastSearchReadAt  = 0;

// Daily write tracking — X pay-per-use enforces 17 tweets per 24h rolling window.
// We track timestamps of recent writes so we can proactively refuse before hitting 429.
const DAILY_WRITE_LIMIT = 17; // x-app-limit-24hour-limit from X API headers
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const recentWriteTimestamps: number[] = [];

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
}

async function saveUsage(): Promise<void> {
  if (usePostgres && pgRepo) {
    await pgRepo.saveXUsage(usageData as XUsageData);
  } else {
    await saveUsageToFile();
  }
}

/**
 * Get configured limits from env (defaults to free tier)
 */
function getWriteLimit(): number {
  const env = getEnv();
  return (env as any).X_MONTHLY_WRITE_LIMIT || 500;
}

const X_READ_COST_USD = 0.005; // $0.005 per read (X pay-per-use)

function getReadLimit(): number {
  const env = getEnv();
  const budget = (env as any).X_READ_BUDGET_USD || 0;
  if (budget > 0) {
    // Budget mode: derive max reads from dollar budget
    return Math.floor(budget / X_READ_COST_USD);
  }
  // Fallback: hard cap (old free-tier style)
  return (env as any).X_MONTHLY_READ_LIMIT || 100;
}

/**
 * Get current read spend in USD this month
 */
export function getReadSpendUsd(): number {
  resetIfNewMonth();
  return usageData.reads * X_READ_COST_USD;
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
  
  const dailyRemaining = getDailyWritesRemaining();
  const monthlyRemaining = getWriteLimit() - usageData.writes;
  logger.info(`[X-RateLimiter] Tweet sent. ${dailyRemaining} daily / ${monthlyRemaining} monthly writes remaining.`);
  
  if (dailyRemaining <= 3) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW DAILY QUOTA: Only ${dailyRemaining} tweets left in 24h window!`);
  }
  if (monthlyRemaining <= 50) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW MONTHLY QUOTA: Only ${monthlyRemaining} tweets remaining this month!`);
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
    ? `📖 Reads: ${quota.reads.used} ($${getReadSpendUsd().toFixed(2)} / $${((getEnv() as any).X_READ_BUDGET_USD || 0).toFixed(2)} budget)`
    : `📖 Reads: ${quota.reads.used}/${quota.reads.limit} (${readPct}% used)`;
  
  return `${status} X/Twitter Usage (${quota.month}):
📝 Tweets: ${quota.writes.used}/${quota.writes.limit} (${writePct}% used, ${quota.writes.remaining} remaining) [FREE]
${readLine}
${quota.lastWrite ? `Last tweet: ${new Date(quota.lastWrite).toLocaleString()}` : 'No tweets this month'}`;
}

/**
 * Report a Twitter 429 rate limit hit. Any component (reply engine,
 * brand posts, marketing) should call this when it receives a 429.
 * Sets a shared backoff so ALL posting pauses for 15 minutes.
 */
export function reportRateLimit(): void {
  rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
  const resumeAt = new Date(rateLimitedUntil).toISOString();
  logger.warn(`[X-RateLimiter] ⚠️ Twitter 429 — ALL posting paused until ${resumeAt} (15 min backoff)`);
}

/**
 * Check if we're currently in a 429 backoff window.
 */
export function isRateLimited(): boolean {
  return rateLimitedUntil > Date.now();
}

/**
 * Report a Twitter 429 on read/search. Pauses reads for 15 minutes.
 */
export function reportReadRateLimit(): void {
  readRateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
  const resumeAt = new Date(readRateLimitedUntil).toISOString();
  logger.warn(`[X-RateLimiter] ⚠️ Read 429 — searches paused until ${resumeAt} (15 min backoff)`);
}

/**
 * Check if reads are currently in a 429 backoff window.
 */
export function isReadRateLimited(): boolean {
  return readRateLimitedUntil > Date.now();
}

// ────────────────────────────────────────────────────────────────────────────
// Per-endpoint read gating (prevents 429s proactively)
// Pay-per-use allows 1 search + 1 mentions call per 15-min window. These
// functions enforce a 16-min cooldown so no caller ever triggers a 429.
// ────────────────────────────────────────────────────────────────────────────

/** Check if enough time has passed since the last mentions read */
export function canReadMentions(): boolean {
  if (isReadRateLimited()) return false;
  if (!canRead()) return false;
  return Date.now() - lastMentionReadAt >= READ_ENDPOINT_COOLDOWN_MS;
}

/** Check if enough time has passed since the last search read */
export function canReadSearch(): boolean {
  if (isReadRateLimited()) return false;
  if (!canRead()) return false;
  return Date.now() - lastSearchReadAt >= READ_ENDPOINT_COOLDOWN_MS;
}

/** How many seconds until mentions endpoint is available again */
export function mentionsCooldownRemaining(): number {
  const remaining = (lastMentionReadAt + READ_ENDPOINT_COOLDOWN_MS) - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** How many seconds until search endpoint is available again */
export function searchCooldownRemaining(): number {
  const remaining = (lastSearchReadAt + READ_ENDPOINT_COOLDOWN_MS) - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** Record a mentions read — sets the cooldown clock */
export async function recordMentionRead(): Promise<void> {
  lastMentionReadAt = Date.now();
  await recordRead();
  logger.info(`[X-RateLimiter] Mentions read recorded. Next allowed in ${READ_ENDPOINT_COOLDOWN_MS / 60000}m`);
}

/** Record a search read — sets the cooldown clock */
export async function recordSearchRead(): Promise<void> {
  lastSearchReadAt = Date.now();
  await recordRead();
  logger.info(`[X-RateLimiter] Search read recorded. Next allowed in ${READ_ENDPOINT_COOLDOWN_MS / 60000}m`);
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
    return { success: false, error: advice.reason };
  }
  
  if (advice.urgency === 'high') {
    logger.warn(`[X-RateLimiter] ⚠️ High urgency warning: ${advice.reason}`);
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
