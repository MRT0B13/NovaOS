# 🧪 Test Actions - Step by Step Guide

## Prerequisites Check

### 1. Check Agent Status

Open http://localhost:3000 in your browser

### 2. Check Wallet Balances

```
check wallet balances
```

Expected output:

- Agent wallet balance (SOL)
- Pump wallet balance (SOL)

---

## Test 1: Create Token with Social Links

### Command:

```
create token called TestDog with ticker TDOG,
website: testdog.io,
x: x.com/testdog,
telegram_link: t.me/testdogofficial,
chat_id: -1001234567890
```

### What to expect:

- ✅ LaunchPack created with ID
- ✅ Auto-generated logo from DiceBear
- ✅ Social links extracted and stored
- ✅ Telegram chat_id stored

### Verify:

```
show all tokens
```

Should show:

- Token name: TestDog
- Ticker: TDOG
- Telegram: ✅ Linked (-1001234567890)
- LaunchPack ID

---

## Test 2: List LaunchPacks

### Command:

```
list launchpacks
```

or

```
show all tokens
```

### What to expect:

- 📦 LaunchPacks (X total)
- For each token:
  - Name and ticker
  - Status (not launched, success, etc.)
  - Mint address (if launched)
  - Telegram group status
  - LaunchPack ID

---

## Test 3: Check Launch Readiness

### Command:

```
check wallet balances
```

### What to check:

- Agent wallet: Should have SOL
- Pump wallet: Needs 0.15-0.2+ SOL per launch

### If pump wallet is low:

```
deposit 0.2 sol to pump wallet
```

---

## Test 4: Launch Token (if SOL available)

### Command:

```
launch TestDog
```

### What to expect:

1. "Deploying to pump.fun..."
2. Metadata uploaded to IPFS (includes all social links)
3. Token created on-chain
4. If Telegram bot configured: "✅ Published to Telegram group!"
5. If X API configured: "✅ Published to X/Twitter!"
6. "🚀 Launch success!"
7. Mint address
8. pump.fun URL

### Verify on pump.fun:

1. Click the pump.fun URL
2. Check token page shows:
   - Name: TestDog
   - Ticker: TDOG
   - Logo (DiceBear generated)
   - Website: testdog.io
   - X: x.com/testdog
   - Telegram: t.me/testdogofficial

---

## Test 5: Create Token with Custom Logo

### Command:

```
create token called CustomCat with ticker CAT,
logo: https://i.imgur.com/cat.png,
site: customcat.io,
twitter: x.com/customcat
```

### What to expect:

- LaunchPack created with custom logo URL
- Social links extracted
- No auto-generated logo (uses provided URL)

---

## Test 6: Minimal Token (Auto-Logo Only)

### Command:

```
create token called SimpleDoge
```

### What to expect:

- Name: SimpleDoge
- Ticker: SIMPLE (auto-derived)
- Logo: Auto-generated from DiceBear
- No social links (all optional)

---

## Test 7: Launch Without Social Links

### Command:

```
launch SimpleDoge
```

### What to expect:

- Token launches successfully
- pump.fun page shows only basic info
- No social links section

---

## Test 8: Multiple Tokens Management

### Create multiple tokens:

```
create token Alpha, site: alpha.io
```

```
create token Beta, x: x.com/betacoin
```

```
create token Gamma, telegram_link: t.me/gammacoin
```

### List all:

```
show all tokens
```

### What to expect:

- All 3 tokens listed
- Different social links per token
- Each with unique LaunchPack ID

---

## Test 9: Telegram Chat ID Variations

Test different chat_id formats:

### Format 1:

```
create token TG1, chat_id: -1001234567890
```

### Format 2:

```
create token TG2, telegram: -1001234567890
```

### Format 3:

```
create token TG3, tg: -1001234567890
```

All should extract chat_id correctly.

---

## Test 10: Edge Cases

### No spaces in URLs:

```
create token NoSpace, website:nospacedoge.io, x:x.com/nospace
```

### With spaces:

```
create token WithSpace, website: withdoge.io, x: x.com/withdoge
```

Both should work (regex handles optional spaces).

### Mixed case:

```
create token MixedCase, Website: mixed.io, X: x.com/mixed
```

Should work (case-insensitive regex).

---

## Expected Behavior Summary

### Social Link Extraction:

- ✅ `website:` or `site:` → Extracts website URL
- ✅ `x:` or `twitter:` → Extracts X/Twitter URL
- ✅ `telegram_link:` or `tg_link:` → Extracts Telegram public URL
- ✅ `chat_id:`, `telegram:`, or `tg:` (with number) → Extracts chat ID

### Auto-Logo:

- ✅ If no logo provided → DiceBear API generates unique logo
- ✅ If logo provided → Uses custom URL

### Launch with Social Links:

- ✅ Metadata includes all provided social links
- ✅ Links appear on pump.fun token page
- ✅ Auto-publish to Telegram (if chat_id + bot configured)
- ✅ Auto-publish to X (if API credentials configured)

### List Command:

- ✅ Shows all LaunchPacks
- ✅ Displays launch status
- ✅ Shows Telegram group status
- ✅ Displays mint address (if launched)

---

## Troubleshooting

### Issue: "LaunchKit store unavailable"

**Fix**: Restart agent (`bun start`)

