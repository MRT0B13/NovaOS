# 🤖 Auto-Trading & Profit Management

## Overview

LaunchKit includes a sophisticated auto-trading system for managing token positions after launch. These features are **DISABLED by default** for safety.

**Key Features:**

- 📈 Take-profit ladder (sell at 2x, 5x, 10x gains)
- 🛑 Trailing stop-loss protection
- ⏰ Time-based exits
- 💰 Auto-sweep profits to treasury
- 📊 Holdings tracking & reporting

## Safety First

All auto-trading features are **OFF by default**. No autonomous trading occurs without explicit configuration.

```bash
# Default state - everything disabled
AUTO_SELL_ENABLE=false
AUTO_SELL_MODE=off
AUTO_WITHDRAW_ENABLE=false
```

## Auto-Sell Policy

### Configuration

```bash
# Enable auto-sell feature
AUTO_SELL_ENABLE=true

# Mode: off | manual_approve | autonomous
AUTO_SELL_MODE=manual_approve  # Creates intents, waits for approval
# AUTO_SELL_MODE=autonomous    # Executes automatically (use with caution!)

# Safety limits
AUTO_SELL_COOLDOWN_SECONDS=300      # 5 minutes between sells
AUTO_SELL_MAX_PERCENT_PER_TX=20     # Max 20% per transaction
AUTO_SELL_MAX_TX_PER_HOUR=10        # Max 10 transactions per hour
```

### Take-Profit Ladder

Default take-profit levels (can be customized via `AUTO_SELL_POLICY_JSON`):

| Trigger  | Sell Amount | Example                        |
| -------- | ----------- | ------------------------------ |
| 2x gain  | Sell 20%    | Buy 100 tokens → sell 20 at 2x |
| 5x gain  | Sell 30%    | Sell 30% of remaining          |
| 10x gain | Sell 30%    | Sell 30% of remaining          |
| 20x gain | Sell 50%    | Take profits, keep moonbag     |

### Custom Policy

Define your own policy with JSON:

```bash
AUTO_SELL_POLICY_JSON='{"take_profit":[{"at_x":3,"sell_percent":25},{"at_x":10,"sell_percent":50}],"moonbag_percent":10}'
```

### Policy Options

```typescript
interface SellPolicy {
  take_profit_levels: Array<{
    threshold_x: number; // Trigger at this gain (2 = 2x)
    sell_percent: number; // Sell this percentage
  }>;
  trailing_stop?: {
    enabled: boolean;
    activate_at_x?: number; // Start trailing after 2x
    drop_percent?: number; // Trigger if drops 20% from peak
    sell_percent?: number; // Sell 50% when triggered
  };
  time_stop?: {
    enabled: boolean;
    hours_inactive?: number; // Exit after 48h of inactivity
    sell_percent?: number;
  };
  moonbag_percent?: number; // Always keep 10% (never sell)
}
```

### Modes Explained

| Mode             | Behavior                           | Use Case        |
| ---------------- | ---------------------------------- | --------------- |
| `off`            | No auto-selling                    | Default, safest |
| `manual_approve` | Creates sell intents, notifies you | Semi-automated  |
| `autonomous`     | Executes sells automatically       | Fully automated |

## Auto-Withdraw (Treasury Sweep)

### Configuration

```bash
# Enable auto-withdrawal to treasury
AUTO_WITHDRAW_ENABLE=true

# Requires treasury to be configured
TREASURY_ENABLE=true
TREASURY_ADDRESS=YourTreasuryPublicKey

# Minimum reserve to keep
TREASURY_MIN_RESERVE_SOL=0.3
```

### How It Works

1. **Threshold Check**: When pump wallet balance exceeds threshold
2. **Guardrail Check**: Validates daily caps, rate limits
3. **Transfer**: Moves excess SOL to treasury (or funding wallet)
4. **Audit Log**: Records all transfers

### Sweep Thresholds

```bash
# Sweep when balance exceeds this amount (keeping reserve)
TREASURY_SWEEP_THRESHOLD_SOL=1.0

# Example: If pump wallet has 1.5 SOL and threshold is 1.0:
# - Reserve: 0.3 SOL
# - Sweepable: 1.5 - 0.3 = 1.2 SOL
# - Since 1.2 > 1.0 threshold, sweep is triggered
# - Actually swept: 1.2 - 0.3 = 0.9 SOL (keeps reserve)
```

## Holdings Tracking

### Agent Commands

```
User: "show holdings"
User: "report holdings"
User: "what tokens do I have?"
```

### Response

