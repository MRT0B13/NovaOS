/**
 * Group Health Monitor
 * Tracks Telegram group metrics: member count, activity, sentiment
 * Runs periodic checks and stores health data in LaunchPack
 */

import { getEnv } from '../env.ts';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { LaunchPack } from '../model/launchPack.ts';

interface ChatInfo {
  id: number;
  type: string;
  title?: string;
  description?: string;
}

interface GroupHealth {
  memberCount: number;
  activeMembers24h: number;
  messagesPerDay: number;
  sentiment: 'bullish' | 'neutral' | 'bearish';
  sentimentScore: number; // -1 to 1
  topContributors: string[];
  lastUpdated: string;
  trend: 'growing' | 'stable' | 'declining';
  memberChange24h: number;
}

interface MessageActivity {
  chatId: string;
  userId: number;
  username?: string;
  timestamp: number;
  sentiment?: 'positive' | 'neutral' | 'negative';
}

// In-memory activity tracking (persisted to file periodically)
const activityLog: Map<string, MessageActivity[]> = new Map();
const memberCountHistory: Map<string, { count: number; timestamp: number }[]> = new Map();

// Sentiment keywords
const BULLISH_KEYWORDS = [
  'moon', 'pump', 'bullish', 'ape', 'buy', 'accumulate', 'hodl', 'hold',
  'wagmi', 'gmi', 'lfg', 'let\'s go', 'fire', '🚀', '🔥', '💎', '🙌',
  'based', 'gigachad', 'alpha', 'sending', 'send it', 'king', 'gem',
  'degen', 'bullrun', 'breakout', 'support', 'higher highs', 'golden'
];

const BEARISH_KEYWORDS = [
  'dump', 'rug', 'scam', 'sell', 'bearish', 'fud', 'ngmi', 'dead',
  'rekt', 'exit', 'liquidated', 'crash', 'dip', 'down', '📉', '💀',
  'bag', 'bagholder', 'shitcoin', 'ponzi', 'over', 'done', 'rugged',
  'resistance', 'lower lows', 'bleeding', 'capitulation'
];

