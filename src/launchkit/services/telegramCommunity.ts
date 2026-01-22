/**
 * Telegram Community Service
 * Handles community engagement, post-launch announcements, and natural conversation
 * Works with ElizaOS Telegram plugin (uses roomId instead of direct chat_id)
 */

import { getEnv } from '../env.ts';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { LaunchPack } from '../model/launchPack.ts';
import type { IAgentRuntime } from '@elizaos/core';

interface TGMessage {
  message_id: number;
  chat: {
    id: number;
    title?: string;
    type: string;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  text?: string;
  date: number;
}

interface SendMessageResult {
  message_id: number;
  chat: { id: number };
}

/**
 * Cache for Telegram user IDs - maps entityId/name to Telegram user info
 * This is needed because ElizaOS doesn't pass through the numeric user_id
 */
interface TelegramUserInfo {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  chatId: string;
  messageId?: number;
  timestamp: number;
}

// Global cache - keyed by chatId:name for lookup
const telegramUserCache = new Map<string, TelegramUserInfo>();

// Also cache by entityId for direct lookup
const entityToTelegramUser = new Map<string, TelegramUserInfo>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  for (const [key, info] of telegramUserCache) {
    if (now - info.timestamp > maxAge) {
      telegramUserCache.delete(key);
    }
  }
  for (const [key, info] of entityToTelegramUser) {
    if (now - info.timestamp > maxAge) {
      entityToTelegramUser.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Store Telegram user info when we receive a message
 * Call this from message handlers to cache the user_id
 */
export function cacheTelegramUser(
  chatId: string, 
  userInfo: { id: number; username?: string; firstName?: string; lastName?: string },
  messageId?: number,
  entityId?: string
): void {
  const info: TelegramUserInfo = {
    ...userInfo,
    chatId,
    messageId,
    timestamp: Date.now(),
  };
  
  // Cache by chat:name (lowercase for matching)
  const name = userInfo.firstName || userInfo.username || String(userInfo.id);
  const cacheKey = `${chatId}:${name.toLowerCase()}`;
  telegramUserCache.set(cacheKey, info);
  
  // Also cache by username if available
  if (userInfo.username) {
    telegramUserCache.set(`${chatId}:@${userInfo.username.toLowerCase()}`, info);
  }
  
  // Cache by entityId if provided
  if (entityId) {
    entityToTelegramUser.set(entityId, info);
  }
  
  console.log(`[TG_CACHE] Cached user ${userInfo.id} (${name}) for chat ${chatId}`);
}

/**
 * Look up a Telegram user ID by name/username in a chat
 */
export function lookupTelegramUser(chatId: string, nameOrUsername: string): TelegramUserInfo | undefined {
  const key = `${chatId}:${nameOrUsername.toLowerCase()}`;
  return telegramUserCache.get(key);
}

/**
 * Look up a Telegram user ID by entityId
 */
export function lookupTelegramUserByEntity(entityId: string): TelegramUserInfo | undefined {
  return entityToTelegramUser.get(entityId);
}

/**
 * Get all cached users for debugging
 */
export function getAllCachedUsers(): Map<string, TelegramUserInfo> {
  return new Map(telegramUserCache);
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

async function tgApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || !json?.ok) {
    throw errorWithCode('TG_API_ERROR', `Telegram ${method} failed: ${json?.description || 'Unknown error'}`);
  }
  return json.result as T;
}

export class TelegramCommunityService {
  private botToken: string | undefined;
  private runtime?: IAgentRuntime;
  
  constructor(private store: LaunchPackStore, runtime?: IAgentRuntime) {
    const env = getEnv();
    this.botToken = env.TG_BOT_TOKEN;
    this.runtime = runtime;
  }
  
  /**
   * Set the runtime (for accessing Telegram client)
   */
  setRuntime(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }
  
  /**
   * Check if TG is configured
   */
  isConfigured(): boolean {
    return Boolean(this.botToken);
  }
  
  /**
   * Get multiple chat_id formats to try
   * Telegram supergroups sometimes need different formats
   */
  private getChatIdVariants(chatId: string): string[] {
    const variants: string[] = [chatId];
    
    if (/^-?\d+$/.test(chatId)) {
      const numericId = chatId.replace('-', '');
      
      // If it has -100 prefix, also try without it
      if (chatId.startsWith('-100') && numericId.length > 10) {
        variants.push('-' + numericId.slice(3)); // Remove the 100 part
      }
      // If it doesn't have -100, try adding it (for supergroups)
      else if (chatId.startsWith('-') && !chatId.startsWith('-100')) {
        variants.push('-100' + numericId);
      }
    }
    
    return variants;
  }
  
  /**
   * Try a Telegram API call with multiple chat_id formats
   */
  private async tryWithChatIdVariants<T>(
    method: string, 
    baseChatId: string, 
    buildParams: (chatId: string) => Record<string, unknown>
  ): Promise<T> {
    const variants = this.getChatIdVariants(baseChatId);
    let lastError: any = null;
    
    for (const chatId of variants) {
      try {
        console.log(`[TG_COMMUNITY] Trying ${method} with chat_id: ${chatId}`);
        const result = await tgApi<T>(this.botToken!, method, buildParams(chatId));
        return result;
      } catch (err: any) {
        lastError = err;
        console.log(`[TG_COMMUNITY] ${method} failed with chat_id ${chatId}: ${err.message}`);
        // Only continue if it's a "chat not found" error
        if (!err.message?.includes('chat not found') && !err.message?.includes('Bad Request')) {
          throw err;
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Convert ElizaOS roomId to real Telegram chat_id
   * Looks up the chat_id from our LaunchPack database
   */
  async getRealChatId(roomId: string): Promise<string | null> {
    const packs = await this.store.list();
    const pack = packs.find((p: any) => p.tg?.chat_id === roomId);
    return pack?.tg?.telegram_chat_id || null;
  }
  
  /**
   * Send a message to a Telegram chat
   * Converts roomId to real chat_id and uses direct Telegram API
   */
  async sendMessage(roomId: string, text: string, options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    disablePreview?: boolean;
    replyToMessageId?: number;
  }): Promise<SendMessageResult> {
    if (!this.botToken) {
      throw errorWithCode('TG_NOT_CONFIGURED', 'TG_BOT_TOKEN not configured');
    }
    
    // Convert roomId to real Telegram chat_id
    const chatId = await this.getRealChatId(roomId);
    if (!chatId) {
      throw errorWithCode('TG_CHAT_NOT_FOUND', `No Telegram chat_id found for roomId: ${roomId}`);
    }
    
    return tgApi<SendMessageResult>(this.botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options?.parseMode,
      disable_web_page_preview: options?.disablePreview ?? false,
      reply_to_message_id: options?.replyToMessageId,
    });
  }
  
  /**
   * Send a message directly to a chat using the actual Telegram chat_id
   * Tries multiple chat_id formats if needed
   */
  async sendMessageToChatId(chatId: string, text: string, options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    disablePreview?: boolean;
    replyToMessageId?: number;
  }): Promise<SendMessageResult> {
    if (!this.botToken) {
      throw errorWithCode('TG_NOT_CONFIGURED', 'TG_BOT_TOKEN not configured');
    }
    
    return this.tryWithChatIdVariants<SendMessageResult>('sendMessage', chatId, (cid) => ({
      chat_id: cid,
      text,
      parse_mode: options?.parseMode,
      disable_web_page_preview: options?.disablePreview ?? false,
      reply_to_message_id: options?.replyToMessageId,
    }));
  }
  
  /**
   * Send a photo message to a Telegram chat
   * Converts roomId to real chat_id and uses direct Telegram API
   */
  async sendPhoto(roomId: string, photoUrl: string, caption?: string, options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  }): Promise<boolean> {
    if (!this.botToken) {
      console.warn('[TG_COMMUNITY] Cannot send photo - no bot token');
      return false;
    }
    
    try {
      // Convert roomId to real Telegram chat_id
      const chatId = await this.getRealChatId(roomId);
      if (!chatId) {
        console.warn(`[TG_COMMUNITY] No chat_id found for roomId: ${roomId}`);
        return false;
      }
      
      await tgApi(this.botToken, 'sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: options?.parseMode,
      });
      return true;
    } catch (err: any) {
      console.error('[TG_COMMUNITY] Failed to send photo:', err);
      return false;
    }
  }
  
  /**
   * Pin a message using direct Telegram API
   * chatId should be the real Telegram chat_id (numeric), not roomId
   */
  async pinMessage(chatId: string, messageId: number, silent: boolean = true): Promise<boolean> {
    if (!this.botToken) {
      console.warn('[TG_COMMUNITY] Cannot pin message - no bot token');
      return false;
    }
    
    try {
      // Try multiple chat_id formats to handle Telegram's format inconsistencies
      const result = await this.tryWithChatIdVariants<{ ok: boolean }>('pinChatMessage', chatId, (cid) => ({
        chat_id: cid,
        message_id: messageId,
        disable_notification: silent,
      }));
      return result !== null;
    } catch (err) {
      console.error('[TG_COMMUNITY] Failed to pin message:', err);
      return false;
    }
  }
  
  /**
   * Send a photo directly to a chat using the actual Telegram chat_id
   */
  async sendPhotoToChatId(chatId: string, photoUrl: string, caption?: string, options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  }): Promise<boolean> {
    if (!this.botToken) {
      console.warn('[TG_COMMUNITY] Cannot send photo - no bot token');
      return false;
    }
    
    try {
      // Try multiple chat_id formats to handle Telegram's format inconsistencies
      const result = await this.tryWithChatIdVariants<{ message_id: number }>('sendPhoto', chatId, (cid) => ({
        chat_id: cid,
        photo: photoUrl,
        caption: caption,
        parse_mode: options?.parseMode,
      }));
      
      return result !== null;
    } catch (err: any) {
      console.error('[TG_COMMUNITY] Failed to send photo:', err);
      return false;
    }
  }
  
