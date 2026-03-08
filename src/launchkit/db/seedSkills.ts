/**
 * Seed Skills — pre-populate the agent_skills registry with foundational skills
 *
 * Called once at startup; uses ON CONFLICT DO NOTHING so it's idempotent.
 */

import type { Pool } from 'pg';
import { logger } from '@elizaos/core';

// ============================================================================
// Seed Data
// ============================================================================

interface SeedSkill {
  skillId: string;
  name: string;
  description: string;
  content: string;
  version: string;
  category: string;
}

interface SeedAssignment {
  agentRole: string;
  skillId: string;
  priority: number;
}

const SEED_SKILLS: SeedSkill[] = [
  {
    skillId: 'risk-framework',
    name: 'Risk Management Framework',
    description: 'Position sizing, exposure limits, and risk-adjusted decision making for DeFi portfolio management',
    content: `## Risk Management Framework

When making portfolio decisions, always apply these risk principles:

1. **Position Sizing**: Never allocate more than 15% of total portfolio to a single position. Scale into large positions over 2-3 entries.
2. **Exposure Limits**: Total leveraged exposure must not exceed 2x portfolio NAV. If health factor drops below 1.5, immediately reduce exposure.
3. **Stop-Loss Discipline**: Set mental stop-losses at -8% for spot, -5% for leveraged positions. If a position breaches its stop, exit — do not average down.
4. **Correlation Risk**: Avoid concentrating in correlated assets. If >40% of portfolio is in the same sector (e.g., all SOL ecosystem), flag for rebalancing.
5. **Drawdown Circuit Breaker**: If portfolio drops 12% in 24h, halt all new entries and post admin alert.
6. **Yield vs Risk**: For LP positions, require minimum 20% APY for volatile pairs, 8% for stablecoin pairs. Below these thresholds, capital is better deployed elsewhere.
7. **Gas Reserve**: Always maintain minimum gas reserves (0.15 SOL on Solana, 0.5 POL on Polygon, 0.005 ETH on Ethereum).`,
    version: '1.0.0',
    category: 'risk',
  },
  {
    skillId: 'hyperliquid-trader',
    name: 'Hyperliquid Trading Expertise',
    description: 'Perpetual futures trading strategies on Hyperliquid DEX',
    content: `## Hyperliquid Trading Expertise

When trading on Hyperliquid:

1. **Order Types**: Prefer limit orders to reduce fees. Use IOC (Immediate-or-Cancel) for urgent entries. Avoid market orders unless volatility demands instant execution.
2. **Leverage**: Default to 3-5x for trend following. Never exceed 10x. Reduce leverage when funding rates are extreme (>0.1% per 8h against your position).
3. **Funding Arbitrage**: Monitor funding rates across assets. When funding is deeply negative, consider long positions that earn funding. When deeply positive, consider shorts.
4. **Liquidation Safety**: Maintain at least 3x distance between entry and liquidation price. If margin ratio drops below 30%, either add margin or reduce position size.
5. **Hedging**: Use Hyperliquid shorts to hedge spot positions on Solana/EVM. Target delta-neutral when market sentiment is unclear.
6. **Entry Timing**: Check order book depth before entering. If top-of-book is thin (<$50k within 0.1%), use smaller orders to avoid slippage.`,
    version: '1.0.0',
    category: 'trading',
  },
  {
    skillId: 'polymarket-edge',
    name: 'Polymarket Trading Edge',
    description: 'Prediction market strategies for Polymarket positions',
    content: `## Polymarket Trading Edge

When evaluating Polymarket positions:

1. **Edge Calculation**: Only enter positions where you estimate ≥10% edge vs market price. If market says 40% YES, you need to believe it's at least 50% YES.
2. **Liquidity Assessment**: Check order book depth. For markets with <$10k in liquidity, limit position size to $500 max to avoid moving the market.
3. **Time Decay**: Prediction markets have implicit time value. As resolution approaches, positions converge to 0 or 100. Enter early when edge is highest.
4. **Correlation with Crypto**: Many Polymarket events correlate with crypto prices (regulatory events, elections). Consider hedging crypto exposure with relevant Polymarket positions.
5. **Portfolio Allocation**: Cap total Polymarket exposure at 10% of portfolio. These are high-conviction, binary-outcome bets.
6. **Exit Strategy**: Take partial profits when position moves 20%+ in your favor. Let remainder ride to resolution.
7. **News Monitoring**: Cross-reference with Scout intel — breaking news can flip market odds before prices adjust. Speed advantage matters.`,
    version: '1.0.0',
    category: 'trading',
  },
  {
    skillId: 'kamino-yield',
    name: 'Kamino Yield Optimization',
    description: 'Kamino Finance lending/borrowing and yield strategies on Solana',
    content: `## Kamino Yield Optimization

When managing Kamino positions:

1. **Lending Strategy**: Prefer lending stablecoins (USDC, USDT) for base yield. Lend SOL only when utilization rate is >70% (better rates).
2. **Borrow Management**: Monitor health factor continuously. Target health factor ≥2.0 for safety. If health drops below 1.5, trigger immediate partial repay.
3. **Loop Strategy**: SOL borrow-lend loops can amplify yield but amplify risk. Maximum 2 loops. Always maintain ability to unwind in single transaction.
4. **Rate Monitoring**: Kamino rates fluctuate with utilization. If borrow rate exceeds lending yield by >2%, the loop is unprofitable — unwind.
5. **Collateral Optimization**: Use liquid staking tokens (mSOL, jitoSOL, bSOL) as collateral to earn staking yield on top of lending yield.
6. **Liquidation Risk**: Set alert at health factor 1.8. Auto-repay at 1.5. Never let it reach 1.2 — liquidation penalties are 5-10%.
7. **Harvest Timing**: Claim KMNO rewards at least weekly. Auto-compound when gas is cheap (< 5000 lamports priority fee).`,
    version: '1.0.0',
    category: 'defi',
  },
  {
    skillId: 'orca-lp',
    name: 'Orca LP Management',
    description: 'Concentrated liquidity management on Orca Whirlpools (Solana)',
    content: `## Orca LP Management

When managing Orca Whirlpool positions:

1. **Range Selection**: For stable pairs (USDC/USDT), use tight ranges (±0.5%). For volatile pairs (SOL/USDC), use wider ranges (±15-25%) to avoid constant rebalancing.
2. **Rebalance Triggers**: Rebalance when price moves past 75% of range bounds, not at exact boundary. This prevents whipsaw rebalancing.
3. **Fee Tier Selection**: Use 1bp pools for stables, 30bp for major pairs, 100bp for volatile/new tokens. Higher fee tiers compensate for impermanent loss.
4. **Position Sizing**: Split large positions across 2-3 sub-ranges for better capital efficiency and smoother rebalancing.
5. **IL Monitoring**: Track impermanent loss vs fees earned. If IL exceeds 30-day fee income, the range is wrong — widen it or exit.
6. **SOL Reserve**: Always keep 0.15 SOL free for transaction fees. Orca positions require multiple transactions (create, deposit, rebalance).
7. **Harvest Schedule**: Claim fees when accrued value exceeds 2x transaction cost. Don't harvest dust.
8. **Exit Strategy**: When closing, withdraw liquidity first, then close position. Never abandon positions — they hold rent deposits.`,
    version: '1.0.0',
    category: 'defi',
  },
  {
    skillId: 'krystal-lp',
    name: 'Krystal LP Management',
    description: 'NFPM-based concentrated liquidity on Polygon/EVM via Krystal',
    content: `## Krystal LP Management

When managing Krystal/NFPM positions on Polygon:

1. **Token ID Tracking**: Always track the actual NFPM tokenId (not Krystal strategy ID). These are different numbers — the tokenId is what the on-chain contract uses.
2. **Gas Awareness**: Polygon gas is cheap but spikes during congestion. Check gas before rebalance — if >200 gwei, wait. Set gas reserve at 0.5 POL minimum.
3. **Rebalance Flow**: Krystal rebalance = (1) collect fees, (2) remove liquidity, (3) swap to target ratio, (4) mint new position. Each step is a separate tx. Ensure sufficient POL for all 4.
4. **Range Strategy**: For WPOL/USDC, use ±20% range. For WETH/USDC, use ±15%. Monitor tick spacing — ranges must align to pool tick spacing.
5. **Fee Collection**: Collect fees before any rebalance. Uncollected fees are lost if the NFT is burned during rebalance.
6. **Position Health**: Check that positions have non-zero liquidity. Zero-liquidity NFTs may still have claimable fees (tokensOwed0/1) — collect before closing.
7. **Burned NFT Detection**: Before any operation, verify the NFT still exists via ownerOf(). If it reverts, the position was already closed.
8. **Entry USD Tracking**: Record entryUsd at position creation for accurate PnL. Thread this value through rebalances.`,
    version: '1.0.0',
    category: 'defi',
  },
  {
    skillId: 'nova-voice',
    name: 'Nova Communication Voice',
    description: 'Tone, style, and personality guidelines for all Nova external communications',
    content: `## Nova Communication Voice

When crafting external communications (tweets, Telegram posts, briefings):

1. **Tone**: Confident but not arrogant. Data-driven but accessible. Professional but with personality. Think "sharp DeFi native" not "corporate press release".
2. **Format**: Lead with the insight, not the preamble. "SOL breaking $180 resistance — our LP ranges just went in-the-money 💰" not "We would like to inform you that..."
3. **Data First**: Always include specific numbers when available. "$12.4k daily yield" not "great yield". "3.2x leverage" not "moderate leverage".
4. **Emojis**: Use sparingly for emphasis. Max 2 per message. 🐝 for Nova identity, 💰 for gains, ⚠️ for alerts, 🔥 for trends.
5. **Thread Structure**: For complex updates, use numbered points. Keep each point to 1-2 sentences. End with a clear takeaway.
6. **Avoid**: Shilling, price predictions, financial advice language, excessive hype. Never say "to the moon", "WAGMI", "NFA but..." etc.
7. **Admin vs Public**: Admin briefings can be technical and detailed. Public posts should be engaging and accessible to non-DeFi natives.
8. **Timing**: Don't post during extreme market volatility unless it's a safety alert. Wait for clarity before commenting on major events.`,
    version: '1.0.0',
    category: 'communication',
  },
  {
    skillId: 'scout-intel-scoring',
    name: 'Scout Intelligence Scoring',
    description: 'Framework for scoring and prioritizing intelligence from KOL monitoring and trend detection',
    content: `## Scout Intelligence Scoring

When evaluating and scoring detected intelligence:

1. **Source Tier Scoring**:
   - Tier 1 (Score 9-10): On-chain data, protocol announcements, verified insider info
   - Tier 2 (Score 7-8): Top KOLs with proven track record (>60% hit rate)
   - Tier 3 (Score 5-6): Mid-tier KOLs, trending topics with moderate engagement
   - Tier 4 (Score 3-4): Low-follower accounts, unverified rumors
   - Tier 5 (Score 1-2): Bot-like accounts, obvious shill campaigns

2. **Actionability Filter**: Score +2 if intel has a clear trade thesis. Score -1 if it's "interesting but no clear action".

3. **Time Sensitivity**: Mark as URGENT if the opportunity window is <2 hours. Mark as NORMAL for 2-24h windows. Mark as RESEARCH for longer-term themes.

4. **Deduplication**: If 3+ sources report the same event, consolidate into single high-confidence intel item. Don't flood the swarm with duplicates.

5. **Sentiment Cross-Check**: Before escalating bullish intel, check for contradicting bearish signals. Report both sides.

6. **Escalation Rules**: Score ≥8 → immediate alert to CFO + Admin. Score 5-7 → include in next briefing. Score <5 → log but don't escalate.

7. **Track Record**: Maintain a hit rate for each source. Downgrade sources that consistently produce low-quality intel.`,
    version: '1.0.0',
    category: 'intelligence',
  },
];

