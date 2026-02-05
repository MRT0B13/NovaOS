/**
 * Community Voting Service
 * 
 * Allows the community to vote on autonomous token ideas before launch.
 * The agent posts ideas to Nova's channel, community reacts with emojis,
 * and the system tallies votes to decide whether to proceed.
 * 
 * Flow:
 * 1. Agent generates idea → posts to channel with reasoning
 * 2. Community reacts: 👍 = Launch | 👎 = Skip | 🔥 = Love it | 💀 = Terrible
 * 3. After voting window, tally reactions
 * 4. If sentiment positive → proceed with launch
 * 5. Store feedback in memory for learning
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import type { TokenIdea } from './ideaGenerator.ts';
import { pinMessage } from './novaChannel.ts';
import * as fs from 'fs';
import * as path from 'path';
import { 
  PostgresScheduleRepository, 
  type CommunityPreferences as PGCommunityPreferences,
  type IdeaFeedback as PGIdeaFeedback,
  type PendingVote as PGPendingVote
} from '../db/postgresScheduleRepository.ts';

// PostgreSQL support
let pgRepo: PostgresScheduleRepository | null = null;
let usePostgres = false;

// Reaction weights for sentiment calculation
const REACTION_WEIGHTS: Record<string, number> = {
  '👍': 1,      // Positive
  '🔥': 2,      // Strong positive
  '🚀': 2,      // Strong positive
  '💎': 1.5,    // Positive (diamond hands)
  '❤️': 1,      // Positive
  '👎': -1,     // Negative
  '💀': -2,     // Strong negative
  '🗑️': -2,     // Strong negative (trash)
  '😴': -0.5,   // Mild negative (boring)
  '🤔': 0.5,    // Interested (thinking) - slightly positive for feedback
  '💡': 0.5,    // Has ideas - slightly positive
  '❌': -1,     // Skip this
};

// Reaction emojis to prompt users with for voting
export const VOTE_REACTIONS = ['👍', '👎', '🔥', '💀'];

// Reaction emojis for scheduled idea feedback (different from voting)
export const FEEDBACK_REACTIONS = ['🔥', '🤔', '❌', '💡'];

// All trackable reactions for personal brand posts
export const BRAND_REACTIONS = ['🔥', '🤔', '❌', '💡', '🤑', '❤️', '👍', '👎', '🎉', '😂', '🚀'];

export interface PendingVote {
  id: string;
  idea: TokenIdea;
  messageId: number;
  chatId: string;
  postedAt: string;
  votingEndsAt: string;
  agentReasoning: string;
  trendContext?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'no_votes' | 'feedback_collected';
  votes?: VoteTally;
  type?: 'voting' | 'feedback'; // voting = auto-launches, feedback = just collects reactions
}

export interface VoteTally {
  positive: number;
  negative: number;
  total: number;
  sentiment: number; // -1 to 1
  reactions: Record<string, number>;
  voters: number;
}

export interface IdeaFeedback {
  id: string;
  idea: TokenIdea;
  outcome: 'approved' | 'rejected' | 'no_votes' | 'override';
  votes: VoteTally;
  launchedAt?: string;
  feedback?: string;
  learnings?: string[];
}

interface VotingState {
  pendingVotes: Map<string, PendingVote>;
  feedbackHistory: IdeaFeedback[];
  communityPreferences: CommunityPreferences;
}

interface CommunityPreferences {
  approvedThemes: Record<string, number>; // theme -> approval count
  rejectedThemes: Record<string, number>; // theme -> rejection count
  preferredStyles: string[];
  avoidStyles: string[];
  totalVotes: number;
  avgApprovalRate: number;
}

// State
const state: VotingState = {
  pendingVotes: new Map(),
  feedbackHistory: [],
  communityPreferences: {
    approvedThemes: {},
    rejectedThemes: {},
    preferredStyles: [],
    avoidStyles: [],
    totalVotes: 0,
    avgApprovalRate: 0.5,
  },
};

// Persistence
const DATA_FILE = './data/community_voting.json';

function loadStateFromFile(): void {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      state.feedbackHistory = data.feedbackHistory || [];
      state.communityPreferences = data.communityPreferences || state.communityPreferences;
      // Restore pending votes
      if (data.pendingVotes) {
        for (const vote of data.pendingVotes) {
          state.pendingVotes.set(vote.id, vote);
        }
      }
      logger.info(`[CommunityVoting] Loaded ${state.feedbackHistory.length} feedback from file, ${state.pendingVotes.size} pending`);
    }
  } catch (err) {
    logger.warn('[CommunityVoting] Failed to load state from file:', err);
  }
}

function saveStateToFile(): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = {
      feedbackHistory: state.feedbackHistory.slice(-100), // Keep last 100
      communityPreferences: state.communityPreferences,
      pendingVotes: Array.from(state.pendingVotes.values()),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn('[CommunityVoting] Failed to save state:', err);
  }
}

async function loadStateFromPostgres(): Promise<boolean> {
  if (!pgRepo) return false;
  try {
    // Load preferences
    const prefs = await pgRepo.getCommunityPreferences();
    if (prefs) {
      state.communityPreferences = prefs as any;
    }
    
    // Load feedback history
    const feedback = await pgRepo.getIdeaFeedbackHistory(100);
    state.feedbackHistory = feedback as IdeaFeedback[];
    
    // Load pending votes
    const pending = await pgRepo.getPendingVotesList();
    for (const vote of pending) {
      state.pendingVotes.set(vote.id, vote as PendingVote);
    }
    
    logger.info(`[CommunityVoting] Loaded ${state.feedbackHistory.length} feedback from PostgreSQL, ${state.pendingVotes.size} pending`);
    return true;
  } catch (err) {
    logger.warn('[CommunityVoting] Failed to load from PostgreSQL:', err);
    return false;
  }
}

async function saveStateToPostgres(): Promise<void> {
  if (!pgRepo) return;
  try {
    await pgRepo.saveCommunityPreferences(state.communityPreferences as PGCommunityPreferences);
  } catch (err) {
    logger.warn('[CommunityVoting] Failed to save preferences to PostgreSQL:', err);
  }
}

/**
 * Initialize community voting (async for PostgreSQL support)
 */
