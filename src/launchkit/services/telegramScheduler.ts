import { logger } from '@elizaos/core';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { generateAITGPost, generatePostSchedule, TGPostType, TokenContext } from './telegramMarketing.ts';
import { generateMeme, isMemeGenerationAvailable } from './memeGenerator.ts';
import { getTokenPrice } from './priceService.ts';
import { recordTGPostSent } from './systemReporter.ts';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';

/**
 * Telegram Marketing Scheduler
 * 
 * Manages scheduled Telegram posts for token communities
 * Auto-posts at scheduled times using the mascot persona
 * Can attach AI-generated memes when enabled
 */

export interface ScheduledTGPost {
  id: string;
  tokenTicker: string;
  tokenMint: string;
  launchPackId: string;
  telegramChatId: string;
  type: TGPostType;
  text: string;
  imageUrl?: string; // Optional meme image (generated at post time)
  scheduledFor: string; // ISO timestamp
  status: 'pending' | 'posted' | 'failed' | 'cancelled';
  createdAt: string;
  postedAt?: string;
  messageId?: number;
  error?: string;
  // Token context for meme generation at post time
  tokenContext?: {
    name: string;
    ticker: string;
    mascot?: string;
  };
}

const SCHEDULE_FILE = './data/tg_scheduled_posts.json';
let schedulerInterval: NodeJS.Timeout | null = null;
let autoRefillInterval: NodeJS.Timeout | null = null;
let store: LaunchPackStore | null = null;

// Config: Posts per day for autonomous mode
const AUTO_POSTS_PER_DAY = 4;
const MIN_PENDING_POSTS = 5; // Refill when below this threshold
const MIN_POST_GAP_MS = 2 * 60 * 60 * 1000; // Minimum 2 hours between posts to same group

/**
 * Build token context with live price data from DexScreener
 */
async function buildTokenContextWithPrice(launchPack: any): Promise<TokenContext> {
  const mint = launchPack.launch?.mint || '';
  
  // Start with basic context
  const context: TokenContext = {
    name: launchPack.brand?.name || 'Unknown',
    ticker: launchPack.brand?.ticker || 'UNKNOWN',
    mint,
    pumpUrl: mint ? `https://pump.fun/coin/${mint}` : '',
    description: launchPack.brand?.description,
    mascot: launchPack.brand?.mascot?.name || (launchPack.brand as any)?.mascot?.name,
    mascotPersonality: launchPack.brand?.mascot?.personality || (launchPack.brand as any)?.mascot?.personality,
    telegramUrl: launchPack.tg?.invite_link,
    websiteUrl: launchPack.links?.website,
    launchDate: launchPack.launch?.launched_at,
  };
  
  // Fetch live price data if we have a mint
  if (mint) {
    try {
      const priceData = await getTokenPrice(mint);
      if (priceData) {
        context.marketCap = priceData.marketCap ?? undefined;
        context.priceUsd = priceData.priceUsd ?? undefined;
        logger.info(`[TGScheduler] Price data for $${context.ticker}: MC=$${context.marketCap} Price=$${context.priceUsd}`);
      }
    } catch (error) {
      logger.warn(`[TGScheduler] Failed to fetch price for ${mint}:`, error);
    }
  }
  
  return context;
}

// Track last post time per telegram chat to prevent double posting
const lastPostTimes: Map<string, number> = new Map();

/**
 * Load scheduled posts from file
 */
function loadScheduledPosts(): ScheduledTGPost[] {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const data = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.warn('[TGScheduler] Failed to load scheduled posts:', error);
  }
  return [];
}

/**
 * Save scheduled posts to file
 */
function saveScheduledPosts(posts: ScheduledTGPost[]): void {
  try {
    const dir = path.dirname(SCHEDULE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(posts, null, 2));
  } catch (error) {
    logger.error('[TGScheduler] Failed to save scheduled posts:', error);
  }
}

/**
 * Generate a UUID
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Schedule TG marketing for a token
 */
