# 🛡️ Treasury & Guardrails System

## Overview

LaunchKit includes a comprehensive security layer for all financial operations. The **Operator Guardrails** system provides:

- **Feature flags** - Enable/disable operations
- **Rate limiting** - Caps on daily withdrawals and hourly transactions
- **Allowlists** - Only treasury address for withdrawals
- **Cooldowns** - Prevent rapid-fire operations
- **Audit logging** - Every operation logged

## Treasury Configuration

### Environment Variables

```bash
# ================================
# Treasury Configuration (Optional)
# ================================

# Enable treasury mode (sends profits to treasury instead of funding wallet)
TREASURY_ENABLE=false

# Treasury wallet address (PUBLIC KEY ONLY - never store private key)
# This is the destination for all profit withdrawals when enabled
TREASURY_ADDRESS=YourTreasuryPublicKeyHere

# Minimum SOL to keep in pump wallet (reserve for gas/future operations)
TREASURY_MIN_RESERVE_SOL=0.3

# Log-only mode (simulate transfers without executing)
# Set to 'false' only when ready for production
TREASURY_LOG_ONLY=true
```

### Treasury Modes

| Mode           | TREASURY_ENABLE | TREASURY_LOG_ONLY | Behavior                                    |
| -------------- | --------------- | ----------------- | ------------------------------------------- |
| **Disabled**   | `false`         | any               | Profits go to funding wallet                |
| **Log Only**   | `true`          | `true`            | Simulates transfers, logs what would happen |
| **Production** | `true`          | `false`           | Actually transfers to treasury address      |

## Wallet Architecture

```
┌─────────────────────────────────┐
│  Funding Wallet                 │  ← Your Phantom wallet
│  (AGENT_FUNDING_WALLET_SECRET)  │     Deposits SOL for launches
└──────────────┬──────────────────┘
               │ deposit
               ↓
┌─────────────────────────────────┐
│  Pump Portal Wallet             │  ← Token creation wallet
│  (PUMP_PORTAL_WALLET_ADDRESS)   │     Accumulates profits
└──────────────┬──────────────────┘
               │ withdraw
               ↓
┌─────────────────────────────────┐
│  Treasury Wallet (optional)     │  ← Cold storage / team wallet
│  (TREASURY_ADDRESS)             │     Receives profits
└─────────────────────────────────┘
```

## Guardrails System

### Protected Operations

All these operations pass through the guardrail gate:

| Operation  | What It Does             | Guardrails Applied            |
| ---------- | ------------------------ | ----------------------------- |
| `launch`   | Create token on pump.fun | Feature flag, balance check   |
| `buy`      | Purchase tokens          | Balance, slippage             |
| `sell`     | Sell tokens              | Rate limit, max %, cooldown   |
| `withdraw` | Move SOL out             | Daily cap, allowlist, reserve |
| `sweep`    | Auto-collect profits     | Same as withdraw              |
| `deposit`  | Add SOL to pump wallet   | Balance check                 |

### Daily Caps

Treasury withdrawals are capped per day:

```typescript
interface TreasuryCaps {
  day: string; // YYYY-MM-DD (resets at midnight UTC)
  withdrawn_sol: number; // SOL withdrawn today
  withdraw_count: number; // Number of withdrawals today
  last_withdraw_at?: string;
}
```

**Default limit**: Configurable via environment (default ~10 SOL/day)

### Hourly Rate Limits

Sell operations are rate-limited per hour:

```typescript
interface SellRateLimits {
  hour_key: string; // YYYY-MM-DDTHH (resets each hour)
  tx_count: number; // Transactions this hour
  last_tx_at?: string;
}
```

**Default limit**: ~5 transactions per hour

### Error Codes

When guardrails block an operation:

| Error Code                | Meaning                         |
| ------------------------- | ------------------------------- |
| `TREASURY_NOT_ENABLED`    | Treasury mode not enabled       |
| `TREASURY_NOT_CONFIGURED` | Missing TREASURY_ADDRESS        |
| `DAILY_CAP_EXCEEDED`      | Hit daily withdrawal limit      |
| `HOURLY_RATE_EXCEEDED`    | Too many transactions this hour |
| `DESTINATION_NOT_ALLOWED` | Address not in allowlist        |
| `INSUFFICIENT_BALANCE`    | Not enough SOL                  |
| `COOLDOWN_ACTIVE`         | Must wait before next operation |
| `SLIPPAGE_TOO_HIGH`       | Price slippage exceeds limit    |

## Agent Commands

### Check Balances

```
User: "check balances"
Agent: Shows funding wallet + pump wallet SOL balances
```

### Deposit to Pump Wallet

```
User: "deposit 0.5 sol to pump wallet"
Agent: Transfers 0.5 SOL from funding → pump wallet
```

### Withdraw Profits

```
User: "withdraw profits"
Agent: Transfers profits to funding wallet (leaves 0.3 SOL reserve)
```

### Custom Withdrawal

```
User: "withdraw 2 sol leave 0.5 sol reserve"
Agent: Withdraws 2 SOL, keeps 0.5 SOL in pump wallet
```

### Withdraw to Treasury

```
User: "withdraw to treasury"
Agent: Sends profits to treasury address (if enabled)
```

## Audit Logging

Every financial operation is logged to LaunchPack's `ops.audit_log`:

```json
{
  "timestamp": "2026-01-22T14:30:00.000Z",
  "operation": "withdraw",
  "actor": "user",
  "amount_sol": 1.5,
  "destination": "TreasuryAddress...",
  "result": "success",
  "tx_signature": "5xY9..."
}
```

## Best Practices

### Development/Testing

1. Keep `TREASURY_ENABLE=false` - profits go to your funding wallet
2. Use small amounts for testing
3. Check balances frequently

### Staging

1. Set `TREASURY_ENABLE=true`
2. Keep `TREASURY_LOG_ONLY=true`
3. Monitor logs to verify behavior
4. Check audit logs for expected operations

### Production

1. Set `TREASURY_ENABLE=true`
2. Set `TREASURY_LOG_ONLY=false`
3. Verify `TREASURY_ADDRESS` is correct cold wallet
4. Set appropriate `TREASURY_MIN_RESERVE_SOL` (recommend 0.3-0.5)
5. Monitor audit logs regularly

## Security Notes

⚠️ **Treasury Address**: Store only the PUBLIC KEY in `.env`. Never store the treasury's private key - it should be a cold wallet or multisig.

⚠️ **Allowlist**: Withdrawals ONLY go to the configured treasury address or back to funding wallet. Arbitrary addresses are blocked.

⚠️ **Rate Limits**: Even if compromised, daily caps limit damage.

⚠️ **Audit Trail**: Every operation logged for forensic review.

## Troubleshooting

### "Treasury not enabled"

Set `TREASURY_ENABLE=true` in `.env`

### "Treasury address required"

Add `TREASURY_ADDRESS=YourPublicKey` in `.env`

### "Daily cap exceeded"

Wait until midnight UTC for cap reset, or adjust cap limits.

### "Destination not allowed"

Only treasury address or funding wallet are valid destinations.

### Operations logged but not executed

Check if `TREASURY_LOG_ONLY=true` - set to `false` for real transfers.

## Files Reference

| File                                           | Purpose                      |
| ---------------------------------------------- | ---------------------------- |
| `src/launchkit/services/operatorGuardrails.ts` | Main guardrail gate function |
| `src/launchkit/services/fundingWallet.ts`      | Wallet transfer logic        |
| `src/launchkit/services/audit.ts`              | Audit log functions          |
| `src/launchkit/eliza/walletActions.ts`         | Agent wallet commands        |
| `src/launchkit/env.ts`                         | Environment validation       |
