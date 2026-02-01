import { logger } from '@elizaos/core';
import { notifySystem, notifyAdmin } from './adminNotify.ts';
import { getTelegramHealthStatus } from './telegramHealthMonitor.ts';
import { getAutonomousStatus } from './autonomousMode.ts';
import { getPumpWalletBalance, getFundingWalletBalance } from './fundingWallet.ts';
import { getEnv } from '../env.ts';
import { getFailedAttempts, isAdminSecurityEnabled, isWebhookSecurityEnabled } from './telegramSecurity.ts';
import { getPnLSummary, initPnLTracker, type PnLSummary } from './pnlTracker.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';
import * as fs from 'fs';
import * as path from 'path';

// PostgreSQL support
let pgRepo: PostgresScheduleRepository | null = null;
let usePostgres = false;

// Persistence file for metrics that should survive restarts
const METRICS_FILE = './data/system_metrics.json';

/**
 * System Reporter Service
 * 
 * Sends periodic system status reports to admin via Telegram.
 * Keeps you informed about Nova's activities when AFK.
 * 
 * Reports include:
 * - Telegram bot connection status
 * - Autonomous mode status & launches
 * - Marketing activity (X & TG posts)
 * - Trend monitoring status
 * - Treasury balance
 * - Any errors or warnings
 */

interface SystemStats {
  // Telegram health
  telegramHealthy: boolean;
  telegramMessagesReceived: number;
  telegramMinutesSinceLastMessage: number | null;
  
  // Autonomous mode
  autonomousEnabled: boolean;
  autonomousDryRun: boolean;
  launchesToday: number;
  reactiveLaunchesToday: number;
  nextScheduledLaunch: string | null;
  
  // Marketing
  tweetsSentToday: number;
  tgPostsSentToday: number;
  
  // Trends
  trendsDetected: number;
  
  // Wallets
  pumpWalletBalance: number | null;
  fundingWalletBalance: number | null;
  fundingWalletAddress: string | null;
  
  // PnL
  pnl: PnLSummary | null;
  
  // System
  uptimeHours: number;
  errors24h: number;
  warnings24h: number;
}

// Banned user record
export interface BannedUserRecord {
  id: number;
  username?: string;
  firstName?: string;
  chatId: string;
  bannedAt: number;
  bannedBy: number;
  bannedByUsername?: string;
  reason?: string;
}

// Failed command attempt record
export interface FailedAttemptRecord {
  timestamp: number;
  userId: number;
  username?: string;
  chatId: number;
  command: string;
  args?: string;
}

// Track system metrics (persisted to survive restarts)
interface PersistedMetrics {
  startTime: number;           // First start time (never reset)
  sessionStartTime: number;    // Current session start
  tweetsSentToday: number;
  tgPostsSentToday: number;
  trendsDetectedToday: number;
  errors24h: number;
  warnings24h: number;
  lastReportTime: number;
  lastDailyReportDate: string;
  totalMessagesReceived: number;
  lastUpdated: string;
  bannedUsers: BannedUserRecord[];  // Persistent ban history
  failedAttempts: FailedAttemptRecord[];  // Blocked command attempts
}

function loadMetricsFromFile(): PersistedMetrics {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const data = fs.readFileSync(METRICS_FILE, 'utf-8');
      const loaded = JSON.parse(data) as PersistedMetrics;
      
      // Check if we need to reset daily counters (new day)
      const today = new Date().toISOString().split('T')[0];
      if (loaded.lastDailyReportDate !== today) {
        loaded.tweetsSentToday = 0;
        loaded.tgPostsSentToday = 0;
        loaded.trendsDetectedToday = 0;
        loaded.errors24h = 0;
        loaded.warnings24h = 0;
        // Also clear old failed attempts on new day
        if (loaded.failedAttempts) {
          const threshold = Date.now() - 24 * 60 * 60 * 1000;
          loaded.failedAttempts = loaded.failedAttempts.filter(a => a.timestamp >= threshold);
        }
        loaded.lastDailyReportDate = today;
      }
      
      // Initialize missing fields (migration from older versions)
      if (!loaded.bannedUsers) loaded.bannedUsers = [];
      if (!loaded.failedAttempts) loaded.failedAttempts = [];
      if (typeof loaded.totalMessagesReceived !== 'number') loaded.totalMessagesReceived = 0;
      
      // Update session start time (restart)
      loaded.sessionStartTime = Date.now();
      logger.info(`[SystemReporter] Loaded persisted metrics from file`);
      return loaded;
    }
  } catch (err) {
    logger.warn('[SystemReporter] Could not load persisted metrics from file, starting fresh');
  }
  
  // Default metrics for first run
  const now = Date.now();
  return {
    startTime: now,
    sessionStartTime: now,
    tweetsSentToday: 0,
    tgPostsSentToday: 0,
    trendsDetectedToday: 0,
    errors24h: 0,
    warnings24h: 0,
    lastReportTime: 0,
    lastDailyReportDate: '',
    totalMessagesReceived: 0,
    lastUpdated: new Date().toISOString(),
    bannedUsers: [],
    failedAttempts: [],
  };
}

