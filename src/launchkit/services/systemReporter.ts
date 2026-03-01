import { logger } from '@elizaos/core';
import { notifySystem, notifyAdmin, notifyAdminForce } from './adminNotify.ts';
import { getTelegramHealthStatus, recordMessageSent } from './telegramHealthMonitor.ts';
import { getAutonomousStatus } from './autonomousMode.ts';
import { getPumpWalletBalance, getFundingWalletBalance } from './fundingWallet.ts';
import { getEnv } from '../env.ts';
import { getFailedAttempts, isAdminSecurityEnabled, isWebhookSecurityEnabled } from './telegramSecurity.ts';
import { getPnLSummary, getActivePositions, initPnLTracker, type PnLSummary } from './pnlTracker.ts';
import { getTokenPrice, getTokenPrices } from './priceService.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';
import type { SwarmHandle } from '../../agents/index.ts';
import * as fs from 'fs';
import * as path from 'path';

// ── Swarm handle (registered by init.ts after swarm starts) ──
let swarmHandle: SwarmHandle | null = null;

/**
 * Register the swarm handle so status reports can include agent data.
 * Called from init.ts after initSwarm() completes.
 */
export function registerSwarmHandle(handle: SwarmHandle): void {
  swarmHandle = handle;
  logger.info('[SystemReporter] Swarm handle registered — agent stats enabled');
}

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

  // Swarm agents
  swarm: SwarmStats | null;

  // CFO portfolio
  cfo: CFOSnapshot | null;
}

interface SwarmAgentInfo {
  name: string;
  status: string;
  lastSeen: Date | null;
  detail: string;   // compact one-liner
}

interface SwarmStats {
  agents: SwarmAgentInfo[];
  totalAgents: number;
  aliveCount: number;
}

// ── CFO Portfolio Snapshot (for status reports) ──
interface CFOSnapshot {
  enabled: boolean;
  totalPortfolioUsd: number;
  solBalance: number;
  solPriceUsd: number;
  hedgeRatio: number;       // 0-1

  // Kamino
  kaminoEnabled: boolean;
  kaminoDepositUsd: number;
  kaminoBorrowUsd: number;
  kaminoNetUsd: number;
  kaminoLtv: number;
  kaminoHealthFactor: number;
  kaminoJitoLoopActive: boolean;
  kaminoJitoLoopApy: number;

  // Orca LP
  orcaEnabled: boolean;
  orcaLpValueUsd: number;
  orcaLpFeeApy: number;
  orcaPositions: Array<{ positionMint: string; inRange: boolean; rangeUtilisationPct: number }>;

  // Jito staking
  jitoSolBalance: number;
  jitoSolValueUsd: number;

  // Hyperliquid
  hlEnabled: boolean;
  hlEquity: number;
  hlTotalPnl: number;
  hlPositions: Array<{ coin: string; side: string; sizeUsd: number; unrealizedPnlUsd: number; leverage: number }>;

  // Polymarket
  polyEnabled: boolean;
  polyDeployedUsd: number;
  polyHeadroomUsd: number;
  polyPositionCount: number;
  polyUsdcBalance: number;

  // Krystal EVM LP
  krystalEnabled: boolean;
  krystalLpValueUsd: number;
  krystalLpFeesUsd: number;
  krystalPositions: Array<{ posId: string; chainName: string; token0Symbol: string; token1Symbol: string; inRange: boolean; rangeUtilisationPct: number; valueUsd: number; feesOwedUsd: number }>;

  // x402 revenue
  x402TotalCalls: number;
  x402TotalEarned: number;
  x402Last24h: number;
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
  
  // Daily counters (reset at midnight)
  tweetsSentToday: number;
  tgPostsSentToday: number;
  trendsDetectedToday: number;
  errors24h: number;
  warnings24h: number;
  
  // All-time cumulative counters (NEVER reset)
  totalLaunches: number;
  totalTweetsSent: number;
  totalTgPostsSent: number;
  
  // Tracks which day the daily counters belong to (ISO date string like '2026-02-09')
  // Only updated when counters are reset — NOT on every metric increment
  counterDate: string;
  
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
      // Use counterDate (which day the counters belong to), NOT lastUpdated
      // lastUpdated gets bumped by every incrementMetric() call so it's unreliable
      const today = new Date().toISOString().split('T')[0];
      const counterDay = loaded.counterDate || (loaded.lastUpdated ? loaded.lastUpdated.split('T')[0] : '');
      
