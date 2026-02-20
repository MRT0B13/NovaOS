/**
 * Telegram Setup Service
 * Handles bot verification, group membership checks, and admin status
 */

import { getEnv } from '../env.ts';

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TelegramChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: {
    id: number;
    is_bot: boolean;
    username?: string;
  };
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
  can_delete_messages?: boolean;
  can_pin_messages?: boolean;
}

interface BotInfo {
  id: number;
  username: string;
  first_name: string;
}

interface GroupVerificationResult {
  success: boolean;
  chatId?: string;
  chatTitle?: string;
  botStatus?: TelegramChatMember['status'];
  isAdmin: boolean;
  canPost: boolean;
  canPin: boolean;
  inviteLink?: string; // Telegram group invite link (t.me/xxx or t.me/+xxx)
  error?: string;
  errorCode?: string;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

async function tgApi<T>(token: string, method: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });
  
  const json = await res.json().catch(() => ({} as any));
  
  if (!res.ok || !json?.ok) {
    const errorDesc = json?.description || `Telegram ${method} failed`;
    throw errorWithCode('TG_API_ERROR', errorDesc, { 
      method, 
      statusCode: res.status,
      telegramError: json?.error_code 
    });
  }
  
  return json.result as T;
}

export class TelegramSetupService {
  private botToken: string | undefined;
  private botInfo: BotInfo | null = null;

  constructor() {
    const env = getEnv();
    this.botToken = env.TG_BOT_TOKEN;
  }

  /**
   * Get bot information (username, id)
   */
  async getBotInfo(): Promise<BotInfo> {
    if (!this.botToken) {
      throw errorWithCode('TG_NOT_CONFIGURED', 'TG_BOT_TOKEN not configured in .env');
    }

    if (this.botInfo) {
      return this.botInfo;
    }

    this.botInfo = await tgApi<BotInfo>(this.botToken, 'getMe');
    return this.botInfo;
  }

  /**
   * Get bot username for display (e.g., @MyLaunchBot)
   */
  async getBotUsername(): Promise<string> {
    const info = await this.getBotInfo();
    return `@${info.username}`;
  }

  /**
   * Extract chat_id from a Telegram group invite link
   * Note: This requires the bot to already be in the group
   * Returns null if can't extract (private group not joined)
   */
  extractChatIdFromLink(link: string): string | null {
    // Public group: t.me/groupname -> need to resolve via getChat
    // Private group: t.me/+XXXXX or t.me/joinchat/XXXXX -> can't get ID without joining
    
    // If it's already a chat_id
    if (/^-?\d{10,}$/.test(link)) {
      return link;
    }
    
    return null; // Need to use getChat with @username or chat_id
  }

  /**
   * Parse a Telegram link and extract the username or determine if it's a private invite
   */
  parseTelegramLink(link: string): { type: 'public' | 'private' | 'chat_id'; value: string } | null {
    if (!link) return null;
    
    // Already a chat_id
    if (/^-?\d{10,}$/.test(link)) {
      return { type: 'chat_id', value: link };
    }

    // Normalize the link
    const normalized = link.trim().replace(/^@/, '');
    
    // t.me/+INVITE or t.me/joinchat/INVITE (private invite link)
    const privateMatch = normalized.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/i);
    if (privateMatch) {
      return { type: 'private', value: privateMatch[1] };
    }

    // t.me/username (public group)
    const publicMatch = normalized.match(/(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)/i);
    if (publicMatch) {
      return { type: 'public', value: publicMatch[1] };
    }

    // Just a username
    if (/^[a-zA-Z0-9_]{5,}$/.test(normalized)) {
      return { type: 'public', value: normalized };
    }