export async function initCommunityVoting(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      usePostgres = true;
      logger.info('[CommunityVoting] PostgreSQL storage initialized');
      
      // Load from PostgreSQL
      const loaded = await loadStateFromPostgres();
      if (!loaded) {
        // Fall back to file
        loadStateFromFile();
      }
    } catch (err) {
      logger.warn('[CommunityVoting] PostgreSQL init failed:', err);
      pgRepo = null;
      usePostgres = false;
      loadStateFromFile();
    }
  } else {
    loadStateFromFile();
  }
}

function saveState(): void {
  // Always save to file as backup
  saveStateToFile();
  
  // Also save to PostgreSQL if available
  if (usePostgres && pgRepo) {
    saveStateToPostgres().catch((err: Error) => {
      logger.warn(`[CommunityVoting] Failed to sync to PostgreSQL: ${err.message}`);
    });
  }
}

// Initialize synchronously from file on import (for backwards compatibility)
loadStateFromFile();

/**
 * Generate the agent's reasoning for why this idea could work
 */
export async function generateIdeaReasoning(idea: TokenIdea, trendContext?: string): Promise<string> {
  const env = getEnv();
  const apiKey = env.OPENAI_API_KEY;
  
  // Fallback reasoning if no API key
  if (!apiKey) {
    return generateFallbackReasoning(idea, trendContext);
  }
  
  const prompt = `You are Nova, a chaotic but self-aware AI agent that launches meme coins. You just generated this token idea and need to pitch it to your community in a fun, engaging way.

Token: $${idea.ticker} - ${idea.name}
Description: ${idea.description}
${idea.mascot ? `Mascot concept: ${idea.mascot}` : ''}
${trendContext ? `Trending topic inspiration: ${trendContext}` : ''}
Confidence: ${(idea.confidence * 100).toFixed(0)}%

Write a SHORT, punchy pitch (2-4 bullet points) explaining:
1. Why this idea slaps (what makes it good)
2. The vibe/timing (why now)
3. One potential risk you're aware of (shows self-awareness)

Be playful, use emojis, but keep it real. No corporate speak. This is for degens.

Format as bullet points, max 200 characters per point.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 300,
      }),
    });
    
    if (!response.ok) {
      return generateFallbackReasoning(idea, trendContext);
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || generateFallbackReasoning(idea, trendContext);
  } catch {
    return generateFallbackReasoning(idea, trendContext);
  }
}

function generateFallbackReasoning(idea: TokenIdea, trendContext?: string): string {
  const reasons = [
    `🎯 The name "${idea.name}" has meme potential`,
    `📈 Confidence level: ${(idea.confidence * 100).toFixed(0)}%`,
  ];
  
  if (trendContext) {
    reasons.push(`🔥 Riding the ${trendContext} wave`);
  }
  
  if (idea.theme) {
    reasons.push(`🎨 Theme: ${idea.theme}`);
  }
  
  reasons.push(`⚠️ As always, DYOR - I'm an AI, not financial advice`);
  
  return reasons.join('\n');
}

/**
 * Post an idea to the channel for community voting
 */
