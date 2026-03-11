-- Migration: 007_universe_feed_events.sql
-- Stores universe events for replay and WS broadcast.
-- Optional — universe routes gracefully fall back to memories table if absent.

CREATE TABLE IF NOT EXISTS feed_events (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT         NOT NULL,
  action      TEXT         NOT NULL,
  zone        TEXT,
  message     TEXT,
  metadata    JSONB        DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feed_events_agent_idx   ON feed_events (agent_id);
CREATE INDEX IF NOT EXISTS feed_events_created_idx ON feed_events (created_at DESC);
CREATE INDEX IF NOT EXISTS feed_events_action_idx  ON feed_events (action);

-- Retention: auto-delete events older than 30 days
-- (run this manually or via pg_cron if available)
-- DELETE FROM feed_events WHERE created_at < NOW() - INTERVAL '30 days';
