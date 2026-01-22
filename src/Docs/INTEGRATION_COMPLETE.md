# ✅ Phantom Wallet Integration Complete

## What Was Built

### Core Integration

- **Direct Private Key Usage**: Agent uses Phantom wallet's private key with `@solana/web3.js` for autonomous operation
- **Dual Wallet System**: Funding wallet (your Phantom) → Pump wallet (pump.fun API) → Token creation
- **Auto-Deposit**: Agent automatically deposits SOL from funding wallet to pump wallet before launches
- **Balance Checking**: Real-time balance monitoring for both wallets

### Why Not Phantom SDK?

Phantom Connect SDK is designed for **user-facing applications** that require manual transaction approval. LaunchKit is an **autonomous agent** that needs to:

- Execute transactions automatically without user interaction
- Operate while user is offline/sleeping
- Respond immediately to launch commands

Therefore, we use **direct private key access** with `@solana/web3.js` - the correct approach for autonomous agents.

## New Files Created

### Documentation

- **[PHANTOM_INTEGRATION.md](PHANTOM_INTEGRATION.md)** - Complete explanation of Phantom integration, why SDK isn't used, how to export keys
- **[WALLET_SETUP.md](WALLET_SETUP.md)** - Detailed setup guide for all wallet options
- **[QUICKSTART.md](QUICKSTART.md)** - Quick reference card for setup and usage

### Code

- **[src/launchkit/services/fundingWallet.ts](src/launchkit/services/fundingWallet.ts)** - SOL transfer utilities (deposit, balance checks)
- **[src/launchkit/eliza/walletActions.ts](src/launchkit/eliza/walletActions.ts)** - Agent actions for wallet management

### Scripts

- **[scripts/check-wallet.ts](scripts/check-wallet.ts)** - Verify wallet configuration and check balances
- **[scripts/generate-wallet.ts](scripts/generate-wallet.ts)** - Generate new Solana wallet for agent

### Updated Files

- `src/launchkit/env.ts` - Added `AGENT_FUNDING_WALLET_SECRET` and `SOLANA_RPC_URL`
- `src/launchkit/services/redact.ts` - Added funding wallet secret to redaction
- `src/plugin.ts` - Added wallet actions to plugin
- `src/character.ts` - Added wallet system explanation and bio entries
- `README.md` - Updated with Phantom integration quick start

## How to Use

### Setup (One-Time)

```bash
# 1. Export Phantom private key
#    Phantom → Settings → Security & Privacy → Export Private Key

# 2. Add to .env
echo "AGENT_FUNDING_WALLET_SECRET=your_phantom_private_key" >> .env

# 3. Verify
bun run scripts/check-wallet.ts

# 4. Start agent
elizaos dev
```

### Agent Actions

| Action                   | Trigger                          | What It Does                             |
| ------------------------ | -------------------------------- | ---------------------------------------- |
| `CHECK_WALLET_BALANCES`  | "check balances"                 | Shows funding + pump wallet balances     |
| `DEPOSIT_TO_PUMP_WALLET` | "deposit 0.5 sol to pump wallet" | Transfers SOL from funding → pump wallet |
| `LAUNCH_LAUNCHPACK`      | "deploy" / "launch"              | Auto-deposits if needed, launches token  |

### Example Flow

```
User: "check wallet balances"

Agent: 💰 Wallet Status
       Funding Wallet: 5.0000 SOL
       Pump Wallet: 0.0000 SOL
       ⚠️ Pump wallet needs funds

User: "I want to launch a rescue dog token"
Agent: [discusses concept, refines narrative]

User: "create the launchpack"
Agent: [generates marketing materials]

User: "deploy"
Agent:
  ✓ Checking pump wallet... 0 SOL
  ✓ Depositing 0.5 SOL from funding wallet
  ✓ Launching token...
  ✅ Token deployed!
     Mint: Abc123...xyz
     TX: 5Qb...xyz
     Chart: https://pump.fun/Abc123...xyz
```

## Architecture

```
┌─────────────────────────────────────┐
│ Your Phantom Wallet                 │
│ (AGENT_FUNDING_WALLET_SECRET)       │
│                                     │
│ • You export private key            │
│ • Agent uses it via @solana/web3.js│
│ • Holds SOL for multiple launches   │
│ • You can still use in Phantom app  │
└──────────────┬──────────────────────┘
               │
               │ Agent auto-deposits before launch
               │ (via fundingWallet.ts)
               ↓
┌─────────────────────────────────────┐
│ Pump Portal Wallet                  │
│ (PUMP_PORTAL_WALLET_ADDRESS)        │
│                                     │
│ • Receives deposits from above      │
│ • Used by pump.fun API              │
│ • Creates tokens (~0.3-0.5 SOL ea.) │
└─────────────────────────────────────┘
```

## Security Model

**Safe:**

- ✅ Private key stored in `.env` (gitignored)
- ✅ Agent code runs on YOUR machine
- ✅ You control and audit the code
- ✅ Same security model as Phantom app accessing the key
- ✅ Can monitor all transactions in Phantom app