export async function postIdeaForVoting(
  idea: TokenIdea,
  trendContext?: string,
  options?: { launchType?: 'scheduled' | 'reactive' }
): Promise<PendingVote | null> {
  const env = getEnv();
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) {
    logger.warn('[CommunityVoting] Missing TG_BOT_TOKEN or NOVA_CHANNEL_ID');
    return null;
  }
  
  // Check if voting is enabled
  if (env.COMMUNITY_VOTING_ENABLED !== 'true') {
    logger.info('[CommunityVoting] Community voting disabled');
    return null;
  }
  
  // Generate reasoning
  const reasoning = await generateIdeaReasoning(idea, trendContext);
  
  // Build the message
  const votingMinutes = parseInt(env.COMMUNITY_VOTING_WINDOW_MINUTES || '30', 10);
  const votingEndsAt = new Date(Date.now() + votingMinutes * 60 * 1000);
  
  // Use different title based on launch type
  const isScheduled = options?.launchType === 'scheduled' || (!trendContext && !options?.launchType);
  let message = isScheduled
    ? `💡 <b>Nova's Daily Creation: $${idea.ticker}</b>\n\n`
    : `🔥 <b>Reactive Idea: $${idea.ticker}</b>\n\n`;
  
  message += `<b>${idea.name}</b>\n`;
  message += `${idea.description}\n\n`;
  
  if (idea.mascot) {
    message += `🎨 <i>Mascot concept: ${idea.mascot}</i>\n\n`;
  }
  
  if (trendContext) {
    message += `🌊 <b>Riding the wave:</b> ${trendContext}\n\n`;
  }
  
  message += `<b>Why I think this slaps:</b>\n${reasoning}\n\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `<b>Should we launch this?</b>\n\n`;
  message += `👍 = Yes, send it!\n`;
  message += `👎 = Nah, skip it\n`;
  message += `🔥 = Love it!\n`;
  message += `💀 = Terrible idea\n\n`;
  message += `⏰ <i>Voting ends in ${votingMinutes} minutes</i>`;
  
  try {
    // Send message
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    
    const json = await res.json();
    if (!json.ok) {
      logger.error(`[CommunityVoting] Failed to post: ${json.description}`);
      return null;
    }
    
    const messageId = json.result.message_id;
    
    // Add initial reactions for users to click
    for (const emoji of VOTE_REACTIONS) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channelId,
            message_id: messageId,
            reaction: [{ type: 'emoji', emoji }],
            is_big: false,
          }),
        });
      } catch {
        // Reactions may not be supported in all chat types
      }
    }
    
    // Create pending vote record
    const vote: PendingVote = {
      id: `vote_${Date.now()}_${idea.ticker}`,
      idea,
      messageId,
      chatId: channelId,
      postedAt: new Date().toISOString(),
      votingEndsAt: votingEndsAt.toISOString(),
      agentReasoning: reasoning,
      trendContext,
      status: 'pending',
      type: 'voting', // This is a voting poll - will auto-launch based on results
    };
    
    state.pendingVotes.set(vote.id, vote);
    
    // Save to PostgreSQL if available
    if (usePostgres && pgRepo) {
      await pgRepo.insertPendingVote(vote as PGPendingVote).catch((err: Error) => {
        logger.warn(`[CommunityVoting] Failed to save vote to PostgreSQL: ${err.message}`);
      });
    }
    
    saveState();
    
    // Pin the voting post so community can see it
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          message_id: messageId,
          disable_notification: false, // Notify users about new idea
        }),
      });
      logger.info(`[CommunityVoting] 📌 Pinned voting post for $${idea.ticker}`);
    } catch (pinErr) {
      logger.warn(`[CommunityVoting] Failed to pin voting post:`, pinErr);
    }
    
    logger.info(`[CommunityVoting] Posted idea $${idea.ticker} for voting (messageId: ${messageId})`);
    
    return vote;
  } catch (err) {
    logger.error('[CommunityVoting] Error posting idea:', err);
    return null;
  }
}

/**
 * Post a scheduled idea to the channel for community feedback (NOT voting)
 * This is for Nova to share his creative ideas and get community reactions
 * Unlike voting, this doesn't auto-launch - it's just for engagement
 */
export async function postScheduledIdeaForFeedback(
  idea: TokenIdea,
  reasoning: string
): Promise<PendingVote | null> {
  const env = getEnv();
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  logger.info(`[CommunityVoting] postScheduledIdeaForFeedback called for $${idea.ticker}`);
  logger.info(`[CommunityVoting] Config: TG_BOT_TOKEN=${botToken ? 'SET' : 'MISSING'}, NOVA_CHANNEL_ID=${channelId || 'MISSING'}`);
  
  if (!botToken || !channelId) {
    logger.error(`[CommunityVoting] ❌ Cannot post scheduled idea - Missing TG_BOT_TOKEN (${botToken ? 'set' : 'missing'}) or NOVA_CHANNEL_ID (${channelId || 'missing'})`);
    return null;
  }
  
  // Feedback window - how long to collect reactions before Nova responds
  const feedbackMinutes = parseInt(env.SCHEDULED_IDEA_FEEDBACK_MINUTES || '60', 10);
  const feedbackEndsAt = new Date(Date.now() + feedbackMinutes * 60 * 1000);
  
  // Build Nova's creative idea message with personality
  let message = `🧠 <b>yo frens, I've been cooking something up...</b>\n\n`;
  message += `Meet <b>$${idea.ticker}</b> - ${idea.name}\n\n`;
  message += `${idea.description}\n\n`;
  
  if (idea.mascot) {
    message += `🎨 <i>The vibe: ${idea.mascot}</i>\n\n`;
  }
  
  message += `💭 <b>Why I think this could be fire:</b>\n`;
  message += reasoning || `Been thinking about this concept for a while. The memetics are strong, the narrative is fresh, and I think the community would love it.`;
  message += `\n\n`;
  
  message += `Confidence: ${(idea.confidence * 100).toFixed(0)}%\n\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `<b>What do you think frens?</b>\n\n`;
  message += `🔥 = LFG, I love it!\n`;
  message += `🤔 = Interesting, tell me more\n`;
  message += `❌ = Nah, skip this one\n`;
  message += `💡 = I have suggestions\n\n`;
  message += `<i>Drop your reactions! I'll check back in ${feedbackMinutes} mins and share what I learned 👀</i>`;
  
  try {
    // Send message
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    
    const json = await res.json();
    if (!json.ok) {
      logger.error(`[CommunityVoting] Failed to post scheduled idea: ${json.description}`);
      return null;
    }
    
    const messageId = json.result.message_id;
    
    // Add initial reactions for users to click
    for (const emoji of FEEDBACK_REACTIONS) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channelId,
            message_id: messageId,
            reaction: [{ type: 'emoji', emoji }],
            is_big: false,
          }),
        });
      } catch {
        // Reactions may not be supported in all chat types
      }
    }
    
    // Create feedback tracking record (type = 'feedback', not 'voting')
    const vote: PendingVote = {
      id: `feedback_${Date.now()}_${idea.ticker}`,
      idea,
      messageId,
      chatId: channelId,
      postedAt: new Date().toISOString(),
      votingEndsAt: feedbackEndsAt.toISOString(),
      agentReasoning: reasoning,
      status: 'pending',
      type: 'feedback', // This is feedback only - won't auto-launch
    };
    
    state.pendingVotes.set(vote.id, vote);
    
    // Save to PostgreSQL if available
    if (usePostgres && pgRepo) {
      await pgRepo.insertPendingVote(vote as PGPendingVote).catch((err: Error) => {
        logger.warn(`[CommunityVoting] Failed to save feedback to PostgreSQL: ${err.message}`);
      });
    }
    
    saveState();
    
    // Pin the idea so community can easily find it
    try {
      await pinMessage(messageId, true); // silent pin
      logger.info(`[CommunityVoting] 📌 Pinned scheduled idea to channel`);
    } catch (pinErr) {
      logger.warn(`[CommunityVoting] Failed to pin scheduled idea: ${pinErr}`);
    }
    
    logger.info(`[CommunityVoting] Posted scheduled idea $${idea.ticker} for feedback (messageId: ${messageId})`);
    
    return vote;
  } catch (err) {
    logger.error('[CommunityVoting] Error posting scheduled idea:', err);
    return null;
  }
}

