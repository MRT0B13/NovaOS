import { logger } from '@elizaos/core';
import { LaunchPackStore } from '../db/launchPackRepository.ts';
import { LaunchPack } from '../model/launchPack.ts';

/**
 * Group Tracker Service
 * 
 * Automatically tracks Telegram groups the bot is in and which
 * LaunchPack (mascot/token) is linked to each group.
 */

export interface TrackedGroup {
  chatId: string;
  name: string;
  type: 'group' | 'supergroup' | 'channel' | 'private';
  linkedPackId?: string;
  linkedPackName?: string;
  linkedPackTicker?: string;
  memberCount?: number;
  firstSeenAt: string;
  lastMessageAt: string;
  messageCount: number;
}

// In-memory cache of tracked groups
const trackedGroups = new Map<string, TrackedGroup>();

/**
 * Track a group when we receive a message from it
 */
export function trackGroup(
  chatId: string | number,
  metadata: {
    name?: string;
    type?: string;
    memberCount?: number;
  }
): void {
  const chatIdStr = String(chatId);
  const now = new Date().toISOString();
  
  const existing = trackedGroups.get(chatIdStr);
  
  if (existing) {
    existing.lastMessageAt = now;
    existing.messageCount++;
    if (metadata.name) existing.name = metadata.name;
    if (metadata.memberCount) existing.memberCount = metadata.memberCount;
  } else {
    const group: TrackedGroup = {
      chatId: chatIdStr,
      name: metadata.name || 'Group ' + chatIdStr,
      type: (metadata.type as any) || 'supergroup',
      firstSeenAt: now,
      lastMessageAt: now,
      messageCount: 1,
      memberCount: metadata.memberCount,
    };
    trackedGroups.set(chatIdStr, group);
    logger.info('[GroupTracker] New group discovered: ' + group.name + ' (' + chatIdStr + ')');
  }
}

/**
 * Link a tracked group to a LaunchPack
 */
export function linkGroupToPack(chatId: string, pack: LaunchPack): void {
  const group = trackedGroups.get(chatId);
  if (group) {
    group.linkedPackId = pack.id;
    group.linkedPackName = pack.brand.name;
    group.linkedPackTicker = pack.brand.ticker;
    logger.info('[GroupTracker] Linked ' + group.name + ' to ' + pack.brand.name + ' ($' + pack.brand.ticker + ')');
  }
}

/**
 * Get all tracked groups with their linked packs
 */
export async function getAllGroups(store?: LaunchPackStore): Promise<TrackedGroup[]> {
  if (store) {
    try {
      const packs = await store.list();
      for (const pack of packs) {
        const chatId = (pack.tg as any)?.telegram_chat_id;
        if (chatId) {
          const group = trackedGroups.get(chatId);
          if (group) {
            group.linkedPackId = pack.id;
            group.linkedPackName = pack.brand.name;
            group.linkedPackTicker = pack.brand.ticker;
          } else {
            trackedGroups.set(chatId, {
              chatId,
              name: pack.brand.name + ' Group',
              type: 'supergroup',
              linkedPackId: pack.id,
              linkedPackName: pack.brand.name,
              linkedPackTicker: pack.brand.ticker,
              firstSeenAt: pack.created_at || new Date().toISOString(),
              lastMessageAt: pack.updated_at || new Date().toISOString(),
              messageCount: 0,
            });
          }
        }
      }
    } catch (err) {
      logger.error('[GroupTracker] Failed to sync with store: ' + err);
    }
  }
  
  return Array.from(trackedGroups.values()).sort((a, b) => 
    new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
}

/**
 * Get a specific group by chat ID
 */
export function getGroup(chatId: string): TrackedGroup | undefined {
  return trackedGroups.get(chatId);
}

/**
 * Get groups that are not linked to any LaunchPack
 */
export async function getUnlinkedGroups(store?: LaunchPackStore): Promise<TrackedGroup[]> {
  const all = await getAllGroups(store);
  return all.filter(g => !g.linkedPackId);
}

/**
 * Get summary of all groups for agent context
 */
export async function getGroupsSummary(store?: LaunchPackStore): Promise<string> {
  const groups = await getAllGroups(store);
  
  if (groups.length === 0) {
    return 'No Telegram groups discovered yet.';
  }
  
  const linked = groups.filter(g => g.linkedPackId);
  const unlinked = groups.filter(g => !g.linkedPackId);
  
  let summary = '## Telegram Groups I Am In\n\n';
  
  if (linked.length > 0) {
    summary += '### Linked Groups (' + linked.length + ')\n';
    for (const g of linked) {
      summary += '- **' + g.name + '** -> $' + g.linkedPackTicker + ' (' + g.linkedPackName + ')\n';
      summary += '  Chat ID: ' + g.chatId + ' | Messages: ' + g.messageCount + '\n';
    }
    summary += '\n';
  }
  
  if (unlinked.length > 0) {
    summary += '### Unlinked Groups (' + unlinked.length + ')\n';
    summary += 'These groups need to be linked to a LaunchPack:\n';
    for (const g of unlinked) {
      summary += '- **' + g.name + '** (' + g.chatId + ')\n';
    }
    summary += '\nLink with: "link group [chat_id] to [token name]"\n';
  }
  
  return summary;
}

/**
 * Initialize tracker from stored LaunchPacks
 */
export async function initializeFromStore(store: LaunchPackStore): Promise<void> {
  try {
    const packs = await store.list();
    for (const pack of packs) {
      const chatId = (pack.tg as any)?.telegram_chat_id;
      if (chatId) {
        trackedGroups.set(chatId, {
          chatId,
          name: pack.brand.name + ' Community',
          type: 'supergroup',
          linkedPackId: pack.id,
          linkedPackName: pack.brand.name,
          linkedPackTicker: pack.brand.ticker,
          firstSeenAt: pack.created_at || new Date().toISOString(),
          lastMessageAt: pack.updated_at || new Date().toISOString(),
          messageCount: 0,
        });
      }
    }
    logger.info('[GroupTracker] Initialized with ' + trackedGroups.size + ' groups from store');
  } catch (err) {
    logger.error('[GroupTracker] Failed to initialize from store: ' + err);
  }
}
