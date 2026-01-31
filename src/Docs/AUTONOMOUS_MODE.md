# Autonomous Mode Guide

Nova can autonomously generate and launch tokens without human intervention. This guide covers the hybrid scheduled + reactive approach.

## Overview

Autonomous mode operates in two complementary ways:

| Mode          | Trigger                  | Use Case                         |
| ------------- | ------------------------ | -------------------------------- |
| **Scheduled** | Daily at set time        | Consistent, predictable launches |
| **Reactive**  | Trending topics detected | Capitalize on viral moments      |

Both modes respect the same guardrails: dry run, SOL balance checks, daily limits.

---

## Quick Start

### 1. Enable Autonomous Mode

```env
# Enable autonomous launching
AUTONOMOUS_ENABLE=true

# Daily launch time (UTC)
AUTONOMOUS_SCHEDULE=14:00

# Max scheduled launches per day
AUTONOMOUS_MAX_PER_DAY=1

# Min wallet balance to launch
AUTONOMOUS_MIN_SOL=0.3

# Dev buy amount per launch
AUTONOMOUS_DEV_BUY_SOL=0.01

# Use Nova's channel as community (recommended)
AUTONOMOUS_USE_NOVA_CHANNEL=true

# SAFETY: Keep this true until you're ready for real launches
AUTONOMOUS_DRY_RUN=true
```

### 2. Enable Reactive Mode (Optional)

```env
# Enable trend-reactive launches
AUTONOMOUS_REACTIVE_ENABLE=true

# Max reactive launches per day (in addition to scheduled)
AUTONOMOUS_REACTIVE_MAX_PER_DAY=2

# Minimum trend score to trigger (0-100)
AUTONOMOUS_REACTIVE_MIN_SCORE=70
```

### 3. Configure Trend Sources

```env
# CryptoPanic API key (free developer tier)
# Get from: https://cryptopanic.com/developers/api/
CRYPTOPANIC_API_KEY=your_api_key_here
```

---

## Trend Sources

### DexScreener (FREE, no auth required)

Monitors top boosted Solana tokens on DexScreener.

- **Endpoint**: `/token-boosts/top/v1`
- **Rate Limit**: 60 requests/min
- **What it detects**: Tokens with high boost counts
- **Score calculation**: `50 + (boost_count / 10)`, max 100
- **Filters**: Solana only, ≥100 boosts, not previously seen

### CryptoPanic (Free Developer Tier)

Monitors trending crypto news with sentiment analysis.

- **Endpoint**: `/api/developer/v2/posts/`
- **Filters**: `rising`, `currencies=SOL`
- **What it detects**: Rising crypto news stories
- **Score calculation**: `40 + (positive_votes × 3)`, max 100
- **Filters**: Positive sentiment, low toxicity

### Manual Injection

You can manually inject a trend for immediate processing:

```typescript
import { injectTrend } from "./launchkit/services/trendMonitor";

await injectTrend({
  topic: "Elon just tweeted about Doge",
  context: "Major social media moment, high meme potential",
  score: 90, // Optional, defaults to 85
});
```

---

## How It Works

### Scheduled Mode Flow

1. **Scheduler tick** runs every 60 seconds
2. At scheduled time (e.g., 14:00 UTC), triggers launch
3. **IdeaGenerator** uses GPT-4o-mini to create token concept
4. **LogoGenerator** creates logo with DALL-E (or DiceBear fallback)
5. **LaunchPack** created with brand, assets, TG config
6. **PumpLauncher** deploys to pump.fun
7. **Nova Channel** announces the launch
8. **Admin notified** of success/failure

### Reactive Mode Flow

1. **TrendMonitor** checks every 5 minutes
2. Fetches trends from DexScreener + CryptoPanic
3. Scores each trend (0-100)
4. If score ≥ MIN_SCORE and daily limit not reached:
   - Admin notified of trend detection
   - IdeaGenerator creates contextual idea (incorporating trend)
   - Same launch flow as scheduled
5. Trend marked as "seen" to prevent re-triggering

---

## Guardrails & Safety

### Dry Run Mode

When `AUTONOMOUS_DRY_RUN=true`:

- Ideas are generated and logged
- Logos are created
- **No actual launches occur**
- Admin receives notifications of what _would_ happen

### Balance Checks

- Launch requires `AUTONOMOUS_MIN_SOL` in wallet
- Auto-fund from funding wallet if available
- Fails gracefully if insufficient funds

### Daily Limits

- Scheduled: `AUTONOMOUS_MAX_PER_DAY` (default: 1)
- Reactive: `AUTONOMOUS_REACTIVE_MAX_PER_DAY` (default: 2)
- Limits reset at midnight UTC

### Trend Deduplication

- Seen topics tracked in memory and **persisted to PostgreSQL**
- Same trend won't trigger twice
- Data survives service restarts when `DATABASE_URL` is set
- Stored in `sched_trend_pool` table

---

## Data Persistence

All autonomous mode data persists to PostgreSQL when deployed on Railway:

| Data                         | PostgreSQL Table           | Survives Restart |
| ---------------------------- | -------------------------- | ---------------- |
| Trend pool                   | `sched_trend_pool`         | ✅ Yes           |
| Community voting preferences | `sched_community_prefs`    | ✅ Yes           |
| Pending votes                | `sched_pending_votes`      | ✅ Yes           |
| Idea feedback                | `sched_community_feedback` | ✅ Yes           |
| System metrics               | `sched_system_metrics`     | ✅ Yes           |

Services initialize asynchronously to connect to PostgreSQL:

