import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { canWrite, getQuota, recordWrite, getPostingAdvice } from '../services/xRateLimiter.ts';
import { generateAITweet, generateTweet, suggestTweetType, type TweetType } from '../services/xMarketing.ts';
import { 
  scheduleTweet, 
  schedulePostLaunchMarketing, 
  getPendingTweets, 
  getScheduleSummary,
  cancelTokenTweets,
  createMarketingSchedule
} from '../services/xScheduler.ts';
import { XPublisherService } from '../services/xPublisher.ts';

function requireLaunchKit(runtime: IAgentRuntime): any {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  if (!kit) {
    throw new Error('LaunchKit service not available');
  }
  return kit;
}

/**
 * TWEET_ABOUT_TOKEN - Manually generate and post a marketing tweet
 */
export const tweetAboutTokenAction: Action = {
  name: 'TWEET_ABOUT_TOKEN',
  similes: ['POST_ABOUT_TOKEN', 'PROMOTE_TOKEN', 'SHILL_TOKEN', 'MARKET_TOKEN', 'TWEET_TOKEN'],
  description: 'Generate and post a marketing tweet about a launched token',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /tweet|post|promote|shill|market/.test(text) && /about|for/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const env = getEnv();
    
    if (env.X_ENABLE !== 'true') {
      await callback({ text: '❌ X/Twitter integration is disabled.' });
      return { text: 'X disabled', success: false };
    }
    
    // Check quota
    const advice = getPostingAdvice();
    if (!advice.canPost) {
      await callback({ text: `❌ Cannot tweet: ${advice.reason}` });
      return { text: 'Rate limited', success: false };
    }
    
    // Find the token from message
    const text = String(message.content?.text ?? '').toLowerCase();
    const kit = requireLaunchKit(runtime);
    const allPacks = await kit.store.list();
    
    // Find tokens that have been launched (have a mint address OR status is 'launched')
    const launchedPacks = allPacks.filter((p: any) => 
      p.launch?.mint || p.launch?.status === 'launched'
    );
    if (launchedPacks.length === 0) {
      await callback({ text: '❌ No launched tokens found to tweet about.' });
      return { text: 'No tokens', success: false };
    }
    
    // Try to match by name or ticker
    let targetPack = launchedPacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    );
    
    // Default to most recent
    if (!targetPack) {
      targetPack = launchedPacks[launchedPacks.length - 1];
    }
    
    // Determine tweet type from message
    let tweetType: TweetType = suggestTweetType({
      name: targetPack.brand?.name || '',
      ticker: targetPack.brand?.ticker || '',
      mint: targetPack.launch?.mint || '',
      pumpUrl: `https://pump.fun/coin/${targetPack.launch?.mint}`,
      launchDate: targetPack.launch?.launched_at,
    });
    
    if (text.includes('chart')) tweetType = 'chart_callout';
    if (text.includes('community')) tweetType = 'community_shoutout';
    if (text.includes('update')) tweetType = 'daily_update';
    if (text.includes('meme')) tweetType = 'meme';
    if (text.includes('engagement') || text.includes('poll')) tweetType = 'engagement_bait';
    
    // Generate the tweet
    const generated = await generateAITweet({
      name: targetPack.brand?.name || 'Token',
      ticker: targetPack.brand?.ticker || 'TOKEN',
      mint: targetPack.launch?.mint || '',
      pumpUrl: `https://pump.fun/coin/${targetPack.launch?.mint}`,
      description: targetPack.brand?.description,
      telegramUrl: targetPack.tg?.invite_link, // Use tg.invite_link from schema
      launchDate: targetPack.launch?.launched_at,
    }, tweetType);
    
    // Use our standalone Twitter client (not ElizaOS plugin which polls)
    const xPublisher = new XPublisherService(kit.store);
    
    // Post the tweet
    try {
      const result = await xPublisher.tweet(generated.text);
      
      await callback({
        text: `✅ **Posted to X!**\n\n"${generated.text}"\n\n📊 ${result.remaining} tweets remaining this month`,
      });
      
      return { 
        text: 'Tweet posted', 
        success: true, 
        data: { 
          tweet: generated, 
          tweetId: result.id,
          remaining: result.remaining 
        } 
      };
    } catch (error) {
      const err = error as Error & { code?: string };
      logger.error('[TweetAction] Failed to post:', error);
      
      // If credentials missing, show preview
      if (err.code === 'X_CLIENT_MISSING' || err.code === 'X_CLIENT_NOT_INITIALIZED') {
        await callback({
          text: `📝 **Generated tweet** (Twitter not configured):\n\n"${generated.text}"\n\n_(${generated.characterCount} chars, type: ${tweetType})_`,
        });
        return { text: 'Preview only', success: true, data: generated as unknown as Record<string, unknown> };
      }
      
      await callback({
        text: `❌ Failed to post tweet: ${err.message}\n\n📝 Generated text was:\n"${generated.text}"`,
      });
      return { text: 'Tweet failed', success: false };
    }
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'tweet about GPTRug' } },
      { name: 'eliza', content: { text: '✅ Posted to X! "$RUG looking bullish 📈"', actions: ['TWEET_ABOUT_TOKEN'] } },
    ],
    [
      { name: 'user', content: { text: 'post a meme tweet about ferb' } },
      { name: 'eliza', content: { text: '✅ Posted meme tweet for $FRB', actions: ['TWEET_ABOUT_TOKEN'] } },
    ],
  ],
};