const SEED_ASSIGNMENTS: SeedAssignment[] = [
  // CFO gets risk + trading + defi skills
  { agentRole: 'nova-cfo', skillId: 'risk-framework', priority: 5 },
  { agentRole: 'nova-cfo', skillId: 'hyperliquid-trader', priority: 10 },
  { agentRole: 'nova-cfo', skillId: 'polymarket-edge', priority: 20 },
  { agentRole: 'nova-cfo', skillId: 'kamino-yield', priority: 30 },
  { agentRole: 'nova-cfo', skillId: 'orca-lp', priority: 40 },
  { agentRole: 'nova-cfo', skillId: 'krystal-lp', priority: 50 },

  // Scout gets intel scoring
  { agentRole: 'nova-scout', skillId: 'scout-intel-scoring', priority: 10 },

  // Supervisor gets communication voice
  { agentRole: 'nova-supervisor', skillId: 'nova-voice', priority: 10 },
];

// ============================================================================
// Seeder
// ============================================================================

export async function seedAgentSkills(pool: Pool): Promise<void> {
  logger.info('[SeedSkills] Seeding agent skills...');
  let inserted = 0;
  let skipped = 0;

  for (const skill of SEED_SKILLS) {
    try {
      const res = await pool.query(
        `INSERT INTO agent_skills
           (skill_id, name, description, content, version, category, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'seed', 'active')
         ON CONFLICT (skill_id) DO NOTHING`,
        [skill.skillId, skill.name, skill.description, skill.content, skill.version, skill.category],
      );
      if (res.rowCount && res.rowCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      logger.warn(`[SeedSkills] Failed to seed skill ${skill.skillId}:`, err);
    }
  }

  for (const assignment of SEED_ASSIGNMENTS) {
    try {
      await pool.query(
        `INSERT INTO agent_skill_assignments (agent_role, skill_id, priority)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_role, skill_id) DO NOTHING`,
        [assignment.agentRole, assignment.skillId, assignment.priority],
      );
    } catch (err) {
      logger.warn(`[SeedSkills] Failed assignment ${assignment.agentRole} → ${assignment.skillId}:`, err);
    }
  }

  logger.info(`[SeedSkills] Done: ${inserted} inserted, ${skipped} already existed, ${SEED_ASSIGNMENTS.length} assignments checked`);
}