async function tgApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description || 'Unknown error'}`);
  }
  return json.result as T;
}

/**
 * Analyze sentiment of a message
 */
export function analyzeSentiment(text: string): { sentiment: 'positive' | 'neutral' | 'negative'; score: number } {
  const lowerText = text.toLowerCase();
  
  let bullishScore = 0;
  let bearishScore = 0;
  
  for (const keyword of BULLISH_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      bullishScore += keyword.length > 3 ? 2 : 1;
    }
  }
  
  for (const keyword of BEARISH_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      bearishScore += keyword.length > 3 ? 2 : 1;
    }
  }
  
  // Exclamation marks boost sentiment
  const exclamations = (text.match(/!/g) || []).length;
  bullishScore += exclamations * 0.5;
  
  // Question marks are neutral/uncertain
  const questions = (text.match(/\?/g) || []).length;
  bearishScore += questions * 0.2;
  
  const netScore = bullishScore - bearishScore;
  const normalizedScore = Math.max(-1, Math.min(1, netScore / 10));
  
  if (netScore > 2) return { sentiment: 'positive', score: normalizedScore };
  if (netScore < -2) return { sentiment: 'negative', score: normalizedScore };
  return { sentiment: 'neutral', score: normalizedScore };
}

/**
 * Track a message for activity and sentiment
 */
export function trackMessage(chatId: string, userId: number, username: string | undefined, text: string): void {
  const activity: MessageActivity = {
    chatId,
    userId,
    username,
    timestamp: Date.now(),
    sentiment: analyzeSentiment(text).sentiment,
  };
  
  const existing = activityLog.get(chatId) || [];
  existing.push(activity);
  
  // Keep only last 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = existing.filter(a => a.timestamp > cutoff);
  activityLog.set(chatId, filtered);
}

/**
 * Get activity stats for a chat
 */
export function getActivityStats(chatId: string): { 
  messagesPerDay: number; 
  activeUsers: number;
  topContributors: { username: string; count: number }[];
  averageSentiment: number;
} {
  const activities = activityLog.get(chatId) || [];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const last24h = activities.filter(a => a.timestamp > cutoff24h);
  
  // Count messages per user
  const userCounts = new Map<number, { username: string; count: number }>();
  let sentimentSum = 0;
  let sentimentCount = 0;
  
  for (const activity of last24h) {
    const existing = userCounts.get(activity.userId);
    if (existing) {
      existing.count++;
    } else {
      userCounts.set(activity.userId, { 
        username: activity.username || `user_${activity.userId}`, 
        count: 1 
      });
    }
    
    if (activity.sentiment) {
      sentimentSum += activity.sentiment === 'positive' ? 1 : activity.sentiment === 'negative' ? -1 : 0;
      sentimentCount++;
    }
  }
  
  // Get top contributors
  const sorted = Array.from(userCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  
  return {
    messagesPerDay: last24h.length,
    activeUsers: userCounts.size,
    topContributors: sorted,
    averageSentiment: sentimentCount > 0 ? sentimentSum / sentimentCount : 0,
  };
}

export class GroupHealthMonitor {
  private botToken: string | undefined;
  private monitorInterval: NodeJS.Timeout | null = null;
  
  constructor(private store: LaunchPackStore) {
    const env = getEnv();
    this.botToken = env.TG_BOT_TOKEN;
  }
  
  /**
   * Get current member count for a chat
   */
  async getMemberCount(chatId: string): Promise<number | null> {
    if (!this.botToken) return null;
    
    try {
      const count = await tgApi<number>(this.botToken, 'getChatMemberCount', { chat_id: chatId });
      
      // Track history
      const history = memberCountHistory.get(chatId) || [];
      history.push({ count, timestamp: Date.now() });
      
      // Keep only last 7 days
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      memberCountHistory.set(chatId, history.filter(h => h.timestamp > cutoff));
      
      return count;
    } catch (err) {
      console.error(`[GROUP_HEALTH] Failed to get member count for ${chatId}:`, err);
      return null;
    }
  }
  
  /**
   * Get chat info
   */
  async getChatInfo(chatId: string): Promise<ChatInfo | null> {
    if (!this.botToken) return null;
    
    try {
      return await tgApi<ChatInfo>(this.botToken, 'getChat', { chat_id: chatId });
    } catch (err) {
      console.error(`[GROUP_HEALTH] Failed to get chat info for ${chatId}:`, err);
      return null;
    }
  }
  
  /**
   * Calculate member change over 24h
   */
  getMemberChange24h(chatId: string): number {
    const history = memberCountHistory.get(chatId) || [];
    if (history.length < 2) return 0;
    
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const oldestIn24h = history.filter(h => h.timestamp > cutoff24h).sort((a, b) => a.timestamp - b.timestamp)[0];
    const latest = history[history.length - 1];
    
    if (!oldestIn24h || !latest) return 0;
    return latest.count - oldestIn24h.count;
  }
  
  /**
   * Get full health report for a chat
   */
  async getHealthReport(chatId: string): Promise<GroupHealth | null> {
    const memberCount = await this.getMemberCount(chatId);
    if (memberCount === null) return null;
    
    const activityStats = getActivityStats(chatId);
    const memberChange = this.getMemberChange24h(chatId);
    
    // Determine trend
    let trend: 'growing' | 'stable' | 'declining' = 'stable';
    if (memberChange > 5) trend = 'growing';
    else if (memberChange < -5) trend = 'declining';
    
    // Determine overall sentiment
    let sentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
    if (activityStats.averageSentiment > 0.2) sentiment = 'bullish';
    else if (activityStats.averageSentiment < -0.2) sentiment = 'bearish';
    
    return {
      memberCount,
      activeMembers24h: activityStats.activeUsers,
      messagesPerDay: activityStats.messagesPerDay,
      sentiment,
      sentimentScore: activityStats.averageSentiment,
      topContributors: activityStats.topContributors.map(c => c.username),
      lastUpdated: new Date().toISOString(),
      trend,
      memberChange24h: memberChange,
    };
  }
  
  /**
   * Get health report for Nova's own channel
   * Tracks the main community channel where autonomous launches are announced
   */
  async getNovaChannelHealth(): Promise<GroupHealth | null> {
    const env = getEnv();
    const channelId = env.NOVA_CHANNEL_ID;
    
    if (!channelId || env.NOVA_CHANNEL_ENABLE !== 'true') {
      return null;
    }
    
    try {
      return await this.getHealthReport(channelId);
    } catch (err) {
      console.warn('[GROUP_HEALTH] Failed to get Nova channel health:', err);
      return null;
    }
  }
  
  async getCommunityGroupHealth(): Promise<GroupHealth | null> {
    const env = getEnv();
    const communityId = env.TELEGRAM_COMMUNITY_CHAT_ID;
    
    if (!communityId) {
      console.log('[GROUP_HEALTH] No TELEGRAM_COMMUNITY_CHAT_ID set, skipping community group health');
      return null;
    }
    
    try {
      console.log(`[GROUP_HEALTH] Fetching community group health for chat ${communityId}`);
      const report = await this.getHealthReport(communityId);
      if (!report) {
        console.warn(`[GROUP_HEALTH] getHealthReport returned null for community group ${communityId}`);
      }
      return report;
    } catch (err) {
      console.warn('[GROUP_HEALTH] Failed to get community group health:', err);
      return null;
    }
  }
  
  /**
   * Update health for all tokens
   */
  async updateAllTokenHealth(): Promise<void> {
    console.log('[GROUP_HEALTH] Starting health check...');
    const env = getEnv();
    
    // If token marketing is disabled, only track Nova channel
    const tokenTrackingDisabled = env.TOKEN_TG_MARKETING_ENABLE === 'false';
    
    const healthSummaries: Array<{
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
    }> = [];
    
    // Only check individual token groups if token marketing is enabled
    if (!tokenTrackingDisabled) {
      const allPacks = await this.store.list();
      // Only check health for launched tokens (not draft/failed)
      // SKIP autonomous launches - they share Nova's channel, not individual TG groups
      const packs = allPacks.filter(p => 
        p.launch?.status === 'launched' &&
        !p.ops?.checklist?.autonomous // Skip autonomous launches
      );
      
      for (const pack of packs) {
        const chatId = pack.tg?.telegram_chat_id;
        if (!chatId) continue;
        
        try {
          const health = await this.getHealthReport(chatId);
          if (health) {
            // Store in LaunchPack
            await this.store.update(pack.id!, {
              tg: {
                ...pack.tg,
                health: health as any,
              }
            } as Partial<LaunchPack>);
            
            console.log(`[GROUP_HEALTH] Updated health for ${pack.brand?.ticker || pack.id}:`, {
              members: health.memberCount,
              active: health.activeMembers24h,
              sentiment: health.sentiment,
              trend: health.trend,
            });
            
            // Collect for Nova channel summary with full details
            healthSummaries.push({
              ticker: pack.brand?.ticker || 'UNKNOWN',
              name: pack.brand?.name,
              description: pack.brand?.description || pack.brand?.tagline,
              members: health.memberCount,
              active: health.activeMembers24h,
              sentiment: health.sentiment,
              trend: health.trend,
              tgInviteLink: pack.tg?.invite_link || pack.links?.telegram,
              messagesPerDay: health.messagesPerDay,
              memberChange24h: health.memberChange24h,
            });
          }
        } catch (err) {
          console.error(`[GROUP_HEALTH] Failed to update ${pack.brand?.ticker}:`, err);
        }
      }
    } else {
      console.log('[GROUP_HEALTH] Token tracking disabled, only checking Nova channel');
    }
    
    // Also track Nova's own channel (where autonomous launches go)
    const novaChannelHealth = await this.getNovaChannelHealth();
    if (novaChannelHealth) {
      const env = getEnv();
      healthSummaries.unshift({
        ticker: 'NOVA',
        name: 'Nova Channel',
        description: 'Broadcast channel',
        members: novaChannelHealth.memberCount,
        active: novaChannelHealth.activeMembers24h,
        sentiment: novaChannelHealth.sentiment,
        trend: novaChannelHealth.trend,
        tgInviteLink: env.NOVA_CHANNEL_INVITE,
        messagesPerDay: novaChannelHealth.messagesPerDay,
        memberChange24h: novaChannelHealth.memberChange24h,
      });
      console.log(`[GROUP_HEALTH] Nova channel health: ${novaChannelHealth.memberCount} members, ${novaChannelHealth.activeMembers24h} active, ${novaChannelHealth.sentiment}`);
    }
    
    // Also track the community discussion group
    const communityGroupHealth = await this.getCommunityGroupHealth();
    if (communityGroupHealth) {
      const env2 = getEnv();
      healthSummaries.push({
        ticker: 'NOVA',
        name: 'Nova Community',
        description: 'Discussion & voting group',
        members: communityGroupHealth.memberCount,
        active: communityGroupHealth.activeMembers24h,
        sentiment: communityGroupHealth.sentiment,
        trend: communityGroupHealth.trend,
        tgInviteLink: env2.TELEGRAM_COMMUNITY_LINK,
        messagesPerDay: communityGroupHealth.messagesPerDay,
        memberChange24h: communityGroupHealth.memberChange24h,
      });
      console.log(`[GROUP_HEALTH] Community group health: ${communityGroupHealth.memberCount} members, ${communityGroupHealth.activeMembers24h} active, ${communityGroupHealth.sentiment}`);
    }
    
    // Post to Nova channel if we have health data
    // When token marketing is disabled, only show Nova's channel health (not other tokens)
    if (healthSummaries.length > 0) {
      try {
        const { announceHealthSummary } = await import('./novaChannel.ts');
        // If token tracking disabled, only show Nova channel
        const summariesToPost = tokenTrackingDisabled 
          ? healthSummaries.filter(s => s.ticker === 'NOVA')
          : healthSummaries;
        if (summariesToPost.length > 0) {
          await announceHealthSummary(summariesToPost);
        }
      } catch {
        // Non-fatal
      }
    }
  }
  
  /**
   * Start periodic health monitoring
   * Default: every hour
   */
  start(intervalMs: number = 60 * 60 * 1000): void {
    if (this.monitorInterval) {
      console.log('[GROUP_HEALTH] Monitor already running');
      return;
    }
    
    console.log('[GROUP_HEALTH] 🏥 Starting health monitor...');
    
    // Initial check after 30 seconds
    setTimeout(() => this.updateAllTokenHealth(), 30 * 1000);
    
    // Then periodic checks
    this.monitorInterval = setInterval(() => this.updateAllTokenHealth(), intervalMs);
    
    console.log(`[GROUP_HEALTH] Health check will run every ${intervalMs / 1000 / 60} minutes`);
  }
  
  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      console.log('[GROUP_HEALTH] Monitor stopped');
    }
  }
  
  /**
   * Get formatted health summary for display
   */
  formatHealthSummary(health: GroupHealth): string {
    const trendEmoji = health.trend === 'growing' ? '📈' : health.trend === 'declining' ? '📉' : '➡️';
    const sentimentEmoji = health.sentiment === 'bullish' ? '🟢' : health.sentiment === 'bearish' ? '🔴' : '🟡';
    const changeSign = health.memberChange24h >= 0 ? '+' : '';
    
    return `
📊 **Group Health Report**

👥 **Members:** ${health.memberCount.toLocaleString()} (${changeSign}${health.memberChange24h} in 24h) ${trendEmoji}
💬 **Messages/day:** ${health.messagesPerDay}
🧑‍🤝‍🧑 **Active users (24h):** ${health.activeMembers24h}

${sentimentEmoji} **Sentiment:** ${health.sentiment.toUpperCase()} (${(health.sentimentScore * 100).toFixed(0)}%)

🏆 **Top Contributors:**
${health.topContributors.slice(0, 3).map((c, i) => `   ${i + 1}. @${c}`).join('\n') || '   No data yet'}

🕐 Last updated: ${new Date(health.lastUpdated).toLocaleString()}
    `.trim();
  }
}

// Singleton instance
let healthMonitor: GroupHealthMonitor | null = null;

export function getHealthMonitor(store: LaunchPackStore): GroupHealthMonitor {
  if (!healthMonitor) {
    healthMonitor = new GroupHealthMonitor(store);
  }
  return healthMonitor;
}

export function startHealthMonitor(store: LaunchPackStore): void {
  getHealthMonitor(store).start();
}
