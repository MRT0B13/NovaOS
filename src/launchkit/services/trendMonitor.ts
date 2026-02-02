import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { notifyAutonomous } from './adminNotify.ts';
import { recordTrendDetected } from './systemReporter.ts';
import * as trendPool from './trendPool.ts';

/**
 * Trend Monitor Service
 * 
 * Monitors for trending topics and viral moments that could be good
 * opportunities for reactive token launches.
 * 
 * Sources:
 * - DexScreener: Top boosted tokens (free, no auth)
 * - CoinGecko: Trending coins by search + social (free, no auth)
 * - CryptoPanic: Trending crypto news (free tier with API key)
 * - CryptoNews: Trending headlines & top mentions (free tier with API key)
 * - Manual trigger via admin command
 * 
 * NEW: Trend Pool Integration
 * - Trends are now persisted to disk (data/trend_pool.json)
 * - Agent can browse and select from a pool of trends
 * - Score decay over time keeps pool fresh
 * - Multi-source confirmation boosts confidence
 * 
 * When a hot trend is detected, it can bypass the scheduler and
 * trigger an immediate launch (with guardrails still in place).
 */

export interface TrendSignal {
  source: 'twitter' | 'news' | 'manual' | 'pump_fun' | 'dexscreener' | 'coingecko' | 'cryptonews';
  topic: string;
  score: number;        // 0-100 confidence score
  context: string;      // Why this is trending
  detectedAt: Date;
  expiresAt: Date;      // Trends have a shelf life
  id?: string;          // Unique identifier (token address, news id)
  boostCount?: number;  // Raw boost count for tiebreaking
  seenCount?: number;   // How many times we've seen this trend
}

interface TrendMonitorState {
  enabled: boolean;
  lastCheck: Date | null;
  activeTrends: TrendSignal[];
  triggeredToday: number;
  lastTriggerDate: string | null;
  lastReactiveLaunchTime: Date | null;  // For cooldown between launches
  seenTopics: Set<string>;       // Avoid re-triggering same trends
  trendPersistence: Map<string, number>;  // id -> times seen consecutively
  lastNotifyTime: Date | null;   // Avoid spam notifications
  lastNotifiedTrends: Map<string, number>; // id -> timestamp when notified
  cryptoPanicDisabled: boolean;  // Disable after 429 quota error
  cryptoPanicDisabledAt: Date | null;
}

const state: TrendMonitorState = {
  enabled: false,
  lastCheck: null,
  activeTrends: [],
  triggeredToday: 0,
  lastTriggerDate: null,
  lastReactiveLaunchTime: null,
  seenTopics: new Set(),
  trendPersistence: new Map(),
  lastNotifyTime: null,
  lastNotifiedTrends: new Map(),
  cryptoPanicDisabled: false,
  cryptoPanicDisabledAt: null,
};

let monitorInterval: NodeJS.Timeout | null = null;
let onTrendCallback: ((trend: TrendSignal) => Promise<void>) | null = null;

// ============================================================================
// Configuration (defaults, can be overridden by env)
// ============================================================================

const getConfig = () => {
  const env = getEnv();
  // Poll interval: default 30 min during busy hours, 45 min during quiet
  const pollIntervalMinutes = env.TREND_POLL_INTERVAL_MINUTES ?? 30;
  const pollIntervalQuietMinutes = env.TREND_POLL_INTERVAL_QUIET_MINUTES ?? 45;
  return {
    CHECK_INTERVAL_MS: pollIntervalMinutes * 60 * 1000,
    CHECK_INTERVAL_QUIET_MS: pollIntervalQuietMinutes * 60 * 1000,
    MIN_SCORE_TO_TRIGGER: env.AUTONOMOUS_REACTIVE_MIN_SCORE || 70,
    MAX_REACTIVE_PER_DAY: env.AUTONOMOUS_REACTIVE_MAX_PER_DAY || 3,
    REACTIVE_COOLDOWN_HOURS: env.AUTONOMOUS_REACTIVE_COOLDOWN_HOURS ?? 2,
    SCHEDULED_BUFFER_HOURS: env.AUTONOMOUS_SCHEDULED_BUFFER_HOURS ?? 1,
    SCHEDULED_LAUNCH_TIME: env.AUTONOMOUS_SCHEDULE || '14:00',
    QUIET_START: env.AUTONOMOUS_REACTIVE_QUIET_START || '00:00',
    QUIET_END: env.AUTONOMOUS_REACTIVE_QUIET_END || '10:00',
    BUSY_START: env.AUTONOMOUS_REACTIVE_BUSY_START || '12:00',
    BUSY_END: env.AUTONOMOUS_REACTIVE_BUSY_END || '22:00',
    TREND_EXPIRY_MINUTES: 60,           // Trends expire after 60 min (pool handles longer persistence)
    COOLDOWN_AFTER_TRIGGER_MS: 60 * 60 * 1000, // 1 hour cooldown after trigger
    MIN_PERSISTENCE_TO_TRIGGER: env.TREND_MIN_PERSISTENCE ?? 2, // Must see trend N times before triggering
    NOTIFY_COOLDOWN_MS: 15 * 60 * 1000, // 15 min between admin notifications (more conservative)
    NOTIFIED_EXPIRY_MS: 60 * 60 * 1000, // Re-notify about trend after 1 hour
    // Pool config
    POOL_DECAY_PER_HOUR: env.TREND_POOL_DECAY_PER_HOUR ?? 5,
    POOL_MAX_SIZE: env.TREND_POOL_MAX_SIZE ?? 30,
    POOL_MIN_SCORE: env.TREND_POOL_MIN_SCORE ?? 40,
    POOL_STALE_HOURS: env.TREND_POOL_STALE_HOURS ?? 6,
  };
};

