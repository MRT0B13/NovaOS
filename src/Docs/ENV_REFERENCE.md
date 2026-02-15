# 🔧 Environment Variables Reference

Complete reference for all LaunchKit environment variables.

## Quick Start (Minimum Required)

```bash
# AI Provider
OPENAI_API_KEY=sk-...

# Enable LaunchKit
LAUNCHKIT_ENABLE=true
LAUNCHKIT_ADMIN_TOKEN=your-secure-random-token

# Solana/Pump.fun (for launching)
PUMP_PORTAL_API_KEY=your-key
PUMP_PORTAL_WALLET_SECRET=your-wallet-secret
PUMP_PORTAL_WALLET_ADDRESS=your-wallet-address
AGENT_FUNDING_WALLET_SECRET=your-phantom-private-key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

---

## Core Settings

| Variable                | Default | Description                               |
| ----------------------- | ------- | ----------------------------------------- |
| `LAUNCHKIT_ENABLE`      | `false` | Enable LaunchKit server                   |
| `LAUNCHKIT_PORT`        | `8787`  | Server port                               |
| `LAUNCHKIT_ADMIN_TOKEN` | -       | API authentication token (takes priority) |
| `ADMIN_TOKEN`           | -       | Fallback API auth token                   |
| `LAUNCH_ENABLE`         | `false` | Enable token launching                    |

---

## Solana & Pump.fun

| Variable                      | Default | Description                      |
| ----------------------------- | ------- | -------------------------------- |
| `SOLANA_RPC_URL`              | mainnet | Solana RPC endpoint              |
| `PUMP_PORTAL_API_KEY`         | -       | Pump Portal API key              |
| `PUMP_PORTAL_WALLET_SECRET`   | -       | Pump wallet private key (base58) |
| `PUMP_PORTAL_WALLET_ADDRESS`  | -       | Pump wallet public key           |
| `AGENT_FUNDING_WALLET_SECRET` | -       | Funding wallet private key       |

---

## Launch Safety Limits

| Variable                  | Default | Description                        |
| ------------------------- | ------- | ---------------------------------- |
| `MAX_SOL_DEV_BUY`         | `0`     | Max SOL for dev buy (0 = disabled) |
| `MAX_PRIORITY_FEE`        | `0`     | Max priority fee (lamports)        |
| `MAX_LAUNCHES_PER_DAY`    | `0`     | Daily launch limit (0 = unlimited) |
| `LAUNCH_SLIPPAGE_PERCENT` | `10`    | Default slippage for launches      |
| `MAX_SLIPPAGE_PERCENT`    | -       | Hard cap on slippage               |
| `LOCAL_WITHDRAW_ENABLE`   | `false` | Enable local wallet withdrawals    |

---

## Database

| Variable                | Default             | Description                           |
| ----------------------- | ------------------- | ------------------------------------- |
| `DATABASE_URL`          | -                   | PostgreSQL URL (Railway auto-injects) |
| `PGLITE_PATH`           | `.pglite/launchkit` | PGlite database path                  |
| `PGLITE_DATA_DIR`       | `.pglite`           | PGlite data directory                 |
| `SQL_EMBEDDINGS_ENABLE` | `true`              | Enable vector embeddings              |

**Note**: If `DATABASE_URL` is set, uses PostgreSQL. Otherwise uses embedded PGlite.

---

## Telegram

| Variable                  | Default | Description                        |
| ------------------------- | ------- | ---------------------------------- |
| `TG_ENABLE`               | -       | Enable Telegram integration        |
| `TG_BOT_TOKEN`            | -       | Telegram bot token from @BotFather |
| `TG_CHAT_ID`              | -       | Default chat ID                    |
| `TELEGRAM_ADMIN_IDS`      | -       | Comma-separated admin user IDs     |
| `TG_WEBHOOK_SECRET`       | -       | Webhook verification secret        |
| `TG_WEBHOOK_URL`          | -       | Webhook URL for production         |
| `TG_DISABLE_AUTO_RESTART` | `false` | Disable auto-restart of TG polling |

---

## Nova Channel (Agent's Own TG Channel)

| Variable               | Default                  | Description                                 |
| ---------------------- | ------------------------ | ------------------------------------------- |
| `NOVA_CHANNEL_ENABLE`  | `false`                  | Enable Nova's personal announcement channel |
| `NOVA_CHANNEL_ID`      | -                        | Telegram channel/group ID for announcements |
| `NOVA_CHANNEL_INVITE`  | -                        | Public t.me invite link (for X marketing)   |
| `NOVA_CHANNEL_UPDATES` | `launches,wallet,health` | Comma-separated update types to post        |

**Update Types:**

- `launches` - New token launch announcements (with logo)
- `wallet` - Withdrawal/deposit notifications with tx links
- `health` - Hourly community health summaries
- `marketing` - Notifications when X/TG marketing posts go out
- `system` - Startup, shutdown, and error notifications

---

## X/Twitter

| Variable                      | Default       | Description                                             |
| ----------------------------- | ------------- | ------------------------------------------------------- |
| `X_ENABLE`                    | -             | Enable X/Twitter integration                            |
| `TWITTER_API_KEY`             | -             | OAuth 1.0a API key                                      |
| `TWITTER_API_SECRET_KEY`      | -             | OAuth 1.0a API secret                                   |
| `TWITTER_ACCESS_TOKEN`        | -             | OAuth 1.0a access token                                 |
| `TWITTER_ACCESS_TOKEN_SECRET` | -             | OAuth 1.0a access secret                                |
| `X_MONTHLY_WRITE_LIMIT`       | `500`         | Monthly tweet limit (Basic tier)                        |
| `X_MONTHLY_READ_LIMIT`        | `100`         | Fallback hard cap for reads                             |
| `X_READ_BUDGET_USD`           | `0`           | Pay-per-use read budget ($0.005/read). 0 = use hard cap |
| `X_USER_ID`                   | -             | Numeric X user ID (avoids v2.me() API call on startup)  |
| `NOVA_X_HANDLE`               | `nova_agent_` | X handle for personal brand posts                       |

**Note**: Regenerate access tokens after changing app permissions.

---

## X Reply Engine

| Variable                   | Default       | Description                               |
| -------------------------- | ------------- | ----------------------------------------- |
| `X_REPLY_ENGINE_ENABLE`    | `false`       | Enable automated X reply engine           |
| `X_REPLY_MAX_PER_DAY`      | `10`          | Max replies per day                       |
| `X_REPLY_INTERVAL_MINUTES` | `60`          | Minutes between reply rounds              |
| `X_REPLY_TARGETS`          | _(see below)_ | Comma-separated X accounts to reply to    |
| `X_REPLY_SEARCH_QUERIES`   | _(see below)_ | Comma-separated search queries for tweets |

**Default targets:** `pumpdotfun,DexScreener,JupiterExchange,elizaOS,RugCheckXYZ,aixbt_agent`
**Default queries:** `pump.fun launched,pump.fun graduated,solana meme token,rugcheck`

---

## X Scheduler (Auto-Tweet Tuning)

| Variable                        | Default | Description                        |
| ------------------------------- | ------- | ---------------------------------- |
| `X_AUTO_TWEETS_PER_DAY`         | `2`     | Auto-tweets per day per token      |
| `X_MIN_PENDING_TWEETS`          | `5`     | Refill threshold for pending queue |
| `X_REFILL_DAYS`                 | `3`     | Generate tweets for N days ahead   |
| `X_CHANNEL_PROMO_INTERVAL_DAYS` | `1`     | Days between TG channel promos     |
| `X_MIN_PENDING_CHANNEL_PROMOS`  | `7`     | Min pending channel promo tweets   |
| `TOKEN_X_MARKETING_ENABLE`      | `true`  | Enable per-token X marketing       |
| `TOKEN_TG_MARKETING_ENABLE`     | `true`  | Enable per-token TG marketing      |

---

## Nova Personal Brand

| Variable                          | Default | Description                          |
| --------------------------------- | ------- | ------------------------------------ |
| `NOVA_PERSONAL_X_ENABLE`          | `false` | Enable personal X posts (gm, recaps) |
| `NOVA_PERSONAL_TG_ENABLE`         | `false` | Enable personal TG channel posts     |
| `NOVA_GM_POST_TIME`               | `08:00` | GM post time (UTC)                   |
| `NOVA_RECAP_POST_TIME`            | `22:00` | Daily recap post time (UTC)          |
| `NOVA_WEEKLY_SUMMARY_DAY`         | `0`     | Weekly summary day (0=Sunday)        |
| `SCHEDULED_IDEA_FEEDBACK_MINUTES` | `60`    | Minutes between idea feedback posts  |

---

## Nova Community Group

| Variable                     | Default | Description                              |
| ---------------------------- | ------- | ---------------------------------------- |
| `TELEGRAM_COMMUNITY_CHAT_ID` | -       | TG group for community voting/discussion |
| `TELEGRAM_COMMUNITY_LINK`    | -       | Public invite link for X CTAs            |

---

## Community Voting

| Variable                              | Default | Description                            |
| ------------------------------------- | ------- | -------------------------------------- |
| `COMMUNITY_VOTING_ENABLED`            | `false` | Enable community voting on ideas       |
| `COMMUNITY_VOTING_WINDOW_MINUTES`     | `30`    | Voting window duration                 |
| `COMMUNITY_VOTING_MIN_VOTES`          | `3`     | Min votes for quorum                   |
| `COMMUNITY_VOTING_APPROVAL_THRESHOLD` | `0.4`   | Approval ratio threshold (0-1)         |
| `COMMUNITY_VOTING_CONFIDENCE_SKIP`    | `0.95`  | Skip voting if confidence exceeds this |

---

## RugCheck

| Variable           | Default | Description                                            |
| ------------------ | ------- | ------------------------------------------------------ |
| `RUGCHECK_API_KEY` | -       | Bearer token (optional, GET endpoints work without it) |

**Rate limits:** 20 scans/hour, 30-minute report cache, 100 max cached reports.

---

## System Reporter

| Variable                | Default | Description                    |
| ----------------------- | ------- | ------------------------------ |
| `SYSTEM_REPORTS_ENABLE` | `false` | Enable system metric reporting |

---

## AI Generation

| Variable         | Default | Description                        |
| ---------------- | ------- | ---------------------------------- |
| `OPENAI_API_KEY` | -       | OpenAI API key (for GPT-4, DALL-E) |
| `AI_LOGO_ENABLE` | `true`  | Enable DALL-E logo generation      |
| `AI_MEME_ENABLE` | `true`  | Enable AI meme generation for TG   |

---

## Treasury

| Variable                   | Default | Description                                 |
| -------------------------- | ------- | ------------------------------------------- |
| `TREASURY_ENABLE`          | `false` | Enable treasury mode                        |
| `TREASURY_ADDRESS`         | -       | Treasury wallet public key (never private!) |
| `TREASURY_MIN_RESERVE_SOL` | `0.3`   | Keep this much in pump wallet               |
| `TREASURY_LOG_ONLY`        | `true`  | Simulate without transferring               |

---

## Auto-Withdraw

| Variable                   | Default | Description                  |
| -------------------------- | ------- | ---------------------------- |
| `AUTO_WITHDRAW_ENABLE`     | `false` | Enable auto profit sweeps    |
| `WITHDRAW_MIN_SOL`         | `0.25`  | Min balance to trigger sweep |
| `WITHDRAW_KEEP_SOL`        | `0.15`  | Keep this much after sweep   |
| `WITHDRAW_MAX_SOL_PER_DAY` | `2`     | Daily withdrawal cap         |

---

## Auto-Sell

| Variable                       | Default | Description                           |
| ------------------------------ | ------- | ------------------------------------- |
| `AUTO_SELL_ENABLE`             | `false` | Enable auto-sell system               |
| `AUTO_SELL_MODE`               | `off`   | `off`, `manual_approve`, `autonomous` |
| `AUTO_SELL_POLICY_JSON`        | -       | Custom take-profit ladder JSON        |
| `AUTO_SELL_COOLDOWN_SECONDS`   | `300`   | Min seconds between sells             |
| `AUTO_SELL_MAX_PERCENT_PER_TX` | `20`    | Max % to sell per transaction         |
| `AUTO_SELL_MAX_TX_PER_HOUR`    | `10`    | Max transactions per hour             |

---

## Autonomous Mode (Experimental)

Let Nova autonomously generate and launch tokens using a hybrid approach:

- **Scheduled**: Daily launch at a set time
- **Reactive**: Event-driven launches triggered by trending topics

### Scheduled Mode

| Variable                      | Default | Description                            |
| ----------------------------- | ------- | -------------------------------------- |
| `AUTONOMOUS_ENABLE`           | `false` | Enable autonomous launching            |
| `AUTONOMOUS_SCHEDULE`         | `14:00` | Daily launch time (HH:MM UTC)          |
| `AUTONOMOUS_MAX_PER_DAY`      | `1`     | Max scheduled launches per day         |
| `AUTONOMOUS_MIN_SOL`          | `0.3`   | Min wallet balance to launch           |
| `AUTONOMOUS_DEV_BUY_SOL`      | `0.01`  | Dev buy amount per launch              |
| `AUTONOMOUS_USE_NOVA_CHANNEL` | `true`  | Use Nova's channel as community        |
| `AUTONOMOUS_DRY_RUN`          | `true`  | Generate ideas only (no real launches) |

### Reactive/Event-Driven Mode

| Variable                             | Default | Description                            |
| ------------------------------------ | ------- | -------------------------------------- |
| `AUTONOMOUS_REACTIVE_ENABLE`         | `false` | Enable trend-reactive launches         |
| `AUTONOMOUS_REACTIVE_MAX_PER_DAY`    | `3`     | Max reactive launches per day          |
| `AUTONOMOUS_REACTIVE_MIN_SCORE`      | `70`    | Minimum trend score (0-100) to trigger |
| `AUTONOMOUS_REACTIVE_COOLDOWN_HOURS` | `2`     | Hours between reactive launches        |
| `AUTONOMOUS_SCHEDULED_BUFFER_HOURS`  | `1`     | Buffer hours around scheduled launches |
| `AUTONOMOUS_REACTIVE_QUIET_START`    | `00:00` | Quiet hours start (UTC)                |
| `AUTONOMOUS_REACTIVE_QUIET_END`      | `10:00` | Quiet hours end (UTC)                  |
| `AUTONOMOUS_REACTIVE_BUSY_START`     | `12:00` | Busy hours start (UTC)                 |
| `AUTONOMOUS_REACTIVE_BUSY_END`       | `22:00` | Busy hours end (UTC)                   |

### Trend Monitor Tuning

| Variable                            | Default | Description                          |
| ----------------------------------- | ------- | ------------------------------------ |
| `TREND_POLL_INTERVAL_MINUTES`       | `30`    | Poll interval during active hours    |
| `TREND_POLL_INTERVAL_QUIET_MINUTES` | `45`    | Poll interval during quiet hours     |
| `TREND_MIN_PERSISTENCE`             | `2`     | Min sightings before trend qualifies |
| `TREND_POOL_MAX_SIZE`               | `30`    | Max trends in pool                   |
| `TREND_POOL_DECAY_PER_HOUR`         | `5`     | Score decay per hour                 |
| `TREND_POOL_MIN_SCORE`              | `40`    | Min score to keep in pool            |
| `TREND_POOL_STALE_HOURS`            | `6`     | Remove trends older than this        |

**How scheduled mode works:**

1. At the scheduled time, Nova generates a token idea using AI
2. Creates logo using DALL-E
3. Launches on pump.fun (if not in dry run mode)
4. Announces to Nova's channel
5. Marketing automation kicks in (X + TG)

**How reactive mode works:**

1. Trend monitor checks every 5 minutes for viral moments
2. Sources: DexScreener (top boosted tokens), CryptoPanic (trending news)
3. When a trend scores above MIN_SCORE, Nova generates a contextual idea
4. Launches immediately (respects MAX_PER_DAY limit)
5. Admin notified of trend detection and launch

### Trend Sources

| Variable              | Default | Description                             |
| --------------------- | ------- | --------------------------------------- |
| `CRYPTOPANIC_API_KEY` | –       | API key for CryptoPanic news (optional) |
| `CRYPTONEWS_API_KEY`  | –       | API key for CryptoNews (optional)       |

**Available Sources:**

- **DexScreener** (FREE, no key needed): Monitors top boosted Solana tokens
- **CryptoPanic** (free tier): Trending crypto news with sentiment. Get key from https://cryptopanic.com/developers/api/

**Safety:** Dry run is enabled by default - ideas are generated and logged but no real launches occur.

---

## Admin Notifications

| Variable        | Default                                | Description                       |
| --------------- | -------------------------------------- | --------------------------------- |
| `ADMIN_CHAT_ID` | –                                      | Telegram chat ID for admin alerts |
| `ADMIN_ALERTS`  | `withdrawals,errors,autonomous,system` | Alert types (comma-separated)     |

**Alert Types:**

- `withdrawal` - SOL swept to treasury destination
- `error` - Critical errors (scheduler failures, etc)
- `autonomous` - Autonomous mode events (ideas, launches, guardrails, trend triggers)
- `system` - System status updates

**Setup:**

1. Message @userinfobot on Telegram to get your chat ID
2. Set `ADMIN_CHAT_ID` to your chat ID
3. Optionally filter alerts with `ADMIN_ALERTS`

---

## Sample .env File

```bash
# ================================
# CORE
# ================================
LAUNCHKIT_ENABLE=true
LAUNCHKIT_ADMIN_TOKEN=generate-a-secure-random-string
LAUNCH_ENABLE=true