export async function scheduleTGMarketing(
  launchPack: any,
  days: number = 5,
  postsPerDay: number = 4
): Promise<{ scheduled: number; firstPost: string; lastPost: string }> {
  const posts = loadScheduledPosts();
  const schedule = generatePostSchedule(days, postsPerDay);
  
  const telegramChatId = launchPack.tg?.telegram_chat_id;
  if (!telegramChatId) {
    throw new Error('No Telegram group linked to this token');
  }
  
  // Build context with live price data
  const tokenContext = await buildTokenContextWithPrice(launchPack);
  
  const now = new Date();
  const newPosts: ScheduledTGPost[] = [];
  
  for (let i = 0; i < schedule.length; i++) {
    const type = schedule[i];
    const dayOffset = Math.floor(i / postsPerDay);
    const postIndexInDay = i % postsPerDay;
    
    // Spread posts throughout day with at least 3 hour gaps
    // For 4 posts: 8am, 12pm, 4pm, 8pm (4 hour gaps)
    const baseHours = [8, 12, 16, 20];
    const postHour = baseHours[postIndexInDay] || 12;
    
    // Add some randomness (0-45 minutes) to make it look natural
    const randomMinutes = Math.floor(Math.random() * 45);
    
    const scheduledTime = new Date(now);
    scheduledTime.setDate(scheduledTime.getDate() + dayOffset);
    scheduledTime.setHours(postHour, randomMinutes, 0, 0);
    
    // Skip if in the past
    if (scheduledTime <= now) {
      scheduledTime.setDate(scheduledTime.getDate() + 1);
    }
    
    // Generate post content
    const result = await generateAITGPost(tokenContext, type);
    
    // Determine if this post should have a meme (but generate at post time, not now!)
    // DALL-E URLs expire after ~1 hour, so we can't pre-generate
    // Meme-first post types always get memes, others get 50% chance
    const memePostTypes: TGPostType[] = ['meme_drop', 'community_hype', 'chart_update', 'milestone', 'holder_appreciation', 'gm_post'];
    const shouldHaveMeme = memePostTypes.includes(type) || Math.random() < 0.5;
    
    const post: ScheduledTGPost = {
      id: generateId(),
      tokenTicker: tokenContext.ticker,
      tokenMint: tokenContext.mint,
      launchPackId: launchPack.id,
      telegramChatId,
      type,
      text: result.text,
      // Store token context for meme generation at post time
      tokenContext: shouldHaveMeme && isMemeGenerationAvailable() ? {
        name: tokenContext.name,
        ticker: tokenContext.ticker,
        mascot: tokenContext.mascot,
      } : undefined,
      scheduledFor: scheduledTime.toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    
    newPosts.push(post);
  }
  
  // Add to existing posts
  posts.push(...newPosts);
  saveScheduledPosts(posts);
  
  logger.info(`[TGScheduler] Scheduled ${newPosts.length} posts for $${tokenContext.ticker}`);
  
  return {
    scheduled: newPosts.length,
    firstPost: newPosts[0]?.scheduledFor || '',
    lastPost: newPosts[newPosts.length - 1]?.scheduledFor || '',
  };
}

/**
 * Get pending posts for a token
 */
export function getPendingPosts(ticker?: string): ScheduledTGPost[] {
  const posts = loadScheduledPosts();
  return posts.filter(p => 
    p.status === 'pending' && 
    (!ticker || p.tokenTicker.toLowerCase() === ticker.toLowerCase())
  );
}

/**
 * Get all posts (for display)
 */
export function getAllPosts(ticker?: string): ScheduledTGPost[] {
  const posts = loadScheduledPosts();
  if (!ticker) return posts;
  return posts.filter(p => p.tokenTicker.toLowerCase() === ticker.toLowerCase());
}

/**
 * Cancel all pending posts for a token
 */
export function cancelTGMarketing(ticker: string): number {
  const posts = loadScheduledPosts();
  let cancelled = 0;
  
  for (const post of posts) {
    if (post.tokenTicker.toLowerCase() === ticker.toLowerCase() && post.status === 'pending') {
      post.status = 'cancelled';
      cancelled++;
    }
  }
  
  saveScheduledPosts(posts);
  logger.info(`[TGScheduler] Cancelled ${cancelled} posts for $${ticker}`);
  return cancelled;
}

/**
 * Post a message to Telegram (with optional image)
 * Handles both remote URLs and local file paths
 */
async function postToTelegram(
  chatId: string, 
  text: string, 
  imageUrl?: string
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { success: false, error: 'No TELEGRAM_BOT_TOKEN configured' };
  }
  
  try {
    // If we have an image, use sendPhoto with caption
    if (imageUrl) {
      // Check if it's a local file (localhost URL or file path)
      const isLocalUrl = imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1');
      
      if (isLocalUrl) {
        // Extract file path from localhost URL and upload file directly
        const filename = imageUrl.split('/').pop();
        const localPath = path.join(homedir(), '.eliza', 'data', 'uploads', 'memes', filename || '');
        
        if (fs.existsSync(localPath)) {
          // Read file and upload via multipart/form-data
          const fileBuffer = fs.readFileSync(localPath);
          const formData = new FormData();
          formData.append('chat_id', chatId);
          formData.append('caption', text);
          formData.append('parse_mode', 'HTML');
          formData.append('photo', new Blob([fileBuffer], { type: 'image/png' }), filename);
          
          const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: 'POST',
            body: formData,
          });
          
          const data = await response.json();
          
          if (data.ok) {
            return { success: true, messageId: data.result?.message_id };
          } else {
            logger.warn(`[TGScheduler] File upload failed: ${data.description}, falling back to text`);
          }
        } else {
          logger.warn(`[TGScheduler] Local file not found: ${localPath}`);
        }
      } else {
        // Remote URL - use direct URL method
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: imageUrl,
            caption: text,
            parse_mode: 'HTML',
          }),
        });
        
        const data = await response.json();
        
        if (data.ok) {
          return { success: true, messageId: data.result?.message_id };
        } else {
          // Fall back to text-only if image fails
          logger.warn(`[TGScheduler] Image send failed: ${data.description}, falling back to text`);
        }
      }
    }
    
    // Text-only message
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    
    const data = await response.json();
    
    if (data.ok) {
      return { success: true, messageId: data.result?.message_id };
    } else {
      return { success: false, error: data.description || 'Unknown Telegram error' };
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to post' };
  }
}

