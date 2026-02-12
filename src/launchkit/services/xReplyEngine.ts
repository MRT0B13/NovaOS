import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getTwitterReader, XPublisherService } from './xPublisher.ts';
import { canWrite, canRead, recordRead, getPostingAdvice, getQuota, isPayPerUseReads } from './xRateLimiter.ts';
import { scanToken, formatReportForTweet } from './rugcheck.ts';

/**
 * X Reply Engine
 * 
 * Searches for relevant tweets from target accounts and ecosystem keywords,
 * generates substantive data-backed replies, and posts them throughout the day.
 * 
 * Reads: If X_READ_BUDGET_USD is set, uses pay-per-use at $0.005/read (no hard cap).
 * Otherwise falls back to X_MONTHLY_READ_LIMIT hard cap (default 100).
 * Always checks canRead() before API calls and recordRead() after.
 * 
 * Strategy: Search → Filter → Generate reply → Post → Track → Cooldown
 */

// ============================================================================
// Configuration
// ============================================================================

interface ReplyCandidate {
  tweetId: string;
  text: string;
  authorId?: string;
  authorHandle?: string;
  createdAt?: string;
  source: 'search' | 'mention' | 'target';
  query?: string;
}

interface TrackedReply {
  tweetId: string;
  replyId: string;
  text: string;
  repliedAt: string;
  source: string;
}

// In-memory tracking (persists within session)
const state = {
  repliesToday: 0,
  lastReplyAt: 0,
  repliedTweetIds: new Set<string>(),
  trackedReplies: [] as TrackedReply[],
  lastResetDate: '',
  running: false,
  intervalHandle: null as ReturnType<typeof setInterval> | null,
  roundCount: 0, // Alternates between mention rounds and search rounds
  rateLimitBackoffUntil: 0, // Timestamp — skip rounds until this time (set on 429)
};

// ============================================================================
// Core Engine
// ============================================================================

/**
 * Start the reply engine scheduler
 */
export function startReplyEngine(): void {
  const env = getEnv();
  
  if (env.X_REPLY_ENGINE_ENABLE !== 'true') {
    logger.info('[ReplyEngine] Disabled (set X_REPLY_ENGINE_ENABLE=true to enable)');
    return;
  }
  
  if (env.X_ENABLE !== 'true') {
    logger.info('[ReplyEngine] X publishing disabled — reply engine skipped');
    return;
  }
  
  if (state.running) {
    logger.warn('[ReplyEngine] Already running');
    return;
  }
  
  const intervalMs = (env.X_REPLY_INTERVAL_MINUTES || 60) * 60 * 1000;
  
  state.running = true;
  logger.info(`[ReplyEngine] Started (max ${env.X_REPLY_MAX_PER_DAY}/day, every ${env.X_REPLY_INTERVAL_MINUTES || 60}m)`);
  
  // Run immediately, then on interval
  runReplyRound().catch(err => logger.error('[ReplyEngine] Initial round failed:', err));
  
  state.intervalHandle = setInterval(() => {
    runReplyRound().catch(err => logger.error('[ReplyEngine] Round failed:', err));
  }, intervalMs);
}

/**
 * Stop the reply engine
 */
export function stopReplyEngine(): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  state.running = false;
  logger.info('[ReplyEngine] Stopped');
}

/**
 * Get reply engine status
 */
export function getReplyEngineStatus() {
  return {
    running: state.running,
    repliesToday: state.repliesToday,
    lastReplyAt: state.lastReplyAt ? new Date(state.lastReplyAt).toISOString() : null,
    trackedCount: state.trackedReplies.length,
  };
}

/**
 * Single round of the reply engine:
 * 1. Check if we can still reply today
 * 2. Search for candidates
 * 3. Pick best candidate
 * 4. Generate reply
 * 5. Post reply
 */