function loadMetrics(): PersistedMetrics {
  return loadMetricsFromFile();
}

async function loadMetricsFromPostgres(): Promise<PersistedMetrics | null> {
  if (!pgRepo) return null;
  try {
    const data = await pgRepo.getSystemMetrics();
    const today = new Date().toISOString().split('T')[0];
    
    // Check if we need to reset daily counters
    if (data.lastDailyReportDate !== today) {
      logger.info(`[SystemReporter] New day detected (was: ${data.lastDailyReportDate}, now: ${today}), resetting daily counters`);
      await pgRepo.resetDailyMetrics();
      data.tweetsSentToday = 0;
      data.tgPostsSentToday = 0;
      data.trendsDetectedToday = 0;
      data.errors24h = 0;
      data.warnings24h = 0;
      data.lastDailyReportDate = today;
    }
    
    data.sessionStartTime = Date.now();
    logger.info(`[SystemReporter] Loaded persisted metrics from PostgreSQL (tweets: ${data.tweetsSentToday}, TG posts: ${data.tgPostsSentToday}, trends: ${data.trendsDetectedToday})`);
    return data as PersistedMetrics;
  } catch (err) {
    logger.warn('[SystemReporter] Failed to load metrics from PostgreSQL:', err);
    return null;
  }
}

function saveMetricsToFile(): void {
  try {
    metrics.lastUpdated = new Date().toISOString();
    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
  } catch (err) {
    logger.debug('[SystemReporter] Could not save metrics to file:', err);
  }
}

function saveMetrics(): void {
  // Always save to file as backup
  saveMetricsToFile();
}

const metrics = loadMetrics();

// Report intervals
let statusReportInterval: NodeJS.Timeout | null = null;
let dailyReportInterval: NodeJS.Timeout | null = null;

// Configuration
const STATUS_REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000; // Every 4 hours
const DAILY_REPORT_HOUR_UTC = 9; // 9 AM UTC

/**
 * Record a message was received (call from webhook/health monitor)
 */
export function recordMessageReceivedPersistent(): void {
  metrics.totalMessagesReceived++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('totalMessagesReceived').catch(() => {});
  }
}

/**
 * Get total messages received (persisted)
 */
export function getTotalMessagesReceived(): number {
  return metrics.totalMessagesReceived || 0;
}

/**
 * Record a tweet was sent (call from XScheduler)
 */
export function recordTweetSent(): void {
  metrics.tweetsSentToday++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('tweetsSentToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment tweetsSentToday in PostgreSQL:', err);
    });
  }
}

/**
 * Record a TG post was sent (call from TGScheduler)
 */
export function recordTGPostSent(): void {
  metrics.tgPostsSentToday++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('tgPostsSentToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment tgPostsSentToday in PostgreSQL:', err);
    });
  }
}

/**
 * Record a trend was detected (call from TrendMonitor)
 */
export function recordTrendDetected(): void {
  metrics.trendsDetectedToday++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('trendsDetectedToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment trendsDetectedToday in PostgreSQL:', err);
    });
  }
}

/**
 * Record an error (call from error handlers)
 */
export function recordError(): void {
  metrics.errors24h++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('errors24h').catch(err => {
      logger.warn('[SystemReporter] Failed to increment errors24h in PostgreSQL:', err);
    });
  }
}

/**
 * Record a warning
 */
export function recordWarning(): void {
  metrics.warnings24h++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('warnings24h').catch(err => {
      logger.warn('[SystemReporter] Failed to increment warnings24h in PostgreSQL:', err);
    });
  }
}

/**
 * Record a banned user
 */
