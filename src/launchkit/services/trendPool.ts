import { logger } from '@elizaos/core';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { PostgresScheduleRepository, type TrendPoolData } from '../db/postgresScheduleRepository.ts';

// PostgreSQL support
let pgRepo: PostgresScheduleRepository | null = null;
let usePostgres = false;

/**
 * Trend Pool - Persistent Trend Storage
 * 
 * Stores detected trends in a persistent JSON file, allowing the agent
 * to "pick and choose" from a pool of trends rather than just reacting
 * to whatever is currently trending.
 * 
 * Features:
 * - Persistent storage survives restarts
 * - Score decay over time (stale trends lose value)
 * - Multi-source merging (same trend from multiple sources = higher confidence)
 * - Pool size limits with smart rotation
 * - Agent-facing API for selection/dismissal
 */

// ============================================================================
// Types
// ============================================================================

export interface PooledTrend {
  id: string;                   // Unique identifier
  topic: string;                // Display name/description
  sources: string[];            // Which sources detected this (dexscreener, coingecko, etc)
  baseScore: number;            // Original score (before decay)
  currentScore: number;         // Score after decay applied
  context: string;              // Why this is trending
  firstSeenAt: number;          // Timestamp when first detected
  lastSeenAt: number;           // Timestamp when last seen in API results
  seenCount: number;            // How many poll cycles this has appeared
  boostCount?: number;          // Raw boost count for reference
  tokenAddress?: string;        // If applicable (for DexScreener tokens)
  dismissed: boolean;           // Agent marked as not interested
  triggered: boolean;           // Already used for a launch
  metadata?: Record<string, unknown>;  // Additional source-specific data
}

export interface TrendPoolState {
  trends: PooledTrend[];
  lastUpdated: number;
  totalTrendsProcessed: number;
  totalTriggered: number;
}

