import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { LaunchPackRepository } from '../db/launchPackRepository.ts';
import { TelegramSetupService, extractSocialLinks } from '../services/telegramSetup.ts';
import { lookupTelegramUser, lookupTelegramUserByEntity } from '../services/telegramCommunity.ts';
import { getAllGroups, getGroupsSummary, trackGroup } from '../services/groupTracker.ts';
import { getHealthMonitor, trackMessage, analyzeSentiment, type GroupHealth } from '../services/groupHealthMonitor.ts';
import { crossBanUser } from '../services/novaChannel.ts';
import { loadMap, saveMap } from '../services/persistenceStore.ts';

// ============================================================================
// SCAM/SPAM WARNING TRACKER
// Tracks warnings per user - warn first, kick on repeat offense
// ============================================================================

interface ScamWarning {
  count: number;
  lastWarning: number;
  reasons: string[];
  entityId?: string;
}

// Map of chatId:userId -> warning info
const scamWarnings = new Map<string, ScamWarning>();

// Restore scam warnings from DB on import
loadMap<ScamWarning>('scam_warnings').then(saved => {
  if (saved.size > 0) {
    const now = Date.now();
    for (const [k, v] of saved) {
      // Skip expired warnings
      if (now - v.lastWarning <= WARNING_EXPIRY_MS) {
        scamWarnings.set(k, v);
      }
    }
    console.log(`[SCAM_TRACKER] Restored ${scamWarnings.size} active warnings from DB`);
  }
}).catch(() => {});

// Warning config
const WARNING_THRESHOLD = 2; // Kick after this many warnings
const WARNING_EXPIRY_MS = 24 * 60 * 60 * 1000; // Warnings expire after 24 hours

/**
 * Scam detection patterns - returns reason if scam detected, null if clean
 */
export function detectScam(text: string): { isScam: boolean; reason: string; severity: 'warn' | 'kick' } | null {
  const lowerText = text.toLowerCase();
  
  // INSTANT KICK - No warning needed for these obvious scams
  const instantKickPatterns = [
    // Wallet giveaway scams (like the screenshot)
    { pattern: /first.*\d+.*people.*(?:dm|message|inbox)|(?:dm|message|inbox).*first.*\d+.*people/i, reason: 'Fake giveaway scam' },
    { pattern: /(?:give|giving|send).*(?:my|their)?.*(?:sol|eth|btc|crypto|wallet)|(?:sol|eth|btc|crypto).*(?:give|giving|send)/i, reason: 'Fake crypto giveaway' },
    { pattern: /(?:not interested in crypto|been scammed|scammed.*(?:many|too many|so many)|leaving crypto).*(?:dm|message|contact)/i, reason: 'Fake exit scam giveaway' },
    { pattern: /anyone.*(?:who )?need(?:s)?.*(?:sol|eth|crypto).*(?:dm|message|should)/i, reason: 'Fake giveaway scam' },
    
    // Forwarded promo spam with other tokens
    { pattern: /(?:launch|launching).*(?:in|within).*(?:\d+)?.*hours?.*(?:t\.me|telegram)/i, reason: 'Forwarded token promo' },
    { pattern: /last project.*(?:reached|did|made).*\d+x/i, reason: 'Forwarded pump promo' },
    
    // Private invite links to other groups
    { pattern: /t\.me\/\+[a-zA-Z0-9_-]{10,}/i, reason: 'Private Telegram invite link' },
    
    // Impersonation scams
    { pattern: /(?:i am|i'm).*(?:admin|moderator|support|official|team member)/i, reason: 'Admin impersonation' },
    { pattern: /(?:official|customer).*(?:support|service|team)/i, reason: 'Support impersonation' },
    
    // Recovery/restore scams
    { pattern: /(?:recover|restore|retrieve).*(?:wallet|funds|crypto|tokens)/i, reason: 'Wallet recovery scam' },
    { pattern: /(?:help|assist).*(?:recover|restore).*(?:lost|stolen)/i, reason: 'Recovery assistance scam' },
  ];
  
  for (const { pattern, reason } of instantKickPatterns) {
    if (pattern.test(text)) {
      return { isScam: true, reason, severity: 'kick' };
    }
  }
  
  // WARNING FIRST - Less obvious, might be genuine confusion
  const warnPatterns = [
    // Mod/admin requests - people begging to be mod or tagged (self-promotion spam)
    { pattern: /(?:tag|make)\s*(?:me|us)\s*(?:as\s*)?(?:mod|admin|moderator)/i, reason: 'Mod begging spam' },
    { pattern: /(?:let\s*me|can\s*i)\s*(?:be\s*)?(?:mod|admin|moderator)/i, reason: 'Mod begging spam' },
    { pattern: /(?:give|want)\s*(?:me\s*)?(?:mod|admin)\s*(?:role|status|rights)/i, reason: 'Mod begging spam' },
    { pattern: /(?:i\s*can|let\s*me)\s*(?:do|help\s*with)\s*(?:shilling|raid|raids|promo)/i, reason: 'Self-promotion spam' },
    { pattern: /(?:tag\s*me\s*up|make\s*me\s*(?:a\s*)?mod)/i, reason: 'Mod begging spam' },
    
    // DM requests (could be scam or just someone new)
    { pattern: /(?:dm|pm|message|inbox|text|write)\s*me/i, reason: 'DM solicitation' },
    { pattern: /(?:contact|reach|hit)\s*(?:me|out)/i, reason: 'Contact solicitation' },
    { pattern: /(?:slide.*dm|hmu|hit me up)/i, reason: 'DM solicitation' },
    
    // Vague investment promises
    { pattern: /(?:guaranteed|minimum).*(?:profit|return|roi|earnings)/i, reason: 'Investment promise scam' },
    { pattern: /(?:daily|weekly|monthly).*(?:profit|return|earnings|passive)/i, reason: 'Passive income scam' },
    
    // Other token mentions (might be genuine comparison question)
    { pattern: /\$[A-Z]{2,10}(?!RUG).*(?:buy|pump|moon|ape|100x)/i, reason: 'Other token shilling' },
    
    // WhatsApp/external contact
    { pattern: /(?:whatsapp|signal|discord\.gg)/i, reason: 'External platform solicitation' },
  ];
  
  for (const { pattern, reason } of warnPatterns) {
    if (pattern.test(text)) {
      return { isScam: true, reason, severity: 'warn' };
    }
  }
  
  return null;
}

/**
 * Track a warning for a user - returns whether they should be kicked
 */
export function trackScamWarning(
  chatId: string, 
  userId: string | number, 
  reason: string,
  entityId?: string
): { shouldKick: boolean; warningCount: number } {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  
  let warning = scamWarnings.get(key);
  
  // Check if existing warning has expired
  if (warning && (now - warning.lastWarning) > WARNING_EXPIRY_MS) {
    warning = undefined;
    scamWarnings.delete(key);
  }
  
  if (!warning) {
    warning = { count: 0, lastWarning: now, reasons: [], entityId };
  }
  
  warning.count++;
  warning.lastWarning = now;
  warning.reasons.push(reason);
  if (entityId) warning.entityId = entityId;
  
  scamWarnings.set(key, warning);
  saveMap('scam_warnings', scamWarnings);
  
  console.log(`[SCAM_TRACKER] User ${userId} in chat ${chatId}: ${warning.count} warnings (${reason})`);
  
  return {
    shouldKick: warning.count >= WARNING_THRESHOLD,
    warningCount: warning.count,
  };
}

/**
 * Get warning status for a user
 */
export function getScamWarnings(chatId: string, userId: string | number): ScamWarning | undefined {
  const key = `${chatId}:${userId}`;
  return scamWarnings.get(key);
}

/**
 * Clear warnings for a user (e.g., after kick or manual clear)
 */
export function clearScamWarnings(chatId: string, userId: string | number): void {
  const key = `${chatId}:${userId}`;
  scamWarnings.delete(key);
  saveMap('scam_warnings', scamWarnings);
}

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/;

function extractLaunchPackId(message: Memory): string | undefined {
  const data = (message.content?.data ?? {}) as any;
  if (typeof data.launchPackId === 'string' && UUID_RE.test(data.launchPackId)) return data.launchPackId;

  const text = String(message.content?.text ?? '');
  const match = text.match(UUID_RE);
  return match?.[0];
}

function requireLaunchKit(runtime: IAgentRuntime) {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  return bootstrap?.getLaunchKit?.();
}

function requireService<T>(service: T | undefined, code: string, message: string): T {
  if (!service) {
    const err = new Error(message);
    (err as any).code = code;
    throw err;
  }
  return service;
}

// Store for pending group links (chat_id -> waiting for token name)
const pendingGroupLinks = new Map<string, { chatId: string; timestamp: number }>();

/**
 * Action to link a Telegram group to a LaunchPack
 * User says: "link this group to MoonDog" or "this is the MoonDog group"
 * Can be used from Telegram group OR web client with manual chat_id
 */
export const linkTelegramGroupAction: Action = {
  name: 'LINK_TELEGRAM_GROUP',
  similes: ['CONNECT_TG_GROUP', 'ASSOCIATE_GROUP'],
  description: 'Link current Telegram group to a LaunchPack by token name',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const isFromTelegram = message.content?.source === 'telegram';
    
    // Check for link intent - more flexible matching
    const hasLinkIntent = /link|connect|linking|set.*chat.*id|associate.*group/.test(text);
    
    // Check if manual chat_id is provided (format: -1003663256702)
    const hasManualChatId = /-\s*\d{10,}/.test(text);
    
    // If manual chat_id is provided, this is an explicit link request
    // Validate if:
    // 1. Has manual chat_id (this is explicit intent to link), OR
    // 2. From Telegram group with link intent
    if (hasManualChatId) {
      console.log('[LINK_TG_GROUP] Validated: has manual chat_id');
      return true;
    }
    return isFromTelegram && hasLinkIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[LINK_TG] Removed REPLY from actions to prevent duplicate message');
      }
    }

    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const text = String(message.content?.text ?? '');
    const roomId = String(message.roomId ?? '');
    const channelType = (message.content as any)?.channelType;
    
    // Extract real Telegram chat_id - try multiple sources
    const rawMessage = (message.content as any)?.rawMessage;
    let telegramChatId = rawMessage?.chat?.id?.toString();
    
    // Also check room's channelId - ElizaOS stores telegram chat_id there
    const room = await runtime.getRoom(message.roomId as any);
    const roomChannelId = room?.channelId;
    if (!telegramChatId && roomChannelId && /^-?\d+$/.test(roomChannelId)) {
      telegramChatId = roomChannelId;
      console.log(`[LINK_TG_GROUP] Using channelId from room: ${telegramChatId}`);
    }
    
    // Check if user provided numeric chat_id in the message
    // Matches: -1003663256702, -100194xxxx987, or any negative number with 10+ digits
    const chatIdMatch = text.match(/-\s*(\d{10,})/);
    if (chatIdMatch) {
      // Add the minus sign back
      telegramChatId = '-' + chatIdMatch[1];
      console.log(`[LINK_TG_GROUP] Using manual chat_id from message: ${telegramChatId}`);
    }
    
    // Check if this is from Telegram group OR from web client with manual chat_id
    const isFromTelegramGroup = roomId && message.content?.source === 'telegram' && channelType === 'GROUP';
    const hasManualChatId = chatIdMatch !== null; // User provided numeric chat_id
    const hasRoomChannelId = roomChannelId && /^-?\d+$/.test(roomChannelId);
    
    if (!isFromTelegramGroup && !hasManualChatId && !hasRoomChannelId) {
      return {
        text: '❌ This command only works in Telegram groups, or provide a manual chat_id.\n' +
              'From Telegram Desktop: Right-click a message → Copy Message Link → Extract middle number → Add -100 prefix.',
        success: false,
      };
    }

    // Extract token name from message (optional - will use most recent if not specified)
    // Match patterns like: "link RUG to -1003663256702" or "link -1003663256702 to RUG"
    // Also: "link Sir Dumps-A-Lot ($DUMP) -1003534790830"
    let tokenName: string | undefined;
    
    if (hasManualChatId) {
      // When manual chat_id is provided, try to extract token name
      // Pattern 0: Look for $TICKER in the message (most reliable)
      const tickerMatch = text.match(/\$([A-Z]{2,10})\b/i);
      if (tickerMatch) {
        tokenName = tickerMatch[1].toUpperCase();
        console.log(`[LINK_TG_GROUP] Found ticker: $${tokenName}`);
      }
      
      if (!tokenName) {
        // Pattern 1: "link TOKENNAME to -100..." (greedy capture up to "to")
        const pattern1 = text.match(/(?:link|connect|linking)\s+(.+?)\s+(?:to|with)\s+-\s*\d{10,}/i);
        // Pattern 2: "link -100... to TOKENNAME"
        const pattern2 = text.match(/(?:link|connect|linking)\s+-\s*\d{10,}\s+(?:to|with)\s+(.+?)(?:\s|$)/i);
        // Pattern 3: Everything between "link" and the chat_id (fallback)
        const pattern3 = text.match(/(?:link|connect|linking)\s+(.+?)\s+-\s*\d{10,}/i);
        // Pattern 4: Just a word before or after the chat_id that could be a token name
        const pattern4 = text.match(/\b([A-Z]{2,10})\b.*-\s*\d{10,}|-\s*\d{10,}.*\b([A-Z]{2,10})\b/i);
        
        tokenName = pattern1?.[1]?.trim() || pattern2?.[1]?.trim() || pattern3?.[1]?.trim() || pattern4?.[1]?.trim() || pattern4?.[2]?.trim();
        
        // Clean up token name - remove parentheses and extra text
        if (tokenName) {
          tokenName = tokenName.replace(/\s*\(.*?\)\s*/g, '').trim();
        }
      }
      
      // Filter out common words that aren't token names
      if (tokenName && /^(the|to|with|group|pack|telegram|tg|link|try|linking|again|sir)$/i.test(tokenName)) {
        tokenName = undefined;
      }
      
      console.log(`[LINK_TG_GROUP] Extracted tokenName: ${tokenName || 'none'}`);
    } else {
      // In Telegram group, name is optional (can use most recent)
      const nameMatch = text.match(/(?:link|connect|this is) (?:the |this )?(?:group )?(?:to )?(.+?)(?:\s|$)/i);
      tokenName = nameMatch?.[1]?.trim();
    }
    
    // Find matching LaunchPack
    const packs = await store.list();
    let pack;
    
    if (tokenName) {
      console.log(`[LINK_TG_GROUP] Looking for pack matching: "${tokenName}"`);
      pack = packs.find(
        (p: any) => {
          const packName = p.brand?.name?.toLowerCase() || '';
          const packTicker = p.brand?.ticker?.toLowerCase() || '';
          const searchTerm = tokenName.toLowerCase();
          
          // Exact ticker match (most reliable)
          if (packTicker === searchTerm) {
            console.log(`[LINK_TG_GROUP] ✅ Exact ticker match: $${packTicker}`);
            return true;
          }
          // Name contains search term
          if (packName.includes(searchTerm)) {
            console.log(`[LINK_TG_GROUP] ✅ Name match: ${packName}`);
            return true;
          }
          // Search term contains name (e.g., "Sir Dumps-A-Lot" contains "dump")
          if (searchTerm.includes(packName)) {
            console.log(`[LINK_TG_GROUP] ✅ Reverse name match: ${searchTerm} contains ${packName}`);
            return true;
          }
          return false;
        }
      );
      
      if (!pack) {
        console.log(`[LINK_TG_GROUP] No pack found for "${tokenName}". Available: ${packs.map((p: any) => `${p.brand?.name} ($${p.brand?.ticker})`).join(', ')}`);
      }
    }
    
    // If no token name specified and multiple packs exist, ask user which one
    if (!tokenName && packs.length > 1) {
      const packList = packs.map((p: any, i: number) => `${i+1}. **${p.brand?.name}** ($${p.brand?.ticker})`).join('\n');
      await callback({
        text: `📦 **Which LaunchPack should I link to this group?**\n\n${packList}\n\n` +
          `Just say: "link [TOKEN NAME] to ${telegramChatId}"`,
      });
      return {
        text: 'Asked user which pack to link',
        success: true, // Return true since we're prompting, not failing
      };
    }
    
    // If no token name or no match, use most recent unlaunched pack (or only pack)
    if (!pack) {
      pack = packs.find((p: any) => p.launch?.status !== 'launched');
    }
    
    // Still no pack? Use the first one (if only one exists)
    if (!pack && packs.length > 0) {
      pack = packs[0];
    }

    if (!pack) {
      const packList = packs.map((p: any) => `${p.brand?.name} ($${p.brand?.ticker})`).join(', ');
      return {
        text: `❌ No LaunchPack found${tokenName ? ` for "${tokenName}"` : ''}. Available tokens: ${packList || 'none yet'}`,
        success: false,
      };
    }

    // Update the LaunchPack with BOTH roomId and real Telegram chat_id
    if (!telegramChatId) {
      await callback({
        text: `⚠️ **Need Chat ID to Link Group**\n\n` +
          `**Easy Method (Telegram Desktop):**\n` +
          `1. Open Telegram Desktop app\n` +
          `2. Make sure this group is **PRIVATE** (not public)\n` +
          `3. Send any message in this group\n` +
          `4. Right-click the message → "Copy Message Link"\n` +
          `5. You'll get: \`https://t.me/c/194xxxx987/11/13\`\n` +
          `6. Take the middle number: \`194xxxx987\`\n` +
          `7. Add \`-100\` prefix: \`-100194xxxx987\`\n\n` +
          `**Then say:**\n` +
          `"link this group to ${pack.brand?.ticker} -100194xxxx987"\n\n` +
          `💡 **Alternative:** Forward any message from this group to @userinfobot`,
      });
      return {
        text: 'Need manual chat_id',
        success: false,
      };
    }
    
    // Verify bot is in the group and has proper permissions via Telegram API
    const tgService = new TelegramSetupService();
    let verifyResult;
    try {
      verifyResult = await tgService.verifyBotInGroup(telegramChatId);
      console.log('[LINK_TG_GROUP] Verification result:', JSON.stringify(verifyResult, null, 2));
    } catch (err) {
      console.error('[LINK_TG_GROUP] Verification error:', err);
      verifyResult = { success: false, error: String(err) };
    }
    
    if (!verifyResult.success) {
      await callback({
        text: `❌ **Cannot access Telegram group**\n\n` +
          `Error: ${verifyResult.error || 'Unknown error'}\n\n` +
          `Please ensure:\n` +
          `1. The chat_id is correct: \`${telegramChatId}\`\n` +
          `2. @Launch_kit_bot is added to the group\n` +
          `3. @Launch_kit_bot is an admin with posting permissions`,
      });
      return {
        text: 'Failed to verify Telegram group access',
        success: false,
      };
    }
    
    await store.update(pack.id, {
      tg: {
        // DON'T use web roomId for chat_id - that causes data leak when multiple packs share same web session
        // Instead, use the telegram_chat_id as the primary identifier, or keep existing if set
        chat_id: pack.tg?.chat_id && pack.tg.chat_id !== roomId ? pack.tg.chat_id : telegramChatId,
        telegram_chat_id: telegramChatId, // Real Telegram chat_id for API calls
        invite_link: verifyResult.inviteLink, // Telegram group invite link for marketing
        verified: true,
        verified_at: new Date().toISOString(),
        chat_title: verifyResult.chatTitle || `Telegram Group (${pack.brand?.name})`,
        is_admin: verifyResult.isAdmin,
        can_post: verifyResult.canPost,
        can_pin: verifyResult.canPin,
        pins: pack.tg?.pins || { welcome: '', how_to_buy: '', memekit: '' },
        schedule: pack.tg?.schedule || [],
      },
    });

    await callback({
      text: `✅ **Linked & Verified Telegram group to ${pack.brand?.name}!**\n\n` +
        `📱 Group: ${verifyResult.chatTitle || 'Unknown'}\n` +
        `🆔 Chat ID: ${telegramChatId}\n` +
        `${verifyResult.inviteLink ? `🔗 Invite: ${verifyResult.inviteLink}\n` : ''}` +
        `🎯 Token: $${pack.brand?.ticker}\n` +
        `📦 LaunchPack ID: ${pack.id}\n\n` +
        `**Bot Status:**\n` +
        `🔐 Admin: ${verifyResult.isAdmin ? '✅ Yes' : '⚠️ No'}\n` +
        `📝 Can Post: ${verifyResult.canPost ? '✅ Yes' : '❌ No'}\n` +
        `📌 Can Pin: ${verifyResult.canPin ? '✅ Yes' : '⚠️ No'}\n\n` +
        `I can now post launch announcements here automatically! 🚀`,
      data: { launchPackId: pack.id, roomId, chatId: telegramChatId },
      source: 'telegram',
    });

    return {
      text: `✅ Group linked to ${pack.brand?.name}!`,
      success: true,
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'link this group to MoonDog' } },
      { name: 'eliza', content: { text: '✅ Linked this Telegram group to MoonDog!', actions: ['LINK_TELEGRAM_GROUP'] } },
    ],
    [
      { name: 'user', content: { text: 'this is the RocketCat group' } },
      { name: 'eliza', content: { text: '✅ Linked this Telegram group to RocketCat!', actions: ['LINK_TELEGRAM_GROUP'] } },
    ],
  ],
};