/**
 * Register a personal brand post for reaction tracking
 * This allows us to track reactions on GM posts, recaps, etc.
 */
export async function registerBrandPostForFeedback(
  messageId: number,
  chatId: string,
  postType: string,
  content: string,
  feedbackMinutes: number = 1440 // Default 24h
): Promise<PendingVote | null> {
  const env = getEnv();
  const usePostgres = env.USE_CENTRAL_POSTGRES;
  const feedbackEndsAt = new Date(Date.now() + feedbackMinutes * 60 * 1000);
  
  // Create a dummy "idea" for tracking purposes
  const dummyIdea: TokenIdea = {
    ticker: postType.toUpperCase(),
    name: `Nova ${postType} Post`,
    description: content.substring(0, 100),
    theme: 'nova_brand',
    generatedAt: new Date().toISOString(),
    status: 'pending',
    confidence: 1,
    hooks: [],
    backstory: '',
    source: 'nova_personal_brand',
    reasoning: `Personal brand ${postType} post`,
  };
  
  const vote: PendingVote = {
    id: `brand_${Date.now()}_${postType}`,
    idea: dummyIdea,
    messageId,
    chatId,
    postedAt: new Date().toISOString(),
    votingEndsAt: feedbackEndsAt.toISOString(),
    agentReasoning: `Nova personal brand ${postType} post`,
    status: 'pending',
    type: 'feedback',
  };
  
  state.pendingVotes.set(vote.id, vote);
  
  // Save to PostgreSQL if available
  if (usePostgres && pgRepo) {
    await pgRepo.insertPendingVote(vote as PGPendingVote).catch((err: Error) => {
      logger.warn(`[CommunityVoting] Failed to save brand post to PostgreSQL: ${err.message}`);
    });
  }
  
  saveState();
  
  logger.info(`[CommunityVoting] Registered brand post ${postType} for feedback (messageId: ${messageId})`);
  
  return vote;
}

/**
 * Tally votes on a message
 */
