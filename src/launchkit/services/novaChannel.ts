import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import type { LaunchPack } from '../model/launchPack.ts';

/**
 * Nova Channel Service
 * 
 * Manages Nova's own Telegram channel/group for:
 * - Launch announcements (new tokens launched)
 * - Wallet activity (withdrawals, deposits, trades)
 * - Group health summaries (periodic token community updates)
 * - Community engagement (responding to messages if it's a group)
 */

export type NovaUpdateType = 'launches' | 'wallet' | 'health' | 'marketing' | 'system';

interface NovaChannelConfig {
  enabled: boolean;
  channelId: string | null;
  enabledUpdates: Set<NovaUpdateType>;
  botToken: string | null;
}

let channelConfig: NovaChannelConfig | null = null;

/**
 * Initialize the Nova channel service
 */
export function initNovaChannel(): NovaChannelConfig {
  const env = getEnv();
  
  const enabledUpdates = new Set<NovaUpdateType>();
  if (env.NOVA_CHANNEL_UPDATES) {
    const updates = env.NOVA_CHANNEL_UPDATES.split(',').map(s => s.trim().toLowerCase());
    for (const u of updates) {
      if (['launches', 'wallet', 'health', 'marketing', 'system'].includes(u)) {
        enabledUpdates.add(u as NovaUpdateType);
      }
    }
  }
  
  channelConfig = {
    enabled: env.NOVA_CHANNEL_ENABLE === 'true' && !!env.NOVA_CHANNEL_ID,
    channelId: env.NOVA_CHANNEL_ID || null,
    enabledUpdates,
    botToken: env.TG_BOT_TOKEN || null,
  };
  
  if (channelConfig.enabled) {
    logger.info(`[NovaChannel] ✅ Initialized (channelId=${channelConfig.channelId}, updates=${Array.from(enabledUpdates).join(',')})`);
  } else {
    logger.info('[NovaChannel] Disabled (set NOVA_CHANNEL_ENABLE=true and NOVA_CHANNEL_ID to enable)');
  }
  
  return channelConfig;
}

/**
 * Check if a specific update type is enabled
 */
export function isUpdateEnabled(type: NovaUpdateType): boolean {
  if (!channelConfig) initNovaChannel();
  return channelConfig?.enabled && channelConfig.enabledUpdates.has(type) || false;
}

/**
 * Sanitize text for Telegram API (ensure valid UTF-8)
 */
function sanitizeForTelegram(text: string): string {
  // Remove any invalid UTF-8 characters and control characters (except newlines/tabs)
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars except \n, \r, \t
    .replace(/[\uFFFD\uFFFE\uFFFF]/g, '') // Remove replacement/invalid Unicode
    .replace(/[\uD800-\uDFFF]/g, '') // Remove lone surrogates
    .trim();
}

/**
 * Send a message to Nova's channel
 */
async function sendToChannel(
  text: string,
  options: { parseMode?: 'HTML' | 'Markdown'; disablePreview?: boolean } = {}
): Promise<boolean> {
  if (!channelConfig) initNovaChannel();
  if (!channelConfig?.enabled || !channelConfig.channelId || !channelConfig.botToken) {
    return false;
  }
  
  // Sanitize text to ensure valid UTF-8
  const sanitizedText = sanitizeForTelegram(text);
  if (!sanitizedText) {
    logger.warn('[NovaChannel] Empty message after sanitization');
    return false;
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${channelConfig.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelConfig.channelId,
        text: sanitizedText,
        parse_mode: options.parseMode || 'HTML',
        disable_web_page_preview: options.disablePreview ?? true,
      }),
    });
    
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      logger.warn(`[NovaChannel] Failed to send message: ${json?.description || res.status}`);
      return false;
    }
    
    logger.info(`[NovaChannel] ✅ Posted: ${sanitizedText.substring(0, 50)}...`);
    return true;
  } catch (err) {
    logger.error('[NovaChannel] Error sending message:', err);
    return false;
  }
}

/**
 * Send a photo with caption to Nova's channel
 */
async function sendPhotoToChannel(
  photoUrl: string,
  caption: string,
  options: { parseMode?: 'HTML' | 'Markdown' } = {}
): Promise<boolean> {
  if (!channelConfig) initNovaChannel();
  if (!channelConfig?.enabled || !channelConfig.channelId || !channelConfig.botToken) {
    return false;
  }
  
  // Sanitize caption to ensure valid UTF-8
  const sanitizedCaption = sanitizeForTelegram(caption);
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${channelConfig.botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelConfig.channelId,
        photo: photoUrl,
        caption: sanitizedCaption,
        parse_mode: options.parseMode || 'HTML',
      }),
    });
    
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      logger.warn(`[NovaChannel] Failed to send photo: ${json?.description || res.status}`);
      // Fallback to text-only
      return sendToChannel(sanitizedCaption, options);
    }
    
    logger.info(`[NovaChannel] ✅ Posted with image: ${sanitizedCaption.substring(0, 50)}...`);
    return true;
  } catch (err) {
    logger.error('[NovaChannel] Error sending photo:', err);
    return false;
  }
}