# ================================
# AI
# ================================
OPENAI_API_KEY=sk-...
AI_LOGO_ENABLE=true
AI_MEME_ENABLE=true

# ================================
# SOLANA
# ================================
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PUMP_PORTAL_API_KEY=your-key
PUMP_PORTAL_WALLET_SECRET=base58-private-key
PUMP_PORTAL_WALLET_ADDRESS=your-pump-wallet-pubkey
AGENT_FUNDING_WALLET_SECRET=your-phantom-private-key

# ================================
# TELEGRAM
# ================================
TG_ENABLE=true
TG_BOT_TOKEN=123456:ABC-DEF...
ADMIN_CHAT_ID=your-telegram-user-id

# ================================
# NOVA CHANNEL (Optional)
# ================================
NOVA_CHANNEL_ENABLE=true
NOVA_CHANNEL_ID=-1001234567890
NOVA_CHANNEL_INVITE=https://t.me/+abcdefg123456
NOVA_CHANNEL_UPDATES=launches,wallet,health,marketing,system

# ================================
# NOVA COMMUNITY GROUP (Optional)
# ================================
TELEGRAM_COMMUNITY_CHAT_ID=-1001234567891
TELEGRAM_COMMUNITY_LINK=https://t.me/+xyz789

# ================================
# X/TWITTER
# ================================
X_ENABLE=true
TWITTER_API_KEY=your-api-key
TWITTER_API_SECRET_KEY=your-api-secret
TWITTER_ACCESS_TOKEN=your-access-token
TWITTER_ACCESS_TOKEN_SECRET=your-access-secret
X_USER_ID=your-numeric-x-user-id
X_READ_BUDGET_USD=5.0

