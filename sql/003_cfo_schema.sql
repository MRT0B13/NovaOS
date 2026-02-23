-- ============================================================
-- 003_cfo_schema.sql — CFO Agent Tables
-- ============================================================
-- Idempotent: safe to run multiple times (IF NOT EXISTS everywhere)
-- Run after 001_health_schema.sql and 002_security_schema.sql
-- ============================================================

-- ============================================================
-- 1. KV_STORE — general key-value storage (used by CFO + agents)
-- ============================================================
CREATE TABLE IF NOT EXISTS kv_store (
  key         TEXT PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add updated_at column for TTL cleanup (migration for existing DBs)
ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- 2. CFO_POSITIONS — tracks all CFO financial positions
-- ============================================================
CREATE TABLE IF NOT EXISTS cfo_positions (
  id                TEXT PRIMARY KEY,
  strategy          TEXT NOT NULL,
  asset             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  chain             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'OPEN',
  entry_price       DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_price     DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_price        DOUBLE PRECISION,
  size_units        DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_basis_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_value_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  realized_pnl_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  unrealized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_tx_hash     TEXT,
  exit_tx_hash      TEXT,
  external_id       TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cfo_positions_strategy_idx ON cfo_positions (strategy);
CREATE INDEX IF NOT EXISTS cfo_positions_status_idx ON cfo_positions (status);
CREATE INDEX IF NOT EXISTS cfo_positions_external_idx ON cfo_positions (external_id);

-- ============================================================
-- 3. CFO_TRANSACTIONS — all financial transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS cfo_transactions (
  id              TEXT PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chain           TEXT NOT NULL,
  strategy_tag    TEXT NOT NULL,
  tx_type         TEXT NOT NULL,
  token_in        TEXT,
  amount_in       DOUBLE PRECISION,
  token_out       TEXT,
  amount_out      DOUBLE PRECISION,
  fee_usd         DOUBLE PRECISION NOT NULL DEFAULT 0,
  tx_hash         TEXT,
  wallet_address  TEXT NOT NULL,
  position_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  error_message   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS cfo_transactions_timestamp_idx ON cfo_transactions (timestamp DESC);
CREATE INDEX IF NOT EXISTS cfo_transactions_strategy_idx ON cfo_transactions (strategy_tag);
CREATE INDEX IF NOT EXISTS cfo_transactions_position_idx ON cfo_transactions (position_id);

-- ============================================================
-- 4. CFO_DAILY_SNAPSHOTS — end-of-day portfolio snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS cfo_daily_snapshots (
  date              DATE PRIMARY KEY,
  total_portfolio_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  sol_price_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  by_strategy       JSONB NOT NULL DEFAULT '{}',
  realized_pnl_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
  unrealized_pnl    DOUBLE PRECISION NOT NULL DEFAULT 0,
  yield_earned_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
  x402_revenue_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
  polymarket_pnl_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_positions    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 5. MIGRATIONS — add new columns to existing tables
-- ============================================================

-- Agent messages: retry count + processed_at for DLQ support
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS retry_count  INTEGER DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Exit price on positions (for existing DBs that lack it)
ALTER TABLE cfo_positions ADD COLUMN IF NOT EXISTS exit_price DOUBLE PRECISION;
