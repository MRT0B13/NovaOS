# Telegram & X Publishing Guide

## Current Architecture

### Multi-Token Telegram Management

Each LaunchPack can link to a separate Telegram group via `tg.chat_id`:

```typescript
{
  brand: { name: "Token A", ... },
  tg: {
    chat_id: "c3fd8872-...",           // ElizaOS roomId (UUID)
    telegram_chat_id: "-1001234567890", // Real Telegram chat_id
    invite_link: "https://t.me/+abc123", // Group invite link
    pins: { welcome: "...", how_to_buy: "...", memekit: "..." }
  }
}
```

**How it works:**

1. User creates LaunchPack for "Token A"
2. Agent asks: "Do you have a Telegram group for Token A?"
3. If yes → User adds bot to group, shares chat_id
4. Agent stores chat_id in LaunchPack
5. When publishing Token A → Agent posts to Token A's group

**Each token = separate group** managed independently by the same bot.

---

## Community Protection Features

### 🛡️ Scam Detection

The bot automatically detects and warns about common scam patterns:

| Pattern                  | Warning                       |
| ------------------------ | ----------------------------- |
| "Send X SOL to..."       | Scam detected - fund requests |
| "DM me for..."           | Likely scam - DM redirect     |
| "Admin here" (fake)      | Impersonation attempt         |
| "Airdrop claim at..."    | Phishing link                 |
| "Connect wallet at..."   | Wallet drainer                |
| "Double your tokens"     | Obvious scam                  |
| "Urgent: migrate tokens" | Fake migration                |
| "Tag me up as mod"       | Mod begging spam              |
| "Let me do shilling"     | Self-promotion spam           |

**Severity Levels:**

- `high` - Known scam patterns (fund requests, fake admins)
- `medium` - Suspicious patterns (DM redirects, urgency)
- `low` - Potential spam (mod begging, self-promotion)

### 🔨 Ban Commands

Bot admins can ban scammers directly in Telegram:

```
/ban @username
/ban 123456789
```

Reply to a message with `/ban` to ban that user.

**Requirements:**

- Bot must be admin with ban permissions
- User issuing command must be admin

### 👋 Welcome Messages

When new members join a linked Telegram group:

1. Bot detects the `new_chat_members` or `chat_member` update
2. Looks up the linked LaunchPack by `telegram_chat_id`
3. Sends a personalized welcome using the token's mascot persona

**Example welcome:**

```
Welcome to the GPTRug ($RUG) community, @newuser! 🎉

I'm here to help - ask me anything about the token!

📌 Check the pinned messages for:
• How to buy
• Official links
• Community guidelines
```

### 🎭 Mascot Persona Switching

When the bot detects it's in a linked Telegram group:

1. Loads the LaunchPack's mascot persona from `brand.mascot`
2. Switches personality to match the token's character
3. Responds in-character within that group

**Example:**

- In GPTRug group → Uses chaotic meme personality
- In Ferb group → Uses Ferb's personality
- In DMs/web → Uses default Nova personality

---

## 📢 Nova Channel (Agent's Announcement Channel)

Nova can manage its own Telegram channel for transparency and community engagement.

### What Gets Posted

| Update Type | Trigger                     | Content                                          |
| ----------- | --------------------------- | ------------------------------------------------ |
| `launches`  | Token launched on pump.fun  | Token name, ticker, pump.fun link, TG link, logo |
| `wallet`    | Treasury sweep executed     | Amount withdrawn, destination, Solscan tx link   |
| `health`    | Every hour (health monitor) | All tokens: members, sentiment, trend            |
| `marketing` | X tweet or TG post sent     | Platform, ticker, post preview                   |
| `system`    | Startup/shutdown            | Status message                                   |

### Setup

1. **Create a Telegram channel** (or use a group)
2. **Add Nova's bot as admin** with "Post Messages" permission
3. **Get the channel ID**:
   - Add `@RawDataBot` or `@getidsbot` to your channel
   - Copy the ID (starts with `-100`)
   - Remove the helper bot

4. **Configure in `.env`**:

```bash
NOVA_CHANNEL_ENABLE=true
NOVA_CHANNEL_ID=-1001234567890
NOVA_CHANNEL_INVITE=https://t.me/+abcdefg123456
NOVA_CHANNEL_UPDATES=launches,wallet,health,marketing,system
```

> **Pro Tip**: Setting `NOVA_CHANNEL_INVITE` enables channel promotion in X marketing tweets! Nova will periodically tweet about the channel to grow your community.

