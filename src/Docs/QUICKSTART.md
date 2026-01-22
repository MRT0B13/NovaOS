# Quick Reference: Phantom + LaunchKit

## One-Time Setup (5 minutes)

```bash
# 1. Export Phantom private key
#    Phantom → Settings → Security → Export Private Key

# 2. Add to .env
AGENT_FUNDING_WALLET_SECRET=your_phantom_private_key_here

# 3. Verify
bun run scripts/check-wallet.ts

# 4. Start agent
elizaos dev
```

## Agent Actions

| User Says                            | Agent Does                                                            |
| ------------------------------------ | --------------------------------------------------------------------- |
| `check wallet balances`              | Shows funding wallet + pump wallet balances                           |
| `deposit 0.5 sol to pump wallet`     | Transfers 0.5 SOL from Phantom → pump wallet                          |
| `withdraw profits`                   | Transfers profits from pump wallet → Phantom (leaves 0.3 SOL reserve) |
| `withdraw 2 sol leave 0.5 reserve`   | Withdraws 2 SOL, keeps 0.5 SOL for next launch                        |
| `deploy` / `launch` / `go live`      | Checks pump wallet, auto-deposits if needed, launches token           |
| `$TOKEN is already launched at MINT` | Imports existing token without deploying (MARK_AS_LAUNCHED)           |
| `pre-launch checklist`               | Shows CA + marketing status for launched tokens                       |
| `generate a logo for TOKEN`          | DALL-E generates + auto-downloads logo                                |

## Wallet Flow

```
Your Phantom Wallet (AGENT_FUNDING_WALLET_SECRET)
        ↓ deposit before launch
Pump Portal Wallet (PUMP_PORTAL_WALLET_ADDRESS)
        ↓ token creation
    pump.fun 🚀
        ↓ profits accumulate
Pump Portal Wallet (gains from successful launches)
        ↓ withdraw profits
Your Phantom Wallet (profits returned) 💰
```

## Why Not Phantom SDK?

| Phantom SDK                 | LaunchKit                            |
| --------------------------- | ------------------------------------ |
| User-facing apps            | Autonomous agent                     |
| Manual approval for each tx | Automatic signing                    |
| React/Browser integration   | Direct private key + @solana/web3.js |
| ❌ Wrong for agents         | ✅ Correct for agents                |

## Security

✅ **Safe:**

- Private key stays in your `.env` (gitignored)
- Agent runs on YOUR machine
- You control the code
- Same security as Phantom app using the key

❌ **Not Safe:**

- Sharing private key with others
- Committing `.env` to git
- Running untrusted agent code
- Keeping large amounts in funding wallet without testing first

## Costs Per Launch

- Token creation: ~0.02-0.05 SOL (pump.fun fee)
- Dev buy: 0.1-0.5 SOL (your initial purchase)
- TX fees: ~0.001 SOL
- **Total: ~0.3-0.6 SOL per launch**

## Troubleshooting

```bash
# Check configuration
bun run scripts/check-wallet.ts

# Generate new wallet instead of using Phantom
bun run scripts/generate-wallet.ts

# View full setup guide
cat PHANTOM_INTEGRATION.md

# Check agent logs
# Look for "FundingWallet" entries
```

## Test Commands

```
# 1. Balance check
User: "check balances"
Expected: Shows both wallet balances

# 2. Manual deposit
User: "deposit 0.5 sol to pump wallet"
Expected: TX signature + new balance

# 3. Full launch (auto-deposits)
User: "deploy"
Expected: Auto-deposit → Launch → Mint address

# 4. Withdraw profits
User: "withdraw profits"
Expected: Transfers profits back to Phantom, leaves 0.3 SOL reserve

# 5. Custom withdrawal
User: "withdraw 2 sol leave 0.5 sol reserve"
Expected: Withdraws 2 SOL, keeps 0.5 SOL in pump wallet

# 6. Import existing token (new!)
User: "$DUMP is already launched at DewdpgYy...Fpump"
Expected: Token marked as launched, marketing features enabled

# 7. Pre-launch checklist (for launched tokens)
User: "pre-launch checklist for DUMP"
Expected: Shows CA, pump.fun link, TG/X scheduler status
```

## Files

- `PHANTOM_INTEGRATION.md` - Complete Phantom guide
- `WALLET_SETUP.md` - All wallet setup options
- `scripts/check-wallet.ts` - Verify config
- `scripts/generate-wallet.ts` - Create new wallet
- `src/launchkit/services/fundingWallet.ts` - Transfer logic
- `src/launchkit/eliza/walletActions.ts` - Agent actions

## Quick Checks

**Is it working?**

```bash
✅ bun run scripts/check-wallet.ts shows balances
✅ Agent responds to "check balances"
✅ Agent can "deposit 0.5 sol to pump wallet"
✅ You see transactions in Phantom app
```

**Common mistakes:**

```bash
❌ Used Phantom SDK instead of private key
❌ Forgot to add AGENT_FUNDING_WALLET_SECRET to .env
❌ Private key has spaces or quotes
❌ Insufficient SOL in funding wallet
```

---

**Still stuck?** See full docs:

- [PHANTOM_INTEGRATION.md](PHANTOM_INTEGRATION.md) - Complete guide
- [WALLET_SETUP.md](WALLET_SETUP.md) - Setup walkthrough
- [TREASURY_GUARDRAILS.md](TREASURY_GUARDRAILS.md) - Treasury & security guardrails
- [AUTO_TRADING.md](AUTO_TRADING.md) - Auto-sell, take-profit, sweep
- [TWITTER_PLUGIN_INTEGRATION.md](TWITTER_PLUGIN_INTEGRATION.md) - X/Twitter setup & troubleshooting
- [SOCIAL_LINKS_GUIDE.md](SOCIAL_LINKS_GUIDE.md) - Setting X handles, website, Telegram
