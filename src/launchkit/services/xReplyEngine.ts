import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getTwitterReader, XPublisherService } from './xPublisher.ts';
import { canWrite, canRead, recordRead, getPostingAdvice, getQuota, isPayPerUseReads, reportRateLimit, reportReadRateLimit, canReadMentions, canReadSearch, recordMentionRead, recordSearchRead, mentionsCooldownRemaining, searchCooldownRemaining } from './xRateLimiter.ts';
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
  
  // Delay first round by 5 minutes to avoid startup 429 collisions
  // (deploy restarts, ElizaOS init, and webhook setup all hit the API on boot)
  const startDelayMs = 5 * 60 * 1000;
  setTimeout(() => {
    runReplyRound().catch(err => logger.error('[ReplyEngine] Initial round failed:', err));
  }, startDelayMs);
  
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
  
  // Check rate limit (includes shared 429 backoff)
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
  
  // Pick best candidate (prioritize mentions, filter spam/irrelevant)
  const candidate = pickBestCandidate(candidates);
  if (!candidate) return;
  
  // Delay between read and write to avoid landing in the same 15-min rate window
  const delayMs = 30_000 + Math.random() * 30_000;
  const delaySec = Math.round(delayMs / 1000);
  logger.info(`[ReplyEngine] Waiting ${delaySec}s before replying...`);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  
  // Re-check rate limits — another service may have posted during the wait
  const postCheckAdvice = getPostingAdvice();
  if (!postCheckAdvice.canPost) {
    logger.debug(`[ReplyEngine] Rate limited after delay: ${postCheckAdvice.reason}`);
    return;
  }
  
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

    // Always mark the tweet as "attempted" so we don't retry the same one
    state.repliedTweetIds.add(candidate.tweetId);

    if (code === 'X_RATE_LIMIT' || msg.includes('429') || msg.includes('rate limit')) {
      // Signal shared backoff — pauses ALL X posting (replies, brand, marketing)
      reportRateLimit();
      logger.warn(`[ReplyEngine] Twitter 429 rate limit — all posting paused for 15 minutes`);
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
 * Always alternates between mentions and search (1 read per round).
 * Even on paid tiers, alternating avoids burning through rate limits
 * and keeps the engine sustainable long-term.
 * 
 * If a 429 hits, reportReadRateLimit() pauses all reads for 15 min.
 */
async function findCandidates(reader: ReturnType<typeof getTwitterReader>): Promise<ReplyCandidate[]> {
  const env = getEnv();
  const candidates: ReplyCandidate[] = [];
  
  // Always alternate: even rounds → mentions, odd rounds → search.
  const doMentions = state.roundCount % 2 === 0;
  const doSearch   = state.roundCount % 2 !== 0;
  
  // Mentions
  if (doMentions && canReadMentions()) {
    try {
      const mentions = await reader.getMentions(10);
      await recordMentionRead();
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
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
        reportReadRateLimit();
      }
      try { await recordMentionRead(); } catch {}
    }
  } else if (doMentions) {
    const wait = mentionsCooldownRemaining();
    if (wait > 0) logger.info(`[ReplyEngine] Mentions on cooldown — ${wait}s remaining`);
  }
  
  // Search
  if (doSearch && canReadSearch()) {
    const queries = (env.X_REPLY_SEARCH_QUERIES || '').split(',').map(q => q.trim()).filter(Boolean);
    if (queries.length > 0) {
      const query = queries[Math.floor(Math.random() * queries.length)];
      try {
        const results = await reader.searchTweets(query, 10);
        await recordSearchRead();
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
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
          reportReadRateLimit();
        }
        try { await recordSearchRead(); } catch {}
      }
    }
  } else if (doSearch) {
    const wait = searchCooldownRemaining();
    if (wait > 0) logger.info(`[ReplyEngine] Search on cooldown — ${wait}s remaining`);
  }
  
  return candidates;
}