### Channel vs Group

- **Channel**: One-way broadcast only. Community can't chat, Nova can't respond.
- **Group**: Two-way. Community can chat, but Nova responds to everything (may be noisy).
- **Channel + Linked Discussion Group**: Best of both worlds - announcements in channel, discussion in linked group.

### Example Posts

**Launch Announcement:**

```
🚀 NEW LAUNCH: $RUG

Meet GPTRug! The token that embraces the chaos just launched on pump.fun!

📈 Trade on Pump.fun
💬 Join Telegram

#RUG #launch #pumpdotfun
```

**Health Summary:**

```
📊 Community Health Update

$RUG 📈
👥 24 members (5 active)
🟡 Sentiment: neutral

$DUMP ➡️
👥 93 members (12 active)
🟢 Sentiment: bullish

Updated 2:30 PM
```

---

## Setup Telegram Bot

### 1. Create Bot (if not done)

```bash
# Talk to @BotFather on Telegram
/newbot
# Follow prompts, save the token
```

Add to .env:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

### 2. Get Chat ID for a Group

**Option A: Using the bot**

1. Create Telegram group for your token
2. Add your bot to the group
3. Make bot an admin (so it can pin messages)
4. Send any message in the group
5. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
6. Look for `"chat":{"id":-1001234567890}` in the response
7. Copy that chat ID

**Option B: Using @userinfobot**

1. Add @userinfobot to your group
2. It will show the chat ID
3. Remove @userinfobot after

### 3. Link Group to LaunchPack

When creating a token, agent should ask:

```
Agent: "Do you have a Telegram group for [TOKEN]?"
User: "Yes, here's the link: https://t.me/mytokengroup"
Agent: "Great! Please add me to the group and make me admin. What's the chat ID?"
User: "-1001234567890"
Agent: "✅ Linked! I'll manage this group for [TOKEN]"
```

The LaunchPack is stored with:

```json
{
  "tg": {
    "chat_id": "-1001234567890",
    "pins": {...}
  }
}
```

---

## Testing Publishing Actions

### Test Telegram Publishing

```bash
# Start agent
bun start

# In chat, after creating a LaunchPack with chat_id:
"publish to telegram"
```

**What should happen:**

1. Agent reads LaunchPack
2. Finds `tg.chat_id`
3. Sends launch announcement to that Telegram group
4. Pins the welcome message (if bot is admin)
5. Returns success confirmation

**Debug**: Check the logs for:

- `[PUBLISH_TELEGRAM] Publishing to chat: -1001234567890`
- If it fails, bot might not be in the group or not admin

---

### Test X (Twitter) Publishing

```bash
# Add X credentials to .env
X_API_KEY=your_api_key
X_API_SECRET=your_api_secret
X_ACCESS_TOKEN=your_access_token
X_ACCESS_SECRET=your_access_secret

# In agent chat:
"publish to x"
```

**What should happen:**

1. Agent reads LaunchPack
2. Composes thread about the token
3. Posts to X/Twitter
4. Returns tweet URL

---

## Enhancement Ideas

### 1. Auto-Create Telegram Groups (Currently Not Possible)

**Limitation**: Telegram Bot API doesn't allow bots to create groups.

**Workaround**: Agent guides user through manual creation:

```
Agent: "I can't create the group myself, but I'll guide you:
1. Open Telegram
2. Tap Menu → New Group
3. Name it '[TOKEN NAME] Community'
4. Add me: @[BOT_USERNAME]
5. Make me admin
6. Share the link here"
```

### 2. Multi-Group Management Dashboard

Create a command to see all linked groups:

```
User: "show my telegram groups"
Agent:
📱 Telegram Groups:
• Token A → @tokenA_community (-1001234567890)
• Token B → @tokenB_community (-1001987654321)
• Token C → No group linked ⚠️
```

### 3. Smart Posting Schedule

Store scheduled posts per token:

```typescript
{
  tg: {
    chat_id: "-1001234567890",
    schedule: [
      { at: "2026-01-13T10:00:00Z", message: "GM holders! 🌅" },
      { at: "2026-01-13T18:00:00Z", message: "Price update: ..." }
    ]
  }
}
```

Agent posts automatically at scheduled times.

### 4. Community Sentiment Analysis

Agent monitors Telegram group messages:

- Track sentiment (bullish/bearish)
- Identify FUD and address it
- Celebrate milestones with community
- Auto-respond to common questions

### 5. Cross-Platform Sync

When posting to Telegram, also:

