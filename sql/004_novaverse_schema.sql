-- ============================================================
-- 004_novaverse_schema.sql
-- NovaVerse Platform — Users, Agents, Governance, NOVA Balances
-- Run: psql $DATABASE_URL -f sql/004_novaverse_schema.sql
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. USERS — wallet-based authentication
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  wallet_address   TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);

-- ============================================================
-- 2. USER_AGENTS — links wallets to deployed agent instances
-- ============================================================
CREATE TABLE IF NOT EXISTS user_agents (
  id               UUID PRIMARY KEY,
  agent_id         UUID NOT NULL,
  wallet_address   TEXT NOT NULL REFERENCES users(wallet_address),
  template_id      TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  risk_level       TEXT NOT NULL DEFAULT 'balanced'
                   CHECK (risk_level IN ('conservative', 'balanced', 'aggressive')),
  status           TEXT NOT NULL DEFAULT 'deploying'
                   CHECK (status IN ('deploying', 'running', 'paused', 'error')),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active agent per wallet (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_agents_active_wallet
  ON user_agents(wallet_address) WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_user_agents_wallet ON user_agents(wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_agents_agent_id ON user_agents(agent_id);

-- ============================================================
-- 3. NOVA_BALANCES — NOVA token balance tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS nova_balances (
  wallet_address   TEXT PRIMARY KEY REFERENCES users(wallet_address),
  balance          NUMERIC NOT NULL DEFAULT 0,
  earned_month     NUMERIC NOT NULL DEFAULT 0,
  earned_total     NUMERIC NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. GOVERNANCE_PROPOSALS
-- ============================================================
CREATE TABLE IF NOT EXISTS governance_proposals (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  proposed_by      TEXT REFERENCES users(wallet_address),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'passed', 'rejected', 'expired')),
  votes_yes        NUMERIC NOT NULL DEFAULT 0,
  votes_no         NUMERIC NOT NULL DEFAULT 0,
  votes_abstain    NUMERIC NOT NULL DEFAULT 0,
  ends_at          TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_proposals_status ON governance_proposals(status);
CREATE INDEX IF NOT EXISTS idx_governance_proposals_created ON governance_proposals(created_at DESC);

-- ============================================================
-- 5. GOVERNANCE_VOTES — individual votes (NOVA-weighted)
-- ============================================================
CREATE TABLE IF NOT EXISTS governance_votes (
  id                SERIAL PRIMARY KEY,
  proposal_id       INT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  wallet_address    TEXT NOT NULL REFERENCES users(wallet_address),
  vote_choice       TEXT NOT NULL CHECK (vote_choice IN ('YES', 'NO', 'ABSTAIN')),
  nova_weight       NUMERIC NOT NULL DEFAULT 0,
  agent_recommended BOOLEAN DEFAULT FALSE,
  voted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(proposal_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_governance_votes_proposal ON governance_votes(proposal_id);

-- ============================================================
-- 6. ALTER existing tables — add columns needed by NovaVerse API
-- ============================================================

-- agent_messages: add agent_id for per-user agent scoping + summary/detail for API feed
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS agent_id UUID;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS summary  TEXT;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS detail   TEXT;

-- Indexes for live feed polling (agent_id + id DESC for fast cursor-based poll)
CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_id_id
  ON agent_messages(agent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created
  ON agent_messages(created_at DESC);

-- cfo_positions: add agent_id for per-user agent scoping
ALTER TABLE cfo_positions ADD COLUMN IF NOT EXISTS agent_id UUID;
CREATE INDEX IF NOT EXISTS idx_cfo_positions_agent_id
  ON cfo_positions(agent_id);

-- ============================================================
-- 7. PORTFOLIO_SNAPSHOTS — hourly snapshots for PnL chart
--    (cfo_daily_snapshots is per-day, this is per-hour per-agent)
-- ============================================================
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id               SERIAL PRIMARY KEY,
  agent_id         UUID NOT NULL,
  total_value_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  by_strategy      JSONB DEFAULT '{}',
  snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_agent_ts
  ON portfolio_snapshots(agent_id, snapshot_at DESC);

-- ============================================================
-- Done. All NovaVerse tables ready.
-- ============================================================
