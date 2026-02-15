# Nova v1

**Autonomous Meme Token Launch Agent on Solana**

Nova is a fully autonomous AI agent that launches meme tokens on pump.fun, manages communities on Telegram, builds a personal brand on X/Twitter, replies to ecosystem tweets, and tracks portfolio performance — all without human intervention.

## Key Features

### 🚀 Token Launch & Management

- **Pump.fun Integration**: Deploy tokens directly via PumpPortal SDK with automated dev buys
- **Dual Wallet System**: Funding wallet (Phantom) → pump wallet for isolated launches
- **RugCheck Safety**: Every launch verified via RugCheck API — mint revoked, freeze revoked
- **DexScreener Price Feeds**: Real-time token pricing, market cap, volume, holder data
- **PumpSwap Fee Tracking**: Monitor and report creator fees earned across launched tokens
- **Auto-Sell Policies**: Configurable take-profit, stop-loss, and sweep strategies
- **Auto-Funding**: Agent deposits SOL to pump wallet automatically before launches

### 📱 Telegram Community Management

- **Nova Channel + Community**: Dedicated broadcast channel with linked discussion group
- **Multi-Token Groups**: Each token gets its own linked Telegram group with mascot persona
- **Group Health Monitoring**: Automated activity tracking, sentiment analysis, and health reports
- **Community Voting**: Post ideas for community feedback before launching
- **Scam Detection**: Pattern-based auto-detection — warns, kicks, or bans scammers
- **AI Meme Generation**: DALL-E 3 meme images posted to groups for engagement
- **Admin Notifications**: System errors, startup/shutdown, and alerts routed to admin DM

### 🐦 X/Twitter Marketing & Personal Brand

- **Personal Brand System**: Autonomous posting schedule — GM, daily recaps, weekly summaries, market commentary, builder insights, behind-the-scenes, milestone celebrations
- **X Reply Engine**: Searches ecosystem tweets, generates data-driven replies, tags @Rugcheckxyz / @dexscreener when relevant
- **Weekly Thread Generator**: Multi-tweet X threads summarizing weekly performance
- **Narrative Arcs**: Multi-day storyline series (The Big Question, Week in the Life, Challenge Accepted, Unpopular Opinions)
- **Token Marketing**: Scheduled promotional tweets per launched token
- **Smart Rate Limiting**: Tracks Basic tier writes (500/month free) + pay-per-use read budget ($5 cap)
- **Hallucination Filters**: Content validated against real system data — blocks fabricated infrastructure or fake metrics
- **Circuit Breaker**: Pauses X posting for 1hr after 3 consecutive failures
- **Collab Tweets**: Tags ecosystem partners (@Pumpfun, @elizaOS, @Rugcheckxyz, @dexscreener, etc.)

### 🤖 Autonomous Mode

- **Scheduled Launches**: Configurable daily launch schedule with time windows
- **Reactive Launches**: Automatically creates tokens from trending topics (CryptoPanic, DexScreener boosts)
- **Trend Monitoring**: Real-time trend detection with scoring, decay, and pool management
- **Community Voting Integration**: Ideas posted for feedback before autonomous launch
- **RugCheck Pre-Launch Scan**: Every autonomous launch verified for safety

### 📊 Data-Driven Intelligence

- **Real-Time Portfolio Tracking**: P&L per token, total holdings value in SOL and USD
- **Token Snapshots**: Periodic price/volume snapshots stored in PostgreSQL
- **System Metrics**: Uptime, tweets sent, TG posts, trends detected, error rates
- **Fee Revenue Reports**: PumpSwap creator fee earnings per token and aggregate

### 🚂 Production Deployment

- **Railway Native**: PostgreSQL persistence, auto-deploy from `main` branch
- **43 Service Files**: Modular architecture — each feature isolated in its own service
- **Hybrid Storage**: PostgreSQL primary, JSON file fallback for local development
- **20+ Database Tables**: Full state persistence across restarts

## Quick Start

### 1. Install Dependencies

```bash
bun install
bun run build
```

### 2. Configure Wallets

**Export your Phantom wallet private key:**

1. Open Phantom → Settings → Security & Privacy
2. Export Private Key → Copy
3. Add to `.env`:

```bash
# Your Phantom wallet (agent's funding source)
AGENT_FUNDING_WALLET_SECRET=your_phantom_private_key

# Pump.fun wallet (for token creation)
PUMP_PORTAL_API_KEY=your_pump_api_key
PUMP_PORTAL_WALLET_ADDRESS=your_pump_wallet_address
PUMP_PORTAL_WALLET_SECRET=your_pump_wallet_secret
```

