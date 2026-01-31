# Railway Deployment Guide

This guide explains how to deploy AgentX/LaunchKit to Railway with PostgreSQL.

## Quick Start

1. **Create Railway Project**
   - Go to [railway.app](https://railway.app)
   - Create new project from GitHub repo

2. **Add PostgreSQL**
   - Click "New" → "Database" → "PostgreSQL"
   - Railway automatically injects `DATABASE_URL`

3. **Configure Environment Variables**

### Required Variables

| Variable                | Description                       | Example                |
| ----------------------- | --------------------------------- | ---------------------- |
| `DATABASE_URL`          | Auto-injected by Railway Postgres | _(automatic)_          |
| `PORT`                  | Auto-injected by Railway          | _(automatic)_          |
| `LAUNCHKIT_ENABLE`      | Enable LaunchKit server           | `true`                 |
| `LAUNCH_ENABLE`         | Enable token launching            | `true`                 |
| `ADMIN_TOKEN`           | Admin API authentication          | Generate secure random |
| `LAUNCHKIT_ADMIN_TOKEN` | LaunchKit API auth                | Generate secure random |

### AI Provider (Required)

| Variable             | Description                  |
| -------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY`  | Claude API key               |
| `OPENAI_API_KEY`     | OpenAI key (for embeddings)  |
| `OPENROUTER_API_KEY` | OpenRouter key (alternative) |

### Solana/Pump.fun (Required for Launches)

| Variable                      | Description                      |
| ----------------------------- | -------------------------------- |
| `SOLANA_RPC_URL`              | Mainnet RPC endpoint             |
| `PUMP_PORTAL_API_KEY`         | Pump Portal API key              |
| `PUMP_PORTAL_WALLET_ADDRESS`  | Pump wallet public key           |
| `PUMP_PORTAL_WALLET_SECRET`   | Pump wallet private key (base58) |
| `AGENT_FUNDING_WALLET_SECRET` | Funding wallet private key       |

### Optional Integrations

| Variable                      | Description                  |
| ----------------------------- | ---------------------------- |
| `TELEGRAM_BOT_TOKEN`          | Telegram bot for communities |
| `TWITTER_API_KEY`             | Twitter/X posting            |
| `TWITTER_API_SECRET_KEY`      | Twitter/X secret             |
| `TWITTER_ACCESS_TOKEN`        | Twitter/X access token       |
| `TWITTER_ACCESS_TOKEN_SECRET` | Twitter/X access secret      |

## PostgreSQL Notes

### pgvector Not Available

Railway Postgres 17 may **not** have the `pgvector` extension. LaunchKit handles this gracefully:

- Automatically detects if pgvector is available
- Logs `vector=disabled` at startup
- Continues without vector embeddings
- Existing functionality works normally

To explicitly disable embeddings:

```
SQL_EMBEDDINGS_ENABLE=false
```

### Auto-Created Tables

LaunchKit automatically creates these tables on startup:

**Core Tables:**

- `launch_packs` - Token launch configurations
- `central_messages` - Message bus persistence
- `central_channels` - Channel metadata

**Scheduling Tables (`sched_*`):**

- `sched_tg_posts` - Telegram scheduled posts
- `sched_x_tweets` - X/Twitter scheduled tweets
- `sched_x_marketing` - X marketing campaign schedules
- `sched_x_usage` - X API rate limit tracking
- `sched_trend_pool` - Detected trends pool
- `sched_community_prefs` - Community voting preferences
- `sched_community_feedback` - Idea feedback from community
- `sched_pending_votes` - Active voting sessions
- `sched_system_metrics` - System metrics, banned users, failed attempts

**PnL Tables (`pnl_*`):**

- `pnl_trades` - Trade history (buys/sells)
- `pnl_positions` - Current token positions
- `pnl_sol_flows` - SOL in/out tracking
- `pnl_summary` - Aggregate P&L summary

No manual SQL or SSH required. See [POSTGRESQL_ARCHITECTURE.md](./POSTGRESQL_ARCHITECTURE.md) for full schema details.

## Health Endpoint

After deployment, verify with:

```bash
curl https://your-app.up.railway.app/health
```

Response:

```json
{
  "ok": true,
  "uptime": 123.45,
  "launchkit": true,
  "db": {
    "mode": "postgres",
    "ready": true,
    "vectorEnabled": false,
    "centralDbReady": true,
    "launchPacksReady": true
  },
  "env": {
    "LAUNCHKIT_ENABLE": true,
    "TREASURY_ENABLE": false,
    "AUTO_WITHDRAW_ENABLE": false,
    "AUTO_SELL_ENABLE": false
  }
}
```

## Startup Logs

Successful Railway startup shows:

```
[LaunchKit] 🚂 Railway environment detected
[LaunchKit]   - PORT: 3000
[LaunchKit]   - DATABASE_URL: set
[LaunchKit]   - Public URL: https://your-app.up.railway.app
[StoreFactory] Using PostgreSQL (DATABASE_URL detected)
[RailwayReady] ✓ pgcrypto extension installed
[RailwayReady] vector extension not available - embeddings will use fallback storage
[RailwayReady] ✓ central_messages schema ensured
[RailwayReady] DB Status: mode=postgres, vector=disabled, central_db=ready, launch_packs=ready
[LaunchKit] Server listening on 0.0.0.0:3000
```

## Troubleshooting

### "Failed query: insert into central_messages"

The `central_messages` table is auto-created on startup. If you see this error:

1. Check Railway logs for schema creation errors
2. Verify `DATABASE_URL` is set correctly
3. Restart the service (tables are created on boot)

### "generate fallback to prompt (err=No handler found for delegate type: undefined)"

This is a benign warning from @elizaos core when processing messages. It does not affect functionality.

### "Could not install pgcrypto/vector"

These are warnings, not errors. LaunchKit continues normally without these extensions.

## Security Reminders

- **Never** store private keys in Postgres
- Use Railway's encrypted environment variables for secrets
- Keep `TREASURY_LOG_ONLY=true` until ready for production transfers
- Generate unique `ADMIN_TOKEN` and `LAUNCHKIT_ADMIN_TOKEN` values
- **Note**: If both tokens are set, `LAUNCHKIT_ADMIN_TOKEN` takes priority
- Use `x-admin-token` header for API authentication (not Bearer)
