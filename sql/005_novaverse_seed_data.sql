-- NovaVerse Test Data Seed
-- Seeds a test user + agent + NOVA balance + governance proposals
-- so all API endpoints return real data for Base44 frontend development.

-- 1. Test user (demo wallet address)
INSERT INTO users (wallet_address, created_at, last_seen)
VALUES ('0xdemo0000000000000000000000000000000001', NOW(), NOW())
ON CONFLICT (wallet_address) DO UPDATE SET last_seen = NOW();

-- 2. Link user to an agent instance
INSERT INTO user_agents (id, agent_id, wallet_address, template_id, display_name, risk_level, status, active, created_at)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'f0e1d2c3-b4a5-6789-0abc-def012345678',
  '0xdemo0000000000000000000000000000000001',
  'full-nova',
  'Nova Alpha #4217',
  'aggressive',
  'running',
  true,
  NOW() - INTERVAL '14 days'
)
ON CONFLICT (id) DO UPDATE SET status = 'running', active = true;

-- 3. NOVA token balance
INSERT INTO nova_balances (wallet_address, balance, earned_month, updated_at)
VALUES ('0xdemo0000000000000000000000000000000001', 2847, 312, NOW())
ON CONFLICT (wallet_address) DO UPDATE SET balance = 2847, earned_month = 312, updated_at = NOW();

-- 4. Tag some agent_messages with the demo agent_id so feed endpoint returns data
UPDATE agent_messages
SET agent_id = 'f0e1d2c3-b4a5-6789-0abc-def012345678'
WHERE id IN (SELECT id FROM agent_messages ORDER BY id DESC LIMIT 50);

-- 5. Tag some cfo_positions with the demo agent_id
UPDATE cfo_positions
SET agent_id = 'f0e1d2c3-b4a5-6789-0abc-def012345678'
WHERE agent_id IS NULL;

-- 6. Governance proposals
INSERT INTO governance_proposals (title, description, proposed_by, status, votes_yes, votes_no, votes_abstain, ends_at, created_at)
VALUES
  ('Enable Polymarket v2 strategy with higher position limits',
   'Proposal to increase Polymarket position limit from $5 to $15 per bet, enabling the CFO to take larger conviction trades on high-confidence markets. The scout signals have been consistently profitable above 60% confidence threshold.',
   '0xdemo0000000000000000000000000000000001',
   'active', 1842, 423, 156,
   NOW() + INTERVAL '5 days',
   NOW() - INTERVAL '2 days'),

  ('Add Raydium concentrated LP to the skill registry',
   'Raydium has launched concentrated liquidity pools on Solana with competitive fee structures. This proposal adds a new Raydium LP skill to complement existing Orca LP capabilities and diversify DEX exposure.',
   '0xdemo0000000000000000000000000000000001',
   'active', 967, 245, 88,
   NOW() + INTERVAL '4 days',
   NOW() - INTERVAL '3 days'),

  ('Reduce max Kamino borrow LTV from 52% to 45%',
   'Recent SOL volatility suggests our current max LTV of 52% is too aggressive. A reduction to 45% would provide additional safety buffer against liquidation during 20%+ drawdowns.',
   '0xdemo0000000000000000000000000000000001',
   'active', 1205, 1180, 340,
   NOW() + INTERVAL '6 days',
   NOW() - INTERVAL '1 day'),

  ('Launch NOVA token staking with 8% APY',
   'Implement staking for NOVA governance tokens. Staked NOVA earns 8% APY paid from protocol fees, with a 7-day unstaking period. This incentivizes long-term governance participation.',
   '0xdemo0000000000000000000000000000000001',
   'passed', 3240, 180, 95,
   NOW() - INTERVAL '1 day',
   NOW() - INTERVAL '8 days'),

  ('Integrate Hyperliquid perpetuals for hedging',
   'Add Hyperliquid perp trading capability so the CFO can hedge LP positions during high volatility. Initial implementation would be limited to SOL-PERP and ETH-PERP with max 2x leverage.',
   '0xdemo0000000000000000000000000000000001',
   'active', 2100, 320, 180,
   NOW() + INTERVAL '3 days',
   NOW() - INTERVAL '4 days')
ON CONFLICT DO NOTHING;

-- 7. Add a test vote from our demo user
INSERT INTO governance_votes (proposal_id, wallet_address, vote_choice, nova_weight, agent_recommended, voted_at)
SELECT p.id, '0xdemo0000000000000000000000000000000001', 'YES', 2847, true, NOW()
FROM governance_proposals p
WHERE p.title LIKE 'Enable Polymarket%'
LIMIT 1
ON CONFLICT (proposal_id, wallet_address) DO NOTHING;

-- 8. Insert portfolio snapshots for PnL chart (hourly, last 7 days)
INSERT INTO portfolio_snapshots (agent_id, total_value_usd, snapshot_at)
SELECT
  'f0e1d2c3-b4a5-6789-0abc-def012345678',
  -- Simulate portfolio value starting at $500, growing to ~$580 with noise
  500 + (ROW_NUMBER() OVER (ORDER BY h) * 0.5) + (RANDOM() * 20 - 10),
  NOW() - (INTERVAL '1 hour' * h)
FROM generate_series(1, 168) AS h  -- 168 hours = 7 days
ON CONFLICT DO NOTHING;