/**
 * SCHEDULE_MARKETING - Set up automated marketing schedule for a token
 */
export const scheduleMarketingAction: Action = {
  name: 'SCHEDULE_MARKETING',
  similes: ['SETUP_MARKETING', 'AUTO_TWEET', 'MARKETING_SCHEDULE', 'PROMOTE_AUTO'],
  description: 'Set up automated marketing tweets for a launched token',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /schedule|automat|marketing|promote/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const env = getEnv();
    
    if (env.X_ENABLE !== 'true') {
      await callback({ text: '❌ X/Twitter integration is disabled.' });
      return { text: 'X disabled', success: false };
    }
    
    const text = String(message.content?.text ?? '').toLowerCase();
    const kit = requireLaunchKit(runtime);
    const allPacks = await kit.store.list();
    
    const launchedPacks = allPacks.filter((p: any) => p.launch?.status === 'launched');
    if (launchedPacks.length === 0) {
      await callback({ text: '❌ No launched tokens found.' });
      return { text: 'No tokens', success: false };
    }
    
    // Find matching token or use most recent
    let targetPack = launchedPacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    ) || launchedPacks[launchedPacks.length - 1];
    
    // Schedule marketing tweets
    const scheduled = await schedulePostLaunchMarketing(targetPack, 7);
    await createMarketingSchedule(targetPack, 3);
    
    if (scheduled.length === 0) {
      await callback({ 
        text: `⚠️ Could not schedule tweets for **${targetPack.brand?.name}** - quota may be too low.` 
      });
      return { text: 'No tweets scheduled', success: false };
    }
    
    const quota = getQuota();
    const scheduleList = scheduled.slice(0, 5).map((t, i) => 
      `${i + 1}. ${new Date(t.scheduledFor).toLocaleString()} - ${t.type}`
    ).join('\n');
    
    await callback({
      text: `📅 **Marketing scheduled for $${targetPack.brand?.ticker}!**\n\n${scheduled.length} tweets over the next 7 days:\n\n${scheduleList}${scheduled.length > 5 ? `\n...and ${scheduled.length - 5} more` : ''}\n\n📊 Quota after schedule: ${quota.writes.remaining - scheduled.length} tweets remaining`,
    });
    
    return { 
      text: 'Marketing scheduled', 
      success: true, 
      data: { 
        tokenTicker: targetPack.brand?.ticker,
        tweetsScheduled: scheduled.length 
      } 
    };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'schedule marketing for GPTRug' } },
      { name: 'eliza', content: { text: '📅 Marketing scheduled for $RUG! 14 tweets over 7 days', actions: ['SCHEDULE_MARKETING'] } },
    ],
    [
      { name: 'user', content: { text: 'set up auto tweets for my tokens' } },
      { name: 'eliza', content: { text: '📅 Marketing scheduled for $FRB!', actions: ['SCHEDULE_MARKETING'] } },
    ],
  ],
};

