import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { PostgresScheduleRepository, type XUsageData } from '../db/postgresScheduleRepository.ts';

/**
 * X/Twitter Free Tier Rate Limiter
 * 
 * Free Plan Limits (per month):
 * - 100 Post reads
 * - 500 Post writes (tweets)
 * 
 * This service tracks usage and prevents exceeding limits
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

function getReadLimit(): number {
  const env = getEnv();
  return (env as any).X_MONTHLY_READ_LIMIT || 100;
}

/**
 * Check if we can make a write (post/tweet)
 */
export function canWrite(): boolean {
  resetIfNewMonth();
  return usageData.writes < getWriteLimit();
}

/**
 * Check if we can make a read
 */
export function canRead(): boolean {
  resetIfNewMonth();
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
  
  const remaining = getWriteLimit() - usageData.writes;
  logger.info(`[X-RateLimiter] Tweet sent. ${remaining} writes remaining this month.`);
  
  if (remaining <= 50) {
    logger.warn(`[X-RateLimiter] ⚠️ LOW QUOTA: Only ${remaining} tweets remaining this month!`);
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
  
  return `${status} X/Twitter Usage (${quota.month}):
📝 Tweets: ${quota.writes.used}/${quota.writes.limit} (${writePct}% used, ${quota.writes.remaining} remaining)
📖 Reads: ${quota.reads.used}/${quota.reads.limit} (${readPct}% used)
${quota.lastWrite ? `Last tweet: ${new Date(quota.lastWrite).toLocaleString()}` : 'No tweets this month'}`;
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
  const quota = getQuota();
  
  if (!canWrite()) {
    return {
      canPost: false,
      shouldPost: false,
      reason: `Monthly tweet limit reached (${quota.writes.limit}). Wait until ${getNextMonthDate()}.`,
      urgency: 'none',
    };
  }
  
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const currentDay = new Date().getDate();
  const daysRemaining = daysInMonth - currentDay;
  const tweetsPerDay = daysRemaining > 0 ? quota.writes.remaining / daysRemaining : 0;
  
  if (quota.writes.remaining <= 10) {
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
};
