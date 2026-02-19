import { logger } from '@elizaos/core';
import { getHealthbeat } from '../health/singleton';
import { TwitterApi } from 'twitter-api-v2';
import { LaunchPackStore } from '../db/launchPackRepository.ts';
import { getEnv } from '../env.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import { canWrite, recordWrite, getQuota, getPostingAdvice, getUsageSummary, reportRateLimit } from './xRateLimiter.ts';
import { recordTweetSent } from './systemReporter.ts';
import type { LaunchPack } from '../model/launchPack.ts';

interface PublishOptions {
  force?: boolean;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

/**
 * Replace placeholder tokens with actual URLs before posting
 * Handles: [MINT_ADDRESS], [MINT], [TG_LINK], [TG], [WEBSITE], pump.fun/[MINT_ADDRESS], etc.
 */
function resolvePlaceholders(text: string, mint?: string, telegramUrl?: string, websiteUrl?: string): string {
  let result = text;
  
  // Build the actual pump.fun URL
  const pumpUrl = mint ? `https://pump.fun/coin/${mint}` : '';
  
  // Replace various placeholder patterns
  // Full URLs first
  result = result.replace(/pump\.fun\/\[MINT_ADDRESS\]/g, pumpUrl ? pumpUrl.replace('https://', '') : '');
  result = result.replace(/pump\.fun\/\[MINT\]/g, pumpUrl ? pumpUrl.replace('https://', '') : '');
  
  // Standalone placeholders
  result = result.replace(/\[MINT_ADDRESS\]/g, mint || '');
  result = result.replace(/\[MINT\]/g, mint || '');
  result = result.replace(/\[TG_LINK\]/g, telegramUrl || '');
  result = result.replace(/\[TG\]/g, telegramUrl || '');
  result = result.replace(/\[WEBSITE\]/g, websiteUrl || '');
  
  // Clean up empty lines (when placeholder is replaced with empty string)
  result = result.replace(/\nChart: $/gm, '');
  result = result.replace(/\nTelegram: $/gm, '');
  result = result.replace(/\nWebsite: $/gm, '');
  // Strip bare pump.fun/ URLs with no address
  result = result.replace(/pump\.fun\/(?!\w)/g, '');
  result = result.replace(/\n\n+/g, '\n\n');
  
  return result.trim();
}

/**
 * Standalone Twitter client - doesn't use ElizaOS plugin (which polls and burns Free Tier quota)
 */
class StandaloneTwitterClient {
  private client: TwitterApi | null = null;
  private initialized = false;
  private cachedUserId: string | null = null;

  initialize(): boolean {
    const env = getEnv();
    
    // Support both X_* and TWITTER_* naming conventions
    const apiKey = env.TWITTER_API_KEY || env.X_API_KEY;
    const apiSecret = env.TWITTER_API_SECRET_KEY || env.X_API_SECRET;
    const accessToken = env.TWITTER_ACCESS_TOKEN || env.X_ACCESS_TOKEN;
    const accessSecret = env.TWITTER_ACCESS_TOKEN_SECRET || env.X_ACCESS_SECRET;
    
    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
      logger.warn('[StandaloneTwitter] Missing Twitter credentials');
      return false;
    }

    try {
      this.client = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken: accessToken,
        accessSecret: accessSecret,
      });
      this.initialized = true;
      
      // Pre-seed user ID from env to avoid v2.me() API call on first mentions fetch
      const userId = env.X_USER_ID;
      if (userId) {
        this.cachedUserId = userId;
        logger.info(`[StandaloneTwitter] User ID pre-seeded from env: ${userId}`);
      }
      