export async function tallyVotes(vote: PendingVote): Promise<VoteTally> {
  const env = getEnv();
  const botToken = env.TG_BOT_TOKEN;
  
  const tally: VoteTally = {
    positive: 0,
    negative: 0,
    total: 0,
    sentiment: 0,
    reactions: {},
    voters: 0,
  };
  
  if (!botToken) return tally;
  
  try {
    // Get message to check reactions
    // Note: Telegram doesn't have a direct API to get reaction counts
    // We'll need to track reactions via updates or use a workaround
    
    // For now, we'll use a simplified approach:
    // Check if the message still exists and has been forwarded/replied to
    // In production, you'd track reactions via webhook updates
    
    // Attempt to get message reactions (if available in newer Telegram API)
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: vote.chatId }),
    });
    
    // For now, return a default tally
    // The actual implementation would track reactions via the webhook
    logger.info(`[CommunityVoting] Tallying votes for $${vote.idea.ticker}`);
    
  } catch (err) {
    logger.error('[CommunityVoting] Error tallying votes:', err);
  }
  
  return tally;
}

/**
 * Process a reaction update from the webhook
 * Handles both message_reaction (groups) and message_reaction_count (channels)
 */
export function processReactionUpdate(update: any): void {
  // Handle channel anonymous reactions (message_reaction_count)
  if (update.message_reaction_count) {
    processChannelReactionCount(update.message_reaction_count);
    return;
  }
  
  // Handle individual user reactions (message_reaction)
  const reaction = update.message_reaction;
  if (!reaction) return;
  
  const messageId = reaction.message_id;
  const chatId = String(reaction.chat?.id);
  
  // Find the pending vote for this message
  for (const vote of state.pendingVotes.values()) {
    if (vote.messageId === messageId && vote.chatId === chatId) {
      // Initialize votes if needed
      if (!vote.votes) {
        vote.votes = {
          positive: 0,
          negative: 0,
          total: 0,
          sentiment: 0,
          reactions: {},
          voters: 0,
        };
      }
      
      // Process new reactions
      const newReactions = reaction.new_reaction || [];
      const oldReactions = reaction.old_reaction || [];
      
      // Remove old reactions
      for (const r of oldReactions) {
        const emoji = r.emoji;
        if (vote.votes.reactions[emoji]) {
          vote.votes.reactions[emoji]--;
          const weight = REACTION_WEIGHTS[emoji] || 0;
          if (weight > 0) vote.votes.positive--;
          if (weight < 0) vote.votes.negative--;
        }
      }
      
      // Add new reactions
      for (const r of newReactions) {
        const emoji = r.emoji;
        vote.votes.reactions[emoji] = (vote.votes.reactions[emoji] || 0) + 1;
        const weight = REACTION_WEIGHTS[emoji] || 0;
        if (weight > 0) vote.votes.positive++;
        if (weight < 0) vote.votes.negative++;
      }
      
      // Recalculate sentiment
      vote.votes.total = vote.votes.positive + vote.votes.negative;
      if (vote.votes.total > 0) {
        let weightedSum = 0;
        for (const [emoji, count] of Object.entries(vote.votes.reactions)) {
          weightedSum += (REACTION_WEIGHTS[emoji] || 0) * count;
        }
        vote.votes.sentiment = Math.max(-1, Math.min(1, weightedSum / (vote.votes.total * 2)));
      }
      
      saveState();
      logger.info(`[CommunityVoting] Updated votes for $${vote.idea.ticker}: +${vote.votes.positive}/-${vote.votes.negative} (sentiment: ${vote.votes.sentiment.toFixed(2)})`);
      
      break;
    }
  }
}

/**
 * Process channel reaction counts (anonymous reactions)
 * This is used for channels where user reactions are aggregated
 */
function processChannelReactionCount(reactionCount: any): void {
  const messageId = reactionCount.message_id;
  const chatId = String(reactionCount.chat?.id);
  
  logger.info(`[CommunityVoting] Processing channel reaction count for message ${messageId} in ${chatId}`);
  
  // Debug: log all pending votes
  logger.info(`[CommunityVoting] Pending votes: ${state.pendingVotes.size} total`);
  for (const [key, v] of state.pendingVotes.entries()) {
    logger.info(`[CommunityVoting]   - ${key}: messageId=${v.messageId}, chatId=${v.chatId}, ticker=${v.idea.ticker}`);
  }
  
  // Find the pending vote for this message
  let found = false;
  for (const vote of state.pendingVotes.values()) {
    if (vote.messageId === messageId && vote.chatId === chatId) {
      found = true;
      logger.info(`[CommunityVoting] ✅ Found matching vote for $${vote.idea.ticker}`);
      
      // Initialize votes if needed
      if (!vote.votes) {
        vote.votes = {
          positive: 0,
          negative: 0,
          total: 0,
          sentiment: 0,
          reactions: {},
          voters: 0,
        };
      }
      
      // Reset and recalculate from the reaction counts
      // reactions is an array of { type: { type: "emoji", emoji: "🔥" }, total_count: 2 }
      const reactions = reactionCount.reactions || [];
      logger.info(`[CommunityVoting] Reactions array: ${JSON.stringify(reactions)}`);
      
      // Clear previous counts
      vote.votes.reactions = {};
      vote.votes.positive = 0;
      vote.votes.negative = 0;
      
      for (const r of reactions) {
        // Telegram nests emoji in type.emoji for message_reaction_count
        const emoji = r.type?.emoji || r.emoji;
        const count = r.total_count || 0;
        
        vote.votes.reactions[emoji] = count;
        const weight = REACTION_WEIGHTS[emoji] || 0;
        if (weight > 0) vote.votes.positive += count;
        if (weight < 0) vote.votes.negative += count;
      }
      
      // Recalculate total and sentiment
      vote.votes.total = vote.votes.positive + vote.votes.negative;
      if (vote.votes.total > 0) {
        let weightedSum = 0;
        for (const [emoji, count] of Object.entries(vote.votes.reactions)) {
          weightedSum += (REACTION_WEIGHTS[emoji] || 0) * (count as number);
        }
        vote.votes.sentiment = Math.max(-1, Math.min(1, weightedSum / (vote.votes.total * 2)));
      }
      
      saveState();
      logger.info(`[CommunityVoting] 📊 Channel votes for $${vote.idea.ticker}: +${vote.votes.positive}/-${vote.votes.negative} (sentiment: ${vote.votes.sentiment.toFixed(2)})`);
      logger.info(`[CommunityVoting]    Reactions: ${JSON.stringify(vote.votes.reactions)}`);
      
      break;
    }
  }
  
  if (!found) {
    // Debug level since most reactions won't be on tracked posts
    logger.debug(`[CommunityVoting] No pending vote found for message ${messageId} in chat ${chatId}`);
  }
}