    return null;
  }

  /**
   * Verify bot is in a group and check its permissions
   * Handles both full Telegram chat IDs (-1001234567890) and ElizaOS truncated IDs (-1234567890)
   */
  async verifyBotInGroup(chatIdOrUsername: string): Promise<GroupVerificationResult> {
    if (!this.botToken) {
      return {
        success: false,
        isAdmin: false,
        canPost: false,
        canPin: false,
        error: 'TG_BOT_TOKEN not configured',
        errorCode: 'TG_NOT_CONFIGURED',
      };
    }

    try {
      const botInfo = await this.getBotInfo();
      
      // Build list of chat_id formats to try
      // Telegram supergroups use -100 prefix, but ElizaOS sometimes strips it
      const chatIdsToTry: string[] = [];
      
      if (chatIdOrUsername.startsWith('@')) {
        chatIdsToTry.push(chatIdOrUsername);
      } else if (/^-?\d+$/.test(chatIdOrUsername)) {
        // It's a numeric chat_id - try multiple formats
        const numericId = chatIdOrUsername.replace('-', '');
        
        // Add provided format first
        chatIdsToTry.push(chatIdOrUsername);
        
        // If it already has -100 prefix, also try without it
        if (chatIdOrUsername.startsWith('-100') && numericId.length > 10) {
          chatIdsToTry.push('-' + numericId.slice(3)); // Remove the 100 part
        }
        // If it doesn't have -100, try adding it (for supergroups)
        else if (chatIdOrUsername.startsWith('-') && !chatIdOrUsername.startsWith('-100')) {
          chatIdsToTry.push('-100' + numericId);
        }
        // Positive number - might need -100 prefix
        else if (!chatIdOrUsername.startsWith('-')) {
          chatIdsToTry.push('-100' + numericId);
          chatIdsToTry.push('-' + numericId);
        }
      } else {
        chatIdsToTry.push(`@${chatIdOrUsername}`);
      }
      
      console.log('[TG_VERIFY] Trying chat_id formats:', chatIdsToTry);
      
      // Try each format until one works
      let chat: TelegramChat | null = null;
      let lastError: any = null;
      
      for (const chatId of chatIdsToTry) {
        try {
          chat = await tgApi<TelegramChat>(this.botToken, 'getChat', { chat_id: chatId });
          console.log('[TG_VERIFY] Successfully got chat with ID:', chatId);
          break;
        } catch (err: any) {
          lastError = err;
          console.log('[TG_VERIFY] Failed with chat_id:', chatId, '-', err.message);
          continue;
        }
      }
      
      if (!chat) {
        if (lastError?.message?.includes('chat not found') || lastError?.details?.telegramError === 400) {
          return {
            success: false,
            isAdmin: false,
            canPost: false,
            canPin: false,
            error: 'Bot is not in this group. Please add the bot first.',
            errorCode: 'BOT_NOT_IN_GROUP',
          };
        }
        throw lastError;
      }

      // Get bot's member status in the chat
      // Note: This can fail if the group has "Hide Members" privacy setting enabled
      let member: TelegramChatMember | null = null;
      try {
        member = await tgApi<TelegramChatMember>(this.botToken, 'getChatMember', {
          chat_id: chat.id,
          user_id: botInfo.id,
        });
        console.log('[TG_VERIFY] Bot member details:', JSON.stringify(member, null, 2));
      } catch (memberErr: any) {
        // "member list is inaccessible" happens when group has privacy settings
        console.log('[TG_VERIFY] Could not get member info:', memberErr.message);
        
        // Return partial success - we know the bot can at least see the chat
        return {
          success: true,
          chatId: String(chat.id),
          chatTitle: chat.title,
          botStatus: 'member' as TelegramChatMember['status'],
          isAdmin: false, // Can't determine
          canPost: true, // Assume yes since we can see the chat
          canPin: false, // Can't determine
          error: 'Could not check permissions (group privacy enabled). Bot appears to be in the group.',
        };
      }

      const isAdmin = member.status === 'administrator' || member.status === 'creator';
      const canPost = isAdmin || member.status === 'member';
      // For admins, check explicit permission; can_pin_messages is true if granted, false if not, or undefined if default
      const canPin = isAdmin && (member.can_pin_messages === true || member.can_pin_messages === undefined);

      console.log('[TG_VERIFY] Permissions:', { 
        status: member.status, 
        isAdmin, 
        canPost, 
        canPin,
        can_pin_messages: member.can_pin_messages,
        can_post_messages: member.can_post_messages 
      });

      // Try to get or create invite link if bot is admin
      let inviteLink: string | undefined;
      if (isAdmin) {
        try {
          // First try to get existing invite link from chat info
          if ((chat as any).invite_link) {
            inviteLink = (chat as any).invite_link;
            console.log('[TG_VERIFY] Using existing invite link:', inviteLink);
          } else {
            // Bot is admin, try to export/create invite link
            const linkResult = await tgApi<string>(this.botToken, 'exportChatInviteLink', { chat_id: chat.id });
            inviteLink = linkResult;
            console.log('[TG_VERIFY] Created new invite link:', inviteLink);
          }
        } catch (err: any) {
          console.log('[TG_VERIFY] Could not get invite link:', err.message);
          // Not a critical error - group linking still works
        }
      }

      return {
        success: true,
        chatId: String(chat.id),
        chatTitle: chat.title,
        botStatus: member.status,
        isAdmin,
        canPost,
        canPin,
        inviteLink,
      };
    } catch (err: any) {
      return {
        success: false,
        isAdmin: false,
        canPost: false,
        canPin: false,
        error: err.message || 'Failed to verify bot in group',
        errorCode: err.code || 'TG_VERIFICATION_FAILED',
      };
    }
  }

  /**
   * Get setup instructions for the user
   */
  async getSetupInstructions(telegramLink?: string): Promise<string> {
    let botUsername: string;
    try {
      botUsername = await this.getBotUsername();
    } catch {
      botUsername = '[Your Bot]';
    }

    const parsed = telegramLink ? this.parseTelegramLink(telegramLink) : null;

    let instructions = `📱 **Telegram Group Setup**\n\n`;
    instructions += `To enable community features, I need to be in your Telegram group.\n\n`;
    instructions += `**Steps:**\n`;
    instructions += `1. Create a Telegram group (or use existing one)\n`;
    instructions += `2. Add ${botUsername} to the group\n`;
    instructions += `3. Make ${botUsername} an **admin** with these permissions:\n`;
    instructions += `   • Post messages\n`;
    instructions += `   • Pin messages\n`;
    instructions += `   • Delete messages (optional)\n`;
    instructions += `4. Come back and say "verify telegram" or share your group link\n\n`;

    if (parsed?.type === 'private') {
      instructions += `⚠️ I see you have a private invite link. I cannot join via invite links.\n`;
      instructions += `Please add me directly: search for ${botUsername} and add to group.\n`;
    }

    return instructions;
  }

  /**
   * Check if Telegram is properly configured
   */
  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.TG_BOT_TOKEN);
  }
  
  /**
   * Get recent groups the bot has been added to or received messages from
   * This helps discover chat_ids for private groups
   */
  async getRecentGroups(): Promise<Array<{ chatId: string; title: string; type: string }>> {
    if (!this.botToken) {
      return [];
    }

    // SAFETY: getUpdates silently disables any active webhook.
    // If TG_WEBHOOK_URL is configured, never call getUpdates.
    try {
      const env = getEnv();
      if (env.TG_WEBHOOK_URL) {
        console.debug('[TelegramSetup] Skipping getUpdates — webhook mode active');
        return [];
      }
    } catch { /* env not available, proceed cautiously */ }
    
    try {
      // Get recent updates (messages, group joins, etc.)
      const updates = await tgApi<any[]>(this.botToken, 'getUpdates', {
        limit: 100,
        allowed_updates: ['message', 'my_chat_member'],
      });
      
      const groups = new Map<string, { chatId: string; title: string; type: string }>();
      
      for (const update of updates) {
        // Check for group messages
        const message = update.message || update.my_chat_member?.chat;
        if (message?.chat?.type === 'group' || message?.chat?.type === 'supergroup') {
          const chatId = String(message.chat.id);
          if (!groups.has(chatId)) {
            groups.set(chatId, {
              chatId,
              title: message.chat.title || 'Unknown Group',
              type: message.chat.type,
            });
          }
        }
        
        // Check for chat member updates (bot added to group)
        if (update.my_chat_member?.chat) {
          const chat = update.my_chat_member.chat;
          if (chat.type === 'group' || chat.type === 'supergroup') {
            const chatId = String(chat.id);
            if (!groups.has(chatId)) {
              groups.set(chatId, {
                chatId,
                title: chat.title || 'Unknown Group',
                type: chat.type,
              });
            }
          }
        }
      }
      
      return Array.from(groups.values());
    } catch (err) {
      console.error('Failed to get recent groups:', err);
      return [];
    }
  }
  
  /**
   * Try to find a group by title (fuzzy match)
   */
  async findGroupByTitle(searchTitle: string): Promise<{ chatId: string; title: string } | null> {
    const groups = await this.getRecentGroups();
    const searchLower = searchTitle.toLowerCase();
    
    // Exact match first
    const exact = groups.find(g => g.title.toLowerCase() === searchLower);
    if (exact) return exact;
    
    // Partial match
    const partial = groups.find(g => 
      g.title.toLowerCase().includes(searchLower) || 
      searchLower.includes(g.title.toLowerCase())
    );
    if (partial) return partial;
    
    return null;
  }
}

