# PostgreSQL Architecture

This document covers the PostgreSQL persistence layer used by LaunchKit for data that must survive Railway restarts.

## Overview

LaunchKit uses a **hybrid storage strategy**:

| Environment | Primary Storage | Fallback |
|-------------|-----------------|----------|
| Railway (Production) | PostgreSQL via `DATABASE_URL` | None |
| Local Development | PostgreSQL if `DATABASE_URL` set | JSON files in `./data/` |

All data is automatically synced to PostgreSQL when available, ensuring persistence across deployments and restarts.

---

## Repository Pattern

LaunchKit uses the **Factory Pattern** with async initialization for database repositories.

### PostgresScheduleRepository

Central repository for all scheduling, voting, and metrics data.

```typescript
import { PostgresScheduleRepository } from './launchkit/db/postgresScheduleRepository';

// Create with factory pattern (NOT new)
const repo = await PostgresScheduleRepository.create(process.env.DATABASE_URL);

// Use the repository
const posts = await repo.getTGPosts('pending');
await repo.insertTGPost(post);
```

### PostgresPnLRepository

Repository for trading, positions, and P&L tracking.

```typescript
import { PostgresPnLRepository } from './launchkit/db/postgresPnLRepository';

const pnlRepo = await PostgresPnLRepository.create(process.env.DATABASE_URL);

const positions = await pnlRepo.getOpenPositions();
await pnlRepo.insertTrade(trade);
```

---

## Database Tables

### Scheduling Tables (`sched_*`)

| Table | Purpose | Service |
|-------|---------|---------|
| `sched_tg_posts` | Telegram scheduled posts | `telegramScheduler.ts` |
| `sched_x_tweets` | X/Twitter scheduled tweets | `xScheduler.ts` |
| `sched_x_marketing` | X marketing campaign schedules | `xScheduler.ts` |
| `sched_x_usage` | X API rate limit tracking | `xRateLimiter.ts` |
| `sched_trend_pool` | Detected trends pool | `trendPool.ts` |
| `sched_community_prefs` | Community voting preferences | `communityVoting.ts` |
| `sched_community_feedback` | Idea feedback from community | `communityVoting.ts` |
| `sched_pending_votes` | Active voting sessions | `communityVoting.ts` |
| `sched_system_metrics` | System metrics, banned users, failed attempts | `systemReporter.ts` |

### PnL Tables (`pnl_*`)

| Table | Purpose | Service |
|-------|---------|---------|
| `pnl_trades` | Trade history (buys/sells) | `pnlTracker.ts` |
| `pnl_positions` | Current token positions | `pnlTracker.ts` |
| `pnl_sol_flows` | SOL in/out tracking | `pnlTracker.ts` |
| `pnl_summary` | Aggregate P&L summary | `pnlTracker.ts` |

### Core Tables

| Table | Purpose | Service |
|-------|---------|---------|
| `launch_packs` | Token launch configurations | `launchPackRepository.ts` |
| `central_messages` | Message bus persistence | ElizaOS core |
| `central_channels` | Channel metadata | ElizaOS core |

---

## Service Initialization

Services with PostgreSQL support require async initialization. This happens automatically in `init.ts`:

```typescript
// In init.ts
import { initTelegramScheduler } from './services/telegramScheduler';
import { initXScheduler } from './services/xScheduler';
import { initXRateLimiter } from './services/xRateLimiter';
import { initPoolAsync } from './services/trendPool';
import { initCommunityVoting } from './services/communityVoting';
import { startSystemReporter } from './services/systemReporter';

// All called with await during LaunchKit startup
await initTelegramScheduler();
await initXScheduler();
await initXRateLimiter();
await initPoolAsync();
await initCommunityVoting();
await startSystemReporter();
```

### Initialization Order

1. **PostgresScheduleRepository** - Creates schema, ensures tables exist
2. **PostgresPnLRepository** - Creates P&L tables
3. **Individual services** - Connect to repository, load persisted data

---

## Table Schemas

### sched_tg_posts