function pickBestCandidate(candidates: ReplyCandidate[]): ReplyCandidate | null {
  if (candidates.length === 0) return null;
  
  const totalCount = candidates.length;
  const viable: ReplyCandidate[] = [];
  
  for (const c of candidates) {
    // Spam filter first — catch scam bots even if they mention us
    if (isSpam(c.text)) {
      logger.debug(`[ReplyEngine] Skipping spam: "${c.text.slice(0, 60)}..."`);
      state.repliedTweetIds.add(c.tweetId);
      continue;
    }
    
    // Relevance filter — mentions always pass, search must have keywords
    if (!isRelevant(c.text, c.source)) {
      logger.debug(`[ReplyEngine] Skipping irrelevant: "${c.text.slice(0, 60)}..."`);
      state.repliedTweetIds.add(c.tweetId);
      continue;
    }
    
    viable.push(c);
  }
  
  if (viable.length === 0) {
    logger.info(`[ReplyEngine] All ${totalCount} candidates filtered out (spam/irrelevant)`);
    return null;
  }
  
  // Priority: mentions > search
  const mentions = viable.filter(c => c.source === 'mention');
  if (mentions.length > 0) return mentions[0];
  
  // For search results, pick one at random
  const search = viable.filter(c => c.source === 'search');
  if (search.length > 0) return search[Math.floor(Math.random() * search.length)];
  
  return viable[0];
}

// ============================================================================
// Spam & Relevance Filters
// ============================================================================

const SPAM_PATTERNS: string[] = [
  // DM bait / scams
  'dm me', 'send me a dm', 'check your dm', 'check inbox', 'check dm',
  'slide into', "let's connect", "let's talk privately", "let's collaborate",
  'message me', 'inbox me', 'text me', 'whatsapp me',
  // Follow farming
  'follow me', 'follow back', 'f4f', 'follow for follow',
  'like and retweet', 'like and follow', 'retweet this', 'repost this',
  // Wallet scams
  'claim your', 'airdrop claim', 'connect wallet', 'connect your wallet',
  'validate your wallet', 'sync your wallet', 'verify wallet', 'whitelist spot',
  'guaranteed profit', 'free mint', 'free airdrop', '100x guaranteed',
  'send sol to', 'send eth to', '10x your',
  // Promo spam
  'i can help you grow', 'grow your account', 'grow your brand',
  'promote your', 'marketing services', 'paid promo', 'paid promotion',
  'book a call', 'schedule a call', 'link in bio', 'check my bio',
  // Generic bot replies
  'nice project', 'great project', 'amazing project', 'interesting project',
  'check out my', 'check my pin', 'check my latest',
  // Engagement bait
  'drop your wallet', 'drop wallet below', 'tag 3 friends',
];

function isSpam(text: string): boolean {
  const lower = text.toLowerCase();
  return SPAM_PATTERNS.some(pattern => lower.includes(pattern));
}

const RELEVANCE_KEYWORDS: string[] = [
  // Solana ecosystem
  'solana', 'sol', 'pump.fun', 'pumpfun', 'pumpswap', 'raydium',
  'jupiter', 'dexscreener', 'birdeye',
  // Token/crypto
  'memecoin', 'meme coin', 'meme token', 'token launch', 'token',
  'crypto', 'defi', 'dex', 'swap', 'liquidity', 'bonding curve',
  'graduated', 'market cap',
  // Safety
  'rugcheck', 'rug pull', 'rugged', 'mint authority', 'freeze authority',
  'lp locked', 'lp burned',
  // Community
  'degen', 'crypto twitter', 'holder', 'airdrop',
  // AI agents
  'ai agent', 'eliza', 'elizaos', 'autonomous', 'nova',
  // Chain/wallet
  'wallet', 'on-chain', 'onchain', 'blockchain', 'web3',
];

function isRelevant(text: string, source: string): boolean {
  // Mentions are always relevant — someone tagged Nova directly
  if (source === 'mention') return true;
  // Search results must contain at least one keyword
  const lower = text.toLowerCase();
  return RELEVANCE_KEYWORDS.some(kw => lower.includes(kw));
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