// ============================================================================
// Launch Announcements
// ============================================================================

/**
 * Announce a new token launch
 */
export async function announceLaunch(launchPack: LaunchPack): Promise<boolean> {
  if (!isUpdateEnabled('launches')) return false;
  
  const ticker = launchPack.brand?.ticker || 'TOKEN';
  const name = launchPack.brand?.name || 'New Token';
  const mint = launchPack.launch?.mint;
  const mascot = (launchPack as any).brand?.mascot;
  
  const pumpUrl = mint ? `https://pump.fun/coin/${mint}` : null;
  const tgUrl = launchPack.tg?.invite_link;
  
  let message = `🚀 <b>NEW LAUNCH: $${ticker}</b>\n\n`;
  message += `${mascot ? `Meet ${mascot}! ` : ''}${name} just launched on pump.fun!\n\n`;
  
  if (pumpUrl) message += `📈 <a href="${pumpUrl}">Trade on Pump.fun</a>\n`;
  if (tgUrl) message += `💬 <a href="${tgUrl}">Join Telegram</a>\n`;
  
  message += `\n#${ticker} #launch #pumpdotfun`;
  
  // Try to send with logo if available
  const logoUrl = (launchPack as any).brand?.image_url || (launchPack as any).brand?.logo_url;
  if (logoUrl) {
    return sendPhotoToChannel(logoUrl, message);
  }
  
  return sendToChannel(message);
}

// ============================================================================
// Wallet Activity Notifications
// ============================================================================

export interface WalletActivity {
  type: 'withdraw' | 'deposit' | 'buy' | 'sell';
  amount: number; // SOL or token amount
  tokenTicker?: string;
  txSignature?: string;
  destination?: string;
  source?: string;
}

/**
 * Announce wallet activity
 */
export async function announceWalletActivity(activity: WalletActivity): Promise<boolean> {
  if (!isUpdateEnabled('wallet')) return false;
  
  const emoji = {
    withdraw: '📤',
    deposit: '📥',
    buy: '🟢',
    sell: '🔴',
  }[activity.type];
  
  const action = {
    withdraw: 'Withdrew',
    deposit: 'Received',
    buy: 'Bought',
    sell: 'Sold',
  }[activity.type];
  
  let message = `${emoji} <b>Wallet Update</b>\n\n`;
  
  if (activity.type === 'buy' || activity.type === 'sell') {
    message += `${action} $${activity.tokenTicker || 'TOKEN'}\n`;
    message += `Amount: ${activity.amount.toFixed(4)} SOL\n`;
  } else {
    message += `${action} ${activity.amount.toFixed(4)} SOL\n`;
    if (activity.destination) message += `To: <code>${activity.destination.slice(0, 8)}...${activity.destination.slice(-4)}</code>\n`;
    if (activity.source) message += `From: <code>${activity.source.slice(0, 8)}...${activity.source.slice(-4)}</code>\n`;
  }
  
  if (activity.txSignature) {
    message += `\n<a href="https://solscan.io/tx/${activity.txSignature}">View on Solscan</a>`;
  }
  
  return sendToChannel(message);
}

// ============================================================================
// Group Health Summaries
// ============================================================================

export interface TokenHealthSummary {
  ticker: string;
  name?: string;
  description?: string;
  members: number;
  active: number;
  sentiment: string;
  trend: string;
  tgInviteLink?: string;
  marketCap?: number;
  priceChange24h?: number;
  messagesPerDay?: number;
  memberChange24h?: number;
}

/**
 * Post a group health summary
 */