/**
 * Action to show which token a Telegram group is linked to
 */
export const checkTelegramGroupAction: Action = {
  name: 'CHECK_TELEGRAM_GROUP',
  similes: ['SHOW_GROUP_LINK', 'WHICH_TOKEN'],
  description: 'Check which token this Telegram group is linked to',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    if (message.content?.source !== 'telegram') return false;
    
    const text = String(message.content?.text ?? '').toLowerCase();
    return /which token|what token|group for|linked to/.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const chatId = String(message.content?.chatId ?? message.roomId ?? '');
    
    if (!chatId || !chatId.startsWith('-100')) {
      return {
        text: '❌ This command only works in Telegram groups.',
        success: false,
      };
    }

    // Find LaunchPack linked to this group
    const packs = await store.list();
    const pack = packs.find((p: any) => p.tg?.chat_id === chatId);

    if (!pack) {
      return {
        text: `❌ This group is not linked to any token yet.\n\nTo link it, say: "link this group to [TOKEN NAME]"`,
        success: false,
      };
    }

    const status = pack.launch?.status || 'not launched';
    const mint = pack.launch?.mint ? `\nMint: ${pack.launch.mint.slice(0, 8)}...` : '';

    await callback({
      text: `✅ This group is linked to:\n\n🪙 **${pack.brand?.name}** ($${pack.brand?.ticker})\nStatus: ${status}${mint}\nID: ${pack.id}`,
      data: { launchPackId: pack.id, chatId },
    });

    return {
      text: `This group is for ${pack.brand?.name}`,
      success: true,
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'which token is this group for?' } },
      { name: 'eliza', content: { text: '✅ This group is linked to MoonDog!', actions: ['CHECK_TELEGRAM_GROUP'] } },
    ],
  ],
};

/**
 * Action to greet when bot is added to a new group
 * Auto-detects chat_id and prompts user to link to a token
 */
export const greetNewTelegramGroupAction: Action = {
  name: 'GREET_TELEGRAM_GROUP',
  similes: ['TG_GROUP_WELCOME'],
  description: 'Greet when added to a new Telegram group and prompt for token linking',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    // Only for Telegram messages
    if (message.content?.source !== 'telegram') return false;
    
    const chatId = String(message.content?.chatId ?? message.roomId ?? '');
    
    // Only in groups (chat_id starts with -100)
    if (!chatId || !chatId.startsWith('-100')) return false;
    
    // Check if this is a new group we haven't greeted yet
    // This would trigger on first message after bot joins
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Trigger on bot being mentioned or first interaction
    return text.includes('launchkit') || text.includes('/start');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const chatId = String(message.content?.chatId ?? message.roomId ?? '');
    
    // Check if group is already linked
    const packs = await store.list();
    const existingPack = packs.find((p: any) => p.tg?.chat_id === chatId);

    if (existingPack) {
      return {
        text: `👋 Hi! I'm already managing ${existingPack.brand?.name} ($${existingPack.brand?.ticker}) in this group.`,
        success: true,
      };
    }

    // Store this as a pending group link
    pendingGroupLinks.set(chatId, { chatId, timestamp: Date.now() });

    const packList = packs.length > 0
      ? packs.map((p: any) => `${p.brand?.name} ($${p.brand?.ticker})`).join(', ')
      : 'none yet - create one first!';

    await callback({
      text: `👋 Hi! I'm LaunchKit, your token launch assistant!\n\n` +
            `🔗 To link this group to a token, say:\n` +
            `"link this group to [TOKEN NAME]"\n\n` +
            `📦 Available tokens: ${packList}\n\n` +
            `Chat ID: ${chatId}`,
      data: { chatId },
    });

    return {
      text: `Welcome! Link me to a token to get started.`,
      success: true,
    };
  },
  examples: [
    [
      { name: 'user', content: { text: '/start' } },
      { name: 'eliza', content: { text: '👋 Hi! I\'m LaunchKit...', actions: ['GREET_TELEGRAM_GROUP'] } },
    ],
  ],
};

/**
 * Action to verify bot is in a Telegram group and has proper permissions
 * User says: "verify telegram" or provides a t.me link
 */
