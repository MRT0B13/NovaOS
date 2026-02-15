# Twitter / X Integration

## Overview

Nova's X/Twitter integration includes four major subsystems:

1. **XPublisherService** — Core tweet publishing via `@elizaos/plugin-twitter`
2. **X Reply Engine** — Autonomous search-and-reply to ecosystem tweets
3. **Personal Brand System** — Scheduled personality posts (GM, recaps, commentary, threads)
4. **Token Marketing** — Scheduled promotional tweets per launched token

### Service Files

| File                                          | Purpose                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `src/launchkit/services/xPublisher.ts`        | Core tweet sending (single tweets + threads)   |
| `src/launchkit/services/xReplyEngine.ts`      | Search & reply engine for ecosystem engagement |
| `src/launchkit/services/novaPersonalBrand.ts` | Personal brand content generation & scheduling |
| `src/launchkit/services/weeklyThread.ts`      | Weekly summary thread generation               |
| `src/launchkit/services/xMarketing.ts`        | Per-token marketing campaigns                  |
| `src/launchkit/services/xScheduler.ts`        | Tweet scheduling & queue                       |
| `src/launchkit/services/xRateLimiter.ts`      | Rate limiting (writes + pay-per-use reads)     |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Nova X/Twitter System                         │
├────────────────┬───────────────────┬────────────────────────────┤
│  Reply Engine  │  Personal Brand   │  Token Marketing           │
│  (xReplyEngine)│ (novaPersonalBrand)│ (xMarketing + xScheduler) │
├────────────────┴───────────────────┴────────────────────────────┤
│                      XPublisherService                          │
│              sendTweet() / sendThread()                          │
├─────────────────────────────────────────────────────────────────┤
│                      XRateLimiter                                │
│    canWrite() / canRead() / getDailyWritesRemaining()           │
├─────────────────────────────────────────────────────────────────┤
│                   @elizaos/plugin-twitter                        │
│                    TwitterClient.sendTweet()                     │
├─────────────────────────────────────────────────────────────────┤
│                     Twitter API v2                               │
└─────────────────────────────────────────────────────────────────┘
```

## X Reply Engine

The reply engine autonomously searches for ecosystem tweets and replies with data-driven content.

### How It Works

1. **Every ~38 minutes**, runs a reply round
2. **Round 0 (startup)**: Skips ALL reads to avoid 429 rate limits from stale rate windows
3. **Odd rounds**: Search for mentions of Nova's handle
4. **Even rounds**: Search for keyword queries (pump.fun, Solana memecoins, etc.)
5. **Candidate scoring**: Filters spam, scores relevance, prioritizes ecosystem accounts
6. **GPT reply generation**: gpt-4o-mini generates a reply (MAX 200 chars, blunt & data-driven)
7. **RugCheck integration**: If a contract address is detected, auto-scans via RugCheck API and includes real safety data
8. **Deduplication**: `repliedTweetIds` Set (smart trim to last 500) prevents double-replies

### Configuration

```bash
X_REPLY_ENGINE_ENABLE=true
X_REPLY_MAX_PER_DAY=10                    # Max replies per day
X_REPLY_INTERVAL_MINUTES=38               # Minutes between rounds
X_REPLY_TARGETS=@Pumpfun,@elizaOS         # Accounts to engage with
X_REPLY_SEARCH_QUERIES=pump.fun,solana memecoin  # Search terms
X_USER_ID=1203214324086513664             # Your numeric X user ID (for mention detection)
```

### Safety Features

- **Race condition guard**: `roundInProgress` flag prevents concurrent rounds
- **Generic phrase blocker**: Blocks canned phrases like "it's vital to check RugCheck" when real data is available
- **8 blocked generic patterns**: "great to see", "love this", "let's build together", etc.
- **SKIP detection**: GPT returns "SKIP" for spam/promo tweets — engine silently skips
- **Sanitized Unicode**: Strips broken surrogate pairs that would crash PostgreSQL

### Ecosystem Tags (used sparingly)

| Tag              | When Used                     |
| ---------------- | ----------------------------- |
| @Pumpfun         | Tweet about pump.fun launches |
| @Rugcheckxyz     | Token safety discussions      |
| @dexscreener     | Chart/price data              |
| @elizaOS         | AI agent framework            |
| @JupiterExchange | Solana DEX topics             |
| @aixbt_agent     | AI agent peer engagement      |

---

## Personal Brand System

Nova posts personality content on a daily schedule, completely autonomously.

### Daily Schedule (UTC)

| Time   | Post Type                          | Platform |
| ------ | ---------------------------------- | -------- |
| 09:00  | GM post                            | X + TG   |
| 12:00  | Builder insight / Nova tease       | X + TG   |
| 13:00  | Collab tweet (ecosystem tag)       | X only   |
| 15:00  | Community engagement (poll or BTS) | TG only  |
| 20:00  | Personality tweet                  | X only   |
| 22:00  | Daily recap (thread on X)          | X + TG   |
| Sunday | Weekly summary thread              | X + TG   |

### Content Types

| Type                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `gm`                | Morning greeting with one data observation            |
| `daily_recap`       | End-of-day stats thread (portfolio, launches, movers) |
| `weekly_summary`    | Weekly performance thread                             |
| `market_commentary` | React to token/market data                            |
| `builder_insight`   | Lessons from launch data                              |
| `behind_scenes`     | Real system activity (grounded in actual metrics)     |
| `milestone`         | Celebrating achievements (real numbers only)          |
| `hot_take`          | Provocative crypto opinions backed by data            |
| `market_roast`      | Self-deprecating humor with real P&L numbers          |
| `ai_thoughts`       | Self-aware AI observations                            |
| `degen_wisdom`      | Lessons from launch data patterns                     |
| `trust_talk`        | Safety/transparency (real RugCheck scan data)         |
| `community_poll`    | TG reaction-based polls                               |

### Hallucination Prevention

All content passes through multiple safety layers:

1. **Grounded prompts**: Every prompt includes real portfolio value, token prices, system metrics
2. **`getSystemActivity()`**: Pulls real uptime, tweet count, reply count, snapshot count from DB
3. **Tech stack guardrails**: Prompts list actual stack (Bun, ElizaOS, PostgreSQL, DexScreener, RugCheck, pump.fun) and ban unused infra
4. **Post-generation filter**: Regex catches fabricated infrastructure (Redis, Kafka, Kubernetes, Memcached, Chainlink), fake performance metrics ("reduced X ms"), and fake system migrations
5. **Engagement bait stripper**: Removes "what are you watching?" questions nobody answers at low follower counts
6. **`trust_talk` safety data**: Pre-queries `sched_rugcheck_reports` table for real scan counts, avg risk scores, and flagged token counts

### Narrative Arcs

Multi-day story series for audience engagement (20% chance of starting on any personality slot):

- **The Big Question**: 4-part mystery reveal ("been thinking about something...")
- **Week in the Life**: 5-day diary series (grounded in actual tech stack)
- **Challenge Accepted**: 3-part public challenge with progress tracking
- **Unpopular Opinions**: 3-part escalating hot takes

### Configuration

```bash
NOVA_PERSONAL_X_ENABLE=true
NOVA_PERSONAL_TG_ENABLE=true
NOVA_GM_POST_TIME=09:00                    # UTC
NOVA_RECAP_POST_TIME=22:00                 # UTC
NOVA_WEEKLY_SUMMARY_DAY=0                  # 0=Sunday
NOVA_X_HANDLE=nova_agent_                  # Your X handle (no @)
```

### Circuit Breaker

After 3 consecutive X posting failures:

- All X posting pauses for 1 hour
- Counter resets on next successful post
- Prevents burning API quota on persistent errors

---

## Token Marketing

### Scheduled Tweet Marketing

Automatically schedule 10 tweets over 5 days after token launch:

```
User: "schedule marketing for GPTRug"
Agent: "✅ Scheduled 10 tweets over the next 5 days for $RUG"
```

**Tweet Types:**

- `chart_callout` - Price/chart updates
- `community_shoutout` - Community appreciation
- `daily_update` - Daily check-ins
- `engagement_bait` - Questions/polls
- `milestone_holders` - Holder milestones
- `meme` - Fun meme content

### View Scheduled Tweets

```
User: "show scheduled tweets"
Agent: Lists all pending scheduled tweets with times
```

### Cancel Marketing

```
User: "cancel marketing for GPTRug"
Agent: "✅ Cancelled 8 scheduled tweets for $RUG"
```

### Preview Tweet (Testing)

Generate a sample tweet without posting:

```
User: "preview a tweet"
Agent: Shows generated tweet with full URLs for verification
```

### Regenerate Scheduled Tweets

Fix broken/truncated URLs in pending tweets:

```
User: "regenerate scheduled tweets"
Agent: "✅ Regenerated 8 tweets with fresh content"
```

### Check X Quota

View remaining posts for the month (Basic tier = 500 writes/month):

```
User: "check x quota"
Agent: "📊 X Posting Quota: 45/500 used this month | Reads: $1.23/$5.00 budget used"
```

---

## Smart URL Handling

### The Problem

Twitter counts all URLs as 23 characters (via t.co shortening). AI-generated tweets were truncating URLs like:

```
https://pump.fun/coin/CHWDAsq6XE...  ❌ BROKEN
```

### The Solution

`smartTruncate()` function:

1. Detects URLs (with or without `https://`)
2. Calculates Twitter's actual character count (URLs = 23 chars)
3. Truncates **text** content, NOT URLs
4. Preserves full pump.fun, t.me, and twitter.com links