- Tweet the same update to X
- Update Discord (if configured)
- Log in LaunchPack audit trail

### 6. Group Health Monitoring

Track metrics per group:

```typescript
{
  tg: {
    chat_id: "-1001234567890",
    metrics: {
      member_count: 150,
      messages_per_day: 45,
      sentiment_score: 8.2,
      top_contributors: ["user1", "user2"]
    }
  }
}
```

Agent reports: "Your Token A community is growing! +20 members this week 📈"

### 7. Meme Kit Auto-Generation

When creating LaunchPack:

- Auto-generate 10-15 meme templates
- Post to Telegram group meme channel
- Let community remix and share
- Store best memes in `assets.memes[]`

---

## Testing Workflow

### Full Flow Test

```bash
# 1. Create LaunchPack with Telegram
User: "create a meme token called Test Coin"
Agent: "Great! Do you have a Telegram group for Test Coin?"
User: "Yes, add me to it: @testcoin_group"
Agent: "Please make me admin and share the chat ID"
User: "Done, chat ID is -1001234567890"
Agent: "✅ Linked! Creating LaunchPack..."

# 2. Launch token
User: "launch it"
Agent: [Deploys to pump.fun]

# 3. Auto-publish
Agent: [Automatically posts to Telegram group]
Agent: [Automatically tweets launch thread]

# 4. Verify
- Check Telegram group for launch announcement
- Check X for tweet
- Check pump.fun for token
```

---

## Current Implementation Status

✅ **Working:**

- Telegram plugin loaded
- X plugin loaded
- LaunchPack model supports `tg.chat_id` and `tg.telegram_chat_id`
- PUBLISH_TELEGRAM action defined
- PUBLISH_X action defined
- **Scam detection** with 10+ patterns
- **Ban commands** (`/ban @user` or `/ban userid`)
- **Welcome messages** for new members
- **Mascot persona switching** per group
- **Scheduled tweets** with auto-posting
- **Smart URL truncation** (preserves full URLs)
- **Preview tweet** command for testing
- **Autonomous TG marketing** - auto-schedules for all tokens
- **AI meme generation** - DALL-E 3 memes for TG shills
- **Localhost meme file upload** - Auto-uploads local files via multipart/form-data

### Meme File Upload (Localhost URLs)

When memes are generated by DALL-E and saved locally:

1. Files stored at: `~/.eliza/data/uploads/memes/`
2. URLs look like: `http://localhost:3000/uploads/memes/tokenname-123456.png`
3. Telegram API can't access localhost URLs directly
4. **Fix:** Scheduler detects localhost URLs and:
   - Extracts filename from URL
   - Reads file from disk
   - Uploads via `multipart/form-data` using `sendPhoto` API
   - Works for all locally-generated images!

⚠️ **Tested & Working:**

- Message sending to Telegram groups ✅
- Tweet posting to X ✅
- Pin messages (requires admin perms) ✅
- Multiple group management ✅
- Scam detection with severity levels ✅
- Ban command in groups ✅
- Scheduled post auto-posting ✅
- Meme attachment to TG posts ✅
- Group health monitoring ✅
- Sentiment analysis ✅
- Cross-platform sync (TG ↔ X) ✅

🔨 **Future Enhancements:**

- Discord integration
- Group analytics dashboard

---

## Telegram Actions Reference

| Action                     | Trigger                | Description                 |
| -------------------------- | ---------------------- | --------------------------- |
| `PUBLISH_TELEGRAM`         | "publish to telegram"  | Posts launch announcement   |
| `LINK_TELEGRAM_GROUP`      | "link telegram group"  | Associates group with token |
| `CHECK_TELEGRAM_GROUP`     | "check telegram setup" | Verifies bot permissions    |
| `GREET_NEW_TELEGRAM_GROUP` | Auto on join           | Welcomes new members        |
| `VERIFY_TELEGRAM_SETUP`    | "verify telegram"      | Full verification check     |
| `SEND_TELEGRAM_MESSAGE`    | "send to telegram"     | Posts custom message        |
| `GROUP_HEALTH_CHECK`       | "group health"         | Get group metrics/stats     |
| `ANALYZE_SENTIMENT`        | "vibe check"           | Community mood analysis     |
| `PIN_MESSAGE`              | "pin announcement:"    | Pin message to group        |
| `CROSS_POST`               | "cross-post:"          | Post to TG and X together   |

---

## X/Twitter Actions Reference