# ================================
# X REPLY ENGINE (Optional)
# ================================
X_REPLY_ENGINE_ENABLE=true
X_REPLY_MAX_PER_DAY=10
X_REPLY_INTERVAL_MINUTES=60

# ================================
# NOVA PERSONAL BRAND (Optional)
# ================================
NOVA_PERSONAL_X_ENABLE=true
NOVA_PERSONAL_TG_ENABLE=true
NOVA_X_HANDLE=nova_agent_

# ================================
# COMMUNITY VOTING (Optional)
# ================================
COMMUNITY_VOTING_ENABLED=true
COMMUNITY_VOTING_WINDOW_MINUTES=30

# ================================
# TREASURY (Optional)
# ================================
TREASURY_ENABLE=false
TREASURY_ADDRESS=your-cold-wallet-pubkey
TREASURY_MIN_RESERVE_SOL=0.3
TREASURY_LOG_ONLY=true

# ================================
# AUTO-TRADING (Disabled by default)
# ================================
AUTO_SELL_ENABLE=false
AUTO_SELL_MODE=off
AUTO_WITHDRAW_ENABLE=false

# ================================
# AUTONOMOUS (Optional)
# ================================
AUTONOMOUS_ENABLE=false
AUTONOMOUS_DRY_RUN=true
AUTONOMOUS_SCHEDULE=14:00
```

---

## See Also

- [POSTGRESQL_ARCHITECTURE.md](POSTGRESQL_ARCHITECTURE.md) - Database schema & persistence
- [AUTONOMOUS_MODE.md](AUTONOMOUS_MODE.md) - Autonomous launching configuration
- [TWITTER_PLUGIN_INTEGRATION.md](TWITTER_PLUGIN_INTEGRATION.md) - X/Twitter setup
- [TELEGRAM_GUIDE.md](TELEGRAM_GUIDE.md) - Telegram integration guide