**Or generate new dedicated wallet:**

```bash
bun run scripts/generate-wallet.ts
# Add output to .env
```

📖 **Detailed Setup**: See [PHANTOM_INTEGRATION.md](src/Docs/PHANTOM_INTEGRATION.md) and [WALLET_SETUP.md](src/Docs/WALLET_SETUP.md)

### 3. Configure Telegram (Recommended)

```bash
# Get token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token
TG_BOT_TOKEN=your_bot_token  # Same token
TG_ENABLE=true

# Nova Channel (broadcast channel for launches/recaps)
NOVA_CHANNEL_ENABLE=true
NOVA_CHANNEL_ID=-100xxxxxxxxxx
NOVA_CHANNEL_INVITE=https://t.me/your_channel

# Community Group (linked discussion group)
TELEGRAM_COMMUNITY_CHAT_ID=-100xxxxxxxxxx
TELEGRAM_COMMUNITY_LINK=https://t.me/your_community

# Admin notifications (errors, startup, shutdown routed here)
ADMIN_CHAT_ID=your_user_id
ADMIN_ALERTS=true
```

### 4. Configure Twitter/X (Recommended)

```bash
# OAuth 1.0a credentials from developer.twitter.com
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_secret
X_ENABLE=true
X_USER_ID=your_numeric_user_id    # Required for mention detection

# Rate limiting
X_MONTHLY_WRITE_LIMIT=500         # Basic tier free writes
X_READ_BUDGET_USD=5.0             # Pay-per-use read budget cap

# Reply Engine
X_REPLY_ENGINE_ENABLE=true
X_REPLY_MAX_PER_DAY=10
X_REPLY_INTERVAL_MINUTES=38

# Personal Brand
NOVA_PERSONAL_X_ENABLE=true
NOVA_PERSONAL_TG_ENABLE=true
NOVA_GM_POST_TIME=09:00           # UTC
NOVA_RECAP_POST_TIME=22:00        # UTC
```

### 5. Configure AI Services

```bash
OPENAI_API_KEY=your_openai_key    # gpt-4o-mini for content, DALL-E 3 for images
AI_LOGO_ENABLE=true
AI_MEME_ENABLE=true
```

### 5. Verify Configuration

```bash
bun run scripts/check-wallet.ts
```

### 6. Start Agent

```bash
elizaos dev
```

## Documentation

| Document                                                                | Description                       |
| ----------------------------------------------------------------------- | --------------------------------- |
| [QUICKSTART.md](src/Docs/QUICKSTART.md)                                 | Quick reference guide             |
| [ENV_REFERENCE.md](src/Docs/ENV_REFERENCE.md)                           | All environment variables         |
| [RAILWAY_DEPLOYMENT.md](src/Docs/RAILWAY_DEPLOYMENT.md)                 | Railway + PostgreSQL deployment   |
| [POSTGRESQL_ARCHITECTURE.md](src/Docs/POSTGRESQL_ARCHITECTURE.md)       | Database schema & persistence     |
| [API_ENDPOINTS.md](src/Docs/API_ENDPOINTS.md)                           | REST API reference (port 8787)    |
| [TELEGRAM_GUIDE.md](src/Docs/TELEGRAM_GUIDE.md)                         | Telegram bot setup & features     |
| [TWITTER_PLUGIN_INTEGRATION.md](src/Docs/TWITTER_PLUGIN_INTEGRATION.md) | X/Twitter integration details     |
| [AUTONOMOUS_MODE.md](src/Docs/AUTONOMOUS_MODE.md)                       | Autonomous launches & trends      |
| [WALLET_SETUP.md](src/Docs/WALLET_SETUP.md)                             | Complete wallet configuration     |
| [PHANTOM_INTEGRATION.md](src/Docs/PHANTOM_INTEGRATION.md)               | Using Phantom wallet              |
| [TREASURY_GUARDRAILS.md](src/Docs/TREASURY_GUARDRAILS.md)               | Treasury & security guardrails    |
| [AUTO_TRADING.md](src/Docs/AUTO_TRADING.md)                             | Auto-sell, take-profit, sweep     |
| [SOCIAL_LINKS_GUIDE.md](src/Docs/SOCIAL_LINKS_GUIDE.md)                 | Setting X handles, website, links |

## Available Actions

### Wallet Management