/**
 * VIEW_SCHEDULED_TWEETS - See what tweets are queued
 */
export const viewScheduledTweetsAction: Action = {
  name: 'VIEW_SCHEDULED_TWEETS',
  similes: ['LIST_SCHEDULED', 'SHOW_QUEUE', 'PENDING_TWEETS', 'TWEET_QUEUE'],
  description: 'View scheduled marketing tweets',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /scheduled|queue|pending/.test(text) && /tweet|post|x/.test(text);
  },
  
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const pending = getPendingTweets();
    const summary = getScheduleSummary();
    
    if (pending.length === 0) {
      await callback({
        text: `📭 No scheduled tweets.\n\n📊 Total: ${summary.totalScheduled} tweets (${summary.posted} posted, ${summary.failed} failed)`,
      });
      return { text: 'No pending tweets', success: true };
    }
    
    const upcoming = pending.slice(0, 10).map((t, i) => {
      const date = new Date(t.scheduledFor);
      return `${i + 1}. **$${t.tokenTicker}** - ${t.type}\n   📅 ${date.toLocaleString()}\n   📝 "${t.text.substring(0, 60)}..."`;
    }).join('\n\n');
    
    const tokenBreakdown = Object.entries(summary.byToken)
      .map(([ticker, stats]) => `$${ticker}: ${stats.pending} pending, ${stats.posted} posted`)
      .join('\n');
    
    await callback({
      text: `📋 **Scheduled Tweets** (${pending.length} pending)\n\n${upcoming}${pending.length > 10 ? `\n\n...and ${pending.length - 10} more` : ''}\n\n📊 **By Token:**\n${tokenBreakdown}`,
    });
    
    return { text: 'Tweets listed', success: true, data: summary };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'show scheduled tweets' } },
      { name: 'eliza', content: { text: '📋 Scheduled Tweets (5 pending)', actions: ['VIEW_SCHEDULED_TWEETS'] } },
    ],
  ],
};

/**
 * CANCEL_TOKEN_MARKETING - Cancel scheduled tweets for a token
 */
export const cancelMarketingAction: Action = {
  name: 'CANCEL_MARKETING',
  similes: ['STOP_MARKETING', 'CANCEL_TWEETS', 'DISABLE_MARKETING'],
  description: 'Cancel scheduled marketing tweets for a token',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /cancel|stop|disable/.test(text) && /marketing|tweet|schedule/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const kit = requireLaunchKit(runtime);
    const allPacks = await kit.store.list();
    
    // Find matching token
    const targetPack = allPacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    );
    
    if (!targetPack) {
      await callback({ text: '❌ Could not find token to cancel. Specify the name or ticker.' });
      return { text: 'Token not found', success: false };
    }
    
    const cancelled = await cancelTokenTweets(targetPack.id);
    
    await callback({
      text: `✅ Cancelled ${cancelled} scheduled tweets for **$${targetPack.brand?.ticker}**`,
    });
    
    return { text: 'Marketing cancelled', success: true, data: { cancelled } };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'cancel marketing for GPTRug' } },
      { name: 'eliza', content: { text: '✅ Cancelled 8 scheduled tweets for $RUG', actions: ['CANCEL_MARKETING'] } },
    ],
  ],
};

/**
 * REGENERATE_SCHEDULED_TWEETS - Regenerate pending tweets with fresh AI content
 * Use this to fix scheduled tweets that have broken/truncated URLs
 */