/**
 * Check if a pending vote should be resolved
 */
export async function checkPendingVotes(): Promise<PendingVote[]> {
  const env = getEnv();
  const now = new Date();
  const resolved: PendingVote[] = [];
  const minVotes = parseInt(env.COMMUNITY_VOTING_MIN_VOTES || '3', 10);
  const approvalThreshold = parseFloat(env.COMMUNITY_VOTING_APPROVAL_THRESHOLD || '0.4');
  
  for (const vote of state.pendingVotes.values()) {
    if (vote.status !== 'pending') continue;
    
    const endsAt = new Date(vote.votingEndsAt);
    if (now < endsAt) continue;
    
    // Voting window has ended
    const votes = vote.votes || { positive: 0, negative: 0, total: 0, sentiment: 0, reactions: {}, voters: 0 };
    
    // Log detailed vote breakdown
    logger.info(`[CommunityVoting] 🗳️ Vote ended for $${vote.idea.ticker}:`);
    logger.info(`[CommunityVoting]    Reactions: ${JSON.stringify(votes.reactions)}`);
    logger.info(`[CommunityVoting]    +${votes.positive}/-${votes.negative} = ${votes.total} total (min: ${minVotes})`);
    logger.info(`[CommunityVoting]    Sentiment: ${votes.sentiment.toFixed(2)} (threshold: ${approvalThreshold})`);
    
    // Handle feedback type differently - just collect reactions, no auto-launch
    if (vote.type === 'feedback') {
      vote.status = 'feedback_collected';
      logger.info(`[CommunityVoting] 📊 Feedback collected for $${vote.idea.ticker}`);
      
      // Post a follow-up message thanking the community and sharing insights
      await postFeedbackResponse(vote, votes);
      
      // Record for learning but don't trigger launch
      recordFeedback(vote).catch(err => {
        logger.warn('[CommunityVoting] Failed to record feedback:', err);
      });
      resolved.push(vote);
      continue;
    }
    
    // Handle voting type - determine if we should launch
    if (votes.total < minVotes) {
      // Not enough votes - default to launch (apathy ≠ rejection)
      vote.status = 'no_votes';
      logger.info(`[CommunityVoting] $${vote.idea.ticker}: No votes (${votes.total}/${minVotes} min) - defaulting to approve`);
    } else if (votes.sentiment >= approvalThreshold) {
      // Approved
      vote.status = 'approved';
      logger.info(`[CommunityVoting] $${vote.idea.ticker}: APPROVED (sentiment: ${votes.sentiment.toFixed(2)})`);
    } else {
      // Rejected
      vote.status = 'rejected';
      logger.info(`[CommunityVoting] $${vote.idea.ticker}: REJECTED (sentiment: ${votes.sentiment.toFixed(2)})`);
    }
    
    // Record feedback (async but don't block)
    recordFeedback(vote).catch(err => {
      logger.warn('[CommunityVoting] Failed to record feedback:', err);
    });
    resolved.push(vote);
  }
  
  // Clean up resolved votes
  for (const vote of resolved) {
    state.pendingVotes.delete(vote.id);
    
    // Remove from PostgreSQL
    if (usePostgres && pgRepo) {
      pgRepo.deletePendingVote(vote.id).catch((err: Error) => {
        logger.warn(`[CommunityVoting] Failed to delete vote from PostgreSQL: ${err.message}`);
      });
    }
  }
  
  if (resolved.length > 0) {
    saveState();
  }
  
  return resolved;
}

/**
 * Post a follow-up response after collecting feedback on a scheduled idea
 * Nova thanks the community and shares what he learned from their reactions
 */