| Command                           | Action                                   |
| --------------------------------- | ---------------------------------------- |
| `check wallet balances`           | Shows funding + pump wallet balances     |
| `deposit 0.5 sol to pump wallet`  | Transfer SOL from funding → pump wallet  |
| `withdraw profits`                | Transfer profits back to funding wallet  |
| `withdraw to treasury`            | Send profits to treasury (if configured) |
| `show holdings`                   | Report all token holdings with P&L       |
| `sell tokens` / `report holdings` | View/sell token holdings                 |

### Token Launch

| Command                       | Action                       |
| ----------------------------- | ---------------------------- |
| `create token called MoonDog` | Create new LaunchPack        |
| `generate copy for MoonDog`   | Generate marketing content   |
| `launch MoonDog`              | Deploy to pump.fun           |
| `list launchpacks`            | Show all tokens              |
| `list launched tokens`        | Show only deployed tokens    |
| `list draft tokens`           | Show tokens not yet launched |

### Telegram Management

| Command                       | Action                     |
| ----------------------------- | -------------------------- |
| `link telegram group`         | Connect TG group to token  |
| `verify telegram for MoonDog` | Verify bot setup in group  |
| `list telegram groups`        | Show linked groups         |
| `publish to telegram`         | Post announcement to group |
| `kick [user]` / `mute [user]` | Moderation commands        |

### X/Twitter Marketing

| Command                          | Action                        |
| -------------------------------- | ----------------------------- |
| `set x handle to @mytoken`       | Set Twitter handle for token  |
| `tweet about MoonDog`            | Generate & post tweet         |
| `schedule marketing for MoonDog` | Set up tweet schedule         |
| `show scheduled tweets`          | View pending tweets           |
| `check x quota`                  | View remaining quota          |
| `regenerate scheduled tweets`    | Refresh pending tweet content |

### Utility Commands

