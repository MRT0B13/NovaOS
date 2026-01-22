import { logger } from '@elizaos/core';
import { TwitterApi } from 'twitter-api-v2';
import { LaunchPackStore } from '../db/launchPackRepository.ts';
import { getEnv } from '../env.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import { canWrite, recordWrite, getQuota, getPostingAdvice, getUsageSummary } from './xRateLimiter.ts';
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
  result = result.replace(/\n\n+/g, '\n\n');
  
  return result.trim();
}

/**
 * Standalone Twitter client - doesn't use ElizaOS plugin (which polls and burns Free Tier quota)
 */
class StandaloneTwitterClient {
  private client: TwitterApi | null = null;
  private initialized = false;

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
      logger.info('[StandaloneTwitter] ✅ Twitter client initialized (no polling, write-only)');
      return true;
    } catch (error) {
      logger.error('[StandaloneTwitter] Failed to initialize:', error);
      return false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  async sendTweet(text: string, replyToTweetId?: string): Promise<{ id: string }> {
    if (!this.client) {
      throw errorWithCode('X_CLIENT_NOT_INITIALIZED', 'Twitter client not initialized');
    }

    const options: any = {};
    if (replyToTweetId) {
      options.reply = { in_reply_to_tweet_id: replyToTweetId };
    }

    try {
      const result = await this.client.v2.tweet(text, options);
      return { id: result.data.id };
    } catch (error: any) {
      // Parse Twitter API errors into cleaner messages
      const code = error?.code || error?.data?.status || 0;
      const detail = error?.data?.detail || error?.message || 'Unknown error';
      
      // Common Twitter error codes
      if (code === 403) {
        if (detail.includes('duplicate') || detail.includes('already posted')) {
          throw errorWithCode('X_DUPLICATE', 'Duplicate tweet - already posted similar content');
        }
        if (detail.includes('not permitted')) {
          throw errorWithCode('X_FORBIDDEN', 'Twitter API permission denied - try regenerating access tokens');
        }
        throw errorWithCode('X_FORBIDDEN', `Twitter 403: ${detail}`);
      }
      if (code === 429) {
        throw errorWithCode('X_RATE_LIMIT', 'Twitter rate limit exceeded');
      }
      if (code === 401) {
        throw errorWithCode('X_AUTH_FAILED', 'Twitter authentication failed - check API credentials');
      }
      
      // Re-throw with cleaner message
      throw errorWithCode('X_API_ERROR', `Twitter API error (${code}): ${detail}`);
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

    const result = await twitterClient.sendTweet(text);
    await recordWrite(text);
    
    const quota = getQuota();
    logger.info(`[XPublisher] ✅ Tweet posted. ${quota.writes.remaining} remaining this month.`);
    
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
        tweetIds.push(result.id);
        previousId = result.id;
      }

      for (const rawPost of claim.x?.thread || []) {
        // Check quota before each thread reply
        if (!canWrite()) {
          logger.warn('[XPublisher] Rate limit hit mid-thread, stopping');
          break;
        }
        // Resolve placeholders with actual URLs
        const post = resolvePlaceholders(rawPost, mint, telegramUrl, websiteUrl);
        const result = await twitterClient.sendTweet(post, previousId);
        await recordWrite(post);
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
