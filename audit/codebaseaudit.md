# NovaOS — Full Codebase Production Audit

**Date:** 2026-02-23 | **Repo:** github.com/MRT0B13/NovaOS | **Total source:** 73,103 lines across 115 files  
**Method:** Live clone, all findings are file-and-line verified

---

## Part 1 — CFO Agent (previously delivered, summarised here)

Three critical bugs, three serious gaps — see `CFO_PRODUCTION_AUDIT.md` for full detail.  
**TL;DR critical fixes needed:**

- `createPythOracle()` doesn't exist → HL positions stored at entryPrice = $0 → corrupted P&L forever (`cfo.ts:365`)
- Decision engine cooldowns are module-level → reset on every restart → possible duplicate hedges (`decisionEngine.ts:216`)
- Guardian LP drain/price crash never triggers CFO `market_crash` → emergency close won't fire on broad market events

---

## Part 2 — Guardian Agent

### 🔴 CRITICAL — AgentWatchdog Quarantine Is Theatrical

**File:** `src/agents/security/agentWatchdog.ts:294`  
**Impact:** A compromised or misbehaving agent is never actually stopped.

When `quarantineAgent()` fires, it writes `enabled = FALSE` to `agent_registry` in the DB and creates a row in `agent_quarantine`. But the running agents **never read `agent_registry` during their lifecycle** — `BaseAgent.running` is an in-memory flag that only responds to `agent.stop()` being called. The quarantine is a DB record with no enforcement mechanism.

The `autoResponse` field in the security event says `"Agent disabled in registry, quarantine record created"` — which sounds like it stops the agent, but it doesn't. The agent keeps running, keeps posting, keeps executing trades.

**Fix — wire quarantine through the swarm handle.** The `AgentWatchdog` needs a callback to actually call `stop()` on the target agent:

```typescript
// In agentWatchdog.ts constructor, add:
private quarantineCallback?: (agentName: string) => Promise<void>;
setQuarantineCallback(cb: (agentName: string) => Promise<void>) {
  this.quarantineCallback = cb;
}

// In quarantineAgent(), after DB write:
if (this.quarantineCallback) {
  await this.quarantineCallback(agentName).catch(() => {});
}
```

```typescript
// In init.ts, after guardian is initialized:
_swarmHandle.guardian["agentWatchdog"].setQuarantineCallback(
  async (agentName) => {
    const agentMap: Record<string, BaseAgent> = {
      "nova-scout": _swarmHandle.scout,
      "nova-analyst": _swarmHandle.analyst,
      "nova-launcher": _swarmHandle.launcher,
      "nova-community": _swarmHandle.community,
      "nova-cfo": _swarmHandle.cfo,
    };
    await agentMap[agentName]?.stop();
  },
);
```

---

### 🔴 CRITICAL — Guardian watchList Silently Truncated at 30 Tokens

**File:** `src/agents/guardian.ts:81`  
**Impact:** If you have more than 30 tokens on the watchlist (13 core + launched tokens + scout tokens easily exceeds this), the ones beyond position #30 never get liquidity checked. An LP drain on token #31 generates no alert.

```typescript
// guardian.ts:81 — silently drops everything after position 30
const batch = mints.slice(0, 30).join(",");
const res = await fetch(
  `https://api.dexscreener.com/latest/dex/tokens/${batch}`,
);
```

The `allMints` array can easily exceed 30 — 13 core tokens alone, plus any launched token, puts you at the limit before any scout-discovered tokens are added.

**Fix — batch in chunks of 30:**

```typescript
async function fetchDexScreenerLiquidity(
  mints: string[],
): Promise<Map<string, LiquiditySnapshot>> {
  const result = new Map<string, LiquiditySnapshot>();
  if (mints.length === 0) return result;

  // DexScreener accepts max 30 tokens per request — batch them
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30).join(",");
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch}`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const seen = new Set<string>();
      for (const pair of data.pairs || []) {
        const addr = pair.baseToken?.address;
        if (addr && !seen.has(addr)) {
          seen.add(addr);
          result.set(addr, {
            /* same as before */
          });
        }
      }
      // Rate-limit between batches
      if (i + 30 < mints.length) await new Promise((r) => setTimeout(r, 500));
    } catch {
      /* non-fatal */
    }
  }
  return result;
}
```

---

### 🟠 SERIOUS — watchList Not Persisted: Scout-Added Tokens Lost on Restart