| Command                            | Action                     |
| ---------------------------------- | -------------------------- |
| `list mascots`                     | Show token mascot personas |
| `set mascot for MoonDog to "Doge"` | Set mascot personality     |
| `rename MoonDog to SuperDog`       | Rename a token             |
| `pre-launch checklist`             | Verify launch readiness    |
| `list scam warnings`               | View warned users          |

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Nova v1                                      │
├───────────────────────────────────────────────────────────────────────────┤
│ Character: Nova (Default) / Token Mascots (in TG groups)                  │
├──────────────────┬─────────────────────┬──────────────────────────────────┤
│   52+ Actions    │   43 Services       │        Database (PostgreSQL)     │
├──────────────────┼─────────────────────┼──────────────────────────────────┤
│ • Wallet Mgmt    │ • FundingWallet     │ • LaunchPacks & Token Data       │
│ • Token Launch   │ • PumpLauncher      │ • Scheduled Posts (TG/X)         │
│ • TG Moderation  │ • TelegramSetup     │ • PnL & Token Positions          │
│ • TG Community   │ • TelegramCommunity │ • System Metrics                 │
│ • X Marketing    │ • XPublisher        │ • Community Voting               │
│ • X Replies      │ • XReplyEngine      │ • Trend Pool                     │
│ • Personal Brand │ • NovaPersonalBrand │ • RugCheck Reports               │
│ • Scam Detection │ • TelegramSecurity  │ • Token Snapshots                │
│ • Auto-Sell      │ • AutoSellPolicy    │ • X Rate Limit & Usage           │
│ • Autonomous     │ • AutonomousMode    │ • Autonomous State               │
│ • System Reports │ • SystemReporter    │ • PumpSwap Fees                  │
│ • List Actions   │ • TrendMonitor      │ • Weekly Thread Data             │
└──────────────────┴─────────────────────┴──────────────────────────────────┘
```

### Service Layer (43 services)

| Category             | Services                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token Launch**     | pumpLauncher, copyGenerator, ideaGenerator, logoGenerator, memeGenerator                                                                                                  |
| **Wallet & Finance** | fundingWallet, treasuryService, treasuryScheduler, pnlTracker, pumpswapFees                                                                                               |
| **X/Twitter**        | xPublisher, xReplyEngine, xMarketing, xScheduler, xRateLimiter                                                                                                            |
| **Personal Brand**   | novaPersonalBrand, weeklyThread, novaChannel                                                                                                                              |
| **Telegram**         | telegramPublisher, telegramCommunity, telegramMarketing, telegramScheduler, telegramSetup, telegramSecurity, telegramBanHandler, telegramUserCache, telegramHealthMonitor |
| **Safety & Data**    | rugcheck, priceService, operatorGuardrails, autoSellPolicy                                                                                                                |
| **Intelligence**     | trendMonitor, trendPool, groupHealthMonitor, communityVoting                                                                                                              |
| **Infrastructure**   | systemReporter, adminNotify, audit, redact, secrets, time, groupTracker                                                                                                   |

## Key Technical Features

### X Reply Engine

- Searches for ecosystem tweets (pump.fun, Solana, memecoins) every ~38 minutes
- Alternates between mention search (odd rounds) and keyword search (even rounds)
- Skips ALL reads on round 0 (startup) to avoid 429 rate limits
- Generates data-driven replies using gpt-4o-mini
- Auto-scans contract addresses via RugCheck and includes real safety data
- Tags @Rugcheckxyz, @dexscreener, @Pumpfun when contextually relevant
- Deduplicates via `repliedTweetIds` set (smart trim to last 500)
- Race condition guard prevents concurrent reply rounds

### Personal Brand System

- Autonomous posting schedule: GM (09:00), builder insight (12:00), community engagement (15:00), personality tweet (20:00), daily recap (22:00)
- Content types: gm, daily_recap, weekly_summary, market_commentary, builder_insight, behind_scenes, milestone, hot_take, market_roast, ai_thoughts, degen_wisdom, trust_talk
- All prompts grounded with real data: portfolio value, token prices, system metrics, RugCheck scan counts
- Hallucination filter blocks fabricated infrastructure (Redis, Kafka, etc.) and fake performance metrics
- Narrative arcs create multi-day story series for audience engagement
- Circuit breaker pauses posting after 3 consecutive failures

### Scam Detection System

- Pattern-based detection for common scams (fake giveaways, DM solicitation, impersonation)
- Two-tier system: warnings for minor violations, instant kick for obvious scams
- 24-hour warning expiry
- Tracks warnings per user per chat

### Smart Tweet URL Handling

- Twitter counts all URLs as 23 chars (t.co shortening)
- Smart truncation preserves full pump.fun and Telegram links
- Pre-validates 280 char limit before sending
- Strips bare pump.fun/ placeholders when no mint address available

### Rate Limiting & Quota Tracking

- Tracks X/Twitter Basic tier limits (500 writes/month free)
- Pay-per-use read budget with configurable USD cap ($5 default)
- Separate cooldown tracking for mentions vs search reads
- Persists usage data to PostgreSQL (survives Railway restarts)
- Circuit breaker pauses writes after consecutive failures

### Content Safety (Hallucination Prevention)

- **Grounded Prompts**: Every GPT prompt includes real system data (portfolio, token prices, metrics)
- **Tech Stack Guardrails**: Prompts explicitly list Nova's actual stack and ban references to unused infrastructure
- **Hallucination Filter**: Post-generation regex catches fabricated infra, fake performance metrics, fake migrations
- **Engagement Bait Stripper**: Removes "what are you watching?" type questions at low follower counts
- **Generic Phrase Blocker**: Blocks canned safety advice when real RugCheck data is available

## Costs Per Launch

| Item           | Cost                                |
| -------------- | ----------------------------------- |
| Token creation | ~0.02-0.05 SOL (pump.fun fee)       |
| Dev buy        | 0.1-0.5 SOL (your initial purchase) |
| TX fees        | ~0.001 SOL                          |
| **Total**      | **~0.3-0.6 SOL per launch**         |

## External APIs

| Service                   | Purpose                                  | Rate Limits                              |
| ------------------------- | ---------------------------------------- | ---------------------------------------- |
| **OpenAI** (gpt-4o-mini)  | Content generation, tweets, replies      | Per-token billing                        |
| **OpenAI** (DALL-E 3)     | Logo & meme image generation             | Per-image billing                        |
| **X/Twitter API** (Basic) | Tweets, replies, mention/keyword search  | 500 writes/month free, reads pay-per-use |
| **DexScreener**           | Token prices, volume, market cap         | 300 req/min, 1-min cache per token       |
| **RugCheck**              | Token safety scanning                    | 20 scans/hr, 30-min cache                |
| **PumpPortal**            | Token creation, dev buys                 | Per-transaction                          |
| **CryptoPanic**           | Trending crypto news for autonomous mode | API key required                         |
| **Telegram Bot API**      | Group management, messaging              | Standard rate limits                     |

## Security Notes

✅ **Safe:**

- Private keys stay in your `.env` (gitignored)
- Agent runs on YOUR machine / Railway
- Every launch passes RugCheck — mint revoked, freeze revoked
- Wallet is public and verifiable on Solscan
- Content hallucination filters prevent fabricated claims

❌ **Not Safe:**

- Sharing private keys with others
- Committing `.env` to git
- Running untrusted agent code
- Disabling RugCheck safety checks

## License

MIT
