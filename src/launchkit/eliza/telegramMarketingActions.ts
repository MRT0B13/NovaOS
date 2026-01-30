import { Action, type IAgentRuntime, type Memory, type State, type HandlerCallback, type ActionResult, logger } from '@elizaos/core';
import { scheduleTGMarketing, getPendingPostsForToken, getAllPosts, cancelTGMarketing, regeneratePendingTGPosts } from '../services/telegramScheduler.ts';
import { generateAITGPost, suggestTGPostType, type TokenContext } from '../services/telegramMarketing.ts';
import { generateMeme, isMemeGenerationAvailable } from '../services/memeGenerator.ts';

// Helper to get LaunchKit from runtime
function requireLaunchKit(runtime: IAgentRuntime) {
  const kit = (runtime as any).getLaunchKit?.();
  if (!kit?.store) {
    throw new Error('LaunchKit not initialized');
  }
  return kit;
}

/**
 * SCHEDULE_TG_MARKETING - Schedule Telegram marketing posts for a token
 */
export const scheduleTGMarketingAction: Action = {
  name: 'SCHEDULE_TG_MARKETING',
  similes: ['SCHEDULE_TELEGRAM_MARKETING', 'TG_MARKETING', 'TELEGRAM_SHILLING'],
  description: 'Schedule automated marketing posts to a token\'s Telegram group',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasSchedule = /schedule|start|setup|create/.test(text);
    const hasTG = /telegram|tg/.test(text);
    const hasMarketing = /marketing|shill|post|promo/.test(text);
    return hasSchedule && (hasTG || hasMarketing);
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
    
    // Find launched tokens with TG linked
    const eligiblePacks = allPacks.filter((p: any) => 
      (p.launch?.mint || p.launch?.status === 'launched') &&
      p.tg?.telegram_chat_id
    );
    
    if (eligiblePacks.length === 0) {
      await callback({ 
        text: '❌ No launched tokens with linked Telegram groups found. Link a TG group first!' 
      });
      return { text: 'No eligible tokens', success: false };
    }
    
    // Find specific token or use first
    let targetPack = eligiblePacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    ) || eligiblePacks[0];
    
    // Parse days and posts per day (defaults: 5 days, 4 posts/day)
    const daysMatch = text.match(/(\d+)\s*days?/);
    const postsMatch = text.match(/(\d+)\s*posts?\s*(per|a|\/)\s*day/);
    const days = daysMatch ? parseInt(daysMatch[1]) : 5;
    const postsPerDay = postsMatch ? parseInt(postsMatch[1]) : 4;
    
    try {
      const result = await scheduleTGMarketing(targetPack, days, postsPerDay);
      
      await callback({
        text: `✅ **Telegram Marketing Scheduled for $${targetPack.brand?.ticker}**\n\n` +
          `📱 Group: ${targetPack.tg?.telegram_chat_id}\n` +
          `📅 Duration: ${days} days\n` +
          `📝 Total posts: ${result.scheduled}\n` +
          `⏰ First post: ${new Date(result.firstPost).toLocaleString()}\n` +
          `🏁 Last post: ${new Date(result.lastPost).toLocaleString()}\n\n` +
          `Posts will be sent automatically as the mascot persona!`,
      });
      
      return { text: 'TG marketing scheduled', success: true, data: result };
    } catch (error: any) {
      await callback({ text: `❌ Failed to schedule: ${error.message}` });
      return { text: 'Scheduling failed', success: false };
    }
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'schedule telegram marketing for GPTRug' } },
      { name: 'eliza', content: { text: '✅ Telegram Marketing Scheduled for $RUG - 20 posts over 5 days', actions: ['SCHEDULE_TG_MARKETING'] } },
    ],
    [
      { name: 'user', content: { text: 'start tg shilling for 7 days' } },
      { name: 'eliza', content: { text: '✅ Telegram Marketing Scheduled - 28 posts over 7 days', actions: ['SCHEDULE_TG_MARKETING'] } },
    ],
  ],
};

/**
 * VIEW_TG_SCHEDULE - View scheduled Telegram posts
 */
