/**
 * Nova Reply Engine Anti-Spam Rules
 *
 * These rules prevent Nova from becoming a spam bot.
 * Quality over quantity: 30-50 substantive replies/day beats 500 generic ones.
 *
 * CRITICAL: These rules are non-negotiable. Violating them gets Nova
 * flagged by X's spam detection and damages reputation.
 */

import { logger } from '@elizaos/core';
import type { CommunityTarget } from './community-targets.ts';
import { getTargetConfig } from './community-targets.ts';

// ============================================================================
// Rules Configuration
// ============================================================================

export const REPLY_RULES = {
  // ── Global Rate Limits ────────────────────────────────────────────
  maxTotalRepliesPerHour: 8,          // never more than 8 replies/hour across ALL targets
  maxTotalRepliesPerDay: 50,          // hard daily cap (aim for 30-50 quality replies)
  maxRepliesToSameAccountPerDay: 2,   // never reply to same account more than 2x/day
  minTimeBetweenReplies: 300,         // 5 min minimum gap between ANY replies (seconds)
  perAccountCooldownHours: 12,        // after replying, wait 12h before replying to same account again

  // ── Content Quality Gates ─────────────────────────────────────────
  qualityThresholds: {
    mustContainData: true,            // reply MUST include a stat, metric, or specific insight
    minRelevanceScore: 0.7,           // LLM rates relevance 0-1 before posting; must be >0.7
    mustAddValue: true,               // reply must contain info NOT already in the original post
    maxReplyLength: 280,              // keep replies concise (X character limit)
    minReplyLength: 50,               // no one-liners — substantive responses only
  },

  // ── Banned Phrases ────────────────────────────────────────────────
  // If Nova's draft reply contains ANY of these, reject it and regenerate.
  noGenericPhrases: [
    'great thread', 'this is huge', 'bullish', 'love this',
    'gm', 'wagmi', 'lfg', 'based', 'ser', 'fren',
    "couldn't agree more", 'this is the way', 'so true',
    'amazing work', 'incredible', 'game changer', 'revolutionary',
    'to the moon', 'diamond hands', 'not financial advice',
    'check out our', 'follow us', 'join our community',
    'great to see', 'love to see', 'always great to see',
    "let's build together", 'transparency is key',
    "i'm always open to collaboration", 'congrats on the',
  ],

  // ── Engagement Filters ────────────────────────────────────────────
  onlyReplyToOriginalPosts: true,     // don't reply to replies (only to top-level posts/threads)
  skipIfRepliesExceed: 50,            // skip posts with 50+ replies already (Nova gets buried)
  skipIfPostOlderThanHours: 6,        // don't reply to stale posts
  skipIfAlreadyReplied: true,         // never double-reply to same post

  // ── Self-Promotion Guard ──────────────────────────────────────────
  noSelfPromotion: true,
  bannedSelfPromoPatterns: [
    /check out (nova|our agent|my agent)/i,
    /follow @?\w*nova/i,
    /nova (can|does|offers|provides)/i,
    /powered by nova/i,
    /https?:\/\/\S*nova\S*/i,
  ],

  // ── Value-Add Categories ──────────────────────────────────────────
  // Every reply MUST contain at least one of these types of value
  valueCategories: {
    intel: ['detected', 'narrative', 'shift', 'trend', 'signal', 'kol', 'mindshare'],
    safety: ['rugcheck', 'score', 'lp', 'locked', 'unlocked', 'mint authority', 'freeze', 'whale', 'holder'],
    data: ['tvl', 'volume', '%', 'sol', 'market cap', 'mcap', 'defilama', 'dexscreener'],
    insight: ['graduated', 'pump.fun', 'bonding curve', 'launch', 'deploy', 'first', 'pattern'],
  },
};

// ============================================================================
// Tracking State (in-memory, per-session)
// ============================================================================

interface ReplyRecord {
  handle: string;
  timestamp: Date;
  tweetId: string;
}

const replyLog: ReplyRecord[] = [];

/** Record a reply for rate-limit tracking */
export function recordReplyForRules(handle: string, tweetId: string): void {
  replyLog.push({ handle, timestamp: new Date(), tweetId });
  // Keep last 500 records
  if (replyLog.length > 500) {
    replyLog.splice(0, replyLog.length - 500);
  }
}

