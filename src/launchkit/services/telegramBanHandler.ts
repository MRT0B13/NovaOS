/**
 * Telegram Ban Command Handler
 * 
 * This service hooks into ElizaOS's existing Telegraf bot instance to add
 * ban/kick command handlers. When an admin replies to a spam message with /ban,
 * this handler gets the user_id from reply_to_message.from.id and bans them.
 * 
 * This works because we piggyback on ElizaOS's existing polling connection,
 * avoiding the need for a separate webhook or polling instance.
 * 
 * Based on: https://github.com/Suburbanno/BanByID
 */

import type { IAgentRuntime } from '@elizaos/core';
import type { Telegraf, Context } from 'telegraf';
import { cacheTelegramUser, lookupTelegramUser } from './telegramCommunity.ts';

let isRegistered = false;
let registeredBot: Telegraf | null = null;

/**
 * Register ban/kick command handlers on an existing Telegraf bot
 * Call this after ElizaOS has initialized its Telegram service
 */
export async function registerBanCommands(runtime: IAgentRuntime): Promise<boolean> {
  if (isRegistered) {
    console.log('[BAN_HANDLER] Commands already registered');
    return true;
  }
  
  try {
    // Get the TelegramService from runtime
    const telegramService = runtime.getService('telegram') as any;
    
    if (!telegramService) {
      console.log('[BAN_HANDLER] No Telegram service found');
      return false;
    }
    
    // Access the bot via messageManager
    const bot = telegramService.messageManager?.bot as Telegraf<Context> | undefined;
    
    if (!bot) {
      console.log('[BAN_HANDLER] No bot instance found in Telegram service');
      return false;
    }
    
    console.log('[BAN_HANDLER] 🔌 Hooking into ElizaOS Telegraf instance...');
    
    registeredBot = bot;
    
    // CRITICAL: Install user caching middleware FIRST
    // This intercepts all updates and caches user IDs before ElizaOS processes them
    // We use bot.use() but this runs for all updates including those ElizaOS handles
    const cachingMiddleware = async (ctx: Context, next: () => Promise<void>) => {
      try {
        const message = (ctx as any).message || (ctx as any).edited_message;
        if (message?.from && message?.chat?.id) {
          const chatId = String(message.chat.id);
          const from = message.from;
          
          // Cache this user immediately
          cacheTelegramUser(chatId, {
            id: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
          }, message.message_id);
          
          console.log(`[BAN_HANDLER] 📥 Cached user: ${from.id} (@${from.username || from.first_name}) in chat ${chatId}`);
        }
        
        // Also cache from new_chat_members
        if ((ctx as any).message?.new_chat_members) {
          const chatId = String((ctx as any).message.chat.id);
          for (const member of (ctx as any).message.new_chat_members) {
            cacheTelegramUser(chatId, {
              id: member.id,
              username: member.username,
              firstName: member.first_name,
              lastName: member.last_name,
            });
            console.log(`[BAN_HANDLER] 📥 Cached new member: ${member.id} (@${member.username || member.first_name})`);
          }
        }
      } catch (e) {
        // Silently ignore caching errors
      }
      return next();
    };
    
    // Prepend our middleware by accessing the internal middleware array
    // This ensures we cache users BEFORE ElizaOS processes the message
    const botAny = bot as any;
    if (botAny.middleware && typeof botAny.middleware === 'function') {
      const originalMiddleware = botAny.middleware();
      botAny.middleware = () => async (ctx: Context, next: () => Promise<void>) => {
        await cachingMiddleware(ctx, async () => {
          await originalMiddleware(ctx, next);
        });
      };
      console.log('[BAN_HANDLER] ✅ Injected caching middleware at start of chain');
    } else {
      // Fallback: just use normal bot.use() - may not catch all messages
      bot.use(cachingMiddleware);
      console.log('[BAN_HANDLER] ⚠️ Added caching middleware (may miss some messages)');
    }
    
    // Register /ban command - supports both reply-to and @username
    bot.command('ban', async (ctx) => {
      try {
        const chatId = ctx.message.chat.id;
        const fromUserId = ctx.message.from.id;
        const replyToMessage = ctx.message.reply_to_message;
        const messageText = ctx.message.text || '';
        
        // Extract @username from command if present (e.g., "/ban @username")
        const usernameMatch = messageText.match(/@(\w+)/);
        const targetUsername = usernameMatch ? usernameMatch[1] : null;
        
        console.log('[BAN_HANDLER] /ban command received:', {
          chatId,
          fromUserId,
          hasReply: !!replyToMessage,
          targetUsername,
        });
        
        let targetUserId: number | undefined;
        let targetName: string = '';
        
        // Method 1: If this is a reply, get user from reply_to_message
        if (replyToMessage?.from) {
          targetUserId = replyToMessage.from.id;
          targetName = replyToMessage.from.first_name || replyToMessage.from.username || String(targetUserId);
          
          // Cache this user
          cacheTelegramUser(String(chatId), {
            id: targetUserId,
            username: replyToMessage.from.username,
            firstName: replyToMessage.from.first_name,
            lastName: replyToMessage.from.last_name,
          }, replyToMessage.message_id);
          
          console.log(`[BAN_HANDLER] Got user from reply: ${targetUserId} (${targetName})`);
        }
        // Method 2: If @username provided, look up in cache
        else if (targetUsername) {
          const cached = lookupTelegramUser(String(chatId), targetUsername);
          if (cached?.id) {
            targetUserId = cached.id;
            targetName = cached.firstName || cached.username || String(targetUserId);
            console.log(`[BAN_HANDLER] Found user in cache: ${targetUserId} (${targetName})`);
          } else {
            // Try to get chat member info from Telegram
            try {
              // Note: This won't work with just username, but try anyway
              console.log(`[BAN_HANDLER] User @${targetUsername} not in cache, cannot resolve to ID`);
              await ctx.reply(
                `⚠️ Cannot find @${targetUsername} in my cache.\\n\\n` +
                `**Try this instead:**\\n` +
                `Reply to their spam message with /ban`,
                { parse_mode: 'Markdown' }
              );
              return;
            } catch (e) {
              console.log('[BAN_HANDLER] getChatMember failed:', e);
            }
          }
        }
        
        // If we still don't have a target, show help
        if (!targetUserId) {
          await ctx.reply(
            '⚠️ **How to use /ban:**\\n\\n' +
            '1️⃣ **Reply method** (recommended):\\n' +
            '   Reply to a spam message with /ban\\n\\n' +
            '2️⃣ **Username method:**\\n' +
            '   /ban @username\\n' +
            '   (only works if user is in my cache)',
            { parse_mode: 'Markdown' }
          );
          return;
        }
        
        console.log(`[BAN_HANDLER] Banning user ${targetUserId} (${targetName}) from chat ${chatId}`);
        
        // Try to ban the user
        try {
          // Ban the user (0 = permanent ban)
          await ctx.telegram.banChatMember(chatId, targetUserId, 0);
          
          // Try to delete the spam message if we have it
          if (replyToMessage) {
            try {
              await ctx.telegram.deleteMessage(chatId, replyToMessage.message_id);
            } catch (delErr) {
              console.log('[BAN_HANDLER] Could not delete message:', delErr);
            }
          }
          
          await ctx.reply(
            `🚫 **RUGGED** ${targetName} from the $RUG zone! 💀\n\n` +
            `User ID: \`${targetUserId}\`\n` +
            `ser thought they could sneak in but got caught. 😈`,
            { 
              parse_mode: 'Markdown',
            }
          );
          
          console.log(`[BAN_HANDLER] ✅ Successfully banned user ${targetUserId}`);
        } catch (banErr: any) {
          console.error('[BAN_HANDLER] Failed to ban:', banErr.message);
          await ctx.reply(
            `❌ Failed to ban ${targetName}: ${banErr.message}\n\n` +
            `Make sure I'm an admin with ban permissions!`
          );
        }
      } catch (err: any) {
        console.error('[BAN_HANDLER] Error processing /ban:', err);
      }
    });
    
    // Handle /kick command (same as ban but can rejoin)
    bot.command('kick', async (ctx) => {
      try {
        const chatId = ctx.message.chat.id;
        const replyToMessage = ctx.message.reply_to_message;
        
        if (!replyToMessage?.from) {
          await ctx.reply('⚠️ Reply to a message with /kick to kick that user');
          return;
        }
        
        const targetUserId = replyToMessage.from.id;
        const targetName = replyToMessage.from.first_name || String(targetUserId);
        
        // Kick = ban then immediately unban
        await ctx.telegram.banChatMember(chatId, targetUserId);
        await ctx.telegram.unbanChatMember(chatId, targetUserId);
        
        await ctx.reply(`👢 Kicked ${targetName} from the group`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        
        console.log(`[BAN_HANDLER] Kicked user ${targetUserId}`);
      } catch (err: any) {
        console.error('[BAN_HANDLER] Error processing /kick:', err);
        await ctx.reply(`❌ Failed to kick: ${err.message}`);
      }
    });
    
    // Handle /roseban command - alternative for compatibility with RoseBot
    bot.command('roseban', async (ctx) => {
      try {
        const replyToMessage = ctx.message.reply_to_message;
        
        if (!replyToMessage?.from) {
          await ctx.reply('⚠️ Reply to a message with /roseban to ban that user');
          return;
        }
        
        const chatId = ctx.message.chat.id;
        const targetUserId = replyToMessage.from.id;
        const targetName = replyToMessage.from.first_name || String(targetUserId);
        
        // Ban permanently (0 = forever)
        await ctx.telegram.banChatMember(chatId, targetUserId, 0);
        
        // Try to delete the spam message
        try {
          await ctx.telegram.deleteMessage(chatId, replyToMessage.message_id);
        } catch (_) {}
        
        await ctx.reply(`🌹 ${targetName} has been handled.`);
        console.log(`[BAN_HANDLER] /roseban - Banned user ${targetUserId}`);
      } catch (err: any) {
        console.error('[BAN_HANDLER] /roseban error:', err.message);
      }
    });
    
    // Handle new member joins with personalized welcome
    bot.on('new_chat_members', async (ctx) => {
      try {
        console.log('[BAN_HANDLER] 🔔 new_chat_members event received!', JSON.stringify({
          chat_id: ctx.message?.chat?.id,
          members: ctx.message?.new_chat_members?.map((m: any) => ({ id: m.id, name: m.first_name })),
        }));
        
        const newMembers = ctx.message.new_chat_members;
        const chatId = String(ctx.message.chat.id);
        
        // Get the LaunchPack for this chat to personalize the greeting
        const bootstrap = runtime.getService('launchkit_bootstrap') as any;
        const kit = bootstrap?.getLaunchKit?.();
        const store = kit?.store;
        
        let tokenName = '$RUG';
        let tokenTicker = 'RUG';
        
        if (store) {
          try {
            const packs = await store.list();
            const pack = packs.find((p: any) => 
              p.tg?.telegram_chat_id === chatId || 
              p.tg?.chat_id === chatId
            );
            if (pack?.brand) {
              tokenName = pack.brand.name || tokenName;
              tokenTicker = pack.brand.ticker || tokenTicker;
            }
          } catch (e) {
            console.log('[BAN_HANDLER] Could not get pack for welcome:', e);
          }
        }
        
        for (const member of newMembers) {
          // Skip bots
          if (member.is_bot) continue;
          
          // Cache the new member
          cacheTelegramUser(chatId, {
            id: member.id,
            username: member.username,
            firstName: member.first_name,
            lastName: member.last_name,
          });
          
          const firstName = member.first_name || member.username || 'fren';
          
          // Generate a fun personalized welcome
          const welcomeMessages = [
            `🎉 yo ${firstName}! welcome to the $${tokenTicker} zone! 💎\n\ngrab a seat, we're just getting started. LFG! 🚀`,
            `👋 ${firstName} just joined the ${tokenName} fam! welcome aboard ser! 🔥\n\nask questions, vibe with the community, and HODL tight! 💪`,
            `🚀 gm ${firstName}! you made it to the $${tokenTicker} community!\n\nwe don't rug here, we RUG together 😈💎`,
            `💎 ${firstName} is here! welcome to ${tokenName}!\n\nyou're early fren, make yourself at home! wagmi 🤝`,
            `🔥 ayoo ${firstName}! glad you found us!\n\nwelcome to the $${tokenTicker} gang. diamond hands only! 💎🙌`,
          ];
          
          const randomWelcome = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
          
          await ctx.reply(randomWelcome);
          console.log(`[BAN_HANDLER] 👋 Welcomed new member: ${member.id} (${firstName})`);
        }
      } catch (err: any) {
        console.error('[BAN_HANDLER] Error welcoming new member:', err.message);
      }
    });
    
    // Handle chat_member updates (for supergroups where new_chat_members doesn't fire)
    // This catches when users join via invite link in supergroups
    bot.on('chat_member', async (ctx) => {
      try {
        const update = ctx.update as any;
        const chatMember = update.chat_member;
        
        if (!chatMember) return;
        
        const oldStatus = chatMember.old_chat_member?.status;
        const newStatus = chatMember.new_chat_member?.status;
        const user = chatMember.new_chat_member?.user;
        const chatId = String(chatMember.chat?.id);
        
        // Only welcome if user just joined (was not a member, now is member)
        const wasNotMember = ['left', 'kicked', 'restricted'].includes(oldStatus) || !oldStatus;
        const isNowMember = ['member', 'administrator', 'creator'].includes(newStatus);
        
        if (!wasNotMember || !isNowMember || !user) return;
        
        // Skip bots
        if (user.is_bot) return;
        
        console.log(`[BAN_HANDLER] 👋 chat_member join detected: ${user.id} (${user.first_name || user.username})`);
        
        // Cache the new member
        cacheTelegramUser(chatId, {
          id: user.id,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
        });
        
        // Get the LaunchPack for this chat to personalize the greeting
        const bootstrap = runtime.getService('launchkit_bootstrap') as any;
        const kit = bootstrap?.getLaunchKit?.();
        const store = kit?.store;
        
        let tokenName = '$RUG';
        let tokenTicker = 'RUG';
        let mascotName = '';
        
        if (store) {
          try {
            const packs = await store.list();
            const pack = packs.find((p: any) => 
              p.tg?.telegram_chat_id === chatId || 
              p.tg?.chat_id === chatId
            );
            if (pack?.brand) {
              tokenName = pack.brand.name || tokenName;
              tokenTicker = pack.brand.ticker || tokenTicker;
              mascotName = (pack as any).mascot?.name || '';
            }
          } catch (e) {
            console.log('[BAN_HANDLER] Could not get pack for welcome:', e);
          }
        }
        
        const firstName = user.first_name || user.username || 'fren';
        
        // Generate a fun personalized welcome
        const welcomeMessages = [
          `🎉 yo ${firstName}! welcome to the $${tokenTicker} zone! 💎\n\ngrab a seat, we're just getting started. LFG! 🚀`,
          `👋 ${firstName} just joined the ${tokenName} fam! welcome aboard ser! 🔥\n\nask questions, vibe with the community, and HODL tight! 💪`,
          `🚀 gm ${firstName}! you made it to the $${tokenTicker} community!\n\nwe don't rug here, we RUG together 😈💎`,
          `💎 ${firstName} is here! welcome to ${tokenName}!\n\nyou're early fren, make yourself at home! wagmi 🤝`,
          `🔥 ayoo ${firstName}! glad you found us!\n\nwelcome to the $${tokenTicker} gang. diamond hands only! 💎🙌`,
        ];
        
        const randomWelcome = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
        
        // Send welcome to the chat
        const botToken = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: randomWelcome,
            }),
          });
          console.log(`[BAN_HANDLER] 👋 Welcomed new member (chat_member): ${user.id} (${firstName})`);
        }
      } catch (err: any) {
        console.error('[BAN_HANDLER] Error welcoming via chat_member:', err.message);
      }
    });
    
    console.log('[BAN_HANDLER] ✅ Commands registered: /ban, /kick, /roseban, new_member_welcome, chat_member_welcome');
    isRegistered = true;
    return true;
    
  } catch (err: any) {
    console.error('[BAN_HANDLER] Failed to register commands:', err.message);
    return false;
  }
}

/**
 * Check if ban commands are registered
 */
export function isBanHandlerRegistered(): boolean {
  return isRegistered;
}

// Legacy exports for backwards compatibility (no-ops now)
export async function startBanCommandHandler(): Promise<boolean> {
  console.log('[BAN_HANDLER] startBanCommandHandler() called - use registerBanCommands(runtime) instead');
  return false;
}

export function stopBanCommandHandler(): void {
  // No-op - commands are registered on ElizaOS's bot, we don't control the lifecycle
  console.log('[BAN_HANDLER] stopBanCommandHandler() called - no action needed');
}

// Export for direct processUpdate (webhook mode fallback if ever needed)
export async function processUpdate(update: any): Promise<void> {
  if (registeredBot) {
    try {
      await registeredBot.handleUpdate(update);
    } catch (err: any) {
      console.error('[BAN_HANDLER] Error processing update:', err.message);
    }
  }
}
