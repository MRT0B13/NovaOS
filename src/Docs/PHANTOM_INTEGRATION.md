# Phantom Wallet Integration Guide

## Why Not Use Phantom SDK?

**TL;DR:** Phantom SDK is for user-facing apps. LaunchKit is an autonomous agent that needs direct wallet control.

### Phantom Connect SDK vs Direct Key Usage

| Feature                  | Phantom Connect SDK                       | LaunchKit Approach                        |
| ------------------------ | ----------------------------------------- | ----------------------------------------- |
| **Use Case**             | Browser/mobile apps with user interaction | Autonomous agent operations               |
| **Transaction Approval** | User clicks "Approve" for each tx         | Automatic signing, no user intervention   |
| **Integration**          | React/Browser/React Native SDK            | Direct `@solana/web3.js` + private key    |
| **Best For**             | DeFi frontends, NFT marketplaces, dApps   | Bots, agents, automated trading, launches |

### What LaunchKit Actually Does

```typescript
// LaunchKit uses your Phantom wallet's private key directly:
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Load your Phantom wallet's private key from .env
const keypair = Keypair.fromSecretKey(
  bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET)
);

// Agent can now sign transactions automatically
const transaction = new Transaction().add(
  SystemProgram.transfer({ ... })
);
await connection.sendTransaction(transaction, [keypair]);
```

**This is the correct approach for autonomous agents.**

## Using Your Phantom Wallet with LaunchKit

### Option 1: Export Existing Phantom Wallet (Easiest)

If you already have SOL in Phantom, use that wallet as your funding source:

**Step 1: Export Private Key from Phantom**

1. Open Phantom wallet (browser extension or mobile app)
2. Click the hamburger menu (☰) or Settings gear (⚙️)
3. Navigate to: **Settings** → **Security & Privacy**
4. Scroll down to **Export Private Key**
5. Enter your password to unlock
6. Click **Copy Private Key**
7. You now have your base58-encoded private key

**Step 2: Add to .env**

```bash
# Your Phantom wallet's private key (the agent will use this wallet)
AGENT_FUNDING_WALLET_SECRET=your_copied_private_key_here

# Optional: Custom RPC endpoint
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

**Step 3: Verify**

```bash
# Check that wallet is configured correctly
bun run scripts/check-wallet.ts
```

You should see:

```
✅ Agent Funding Wallet (AGENT_FUNDING_WALLET_SECRET)
   Address: YourPhantomWalletAddress...
   Balance: 1.2345 SOL
   ✅ Good balance for launches
```

**That's it!** Your Phantom wallet is now the agent's funding source.

### Option 2: Generate New Dedicated Wallet

If you want a separate wallet just for the agent:

```bash
# Generate new wallet
bun run scripts/generate-wallet.ts

# Copy the private key it outputs
# Add to .env: AGENT_FUNDING_WALLET_SECRET=...

# Send SOL to the public address shown
# (You can send from your Phantom wallet!)

# Verify
bun run scripts/check-wallet.ts
```

## How It Works: Dual Wallet System

LaunchKit uses TWO wallets:

```
┌──────────────────────────────────┐
│  Your Phantom Wallet             │  ← You control this (via private key in .env)
│  (AGENT_FUNDING_WALLET_SECRET)   │
│                                  │
│  • Holds your SOL                │
│  • Agent uses for deposits       │
│  • You can check balance in      │
│    Phantom app anytime           │
└───────────────┬──────────────────┘
                │
                │ Agent auto-deposits before launches
                ↓
┌──────────────────────────────────┐
│  Pump Portal Wallet              │  ← pump.fun's API wallet
│  (PUMP_PORTAL_WALLET_ADDRESS)    │
│                                  │
│  • Receives deposits from above  │
│  • Used for token creation       │
│  • ~0.3-0.5 SOL per launch       │
└──────────────────────────────────┘
```

### Launch Flow Example

```
User: "deploy the token"
  ↓
Agent: Check pump wallet balance
  ↓
Pump wallet: 0.1 SOL (not enough)
  ↓
Agent: Auto-deposit 0.5 SOL from YOUR PHANTOM WALLET → pump wallet
  ↓
Agent: Launch token with pump wallet
  ↓
Result: Token created, mint address returned
```

**Your Phantom wallet balance will decrease by 0.5 SOL** when the agent deposits for launch. You can see this transaction in your Phantom wallet's activity history!

## Verifying Your Phantom Integration

After adding `AGENT_FUNDING_WALLET_SECRET` to `.env`:

### 1. Check Configuration

```bash
bun run scripts/check-wallet.ts
```

Expected output:

```
🔍 LaunchKit Wallet Configuration Check

═══════════════════════════════════════════════

✅ Agent Funding Wallet (AGENT_FUNDING_WALLET_SECRET)
   Address: 7XYZ...abc (your Phantom address)
   Balance: 2.5000 SOL
   ✅ Good balance for launches

✅ Pump Portal Wallet (PUMP_PORTAL_WALLET_ADDRESS)
   Address: ABC...xyz
   Balance: 0.0000 SOL
   ⚠️  Needs funding for launches
   Agent will auto-deposit from funding wallet when launching

═══════════════════════════════════════════════

📊 Configuration Status:
   ✅ All required wallet configs present

🚀 Ready to launch!
```

### 2. Test Balance Check with Agent

```
User: "check wallet balances"