**File:** `src/agents/guardian.ts:674`  
**Impact:** Guardian correctly restores `scanCount` and `liquidityAlertCount` across restarts, but the `watchList` itself is rebuilt from scratch. Core tokens (hardcoded array) and launched tokens (loaded from `kv_store`) survive restarts fine. But scout-ingested tokens — the most interesting ones, fresh mints that Scout flagged as trending — are gone after every deploy. Guardian has no memory of what it was watching for Scout-sourced tokens.

```typescript
// persistState() — scanCount + liquidityAlertCount only, watchList not included
private async persistState(): Promise<void> {
  await this.saveState({
    scanCount: this.scanCount,
    liquidityAlertCount: this.liquidityAlertCount,
    securityInitialized: this.securityInitialized,
    // ← watchList missing entirely
  });
}
```

**Fix — persist watchList entries with `source === 'scout'` to `saveState`:**

```typescript
private async persistState(): Promise<void> {
  const scoutTokens = Array.from(this.watchList.values())
    .filter(t => t.source === 'scout')
    .map(t => ({ mint: t.mint, ticker: t.ticker, addedAt: t.addedAt }));

  await this.saveState({
    scanCount: this.scanCount,
    liquidityAlertCount: this.liquidityAlertCount,
    securityInitialized: this.securityInitialized,
    scoutTokens, // ← add this
  });
}
```

Then restore them in `restorePersistedState()` before calling `loadWatchListFromDB()`.

---

### 🟠 SERIOUS — WalletSentinel Doesn't Monitor the CFO's Polygon Wallet

**File:** `src/agents/security/walletSentinel.ts`  
**Impact:** The Wallet Sentinel monitors `AGENT_FUNDING_WALLET_SECRET`, `PUMP_PORTAL_WALLET_ADDRESS`, and treasury SOL. The CFO's Polygon wallet (`CFO_EVM_PRIVATE_KEY`) — which holds USDC for Polymarket and MATIC for gas — is completely unmonitored. If that wallet is drained (or runs dry), the first you'd know about it is when `checkGas()` fails during a trade.

The sentinel already has `chain: 'solana' | 'evm'` in its `WalletConfig` interface and a comment `// EVM wallet checks can be added here` — the structure exists, it was just never wired.

**Fix — add the CFO Polygon wallet to `walletSentinel.init()`:**

```typescript
// In walletSentinel.ts init():
const cfoBuildWallet = process.env.CFO_EVM_PRIVATE_KEY;
const cfoBuildRpc = process.env.CFO_POLYGON_RPC_URL;
if (
  cfoBuildWallet &&
  cfoBuildRpc &&
  process.env.CFO_POLYMARKET_ENABLE === "true"
) {
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(cfoBuildWallet);
  this.wallets.push({
    address: wallet.address,
    label: "CFO Polygon (Polymarket)",
    chain: "evm",
    rpcUrl: cfoBuildRpc,
    drainThresholdPct: 30,
    lowBalanceThreshold: 5, // $5 USDC equivalent
  });
}
```

Then implement `checkEvmWallet()` alongside the existing `checkSolanaWallet()`.

---

### 🟡 MEDIUM — Guardian LP Drain/Price Crash Type Field Is Ignored by Supervisor

**File:** `src/agents/supervisor.ts:501`  
Guardian correctly sends `type: 'lp_drain'` and `type: 'price_crash'` in alert payloads from `monitorLiquidity()`. But the supervisor's `nova-guardian:alert` handler only switches on `msg.priority`, not on `payload.type`. LP drain and price crash events hit the same generic path as any other guardian alert — they get posted to TG channel if `priority === 'high'`, but the CFO-specific forwarding (the `market_crash` command) never fires for these event types.

This is the same gap called out in the CFO audit as Critical #3, but it's worth restating from the Guardian side: the Guardian is doing its job correctly by tagging the event type. The supervisor just isn't routing on it.

---

### 🟡 MEDIUM — IncidentResponse Has No Channel Alert Callback

**File:** `src/agents/security/incidentResponse.ts:39`  
The `IncidentCallbacks` interface only defines `onAdminAlert`. Security incidents (wallet drain, agent quarantine, RPC compromise) go only to the admin chat ID, never to the public TG channel. For most of these this is correct — you don't want to alarm your community about a wallet drain. But critical incidents that affect community (e.g., phishing link detected in the group chat) arguably deserve a public "heads up, suspicious activity detected" message.

Not urgent, but worth adding an `onChannelAlert?` callback and routing phishing/scam content filter events through it.

---

## Part 3 — Scout Agent

### 🟠 SERIOUS — Intel Buffer Lost on Every Restart