```
📊 Agent Holdings Report

💰 SOL Balance: 2.5432 SOL

🪙 Token Holdings:
• DUMP (Sir Dumps-A-Lot)
  Mint: Dewdpg1yy...Fpump
  Balance: 50,000,000 tokens
  Entry: 0.001 SOL
  Current: 0.0025 SOL (2.5x)

• RUG (GPTRug)
  Mint: CHWDAsq6...
  Balance: 10,000,000 tokens
  Entry: 0.002 SOL
  Current: 0.001 SOL (0.5x)

📈 Total Unrealized: +0.075 SOL
```

## Dev Buy Tracking

When tokens are launched with dev buys, they're tracked:

```typescript
interface DevBuy {
  enabled: boolean;
  amount_sol: number; // SOL spent (0.001 - 1 max)
  tokens_received?: number; // Tokens acquired
  locked_until?: string; // Vesting date (optional)
  disclosed: boolean; // Always true for transparency
}
```

### Transparency

All dev buys are:

- ✅ Disclosed publicly
- ✅ Tracked in LaunchPack
- ✅ Visible in holdings report
- ✅ Subject to take-profit policies

## Guardrails on Trading

All trading operations pass through the guardrail system:

### Rate Limits

| Limit        | Default | Description                           |
| ------------ | ------- | ------------------------------------- |
| Max % per TX | 20%     | Can't sell more than 20% at once      |
| Max TX/hour  | 10      | Maximum 10 sell transactions per hour |
| Cooldown     | 5 min   | Minimum 5 minutes between sells       |
| Slippage     | 10%     | Reject if slippage exceeds 10%        |

### Error Codes

| Code                      | Meaning                         |
| ------------------------- | ------------------------------- |
| `AUTO_SELL_NOT_ENABLED`   | Feature not enabled             |
| `MAX_PERCENTAGE_EXCEEDED` | Trying to sell too much at once |
| `HOURLY_RATE_EXCEEDED`    | Too many transactions this hour |
| `COOLDOWN_ACTIVE`         | Must wait for cooldown          |
| `SLIPPAGE_TOO_HIGH`       | Market conditions unfavorable   |

## Audit Trail

Every trade is logged:

```json
{
  "timestamp": "2026-01-22T14:30:00.000Z",
  "operation": "sell",
  "actor": "auto-sell-policy",
  "trigger": "TP2",
  "reason": "Take-profit at 5x triggered (current: 5.2x)",
  "amount_tokens": 15000000,
  "amount_sol": 0.075,
  "percent_of_holding": 30,
  "tx_signature": "5xY9...",
  "result": "success"
}
```

## Best Practices

### Getting Started

1. Start with `AUTO_SELL_MODE=off`
2. Launch tokens, observe prices manually
3. Enable `manual_approve` mode
4. Review sell intents before approving
5. Only enable `autonomous` after confidence

### Conservative Policy

```bash
# Low-risk settings
AUTO_SELL_ENABLE=true
AUTO_SELL_MODE=manual_approve
AUTO_SELL_MAX_PERCENT_PER_TX=10
AUTO_SELL_COOLDOWN_SECONDS=600
```

### Aggressive Policy

```bash
# Higher risk, faster execution
AUTO_SELL_ENABLE=true
AUTO_SELL_MODE=autonomous
AUTO_SELL_MAX_PERCENT_PER_TX=25
AUTO_SELL_COOLDOWN_SECONDS=120
AUTO_SELL_POLICY_JSON='{"take_profit":[{"at_x":1.5,"sell_percent":20},{"at_x":3,"sell_percent":40}]}'
```

## Files Reference

| File                                           | Purpose                   |
| ---------------------------------------------- | ------------------------- |
| `src/launchkit/services/autoSellPolicy.ts`     | Take-profit ladder logic  |
| `src/launchkit/services/treasuryService.ts`    | Treasury operations       |
| `src/launchkit/services/treasuryScheduler.ts`  | Auto-sweep scheduling     |
| `src/launchkit/services/operatorGuardrails.ts` | Rate limits & safety      |
| `src/launchkit/eliza/walletActions.ts`         | Agent wallet commands     |
| `src/launchkit/services/fundingWallet.ts`      | Actual transfer execution |

## Environment Variables Summary

```bash
# Auto-Sell
AUTO_SELL_ENABLE=false
AUTO_SELL_MODE=off
AUTO_SELL_POLICY_JSON=
AUTO_SELL_COOLDOWN_SECONDS=300
AUTO_SELL_MAX_PERCENT_PER_TX=20
AUTO_SELL_MAX_TX_PER_HOUR=10

# Auto-Withdraw
AUTO_WITHDRAW_ENABLE=false

# Treasury (required for auto-withdraw)
TREASURY_ENABLE=false
TREASURY_ADDRESS=
TREASURY_MIN_RESERVE_SOL=0.3
TREASURY_LOG_ONLY=true
TREASURY_SWEEP_THRESHOLD_SOL=1.0
```
