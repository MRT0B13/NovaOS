/**
 * Nova Engagement Tracker
 *
 * Logs every reply/post Nova makes and tracks response metrics.
 * Helps optimize which accounts to engage and which reply styles work best.
 *
 * Uses PostgreSQL for persistence (falls back to in-memory if DB unavailable).
 * Schema migration runs automatically on first use.
 */

import { logger } from '@elizaos/core';
import { Pool } from 'pg';

// ============================================================================
// Types
// ============================================================================

export interface EngagementEntry {
  platform: 'x' | 'telegram' | 'farcaster';
  targetHandle: string;
  postId: string;
  replyId?: string;
  replyContent: string;
  replyStyle: 'peer' | 'analyst' | 'collaborator' | 'general';
  tier: 1 | 2 | 3 | 0;
  timestamp: Date;
  // Metrics (updated async after posting)
  likes?: number;
  replies?: number;
  impressions?: number;
}

export interface EngagementSummary {
  totalReplies: number;
  repliesToday: number;
  avgLikes: number;
  topTargets: Array<{ handle: string; count: number; avgLikes: number }>;
  bestStyle: string;
}

// ============================================================================
// Schema Migration
// ============================================================================

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engagement_log (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(20) NOT NULL,
  target_handle VARCHAR(100),
  post_id VARCHAR(100),
  reply_id VARCHAR(100),
  reply_content TEXT,
  reply_style VARCHAR(20),
  tier INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_platform ON engagement_log(platform);
CREATE INDEX IF NOT EXISTS idx_engagement_target ON engagement_log(target_handle);
CREATE INDEX IF NOT EXISTS idx_engagement_created ON engagement_log(created_at);
`;

// ============================================================================
// Tracker Class
// ============================================================================

let _pool: Pool | null = null;
let _migrated = false;
const _inmemory: EngagementEntry[] = [];

/**
 * Initialize the engagement tracker with a database pool.
 * Should be called once at startup.
 */
export async function initEngagementTracker(pool: Pool): Promise<void> {
  _pool = pool;
  if (!_migrated) {
    try {
      await pool.query(CREATE_TABLE_SQL);
      _migrated = true;
      logger.info('[EngagementTracker] Schema migrated / verified');
    } catch (err) {
      logger.warn('[EngagementTracker] Schema migration failed (will use in-memory):', err);
    }
  }
}

/**
 * Log an engagement event (reply posted).
 */
export async function logEngagement(entry: EngagementEntry): Promise<void> {
  // Always keep in-memory copy
  _inmemory.push(entry);
  if (_inmemory.length > 1000) _inmemory.splice(0, _inmemory.length - 500);

  if (!_pool || !_migrated) return;

  try {
    await _pool.query(
      `INSERT INTO engagement_log
        (platform, target_handle, post_id, reply_id, reply_content, reply_style, tier, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.platform,
        entry.targetHandle,
        entry.postId,
        entry.replyId || null,
        entry.replyContent,
        entry.replyStyle,
        entry.tier,
        entry.timestamp,
      ],
    );
  } catch (err) {
    logger.debug('[EngagementTracker] Failed to log engagement to DB:', err);
  }
}

/**
 * Update engagement metrics for a previously logged reply.
 */
export async function updateEngagementMetrics(
  replyId: string,
  metrics: { likes?: number; replies?: number; impressions?: number },
): Promise<void> {
  if (!_pool || !_migrated) return;

  try {
    await _pool.query(
      `UPDATE engagement_log SET
        likes = COALESCE($2, likes),
        replies = COALESCE($3, replies),
        impressions = COALESCE($4, impressions),
        updated_at = NOW()
       WHERE reply_id = $1`,
      [replyId, metrics.likes ?? null, metrics.replies ?? null, metrics.impressions ?? null],
    );
  } catch (err) {
    logger.debug('[EngagementTracker] Failed to update metrics:', err);
  }
}

/**
 * Get engagement summary for the last N days.
 */
export async function getEngagementSummary(days: number = 7): Promise<EngagementSummary> {
  // Fallback to in-memory if no DB
  if (!_pool || !_migrated) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recent = _inmemory.filter(e => e.timestamp >= cutoff);
    const today = new Date().toDateString();
    return {
      totalReplies: recent.length,
      repliesToday: recent.filter(e => e.timestamp.toDateString() === today).length,
      avgLikes: 0,
      topTargets: [],
      bestStyle: 'general',
    };
  }

  try {
    const result = await _pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) as today,
        AVG(likes) as avg_likes
      FROM engagement_log
      WHERE created_at > NOW() - INTERVAL '${days} days'
    `);

    const topTargetsResult = await _pool.query(`
      SELECT target_handle, COUNT(*) as cnt, AVG(likes) as avg_likes
      FROM engagement_log
      WHERE created_at > NOW() - INTERVAL '${days} days'
        AND target_handle IS NOT NULL
      GROUP BY target_handle
      ORDER BY cnt DESC
      LIMIT 10
    `);

    const bestStyleResult = await _pool.query(`
      SELECT reply_style, AVG(likes) as avg_likes
      FROM engagement_log
      WHERE created_at > NOW() - INTERVAL '${days} days'
        AND likes > 0
      GROUP BY reply_style
      ORDER BY avg_likes DESC
      LIMIT 1
    `);

    const row = result.rows[0];
    return {
      totalReplies: parseInt(row.total) || 0,
      repliesToday: parseInt(row.today) || 0,
      avgLikes: parseFloat(row.avg_likes) || 0,
      topTargets: topTargetsResult.rows.map(r => ({
        handle: r.target_handle,
        count: parseInt(r.cnt),
        avgLikes: parseFloat(r.avg_likes) || 0,
      })),
      bestStyle: bestStyleResult.rows[0]?.reply_style || 'general',
    };
  } catch (err) {
    logger.debug('[EngagementTracker] Failed to get summary:', err);
    return { totalReplies: 0, repliesToday: 0, avgLikes: 0, topTargets: [], bestStyle: 'general' };
  }
}

/**
 * Get today's reply count (fast, for rate-limiting).
 */
export function getTodayReplyCount(): number {
  const today = new Date().toDateString();
  return _inmemory.filter(e => e.timestamp.toDateString() === today).length;
}
