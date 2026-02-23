# NovaOS — CFO Agent Production Audit

**Date:** 2026-02-23  
**Repo:** github.com/MRT0B13/NovaOS (main branch, 172 commits)  
**Scope:** Full audit of CFO agent and its integration into the Nova swarm  
**Method:** Live source inspection — all findings are file-and-line verified

---

## Executive Summary

The CFO is substantially complete and better than the original design — the addition of a proper decision engine, approval persistence across restarts, and a 3-tier approval system are all solid improvements. The swarm wiring is fully in place (types, index, supervisor, Telegram commands). However there are **two bugs that will silently corrupt data at runtime**, **one critical emergency path gap**, and **several operational gaps** that will hurt you in production. None of these are showstoppers, but fix the critical ones before you go live with real capital.

---

## 🔴 Critical Bugs (Fix Before Live Capital)

### 1. `createPythOracle()` Does Not Exist

**File:** `src/agents/cfo.ts` line 365  
**Impact:** HL positions are persisted with `entryPrice = 0`, corrupting all P&L calculations in the DB permanently.

```typescript
// cfo.ts line 365 — BROKEN
const pyth = await import("../launchkit/cfo/pythOracleService.ts");
entryPrice = await (await pyth.createPythOracle()).getSolPrice();
// ^^^ createPythOracle() does not exist. pythOracleService exports standalone functions only.
```

The `try/catch` swallows the error silently, so `entryPrice` stays 0. When the DB records a SOL SHORT position at $0, every subsequent P&L calculation (`unrealized_pnl_usd = current_value - cost_basis`) will be wrong.

**Fix — replace lines 363–366 with:**

```typescript
try {
  const { getSolPrice } = await import("../launchkit/cfo/pythOracleService.ts");
  entryPrice = await getSolPrice();
} catch {
  /* non-fatal */
}
```

---

### 2. Decision Engine Cooldowns Are In-Memory — Lost on Every Restart

**File:** `src/launchkit/cfo/decisionEngine.ts` line 216  
**Impact:** After any Railway redeploy or crash, all cooldowns reset. The 4-hour hedge cooldown, 6-hour stake cooldown, and 1-hour close cooldown all go back to zero. In a volatile market, a restart during a downswing could cause the CFO to immediately fire another hedge on top of an existing one.

```typescript
// decisionEngine.ts line 216 — dies on restart
const lastDecisionAt: Record<string, number> = {};
```

This is a module-level object. Every redeploy wipes it.

**Fix — persist cooldowns to `kv_store` in the same `persistState` call already in `cfo.ts`.** In `cfo.ts`, add cooldown data to `persistState()`:

```typescript
// In persistState():
await this.saveState({
  cycleCount: this.cycleCount,
  startedAt: this.startedAt,
  approvalCounter: this.approvalCounter,
  pendingApprovals: serializedApprovals,
  lastDecisionAt: getLastDecisionAt(), // new export from decisionEngine
});

// In restorePersistedState():
if (s.lastDecisionAt) restoreLastDecisionAt(s.lastDecisionAt); // new export
```

Add two exports to `decisionEngine.ts`:

```typescript
export function getLastDecisionAt(): Record<string, number> {
  return { ...lastDecisionAt };
}
export function restoreLastDecisionAt(data: Record<string, number>): void {
  Object.assign(lastDecisionAt, data);
}
```

---

### 3. Guardian → CFO Emergency Path Only Covers Token Rugs, Not Market Events

**Files:** `src/agents/guardian.ts`, `src/agents/supervisor.ts` line 277  
**Impact:** The CFO handles `market_crash` and will pause + close positions. But this signal only reaches the CFO when Guardian detects a critical **token rug** (safety score). LP drain >40%, price crash >30%, and volume spike >5× on watched tokens only post to social channels — they never trigger CFO emergency close.

From `supervisor.ts`:

```typescript
// Line 277 — only fires for guardian:alert with token rug data
await this.sendMessage("nova-cfo", "alert", "critical", {
  command: "market_crash",
  source: "guardian",
  tokenAddress,
  score,
  alerts, // token-specific fields
});
```

The LP drain / price crash handlers in `supervisor.ts` (lines 355–395) forward to CFO as `narrative_update` (low priority intel), not `market_crash`. A 30% crash in SOL itself would not trigger CFO emergency close.

**Fix — in `supervisor.ts`, update the guardian alert handler for LP/price crash events:**

```typescript
// In the nova-guardian:alert handler, add:
if (source === "lp_drain" || source === "price_crash") {
  const isSevere =
    (msg.payload.dropPct ?? 0) > 60 || (msg.payload.crashPct ?? 0) > 40;
  if (isSevere) {
    await this.sendMessage("nova-cfo", "alert", "critical", {
      command: "market_crash",
      source: "guardian",
      message: msg.payload.summary ?? `Guardian: ${source} detected`,
    });
  }
}
```

---

## 🟠 Serious Operational Gaps

### 4. `.env.example` Has Zero CFO Variables

**File:** `.env.example`  
**Count:** 55 CFO\_ environment variables in `env.ts` schema, 0 documented in `.env.example`

Anyone deploying this from scratch — including yourself on a fresh Railway instance — has no reference for what to set. The decision engine alone adds 21 new env vars (`CFO_AUTO_DECISIONS`, `CFO_DECISION_INTERVAL`, `CFO_AUTO_HEDGE`, `CFO_HEDGE_TARGET_RATIO`, `CFO_HL_STOP_LOSS_PCT`, etc.) that aren't documented anywhere.

**Fix — add a CFO section to `.env.example`:**

```bash
# ============================================================================
# 🏦 CFO AGENT — Autonomous Financial Operator
# ============================================================================
CFO_ENABLE=false                         # Master switch — start false
CFO_DRY_RUN=true                         # ALWAYS start true, validate first
CFO_DAILY_REPORT_HOUR=8                  # UTC hour for daily P&L digest

# Decision Engine
CFO_AUTO_DECISIONS=false                 # Enable autonomous decision loop
CFO_DECISION_INTERVAL=30                 # Minutes between decision cycles
CFO_AUTO_TIER_USD=50                     # Below this: execute silently
CFO_NOTIFY_TIER_USD=200                  # Below this: execute + notify admin
CFO_APPROVAL_EXPIRY_MINUTES=30           # How long approval requests live
CFO_CRITICAL_BYPASS_APPROVAL=true        # Stop-loss executes without approval

# Polymarket
CFO_POLYMARKET_ENABLE=false
CFO_EVM_PRIVATE_KEY=                     # DEDICATED Polygon wallet (not your main)
CFO_POLYGON_RPC_URL=https://polygon-rpc.com
CFO_MAX_POLYMARKET_USD=200               # Max USDC deployed across all bets
CFO_MAX_SINGLE_BET_USD=50               # Max per bet
CFO_KELLY_FRACTION=0.25                  # Fractional Kelly (0.25 = conservative)
CFO_MIN_EDGE=0.05                        # Minimum edge to place bet (5%)
CFO_AUTO_POLYMARKET=true

# Hyperliquid (hedging SOL treasury)
CFO_HYPERLIQUID_ENABLE=false
CFO_HYPERLIQUID_API_WALLET_KEY=          # HL API wallet key (separate from main)
CFO_HYPERLIQUID_TESTNET=true             # Use testnet first
CFO_ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
CFO_MAX_HYPERLIQUID_USD=500
CFO_MAX_HYPERLIQUID_LEVERAGE=3           # Hard cap (architecture limit: 5)
CFO_AUTO_HEDGE=true
CFO_HEDGE_TARGET_RATIO=0.50             # Hedge 50% of SOL exposure
CFO_HEDGE_MIN_SOL_USD=100               # Don't hedge below this SOL value
CFO_HEDGE_REBALANCE_THRESHOLD=0.15      # Rebalance if ratio drifts ±15%
CFO_HL_STOP_LOSS_PCT=25                 # Close HL position at 25% loss
CFO_HL_LIQUIDATION_WARNING_PCT=15       # Alert when 15% from liquidation

# Kamino (Solana lending yield)
CFO_KAMINO_ENABLE=false
CFO_MAX_KAMINO_USD=1000
CFO_KAMINO_MAX_LTV_PCT=60

# Jito (SOL liquid staking)
CFO_JITO_ENABLE=false
CFO_MAX_JITO_SOL=5
CFO_AUTO_STAKE=true
CFO_STAKE_RESERVE_SOL=0.5               # Keep this much SOL liquid
CFO_STAKE_MIN_SOL=0.1                   # Minimum SOL to stake in one go

# Bridging
CFO_WORMHOLE_ENABLE=false
CFO_LIFI_ENABLE=false
CFO_MAX_BRIDGE_USD=200

# x402 Micropayments
CFO_X402_ENABLE=false
CFO_X402_PRICE_RUGCHECK=0.02
CFO_X402_PRICE_SIGNAL=0.001

# Cooldowns (hours)
CFO_HEDGE_COOLDOWN_HOURS=4
CFO_STAKE_COOLDOWN_HOURS=6
CFO_CLOSE_COOLDOWN_HOURS=1
CFO_POLY_BET_COOLDOWN_HOURS=2
CFO_MAX_DECISIONS_PER_CYCLE=3

# Oracle + Analytics
CFO_PYTH_ENABLE=true
CFO_HELIUS_API_KEY=                      # Free at helius.dev
```