// Legacy constant for backward compatibility
const CONFIG = {
  CHECK_INTERVAL_MS: 5 * 60 * 1000,
  MIN_SCORE_TO_TRIGGER: 70,
  MAX_REACTIVE_PER_DAY: 2,
  TREND_EXPIRY_MINUTES: 30,
  COOLDOWN_AFTER_TRIGGER_MS: 60 * 60 * 1000,
};

// ============================================================================
// Trend Detection - Real Implementations
// ============================================================================

/**
 * Fetch top boosted tokens from DexScreener
 * FREE API, no auth required, 60 req/min limit
 */
async function fetchDexScreenerTrends(): Promise<TrendSignal[]> {
  const trends: TrendSignal[] = [];
  
  try {
    // Get top boosted tokens - these are tokens getting attention
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!res.ok) {
      logger.debug(`[TrendMonitor] DexScreener API returned ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    
    // Handle both array and single object responses
    const tokens = Array.isArray(data) ? data : (data ? [data] : []);
    
    // Filter for Solana tokens with significant boosts
    const solanaTokens = tokens.filter((t: any) => 
      t.chainId === 'solana' && 
      t.totalAmount >= 100 && // At least 100 boosts
      !state.seenTopics.has(t.tokenAddress) // Haven't seen this before
    );
    
    // Take top 5 most boosted
    for (const token of solanaTokens.slice(0, 5)) {
      // Skip if no description (likely a scam or low-effort token)
      if (!token.description && !token.symbol) continue;
      
      const topic = token.description || token.symbol || token.tokenAddress;
      const score = Math.min(100, 50 + (token.totalAmount / 10)); // Score based on boost count
      
      trends.push({
        source: 'dexscreener',
        topic: topic,
        score: Math.round(score),
        context: `Hot on DexScreener: ${token.totalAmount} boosts. Token: ${token.tokenAddress}`,
        detectedAt: new Date(),
        expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
        id: token.tokenAddress,    // Unique identifier for deduplication
        boostCount: token.totalAmount,  // For tiebreaking when scores are equal
      });
    }
    
    if (trends.length > 0) {
      logger.info(`[TrendMonitor] DexScreener: Found ${trends.length} trending Solana tokens`);
    }
    
  } catch (err) {
    logger.debug('[TrendMonitor] DexScreener check failed:', err);
  }
  
  return trends;
}

/**
 * Fetch trending crypto news from CryptoPanic
 * Free "developer" tier - requires API key
 * Set CRYPTOPANIC_API_KEY in .env
 */
async function fetchCryptoPanicTrends(): Promise<TrendSignal[]> {
  const trends: TrendSignal[] = [];
  const env = getEnv();
  const apiKey = env.CRYPTOPANIC_API_KEY;
  
  if (!apiKey) {
    return []; // Silently skip if no API key
  }
  
  // Skip if disabled due to quota exceeded
  if (state.cryptoPanicDisabled) {
    // Re-enable after 24 hours (quota might reset)
    if (state.cryptoPanicDisabledAt && 
        Date.now() - state.cryptoPanicDisabledAt.getTime() > 24 * 60 * 60 * 1000) {
      logger.info('[TrendMonitor] CryptoPanic: Re-enabling after 24h cooldown');
      state.cryptoPanicDisabled = false;
      state.cryptoPanicDisabledAt = null;
    } else {
      return []; // Still disabled
    }
  }
  
  try {
    // Get "rising" crypto news - these are gaining traction
    const url = `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${apiKey}&public=true&filter=rising&currencies=SOL&kind=news`;
    
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!res.ok) {
      const body = await res.text();
      
      // Handle quota exceeded - disable for 24 hours
      if (res.status === 429 || body.includes('quota exceeded')) {
        logger.warn('[TrendMonitor] CryptoPanic: Monthly quota exceeded - disabling for 24h');
        state.cryptoPanicDisabled = true;
        state.cryptoPanicDisabledAt = new Date();
        return [];
      }
      
      logger.warn(`[TrendMonitor] CryptoPanic API error: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const posts = data.results || [];
    
    // Look for viral/trending news
    for (const post of posts.slice(0, 5)) {
      // Skip if we've seen this story
      if (state.seenTopics.has(post.slug || post.id)) continue;
      
      // Calculate score based on votes
      const votes = post.votes || {};
      const engagement = (votes.positive || 0) + (votes.important || 0) + (votes.liked || 0);
      const negativeSignal = (votes.negative || 0) + (votes.toxic || 0);
      
      // Need some engagement and low negative signals (lowered threshold for news rarity)
      if (engagement < 3 || negativeSignal > engagement * 0.3) continue;
      
      // Score formula: news is valuable, so scale more aggressively
      // 3 votes = 55, 5 votes = 65, 10 votes = 90, 15+ = 100
      const score = Math.min(100, 40 + (engagement * 5));
      
      trends.push({
        source: 'news',  // Shows as 'cryptopanic' in admin notifications
        topic: `[CryptoPanic] ${post.title}`,
        score: Math.round(score),
        context: `Rising on CryptoPanic: ${engagement} positive votes. ${post.url}`,
        detectedAt: new Date(),
        expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
        id: post.slug || post.id || post.title,  // Unique identifier
        boostCount: engagement,  // For tiebreaking
      });
    }
    
    if (trends.length > 0) {
      logger.info(`[TrendMonitor] CryptoPanic: Found ${trends.length} trending news stories`);
    }
    
  } catch (err: any) {
    logger.debug(`[TrendMonitor] CryptoPanic check failed: ${err.message}`);
  }
  
  return trends;
}

/**
 * Fetch trending coins from CoinGecko
 * FREE API, no auth required, 10-30 req/min limit
 * Returns top 7 trending coins based on search + social activity
 */
async function fetchCoinGeckoTrends(): Promise<TrendSignal[]> {
  const trends: TrendSignal[] = [];
  
  try {
    // CoinGecko trending endpoint - returns top 7 trending coins
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending', {
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'Nova-LaunchKit/1.0',
      },
    });
    
    if (!res.ok) {
      logger.debug(`[TrendMonitor] CoinGecko API returned ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const coins = data.coins || [];
    
    // CoinGecko returns coins ranked by trending score (position 0 = most trending)
    for (let i = 0; i < coins.length; i++) {
      const coin = coins[i].item;
      if (!coin) continue;
      
      // Skip if we've already triggered on this coin
      const coinId = `coingecko:${coin.id}`;
      if (state.seenTopics.has(coinId)) continue;
      
      // Score: Position-based (rank 1 = 95, rank 7 = 65) + market cap rank bonus
      let score = 95 - (i * 5);
      
      // Boost score for lower market cap coins (higher upside potential)
      if (coin.market_cap_rank && coin.market_cap_rank > 100) {
        score += 5; // Small cap bonus
      }
      
      // Cap at 100
      score = Math.min(100, score);
      
      // Build context with available info
      let context = `Trending #${i + 1} on CoinGecko`;
      if (coin.market_cap_rank) {
        context += ` (MC rank: #${coin.market_cap_rank})`;
      }
      if (coin.data?.price_change_percentage_24h) {
        const change = coin.data.price_change_percentage_24h.usd?.toFixed(1);
        if (change) context += ` 24h: ${change}%`;
      }
      
      trends.push({
        source: 'coingecko',
        topic: `${coin.name} ($${coin.symbol.toUpperCase()})`,
        score: Math.round(score),
        context,
        detectedAt: new Date(),
        expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
        id: coinId,
        boostCount: 7 - i, // Higher for top ranked
      });
    }
    
    if (trends.length > 0) {
      logger.info(`[TrendMonitor] CoinGecko: Found ${trends.length} trending coins`);
    }
    
  } catch (err: any) {
    logger.debug(`[TrendMonitor] CoinGecko check failed: ${err.message}`);
  }
  
  return trends;
}