**File:** `src/agents/scout.ts:425`  
Scout's `persistState()` correctly saves `cycleCount`, `scanCount`, timing markers, and `seenHashes`. But the `intelBuffer` — the in-memory array of up to 60 recent research results that feeds the `sendDigest()` method — is **not persisted**. Every restart wipes it.

Consequences:

1. After a restart, the next CFO decision cycle sees no Scout intel (empty buffer = no digest = no `cryptoBullish` signal)
2. Cross-confirmed items (the highest-confidence signals) are lost even if they were confirmed minutes before the restart
3. The CFO decision engine falls back to `riskMultiplier: 1.0` (neutral) until a full scan cycle completes (~15–30 min)

```typescript
// scout.ts:425 — intelBuffer missing from persistState
private async persistState(): Promise<void> {
  await this.saveState({
    cycleCount: this.cycleCount,
    scanCount: this.scanCount,
    lastResearchAt: this.lastResearchAt,
    lastScanAt: this.lastScanAt,
    lastDigestAt: this.lastDigestAt,
    seenHashes: [...this.seenHashes].slice(-100),
    // ← intelBuffer not here
  });
}
```

**Fix:**

```typescript
await this.saveState({
  // ...existing fields...
  intelBuffer: this.intelBuffer.slice(-30), // cap at 30 for storage efficiency
});
```

And restore in `restorePersistedState()`:

```typescript
if (s.intelBuffer) this.intelBuffer = s.intelBuffer;
```

---

## Part 4 — API Server

### 🔴 CRITICAL — x402 Routes Never Registered

**File:** `src/launchkit/api/server.ts`, `src/launchkit/cfo/x402Service.ts`  
**Impact:** x402 micropayments are fully implemented (408 lines), tested, and wired to the CFO for revenue tracking — but the HTTP endpoints (`/x402/rugcheck`, `/x402/signal`, `/x402/trend`) are **never registered** in the API server. There is no `registerX402Routes()` call anywhere in `server.ts` or `init.ts`. The endpoints don't exist.

```bash
$ grep -r "x402" /tmp/NovaRepo/src/launchkit/api/server.ts
# (no output)
```

**Fix — add x402 route registration to `server.ts`:**

```typescript
// In server.ts, inside the request handler, before the 404 fallthrough:
if (pathname.startsWith("/x402/") && req.method === "GET") {
  const { handleX402Request } = await import("../cfo/x402Service.ts");
  const result = await handleX402Request(pathname, url.searchParams, pool);
  sendJson(res, result.status, result.body);
  return;
}
```

Or if x402Service exports route handlers, wire them during server setup. Either way, until this is done, `CFO_X402_ENABLE=true` silently does nothing — there's no way for external callers to pay for rug checks or signals.

---

### 🟠 SERIOUS — `/v1/portfolio` Shows Token Trades, Not CFO Financial Positions

**File:** `src/launchkit/api/server.ts:951`, `src/launchkit/services/pnlTracker.ts`  
**Impact:** The dashboard's portfolio view is misleading. `/v1/portfolio/summary` and `/v1/portfolio/positions` query `pnlTracker` — which tracks **pump.fun token buy/sell positions** (spot trades in launched tokens). It does not query `cfo_positions` at all. Polymarket bets, Jito staking, Kamino deposits, and Hyperliquid hedges are invisible in the API.

Two parallel, disconnected position-tracking systems:

- `pnlTracker` → token spot P&L from launches (feeds `/v1/portfolio/*`)
- `cfo_positions` → DeFi strategy positions (exists in DB, zero API exposure)

**Fix — add CFO-specific portfolio endpoints:**

```
GET /v1/cfo/portfolio    → cfo_positions + strategy breakdown
GET /v1/cfo/positions    → open/closed positions by strategy
GET /v1/cfo/transactions → recent CFO transaction log
GET /v1/cfo/snapshots    → cfo_daily_snapshots for chart data
GET /v1/cfo/status       → CFO agent live status (paused, cycle count, pending approvals)
```

These endpoints already have all the DB queries available via `PostgresCFORepository` — they just need to be wired into server routes.

---

### 🟡 MEDIUM — No Rate Limiting on Admin API Endpoints

**File:** `src/launchkit/api/server.ts:368`  
Admin endpoints (`/v1/launchpacks`, `/v1/tweet`, `/v1/swarm/*`) are protected by `x-admin-token` header check. But there's no rate limiting — a leaked admin token allows unlimited requests. There's also no IP allowlist. The `NetworkShield` rate bucket system exists in Guardian but isn't applied to the API server.