export function recordBannedUser(record: BannedUserRecord): void {
  // Initialize if not exists (migration)
  if (!metrics.bannedUsers) {
    metrics.bannedUsers = [];
  }
  
  // Check if user is already banned in this chat
  const existingIndex = metrics.bannedUsers.findIndex(
    u => u.id === record.id && u.chatId === record.chatId
  );
  
  if (existingIndex >= 0) {
    // Update existing record
    metrics.bannedUsers[existingIndex] = record;
  } else {
    // Add new record
    metrics.bannedUsers.push(record);
  }
  
  saveMetrics();
  
  // Also sync to PostgreSQL
  if (usePostgres && pgRepo) {
    pgRepo.updateSystemMetrics({ bannedUsers: metrics.bannedUsers }).catch(() => {});
  }
  
  logger.info(`[SystemReporter] Recorded banned user: ${record.id} (@${record.username || record.firstName})`);
}

/**
 * Get all banned users
 */
export function getBannedUsers(): BannedUserRecord[] {
  return metrics.bannedUsers || [];
}

/**
 * Get banned users count
 */
export function getBannedUsersCount(): number {
  return (metrics.bannedUsers || []).length;
}

/**
 * Check if a user is banned
 */
export function isUserBanned(userId: number, chatId?: string): boolean {
  if (!metrics.bannedUsers) return false;
  if (chatId) {
    return metrics.bannedUsers.some(u => u.id === userId && u.chatId === chatId);
  }
  return metrics.bannedUsers.some(u => u.id === userId);
}

/**
 * Record a failed command attempt (unauthorized user trying admin command)
 */
export function recordFailedAttempt(record: FailedAttemptRecord): void {
  // Initialize if not exists (migration)
  if (!metrics.failedAttempts) {
    metrics.failedAttempts = [];
  }
  
  metrics.failedAttempts.push(record);
  
  // Keep only last 100 attempts
  if (metrics.failedAttempts.length > 100) {
    metrics.failedAttempts = metrics.failedAttempts.slice(-100);
  }
  
  saveMetrics();
  
  // Also sync to PostgreSQL
  if (usePostgres && pgRepo) {
    pgRepo.updateSystemMetrics({ failedAttempts: metrics.failedAttempts }).catch(() => {});
  }
  
  logger.info(`[SystemReporter] 🚨 Recorded failed attempt: ${record.username || record.userId} tried /${record.command}`);
}

/**
 * Get failed attempts from persistent storage (last 24h)
 */
export function getPersistedFailedAttempts(): FailedAttemptRecord[] {
  if (!metrics.failedAttempts) return [];
  const threshold = Date.now() - 24 * 60 * 60 * 1000;
  return metrics.failedAttempts.filter(a => a.timestamp >= threshold);
}

/**
 * Reset daily counters (call at midnight)
 */
function resetDailyCounters(): void {
  metrics.tweetsSentToday = 0;
  metrics.tgPostsSentToday = 0;
  metrics.trendsDetectedToday = 0;
  // Also clear old failed attempts (older than 24h)
  if (metrics.failedAttempts) {
    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    metrics.failedAttempts = metrics.failedAttempts.filter(a => a.timestamp >= threshold);
  }
}

/**
 * Collect current system stats
 */
async function collectStats(): Promise<SystemStats> {
  const tgHealth = getTelegramHealthStatus();
  
  // Try to get autonomous status
  let autonomousStatus: ReturnType<typeof getAutonomousStatus> | null = null;
  try {
    autonomousStatus = getAutonomousStatus();
  } catch {
    // Autonomous mode might not be initialized
  }
  
  // Try to get wallet balances
  let pumpWalletBalance: number | null = null;
  let fundingWalletBalance: number | null = null;
  let fundingWalletAddress: string | null = null;
  
  try {
    pumpWalletBalance = await getPumpWalletBalance();
  } catch {
    // Wallet not configured or RPC error
  }
  
  try {
    const fundingInfo = await getFundingWalletBalance();
    fundingWalletBalance = fundingInfo.balance;
    fundingWalletAddress = fundingInfo.address;
  } catch {
    // Wallet not configured or RPC error
  }
  
  const uptimeMs = Date.now() - metrics.startTime;
  const uptimeHours = Math.round(uptimeMs / (60 * 60 * 1000) * 10) / 10;
  
  // Get PnL summary
  let pnl: PnLSummary | null = null;
  try {
    pnl = await getPnLSummary();
  } catch {
    // PnL tracker might not be initialized
  }
  
  return {
    // Telegram health
    telegramHealthy: tgHealth.isHealthy,
    telegramMessagesReceived: tgHealth.messageCount,
    telegramMinutesSinceLastMessage: tgHealth.minutesSinceLastMessage,
    
    // Autonomous mode
    autonomousEnabled: autonomousStatus?.enabled ?? false,
    autonomousDryRun: autonomousStatus?.dryRun ?? true,
    launchesToday: autonomousStatus?.launchesToday ?? 0,
    reactiveLaunchesToday: autonomousStatus?.reactiveLaunchesToday ?? 0,
    nextScheduledLaunch: autonomousStatus?.nextScheduledTime 
      ? new Date(autonomousStatus.nextScheduledTime).toISOString()
      : null,
    
    // Marketing
    tweetsSentToday: metrics.tweetsSentToday,
    tgPostsSentToday: metrics.tgPostsSentToday,
    
    // Trends
    trendsDetected: metrics.trendsDetectedToday,
    
    // Wallets
    pumpWalletBalance,
    fundingWalletBalance,
    fundingWalletAddress,
    
    // PnL
    pnl,
    
    // System
    uptimeHours,
    errors24h: metrics.errors24h,
    warnings24h: metrics.warnings24h,
  };
}

