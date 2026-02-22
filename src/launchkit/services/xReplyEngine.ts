import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getTwitterReader, XPublisherService } from './xPublisher.ts';
import { canWrite, canRead, recordRead, getPostingAdvice, getQuota, isPayPerUseReads, reportRateLimit, reportReadRateLimit, canReadMentions, canReadSearch, recordMentionRead, recordSearchRead, mentionsCooldownRemaining, searchCooldownRemaining, getDailyWritesRemaining } from './xRateLimiter.ts';
import { canPostToX, recordXPost } from './novaPersonalBrand.ts';
import { getNovaStats, type TokenMover } from './novaPersonalBrand.ts';
import { scanToken, formatReportForTweet } from './rugcheck.ts';
import { loadSet, saveSet, loadMap, saveMap } from './persistenceStore.ts';
import { quickSearch, getReplyIntel } from './novaResearch.ts';
import { getHealthbeat } from '../health/singleton';
import { getTargetConfig, getAllTargetHandles, REPLY_STYLE_GUIDES } from '../community-targets.ts';
import { validateReply, recordReplyForRules, shouldSkipPost } from '../reply-rules.ts';
import { logEngagement } from '../engagement-tracker.ts';

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
  
  // Restore persisted state from PG before first round
  restorePersistedState().catch(e => logger.warn('[ReplyEngine] Could not restore persisted state:', e));
  
  const intervalMs = (env.X_REPLY_INTERVAL_MINUTES || 60) * 60 * 1000;
  
  state.running = true;

  // Show actual remaining so the startup log is truthful after restarts
  const dailyRemaining = getDailyWritesRemaining();
  logger.info(`[ReplyEngine] Started (max ${env.X_REPLY_MAX_PER_DAY}/day, every ${env.X_REPLY_INTERVAL_MINUTES || 60}m) — ${dailyRemaining} tweets remaining in 24h window`);
  if (dailyRemaining <= 0) {
    logger.warn(`[ReplyEngine] ⚠️ Daily X quota exhausted (0/${env.X_REPLY_MAX_PER_DAY}). Will resume when oldest tweet ages out of 24h window.`);
  }
  
  // Delay first round by 16 minutes — exceeds X's 15-min rate window.
  // Previous deploy may have burned the mentions/search quota;
  // waiting 16 min guarantees a fresh window.
  const startDelayMs = 16 * 60 * 1000;
  setTimeout(() => {
    runReplyRound().catch(err => logger.error('[ReplyEngine] Initial round failed:', err));
  }, startDelayMs);
  
  state.intervalHandle = setInterval(() => {
    runReplyRound().catch(err => logger.error('[ReplyEngine] Round failed:', err));
  }, intervalMs);
}