---

### 5. x402 Revenue Is In-Memory Only — Wiped on Every Restart

**File:** `src/launchkit/cfo/x402Service.ts` line 70  
**Impact:** `revenueTracker` is a module-level object. Every Railway redeploy resets total calls, total earned, and 24h revenue to zero. The daily digest will always show $0 x402 revenue after any restart.

```typescript
// x402Service.ts line 70 — wiped on restart
const revenueTracker = {
  totalCalls: 0,
  totalEarned: 0,
  last24hEarned: 0,
  ...
};
```

**Fix — persist x402 revenue to `cfo_transactions` table.** When a payment is received, call `repo.insertTransaction()` with `strategyTag: 'x402'`. Revenue can then be reconstructed from the DB on startup via `getDailyRevenue()`. The repo already exists for this purpose.

Alternatively, add a `cfo_x402_stats` row to `kv_store` updated after each payment and restored on startup — simpler than a full DB query.

---

### 6. Exit Price Is Accepted but Never Stored

**File:** `src/launchkit/cfo/positionManager.ts` line 325  
**Impact:** Low-level data quality issue. The 4-parameter `closePosition` signature accepts `exitPrice` but never passes it to `repo.closePosition()`. The DB `cfo_positions` table has an `exit_price` column (if added to schema) but it will always be null. This means you can't reconstruct position history or calculate proper P&L analysis from the DB alone.

```typescript
// positionManager.ts line 325
async closePosition(
  positionId: string,
  exitPrice: number,    // ← accepted
  exitTxHash: string,
  receivedUsd: number,
): Promise<void> {
  // ...
  await this.repo.closePosition(positionId, exitTxHash, realizedPnl);
  // ^^^ exitPrice is silently dropped — never stored
}
```

**Fix — add `exit_price` to `repo.closePosition()` signature and the SQL UPDATE:**

