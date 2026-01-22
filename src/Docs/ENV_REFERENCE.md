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

| Variable       | Default | Description                        |
| -------------- | ------- | ---------------------------------- |
| `TG_ENABLE`    | -       | Enable Telegram integration        |
| `TG_BOT_TOKEN` | -       | Telegram bot token from @BotFather |
| `TG_CHAT_ID`   | -       | Default chat ID                    |

---

## X/Twitter

| Variable                      | Default | Description                     |
| ----------------------------- | ------- | ------------------------------- |
| `X_ENABLE`                    | -       | Enable X/Twitter integration    |
| `TWITTER_API_KEY`             | -       | OAuth 1.0a API key              |
| `TWITTER_API_SECRET_KEY`      | -       | OAuth 1.0a API secret           |
| `TWITTER_ACCESS_TOKEN`        | -       | OAuth 1.0a access token         |
| `TWITTER_ACCESS_TOKEN_SECRET` | -       | OAuth 1.0a access secret        |
| `X_MONTHLY_WRITE_LIMIT`       | `500`   | Monthly tweet limit (Free tier) |
| `X_MONTHLY_READ_LIMIT`        | `100`   | Monthly read limit              |

**Note**: Regenerate access tokens after changing app permissions.

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

# ================================
# X/TWITTER
# ================================
X_ENABLE=true
TWITTER_API_KEY=your-api-key
TWITTER_API_SECRET_KEY=your-api-secret
TWITTER_ACCESS_TOKEN=your-access-token
TWITTER_ACCESS_TOKEN_SECRET=your-access-secret

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
```

---

## See Also

- [TREASURY_GUARDRAILS.md](TREASURY_GUARDRAILS.md) - Treasury security
- [AUTO_TRADING.md](AUTO_TRADING.md) - Auto-sell configuration
- [TWITTER_PLUGIN_INTEGRATION.md](TWITTER_PLUGIN_INTEGRATION.md) - X/Twitter setup
- [WALLET_SETUP.md](WALLET_SETUP.md) - Wallet configuration