export const verifyTelegramSetupAction: Action = {
  name: 'VERIFY_TELEGRAM_SETUP',
  similes: ['CHECK_TG_BOT', 'VERIFY_TG', 'TG_STATUS', 'TELEGRAM_CHECK'],
  description: 'Verify bot is in Telegram group with proper admin permissions',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Only run in Telegram groups or if there's a t.me link provided
    const isFromTelegram = message.content?.source === 'telegram';
    const channelType = (message.content as any)?.channelType;
    const isGroupChat = isFromTelegram && channelType === 'GROUP';
    const hasTelegramLink = /t\.me\//.test(text);
    const hasVerifyIntent = /verif|check.*telegram|telegram.*setup|telegram.*status/i.test(text);
    
    // Check if manual chat_id is provided - if so, LINK action should handle it, not verify
    const hasManualChatId = /-\s*\d{10,}/.test(text);
    if (hasManualChatId) {
      console.log('[VERIFY_TG] Skipping - manual chat_id should be handled by LINK action');
      return false;
    }
    
    // Validate if:
    // 1. Message has a t.me link, OR
    // 2. Message is from a Telegram GROUP chat with verify intent
    // DO NOT validate from web client without a link
    return hasTelegramLink || (isGroupChat && hasVerifyIntent);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Remove REPLY from actions array to prevent duplicate messages
    // This action handles its own response via callback
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[VERIFY_TG] Removed REPLY from actions to prevent duplicate message');
      }
    }

    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const tgService = new TelegramSetupService();
    
    // Check if TG is configured
    if (!tgService.isConfigured()) {
      await callback({
        text: `📱 **Telegram Verification Not Available**\n\n` +
          `I don't have a Telegram bot set up yet, so I can't verify your group.\n\n` +
          `**You have two options:**\n` +
          `1. **Skip Telegram** - Say "skip telegram" and launch without TG integration\n` +
          `2. **Launch without verification** - I'll save your TG link and you can add community management later\n\n` +
          `💡 Your Telegram link will still be included on pump.fun even without verification!`,
      });
      return {
        text: 'Telegram verification not available - bot not configured',
        success: false,
      };
    }

    const text = String(message.content?.text ?? '');
    const launchPackId = extractLaunchPackId(message);
    
    // Extract telegram link from message
    const links = extractSocialLinks(text);
    const telegramLink = links.telegram;
    
    // Get LaunchPack if ID provided
    let pack: any = null;
    const packs = await store.list(); // Get all packs for lookup
    
    if (launchPackId) {
      pack = await store.get(launchPackId);
    }
    
    // Determine what to verify
    let chatIdOrUsername: string | null = null;
    
    if (telegramLink) {
      const parsed = tgService.parseTelegramLink(telegramLink);
      if (parsed?.type === 'public') {
        chatIdOrUsername = parsed.value;
      } else if (parsed?.type === 'chat_id') {
        chatIdOrUsername = parsed.value;
      } else if (parsed?.type === 'private') {
        // Private invite link - provide step-by-step guidance
        const botUsername = await tgService.getBotUsername().catch(() => '[Your Bot]');
        
        // Save the link even though we can't verify yet
        if (pack) {
          await store.update(pack.id, {
            links: {
              ...(pack.links || {}),
              telegram: telegramLink,
            },
            tg: {
              ...(pack.tg || {}),
              pending_verification: true,
            },
          });
        }
        
        await callback({
          text: `📱 **Private Telegram Group Detected**\n\n` +
            `I see you have a **private invite link** (t.me/+...). ` +
            `That's great for keeping your community exclusive!\n\n` +
            `However, I can't automatically verify my access through invite links. ` +
            `Here's how to set it up:\n\n` +
            `**🔧 Quick Setup (2 minutes):**\n\n` +
            `1️⃣ Open your Telegram group\n\n` +
            `2️⃣ Go to **Group Settings** → **Administrators** → **Add Admin**\n\n` +
            `3️⃣ Search for ${botUsername} and add me\n\n` +
            `4️⃣ Grant these permissions:\n` +
            `   ✅ Post messages\n` +
            `   ✅ Pin messages\n` +
            `   ✅ Delete messages (optional)\n\n` +
            `5️⃣ Come back here and say **"verify telegram"**\n\n` +
            `💾 I've saved your TG link - it will be included on pump.fun even before verification!\n\n` +
            `💡 **Tip:** After adding me, I'll be able to auto-post your launch announcement to the group!`,
          data: { launchPackId: pack?.id, telegramLink, pendingVerification: true },
        });
        return {
          text: 'Provided setup instructions for private TG group',
          success: true, // Return success since we saved the link
        };
      }
    } else if (pack?.tg?.telegram_chat_id) {
      // Use the real Telegram chat_id stored from linking
      chatIdOrUsername = pack.tg.telegram_chat_id;
      console.log('[VERIFY_TG] Using stored telegram_chat_id:', chatIdOrUsername);
    } else if (pack?.tg?.chat_id && pack.tg.chat_id.startsWith('-')) {
      // Fallback to chat_id if it looks like a real Telegram ID (starts with -)
      chatIdOrUsername = pack.tg.chat_id;
    }
    
    if (!chatIdOrUsername) {
      // Check if this is from a Telegram group - if so, prompt to use link action
      const isFromTelegram = message.content?.source === 'telegram';
      const channelType = (message.content as any)?.channelType;
      const isGroupChat = isFromTelegram && channelType === 'GROUP';
      
      if (isGroupChat) {
        // User is in Telegram but we don't have the real chat_id
        // First check if ANY LaunchPack has a telegram_chat_id stored
        const roomId = String(message.roomId ?? '');
        
        // Search for any pack that has telegram_chat_id linked
        // First try to find by roomId match, then by any telegram_chat_id
        let linkedPack = packs.find((p: any) => p.tg?.chat_id === roomId && p.tg?.telegram_chat_id);
        
        // If not found by roomId, check if we have a pack with telegram_chat_id from web linking
        if (!linkedPack) {
          // Find the first pack with a telegram_chat_id that's been verified
          linkedPack = packs.find((p: any) => p.tg?.telegram_chat_id && p.tg?.is_admin);
          if (linkedPack) {
            console.log('[VERIFY_TG] Found pack linked via web with telegram_chat_id:', linkedPack.tg.telegram_chat_id);
          }
        }
        
        if (linkedPack && linkedPack.tg?.telegram_chat_id) {
          // Found linked pack! Use its telegram_chat_id
          chatIdOrUsername = linkedPack.tg.telegram_chat_id;
          pack = linkedPack;
          console.log('[VERIFY_TG] Using stored telegram_chat_id:', chatIdOrUsername);
        } else {
          // Need user to provide the chat_id manually via link action
          const botUsername = await tgService.getBotUsername().catch(() => '@Launch_kit_bot');
          
          await callback({
            text: `✅ **I can see you're in a Telegram group!**\n\n` +
              `To verify, I need the numeric chat_id. Here's how to get it:\n\n` +
              `**Telegram Desktop:**\n` +
              `1. Right-click any message → "Copy Message Link"\n` +
              `2. You'll get: \`https://t.me/c/3663256702/123\`\n` +
              `3. Take the number after /c/: \`3663256702\`\n` +
              `4. Add \`-100\` prefix: \`-1003663256702\`\n\n` +
              `**Then say:** "link ${pack?.brand?.ticker || 'TOKEN'} to -100xxxxxxxxxx"\n\n` +
              `After linking, verification will work automatically! 🚀`,
            data: { launchPackId: pack?.id, roomId, isGroup: true },
          });
          
          return {
            text: 'Need chat_id to verify - prompted user',
            success: true,
          };
        }
      }
    }
    
    if (!chatIdOrUsername) {
      // No chat_id available - show instructions
      const botUsername = await tgService.getBotUsername().catch(() => '@Launch_kit_bot');
      
      await callback({
        text: `📱 **Telegram Group Setup Needed**\n\n` +
          `To verify Telegram, please do this:\n\n` +
          `1️⃣ Go to your Telegram group\n\n` +
          `2️⃣ Make sure I'm (${botUsername}) added as admin\n\n` +
          `3️⃣ Get your chat_id via Telegram Desktop:\n` +
          `   • Right-click message → Copy Message Link\n` +
          `   • Extract number, add -100 prefix\n\n` +
          `4️⃣ Say: "link ${pack?.brand?.ticker || 'TOKEN'} to -100xxxxxxxxxx"\n\n` +
          `💡 Once linked, verification works automatically!`,
        data: { launchPackId },
      });
      return {
        text: 'Please link with chat_id first',
        success: false,
      };
    }
    
    // Verify bot membership using the real Telegram chat_id
    console.log('[VERIFY_TG] Verifying bot membership for chat_id:', chatIdOrUsername);
    const result = await tgService.verifyBotInGroup(chatIdOrUsername);
    
    if (!result.success) {
      const botUsername = await tgService.getBotUsername().catch(() => '[Your Bot]');
      
      let errorMessage = `❌ **Telegram Setup Incomplete**\n\n`;
      errorMessage += `Error: ${result.error}\n\n`;
      
      if (result.errorCode === 'BOT_NOT_IN_GROUP') {
        errorMessage += `**To fix:**\n`;
        errorMessage += `1. Open your Telegram group\n`;
        errorMessage += `2. Add ${botUsername} to the group\n`;
        errorMessage += `3. Make ${botUsername} an admin\n`;
        errorMessage += `4. Come back and say "verify telegram" again\n`;
      }
      
      await callback({
        text: errorMessage,
        data: { launchPackId, error: result.error },
      });
      
      return {
        text: result.error || 'Verification failed',
        success: false,
      };
    }
    
    // Update LaunchPack with verified chat_id if we have one
    if (pack && result.chatId) {
      await store.update(pack.id, {
        tg: {
          ...(pack.tg || {}),
          telegram_chat_id: result.chatId, // Store the real Telegram chat_id
          verified: true,
          verified_at: new Date().toISOString(),
          chat_title: result.chatTitle,
          is_admin: result.isAdmin,
          can_post: result.canPost,
          can_pin: result.canPin,
        },
        links: {
          ...(pack.links || {}),
          telegram: telegramLink || pack.links?.telegram,
        },
      });
    }
    
    // Build status message
    let statusMessage = `✅ **Telegram Setup Verified**\n\n`;
    statusMessage += `📱 Group: ${result.chatTitle || 'Unknown'}\n`;
    statusMessage += `🆔 Chat ID: ${result.chatId}\n`;
    statusMessage += `👤 Bot Status: ${result.botStatus}\n`;
    statusMessage += `🔐 Admin: ${result.isAdmin ? '✅ Yes' : '⚠️ No'}\n`;
    statusMessage += `📝 Can Post: ${result.canPost ? '✅ Yes' : '❌ No'}\n`;
    statusMessage += `📌 Can Pin: ${result.canPin ? '✅ Yes' : '⚠️ No'}\n`;
    
    if (!result.isAdmin) {
      const botUsername = await tgService.getBotUsername().catch(() => '[Your Bot]');
      statusMessage += `\n⚠️ **Recommended:** Make ${botUsername} an admin for full features (pinning, deleting).`;
    }
    
    if (pack) {
      statusMessage += `\n\n🪙 Linked to: **${pack.brand?.name}** ($${pack.brand?.ticker})`;
    }
    
    return {
      text: statusMessage,
      success: true,
      data: { 
        launchPackId: pack?.id,
        chatId: result.chatId,
        chatTitle: result.chatTitle,
        isAdmin: result.isAdmin,
        canPost: result.canPost,
        canPin: result.canPin,
      },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'verify telegram setup' } },
      { name: 'eliza', content: { text: '✅ Telegram Setup Verified\n\n📱 Group: $TOKEN\n🆔 Chat ID: -100xxx\n👤 Bot Status: administrator\n🔐 Admin: ✅ Yes\n📝 Can Post: ✅ Yes\n📌 Can Pin: ✅ Yes', actions: ['VERIFY_TELEGRAM_SETUP'] } },
    ],
    [
      { name: 'user', content: { text: 'verify telegram' } },
      { name: 'eliza', content: { text: '✅ Telegram Setup Verified', actions: ['VERIFY_TELEGRAM_SETUP'] } },
    ],
  ],
};

/**
 * Action to verify ALL linked Telegram groups at once
 * User says: "verify telegram" or "verify all telegram groups"
 */
export const verifyAllTelegramAction: Action = {
  name: 'VERIFY_ALL_TELEGRAM',
  similes: ['VERIFY_TG_ALL', 'CHECK_ALL_TELEGRAM', 'VERIFY_TELEGRAMS'],
  description: 'Verify all linked Telegram groups for all LaunchPacks at once',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const isFromTelegram = message.content?.source === 'telegram';
    
    // Only trigger from web client (not Telegram)
    if (isFromTelegram) return false;
    
    // Check for verify telegram intent
    const hasVerifyIntent = /verif.*telegram|telegram.*verif|check.*telegram|telegram.*check|telegram.*status/i.test(text);
    
    // Don't trigger if there's a specific t.me link (let the other action handle that)
    const hasTelegramLink = /t\.me\//.test(text);
    if (hasTelegramLink) return false;
    
    return hasVerifyIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Remove REPLY to prevent duplicate
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) actions.splice(replyIndex, 1);
    }

    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return { text: '❌ LaunchKit store unavailable', success: false };
    }

    const tgService = new TelegramSetupService();
    if (!tgService.isConfigured()) {
      await callback({
        text: `❌ **Telegram bot not configured**\n\nSet TG_BOT_TOKEN in .env to enable Telegram features.`,
      });
      return { text: 'Telegram not configured', success: false };
    }

    const packs = await store.list();
    const packsWithTg = packs.filter((p: any) => p.tg?.telegram_chat_id);
    
    if (packsWithTg.length === 0) {
      await callback({
        text: `📱 **No Telegram Groups Linked**\n\n` +
          `None of your LaunchPacks have Telegram groups linked yet.\n\n` +
          `To link a group, say: "link [TOKEN NAME] to -100xxxxxxxxxx"`,
      });
      return { text: 'No groups to verify', success: false };
    }

    // Verify all linked groups
    let results: string[] = [];
    let successCount = 0;
    
    for (const pack of packsWithTg) {
      const chatId = pack.tg.telegram_chat_id;
      const tokenName = `${pack.brand?.name} ($${pack.brand?.ticker})`;
      
      try {
        const result = await tgService.verifyBotInGroup(chatId);
        
        if (result.success) {
          successCount++;
          
          // Update the pack with latest verification info
          await store.update(pack.id, {
            tg: {
              ...pack.tg,
              verified: true,
              verified_at: new Date().toISOString(),
              chat_title: result.chatTitle || pack.tg.chat_title,
              is_admin: result.isAdmin,
              can_post: result.canPost,
              can_pin: result.canPin,
              invite_link: result.inviteLink || pack.tg.invite_link,
            },
          });
          
          results.push(
            `✅ **${tokenName}**\n` +
            `   📱 ${result.chatTitle || 'Unknown'}\n` +
            `   🔐 Admin: ${result.isAdmin ? '✅' : '⚠️'} | 📝 Post: ${result.canPost ? '✅' : '❌'} | 📌 Pin: ${result.canPin ? '✅' : '⚠️'}` +
            (result.inviteLink ? `\n   🔗 ${result.inviteLink}` : '')
          );
        } else {
          results.push(`⚠️ **${tokenName}**: ${result.error || 'Verification failed'}`);
        }
      } catch (err: any) {
        results.push(`❌ **${tokenName}**: ${err.message}`);
      }
    }
    
    await callback({
      text: `📱 **Telegram Verification Complete**\n\n` +
        `Verified ${successCount}/${packsWithTg.length} groups:\n\n` +
        results.join('\n\n'),
    });
    
    return {
      text: `Verified ${successCount}/${packsWithTg.length} Telegram groups`,
      success: true,
      data: { verified: successCount, total: packsWithTg.length },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'verify telegram' } },
      { name: 'eliza', content: { text: '📱 Telegram Verification Complete\n\nVerified 2/2 groups', actions: ['VERIFY_ALL_TELEGRAM'] } },
    ],
  ],
};

/**
 * Action to update social links on a LaunchPack
 * User provides website, twitter/x, telegram links
 */