export async function announceHealthSummary(tokens: TokenHealthSummary[]): Promise<boolean> {
  if (!isUpdateEnabled('health')) return false;
  if (tokens.length === 0) return false;
  
  let message = `📊 <b>Community Health Update</b>\n\n`;
  
  // Sort by activity (most active first)
  const sorted = [...tokens].sort((a, b) => b.active - a.active);
  
  for (let i = 0; i < sorted.length; i++) {
    const token = sorted[i];
    const trendEmoji = token.trend === 'growing' ? '📈' : token.trend === 'declining' ? '📉' : '➡️';
    const sentimentEmoji = token.sentiment === 'bullish' ? '🟢' : token.sentiment === 'bearish' ? '🔴' : '🟡';
    const rankEmoji = i === 0 && sorted.length > 1 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
    
    // Header with name and trend
    message += `${rankEmoji}<b>$${token.ticker}</b>`;
    if (token.name) message += ` - ${token.name}`;
    message += ` ${trendEmoji}\n`;
    
    // Description if available
    if (token.description) {
      message += `<i>${token.description}</i>\n`;
    }
    
    // Stats line
    message += `👥 ${token.members} members`;
    if (token.memberChange24h !== undefined && token.memberChange24h !== 0) {
      const changeSign = token.memberChange24h > 0 ? '+' : '';
      message += ` (${changeSign}${token.memberChange24h} today)`;
    }
    message += ` • ${token.active} active\n`;
    
    // Activity and sentiment
    if (token.messagesPerDay !== undefined && token.messagesPerDay > 0) {
      message += `💬 ${token.messagesPerDay} msgs/day • `;
    }
    message += `${sentimentEmoji} ${token.sentiment}\n`;
    
    // Market data if available
    if (token.marketCap) {
      message += `💰 MC: $${formatNumber(token.marketCap)}`;
      if (token.priceChange24h !== undefined) {
        const changeEmoji = token.priceChange24h >= 0 ? '🟢' : '🔴';
        message += ` ${changeEmoji} ${token.priceChange24h >= 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}%`;
      }
      message += '\n';
    }
    
    // Join link
    if (token.tgInviteLink) {
      message += `🔗 <a href="${token.tgInviteLink}">Join Community</a>\n`;
    }
    
    message += '\n';
  }
  
  message += `<i>Updated ${new Date().toLocaleTimeString()}</i>`;
  
  return sendToChannel(message);
}

// ============================================================================
// Marketing Updates
// ============================================================================

/**
 * Announce when marketing posts go out
 */
export async function announceMarketingPost(
  platform: 'x' | 'telegram',
  ticker: string,
  postPreview: string
): Promise<boolean> {
  if (!isUpdateEnabled('marketing')) return false;
  
  const platformEmoji = platform === 'x' ? '🐦' : '📣';
  const platformName = platform === 'x' ? 'X/Twitter' : 'Telegram';
  
  const message = `${platformEmoji} <b>Posted to ${platformName}</b>\n\n` +
    `$${ticker}: "${postPreview.substring(0, 100)}${postPreview.length > 100 ? '...' : ''}"`;
  
  return sendToChannel(message);
}

// ============================================================================
// System Notifications
// ============================================================================

/**
 * Send a system notification (startup, errors, etc.)
 */
export async function announceSystem(
  type: 'startup' | 'shutdown' | 'error' | 'info',
  message: string
): Promise<boolean> {
  if (!isUpdateEnabled('system')) return false;
  
  const emoji = {
    startup: '🟢',
    shutdown: '🔴',
    error: '⚠️',
    info: 'ℹ️',
  }[type];
  
  const fullMessage = `${emoji} <b>System</b>\n\n${message}`;
  
  return sendToChannel(fullMessage);
}

// ============================================================================
// Daily Summary (Scheduled)
// ============================================================================

export interface DailySummaryData {
  launchCount: number;
  totalTweets: number;
  totalTgPosts: number;
  walletBalance: number;
  totalWithdrawn: number;
  tokens: TokenHealthSummary[];
}

/**
 * Post a daily summary
 */
export async function announceDailySummary(data: DailySummaryData): Promise<boolean> {
  if (!channelConfig?.enabled) return false;
  
  let message = `📅 <b>Daily Summary</b>\n\n`;
  
  message += `🚀 Launches: ${data.launchCount}\n`;
  message += `🐦 Tweets sent: ${data.totalTweets}\n`;
  message += `📣 TG posts: ${data.totalTgPosts}\n`;
  message += `💰 Wallet: ${data.walletBalance.toFixed(4)} SOL\n`;
  
  if (data.totalWithdrawn > 0) {
    message += `📤 Withdrawn today: ${data.totalWithdrawn.toFixed(4)} SOL\n`;
  }
  
  if (data.tokens.length > 0) {
    message += `\n<b>Token Status:</b>\n`;
    for (const token of data.tokens) {
      const emoji = token.trend === 'growing' ? '📈' : token.trend === 'declining' ? '📉' : '➡️';
      message += `• $${token.ticker}: ${token.members} members ${emoji}\n`;
    }
  }
  
  message += `\n<i>Generated ${new Date().toLocaleString()}</i>`;
  
  return sendToChannel(message);
}

// ============================================================================
// Utilities
// ============================================================================

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(2);
}

export default {
  initNovaChannel,
  isUpdateEnabled,
  announceLaunch,
  announceWalletActivity,
  announceHealthSummary,
  announceMarketingPost,
  announceSystem,
  announceDailySummary,
};
