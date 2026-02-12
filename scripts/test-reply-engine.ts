/**
 * Reply Engine Diagnostic — dry-run one round and count API requests.
 * 
 * Usage: bun run scripts/test-reply-engine.ts
 * 
 * Shows:
 *   - Rate limiter state (reads/writes used, remaining, backoff status)
 *   - Reply engine status (running, replies today, tracked count)
 *   - Shared data (cached mentions, engager counts, perf queue)
 *   - Then runs ONE round of findCandidates (real API call) and shows what it found
 *   - Runs the filters on those candidates so you can see what gets through
 */

import { getQuota, getUsageSummary, isRateLimited, isReadRateLimited, getPostingAdvice, getDailyWritesRemaining } from '../src/launchkit/services/xRateLimiter.ts';
import { getReplyEngineStatus, getTopEngagers, getLastMentions, getPerfResults } from '../src/launchkit/services/xReplyEngine.ts';
import { canPostToX } from '../src/launchkit/services/novaPersonalBrand.ts';

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  NOVA REPLY ENGINE DIAGNOSTIC');
  console.log('═══════════════════════════════════════════════\n');

  // ── Rate Limiter State ──
  console.log('── Rate Limiter ──');
  const quota = getQuota();
  console.log(`  Month:            ${quota.month}`);
  console.log(`  Writes:           ${quota.writes.used} / ${quota.writes.limit}  (${quota.writes.remaining} remaining)`);
  console.log(`  Reads:            ${quota.reads.used} / ${quota.reads.limit}  (${quota.reads.remaining} remaining)`);
  console.log(`  Daily writes left: ${getDailyWritesRemaining()}`);
  console.log(`  Last write:       ${quota.lastWrite || 'none'}`);
  console.log(`  429 backoff:      ${isRateLimited() ? '🔴 ACTIVE' : '🟢 clear'}`);
  console.log(`  Read rate limited: ${isReadRateLimited() ? '🔴 ACTIVE' : '🟢 clear'}`);
  
  const advice = getPostingAdvice();
  console.log(`  Can post:         ${advice.canPost ? '✅ yes' : `❌ no — ${advice.reason}`}`);
  console.log(`  Global write gate: ${canPostToX() ? '✅ open' : '⏳ cooling down'}`);
  console.log();

  // ── Reply Engine State ──
  console.log('── Reply Engine Status ──');
  const status = getReplyEngineStatus();
  console.log(`  Running:          ${status.running}`);
  console.log(`  Replies today:    ${status.repliesToday}`);
  console.log(`  Last reply:       ${status.lastReplyAt || 'never'}`);
  console.log(`  Tracked replies:  ${status.trackedCount}`);
  console.log();

  // ── Shared Data ──
  console.log('── Shared Data (cached reads) ──');
  const mentions = getLastMentions();
  console.log(`  Cached mentions:  ${mentions.mentions.length}`);
  console.log(`  Last fetch:       ${mentions.fetchedAt ? new Date(mentions.fetchedAt).toISOString() : 'never'}`);
  
  const engagers = getTopEngagers(1);
  console.log(`  Engager count:    ${engagers.length} unique`);
  if (engagers.length > 0) {
    console.log(`  Top 5 engagers:`);
    for (const e of engagers.slice(0, 5)) {
      console.log(`    ${e.authorId}: ${e.count} mentions`);
    }
  }
  
  const perfResults = getPerfResults();
  console.log(`  Perf results:     ${perfResults.size} tweets checked`);
  console.log();

  // ── Usage Summary (formatted) ──
  console.log('── Full Usage Summary ──');
  console.log(getUsageSummary());
  console.log();

  // ── Dry-run: show what one round would do ──
  console.log('── Dry Run: Candidate Discovery ──');
  console.log('  (This will make 1 real API call to test connectivity)\n');
  
  try {
    const { getTwitterReader } = await import('../src/launchkit/services/xPublisher.ts');
    const reader = getTwitterReader();
    
    if (!reader.isReady()) {
      console.log('  ❌ Twitter client not ready (missing credentials?)');
      console.log('  Check: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET');
      return;
    }

    console.log('  Twitter client: ✅ ready');
    
    // Check quota before making a call
    const preQuota = getQuota();
    console.log(`  Pre-call reads: ${preQuota.reads.used}`);
    
    // Try mentions (just 5 to minimize cost)
    console.log('  Fetching mentions (limit: 5)...');
    try {
      const rawMentions = await reader.getMentions(5);
      const postQuota = getQuota();
      console.log(`  Post-call reads: ${postQuota.reads.used} (+${postQuota.reads.used - preQuota.reads.used})`);
      console.log(`  Mentions returned: ${rawMentions.length}`);
      
      if (rawMentions.length > 0) {
        console.log('\n  ── Candidates (with filter results) ──');
        for (const m of rawMentions) {
          const textPreview = m.text.slice(0, 80).replace(/\n/g, ' ');
          console.log(`\n  Tweet: "${textPreview}${m.text.length > 80 ? '...' : ''}"`);
          console.log(`    ID: ${m.id} | Author: ${m.authorId || 'unknown'}`);
          
          // Run spam check
          const lower = m.text.toLowerCase();
          const SPAM_PATTERNS = [
            'dm me', 'check your dm', 'check dm', 'sent you a dm', "let's connect",
            'follow me', 'follow back', 'f4f', 'like and retweet', 'rt and follow',
            'claim your', 'connect wallet', 'validate your wallet', 'guaranteed profit',
            'send sol to', 'send eth to', 'free airdrop claim', 'claim now',
            'grow your account', 'marketing services', 'book a call', 'link in bio',
            'nice project', 'great project', 'amazing project', 'check out my',
            'looks promising sir', 'drop your wallet', 'tag 3 friends',
            'sponsored', 'ad:', '#ad ', 'limited time offer', 'use code',
            'shop now', 'buy now', 'order now', 'free shipping',
          ];
          const spamMatch = SPAM_PATTERNS.find(p => lower.includes(p));
          if (spamMatch) {
            console.log(`    🚫 SPAM — matched: "${spamMatch}"`);
          } else {
            console.log(`    ✅ Not spam`);
          }
          
          // Run relevance check (mentions are always relevant by default)
          console.log(`    ✅ Relevant (mention — auto-pass)`);
        }
      }
    } catch (err: any) {
      console.log(`  ❌ Mentions failed: ${err.message}`);
      if (err.message?.includes('429')) {
        console.log('  → Rate limited. The 429 backoff will pause retries.');
      }
    }
    
  } catch (err: any) {
    console.log(`  ❌ Could not initialize Twitter client: ${err.message}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('  DONE — API calls made: 1 (getMentions)');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
