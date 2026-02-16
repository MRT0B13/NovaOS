import { Pool, type PoolConfig } from 'pg';
import { logger } from '@elizaos/core';

/**
 * PostgreSQL Repository for Scheduled Posts and Related Data
 * 
 * Consolidates persistence for:
 * - Telegram scheduled posts
 * - X/Twitter scheduled tweets
 * - X marketing schedules
 * - X usage/rate limiting
 * - Trend pool
 * - Community voting
 * - System metrics
 * 
 * All tables prefixed with 'sched_' to avoid conflicts
 */

// ============================================================================
// Types (imported from respective services)
// ============================================================================

export interface ScheduledTGPost {
  id: string;
  tokenTicker: string;
  tokenMint: string;
  launchPackId: string;
  telegramChatId: string;
  type: string;
  text: string;
  imageUrl?: string;
  scheduledFor: string;
  status: 'pending' | 'posted' | 'failed' | 'cancelled';
  createdAt: string;
  postedAt?: string;
  messageId?: number;
  error?: string;
  tokenContext?: {
    name: string;
    ticker: string;
    mascot?: string;
  };
}

export interface ScheduledTweet {
  id: string;
  tokenTicker: string;
  tokenMint: string;
  launchPackId: string;
  type: string;
  text: string;
  scheduledFor: string;
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

export interface XUsageData {
  month: string;
  reads: number;
  writes: number;
  lastWrite: string | null;
  lastRead: string | null;
  writeHistory: { timestamp: string; text: string }[];
}

export interface PooledTrend {
  id: string;
  topic: string;
  sources: string[];
  baseScore: number;
  currentScore: number;
  context: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  boostCount?: number;
  tokenAddress?: string;
  dismissed: boolean;
  triggered: boolean;
  metadata?: Record<string, unknown>;
}

export interface TrendPoolData {
  trends: PooledTrend[];
  launchedTokens: string[];
  lastUpdated: number;
}

export interface CommunityFeedback {
  id: string;
  ideaId: string;
  userId: string;
  vote: 'approve' | 'reject' | 'neutral';
  comment?: string;
  timestamp: number;
}

export interface CommunityPreferences {
  approvedThemes: Record<string, number>;
  rejectedThemes: Record<string, number>;
  preferredStyles: string[];
  avoidStyles: string[];
  totalVotes: number;
  avgApprovalRate: number;
}

export interface PendingVote {
  id: string;
  idea: any;
  messageId: number;
  chatId: string;
  postedAt: string;
  votingEndsAt: string;
  agentReasoning: string;
  trendContext?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'no_votes';
  votes?: any;
}

export interface IdeaFeedback {
  id: string;
  idea: any;
  outcome: 'approved' | 'rejected' | 'no_votes' | 'override';
  votes: any;
  launchedAt?: string;
  feedback?: string;
  learnings?: string[];
}

export interface SystemMetrics {
  startTime: number;
  sessionStartTime: number;
  tweetsSentToday: number;
  tgPostsSentToday: number;
  trendsDetectedToday: number;
  errors24h: number;
  warnings24h: number;
  lastReportTime: number;
  lastDailyReportDate: string;
  totalMessagesReceived: number;
  // All-time cumulative counters (never reset)
  totalLaunches: number;
  totalTweetsSent: number;
  totalTgPostsSent: number;
  counterDate: string;
  lastUpdated: string;
}

// ============================================================================
// Repository Class
// ============================================================================

function buildPool(databaseUrl: string): Pool {
  const sslNeeded = databaseUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
  const config: PoolConfig = { connectionString: databaseUrl };
  if (sslNeeded) {
    config.ssl = { rejectUnauthorized: false } as any;
  }
  return new Pool(config);
}

export class PostgresScheduleRepository {
  private constructor(private pool: Pool) {}

  static async create(databaseUrl: string): Promise<PostgresScheduleRepository> {
    const pool = buildPool(databaseUrl);
    const repo = new PostgresScheduleRepository(pool);
    await repo.ensureSchema();
    return repo;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Public query proxy for ad-hoc SQL queries */
  async query(sql: string, params?: any[]): Promise<any> {
    return this.pool.query(sql, params);
  }

  // ==========================================================================
  // Schema Setup
  // ==========================================================================

  private async ensureSchema(): Promise<void> {
    // Telegram Scheduled Posts
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_tg_posts (
        id TEXT PRIMARY KEY,
        token_ticker TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        launch_pack_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        image_url TEXT,
        scheduled_for TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL,
        posted_at TIMESTAMPTZ,
        message_id BIGINT,
        error TEXT,
        token_context JSONB
      );
    `);

    // X Scheduled Tweets
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_x_tweets (
        id TEXT PRIMARY KEY,
        token_ticker TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        launch_pack_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        posted_at TIMESTAMPTZ,
        tweet_id TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);

    // X Marketing Schedules
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_x_marketing (
        launch_pack_id TEXT PRIMARY KEY,
        token_ticker TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        tweets_per_week INTEGER DEFAULT 3,
        last_tweet_at TIMESTAMPTZ,
        total_tweeted INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);

    // X Usage Tracking (one row per month)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_x_usage (
        month TEXT PRIMARY KEY,
        reads INTEGER DEFAULT 0,
        writes INTEGER DEFAULT 0,
        last_write TIMESTAMPTZ,
        last_read TIMESTAMPTZ,
        write_history JSONB DEFAULT '[]'::jsonb
      );
    `);
    // Migration: add daily_write_ts column (epoch-ms array for 24h rolling window)
    await this.pool.query(`
      ALTER TABLE sched_x_usage
      ADD COLUMN IF NOT EXISTS daily_write_ts JSONB DEFAULT '[]'::jsonb;
    `);

    // Trend Pool
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_trend_pool (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        sources JSONB NOT NULL DEFAULT '[]'::jsonb,
        base_score INTEGER NOT NULL,
        current_score INTEGER NOT NULL,
        context TEXT,
        first_seen_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        seen_count INTEGER DEFAULT 1,
        boost_count INTEGER,
        token_address TEXT,
        dismissed BOOLEAN DEFAULT FALSE,
        triggered BOOLEAN DEFAULT FALSE,
        metadata JSONB
      );
    `);

    // Community Voting State
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_community_prefs (
        id TEXT PRIMARY KEY DEFAULT 'main',
        approved_themes JSONB DEFAULT '{}'::jsonb,
        rejected_themes JSONB DEFAULT '{}'::jsonb,
        preferred_styles JSONB DEFAULT '[]'::jsonb,
        avoid_styles JSONB DEFAULT '[]'::jsonb,
        total_votes INTEGER DEFAULT 0,
        avg_approval_rate DOUBLE PRECISION DEFAULT 0.5
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_community_feedback (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vote TEXT NOT NULL,
        comment TEXT,
        timestamp BIGINT NOT NULL
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_pending_votes (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        expires_at BIGINT NOT NULL
      );
    `);