```sql
CREATE TABLE sched_tg_posts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  token_ticker TEXT,
  token_mint TEXT,
  launch_pack_id TEXT,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  posted_at TIMESTAMPTZ,
  message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### sched_x_tweets

```sql
CREATE TABLE sched_x_tweets (
  id TEXT PRIMARY KEY,
  token_ticker TEXT,
  token_mint TEXT,
  launch_pack_id TEXT,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  posted_at TIMESTAMPTZ,
  tweet_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### sched_system_metrics

```sql
CREATE TABLE sched_system_metrics (
  id TEXT PRIMARY KEY DEFAULT 'global',
  tweets_sent INTEGER DEFAULT 0,
  tweets_sent_today INTEGER DEFAULT 0,
  tg_posts_sent INTEGER DEFAULT 0,
  tg_posts_sent_today INTEGER DEFAULT 0,
  trends_detected INTEGER DEFAULT 0,
  trends_detected_today INTEGER DEFAULT 0,
  launches_triggered INTEGER DEFAULT 0,
  launches_triggered_today INTEGER DEFAULT 0,
  errors_today INTEGER DEFAULT 0,
  last_tweet_at TIMESTAMPTZ,
  last_tg_post_at TIMESTAMPTZ,
  uptime_start TIMESTAMPTZ DEFAULT NOW(),
  banned_users JSONB DEFAULT '[]',
  failed_attempts JSONB DEFAULT '[]'
);
```

### pnl_positions

```sql
CREATE TABLE pnl_positions (
  token_mint TEXT PRIMARY KEY,
  token_ticker TEXT,
  launch_pack_id TEXT,
  quantity NUMERIC NOT NULL,
  avg_entry_price NUMERIC NOT NULL,
  total_cost_sol NUMERIC NOT NULL,
  realized_pnl NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
```

---

## Hybrid Storage Behavior

### Startup Flow

```
1. Check for DATABASE_URL environment variable
2. If set:
   a. Create PostgresScheduleRepository
   b. Ensure schema (create tables if missing)
   c. Load data from PostgreSQL
   d. Set usePostgres = true
3. If not set:
   a. Load from JSON files in ./data/
   b. Set usePostgres = false
```

### Write Flow

```
1. Update in-memory state
2. Save to JSON file (always, for local backup)
3. If usePostgres:
   a. Sync to PostgreSQL
   b. Log any sync errors (non-blocking)
```

### Read Flow

```
1. If usePostgres:
   a. Read from PostgreSQL
2. Else:
   a. Read from JSON file
3. Update in-memory cache
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | _(none)_ |
| `PGLITE_PATH` | Path for embedded PGlite | `./data/pglite` |
| `SQL_EMBEDDINGS_ENABLE` | Enable vector embeddings | `true` |

---

## Monitoring & Debugging

### Health Check

```bash
curl https://your-app.up.railway.app/health
```

Response includes database status:

```json
{
  "db": {
    "mode": "postgres",
    "ready": true,
    "vectorEnabled": false,
    "centralDbReady": true,
    "launchPacksReady": true
  }
}
```

### Startup Logs

Successful PostgreSQL initialization shows:

```
[ScheduleRepository] PostgreSQL schema ensured
[TGScheduler] Initialized with PostgreSQL storage (Railway)
[XScheduler] PostgreSQL storage initialized
[X-RateLimiter] PostgreSQL storage initialized
[TrendPool] PostgreSQL storage initialized
[SystemReporter] PostgreSQL storage initialized
[SystemReporter] Loaded persisted metrics from PostgreSQL
[PnLRepository] Schema ensured
[PnLTracker] Initialized with PostgreSQL storage (Railway)
```

---

## Migration Notes

### From JSON to PostgreSQL

No manual migration needed. When `DATABASE_URL` is set:

1. Services detect PostgreSQL mode
2. Tables are auto-created on first startup
3. Existing JSON data is not automatically migrated (fresh start)

### Data Recovery

If you need to recover data from JSON files after switching to PostgreSQL:

1. Ensure JSON files are in `./data/` directory
2. Temporarily unset `DATABASE_URL`
3. Start the service (loads from JSON)
4. Set `DATABASE_URL` again
5. Restart (data will be written to PostgreSQL)

---

## Best Practices

1. **Always use factory pattern**: `await Repository.create(url)` not `new Repository()`
2. **Handle async init**: Services with PostgreSQL need `await` on initialization
3. **Check for errors**: PostgreSQL sync failures are logged but non-blocking
4. **Local development**: Keep JSON files for easy testing without PostgreSQL
5. **Railway deployment**: `DATABASE_URL` is auto-injected by Railway PostgreSQL addon
