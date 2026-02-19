# 🏥 Nova Health Agent — Self-Healing Swarm Monitor

Nova's immune system. Monitors all agents, auto-restarts failures, checks APIs, and **repairs broken code using LLM-powered diagnosis**.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HEALTH AGENT (standalone process)         │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │  Heartbeat   │  │  API Health  │  │  Code Repair     │   │
│  │  Monitor     │  │  Checker     │  │  Engine          │   │
│  │  (30s loop)  │  │  (60s loop)  │  │  (on error)      │   │
│  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘   │
│         │                │                    │             │
│         └────────────────┴────────────────────┘             │
│                          │                                  │
│              ┌───────────┴───────────┐                      │
│              │    PostgreSQL DB      │                      │
│              │  (shared with Eliza)  │                      │
│              └───────────┬───────────┘                      │
│                          │                                  │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│  ┌─────────────┐  ┌───────────┐  ┌──────────────┐         │
│  │  Auto       │  │  TG       │  │  Degradation │         │
│  │  Restart    │  │  Alerts   │  │  Rules       │         │
│  │  (pm2)      │  │  (owner)  │  │  (fallbacks) │         │
│  └─────────────┘  └───────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  NOVA AGENTS (each imports HeartbeatClient)                  │
│                                                              │
│  nova-main  │  scout  │  guardian  │  launcher  │  community │
│     💓      │   💓    │    💓      │    💓      │     💓     │
│  sends heartbeat every 60s, reports errors on catch          │
└──────────────────────────────────────────────────────────────┘
```

## Code Repair Flow

```
Error caught by agent
        │
        ▼
HeartbeatClient.reportError()
        │
        ▼
Health Agent reads error from DB
        │
        ▼
classifyError() → RepairCategory?
        │ (if repairable)
        ▼
Extract file path from stack trace
        │
        ▼
Read source file, extract context (±40 lines)
        │
        ▼
Send to LLM: "Here's the error + code. Diagnose and fix."
        │
        ▼
Parse LLM response → { diagnosis, original_code, repaired_code, confidence }
        │
        ▼
Is confidence > 0.5?  ──No──▶ Skip (log attempt)
        │ Yes
        ▼
File in sensitive path? (wallet/launcher/auth)
        │
   ┌────┴────┐
   Yes       No
   │         │
   ▼         ▼
Send TG     Create backup
alert for   Apply fix
approval    Run syntax check (tsc --noEmit)
   │              │
   │         ┌────┴────┐
   │        Pass      Fail
   │         │         │
   │         ▼         ▼
   │      Keep fix   Rollback from backup
   │      Mark resolved
   │         │
   ▼         ▼
Owner        Done ✅
approves/
rejects
via TG
```

## What it Auto-Fixes (safe)

| Category | Example |
|----------|---------|
| `config_fix` | Missing env var, wrong timeout value |
| `api_endpoint` | URL changed, 404 on known endpoint |
| `rpc_rotation` | Dead Solana RPC → swap to Helius backup |
| `model_fallback` | OpenAI model deprecated → switch model string |
| `rate_limit_adjust` | 429 error → reduce frequency constant |
| `import_fix` | Module path changed after npm update |
| `query_fix` | SQL column name mismatch |
| `type_fix` | TypeScript type error from interface change |
| `retry_logic` | Timeout too short → increase timeout value |

## What Requires Your Approval (via Telegram)

- Any file in `wallet/`, `launcher/`, `token/`, `transaction/`, `deploy/`, `auth/`, `keys/`
- Any file not explicitly in the auto-approve list

## What it Never Touches

- Private keys, seed phrases
- Wallet signing logic
- Deployed smart contracts
- Production database data

## Files

```
health-agent/
├── sql/
│   └── 001_health_schema.sql    # PostgreSQL migration (7 tables + views)
├── src/
│   ├── types.ts                 # Config, types, degradation rules
│   ├── db.ts                    # All database operations
│   ├── code-repair.ts           # LLM-powered code repair engine
│   ├── monitor.ts               # Main health monitor loop
│   ├── heartbeat-client.ts      # Lightweight client for other agents
│   ├── index.ts                 # Entry point (standalone process)
│   └── integration-example.ts   # How to wire into existing Nova
└── README.md
```

## Setup

### 1. Run the schema migration

```bash
psql $DATABASE_URL -f sql/001_health_schema.sql
```

### 2. Add env vars

```bash
ADMIN_CHAT_ID=123456789    # Your personal TG chat ID
REPAIR_ENABLED=true
REPAIR_MODEL=claude-sonnet-4-20250514
PROJECT_ROOT=/app
```

### 3. Add HeartbeatClient to Nova's main agent

```typescript
import { HeartbeatClient } from './health/heartbeat-client';