/**
 * Fetch trending headlines and top mentions from CryptoNews API
 * Requires API key from https://cryptonews-api.com
 * Free trial available, includes sentiment analysis
 */
async function fetchCryptoNewsTrends(): Promise<TrendSignal[]> {
  const trends: TrendSignal[] = [];
  const env = getEnv();
  const apiKey = env.CRYPTONEWS_API_KEY;
  
  if (!apiKey) {
    return []; // Silently skip if no API key
  }
  
  try {
    // Fetch trending headlines - high news coverage stories
    const trendingUrl = `https://cryptonews-api.com/api/v1/trending-headlines?&page=1&token=${apiKey}`;
    
    const trendingRes = await fetch(trendingUrl, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (trendingRes.ok) {
      const trendingData = await trendingRes.json();
      const headlines = trendingData.data || [];
      
      for (let i = 0; i < Math.min(headlines.length, 5); i++) {
        const item = headlines[i];
        // API returns 'headline' not 'title'
        const headline = item?.headline || item?.title;
        if (!item || !headline) continue;
        
        // Skip if we've seen this
        const itemId = `cryptonews:${item.news_url || headline}`;
        if (state.seenTopics.has(itemId)) continue;
        
        // Score: Position-based (top = 90, drops by 5 per position)
        // Boost for positive sentiment
        let score = 90 - (i * 5);
        if (item.sentiment === 'Positive') score += 5;
        if (item.sentiment === 'Negative') score -= 10;
        score = Math.max(50, Math.min(100, score));
        
        // Extract tickers from the headline
        const tickers = item.tickers?.join(', ') || 'Crypto';
        
        trends.push({
          source: 'cryptonews',
          topic: `${headline}`,
          score: Math.round(score),
          context: `Trending headline (${item.sentiment || 'Neutral'}) - ${tickers}. Source: ${item.source_name || 'CryptoNews'}`,
          detectedAt: new Date(),
          expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
          id: itemId,
          boostCount: 5 - i, // Higher for top headlines
        });
      }
    } else {
      logger.debug(`[TrendMonitor] CryptoNews API returned ${trendingRes.status}`);
    }
    
    // Also fetch top mentioned tickers this week for additional context
    const topMentionUrl = `https://cryptonews-api.com/api/v1/top-mention?&date=last7days&token=${apiKey}`;
    
    const mentionRes = await fetch(topMentionUrl, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (mentionRes.ok) {
      const mentionData = await mentionRes.json();
      const mentions = mentionData.data || [];
      
      // Look for unusual spikes - coins with high mention count AND positive sentiment
      for (let i = 0; i < Math.min(mentions.length, 3); i++) {
        const item = mentions[i];
        if (!item || !item.ticker) continue;
        
        // Skip major coins - we want emerging narratives
        const majorCoins = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'XRP', 'BNB'];
        if (majorCoins.includes(item.ticker)) continue;
        
        const itemId = `cryptonews:mention:${item.ticker}`;
        if (state.seenTopics.has(itemId)) continue;
        
        // Score based on sentiment ratio and mention count
        const positiveRatio = item.positive_count / (item.total_count || 1);
        let score = 70 + (positiveRatio * 20); // 70-90 based on sentiment
        if (item.total_count > 50) score += 5; // Bonus for high coverage
        score = Math.min(95, score);
        
        trends.push({
          source: 'cryptonews',
          topic: `${item.ticker} trending in news`,
          score: Math.round(score),
          context: `Top mentioned: ${item.total_count} articles, ${Math.round(positiveRatio * 100)}% positive`,
          detectedAt: new Date(),
          expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
          id: itemId,
          boostCount: item.total_count || 1,
        });
      }
    }
    
    if (trends.length > 0) {
      logger.info(`[TrendMonitor] CryptoNews: Found ${trends.length} trending items`);
    }
    
  } catch (err: any) {
    logger.debug(`[TrendMonitor] CryptoNews check failed: ${err.message}`);
  }
  
  return trends;
}

/**
 * Aggregate trends from all sources
 */
async function detectTrends(): Promise<TrendSignal[]> {
  const allTrends: TrendSignal[] = [];
  
  // Fetch from all sources in parallel
  const [dexTrends, geckoTrends, newsTrends, cryptoNewsTrends] = await Promise.all([
    fetchDexScreenerTrends().catch(() => []),
    fetchCoinGeckoTrends().catch(() => []),
    fetchCryptoPanicTrends().catch(() => []),
    fetchCryptoNewsTrends().catch(() => []),
  ]);
  
  allTrends.push(...dexTrends, ...geckoTrends, ...newsTrends, ...cryptoNewsTrends);
  
  // Filter expired trends
  const now = Date.now();
  const activeTrends = allTrends.filter(t => t.expiresAt.getTime() > now);
  
  // Sort by score (highest first)
  activeTrends.sort((a, b) => b.score - a.score);
  
  return activeTrends;
}

// ============================================================================
// Manual Trend Injection (for admin use)
// ============================================================================

/**
 * Manually inject a trend signal
 * Use this when you spot something hot before the monitors do
 */
export async function injectTrend(params: {
  topic: string;
  context: string;
  score?: number;
}): Promise<{ success: boolean; message: string }> {
  if (!state.enabled) {
    return { success: false, message: 'Trend monitor not enabled' };
  }
  
  const trend: TrendSignal = {
    source: 'manual',
    topic: params.topic,
    score: params.score ?? 85, // Manual trends get high confidence
    context: params.context,
    detectedAt: new Date(),
    expiresAt: new Date(Date.now() + CONFIG.TREND_EXPIRY_MINUTES * 60 * 1000),
  };
  
  state.activeTrends.push(trend);
  
  logger.info(`[TrendMonitor] 🔥 Manual trend injected: "${trend.topic}" (score: ${trend.score})`);
  
  // Notify admin
  await notifyAutonomous({
    event: 'trend_detected',
    details: `Manual trend: ${trend.topic}\nContext: ${trend.context}\nScore: ${trend.score}`,
  });
  
  // Check if we should trigger
  await evaluateAndTrigger();
  
  return { success: true, message: `Trend "${trend.topic}" injected with score ${trend.score}` };
}

// ============================================================================
// Time Helpers
// ============================================================================

/**
 * Parse time string (HH:MM) to minutes since midnight
 */
function parseTimeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + (minutes || 0);
}

