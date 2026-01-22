/**
 * Telegram User ID Caching Service
 * 
 * This service runs in parallel with ElizaOS's Telegram plugin to cache user IDs.
 * It uses getUpdates with an offset to not interfere with ElizaOS's polling,
 * but caches user info from the updates before they're processed.
 * 
 * KEY INSIGHT: This won't work because Telegram only allows ONE getUpdates client at a time.
 * If ElizaOS is polling, we can't poll simultaneously.
 * 
 * ACTUAL SOLUTION: We need to intercept updates at the ElizaOS plugin level,
 * or switch to webhook mode.
 * 
 * This file provides utility functions to manually cache users when we see them.
 */

import { cacheTelegramUser, getAllCachedUsers } from './telegramCommunity.ts';
import { getEnv } from '../env.ts';

const BOT_TOKEN = getEnv().TG_BOT_TOKEN;
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tgApi<T>(method: string, params?: Record<string, any>): Promise<T> {
  if (!API_BASE) {
    throw new Error('TG_BOT_TOKEN not configured');
  }
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });
  const json = await res.json() as any;
  if (!json.ok) {
    throw new Error(`Telegram API error: ${json.description || 'Unknown error'}`);
  }
  return json.result as T;
}

/**
 * Get all chat members (admins) to cache their IDs
 * This is useful for building an initial cache
 */
export async function cacheAllAdmins(chatId: string): Promise<number> {
  try {
    const admins = await tgApi<any[]>('getChatAdministrators', { chat_id: chatId });
    let cached = 0;
    
    for (const admin of admins) {
      if (admin.user) {
        cacheTelegramUser(chatId, {
          id: admin.user.id,
          username: admin.user.username,
          firstName: admin.user.first_name,
          lastName: admin.user.last_name,
        });
        cached++;
      }
    }
    
    console.log(`[TG_CACHE] Cached ${cached} admin users from chat ${chatId}`);
    return cached;
  } catch (err: any) {
    console.error(`[TG_CACHE] Failed to cache admins:`, err.message);
    return 0;
  }
}

/**
 * Try to get a user's ID by searching recent messages
 * This is a fallback when we don't have the user cached
 */
export async function findUserByRecentMessage(chatId: string, nameOrUsername: string): Promise<number | null> {
  // We can't search messages directly in Telegram API without webhooks/updates
  // This would need to be done at the webhook level
  console.log(`[TG_CACHE] findUserByRecentMessage not implemented - need webhook mode`);
  return null;
}

/**
 * Cache a user from a raw Telegram update
 * Call this when you have access to raw update data
 */
export function cacheUserFromUpdate(update: any): void {
  const message = update.message || update.edited_message || update.channel_post;
  const callbackQuery = update.callback_query;
  const chatMember = update.chat_member || update.my_chat_member;
  
  let from: any = null;
  let chatId: string | null = null;
  let messageId: number | undefined;
  
  if (message?.from) {
    from = message.from;
    chatId = String(message.chat?.id);
    messageId = message.message_id;
  } else if (callbackQuery?.from) {
    from = callbackQuery.from;
    chatId = String(callbackQuery.message?.chat?.id);
    messageId = callbackQuery.message?.message_id;
  } else if (chatMember?.from) {
    // chat_member updates for when users join
    from = chatMember.from;
    chatId = String(chatMember.chat?.id);
    
    // Also cache the user whose status changed
    const newMember = chatMember.new_chat_member?.user;
    if (newMember && chatId) {
      cacheTelegramUser(chatId, {
        id: newMember.id,
        username: newMember.username,
        firstName: newMember.first_name,
        lastName: newMember.last_name,
      });
    }
  }
  
  if (from && chatId) {
    cacheTelegramUser(chatId, {
      id: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    }, messageId);
  }
}

/**
 * Debug: Log all cached users
 */
export function debugPrintCache(): void {
  const cache = getAllCachedUsers();
  console.log(`\n[TG_CACHE] Current cache (${cache.size} entries):`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const [key, info] of cache) {
    const age = Math.floor((Date.now() - info.timestamp) / 1000 / 60);
    console.log(`  ${key} => ID ${info.id} (@${info.username || 'no-username'}) [${age}m ago]`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}
