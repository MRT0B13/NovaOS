# LaunchKit Agent Wallet Setup

## Important: Why Not Phantom SDK?

**Phantom Connect SDK** is for browser/mobile apps where users manually approve each transaction.

**LaunchKit Agent** is autonomous - it needs to send transactions automatically without user approval. Therefore, we use the **wallet's private key directly** with `@solana/web3.js`.

You can use your **Phantom wallet** as the funding source by exporting its private key (see below), but we don't use the Phantom SDK itself.

## Wallet Architecture

LaunchKit uses a **dual wallet system** for secure token launches:

```
┌─────────────────────────────────┐
│  Agent Funding Wallet           │  ← Your main SOL wallet
│  (AGENT_FUNDING_WALLET_SECRET)  │
│  • Holds SOL                    │
│  • Controlled by agent          │
└──────────────┬──────────────────┘
               │ Deposits SOL
               ↓
┌─────────────────────────────────┐
│  Pump Portal Wallet             │  ← pump.fun API wallet
│  (PUMP_PORTAL_WALLET_ADDRESS)   │
│  • Receives deposits            │
│  • Creates tokens               │
└─────────────────────────────────┘
```

## Why Two Wallets?

1. **Security**: Funding wallet holds your main SOL, pump wallet only gets what's needed
2. **Flexibility**: Agent can auto-fund launches without manual intervention
3. **Tracking**: Clear separation between funding and token creation

## Setup Instructions

### 1. Get your Pump Portal wallet (if you don't have one)

Your `.env` should already have:

```bash
PUMP_PORTAL_API_KEY=your_api_key
PUMP_PORTAL_WALLET_ADDRESS=your_pump_wallet_address
PUMP_PORTAL_WALLET_SECRET=your_pump_wallet_secret
```

### 2. Create Agent Funding Wallet

The agent needs a Solana wallet it can control programmatically. You have several options:

**Option A: Use Your Phantom Wallet (Recommended for Existing Users)**

1. Open Phantom wallet extension/app
2. Click Settings (gear icon) → Security & Privacy
3. Scroll to "Export Private Key"
4. Enter your password
5. Click "Copy Private Key" - this is your `AGENT_FUNDING_WALLET_SECRET`
6. ⚠️ **Keep this safe** - anyone with this key can spend your SOL

**Why this works:** The agent uses your Phantom wallet's keypair programmatically via `@solana/web3.js`. Your Phantom wallet becomes the agent's funding source.

**Option B: Generate new dedicated wallet (Recommended for New Users)**
**Option B: Generate new dedicated wallet (Recommended for New Users)**

```bash
# Install Solana CLI if needed
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Generate new keypair
solana-keygen new --outfile ~/agent-funding-wallet.json

# Get the public key (this is where you send SOL)
solana-keygen pubkey ~/agent-funding-wallet.json

# Get private key in base58 format for .env:
# The JSON file contains the keypair, you need to convert it to base58
```

To convert to base58:

```javascript
// convert-key.js
const fs = require("fs");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");

const keyfile = fs.readFileSync(process.argv[2]);
const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(keyfile)));
console.log("Public Key:", keypair.publicKey.toBase58());
console.log("Private Key (base58):", bs58.encode(keypair.secretKey));
```

Run: `node convert-key.js ~/agent-funding-wallet.json`

**Option C: Create with code**
**Option C: Create with code**

```javascript
// generate-wallet.js
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");

const keypair = Keypair.generate();
console.log("Public Key:", keypair.publicKey.toBase58());
console.log("Private Key (base58):", bs58.encode(keypair.secretKey));
console.log("\n⚠️  Save these securely! Private key = full wallet access");
```

Run: `node generate-wallet.js`

**Which option should you choose?**

- **Use Phantom wallet** if you already have SOL and want to use that wallet
- **Generate new wallet** if you want a dedicated agent wallet separate from your personal funds

### 3. Add to .env