/**
 * Check if current time is within a time window
 */
function isWithinTimeWindow(startTime: string, endTime: string): boolean {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Wraps around midnight
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Check if we're in quiet hours
 */
function isQuietHours(): boolean {
  const config = getConfig();
  return isWithinTimeWindow(config.QUIET_START, config.QUIET_END);
}

/**
 * Check if we're in busy hours (when reactive launches ARE allowed)
 */
function isBusyHours(): boolean {
  const config = getConfig();
  return isWithinTimeWindow(config.BUSY_START, config.BUSY_END);
}

/**
 * Check if we're within buffer zone around scheduled launch
 */
function isNearScheduledLaunch(): boolean {
  const config = getConfig();
  const [schedHours, schedMinutes] = config.SCHEDULED_LAUNCH_TIME.split(':').map(Number);
  const scheduledMinutes = schedHours * 60 + (schedMinutes || 0);
  
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  
  const bufferMinutes = config.SCHEDULED_BUFFER_HOURS * 60;
  const diff = Math.abs(currentMinutes - scheduledMinutes);
  
  // Account for wrapping around midnight
  const wrappedDiff = Math.min(diff, 24 * 60 - diff);
  
  return wrappedDiff < bufferMinutes;
}

/**
 * Check if cooldown between reactive launches has passed
 */
function isCooldownPassed(): boolean {
  if (!state.lastReactiveLaunchTime) return true;
  
  const config = getConfig();
  const cooldownMs = config.REACTIVE_COOLDOWN_HOURS * 60 * 60 * 1000;
  const elapsed = Date.now() - state.lastReactiveLaunchTime.getTime();
  
  return elapsed >= cooldownMs;
}

/**
 * Get current poll interval based on time of day
 */
function getCurrentPollInterval(): number {
  const config = getConfig();
  if (isQuietHours()) {
    return config.CHECK_INTERVAL_QUIET_MS;
  }
  return config.CHECK_INTERVAL_MS;
}

// ============================================================================
// Trigger Logic
// ============================================================================

/**
 * Check daily reset
 */
function checkDayReset(): void {
  const today = new Date().toISOString().split('T')[0];
  if (state.lastTriggerDate !== today) {
    state.triggeredToday = 0;
    state.lastTriggerDate = today;
    state.lastReactiveLaunchTime = null; // Reset cooldown on new day
  }
}

/**
 * Evaluate trends and trigger launch if conditions are met
 * 
 * SMART SELECTION:
 * 1. Trend must have been seen MIN_PERSISTENCE_TO_TRIGGER times (default: 2)
 * 2. Score must be >= MIN_SCORE_TO_TRIGGER (default: 70)
 * 3. Source diversity: rotate between sources, don't always pick DexScreener
 * 4. Within same source: pick by score > boostCount > oldest detection
 */
async function evaluateAndTrigger(): Promise<void> {
  checkDayReset();
  
  const config = getConfig();
  
  // Check quiet hours - NO reactive launches during this window
  if (isQuietHours()) {
    logger.debug(`[TrendMonitor] Quiet hours active (${config.QUIET_START}-${config.QUIET_END} UTC), skipping reactive`);
    return;
  }
  
  // Check busy hours - reactive launches ONLY during this window
  if (!isBusyHours()) {
    logger.debug(`[TrendMonitor] Outside busy hours (${config.BUSY_START}-${config.BUSY_END} UTC), skipping reactive`);
    return;
  }
  
  // Check daily limit
  if (state.triggeredToday >= config.MAX_REACTIVE_PER_DAY) {
    logger.debug('[TrendMonitor] Daily reactive limit reached');
    return;
  }
  
  // Check cooldown between launches (spread them out)
  if (!isCooldownPassed()) {
    const elapsed = state.lastReactiveLaunchTime 
      ? Math.round((Date.now() - state.lastReactiveLaunchTime.getTime()) / (60 * 1000))
      : 0;
    logger.debug(`[TrendMonitor] Cooldown active (${elapsed}/${config.REACTIVE_COOLDOWN_HOURS * 60} min)`);
    return;
  }
  
  // Check if we're near the scheduled launch time
  if (isNearScheduledLaunch()) {
    logger.debug(`[TrendMonitor] Near scheduled launch time, skipping reactive`);
    return;
  }
  
  // Filter trends that meet criteria:
  // 1. Score above threshold
  // 2. Seen enough times (persistence)
  const qualifyingTrends = state.activeTrends.filter(t => {
    if (t.score < config.MIN_SCORE_TO_TRIGGER) return false;
    
    const trendId = t.id || t.topic;
    const seenCount = state.trendPersistence.get(trendId) || 0;
    
    if (seenCount < config.MIN_PERSISTENCE_TO_TRIGGER) {
      logger.debug(`[TrendMonitor] "${t.topic.slice(0, 30)}..." seen ${seenCount}/${config.MIN_PERSISTENCE_TO_TRIGGER} times - waiting`);
      return false;
    }
    
    return true;
  });
  
  if (qualifyingTrends.length === 0) {
    return; // No trends ready to trigger yet
  }
  
  // Source diversity: group by source, pick best from preferred source
  // Priority: news (rare/valuable) > manual > dexscreener (common)
  const bySource: Record<string, TrendSignal[]> = {};
  for (const t of qualifyingTrends) {
    const src = t.source;
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(t);
  }
  
  // Source priority: news is rarer so give it preference, coingecko is reliable free source
  const sourcePriority = ['news', 'cryptonews', 'manual', 'coingecko', 'dexscreener', 'pump_fun', 'twitter'];
  let bestTrend: TrendSignal | null = null;
  
  for (const source of sourcePriority) {
    const trends = bySource[source];
    if (trends && trends.length > 0) {
      // Sort within source: score > boostCount > oldest
      trends.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((b.boostCount || 0) !== (a.boostCount || 0)) {
          return (b.boostCount || 0) - (a.boostCount || 0);
        }
        return a.detectedAt.getTime() - b.detectedAt.getTime();
      });
      bestTrend = trends[0];
      break;
    }
  }
  
  // Fallback: just take first qualifying if no source matched
  if (!bestTrend) {
    bestTrend = qualifyingTrends[0];
  }
  
  const trendId = bestTrend.id || bestTrend.topic;
  
  // Log selection reasoning
  const sourceBreakdown = Object.entries(bySource)
    .map(([src, arr]) => `${src}: ${arr.length}`)
    .join(', ');
  logger.info(`[TrendMonitor] ${qualifyingTrends.length} trends qualified (${sourceBreakdown})`);
  logger.info(`[TrendMonitor] Selected: "${bestTrend.topic.slice(0, 40)}..." (${bestTrend.source}, score: ${bestTrend.score})`);
  
  // Mark as seen so we don't re-trigger
  state.seenTopics.add(trendId);
  state.seenTopics.add(bestTrend.topic);
  
  // Remove this trend and clean up persistence
  state.activeTrends = state.activeTrends.filter(t => t !== bestTrend);
  state.trendPersistence.delete(trendId);
  state.triggeredToday++;
  state.lastReactiveLaunchTime = new Date(); // Start cooldown
  
  logger.info(`[TrendMonitor] 🚀 Triggering reactive launch for: "${bestTrend.topic}"`);
  
  // Notify admin
  await notifyAutonomous({
    event: 'trend_triggered',
    details: `Triggering reactive launch!\nTrend: ${bestTrend.topic}\nSource: ${bestTrend.source}\nScore: ${bestTrend.score}\nSeen: ${state.trendPersistence.get(trendId) || config.MIN_PERSISTENCE_TO_TRIGGER} times\nContext: ${bestTrend.context}`,
  });
  
  // Call the registered callback
  if (onTrendCallback) {
    try {
      await onTrendCallback(bestTrend);
    } catch (err) {
      logger.error('[TrendMonitor] Trigger callback error:', err);
    }
  }
}