```typescript
// postgresCFORepository.ts
async closePosition(id: string, exitPrice: number, exitTxHash: string, realizedPnlUsd: number) {
  await this.pool.query(
    `UPDATE cfo_positions
     SET status = 'CLOSED', exit_price = $2, exit_tx_hash = $3, realized_pnl_usd = $4,
         unrealized_pnl_usd = 0, current_value_usd = 0,
         closed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id, exitPrice, exitTxHash, realizedPnlUsd],
  );
}
```

Also check that `exit_price` column exists in your `CREATE TABLE` schema in `postgresCFORepository.ts`. If not, add it to the schema and run a migration.

---

## 🟡 Medium Issues (Fix Before Scaling Capital)

### 7. `kv_store` Decision Audit Trail Has Unbounded Growth

**File:** `src/agents/cfo.ts` line ~450  
**Impact:** Every decision cycle writes a new `kv_store` row with key `cfo_decision_${Date.now()}`. At a 30-minute decision interval, that's 48 rows per day, 1,440 per month, with no cleanup. Over time this table balloons.

**Fix — add a cleanup job.** In `checkDailyDigest()` or as a separate interval, purge decision audit rows older than 30 days:

```typescript
await this.pool.query(
  `DELETE FROM kv_store WHERE key LIKE 'cfo_decision_%' AND (data->>'timestamp')::timestamptz < NOW() - INTERVAL '30 days'`,
);
```

---

### 8. Guardian Broadcast Market Crashes Don't Reach CFO Directly

**Context:** This is a corollary of Critical #3 but worth calling out separately at medium priority.

When Nova's guardian detects a general market crash signal (broad LP drain, volume collapse across all watched tokens simultaneously), the message reaches the CFO only as a low-priority `narrative_update` through the supervisor — the same category as a Scout tweet trend. This means the CFO's `market_crash` handler (which pauses all trading and closes all positions) never fires on broad market events, only on individual token rugs.

This is acceptable risk if you have manual `/cfo close all` available and you're monitoring actively. Escalate to critical if you plan to leave the system unattended overnight.

---

### 9. No Migration Files for CFO DB Tables

**Files:** `sql/` directory only contains `001_health_schema.sql`, `002_security_schema.sql`

The CFO schema (3 tables, 6 indexes) is created inline via `CREATE TABLE IF NOT EXISTS` in `PostgresCFORepository.create()`. This works fine but:

- No record of when the schema was deployed
- Can't run CFO schema in isolation (e.g., testing, staging)
- No rollback path if schema changes

**Fix — add `003_cfo_schema.sql`** extracting the CFO `CREATE TABLE` statements. Low urgency, good hygiene.

---

### 10. `CLOSE_HEDGE` in Decision Engine Makes Two Sequential HL API Calls

**File:** `src/launchkit/cfo/decisionEngine.ts` CLOSE_HEDGE execution block

At decision time, the position exists. At execution time (potentially seconds later), `getAccountSummary()` is called again to find the position. If HL is momentarily unreachable or the position was already closed by a concurrent call, execution fails with "No SOL SHORT position found to reduce."

This is defensive but means a legitimate over-hedge might not get reduced. Not dangerous, just occasionally inefficient. Consider storing the position reference from the decision phase and using it at execution.

---

## ✅ What's Verified Working

The following were checked against the actual source and confirmed correct:

**Swarm wiring:**

- `'cfo'` correctly added to `AgentType` union in `types.ts` ✓
- `CFOAgent` exported, instantiated, and registered in `agents/index.ts` ✓
- CFO stopped first in `stopSwarm()` (financial ops before intel) ✓
- All 55+ CFO env vars registered in `env.ts` Zod schema ✓

**Supervisor → CFO intelligence pipeline (all 4 paths):**

- Scout `narrative_shift` / `quick_scan` / `intel_digest` → forwarded to CFO as `scout_intel` ✓
- Guardian token rug (critical) → forwarded as `market_crash` ✓
- Analyst `defi_snapshot` → forwarded to CFO as `intel` ✓
- Analyst `volume_spike` / `price_alert` → forwarded to CFO as `narrative_update` ✓

**Decision engine:**

- All 21 decision engine env vars present in `env.ts` schema (verified with diff) ✓
- 5-step cycle (gather → consult → assess → decide → execute) properly implemented ✓
- Tier classification logic (AUTO/NOTIFY/APPROVAL) correct ✓
- Critical bypass for stop-loss / liquidation prevention ✓
- Danger market condition bumps tier up one level for safety ✓
- Max 3 decisions per cycle cap enforced ✓

**POLY_BET execution resilience:**

- TokenId mismatch fallback: resolves by `outcome` ('Yes'/'No') if stored tokenId doesn't match at execution time ✓
- Uses scan-time price as fallback if resolved token has no price ✓
- Gas check before every bet ✓

**Approval system:**

- `pendingApprovals` serialized and persisted to `kv_store` on every change ✓
- Restored on restart with action closures rebuilt from `decisionJson` ✓
- Already-expired approvals skipped on restore ✓
- Half-life reminder at 50% of remaining time ✓
- Legacy bets (pre-restart) correctly flagged as non-re-executable ✓

**positionManager.closePosition signature:**

- `cfo.ts` calls `positionManager.closePosition(id, exitPrice, txHash, receivedUsd)` — 4 params ✓
- `positionManager.closePosition` accepts `(positionId, exitPrice, exitTxHash, receivedUsd)` — 4 params ✓
- `repo.closePosition` called with correct 3-param subset `(id, exitTxHash, realizedPnl)` ✓

**Package dependencies:**

- `ethers ^6.16.0` ✓
- `@lifi/sdk ^3.15.6` ✓
- `@wormhole-foundation/sdk ^4.11.0` ✓
- `@kamino-finance/klend-sdk ^7.3.19` ✓
- `@nktkas/hyperliquid ^0.31.0` ✓

**Telegram commands** (`/cfo stop|start|status|scan|close poly|close hl|close all|stake|deposit|approve`) — all wired in `telegramFactoryCommands.ts` ✓

**Daily digest** — sends at configured UTC hour, deduped via `kv_store`, includes all 6 strategy sections ✓

**Life-sign logging** — 5-minute heartbeat with uptime, cycle count, enabled services, scout intel age ✓

---

## Fix Priority Checklist

```
🔴 Critical — Fix Before Live Capital
  [ ] Bug #1: Replace createPythOracle() with getSolPrice() in OPEN_HEDGE persistence
  [ ] Bug #2: Persist decision engine cooldowns to kv_store across restarts
  [ ] Bug #3: Forward guardian LP drain/price crash to CFO as market_crash