      if (counterDay && counterDay !== today) {
        // Counters are from a previous day - reset them
        logger.info(`[SystemReporter] File metrics from previous day (${counterDay}), resetting daily counters`);
        loaded.tweetsSentToday = 0;
        loaded.tgPostsSentToday = 0;
        loaded.trendsDetectedToday = 0;
        loaded.errors24h = 0;
        loaded.warnings24h = 0;
        loaded.counterDate = today;
        // NOTE: Do NOT set lastDailyReportDate here.
        // That field tracks whether the daily *summary report* was sent,
        // not whether counters were reset. Setting it here would prevent
        // the daily summary from firing at the scheduled hour.
        // Also clear old failed attempts on new day
        if (loaded.failedAttempts) {
          const threshold = Date.now() - 24 * 60 * 60 * 1000;
          loaded.failedAttempts = loaded.failedAttempts.filter(a => a.timestamp >= threshold);
        }
      } else {
        logger.info(`[SystemReporter] Same day (${today}), preserving file metrics`);
      }
      
      // Ensure counterDate is set (migration from older versions)
      if (!loaded.counterDate) loaded.counterDate = today;
      
      // Initialize missing fields (migration from older versions)
      if (!loaded.bannedUsers) loaded.bannedUsers = [];
      if (!loaded.failedAttempts) loaded.failedAttempts = [];
      if (typeof loaded.totalMessagesReceived !== 'number') loaded.totalMessagesReceived = 0;
      // Initialize all-time cumulative counters (migration)
      if (typeof loaded.totalLaunches !== 'number') loaded.totalLaunches = 0;
      if (typeof loaded.totalTweetsSent !== 'number') loaded.totalTweetsSent = 0;
      if (typeof loaded.totalTgPostsSent !== 'number') loaded.totalTgPostsSent = 0;
      
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
    // All-time cumulative (never reset)
    totalLaunches: 0,
    totalTweetsSent: 0,
    totalTgPostsSent: 0,
    counterDate: new Date().toISOString().split('T')[0],
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
    // Use counterDate (which day the counters belong to), NOT lastUpdated
    // lastUpdated gets bumped by every incrementMetric() call so it's unreliable
    const counterDay = data.counterDate || (data.lastUpdated ? data.lastUpdated.split('T')[0] : '');
    
    if (counterDay && counterDay !== today) {
      // Counters are from a previous day - reset them
      logger.info(`[SystemReporter] New day detected (counter_date: ${counterDay}, now: ${today}), resetting daily counters`);
      await pgRepo.resetDailyMetrics(today);
      data.tweetsSentToday = 0;
      data.tgPostsSentToday = 0;
      data.trendsDetectedToday = 0;
      data.errors24h = 0;
      data.warnings24h = 0;
      data.counterDate = today;
      // NOTE: Do NOT set lastDailyReportDate here.
      // That field tracks whether the daily *summary report* was sent,
      // not whether counters were reset. Setting it here would prevent
      // the daily summary from firing at the scheduled hour.
    } else {
      // Same day - preserve counters
      if (!data.counterDate) data.counterDate = today; // migration
      logger.info(`[SystemReporter] Same day (${today}), preserving counters`);
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
 * Lightweight day-change guard: if we've crossed midnight since the last check,
 * reset daily counters immediately. This prevents stale counter accumulation
 * when the hourly checkMidnightReset() hasn't fired yet.
 */
function ensureDayIsCurrent(): void {
  const today = new Date().toISOString().split('T')[0];
  if (metrics.counterDate && metrics.counterDate !== today) {
    logger.info(`[SystemReporter] 🌅 Day change detected in counter guard (was ${metrics.counterDate}, now ${today}), resetting`);
    resetDailyCounters();
    metrics.errors24h = 0;
    metrics.warnings24h = 0;
    lastCheckedDate = today;
    saveMetrics();
    // Fire-and-forget DB reset
    if (usePostgres && pgRepo) {
      pgRepo.resetDailyMetrics(today).catch(err => {
        logger.warn('[SystemReporter] Failed to reset PostgreSQL metrics in guard:', err);
      });
    }
  }
}

/**
 * Record a tweet was sent (call from XScheduler)
 */
export function recordTweetSent(): void {
  ensureDayIsCurrent();
  metrics.tweetsSentToday++;
  metrics.totalTweetsSent++;  // All-time cumulative
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('tweetsSentToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment tweetsSentToday in PostgreSQL:', err);
    });
    pgRepo.incrementMetric('totalTweetsSent').catch(() => {});
  }
}

/**
 * Record a TG post was sent (call from TGScheduler)
 */
export function recordTGPostSent(): void {
  ensureDayIsCurrent();
  metrics.tgPostsSentToday++;
  metrics.totalTgPostsSent++;  // All-time cumulative
  saveMetrics();
  
  // Also record for health monitoring (TG is alive if we're sending posts)
  recordMessageSent();
  
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('tgPostsSentToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment tgPostsSentToday in PostgreSQL:', err);
    });
    pgRepo.incrementMetric('totalTgPostsSent').catch(() => {});
  }
}