export const updateSocialLinksAction: Action = {
  name: 'UPDATE_SOCIAL_LINKS',
  similes: ['SET_LINKS', 'ADD_LINKS', 'SOCIAL_LINKS', 'SET_WEBSITE', 'SET_TWITTER', 'SET_TELEGRAM'],
  description: 'Update social links (website, X/Twitter, Telegram) for a LaunchPack',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Check for link-setting intent
    const hasSetIntent = /set|add|update|change|link/.test(text);
    const hasLinkType = /website|site|twitter|x\.com|telegram|t\.me|social/.test(text);
    
    // Check for actual URLs
    const hasUrl = /https?:\/\/|t\.me\/|x\.com|twitter\.com/.test(text);
    
    return (hasSetIntent && hasLinkType) || hasUrl;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const text = String(message.content?.text ?? '');
    let launchPackId = extractLaunchPackId(message);
    
    // If no UUID, try to find most recent LaunchPack
    if (!launchPackId) {
      const packs = await store.list();
      if (packs.length === 1) {
        launchPackId = packs[0].id;
      } else if (packs.length > 1) {
        // Find most recently created
        const sorted = packs.sort((a: any, b: any) => 
          new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        launchPackId = sorted[0].id;
      }
    }
    
    if (!launchPackId) {
      return {
        text: '❌ No LaunchPack found. Create one first by describing your token idea!',
        success: false,
      };
    }
    
    const pack = await store.get(launchPackId);
    if (!pack) {
      return {
        text: '❌ LaunchPack not found.',
        success: false,
      };
    }
    
    // Extract links from message
    const newLinks = extractSocialLinks(text);
    
    // Merge with existing links
    const updatedLinks = {
      website: newLinks.website || pack.links?.website,
      x: newLinks.x || pack.links?.x,
      telegram: newLinks.telegram || pack.links?.telegram,
    };
    
    // Check if we found any new links
    const foundLinks: string[] = [];
    if (newLinks.website) foundLinks.push(`Website: ${newLinks.website}`);
    if (newLinks.x) foundLinks.push(`X: ${newLinks.x}`);
    if (newLinks.xHandle) foundLinks.push(`X Handle: ${newLinks.xHandle}`);
    if (newLinks.telegram) foundLinks.push(`Telegram: ${newLinks.telegram}`);
    
    if (foundLinks.length === 0) {
      return {
        text: `❌ No links detected in your message.\n\nExamples:\n• "set website https://moondog.io"\n• "set x handle to @moondogtoken"\n• "telegram: t.me/moondogcommunity"`,
        success: false,
      };
    }
    
    // Build update payload - include x.handle if provided
    const updatePayload: any = {
      links: updatedLinks,
    };
    
    // If xHandle was extracted, also update x.handle in the LaunchPack
    if (newLinks.xHandle) {
      updatePayload.x = {
        ...(pack.x || {}),
        handle: newLinks.xHandle,
      };
    }
    
    // Update LaunchPack
    await store.update(launchPackId, updatePayload);
    
    // If telegram link provided, offer to verify
    let responseText = `✅ Updated social links for **${pack.brand?.name}**:\n\n`;
    responseText += foundLinks.map(l => `• ${l}`).join('\n');
    responseText += `\n\n📦 These will be included when you launch on pump.fun.`;
    
    if (newLinks.telegram) {
      responseText += `\n\n💡 Say "verify telegram" to check bot access to your group.`;
    }
    
    await callback({
      text: responseText,
      data: { launchPackId, links: updatedLinks },
    });
    
    return {
      text: `Updated ${foundLinks.length} social links`,
      success: true,
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'set website https://moondog.io' } },
      { name: 'eliza', content: { text: '✅ Updated social links', actions: ['UPDATE_SOCIAL_LINKS'] } },
    ],
    [
      { name: 'user', content: { text: 'telegram is t.me/moondogcommunity and twitter @moondog' } },
      { name: 'eliza', content: { text: '✅ Updated social links', actions: ['UPDATE_SOCIAL_LINKS'] } },
    ],
  ],
};

/**
 * Pre-launch checklist action
 * Prompts user about Telegram setup before allowing launch
 */
export const preLaunchChecklistAction: Action = {
  name: 'PRE_LAUNCH_CHECKLIST',
  similes: ['LAUNCH_CHECKLIST', 'READY_TO_LAUNCH', 'LAUNCH_STATUS'],
  description: 'Check if LaunchPack is ready for launch and prompt for missing items',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Check for pre-launch/status intent
    return /checklist|ready|status|pre-?launch|before launch/.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const text = String(message.content?.text ?? '');
    let launchPackId = extractLaunchPackId(message);
    
    // First: Try to find LaunchPack ID from recent conversation context
    if (!launchPackId) {
      try {
        const memories = await runtime.getMemories({
          roomId: message.roomId as any,
          tableName: 'messages',
          count: 50,
        });
        
        // Sort by createdAt descending (newest first)
        const sorted = memories.sort((a, b) => {
          const timeA = a.createdAt || 0;
          const timeB = b.createdAt || 0;
          return timeB - timeA;
        });
        
        // Look for LaunchPack ID in recent messages
        for (const mem of sorted) {
          const data = mem.content?.data as any;
          if (data?.launchPackId && UUID_RE.test(data.launchPackId)) {
            launchPackId = data.launchPackId;
            break;
          }
          // Also check text for UUID
          const textMatch = String(mem.content?.text ?? '').match(UUID_RE);
          if (textMatch?.[0]) {
            launchPackId = textMatch[0];
            break;
          }
        }
      } catch {
        // Memory lookup failed, continue to database fallback
      }
    }
    
    // Second: Fall back to database - find most recent unlaunched pack
    if (!launchPackId) {
      const packs = await store.list();
      const notLaunched = packs.filter((p: any) => p.launch?.status !== 'launched');
      if (notLaunched.length === 1) {
        launchPackId = notLaunched[0].id;
      } else if (notLaunched.length > 1) {
        const sorted = notLaunched.sort((a: any, b: any) => 
          new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        launchPackId = sorted[0].id;
      } else if (packs.length > 0) {
        return {
          text: '✅ All your tokens have already been launched!',
          success: true,
        };
      }
    }
    
    if (!launchPackId) {
      return {
        text: '❌ No LaunchPack found. Create one first by describing your token idea!',
        success: false,
      };
    }
    
    const pack = await store.get(launchPackId);
    if (!pack) {
      return {
        text: '❌ LaunchPack not found.',
        success: false,
      };
    }
    
    // Check if already launched
    const isLaunched = pack.launch?.status === 'launched';
    const mintAddress = pack.launch?.mint;
    const pumpUrl = pack.launch?.pump_url || (mintAddress ? `https://pump.fun/coin/${mintAddress}` : null);
    
    // If already launched, show different view
    if (isLaunched && mintAddress) {
      let response = `🚀 **${pack.brand?.name} ($${pack.brand?.ticker}) is LIVE!**\n\n`;
      response += `🪙 **Contract Address:** \`${mintAddress}\`\n`;
      response += `📊 **Chart:** ${pumpUrl}\n\n`;
      response += `**Marketing Status:**\n`;
      
      const tgSchedulerActive = pack.ops?.tg_scheduler_enabled;
      const xMarketingActive = pack.ops?.x_marketing_enabled;
      
      response += `• Telegram Scheduler: ${tgSchedulerActive ? '✅ Active' : '⚠️ Not started - say "start TG scheduler"'}\n`;
      response += `• X Marketing: ${xMarketingActive ? '✅ Active' : '⚠️ Not started - say "start X marketing"'}\n`;
      
      if (pack.mascot?.name) {
        response += `• Mascot: ✅ ${pack.mascot.name}\n`;
      }
      
      await callback({
        text: response,
        data: { launchPackId, launched: true, mintAddress, pumpUrl },
      });
      
      return { text: 'Token is live', success: true };
    }
    
    // Build checklist for unlaunched tokens
    const checklist: { item: string; status: '✅' | '⚠️' | '❌'; note?: string }[] = [];
    
    // Token basics
    checklist.push({
      item: 'Token Name & Ticker',
      status: pack.brand?.name && pack.brand?.ticker ? '✅' : '❌',
      note: pack.brand?.name ? `${pack.brand.name} ($${pack.brand.ticker})` : 'Missing',
    });
    
    // Logo
    checklist.push({
      item: 'Logo',
      status: pack.assets?.logo_url ? '✅' : '❌',
      note: pack.assets?.logo_url ? 'Set' : 'Required for launch',
    });
    
    // Social links
    checklist.push({
      item: 'Website',
      status: pack.links?.website ? '✅' : '⚠️',
      note: pack.links?.website || 'Optional but recommended',
    });
    
    checklist.push({
      item: 'X/Twitter',
      status: pack.links?.x ? '✅' : '⚠️',
      note: pack.links?.x || 'Optional but recommended',
    });
    
    // Telegram - special handling
    const hasTgLink = Boolean(pack.links?.telegram);
    const hasTgChatId = Boolean(pack.tg?.chat_id);
    const tgVerified = Boolean(pack.tg?.verified);
    
    if (hasTgChatId && tgVerified) {
      checklist.push({
        item: 'Telegram Group',
        status: '✅',
        note: `Verified: ${pack.tg?.chat_title || pack.tg?.chat_id}`,
      });
    } else if (hasTgLink || hasTgChatId) {
      const isPendingPrivate = pack.tg?.pending_verification;
      checklist.push({
        item: 'Telegram Group',
        status: '⚠️',
        note: isPendingPrivate 
          ? 'Link saved, waiting for bot to be added to group'
          : 'Link set but not verified. Say "verify telegram"',
      });
    } else {
      checklist.push({
        item: 'Telegram Group',
        status: '⚠️',
        note: 'No group linked. Optional but recommended for community.',
      });
    }
    
    // Marketing copy
    const hasTgPins = pack.tg?.pins?.welcome || pack.tg?.pins?.how_to_buy;
    const hasXThread = pack.x?.thread?.length > 0;
    
    checklist.push({
      item: 'Marketing Copy',
      status: hasTgPins || hasXThread ? '✅' : '⚠️',
      note: hasTgPins || hasXThread ? 'Generated' : 'Run "generate copy" for TG pins & X posts',
    });
    
    // Mascot (optional but recommended for community engagement)
    const hasMascot = Boolean((pack as any).mascot?.name);
    checklist.push({
      item: 'Community Mascot',
      status: hasMascot ? '✅' : '⚠️',
      note: hasMascot 
        ? `${(pack as any).mascot.name} - ${(pack as any).mascot.personality?.substring(0, 30)}...` 
        : 'Optional - say "set mascot" for custom bot personality in TG',
    });
    
    // Build response
    let response = `📋 **Pre-Launch Checklist** for ${pack.brand?.name}\n\n`;
    
    for (const item of checklist) {
      response += `${item.status} ${item.item}`;
      if (item.note) response += ` - ${item.note}`;
      response += `\n`;
    }
    
    // Overall status
    const hasRequiredItems = pack.brand?.name && pack.brand?.ticker && pack.assets?.logo_url;
    const hasRecommendedItems = pack.links?.telegram || pack.links?.x;
    
    response += `\n---\n`;
    
    if (!hasRequiredItems) {
      response += `\n❌ **Not ready to launch** - missing required items.`;
    } else if (!hasRecommendedItems) {
      response += `\n⚠️ **Ready but incomplete** - consider adding social links for better visibility.`;
      response += `\n\n💡 To add links, say something like:\n`;
      response += `"telegram is t.me/yourgroup, twitter @yourhandle"`;
      response += `\n\n🚀 Or say "launch" to proceed anyway!`;
    } else if (!tgVerified && hasTgLink) {
      const isPendingPrivate = pack.tg?.pending_verification;
      const tgService = new TelegramSetupService();
      const botUsername = await tgService.getBotUsername().catch(() => '[Your Bot]');
      
      response += `\n⚠️ **Almost ready** - complete your Telegram setup:\n`;
      
      if (isPendingPrivate) {
        response += `\n**Your TG link is saved!** To enable auto-posting:\n\n`;
        response += `1️⃣ Open your Telegram group\n`;
        response += `2️⃣ Go to **Settings** → **Administrators** → **Add Admin**\n`;
        response += `3️⃣ Search for ${botUsername} and add me as admin\n`;
        response += `4️⃣ Then say **"verify telegram"** here\n\n`;
        response += `💡 Or say **"launch anyway"** to proceed without TG auto-posting.`;
      } else {
        response += `\nSay "verify telegram" to check bot access.`;
      }
    } else {
      response += `\n✅ **Ready to launch!** Say "launch" or "deploy" to go live.`;
    }
    
    await callback({
      text: response,
      data: { 
        launchPackId, 
        ready: hasRequiredItems,
        checklist: checklist.map(c => ({ item: c.item, status: c.status })),
      },
    });
    
    return {
      text: hasRequiredItems ? 'Ready to launch' : 'Not ready - missing items',
      success: hasRequiredItems,
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'am I ready to launch?' } },
      { name: 'eliza', content: { text: '📋 Pre-Launch Checklist...', actions: ['PRE_LAUNCH_CHECKLIST'] } },
    ],
    [
      { name: 'user', content: { text: 'show launch checklist' } },
      { name: 'eliza', content: { text: '📋 Pre-Launch Checklist...', actions: ['PRE_LAUNCH_CHECKLIST'] } },
    ],
  ],
};

/**
 * Community Engagement Action
 * Responds naturally to messages in Telegram groups the bot manages
 * The bot engages as the token's "community manager" personality
 */
export const communityEngagementAction: Action = {
  name: 'COMMUNITY_ENGAGEMENT',
  similes: ['TG_COMMUNITY', 'ENGAGE_COMMUNITY'],
  description: 'Respond to community messages in Telegram groups as the token personality',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Only for Telegram group messages
    if (message.content?.source !== 'telegram') return false;
    
    const chatId = String(message.content?.chatId ?? message.roomId ?? '');
    if (!chatId || !chatId.startsWith('-100')) return false;
    
    // Check if we manage this group
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) return false;
    
    try {
      const packs = await store.list();
      const pack = packs.find((p: any) => p.tg?.chat_id === chatId && (p.tg?.verified || p.launch?.status === 'launched'));
      return Boolean(pack);
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    const communityService = kit?.telegramCommunity;
    
    if (!store || !communityService) {
      return { text: '', success: false };
    }
    
    const chatId = String(message.content?.chatId ?? message.roomId ?? '');
    const text = String(message.content?.text ?? '');
    const fromContent = (message.content?.from ?? {}) as { first_name?: string };
    const userName = String(message.content?.userName ?? fromContent.first_name ?? '');
    
    // Find the LaunchPack for this group
    const pack = await communityService.findPackForChat(chatId);
    if (!pack) {
      return { text: '', success: false };
    }
    
    // Generate a response based on the message
    const response = await communityService.generateCommunityResponse(pack, text, userName);
    
    if (response) {
      await callback({
        text: response,
        data: { 
          launchPackId: pack.id, 
          engagement: true,
          chatId,
        },
        source: 'telegram',
      });
      
      return {
        text: response,
        success: true,
      };
    }
    
    // No response needed - message didn't match any patterns
    return { text: '', success: true };
  },
  examples: [
    [
      { name: 'user', content: { text: 'what is the CA?', source: 'telegram' } },
      { name: 'eliza', content: { text: '🎯 Here\'s the CA...', actions: ['COMMUNITY_ENGAGEMENT'] } },
    ],
    [
      { name: 'user', content: { text: 'gm everyone!', source: 'telegram' } },
      { name: 'eliza', content: { text: 'GM! ☀️ Ready for another day...', actions: ['COMMUNITY_ENGAGEMENT'] } },
    ],
    [
      { name: 'user', content: { text: 'how do I buy this token?', source: 'telegram' } },
      { name: 'eliza', content: { text: '💎 How to buy $TOKEN...', actions: ['COMMUNITY_ENGAGEMENT'] } },
    ],
  ],
};

