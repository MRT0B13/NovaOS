-- ============================================================
-- 006_burn_schema.sql
-- Meme Token Burn-to-Fund Ecosystem
--
-- Users burn meme tokens launched by Nova on pump.fun.
-- The backend swaps them to SOL via Jupiter, then distributes:
--   40% → Treasury (infra, dev, liquidity)
--   30% → Staking Rewards Pool
--   20% → Community Rewards Pool
--   10% → NOVA Buyback & Burn
--
-- Burners earn ecosystem credits redeemable for NOVA or rewards.
--
-- Run: psql $DATABASE_URL -f sql/006_burn_schema.sql
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. TOKEN_BURNS — individual burn transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS token_burns (
  id                UUID PRIMARY KEY,
  wallet_address    TEXT NOT NULL,
  mint              TEXT NOT NULL,                    -- SPL token mint (the meme token)
  token_name        TEXT,                             -- human-readable name
  token_ticker      TEXT,                             -- e.g. $DOGE
  amount_tokens     NUMERIC NOT NULL,                 -- number of tokens burned
  amount_sol        NUMERIC,                          -- SOL received from Jupiter swap
  amount_usd        NUMERIC,                          -- USD value at time of burn
  launch_pack_id    TEXT REFERENCES launch_packs(id), -- links to the launch that created this token

  -- Distribution breakdown (in SOL)
  dist_treasury     NUMERIC DEFAULT 0,       -- 40%
  dist_staking      NUMERIC DEFAULT 0,       -- 30%
  dist_rewards      NUMERIC DEFAULT 0,       -- 20%
  dist_buyback      NUMERIC DEFAULT 0,       -- 10%

  -- Transaction status
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'swapping', 'distributing', 'completed', 'failed', 'refunded')),
  swap_tx           TEXT,                     -- Jupiter swap transaction signature
  dist_tx           TEXT,                     -- Distribution transaction signature(s)
  burn_tx           TEXT,                     -- SPL burn transaction signature
  error_message     TEXT,

  -- Credits awarded to the burner
  credits_earned    NUMERIC DEFAULT 0,
  credits_redeemed  NUMERIC DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_token_burns_wallet ON token_burns(wallet_address);
CREATE INDEX IF NOT EXISTS idx_token_burns_mint ON token_burns(mint);
CREATE INDEX IF NOT EXISTS idx_token_burns_status ON token_burns(status);
CREATE INDEX IF NOT EXISTS idx_token_burns_launch ON token_burns(launch_pack_id);
CREATE INDEX IF NOT EXISTS idx_token_burns_created ON token_burns(created_at DESC);

-- ============================================================
-- 2. BURN_CREDITS — running balance of credits per wallet
-- ============================================================
CREATE TABLE IF NOT EXISTS burn_credits (
  wallet_address    TEXT PRIMARY KEY,
  total_earned      NUMERIC NOT NULL DEFAULT 0,
  total_redeemed    NUMERIC NOT NULL DEFAULT 0,
  total_burns       INTEGER NOT NULL DEFAULT 0,
  total_sol_value   NUMERIC NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. BURN_DISTRIBUTIONS — aggregate tracking of distribution pools
-- ============================================================
CREATE TABLE IF NOT EXISTS burn_distributions (
  id                SERIAL PRIMARY KEY,
  period            TEXT NOT NULL DEFAULT 'all_time',  -- 'daily', 'weekly', 'all_time'
  period_start      DATE,

  total_burns       INTEGER NOT NULL DEFAULT 0,
  total_sol_burned  NUMERIC NOT NULL DEFAULT 0,

  -- Pool totals (cumulative SOL)
  treasury_total    NUMERIC NOT NULL DEFAULT 0,
  staking_total     NUMERIC NOT NULL DEFAULT 0,
  rewards_total     NUMERIC NOT NULL DEFAULT 0,
  buyback_total     NUMERIC NOT NULL DEFAULT 0,

  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(period, period_start)
);

-- Insert initial all_time row
INSERT INTO burn_distributions (period, period_start, updated_at)
VALUES ('all_time', '2025-01-01', NOW())
ON CONFLICT (period, period_start) DO NOTHING;

-- ============================================================
-- 4. CREDIT_REDEMPTIONS — history of credit redemptions
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_redemptions (
  id                UUID PRIMARY KEY,
  wallet_address    TEXT NOT NULL,
  credits_spent     NUMERIC NOT NULL,
  reward_type       TEXT NOT NULL
                    CHECK (reward_type IN ('nova_token', 'sol_reward', 'nft_claim', 'boost', 'other')),
  reward_amount     NUMERIC,
  reward_details    JSONB DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  tx_signature      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_credit_redemptions_wallet ON credit_redemptions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_credit_redemptions_status ON credit_redemptions(status);

-- ============================================================
-- Done. Burn ecosystem tables ready.
-- ============================================================