🟠 Serious — Fix Before Scaling
  [ ] Gap #4: Add CFO section to .env.example (55 vars, zero documented)
  [ ] Gap #5: Persist x402 revenue to DB (currently wiped on restart)
  [ ] Gap #6: Store exitPrice in repo.closePosition() + add column to schema

🟡 Medium — Fix Before Leaving Unattended
  [ ] Issue #7: Add kv_store cleanup for cfo_decision_* rows (30-day TTL)
  [ ] Issue #8: Consider broader market crash forwarding from guardian
  [ ] Issue #9: Add 003_cfo_schema.sql migration file
```

---

## One-Line Fixes Summary

The three critical fixes total roughly 15 lines of code:

**Fix 1** (2 lines): Replace `pyth.createPythOracle().getSolPrice()` with `getSolPrice()` in `cfo.ts:365`

**Fix 2** (~10 lines): Export `getLastDecisionAt()`/`restoreLastDecisionAt()` from `decisionEngine.ts`, save/restore in `cfo.ts` `persistState`/`restorePersistedState`

**Fix 3** (~8 lines): In `supervisor.ts` guardian alert handler, forward LP drain/price crash events as `market_crash` to CFO when `dropPct > 60` or `crashPct > 40`

The architectural foundation is solid. The decision engine, approval persistence, and swarm integration represent a significant step up from the original design. Once these three critical patches are applied, the CFO is ready for dry-run validation with real market data.