// Heartbeat counter for TG scheduler
let tgHeartbeatCounter = 0;

/**
 * Check for due posts and send them
 */
async function checkAndPostDue(): Promise<void> {
  const posts = loadScheduledPosts();
  const now = new Date();
  let updated = false;
  
  // Log heartbeat every 5 minutes (every 5th call since we run every minute)
  tgHeartbeatCounter++;
  const pendingCount = posts.filter(p => p.status === 'pending').length;
  
  // Sort by scheduled time so we process in order
  const duePosts = posts
    .filter(p => p.status === 'pending' && new Date(p.scheduledFor) <= now)
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
  
  // Heartbeat log every 5 minutes
  if (tgHeartbeatCounter % 5 === 0) {
    if (duePosts.length > 0) {
      const nextDue = duePosts[0];
      logger.info(`[TGScheduler] 💓 Heartbeat: ${pendingCount} pending, ${duePosts.length} due (next: $${nextDue.tokenTicker})`);
    } else {
      // Find next scheduled post
      const nextPending = posts
        .filter(p => p.status === 'pending')
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())[0];
      
      if (nextPending) {
        const minsUntil = Math.ceil((new Date(nextPending.scheduledFor).getTime() - now.getTime()) / 60000);
        logger.info(`[TGScheduler] 💓 Heartbeat: ${pendingCount} pending, next in ${minsUntil} min ($${nextPending.tokenTicker})`);
      } else {
        logger.info(`[TGScheduler] 💓 Heartbeat: No pending posts`);
      }
    }
  }
  
  for (const post of duePosts) {
    // Enforce minimum gap between posts to the same group
    const lastPostTime = lastPostTimes.get(post.telegramChatId);
    if (lastPostTime) {
      const timeSinceLastPost = now.getTime() - lastPostTime;
      if (timeSinceLastPost < MIN_POST_GAP_MS) {
        const waitMinutes = Math.ceil((MIN_POST_GAP_MS - timeSinceLastPost) / 60000);
        logger.info(`[TGScheduler] Skipping $${post.tokenTicker} post - need ${waitMinutes}min gap (min 2h between posts)`);
        continue; // Skip this post for now, will retry next tick
      }
    }
    
    // Find this post in the original array
    const postIndex = posts.findIndex(p => p.id === post.id);
    if (postIndex === -1) continue;
    
    // Generate meme at post time (DALL-E URLs expire after ~1 hour)
    let imageUrl: string | undefined;
    if (post.tokenContext && isMemeGenerationAvailable()) {
      try {
        logger.info(`[TGScheduler] Generating meme for $${post.tokenTicker} at post time...`);
        const memeResult = await generateMeme(
          post.tokenContext.name,
          post.tokenContext.ticker,
          post.type,
          post.text.substring(0, 200),
          post.tokenContext.mascot
        );
        if (memeResult && memeResult.success && memeResult.url) {
          imageUrl = memeResult.url;
          logger.info(`[TGScheduler] ✅ Generated meme for ${post.type} post`);
        }
      } catch (err) {
        logger.warn(`[TGScheduler] Meme generation failed, proceeding without image: ${err}`);
      }
    }
    
    // Time to post!
    const hasMeme = !!imageUrl;
    logger.info(`[TGScheduler] Posting scheduled message for $${post.tokenTicker}${hasMeme ? ' (with image)' : ''}`);
    
    let result = await postToTelegram(post.telegramChatId, post.text, imageUrl);
    
    // Handle supergroup migration error - try to get new chat ID
    if (!result.success && result.error?.includes('upgraded to a supergroup')) {
      logger.warn(`[TGScheduler] Group migrated to supergroup, attempting to update chat ID...`);
      const newChatId = await tryGetMigratedChatId(post.telegramChatId);
      if (newChatId) {
        logger.info(`[TGScheduler] Found new chat ID: ${newChatId}, retrying...`);
        result = await postToTelegram(newChatId, post.text, imageUrl);
        
        // Update all pending posts for this token with new chat ID
        if (result.success) {
          for (const p of posts) {
            if (p.telegramChatId === post.telegramChatId) {
              p.telegramChatId = newChatId;
            }
          }
          // Also update the LaunchPack in store
          await updateLaunchPackChatId(post.launchPackId, newChatId);
        }
      }
    }
    
    if (result.success) {
      posts[postIndex].status = 'posted';
      posts[postIndex].postedAt = new Date().toISOString();
      posts[postIndex].messageId = result.messageId;
      posts[postIndex].imageUrl = imageUrl; // Store the URL that was used
      // Track successful post time to enforce minimum gap
      lastPostTimes.set(post.telegramChatId, now.getTime());
      logger.info(`[TGScheduler] ✅ Posted to TG: ${post.text.substring(0, 50)}...`);
      
      // Record for system reporter
      recordTGPostSent();
      
      // Notify Nova channel
      try {
        const { announceMarketingPost } = await import('./novaChannel.ts');
        await announceMarketingPost('telegram', post.tokenTicker, post.text);
      } catch {
        // Non-fatal
      }
    } else {
      posts[postIndex].status = 'failed';
      posts[postIndex].error = result.error;
      logger.error(`[TGScheduler] ❌ Failed to post: ${result.error}`);
    }
    
    updated = true;
    
    // Small delay between posts to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }
  
  if (updated) {
    saveScheduledPosts(posts);
  }
}