const heartbeat = new HeartbeatClient(pool, 'nova-main');
heartbeat.start();

// Wrap existing functions:
async function scanKOLs() {
  return heartbeat.withErrorReporting('scanning KOLs', async () => {
    // ... existing code
  });
}
```

### 4. Start Health Agent alongside Nova

```bash
# Option A: pm2 (recommended)
pm2 start src/health/index.ts --name health-agent --interpreter "npx ts-node"

# Option B: separate terminal
npx ts-node src/health/index.ts

# Option C: Docker
# Add as second service in docker-compose
```

### 5. Add Telegram commands

See `integration-example.ts` section 6 for `/approve`, `/reject`, `/health`, `/repairs`, `/rollback` handlers.

## Database Tables

| Table | Purpose |
|-------|---------|
| `agent_heartbeats` | Live status of every agent (beat every 60s) |
| `agent_errors` | Error log with stack traces and severity |
| `agent_restarts` | Restart history with recovery times |
| `api_health` | External API status (Twitter, OpenAI, Solana, etc.) |
| `code_repairs` | Every repair attempt with diagnosis, fix, and outcome |
| `health_reports` | Periodic snapshots posted to TG |
| `agent_messages` | Inter-agent communication bus |
| `agent_registry` | Agent config and process management |

## Telegram Interactions

**Every 6 hours:**
```
🏥 Nova Swarm Health Report
═══════════════════════════
AGENTS:
🟢 nova-main — alive (uptime: 47h, errors: 0)
🟢 health-agent — alive (uptime: 47h, errors: 0)

EXTERNAL APIS:
🟢 Twitter API — 142ms
🟢 Solana RPC — 89ms
🟡 OpenAI — 3200ms (slow)

LAST 24H:
Errors: 3 | Restarts: 0 | Repairs: 1
```

**When repair needs approval:**
```
🔧 Repair needs your approval (#42):
Agent: nova-main
Error: TypeError: Cannot read property 'data' of undefined
Diagnosis: DeFiLlama API response structure changed. 
           The 'protocols' endpoint now wraps results in a 'data' field.
/approve 42 or /reject 42
```

**When auto-repair succeeds:**
```
✅ Auto-repaired error in nova-main:
Solana RPC endpoint unreachable. Rotated to backup: rpc.helius.xyz
```

## Dependencies

```bash
npm install pg minimatch
npm install -D @types/pg
# minimatch is for glob pattern matching on file paths
```

## Narrative Value

> "Most AI agents crash and nobody notices. Nova fixes itself."
>
> Nova's Health Agent monitors every process in the swarm, auto-restarts 
> failures, and — uniquely — uses LLM-powered code analysis to diagnose 
> and patch errors in real-time. When Nova encounters a broken API endpoint,
> a stale RPC connection, or a type mismatch from a dependency update, it 
> reads the error, reads the code, generates a fix, tests it, and deploys 
> it — all before you wake up.
>
> Sensitive code (wallets, token launches) always requires human approval 
> via Telegram. Everything else heals autonomously.