Agent: 💰 **Wallet Status**

**Agent Funding Wallet**
Address: `7XYZ...abc`
Balance: 2.5000 SOL

**Pump Portal Wallet**
Balance: 0.0000 SOL

⚠️ Pump wallet needs funds! Use DEPOSIT_TO_PUMP_WALLET to add SOL.
```

### 3. Test Manual Deposit

```
User: "deposit 0.5 sol to pump wallet"

Agent: ✅ **Deposited 0.5 SOL to pump wallet**

Transaction: `5Qb...xyz`
Pump wallet balance: 0.5000 SOL

Ready for token launches! 🚀
```

**Check your Phantom app** - you'll see the 0.5 SOL transfer transaction in your history!

### 4. Test Automatic Launch Funding

```
User: "launch it"

Agent:
- Checking pump wallet... 0 SOL
- Depositing 0.5 SOL from funding wallet...
- ✅ Deposited
- 🚀 Deploying to pump.fun...
- ✅ Token deployed!
  Mint: Abc...xyz
  Tx: 5Qb...xyz
  Chart: https://pump.fun/Abc...xyz
```

## Security Best Practices

### ✅ Do's

- **DO** use a dedicated wallet for the agent if you have a lot of SOL
- **DO** add `AGENT_FUNDING_WALLET_SECRET` to `.env` (which is gitignored)
- **DO** keep only what you need for launches in the funding wallet
- **DO** back up your private key securely (password manager, encrypted file)
- **DO** monitor transactions in your Phantom app

### ❌ Don'ts

- **DON'T** share your private key with anyone
- **DON'T** commit `.env` to git
- **DON'T** screenshot or paste your private key in public channels
- **DON'T** keep large amounts if you're just testing
- **DON'T** use Phantom SDK (it's for user-facing apps, not agents)

## Comparison: User App vs Agent

### User-Facing DeFi App (Uses Phantom SDK)

```typescript
import { PhantomProvider } from "@phantom/wallet-sdk";

// User clicks "Connect Wallet"
const provider = new PhantomProvider();
await provider.connect();

// User clicks "Approve" for each transaction
const signature = await provider.signAndSendTransaction(transaction);
// ↑ Requires user to click "Approve" in Phantom popup
```

### LaunchKit Agent (Uses Private Key)

```typescript
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Agent loads wallet from .env
const keypair = Keypair.fromSecretKey(
  bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET)
);

// Agent signs automatically (no user interaction)
const signature = await connection.sendTransaction(transaction, [keypair]);
// ↑ No popup, no approval - fully autonomous
```

**For LaunchKit, we NEED the second approach** because the agent operates autonomously.

## FAQ

**Q: Is it safe to give my Phantom private key to the agent?**

A: The agent doesn't "get" your key - you're running the agent code yourself, and the key stays in your `.env` file on your machine. The agent uses it to sign transactions locally, just like you clicking "Approve" in Phantom. That said, only use wallets with amounts you're comfortable with, and consider using a dedicated wallet.

**Q: Can I still use Phantom app with this wallet?**

A: Yes! The private key is the same whether accessed by Phantom app or the agent code. You can import the same wallet into Phantom and use both simultaneously. Check your Phantom app to see agent transactions.

**Q: Will the agent drain my wallet?**

A: The agent only spends SOL when you explicitly command launches. Check `src/launchkit/eliza/walletActions.ts` to see exactly what actions can spend funds. Each launch costs ~0.3-0.5 SOL.

**Q: Why not use Phantom Connect SDK?**

A: Phantom Connect is for apps where users manually approve transactions. LaunchKit is autonomous - it needs to execute launches automatically while you sleep. This requires direct private key access, not the SDK.

**Q: Can I use a hardware wallet?**

A: Not directly with LaunchKit, because hardware wallets require manual transaction approval. Use a software wallet (Phantom, or generate new with our script) and keep only launch funds in it.

**Q: What if I lose my private key?**

A: Your SOL is lost. Always back up your private key securely. Phantom has seed phrase backup - use that as your ultimate backup.

## Troubleshooting

### "Invalid AGENT_FUNDING_WALLET_SECRET"

- Make sure you copied the full private key from Phantom (starts with base58 characters, typically 87-88 characters long)
- No spaces, no quotes around the key in `.env`
- Format: `AGENT_FUNDING_WALLET_SECRET=5Abc123...xyz`

### "Insufficient balance in funding wallet"

- Your Phantom wallet doesn't have enough SOL
- Send SOL to the address shown in `bun run scripts/check-wallet.ts`
- Or send from Phantom app to that address

### "Transaction failed"

- Check Solana network status: https://status.solana.com/
- Your RPC might be rate limited - consider using a private RPC
- Ensure funding wallet has enough for tx fees (~0.001 SOL)

### "Agent didn't auto-deposit before launch"

- Verify `AGENT_FUNDING_WALLET_SECRET` is set correctly
- Check funding wallet has enough SOL
- Check agent logs for errors
- Try manual deposit first: "deposit 0.5 sol to pump wallet"

## Summary

1. **Export private key from Phantom** (Settings → Security → Export Private Key)
2. **Add to `.env`**: `AGENT_FUNDING_WALLET_SECRET=your_key`
3. **Verify**: `bun run scripts/check-wallet.ts`
4. **Test**: Agent can now automatically fund and launch tokens

Your Phantom wallet = Agent's funding source. Simple as that!