/**
 * Try to get the new chat ID after a group was migrated to supergroup
 */
async function tryGetMigratedChatId(oldChatId: string): Promise<string | null> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;
  
  try {
    // Try to get chat info - if migrated, the API sometimes returns the new ID
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: oldChatId }),
    });
    
    const data = await response.json();
    
    // Check for migrate_to_chat_id in the response
    if (data.parameters?.migrate_to_chat_id) {
      return String(data.parameters.migrate_to_chat_id);
    }
    
    // Check if we got a new ID in the result
    if (data.result?.id && String(data.result.id) !== oldChatId) {
      return String(data.result.id);
    }
    
    return null;
  } catch (err) {
    logger.warn(`[TGScheduler] Failed to get migrated chat ID: ${err}`);
    return null;
  }
}

/**
 * Update LaunchPack's telegram_chat_id after migration
 */
async function updateLaunchPackChatId(launchPackId: string, newChatId: string): Promise<void> {
  if (!store) return;
  
  try {
    const pack = await store.get(launchPackId);
    if (pack && pack.tg) {
      pack.tg.telegram_chat_id = newChatId;
      await store.update(launchPackId, { tg: pack.tg });
      logger.info(`[TGScheduler] ✅ Updated LaunchPack ${launchPackId} with new chat ID: ${newChatId}`);
    }
  } catch (err) {
    logger.warn(`[TGScheduler] Failed to update LaunchPack chat ID: ${err}`);
  }
}

/**
 * Start the TG scheduler
 */
export function startTGScheduler(launchPackStore: LaunchPackStore): void {
  store = launchPackStore;
  
  if (schedulerInterval) {
    logger.info('[TGScheduler] Scheduler already running');
    return;
  }
  
  // Initialize lastPostTimes from existing posted messages to prevent double-posting after restart
  const posts = loadScheduledPosts();
  for (const post of posts) {
    if (post.status === 'posted' && post.postedAt) {
      const postedTime = new Date(post.postedAt).getTime();
      const existingTime = lastPostTimes.get(post.telegramChatId);
      if (!existingTime || postedTime > existingTime) {
        lastPostTimes.set(post.telegramChatId, postedTime);
      }
    }
  }
  logger.info(`[TGScheduler] Initialized post timing for ${lastPostTimes.size} chats`);
  
  // Check for due posts every minute
  schedulerInterval = setInterval(async () => {
    try {
      await checkAndPostDue();
    } catch (error) {
      logger.error('[TGScheduler] Error in scheduler:', error);
    }
  }, 60 * 1000);
  
  // Auto-refill posts every hour
  autoRefillInterval = setInterval(async () => {
    try {
      await autoScheduleAllTokens(launchPackStore);
    } catch (error) {
      logger.error('[TGScheduler] Error in auto-refill:', error);
    }
  }, 60 * 60 * 1000); // Every hour
  
  // Initial checks
  checkAndPostDue().catch(err => logger.error('[TGScheduler] Initial check failed:', err));
  
  // Auto-schedule all tokens on startup (with delay to let things initialize)
  setTimeout(() => {
    autoScheduleAllTokens(launchPackStore).catch(err => 
      logger.error('[TGScheduler] Initial auto-schedule failed:', err)
    );
  }, 10000); // 10 second delay
  
  logger.info('[TGScheduler] Started autonomous TG marketing scheduler');
}