/**
 * Extract social links from text with improved detection
 */
export function extractSocialLinks(text: string): {
  website?: string;
  x?: string;
  xHandle?: string;
  telegram?: string;
  telegramChatId?: string;
} {
  const result: ReturnType<typeof extractSocialLinks> = {};

  // Website detection - look for actual URLs first, then labeled patterns
  // Priority 1: Explicit "website: URL" or "website URL" (skip "to" word)
  const websiteLabeledMatch = text.match(/(?:website|site|web)[:\s]+(?:to\s+)?(https?:\/\/[^\s]+)/i);
  if (websiteLabeledMatch) {
    result.website = websiteLabeledMatch[1];
  } else {
    // Priority 2: Any https URL that's not twitter/telegram/x.com
    const allUrls = text.match(/https?:\/\/[^\s]+/gi) || [];
    for (const url of allUrls) {
      if (!url.includes('twitter.com') && !url.includes('x.com') && !url.includes('t.me') && !url.includes('pump.fun')) {
        result.website = url;
        break;
      }
    }
    // Priority 3: Domain pattern without http (e.g., "candlejoust.com")
    if (!result.website) {
      const domainMatch = text.match(/(?:^|\s)([a-zA-Z0-9][a-zA-Z0-9-]*\.(com|io|xyz|org|net|co|app|dev|gg|fun)[^\s]*)/i);
      if (domainMatch && !domainMatch[1].includes('twitter') && !domainMatch[1].includes('x.com') && !domainMatch[1].includes('t.me')) {
        result.website = `https://${domainMatch[1]}`;
      }
    }
  }

  // X/Twitter handle detection - PRIORITY: Check for explicit "x handle" or "twitter handle" patterns first
  // Pattern: "set x handle to @username" or "x handle: @username" or "twitter handle @username"
  const handlePatterns = [
    /(?:x|twitter)\s+handle\s+(?:to\s+|is\s+|:\s*)?@?([a-zA-Z0-9_]+)/i,
    /handle\s+(?:for\s+\$?\w+\s+)?(?:to\s+|is\s+)?@([a-zA-Z0-9_]+)/i,
    /set\s+(?:x|twitter)\s+(?:to\s+)?@([a-zA-Z0-9_]+)/i,
  ];
  
  for (const pattern of handlePatterns) {
    const match = text.match(pattern);
    if (match && match[1] && !['handle', 'to', 'is', 'for'].includes(match[1].toLowerCase())) {
      const username = match[1].replace(/^@/, '');
      result.xHandle = `@${username}`;
      result.x = `https://x.com/${username}`;
      break;
    }
  }

  // If no handle found, try URL-based X/Twitter detection
  if (!result.x) {
    const xPatterns = [
      /(?:x|twitter)[:\s]+(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([^\s\/]+)/i,
      /(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/i,
    ];
    for (const pattern of xPatterns) {
      const match = text.match(pattern);
      if (match && match[1] && !['intent', 'share', 'home', 'handle'].includes(match[1].toLowerCase())) {
        const username = match[1].replace(/^@/, '');
        result.x = `https://x.com/${username}`;
        result.xHandle = `@${username}`;
        break;
      }
    }
  }

  // Telegram link detection - improved to catch t.me URLs
  const tgPatterns = [
    /(?:telegram|tg|tg_link|telegram_link)[:\s]+([^\s]+)/i,
    /(https?:\/\/)?t\.me\/([a-zA-Z0-9_+]+)/i,
    /(https?:\/\/)?telegram\.me\/([a-zA-Z0-9_+]+)/i,
  ];
  for (const pattern of tgPatterns) {
    const match = text.match(pattern);
    if (match) {
      let link = match[0];
      // Extract just the t.me part if it's a full URL match
      const tmeMatch = link.match(/(https?:\/\/)?t\.me\/([a-zA-Z0-9_+]+)/i);
      if (tmeMatch) {
        link = `https://t.me/${tmeMatch[2]}`;
      } else if (!link.startsWith('http') && !link.startsWith('t.me')) {
        link = `https://t.me/${link.replace(/^@/, '')}`;
      } else if (link.startsWith('t.me')) {
        link = `https://${link}`;
      }
      result.telegram = link;
      break;
    }
  }

  // Direct chat_id detection
  const chatIdMatch = text.match(/(?:chat_?id)[:\s]+(-?\d{10,})/i);
  if (chatIdMatch) {
    result.telegramChatId = chatIdMatch[1];
  }

  return result;
}