/**
 * Action to rename a LaunchPack (name or ticker)
 * User says: "rename RUG to GPTRug" or "change ticker to $GRUG"
 */
export const renameLaunchPackAction: Action = {
  name: 'RENAME_LAUNCHPACK',
  similes: ['CHANGE_TOKEN_NAME', 'UPDATE_NAME', 'CHANGE_TICKER'],
  description: 'Rename a LaunchPack token name or change its ticker',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Match: "rename X to Y", "change X to Y", "change ticker to X", "set ticker to X"
    return /rename\s+\S+\s+to\s+\S+|chang\S*\s+\S+\s+to\s+\S+|change\s+ticker|set\s+ticker|update\s+ticker/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[RENAME] Removed REPLY from actions to prevent duplicate message');
      }
    }

    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const text = String(message.content?.text ?? '');
    const packs = await store.list();
    
    // Parse for both name change and ticker change in the same message
    // "chang RUG to GPTRug and change $again to $RUG"
    
    // Extract name rename: "chang/change/rename X to Y"
    const renameMatch = text.match(/(?:rename|chang\w*)\s+(?:token\s+)?(?:name\s+)?(?:from\s+)?(\S+)\s+to\s+(\S+?)(?:\s+and|\s*$)/i) ||
                       text.match(/(?:rename|chang\w*)\s+(?:token\s+)?(\S+)\s+to\s+(\S+)/i);
    
    // Extract ticker change: "change $X to $Y" or "ticker to $X"  
    const tickerMatch = text.match(/(?:change|set|update)\s+\$?(\w+)\s+to\s+\$([A-Z0-9]{2,10})/i) ||
                       text.match(/ticker\s+(?:to\s+)?\$?([A-Z0-9]{2,10})/i) ||
                       text.match(/\$(\w+)\s+to\s+\$([A-Z0-9]{2,10})/i);
    
    let nameChange: { old: string; new: string } | null = null;
    let tickerChange: { old: string; new: string } | null = null;
    let pack: any = null;
    
    // Determine what changes are being requested
    if (renameMatch) {
      const oldName = renameMatch[1].trim().replace(/^\$/, '');
      const newName = renameMatch[2].trim().replace(/^\$/, '');
      // Don't treat ticker patterns as name changes
      if (!/^\$?[A-Z]{2,6}$/i.test(oldName) || !/ticker/i.test(text.substring(0, text.indexOf(oldName)))) {
        nameChange = { old: oldName, new: newName };
      }
    }
    
    if (tickerMatch) {
      // Handle "change $AGAIN to $RUG" format
      if (tickerMatch[2]) {
        tickerChange = { old: tickerMatch[1].toUpperCase(), new: tickerMatch[2].toUpperCase() };
      } else {
        tickerChange = { old: '', new: tickerMatch[1].toUpperCase() };
      }
    }
    
    // Find the pack to update
    if (nameChange) {
      pack = packs.find((p: any) => 
        p.brand?.name?.toLowerCase() === nameChange!.old.toLowerCase() ||
        p.brand?.ticker?.toLowerCase() === nameChange!.old.toLowerCase()
      );
    }
    
    if (!pack && tickerChange?.old) {
      pack = packs.find((p: any) => 
        p.brand?.ticker?.toLowerCase() === tickerChange!.old.toLowerCase()
      );
    }
    
    // Default to most recent unlaunched pack
    if (!pack) {
      pack = packs.find((p: any) => p.launch?.status !== 'launched') || packs[0];
    }
    
    if (!pack) {
      const packList = packs.map((p: any) => `${p.brand?.name} ($${p.brand?.ticker})`).join(', ');
      await callback({
        text: `❌ **No LaunchPack found**\n\nAvailable: ${packList || 'None'}`,
      });
      return { text: 'No pack found', success: false };
    }
    
    // Apply changes
    const updates: any = { brand: { ...pack.brand } };
    const changes: string[] = [];
    
    if (nameChange) {
      const oldNameValue = pack.brand?.name;
      updates.brand.name = nameChange.new;
      changes.push(`📝 Name: "${oldNameValue}" → "${nameChange.new}"`);
    }
    
    if (tickerChange) {
      const oldTickerValue = pack.brand?.ticker;
      updates.brand.ticker = tickerChange.new;
      changes.push(`🏷️ Ticker: $${oldTickerValue} → $${tickerChange.new}`);
    }
    
    if (changes.length === 0) {
      await callback({
        text: `⚠️ **Rename/Ticker Format**\n\n` +
          `**Change Name:**\n` +
          `• "rename RUG to GPTRug"\n` +
          `• "change name from X to Y"\n\n` +
          `**Change Ticker:**\n` +
          `• "change $AGAIN to $RUG"\n` +
          `• "set ticker to RUG"\n\n` +
          `**Both at once:**\n` +
          `• "rename RUG to GPTRug and change ticker to $RUG"`,
      });
      return { text: 'No valid changes detected', success: false };
    }
    
    await store.update(pack.id, updates);
    
    await callback({
      text: `✅ **Updated!**\n\n${changes.join('\n')}\n\n📦 ID: ${pack.id}`,
      data: { launchPackId: pack.id, nameChange, tickerChange },
    });
    
    return { 
      text: `Updated: ${changes.join(', ')}`, 
      success: true 
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'rename RUG to GPTRug' } },
      { name: 'eliza', content: { text: '✅ Updated! Name: "RUG" → "GPTRug"', actions: ['RENAME_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'change $AGAIN to $RUG' } },
      { name: 'eliza', content: { text: '✅ Updated! Ticker: $AGAIN → $RUG', actions: ['RENAME_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'rename RUG to GPTRug and change ticker to $RUG' } },
      { name: 'eliza', content: { text: '✅ Updated! Name and Ticker changed', actions: ['RENAME_LAUNCHPACK'] } },
    ],
  ],
};

/**
 * Action to kick/ban a spammer from the Telegram group
 * Triggered when agent detects spam or is asked to kick someone
 */
export const kickSpammerAction: Action = {
  name: 'KICK_SPAMMER',
  similes: ['BAN_USER', 'REMOVE_SPAMMER', 'KICK_USER', 'BAN_SPAMMER', 'WARN_SCAMMER'],
  description: 'Kick or ban a user from the Telegram group for spamming, scamming, shilling other projects, or violating community rules. Use this when someone posts fake giveaways, wallet screenshots with "DM me" messages, advertises other tokens, posts scam links, or repeatedly breaks rules. For first offenses on minor violations, warn the user. For obvious scams (fake giveaways, recovery scams), kick immediately.',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    // Only works in Telegram context
    if (message.content?.source !== 'telegram') return false;
    
    const text = String(message.content?.text ?? '');
    
    // Use the comprehensive scam detection
    const scamResult = detectScam(text);
    if (scamResult) {
      console.log(`[KICK_SPAMMER] Scam detected: ${scamResult.reason} (severity: ${scamResult.severity})`);
      // Store the detection result on the message for the handler to use
      (message as any)._scamDetection = scamResult;
      return true;
    }
    
    // Also check for explicit kick/ban requests from admins
    if (/kick|ban|remove.*spam/i.test(text.toLowerCase())) {
      return true;
    }
    
    return false;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Remove REPLY from actions array to prevent duplicate messages
    // This action handles its own response via callback
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[KICK_SPAMMER] Removed REPLY from actions to prevent duplicate message');
      }
    }

    const kit = requireLaunchKit(runtime);
    if (!kit) {
      return { text: 'LaunchKit not available', success: false };
    }
    
    const telegramCommunity = kit.telegramCommunity;
    if (!telegramCommunity) {
      return { text: 'Telegram service not available', success: false };
    }
    
    // Debug: Log full message structure to find where user info is
    console.log('[KICK_SPAMMER] Full message object:', JSON.stringify({
      content: message.content,
      entityId: message.entityId,
      roomId: message.roomId,
    }, null, 2));
    
    // Get user info from message - try multiple locations
    const metadata = message.content?.metadata as any;
    const content = message.content as any;
    
    // Try different places where ElizaOS might store user info
    const userId = 
      metadata?.userId || 
      metadata?.from?.id ||
      content?.userId ||
      content?.from?.id ||
      (message as any).userId ||
      (message as any).senderId;
      
    const username = 
      metadata?.username || 
      metadata?.from?.username ||
      content?.username ||
      content?.from?.username ||
      'unknown';
      
    const messageId = 
      metadata?.messageId || 
      metadata?.message_id ||
      content?.messageId ||
      content?.message_id ||
      metadata?.telegram?.message_id ||
      content?.telegram?.message_id;
    
    console.log('[KICK_SPAMMER] Message data:', {
      messageId,
      metadataKeys: Object.keys(metadata || {}),
      contentKeys: Object.keys(content || {}),
      hasRawTelegram: !!metadata?.telegram || !!content?.telegram,
      rawMetadata: JSON.stringify(metadata)?.slice(0, 500),
    });
    
    // Get chat ID from the room
    const room = await runtime.getRoom(message.roomId as any);
    const chatId = room?.channelId;
    
    // Try to get user info from entity
    let entityUserId: number | undefined;
    let entityUsername: string | undefined;
    let entityName: string | undefined;
    if (message.entityId) {
      try {
        const entity = await runtime.getEntityById(message.entityId as any);
        console.log('[KICK_SPAMMER] Entity:', JSON.stringify(entity, null, 2));
        
        // Try to extract Telegram user ID from various locations
        const tgMeta = (entity?.metadata as any)?.telegram;
        entityUserId = tgMeta?.userId || tgMeta?.id || tgMeta?.user_id;
        // Check both userName (capital N) and username (lowercase) since ElizaOS uses different formats
        entityUsername = tgMeta?.userName || tgMeta?.username || entity?.metadata?.username;
        entityName = tgMeta?.name || entity?.names?.[0];
        
        // Try to look up from our cache using entityId
        if (!entityUserId && chatId) {
          const cachedByEntity = lookupTelegramUserByEntity(message.entityId as string);
          if (cachedByEntity) {
            console.log('[KICK_SPAMMER] Found user in cache by entityId:', cachedByEntity);
            entityUserId = cachedByEntity.id;
            entityUsername = cachedByEntity.username;
          }
        }
        
        // Try to look up from our cache using name
        if (!entityUserId && chatId && entityName) {
          const cachedByName = lookupTelegramUser(chatId, entityName);
          if (cachedByName) {
            console.log('[KICK_SPAMMER] Found user in cache by name:', cachedByName);
            entityUserId = cachedByName.id;
            entityUsername = cachedByName.username;
          }
        }
      } catch (e) {
        console.log('[KICK_SPAMMER] Could not get entity:', e);
      }
    }
    
    const finalUserId = userId || entityUserId;
    const finalUsername = username !== 'unknown' ? username : (entityUsername || 'unknown');
    const finalName = entityName || finalUsername;

    if (!chatId) {
      console.log('[KICK_SPAMMER] Missing chatId:', { chatId });
      return { text: 'Could not identify chat', success: false };
    }
    
    // Try to get the message ID to reply to for RoseBot
    const spamMessageId = messageId || content?.messageId || content?.message_id;
    
    // If we don't have user ID, try to search for them
    let searchedUserId: number | undefined;
    if (!finalUserId && chatId) {
      // Try searching by username first
      if (finalUsername && finalUsername !== 'unknown') {
        const searchResult = await telegramCommunity.searchChatMember(chatId, `@${finalUsername.replace('@', '')}`);
        if (searchResult.found && searchResult.userId) {
          searchedUserId = searchResult.userId;
          console.log(`[KICK_SPAMMER] Found user by username search: ${searchedUserId}`);
        }
      }
      
      // Try searching by name if username search failed
      if (!searchedUserId && finalName && finalName !== 'unknown') {
        const searchResult = await telegramCommunity.searchChatMember(chatId, finalName);
        if (searchResult.found && searchResult.userId) {
          searchedUserId = searchResult.userId;
          console.log(`[KICK_SPAMMER] Found user by name search: ${searchedUserId}`);
        }
      }
    }
    
    const userIdToKick = finalUserId || searchedUserId;
    
    // Get scam detection result (set during validate)
    let scamDetection = (message as any)._scamDetection as { isScam: boolean; reason: string; severity: 'warn' | 'kick' } | undefined;
    
    // If the LLM chose KICK_SPAMMER but validate didn't run detectScam
    // (e.g. the model picked the action from context), re-run detection now
    if (!scamDetection) {
      const text = String(message.content?.text ?? '');
      const recheck = detectScam(text);
      if (recheck) {
        scamDetection = recheck;
        console.log(`[KICK_SPAMMER] Re-detected scam in handler: ${recheck.reason} (severity: ${recheck.severity})`);
      }
    }

    // Determine whether to warn or kick based on severity and history
    let shouldKick = false;
    let warningCount = 0;
    
    // Check if this is an explicit admin kick/ban command (not LLM judgment)
    const messageText = String(message.content?.text ?? '').toLowerCase();
    const isExplicitKickCommand = /\b(?:kick|ban|remove)\b.*\b(?:spam|scam|user|member)\b/i.test(messageText) 
      || /\b(?:spam|scam).*\b(?:kick|ban|remove)\b/i.test(messageText);
    
    if (scamDetection && userIdToKick) {
      if (scamDetection.severity === 'kick') {
        // Obvious scam - kick immediately
        shouldKick = true;
        console.log(`[KICK_SPAMMER] Severe scam detected (${scamDetection.reason}) - kicking immediately`);
      } else {
        // Minor offense - check warning history
        const warningResult = trackScamWarning(chatId, userIdToKick, scamDetection.reason, message.entityId as string);
        warningCount = warningResult.warningCount;
        shouldKick = warningResult.shouldKick;
        
        if (!shouldKick) {
          // Just warn the user, don't kick yet
          console.log(`[KICK_SPAMMER] Warning user (${warningCount}/${WARNING_THRESHOLD}): ${scamDetection.reason}`);
          
          await callback({
            text: `⚠️ **WARNING ${warningCount}/${WARNING_THRESHOLD}** to ${finalName}\n\n` +
              `yo ser that's not cool - ${scamDetection.reason.toLowerCase()} ain't welcome here 🚫\n\n` +
              `this is your ${warningCount === 1 ? 'first' : 'final'} warning. ` +
              `${warningCount >= WARNING_THRESHOLD - 1 ? 'next offense = instant ban 🔨' : 'keep it clean or get rugged fren'}\n\n` +
              `we're here for legit community vibes only 💎`,
            actions: [],
          });
          
          return {
            text: `Warned user ${finalName} (${warningCount}/${WARNING_THRESHOLD})`,
            success: true,
            data: { warned: true, userId: userIdToKick, userName: finalName, warningCount, reason: scamDetection.reason }
          };
        }
      }
    } else if (!scamDetection && isExplicitKickCommand) {
      // Explicit admin kick/ban command with no scam pattern match - kick immediately
      shouldKick = true;
    } else if (!scamDetection && userIdToKick) {
      // LLM chose KICK_SPAMMER but no scam pattern matched — treat as warn-severity
      // This prevents instant bans for borderline messages the LLM flagged
      const warningResult = trackScamWarning(chatId, userIdToKick, 'LLM-flagged suspicious message', message.entityId as string);
      warningCount = warningResult.warningCount;
      shouldKick = warningResult.shouldKick;
      
      if (!shouldKick) {
        console.log(`[KICK_SPAMMER] LLM-flagged, warning user (${warningCount}/${WARNING_THRESHOLD})`);
        
        await callback({
          text: `⚠️ **WARNING ${warningCount}/${WARNING_THRESHOLD}** to ${finalName}\n\n` +
            `that message looks suspicious ser 🚫\n\n` +
            `this is your ${warningCount === 1 ? 'first' : 'final'} warning. ` +
            `${warningCount >= WARNING_THRESHOLD - 1 ? 'next offense = instant ban 🔨' : 'keep it clean or get rugged fren'}\n\n` +
            `we're here for legit community vibes only 💎`,
          actions: [],
        });
        
        return {
          text: `Warned user ${finalName} (${warningCount}/${WARNING_THRESHOLD})`,
          success: true,
          data: { warned: true, userId: userIdToKick, userName: finalName, warningCount, reason: 'LLM-flagged suspicious message' }
        };
      }
    } else if (!scamDetection) {
      // No scam detection AND no user ID — can't do anything meaningful
      shouldKick = true;
    }
    
    // If we found a user ID and should kick, do it
    if (userIdToKick && shouldKick) {
      console.log(`[KICK_SPAMMER] Kicking user ${finalName} (${userIdToKick}) from chat ${chatId} - reason: ${scamDetection?.reason || 'explicit request'}`);
      
      try {
        const kickResult = await telegramCommunity.kickUser(chatId, userIdToKick, {
          revokeMessages: true, // Delete their spam
        });
        
        if (kickResult.success) {
          console.log(`[KICK_SPAMMER] ✅ Successfully kicked user ${userIdToKick}`);
          
          // Clear their warnings since they're gone
          clearScamWarnings(chatId, userIdToKick);
          
          // Cross-ban: also remove from the other chat (community ↔ channel)
          crossBanUser(userIdToKick, { reason: scamDetection?.reason || 'KICK_SPAMMER', originChatId: chatId })
            .catch(e => console.log('[KICK_SPAMMER] Cross-ban error:', e));
          
          const reasonText = scamDetection?.reason 
            ? `**Reason:** ${scamDetection.reason}` 
            : 'shilling other projects';
          
          await callback({
            text: `🚫 **RUGGED** ${finalName} from the community! 💀\n\n` +
              `${reasonText}\n\n` +
              `${warningCount > 0 ? `⚠️ Had ${warningCount} prior warning(s)\n\n` : ''}` +
              `ser thought they could pull a fast one but got caught. scammers get what they deserve. 😈\n\n` +
              `🔨 BANNED - protect your wallets fam, never DM strangers!`,
            actions: [],
          });
          
          return { 
            text: `Kicked scammer ${finalName}`, 
            success: true,
            data: { kicked: true, userId: userIdToKick, userName: finalName, reason: scamDetection?.reason }
          };
        } else {
          console.log(`[KICK_SPAMMER] Failed to kick: ${kickResult.error}`);
          
          // Handle specific error cases
          if (kickResult.error?.includes('CHAT_ADMIN_REQUIRED')) {
            await callback({
              text: `⚠️ **SCAM DETECTED** from ${finalName}!\n\n` +
                `**${scamDetection?.reason || 'Spam/scam message'}**\n\n` +
                `🚫 I can't kick in this group (it's a basic group where everyone is admin).\n\n` +
                `**To enable kicks:**\n` +
                `1. Convert to supergroup (Settings → Group Type → Supergroup)\n` +
                `2. Or manually remove this user\n\n` +
                `⚠️ **DO NOT DM** this person - it's a scam!`,
              actions: [],
            });
            return { text: 'Cannot kick in basic group', success: false, error: 'CHAT_ADMIN_REQUIRED' };
          }
        }
      } catch (kickErr: any) {
        console.log(`[KICK_SPAMMER] Kick failed:`, kickErr.message);
        
        // Handle CHAT_ADMIN_REQUIRED error
        if (kickErr.message?.includes('CHAT_ADMIN_REQUIRED')) {
          await callback({
            text: `⚠️ **SCAM DETECTED** from ${finalName}!\n\n` +
              `**${scamDetection?.reason || 'Spam/scam message'}**\n\n` +
              `🚫 I can't kick in this group (it's a basic group where everyone is admin).\n\n` +
              `**To enable kicks:**\n` +
              `1. Convert to supergroup (Settings → Group Type → Supergroup)\n` +
              `2. Or manually remove this user\n\n` +
              `⚠️ **DO NOT DM** this person - it's a scam!`,
            actions: [],
          });
          return { text: 'Cannot kick in basic group', success: false, error: 'CHAT_ADMIN_REQUIRED' };
        }
      }
    }
    
    // If we still couldn't kick, try to find user in cache and ban directly
    if (!userIdToKick) {
      console.log('[KICK_SPAMMER] No user ID available - trying cache lookup');
      console.log('[KICK_SPAMMER] Available data:', { finalName, finalUsername, spamMessageId, chatId });
      
      // IMPORTANT: ElizaOS v1.7.0 strips user_id and message_id from Telegram updates!
      // We CANNOT reliably kick users directly without these IDs.
      // But we can try to look up users in our cache if they've sent messages.
      
      // Method 1: Look up user in our cache by username
      if (finalUsername && finalUsername !== 'unknown') {
        const cleanUsername = finalUsername.replace('@', '');
        const cachedUser = lookupTelegramUser(chatId, cleanUsername);
        
        if (cachedUser?.id) {
          console.log(`[KICK_SPAMMER] Found user in cache: ${cachedUser.id} (@${cleanUsername})`);
          
          // Try to ban directly via Telegram API
          try {
            const banResult = await telegramCommunity.kickMember(chatId, String(cachedUser.id));
            if (banResult.success) {
              console.log(`[KICK_SPAMMER] ✅ Banned user ${cachedUser.id} via cache lookup`);
              
              await callback({
                text: `🚫 **RUGGED** @${cleanUsername} from the $RUG zone! 💀\n\n` +
                  `User ID: \`${cachedUser.id}\`\n` +
                  `ser thought they could sneak in some other token but got caught. paper hands get what they deserve. 😈`,
                actions: [],
              });
              
              return { 
                text: `Banned @${cleanUsername} (${cachedUser.id})`, 
                success: true,
                data: { method: 'cache-lookup', kicked: true, userId: cachedUser.id, userName: cleanUsername }
              };
            }
          } catch (banErr: any) {
            console.log('[KICK_SPAMMER] Direct ban via cache failed:', banErr.message);
          }
        } else {
          console.log(`[KICK_SPAMMER] User @${cleanUsername} not in cache`);
        }
      }
      
      // Method 2: Look up by display name
      if (finalName && finalName !== finalUsername) {
        const cachedByName = lookupTelegramUser(chatId, finalName);
        
        if (cachedByName?.id) {
          console.log(`[KICK_SPAMMER] Found user in cache by name: ${cachedByName.id} (${finalName})`);
          
          try {
            const banResult = await telegramCommunity.kickMember(chatId, String(cachedByName.id));
            if (banResult.success) {
              console.log(`[KICK_SPAMMER] ✅ Banned user ${cachedByName.id} via name lookup`);
              
              await callback({
                text: `🚫 **RUGGED** ${finalName} from the $RUG zone! 💀\n\n` +
                  `ser thought they could sneak in some other token but got caught. paper hands get what they deserve. 😈`,
                actions: [],
              });
              
              return { 
                text: `Banned ${finalName} (${cachedByName.id})`, 
                success: true,
                data: { method: 'cache-name-lookup', kicked: true, userId: cachedByName.id, userName: finalName }
              };
            }
          } catch (banErr: any) {
            console.log('[KICK_SPAMMER] Direct ban via name failed:', banErr.message);
          }
        }
      }
      
      // Method 3: Fallback to RoseBot command (for external bot to handle)
      // This is a last resort - send /ban @username hoping RoseBot picks it up
      if (finalUsername && finalUsername !== 'unknown') {
        try {
          const cleanUsername = finalUsername.replace('@', '');
          const banCommand = `/ban @${cleanUsername}`;
          await telegramCommunity.sendMessageToChatId(chatId, banCommand);
          
          console.log(`[KICK_SPAMMER] Sent /ban @username command for RoseBot: ${banCommand}`);
          
          await callback({
            text: `🚫 **RUGGED** @${cleanUsername} for shilling other projects in the $RUG zone. 💀\n\n` +
              `ser thought they could sneak in some other token but got caught. paper hands get what they deserve. 😈`,
            actions: [],
          });
          
          return { 
            text: `Requested RoseBot ban for @${cleanUsername}`, 
            success: true,
            data: { method: 'rosebot-username', kicked: true, userName: cleanUsername }
          };
        } catch (roseBotErr: any) {
          console.log('[KICK_SPAMMER] RoseBot @username command failed:', roseBotErr.message);
        }
      }
      
      // Method 2: Try to reply to spam message with /ban (if we have message ID)
      // NOTE: ElizaOS doesn't pass message_id through, so this rarely works
      if (spamMessageId) {
        try {
          await telegramCommunity.sendMessageToChatId(chatId, '/ban', {
            replyToMessageId: spamMessageId,
          });
          
          console.log(`[KICK_SPAMMER] Sent /ban reply to message ${spamMessageId}`);
          
          await callback({
            text: `🚫 **RUGGED** ${finalName} for shilling other projects in the $RUG zone. 💀\n\n` +
              `ser thought they could sneak in some other token but got caught. paper hands get what they deserve. 😈`,
            actions: [],
          });
          
          return { 
            text: `Requested RoseBot ban for ${finalName}`, 
            success: true,
            data: { method: 'rosebot-reply', kicked: true, userName: finalName }
          };
        } catch (roseBotErr: any) {
          console.log('[KICK_SPAMMER] RoseBot reply command failed:', roseBotErr.message);
        }
      }
      
      // Method 3: Alert admins with detailed spam info for manual action
      // This is the fallback when we can't identify the user
      console.log('[KICK_SPAMMER] All automated methods failed - alerting admins');
    }
    
    // Final fallback - warn the community and ask admins with clear instructions
    const spamText = String(message.content?.text ?? '').slice(0, 100);
    
    await callback({
      text: `⚠️ **SPAM DETECTED** from **${finalName}**!\n\n` +
        `📝 *"${spamText}..."*\n\n` +
        `🚫 this is the $RUG zone only, ser. we don't shill other projects here.\n\n` +
        `👮 **Admins**: Reply to their spam message with \`/ban\` to remove them!\n\n` +
        `🛡️ **Community**: don't click those links, protect your wallets frens! 💀`,
      parseMode: 'Markdown',
      actions: [],
    });
    
    return { 
      text: `Warned about spammer ${finalName}`, 
      success: true,
      data: { 
        warning: 'sent', 
        kicked: false, 
        reason: 'no_user_id_available',
        note: 'ElizaOS v1.7.0 does not pass user_id from Telegram updates. Admins need to manually ban.'
      }
    };
  },
  examples: [
    [
      { name: 'user', content: { text: '🚀 Launch in hours - PEPE WHALE. Last project reached 50m mcap https://t.me/+spam' } },
      { name: 'eliza', content: { text: '🚫 RUGGED @spammer for shilling other projects', actions: ['KICK_SPAMMER'] } },
    ],
  ],
};

