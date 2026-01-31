# Twitter Plugin Integration

## Overview

The XPublisherService and publishXAction have been refactored to use the `@elizaos/plugin-twitter` client instead of direct Twitter API calls. This provides better integration with ElizaOS's plugin architecture and maintains consistency with the Telegram plugin approach.

## Changes Made

### 1. XPublisherService (`src/launchkit/services/xPublisher.ts`)

- **Removed**: Custom `postTweet()` function with manual Twitter API calls
- **Added**: `TwitterClient` interface for type safety
- **Added**: `twitterClient` property to store the plugin's client
- **Added**: `setTwitterClient()` method to inject the plugin client
- **Updated**: `publish()` method to use `this.twitterClient.sendTweet()` instead of custom API calls
- **Updated**: Error handling to check for client availability

Key changes:

```typescript
// Before: Manual API calls
const idStr = await postTweet(env, mainText);

// After: Plugin client
const result = await this.twitterClient.sendTweet(mainText);
const idStr = result?.id || result?.data?.id || String(result);
```

### 2. publishXAction (`src/launchkit/eliza/publishActions.ts`)

- **Added**: Twitter service retrieval from runtime
- **Added**: Client injection into XPublisherService before publishing
- **Added**: Better error messaging when plugin is not available

Key changes:

```typescript
// Get Twitter client from plugin
const twitterService = runtime.getService("twitter") as any;
if (!twitterService?.twitterClient) {
  throw new Error(
    "Twitter plugin not available. Ensure @elizaos/plugin-twitter is loaded and configured.",
  );
}
xPublisher.setTwitterClient(twitterService.twitterClient);
```

### 3. Character Configuration (`src/character.ts`)

The Twitter plugin is conditionally loaded when credentials are available:

```typescript
plugins: [
  ...(process.env.TWITTER_API_KEY?.trim() &&
  process.env.TWITTER_API_SECRET_KEY?.trim()
    ? ["@elizaos/plugin-twitter"]
    : []),
];
```

### 4. Environment Configuration (`.env`)

Updated to include Twitter API credentials required by the plugin:

```bash
# Twitter Plugin Configuration
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET_KEY=your_api_secret_key_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret_here

# Enable X publishing
X_ENABLE=true
TWITTER_DRY_RUN=false
TWITTER_ENABLE_POSTING=true
```

## Benefits

1. **Consistency**: Matches the Telegram plugin architecture approach
2. **Maintained**: Twitter client is maintained by the ElizaOS team
3. **Features**: Access to all plugin features (timeline, interactions, etc.)
4. **Type Safety**: Proper TypeScript interfaces for the client
5. **Error Handling**: Better error messages when plugin is not available

## Getting Twitter API Credentials

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Create a new Twitter App (or use an existing one)
3. Enable OAuth 1.0a authentication
4. Generate API Key & Secret (Consumer Keys)
5. Generate Access Token & Secret
6. Copy these credentials to your `.env` file

## Testing

To test the Twitter integration:

1. **Configure credentials** in `.env`:

   ```bash
   TWITTER_API_KEY=your_actual_api_key
   TWITTER_API_SECRET_KEY=your_actual_api_secret
   TWITTER_ACCESS_TOKEN=your_actual_access_token
   TWITTER_ACCESS_TOKEN_SECRET=your_actual_access_secret
   X_ENABLE=true
   ```

2. **Build and start the agent**:

   ```bash
   bun run build
   bun start
   ```

3. **Test publishing**:
   - Create a LaunchPack: "launch a token called MoonDog"
   - Publish to X: "publish to x for <launchpack_id>"
   - Or auto-publish after launch by ensuring pump.fun launch succeeds

## Architecture