/**
 * Auto-schedule marketing for ALL launched tokens with TG groups
 * This runs on startup and periodically to keep queues filled
 */
async function autoScheduleAllTokens(launchPackStore: LaunchPackStore): Promise<void> {
  try {
    const allPacks = await launchPackStore.list();
    logger.info(`[TGScheduler] Checking ${allPacks.length} packs for auto-scheduling`);
    
    // Find all launched tokens with TG groups
    const eligiblePacks = allPacks.filter((p: any) => 
      (p.launch?.mint || p.launch?.status === 'launched') &&
      p.tg?.telegram_chat_id
    );
    
    if (eligiblePacks.length === 0) {
      logger.info('[TGScheduler] No eligible tokens for auto-scheduling (need launch.mint AND tg.telegram_chat_id)');
      return;
    }
    
    logger.info(`[TGScheduler] Found ${eligiblePacks.length} eligible tokens for TG marketing`);
    
    const posts = loadScheduledPosts();
    logger.info(`[TGScheduler] Loaded ${posts.length} existing scheduled posts from file`);
    
    
    for (const pack of eligiblePacks) {
      const ticker = pack.brand?.ticker || 'UNKNOWN';
      
      // Count pending posts for this token
      const pendingCount = posts.filter(p => 
        p.tokenTicker === ticker && 
        p.status === 'pending'
      ).length;
      
      // If below threshold, schedule more
      if (pendingCount < MIN_PENDING_POSTS) {
        logger.info(`[TGScheduler] Auto-scheduling for $${ticker} (${pendingCount} pending, need ${MIN_PENDING_POSTS})`);
        
        try {
          // Schedule 3 days worth of posts
          const result = await scheduleTGMarketing(pack, 3, AUTO_POSTS_PER_DAY);
          logger.info(`[TGScheduler] ✅ Auto-scheduled ${result.scheduled} posts for $${ticker}`);
        } catch (err: any) {
          logger.warn(`[TGScheduler] Failed to auto-schedule for $${ticker}: ${err.message}`);
        }
      }
    }
  } catch (error) {
    logger.error('[TGScheduler] Auto-schedule error:', error);
  }
}

/**
 * Stop the TG scheduler
 */
export function stopTGScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (autoRefillInterval) {
    clearInterval(autoRefillInterval);
    autoRefillInterval = null;
  }
  logger.info('[TGScheduler] Stopped TG marketing scheduler');
}

/**
 * Regenerate pending posts with fresh content
 */
export async function regeneratePendingTGPosts(launchPackStore: LaunchPackStore): Promise<{ regenerated: number; failed: number }> {
  const posts = loadScheduledPosts();
  const pendingPosts = posts.filter(p => p.status === 'pending');
  
  let regenerated = 0;
  let failed = 0;
  
  // Group by launchPackId
  const byPack = new Map<string, ScheduledTGPost[]>();
  for (const post of pendingPosts) {
    const existing = byPack.get(post.launchPackId) || [];
    existing.push(post);
    byPack.set(post.launchPackId, existing);
  }
  
  for (const [packId, packPosts] of byPack) {
    try {
      const pack = await launchPackStore.get(packId);
      if (!pack) {
        failed += packPosts.length;
        continue;
      }
      
      // Build context with live price data
      const tokenContext = await buildTokenContextWithPrice(pack);
      
      for (const post of packPosts) {
        try {
          const result = await generateAITGPost(tokenContext, post.type);
          post.text = result.text;
          regenerated++;
        } catch (err) {
          failed++;
        }
      }
    } catch (err) {
      failed += packPosts.length;
    }
  }
  
  saveScheduledPosts(posts);
  logger.info(`[TGScheduler] Regenerated ${regenerated} TG posts, ${failed} failed`);
  
  return { regenerated, failed };
}

export default {
  scheduleTGMarketing,
  getPendingPosts,
  getAllPosts,
  cancelTGMarketing,
  startTGScheduler,
  stopTGScheduler,
  regeneratePendingTGPosts,
};