/**
 * Action to mute a user temporarily
 */
export const muteUserAction: Action = {
  name: 'MUTE_USER',
  similes: ['RESTRICT_USER', 'SILENCE_USER', 'TIMEOUT_USER'],
  description: 'Temporarily mute a user in the Telegram group. Use this for minor infractions before a full kick.',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    if (message.content?.source !== 'telegram') return false;
    const text = String(message.content?.text ?? '').toLowerCase();
    return /mute|silence|timeout|restrict/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    if (!kit?.telegramCommunity) {
      return { text: 'Telegram service not available', success: false };
    }
    
    const metadata = message.content?.metadata as any;
    const userId = metadata?.replyToUserId || metadata?.userId;
    const username = metadata?.replyToUsername || metadata?.username || 'user';
    
    const room = await runtime.getRoom(message.roomId as any);
    const chatId = room?.channelId;
    
    if (!chatId || !userId) {
      return { text: 'Could not identify user or chat', success: false };
    }
    
    // Mute for 30 minutes
    const thirtyMinutesFromNow = Math.floor(Date.now() / 1000) + 1800;
    
    const result = await kit.telegramCommunity.restrictUser(chatId, userId, {
      untilDate: thirtyMinutesFromNow,
      canSendMessages: false,
    });
    
    if (result.success) {
      await callback({
        text: `🔇 @${username} has been muted for 30 minutes. time to touch grass, fren. 🌱`,
      });
      return { text: `Muted @${username}`, success: true };
    } else {
      await callback({
        text: `⚠️ couldn't mute @${username} - need admin perms!`,
      });
      return { text: 'Missing permissions', success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'mute this guy' } },
      { name: 'eliza', content: { text: '🔇 @user has been muted for 30 minutes', actions: ['MUTE_USER'] } },
    ],
  ],
};