/**
 * Format uptime nicely
 */
function formatUptime(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)} minutes`;
  } else if (hours < 24) {
    return `${hours.toFixed(1)} hours`;
  } else {
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return `${days}d ${remainingHours}h`;
  }
}

/**
 * Format time ago (e.g., "2h ago", "3d ago")
 */
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Send a status report to admin
 */
async function sendStatusReport(): Promise<void> {
  const stats = await collectStats();
  
  const tgStatus = stats.telegramHealthy 
    ? '🟢 Connected' 
    : `🔴 Stale (${stats.telegramMinutesSinceLastMessage ?? '?'}min ago)`;
  
  const autonomousStatus = stats.autonomousEnabled
    ? (stats.autonomousDryRun ? '🧪 Dry Run' : '🟢 Active')
    : '⏸️ Disabled';
  
  let message = `📊 <b>Nova Status Report</b>\n\n`;
  
  // Telegram status
  const totalMessages = getTotalMessagesReceived();
  message += `<b>🤖 Telegram Bot:</b>\n`;
  message += `  Status: ${tgStatus}\n`;
  message += `  Messages received: ${totalMessages}\n\n`;
  
  // Autonomous mode
  const totalLaunches = (stats.launchesToday || 0) + (stats.reactiveLaunchesToday || 0);
  message += `<b>🚀 Autonomous Mode:</b>\n`;
  message += `  Status: ${autonomousStatus}\n`;
  message += `  Launches today: ${totalLaunches} total (${stats.launchesToday || 0} scheduled, ${stats.reactiveLaunchesToday || 0} reactive)\n`;
  if (stats.nextScheduledLaunch) {
    const next = new Date(stats.nextScheduledLaunch);
    message += `  Next scheduled: ${next.toUTCString()}\n`;
  }
  message += '\n';
  
  // Marketing
  message += `<b>📢 Marketing:</b>\n`;
  message += `  Tweets sent: ${stats.tweetsSentToday}\n`;
  message += `  TG posts sent: ${stats.tgPostsSentToday}\n`;
  message += `  Trends detected: ${stats.trendsDetected}\n\n`;
  
  // Wallet balances
  message += `<b>💰 Wallets:</b>\n`;
  if (stats.pumpWalletBalance !== null) {
    message += `  Pump Wallet: ${stats.pumpWalletBalance.toFixed(4)} SOL\n`;
  } else {
    message += `  Pump Wallet: ⚠️ Not configured\n`;
  }
  if (stats.fundingWalletBalance !== null) {
    message += `  Funding Wallet: ${stats.fundingWalletBalance.toFixed(4)} SOL\n`;
    if (stats.fundingWalletAddress) {
      message += `  Address: <code>${stats.fundingWalletAddress.slice(0, 6)}...${stats.fundingWalletAddress.slice(-4)}</code>\n`;
    }
  } else {
    message += `  Funding Wallet: ⚠️ Not configured\n`;
  }
  message += '\n';
  
  // PnL Section
  if (stats.pnl) {
    const pnl = stats.pnl;
    const realizedEmoji = pnl.totalRealizedPnl >= 0 ? '🟢' : '🔴';
    const realizedSign = pnl.totalRealizedPnl >= 0 ? '+' : '';
    
    message += `<b>📈 PnL Tracking:</b>\n`;
    message += `  Realized: ${realizedEmoji} ${realizedSign}${pnl.totalRealizedPnl.toFixed(4)} SOL\n`;
    message += `  Active positions: ${pnl.activePositions}\n`;
    message += `  Total trades: ${pnl.totalTrades}\n`;
    if (pnl.winningTrades + pnl.losingTrades > 0) {
      message += `  Win rate: ${pnl.winRate.toFixed(0)}% (${pnl.winningTrades}W/${pnl.losingTrades}L)\n`;
    }
    message += `  Net SOL flow: ${pnl.netSolFlow >= 0 ? '+' : ''}${pnl.netSolFlow.toFixed(4)} SOL\n`;
    message += '\n';
  }
  
  // Security - Banned users and alerts
  const bannedUsers = getBannedUsers();
  const persistedFailed = getPersistedFailedAttempts(); // From JSON
  const memoryFailed = getFailedAttempts(); // From memory (current session)
  // Combine both sources, prefer persisted for count
  const failedAttempts = persistedFailed.length > 0 ? persistedFailed : memoryFailed;
  const adminSecurityOn = isAdminSecurityEnabled();
  const webhookSecurityOn = isWebhookSecurityEnabled();
  
  message += `<b>🛡️ Security:</b>\n`;
  
  // Security configuration status
  message += `  Admin auth: ${adminSecurityOn ? '✅ Enabled' : '⚠️ Open'}\n`;
  message += `  Webhook auth: ${webhookSecurityOn ? '✅ Enabled' : '⚠️ Open'}\n`;
  
  // Failed command attempts (unauthorized users trying admin commands)
  if (failedAttempts.length > 0) {
    message += `  🚨 Blocked attempts (24h): ${failedAttempts.length}\n`;
    // Show last 2 failed attempts
    const recentFailed = failedAttempts.slice(-2).reverse();
    for (const attempt of recentFailed) {
      const who = attempt.username ? `@${attempt.username}` : `ID:${attempt.userId}`;
      message += `    • ${who} tried /${attempt.command}\n`;
    }
  } else {
    message += `  Blocked attempts (24h): 0\n`;
  }
  
  // Banned users
  message += `  Banned users: ${bannedUsers.length}\n`;
  if (bannedUsers.length > 0) {
    // Show last 3 banned users
    const recentBans = bannedUsers.slice(-3).reverse();
    for (const ban of recentBans) {
      const displayName = ban.username ? `@${ban.username}` : ban.firstName || String(ban.id);
      const bannedDate = new Date(ban.bannedAt);
      const timeAgo = formatTimeAgo(bannedDate);
      message += `    • ${displayName} (${timeAgo})\n`;
    }
    if (bannedUsers.length > 3) {
      message += `    <i>...and ${bannedUsers.length - 3} more</i>\n`;
    }
  }
  message += '\n';
  
  // System health
  message += `<b>⚙️ System:</b>\n`;
  message += `  Uptime: ${formatUptime(stats.uptimeHours)}\n`;
  message += `  Errors (24h): ${stats.errors24h}\n`;
  message += `  Warnings (24h): ${stats.warnings24h}\n`;
  
  await notifyAdmin(message, 'system');
  metrics.lastReportTime = Date.now();
  
  logger.info('[SystemReporter] Sent status report to admin');
}

/**
 * Send a comprehensive daily summary
 */
async function sendDailySummary(): Promise<void> {
  const stats = await collectStats();
  
  let message = `📅 <b>Nova Daily Summary</b>\n`;
  message += `<i>${new Date().toDateString()}</i>\n\n`;
  
  // Highlights
  message += `<b>📊 Today's Activity:</b>\n`;
  message += `  • Launches: ${stats.launchesToday} scheduled, ${stats.reactiveLaunchesToday} reactive\n`;
  message += `  • Tweets: ${stats.tweetsSentToday}\n`;
  message += `  • TG Posts: ${stats.tgPostsSentToday}\n`;
  message += `  • Trends Spotted: ${stats.trendsDetected}\n\n`;
  
  // Wallets
  message += `<b>💰 Wallets:</b>\n`;
  if (stats.pumpWalletBalance !== null) {
    message += `  • Pump: ${stats.pumpWalletBalance.toFixed(4)} SOL\n`;
  }
  if (stats.fundingWalletBalance !== null) {
    message += `  • Funding: ${stats.fundingWalletBalance.toFixed(4)} SOL\n`;
  }
  message += '\n';
  
  // Health
  message += `<b>🏥 Health:</b>\n`;
  message += `  • Telegram: ${stats.telegramHealthy ? '✅ Connected' : '⚠️ Check connection'}\n`;
  message += `  • Autonomous: ${stats.autonomousEnabled ? (stats.autonomousDryRun ? '🧪 Dry Run' : '✅ Active') : '⏸️ Disabled'}\n`;
  message += `  • Errors: ${stats.errors24h > 0 ? `⚠️ ${stats.errors24h}` : '✅ None'}\n`;
  message += `  • Uptime: ${formatUptime(stats.uptimeHours)}\n\n`;
  
  // Tips or alerts
  if (!stats.telegramHealthy) {
    message += `⚠️ <b>Alert:</b> Telegram bot may be disconnected. Consider restarting.\n\n`;
  }
  if (stats.errors24h > 5) {
    message += `⚠️ <b>Alert:</b> High error count. Check logs for issues.\n\n`;
  }
  
  message += `<i>Nova is working hard for you! 💪</i>`;
  
  await notifySystem({
    event: 'daily_summary',
    message,
    stats: {
      launches: stats.launchesToday + stats.reactiveLaunchesToday,
      tweets: stats.tweetsSentToday,
      tgPosts: stats.tgPostsSentToday,
      uptime: formatUptime(stats.uptimeHours),
    },
  });
  
  // Reset counters for new day
  resetDailyCounters();
  metrics.errors24h = 0;
  metrics.warnings24h = 0;
  metrics.lastDailyReportDate = new Date().toISOString().split('T')[0];
  
  logger.info('[SystemReporter] Sent daily summary to admin');
}