/** Get recent reply records (for external inspection) */
export function getRecentReplies(): ReplyRecord[] {
  return [...replyLog];
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a draft reply against all rules before posting.
 * Call this BEFORE every reply is sent.
 */
export function validateReply(
  draftReply: string,
  targetHandle: string,
): ValidationResult {
  const now = new Date();

  // ── Length checks ────────────────────────────────────────────────
  if (draftReply.length < REPLY_RULES.qualityThresholds.minReplyLength) {
    return { valid: false, reason: `Too short (${draftReply.length} chars, min ${REPLY_RULES.qualityThresholds.minReplyLength})` };
  }
  if (draftReply.length > REPLY_RULES.qualityThresholds.maxReplyLength) {
    return { valid: false, reason: `Too long (${draftReply.length} chars, max ${REPLY_RULES.qualityThresholds.maxReplyLength})` };
  }

  // ── Banned phrases ──────────────────────────────────────────────
  const lowerReply = draftReply.toLowerCase();
  for (const phrase of REPLY_RULES.noGenericPhrases) {
    if (lowerReply.includes(phrase.toLowerCase())) {
      return { valid: false, reason: `Contains banned phrase: "${phrase}"` };
    }
  }

  // ── Self-promotion ──────────────────────────────────────────────
  if (REPLY_RULES.noSelfPromotion) {
    for (const pattern of REPLY_RULES.bannedSelfPromoPatterns) {
      if (pattern.test(draftReply)) {
        return { valid: false, reason: `Self-promotion detected: ${pattern}` };
      }
    }
  }

  // ── Value-add check ─────────────────────────────────────────────
  // Reply must contain at least one value indicator
  if (REPLY_RULES.qualityThresholds.mustContainData) {
    const allIndicators = Object.values(REPLY_RULES.valueCategories).flat();
    const hasValue = allIndicators.some(kw => lowerReply.includes(kw.toLowerCase()));
    if (!hasValue) {
      return { valid: false, reason: 'Reply lacks data/intel/safety value — must contain at least one value indicator' };
    }
  }

  // ── Per-account cooldown ────────────────────────────────────────
  const recentToSameAccount = replyLog.filter(
    r => r.handle.toLowerCase() === targetHandle.toLowerCase() &&
      now.getTime() - r.timestamp.getTime() < REPLY_RULES.perAccountCooldownHours * 60 * 60 * 1000,
  );
  if (recentToSameAccount.length >= REPLY_RULES.maxRepliesToSameAccountPerDay) {
    return { valid: false, reason: `Already replied to @${targetHandle} ${recentToSameAccount.length}x today` };
  }

  // ── Per-account daily max from community targets config ─────────
  const config = getTargetConfig(targetHandle);
  if (config) {
    const todayToTarget = replyLog.filter(
      r => r.handle.toLowerCase() === targetHandle.toLowerCase() &&
        r.timestamp.toDateString() === now.toDateString(),
    );
    if (todayToTarget.length >= config.target.maxRepliesPerDay) {
      return { valid: false, reason: `Target @${targetHandle} daily cap reached (${todayToTarget.length}/${config.target.maxRepliesPerDay})` };
    }
  }

  // ── Global hourly rate ──────────────────────────────────────────
  const lastHour = replyLog.filter(
    r => now.getTime() - r.timestamp.getTime() < 60 * 60 * 1000,
  );
  if (lastHour.length >= REPLY_RULES.maxTotalRepliesPerHour) {
    return { valid: false, reason: `Hourly cap reached (${lastHour.length}/${REPLY_RULES.maxTotalRepliesPerHour})` };
  }

  // ── Global daily rate ───────────────────────────────────────────
  const today = replyLog.filter(r => r.timestamp.toDateString() === now.toDateString());
  if (today.length >= REPLY_RULES.maxTotalRepliesPerDay) {
    return { valid: false, reason: `Daily cap reached (${today.length}/${REPLY_RULES.maxTotalRepliesPerDay})` };
  }

  // ── Minimum gap between replies ─────────────────────────────────
  if (replyLog.length > 0) {
    const lastReply = replyLog.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    const secondsSinceLast = (now.getTime() - lastReply.timestamp.getTime()) / 1000;
    if (secondsSinceLast < REPLY_RULES.minTimeBetweenReplies) {
      return { valid: false, reason: `Too soon since last reply (${Math.round(secondsSinceLast)}s, min ${REPLY_RULES.minTimeBetweenReplies}s)` };
    }
  }

  return { valid: true };
}

/**
 * Check if a post is too old or too crowded for a reply to be effective.
 */
export function shouldSkipPost(opts: {
  replyCount?: number;
  postAgeHours?: number;
  isReply?: boolean;
}): ValidationResult {
  if (REPLY_RULES.onlyReplyToOriginalPosts && opts.isReply) {
    return { valid: false, reason: 'Post is a reply (only replying to original posts)' };
  }
  if (opts.replyCount && opts.replyCount >= REPLY_RULES.skipIfRepliesExceed) {
    return { valid: false, reason: `Post has ${opts.replyCount} replies (max ${REPLY_RULES.skipIfRepliesExceed})` };
  }
  if (opts.postAgeHours && opts.postAgeHours >= REPLY_RULES.skipIfPostOlderThanHours) {
    return { valid: false, reason: `Post is ${opts.postAgeHours.toFixed(1)}h old (max ${REPLY_RULES.skipIfPostOlderThanHours}h)` };
  }
  return { valid: true };
}