// ============================================================================
// Monitor Loop
// ============================================================================

async function monitorTick(): Promise<void> {
  if (!state.enabled) return;
  
  state.lastCheck = new Date();
  const config = getConfig();
  
  try {
    const trends = await detectTrends();
    
    // Track which trends we saw THIS tick (for persistence cleanup)
    const seenThisTick = new Set<string>();
    
    if (trends.length > 0) {
      logger.info(`[TrendMonitor] Detected ${trends.length} trends`);
      
      // ========================================
      // NEW: Add trends to persistent pool
      // ========================================
      for (const trend of trends) {
        const trendId = trend.id || trend.topic;
        seenThisTick.add(trendId);
        
        // Upsert into pool (handles merging, multi-source boost, etc)
        const pooledTrend = trendPool.upsertTrend({
          id: trendId,
          topic: trend.topic,
          source: trend.source,
          score: trend.score,
          context: trend.context,
          boostCount: trend.boostCount,
          tokenAddress: trend.source === 'dexscreener' ? trend.id : undefined,
        });
        
        // Update in-memory persistence count
        const previousCount = state.trendPersistence.get(trendId) || 0;
        const newCount = previousCount + 1;
        state.trendPersistence.set(trendId, newCount);
        trend.seenCount = newCount;
        
        if (newCount === 1) {
          logger.debug(`[TrendMonitor] New trend: "${trend.topic.slice(0, 40)}..." (score: ${trend.score})`);
        } else if (newCount === config.MIN_PERSISTENCE_TO_TRIGGER) {
          logger.info(`[TrendMonitor] 📊 Trend now eligible: "${trend.topic.slice(0, 40)}..." seen ${newCount} times`);
        }
      }
      
      // Prune old/low-score trends and persist to disk
      trendPool.prunePool();
      trendPool.persist();
      
      // Reset persistence for trends NOT seen this tick (they went away)
      // Note: Pool handles its own decay - in-memory persistence is for quick trigger logic
      for (const [id, count] of state.trendPersistence.entries()) {
        if (!seenThisTick.has(id)) {
          logger.debug(`[TrendMonitor] Trend "${id.slice(0, 30)}..." no longer trending (still in pool with decay)`);
          state.trendPersistence.delete(id);
        }
      }
      
      state.activeTrends = trends;
      
      // Clean up old notification records (allow re-notify after NOTIFIED_EXPIRY_MS)
      const now = Date.now();
      for (const [id, timestamp] of state.lastNotifiedTrends.entries()) {
        if (now - timestamp >= config.NOTIFIED_EXPIRY_MS) {
          state.lastNotifiedTrends.delete(id);
        }
      }
      
      // Notify admin about detected trends (with cooldown to avoid spam)
      const shouldNotify = 
        !state.lastNotifyTime || 
        Date.now() - state.lastNotifyTime.getTime() >= config.NOTIFY_COOLDOWN_MS;
      
      // Only notify about NEW trends we haven't notified about recently
      const newTrendIds = trends
        .map(t => t.id || t.topic)
        .filter(id => !state.lastNotifiedTrends.has(id));
      
      if (shouldNotify && newTrendIds.length > 0) {
        // Get pool stats for context
        const poolStats = trendPool.getPoolStats();
        
        const trendSummary = trends.slice(0, 5).map(t => {
          const trendId = t.id || t.topic;
          const seenCount = state.trendPersistence.get(trendId) || 1;
          const pooledTrend = trendPool.getTrendById(trendId);
          const sources = pooledTrend?.sources.join(', ') || t.source;
          const readyStatus = seenCount >= config.MIN_PERSISTENCE_TO_TRIGGER ? '✅' : `⏳`;
          
          // Build detailed trend line
          let details = `• ${readyStatus} ${seenCount}/${config.MIN_PERSISTENCE_TO_TRIGGER} <b>${t.topic.slice(0, 60)}${t.topic.length > 60 ? '...' : ''}</b>`;
          details += `\n   📊 Score: ${pooledTrend?.currentScore ?? t.score} | Sources: ${sources}`;
          if (t.boostCount) {
            details += ` | Boosts: ${t.boostCount}`;
          }
          if (t.id && t.source === 'dexscreener') {
            // Shorten token address for display
            const shortAddr = `${t.id.slice(0, 6)}...${t.id.slice(-4)}`;
            details += `\n   🔗 Token: ${shortAddr}`;
          }
          return details;
        }).join('\n\n');
        
        await notifyAutonomous({
          event: 'trend_detected',
          details: `Found ${trends.length} trend(s):\n\n${trendSummary}\n\n📦 Pool: ${poolStats.available} available, ${poolStats.totalInPool} total\n<i>✅ = ready to trigger, ⏳ = building confidence</i>`,
        });
        
        // Record trends for system reporter
        for (let i = 0; i < newTrendIds.length; i++) {
          recordTrendDetected();
        }
        
        state.lastNotifyTime = new Date();
        // Track what we've notified about (with timestamp)
        for (const id of newTrendIds) {
          state.lastNotifiedTrends.set(id, now);
        }
      }
      
      await evaluateAndTrigger();
    } else {
      // No trends found from APIs, but pool still has trends agent can browse
      const poolStats = trendPool.getPoolStats();
      if (poolStats.available > 0) {
        logger.debug(`[TrendMonitor] No new trends, but pool has ${poolStats.available} available trends`);
      }
      
      // Clear in-memory persistence (pool handles its own decay)
      if (state.trendPersistence.size > 0) {
        logger.debug('[TrendMonitor] No trends found, clearing in-memory persistence');
        state.trendPersistence.clear();
      }
      // Also clear old notification records when no trends
      state.lastNotifiedTrends.clear();
      
      // Still prune and persist the pool
      trendPool.prunePool();
      trendPool.persist();
    }
  } catch (err) {
    logger.error('[TrendMonitor] Monitor tick error:', err);
  }
}