export interface TrendPoolConfig {
  maxPoolSize: number;              // Max trends to keep in pool
  decayPerHour: number;             // Score points to subtract per hour not seen
  minScoreToKeep: number;           // Remove trends below this score
  staleAfterHours: number;          // Consider trend stale after this many hours
  mergeBoostPerSource: number;      // Score boost when seen from multiple sources
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: TrendPoolConfig = {
  maxPoolSize: 30,
  decayPerHour: 5,
  minScoreToKeep: 40,
  staleAfterHours: 6,
  mergeBoostPerSource: 10,
};

// ============================================================================
// Persistence
// ============================================================================

function getPoolPath(): string {
  // Use the data directory at project root
  return join(process.cwd(), 'data', 'trend_pool.json');
}

function loadPool(): TrendPoolState {
  // PostgreSQL loading is async, so this returns the cached file data
  // Actual PostgreSQL loading happens in initPoolAsync
  const poolPath = getPoolPath();
  
  try {
    if (existsSync(poolPath)) {
      const data = readFileSync(poolPath, 'utf-8');
      const parsed = JSON.parse(data) as TrendPoolState;
      logger.debug(`[TrendPool] Loaded ${parsed.trends.length} trends from disk`);
      return parsed;
    }
  } catch (err) {
    logger.warn('[TrendPool] Failed to load pool, starting fresh:', err);
  }
  
  return {
    trends: [],
    lastUpdated: Date.now(),
    totalTrendsProcessed: 0,
    totalTriggered: 0,
  };
}

async function loadPoolFromPostgres(): Promise<TrendPoolState | null> {
  if (!pgRepo) return null;
  try {
    const data = await pgRepo.getTrendPool();
    if (data) {
      logger.info(`[TrendPool] Loaded ${data.trends.length} trends from PostgreSQL`);
      return data as TrendPoolState;
    }
  } catch (err) {
    logger.warn('[TrendPool] Failed to load from PostgreSQL:', err);
  }
  return null;
}

function savePool(state: TrendPoolState): void {
  state.lastUpdated = Date.now();
  
  // If PostgreSQL is available, also save async
  if (usePostgres && pgRepo) {
    pgRepo.saveTrendPool(state as TrendPoolData).catch(err => {
      logger.warn('[TrendPool] Failed to save to PostgreSQL:', err);
    });
  }
  
  // Always save to file as backup
  const poolPath = getPoolPath();
  
  try {
    // Ensure directory exists
    const dir = dirname(poolPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(poolPath, JSON.stringify(state, null, 2), 'utf-8');
    logger.debug(`[TrendPool] Saved ${state.trends.length} trends to disk`);
  } catch (err) {
    logger.error('[TrendPool] Failed to save pool:', err);
  }
}

// ============================================================================
// Pool State (in-memory, synced with disk)
// ============================================================================

let poolState: TrendPoolState = loadPool();
let config: TrendPoolConfig = { ...DEFAULT_CONFIG };

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Apply score decay to all trends based on time since last seen
 */
export function applyDecay(): void {
  const now = Date.now();
  
  for (const trend of poolState.trends) {
    const hoursSinceLastSeen = (now - trend.lastSeenAt) / (1000 * 60 * 60);
    const decay = Math.floor(hoursSinceLastSeen * config.decayPerHour);
    
    trend.currentScore = Math.max(0, trend.baseScore - decay);
  }
}

/**
 * Add or update a trend in the pool
 * If the trend already exists, merge the data and boost score
 */
export function upsertTrend(params: {
  id: string;
  topic: string;
  source: string;
  score: number;
  context: string;
  boostCount?: number;
  tokenAddress?: string;
  metadata?: Record<string, unknown>;
}): PooledTrend {
  const now = Date.now();
  
  // Check for existing trend by ID or similar topic
  let existing = poolState.trends.find(t => 
    t.id === params.id || 
    (t.topic.toLowerCase() === params.topic.toLowerCase())
  );
  
  if (existing) {
    // Update existing trend
    existing.lastSeenAt = now;
    existing.seenCount++;
    
    // Add source if new
    if (!existing.sources.includes(params.source)) {
      existing.sources.push(params.source);
      // Boost score for multi-source confirmation
      existing.baseScore = Math.min(100, existing.baseScore + config.mergeBoostPerSource);
      logger.info(`[TrendPool] Multi-source confirmation: "${params.topic.slice(0, 40)}..." now from ${existing.sources.length} sources (+${config.mergeBoostPerSource} score)`);
    }
    
    // Update score if higher
    if (params.score > existing.baseScore) {
      existing.baseScore = params.score;
    }
    
    // Update boost count if provided and higher
    if (params.boostCount && (!existing.boostCount || params.boostCount > existing.boostCount)) {
      existing.boostCount = params.boostCount;
    }
    
    // Merge metadata
    if (params.metadata) {
      existing.metadata = { ...existing.metadata, ...params.metadata };
    }
    
    existing.currentScore = existing.baseScore;
    
    return existing;
  }
  
  // Create new trend
  const newTrend: PooledTrend = {
    id: params.id,
    topic: params.topic,
    sources: [params.source],
    baseScore: params.score,
    currentScore: params.score,
    context: params.context,
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1,
    boostCount: params.boostCount,
    tokenAddress: params.tokenAddress,
    dismissed: false,
    triggered: false,
    metadata: params.metadata,
  };
  
  poolState.trends.push(newTrend);
  poolState.totalTrendsProcessed++;
  
  logger.debug(`[TrendPool] New trend: "${params.topic.slice(0, 40)}..." (score: ${params.score}, source: ${params.source})`);
  
  return newTrend;
}

/**
 * Clean up the pool - remove stale/low-score trends, enforce size limits
 */
export function prunePool(): number {
  const now = Date.now();
  const initialCount = poolState.trends.length;
  
  // Apply decay first
  applyDecay();
  
  // Remove trends that are:
  // 1. Below minimum score (after decay)
  // 2. Already triggered
  // 3. Dismissed by agent
  // 4. Too stale (not seen for too long)
  poolState.trends = poolState.trends.filter(trend => {
    if (trend.triggered) return false;
    if (trend.dismissed) return false;
    if (trend.currentScore < config.minScoreToKeep) return false;
    
    const hoursSinceLastSeen = (now - trend.lastSeenAt) / (1000 * 60 * 60);
    if (hoursSinceLastSeen > config.staleAfterHours) return false;
    
    return true;
  });
  
  // If still over limit, remove lowest scoring
  if (poolState.trends.length > config.maxPoolSize) {
    poolState.trends.sort((a, b) => b.currentScore - a.currentScore);
    poolState.trends = poolState.trends.slice(0, config.maxPoolSize);
  }
  
  const removed = initialCount - poolState.trends.length;
  if (removed > 0) {
    logger.debug(`[TrendPool] Pruned ${removed} trends (${poolState.trends.length} remaining)`);
  }
  
  return removed;
}

/**
 * Persist current state to disk
 */
export function persist(): void {
  savePool(poolState);
}

// ============================================================================
// Agent-Facing API
// ============================================================================

/**
 * Get all available trends (not dismissed, not triggered, above min score)
 * Sorted by current score descending
 */
export function getAvailableTrends(minScore?: number): PooledTrend[] {
  applyDecay();
  
  const threshold = minScore ?? config.minScoreToKeep;
  
  return poolState.trends
    .filter(t => !t.dismissed && !t.triggered && t.currentScore >= threshold)
    .sort((a, b) => {
      // Primary: score
      if (b.currentScore !== a.currentScore) return b.currentScore - a.currentScore;
      // Secondary: number of sources (more confirmation = better)
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      // Tertiary: seen count
      return b.seenCount - a.seenCount;
    });
}

/**
 * Get a specific trend by ID
 */
export function getTrendById(id: string): PooledTrend | undefined {
  return poolState.trends.find(t => t.id === id);
}

/**
 * Select a trend for launch (marks as triggered)
 */
export function selectTrendForLaunch(id: string): PooledTrend | null {
  const trend = poolState.trends.find(t => t.id === id);
  
  if (!trend) {
    logger.warn(`[TrendPool] Trend not found: ${id}`);
    return null;
  }
  
  if (trend.triggered) {
    logger.warn(`[TrendPool] Trend already triggered: ${id}`);
    return null;
  }
  
  if (trend.dismissed) {
    logger.warn(`[TrendPool] Trend was dismissed: ${id}`);
    return null;
  }
  
  trend.triggered = true;
  poolState.totalTriggered++;
  
  logger.info(`[TrendPool] 🚀 Selected trend for launch: "${trend.topic.slice(0, 40)}..."`);
  
  persist();
  return trend;
}

/**
 * Dismiss a trend (agent not interested)
 */
export function dismissTrend(id: string, reason?: string): boolean {
  const trend = poolState.trends.find(t => t.id === id);
  
  if (!trend) {
    return false;
  }
  
  trend.dismissed = true;
  if (reason) {
    trend.metadata = { ...trend.metadata, dismissReason: reason };
  }
  
  logger.info(`[TrendPool] Dismissed trend: "${trend.topic.slice(0, 40)}..." ${reason ? `(${reason})` : ''}`);
  
  persist();
  return true;
}

/**
 * Get pool statistics
 */
export function getPoolStats(): {
  totalInPool: number;
  available: number;
  dismissed: number;
  triggered: number;
  topTrends: Array<{ topic: string; score: number; sources: string[] }>;
  totalProcessed: number;
  lastUpdated: number;
} {
  applyDecay();
  
  const available = poolState.trends.filter(t => !t.dismissed && !t.triggered);
  const dismissed = poolState.trends.filter(t => t.dismissed);
  const triggered = poolState.trends.filter(t => t.triggered);
  
  return {
    totalInPool: poolState.trends.length,
    available: available.length,
    dismissed: dismissed.length,
    triggered: triggered.length,
    topTrends: available
      .sort((a, b) => b.currentScore - a.currentScore)
      .slice(0, 5)
      .map(t => ({
        topic: t.topic.slice(0, 50),
        score: t.currentScore,
        sources: t.sources,
      })),
    totalProcessed: poolState.totalTrendsProcessed,
    lastUpdated: poolState.lastUpdated,
  };
}

/**
 * Get trends grouped by source
 */
export function getTrendsBySource(): Record<string, PooledTrend[]> {
  const bySource: Record<string, PooledTrend[]> = {};
  
  for (const trend of getAvailableTrends()) {
    for (const source of trend.sources) {
      if (!bySource[source]) bySource[source] = [];
      bySource[source].push(trend);
    }
  }
  
  return bySource;
}

/**
 * Get the best trend by smart selection criteria
 * Considers: score, source diversity, freshness, confirmation count
 */
export function getBestTrend(preferredSources?: string[]): PooledTrend | null {
  const available = getAvailableTrends();
  
  if (available.length === 0) return null;
  
  // If preferred sources specified, try those first
  if (preferredSources && preferredSources.length > 0) {
    for (const source of preferredSources) {
      const fromSource = available.find(t => t.sources.includes(source));
      if (fromSource) return fromSource;
    }
  }
  
  // Default: return highest scoring
  return available[0];
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Update pool configuration
 */
export function setPoolConfig(newConfig: Partial<TrendPoolConfig>): void {
  config = { ...config, ...newConfig };
  logger.info(`[TrendPool] Config updated: maxSize=${config.maxPoolSize}, decay=${config.decayPerHour}/hr, minScore=${config.minScoreToKeep}`);
}

/**
 * Get current configuration
 */
export function getPoolConfig(): TrendPoolConfig {
  return { ...config };
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the pool (load from disk, apply decay) - synchronous version
 */
export function initPool(customConfig?: Partial<TrendPoolConfig>): void {
  if (customConfig) {
    config = { ...config, ...customConfig };
  }
  
  poolState = loadPool();
  applyDecay();
  prunePool();
  
  logger.info(`[TrendPool] Initialized with ${poolState.trends.length} trends`);
}

/**
 * Initialize the pool with PostgreSQL support - async version
 */
export async function initPoolAsync(customConfig?: Partial<TrendPoolConfig>): Promise<void> {
  if (customConfig) {
    config = { ...config, ...customConfig };
  }
  
  // Try PostgreSQL first
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      usePostgres = true;
      logger.info('[TrendPool] PostgreSQL storage initialized');
      
      // Load from PostgreSQL
      const pgData = await loadPoolFromPostgres();
      if (pgData) {
        poolState = pgData;
      } else {
        // Fall back to file and migrate to PostgreSQL
        poolState = loadPool();
        if (poolState.trends.length > 0) {
          await pgRepo.saveTrendPool(poolState as TrendPoolData);
          logger.info(`[TrendPool] Migrated ${poolState.trends.length} trends to PostgreSQL`);
        }
      }
    } catch (err) {
      logger.warn('[TrendPool] PostgreSQL init failed, using file storage:', err);
      pgRepo = null;
      usePostgres = false;
      poolState = loadPool();
    }
  } else {
    poolState = loadPool();
  }
  
  applyDecay();
  prunePool();
  
  logger.info(`[TrendPool] Initialized with ${poolState.trends.length} trends (PostgreSQL: ${usePostgres})`);
}

/**
 * Reset the pool (clear all data)
 */
export function resetPool(): void {
  poolState = {
    trends: [],
    lastUpdated: Date.now(),
    totalTrendsProcessed: 0,
    totalTriggered: 0,
  };
  
  persist();
  logger.info('[TrendPool] Pool reset');
}

/**
 * Force reload from disk
 */
export function reloadPool(): void {
  poolState = loadPool();
  applyDecay();
  logger.info(`[TrendPool] Reloaded ${poolState.trends.length} trends from disk`);
}

export default {
  // Core
  upsertTrend,
  prunePool,
  persist,
  applyDecay,
  
  // Agent API
  getAvailableTrends,
  getTrendById,
  selectTrendForLaunch,
  dismissTrend,
  getBestTrend,
  getTrendsBySource,
  getPoolStats,
  
  // Config
  setPoolConfig,
  getPoolConfig,
  
  // Lifecycle
  initPool,
  initPoolAsync,
  resetPool,
  reloadPool,
};