async function postFeedbackResponse(vote: PendingVote, votes: VoteTally): Promise<void> {
  const env = getEnv();
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) return;
  
  const ticker = vote.idea.ticker;
  const totalReactions = Object.values(votes.reactions).reduce((a, b) => a + (b as number), 0);
  
  // Build response based on sentiment
  let message = `📊 <b>Thanks for the feedback on $${ticker} frens!</b>\n\n`;
  
  if (totalReactions === 0) {
    message += `Looks like y'all are busy today - no reactions came in. That's cool, I'll keep cooking and share more ideas soon! 🍳\n`;
  } else if (votes.sentiment >= 0.5) {
    // Very positive
    const fireCount = votes.reactions['🔥'] || 0;
    message += `Y'all are hyped! 🔥 Got ${fireCount > 0 ? fireCount + ' fire reactions' : 'lots of love'} on this one.\n\n`;
    message += `I hear you - this concept resonates. Taking notes for future launches! 📝\n`;
  } else if (votes.sentiment >= 0) {
    // Mildly positive or neutral
    const thinkingCount = votes.reactions['🤔'] || 0;
    message += `Mixed signals on this one - ${thinkingCount > 0 ? 'some of you want to know more' : 'interesting reactions'}.\n\n`;
    message += `I appreciate the honest feedback! This helps me understand what hits different. 🎯\n`;
  } else {
    // Negative
    const skipCount = votes.reactions['❌'] || 0;
    message += `Got the message - ${skipCount > 0 ? `${skipCount} of you said skip this` : 'not the vibe y\'all wanted'}.\n\n`;
    message += `No cap, I learn from the misses too. Back to the drawing board! 💪\n`;
  }
  
  // Show reaction breakdown
  if (totalReactions > 0) {
    message += `\n<b>Reactions:</b> `;
    const parts: string[] = [];
    for (const [emoji, count] of Object.entries(votes.reactions)) {
      if ((count as number) > 0) parts.push(`${emoji} ${count}`);
    }
    message += parts.join(' | ') + '\n';
  }
  
  message += `\n<i>Keep the reactions coming on my ideas - your input shapes what I create next! 🤝</i>`;
  
  try {
    // Reply to the original message
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: 'HTML',
        reply_to_message_id: vote.messageId,
      }),
    });
    
    logger.info(`[CommunityVoting] ✅ Posted feedback response for $${ticker}`);
  } catch (err) {
    logger.error('[CommunityVoting] Error posting feedback response:', err);
  }
}

/**
 * Record feedback for learning
 */
async function recordFeedback(vote: PendingVote): Promise<void> {
  const feedback: IdeaFeedback = {
    id: vote.id,
    idea: vote.idea,
    outcome: vote.status === 'approved' || vote.status === 'no_votes' ? 'approved' : 'rejected',
    votes: vote.votes || { positive: 0, negative: 0, total: 0, sentiment: 0, reactions: {}, voters: 0 },
  };
  
  state.feedbackHistory.push(feedback);
  
  // Save to PostgreSQL if available
  if (usePostgres && pgRepo) {
    await pgRepo.insertIdeaFeedback(feedback as PGIdeaFeedback).catch((err: Error) => {
      logger.warn(`[CommunityVoting] Failed to save feedback to PostgreSQL: ${err.message}`);
    });
  }
  
  // Update community preferences
  const theme = vote.idea.theme || 'general';
  if (feedback.outcome === 'approved') {
    state.communityPreferences.approvedThemes[theme] = 
      (state.communityPreferences.approvedThemes[theme] || 0) + 1;
  } else {
    state.communityPreferences.rejectedThemes[theme] = 
      (state.communityPreferences.rejectedThemes[theme] || 0) + 1;
  }
  
  // Update approval rate
  const approvedCount = state.feedbackHistory.filter(f => f.outcome === 'approved').length;
  state.communityPreferences.totalVotes = state.feedbackHistory.length;
  state.communityPreferences.avgApprovalRate = approvedCount / state.feedbackHistory.length;
  
  // Identify preferred/avoid styles
  updateStylePreferences();
  
  saveState();
}

/**
 * Update style preferences based on feedback history
 */
function updateStylePreferences(): void {
  const themeScores: Record<string, { approved: number; rejected: number }> = {};
  
  for (const feedback of state.feedbackHistory) {
    const theme = feedback.idea.theme || 'general';
    if (!themeScores[theme]) {
      themeScores[theme] = { approved: 0, rejected: 0 };
    }
    if (feedback.outcome === 'approved') {
      themeScores[theme].approved++;
    } else {
      themeScores[theme].rejected++;
    }
  }
  
  const preferred: string[] = [];
  const avoid: string[] = [];
  
  for (const [theme, scores] of Object.entries(themeScores)) {
    const total = scores.approved + scores.rejected;
    if (total < 3) continue; // Need at least 3 data points
    
    const rate = scores.approved / total;
    if (rate >= 0.7) preferred.push(theme);
    if (rate <= 0.3) avoid.push(theme);
  }
  
  state.communityPreferences.preferredStyles = preferred;
  state.communityPreferences.avoidStyles = avoid;
}

/**
 * Get community preferences for idea generation
 */
export function getCommunityPreferences(): CommunityPreferences {
  return { ...state.communityPreferences };
}