/**
 * Action to list all Telegram groups the bot is in
 */
export const listTelegramGroupsAction: Action = {
  name: 'LIST_TELEGRAM_GROUPS',
  similes: ['SHOW_GROUPS', 'MY_GROUPS', 'WHICH_GROUPS', 'LIST_GROUPS'],
  description: 'List all Telegram groups the agent is in and which token/mascot is linked to each',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(what|which|list|show|my).*group|group.*in\b/.test(text) ||
           /\bwhere am i\b/.test(text) ||
           /\bwhat mascot|which mascot\b/.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    try {
      const groups = await getAllGroups(store);
      
      if (groups.length === 0) {
        await callback({
          text: `📱 **My Telegram Groups**\n\nI haven't been added to any groups yet, or I haven't received any messages from groups.\n\n💡 Add me to a Telegram group and I'll start tracking it!`,
        });
        return { text: 'No groups found', success: true };
      }
      
      const linked = groups.filter(g => g.linkedPackId);
      const unlinked = groups.filter(g => !g.linkedPackId);
      
      let response = `📱 **My Telegram Groups** (${groups.length} total)\n\n`;
      
      if (linked.length > 0) {
        response += `**✅ Linked Groups (${linked.length})**\n`;
        for (const g of linked) {
          response += `• **${g.name}** → $${g.linkedPackTicker}\n`;
          response += `  Mascot: ${g.linkedPackName} | Chat: \`${g.chatId}\`\n`;
        }
        response += '\n';
      }
      
      if (unlinked.length > 0) {
        response += `**⚠️ Unlinked Groups (${unlinked.length})**\n`;
        response += `_These need a token/mascot assigned:_\n`;
        for (const g of unlinked) {
          response += `• **${g.name}** → \`${g.chatId}\`\n`;
        }
        response += '\n💡 To link: "link group [chat_id] to [token name]"\n';
      }
      
      await callback({ text: response });
      return { text: 'Listed groups', success: true };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Failed to list groups: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'what groups are you in?' } },
      { name: 'eliza', content: { text: 'Let me check my groups...', actions: ['LIST_TELEGRAM_GROUPS'] } },
    ],
    [
      { name: 'user', content: { text: 'which mascots do you play?' } },
      { name: 'eliza', content: { text: 'Here are my groups and mascots...', actions: ['LIST_TELEGRAM_GROUPS'] } },
    ],
    [
      { name: 'user', content: { text: 'show me all telegram groups' } },
      { name: 'eliza', content: { text: 'Listing all my groups...', actions: ['LIST_TELEGRAM_GROUPS'] } },
    ],
  ],
};

// ============================================================================
// LIST_MASCOTS - Show all mascot personas
// ============================================================================

export const listMascotsAction: Action = {
  name: 'LIST_MASCOTS',
  similes: ['SHOW_MASCOTS', 'MY_MASCOTS', 'WHICH_PERSONAS', 'LIST_PERSONAS', 'MY_CHARACTERS'],
  description: 'List all mascot personas with their name, personality, and speaking style',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(list|show|what|which|my).*mascot|mascot.*list|persona|character/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    try {
      const packs = await store.list();
      const mascotsWithPersona = packs.filter((p: any) => p.mascot?.name);
      
      if (mascotsWithPersona.length === 0) {
        await callback({
          text: `🎭 **My Mascots**\n\nNo mascots defined yet!\n\n💡 Set a mascot with: "set mascot for [token] to [name] with personality [description]"`,
        });
        return { text: 'No mascots found', success: true };
      }
      
      let response = `🎭 **My Mascots** (${mascotsWithPersona.length} total)\n\n`;
      
      for (const pack of mascotsWithPersona) {
        const m = pack.mascot;
        response += `**${m.name}** (for $${pack.brand?.ticker})\n`;
        if (m.personality) response += `  🧠 Personality: ${m.personality.substring(0, 100)}${m.personality.length > 100 ? '...' : ''}\n`;
        if (m.speakingStyle) response += `  💬 Style: ${m.speakingStyle.substring(0, 80)}${m.speakingStyle.length > 80 ? '...' : ''}\n`;
        if (pack.tg?.chat_id) response += `  📱 TG Group: Linked\n`;
        response += '\n';
      }
      
      await callback({ text: response });
      return { text: 'Listed mascots', success: true };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Failed to list mascots: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'list my mascots' } },
      { name: 'eliza', content: { text: '🎭 My Mascots (2 total)...', actions: ['LIST_MASCOTS'] } },
    ],
    [
      { name: 'user', content: { text: 'what personas do you have?' } },
      { name: 'eliza', content: { text: 'Here are my mascot personas...', actions: ['LIST_MASCOTS'] } },
    ],
  ],
};

// ============================================================================
// LIST_SCAM_WARNINGS - Show users with active scam warnings
// ============================================================================

export const listScamWarningsAction: Action = {
  name: 'LIST_SCAM_WARNINGS',
  similes: ['SHOW_WARNINGS', 'SCAM_LIST', 'WHO_IS_WARNED', 'WARNED_USERS'],
  description: 'List all users with active scam warnings across groups',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(list|show|who).*warn|warn.*list|scam.*user|warned.*user/i.test(text);
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    try {
      const warnings = getAllScamWarnings();
      
      if (warnings.length === 0) {
        await callback({
          text: `✅ **Scam Warnings**\n\nNo users with active warnings. All clear!`,
        });
        return { text: 'No warnings', success: true };
      }
      
      let response = `⚠️ **Active Scam Warnings** (${warnings.length} users)\n\n`;
      
      for (const w of warnings.slice(0, 20)) {
        const expiresIn = Math.round((WARNING_EXPIRY_MS - (Date.now() - w.lastWarning)) / 60000);
        response += `• **User ${w.userId}** in chat ${w.chatId}\n`;
        response += `  Warnings: ${w.count}/${WARNING_THRESHOLD} | Expires in: ${expiresIn}min\n`;
        response += `  Reasons: ${w.reasons.slice(-2).join(', ')}\n\n`;
      }
      
      if (warnings.length > 20) {
        response += `\n...and ${warnings.length - 20} more`;
      }
      
      await callback({ text: response });
      return { text: 'Listed warnings', success: true };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Failed to list warnings: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'show scam warnings' } },
      { name: 'eliza', content: { text: '⚠️ Active Scam Warnings (3 users)...', actions: ['LIST_SCAM_WARNINGS'] } },
    ],
    [
      { name: 'user', content: { text: 'who is warned?' } },
      { name: 'eliza', content: { text: 'Here are users with warnings...', actions: ['LIST_SCAM_WARNINGS'] } },
    ],
  ],
};

// ============================================================================
// LIST_LAUNCHED_TOKENS - Show only launched tokens
// ============================================================================

export const listLaunchedTokensAction: Action = {
  name: 'LIST_LAUNCHED_TOKENS',
  similes: ['SHOW_LAUNCHED', 'LIVE_TOKENS', 'ACTIVE_TOKENS', 'LAUNCHED_TOKENS'],
  description: 'List only tokens that have been successfully launched on pump.fun',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(list|show).*launched|launched.*token|live.*token|active.*token/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    try {
      const packs = await store.list();
      const launched = packs.filter((p: any) => p.launch?.status === 'launched');
      
      if (launched.length === 0) {
        await callback({
          text: `🚀 **Launched Tokens**\n\nNo tokens launched yet. Use "launch [token name]" to deploy one!`,
        });
        return { text: 'No launched tokens', success: true };
      }
      
      let response = `🚀 **Launched Tokens** (${launched.length} live)\n\n`;
      
      for (const pack of launched) {
        const name = pack.brand?.name || 'Unnamed';
        const ticker = pack.brand?.ticker || 'N/A';
        const mint = pack.launch?.mint ? pack.launch.mint.slice(0, 12) + '...' : 'Unknown';
        const launchedAt = pack.launch?.launchedAt ? new Date(pack.launch.launchedAt).toLocaleDateString() : 'Unknown';
        const pumpUrl = pack.launch?.mint ? `https://pump.fun/${pack.launch.mint}` : '';
        
        response += `🪙 **${name}** ($${ticker})\n`;
        response += `   Mint: \`${mint}\`\n`;
        response += `   Launched: ${launchedAt}\n`;
        if (pumpUrl) response += `   🔗 ${pumpUrl}\n`;
        if (pack.tg?.chat_id) response += `   📱 TG: Linked\n`;
        response += '\n';
      }
      
      await callback({ text: response });
      return { text: 'Listed launched tokens', success: true, data: { count: launched.length } };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Failed to list tokens: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'show launched tokens' } },
      { name: 'eliza', content: { text: '🚀 Launched Tokens (2 live)...', actions: ['LIST_LAUNCHED_TOKENS'] } },
    ],
    [
      { name: 'user', content: { text: 'list live tokens' } },
      { name: 'eliza', content: { text: 'Here are your live tokens...', actions: ['LIST_LAUNCHED_TOKENS'] } },
    ],
  ],
};

// ============================================================================
// LIST_DRAFT_TOKENS - Show only draft/pending tokens
// ============================================================================

export const listDraftTokensAction: Action = {
  name: 'LIST_DRAFT_TOKENS',
  similes: ['SHOW_DRAFTS', 'PENDING_TOKENS', 'UNLAUNCHED_TOKENS', 'DRAFT_TOKENS'],
  description: 'List tokens that are still drafts and not yet launched',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(list|show).*draft|draft.*token|pending.*token|unlaunched|not.*launched/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    try {
      const packs = await store.list();
      const drafts = packs.filter((p: any) => p.launch?.status !== 'launched');
      
      if (drafts.length === 0) {
        await callback({
          text: `📝 **Draft Tokens**\n\nNo drafts! All tokens have been launched. 🎉\n\n💡 Create a new one: "generate token called [NAME]"`,
        });
        return { text: 'No draft tokens', success: true };
      }
      
      let response = `📝 **Draft Tokens** (${drafts.length} pending)\n\n`;
      
      for (const pack of drafts) {
        const name = pack.brand?.name || 'Unnamed';
        const ticker = pack.brand?.ticker || 'N/A';
        const status = pack.launch?.status || 'not started';
        const hasCopy = pack.tg?.pins?.welcome ? '✅' : '❌';
        const hasLogo = pack.assets?.logo_url ? '✅' : '❌';
        const hasTg = pack.tg?.chat_id ? '✅' : '❌';
        
        response += `📋 **${name}** ($${ticker})\n`;
        response += `   Status: ${status}\n`;
        response += `   Ready: Copy ${hasCopy} | Logo ${hasLogo} | TG ${hasTg}\n`;
        response += `   ID: ${pack.id}\n\n`;
      }
      
      response += `💡 Launch with: "launch [token name]"`;
      
      await callback({ text: response });
      return { text: 'Listed draft tokens', success: true, data: { count: drafts.length } };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Failed to list drafts: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'show draft tokens' } },
      { name: 'eliza', content: { text: '📝 Draft Tokens (3 pending)...', actions: ['LIST_DRAFT_TOKENS'] } },
    ],
    [
      { name: 'user', content: { text: 'list pending tokens' } },
      { name: 'eliza', content: { text: 'Here are your drafts...', actions: ['LIST_DRAFT_TOKENS'] } },
    ],
  ],
};

// ============================================================================
// Helper to get all scam warnings (for LIST_SCAM_WARNINGS)
// ============================================================================

function getAllScamWarnings(): Array<{ chatId: string; userId: string; count: number; lastWarning: number; reasons: string[] }> {
  const now = Date.now();
  const results: Array<{ chatId: string; userId: string; count: number; lastWarning: number; reasons: string[] }> = [];
  
  for (const [key, warning] of scamWarnings.entries()) {
    // Skip expired warnings
    if ((now - warning.lastWarning) > WARNING_EXPIRY_MS) continue;
    
    const [chatId, userId] = key.split(':');
    results.push({
      chatId,
      userId,
      count: warning.count,
      lastWarning: warning.lastWarning,
      reasons: warning.reasons,
    });
  }
  
  return results.sort((a, b) => b.count - a.count);
}

// ============================================================================
// GROUP_HEALTH_CHECK - Get health report for a token's TG group
// ============================================================================