export const viewTGScheduleAction: Action = {
  name: 'VIEW_TG_SCHEDULE',
  similes: ['SHOW_TG_POSTS', 'LIST_TG_MARKETING', 'TG_QUEUE'],
  description: 'View scheduled Telegram marketing posts',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasView = /show|view|list|see|check/.test(text);
    const hasTG = /telegram|tg/.test(text);
    const hasSchedule = /schedule|post|queue|marketing/.test(text);
    return hasView && hasTG && hasSchedule;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Extract ticker if specified
    const tickerMatch = text.match(/\$([A-Z]+)/i) || text.match(/for\s+(\w+)/i);
    const ticker = tickerMatch ? tickerMatch[1] : undefined;
    
    const pending = await getPendingPostsForToken(ticker);
    
    if (pending.length === 0) {
      await callback({ 
        text: ticker 
          ? `📭 No pending Telegram posts for $${ticker.toUpperCase()}`
          : '📭 No pending Telegram posts scheduled'
      });
      return { text: 'No pending posts', success: true };
    }
    
    // Group by token
    const byToken = new Map<string, typeof pending>();
    for (const post of pending) {
      const existing = byToken.get(post.tokenTicker) || [];
      existing.push(post);
      byToken.set(post.tokenTicker, existing);
    }
    
    let response = `📱 **Scheduled Telegram Posts**\n\n`;
    
    for (const [tok, posts] of byToken) {
      response += `**$${tok}** - ${posts.length} pending\n`;
      
      // Show next 5
      const upcoming = posts
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
        .slice(0, 5);
      
      for (const post of upcoming) {
        const time = new Date(post.scheduledFor).toLocaleString();
        const preview = post.text.substring(0, 40) + (post.text.length > 40 ? '...' : '');
        response += `  • ${post.type} @ ${time}\n    "${preview}"\n`;
      }
      
      if (posts.length > 5) {
        response += `  ... and ${posts.length - 5} more\n`;
      }
      response += '\n';
    }
    
    await callback({ text: response });
    return { text: 'Showed schedule', success: true, data: { count: pending.length } };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'show telegram schedule' } },
      { name: 'eliza', content: { text: '📱 Scheduled Telegram Posts...', actions: ['VIEW_TG_SCHEDULE'] } },
    ],
  ],
};

/**
 * CANCEL_TG_MARKETING - Cancel scheduled Telegram posts
 */
export const cancelTGMarketingAction: Action = {
  name: 'CANCEL_TG_MARKETING',
  similes: ['STOP_TG_MARKETING', 'CANCEL_TG_POSTS', 'DISABLE_TG_SHILLING'],
  description: 'Cancel scheduled Telegram marketing posts for a token',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasCancel = /cancel|stop|disable|remove/.test(text);
    const hasTG = /telegram|tg/.test(text);
    const hasMarketing = /marketing|post|shill|schedule/.test(text);
    return hasCancel && (hasTG || hasMarketing);
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
    
    const cancelled = cancelTGMarketing(targetPack.brand?.ticker || '');
    
    await callback({
      text: `✅ Cancelled ${cancelled} scheduled Telegram posts for **$${targetPack.brand?.ticker}**`,
    });
    
    return { text: 'TG marketing cancelled', success: true, data: { cancelled } };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'cancel telegram marketing for GPTRug' } },
      { name: 'eliza', content: { text: '✅ Cancelled 18 scheduled Telegram posts for $RUG', actions: ['CANCEL_TG_MARKETING'] } },
    ],
  ],
};

/**
 * PREVIEW_TG_POST - Generate a preview TG post without sending
 */
export const previewTGPostAction: Action = {
  name: 'PREVIEW_TG_POST',
  similes: ['TEST_TG_POST', 'SAMPLE_TG_MESSAGE'],
  description: 'Generate a sample Telegram post to preview without sending',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasPreview = /preview|test|sample/.test(text);
    const hasTG = /telegram|tg/.test(text);
    const hasPost = /post|message/.test(text);
    return hasPreview && hasTG && hasPost;
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
    
    // Find launched tokens with TG
    const eligiblePacks = allPacks.filter((p: any) => 
      (p.launch?.mint || p.launch?.status === 'launched') &&
      p.tg?.telegram_chat_id
    );
    
    if (eligiblePacks.length === 0) {
      await callback({ text: '❌ No launched tokens with linked Telegram groups found.' });
      return { text: 'No eligible tokens', success: false };
    }
    
    // Find specific token or use first
    let targetPack = eligiblePacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    ) || eligiblePacks[0];
    
    const tokenContext: TokenContext = {
      name: targetPack.brand?.name || 'Unknown',
      ticker: targetPack.brand?.ticker || 'UNKNOWN',
      mint: targetPack.launch?.mint || '',
      pumpUrl: `https://pump.fun/coin/${targetPack.launch?.mint}`,
      description: targetPack.brand?.description,
      mascot: (targetPack.brand as any)?.mascot?.name,
      mascotPersonality: (targetPack.brand as any)?.mascot?.personality,
      telegramUrl: targetPack.tg?.invite_link,
      websiteUrl: targetPack.links?.website,
    };
    
    const postType = suggestTGPostType();
    const result = await generateAITGPost(tokenContext, postType);
    
    await callback({
      text: `📱 Preview TG Post for $${targetPack.brand?.ticker} (${postType}):\n\n${result.text}`,
    });
    
    return { text: 'Preview generated', success: true, data: { preview: result.text } };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'preview telegram post' } },
      { name: 'eliza', content: { text: '📱 Preview TG Post for $RUG (gm_post)...', actions: ['PREVIEW_TG_POST'] } },
    ],
  ],
};