/**
 * Schedule the next monitor tick using dynamic interval
 * Uses shorter intervals during busy hours and longer during quiet hours
 */
function scheduleNextTick(): void {
  if (!state.enabled) {
    return;
  }
  
  const intervalMs = getCurrentPollInterval();
  const intervalMin = Math.round(intervalMs / 60000);
  const isQuiet = isQuietHours();
  
  // Clear any existing interval/timeout
  if (monitorInterval) {
    clearInterval(monitorInterval);
    clearTimeout(monitorInterval);
    monitorInterval = null;
  }
  
  // Schedule next tick
  monitorInterval = setTimeout(() => {
    monitorTick();
    scheduleNextTick(); // Recursive - schedule next after this one
  }, intervalMs);
  
  // Log when interval changes (at boundary of quiet/busy hours)
  const nextQuiet = isQuietHours();
  if (nextQuiet !== isQuiet) {
    logger.info(`[TrendMonitor] ⏰ Poll interval now ${intervalMin}min (${isQuiet ? 'quiet' : 'busy'} hours)`);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the trend monitor
 * @param onTrend Callback when a trend triggers a launch opportunity
 */
export async function startTrendMonitor(
  onTrend: (trend: TrendSignal) => Promise<void>
): Promise<void> {
  const env = getEnv();
  
  // Check if reactive mode is enabled
  if (env.AUTONOMOUS_ENABLE !== 'true') {
    logger.info('[TrendMonitor] Not starting - AUTONOMOUS_ENABLE=false');
    return;
  }
  
  if (env.AUTONOMOUS_REACTIVE_ENABLE !== 'true') {
    logger.info('[TrendMonitor] Not starting - AUTONOMOUS_REACTIVE_ENABLE=false');
    return;
  }
  
  const config = getConfig();
  
  state.enabled = true;
  onTrendCallback = onTrend;
  
  // Log sources
  const sources: string[] = ['DexScreener (free)', 'CoinGecko (free)'];
  if (env.CRYPTOPANIC_API_KEY) {
    sources.push('CryptoPanic (news)');
  }
  if (env.CRYPTONEWS_API_KEY) {
    sources.push('CryptoNews (headlines)');
  }
  
  // Initialize the trend pool with config (async to support PostgreSQL)
  await trendPool.initPoolAsync({
    maxPoolSize: config.POOL_MAX_SIZE,
    decayPerHour: config.POOL_DECAY_PER_HOUR,
    minScoreToKeep: config.POOL_MIN_SCORE,
    staleAfterHours: config.POOL_STALE_HOURS,
  });
  
  const busyPollMin = Math.round(config.CHECK_INTERVAL_MS / 60000);
  const quietPollMin = Math.round(config.CHECK_INTERVAL_QUIET_MS / 60000);
  logger.info(`[TrendMonitor] ✅ Started (busy: ${busyPollMin}min, quiet: ${quietPollMin}min)`);
  logger.info(`[TrendMonitor] Sources: ${sources.join(', ')}`);
  logger.info(`[TrendMonitor] Config: min_score=${config.MIN_SCORE_TO_TRIGGER}, max_per_day=${config.MAX_REACTIVE_PER_DAY}, cooldown=${config.REACTIVE_COOLDOWN_HOURS}h, persistence=${config.MIN_PERSISTENCE_TO_TRIGGER} checks`);
  
  const poolStats = trendPool.getPoolStats();
  if (poolStats.totalInPool > 0) {
    logger.info(`[TrendMonitor] 📦 Loaded ${poolStats.available} available trends from pool (${poolStats.totalInPool} total)`);
  }
  
  // Start dynamic polling - schedules next tick based on time of day
  scheduleNextTick();
  
  // Initial check
  monitorTick();
}

/**
 * Stop the trend monitor
 */
export function stopTrendMonitor(): void {
  state.enabled = false;
  
  if (monitorInterval) {
    // Clear both interval and timeout (we switched to setTimeout for dynamic polling)
    clearInterval(monitorInterval);
    clearTimeout(monitorInterval);
    monitorInterval = null;
  }
  
  onTrendCallback = null;
  
  // Reset tracking state
  state.trendPersistence.clear();
  state.lastNotifiedTrends.clear();
  state.lastNotifyTime = null;
  
  // Persist pool to disk before stopping
  trendPool.persist();
  
  logger.info('[TrendMonitor] Stopped');
}

/**
 * Sync the triggered today count from an external source (e.g., PostgreSQL)
 * This ensures consistency after restarts
 */
export function syncTriggeredCount(count: number, lastLaunchTime?: Date): void {
  const today = new Date().toISOString().split('T')[0];
  state.triggeredToday = count;
  state.lastTriggerDate = today;
  if (lastLaunchTime) {
    state.lastReactiveLaunchTime = lastLaunchTime;
  }
  logger.info(`[TrendMonitor] Synced triggered count: ${count} reactive launches today`);
}

/**
 * Get current monitor status
 */
export function getTrendMonitorStatus(): {
  enabled: boolean;
  lastCheck: Date | null;
  activeTrends: number;
  triggeredToday: number;
  poolStats: ReturnType<typeof trendPool.getPoolStats>;
} {
  return {
    enabled: state.enabled,
    lastCheck: state.lastCheck,
    activeTrends: state.activeTrends.length,
    triggeredToday: state.triggeredToday,
    poolStats: trendPool.getPoolStats(),
  };
}

/**
 * Get active trends
 */
export function getActiveTrends(): TrendSignal[] {
  return [...state.activeTrends];
}

// ============================================================================
// Agent Selection API - Pick from the pool
// ============================================================================

/**
 * Get all available trends from the pool (for agent to browse)
 * Sorted by score descending
 */
export function getPooledTrends(minScore?: number): trendPool.PooledTrend[] {
  return trendPool.getAvailableTrends(minScore);
}

/**
 * Get the best trend from the pool using smart selection
 * @param preferredSources Optional array of preferred sources (e.g., ['news', 'coingecko'])
 */
export function getBestPooledTrend(preferredSources?: string[]): trendPool.PooledTrend | null {
  return trendPool.getBestTrend(preferredSources);
}

/**
 * Agent selects a trend from the pool for launch
 * Returns the trend data and marks it as triggered
 */
export async function selectTrendFromPool(trendId: string): Promise<trendPool.PooledTrend | null> {
  const trend = trendPool.selectTrendForLaunch(trendId);
  
  if (trend) {
    // Also mark as seen in local state
    state.seenTopics.add(trendId);
    state.triggeredToday++;
    state.lastReactiveLaunchTime = new Date(); // Start cooldown
    
    logger.info(`[TrendMonitor] 🎯 Agent selected trend: "${trend.topic.slice(0, 40)}..."`);
    
    // Notify admin about agent selection
    const poolStats = trendPool.getPoolStats();
    await notifyAutonomous({
      event: 'trend_triggered',
      details: `🎯 Agent selected trend from pool!\n\nTrend: <b>${trend.topic}</b>\nSources: ${trend.sources.join(', ')}\nScore: ${trend.currentScore}\nSeen: ${trend.seenCount} times\nContext: ${trend.context}\n\n📦 Pool: ${poolStats.available} remaining`,
    });
  }
  
  return trend;
}

/**
 * Agent dismisses a trend (not interested)
 */
export async function dismissPooledTrend(trendId: string, reason?: string): Promise<boolean> {
  const trend = trendPool.getTrendById(trendId);
  const success = trendPool.dismissTrend(trendId, reason);
  
  if (success && trend) {
    // Notify admin about dismissal (less urgent, so only log for now)
    logger.info(`[TrendMonitor] ❌ Agent dismissed trend: "${trend.topic.slice(0, 40)}..." ${reason ? `(${reason})` : ''}`);
  }
  
  return success;
}

/**
 * Get trends grouped by source
 */
export function getPooledTrendsBySource(): Record<string, trendPool.PooledTrend[]> {
  return trendPool.getTrendsBySource();
}

export default {
  startTrendMonitor,
  stopTrendMonitor,
  getTrendMonitorStatus,
  getActiveTrends,
  injectTrend,
  // Pool API
  getPooledTrends,
  getBestPooledTrend,
  selectTrendFromPool,
  dismissPooledTrend,
  getPooledTrendsBySource,
};
