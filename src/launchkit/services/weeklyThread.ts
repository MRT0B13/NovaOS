import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { XPublisherService } from './xPublisher.ts';
import { getFeesSummary, formatFeesForTweet } from './pumpswapFees.ts';

/**
 * Weekly Thread Generator
 * 
 * Every Sunday, posts a 4-tweet thread summarizing the week:
 * 1. Hook (key stat)
 * 2. P&L breakdown
 * 3. Safety report (RugCheck data)
 * 4. CTA (what's next)
 */

interface WeeklyStats {
  launchCount: number;
  totalTweets: number;
  totalTgPosts: number;
  walletBalance: number;
  startBalance: number;
  graduatedCount: number;
  rugcheckScans: number;
  avgRugcheckScore: number;
  totalReplies: number;
  feesEarned: number;
}

/**
 * Generate and post the weekly recap thread
 */
export async function postWeeklyThread(stats: WeeklyStats): Promise<string[] | null> {
  const env = getEnv();
  
  if (env.X_ENABLE !== 'true') {
    logger.info('[WeeklyThread] X disabled, skipping');
    return null;
  }
  
  const openaiKey = env.OPENAI_API_KEY;
  if (!openaiKey) {
    logger.warn('[WeeklyThread] No OpenAI key for thread generation');
    return null;
  }
  
  try {
    // Generate the 4-tweet thread via LLM
    const threadTexts = await generateThreadContent(stats, openaiKey);
    if (!threadTexts || threadTexts.length === 0) return null;
    
    // Post as thread
    const xPublisher = new XPublisherService({} as any);
    const tweetIds: string[] = [];
    let previousId: string | undefined;
    
    for (const text of threadTexts) {
      try {
        if (previousId) {
          const result = await xPublisher.reply(text, previousId);
          tweetIds.push(result.id);
          previousId = result.id;
        } else {
          const result = await xPublisher.tweet(text);
          tweetIds.push(result.id);
          previousId = result.id;
        }
        
        // Small delay between thread tweets
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.warn(`[WeeklyThread] Thread tweet failed: ${(err as Error).message}`);
        break;
      }
    }
    
    if (tweetIds.length > 0) {
      logger.info(`[WeeklyThread] ✅ Posted ${tweetIds.length}-tweet weekly thread`);
    }
    
    return tweetIds;
  } catch (err) {
    logger.error('[WeeklyThread] Failed:', err);
    return null;
  }
}

async function generateThreadContent(stats: WeeklyStats, apiKey: string): Promise<string[]> {
  const pnl = stats.walletBalance - stats.startBalance;
  const pnlPct = stats.startBalance > 0 ? ((pnl / stats.startBalance) * 100).toFixed(1) : '0';
  const feesSummary = getFeesSummary();
  
  const systemPrompt = `You are Nova, an autonomous AI agent that launches meme tokens on Solana.
You're writing a weekly recap thread (4 tweets). Rules:
- DATA FIRST. Every tweet has at least one specific number.
- BLUNT HONESTY. Own the losses, celebrate wins with specifics.
- SHORT AND PUNCHY. Each tweet under 250 chars.
- NO "fam", "frens", "vibes", "let's gooo", "what a journey"
- Max 1 emoji per tweet

Format: Return exactly 4 tweets separated by ---
Tweet 1: Hook — the most interesting stat from the week
Tweet 2: P&L breakdown — wallet balance, gains/losses, launch count
Tweet 3: Safety report — RugCheck scans, mint/freeze revocations, security data
Tweet 4: CTA — what's next, link to TG for voting`;

  const userPrompt = `Weekly stats:
- Launches: ${stats.launchCount}
- Graduated: ${stats.graduatedCount}
- Wallet: ${stats.walletBalance.toFixed(4)} SOL (started at ${stats.startBalance.toFixed(4)} SOL)
- P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPct}%)
- Tweets: ${stats.totalTweets}
- TG posts: ${stats.totalTgPosts}
- RugCheck scans: ${stats.rugcheckScans} (avg score: ${stats.avgRugcheckScore})
- Replies sent: ${stats.totalReplies}
- Creator fees earned: ${stats.feesEarned.toFixed(4)} SOL

Write the 4-tweet thread:`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 600,
    }),
  });

  if (!res.ok) {
    logger.warn(`[WeeklyThread] OpenAI returned ${res.status}`);
    return [];
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return [];

  // Parse 4 tweets separated by ---
  const tweets = content.split('---').map((t: string) => t.trim()).filter((t: string) => t.length > 0);
  
  // Enforce 280 char limit
  return tweets.slice(0, 4).map((t: string) => t.length > 280 ? t.substring(0, 277) + '...' : t);
}

/**
 * Check if it's time for the weekly thread (Sunday 18:00 UTC)
 */
export function isWeeklyThreadTime(): boolean {
  const now = new Date();
  return now.getUTCDay() === 0 && now.getUTCHours() === 18;
}

export default {
  postWeeklyThread,
  isWeeklyThreadTime,
};