```bash
# Agent's funding wallet (your main SOL wallet)
AGENT_FUNDING_WALLET_SECRET=your_base58_private_key_here

# Solana RPC (optional, defaults to mainnet)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

### 4. Fund the Agent Wallet

Send SOL to your agent's funding wallet public address:

```bash
# Check balance
solana balance YOUR_AGENT_PUBLIC_KEY

# Or ask the agent:
# You: "check wallet balances"
# Agent will show both wallet balances
```

**Recommended funding**:

- Development/testing: 0.5-1 SOL
- Production launches: 5-10 SOL (for multiple launches)

### 5. Test the Setup

Start your agent and test:

```bash
# 1. Check balances
User: "check wallet balances"
# Agent shows funding wallet and pump wallet balances

# 2. Deposit to pump wallet
User: "deposit 0.5 sol to pump wallet"
# Agent transfers 0.5 SOL from funding wallet → pump wallet

# 3. Launch (agent auto-deposits if needed)
User: "deploy"
# Agent checks pump wallet, deposits if needed, then launches
```

## Agent Actions

### CHECK_WALLET_BALANCES

```
User: "check balances"
User: "how much SOL do we have?"
User: "wallet status"
```

Shows:

- Agent funding wallet address and balance
- Pump wallet balance
- Ready status for launches

### DEPOSIT_TO_PUMP_WALLET

```
User: "deposit 0.5 sol to pump wallet"
User: "fund pump wallet with 1 SOL"
User: "add sol to pump wallet"
```

Transfers SOL from agent funding wallet → pump wallet

### LAUNCH_LAUNCHPACK (auto-deposits)

```
User: "deploy"
User: "launch it"
User: "go live"
```

- Checks pump wallet balance
- If < 0.3 SOL, automatically deposits from funding wallet
- Launches token on pump.fun
- Returns mint address, transaction signature, pump.fun URL

## Typical Launch Flow

```
1. User: "I want to launch a token about rescue dogs"
   Agent: [discusses concept, refines narrative]

2. User: "create the launchpack"
   Agent: [generates marketing materials via GENERATE_LAUNCHPACK_COPY]

3. User: "check balances"
   Agent: Shows funding wallet: 5 SOL, pump wallet: 0 SOL

4. User: "deploy"
   Agent:
   - Checks pump wallet (0 SOL)
   - Deposits 0.5 SOL from funding wallet → pump wallet
   - Launches token
   - Returns: mint address, tx signature, pump URL
   - Posts to X and Telegram automatically
```

## Security Notes

1. **Private keys**: Never share `AGENT_FUNDING_WALLET_SECRET` or `PUMP_PORTAL_WALLET_SECRET`
2. **Funding amounts**: Only keep what you need for launches in funding wallet
3. **RPC endpoint**: Use private RPC for production (public RPCs rate limit)
4. **Backups**: Save your funding wallet keypair securely

## Troubleshooting

### "AGENT_FUNDING_WALLET_SECRET not configured"

- Add `AGENT_FUNDING_WALLET_SECRET=...` to your `.env`
- Restart the agent

### "Insufficient balance in funding wallet"

- Send more SOL to your agent's funding wallet address
- Check balance: `solana balance YOUR_AGENT_PUBLIC_KEY`

### "Failed to deposit: Transaction failed"

- Check Solana network status
- Verify RPC URL is working
- Ensure funding wallet has enough SOL + fees (~0.01 SOL for tx)

### Agent doesn't auto-deposit before launch

- Update to latest LaunchKit code
- Verify `AGENT_FUNDING_WALLET_SECRET` is set correctly
- Check agent logs for errors

## Cost Estimates

Per token launch:

- Token creation: ~0.02-0.05 SOL (pump.fun fee)
- Dev buy: 0.1-0.5 SOL (your initial buy)
- Transaction fees: ~0.001 SOL
- **Total**: ~0.3-0.6 SOL per launch

Keep funding wallet topped up for multiple launches.