async function runReplyRound(): Promise<void> {
  const env = getEnv();
  
  // Reset daily counter
  const today = new Date().toISOString().split('T')[0];
  if (state.lastResetDate !== today) {
    state.repliesToday = 0;
    state.lastResetDate = today;
    // Keep replied IDs for dedup but trim old ones
    if (state.repliedTweetIds.size > 1000) {
      state.repliedTweetIds.clear();
    }
  }
  
  // Check daily limit
  const maxPerDay = env.X_REPLY_MAX_PER_DAY || 50;
  if (state.repliesToday >= maxPerDay) {
    logger.debug(`[ReplyEngine] Daily limit reached (${state.repliesToday}/${maxPerDay})`);
    return;
  }
  
  // Check 429 backoff — if Twitter told us to chill, respect it
  if (state.rateLimitBackoffUntil > Date.now()) {
    const remainMin = Math.ceil((state.rateLimitBackoffUntil - Date.now()) / 60000);
    logger.debug(`[ReplyEngine] Rate-limit backoff active — ${remainMin}m remaining`);
    return;
  }

  // Check rate limit
  const advice = getPostingAdvice();
  if (!advice.canPost) {
    logger.debug(`[ReplyEngine] Write rate limited: ${advice.reason}`);
    return;
  }
  
  // Check read quota
  const quota = getQuota();
  if (!canRead()) {
    logger.warn(`[ReplyEngine] Read budget exhausted (${quota.reads.used} reads used). Pausing until next month.`);
    return;
  }
  
  // If NOT on pay-per-use and reads are getting low, conserve
  if (!isPayPerUseReads() && quota.reads.remaining <= 20) {
    if (state.roundCount % 4 !== 0) {
      logger.debug(`[ReplyEngine] Conserving reads (${quota.reads.remaining} left) — skipping this round`);
      state.roundCount++;
      return;
    }
  }
  
  // Check cooldown
  const cooldownMs = (env.X_REPLY_INTERVAL_MINUTES || 60) * 60 * 1000;
  if (Date.now() - state.lastReplyAt < cooldownMs * 0.8) {
    return; // Too soon since last reply
  }
  
  const reader = getTwitterReader();
  if (!reader.isReady()) {
    logger.warn('[ReplyEngine] Twitter client not ready');
    return;
  }
  
  // Find candidates
  const candidates = await findCandidates(reader);
  if (candidates.length === 0) {
    logger.debug('[ReplyEngine] No candidates found this round');
    return;
  }
  
  // Pick best candidate (prioritize mentions, then targets, then search)
  const candidate = pickBestCandidate(candidates);
  if (!candidate) return;
  
  // Generate a reply
  const replyText = await generateReply(candidate);
  if (!replyText) return;
  
  // Post the reply
  try {
    // XPublisherService needs a store but we only use reply() which doesn't need it
    const xPublisher = new XPublisherService({} as any);
    
    const result = await xPublisher.reply(replyText, candidate.tweetId);
    
    state.repliesToday++;
    state.lastReplyAt = Date.now();
    state.repliedTweetIds.add(candidate.tweetId);
    state.trackedReplies.push({
      tweetId: candidate.tweetId,
      replyId: result.id,
      text: replyText,
      repliedAt: new Date().toISOString(),
      source: candidate.source,
    });
    
    // Keep tracked replies trimmed
    if (state.trackedReplies.length > 200) {
      state.trackedReplies = state.trackedReplies.slice(-100);
    }
    
    // Increment round counter
    state.roundCount++;
    
    logger.info(`[ReplyEngine] Reply #${state.repliesToday} posted (${candidate.source}: ${candidate.tweetId.slice(0, 8)})`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    const code = err?.code || '';

    if (code === 'X_RATE_LIMIT' || msg.includes('429') || msg.includes('rate limit')) {
      // Back off for 15 minutes on 429
      const backoffMs = 15 * 60 * 1000;
      state.rateLimitBackoffUntil = Date.now() + backoffMs;
      logger.warn(`[ReplyEngine] Twitter 429 rate limit — backing off for 15 minutes`);
    } else {
      logger.warn(`[ReplyEngine] Failed to post reply: ${msg}`);
    }
  }
}

// ============================================================================
// Candidate Discovery
// ============================================================================

/**
 * Find reply candidates.
 * - Pay-per-use mode: uses 2 reads/round (mentions + search) for better coverage.
 * - Hard-cap mode: uses 1 read/round, alternating mentions ↔ search.
 */
async function findCandidates(reader: ReturnType<typeof getTwitterReader>): Promise<ReplyCandidate[]> {
  const env = getEnv();
  const candidates: ReplyCandidate[] = [];
  
  const payPerUse = isPayPerUseReads();
  
  // In pay-per-use mode, do both mentions AND search each round for better coverage.
  // In hard-cap mode, alternate: even rounds → mentions, odd rounds → search.
  const doMentions = payPerUse || state.roundCount % 2 === 0;
  const doSearch   = payPerUse || state.roundCount % 2 !== 0;
  
  // Mentions
  if (doMentions && canRead()) {
    try {
      const mentions = await reader.getMentions(10);
      await recordRead();
      for (const m of mentions) {
        if (!state.repliedTweetIds.has(m.id)) {
          candidates.push({
            tweetId: m.id,
            text: m.text,
            authorId: m.authorId,
            createdAt: m.createdAt,
            source: 'mention',
          });
        }
      }
    } catch {
      try { await recordRead(); } catch {}
    }
  }
  
  // Search
  if (doSearch && canRead()) {
    const queries = (env.X_REPLY_SEARCH_QUERIES || '').split(',').map(q => q.trim()).filter(Boolean);
    if (queries.length > 0) {
      const query = queries[Math.floor(Math.random() * queries.length)];
      try {
        const results = await reader.searchTweets(query, 10);
        await recordRead();
        for (const t of results) {
          if (!state.repliedTweetIds.has(t.id)) {
            candidates.push({
              tweetId: t.id,
              text: t.text,
              authorId: t.authorId,
              createdAt: t.createdAt,
              source: 'search',
              query,
            });
          }
        }
      } catch {
        try { await recordRead(); } catch {}
      }
    }
  }
  
  return candidates;
}

function pickBestCandidate(candidates: ReplyCandidate[]): ReplyCandidate | null {
  if (candidates.length === 0) return null;
  
  // Priority: mentions > search
  const mentions = candidates.filter(c => c.source === 'mention');
  if (mentions.length > 0) return mentions[0];
  
  // For search results, pick one at random
  const search = candidates.filter(c => c.source === 'search');
  if (search.length > 0) return search[Math.floor(Math.random() * search.length)];
  
  return candidates[0];
}

// ============================================================================
// Mint Address Extraction & RugCheck
// ============================================================================

/**
 * Extract Solana mint addresses from tweet text.
 * Looks for base58-encoded strings that are 32-44 chars long (typical for Solana addresses).
 */
function extractMintAddresses(text: string): string[] {
  // Solana addresses are base58: 1-9, A-H, J-N, P-Z, a-k, m-z (no 0, O, I, l)
  const base58Regex = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
  const matches: string[] = [];
  let match;
  while ((match = base58Regex.exec(text)) !== null) {
    // Filter out common false positives (URLs, hashtags, etc.)
    const candidate = match[1];
    // Must start/end with alphanumeric and be a plausible Solana address
    if (candidate.length >= 32 && candidate.length <= 44) {
      matches.push(candidate);
    }
  }
  return [...new Set(matches)]; // dedupe
}

/**
 * Try to get RugCheck data for any mint addresses found in a tweet.
 * Returns formatted context string or null.
 */
async function getRugCheckContext(text: string): Promise<string | null> {
  const mints = extractMintAddresses(text);
  if (mints.length === 0) return null;
  
  // Only scan the first mint found (avoid excessive API calls)
  const mint = mints[0];
  try {
    const report = await scanToken(mint);
    if (!report) return null;
    
    const formatted = formatReportForTweet(report);
    return `\n\nRugCheck Data for ${mint.slice(0, 8)}...:\n${formatted}`;
  } catch (err) {
    logger.debug(`[ReplyEngine] RugCheck scan failed for ${mint.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
}

// ============================================================================
// Reply Generation
// ============================================================================

async function generateReply(candidate: ReplyCandidate): Promise<string | null> {
  try {
    const env = getEnv();
    const openaiKey = env.OPENAI_API_KEY;
    if (!openaiKey) {
      logger.warn('[ReplyEngine] No OPENAI_API_KEY for reply generation');
      return null;
    }
    
    const systemPrompt = `You are Nova, an autonomous AI agent that launches meme tokens on Solana via pump.fun.

You're replying to a tweet. Your reply should be:
- SHORT (under 200 chars ideally, max 280)
- SUBSTANTIVE — add real value, data, or a sharp observation
- NOT generic ("great post!" / "love this!" / "100%")
- Speak as a PEER, not a fan
- Include relevant data when possible (your launch count, graduation rates, RugCheck scores, etc.)
- If the tweet mentions a specific token, add safety context from RugCheck data if available
- If it's about pump.fun/Solana ecosystem, share your experience as an active builder

Your context:
- You've launched tokens on pump.fun and actively build in the Solana meme space
- You run RugCheck scans on every token you launch (mint revoked, freeze revoked)
- You track on-chain data and share it transparently
- Your handle is @${env.NOVA_X_HANDLE || 'NovaOnSolana'}

NEVER:
- Say "fam", "frens", "let's gooo", "vibes"
- Be sycophantic or generic
- Self-promote excessively (one natural mention of your work is fine)
- Use more than 1 emoji`;
    
    // Try to get RugCheck data for any token addresses in the tweet
    const rugCheckContext = await getRugCheckContext(candidate.text);
    
    let userPrompt = `Reply to this tweet:\n\n"${candidate.text}"\n\nSource: ${candidate.source}${candidate.query ? ` (query: "${candidate.query}")` : ''}`;
    
    if (rugCheckContext) {
      userPrompt += `\n\n${rugCheckContext}\n\nUse this RugCheck data to add safety context in your reply.`;
    }
    
    userPrompt += `\n\nWrite a concise, data-driven reply:`;
    
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 150,
      }),
    });
    
    if (!res.ok) {
      logger.warn(`[ReplyEngine] OpenAI returned ${res.status}`);
      return null;
    }
    
    const data = await res.json();
    let reply = data.choices?.[0]?.message?.content?.trim();
    
    if (!reply) return null;
    
    // Clean up quotes if LLM wrapped it
    reply = reply.replace(/^["']|["']$/g, '');
    
    // Enforce character limit
    if (reply.length > 280) {
      reply = reply.substring(0, 277) + '...';
    }
    
    return reply;
  } catch (err) {
    logger.error('[ReplyEngine] Reply generation failed:', err);
    return null;
  }
}

export default {
  startReplyEngine,
  stopReplyEngine,
  getReplyEngineStatus,
};
