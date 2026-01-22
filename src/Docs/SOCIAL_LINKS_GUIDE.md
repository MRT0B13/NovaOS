# 🔗 Social Links - Complete Guide

## Overview

When you launch a token on pump.fun, the agent **automatically fills in ALL the details** including:

- ✅ Coin name
- ✅ Ticker symbol
- ✅ Description
- ✅ Logo (auto-generated or custom)
- ✅ **Website**
- ✅ **X/Twitter**
- ✅ **Telegram**

## How to Provide Social Links

### Format Examples

```
User: "create token called MoonDog with ticker MOON,
       website: https://moondogcoin.com,
       x: https://x.com/moondogcoin,
       telegram_link: https://t.me/moondogofficial,
       chat_id: -1001234567890"
```

Or more concise:

```
User: "launch token called RocketCat ($ROCKET)
       site: rocketcat.io
       twitter: x.com/rocketcat
       tg_link: t.me/rocketcatcommunity"
```

## Recognized Patterns

### Website

- `website: https://yoursite.com`
- `site: yoursite.com`

### X/Twitter

- `x: https://x.com/yourhandle`
- `twitter: https://twitter.com/yourhandle`

### X Handle (Just the @handle)

- `set x handle to @yourhandle`
- `x handle: @yourhandle`
- `twitter handle is @yourhandle`

**Note:** This stores the handle in `x.handle` (e.g., `@yourhandle`) AND auto-generates the URL in `links.x` (e.g., `https://x.com/yourhandle`).

### Telegram Link (Public Group/Channel URL)

- `telegram_link: https://t.me/yourgroup`
- `tg_link: t.me/yourchannel`

### Telegram Chat ID (For Bot Management)

- `chat_id: -1001234567890`
- `telegram: -1001234567890`
- `tg: -1001234567890`

## Important Distinctions

### Telegram Link vs Chat ID

1. **Telegram Link** (`telegram_link` or `tg_link`):
   - Public URL to your group/channel
   - Shows on pump.fun token page
   - Example: `https://t.me/moondogofficial`
   - Users click this to join

2. **Chat ID** (`chat_id`, `telegram`, or `tg`):
   - Numeric ID for bot to post messages
   - Used for auto-publishing launch announcements
   - Example: `-1001234567890`
   - Not shown publicly, internal use only

You can provide both!

```
User: "create token MoonDog,
       telegram_link: t.me/moondogofficial,
       chat_id: -1001234567890"
```

This will:

- Display `t.me/moondogofficial` on pump.fun
- Let bot post to the group using `-1001234567890`

## What Gets Uploaded to Pump.fun

When you say "launch [TOKEN]", the agent:

1. **Uploads metadata to IPFS** including:

   ```json
   {
     "name": "MoonDog",
     "symbol": "MOON",
     "description": "To the moon!",
     "image": "https://api.dicebear.com/7.x/shapes/png?seed=MoonDog&size=400",
     "twitter": "https://x.com/moondogcoin",
     "telegram": "https://t.me/moondogofficial",
     "website": "https://moondogcoin.com"
   }
   ```

2. **Creates token on pump.fun** with metadata URI

3. **Social links appear on token page** automatically

## Complete Example Workflows

### Minimal (Just Token Name)

```
User: "launch token called SimpleToken"

Agent extracts:
- Name: SimpleToken
- Ticker: SIMPLE (auto-derived)
- Logo: Auto-generated from DiceBear
- Description: (from message text)
- Social links: None

Result: Token launched with basic info only
```

### With Social Links

```
User: "create token MoonDog ($MOON) - going to the moon!
       website: moondogcoin.com
       x: x.com/moondogcoin
       telegram_link: t.me/moondogofficial"

Agent extracts:
- Name: MoonDog
- Ticker: MOON
- Description: "going to the moon!"
- Logo: Auto-generated
- Website: https://moondogcoin.com (adds https:// if missing)
- X: https://x.com/moondogcoin
- Telegram: https://t.me/moondogofficial

Result: Token launched with full social presence
```

### With Custom Logo + Socials + Bot Management

```
User: "launch RocketCat with ticker ROCKET
       logo: https://i.imgur.com/rocketcat.png
       site: rocketcat.io
       twitter: x.com/rocketcat
       telegram_link: t.me/rocketcatpublic
       chat_id: -1001234567890"

Agent extracts:
- Name: RocketCat
- Ticker: ROCKET
- Logo: https://i.imgur.com/rocketcat.png (custom)
- Website: rocketcat.io
- X: x.com/rocketcat
- Telegram link: t.me/rocketcatpublic (public URL)
- Chat ID: -1001234567890 (bot posts here)

Result:
- Token launched with custom logo and all socials
- Auto-publishes launch announcement to Telegram group
- Token page shows all social links
```

## Auto-Publishing Flow

When you launch a token with social links:

1. **Token Deployment**:

   ```
   User: "launch MoonDog"
   Agent: Deploying to pump.fun...
   Agent: 🚀 Launch success! Mint: ABC123...
   ```

2. **Auto-Publish to Socials** (if configured):

   ```
   Agent: ✅ Published to Telegram group!
   Agent: ✅ Published to X/Twitter!
   ```

3. **Result**:
   - Token appears on pump.fun with all social links
   - Launch announcement posted to Telegram (if chat_id provided)
   - Launch announcement posted to X (if credentials configured)
   - Users can click social links directly from token page

## Checking Your Tokens

```
User: "show all tokens"

Agent: 📦 LaunchPacks (2 total):

🪙 **MoonDog** ($MOON)
   Status: success
   Mint: ABC12345...
   Telegram: ✅ Linked (-1001234567890)
   Website: moondogcoin.com
   X: x.com/moondogcoin
   ID: 550e8400-e29b-41d4-a716-446655440000
```

## FAQ

### Q: Do I need to provide all social links?

**A:** No! All are optional. Provide only what you have.

### Q: What if I only have Twitter?

**A:** Just say: `"launch token Doge, twitter: x.com/dogetoken"`

### Q: Can I add social links after creation?

**A:** Not yet - provide them during creation. Future update will allow editing.

### Q: What format should URLs be?

**A:** Agent accepts with or without `https://`. It will normalize them.

### Q: What's the difference between telegram_link and chat_id?

**A:**

- `telegram_link`: Public URL users see on pump.fun
- `chat_id`: Numeric ID for bot to post announcements

### Q: Can I have Telegram link without chat_id?

**A:** Yes! Link shows on pump.fun, but bot won't post announcements.

### Q: Can I have chat_id without telegram_link?

**A:** Yes! Bot can post announcements, but no public link on pump.fun.

## Summary

✅ **Yes, the agent fills in ALL necessary details when launching**, including:

- Coin name & ticker
- Description
- Logo (auto-generated or custom)
- **Website** (if you provide it)
- **X/Twitter** (if you provide it)
- **Telegram** (if you provide it)

Just include them in your message using the patterns above, and they'll automatically appear on the pump.fun token page!

## Example One-Liner

```
User: "launch MemeKing ($KING), site: memeking.io, x: x.com/memeking, tg_link: t.me/memekingdom, chat_id: -1001234567890"
```

Agent will:

1. Create LaunchPack with all details
2. Deploy token to pump.fun with social links
3. Auto-publish announcement to Telegram group
4. Auto-publish announcement to X/Twitter
5. Return mint address and pump.fun URL

Done! 🚀