export const regenerateScheduledTweetsAction: Action = {
  name: 'REGENERATE_SCHEDULED_TWEETS',
  similes: ['FIX_SCHEDULED_TWEETS', 'REFRESH_TWEETS', 'REGENERATE_TWEETS'],
  description: 'Regenerate pending scheduled tweets with fresh AI content (fixes broken URLs)',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /regenerate|refresh|fix/.test(text) && /scheduled|tweet|marketing/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    
    await callback({ text: '🔄 Regenerating scheduled tweets with fresh content...' });
    
    const { regeneratePendingTweets } = await import('../services/xScheduler.ts');
    const results = await regeneratePendingTweets(kit.store);
    
    await callback({
      text: `✅ **Tweet Regeneration Complete**\n\n` +
        `🔄 Regenerated: ${results.regenerated}\n` +
        `❌ Failed: ${results.failed}\n\n` +
        `All pending tweets now have fresh AI-generated content with full URLs.`,
    });
    
    return { 
      text: 'Tweets regenerated', 
      success: true, 
      data: results as unknown as Record<string, unknown> 
    };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'regenerate scheduled tweets' } },
      { name: 'eliza', content: { text: '✅ Tweet Regeneration Complete - 8 regenerated', actions: ['REGENERATE_SCHEDULED_TWEETS'] } },
    ],
    [
      { name: 'user', content: { text: 'fix scheduled tweets' } },
      { name: 'eliza', content: { text: '✅ Tweet Regeneration Complete', actions: ['REGENERATE_SCHEDULED_TWEETS'] } },
    ],
  ],
};

/**
 * PREVIEW_TWEET - Generate a preview tweet without posting (for testing URL formatting)
 */
export const previewTweetAction: Action = {
  name: 'PREVIEW_TWEET',
  similes: ['TEST_TWEET', 'SAMPLE_TWEET', 'DRY_RUN_TWEET'],
  description: 'Generate a sample tweet to preview URL formatting without posting',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasPreview = /preview|test|sample|dry.?run/.test(text);
    const hasTweet = /tweet|post/.test(text);
    logger.info(`[PREVIEW_TWEET] Validate: text="${text}", hasPreview=${hasPreview}, hasTweet=${hasTweet}`);
    return hasPreview && hasTweet;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const kit = requireLaunchKit(runtime);
    const allPacks = await kit.store.list();
    
    // Debug: log what we found
    logger.info('[PREVIEW_TWEET] Found packs:', allPacks.length);
    for (const p of allPacks) {
      logger.info(`[PREVIEW_TWEET] Pack: ${p.brand?.ticker}, launch.mint: ${p.launch?.mint}, launch.status: ${p.launch?.status}`);
    }
    
    // Find launched tokens (use same check as tweetAboutTokenAction)
    const launchedPacks = allPacks.filter((p: any) => 
      p.launch?.mint || p.launch?.status === 'launched'
    );
    
    logger.info('[PREVIEW_TWEET] Launched packs:', launchedPacks.length);
    
    if (launchedPacks.length === 0) {
      await callback({ text: '❌ No launched tokens found. Launch a token first!' });
      return { text: 'No tokens', success: false };
    }
    
    // Find specific token or use first launched
    let targetPack = launchedPacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    ) || launchedPacks[0];
    
    const { generateAITweet } = await import('../services/xMarketing.ts');
    
    // Build TokenContext matching what generateAITweet expects
    const tokenContext = {
      name: targetPack.brand?.name || 'Unknown',
      ticker: targetPack.brand?.ticker || 'UNKNOWN',
      mint: targetPack.launch?.mint || '',
      pumpUrl: `https://pump.fun/coin/${targetPack.launch?.mint}`,
      description: targetPack.brand?.description,
      telegramUrl: targetPack.tg?.invite_link,
      launchDate: targetPack.launch?.launched_at,
    };
    
    const result = await generateAITweet(tokenContext, 'chart_callout');
    
    // Show the generated tweet - simplified format to avoid message bus issues
    const previewText = `Preview Tweet for $${targetPack.brand?.ticker} (${result.text.length} chars):\n\n${result.text}`;
    
    await callback({ text: previewText });
    
    return { text: 'Preview generated', success: true, data: { preview: result.text } };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'preview tweet' } },
      { name: 'eliza', content: { text: '📝 Preview Tweet for $RUG...', actions: ['PREVIEW_TWEET'] } },
    ],
    [
      { name: 'user', content: { text: 'test a tweet for GPTRug' } },
      { name: 'eliza', content: { text: '📝 Preview Tweet for $RUG...', actions: ['PREVIEW_TWEET'] } },
    ],
  ],
};

export const xMarketingActions = [
  tweetAboutTokenAction,
  scheduleMarketingAction,
  viewScheduledTweetsAction,
  cancelMarketingAction,
  regenerateScheduledTweetsAction,
  previewTweetAction,
];