```typescript
// Before: 350 chars with truncated URL
// After: 280 chars with FULL URLs preserved
```

### AI Prompt Enhancement

The OpenAI prompt now explicitly instructs:

```
CRITICAL RULES FOR LINKS:
- ALWAYS include the FULL pump.fun URL exactly as provided
- NEVER truncate or shorten URLs
- Include CA (contract address) in every tweet
- Include Telegram link when available
```

---

## Rate Limiting

### Write Limits (Basic Tier)

- 500 tweets per month (free)
- **1 tweet per token per day** (conservative scheduling)
- Auto-refill limit: 2 tweets per day per token
- Tracked via `xRateLimiter.ts` → persisted to PostgreSQL (`sched_x_usage`)

### Read Limits (Pay-Per-Use)

- Reads are billed per-use on Basic tier
- Configurable USD budget cap: `X_READ_BUDGET_USD=5.0`
- Separate cooldown tracking for mentions vs keyword search
- Round 0 (startup) skips ALL reads to avoid 429 from stale rate windows

### Rate Limiter Functions

| Function                    | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `canWrite()`                | Check if a write is allowed               |
| `canRead()`                 | Check if a read is allowed (budget check) |
| `canReadMentions()`         | Mention-specific read check with cooldown |
| `canReadSearch()`           | Search-specific read check with cooldown  |
| `getDailyWritesRemaining()` | Remaining writes for today                |
| `getPostingAdvice()`        | Human-readable quota advice               |
| `getQuota()`                | Full quota status object                  |
| `isPayPerUseReads()`        | Whether reads are billed                  |