### Issue: "Insufficient SOL balance"

**Fix**:

1. Check balances: `check wallet balances`
2. Deposit: `deposit [amount] sol to pump wallet`

### Issue: "LOGO_REQUIRED"

**Fix**: This shouldn't happen anymore (auto-generates logo)

### Issue: "Telegram publish failed"

**Reason**: TELEGRAM_BOT_TOKEN not configured in .env
**Not critical**: Launch still succeeds, just skips Telegram post

### Issue: "X publish failed"

**Reason**: X API credentials not configured in .env
**Not critical**: Launch still succeeds, just skips X post

---

## Success Criteria

All these should work:

- ✅ Create token with social links
- ✅ Create token without social links
- ✅ Auto-generate logos
- ✅ Custom logos
- ✅ List all tokens
- ✅ Check wallet balances
- ✅ Launch token (if SOL available)
- ✅ Social links appear on pump.fun
- ✅ Chat_id extracted from multiple formats

---

## Test 11: Import Existing Token (MARK_AS_LAUNCHED)

Use this when you have a token that was launched outside the agent.

### Command:

```
$DUMP is already launched at DewdpgYyVsHAzGvQMf8lzxynvue8ubszY4bP8Fpump
```

Or:

```
mark DUMP as launched with mint DewdpgYyVsHAzGvQMf8lzxynvue8ubszY4bP8Fpump
```

### What to expect:

1. Agent finds existing LaunchPack by ticker
2. Updates status to `success`
3. Stores mint address
4. Enables marketing features (TG scheduler, X scheduler)

### Verify:

```
view DUMP
```

Should show:

- Status: ✅ Launched
- CA: DewdpgYy...
- Pump.fun link

---

## Test 12: Pre-Launch Checklist (Launched Token)

After marking a token as launched:

### Command:

```
pre-launch checklist for DUMP
```

### What to expect for LAUNCHED token:

```
✅ Token is LAUNCHED!
• CA: DewdpgYy...Fpump
• Pump.fun: https://pump.fun/coin/...

📊 Marketing Status:
• TG: 5 posts scheduled
• X: 9 tweets scheduled
```

### What to expect for UNLAUNCHED token:

- Traditional checklist (wallet balance, social links, etc.)

---

## Test 13: Generate Logo (DALL-E with Auto-Download)

### Command:

```
generate a logo for DUMP
```

### What to expect:

1. DALL-E generates unique logo
2. **New**: Image auto-downloads to `~/.eliza/data/uploads/logos/`
3. Returns local URL (never expires)

### Verify:

- Check `~/.eliza/data/uploads/logos/` for new PNG file
- File named like: `dump-1234567890.png`

---

## Test 14: Meme Generation

### Automatic (TG Scheduler):

Memes automatically attach to these post types:

- `meme_post` (always)
- `shitpost` (always)
- `holder_callout` (always)
- `gm_post` (always)
- `holder_appreciation` (always)
- Other posts: 50% random chance

### Verify:

- Check TG group for posts with images
- Check `~/.eliza/data/uploads/memes/` for downloaded memes

---

## Test 15: Update Website URL

### Command:

```
update website to https://candlejoust.com/
```

### What to expect:

- Website URL extracted correctly (not "to")
- LaunchPack updated with new website

### Verify:

```
view DUMP
```

Should show: `Website: https://candlejoust.com/`

---

## Test 16: Group Health Check

### Command:

```
check group health for DUMP
```

### What to expect:

```
📊 Group Health Report

👥 Members: 150 (+12 in 24h) 📈
💬 Messages/day: 45
🧑‍🤝‍🧑 Active users (24h): 23

🟢 Sentiment: BULLISH (75%)

🏆 Top Contributors:
   1. @whale_trader
   2. @degen_chad
```

### Verify:

- Member count matches TG group
- Sentiment reflects recent messages

---

## Test 17: Sentiment Analysis (Vibe Check)

### Command:

```
vibe check for DUMP
```

### What to expect:

```
📊 Sentiment Analysis - Sir Dumps-A-Lot ($DUMP)

🟢🚀 Overall Mood: BULLISH
📈 Sentiment Score: 75% bullish

✨ The community is feeling bullish!
```

---

## Test 18: Pin Announcement

### Command:

```
pin announcement: 🎉 We just hit 1000 holders! Thanks fam!
```

### What to expect:

1. Message sent to linked TG group
2. Message pinned (silently)
3. Confirmation from agent

### Verify:

- Check TG group for pinned message

**Note:** Bot must be admin with pin permissions.

---

## Test 19: Cross-Post to TG and X

### Command:

```
cross-post: 🚀 $DUMP just hit 1000 holders! LFG!
```

### What to expect:

```
📢 Cross-Post Results

📱 Telegram: ✅ Posted
🐦 X/Twitter: ✅ Posted

📝 Message: "🚀 $DUMP just hit 1000 holders! LFG!"
```

### Verify:

- Check TG group for message
- Check X/Twitter for tweet

---

## Next Steps After Testing

If all tests pass:

1. Fund pump wallet with real SOL
2. Configure Telegram bot (TELEGRAM_BOT_TOKEN)
3. Configure X API credentials
4. Launch real tokens!

If tests fail:

1. Check terminal output for errors
2. Verify .env configuration
3. Check LaunchPack creation in database
4. Review error messages
