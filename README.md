# Nova v1

**Autonomous Meme Token Launch Agent**

Nova is an AI agent specialized in pump.fun token launches with full automation - from token creation to community management and marketing.

## Key Features

### 🚀 Token Launch

- **Pump.fun Integration**: Deploy tokens directly to pump.fun with automated dev buys
- **Dual Wallet System**: Autonomous funding from your Phantom wallet → pump.fun launches
- **Safety Controls**: Slippage limits, dev buy caps, transparent auditing
- **Auto-Funding**: Agent deposits SOL to pump wallet automatically before launches

### 📱 Telegram Community Management

- **Multi-Token Groups**: Each token can have its own linked Telegram group
- **Mascot Personas**: Each token can have a unique mascot personality
- **Scam Detection**: Auto-warns/kicks scammers with pattern detection
- **Group Verification**: Auto-detects admin status and invite links
- **Moderation Tools**: Kick, mute, ban commands with user lookup

### 🐦 X/Twitter Marketing

- **Smart Tweet Generation**: AI-powered marketing tweets with templates
- **URL Preservation**: Smart truncation that keeps pump.fun/Telegram links intact
- **Rate Limiting**: Tracks Free Tier quota (500 writes/month)
- **Scheduled Tweets**: Schedule marketing content in advance
- **Standalone Client**: Write-only (no polling to burn read quota)

### 🧠 Intelligent Actions

- **38+ Built-in Actions**: From token creation to community moderation
- **Context-Aware**: Understands which token you're discussing
- **Conversation Intelligence**: Refines concepts, guides strategy

### 🚂 Railway Deployment

- **PostgreSQL Persistence**: All data survives restarts on Railway
- **Auto-Schema Creation**: Tables created automatically on first boot
- **Hybrid Storage**: PostgreSQL primary, JSON file fallback for local dev
- **17 Database Tables**: Scheduling, metrics, PnL tracking, community voting

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
```

### 4. Configure Twitter/X (Optional)

```bash
# OAuth 1.0a credentials from developer.twitter.com
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_secret
X_ENABLE=true
X_MONTHLY_WRITE_LIMIT=500  # Free tier
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
┌─────────────────────────────────────────────────────────────────┐
│                         Nova v1                                 │
├─────────────────────────────────────────────────────────────────┤
│  Character: Nova (Default) / Token Mascots (in TG groups)      │
├─────────────────┬───────────────────┬───────────────────────────┤
│   52+ Actions   │    Services       │       Database            │
├─────────────────┼───────────────────┼───────────────────────────┤
│ • Wallet Mgmt   │ • FundingWallet   │ PostgreSQL (Railway)      │
│ • Token Launch  │ • PumpLauncher    │ • LaunchPacks             │
│ • TG Moderation │ • TelegramSetup   │ • Scheduled Posts (TG/X)  │
│ • X Marketing   │ • XMarketing      │ • PnL & Positions         │
│ • List Actions  │ • XScheduler      │ • System Metrics          │
│ • Scam Detection│ • TrendMonitor    │ • Community Voting        │
│ • Autonomous    │ • PnLTracker      │ • Trend Pool              │
└─────────────────┴───────────────────┴───────────────────────────┘
```

## Key Technical Features

### Scam Detection System

- Pattern-based detection for common scams (fake giveaways, DM solicitation, impersonation)
- Two-tier system: warnings for minor violations, instant kick for obvious scams
- 24-hour warning expiry
- Tracks warnings per user per chat

### Smart Tweet URL Handling

- Twitter counts all URLs as 23 chars (t.co shortening)
- Smart truncation preserves full pump.fun and Telegram links
- Truncates text content, not URLs
- Cleans up empty placeholder lines

### Multi-Token Mascot Personas

- Each LaunchPack can have a unique mascot personality
- Mascot persona used in that token's Telegram group
- Default "Nova" persona used elsewhere
- Prevents data leakage between token communities

### Rate Limiting & Quota Tracking

- Tracks X/Twitter Free Tier limits (500 writes/month)
- Persists usage data to PostgreSQL (survives Railway restarts)
- Provides quota status and posting advice
- Refuses to post when limits reached

## Costs Per Launch

| Item           | Cost                                |
| -------------- | ----------------------------------- |
| Token creation | ~0.02-0.05 SOL (pump.fun fee)       |
| Dev buy        | 0.1-0.5 SOL (your initial purchase) |
| TX fees        | ~0.001 SOL                          |
| **Total**      | **~0.3-0.6 SOL per launch**         |

## Security Notes

✅ **Safe:**

- Private key stays in your `.env` (gitignored)
- Agent runs on YOUR machine
- You control the code

❌ **Not Safe:**

- Sharing private key with others
- Committing `.env` to git
- Running untrusted agent code

## License

MIT