/**
 * Record a trend was detected (call from TrendMonitor)
 */
export function recordTrendDetected(): void {
  ensureDayIsCurrent();
  metrics.trendsDetectedToday++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('trendsDetectedToday').catch(err => {
      logger.warn('[SystemReporter] Failed to increment trendsDetectedToday in PostgreSQL:', err);
    });
  }
}

/**
 * Record a launch was completed (call from AutonomousMode)
 * Increments the all-time cumulative counter
 */
export function recordLaunchCompleted(): void {
  metrics.totalLaunches++;
  saveMetrics();
  if (usePostgres && pgRepo) {
    pgRepo.incrementMetric('totalLaunches').catch(err => {
      logger.warn('[SystemReporter] Failed to increment totalLaunches in PostgreSQL:', err);
    });
  }
}

/**
 * Get all-time cumulative stats
 */
export function getAllTimeStats(): { launches: number; tweets: number; tgPosts: number } {
  return {
    launches: metrics.totalLaunches || 0,
    tweets: metrics.totalTweetsSent || 0,
    tgPosts: metrics.totalTgPostsSent || 0,
  };
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

// Track last checked date to detect day changes
let lastCheckedDate: string = new Date().toISOString().split('T')[0];

/**
 * Reset daily counters (call at midnight or on day change)
 */
function resetDailyCounters(): void {
  const today = new Date().toISOString().split('T')[0];
  metrics.tweetsSentToday = 0;
  metrics.tgPostsSentToday = 0;
  metrics.trendsDetectedToday = 0;
  metrics.counterDate = today;
  // Also clear old failed attempts (older than 24h)
  if (metrics.failedAttempts) {
    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    metrics.failedAttempts = metrics.failedAttempts.filter(a => a.timestamp >= threshold);
  }
}

/**
 * Check if we've crossed midnight and reset counters if so
 * Called hourly to catch the day change
 */
async function checkMidnightReset(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (lastCheckedDate !== today) {
    logger.info(`[SystemReporter] 🌅 New day detected (was ${lastCheckedDate}, now ${today}), resetting daily counters`);
    
    // Reset in-memory counters
    resetDailyCounters();
    metrics.errors24h = 0;
    metrics.warnings24h = 0;
    
    // Update tracking
    lastCheckedDate = today;
    
    // Save to file
    saveMetrics();
    
    // Reset in PostgreSQL
    if (usePostgres && pgRepo) {
      try {
        await pgRepo.resetDailyMetrics(today);
        logger.info('[SystemReporter] Reset daily metrics in PostgreSQL');
      } catch (err) {
        logger.warn('[SystemReporter] Failed to reset PostgreSQL metrics:', err);
      }
    }
  }
}

// ── CFO portfolio snapshot (lazy-imports to avoid circular deps) ──
async function gatherCFOSnapshot(): Promise<CFOSnapshot | null> {
  try {
    const { getCFOEnv } = await import('../cfo/cfoEnv.ts');
    const env = getCFOEnv();
    if (!env.cfoEnabled) return null;

    const { gatherPortfolioState } = await import('../cfo/decisionEngine.ts');
    const ps = await gatherPortfolioState();

    // x402 revenue (non-fatal)
    let x402TotalCalls = 0, x402TotalEarned = 0, x402Last24h = 0;
    if (env.x402Enabled) {
      try {
        const { getRevenue } = await import('../cfo/x402Service.ts');
        const rev = getRevenue();
        x402TotalCalls = rev.totalCalls;
        x402TotalEarned = rev.totalEarned;
        x402Last24h = rev.last24h;
      } catch { /* non-fatal */ }
    }

    return {
      enabled: true,
      totalPortfolioUsd: ps.totalPortfolioUsd,
      solBalance: ps.solBalance,
      solPriceUsd: ps.solPriceUsd,
      hedgeRatio: ps.hedgeRatio,

      kaminoEnabled: env.kaminoEnabled,
      kaminoDepositUsd: ps.kaminoDepositValueUsd,
      kaminoBorrowUsd: ps.kaminoBorrowValueUsd,
      kaminoNetUsd: ps.kaminoNetValueUsd,
      kaminoLtv: ps.kaminoLtv,
      kaminoHealthFactor: ps.kaminoHealthFactor,
      kaminoJitoLoopActive: ps.kaminoJitoLoopActive,
      kaminoJitoLoopApy: ps.kaminoJitoLoopApy,

      orcaEnabled: env.orcaLpEnabled,
      orcaLpValueUsd: ps.orcaLpValueUsd,
      orcaLpFeeApy: ps.orcaLpFeeApy,
      orcaPositions: ps.orcaPositions.map(p => ({
        positionMint: p.positionMint,
        inRange: p.inRange,
        rangeUtilisationPct: p.rangeUtilisationPct,
      })),

      jitoSolBalance: ps.jitoSolBalance,
      jitoSolValueUsd: ps.jitoSolValueUsd,

      hlEnabled: env.hyperliquidEnabled,
      hlEquity: ps.hlEquity,
      hlTotalPnl: ps.hlTotalPnl,
      hlPositions: ps.hlPositions.map(p => ({
        coin: p.coin,
        side: p.side,
        sizeUsd: p.sizeUsd,
        unrealizedPnlUsd: p.unrealizedPnlUsd,
        leverage: p.leverage,
      })),

      krystalEnabled: env.krystalLpEnabled,
      krystalLpValueUsd: ps.evmLpTotalValueUsd,
      krystalLpFeesUsd: ps.evmLpTotalFeesUsd,
      krystalPositions: ps.evmLpPositions.map(p => ({
        posId: p.posId,
        chainName: p.chainName,
        token0Symbol: p.token0Symbol,
        token1Symbol: p.token1Symbol,
        inRange: p.inRange,
        rangeUtilisationPct: p.rangeUtilisationPct,
        valueUsd: p.valueUsd,
        feesOwedUsd: p.feesOwedUsd,
      })),

      polyEnabled: env.polymarketEnabled,
      polyDeployedUsd: ps.polyDeployedUsd,
      polyHeadroomUsd: ps.polyHeadroomUsd,
      polyPositionCount: ps.polyPositionCount,
      polyUsdcBalance: ps.polyUsdcBalance,

      x402TotalCalls,
      x402TotalEarned,
      x402Last24h,
    };
  } catch (err) {
    logger.warn(`[SystemReporter] CFO snapshot failed: ${err}`);
    return null;
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
  
  // Get PnL summary with current market prices for unrealized PnL
  let pnl: PnLSummary | null = null;
  try {
    // Fetch current prices for all active positions (batch call)
    const currentPrices: Record<string, number> = {};
    try {
      const positions = await getActivePositions();
      const mintsToPrice = positions
        .filter(pos => pos.currentBalance > 0 && pos.mint)
        .map(pos => pos.mint);
      
      if (mintsToPrice.length > 0) {
        const priceMap = await getTokenPrices(mintsToPrice);
        for (const [mint, priceData] of priceMap) {
          if (priceData?.priceNative && priceData.priceNative > 0) {
            currentPrices[mint] = priceData.priceNative;
          }
        }
      }
    } catch (priceErr) {
      logger.warn(`[SystemReporter] Failed to fetch token prices for PnL: ${priceErr}`);
    }
    pnl = await getPnLSummary(Object.keys(currentPrices).length > 0 ? currentPrices : undefined);
  } catch {
    // PnL tracker might not be initialized
  }
  
  return {
    // Telegram health (use minutesSinceLastActivity to include sent messages for autonomous mode)
    telegramHealthy: tgHealth.isHealthy,
    telegramMessagesReceived: tgHealth.messageCount,
    telegramMinutesSinceLastMessage: tgHealth.minutesSinceLastActivity ?? tgHealth.minutesSinceLastMessage,
    
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
    
    // Swarm agents
    swarm: collectSwarmStats(),

    // CFO portfolio
    cfo: await gatherCFOSnapshot(),
  };
}

/**
 * Collect swarm agent stats from the registered SwarmHandle
 */
function collectSwarmStats(): SwarmStats | null {
  if (!swarmHandle) return null;

  const agents: SwarmAgentInfo[] = [];
  const agentStatuses = swarmHandle.supervisor.getAgentStatuses();

  // Helper: time ago string
  const ago = (d: Date | null): string => {
    if (!d) return '?';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  };

  // Helper: resolve status — trust live in-process running state over potentially stale DB heartbeat
  const resolveStatus = (running: boolean, hb?: { status: string } | null): string =>
    running ? (hb?.status === 'degraded' ? 'degraded' : 'alive') : (hb?.status || 'dead');

  // Supervisor (agentId is 'nova', not 'nova-supervisor')
  try {
    const s = swarmHandle.supervisor.getStatus();
    const hb = agentStatuses.get('nova');
    agents.push({
      name: 'supervisor',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.messagesProcessed} msgs, ${s.intelBufferSize} intel, ${s.activeChildren} children`,
    });
  } catch { agents.push({ name: 'supervisor', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // Scout
  try {
    const s = swarmHandle.scout.getStatus();
    const hb = agentStatuses.get('nova-scout');
    const lastR = s.lastResearchAt ? ago(new Date(s.lastResearchAt)) : 'never';
    agents.push({
      name: 'scout',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.cycleCount} cycles, last research ${lastR}`,
    });
  } catch { agents.push({ name: 'scout', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // Guardian
  try {
    const s = swarmHandle.guardian.getStatus();
    const hb = agentStatuses.get('nova-guardian');
    agents.push({
      name: 'guardian',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.watchListSize} watched, ${s.totalScans} scans, ${s.totalLiquidityAlerts} LP alerts`,
    });
  } catch { agents.push({ name: 'guardian', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // Analyst
  try {
    const s = swarmHandle.analyst.getStatus();
    const hb = agentStatuses.get('nova-analyst');
    const totalTokens = s.coreTokenCount + s.dynamicCoinGeckoCount + s.dynamicDexMintCount;
    agents.push({
      name: 'analyst',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${totalTokens} tokens (${s.coreTokenCount}+${s.dynamicCoinGeckoCount}+${s.dynamicDexMintCount}), ${s.cycleCount} snapshots`,
    });
  } catch { agents.push({ name: 'analyst', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // Launcher
  try {
    const s = swarmHandle.launcher.getStatus();
    const hb = agentStatuses.get('nova-launcher');
    agents.push({
      name: 'launcher',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.launchCount} launches, ${s.graduationCount} graduated`,
    });
  } catch { agents.push({ name: 'launcher', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // Community
  try {
    const s = swarmHandle.community.getStatus();
    const hb = agentStatuses.get('nova-community');
    agents.push({
      name: 'community',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.lastEngagementRate.toFixed(1)} eng/hr, ${s.reportCount} reports`,
    });
  } catch { agents.push({ name: 'community', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  // CFO
  try {
    const s = swarmHandle.cfo.getStatus();
    const hb = agentStatuses.get('nova-cfo');
    const pauseLabel = s.paused ? '⏸️ paused' : 'active';
    agents.push({
      name: 'cfo',
      status: resolveStatus(s.running, hb),
      lastSeen: hb?.lastSeen ?? null,
      detail: `${s.cycleCount} cycles, ${s.pendingApprovals} pending, ${pauseLabel}`,
    });
  } catch { agents.push({ name: 'cfo', status: 'error', lastSeen: null, detail: 'failed to read' }); }

  const aliveCount = agents.filter(a => a.status === 'alive').length;

  return { agents, totalAgents: agents.length, aliveCount };
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

  // ── CFO Portfolio Section ──
  if (stats.cfo) {
    const c = stats.cfo;
    const hedgePct = (c.hedgeRatio * 100).toFixed(0);
    message += `<b>💹 CFO Portfolio ($${c.totalPortfolioUsd.toFixed(2)}):</b>\n`;
    message += `  SOL: ${c.solBalance.toFixed(4)} ($${(c.solBalance * c.solPriceUsd).toFixed(2)}) @ $${c.solPriceUsd.toFixed(2)}\n`;
    if (c.polyUsdcBalance > 0 || c.polyDeployedUsd > 0) {
      message += `  Polygon USDC: $${c.polyUsdcBalance.toFixed(2)} (wallet) + $${c.polyDeployedUsd.toFixed(2)} (deployed)\n`;
    }
    message += `  Hedge ratio: ${hedgePct}%\n\n`;

    // Kamino
    if (c.kaminoEnabled && (c.kaminoDepositUsd > 0 || c.kaminoBorrowUsd > 0)) {
      const healthEmoji = c.kaminoHealthFactor > 1.5 ? '🟢' : c.kaminoHealthFactor > 1.2 ? '🟡' : '🔴';
      message += `  <b>🏦 Kamino Lending:</b>\n`;
      message += `    Deposits: $${c.kaminoDepositUsd.toFixed(2)}\n`;
      message += `    Borrows: $${c.kaminoBorrowUsd.toFixed(2)}\n`;
      message += `    Net equity: $${c.kaminoNetUsd.toFixed(2)}\n`;
      message += `    LTV: ${(c.kaminoLtv * 100).toFixed(1)}% | Health: ${healthEmoji} ${c.kaminoHealthFactor.toFixed(2)}\n`;
      if (c.kaminoJitoLoopActive) {
        message += `    JitoSOL loop: ✅ active (${(c.kaminoJitoLoopApy * 100).toFixed(1)}% APY)\n`;
      }
      message += '\n';
    }

    // Orca LP
    if (c.orcaEnabled && c.orcaPositions.length > 0) {
      message += `  <b>🌊 Orca LP ($${c.orcaLpValueUsd.toFixed(2)}):</b>\n`;
      for (const pos of c.orcaPositions) {
        const rangeEmoji = pos.inRange ? '🟢' : '🔴';
        message += `    ${rangeEmoji} <code>${pos.positionMint.slice(0, 6)}…</code> ${pos.rangeUtilisationPct.toFixed(0)}% util${pos.inRange ? '' : ' (out of range)'}\n`;
      }
      message += `    Est. fee APY: ${(c.orcaLpFeeApy * 100).toFixed(1)}%\n\n`;
    }

    // Krystal EVM LP
    if (c.krystalEnabled && c.krystalPositions.length > 0) {
      message += `  <b>💎 Krystal LP ($${c.krystalLpValueUsd.toFixed(2)}):</b>\n`;
      for (const pos of c.krystalPositions) {
        const rangeEmoji = pos.inRange ? '🟢' : '🔴';
        message += `    ${rangeEmoji} ${pos.token0Symbol}/${pos.token1Symbol} on ${pos.chainName} — $${pos.valueUsd.toFixed(2)} | ${pos.rangeUtilisationPct.toFixed(0)}% util`;
        if (pos.feesOwedUsd > 0.001) message += ` | fees: $${pos.feesOwedUsd.toFixed(4)}`;
        message += `\n`;
      }
      message += `\n`;
    }

    // Jito Staking
    if (c.jitoSolBalance > 0) {
      message += `  <b>⚡ Jito Staking:</b>\n`;
      message += `    JitoSOL: ${c.jitoSolBalance.toFixed(4)} ($${c.jitoSolValueUsd.toFixed(2)})\n\n`;
    }

    // Hyperliquid
    if (c.hlEnabled && (c.hlEquity > 0 || c.hlPositions.length > 0)) {
      const pnlEmoji = c.hlTotalPnl >= 0 ? '🟢' : '🔴';
      const pnlSign = c.hlTotalPnl >= 0 ? '+' : '';
      message += `  <b>📊 HyperLiquid ($${c.hlEquity.toFixed(2)}):</b>\n`;
      message += `    PnL: ${pnlEmoji} ${pnlSign}$${c.hlTotalPnl.toFixed(2)}\n`;
      for (const p of c.hlPositions) {
        const posEmoji = p.unrealizedPnlUsd >= 0 ? '🟢' : '🔴';
        message += `    ${posEmoji} ${p.coin} ${p.side} $${p.sizeUsd.toFixed(0)} (${p.leverage}x) PnL: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)}\n`;
      }
      message += '\n';
    }

    // Polymarket
    if (c.polyEnabled && (c.polyDeployedUsd > 0 || c.polyUsdcBalance > 0)) {
      message += `  <b>🎰 Polymarket:</b>\n`;
      message += `    Deployed: $${c.polyDeployedUsd.toFixed(2)} (${c.polyPositionCount} positions)\n`;
      message += `    USDC balance: $${c.polyUsdcBalance.toFixed(2)}\n`;
      message += `    Headroom: $${c.polyHeadroomUsd.toFixed(2)}\n\n`;
    }

    // x402 Revenue
    if (c.x402TotalCalls > 0 || c.x402TotalEarned > 0) {
      message += `  <b>💳 x402 Payments:</b>\n`;
      message += `    Total earned: $${c.x402TotalEarned.toFixed(4)} USDC (${c.x402TotalCalls} calls)\n`;
      message += `    Last 24h: $${c.x402Last24h.toFixed(4)} USDC\n\n`;
    }
  }

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
  
  // Swarm agents
  if (stats.swarm) {
    const sw = stats.swarm;
    const statusEmoji = (s: string) => s === 'alive' ? '🟢' : s === 'degraded' ? '🟡' : s === 'error' ? '🔴' : '⚫';
    message += `<b>🧠 Agent Swarm (${sw.aliveCount}/${sw.totalAgents}):</b>\n`;
    for (const a of sw.agents) {
      const lastSeenStr = a.lastSeen ? (() => {
        const mins = Math.round((Date.now() - a.lastSeen!.getTime()) / 60000);
        return mins < 1 ? 'now' : mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
      })() : '?';
      message += `  ${statusEmoji(a.status)} <b>${a.name}</b> (${lastSeenStr}) — ${a.detail}\n`;
    }
    message += '\n';
  }
  
  // System health
  message += `<b>⚙️ System:</b>\n`;
  message += `  Uptime: ${formatUptime(stats.uptimeHours)}\n`;
  message += `  Errors (24h): ${stats.errors24h}\n`;
  message += `  Warnings (24h): ${stats.warnings24h}\n`;
  
  await notifyAdminForce(message);
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
  
  // PnL
  if (stats.pnl) {
    const p = stats.pnl;
    const realizedSign = p.totalRealizedPnl >= 0 ? '+' : '';
    message += `<b>📈 PnL:</b>\n`;
    message += `  • Realized: ${realizedSign}${p.totalRealizedPnl.toFixed(4)} SOL\n`;
    message += `  • Active: ${p.activePositions} positions, ${p.totalTrades} trades\n`;
    if (p.winningTrades + p.losingTrades > 0) {
      message += `  • Win rate: ${p.winRate.toFixed(0)}% (${p.winningTrades}W/${p.losingTrades}L)\n`;
    }
    message += `  • Net flow: ${p.netSolFlow >= 0 ? '+' : ''}${p.netSolFlow.toFixed(4)} SOL\n`;
    message += '\n';
  }

  // ── CFO Portfolio (condensed) ──
  if (stats.cfo) {
    const c = stats.cfo;
    message += `<b>💹 CFO Portfolio ($${c.totalPortfolioUsd.toFixed(2)}):</b>\n`;
    message += `  • SOL: ${c.solBalance.toFixed(4)} @ $${c.solPriceUsd.toFixed(2)} | Hedge: ${(c.hedgeRatio * 100).toFixed(0)}%\n`;
    if (c.polyUsdcBalance > 0 || c.polyDeployedUsd > 0) {
      message += `  • Polygon USDC: $${c.polyUsdcBalance.toFixed(2)} wallet + $${c.polyDeployedUsd.toFixed(2)} deployed\n`;
    }

    if (c.kaminoEnabled && (c.kaminoDepositUsd > 0 || c.kaminoBorrowUsd > 0)) {
      const healthEmoji = c.kaminoHealthFactor > 1.5 ? '🟢' : c.kaminoHealthFactor > 1.2 ? '🟡' : '🔴';
      message += `  • Kamino: $${c.kaminoNetUsd.toFixed(2)} net | LTV ${(c.kaminoLtv * 100).toFixed(1)}% | ${healthEmoji} HF ${c.kaminoHealthFactor.toFixed(2)}`;
      if (c.kaminoJitoLoopActive) message += ` | Loop ${(c.kaminoJitoLoopApy * 100).toFixed(1)}%`;
      message += '\n';
    }

    if (c.orcaEnabled && c.orcaPositions.length > 0) {
      const inRange = c.orcaPositions.filter(p => p.inRange).length;
      message += `  • Orca LP: $${c.orcaLpValueUsd.toFixed(2)} | ${inRange}/${c.orcaPositions.length} in range | ${(c.orcaLpFeeApy * 100).toFixed(1)}% APY\n`;
    }

    if (c.krystalEnabled && c.krystalPositions.length > 0) {
      const inRange = c.krystalPositions.filter(p => p.inRange).length;
      const chains = [...new Set(c.krystalPositions.map(p => p.chainName))].join(',');
      message += `  • Krystal LP: $${c.krystalLpValueUsd.toFixed(2)} | ${inRange}/${c.krystalPositions.length} in range | ${chains}\n`;
    }

    if (c.jitoSolBalance > 0) {
      message += `  • Jito: ${c.jitoSolBalance.toFixed(4)} JitoSOL ($${c.jitoSolValueUsd.toFixed(2)})\n`;
    }

    if (c.hlEnabled && (c.hlEquity > 0 || c.hlPositions.length > 0)) {
      const pnlSign = c.hlTotalPnl >= 0 ? '+' : '';
      message += `  • HL: $${c.hlEquity.toFixed(2)} equity | PnL: ${pnlSign}$${c.hlTotalPnl.toFixed(2)}`;
      if (c.hlPositions.length > 0) {
        const posStr = c.hlPositions.map(p => `${p.coin} ${p.side} $${p.sizeUsd.toFixed(0)}`).join(', ');
        message += ` | ${posStr}`;
      }
      message += '\n';
    }

    if (c.polyEnabled && (c.polyDeployedUsd > 0 || c.polyUsdcBalance > 0)) {
      message += `  • Poly: $${c.polyDeployedUsd.toFixed(2)} deployed (${c.polyPositionCount} pos) | $${c.polyUsdcBalance.toFixed(2)} USDC\n`;
    }

    if (c.x402TotalCalls > 0 || c.x402TotalEarned > 0) {
      message += `  • x402: $${c.x402TotalEarned.toFixed(4)} earned (${c.x402TotalCalls} calls) | 24h: $${c.x402Last24h.toFixed(4)}\n`;
    }

    message += '\n';
  }

  // Swarm performance
  if (stats.swarm) {
    const sw = stats.swarm;
    message += `<b>🧠 Swarm (${sw.aliveCount}/${sw.totalAgents} online):</b>\n`;
    for (const a of sw.agents) {
      const emoji = a.status === 'alive' ? '✅' : a.status === 'degraded' ? '⚠️' : '❌';
      message += `  ${emoji} ${a.name}: ${a.detail}\n`;
    }
    message += '\n';
  }
  
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
  
  // Send directly to admin (bypass alert-type gating)
  await notifyAdminForce(message);
  
  // Note: Counter reset is handled by checkMidnightReset() which runs hourly
  // Just update the daily report date to prevent duplicate reports
  metrics.lastDailyReportDate = new Date().toISOString().split('T')[0];
  saveMetrics();
  
  logger.info('[SystemReporter] Sent daily summary to admin');
}

/**
 * Check if it's time for daily report.
 * Uses >= instead of === so we catch up if the hourly check
 * missed the exact target hour (e.g. after a Railway redeploy).
 */
function checkDailyReport(): void {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  // Only send once per day, on or after the configured hour
  if (metrics.lastDailyReportDate === today) {
    return;
  }
  
  if (now.getUTCHours() >= DAILY_REPORT_HOUR_UTC) {
    logger.info(`[SystemReporter] Triggering daily summary (hour=${now.getUTCHours()}, target=${DAILY_REPORT_HOUR_UTC})`);
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
      
      // Self-healing: recover metrics from actual post tables if needed
      try {
        const recovery = await pgRepo.recoverMetricsFromPosts();
        if (recovery.recovered) {
          logger.info(`[SystemReporter] 🔧 Self-healed metrics from post tables (X: ${recovery.tweets}, TG: ${recovery.tgPosts}${recovery.totalLaunches ? `, Launches: ${recovery.totalLaunches}` : ''})`);
          metrics.tweetsSentToday = recovery.tweets;
          metrics.tgPostsSentToday = recovery.tgPosts;
          if (recovery.totalLaunches) {
            metrics.totalLaunches = recovery.totalLaunches;
          }
        }
      } catch (recoveryErr) {
        logger.warn('[SystemReporter] Metrics recovery check failed:', recoveryErr);
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
  
  // Send initial startup report after a short delay — but skip if one was sent recently
  const MIN_REPORT_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
  setTimeout(() => {
    const elapsed = Date.now() - (metrics.lastReportTime || 0);
    if (elapsed < MIN_REPORT_GAP_MS) {
      logger.info(`[SystemReporter] Skipping startup report — last report was ${Math.round(elapsed / 60000)}m ago (min gap: ${MIN_REPORT_GAP_MS / 60000}m)`);
      return;
    }
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
  
  // Check for daily report and midnight reset every hour
  dailyReportInterval = setInterval(() => {
    // Check if we crossed midnight (reset counters)
    checkMidnightReset().catch(err => {
      logger.error('[SystemReporter] Failed midnight reset check:', err);
    });
    // Check if it's time for the daily summary
    checkDailyReport();
  }, 60 * 60 * 1000);
  
  // Also run midnight check immediately on startup
  checkMidnightReset().catch(err => {
    logger.error('[SystemReporter] Failed initial midnight check:', err);
  });
  
  // Also check daily report on startup (catches missed summaries after redeploy)
  setTimeout(() => {
    checkDailyReport();
  }, 60 * 1000); // 1 minute after startup
  
  logger.info(`[SystemReporter] ✅ Started (reports every ${STATUS_REPORT_INTERVAL_MS / (60 * 60 * 1000)}h, daily summary at >=${DAILY_REPORT_HOUR_UTC}:00 UTC, midnight reset check hourly)`);

  // ── Auto-track errors & warnings by patching the ElizaOS logger ──
  // This ensures ALL logger.error() and logger.warn() calls in the codebase
  // are counted, without needing to sprinkle recordError() everywhere.
  try {
    const origError = logger.error.bind(logger);
    const origWarn  = logger.warn.bind(logger);
    (logger as any).error = function (...args: unknown[]) {
      metrics.errors24h++;
      // Fire-and-forget PG increment
      if (usePostgres && pgRepo) {
        pgRepo.incrementMetric('errors24h').catch(() => {});
      }
      return (origError as Function).apply(logger, args);
    };
    (logger as any).warn = function (...args: unknown[]) {
      metrics.warnings24h++;
      if (usePostgres && pgRepo) {
        pgRepo.incrementMetric('warnings24h').catch(() => {});
      }
      return (origWarn as Function).apply(logger, args);
    };
    logger.info('[SystemReporter] Logger patched — errors/warnings now auto-tracked');
  } catch (patchErr) {
    logger.warn('[SystemReporter] Failed to patch logger for error/warning tracking:', patchErr);
  }
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