/**
 * SEND_TG_SHILL - Send a shill message to TG group now
 */
export const sendTGShillAction: Action = {
  name: 'SEND_TG_SHILL',
  similes: ['POST_TO_TG', 'SHILL_TG_NOW', 'TG_POST_NOW'],
  description: 'Send a marketing message to the token\'s Telegram group immediately',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasSend = /send|post|shill/.test(text);
    const hasTG = /telegram|tg/.test(text);
    const hasNow = /now|immediately|quick/.test(text);
    return hasSend && hasTG && hasNow;
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
    
    // Find launched tokens with TG
    const eligiblePacks = allPacks.filter((p: any) => 
      (p.launch?.mint || p.launch?.status === 'launched') &&
      p.tg?.telegram_chat_id
    );
    
    if (eligiblePacks.length === 0) {
      await callback({ text: '❌ No launched tokens with linked Telegram groups found.' });
      return { text: 'No eligible tokens', success: false };
    }
    
    // Find specific token
    let targetPack = eligiblePacks.find((p: any) => 
      text.includes(p.brand?.name?.toLowerCase() || '') ||
      text.includes(p.brand?.ticker?.toLowerCase() || '')
    ) || eligiblePacks[0];
    
    const tokenContext: TokenContext = {
      name: targetPack.brand?.name || 'Unknown',
      ticker: targetPack.brand?.ticker || 'UNKNOWN',
      mint: targetPack.launch?.mint || '',
      pumpUrl: `https://pump.fun/coin/${targetPack.launch?.mint}`,
      description: targetPack.brand?.description,
      mascot: (targetPack.brand as any)?.mascot?.name,
      mascotPersonality: (targetPack.brand as any)?.mascot?.personality,
      telegramUrl: targetPack.tg?.invite_link,
      websiteUrl: targetPack.links?.website,
    };
    
    const postType = suggestTGPostType();
    const result = await generateAITGPost(tokenContext, postType);
    
    // Try to generate a meme if enabled
    let imageUrl: string | undefined;
    if (isMemeGenerationAvailable()) {
      try {
        const memeResult = await generateMeme(
          tokenContext.name,
          tokenContext.ticker,
          postType,
          result.text.substring(0, 200),
          tokenContext.mascot
        );
        if (memeResult && memeResult.success && memeResult.url) {
          imageUrl = memeResult.url;
          logger.info(`[TGShill] Generated meme for immediate post`);
        }
      } catch (err) {
        logger.warn(`[TGShill] Meme generation failed: ${err}`);
      }
    }
    
    // Post to Telegram
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      await callback({ text: '❌ TELEGRAM_BOT_TOKEN not configured' });
      return { text: 'No bot token', success: false };
    }
    
    try {
      let response;
      
      // Send with image if available
      if (imageUrl) {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: targetPack.tg?.telegram_chat_id,
            photo: imageUrl,
            caption: result.text,
            parse_mode: 'HTML',
          }),
        });
        
        const data = await response.json();
        if (!data.ok) {
          // Fall back to text if image fails
          logger.warn(`[TGShill] Image send failed, falling back to text`);
          imageUrl = undefined;
        } else {
          await callback({
            text: `✅ Posted to $${targetPack.brand?.ticker} Telegram with meme! 🖼️\n\n"${result.text}"`,
          });
          return { text: 'Posted with meme', success: true };
        }
      }
      
      // Text-only fallback
      response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetPack.tg?.telegram_chat_id,
          text: result.text,
          parse_mode: 'HTML',
        }),
      });
      
      const data = await response.json();
      
      if (data.ok) {
        await callback({
          text: `✅ Posted to $${targetPack.brand?.ticker} Telegram!\n\n"${result.text}"`,
        });
        return { text: 'Posted', success: true };
      } else {
        await callback({ text: `❌ Failed to post: ${data.description}` });
        return { text: 'Post failed', success: false };
      }
    } catch (error: any) {
      await callback({ text: `❌ Error: ${error.message}` });
      return { text: 'Error', success: false };
    }
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'shill to telegram now' } },
      { name: 'eliza', content: { text: '✅ Posted to $RUG Telegram!', actions: ['SEND_TG_SHILL'] } },
    ],
  ],
};

export const telegramMarketingActions = [
  scheduleTGMarketingAction,
  viewTGScheduleAction,
  cancelTGMarketingAction,
  previewTGPostAction,
  sendTGShillAction,
];