**Fix — add simple in-memory rate limiting per IP to admin endpoints:**

```typescript
const adminRateMap = new Map<string, { count: number; resetAt: number }>();
function checkAdminRateLimit(
  ip: string,
  max = 100,
  windowMs = 60_000,
): boolean {
  const now = Date.now();
  const bucket = adminRateMap.get(ip) ?? { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count++;
  adminRateMap.set(ip, bucket);
  return bucket.count <= max;
}
```

---

## Part 5 — Security Modules

### 🟠 SERIOUS — ContentFilter Never Scans Outbound TG Messages

**File:** `src/agents/security/contentFilter.ts:140`, `src/launchkit/services/telegramPublisher.ts`  
The `scanOutbound()` method exists and works — it checks for leaked secrets, hallucinated URLs, and Solana private key patterns. But it's **never called before sending Telegram messages**. `TelegramPublisher` posts directly without running content through the filter.

The `scanInbound()` method is called from `ingestScoutTokens` for agent messages, but outbound TG (marketing posts, Nova brand content, channel announcements) goes unscanned.

If an LLM hallucinates a private key or API key fragment into a marketing post, it publishes directly to the Telegram channel.

**Fix — add outbound scan in `telegramPublisher.ts` before `bot.sendMessage()`:**

```typescript
// In TelegramPublisher, before any send:
const guardian = getGuardianRef(); // need a reference passed in
if (guardian?.getContentFilter()) {
  const scan = guardian.getContentFilter()!.scanOutbound(text, chatId);
  if (!scan.clean) {
    logger.error("[TGPublisher] Outbound scan blocked:", scan.threats);
    return; // never send
  }
}
```

The `ContentFilter` is already exposed via `guardian.getContentFilter()` — it just needs to be wired into the publish pipeline.

---

### 🟡 MEDIUM — NetworkShield RPC Check Has No Fallback Action

**File:** `src/agents/security/networkShield.ts:154`  
When an RPC endpoint fails validation, the shield reports `autoResponse: 'RPC rotation triggered'` — but no rotation actually happens. The code fires a SecurityEvent and logs the failure; it doesn't update `process.env.SOLANA_RPC_URL` or trigger a failover in `solanaRpc.ts`. The autoResponse string is aspirational, not functional.

---

## Part 6 — Launcher Agent

### 🟡 MEDIUM — Graduation Events Don't Notify CFO of Fee Revenue

**File:** `src/agents/launcher.ts:125`  
When a Nova-launched token graduates to PumpSwap, Launcher detects it via `monitorGraduations()` and reports to Supervisor (which posts to social channels). But it doesn't send a message to CFO. The CFO has no way to know that a graduation happened and that creator fees are now accruing.

The original design called for CFO to monitor graduation fee revenue and route idle USDC/SOL into yield strategies. This loop is broken because Launcher never notifies CFO.

**Fix — add CFO notification in `monitorGraduations()`:**

```typescript
// After the existing reportToSupervisor call:
await this.sendMessage("nova-cfo", "intel", "medium", {
  command: "token_graduated",
  mint,
  tokenName: pack.brand?.name,
  tokenSymbol: pack.brand?.ticker,
  graduatedAt: new Date().toISOString(),
  note: "Creator fees now accruing on PumpSwap — consider yield deployment",
});
```

And handle `token_graduated` in CFO's `handleMessage()` to trigger a yield check (Jito/Kamino auto-deposit if SOL balance is above reserve).

---

## Part 7 — Cross-Cutting Issues

### 🔴 CRITICAL — Dual PnL Systems with No Reconciliation

**Scope:** `pnlTracker.ts`, `cfo_positions` schema, `server.ts`

There are two completely independent position tracking systems that are unaware of each other:

| System          | Tracks                                                 | Data                                | API Exposed          |
| --------------- | ------------------------------------------------------ | ----------------------------------- | -------------------- |
| `pnlTracker`    | pump.fun spot token P&L                                | File + PostgreSQL `token_positions` | ✅ `/v1/portfolio/*` |
| `cfo_positions` | DeFi strategy positions (Polymarket, Jito, Kamino, HL) | PostgreSQL `cfo_positions`          | ❌ Not exposed       |

The dashboard will show a completely different "total portfolio value" than what the CFO calculates internally. An operator looking at the API thinks they're seeing total portfolio health — but they're only seeing the token trading side. A $500 Polymarket position and 5 JitoSOL staked are invisible.

**Fix — add `/v1/cfo/*` endpoints** (see API section above) and update dashboard to show both systems side by side. A unified "total net worth" view should sum: token P&L (pnlTracker) + CFO strategy positions (cfo_positions) + current wallet balances.

