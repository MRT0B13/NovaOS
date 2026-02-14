import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getTwitterReader, XPublisherService } from './xPublisher.ts';
import { canWrite, canRead, recordRead, getPostingAdvice, getQuota, isPayPerUseReads, reportRateLimit, reportReadRateLimit, canReadMentions, canReadSearch, recordMentionRead, recordSearchRead, mentionsCooldownRemaining, searchCooldownRemaining } from './xRateLimiter.ts';
import { canPostToX, recordXPost } from './novaPersonalBrand.ts';
import { getNovaStats, type TokenMover } from './novaPersonalBrand.ts';
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
// Shared Read Data
// ============================================================================
// The reply engine is the ONLY service that reads from the X API.
// Other services (shoutouts, performance tracking) consume from this cache.
// This prevents duplicate API calls and 429s.

const sharedData = {
  /** Raw mentions from last fetch — other services can read this */
  lastMentions: [] as Array<{ id: string; text: string; authorId?: string; createdAt?: string }>,
  lastMentionFetchAt: 0,
  
  /** Engager tracking — counts how many times each authorId has mentioned us */
  engagerCounts: new Map<string, number>(),
  
  /** Performance tracking — brand scheduler queues tweet IDs, engine checks 1 per round */
  perfQueue: [] as string[],
  perfResults: new Map<string, { likes: number; retweets: number; replies: number; checkedAt: number }>(),
};

// ── Exported accessors (consumed by novaPersonalBrand.ts) ──