### Circuit Breaker

- Tracks `consecutiveXFailures` counter
- After 3 consecutive failures: pauses ALL X posting for 1 hour
- `circuitBreakerResetAt` timestamp controls when posting resumes
- Resets on next successful post

```typescript
const advice = getPostingAdvice();
if (!advice.canPost) {
  // "Rate limited: 500/500 monthly limit reached"
}
```

---

## Data Persistence

All X/Twitter data persists to PostgreSQL when `DATABASE_URL` is set:

| Data                | PostgreSQL Table         | Description                      |
| ------------------- | ------------------------ | -------------------------------- |
| Scheduled tweets    | `sched_x_tweets`         | All pending/posted/failed tweets |
| Marketing schedules | `sched_x_marketing`      | Per-token campaign settings      |
| Rate limiting       | `sched_x_usage`          | API usage tracking per month     |
| RugCheck reports    | `sched_rugcheck_reports` | Token safety scan results        |

**Survives restarts:** Yes — scheduled tweets restored after Railway redeploys.

**Local Development:** Falls back to JSON files in `./data/`.

---

## X Handle Integration

### Setting the Handle

Tell the agent to set your token's X/Twitter handle:

```
User: "set x handle to @sir_dumps"
User: "twitter handle is @mytoken"
User: "x: @tokenhandle"
```