- `initPoolAsync()` - Trend pool
- `initCommunityVoting()` - Community voting

See [POSTGRESQL_ARCHITECTURE.md](./POSTGRESQL_ARCHITECTURE.md) for full details.

---

## Admin Notifications

All autonomous events are sent to your admin chat:

| Event                | Description                    |
| -------------------- | ------------------------------ |
| `idea_generated`     | 💡 New token idea created      |
| `launch_success`     | 🚀 Token launched successfully |
| `launch_failed`      | ❌ Launch failed with error    |
| `guardrail_blocked`  | 🛑 Blocked by safety check     |
| `schedule_activated` | ⏰ Scheduled launch triggered  |
| `trend_detected`     | 📈 Trend found (reactive mode) |
| `trend_triggered`    | 🔥 Reactive launch triggered   |

Configure in `.env`:

```env
ADMIN_CHAT_ID=your_telegram_user_id
ADMIN_ALERTS=withdrawal,error,autonomous,system
```

---

## Environment Variables Reference

### Scheduled Mode

| Variable                      | Default | Description                            |
| ----------------------------- | ------- | -------------------------------------- |
| `AUTONOMOUS_ENABLE`           | `false` | Enable autonomous mode                 |
| `AUTONOMOUS_SCHEDULE`         | `14:00` | Daily launch time (HH:MM UTC)          |
| `AUTONOMOUS_MAX_PER_DAY`      | `1`     | Max scheduled launches per day         |
| `AUTONOMOUS_MIN_SOL`          | `0.3`   | Min wallet balance to launch           |
| `AUTONOMOUS_DEV_BUY_SOL`      | `0.01`  | Dev buy amount per launch              |
| `AUTONOMOUS_USE_NOVA_CHANNEL` | `true`  | Use Nova's channel as community        |
| `AUTONOMOUS_DRY_RUN`          | `true`  | Generate ideas only (no real launches) |

### Reactive Mode

| Variable                          | Default | Description                    |
| --------------------------------- | ------- | ------------------------------ |
| `AUTONOMOUS_REACTIVE_ENABLE`      | `false` | Enable trend-reactive launches |
| `AUTONOMOUS_REACTIVE_MAX_PER_DAY` | `2`     | Max reactive launches per day  |
| `AUTONOMOUS_REACTIVE_MIN_SCORE`   | `70`    | Minimum trend score to trigger |

### Trend Sources

| Variable              | Default | Description                    |
| --------------------- | ------- | ------------------------------ |
| `CRYPTOPANIC_API_KEY` | –       | CryptoPanic API key (optional) |

---

## Monitoring

### Logs to Watch

```
[Autonomous] ✅ Started
[Autonomous] Scheduler tick
[Autonomous] 🚀 Starting scheduled launch
[Autonomous] 💡 Idea generated: $TICKER
[TrendMonitor] ✅ Started (checking every 5 min)
[TrendMonitor] Detected N trends
[TrendMonitor] 🔥 Triggering reactive launch
```

### Get Status

```typescript
import { getAutonomousStatus } from "./launchkit/services/autonomousMode";
import { getTrendMonitorStatus } from "./launchkit/services/trendMonitor";

const status = getAutonomousStatus();
// { enabled, dryRun, launchesToday, lastLaunch, nextScheduled }

const trendStatus = getTrendMonitorStatus();
// { enabled, lastCheck, activeTrends, triggeredToday }
```

---

## Troubleshooting

### Scheduled launch not triggering

1. Check `AUTONOMOUS_ENABLE=true`
2. Verify schedule format is `HH:MM` (e.g., `14:00`)
3. Check logs for "Scheduler tick" messages
4. Ensure wallet has sufficient SOL

### Reactive mode not detecting trends

1. Check `AUTONOMOUS_REACTIVE_ENABLE=true`
2. Verify `CRYPTOPANIC_API_KEY` is set (for news)
3. DexScreener works without auth
4. Check logs for "TrendMonitor" messages
5. Lower `AUTONOMOUS_REACTIVE_MIN_SCORE` to test

### Ideas generating but not launching

1. `AUTONOMOUS_DRY_RUN=true` prevents real launches
2. Set to `false` when ready for production
3. Ensure `OPENAI_API_KEY` is set for logo generation

### No admin notifications

1. Check `ADMIN_CHAT_ID` is your Telegram user ID (not group)
2. Ensure bot has permission to message you
3. Verify `autonomous` is in `ADMIN_ALERTS`

---

## Best Practices

1. **Start with dry run** - Test idea generation before real launches
2. **Use Nova's channel** - Consolidates community in one place
3. **Set conservative limits** - Start with 1 scheduled, 1-2 reactive per day
4. **Monitor admin alerts** - Stay informed of all activity
5. **Keep SOL buffer** - Maintain more than MIN_SOL for fees
6. **Review generated ideas** - Check quality before disabling dry run

---

## Files

| File                                       | Purpose                                    |
| ------------------------------------------ | ------------------------------------------ |
| `src/launchkit/services/autonomousMode.ts` | Main scheduler and launch logic            |
| `src/launchkit/services/trendMonitor.ts`   | Trend detection (DexScreener, CryptoPanic) |
| `src/launchkit/services/ideaGenerator.ts`  | AI token concept generation                |
| `src/launchkit/services/logoGenerator.ts`  | DALL-E / DiceBear logo generation          |
| `src/launchkit/services/adminNotify.ts`    | Telegram admin notifications               |
| `src/launchkit/services/novaChannel.ts`    | Nova's announcement channel                |