      logger.info('[StandaloneTwitter] ✅ Twitter client initialized (read + write, no polling)');
      return true;
    } catch (error) {
      logger.error('[StandaloneTwitter] Failed to initialize:', error);
      return false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  /**
   * Get the authenticated user's info
   */
  async getMe(): Promise<{ id: string; username: string; name: string } | null> {
    if (!this.client) return null;
    try {
      const me = await this.client.v2.me();
      return { id: me.data.id, username: me.data.username, name: me.data.name };
    } catch (error) {
      logger.error('[StandaloneTwitter] Failed to get authenticated user:', error);
      return null;
    }
  }

  /**
   * Get a specific tweet by ID
   */
  async getTweet(tweetId: string): Promise<{
    id: string;
    text: string;
    authorId?: string;
    createdAt?: string;
    metrics?: { likes: number; retweets: number; replies: number };
  } | null> {
    if (!this.client) return null;
    try {
      const tweet = await this.client.v2.singleTweet(tweetId, {
        'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
      });
      return {
        id: tweet.data.id,
        text: tweet.data.text,
        authorId: tweet.data.author_id,
        createdAt: tweet.data.created_at,
        metrics: tweet.data.public_metrics ? {
          likes: tweet.data.public_metrics.like_count,
          retweets: tweet.data.public_metrics.retweet_count,
          replies: tweet.data.public_metrics.reply_count,
        } : undefined,
      };
    } catch (error) {
      logger.error('[StandaloneTwitter] Failed to get tweet:', error);
      return null;
    }
  }

  /**
   * Get recent tweets from a user's timeline
   */
  async getUserTweets(userId: string, maxResults = 10): Promise<Array<{
    id: string;
    text: string;
    createdAt?: string;
  }>> {
    if (!this.client) return [];
    try {
      const timeline = await this.client.v2.userTimeline(userId, {
        max_results: maxResults,
        'tweet.fields': ['created_at'],
      });
      return timeline.data.data?.map(t => ({
        id: t.id,
        text: t.text,
        createdAt: t.created_at,
      })) || [];
    } catch (error) {
      logger.error('[StandaloneTwitter] Failed to get user tweets:', error);
      return [];
    }
  }

  /**
   * Search for recent tweets (requires Basic or higher API tier)
   */
  async searchTweets(query: string, maxResults = 10): Promise<Array<{
    id: string;
    text: string;
    authorId?: string;
    createdAt?: string;
  }>> {
    if (!this.client) return [];
    try {
      const results = await this.client.v2.search(query, {
        max_results: maxResults,
        'tweet.fields': ['created_at', 'author_id'],
      });
      return results.data.data?.map(t => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        createdAt: t.created_at,
      })) || [];
    } catch (error: any) {
      // Search requires Basic tier - Free tier won't work
      if (error?.code === 403) {
        logger.warn('[StandaloneTwitter] Search requires Basic API tier (not available on Free)');
      } else if (error?.code === 429 || error?.message?.includes('429') || error?.message?.includes('Too Many')) {
        logger.warn('[StandaloneTwitter] Search 429 rate limit hit');
        // Don't call reportReadRateLimit() here — let the caller decide.
        throw error; // Re-throw so caller knows it was a rate limit
      } else {
        logger.error('[StandaloneTwitter] Failed to search tweets:', error);
      }
      return [];
    }
  }

  /**
   * Get mentions of the authenticated user (requires Basic or higher)
   */
  async getMentions(maxResults = 10): Promise<Array<{
    id: string;
    text: string;
    authorId?: string;
    createdAt?: string;
  }>> {
    if (!this.client) return [];
    try {
      // Cache user ID to avoid burning an API call every round
      if (!this.cachedUserId) {
        const me = await this.client.v2.me();
        this.cachedUserId = me.data.id;
        logger.info(`[StandaloneTwitter] Cached user ID: ${this.cachedUserId}`);
      }
      const mentions = await this.client.v2.userMentionTimeline(this.cachedUserId, {
        max_results: maxResults,
        'tweet.fields': ['created_at', 'author_id'],
      });
      return mentions.data.data?.map(t => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        createdAt: t.created_at,
      })) || [];
    } catch (error: any) {
      if (error?.code === 403) {
        logger.warn('[StandaloneTwitter] Mentions requires Basic API tier');
      } else if (error?.code === 429 || error?.message?.includes('429') || error?.message?.includes('Too Many')) {
        logger.warn('[StandaloneTwitter] Mentions 429 rate limit hit');
        // Don't call reportReadRateLimit() here — let the caller (reply engine) decide
        // whether to trigger exponential backoff or treat it as a soft skip.
        throw error; // Re-throw so caller knows it was a rate limit
      } else {
        logger.error('[StandaloneTwitter] Failed to get mentions:', error);
      }
      return [];
    }
  }

  async sendTweet(text: string, replyToTweetId?: string, mediaIds?: string[]): Promise<{ id: string }> {
    if (!this.client) {
      throw errorWithCode('X_CLIENT_NOT_INITIALIZED', 'Twitter client not initialized');
    }
    
    // Pre-validate tweet length
    if (text.length > 280) {
      logger.error(`[StandaloneTwitter] Tweet too long (${text.length} chars), truncating to 280`);
      text = text.substring(0, 277) + '...';
    }
    if (!text.trim()) {
      throw errorWithCode('X_TWEET_EMPTY', 'Cannot send empty tweet');
    }

    const options: any = {};
    if (replyToTweetId) {
      options.reply = { in_reply_to_tweet_id: replyToTweetId };
    }
    if (mediaIds && mediaIds.length > 0) {
      options.media = { media_ids: mediaIds };
    }

    try {
      const result = await this.client.v2.tweet(text, options);
      return { id: result.data.id };
    } catch (error: any) {
      // Log full error for debugging
      logger.error('[StandaloneTwitter] Tweet error:', JSON.stringify({
        code: error?.code,
        status: error?.data?.status,
        detail: error?.data?.detail,
        title: error?.data?.title,
        errors: error?.data?.errors,
        message: error?.message,
      }));
      getHealthbeat()?.reportError({ errorType: 'X_TWEET_FAILED', errorMessage: error?.message || 'Tweet failed', stackTrace: error?.stack, severity: 'critical', context: { task: 'tweet_post', code: error?.code, status: error?.data?.status } }).catch(() => {});
      
      // Parse Twitter API errors into cleaner messages
      const code = error?.code || error?.data?.status || 0;
      const detail = error?.data?.detail || error?.data?.title || error?.message || 'Unknown error';
      
      // Common Twitter error codes
      if (code === 403) {
        if (detail.includes('duplicate') || detail.includes('already posted')) {
          throw errorWithCode('X_DUPLICATE', 'Duplicate tweet - already posted similar content');
        }
        // Include full detail in error message for debugging
        throw errorWithCode('X_FORBIDDEN', `Twitter 403 Forbidden: ${detail}`, { 
          errors: error?.data?.errors,
          rawMessage: error?.message 
        });
      }
      if (code === 429) {
        reportRateLimit(); // Signal shared backoff — pauses ALL X posting
        throw errorWithCode('X_RATE_LIMIT', 'Twitter rate limit exceeded');
      }
      if (code === 401) {
        throw errorWithCode('X_AUTH_FAILED', 'Twitter authentication failed - check API credentials');
      }
      
      // Re-throw with cleaner message
      throw errorWithCode('X_API_ERROR', `Twitter API error (${code}): ${detail}`);
    }
  }

  /**
   * Upload media (image) to Twitter and return the media ID
   */
  async uploadMedia(imageBuffer: Buffer, mimeType: string = 'image/png'): Promise<string | null> {
    if (!this.client) {
      logger.warn('[StandaloneTwitter] Client not initialized for media upload');
      return null;
    }
    try {
      const mediaId = await this.client.v1.uploadMedia(imageBuffer, { mimeType });
      logger.info(`[StandaloneTwitter] ✅ Media uploaded (ID: ${mediaId})`);
      return mediaId;
    } catch (error: any) {
      logger.error('[StandaloneTwitter] Media upload failed:', error?.message || error);
      getHealthbeat()?.reportError({ errorType: 'X_MEDIA_UPLOAD_FAILED', errorMessage: error?.message || 'Media upload failed', severity: 'error', context: { task: 'media_upload' } }).catch(() => {});
      return null;
    }
  }
}