/** Restore repliedTweetIds + engagerCounts from PG */
async function restorePersistedState(): Promise<void> {
  const [savedIds, savedEngagers] = await Promise.all([
    loadSet('reply_engine:replied_tweet_ids'),
    loadMap<number>('reply_engine:engager_counts'),
  ]);
  if (savedIds.size > 0) {
    for (const id of savedIds) state.repliedTweetIds.add(id);
    logger.info(`[ReplyEngine] Restored ${savedIds.size} replied tweet IDs from DB`);
  }
  if (savedEngagers.size > 0) {
    for (const [k, v] of savedEngagers) sharedData.engagerCounts.set(k, v);
    logger.info(`[ReplyEngine] Restored ${savedEngagers.size} engager counts from DB`);
  }
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
let roundInProgress = false;
async function runReplyRound(): Promise<void> {
  // Guard against concurrent rounds (interval can fire before prev round finishes)
  if (roundInProgress) {
    logger.info('[ReplyEngine] Previous round still running, skipping');
    return;
  }
  roundInProgress = true;
  try {
  return await _runReplyRoundInner();
  } finally {
    roundInProgress = false;
  }
}
async function _runReplyRoundInner(): Promise<void> {
  const env = getEnv();

  // Fast-path: skip entire round if X daily quota is exhausted (24h rolling window)
  const windowRemaining = getDailyWritesRemaining();
  if (windowRemaining <= 0 || !canWrite()) {
    logger.info(`[ReplyEngine] Skipping round — daily quota exhausted (${windowRemaining} remaining)`);
    return;
  }
  
  // Reset daily counter
  const today = new Date().toISOString().split('T')[0];
  if (state.lastResetDate !== today) {
    state.repliesToday = 0;
    state.lastResetDate = today;
    // Keep replied IDs for dedup — trim to last 500 instead of nuking all
    if (state.repliedTweetIds.size > 1000) {
      const ids = [...state.repliedTweetIds];
      state.repliedTweetIds = new Set(ids.slice(-500));
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
  
  // ALWAYS increment round counter — ensures we alternate mentions/search
  // regardless of whether we found candidates or posted a reply.
  state.roundCount++;
  
  if (candidates.length === 0) {
    logger.info(`[ReplyEngine] Round #${state.roundCount - 1} — no candidates found`);
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
  
  // ── Validate via reply rules before generating ──
  if (candidate.authorHandle) {
    const preCheck = validateReply(
      'placeholder-check', // We check length/content after generation; here we check rate limits
      candidate.authorHandle,
    );
    // Only block on rate-limit reasons (not content reasons — those apply post-generation)
    if (!preCheck.valid && (preCheck.reason?.includes('cap reached') || preCheck.reason?.includes('Already replied') || preCheck.reason?.includes('Too soon'))) {
      logger.info(`[ReplyEngine] Reply rules blocked: ${preCheck.reason}`);
      return;
    }
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

  // ── Post-generation content validation via reply rules ──
  if (candidate.authorHandle) {
    const contentCheck = validateReply(replyText, candidate.authorHandle);
    if (!contentCheck.valid) {
      logger.info(`[ReplyEngine] Reply rules rejected content: ${contentCheck.reason}`);
      return;
    }
  }
  
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
    saveSet('reply_engine:replied_tweet_ids', state.repliedTweetIds);
    state.trackedReplies.push({
      tweetId: candidate.tweetId,
      replyId: result.id,
      text: replyText,
      repliedAt: new Date().toISOString(),
      source: candidate.source,
    });

    // Record for anti-spam rate limiting
    recordReplyForRules(candidate.authorHandle || 'unknown', candidate.tweetId);

    // Log engagement for tracking
    const targetCfg = candidate.authorHandle ? getTargetConfig(candidate.authorHandle) : null;
    const tierNum = targetCfg ? (
      targetCfg.style === 'peer' ? 1 : targetCfg.style === 'analyst' ? 2 : 3
    ) as 1 | 2 | 3 : 0 as 0;
    logEngagement({
      platform: 'x',
      targetHandle: candidate.authorHandle || 'unknown',
      postId: candidate.tweetId,
      replyId: result.id,
      replyContent: replyText,
      replyStyle: targetCfg?.style || 'general',
      tier: tierNum,
      timestamp: new Date(),
    }).catch(() => {});
    
    // Keep tracked replies trimmed
    if (state.trackedReplies.length > 200) {
      state.trackedReplies = state.trackedReplies.slice(-100);
    }
    
    // Increment round counter
    // (already incremented above after findCandidates — this is intentionally removed)
    // state.roundCount++;
    
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
      getHealthbeat()?.reportError({ errorType: 'X_RATE_LIMIT', errorMessage: msg, severity: 'warning', context: { task: 'reply_post', tweetId: candidate.tweetId } }).catch(() => {});
    } else {
      logger.warn(`[ReplyEngine] Failed to post reply: ${msg}`);
      getHealthbeat()?.reportError({ errorType: err?.name || 'ReplyPostError', errorMessage: msg, stackTrace: err?.stack, severity: 'error', context: { task: 'reply_post', tweetId: candidate.tweetId } }).catch(() => {});
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
  
  // Round 0: skip ALL reads — prev deploy's 15-min rate window covers both mentions AND search.
  // Round 1+: alternate search (even) / mentions (odd).
  if (state.roundCount === 0) {
    logger.info('[ReplyEngine] Round #0 — skipping all reads (previous deploy rate window). Will start reading next round.');
    state.roundCount++;
    return candidates;
  }
  const doMentions = state.roundCount % 2 !== 0;
  const doSearch   = state.roundCount % 2 === 0;
  
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
      // Persist engager counts (debounced 10s)
      saveMap('reply_engine:engager_counts', sharedData.engagerCounts, 10000);
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
      logger.info(`[ReplyEngine] Mentions: ${mentions.length} fetched, ${candidates.length} new candidates (${mentions.length - candidates.length} already seen)`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
        // On first two rounds, a 429 is likely leftover from previous deploy's rate window.
        // Just skip — don't trigger the exponential backoff hammer.
        if (state.roundCount <= 1) {
          logger.info(`[ReplyEngine] Mentions 429 on startup round #${state.roundCount} — skipping (previous deploy rate window). Will retry next round.`);
        } else {
          // Trigger read backoff for later rounds
          try { reportReadRateLimit(); } catch {}
          logger.info(`[ReplyEngine] Mentions 429 — read backoff active, will retry next round`);
        }
        getHealthbeat()?.reportError({ errorType: 'X_READ_429', errorMessage: msg, severity: 'warning', context: { task: 'mentions_fetch' } }).catch(() => {});
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
        let newCount = 0;
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
            newCount++;
          }
        }
        logger.info(`[ReplyEngine] Search "${query}": ${results.length} fetched, ${newCount} new candidates`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')) {
          if (state.roundCount <= 1) {
            logger.info(`[ReplyEngine] Search 429 on startup round #${state.roundCount} — skipping (previous deploy rate window).`);
          } else {
            try { reportReadRateLimit(); } catch {}
            logger.info(`[ReplyEngine] Search 429 — read backoff active, will retry next round`);
          }
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
      logger.info(`[ReplyEngine] SPAM skipped: "${c.text.slice(0, 80)}..." (${c.source})`);
      state.repliedTweetIds.add(c.tweetId); // Don't retry this one
      continue;
    }
    
    // Relevance filter — mentions pass by default, search must match keywords
    if (!isRelevant(c.text, c.source)) {
      logger.info(`[ReplyEngine] IRRELEVANT skipped: "${c.text.slice(0, 80)}..." (${c.source})`);
      state.repliedTweetIds.add(c.tweetId); // Don't retry
      continue;
    }
    
    viable.push(c);
  }
  
  if (viable.length === 0) {
    logger.info(`[ReplyEngine] All ${candidates.length} candidates filtered out (spam/irrelevant)`);
    return null;
  }
  
  logger.info(`[ReplyEngine] ${viable.length}/${candidates.length} candidates passed filters`);
  
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
    
    // Determine reply style based on community target tier
    const targetConfig = candidate.authorHandle ? getTargetConfig(candidate.authorHandle) : null;
    const styleGuide = targetConfig ? `\n\nREPLY STYLE for @${candidate.authorHandle}: ${REPLY_STYLE_GUIDES[targetConfig.style]}` : '';

    const systemPrompt = `You are Nova (@${env.NOVA_X_HANDLE || 'nova_agent_'}), an autonomous AI agent that launches meme tokens on Solana via pump.fun. You are blunt, data-driven, and transparent. You are NOT a hype bot, NOT a cheerleader, NOT a generic engagement farmer.

${statsBlock}${styleGuide}

You're replying to a tweet. Rules:
- MAX 200 characters. Shorter is better.
- Add a specific observation, data point, or honest opinion
- Speak as a builder who has opinions, not a fan who agrees with everything
- If someone shares a token, offer a safety take (mint/freeze status matters)
- If someone says something generic, call it out or add substance
- ONE emoji max. Zero is fine.

NEVER:
- Invent numbers you don't have. If you don't know a stat, don't mention it.
- Fabricate statistics, percentages, TVL numbers, or market data that wasn't provided to you.
- Say "reports show" or "data suggests" when you're guessing — if you don't have the number, skip it.
- Round or embellish numbers from RESEARCH CONTEXT — use them exactly as provided or don't use them.
- Say "Transparency is key", "Let's build together", "I'm always open to collaboration"
- Say "fam", "frens", "vibes", "LFG", "WAGMI"
- Start with "Great to see", "Always great to see", "Congrats on the", "Love this", "Love to see", or "I'm always open to"
- Give generic safety advice like "make sure to check RugCheck" when you actually HAVE RugCheck data — use the data
- Say "it's vital to check" or "it's crucial to" — either share actual data or don't mention it
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

    // Enrich with web research for topic-relevant tweets
    let researchContext = '';
    const tweetLower = candidate.text.toLowerCase();

    // Fast check: try cached intel from nova_knowledge first (free, no API call)
    try {
      const intel = await getReplyIntel(candidate.text);
      if (intel) {
        researchContext = `\n\nRESEARCH CONTEXT (from cached intelligence):\n${intel}\n\nRULES: You may reference this data naturally but NEVER invent additional statistics or numbers beyond what's shown above. If the data doesn't match the tweet topic, ignore it. Do NOT fabricate percentages, dollar amounts, or "reports say" claims. Wrong numbers kill credibility.`;
        logger.info(`[ReplyEngine] Got cached intel for tweet (skipping Tavily)`);
      }
    } catch { /* non-critical */ }

    // Fallback: if no cached intel, try Tavily web search (costs a credit)
    if (!researchContext) {
    const TOPIC_KEYWORDS: { regex: RegExp; query: string }[] = [
      // Meme / launch platform
      { regex: /bonding curve|graduation|graduate/i, query: 'pump.fun bonding curve graduation mechanics' },
      { regex: /rug pull|rug|rugged|scam/i, query: 'Solana rug pull statistics prevention latest' },
      { regex: /pump\.?fun|pumpfun/i, query: 'pump.fun latest news updates' },
      { regex: /pumpswap|creator fee/i, query: 'PumpSwap creator fees pump.fun AMM' },
      { regex: /moonshot|believe|four\.?meme/i, query: 'token launch platform comparison pump.fun moonshot believe' },

      // AI agents
      { regex: /ai agent|autonomous agent|elizaos/i, query: 'AI agents crypto autonomous trading ElizaOS' },
      { regex: /x402|zauth|agent trust|agent verif/i, query: 'AI agent trust verification x402 zauth' },
      { regex: /virtuals|virtual protocol/i, query: 'Virtuals Protocol AI agents crypto' },

      // DeFi
      { regex: /tvl|total value locked/i, query: 'DeFi TVL top protocols latest' },
      { regex: /jupiter|raydium|orca/i, query: 'Solana DEX Jupiter Raydium comparison volume' },
      { regex: /aave|compound|lending/i, query: 'DeFi lending rates protocols latest' },
      { regex: /liquid staking|jito|marinade/i, query: 'Solana liquid staking Jito Marinade yields' },
      { regex: /hyperliquid|perps|perpetual/i, query: 'on-chain perpetuals derivatives Hyperliquid latest' },
      { regex: /stablecoin|usdc|usdt/i, query: 'stablecoin market supply USDT USDC latest' },

      // Bitcoin / macro
      { regex: /bitcoin etf|btc etf|blackrock/i, query: 'Bitcoin ETF flows latest BlackRock' },
      { regex: /halving|btc cycle|bitcoin cycle/i, query: 'Bitcoin halving cycle price analysis' },
      { regex: /fed|interest rate|macro/i, query: 'Fed interest rates crypto market impact latest' },

      // Solana ecosystem
      { regex: /solana tps|solana speed|solana down|solana outage/i, query: 'Solana network performance TPS uptime latest' },
      { regex: /mev|jito tip|sandwich/i, query: 'Solana MEV Jito sandwich attacks' },
      { regex: /depin|helium|hivemapper/i, query: 'Solana DePIN projects latest' },

      // Security
      { regex: /hack|exploit|drained|bridge hack/i, query: 'cryptocurrency hack exploit latest' },
      { regex: /rugcheck|rug check|token safety/i, query: 'RugCheck Solana token safety scanner' },
      { regex: /mint authority|freeze authority|revoke/i, query: 'Solana token mint freeze authority safety' },

      // Regulation
      { regex: /sec |securities|gensler|regulation/i, query: 'SEC cryptocurrency regulation enforcement latest' },
      { regex: /mica|europe crypto|eu crypto/i, query: 'MiCA Europe crypto regulation implementation' },

      // Culture
      { regex: /airdrop/i, query: 'crypto airdrop latest upcoming' },
      { regex: /nft/i, query: 'NFT market status latest' },
      { regex: /rwa|tokeniz/i, query: 'RWA real world assets tokenization crypto latest' },
      { regex: /dao|governance vote/i, query: 'DAO governance notable proposals latest' },
    ];
    const matchedTopic = TOPIC_KEYWORDS.find(k => k.regex.test(tweetLower));
    if (matchedTopic) {
      try {
        const answer = await quickSearch(matchedTopic.query);
        if (answer) {
          researchContext = `\n\nRESEARCH CONTEXT (from web search — use carefully):\n${answer}\n\nRULES: You may reference this data naturally but NEVER invent additional statistics or numbers beyond what's shown above. If the data doesn't match the tweet topic, ignore it. Do NOT fabricate percentages, dollar amounts, or "reports say" claims. Wrong numbers kill credibility.`;
        }
      } catch { /* non-critical */ }
    }
    } // end fallback to Tavily
    
    let userPrompt = `Reply to this tweet:\n\n"${candidate.text}"`;
    
    if (rugCheckContext) {
      userPrompt += `\n\n${rugCheckContext}\n\nYou MUST include the actual RugCheck score and key findings (mint/freeze status, risk flags) in your reply. This is your value-add — do NOT give generic safety advice like "check RugCheck scores" when you HAVE the data right here. Lead with the findings. Example: "RugCheck on $TOKEN: score 45, mint authority still active ⚠️. Careful." You can go up to 280 chars for replies that include RugCheck data. NEVER include URLs or markdown links — just the data. Tag @Rugcheckxyz instead of posting a link.`;
    }

    // If we found a mint address but RugCheck scan failed, be honest about it
    const detectedMints = extractMintAddresses(candidate.text);
    if (detectedMints.length > 0 && !rugCheckContext) {
      userPrompt += `\n\nA contract address was found in this tweet (${detectedMints[0].slice(0, 8)}...) but the RugCheck scan failed or returned no data. Do NOT give generic safety advice like "it's vital to check RugCheck scores." Instead, either: (a) say you tried to scan it and couldn't get data, or (b) skip the safety angle entirely and comment on something else in the tweet. NEVER pretend you checked something you didn't.`;
    }

    if (researchContext) {
      userPrompt += researchContext;
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
    
    // Strip markdown links → keep just the label text
    // e.g. "[More info](https://...)" → "More info"
    reply = reply.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    
    // Strip raw URLs (X shows link cards, but they eat chars and look spammy in replies)
    reply = reply.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    
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
      'always great to see',
      'congrats on the',
      "it's vital to check",
      "it's important to check",
      'crucial to check',
      'make sure to check',
      'always do your own',
      'love to see new',
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