    // System Metrics (single row)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_system_metrics (
        id TEXT PRIMARY KEY DEFAULT 'main',
        start_time BIGINT NOT NULL,
        session_start_time BIGINT NOT NULL,
        tweets_sent_today INTEGER DEFAULT 0,
        tg_posts_sent_today INTEGER DEFAULT 0,
        trends_detected_today INTEGER DEFAULT 0,
        errors_24h INTEGER DEFAULT 0,
        warnings_24h INTEGER DEFAULT 0,
        last_report_time BIGINT DEFAULT 0,
        last_daily_report_date TEXT,
        total_messages_received INTEGER DEFAULT 0,
        -- All-time cumulative counters (never reset)
        total_launches INTEGER DEFAULT 0,
        total_tweets_sent INTEGER DEFAULT 0,
        total_tg_posts_sent INTEGER DEFAULT 0,
        counter_date TEXT,
        last_updated TIMESTAMPTZ DEFAULT NOW(),
        banned_users JSONB DEFAULT '[]'::jsonb,
        failed_attempts JSONB DEFAULT '[]'::jsonb
      );
    `);
    
    // Migration: Add all-time columns to existing tables
    await this.pool.query(`
      ALTER TABLE sched_system_metrics 
      ADD COLUMN IF NOT EXISTS total_launches INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_tweets_sent INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_tg_posts_sent INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS counter_date TEXT;
    `).catch(() => {/* columns may already exist */});

    // Autonomous Mode State (single row - persists launch counts across restarts)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_autonomous_state (
        id TEXT PRIMARY KEY DEFAULT 'main',
        launches_today INTEGER DEFAULT 0,
        reactive_launches_today INTEGER DEFAULT 0,
        last_launch_date TEXT,
        next_scheduled_time BIGINT,
        pending_idea JSONB,
        pending_vote_id TEXT,
        nova_start_date TEXT,
        nova_tease_count INTEGER DEFAULT 0,
        nova_milestones JSONB DEFAULT '[]',
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // Add nova_start_date column if missing (migration)
    await this.pool.query(`
      ALTER TABLE sched_autonomous_state
      ADD COLUMN IF NOT EXISTS nova_start_date TEXT;
    `).catch(() => {});
    await this.pool.query(`
      ALTER TABLE sched_autonomous_state
      ADD COLUMN IF NOT EXISTS nova_tease_count INTEGER DEFAULT 0;
    `).catch(() => {});
    await this.pool.query(`
      ALTER TABLE sched_autonomous_state
      ADD COLUMN IF NOT EXISTS nova_milestones JSONB DEFAULT '[]';
    `).catch(() => {});
    await this.pool.query(`
      ALTER TABLE sched_autonomous_state
      ADD COLUMN IF NOT EXISTS initial_balance NUMERIC DEFAULT NULL;
    `).catch(() => {});

    // Create indexes
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_tg_posts_status ON sched_tg_posts (status);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_tg_posts_scheduled ON sched_tg_posts (scheduled_for);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_x_tweets_status ON sched_x_tweets (status);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_x_tweets_scheduled ON sched_x_tweets (scheduled_for);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_trend_pool_score ON sched_trend_pool (current_score DESC);`);

    // RugCheck Reports
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_rugcheck_reports (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        ticker TEXT,
        score INTEGER NOT NULL,
        risk_level TEXT NOT NULL,
        mint_authority BOOLEAN DEFAULT FALSE,
        freeze_authority BOOLEAN DEFAULT FALSE,
        top_holder_pct DOUBLE PRECISION DEFAULT 0,
        top10_holder_pct DOUBLE PRECISION DEFAULT 0,
        lp_locked BOOLEAN DEFAULT FALSE,
        risks JSONB DEFAULT '[]'::jsonb,
        raw_data JSONB,
        scanned_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_rugcheck_mint ON sched_rugcheck_reports (mint);`);

    // Reply Engine Tracking
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_reply_tracking (
        id TEXT PRIMARY KEY,
        tweet_id TEXT NOT NULL,
        reply_id TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        source TEXT NOT NULL,
        author_id TEXT,
        original_text TEXT,
        replied_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_reply_tweet ON sched_reply_tracking (tweet_id);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_reply_date ON sched_reply_tracking (replied_at);`);

    // Creator Fees Tracking (PumpSwap)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_creator_fees (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        ticker TEXT,
        fee_amount_sol DOUBLE PRECISION NOT NULL,
        fee_amount_usd DOUBLE PRECISION,
        pool_address TEXT,
        tx_signature TEXT,
        claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_creator_fees_mint ON sched_creator_fees (mint);`);

    // Fee Claims (actual on-chain claim transactions)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_fee_claims (
        id TEXT PRIMARY KEY,
        mint_address TEXT NOT NULL,
        amount_sol DOUBLE PRECISION NOT NULL,
        tx_signature TEXT NOT NULL,
        destination_wallet TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_fee_claims_mint ON sched_fee_claims (mint_address);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_fee_claims_date ON sched_fee_claims (claimed_at);`);

    // Initialize default rows if needed
    await this.pool.query(`
      INSERT INTO sched_community_prefs (id) VALUES ('main')
      ON CONFLICT (id) DO NOTHING;
    `);

    const now = Date.now();
    await this.pool.query(`
      INSERT INTO sched_system_metrics (id, start_time, session_start_time)
      VALUES ('main', $1, $1)
      ON CONFLICT (id) DO NOTHING;
    `, [now]);

    await this.pool.query(`
      INSERT INTO sched_autonomous_state (id) VALUES ('main')
      ON CONFLICT (id) DO NOTHING;
    `);

    // General-purpose key-value store for persisting in-memory state across restarts
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sched_kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Web research knowledge store (Tavily search results → GPT-extracted facts)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS nova_knowledge (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        topic TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        facts JSONB DEFAULT '[]',
        sources JSONB DEFAULT '[]',
        search_query TEXT,
        confidence REAL DEFAULT 0.5,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_count INTEGER DEFAULT 0
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_category ON nova_knowledge (category);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_expires ON nova_knowledge (expires_at);`);

    logger.info('[ScheduleRepository] PostgreSQL schema ensured');
  }

  // ==========================================================================
  // Telegram Scheduled Posts
  // ==========================================================================

  async insertTGPost(post: ScheduledTGPost): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_tg_posts 
        (id, token_ticker, token_mint, launch_pack_id, telegram_chat_id, type, text, 
         image_url, scheduled_for, status, created_at, posted_at, message_id, error, token_context)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        posted_at = EXCLUDED.posted_at,
        message_id = EXCLUDED.message_id,
        error = EXCLUDED.error
    `, [
      post.id, post.tokenTicker, post.tokenMint, post.launchPackId,
      post.telegramChatId, post.type, post.text, post.imageUrl || null,
      post.scheduledFor, post.status, post.createdAt, post.postedAt || null,
      post.messageId || null, post.error || null, 
      post.tokenContext ? JSON.stringify(post.tokenContext) : null
    ]);
  }

  async getTGPosts(status?: string): Promise<ScheduledTGPost[]> {
    const query = status 
      ? `SELECT * FROM sched_tg_posts WHERE status = $1 ORDER BY scheduled_for`
      : `SELECT * FROM sched_tg_posts ORDER BY scheduled_for`;
    const params = status ? [status] : [];
    const result = await this.pool.query(query, params);
    return result.rows.map(this.rowToTGPost);
  }

  async getPendingTGPosts(): Promise<ScheduledTGPost[]> {
    return this.getTGPosts('pending');
  }

  async updateTGPostStatus(id: string, status: string, extras?: { postedAt?: string; messageId?: number; error?: string }): Promise<void> {
    const sets = ['status = $2'];
    const values: any[] = [id, status];
    let paramIndex = 3;

    if (extras?.postedAt) {
      sets.push(`posted_at = $${paramIndex++}`);
      values.push(extras.postedAt);
    }
    if (extras?.messageId) {
      sets.push(`message_id = $${paramIndex++}`);
      values.push(extras.messageId);
    }
    if (extras?.error) {
      sets.push(`error = $${paramIndex++}`);
      values.push(extras.error);
    }

    await this.pool.query(`UPDATE sched_tg_posts SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  async deleteTGPost(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sched_tg_posts WHERE id = $1`, [id]);
  }

  private rowToTGPost(row: any): ScheduledTGPost {
    return {
      id: row.id,
      tokenTicker: row.token_ticker,
      tokenMint: row.token_mint,
      launchPackId: row.launch_pack_id,
      telegramChatId: row.telegram_chat_id,
      type: row.type,
      text: row.text,
      imageUrl: row.image_url || undefined,
      scheduledFor: row.scheduled_for instanceof Date ? row.scheduled_for.toISOString() : row.scheduled_for,
      status: row.status,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      postedAt: row.posted_at ? (row.posted_at instanceof Date ? row.posted_at.toISOString() : row.posted_at) : undefined,
      messageId: row.message_id ? Number(row.message_id) : undefined,
      error: row.error || undefined,
      tokenContext: row.token_context || undefined,
    };
  }

  // ==========================================================================
  // X Scheduled Tweets
  // ==========================================================================

  async insertTweet(tweet: ScheduledTweet): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_x_tweets 
        (id, token_ticker, token_mint, launch_pack_id, type, text, scheduled_for, 
         status, posted_at, tweet_id, error, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        posted_at = EXCLUDED.posted_at,
        tweet_id = EXCLUDED.tweet_id,
        error = EXCLUDED.error
    `, [
      tweet.id, tweet.tokenTicker, tweet.tokenMint, tweet.launchPackId,
      tweet.type, tweet.text, tweet.scheduledFor, tweet.status,
      tweet.postedAt || null, tweet.tweetId || null, tweet.error || null, tweet.createdAt
    ]);
  }

  async getTweets(status?: string): Promise<ScheduledTweet[]> {
    const query = status 
      ? `SELECT * FROM sched_x_tweets WHERE status = $1 ORDER BY scheduled_for`
      : `SELECT * FROM sched_x_tweets ORDER BY scheduled_for`;
    const params = status ? [status] : [];
    const result = await this.pool.query(query, params);
    return result.rows.map(this.rowToTweet);
  }

  async getPendingTweets(): Promise<ScheduledTweet[]> {
    return this.getTweets('pending');
  }

  async updateTweetStatus(id: string, status: string, extras?: { postedAt?: string; tweetId?: string; error?: string }): Promise<void> {
    const sets = ['status = $2'];
    const values: any[] = [id, status];
    let paramIndex = 3;

    if (extras?.postedAt) {
      sets.push(`posted_at = $${paramIndex++}`);
      values.push(extras.postedAt);
    }
    if (extras?.tweetId) {
      sets.push(`tweet_id = $${paramIndex++}`);
      values.push(extras.tweetId);
    }
    if (extras?.error) {
      sets.push(`error = $${paramIndex++}`);
      values.push(extras.error);
    }

    await this.pool.query(`UPDATE sched_x_tweets SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  async deleteTweet(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sched_x_tweets WHERE id = $1`, [id]);
  }

  private rowToTweet(row: any): ScheduledTweet {
    return {
      id: row.id,
      tokenTicker: row.token_ticker,
      tokenMint: row.token_mint,
      launchPackId: row.launch_pack_id,
      type: row.type,
      text: row.text,
      scheduledFor: row.scheduled_for instanceof Date ? row.scheduled_for.toISOString() : row.scheduled_for,
      status: row.status,
      postedAt: row.posted_at ? (row.posted_at instanceof Date ? row.posted_at.toISOString() : row.posted_at) : undefined,
      tweetId: row.tweet_id || undefined,
      error: row.error || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  // Alias methods for xScheduler compatibility
  async getXTweetsByStatus(status: string): Promise<ScheduledTweet[]> {
    return this.getTweets(status);
  }

  async insertXTweet(tweet: ScheduledTweet): Promise<void> {
    return this.insertTweet(tweet);
  }

  async updateXTweetStatus(id: string, status: string, tweetId?: string, error?: string): Promise<void> {
    return this.updateTweetStatus(id, status, { tweetId, error });
  }

  // ==========================================================================
  // X Marketing Schedules
  // ==========================================================================

  async upsertMarketingSchedule(schedule: MarketingSchedule): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_x_marketing 
        (launch_pack_id, token_ticker, enabled, tweets_per_week, last_tweet_at, total_tweeted, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (launch_pack_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        tweets_per_week = EXCLUDED.tweets_per_week,
        last_tweet_at = EXCLUDED.last_tweet_at,
        total_tweeted = EXCLUDED.total_tweeted
    `, [
      schedule.launchPackId, schedule.tokenTicker, schedule.enabled,
      schedule.tweetsPerWeek, schedule.lastTweetAt || null,
      schedule.totalTweeted, schedule.createdAt
    ]);
  }

  async getMarketingSchedule(launchPackId: string): Promise<MarketingSchedule | null> {
    const result = await this.pool.query(
      `SELECT * FROM sched_x_marketing WHERE launch_pack_id = $1`,
      [launchPackId]
    );
    if (!result.rows[0]) return null;
    return this.rowToMarketingSchedule(result.rows[0]);
  }

  async getAllMarketingSchedules(): Promise<MarketingSchedule[]> {
    const result = await this.pool.query(`SELECT * FROM sched_x_marketing WHERE enabled = TRUE`);
    return result.rows.map(this.rowToMarketingSchedule);
  }

  // Alias methods for xScheduler compatibility
  async getXMarketingSchedules(): Promise<MarketingSchedule[]> {
    return this.getAllMarketingSchedules();
  }

  async upsertXMarketingSchedule(schedule: MarketingSchedule): Promise<void> {
    return this.upsertMarketingSchedule(schedule);
  }

  private rowToMarketingSchedule(row: any): MarketingSchedule {
    return {
      launchPackId: row.launch_pack_id,
      tokenTicker: row.token_ticker,
      enabled: row.enabled,
      tweetsPerWeek: row.tweets_per_week,
      lastTweetAt: row.last_tweet_at ? (row.last_tweet_at instanceof Date ? row.last_tweet_at.toISOString() : row.last_tweet_at) : undefined,
      totalTweeted: row.total_tweeted,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  // ==========================================================================
  // X Usage Tracking
  // ==========================================================================

  async getXUsage(month: string): Promise<XUsageData> {
    const result = await this.pool.query(`SELECT * FROM sched_x_usage WHERE month = $1`, [month]);
    if (!result.rows[0]) {
      return {
        month,
        reads: 0,
        writes: 0,
        lastWrite: null,
        lastRead: null,
        writeHistory: [],
      };
    }
    const row = result.rows[0];
    return {
      month: row.month,
      reads: row.reads,
      writes: row.writes,
      lastWrite: row.last_write ? (row.last_write instanceof Date ? row.last_write.toISOString() : row.last_write) : null,
      lastRead: row.last_read ? (row.last_read instanceof Date ? row.last_read.toISOString() : row.last_read) : null,
      writeHistory: row.write_history || [],
    };
  }

  async incrementXWrites(month: string, tweetText?: string): Promise<void> {
    const now = new Date().toISOString();
    const historyEntry = tweetText ? { timestamp: now, text: tweetText.slice(0, 100) } : null;

    await this.pool.query(`
      INSERT INTO sched_x_usage (month, writes, last_write, write_history)
      VALUES ($1, 1, $2, CASE WHEN $3::jsonb IS NOT NULL THEN jsonb_build_array($3::jsonb) ELSE '[]'::jsonb END)
      ON CONFLICT (month) DO UPDATE SET
        writes = sched_x_usage.writes + 1,
        last_write = $2,
        write_history = CASE 
          WHEN $3::jsonb IS NOT NULL THEN (
            SELECT jsonb_agg(elem) FROM (
              SELECT elem FROM jsonb_array_elements(sched_x_usage.write_history) elem
              UNION ALL
              SELECT $3::jsonb
              ORDER BY elem->>'timestamp' DESC
              LIMIT 50
            ) sub
          )
          ELSE sched_x_usage.write_history
        END
    `, [month, now, historyEntry ? JSON.stringify(historyEntry) : null]);
  }

  async incrementXReads(month: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`
      INSERT INTO sched_x_usage (month, reads, last_read)
      VALUES ($1, 1, $2)
      ON CONFLICT (month) DO UPDATE SET
        reads = sched_x_usage.reads + 1,
        last_read = $2
    `, [month, now]);
  }

  /**
   * Get the 24h rolling-window tweet timestamps (epoch ms) from Postgres.
   * Returns only timestamps within the last 24 hours.
   */
  async getDailyWriteTimestamps(): Promise<number[]> {
    const month = new Date().toISOString().slice(0, 7);
    const result = await this.pool.query(
      `SELECT daily_write_ts FROM sched_x_usage WHERE month = $1`, [month]
    );
    const raw: number[] = result.rows[0]?.daily_write_ts || [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return raw.filter(ts => ts > cutoff);
  }

  /**
   * Save the 24h rolling-window tweet timestamps to Postgres.
   * Prunes entries older than 24h before saving.
   */
  async saveDailyWriteTimestamps(timestamps: number[]): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const pruned = timestamps.filter(ts => ts > cutoff);
    await this.pool.query(`
      INSERT INTO sched_x_usage (month, daily_write_ts)
      VALUES ($1, $2)
      ON CONFLICT (month) DO UPDATE SET
        daily_write_ts = $2
    `, [month, JSON.stringify(pruned)]);
  }

  /**
   * Save full X usage data (upsert) - used by xRateLimiter
   */
  async saveXUsage(data: XUsageData): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_x_usage (month, reads, writes, last_read, last_write, write_history)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (month) DO UPDATE SET
        reads = $2,
        writes = $3,
        last_read = $4,
        last_write = $5,
        write_history = $6
    `, [
      data.month,
      data.reads || 0,
      data.writes || 0,
      data.lastRead,
      data.lastWrite,
      JSON.stringify(data.writeHistory || [])
    ]);
  }

  // ==========================================================================
  // Trend Pool
  // ==========================================================================

  async upsertTrend(trend: PooledTrend): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_trend_pool 
        (id, topic, sources, base_score, current_score, context, first_seen_at, 
         last_seen_at, seen_count, boost_count, token_address, dismissed, triggered, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        sources = EXCLUDED.sources,
        current_score = EXCLUDED.current_score,
        last_seen_at = EXCLUDED.last_seen_at,
        seen_count = EXCLUDED.seen_count,
        dismissed = EXCLUDED.dismissed,
        triggered = EXCLUDED.triggered,
        metadata = EXCLUDED.metadata
    `, [
      trend.id, trend.topic, JSON.stringify(trend.sources), trend.baseScore,
      trend.currentScore, trend.context, trend.firstSeenAt, trend.lastSeenAt,
      trend.seenCount, trend.boostCount || null, trend.tokenAddress || null,
      trend.dismissed, trend.triggered, trend.metadata ? JSON.stringify(trend.metadata) : null
    ]);
  }

  async getTrends(options?: { minScore?: number; excludeDismissed?: boolean; excludeTriggered?: boolean }): Promise<PooledTrend[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options?.minScore !== undefined) {
      conditions.push(`current_score >= $${paramIndex++}`);
      params.push(options.minScore);
    }
    if (options?.excludeDismissed) {
      conditions.push(`dismissed = FALSE`);
    }
    if (options?.excludeTriggered) {
      conditions.push(`triggered = FALSE`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM sched_trend_pool ${where} ORDER BY current_score DESC`,
      params
    );

    return result.rows.map(this.rowToTrend);
  }

  async getTrend(id: string): Promise<PooledTrend | null> {
    const result = await this.pool.query(`SELECT * FROM sched_trend_pool WHERE id = $1`, [id]);
    if (!result.rows[0]) return null;
    return this.rowToTrend(result.rows[0]);
  }

  async deleteTrend(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sched_trend_pool WHERE id = $1`, [id]);
  }

  async deleteStaLeTrends(minScore: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM sched_trend_pool WHERE current_score < $1 RETURNING id`,
      [minScore]
    );
    return result.rowCount || 0;
  }

  private rowToTrend(row: any): PooledTrend {
    return {
      id: row.id,
      topic: row.topic,
      sources: row.sources || [],
      baseScore: row.base_score,
      currentScore: row.current_score,
      context: row.context,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      seenCount: row.seen_count,
      boostCount: row.boost_count || undefined,
      tokenAddress: row.token_address || undefined,
      dismissed: row.dismissed,
      triggered: row.triggered,
      metadata: row.metadata || undefined,
    };
  }

  // Alias methods for trendPool.ts compatibility
  async getTrendPool(): Promise<TrendPoolData | null> {
    const trends = await this.getTrends();
    if (trends.length === 0) return null;
    return {
      trends,
      launchedTokens: [],
      lastUpdated: Date.now(),
    };
  }

  async saveTrendPool(data: TrendPoolData): Promise<void> {
    // Upsert all trends
    for (const trend of data.trends) {
      await this.upsertTrend(trend);
    }
  }

  // ==========================================================================
  // System Metrics
  // ==========================================================================

  async getSystemMetrics(): Promise<SystemMetrics & { bannedUsers: any[]; failedAttempts: any[] }> {
    const result = await this.pool.query(`SELECT * FROM sched_system_metrics WHERE id = 'main'`);
    const row = result.rows[0];
    if (!row) {
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
        // All-time cumulative
        totalLaunches: 0,
        totalTweetsSent: 0,
        totalTgPostsSent: 0,
        counterDate: new Date().toISOString().split('T')[0],
        lastUpdated: new Date().toISOString(),
        bannedUsers: [],
        failedAttempts: [],
      };
    }

    return {
      startTime: Number(row.start_time),
      sessionStartTime: Number(row.session_start_time),
      tweetsSentToday: row.tweets_sent_today,
      tgPostsSentToday: row.tg_posts_sent_today,
      trendsDetectedToday: row.trends_detected_today,
      errors24h: row.errors_24h,
      warnings24h: row.warnings_24h,
      lastReportTime: Number(row.last_report_time),
      lastDailyReportDate: row.last_daily_report_date || '',
      totalMessagesReceived: row.total_messages_received,
      // All-time cumulative
      totalLaunches: row.total_launches || 0,
      totalTweetsSent: row.total_tweets_sent || 0,
      totalTgPostsSent: row.total_tg_posts_sent || 0,
      counterDate: row.counter_date || '',
      lastUpdated: row.last_updated instanceof Date ? row.last_updated.toISOString() : row.last_updated,
      bannedUsers: row.banned_users || [],
      failedAttempts: row.failed_attempts || [],
    };
  }

  async updateSystemMetrics(updates: Partial<SystemMetrics & { bannedUsers?: any[]; failedAttempts?: any[] }>): Promise<void> {
    const sets: string[] = ['last_updated = NOW()'];
    const values: any[] = [];
    let paramIndex = 1;

    const fieldMap: Record<string, string> = {
      sessionStartTime: 'session_start_time',
      tweetsSentToday: 'tweets_sent_today',
      tgPostsSentToday: 'tg_posts_sent_today',
      trendsDetectedToday: 'trends_detected_today',
      errors24h: 'errors_24h',
      warnings24h: 'warnings_24h',
      lastReportTime: 'last_report_time',
      lastDailyReportDate: 'last_daily_report_date',
      totalMessagesReceived: 'total_messages_received',
      bannedUsers: 'banned_users',
      failedAttempts: 'failed_attempts',
    };

    for (const [key, value] of Object.entries(updates)) {
      const dbField = fieldMap[key];
      if (dbField && value !== undefined) {
        sets.push(`${dbField} = $${paramIndex++}`);
        if (key === 'bannedUsers' || key === 'failedAttempts') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
    }

    if (values.length > 0) {
      await this.pool.query(`UPDATE sched_system_metrics SET ${sets.join(', ')} WHERE id = 'main'`, values);
    }
  }

  async incrementMetric(field: 'tweetsSentToday' | 'tgPostsSentToday' | 'trendsDetectedToday' | 'errors24h' | 'warnings24h' | 'totalMessagesReceived' | 'totalLaunches' | 'totalTweetsSent' | 'totalTgPostsSent', amount: number = 1): Promise<void> {
    const fieldMap: Record<string, string> = {
      tweetsSentToday: 'tweets_sent_today',
      tgPostsSentToday: 'tg_posts_sent_today',
      trendsDetectedToday: 'trends_detected_today',
      errors24h: 'errors_24h',
      warnings24h: 'warnings_24h',
      totalMessagesReceived: 'total_messages_received',
      // All-time cumulative counters
      totalLaunches: 'total_launches',
      totalTweetsSent: 'total_tweets_sent',
      totalTgPostsSent: 'total_tg_posts_sent',
    };
    const dbField = fieldMap[field];
    if (dbField) {
      await this.pool.query(
        `UPDATE sched_system_metrics SET ${dbField} = ${dbField} + $1, last_updated = NOW() WHERE id = 'main'`,
        [amount]
      );
    }
  }

  async resetDailyMetrics(counterDate?: string): Promise<void> {
    const today = counterDate || new Date().toISOString().split('T')[0];
    await this.pool.query(`
      UPDATE sched_system_metrics SET 
        tweets_sent_today = 0,
        tg_posts_sent_today = 0,
        trends_detected_today = 0,
        errors_24h = 0,
        warnings_24h = 0,
        counter_date = $1,
        last_updated = NOW()
      WHERE id = 'main'
    `, [today]);
  }

  /**
   * Count posts sent today from actual post tables (for metrics recovery)
   * This provides a source of truth when metrics get reset accidentally
   */
  async countTodaysPosts(): Promise<{ tweetsSentToday: number; tgPostsSentToday: number }> {
    const today = new Date().toISOString().slice(0, 10);
    
    // X tweets: use created_at because posted_at may not be set
    const tweetsResult = await this.pool.query(`
      SELECT COUNT(*) as count FROM sched_x_tweets 
      WHERE status = 'posted' AND created_at::date = $1
    `, [today]);
    
    // TG posts: use posted_at (which is properly set)
    const tgResult = await this.pool.query(`
      SELECT COUNT(*) as count FROM sched_tg_posts 
      WHERE status = 'posted' AND posted_at::date = $1
    `, [today]);
    
    return {
      tweetsSentToday: parseInt(tweetsResult.rows[0]?.count || '0', 10),
      tgPostsSentToday: parseInt(tgResult.rows[0]?.count || '0', 10),
    };
  }

  /**
   * Recover metrics from actual post tables
   * Call this on startup to ensure metrics match reality
   */
  async recoverMetricsFromPosts(): Promise<{ recovered: boolean; tweets: number; tgPosts: number; totalLaunches?: number }> {
    const counts = await this.countTodaysPosts();
    const current = await this.getSystemMetrics();
    let recovered = false;
    
    // Recover daily tweet/TG counts if lower than actual
    if (counts.tweetsSentToday > current.tweetsSentToday || 
        counts.tgPostsSentToday > current.tgPostsSentToday) {
      await this.pool.query(`
        UPDATE sched_system_metrics SET
          tweets_sent_today = GREATEST(tweets_sent_today, $1),
          tg_posts_sent_today = GREATEST(tg_posts_sent_today, $2),
          last_updated = NOW()
        WHERE id = 'main'
      `, [counts.tweetsSentToday, counts.tgPostsSentToday]);
      recovered = true;
    }
    
    // Recover total launch count from actual launch_packs table
    try {
      const launchResult = await this.pool.query(
        `SELECT COUNT(*) as count FROM launch_packs WHERE data->'launch'->>'status' = 'launched'`
      );
      const actualLaunches = parseInt(launchResult.rows[0]?.count || '0', 10);
      if (actualLaunches > 0 && actualLaunches !== current.totalLaunches) {
        await this.pool.query(
          `UPDATE sched_system_metrics SET total_launches = $1, last_updated = NOW() WHERE id = 'main'`,
          [actualLaunches]
        );
        logger.info(`[PostgresRepo] 🔧 Self-healed total_launches: ${current.totalLaunches} → ${actualLaunches}`);
        recovered = true;
        return { recovered, tweets: Math.max(counts.tweetsSentToday, current.tweetsSentToday), tgPosts: Math.max(counts.tgPostsSentToday, current.tgPostsSentToday), totalLaunches: actualLaunches };
      }
    } catch (err) {
      // launch_packs table might not exist in some setups
    }
    
    return { recovered, tweets: Math.max(counts.tweetsSentToday, current.tweetsSentToday), tgPosts: Math.max(counts.tgPostsSentToday, current.tgPostsSentToday) };
  }

  // ==========================================================================
  // Community Voting
  // ==========================================================================

  async getCommunityPreferences(): Promise<CommunityPreferences | null> {
    const result = await this.pool.query(`SELECT * FROM sched_community_prefs WHERE id = 'main'`);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      approvedThemes: row.approved_themes || {},
      rejectedThemes: row.rejected_themes || {},
      preferredStyles: row.preferred_styles || [],
      avoidStyles: row.avoid_styles || [],
      totalVotes: row.total_votes || 0,
      avgApprovalRate: row.avg_approval_rate || 0.5,
    };
  }

  async saveCommunityPreferences(prefs: CommunityPreferences): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_community_prefs (id, approved_themes, rejected_themes, preferred_styles, avoid_styles, total_votes, avg_approval_rate)
      VALUES ('main', $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        approved_themes = $1,
        rejected_themes = $2,
        preferred_styles = $3,
        avoid_styles = $4,
        total_votes = $5,
        avg_approval_rate = $6
    `, [
      JSON.stringify(prefs.approvedThemes),
      JSON.stringify(prefs.rejectedThemes),
      JSON.stringify(prefs.preferredStyles),
      JSON.stringify(prefs.avoidStyles),
      prefs.totalVotes,
      prefs.avgApprovalRate,
    ]);
  }

  async insertIdeaFeedback(feedback: IdeaFeedback): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_community_feedback (id, idea_id, user_id, vote, comment, timestamp)
      VALUES ($1, $2, 'system', $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [
      feedback.id,
      feedback.idea?.ticker || 'unknown',
      feedback.outcome,
      feedback.feedback || null,
      Date.now(),
    ]);
  }

  async getIdeaFeedbackHistory(limit: number = 100): Promise<IdeaFeedback[]> {
    const result = await this.pool.query(
      `SELECT * FROM sched_community_feedback ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      idea: { ticker: row.idea_id },
      outcome: row.vote as any,
      votes: { positive: 0, negative: 0, total: 0, sentiment: 0, reactions: {}, voters: 0 },
      feedback: row.comment,
    }));
  }

  async insertPendingVote(vote: PendingVote): Promise<void> {
    await this.pool.query(`
      INSERT INTO sched_pending_votes (id, data, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET data = $2, expires_at = $3
    `, [vote.id, JSON.stringify(vote), new Date(vote.votingEndsAt).getTime()]);
  }

  async getPendingVotesList(): Promise<PendingVote[]> {
    const result = await this.pool.query(
      `SELECT data FROM sched_pending_votes WHERE expires_at > $1`,
      [Date.now()]
    );
    return result.rows.map(row => row.data);
  }

  async deletePendingVote(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sched_pending_votes WHERE id = $1`, [id]);
  }

  // ==========================================================================
  // Autonomous Mode State
  // ==========================================================================

  async getAutonomousState(): Promise<{
    launchesToday: number;
    reactiveLaunchesToday: number;
    lastLaunchDate: string | null;
    nextScheduledTime: number | null;
    pendingIdea: any | null;
    pendingVoteId: string | null;
    nova_start_date?: string | null;
    nova_tease_count?: number;
    nova_milestones?: any;
    initial_balance?: number | null;
  }> {
    const result = await this.pool.query(`SELECT * FROM sched_autonomous_state WHERE id = 'main'`);
    const row = result.rows[0];
    if (!row) {
      return {
        launchesToday: 0,
        reactiveLaunchesToday: 0,
        lastLaunchDate: null,
        nextScheduledTime: null,
        pendingIdea: null,
        pendingVoteId: null,
      };
    }
    return {
      launchesToday: row.launches_today || 0,
      reactiveLaunchesToday: row.reactive_launches_today || 0,
      lastLaunchDate: row.last_launch_date || null,
      nextScheduledTime: row.next_scheduled_time ? Number(row.next_scheduled_time) : null,
      pendingIdea: row.pending_idea || null,
      pendingVoteId: row.pending_vote_id || null,
      nova_start_date: row.nova_start_date || null,
      nova_tease_count: row.nova_tease_count || 0,
      nova_milestones: row.nova_milestones || null,
      initial_balance: row.initial_balance != null ? Number(row.initial_balance) : null,
    };
  }

  async updateAutonomousState(updates: {
    launchesToday?: number;
    reactiveLaunchesToday?: number;
    lastLaunchDate?: string | null;
    nextScheduledTime?: number | null;
    pendingIdea?: any | null;
    pendingVoteId?: string | null;
    nova_start_date?: string;
    nova_tease_count?: number;
    nova_milestones?: string;
    initial_balance?: number;
  }): Promise<void> {
    const sets: string[] = ['last_updated = NOW()'];
    const values: any[] = [];
    let paramIndex = 1;

    const fieldMap: Record<string, string> = {
      launchesToday: 'launches_today',
      reactiveLaunchesToday: 'reactive_launches_today',
      lastLaunchDate: 'last_launch_date',
      nextScheduledTime: 'next_scheduled_time',
      pendingIdea: 'pending_idea',
      pendingVoteId: 'pending_vote_id',
      nova_start_date: 'nova_start_date',
      nova_tease_count: 'nova_tease_count',
      nova_milestones: 'nova_milestones',
      initial_balance: 'initial_balance',
    };

    for (const [key, value] of Object.entries(updates)) {
      const dbField = fieldMap[key];
      if (dbField && value !== undefined) {
        sets.push(`${dbField} = $${paramIndex++}`);
        if (key === 'pendingIdea') {
          values.push(value ? JSON.stringify(value) : null);
        } else {
          values.push(value);
        }
      }
    }

    if (values.length > 0) {
      await this.pool.query(
        `UPDATE sched_autonomous_state SET ${sets.join(', ')} WHERE id = 'main'`,
        values
      );
    }
  }

  async incrementLaunchCount(type: 'scheduled' | 'reactive'): Promise<void> {
    const field = type === 'scheduled' ? 'launches_today' : 'reactive_launches_today';
    await this.pool.query(
      `UPDATE sched_autonomous_state SET ${field} = ${field} + 1, last_updated = NOW() WHERE id = 'main'`
    );
  }

  async resetDailyLaunchCounts(date: string): Promise<void> {
    await this.pool.query(`
      UPDATE sched_autonomous_state SET 
        launches_today = 0,
        reactive_launches_today = 0,
        last_launch_date = $1,
        last_updated = NOW()
      WHERE id = 'main'
    `, [date]);
  }

  // ==========================================================================
  // Key-Value Store (general-purpose state persistence)
  // ==========================================================================

  /** Store a JSON-serialisable value under a key (upsert) */
  async kvSet(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO sched_kv_store (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  /** Retrieve a value by key, or null if missing */
  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const res = await this.pool.query(
      `SELECT value FROM sched_kv_store WHERE key = $1`,
      [key]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].value as T;
  }

  /** Delete a key */
  async kvDelete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM sched_kv_store WHERE key = $1`, [key]);
  }
}
