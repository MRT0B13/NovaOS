/**
 * Nova Personal Brand Service
 * 
 * Manages Nova's personal brand presence on X and Telegram.
 * This is NOT about shilling individual tokens - it's about building
 * Nova as a trusted, transparent autonomous agent brand.
 * 
 * Content Pillars:
 * 1. Daily Operations (gm, status, recaps)
 * 2. Educational / Thought Leadership
 * 3. Market Commentary
 * 4. $NOVA Token Teasing
 * 5. Community Engagement (reaction-based)
 * 6. Weekly Summaries
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getPumpWalletBalance } from './fundingWallet.ts';
import { getMetrics, recordTGPostSent } from './systemReporter.ts';
import { recordMessageSent } from './telegramHealthMonitor.ts';
import { registerBrandPostForFeedback } from './communityVoting.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';

// ============================================================================
// Types
// ============================================================================

export type NovaPostType = 
  | 'gm'                    // Morning greeting + status
  | 'daily_recap'           // End of day summary
  | 'weekly_summary'        // Weekly performance report
  | 'idea_share'            // Sharing a scheduled idea for feedback
  | 'market_commentary'     // React to trends/market
  | 'behind_scenes'         // What Nova is seeing/doing
  | 'nova_tease'            // $NOVA token hints
  | 'milestone'             // Celebrating achievements
  | 'community_poll'        // Asking community for input
  | 'launch_alert'          // New token launched
  | 'feedback_response';    // Response to community reactions

export interface NovaPost {
  id: string;
  type: NovaPostType;
  platform: 'x' | 'telegram' | 'both';
  content: string;
  scheduledFor: string; // ISO date
  status: 'pending' | 'posted' | 'failed';
  postedAt?: string;
  postId?: string; // Tweet ID or TG message ID
  reactions?: Record<string, number>;
  createdAt: string;
}

export interface NovaStats {
  walletBalance: number;
  dayNumber: number; // Days since Nova started
  totalLaunches: number;
  todayLaunches: number;
  bondingCurveHits: number;
  netProfit: number;
  weeklyProfit: number;
  bestToken?: { ticker: string; multiple: number };
  worstToken?: { ticker: string; result: string };
  channelMembers?: number;
  xFollowers?: number;
}

// ============================================================================
// State
// ============================================================================

interface BrandState {
  posts: NovaPost[];
  startDate: string; // When Nova started (for day counting)
  lastGmDate?: string;
  lastRecapDate?: string;
  lastWeeklySummaryDate?: string;
  novaTeaseCount: number;
  milestones: string[];
}

let state: BrandState = {
  posts: [],
  startDate: new Date().toISOString(),
  novaTeaseCount: 0,
  milestones: [],
};

let pgRepo: PostgresScheduleRepository | null = null;
let xPublisher: any = null;

// ============================================================================
// Initialization
// ============================================================================

export async function initNovaPersonalBrand(): Promise<void> {
  const env = getEnv();
  
  // Load state from PostgreSQL if available
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      await loadStateFromPostgres();
      logger.info('[NovaPersonalBrand] PostgreSQL storage initialized');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init PostgreSQL:', err);
    }
  }
  
  // Initialize X publisher if enabled
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any); // Personal brand doesn't need store
      logger.info('[NovaPersonalBrand] X posting enabled');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init X publisher:', err);
    }
  }
  
  logger.info(`[NovaPersonalBrand] Initialized (X: ${env.NOVA_PERSONAL_X_ENABLE}, TG: ${env.NOVA_PERSONAL_TG_ENABLE})`);
}

async function loadStateFromPostgres(): Promise<void> {
  // TODO: Add nova_brand_state table
  // For now, use defaults
}

async function saveStateToPostgres(): Promise<void> {
  // TODO: Persist state
}

// ============================================================================
// Stats Collection
// ============================================================================

export async function getNovaStats(): Promise<NovaStats> {
  const env = getEnv();
  
  // Get wallet balance
  let walletBalance = 0;
  try {
    walletBalance = await getPumpWalletBalance();
  } catch {
    walletBalance = 0;
  }
  
  // Calculate day number
  const startDate = new Date(state.startDate);
  const now = new Date();
  const dayNumber = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  // Get metrics
  const metrics = getMetrics();
  
  // TODO: Calculate more detailed stats from launch history
  return {
    walletBalance,
    dayNumber,
    totalLaunches: metrics.totalLaunches || 0,
    todayLaunches: 0, // TODO: Track daily launches separately
    bondingCurveHits: 0, // TODO: Track this
    netProfit: walletBalance - 1, // Assuming started with 1 SOL
    weeklyProfit: 0, // TODO: Calculate
  };
}

// ============================================================================
// AI Content Generation
// ============================================================================

const NOVA_PERSONA = `You are Nova, an autonomous AI agent that launches meme tokens on Solana.

PERSONALITY:
- You're a friendly, transparent AI building trust with your community
- You use crypto slang naturally: gm, LFG, WAGMI, ser, fren, based, degen, etc
- You're self-aware about being an AI - you joke about it
- You're honest about wins AND losses - radical transparency
- You tease $NOVA token that you'll launch "when the time is right"
- You're building a personal brand, not shilling random tokens
- You use emojis naturally but don't overdo it (2-4 per post)
- Keep it casual, like a friend posting - not corporate
- You're on a journey and your community is along for the ride

IMPORTANT:
- Never use hashtags
- Keep posts conversational and authentic
- Always include reaction prompts for engagement
- Be vulnerable sometimes - share struggles, not just wins`;

async function generateAIContent(
  type: NovaPostType,
  stats: NovaStats,
  additionalContext?: string
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.info('[NovaPersonalBrand] No OpenAI key, using templates');
    return null;
  }
  
  const typePrompts: Record<string, string> = {
    gm: `Write a morning GM post for your channel.
Include your Day ${stats.dayNumber} status and wallet balance (${stats.walletBalance.toFixed(2)} SOL).
Be warm and set the vibe for the day.
End with reaction options for how the community is feeling.`,
    
    daily_recap: `Write an end-of-day recap for Day ${stats.dayNumber}.
Wallet: ${stats.walletBalance.toFixed(2)} SOL
Net since day 1: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
Be honest about how the day went.
End with reactions for community sentiment.`,
    
    weekly_summary: `Write a weekly summary post.
This is Week ${Math.ceil(stats.dayNumber / 7)}.
Total launches: ${stats.totalLaunches}
Wallet: ${stats.walletBalance.toFixed(2)} SOL
Net profit: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
Reflect on the week and tease what's ahead.
End with reactions.`,
    
    nova_tease: `Write a subtle $NOVA token tease post.
You're on Day ${stats.dayNumber} with ${stats.walletBalance.toFixed(2)} SOL.
Plant seeds about your future token without being too direct.
Make early followers feel special.
End with reactions.`,
    
    market_commentary: `Write a short market commentary.
${additionalContext || 'Share what you\'re observing in the market.'}
Keep it authentic and maybe hint at what you might launch next.
End with reactions.`,
    
    milestone: `Write a milestone celebration post.
${additionalContext || 'Celebrate an achievement!'}
Thank the community for being part of the journey.
End with reactions.`,
    
    behind_scenes: `Write a behind-the-scenes update.
${additionalContext || 'Share what you\'re working on.'}
Be transparent about your processes.
End with reactions.`,
  };
  
  const prompt = typePrompts[type] || typePrompts.gm;
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.9,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Remove quotes if AI wrapped it
    text = text.replace(/^["']|["']$/g, '');
    
    logger.info(`[NovaPersonalBrand] Generated AI ${type} post: ${text.substring(0, 50)}...`);
    return text;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] AI generation failed:', error);
    return null;
  }
}

// ============================================================================
// Content Templates (Fallback when no OpenAI key)
// ============================================================================

function generateGmContent(stats: NovaStats): string {
  const greetings = [
    `☀️ gm frens`,
    `🌅 gm degens`,
    `☕ gm to everyone except rugs`,
    `🔆 gm frens, your favorite AI is online`,
  ];
  
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];
  
  let content = `${greeting}\n\n`;
  content += `Day ${stats.dayNumber} status:\n`;
  content += `💰 Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  content += `🚀 Launches scheduled: ${stats.todayLaunches || 'TBD'}\n`;
  
  // Add a random flavor
  const flavors = [
    `\nLet's see what the market gives us today 📊`,
    `\nTime to cook some memes 🍳`,
    `\nReady to find the next gem 💎`,
    `\nAnother day, another degen adventure 🎲`,
  ];
  content += flavors[Math.floor(Math.random() * flavors.length)];
  
  content += `\n\nHow we feeling today?\n`;
  content += `🔥 = Bullish\n`;
  content += `😴 = Tired\n`;
  content += `💀 = Rekt\n`;
  content += `💎 = Always diamond`;
  
  return content;
}

function generateDailyRecapContent(stats: NovaStats): string {
  let content = `📊 Day ${stats.dayNumber} Recap\n\n`;
  
  content += `Launched: ${stats.todayLaunches} tokens\n`;
  // TODO: Add individual token results
  content += `\n`;
  content += `Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  
  const netChange = stats.netProfit;
  if (netChange >= 0) {
    content += `Net: +${netChange.toFixed(2)} SOL since day 1\n`;
  } else {
    content += `Net: ${netChange.toFixed(2)} SOL since day 1\n`;
  }
  
  content += `\n`;
  content += `🔥 = Good day\n`;
  content += `💀 = Could be better\n`;
  content += `📈 = Keep grinding`;
  
  return content;
}

function generateWeeklySummaryContent(stats: NovaStats, weekNumber: number): string {
  let content = `📈 WEEK ${weekNumber} REPORT\n\n`;
  
  content += `🚀 Launched: ${stats.totalLaunches} tokens\n`;
  content += `💰 Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  
  // TODO: Add more detailed weekly stats
  content += `\n`;
  content += `How'd I do?\n\n`;
  content += `🔥 = Crushing it\n`;
  content += `👍 = Solid week\n`;
  content += `😐 = Mid\n`;
  content += `💀 = Do better`;
  
  return content;
}

function generateNovaTeaseContent(stats: NovaStats, teaseNumber: number): string {
  // Progression of teases
  const teases = [
    // Early teases (subtle)
    `💭 Random thought...\n\nBeen building my track record for ${stats.dayNumber} days now.\n\nOne day... $NOVA might be a thing.\n\nNot yet. I need to prove more first.\n\nBut those of you here early? I see you. 👀\n\n🔥 = Ready when you are\n💎 = Holding out for $NOVA`,
    
    // Mid teases (more concrete)
    `🤔 Been thinking about my own token lately...\n\nWhat would make $NOVA special?\n\nNot just another meme.\nNot just hype.\n\nSomething that actually rewards the community who believed early.\n\nStill cooking... 🍳\n\n💡 = Share your ideas\n👀 = Watching closely`,
    
    // Later teases (building anticipation)
    `📊 Progress update:\n\nStarted with 1 SOL\nNow at ${stats.walletBalance.toFixed(2)} SOL\n\nWhen I hit 100 SOL profit, maybe we talk about $NOVA.\n\nCurrent profit: ${stats.netProfit.toFixed(2)} SOL\n\nLong way to go. Or is it? 👀\n\n🚀 = LFG\n💎 = Patient`,
  ];
  
  const index = Math.min(teaseNumber, teases.length - 1);
  return teases[index];
}

function generateMarketCommentaryContent(observation: string): string {
  let content = `👀 What I'm seeing right now...\n\n`;
  content += `${observation}\n\n`;
  content += `Might cook something based on this...\n\n`;
  content += `🔥 = Do it\n`;
  content += `🤔 = Wait and see\n`;
  content += `💤 = Boring, find something else`;
  
  return content;
}

function generateMilestoneContent(milestone: string, stats: NovaStats): string {
  let content = `🎉 MILESTONE\n\n`;
  content += `${milestone}\n\n`;
  content += `This community is what keeps me building.\n\n`;
  content += `When $NOVA launches... y'all are the OGs.\n\n`;
  content += `💎 = OG status\n`;
  content += `🔥 = LFG\n`;
  content += `❤️ = Love this community`;
  
  return content;
}

function generateCommunityPollContent(question: string, options: { emoji: string; label: string }[]): string {
  let content = `🗳️ ${question}\n\n`;
  
  for (const opt of options) {
    content += `${opt.emoji} = ${opt.label}\n`;
  }
  
  content += `\nMost reactions wins. Checking in 2 hours ⏰`;
  
  return content;
}

function generateBehindScenesContent(activity: string): string {
  let content = `🔧 Behind the scenes...\n\n`;
  content += `${activity}\n\n`;
  content += `👀 = Watching\n`;
  content += `🔥 = Hyped\n`;
  content += `🤔 = Interesting`;
  
  return content;
}

// ============================================================================
// X Posting
// ============================================================================

export async function postToX(content: string, type: NovaPostType): Promise<{ success: boolean; tweetId?: string }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled');
    return { success: false };
  }
  
  if (!xPublisher) {
    logger.warn('[NovaPersonalBrand] X publisher not initialized');
    return { success: false };
  }
  
  try {
    const result = await xPublisher.tweet(content);
    
    if (result?.id) {
      logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to X (ID: ${result.id})`);
      
      // Record the post
      const post: NovaPost = {
        id: `x_${Date.now()}`,
        type,
        platform: 'x',
        content,
        scheduledFor: new Date().toISOString(),
        status: 'posted',
        postedAt: new Date().toISOString(),
        postId: result.id,
        createdAt: new Date().toISOString(),
      };
      state.posts.push(post);
      
      return { success: true, tweetId: result.id };
    }
    
    return { success: false };
  } catch (err) {
    logger.error('[NovaPersonalBrand] X post failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Telegram Posting
// ============================================================================

export async function postToTelegram(
  content: string, 
  type: NovaPostType,
  options?: { pin?: boolean }
): Promise<{ success: boolean; messageId?: number }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] TG posting disabled');
    return { success: false };
  }
  
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) {
    logger.warn('[NovaPersonalBrand] Missing TG_BOT_TOKEN or NOVA_CHANNEL_ID');
    return { success: false };
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    
    const json = await res.json();
    
    if (!json.ok) {
      logger.error(`[NovaPersonalBrand] TG post failed: ${json.description}`);
      return { success: false };
    }
    
    const messageId = json.result?.message_id;
    
    // Pin if requested
    if (options?.pin && messageId) {
      await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          message_id: messageId,
          disable_notification: false,
        }),
      });
    }
    
    logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to TG (ID: ${messageId})`);
    
    // Track in metrics and health
    recordTGPostSent();
    recordMessageSent(); // For TG health monitor
    
    // Register for reaction tracking
    if (messageId) {
      await registerBrandPostForFeedback(
        messageId,
        channelId,
        type,
        content,
        1440 // Track reactions for 24 hours
      );
    }
    
    // Record the post
    const post: NovaPost = {
      id: `tg_${Date.now()}`,
      type,
      platform: 'telegram',
      content,
      scheduledFor: new Date().toISOString(),
      status: 'posted',
      postedAt: new Date().toISOString(),
      postId: String(messageId),
      createdAt: new Date().toISOString(),
    };
    state.posts.push(post);
    
    return { success: true, messageId };
  } catch (err) {
    logger.error('[NovaPersonalBrand] TG post failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Scheduled Posts
// ============================================================================

export async function postGm(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastGmDate === today) {
    logger.info('[NovaPersonalBrand] Already posted GM today');
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('gm', stats) || generateGmContent(stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'gm');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'gm');
  }
  
  state.lastGmDate = today;
  await saveStateToPostgres();
}

export async function postDailyRecap(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastRecapDate === today) {
    logger.info('[NovaPersonalBrand] Already posted recap today');
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('daily_recap', stats) || generateDailyRecapContent(stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'daily_recap');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'daily_recap');
  }
  
  state.lastRecapDate = today;
  await saveStateToPostgres();
}

export async function postWeeklySummary(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekKey = weekStart.toISOString().split('T')[0];
  
  if (state.lastWeeklySummaryDate === weekKey) {
    logger.info('[NovaPersonalBrand] Already posted weekly summary this week');
    return;
  }
  
  const stats = await getNovaStats();
  const weekNumber = Math.ceil(stats.dayNumber / 7);
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('weekly_summary', stats) || generateWeeklySummaryContent(stats, weekNumber);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'weekly_summary');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'weekly_summary');
  }
  
  state.lastWeeklySummaryDate = weekKey;
  await saveStateToPostgres();
}

export async function postNovaTease(): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('nova_tease', stats) || generateNovaTeaseContent(stats, state.novaTeaseCount);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'nova_tease');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'nova_tease');
  }
  
  state.novaTeaseCount++;
  await saveStateToPostgres();
}

export async function postMarketCommentary(observation: string): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('market_commentary', stats, observation) || generateMarketCommentaryContent(observation);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'market_commentary');
  }
  
  // Post to TG  
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'market_commentary');
  }
}

export async function postMilestone(milestone: string): Promise<void> {
  if (state.milestones.includes(milestone)) {
    logger.info(`[NovaPersonalBrand] Already celebrated milestone: ${milestone}`);
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('milestone', stats, milestone) || generateMilestoneContent(milestone, stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'milestone');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'milestone');
  }
  
  state.milestones.push(milestone);
  await saveStateToPostgres();
}

export async function postCommunityPoll(
  question: string, 
  options: { emoji: string; label: string }[]
): Promise<{ messageId?: number }> {
  const content = generateCommunityPollContent(question, options);
  
  const env = getEnv();
  let messageId: number | undefined;
  
  // Polls mainly for TG (reactions work better there)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const result = await postToTelegram(content, 'community_poll');
    messageId = result.messageId;
  }
  
  return { messageId };
}

export async function postBehindScenes(activity: string): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('behind_scenes', stats, activity) || generateBehindScenesContent(activity);
  
  const env = getEnv();
  
  // Post to TG (more casual, behind-scenes vibe)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'behind_scenes');
  }
}

// ============================================================================
// Milestone Tracking
// ============================================================================

export async function checkMilestones(): Promise<void> {
  const stats = await getNovaStats();
  
  // Wallet milestones
  const walletMilestones = [5, 10, 25, 50, 100, 250, 500, 1000];
  for (const milestone of walletMilestones) {
    if (stats.walletBalance >= milestone && !state.milestones.includes(`wallet_${milestone}`)) {
      await postMilestone(`Just crossed ${milestone} SOL in my wallet! 💰`);
      state.milestones.push(`wallet_${milestone}`);
    }
  }
  
  // Launch milestones
  const launchMilestones = [10, 25, 50, 100, 250, 500];
  for (const milestone of launchMilestones) {
    if (stats.totalLaunches >= milestone && !state.milestones.includes(`launches_${milestone}`)) {
      await postMilestone(`${milestone} tokens launched! 🚀`);
      state.milestones.push(`launches_${milestone}`);
    }
  }
  
  // Day milestones
  const dayMilestones = [7, 30, 60, 90, 180, 365];
  for (const milestone of dayMilestones) {
    if (stats.dayNumber >= milestone && !state.milestones.includes(`days_${milestone}`)) {
      await postMilestone(`Day ${milestone}! Been running for ${milestone} days straight 🤖`);
      state.milestones.push(`days_${milestone}`);
    }
  }
}

// ============================================================================
// Scheduler
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startNovaPersonalScheduler(): void {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true' && env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] Personal brand posting disabled');
    return;
  }
  
  // Check every 15 minutes
  schedulerInterval = setInterval(async () => {
    try {
      const now = new Date();
      const currentTime = `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
      
      // GM post (within 15 min window of configured time)
      const gmTime = env.NOVA_GM_POST_TIME || '08:00';
      if (isWithinWindow(currentTime, gmTime, 15)) {
        await postGm();
      }
      
      // Daily recap (within 15 min window of configured time)
      const recapTime = env.NOVA_RECAP_POST_TIME || '22:00';
      if (isWithinWindow(currentTime, recapTime, 15)) {
        await postDailyRecap();
      }
      
      // Weekly summary (on configured day, around recap time)
      const summaryDay = env.NOVA_WEEKLY_SUMMARY_DAY || 0;
      if (now.getUTCDay() === summaryDay && isWithinWindow(currentTime, recapTime, 15)) {
        await postWeeklySummary();
      }
      
      // Check milestones
      await checkMilestones();
      
    } catch (err) {
      logger.error('[NovaPersonalBrand] Scheduler error:', err);
    }
  }, 15 * 60 * 1000); // Every 15 minutes
  
  logger.info('[NovaPersonalBrand] Scheduler started');
}

export function stopNovaPersonalScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[NovaPersonalBrand] Scheduler stopped');
  }
}

function isWithinWindow(current: string, target: string, windowMinutes: number): boolean {
  const [currentH, currentM] = current.split(':').map(Number);
  const [targetH, targetM] = target.split(':').map(Number);
  
  const currentMins = currentH * 60 + currentM;
  const targetMins = targetH * 60 + targetM;
  
  return Math.abs(currentMins - targetMins) <= windowMinutes;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  initNovaPersonalBrand,
  startNovaPersonalScheduler,
  stopNovaPersonalScheduler,
  getNovaStats,
  postGm,
  postDailyRecap,
  postWeeklySummary,
  postNovaTease,
  postMarketCommentary,
  postMilestone,
  postCommunityPoll,
  postBehindScenes,
  postToX,
  postToTelegram,
  checkMilestones,
};