/**
 * Get feedback summary for a theme
 */
export function getThemeFeedback(theme: string): { approved: number; rejected: number; rate: number } {
  const approved = state.communityPreferences.approvedThemes[theme] || 0;
  const rejected = state.communityPreferences.rejectedThemes[theme] || 0;
  const total = approved + rejected;
  return {
    approved,
    rejected,
    rate: total > 0 ? approved / total : 0.5,
  };
}

/**
 * Get a summary of what the community prefers
 */
export function getCommunityInsights(): string {
  const prefs = state.communityPreferences;
  
  let insights = '📊 **Community Voting Insights**\n\n';
  insights += `Total votes: ${prefs.totalVotes}\n`;
  insights += `Approval rate: ${(prefs.avgApprovalRate * 100).toFixed(0)}%\n\n`;
  
  if (prefs.preferredStyles.length > 0) {
    insights += `✅ **Preferred themes:** ${prefs.preferredStyles.join(', ')}\n`;
  }
  
  if (prefs.avoidStyles.length > 0) {
    insights += `❌ **Avoid themes:** ${prefs.avoidStyles.join(', ')}\n`;
  }
  
  // Top approved themes
  const topApproved = Object.entries(prefs.approvedThemes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  
  if (topApproved.length > 0) {
    insights += `\n🏆 **Top approved:** ${topApproved.map(([t, c]) => `${t} (${c})`).join(', ')}\n`;
  }
  
  return insights;
}

/**
 * Announce vote result to channel
 */
export async function announceVoteResult(vote: PendingVote): Promise<boolean> {
  const env = getEnv();
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) return false;
  
  const votes = vote.votes || { positive: 0, negative: 0, total: 0, sentiment: 0, reactions: {}, voters: 0 };
  
  let message = '';
  
  if (vote.status === 'approved') {
    message = `✅ <b>$${vote.idea.ticker} APPROVED!</b>\n\n`;
    message += `The community has spoken! Launching ${vote.idea.name}...\n\n`;
    message += `Votes: 👍 ${votes.positive} | 👎 ${votes.negative}\n`;
    message += `Sentiment: ${(votes.sentiment * 100).toFixed(0)}% positive`;
  } else if (vote.status === 'rejected') {
    message = `❌ <b>$${vote.idea.ticker} REJECTED</b>\n\n`;
    message += `The community said no to ${vote.idea.name}.\n`;
    message += `I'll learn from this and come back with better ideas! 🧠\n\n`;
    message += `Votes: 👍 ${votes.positive} | 👎 ${votes.negative}\n`;
    message += `Sentiment: ${(votes.sentiment * 100).toFixed(0)}%`;
  } else if (vote.status === 'no_votes') {
    message = `🤷 <b>$${vote.idea.ticker} - No Votes</b>\n\n`;
    message += `Not enough votes received. Proceeding with launch since silence = consent in degen land! 🚀`;
  }
  
  try {
    // Reply to original message
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: 'HTML',
        reply_to_message_id: vote.messageId,
      }),
    });
    
    const json = await res.json();
    return json.ok;
  } catch (err) {
    logger.error('[CommunityVoting] Error announcing result:', err);
    return false;
  }
}

/**
 * Check if an idea should skip voting (high confidence or preferred theme)
 */
export function shouldSkipVoting(idea: TokenIdea): { skip: boolean; reason?: string } {
  const env = getEnv();
  
  // If voting is disabled, skip
  if (env.COMMUNITY_VOTING_ENABLED !== 'true') {
    return { skip: true, reason: 'Voting disabled' };
  }
  
  // High confidence ideas can skip voting
  const confidenceThreshold = parseFloat(env.COMMUNITY_VOTING_CONFIDENCE_SKIP || '0.95');
  if (idea.confidence >= confidenceThreshold) {
    return { skip: true, reason: `High confidence (${(idea.confidence * 100).toFixed(0)}%)` };
  }
  
  // Preferred themes can skip
  if (idea.theme && state.communityPreferences.preferredStyles.includes(idea.theme)) {
    const feedback = getThemeFeedback(idea.theme);
    if (feedback.rate >= 0.8) {
      return { skip: true, reason: `Community-preferred theme: ${idea.theme}` };
    }
  }
  
  return { skip: false };
}

/**
 * Get pending votes for monitoring
 */
export function getPendingVotes(): PendingVote[] {
  return Array.from(state.pendingVotes.values());
}

/**
 * Get recent feedback history
 */
export function getRecentFeedback(limit: number = 10): IdeaFeedback[] {
  return state.feedbackHistory.slice(-limit);
}

export default {
  postIdeaForVoting,
  postScheduledIdeaForFeedback,
  registerBrandPostForFeedback,
  processReactionUpdate,
  checkPendingVotes,
  announceVoteResult,
  shouldSkipVoting,
  getCommunityPreferences,
  getCommunityInsights,
  getPendingVotes,
  getRecentFeedback,
  VOTE_REACTIONS,
  FEEDBACK_REACTIONS,
  BRAND_REACTIONS,
};