| Action                        | Trigger                        | Description               |
| ----------------------------- | ------------------------------ | ------------------------- |
| `PUBLISH_X`                   | "publish to x"                 | Posts launch tweet        |
| `TWEET_ABOUT_TOKEN`           | "tweet about [token]"          | Manual tweet              |
| `SCHEDULE_MARKETING`          | "schedule marketing"           | Creates 10-tweet schedule |
| `VIEW_SCHEDULED_TWEETS`       | "show scheduled tweets"        | Lists pending tweets      |
| `CANCEL_MARKETING`            | "cancel marketing for [token]" | Cancels scheduled         |
| `REGENERATE_SCHEDULED_TWEETS` | "regenerate scheduled tweets"  | Fixes broken tweets       |
| `PREVIEW_TWEET`               | "preview a tweet"              | Test tweet generation     |
| `CHECK_X_QUOTA`               | "check x quota"                | Shows remaining posts     |

---

## Autonomous Telegram Marketing

### Overview

The bot can automatically shill all launched tokens with linked Telegram groups. It generates engaging posts using AI and optionally attaches DALL-E generated memes.

### Data Persistence

All scheduled posts persist to PostgreSQL when `DATABASE_URL` is set:

| Data | PostgreSQL Table | Description |
|------|------------------|-------------|
| Scheduled posts | `sched_tg_posts` | All pending/posted/failed TG posts |
| System metrics | `sched_system_metrics` | Post counts, banned users |

**Survives restarts:** Yes - scheduled posts are restored after Railway redeploys.

**Local Development:** Falls back to `./data/tg_scheduled_posts.json`.

See [POSTGRESQL_ARCHITECTURE.md](./POSTGRESQL_ARCHITECTURE.md) for full details.

### Auto-Start Behavior

When the agent boots up:

1. **10 second delay** - Waits for database to initialize
2. **Auto-scan** - Finds all launched tokens with TG groups
3. **Queue check** - If < 5 pending posts for any token, auto-schedules more
4. **Perpetual refill** - Every hour, checks and refills the queue

### Post Types

| Type                  | Description                     | Meme Chance |
| --------------------- | ------------------------------- | ----------- |
| `gm_post`             | Morning greeting to community   | 100%        |
| `chart_update`        | Price/chart hype                | 100%        |
| `community_hype`      | Community milestone celebration | 100%        |
| `meme_drop`           | Pure meme content               | 100%        |
| `meme_post`           | Meme-focused post               | 100%        |
| `shitpost`            | Humorous shitposting            | 100%        |
| `holder_callout`      | Shoutout to holders             | 100%        |
| `holder_appreciation` | Thanks to holders               | 100%        |
| `alpha_tease`         | Hints at upcoming features      | 50%         |
| `question`            | Community engagement question   | 50%         |
| `milestone`           | Achievement celebration         | 100%        |
| Other types           | Any non-listed type             | 50%         |

### AI Meme Generation

When `AI_MEME_ENABLE=true` in .env:

- DALL-E 3 generates contextual memes
- Post type determines meme style
- Images attach to TG posts via `sendPhoto` API
- **Images auto-downloaded** to `~/.eliza/data/uploads/memes/` for permanent storage
- Falls back to text-only if image fails

**Image Storage:**

- DALL-E URLs expire after ~2 hours
- Auto-download ensures images never expire
- Files named: `{token-ticker}-{timestamp}.png`
- Example: `~/.eliza/data/uploads/memes/dump-1736892145000.png`

**Example .env:**

```bash
AI_MEME_ENABLE=true
OPENAI_API_KEY=your_openai_key
```

### Posting Schedule

Default schedule posts at:

- 9:00 AM (local time)
- 1:00 PM
- 5:00 PM
- 9:00 PM

**Configuration:**

- `AUTO_POSTS_PER_DAY = 4` - Posts scheduled per day
- `MIN_PENDING_POSTS = 5` - Auto-refill threshold

### Manual Control Actions

| Action                  | Trigger                 | Description               |
| ----------------------- | ----------------------- | ------------------------- |
| `SCHEDULE_TG_MARKETING` | "schedule tg marketing" | Manual schedule for token |
| `VIEW_TG_SCHEDULE`      | "show tg schedule"      | View pending posts        |
| `CANCEL_TG_MARKETING`   | "cancel tg marketing"   | Cancel pending posts      |
| `PREVIEW_TG_POST`       | "preview tg post"       | Test post without sending |
| `SEND_TG_SHILL`         | "shill to telegram now" | Immediate post with meme  |

### Storage

Scheduled posts stored in: `./data/tg_scheduled_posts.json`