// Singleton instance
const twitterClient = new StandaloneTwitterClient();

export class XPublisherService {
  constructor(private store: LaunchPackStore) {
    // Initialize Twitter client on first use
    if (!twitterClient.isReady()) {
      twitterClient.initialize();
    }
  }

  /**
   * Get current X/Twitter rate limit status
   */
  getQuotaStatus() {
    return {
      quota: getQuota(),
      advice: getPostingAdvice(),
      summary: getUsageSummary(),
    };
  }

  /**
   * Send a simple tweet (for marketing actions)
   */
  async tweet(text: string): Promise<{ id: string; remaining: number }> {
    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }

    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        throw errorWithCode('X_CLIENT_MISSING', 'Twitter client not initialized - check credentials');
      }
    }

    const advice = getPostingAdvice();
    if (!advice.canPost) {
      throw errorWithCode('X_RATE_LIMIT', advice.reason);
    }

    // Debug: Log exact tweet content being sent
    logger.info(`[XPublisher] Attempting tweet (${text.length} chars): ${text.substring(0, 100)}...`);

    const result = await twitterClient.sendTweet(text);
    await recordWrite(text);
    recordTweetSent();
    
    const quota = getQuota();
    logger.info(`[XPublisher] ✅ Tweet posted. ${quota.writes.remaining} remaining this month.`);
    
    return { id: result.id, remaining: quota.writes.remaining };
  }

  /**
   * Reply to a tweet (for threads and engagement)
   */
  async reply(text: string, replyToTweetId: string): Promise<{ id: string; remaining: number }> {
    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }

    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        throw errorWithCode('X_CLIENT_MISSING', 'Twitter client not initialized - check credentials');
      }
    }

    const advice = getPostingAdvice();
    if (!advice.canPost) {
      throw errorWithCode('X_RATE_LIMIT', advice.reason);
    }

    logger.info(`[XPublisher] Replying to ${replyToTweetId} (${text.length} chars): ${text.substring(0, 100)}...`);

    const result = await twitterClient.sendTweet(text, replyToTweetId);
    await recordWrite(text);
    recordTweetSent();
    
    const quota = getQuota();
    logger.info(`[XPublisher] ✅ Reply posted. ${quota.writes.remaining} remaining this month.`);
    
    return { id: result.id, remaining: quota.writes.remaining };
  }

  /**
   * Reply to a tweet with media attached
   */
  async replyWithMedia(text: string, replyToTweetId: string, mediaIds: string[]): Promise<{ id: string; remaining: number }> {
    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }

    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        throw errorWithCode('X_CLIENT_MISSING', 'Twitter client not initialized - check credentials');
      }
    }

    const advice = getPostingAdvice();
    if (!advice.canPost) {
      throw errorWithCode('X_RATE_LIMIT', advice.reason);
    }

    logger.info(`[XPublisher] Replying with ${mediaIds.length} media to ${replyToTweetId} (${text.length} chars)`);

    const result = await twitterClient.sendTweet(text, replyToTweetId, mediaIds);
    await recordWrite(text);
    recordTweetSent();
    
    const quota = getQuota();
    logger.info(`[XPublisher] ✅ Reply with media posted. ${quota.writes.remaining} remaining this month.`);
    
    return { id: result.id, remaining: quota.writes.remaining };
  }

  /**
   * Upload media to Twitter
   */
  async uploadMedia(imageBuffer: Buffer, mimeType: string = 'image/png'): Promise<string | null> {
    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        logger.warn('[XPublisher] Twitter client not initialized for media upload');
        return null;
      }
    }
    return twitterClient.uploadMedia(imageBuffer, mimeType);
  }

  /**
   * Send a tweet with media attached
   */
  async tweetWithMedia(text: string, mediaIds: string[]): Promise<{ id: string; remaining: number }> {
    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }

    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        throw errorWithCode('X_CLIENT_MISSING', 'Twitter client not initialized - check credentials');
      }
    }

    const advice = getPostingAdvice();
    if (!advice.canPost) {
      throw errorWithCode('X_RATE_LIMIT', advice.reason);
    }

    logger.info(`[XPublisher] Attempting tweet with ${mediaIds.length} media (${text.length} chars): ${text.substring(0, 100)}...`);

    const result = await twitterClient.sendTweet(text, undefined, mediaIds);
    await recordWrite(text);
    recordTweetSent();
    
    const quota = getQuota();
    logger.info(`[XPublisher] ✅ Tweet with media posted. ${quota.writes.remaining} remaining this month.`);
    
    return { id: result.id, remaining: quota.writes.remaining };
  }

  async publish(id: string, options: PublishOptions = {}): Promise<LaunchPack> {
    if (!twitterClient.isReady()) {
      if (!twitterClient.initialize()) {
        throw errorWithCode('X_CLIENT_MISSING', 'Twitter client not initialized - check credentials');
      }
    }

    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }

    // Check rate limits before attempting to publish
    const advice = getPostingAdvice();
    if (!advice.canPost) {
      logger.warn(`[XPublisher] Rate limit reached: ${advice.reason}`);
      import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_publish_blocked',
        `Token publish blocked: ${advice.reason}`
      )).catch(() => {});
      throw errorWithCode('X_RATE_LIMIT', advice.reason);
    }

    // Count tweets we're about to send
    const pack = await this.store.get(id);
    if (!pack) throw errorWithCode('NOT_FOUND', 'LaunchPack not found');
    
    const tweetsToSend = 1 + (pack.x?.thread?.length || 0); // main + thread
    const quota = getQuota();
    
    if (quota.writes.remaining < tweetsToSend) {
      const msg = `Not enough quota for thread. Need ${tweetsToSend} tweets, have ${quota.writes.remaining} remaining.`;
      logger.warn(`[XPublisher] ${msg}`);
      import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_insufficient_quota',
        `Insufficient quota for thread publish.\nNeed: ${tweetsToSend} tweets, Have: ${quota.writes.remaining} remaining.`
      )).catch(() => {});
      throw errorWithCode('X_INSUFFICIENT_QUOTA', msg);
    }

    if (!pack.ops?.checklist?.x_ready) {
      throw errorWithCode('X_NOT_READY', 'X checklist not ready');
    }
    if (pack.ops?.x_published_at && pack.ops.x_publish_status === 'published' && !options.force) {
      return pack;
    }

    const claim = await this.store.claimXPublish(id, {
      requested_at: nowIso(),
      force: options.force,
    });
    if (!claim) {
      throw errorWithCode('X_PUBLISH_IN_PROGRESS', 'X publish already in progress');
    }

    // Get the actual mint and telegram URL for resolving placeholders
    const mint = claim.launch?.mint;
    const telegramUrl = claim.tg?.invite_link;
    const websiteUrl = claim.links?.website;

    const tweetIds: string[] = [];
    let previousId: string | undefined;
    const rawMainText = claim.x?.main_post;
    try {
      if (rawMainText) {
        // Resolve placeholders with actual URLs
        const mainText = resolvePlaceholders(rawMainText, mint, telegramUrl, websiteUrl);
        logger.info(`[XPublisher] Sending main tweet (${quota.writes.remaining} remaining)...`);
        const result = await twitterClient.sendTweet(mainText);
        await recordWrite(mainText);
        recordTweetSent();
        tweetIds.push(result.id);
        previousId = result.id;
      }

      for (const rawPost of claim.x?.thread || []) {
        // Check quota before each thread reply
        if (!canWrite()) {
          logger.warn('[XPublisher] Rate limit hit mid-thread, stopping');
          import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_thread_stopped',
            `Rate limit hit mid-thread — thread publishing stopped.\nPosted ${tweetIds.length} of ${(claim.x?.thread?.length || 0) + 1} tweets.`
          )).catch(() => {});
          break;
        }
        // Resolve placeholders with actual URLs
        const post = resolvePlaceholders(rawPost, mint, telegramUrl, websiteUrl);
        const result = await twitterClient.sendTweet(post, previousId);
        await recordWrite(post);
        recordTweetSent();
        tweetIds.push(result.id);
        previousId = result.id;
      }

      const scheduleIntent = (claim.x?.schedule || []).map((item) => ({ ...item, when: new Date(item.when).toISOString() }));
      
      const finalQuota = getQuota();
      logger.info(`[XPublisher] ✅ Published ${tweetIds.length} tweets. ${finalQuota.writes.remaining} remaining this month.`);

      const updated = await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          checklist: { ...(claim.ops?.checklist || {}), x_published: true },
          x_publish_status: 'published',
          x_published_at: nowIso(),
          x_post_ids: tweetIds,
          x_tweet_ids: tweetIds,
          x_schedule_intent: scheduleIntent,
          x_publish_error_code: null,
          x_publish_error_message: null,
          audit_log: appendAudit(claim.ops?.audit_log, `X publish complete (${tweetIds.length} tweets, ${finalQuota.writes.remaining} quota remaining)`, 'eliza'),
        },
      });
      return updated;
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          x_publish_status: 'failed',
          x_publish_failed_at: nowIso(),
          x_publish_error_code: err.code || 'X_PUBLISH_FAILED',
          x_publish_error_message: err.message,
        },
      });
      throw err;
    }
  }
}

// ============================================================================
// Export read methods for on-demand use (no polling)
// ============================================================================

/**
 * Get the Twitter client for read operations
 * Use sparingly - each call uses API quota
 */
export function getTwitterReader() {
  if (!twitterClient.isReady()) {
    twitterClient.initialize();
  }
  
  return {
    /** Check if client is ready */
    isReady: () => twitterClient.isReady(),
    
    /** Get authenticated user info */
    getMe: () => twitterClient.getMe(),
    
    /** Get a specific tweet by ID */
    getTweet: (tweetId: string) => twitterClient.getTweet(tweetId),
    
    /** Get recent tweets from a user (by user ID) */
    getUserTweets: (userId: string, maxResults?: number) => twitterClient.getUserTweets(userId, maxResults),
    
    /** Search tweets (requires Basic API tier) */
    searchTweets: (query: string, maxResults?: number) => twitterClient.searchTweets(query, maxResults),
    
    /** Get mentions (requires Basic API tier) */
    getMentions: (maxResults?: number) => twitterClient.getMentions(maxResults),
  };
}
