-- Nova Health Agent Schema
-- Run once against your PostgreSQL database.
-- These tables do NOT conflict with ElizaOS tables.

-- ============================================================
-- 1. AGENT HEARTBEATS — live status of every agent
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent_name        TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'alive'
                    CHECK (status IN ('alive', 'degraded', 'dead', 'disabled')),
  last_beat         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uptime_started    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memory_mb         INTEGER DEFAULT 0,
  cpu_percent       REAL DEFAULT 0,
  error_count_last_5min INTEGER DEFAULT 0,
  current_task      TEXT,
  version           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. AGENT ERRORS — error log with stack traces
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_errors (
  id                SERIAL PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  error_type        TEXT NOT NULL,
  error_message     TEXT NOT NULL,
  stack_trace       TEXT,
  file_path         TEXT,
  line_number       INTEGER,
  severity          TEXT NOT NULL DEFAULT 'error'
                    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  context           JSONB DEFAULT '{}',
  resolved          BOOLEAN DEFAULT FALSE,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  resolution_method TEXT,
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_errors_agent ON agent_errors(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_errors_unresolved ON agent_errors(resolved, severity) WHERE resolved = FALSE;

-- ============================================================
-- 3. AGENT RESTARTS — restart history
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_restarts (
  id                SERIAL PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  restart_type      TEXT NOT NULL DEFAULT 'full'
                    CHECK (restart_type IN ('full', 'soft', 'feature_disable', 'rpc_rotate', 'model_switch')),
  error_id          INTEGER REFERENCES agent_errors(id),
  success           BOOLEAN,
  recovery_time_ms  INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_restarts_agent ON agent_restarts(agent_name, created_at DESC);

-- ============================================================
-- 4. API HEALTH — external API monitoring
-- ============================================================
CREATE TABLE IF NOT EXISTS api_health (
  api_name              TEXT PRIMARY KEY,
  endpoint              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('up', 'slow', 'down', 'unknown')),
  response_time_ms      INTEGER DEFAULT 0,
  last_check            TIMESTAMPTZ DEFAULT NOW(),
  consecutive_failures  INTEGER DEFAULT 0,
  last_failure_reason   TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 5. CODE REPAIRS — repair attempts with diagnosis and outcome
-- ============================================================
CREATE TABLE IF NOT EXISTS code_repairs (
  id                SERIAL PRIMARY KEY,
  error_id          INTEGER REFERENCES agent_errors(id),
  agent_name        TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  error_type        TEXT NOT NULL,
  error_message     TEXT,
  diagnosis         TEXT,
  repair_category   TEXT,
  original_code     TEXT,
  repaired_code     TEXT,
  llm_model_used    TEXT,
  llm_prompt        TEXT,
  llm_response      TEXT,
  requires_approval BOOLEAN DEFAULT FALSE,
  approved          BOOLEAN,
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  applied           BOOLEAN DEFAULT FALSE,
  applied_at        TIMESTAMPTZ,
  test_passed       BOOLEAN,
  test_output       TEXT,
  rolled_back       BOOLEAN DEFAULT FALSE,
  rolled_back_at    TIMESTAMPTZ,
  rollback_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_repairs_pending ON code_repairs(requires_approval, approved)
  WHERE requires_approval = TRUE AND approved IS NULL;

-- ============================================================
-- 6. HEALTH REPORTS — periodic health snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS health_reports (
  id                SERIAL PRIMARY KEY,
  report_type       TEXT NOT NULL DEFAULT 'periodic'
                    CHECK (report_type IN ('periodic', 'incident', 'recovery', 'manual')),
  report_text       TEXT NOT NULL,
  agent_statuses    JSONB,
  api_statuses      JSONB,
  metrics           JSONB,
  posted_to         TEXT[] DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 7. AGENT MESSAGES — inter-agent message bus
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_messages (
  id                SERIAL PRIMARY KEY,
  from_agent        TEXT NOT NULL,
  to_agent          TEXT NOT NULL,
  message_type      TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  payload           JSONB NOT NULL,
  acknowledged      BOOLEAN DEFAULT FALSE,
  acknowledged_at   TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_pending ON agent_messages(to_agent, acknowledged, created_at)
  WHERE acknowledged = FALSE;

-- ============================================================
-- 8. AGENT REGISTRY — agent config and process management
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_registry (
  agent_name        TEXT PRIMARY KEY,
  agent_type        TEXT NOT NULL DEFAULT 'worker',
  enabled           BOOLEAN DEFAULT TRUE,
  auto_restart      BOOLEAN DEFAULT TRUE,
  max_memory_mb     INTEGER DEFAULT 512,
  start_command     TEXT,
  config            JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 9. HEALTH CONFIG — persistent key-value settings
-- ============================================================
CREATE TABLE IF NOT EXISTS health_config (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VIEWS
-- ============================================================

-- Swarm status overview
CREATE OR REPLACE VIEW swarm_status AS
SELECT
  h.agent_name,
  h.status,
  h.last_beat,
  h.memory_mb,
  h.error_count_last_5min,
  h.current_task,
  h.version,
  EXTRACT(EPOCH FROM (NOW() - h.last_beat)) AS seconds_since_beat,
  r.enabled,
  r.auto_restart
FROM agent_heartbeats h
LEFT JOIN agent_registry r ON r.agent_name = h.agent_name
ORDER BY h.agent_name;

-- Recent errors (last 24h)
CREATE OR REPLACE VIEW recent_errors AS
SELECT
  id, agent_name, error_type, error_message, severity,
  file_path, line_number, resolved, created_at
FROM agent_errors
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Pending repairs
CREATE OR REPLACE VIEW pending_repairs AS
SELECT
  cr.id, cr.agent_name, cr.file_path, cr.error_type,
  cr.diagnosis, cr.repair_category, cr.requires_approval,
  cr.approved, cr.created_at
FROM code_repairs cr
WHERE cr.requires_approval = TRUE AND cr.approved IS NULL
ORDER BY cr.created_at;