```json
{
  "id": "abc123",
  "tokenTicker": "RUG",
  "telegramChatId": "-1001234567890",
  "type": "community_hype",
  "text": "🚀 $RUG is absolutely mooning! ...",
  "imageUrl": "https://oaidalleapiprodscus.blob.../img.png",
  "scheduledFor": "2024-01-15T13:00:00.000Z",
  "status": "pending"
}
```

---

## Group Health Monitoring

### Overview

The bot automatically monitors the health of all linked Telegram groups, tracking:

- **Member count** - Current members + 24h change
- **Activity** - Messages per day, unique active users
- **Sentiment** - Bullish/neutral/bearish based on message content
- **Trend** - Growing/stable/declining based on member changes
- **Top contributors** - Most active community members

### Auto-Monitoring

Health checks run automatically:

- First check: 30 seconds after boot
- Periodic checks: Every hour

Health data is stored in each LaunchPack's `tg.health` field.

### Manual Health Check

```
User: "check group health for DUMP"

Agent:
📊 Group Health Report

👥 Members: 150 (+12 in 24h) 📈
💬 Messages/day: 45
🧑‍🤝‍🧑 Active users (24h): 23

🟢 Sentiment: BULLISH (75%)

🏆 Top Contributors:
   1. @whale_trader
   2. @degen_chad
   3. @moon_boy

🕐 Last updated: 1/21/2026, 3:45 PM
```

### Sentiment Analysis

Keywords tracked for sentiment:

**Bullish signals:**

- moon, pump, bullish, ape, buy, hodl, wagmi, lfg
- Emojis: 🚀, 🔥, 💎, 🙌

**Bearish signals:**

- dump, rug, scam, sell, fud, dead, rekt
- Emojis: 📉, 💀

### Vibe Check

Quick sentiment check:

```
User: "vibe check for DUMP"

Agent:
📊 Sentiment Analysis - Sir Dumps-A-Lot ($DUMP)

🟢🚀 Overall Mood: BULLISH
📈 Sentiment Score: 75% bullish

✨ The community is feeling bullish! Lots of positive vibes.
📣 Good time for marketing and engagement!
```

---

## Cross-Platform Sync

### Post to Both Platforms

Sync announcements across Telegram and X:

```
User: "cross-post: 🚀 $DUMP just hit 1000 holders! LFG!"

Agent:
📢 Cross-Post Results

📱 Telegram: ✅ Posted
🐦 X/Twitter: ✅ Posted

📝 Message: "🚀 $DUMP just hit 1000 holders! LFG!"
```

**Notes:**

- X posts are auto-truncated to 280 characters
- Requires both TG group and X credentials configured

---

## Pin Management

### Pin Announcements

```
User: "pin announcement: We just hit 1000 holders! 🎉"

Agent: 📌 Message pinned successfully!

"We just hit 1000 holders! 🎉"
```

**Requirements:**

- Bot must be admin in the group
- Bot needs "Pin Messages" permission

---

## Next Steps

1. ~~Test Telegram publishing~~ ✅
2. ~~Test X publishing~~ ✅
3. ~~Implement scam detection~~ ✅
4. ~~Implement ban commands~~ ✅
5. ~~Implement welcome messages~~ ✅
6. ~~Implement mascot personas~~ ✅
7. ~~Autonomous TG marketing~~ ✅
8. ~~AI meme generation~~ ✅
9. ~~DALL-E image auto-download~~ ✅
10. ~~50% meme chance on non-meme posts~~ ✅
11. ~~Group health monitoring~~ ✅
12. ~~Sentiment analysis~~ ✅
13. ~~Cross-platform sync~~ ✅
14. ~~Pin management~~ ✅
15. **Add Discord integration**

---

## Troubleshooting

### Memes Not Appearing on Posts

**Check:**

1. `AI_MEME_ENABLE=true` in .env
2. `OPENAI_API_KEY` is valid
3. Post type is meme-eligible (see Post Types table)
4. Check logs for `[MEME_GENERATOR]` messages

### DALL-E Images Expiring

**Solution:** Images now auto-download to local storage:

- Logos: `~/.eliza/data/uploads/logos/`
- Memes: `~/.eliza/data/uploads/memes/`

If old images expired, regenerate with:

```
generate a logo for TOKEN
```

### Posts Not Scheduling

**Check:**

1. Token is marked as launched (`status: 'success'`)
2. Telegram group is linked (`tg.telegram_chat_id` exists)
3. Run: `show tg schedule for TOKEN`
