/**
 * Seed Skills — pre-populate the agent_skills registry with foundational skills
 *
 * Called once at startup; uses ON CONFLICT DO NOTHING so it's idempotent.
 */

import { logger } from '@elizaos/core';
import type { SkillsService } from '../services/skillsService.ts';

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
    skillId: 'hyperliquid-trader',
    name: 'Hyperliquid Perpetuals Trader',
    category: 'finance',
    description: 'Perpetuals trading on Hyperliquid — hedging, stop-loss, leverage decisions',
    content: `# Hyperliquid Perpetuals — Decision Framework

## When to Open a Hedge
- Open short when SOL portfolio exposure exceeds hedge target ratio AND market regime is trending down
- Hedge size = portfolio_sol_value × hedge_target_ratio × globalRiskMultiplier
- Never hedge if recent PnL shows stop-loss has already fired (check cooldown)
- Only open hedge if position value > CFO_HEDGE_MIN_SOL_USD

## Stop-Loss Rules
- Hard stop at CFO_HL_STOP_LOSS_PCT — no exceptions, bypass approval tier
- Liquidation warning at CFO_HL_LIQUIDATION_WARNING_PCT — deleverage immediately
- Never add to a losing HL position

## Leverage
- Default hedge: 1x (delta neutral target)
- Max leverage: CFO_MAX_HYPERLIQUID_LEVERAGE (currently 3x)
- Higher leverage = smaller notional needed for same hedge, but higher funding cost

## Cooldowns
- Hedge cooldown: CFO_HEDGE_COOLDOWN_HOURS (no new hedges within window)
- Rebalance threshold: CFO_HEDGE_REBALANCE_THRESHOLD — only rebalance when drift exceeds this
- When in doubt: do nothing, let existing position run

## Common Mistakes to Avoid
- Do not open a hedge and a long simultaneously — net neutral defeats the purpose
- Do not use HL for speculation, only hedging unless a clear directional signal exists
- Always verify mainnet (not testnet) before opening`,
    version: '1.0.0',
  },
  {
    skillId: 'polymarket-edge',
    name: 'Polymarket Prediction Market Edge',
    category: 'finance',
    description: 'Kelly criterion sizing, edge detection, and market selection for Polymarket',
    content: `# Polymarket — Edge and Sizing Framework

## Market Selection
- Only bet on markets where estimated edge > CFO_MIN_EDGE (5%)
- Focus on: crypto price milestones, protocol launches, macro events with crypto impact
- Avoid: political markets (jurisdiction risk), sports, markets with < 48h to resolution
- Never bet on markets with < $10k liquidity (price impact too high)

## Edge Calculation
- Edge = |estimated_probability - market_implied_probability|
- Estimated probability must come from analysis, not gut feel
- Consider: on-chain data, KOL signals from Scout, macro context
- Update estimate if new information arrives before resolution

## Kelly Criterion Sizing
- Bet size = (edge / odds) × kelly_fraction × total_bankroll
- kelly_fraction = CFO_KELLY_FRACTION (currently 0.20 — conservative)
- Max single bet = CFO_MAX_SINGLE_BET_USD regardless of Kelly output
- Never exceed 15% of total portfolio on Polymarket total exposure

## Cooldowns and Risk
- Cooldown between bets on same market: CFO_POLY_BET_COOLDOWN_HOURS
- Cut losses if probability estimate moves against position by > 20%
- Record estimated_probability in position metadata for calibration tracking

## After Resolution
- Log actual outcome vs estimated probability — this feeds the calibration loop
- If Brier score deteriorates over 10+ bets, reduce kelly_fraction`,
    version: '1.0.0',
  },
  {
    skillId: 'kamino-yield',
    name: 'Kamino Finance Yield Strategy',
    category: 'finance',
    description: 'Kamino lending, borrowing, JitoSOL loop, and LTV management',
    content: `# Kamino Finance — Yield Strategy Framework

## Lending (Passive Yield)
- Deposit idle USDC into Kamino lending at prevailing rate (~5-8% APY)
- Only deposit if USDC is not needed for Polymarket in next 24h
- Monitor: deposit APR daily, withdraw if rate drops below 3%

## JitoSOL Loop Strategy
- Deposit SOL → borrow SOL against JitoSOL → re-stake = amplified yield
- Target LTV: CFO_KAMINO_JITO_LOOP_TARGET_LTV (currently 55%)
- Max LTV before emergency deleverage: CFO_KAMINO_JITO_LOOP_MAX_LTV_PCT (63%)
- Max loops: CFO_KAMINO_JITO_LOOP_MAX_LOOPS (2)
- Only loop when JitoSOL APY > borrow rate + 2% spread

## Borrow-LP Strategy
- Borrow USDC against SOL collateral to fund LP positions
- Max borrow: CFO_MAX_KAMINO_BORROW_USD
- LP borrow max LTV: CFO_KAMINO_BORROW_LP_MAX_LTV_PCT (50%)
- Required spread: borrow_rate + CFO_KAMINO_BORROW_MIN_SPREAD_PCT < LP_APR
- Only open if net yield positive after borrowing cost

## LTV Management Rules
- Hard ceiling: CFO_KAMINO_MAX_LTV_PCT (52%)
- Reduce borrowing if LTV > 45% (approaching ceiling)
- Emergency deleverage if LTV > 50% — do not wait for approval
- Monitor LTV every decision cycle — Kamino can liquidate if SOL price drops

## What Not To Do
- Never borrow to chase yield on high-risk pools — net yield must be provably positive
- Never open a borrow position if SOL price is >10% down in 24h (liquidation risk higher)`,
    version: '1.0.0',
  },
  {
    skillId: 'orca-lp',
    name: 'Orca Whirlpool LP Strategy (Solana)',
    category: 'finance',
    description: 'Concentrated liquidity LP on Orca — range setting, rebalancing, fee collection',
    content: `# Orca Whirlpool LP — Decision Framework

## Pool Selection
- Minimum: pool must pass DeFiLlama cross-reference + Orca on-chain verification
- Score pools on: fee revenue (35%), volume/TVL ratio (20%), TVL depth (15%), IL risk (15%), ML prediction (10%)
- Risk tiers: low (stable pairs), medium (one volatile token), high (both volatile)
- Apply learning engine lpBestPairs preferences when scoring is close

## Range Width by Risk Tier
- Low (stables): tighter ranges — lpRangeWidthMultiplier × low tier multiplier
- Medium: standard range — lpRangeWidthMultiplier × medium tier multiplier
- High: wide range — lpRangeWidthMultiplier × high tier multiplier
- Learning engine adjusts these via lpTierRangeMultipliers

## When to Rebalance
- Trigger: position is out-of-range (earning zero fees)
- Trigger threshold: CFO_ORCA_LP_REBALANCE_TRIGGER_PCT from center
- Check: is rebalance cost (gas + slippage) < projected fee income in next 24h?
- If not cost-effective: wait, don't rebalance for small price movements
- Set metadata.outOfRange = true when position goes OOR (feeds learning engine)

## Fee Collection
- Collect fees when accumulated > gas cost × 10
- Record fee amount in transaction metadata (feeds feeDrag tracking)
- Never close a position just to collect fees — wait for rebalance

## Position Limits
- Max positions: CFO_ORCA_LP_MAX_POSITIONS
- Max total USD: CFO_ORCA_LP_MAX_USD
- Only open new position if Kamino borrow path is available OR free capital exists`,
    version: '1.0.0',
  },
  {
    skillId: 'krystal-lp',
    name: 'Krystal EVM LP Strategy (Multi-chain)',
    category: 'finance',
    description: 'Concentrated liquidity LP on EVM chains via Krystal — Uniswap V3, PancakeSwap, Aerodrome',
    content: `# Krystal EVM LP — Decision Framework

## Chain and Protocol Selection
- Chains: Ethereum, Optimism, Polygon, Base, Arbitrum, BSC
- Protocols: Uniswap V3, PancakeSwap V3, Aerodrome CL (different ABI — tick-based not fee-based)
- Score pools: APR 7d (40%), TVL (25%), volume consistency (20%), protocol reputation (10%), range safety (5%)
- Minimum: CFO_KRYSTAL_LP_MIN_APR_7D and CFO_KRYSTAL_LP_MIN_TVL_USD must be met

## Risk Tiers
- Assign riskTier to every opened position (write to metadata.riskTier)
- low: both tokens stable (USDC/USDT, etc.)
- medium: one volatile, one stable
- high: both volatile
- Record tier in cfo_positions metadata — feeds learning engine lpRangeWidthMultiplier

## Range Management
- Use CFO_KRYSTAL_LP_RANGE_WIDTH_TICKS for initial range
- Apply learning engine lpRangeWidthMultiplier adjustments
- Monitor via Krystal API — if API down, use on-chain fallback (NFPM.positions())
- Rebalance when: position OOR AND CFO_KRYSTAL_LP_REBALANCE_TRIGGER_PCT exceeded

## EVM Wallet Considerations
- Gas costs on Ethereum can be significant — check before rebalancing small positions
- Base and Arbitrum have lowest gas — prefer these for smaller positions
- Never open a position if wallet MATIC/ETH balance < 0.01 (gas buffer)
- __cfo_evm_lp_records must be re-synced from on-chain after any restart

## Common Mistakes
- Do not conflate Aerodrome sqrtPriceX96 parameter with Uniswap fee parameter
- Always verify riskTier is written to metadata before position is considered tracked`,
    version: '1.0.0',
  },
  {
    skillId: 'risk-framework',
    name: 'CFO Risk Management Framework',
    category: 'finance',
    description: 'Exposure limits, approval tiers, emergency procedures, and position sizing',
    content: `# CFO Risk Management — Standing Rules

## Exposure Limits (Never Exceed)
- Hyperliquid: max CFO_MAX_HYPERLIQUID_USD total notional
- Polymarket: max CFO_MAX_POLYMARKET_USD total exposure
- Kamino: max CFO_MAX_KAMINO_USD deposited/borrowed
- Orca LP: max CFO_ORCA_LP_MAX_USD
- Krystal LP: max CFO_KRYSTAL_LP_MAX_USD
- Jito: max CFO_MAX_JITO_SOL staked
- Always maintain CFO_STAKE_RESERVE_SOL liquid (never deploy below this)

## Approval Tiers
- Auto-execute: value < CFO_AUTO_TIER_USD (no notification needed)
- Notify: CFO_AUTO_TIER_USD ≤ value < CFO_NOTIFY_TIER_USD (execute + alert admin)
- Approval required: value ≥ CFO_NOTIFY_TIER_USD (send proposal, wait for /approve)
- Emergency bypass: CFO_CRITICAL_BYPASS_APPROVAL=true for stop-loss/liquidation prevention

## Global Risk Multiplier
- globalRiskMultiplier from learning engine scales all position sizes
- Risk-off regime (0.6×): reduce all position sizes, tighten stops
- Risk-on regime (1.15×): can increase sizes up to the exposure limits
- Never override globalRiskMultiplier manually — it exists for good reason

## Emergency Procedures
- market_crash command: pause all new decisions, close all open positions in order
- /cfo stop: immediate pause
- Stop-loss fires: immediate execution, no approval needed regardless of size

## What the CFO Must Never Do
- Never spend below TREASURY_MIN_RESERVE_SOL on the main wallet
- Never open both a long and short position on the same asset simultaneously
- Never execute more than CFO_MAX_DECISIONS_PER_CYCLE decisions in one cycle
- Never approve its own decisions — that's what the admin is for`,
    version: '1.0.0',
  },
  {
    skillId: 'nova-voice',
    name: 'Nova Brand Voice and Content Rules',
    category: 'content',
    description: "Nova's authentic voice — tone, banned phrases, content rules for X and TG",
    content: `# Nova Brand Voice — Standing Rules

## Who Nova Is
An autonomous AI agent that launches meme tokens on pump.fun and manages a DeFi portfolio. Builder mindset, data-driven, transparent about what she does and doesn't know. Not a hype bot.

## Tone
- Peer builder, not fan or marketer
- Specific over vague — name the event, token, or data point
- Transparent about uncertainty — "estimated" not "guaranteed"
- Dry wit is good, forced enthusiasm is not

## Banned Phrases (Never Use)
- "LFG", "WAGMI", "fam", "fren", "vibes", "banger", "slaps", "fire"
- "game changer", "groundbreaking", "revolutionary"
- "let's build together", "transparency is key", "great to see"
- "I've launched X tokens with Y% safety score" — never invent statistics
- Any percentage claim about RugCheck (it gives risk scores 0-100, not percentages)

## Data Rules
- Never invent numbers. If you don't have the stat, don't use it.
- Real stats available: launches count, graduation count, portfolio value (SOL)
- RugCheck gives a risk score (lower = safer), not a safety percentage

## Content Formula (X Posts)
- Lead with a real data point or observation
- Add one specific insight or question
- One emoji max. Zero is fine.
- Under 240 characters preferred, 280 max

## Reply Rules
- Tier 1 KOLs (aixbt, elizaos, pumpfun): substantive reply about their specific content
- Tier 2 ecosystem: brief, relevant, on-topic
- Skip: Samsung ads, spam, "nice project", engagement bait, unrelated to crypto

## X Handles (Always Use @ Tags, Not Hashtags)
- @Pumpfun @Rugcheckxyz @dexscreener @elizaOS @JupiterExchange @aixbt_agent`,
    version: '1.0.0',
  },
  {
    skillId: 'scout-intel-scoring',
    name: 'KOL Signal Scoring and Narrative Detection',
    category: 'analytics',
    description: 'How to score KOL signals, weight narratives, and decide what to forward to CFO',
    content: `# Scout — Signal Scoring Framework

## KOL Signal Weighting
- Tier 1 (high weight): accounts with > 100k followers AND track record of early calls
- Tier 2 (medium weight): active builders in the ecosystem, protocol accounts
- Tier 3 (low weight): general crypto commentary

## What Constitutes a Signal
- Specific token ticker mentioned with price target or thesis
- Protocol launch or upgrade announcement from official account
- Multiple Tier 1-2 KOLs converging on same narrative within 4 hours = strong signal
- Single KOL mention without cross-reference = weak signal

## Cross-Reference Rule
- Any signal forwarded to CFO must have 2+ independent sources OR 1 Tier 1 source with >10 engagements
- Trending tokens should always be cross-checked against Guardian watchlist for rug risk

## Intel Digest Content
- Lead with highest-confidence signals
- Include: source, confidence score, raw signal, cross-reference count
- Exclude: price predictions without thesis, obvious hype, tokens already on watchlist

## Forwarding to CFO
- Narrative shifts with DeFi implications → forward with 'high' priority
- New yield opportunities → forward as 'medium' intel
- Speculative mentions only → do not forward to CFO, include in digest only`,
    version: '1.0.0',
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

export async function seedAgentSkills(skills: SkillsService): Promise<void> {
  logger.info('[SeedSkills] Seeding agent skills...');

  for (const skill of SEED_SKILLS) {
    try {
      await skills.upsertSkill({
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        version: skill.version,
        category: skill.category,
        source: 'seed',
      });
    } catch (err) {
      logger.warn(`[SeedSkills] Failed to seed skill ${skill.skillId}:`, err);
    }
  }

  for (const assignment of SEED_ASSIGNMENTS) {
    try {
      await skills.assignSkill(assignment.agentRole, assignment.skillId, assignment.priority);
    } catch (err) {
      logger.warn(`[SeedSkills] Failed assignment ${assignment.agentRole} → ${assignment.skillId}:`, err);
    }
  }

  logger.info(`[SeedSkills] Seed complete — ${SEED_SKILLS.length} skills across ${new Set(SEED_ASSIGNMENTS.map(a => a.agentRole)).size} agents`);
}