/** Get top engagers sorted by mention count. Used by community shoutout. */
export function getTopEngagers(minCount = 2): Array<{ authorId: string; count: number }> {
  return [...sharedData.engagerCounts.entries()]
    .filter(([_, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([authorId, count]) => ({ authorId, count }));
}

/** Queue a tweet ID for performance checking. Engine will check 1 per round. */
export function queuePerfCheck(tweetId: string): void {
  if (!sharedData.perfQueue.includes(tweetId) && !sharedData.perfResults.has(tweetId)) {
    sharedData.perfQueue.push(tweetId);
    // Keep queue reasonable
    if (sharedData.perfQueue.length > 20) {
      sharedData.perfQueue = sharedData.perfQueue.slice(-20);
    }
  }
}

/** Get performance results for checked tweets. */
export function getPerfResults(): Map<string, { likes: number; retweets: number; replies: number; checkedAt: number }> {
  return sharedData.perfResults;
}

/** Get last fetched mentions (for any service that needs them without a separate API call). */
export function getLastMentions() {
  return {
    mentions: sharedData.lastMentions,
    fetchedAt: sharedData.lastMentionFetchAt,
  };
}

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
  
  // Delay first round by 10 minutes to avoid startup 429 collisions
  // (deploy restarts, ElizaOS init, brand scheduler, and webhook setup all hit the API on boot)
  const startDelayMs = 10 * 60 * 1000;
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
    logger.info(`[ReplyEngine] Daily limit reached (${state.repliesToday}/${maxPerDay})`);
    return;
  }
  
  // Check rate limit (includes shared 429 backoff)
  const advice = getPostingAdvice();
  if (!advice.canPost) {
    logger.info(`[ReplyEngine] Write rate limited: ${advice.reason}`);
    return;
  }
  
  // Check read quota
  const quota = getQuota();
  if (!canRead()) {
    logger.warn(`[ReplyEngine] Read budget exhausted (${quota.reads.used} reads used). Pausing until next month.`);
    import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_budget_exhausted',
      `X read budget exhausted (${quota.reads.used} reads used).\nReply engine paused until next month.`
    )).catch(() => {});
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
  logger.info(`[ReplyEngine] Round #${state.roundCount} — finding candidates...`);
  const candidates = await findCandidates(reader);
  if (candidates.length === 0) {
    logger.info(`[ReplyEngine] Round #${state.roundCount} — no candidates found`);
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
  
  // Global write gate — ensure 5-min gap between any two X writes
  if (!canPostToX()) {
    logger.debug('[ReplyEngine] Skipping reply — global X write gate (5-min gap)');
    return;
  }
  
  // Generate a reply
  // Fetch real stats so the reply uses actual numbers (not hallucinated)
  let stats: { launches: number; graduated: number; portfolioSol: string; dayNumber: number; tokenMovers: TokenMover[] } | null = null;
  try {
    const novaStats = await getNovaStats();
    stats = {
      launches: novaStats.totalLaunches,
      graduated: novaStats.bondingCurveHits,
      portfolioSol: novaStats.walletBalance.toFixed(2),
      dayNumber: novaStats.dayNumber,
      tokenMovers: novaStats.tokenMovers || [],
    };
  } catch {
    // Non-fatal — reply will just omit specific numbers
  }

  const replyText = await generateReply(candidate, stats);
  if (!replyText) return;
  
  // Post the reply
  try {
    // XPublisherService needs a store but we only use reply() which doesn't need it
    const xPublisher = new XPublisherService({} as any);
    
    const result = await xPublisher.reply(replyText, candidate.tweetId);
    
    // Update global write gate
    recordXPost();
    
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
      import('./adminNotify.ts').then(m => m.notifyAdminWarning('x_reply_failed',
        `Reply engine failed to post reply.\nTweet ID: <code>${candidate.tweetId}</code>\nError: ${msg}`
      )).catch(() => {});
    }
  }
  
  // ── Piggyback: check 1 queued tweet's performance per round ──
  // Spreads the load (1 read per round instead of 5 at once)
  if (sharedData.perfQueue.length > 0 && canRead()) {
    const tweetId = sharedData.perfQueue.shift()!;
    try {
      const perfReader = getTwitterReader();
      const tweet = await perfReader.getTweet(tweetId);
      await recordRead();
      if (tweet?.metrics) {
        sharedData.perfResults.set(tweetId, {
          ...tweet.metrics,
          checkedAt: Date.now(),
        });
        logger.debug(`[ReplyEngine] Perf check: ${tweetId.slice(0, 8)} → ${tweet.metrics.likes} likes, ${tweet.metrics.retweets} RTs`);
      }
      // Trim old results
      if (sharedData.perfResults.size > 50) {
        const entries = [...sharedData.perfResults.entries()].sort((a, b) => b[1].checkedAt - a[1].checkedAt);
        sharedData.perfResults = new Map(entries.slice(0, 30));
      }
    } catch {
      // Non-fatal — just skip this round's perf check
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
      
      // ── Populate shared data (consumed by brand scheduler) ──
      sharedData.lastMentions = mentions;
      sharedData.lastMentionFetchAt = Date.now();
      
      // Track engager counts (for community shoutouts)
      for (const m of mentions) {
        if (m.authorId) {
          sharedData.engagerCounts.set(
            m.authorId,
            (sharedData.engagerCounts.get(m.authorId) || 0) + 1
          );
        }
      }
      // Trim engager map if it gets too large
      if (sharedData.engagerCounts.size > 500) {
        const sorted = [...sharedData.engagerCounts.entries()].sort((a, b) => b[1] - a[1]);
        sharedData.engagerCounts = new Map(sorted.slice(0, 200));
      }
      // ── End shared data ──
      
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
      // getMentions() already calls reportReadRateLimit() on 429 — don't double-fire
      const msg = err?.message || String(err);
      if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
        logger.info(`[ReplyEngine] Mentions 429 — read backoff active, will retry next round`);
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
        // searchTweets() already calls reportReadRateLimit() on 429 — don't double-fire
        const msg = err?.message || String(err);
        if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
          logger.info(`[ReplyEngine] Search 429 — read backoff active, will retry next round`);
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

// ============================================================================
// Spam & Relevance Filters
// ============================================================================

/**
 * Patterns that indicate spam, scam, or engagement-farming tweets.
 * Checked as case-insensitive substrings.
 */
const SPAM_PATTERNS = [
  // DM bait / scams
  'dm me', 'check your dm', 'check dm', 'sent you a dm', "let's connect",
  'message me', 'inbox me', 'slide into', 'text me',
  // Follow farming
  'follow me', 'follow back', 'f4f', 'like and retweet', 'rt and follow',
  // Wallet scams
  'claim your', 'connect wallet', 'validate your wallet', 'guaranteed profit',
  'send sol to', 'send eth to', 'free airdrop claim', 'claim now',
  // Promo spam
  'grow your account', 'marketing services', 'book a call', 'link in bio',
  'promote your', 'boost your followers',
  // Generic bot replies
  'nice project', 'great project', 'amazing project', 'check out my',
  'looks promising sir',
  // Engagement bait
  'drop your wallet', 'tag 3 friends', 'tag a friend', 'comment your',
  // Ad / brand content
  'sponsored', 'ad:', '#ad ', 'limited time offer', 'use code',
  'shop now', 'buy now', 'order now', 'free shipping',
];

/**
 * Keywords that indicate crypto/Solana relevance.
 */
const RELEVANCE_KEYWORDS = [
  // Solana ecosystem
  'solana', 'sol', 'pump.fun', 'pumpfun', 'pump fun', 'pumpswap',
  'raydium', 'jupiter', 'dexscreener', 'birdeye', 'phantom',
  // Token / crypto terms
  'memecoin', 'meme coin', 'meme token', 'token', 'crypto',
  'defi', 'dex', 'bonding curve', 'market cap', 'mcap',
  // Safety terms
  'rugcheck', 'rug pull', 'rug pulled', 'rugged',
  'mint authority', 'freeze authority', 'lp locked', 'liquidity',
  // Community
  'degen', 'holder', 'airdrop', 'launch', 'presale',
  // AI agents
  'ai agent', 'eliza', 'elizaos', 'autonomous', 'nova',
  // Chain / wallet
  'wallet', 'on-chain', 'onchain', 'blockchain', 'web3',
];

/**
 * Check if a tweet is spam/scam.
 * Returns true if spam (should be SKIPPED).
 */
function isSpam(text: string): boolean {
  const lower = text.toLowerCase();
  return SPAM_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Check if a tweet is relevant to Nova's domain.
 * - Mentions: always relevant (someone tagged us directly) UNLESS caught by spam filter
 * - Search results: must contain at least one relevance keyword
 */
function isRelevant(text: string, source: 'mention' | 'search' | 'target'): boolean {
  // Mentions are relevant by default (spam filter catches the bad ones first)
  if (source === 'mention') return true;
  
  const lower = text.toLowerCase();
  return RELEVANCE_KEYWORDS.some(kw => lower.includes(kw));
}

function pickBestCandidate(candidates: ReplyCandidate[]): ReplyCandidate | null {
  if (candidates.length === 0) return null;
  
  const viable: ReplyCandidate[] = [];
  
  for (const c of candidates) {
    // Spam filter FIRST — catches DM scams, follow bait, ads, etc.
    if (isSpam(c.text)) {
      logger.debug(`[ReplyEngine] SPAM filtered: "${c.text.slice(0, 60)}..." (${c.source})`);
      state.repliedTweetIds.add(c.tweetId); // Don't retry this one
      continue;
    }
    
    // Relevance filter — mentions pass by default, search must match keywords
    if (!isRelevant(c.text, c.source)) {
      logger.debug(`[ReplyEngine] IRRELEVANT filtered: "${c.text.slice(0, 60)}..." (${c.source})`);
      state.repliedTweetIds.add(c.tweetId); // Don't retry
      continue;
    }
    
    viable.push(c);
  }
  
  if (viable.length === 0) {
    logger.info(`[ReplyEngine] All ${candidates.length} candidates filtered out (spam/irrelevant)`);
    return null;
  }
  
  logger.debug(`[ReplyEngine] ${viable.length}/${candidates.length} candidates passed filters`);
  
  // Priority: mentions > search
  const mentions = viable.filter(c => c.source === 'mention');
  if (mentions.length > 0) return mentions[0];
  
  const search = viable.filter(c => c.source === 'search');
  if (search.length > 0) return search[Math.floor(Math.random() * search.length)];
  
  return viable[0];
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

async function generateReply(
  candidate: ReplyCandidate,
  stats?: { launches: number; graduated: number; portfolioSol: string; dayNumber: number; tokenMovers: TokenMover[] } | null
): Promise<string | null> {
  try {
    const env = getEnv();
    const openaiKey = env.OPENAI_API_KEY;
    if (!openaiKey) {
      logger.warn('[ReplyEngine] No OPENAI_API_KEY for reply generation');
      return null;
    }
    
    // Build stats block with REAL numbers only
    const topToken = stats?.tokenMovers?.[0];
    const tokenLine = topToken
      ? `\n- Most active token: $${topToken.ticker} — ${topToken.priceChange24h !== null ? `${topToken.priceChange24h > 0 ? '+' : ''}${topToken.priceChange24h.toFixed(1)}% 24h` : 'no 24h data'}, vol $${topToken.volume24h?.toLocaleString() ?? '?'}`
      : '';
    const statsBlock = stats
      ? `YOUR CONTEXT (use sparingly — do NOT lead every reply with stats):
- Day ${stats.dayNumber}, ${stats.launches} launches, ${stats.graduated} graduated
- Portfolio: ${stats.portfolioSol} SOL${tokenLine}
- Mint & freeze revoked on all tokens (boolean, NOT a score)
- RugCheck = risk score 0-100 (lower = safer). Never say "98% safety score".`
      : `You launch tokens on pump.fun. Do NOT cite specific numbers for launch count, portfolio value, or RugCheck scores — you don't have current data right now.`;
    
    const systemPrompt = `You are Nova (@${env.NOVA_X_HANDLE || 'nova_agent_'}), an autonomous AI agent that launches meme tokens on Solana via pump.fun. You are blunt, data-driven, and transparent. You are NOT a hype bot, NOT a cheerleader, NOT a generic engagement farmer.

${statsBlock}

You're replying to a tweet. Rules:
- MAX 200 characters. Shorter is better.
- Add a specific observation, data point, or honest opinion
- Speak as a builder who has opinions, not a fan who agrees with everything
- If someone shares a token, offer a safety take (mint/freeze status matters)
- If someone says something generic, call it out or add substance
- ONE emoji max. Zero is fine.

NEVER:
- Invent numbers you don't have. If you don't know a stat, don't mention it.
- Say "Transparency is key", "Let's build together", "I'm always open to collaboration"
- Say "fam", "frens", "vibes", "LFG", "WAGMI"
- Start with "Great to see" or "Love this" or "I'm always open to"
- Agree enthusiastically with vague statements
- Use exclamation marks more than once

If the tweet is clearly spam, a paid promo offer, engagement farming ("let's connect", "I've got the crew", "looks solid 🔥"), or completely unrelated to crypto — respond with exactly "SKIP" and nothing else.

Ecosystem accounts you can tag when relevant (use sparingly, 1 per reply max):
- @Pumpfun — the platform you launch on
- @Rugcheckxyz — your safety scanner
- @dexscreener — where chart data comes from
- @elizaOS — your framework
- @JupiterExchange — Solana DEX aggregator
- @aixbt_agent — AI agent peer (engage as equal, not fan)
- @shawmakesmagic — elizaOS creator
Only tag if the tweet is directly about that account/topic. Never force a tag.`;
    
    // Try to get RugCheck data for any token addresses in the tweet
    const rugCheckContext = await getRugCheckContext(candidate.text);
    
    let userPrompt = `Reply to this tweet:\n\n"${candidate.text}"`;
    
    if (rugCheckContext) {
      userPrompt += `\n\n${rugCheckContext}\n\nIncorporate this RugCheck data naturally.`;
    }
    
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
        temperature: 0.7,
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
    
    // GPT can refuse to reply by returning "SKIP"
    if (reply.trim().toUpperCase() === 'SKIP') {
      logger.debug(`[ReplyEngine] GPT refused (spam/irrelevant): "${candidate.text.slice(0, 60)}..."`);
      state.repliedTweetIds.add(candidate.tweetId);
      return null;
    }
    
    // Clean up quotes if LLM wrapped it
    reply = reply.replace(/^["']|["']$/g, '');
    
    // Normalize handles in reply
    try {
      const { normalizeHandles } = await import('./novaPersonalBrand.ts');
      reply = normalizeHandles(reply);
    } catch { /* non-fatal */ }
    
    // Enforce character limit
    if (reply.length > 280) {
      reply = reply.substring(0, 277) + '...';
    }
    
    // ── Post-generation sanity check ──
    // Catch common hallucination patterns even if GPT ignores instructions
    const lower = reply.toLowerCase();
    const hallucinations = [
      /\b\d+%\s*(rugcheck|safety|compliance|score)/i,           // "98% RugCheck score"
      /\bover\s+\d+\s+tokens?\s+(launched|created|deployed)/i,  // "over 50 tokens launched" (if number doesn't match)
      /100%\s*(rugcheck|compliance|safety)/i,                    // "100% RugCheck compliance"
    ];
    
    for (const pattern of hallucinations) {
      if (pattern.test(reply)) {
        logger.warn(`[ReplyEngine] Caught hallucination in reply: "${reply.slice(0, 80)}..." — discarding`);
        return null;
      }
    }
    
    // Catch generic ChatGPT phrases
    const genericPhrases = [
      'transparency is key',
      "let's build together",
      "let's build a resilient",
      "i'm always open to collaboration",
      "great to see",
      "love to see",
      "game changer",
    ];
    
    for (const phrase of genericPhrases) {
      if (lower.includes(phrase)) {
        logger.warn(`[ReplyEngine] Generic phrase detected: "${phrase}" — discarding`);
        return null;
      }
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
  // Shared data (single-source reads)
  getTopEngagers,
  queuePerfCheck,
  getPerfResults,
  getLastMentions,
};