**Best Practices:**

- Keep only launch funds in funding wallet (test with small amounts first)
- Use dedicated wallet for agent (not your main wallet with large holdings)
- Back up private key securely (Phantom seed phrase works)
- Monitor transactions via Phantom app
- Review code before running (all source visible)

## Cost Estimates

**Per Token Launch:**

- Token creation fee: ~0.02-0.05 SOL
- Dev buy (initial purchase): 0.1-0.5 SOL
- Transaction fees: ~0.001 SOL
- **Total: ~0.3-0.6 SOL per launch**

**Recommended Funding:**

- Testing: 0.5-1 SOL
- Production: 5-10 SOL (multiple launches)

## Verification

### Check Configuration

```bash
bun run scripts/check-wallet.ts
```

Expected output:

```
✅ Agent Funding Wallet (AGENT_FUNDING_WALLET_SECRET)
   Address: 7XYZ...abc
   Balance: 2.5000 SOL
   ✅ Good balance for launches

✅ Pump Portal Wallet (PUMP_PORTAL_WALLET_ADDRESS)
   Address: ABC...xyz
   Balance: 0.0000 SOL
   ⚠️ Needs funding (agent will auto-deposit)

✅ All required wallet configs present
🚀 Ready to launch!
```

### Test with Agent

```
1. "check wallet balances" → Should show both wallets
2. "deposit 0.5 sol to pump wallet" → Should transfer and return TX
3. Check Phantom app → Should see transaction history
```

## Technical Details

### fundingWallet.ts Functions

```typescript
// Deposit SOL to pump wallet
depositToPumpWallet(amountSol: number): Promise<{ signature: string; balance: number }>

// Check pump wallet balance
getPumpWalletBalance(): Promise<number>

// Check funding wallet balance
getFundingWalletBalance(): Promise<{ address: string; balance: number }>
```

### Agent Actions

```typescript
// CHECK_WALLET_BALANCES
validate: /\b(balance|wallet|fund|sol|check.*wallet|how much)\b/
handler: Shows both wallet balances, readiness status

// DEPOSIT_TO_PUMP_WALLET
validate: /\b(deposit|fund|add.*sol|transfer.*pump)\b/
handler: Extracts amount, transfers SOL, returns TX signature

// LAUNCH_LAUNCHPACK (updated)
validate: /\b(deploy|launch|go live|execute|ready|yes|yea|yeah)\b/
handler: Checks pump wallet, auto-deposits if < 0.3 SOL, launches token
```

## Comparison: SDK vs Direct Key

| Aspect                   | Phantom Connect SDK          | LaunchKit (Direct Key)    |
| ------------------------ | ---------------------------- | ------------------------- |
| **Purpose**              | User-facing dApps            | Autonomous agents         |
| **Approval**             | User clicks "Approve" per TX | Automatic signing         |
| **Use Case**             | DeFi apps, NFT marketplaces  | Bots, agents, trading     |
| **Integration**          | React/Browser SDK            | @solana/web3.js + Keypair |
| **User Online?**         | Required                     | Not required              |
| **Right for LaunchKit?** | ❌ No                        | ✅ Yes                    |

## Documentation Index

- **Setup Guides:**
  - [PHANTOM_INTEGRATION.md](PHANTOM_INTEGRATION.md) - Why & how Phantom works with LaunchKit
  - [WALLET_SETUP.md](WALLET_SETUP.md) - Complete setup walkthrough
  - [QUICKSTART.md](QUICKSTART.md) - Quick reference card
- **Code Files:**
  - `src/launchkit/services/fundingWallet.ts` - Transfer logic
  - `src/launchkit/eliza/walletActions.ts` - Agent actions
  - `scripts/check-wallet.ts` - Verification script
  - `scripts/generate-wallet.ts` - Wallet generator

- **Configuration:**
  - `src/launchkit/env.ts` - Environment variables
  - `.env` - Your configuration (not committed)

## Next Steps

1. **Export your Phantom private key** (or generate new wallet)
2. **Add to `.env`**: `AGENT_FUNDING_WALLET_SECRET=...`
3. **Send SOL** to your funding wallet address
4. **Verify**: `bun run scripts/check-wallet.ts`
5. **Test**: Start agent and try "check balances"
6. **Launch**: Follow full launch flow in docs

## Support

**Configuration issues?**

```bash
bun run scripts/check-wallet.ts  # Diagnose problems
```

**Need new wallet?**

```bash
bun run scripts/generate-wallet.ts  # Create dedicated wallet
```

**Questions about Phantom integration?**

- See [PHANTOM_INTEGRATION.md](PHANTOM_INTEGRATION.md) for FAQ
- Check "Troubleshooting" section in [WALLET_SETUP.md](WALLET_SETUP.md)

---

**Integration Status:** ✅ Complete and ready for testing

Your Phantom wallet is now connected to the LaunchKit agent for autonomous token launches!
