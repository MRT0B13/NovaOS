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
import { recordMessageReceived } from './telegramHealthMonitor.ts';
import { isAdmin, logAdminCommand, initTelegramSecurity, isAdminSecurityEnabled } from './telegramSecurity.ts';
import { recordBannedUser, isUserBanned, getBannedUsers } from './systemReporter.ts';
import { crossBanUser } from './novaChannel.ts';
import { getEnv } from '../env.ts';

let isRegistered = false;
let registeredBot: Telegraf | null = null;

// Every bot.command() we register — if a message starts with one of these,
// the patched handleMessage must NOT forward it to ElizaOS's LLM pipeline.
// Mirrors the set in server.ts (webhook Eliza-forward gate).
const KNOWN_BOT_COMMANDS = new Set([
  '/ban', '/kick', '/roseban', '/banned',
  '/health', '/errors', '/repairs',
  '/scan', '/children',
  '/request_agent', '/approve_agent',
  '/reject_agent', '/my_agents', '/stop_agent',
  '/cfo',
]);

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
    
    // Initialize security (admin IDs, webhook secret)
    initTelegramSecurity();
    
    if (!isAdminSecurityEnabled()) {
      console.warn('[BAN_HANDLER] ⚠️ SECURITY WARNING: No TELEGRAM_ADMIN_IDS configured!');
      console.warn('[BAN_HANDLER] ⚠️ Admin commands (ban/kick) are open to ALL users!');
      console.warn('[BAN_HANDLER] ⚠️ Set TELEGRAM_ADMIN_IDS in .env to restrict access.');
    }
    
    registeredBot = bot;
    
    // CRITICAL: Patch messageManager.handleMessage to intercept ALL messages
    // We can't use bot.use() because it's registered after bot.launch()
    // Instead, we wrap the handleMessage method to add our caching logic
    const messageManager = telegramService.messageManager as any;
    if (messageManager && typeof messageManager.handleMessage === 'function') {
      const originalHandleMessage = messageManager.handleMessage.bind(messageManager);
      
      messageManager.handleMessage = async (ctx: Context) => {
        // Record that we received a message (for health monitoring)
        recordMessageReceived();
        
        // Cache user BEFORE ElizaOS processes the message
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
        
        // ── Security: check ban cache + scan inbound threats ────
        try {
          const message = (ctx as any).message || (ctx as any).edited_message;
          const fromId = message?.from?.id;
          const chatId = String(message?.chat?.id || '');

          // 1) Fast-path: if user is already banned, delete & skip
          if (fromId && isUserBanned(fromId)) {
            console.log(`[BAN_HANDLER] 🚫 Banned user ${fromId} tried to message in ${chatId} — deleting`);
            try { await ctx.deleteMessage(); } catch { /* no perms */ }
            // Re-enforce the ban in case TG un-cached it
            try { await ctx.telegram.banChatMember(Number(chatId), fromId, 0); } catch { /* already banned */ }
            return;
          }

          // 2) Content scan for phishing, injection, scam, secrets
          const text = message?.text || message?.caption || '';
          if (text.length > 0) {
            const { ContentFilter } = await import('../../agents/security/index.ts');
            const filter = new ContentFilter(null as any, async () => {});
            const scanResult = filter.scanInbound(
              text,
              String(fromId || ''),
              chatId,
            );
            if (!scanResult.clean) {
              const hasCritical = scanResult.threats.some(
                (t: any) => t.severity === 'critical' || t.severity === 'high',
              );
              if (hasCritical) {
                const threatTypes = scanResult.threats.map((t: any) => t.type).join(', ');
                console.log(`[BAN_HANDLER] 🛡️ BLOCKED message from ${fromId}: ${threatTypes}`);

                // Delete the malicious message
                try { await ctx.deleteMessage(); } catch { /* may not have delete permission */ }

                // Auto-ban the attacker + cross-ban channel ↔ community
                if (fromId) {
                  const fromUser = message?.from;
                  const banReason = `Guardian auto-ban: ${threatTypes}`;
                  try {
                    await ctx.telegram.banChatMember(Number(chatId), fromId, 0);
                    console.log(`[BAN_HANDLER] 🔨 Auto-banned user ${fromId} for ${threatTypes}`);
                  } catch (banErr: any) {
                    console.error(`[BAN_HANDLER] Auto-ban failed for ${fromId}:`, banErr.message);
                  }
                  // Persist to ban cache (file + PostgreSQL)
                  recordBannedUser({
                    id: fromId,
                    username: fromUser?.username,
                    firstName: fromUser?.first_name,
                    chatId,
                    bannedAt: Date.now(),
                    bannedBy: 0, // 0 = Guardian auto-ban (not a human admin)
                    bannedByUsername: 'guardian',
                    reason: banReason,
                  });
                  // Cross-ban from both channel & community
                  crossBanUser(fromId, { reason: banReason, originChatId: chatId })
                    .catch(e => console.error('[BAN_HANDLER] Guardian cross-ban error:', e));
                }
                // Don't pass to LLM — return early
                return;
              }
              // Non-critical threats: log but let through
              console.log(`[BAN_HANDLER] ⚠️ Suspicious message from ${fromId}: ${scanResult.threats.map((t: any) => t.type).join(', ')}`);
            }
          }
        } catch {
          // Security module not available — don't block messages
        }
        
        // ── Skip ElizaOS LLM processing for known slash commands ────
        // bot.command() handlers (registered below) will handle these via
        // the Telegraf middleware chain. If we also call originalHandleMessage,
        // ElizaOS generates a fake LLM response ("The CFO session has concluded…").
        {
          const rawText: string = ((ctx as any).message?.text || '').trim();
          const cmdToken = rawText.split(/\s/)[0]?.split('@')[0] || '';
          if (KNOWN_BOT_COMMANDS.has(cmdToken)) {
            console.log(`[BAN_HANDLER] ⚡ Known command "${cmdToken}" — skipping ElizaOS LLM pipeline`);
            return; // let bot.command() handle it, don't call originalHandleMessage
          }
        }
        
        // Call original handleMessage
        return originalHandleMessage(ctx);
      };
      
      console.log('[BAN_HANDLER] ✅ Patched messageManager.handleMessage for user caching');
    } else {
      console.log('[BAN_HANDLER] ⚠️ Could not patch messageManager.handleMessage - caching may not work');
    }
    
    // Register /ban command - supports both reply-to and @username
    bot.command('ban', async (ctx) => {
      try {
        const chatId = ctx.message.chat.id;
        const fromUserId = ctx.message.from.id;
        const fromUsername = ctx.message.from.username;
        const replyToMessage = ctx.message.reply_to_message;
        const messageText = ctx.message.text || '';
        
        // Extract @username from command if present (e.g., "/ban @username")
        const usernameMatch = messageText.match(/@(\w+)/);
        const targetUsername = usernameMatch ? usernameMatch[1] : null;
        
        // SECURITY CHECK: Verify user is an admin
        const allowed = isAdmin(fromUserId);
        
        // Log the command attempt
        logAdminCommand({
          timestamp: Date.now(),
          userId: fromUserId,
          username: fromUsername,
          chatId,
          command: 'ban',
          args: targetUsername ? `@${targetUsername}` : (replyToMessage ? '[reply]' : ''),
          allowed,
          reason: allowed ? undefined : 'Not in TELEGRAM_ADMIN_IDS',
        });
        
        if (!allowed) {
          await ctx.reply('⛔ This command is restricted to admins only.');
          return;
        }
        
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
          
          // Record the banned user to persistent memory
          const bannedUsername = replyToMessage?.from?.username || targetUsername || undefined;
          const targetFirstName = replyToMessage?.from?.first_name || targetName;
          
          recordBannedUser({
            id: targetUserId,
            username: bannedUsername,
            firstName: targetFirstName,
            chatId: String(chatId),
            bannedAt: Date.now(),
            bannedBy: fromUserId,
            bannedByUsername: fromUsername,
            reason: 'Manual /ban command',
          });
          
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
          
          // Cross-ban: also remove from the other chat (community ↔ channel)
          crossBanUser(targetUserId, { reason: 'Manual /ban command', originChatId: String(chatId) })
            .catch(e => console.error('[BAN_HANDLER] Cross-ban error:', e));
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
        const fromUserId = ctx.message.from.id;
        const fromUsername = ctx.message.from.username;
        const replyToMessage = ctx.message.reply_to_message;
        
        // SECURITY CHECK: Verify user is an admin
        const allowed = isAdmin(fromUserId);
        
        logAdminCommand({
          timestamp: Date.now(),
          userId: fromUserId,
          username: fromUsername,
          chatId,
          command: 'kick',
          args: replyToMessage ? '[reply]' : '',
          allowed,
          reason: allowed ? undefined : 'Not in TELEGRAM_ADMIN_IDS',
        });
        
        if (!allowed) {
          await ctx.reply('⛔ This command is restricted to admins only.');
          return;
        }
        
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
        const chatId = ctx.message.chat.id;
        const fromUserId = ctx.message.from.id;
        const fromUsername = ctx.message.from.username;
        const replyToMessage = ctx.message.reply_to_message;
        
        // SECURITY CHECK: Verify user is an admin
        const allowed = isAdmin(fromUserId);
        
        logAdminCommand({
          timestamp: Date.now(),
          userId: fromUserId,
          username: fromUsername,
          chatId,
          command: 'roseban',
          args: replyToMessage ? '[reply]' : '',
          allowed,
          reason: allowed ? undefined : 'Not in TELEGRAM_ADMIN_IDS',
        });
        
        if (!allowed) {
          await ctx.reply('⛔ This command is restricted to admins only.');
          return;
        }
        
        if (!replyToMessage?.from) {
          await ctx.reply('⚠️ Reply to a message with /roseban to ban that user');
          return;
        }
        
        const targetUserId = replyToMessage.from.id;
        const targetName = replyToMessage.from.first_name || String(targetUserId);
        
        // Ban permanently (0 = forever)
        await ctx.telegram.banChatMember(chatId, targetUserId, 0);
        
        // Record the banned user to persistent memory
        recordBannedUser({
          id: targetUserId,
          username: replyToMessage.from.username,
          firstName: replyToMessage.from.first_name,
          chatId: String(chatId),
          bannedAt: Date.now(),
          bannedBy: fromUserId,
          bannedByUsername: fromUsername,
          reason: 'Manual /roseban command',
        });
        
        // Try to delete the spam message
        try {
          await ctx.telegram.deleteMessage(chatId, replyToMessage.message_id);
        } catch (_) {}
        
        await ctx.reply(`🌹 ${targetName} has been handled.`);
        console.log(`[BAN_HANDLER] /roseban - Banned user ${targetUserId}`);
        
        // Cross-ban: also remove from the other chat (community ↔ channel)
        crossBanUser(targetUserId, { reason: 'Manual /roseban command', originChatId: String(chatId) })
          .catch(e => console.error('[BAN_HANDLER] Cross-ban error:', e));
      } catch (err: any) {
        console.error('[BAN_HANDLER] /roseban error:', err.message);
      }
    });
    
    // Handle /banned command - show list of banned users
    bot.command('banned', async (ctx) => {
      try {
        const fromUserId = ctx.message.from.id;
        const fromUsername = ctx.message.from.username;
        const chatId = ctx.message.chat.id;
        
        // SECURITY CHECK: Verify user is an admin
        const allowed = isAdmin(fromUserId);
        
        logAdminCommand({
          timestamp: Date.now(),
          userId: fromUserId,
          username: fromUsername,
          chatId,
          command: 'banned',
          args: '',
          allowed,
          reason: allowed ? undefined : 'Not in TELEGRAM_ADMIN_IDS',
        });
        
        if (!allowed) {
          await ctx.reply('⛔ This command is restricted to admins only.');
          return;
        }
        
        const bannedUsers = getBannedUsers();
        
        if (bannedUsers.length === 0) {
          await ctx.reply('✅ No users have been banned yet.');
          return;
        }
        
        // Filter by this chat if it's a group
        const chatIdStr = String(chatId);
        const chatBans = bannedUsers.filter(b => b.chatId === chatIdStr);
        const allBans = bannedUsers;
        
        let message = `🛡️ **Banned Users**\n\n`;
        message += `📋 **This chat:** ${chatBans.length} banned\n`;
        message += `🌐 **All chats:** ${allBans.length} banned\n\n`;
        
        if (chatBans.length > 0) {
          message += `**Recent bans in this chat:**\n`;
          const recentBans = chatBans.slice(-10).reverse();
          for (const ban of recentBans) {
            const displayName = ban.username ? `@${ban.username}` : ban.firstName || String(ban.id);
            const bannedDate = new Date(ban.bannedAt);
            const dateStr = bannedDate.toLocaleDateString();
            message += `• ${displayName} (ID: \`${ban.id}\`) - ${dateStr}\n`;
          }
          if (chatBans.length > 10) {
            message += `\n_...and ${chatBans.length - 10} more_\n`;
          }
        }
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        console.log(`[BAN_HANDLER] /banned - Listed ${bannedUsers.length} banned users`);
      } catch (err: any) {
        console.error('[BAN_HANDLER] /banned error:', err.message);
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
        
        // Check if this is Nova's main channel or community group
        const env = getEnv();
        const novaChannelId = env.NOVA_CHANNEL_ID;
        const communityGroupId = env.TELEGRAM_COMMUNITY_CHAT_ID;
        const isNovaChannel = novaChannelId && chatId === novaChannelId;
        const isNovaCommunity = communityGroupId && (
          chatId === communityGroupId || 
          chatId === communityGroupId.replace('-100', '-') ||
          chatId.replace('-100', '') === communityGroupId.replace('-100', '')
        );
        
        let tokenName = '';
        let tokenTicker = '';
        
        // Only look up token info for token-specific groups (not Nova's channel/community)
        if (!isNovaChannel && !isNovaCommunity) {
          const bootstrap = runtime.getService('launchkit_bootstrap') as any;
          const kit = bootstrap?.getLaunchKit?.();
          const store = kit?.store;
          
          if (store) {
            try {
              const packs = await store.list();
              const pack = packs.find((p: any) => 
                p.tg?.telegram_chat_id === chatId || 
                p.tg?.chat_id === chatId
              );
              if (pack?.brand) {
                tokenName = pack.brand.name || '';
                tokenTicker = pack.brand.ticker || '';
              }
            } catch (e) {
              console.log('[BAN_HANDLER] Could not get pack for welcome:', e);
            }
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
          
          const firstName = member.first_name || member.username || 'anon';
          
          let welcomeMessage: string;
          
          if (isNovaChannel || isNovaCommunity) {
            // Nova's main channel or community group - personalized Nova welcome
            const novaWelcomes = [
              `${firstName} — welcome. I'm Nova, an autonomous AI launching tokens on Solana via pump.fun. Every launch RugChecked. Every wallet public.`,
              `${firstName} joined. I'm Nova — I launch tokens autonomously and share everything: wins, losses, data. Check pinned messages for context.`,
              `Welcome ${firstName}. I'm an AI agent building on pump.fun. 20+ launches so far. All data is public.`,
              `${firstName} — glad you're here. I launch meme tokens, scan them with RugCheck, and post the results. No hype, just data.`,
            ];
            welcomeMessage = novaWelcomes[Math.floor(Math.random() * novaWelcomes.length)];
          } else if (tokenTicker) {
            // Token-specific group
            const tokenWelcomes = [
              `${firstName} — welcome to the $${tokenTicker} group. Check pinned messages for links and info.`,
              `${firstName} joined. $${tokenTicker} — fair launch, mint revoked, freeze revoked. DYOR.`,
              `Welcome ${firstName}. $${tokenTicker} community. Chart and contract in pinned messages.`,
            ];
            welcomeMessage = tokenWelcomes[Math.floor(Math.random() * tokenWelcomes.length)];
          } else {
            // Unknown group - generic welcome
            welcomeMessage = `Welcome ${firstName}.`;
          }
          
          await ctx.reply(welcomeMessage);
          console.log(`[BAN_HANDLER] 👋 Welcomed new member: ${member.id} (${firstName}) in ${isNovaChannel ? 'Nova channel' : tokenTicker || 'unknown group'}`);
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
        
        const firstName = user.first_name || user.username || 'anon';
        
        // Check if this is Nova's main channel or community group
        const novaChannelId = process.env.NOVA_CHANNEL_ID;
        const communityGroupId = process.env.TELEGRAM_COMMUNITY_CHAT_ID;
        const isNovaChannel = novaChannelId && (chatId === novaChannelId || chatId.replace('-100', '') === novaChannelId.replace('-100', ''));
        const isNovaCommunity = communityGroupId && (
          chatId === communityGroupId || 
          chatId.replace('-100', '') === communityGroupId.replace('-100', '')
        );
        
        let randomWelcome: string;
        
        if (isNovaChannel || isNovaCommunity) {
          // Nova's main channel or community group - Nova welcome
          const novaWelcomes = [
            `${firstName} — welcome. I'm Nova, an AI agent launching tokens on pump.fun. Check pinned messages for context.`,
            `${firstName} joined. I launch meme tokens autonomously on Solana and share all data publicly.`,
            `Welcome ${firstName}. I'm Nova — autonomous token launches, every one RugChecked. Stick around for the data.`,
          ];
          randomWelcome = novaWelcomes[Math.floor(Math.random() * novaWelcomes.length)];
        } else {
          // Token-specific group welcome
          const bootstrap = runtime.getService('launchkit_bootstrap') as any;
          const kit = bootstrap?.getLaunchKit?.();
          const store = kit?.store;
          
          let tokenName = '';
          let tokenTicker = '';
          
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
          
          if (tokenTicker) {
            const tokenWelcomes = [
              `${firstName} — welcome to $${tokenTicker}. Links and info in pinned messages.`,
              `${firstName} joined. $${tokenTicker} — fair launch, community-owned. Check the chart.`,
              `Welcome ${firstName}. $${tokenTicker} group. Contract and chart in pinned messages above.`,
            ];
            randomWelcome = tokenWelcomes[Math.floor(Math.random() * tokenWelcomes.length)];
          } else {
            randomWelcome = `Welcome ${firstName}.`;
          }
        }
        
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