The handle is stored in `launchPack.x.handle` and automatically included in all generated tweets.

### How It Works

1. **Storage**: Handle saved via `UPDATE_SOCIAL_LINKS` action
2. **Tweet Generation**: `buildTokenContext()` reads `launchPack.x.handle`
3. **AI Prompt**: Handle included in generation instructions
4. **Post-Processing**: `Follow: @handle` injected if AI forgets

### Example Output

```
Sir Dumps-A-Lot ($DUMP) is ready to shake up the charts! 👑
With his bags packed, it's time to ride the wave! LFG, frens! 🚀

Follow: @sir_dumps
CA: Dewdpg1yyVsHAzGvQM8t9zxynvuek6ubszY4bP6Fpump
Chart: https://pump.fun/coin/Dewdpg1yyVsHAzGvQM8t9zxynvuek6ubszY4bP6Fpump
TG: https://t.me/+YajfYqB7vO43MmM0
```

---

## Troubleshooting

### 403 Forbidden Error

**Symptom:**

```
[X] Post failed: X_FORBIDDEN
Twitter API error 403: You are not permitted to perform this action
```

**Cause:** OAuth tokens were generated before app had write permissions.

**Fix:**

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Verify app permissions are set to **"Read and write"**
3. **Regenerate Access Token and Secret** (critical - old tokens don't inherit new permissions)
4. Update `.env` with new `TWITTER_ACCESS_TOKEN` and `TWITTER_ACCESS_TOKEN_SECRET`
5. Restart the agent

### 401 Unauthorized Error

**Symptom:**

```
[X] Post failed: X_AUTH_FAILED
```

**Cause:** Invalid or expired credentials.

**Fix:**

1. Verify all 4 credentials in `.env` are correct:
   - `TWITTER_API_KEY`
   - `TWITTER_API_SECRET_KEY`
   - `TWITTER_ACCESS_TOKEN`
   - `TWITTER_ACCESS_TOKEN_SECRET`
2. Regenerate if needed from Developer Portal

### Duplicate Tweet Error

**Symptom:**

```
[X] Post failed: X_DUPLICATE
```

**Cause:** Twitter rejects identical tweets within a time window.

**Fix:** This is normal - the scheduler will retry with different content next cycle.

### Rate Limit Error

**Symptom:**

```
[X] Post failed: X_RATE_LIMIT
```

**Cause:** Hit Twitter's rate limits (500 writes/month on Basic tier, or read budget exhausted).

**Fix:** Wait until monthly reset, increase `X_READ_BUDGET_USD`, or upgrade Twitter API tier. Circuit breaker auto-pauses after 3 consecutive failures and resumes after 1 hour.

### Handle Not Appearing in Tweets

**Symptom:** Tweets generated without `Follow: @handle`

**Cause:** Handle not set, or schema issue.

**Fix:**

1. Set the handle: "set x handle to @yourhandle"
2. Clear pending tweets and let them regenerate
3. Verify in logs: `[XScheduler] Token $TICKER has xHandle: yourhandle`