```
┌─────────────────────┐
│  publishXAction     │
│  (eliza action)     │
└──────────┬──────────┘
           │
           │ 1. getService('twitter')
           ↓
┌─────────────────────┐
│ TwitterService      │
│ (@elizaos/plugin)   │
└──────────┬──────────┘
           │
           │ 2. setTwitterClient()
           ↓
┌─────────────────────┐
│ XPublisherService   │
│ (custom service)    │
└──────────┬──────────┘
           │
           │ 3. sendTweet()
           ↓
┌─────────────────────┐
│ TwitterClient       │
│ (plugin client)     │
└──────────┬──────────┘
           │
           │ 4. Twitter API v2
           ↓
     Twitter.com
```

## Fallback Behavior

If the Twitter plugin is not loaded or credentials are missing:

- The plugin won't load (conditional in character.ts)
- Publishing will fail with clear error message
- Other LaunchPack operations continue to work normally
- Telegram publishing still works independently

## Next Steps

1. ✅ Install `@elizaos/plugin-twitter` package
2. ✅ Refactor XPublisherService to use plugin client
3. ✅ Update publishXAction to inject plugin client
4. ✅ Update character.ts with conditional plugin loading
5. ✅ Update .env with Twitter API credentials placeholders
6. ✅ Get Twitter API credentials from Developer Portal
7. ✅ Test full launch → auto-publish flow
8. ✅ Verify tweets are posted correctly with LaunchPack content

---

## X Marketing Features

### Data Persistence

All X/Twitter scheduling data persists to PostgreSQL when `DATABASE_URL` is set:

| Data                | PostgreSQL Table    | Description                      |
| ------------------- | ------------------- | -------------------------------- |
| Scheduled tweets    | `sched_x_tweets`    | All pending/posted/failed tweets |
| Marketing schedules | `sched_x_marketing` | Per-token campaign settings      |
| Rate limiting       | `sched_x_usage`     | API usage tracking per month     |

**Survives restarts:** Yes - scheduled tweets are restored after Railway redeploys.

**Local Development:** Falls back to JSON files in `./data/`.

Services require async initialization:

- `initXScheduler()` - Tweet scheduling
- `initXRateLimiter()` - Rate limit tracking

See [POSTGRESQL_ARCHITECTURE.md](./POSTGRESQL_ARCHITECTURE.md) for full details.

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

View remaining posts for the month (Free tier = 500/month):

```
User: "check x quota"
Agent: "📊 X Posting Quota: 45/500 used this month"
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

### Free Tier Limits

- 500 tweets per month
- **1 tweet per token per day** (conservative scheduling)
- Tracked in `data/x_usage.json`
- Auto-refill limit: 2 tweets per day per token

### Rate Limiter Features

- Automatic daily/monthly tracking
- Warns when approaching limits
- Blocks posts when quota exceeded
- Resets on new month

```typescript
const advice = getPostingAdvice();
if (!advice.canPost) {
  // "Rate limited: 500/500 monthly limit reached"
}
```

---

## Scheduled Tweet Storage

Tweets stored in `data/x_scheduled_tweets.json`:

```json
{
  "id": "uuid",
  "tokenTicker": "RUG",
  "tokenMint": "CHWDAsq6...",
  "launchPackId": "uuid",
  "type": "chart_callout",
  "text": "gm frens! Check out $RUG...",
  "scheduledFor": "2026-01-20T10:00:00Z",
  "status": "pending",
  "createdAt": "2026-01-19T20:00:00Z"
}
```

**Status values:**

- `pending` - Waiting to be posted
- `posted` - Successfully tweeted
- `failed` - Failed to post
- `cancelled` - User cancelled

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

**Cause:** Hit Twitter's rate limits (500 tweets/month on free tier).

**Fix:** Wait until monthly reset or upgrade Twitter API tier.

### Handle Not Appearing in Tweets

**Symptom:** Tweets generated without `Follow: @handle`

**Cause:** Handle not set, or schema issue.

**Fix:**

1. Set the handle: "set x handle to @yourhandle"
2. Clear pending tweets and let them regenerate
3. Verify in logs: `[XScheduler] Token $TICKER has xHandle: yourhandle`