---

### 🟠 SERIOUS — No Structured Logging / Traceability for Financial Decisions

**Scope:** All CFO decision execution paths

When the decision engine executes a `POLY_BET`, the log line is:

```
[CFO:Decision] POLY_BET[NOTIFY]: "Will BTC hit $120k..." $45 @ 45¢ edge:8.0%
```

There's no structured log (JSON) with a correlation ID that links: decision → execution → DB transaction → Telegram notification → position record. If you need to audit why a specific bet was placed, you're grep-ing across free-text logs.

**Fix — add a `traceId` to each decision cycle:**

```typescript
// In runDecisionCycle():
const traceId = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Pass traceId through executeDecision → persistDecisionResults → log lines
```

Not blocking, but important before you have real capital at stake.

---

### 🟡 MEDIUM — Agent Message Bus Has No Dead-Letter Queue

**Scope:** `BaseAgent.readMessages()`, `BaseAgent.acknowledgeMessage()`

If a message handler throws (e.g., CFO tries to handle `cfo_approve` but the DB is momentarily down), the message is never acknowledged and will be re-processed on the next `processCommands()` tick (every 10 seconds). Most handlers catch errors, but some do not (e.g., `cfo_close_poly` calls `polyMod.cancelAllOrders()` without a catch). A repeatedly-failing message could cause duplicate order cancellations.

**Fix — add max retry count to message processing:**

```typescript
// In BaseAgent.readMessages(), filter out messages with retry_count > 3
WHERE retry_count < 3 -- add this to the SELECT
// And add: UPDATE agent_messages SET retry_count = retry_count + 1 on failure
```

---

## Complete Fix Checklist

```
🔴 CRITICAL (blocking for real capital)
  [ ] CFO Bug #1:  createPythOracle() → getSolPrice() (cfo.ts:365)
  [ ] CFO Bug #2:  Persist decision engine cooldowns across restarts
  [ ] CFO Bug #3:  Forward guardian LP drain/crash as market_crash to CFO
  [ ] Guardian #1: AgentWatchdog quarantine must actually stop the in-process agent
  [ ] Guardian #2: DexScreener batch in chunks of 30 (not truncate at 30)
  [ ] API #1:      Register x402 HTTP routes in server.ts
  [ ] Cross #1:    Add /v1/cfo/* portfolio endpoints to expose CFO positions

🟠 SERIOUS (fix before scaling capital or leaving unattended)
  [ ] CFO Gap:     Add CFO section to .env.example (55 vars undocumented)
  [ ] CFO Gap:     Persist x402 revenue to DB (wiped on restart)
  [ ] CFO Gap:     Store exitPrice in repo.closePosition()
  [ ] Guardian #3: Persist scout-added watchList tokens across restarts
  [ ] Guardian #4: Add CFO Polygon wallet to WalletSentinel monitoring
  [ ] Scout:       Persist intelBuffer to saveState (CFO blind after restart)
  [ ] Security:    Wire ContentFilter.scanOutbound() into TelegramPublisher
  [ ] Launcher:    Send token_graduated message to CFO for fee revenue tracking

🟡 MEDIUM (fix before leaving fully autonomous)
  [ ] CFO Issue:   Add kv_store TTL cleanup for cfo_decision_* rows
  [ ] CFO Issue:   Add exitPrice column to cfo_positions schema
  [ ] API #2:      Add rate limiting on admin API endpoints
  [ ] Security:    NetworkShield RPC rotation should actually rotate
  [ ] Guardian:    Add lp_drain/price_crash → market_crash routing in supervisor
  [ ] Agent bus:   Add dead-letter queue / retry count to agent_messages
  [ ] Logging:     Add traceId to decision cycles for financial audit trail
```

---

## What's Solid ✅

- All 7 agents registered, typed, wired into swarm — architecture is clean
- Supervisor intel pipeline (Scout → CFO, Guardian → CFO, Analyst → CFO) — fully implemented
- CFO approval persistence across restarts — well-engineered
- POLY_BET tokenId fallback at execution time — robust
- Scout seenHashes deduplication persisted — no duplicate intel posts
- `novaPersonalBrand` hallucination filter — solid, 3-phase filter with regex patterns
- `telegramSecurity.ts` — admin ID validation, webhook secret verification
- Health monitor with code repair engine — sophisticated auto-repair capability
- All 55 CFO env vars in Zod schema — complete
- Dry run mode throughout all financial operations — safe default