/**
 * Check if it's time for daily report
 */
function checkDailyReport(): void {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  // Only send once per day at the configured hour
  if (metrics.lastDailyReportDate === today) {
    return;
  }
  
  if (now.getUTCHours() === DAILY_REPORT_HOUR_UTC) {
    sendDailySummary().catch(err => {
      logger.error('[SystemReporter] Failed to send daily summary:', err);
    });
  }
}

/**
 * Start the system reporter
 */
export async function startSystemReporter(): Promise<void> {
  const env = getEnv();
  
  // Initialize PostgreSQL if available
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      usePostgres = true;
      logger.info('[SystemReporter] PostgreSQL storage initialized');
      
      // Load metrics from PostgreSQL (overrides file-loaded metrics)
      const pgMetrics = await loadMetricsFromPostgres();
      if (pgMetrics) {
        Object.assign(metrics, pgMetrics);
      }
    } catch (err) {
      logger.warn('[SystemReporter] PostgreSQL init failed, using file storage:', err);
      pgRepo = null;
      usePostgres = false;
    }
  }
  
  // Initialize PnL tracker (loads persisted data)
  try {
    await initPnLTracker();
  } catch (err) {
    logger.warn('[SystemReporter] Failed to init PnL tracker:', err);
  }
  
  // Check if system reports are enabled
  const enableReports = env.SYSTEM_REPORTS_ENABLE === 'true';
  
  if (!enableReports) {
    logger.info('[SystemReporter] Disabled (set SYSTEM_REPORTS_ENABLE=true to enable)');
    return;
  }
  
  if (statusReportInterval || dailyReportInterval) {
    return; // Already running
  }
  
  // Send initial startup report after a short delay
  setTimeout(() => {
    sendStatusReport().catch(err => {
      logger.error('[SystemReporter] Failed to send startup report:', err);
    });
  }, 30 * 1000); // 30 seconds after startup
  
  // Schedule periodic status reports
  statusReportInterval = setInterval(() => {
    sendStatusReport().catch(err => {
      logger.error('[SystemReporter] Failed to send status report:', err);
    });
  }, STATUS_REPORT_INTERVAL_MS);
  
  // Check for daily report every hour
  dailyReportInterval = setInterval(checkDailyReport, 60 * 60 * 1000);
  
  logger.info(`[SystemReporter] ✅ Started (reports every ${STATUS_REPORT_INTERVAL_MS / (60 * 60 * 1000)}h, daily summary at ${DAILY_REPORT_HOUR_UTC}:00 UTC)`);
}

/**
 * Stop the system reporter
 */
export function stopSystemReporter(): void {
  if (statusReportInterval) {
    clearInterval(statusReportInterval);
    statusReportInterval = null;
  }
  if (dailyReportInterval) {
    clearInterval(dailyReportInterval);
    dailyReportInterval = null;
  }
}

/**
 * Manually trigger a status report (for testing or on-demand)
 */
export async function triggerStatusReport(): Promise<void> {
  await sendStatusReport();
}

/**
 * Get current metrics (for API or debugging)
 */
export function getMetrics() {
  return {
    ...metrics,
    uptimeMs: Date.now() - metrics.startTime,
  };
}