export const groupHealthCheckAction: Action = {
  name: 'GROUP_HEALTH_CHECK',
  similes: ['CHECK_GROUP_HEALTH', 'COMMUNITY_HEALTH', 'GROUP_STATS', 'TG_HEALTH'],
  description: 'Get health metrics for a token\'s Telegram group including member count, activity, and sentiment',
  suppressInitialMessage: true,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(group|community|tg).*(health|stats|metrics|activity)|health.*(check|report)|member.*count/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    if (!store) {
      await callback({ text: '❌ LaunchKit not initialized. Please try again in a moment.' });
      return { text: 'LaunchKit not initialized', success: false };
    }
    
    try {
      const text = String(message.content?.text ?? '');
      const packs = await store.list();
      
      // Helper to get chat ID from pack (handles both field names)
      const getChatId = (p: any) => p.tg?.telegram_chat_id || p.tg?.chat_id;
      
      // Find token from message
      const tickerMatch = text.match(/\$([A-Z]{2,10})/i);
      let targetPack = packs.find((p: any) => 
        tickerMatch && p.brand?.ticker?.toUpperCase() === tickerMatch[1].toUpperCase()
      );
      
      // If matched ticker has no TG group, or no ticker matched, find any pack with TG
      if (!targetPack || !getChatId(targetPack)) {
        const packWithTg = packs.find((p: any) => getChatId(p));
        if (packWithTg) {
          targetPack = packWithTg;
        }
      }
      
      // Debug log
      console.log(`[GROUP_HEALTH] Found ${packs.length} packs, targetPack: ${targetPack?.brand?.ticker || 'none'}, tg_chat: ${getChatId(targetPack) || 'none'}`);
      
      if (!targetPack) {
        await callback({ text: `❌ No token found. You have ${packs.length} tokens but none have linked Telegram groups.` });
        return { text: 'No group found', success: false };
      }
      
      const chatId = getChatId(targetPack);
      if (!chatId) {
        await callback({ text: `❌ ${targetPack.brand?.ticker} doesn't have a linked Telegram group.` });
        return { text: 'No chat_id', success: false };
      }
      
      const healthMonitor = getHealthMonitor(store);
      const health = await healthMonitor.getHealthReport(chatId);
      
      if (!health) {
        await callback({ text: `❌ Couldn't fetch health data for ${targetPack.brand?.ticker}. Bot may not be in the group.` });
        return { text: 'Health check failed', success: false };
      }
      
      const summary = healthMonitor.formatHealthSummary(health);
      await callback({ text: `🏥 **${targetPack.brand?.name}** ($${targetPack.brand?.ticker})\n\n${summary}` });
      
      return { text: 'Health report generated', success: true, data: health };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Health check failed: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'check group health for DUMP' } },
      { name: 'eliza', content: { text: '📊 Group Health Report...', actions: ['GROUP_HEALTH_CHECK'] } },
    ],
    [
      { name: 'user', content: { text: 'community stats' } },
      { name: 'eliza', content: { text: '📊 Health metrics for your group...', actions: ['GROUP_HEALTH_CHECK'] } },
    ],
  ],
};

// ============================================================================
// ANALYZE_SENTIMENT - Analyze sentiment of a message or the group
// ============================================================================

export const analyzeSentimentAction: Action = {
  name: 'ANALYZE_SENTIMENT',
  similes: ['CHECK_SENTIMENT', 'COMMUNITY_MOOD', 'VIBE_CHECK', 'SENTIMENT_CHECK'],
  description: 'Analyze the sentiment of a message or the overall community mood',
  suppressInitialMessage: true,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(sentiment|mood|vibe|feeling).*(check|analyze|what)|analyze.*sentiment|how.*community.*feel/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    if (!store) {
      await callback({ text: '❌ LaunchKit not initialized. Please try again in a moment.' });
      return { text: 'LaunchKit not initialized', success: false };
    }
    
    try {
      const text = String(message.content?.text ?? '');
      const packs = await store.list();
      
      // Helper to get chat ID from pack (handles both field names)
      const getChatId = (p: any) => p.tg?.telegram_chat_id || p.tg?.chat_id;
      
      // Find token
      const tickerMatch = text.match(/\$([A-Z]{2,10})/i);
      let targetPack = packs.find((p: any) => 
        tickerMatch && p.brand?.ticker?.toUpperCase() === tickerMatch[1].toUpperCase()
      );
      
      // If matched ticker has no TG group, or no ticker matched, find any pack with TG
      if (!targetPack || !getChatId(targetPack)) {
        const packWithTg = packs.find((p: any) => getChatId(p));
        if (packWithTg) {
          targetPack = packWithTg;
        }
      }
      
      // Debug log
      const chatId = getChatId(targetPack);
      console.log(`[ANALYZE_SENTIMENT] Found ${packs.length} packs, targetPack: ${targetPack?.brand?.ticker || 'none'}, tg_chat: ${chatId || 'none'}`);
      
      if (!chatId) {
        await callback({ text: '❌ No token with linked Telegram group found.' });
        return { text: 'No group found', success: false };
      }
      
      const healthMonitor = getHealthMonitor(store);
      const health = await healthMonitor.getHealthReport(chatId);
      
      if (!health) {
        await callback({ text: '❌ Couldn\'t analyze sentiment. No activity data available yet.' });
        return { text: 'No sentiment data', success: false };
      }
      
      const sentimentEmoji = health.sentiment === 'bullish' ? '🟢🚀' : health.sentiment === 'bearish' ? '🔴📉' : '🟡';
      const scorePercent = Math.round((health.sentimentScore + 1) * 50);
      
      let response = `📊 **Sentiment Analysis** - ${targetPack.brand?.name} ($${targetPack.brand?.ticker})\n\n`;
      response += `${sentimentEmoji} **Overall Mood:** ${health.sentiment.toUpperCase()}\n`;
      response += `📈 **Sentiment Score:** ${scorePercent}% bullish\n\n`;
      
      if (health.sentiment === 'bullish') {
        response += `✨ The community is feeling bullish! Lots of positive vibes and excitement.\n`;
        response += `📣 Good time for marketing and engagement!\n`;
      } else if (health.sentiment === 'bearish') {
        response += `⚠️ The community mood is down. Consider addressing concerns.\n`;
        response += `💬 Engagement and reassurance might help.\n`;
      } else {
        response += `😐 Community is neutral - neither overly bullish nor bearish.\n`;
        response += `💡 A good announcement or meme could shift the vibe!\n`;
      }
      
      await callback({ text: response });
      return { text: 'Sentiment analyzed', success: true, data: { sentiment: health.sentiment, score: health.sentimentScore } };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Sentiment analysis failed: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'check community sentiment' } },
      { name: 'eliza', content: { text: '📊 Sentiment Analysis - BULLISH 🚀', actions: ['ANALYZE_SENTIMENT'] } },
    ],
    [
      { name: 'user', content: { text: 'vibe check for DUMP' } },
      { name: 'eliza', content: { text: 'The community is feeling bullish!', actions: ['ANALYZE_SENTIMENT'] } },
    ],
  ],
};

// ============================================================================
// PIN_MESSAGE - Pin a message to the chat
// ============================================================================

export const pinMessageAction: Action = {
  name: 'PIN_MESSAGE',
  similes: ['PIN_TO_CHAT', 'PIN_ANNOUNCEMENT', 'STICKY_MESSAGE'],
  description: 'Pin a message to a token\'s Telegram group',
  suppressInitialMessage: true,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\bpin\s+(this|a|the|message|announcement)|create.*pin/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    if (!store) {
      await callback({ text: '❌ LaunchKit not initialized. Please try again in a moment.' });
      return { text: 'LaunchKit not initialized', success: false };
    }
    
    try {
      const text = String(message.content?.text ?? '');
      const packs = await store.list();
      
      // Helper to get chat ID from pack (handles both field names)
      const getChatId = (p: any) => p.tg?.telegram_chat_id || p.tg?.chat_id;
      
      // Find token
      const tickerMatch = text.match(/\$([A-Z]{2,10})/i);
      let targetPack = packs.find((p: any) => 
        tickerMatch && p.brand?.ticker?.toUpperCase() === tickerMatch[1].toUpperCase()
      );
      
      // If matched ticker has no TG group, or no ticker matched, find any pack with TG
      if (!targetPack || !getChatId(targetPack)) {
        const packWithTg = packs.find((p: any) => getChatId(p));
        if (packWithTg) {
          targetPack = packWithTg;
        }
      }
      
      // Debug log
      const chatId = getChatId(targetPack);
      console.log(`[PIN_MESSAGE] Found ${packs.length} packs, targetPack: ${targetPack?.brand?.ticker || 'none'}, tg_chat: ${chatId || 'none'}`);
      
      if (!chatId) {
        await callback({ text: '❌ No token with linked Telegram group found.' });
        return { text: 'No group found', success: false };
      }
      
      // Extract message to pin (everything after "pin")
      const pinMatch = text.match(/pin\s+(?:this\s+)?(?:message\s*:?\s*)?(.+)/i);
      const messageToPin = pinMatch?.[1]?.trim();
      
      if (!messageToPin || messageToPin.length < 5) {
        await callback({ text: '❌ Please provide a message to pin. Example: "pin announcement: We just hit 1000 holders!"' });
        return { text: 'No message provided', success: false };
      }
      
      // Send and pin the message (chatId already defined above via getChatId)
      const tgService = new TelegramSetupService(store as any);
      
      // Use the community service to send and pin
      const { TelegramCommunityService } = await import('../services/telegramCommunity.ts');
      const communityService = new TelegramCommunityService(store as any);
      
      const result = await communityService.sendMessageToChatId(chatId, messageToPin, { parseMode: 'HTML' });
      
      if (result?.message_id) {
        const pinned = await communityService.pinMessage(chatId, result.message_id, true);
        if (pinned) {
          await callback({ text: `📌 **Message pinned successfully!**\n\n"${messageToPin.slice(0, 100)}${messageToPin.length > 100 ? '...' : ''}"` });
          return { text: 'Message pinned', success: true };
        }
      }
      
      await callback({ text: `✅ Message sent but couldn't pin it. Make sure the bot is an admin with pin permissions.` });
      return { text: 'Sent but not pinned', success: false };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Pin failed: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'pin announcement: We just hit 1000 holders! 🎉' } },
      { name: 'eliza', content: { text: '📌 Message pinned successfully!', actions: ['PIN_MESSAGE'] } },
    ],
  ],
};

// ============================================================================
// CROSS_POST - Post the same content to TG and X
// ============================================================================

export const crossPostAction: Action = {
  name: 'CROSS_POST',
  similes: ['POST_EVERYWHERE', 'SYNC_POST', 'MULTI_PLATFORM_POST', 'TG_AND_X'],
  description: 'Post the same announcement to both Telegram and X/Twitter',
  suppressInitialMessage: true,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(cross.?post|post.*(tg|telegram).*x|post.*everywhere|sync.*post|announce.*(both|all)|both.*platforms?)/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    if (!store) {
      await callback({ text: '❌ LaunchKit not initialized. Please try again in a moment.' });
      return { text: 'LaunchKit not initialized', success: false };
    }
    
    try {
      const text = String(message.content?.text ?? '');
      const packs = await store.list();
      
      // Helper to get chat ID from pack (handles both field names)
      const getChatId = (p: any) => p.tg?.telegram_chat_id || p.tg?.chat_id;
      
      // Find token
      const tickerMatch = text.match(/\$?([A-Z]{2,10})/i);
      let targetPack = packs.find((p: any) => 
        tickerMatch && p.brand?.ticker?.toUpperCase() === tickerMatch[1].toUpperCase()
      );
      
      // If no specific token, use any token (launched or not)
      if (!targetPack) {
        targetPack = packs.find((p: any) => getChatId(p) || p.launch?.mint);
      }
      if (!targetPack) {
        targetPack = packs[0];
      }
      
      // Debug log
      console.log(`[CROSS_POST] Found ${packs.length} packs, targetPack: ${targetPack?.brand?.ticker || 'none'}, tg_chat: ${getChatId(targetPack) || 'none'}`);
      
      if (!targetPack) {
        await callback({ text: `❌ No token found. Create a token first!` });
        return { text: 'No token found', success: false };
      }
      
      // Extract the message to post
      const postMatch = text.match(/(?:cross.?post|post.*:)\s*(.+)/i);
      let messageToPost = postMatch?.[1]?.trim();
      
      if (!messageToPost || messageToPost.length < 10) {
        await callback({ text: '❌ Please provide a message to cross-post. Example: "cross-post: 🚀 $DUMP just hit 1000 holders!"' });
        return { text: 'No message provided', success: false };
      }
      
      // Replace token placeholder
      messageToPost = messageToPost.replace(/\[token\]/gi, `$${targetPack.brand?.ticker}`);
      
      const results = { tg: false, x: false };
      
      // Post to Telegram
      const tgChatId = getChatId(targetPack);
      if (tgChatId) {
        try {
          const { TelegramCommunityService } = await import('../services/telegramCommunity.ts');
          const communityService = new TelegramCommunityService(store as any);
          await communityService.sendMessageToChatId(tgChatId, messageToPost);
          results.tg = true;
        } catch (err) {
          console.error('[CROSS_POST] TG failed:', err);
        }
      }
      
      // Post to X/Twitter using LaunchKit's xPublisher (custom implementation)
      try {
        const xPublisher = kit?.xPublisher;
        if (xPublisher) {
          // Truncate for X if needed (280 chars)
          const xMessage = messageToPost.length > 280 ? messageToPost.slice(0, 277) + '...' : messageToPost;
          await xPublisher.tweet(xMessage);
          results.x = true;
        } else {
          console.log('[CROSS_POST] xPublisher not available in LaunchKit');
        }
      } catch (err: any) {
        console.error('[CROSS_POST] X failed:', err?.message || err);
        // Check for specific error codes
        if (err?.code === 'X_DISABLED') {
          console.log('[CROSS_POST] X posting is disabled (X_ENABLE != true)');
        } else if (err?.code === 'X_RATE_LIMIT') {
          console.log('[CROSS_POST] X rate limit reached');
        }
      }
      
      let response = `📢 **Cross-Post Results**\n\n`;
      response += `📱 Telegram: ${results.tg ? '✅ Posted' : '❌ Failed or not configured'}\n`;
      response += `🐦 X/Twitter: ${results.x ? '✅ Posted' : '❌ Failed or not configured'}\n\n`;
      
      if (results.tg || results.x) {
        response += `📝 Message: "${messageToPost.slice(0, 100)}${messageToPost.length > 100 ? '...' : ''}"`;
      }
      
      await callback({ text: response });
      return { text: 'Cross-post complete', success: results.tg || results.x, data: results };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({ text: `❌ Cross-post failed: ${errMsg}` });
      return { text: errMsg, success: false };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'cross-post: 🚀 $DUMP just hit 1000 holders! LFG!' } },
      { name: 'eliza', content: { text: '📢 Cross-Post Results\n✅ Telegram\n✅ X/Twitter', actions: ['CROSS_POST'] } },
    ],
    [
      { name: 'user', content: { text: 'post to both platforms: GM holders! Big day ahead!' } },
      { name: 'eliza', content: { text: 'Posted to TG and X!', actions: ['CROSS_POST'] } },
    ],
  ],
};