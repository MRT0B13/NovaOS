-- Nova Guardian Security Schema
-- Adds tables for comprehensive security monitoring.
-- Run AFTER 001_health_schema.sql.

-- ============================================================
-- 1. SECURITY EVENTS — audit log for all security-relevant events
-- ============================================================
CREATE TABLE IF NOT EXISTS security_events (
  id                SERIAL PRIMARY KEY,
  category          TEXT NOT NULL
                    CHECK (category IN ('wallet', 'network', 'content', 'agent', 'incident')),
  severity          TEXT NOT NULL
                    CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  title             TEXT NOT NULL,
  details           JSONB NOT NULL DEFAULT '{}',
  auto_response     TEXT,
  source_agent      TEXT DEFAULT 'nova-guardian',
  resolved          BOOLEAN DEFAULT FALSE,
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_unresolved
  ON security_events(severity, created_at DESC)
  WHERE resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_security_events_category
  ON security_events(category, created_at DESC);

-- ============================================================
-- 2. WALLET SNAPSHOTS — balance history for anomaly detection
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id                SERIAL PRIMARY KEY,
  wallet_address    TEXT NOT NULL,
  wallet_label      TEXT NOT NULL,
  balance_sol       NUMERIC(20,9) NOT NULL,
  balance_lamports  BIGINT NOT NULL,
  token_balances    JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_addr
  ON wallet_snapshots(wallet_address, created_at DESC);

-- ============================================================
-- 3. AGENT QUARANTINE — isolation of compromised agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_quarantine (
  agent_name        TEXT PRIMARY KEY,
  quarantined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason            TEXT NOT NULL,
  quarantined_by    TEXT NOT NULL DEFAULT 'nova-guardian',
  severity          TEXT NOT NULL DEFAULT 'critical',
  auto_release_at   TIMESTAMPTZ,
  released          BOOLEAN DEFAULT FALSE,
  released_at       TIMESTAMPTZ,
  released_by       TEXT
);

-- ============================================================
-- 4. CONTENT BLOCKS — blocked messages / links / addresses
-- ============================================================
CREATE TABLE IF NOT EXISTS content_blocks (
  id                SERIAL PRIMARY KEY,
  block_type        TEXT NOT NULL
                    CHECK (block_type IN ('phishing_link', 'scam_address', 'prompt_injection', 'leaked_secret', 'malicious_content')),
  content_hash      TEXT NOT NULL,
  content_preview   TEXT,
  source_user_id    TEXT,
  source_chat_id    TEXT,
  action_taken      TEXT NOT NULL DEFAULT 'blocked',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type
  ON content_blocks(block_type, created_at DESC);

-- ============================================================
-- 5. RATE LIMIT TRACKING — per-service request tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id                SERIAL PRIMARY KEY,
  service_name      TEXT NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 0,
  window_start      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_seconds    INTEGER NOT NULL DEFAULT 60,
  blocked           BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_service
  ON rate_limit_log(service_name, window_start DESC);

-- ============================================================
-- VIEWS
-- ============================================================

-- Active security incidents (unresolved critical/emergency events)
CREATE OR REPLACE VIEW active_security_incidents AS
SELECT id, category, severity, title, details, auto_response, created_at
FROM security_events
WHERE resolved = FALSE AND severity IN ('critical', 'emergency')
ORDER BY created_at DESC;

-- Quarantined agents
CREATE OR REPLACE VIEW quarantined_agents AS
SELECT agent_name, quarantined_at, reason, severity
FROM agent_quarantine
WHERE released = FALSE
ORDER BY quarantined_at DESC;

-- Wallet balance trend (last 24h)
CREATE OR REPLACE VIEW wallet_balance_trend AS
SELECT wallet_address, wallet_label, balance_sol, created_at
FROM wallet_snapshots
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY wallet_address, created_at DESC;