  /**
   * Kick (ban) a user from the chat
   * Uses Telegram's banChatMember API
   * @param chatId - The Telegram chat ID
   * @param userId - The Telegram user ID to kick
   * @param untilDate - Optional unix timestamp when the ban will be lifted. If 0 or not specified, user is banned forever
   * @param revokeMessages - Optional, delete all messages from the user in the chat
   */
  async kickUser(chatId: string, userId: number, options?: {
    untilDate?: number;
    revokeMessages?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'TG_BOT_TOKEN not configured' };
    }
    
    try {
      console.log(`[TG_COMMUNITY] Kicking user ${userId} from chat ${chatId}`);
      
      await tgApi(this.botToken, 'banChatMember', {
        chat_id: chatId,
        user_id: userId,
        until_date: options?.untilDate,
        revoke_messages: options?.revokeMessages ?? false,
      });
      
      console.log(`[TG_COMMUNITY] ✅ Successfully kicked user ${userId}`);
      return { success: true };
    } catch (err: any) {
      console.error(`[TG_COMMUNITY] Failed to kick user ${userId}:`, err);
      return { success: false, error: err.message || 'Failed to kick user' };
    }
  }
  
  /**
   * Unban a user (allow them to rejoin)
   */
  async unbanUser(chatId: string, userId: number): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'TG_BOT_TOKEN not configured' };
    }
    
    try {
      await tgApi(this.botToken, 'unbanChatMember', {
        chat_id: chatId,
        user_id: userId,
        only_if_banned: true,
      });
      return { success: true };
    } catch (err: any) {
      console.error(`[TG_COMMUNITY] Failed to unban user ${userId}:`, err);
      return { success: false, error: err.message || 'Failed to unban user' };
    }
  }
  
  /**
   * Delete a message from the chat
   */
  async deleteMessage(chatId: string, messageId: number): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'TG_BOT_TOKEN not configured' };
    }
    
    try {
      await tgApi(this.botToken, 'deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      });
      return { success: true };
    } catch (err: any) {
      console.error(`[TG_COMMUNITY] Failed to delete message ${messageId}:`, err);
      return { success: false, error: err.message || 'Failed to delete message' };
    }
  }
  
  /**
   * Restrict a user (mute them temporarily)
   */
  async restrictUser(chatId: string, userId: number, options?: {
    untilDate?: number; // Unix timestamp
    canSendMessages?: boolean;
    canSendMedia?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'TG_BOT_TOKEN not configured' };
    }
    
    try {
      await tgApi(this.botToken, 'restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        permissions: {
          can_send_messages: options?.canSendMessages ?? false,
          can_send_audios: options?.canSendMedia ?? false,
          can_send_documents: options?.canSendMedia ?? false,
          can_send_photos: options?.canSendMedia ?? false,
          can_send_videos: options?.canSendMedia ?? false,
          can_send_video_notes: options?.canSendMedia ?? false,
          can_send_voice_notes: options?.canSendMedia ?? false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        until_date: options?.untilDate,
      });
      return { success: true };
    } catch (err: any) {
      console.error(`[TG_COMMUNITY] Failed to restrict user ${userId}:`, err);
      return { success: false, error: err.message || 'Failed to restrict user' };
    }
  }
  
  /**
   * Search for a chat member by query (name, username)
   * Uses Telegram's getChatAdministrators for admins, or searchChatMembers if available
   * Note: searchChatMembers is only available in supergroups
   */
  async searchChatMember(chatId: string, query: string): Promise<{ 
    userId?: number; 
    username?: string;
    firstName?: string;
    found: boolean;
  }> {
    if (!this.botToken) {
      return { found: false };
    }
    
    // First check our local cache
    const cached = lookupTelegramUser(chatId, query);
    if (cached) {
      console.log(`[TG_COMMUNITY] Found user in cache: ${cached.id} (${query})`);
      return { 
        userId: cached.id, 
        username: cached.username,
        firstName: cached.firstName,
        found: true 
      };
    }
    
    // Try to search using getChatMember if we have a username
    if (query.startsWith('@')) {
      try {
        const member = await tgApi<any>(this.botToken, 'getChatMember', {
          chat_id: chatId,
          user_id: query, // Can be @username
        });
        if (member?.user?.id) {
          console.log(`[TG_COMMUNITY] Found user by username: ${member.user.id}`);
          return {
            userId: member.user.id,
            username: member.user.username,
            firstName: member.user.first_name,
            found: true
          };
        }
      } catch (err: any) {
        console.log(`[TG_COMMUNITY] getChatMember by username failed:`, err.message);
      }
    }
    
    console.log(`[TG_COMMUNITY] Could not find user "${query}" in chat ${chatId}`);
    return { found: false };
  }
  
  /**
   * Post-launch announcement: Send welcome message and token details with logo
   * Uses roomId to chat_id conversion and direct Telegram API
   * Automatically called after successful pump.fun launch
   */
  async postLaunchAnnouncement(launchPackId: string): Promise<{
    announcementId?: number;
    welcomePinned?: boolean;
    error?: string;
  }> {
    const pack = await this.store.get(launchPackId);
    if (!pack) {
      return { error: 'LaunchPack not found' };
    }
    
    // Use telegram_chat_id (the actual Telegram chat ID) first, fall back to roomId lookup
    const telegramChatId = pack.tg?.telegram_chat_id;
    const roomId = pack.tg?.chat_id; // This is the ElizaOS roomId (UUID)
    
    if (!telegramChatId && !roomId) {
      return { error: 'No Telegram group linked to this LaunchPack' };
    }
    
    // Get the actual Telegram chat ID (use direct ID if available, otherwise look it up)
    const actualChatId = telegramChatId || (roomId ? await this.getRealChatId(roomId) : null);
    if (!actualChatId) {
      return { error: 'Could not resolve Telegram chat ID' };
    }
    
    const results: { announcementId?: number; welcomePinned?: boolean; error?: string } = {};
    
    // 1. Send welcome message if configured
    const welcomeMessage = pack.tg?.pins?.welcome;
    if (welcomeMessage) {
      try {
        const result = await this.sendMessageToChatId(actualChatId, welcomeMessage, { parseMode: 'Markdown' });
        console.log('[TG_COMMUNITY] Sent welcome message');
        // Try to pin it
        if (result.message_id) {
          results.welcomePinned = await this.pinMessage(actualChatId, result.message_id);
        }
      } catch (err: any) {
        console.error('[TG_COMMUNITY] Failed to send welcome message:', err);
        results.error = `Welcome failed: ${err.message}`;
      }
    }
    
    // 2. Send launch announcement with logo as photo + caption
    const announcement = this.formatLaunchAnnouncement(pack);
    const logoUrl = pack.assets?.logo_url;
    
    try {
      if (logoUrl) {
        const success = await this.sendPhotoToChatId(actualChatId, logoUrl, announcement, {
          parseMode: 'HTML',
        });
        if (success) {
          console.log('[TG_COMMUNITY] Sent launch announcement with logo');
          results.announcementId = 1;
        } else {
          // Fallback to text-only
          await this.sendMessageToChatId(actualChatId, announcement, { parseMode: 'HTML' });
          results.announcementId = 1;
        }
      } else {
        // No logo, send text only
        await this.sendMessageToChatId(actualChatId, announcement, { parseMode: 'HTML' });
        console.log('[TG_COMMUNITY] Sent launch announcement (no logo)');
        results.announcementId = 1;
      }
    } catch (err: any) {
      console.error('[TG_COMMUNITY] Failed to send launch announcement:', err);
      results.error = (results.error ? results.error + ' | ' : '') + `Announcement failed: ${err.message}`;
    }
    
    // Update LaunchPack with announcement info
    await this.store.update(launchPackId, {
      ops: {
        ...(pack.ops || {}),
        tg_announcement_sent_at: new Date().toISOString(),
        tg_announcement_message_id: results.announcementId,
        tg_welcome_pinned: results.welcomePinned,
      },
    });
    
    return results;
  }
  
  /**
   * Format the launch announcement message with all token details
   */
  private formatLaunchAnnouncement(pack: LaunchPack): string {
    const name = pack.brand?.name || 'Token';
    const ticker = pack.brand?.ticker || 'TOKEN';
    const description = pack.brand?.description || '';
    const mint = pack.launch?.mint || 'N/A';
    const pumpUrl = pack.launch?.pump_url || `https://pump.fun/${mint}`;
    const dexscreener = mint !== 'N/A' ? `https://dexscreener.com/solana/${mint}` : null;
    
    const lines = [
      `🚀 <b>${name} ($${ticker}) IS LIVE!</b> 🚀`,
      ``,
      `📝 ${description}`,
      ``,
      `━━━━━━━━━━━━━━━━`,
      `💎 <b>Contract Address (CA):</b>`,
      `<code>${mint}</code>`,
      `━━━━━━━━━━━━━━━━`,
      ``,
      `🔗 <b>Quick Links:</b>`,
      `• <a href="${pumpUrl}">Buy on Pump.fun</a>`,
    ];
    
    if (dexscreener) {
      lines.push(`• <a href="${dexscreener}">Chart on DexScreener</a>`);
    }
    
    // Add social links if available
    if (pack.links?.website) {
      lines.push(`• <a href="${pack.links.website}">Website</a>`);
    }
    if (pack.links?.x) {
      lines.push(`• <a href="${pack.links.x}">Twitter/X</a>`);
    }
    
    lines.push(
      ``,
      `━━━━━━━━━━━━━━━━`,
      `⚡️ <b>How to Buy:</b>`,
      `1️⃣ Copy the CA above`,
      `2️⃣ Open pump.fun or your wallet`,
      `3️⃣ Paste CA and swap SOL`,
      ``,
      `🎉 Welcome to the ${name} family! 🎉`,
    );
    
    return lines.join('\n');
  }
  
  /**
   * Generate a community-appropriate response to a message
   * The agent responds in character based on the token's personality
   */
  async generateCommunityResponse(
    pack: LaunchPack,
    userMessage: string,
    userName?: string
  ): Promise<string | null> {
    // This will be called by the community engagement action
    // Returns null if the bot shouldn't respond (e.g., spam, off-topic)
    
    const name = pack.brand?.name || 'Token';
    const ticker = pack.brand?.ticker || 'TOKEN';
    const description = pack.brand?.description || '';
    
    // Simple keyword-based responses (in future, can use LLM)
    const text = userMessage.toLowerCase();
    
    // Price/CA questions
    if (text.includes('ca') || text.includes('contract') || text.includes('address')) {
      const mint = pack.launch?.mint;
      if (mint) {
        return `🎯 Here's the CA for $${ticker}:\n\n<code>${mint}</code>\n\nhttps://pump.fun/${mint}`;
      }
      return `$${ticker} hasn't launched yet! Stay tuned 👀`;
    }
    
    // Website/links questions
    if (text.includes('website') || text.includes('links') || text.includes('socials')) {
      const links = [];
      if (pack.links?.website) links.push(`🌐 Website: ${pack.links.website}`);
      if (pack.links?.x) links.push(`🐦 Twitter: ${pack.links.x}`);
      if (pack.launch?.pump_url) links.push(`💎 Pump.fun: ${pack.launch.pump_url}`);
      
      if (links.length > 0) {
        return `Here are our links for $${ticker}:\n\n${links.join('\n')}`;
      }
      return `Links coming soon! We're just getting started 🚀`;
    }
    
    // How to buy questions
    if (text.includes('buy') || text.includes('how to') || text.includes('where')) {
      const mint = pack.launch?.mint;
      if (mint) {
        return `💎 How to buy $${ticker}:\n\n1️⃣ Copy CA: <code>${mint}</code>\n2️⃣ Go to pump.fun\n3️⃣ Connect wallet & swap SOL\n\nEasy! 🎉`;
      }
      return `$${ticker} isn't live yet - stay tuned for the launch! 🔜`;
    }
    
    // Greetings
    if (text.includes('gm') || text.includes('good morning')) {
      return `GM ${userName ? userName + '! ' : ''}☀️ Ready for another day with $${ticker}! 🚀`;
    }
    
    if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
      return `Hey ${userName ? userName + '! ' : ''}👋 Welcome to the $${ticker} community! LFG! 🔥`;
    }
    
    // Excitement/hype
    if (text.includes('moon') || text.includes('pump') || text.includes('lfg') || text.includes('🚀')) {
      const hypeResponses = [
        `LFG! $${ticker} to the moon! 🚀🌕`,
        `We're just getting started! $${ticker} 💎🙌`,
        `The $${ticker} community is BUILT DIFFERENT! 🔥`,
        `$${ticker} holders are the real ones! 💪`,
      ];
      return hypeResponses[Math.floor(Math.random() * hypeResponses.length)];
    }
    
    // When/roadmap questions
    if (text.includes('when') || text.includes('roadmap') || text.includes('plans')) {
      return `Big things coming for $${ticker}! 👀 Stay tuned and stay based. Community first! 💪`;
    }
    
    // Wen lambo type questions (playful)
    if (text.includes('lambo') || text.includes('rich') || text.includes('millionaire')) {
      return `Wen lambo? Soon™ 😎 Just keep holding $${ticker} and trust the process! 🔥`;
    }
    
    // Don't respond to everything - return null for random messages
    // This prevents the bot from being annoying
    return null;
  }
  
  /**
   * Get all LaunchPacks that this bot manages TG groups for
   */
  async getManagedGroups(): Promise<Array<{ pack: LaunchPack; chatId: string }>> {
    const packs = await this.store.list();
    return packs
      .filter((p: LaunchPack) => p.tg?.chat_id && p.tg?.verified)
      .map((p: LaunchPack) => ({ pack: p, chatId: p.tg!.chat_id! }));
  }
  
  /**
   * Find which LaunchPack a chat belongs to
   */
  async findPackForChat(chatId: string): Promise<LaunchPack | null> {
    const packs = await this.store.list();
    return packs.find((p: LaunchPack) => p.tg?.chat_id === chatId) || null;
  }
}
