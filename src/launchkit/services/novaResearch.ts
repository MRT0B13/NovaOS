/**
 * Nova Research Engine
 * 
 * Gives Nova ecosystem knowledge via web search (Tavily API) + fact extraction (GPT).
 * 
 * Architecture:
 * 1. Scheduled research (3x daily): searches pre-defined topics, extracts facts, stores in PG
 * 2. On-demand quickSearch: reply engine can search for specific facts in real-time
 * 3. Knowledge query: content pipeline pulls relevant facts into GPT prompts
 * 
 * Data flow: Tavily search → GPT-4o-mini extraction → nova_knowledge table → prompt injection
 */

import { logger } from '@elizaos/core';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';

// =========================================================================
// Types
// =========================================================================

type KnowledgeCategory = 
  | 'ecosystem'       // pump.fun, Solana meme landscape, launch platforms
  | 'security'        // Rugs, scams, exploits, safety tools
  | 'competitive'     // Platform comparisons, chain comparisons
  | 'educational'     // Bonding curves, tokenomics, mechanics
  | 'news'            // Breaking/recent events (24h TTL)
  | 'defi'            // DeFi protocols, yields, TVL, DEXs
  | 'solana'          // Solana-specific ecosystem depth
  | 'bitcoin_macro'   // BTC, ETFs, institutional, macro
  | 'regulation'      // SEC, global regulation, legal landscape
  | 'ai_agents'       // AI x crypto intersection
  | 'infrastructure'  // Bridges, oracles, MEV, validators
  | 'culture';        // CT culture, narratives, social dynamics

interface ResearchTopic {
  id: string;
  category: KnowledgeCategory;
  query: string;
  extractPrompt: string;
  ttlHours: number;
  priority: number; // 1-10, higher = research first
}

type NovaPostType = 
  | 'hot_take' | 'market_commentary' | 'trust_talk' | 'builder_insight'
  | 'ai_thoughts' | 'degen_wisdom' | 'daily_recap' | 'gm' | 'market_roast'
  | 'behind_scenes' | 'milestone' | 'weekly_summary' | 'random_banter'
  | 'community_poll';

// =========================================================================
// Research Topics
// =========================================================================

const RESEARCH_TOPICS: ResearchTopic[] = [

  // ============================================================================
  // ECOSYSTEM — pump.fun, Solana meme landscape, launch platforms
  // ============================================================================
  
  {
    id: 'pump_fun_stats',
    category: 'ecosystem',
    query: 'pump.fun statistics tokens launched graduation rate volume 2025 2026',
    extractPrompt: 'Extract specific numbers: total tokens launched on pump.fun, graduation rate percentage, daily/total volume processed, revenue generated. Only include numbers attributable to a source.',
    ttlHours: 72,
    priority: 9,
  },
  {
    id: 'pump_fun_recent_news',
    category: 'news',
    query: 'pump.fun news updates latest week',
    extractPrompt: 'What are the most recent pump.fun developments? New features, controversies, partnerships, volume milestones, PumpSwap updates. Include dates.',
    ttlHours: 24,
    priority: 9,
  },
  {
    id: 'pumpswap_mechanics',
    category: 'ecosystem',
    query: 'PumpSwap pump.fun AMM DEX creator fees graduation mechanics',
    extractPrompt: 'What is PumpSwap? How does graduation from bonding curve to PumpSwap work? What are creator fee percentages? How does liquidity transition? Extract specific mechanics and numbers.',
    ttlHours: 72,
    priority: 8,
  },
  {
    id: 'pump_fun_controversies',
    category: 'ecosystem',
    query: 'pump.fun controversies problems issues criticism scams',
    extractPrompt: 'What criticisms and controversies has pump.fun faced? Livestream incidents, scam concerns, regulatory questions. Extract specific incidents and community reactions.',
    ttlHours: 72,
    priority: 6,
  },
  {
    id: 'meme_coin_meta',
    category: 'ecosystem',
    query: 'meme coin meta narrative trends what types performing 2025 2026',
    extractPrompt: 'What meme coin narratives are currently performing? Animal coins, political tokens, AI tokens, culture coins? What themes are gaining or losing traction? Extract specific trends and examples.',
    ttlHours: 48,
    priority: 7,
  },
  {
    id: 'meme_coin_lifecycle',
    category: 'educational',
    query: 'meme coin lifecycle average lifespan pump.fun token survival rate',
    extractPrompt: 'What is the typical lifecycle of a meme token? Average time from launch to death, what percentage survive past 24h, 7 days, 30 days? Extract any survival/mortality data available.',
    ttlHours: 168,
    priority: 7,
  },

  // ============================================================================
  // SECURITY — Rugs, scams, exploits, safety
  // ============================================================================
  
  {
    id: 'solana_rug_pulls_weekly',
    category: 'security',
    query: 'Solana rug pull scam this week latest meme coin',
    extractPrompt: 'What are the most recent Solana rug pulls or scams? Extract specific token names, amounts lost, methods used (mint exploit, liquidity pull, etc.). Include dates.',
    ttlHours: 48,
    priority: 9,
  },
  {
    id: 'rug_pull_techniques',
    category: 'security',
    query: 'common rug pull techniques Solana SPL token mint authority freeze honeypot',
    extractPrompt: 'What are the most common rug pull techniques on Solana? Mint authority exploits, freeze authority abuse, honeypot contracts, liquidity removal, bundled buys. Explain each method specifically.',
    ttlHours: 168,
    priority: 8,
  },
  {
    id: 'crypto_hacks_exploits',
    category: 'security',
    query: 'cryptocurrency hack exploit bridge DeFi latest 2025 2026',
    extractPrompt: 'What are the most recent major crypto hacks or exploits? Protocol name, amount stolen, attack vector, was money recovered? Extract specific incidents with numbers.',
    ttlHours: 48,
    priority: 8,
  },
  {
    id: 'rugcheck_updates',
    category: 'security',
    query: 'RugCheck Solana token safety scanner how it works updates',
    extractPrompt: 'What does RugCheck check specifically? Risk score methodology, what flags it raises, recent updates or new features. How is it used in the Solana ecosystem?',
    ttlHours: 168,
    priority: 6,
  },
  {
    id: 'crypto_scam_patterns',
    category: 'security',
    query: 'cryptocurrency scam patterns social engineering fake airdrops phishing 2025',
    extractPrompt: 'What are the current common crypto scam patterns? Fake airdrops, phishing, social engineering, impersonation, fake DEX approvals. How much has been lost to scams recently?',
    ttlHours: 72,
    priority: 6,
  },
  {
    id: 'smart_contract_audits',
    category: 'security',
    query: 'smart contract audit importance Solana security best practices',
    extractPrompt: 'Why do smart contract audits matter? What do auditors check? How many DeFi exploits could have been prevented by audits? Extract statistics and examples.',
    ttlHours: 336,
    priority: 4,
  },

  // ============================================================================
  // COMPETITIVE — Platform and chain comparisons
  // ============================================================================
  
  {
    id: 'launch_platform_comparison',
    category: 'competitive',
    query: 'pump.fun vs moonshot vs believe vs four.meme token launch platform comparison 2025',
    extractPrompt: 'Compare token launch platforms: pump.fun, Moonshot, Believe, four.meme, others. Fee structures, graduation mechanics, volume, user base, chain. Pros/cons of each.',
    ttlHours: 168,
    priority: 7,
  },
  {
    id: 'solana_vs_base_memecoins',
    category: 'competitive',
    query: 'Solana vs Base meme coins comparison volume activity 2025 2026',
    extractPrompt: 'How does Solana meme coin ecosystem compare to Base? Volume, active users, transaction costs, launch platforms, notable tokens. Why choose one over the other?',
    ttlHours: 168,
    priority: 6,
  },
  {
    id: 'solana_vs_ethereum',
    category: 'competitive',
    query: 'Solana vs Ethereum comparison TPS fees DeFi TVL 2025 2026',
    extractPrompt: 'Current Solana vs Ethereum comparison: TPS, transaction costs, TVL, DeFi activity, developer activity, market cap. Where does each chain excel?',
    ttlHours: 168,
    priority: 6,
  },
  {
    id: 'dex_comparison',
    category: 'competitive',
    query: 'Jupiter Raydium Orca Solana DEX comparison volume features 2025',
    extractPrompt: 'Compare major Solana DEXs: Jupiter, Raydium, Orca. Volume, features, fee structures, market share. How do they interact with pump.fun tokens post-graduation?',
    ttlHours: 168,
    priority: 7,
  },
  {
    id: 'l2_landscape',
    category: 'competitive',
    query: 'Layer 2 landscape Base Arbitrum Optimism comparison TVL activity 2025',
    extractPrompt: 'Current L2 landscape: Base, Arbitrum, Optimism, zkSync, others. TVL, transaction volume, unique features, meme coin activity. Which are growing fastest?',
    ttlHours: 168,
    priority: 5,
  },

  // ============================================================================
  // DEFI — Protocols, yields, TVL, DEX mechanics
  // ============================================================================

  {
    id: 'defi_tvl_landscape',
    category: 'defi',
    query: 'DeFi total value locked TVL top protocols 2025 2026',
    extractPrompt: 'What is total DeFi TVL? Top protocols by TVL and chain. How has TVL changed recently? Which protocols are growing or shrinking? Extract specific numbers.',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'solana_defi_ecosystem',
    category: 'defi',
    query: 'Solana DeFi ecosystem TVL top protocols Marinade Jito Jupiter',
    extractPrompt: 'What is Solana DeFi TVL? Top protocols: Jupiter, Raydium, Marinade, Jito, Drift, Kamino. What are their key metrics? How does Solana DeFi compare to Ethereum DeFi?',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'yield_landscape',
    category: 'defi',
    query: 'DeFi yield rates staking lending 2025 best yields Solana Ethereum',
    extractPrompt: 'What are current DeFi yield rates? Staking yields (ETH, SOL), lending rates, LP yields. Where are the best risk-adjusted returns? Extract specific APY numbers.',
    ttlHours: 72,
    priority: 5,
  },
  {
    id: 'dex_volume_trends',
    category: 'defi',
    query: 'DEX trading volume Uniswap Jupiter Raydium monthly 2025 2026',
    extractPrompt: 'What are current DEX volumes? Monthly and daily figures for top DEXs. How does DEX volume compare to CEX volume? Which DEXs are growing? Extract specific numbers.',
    ttlHours: 72,
    priority: 6,
  },
  {
    id: 'stablecoin_landscape',
    category: 'defi',
    query: 'stablecoin market USDT USDC PYUSD supply dominance 2025 2026',
    extractPrompt: 'Current stablecoin market: total supply, USDT vs USDC vs others market share, Solana stablecoin activity, PYUSD adoption, new stablecoin entrants. Extract supply figures and market shares.',
    ttlHours: 72,
    priority: 5,
  },
  {
    id: 'lending_protocols',
    category: 'defi',
    query: 'DeFi lending Aave Compound Solend Kamino rates TVL 2025',
    extractPrompt: 'Current DeFi lending landscape: top protocols, TVL, borrow/supply rates, recent exploits or changes. What are the dominant lending protocols on Solana specifically?',
    ttlHours: 168,
    priority: 4,
  },
  {
    id: 'liquid_staking',
    category: 'defi',
    query: 'liquid staking Solana Jito Marinade mSOL jitoSOL TVL yields',
    extractPrompt: 'Liquid staking on Solana: Jito (jitoSOL), Marinade (mSOL), others. TVL, yields, MEV rewards, market share. How does Solana liquid staking compare to Ethereum (Lido)?',
    ttlHours: 168,
    priority: 5,
  },
  {
    id: 'perps_derivatives',
    category: 'defi',
    query: 'DeFi perpetuals derivatives Hyperliquid Drift dYdX volume 2025',
    extractPrompt: 'On-chain derivatives landscape: Hyperliquid, Drift, dYdX, Jupiter Perps. Daily/monthly volume, open interest, market share. Which are growing? Extract specific numbers.',
    ttlHours: 72,
    priority: 6,
  },

  // ============================================================================
  // SOLANA — Deep Solana ecosystem knowledge
  // ============================================================================

  {
    id: 'solana_network_stats',
    category: 'solana',
    query: 'Solana network statistics TPS uptime validators performance 2025 2026',
    extractPrompt: 'Current Solana network stats: TPS, validator count, uptime record, recent outages or congestion, transaction fees. How has network performance improved or degraded?',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'solana_ecosystem_growth',
    category: 'solana',
    query: 'Solana ecosystem growth developers TVL market cap 2025 2026',
    extractPrompt: 'Solana ecosystem health: developer count, new projects, TVL growth, daily active addresses, transaction count. Is the ecosystem growing or contracting? Extract trend data.',
    ttlHours: 72,
    priority: 6,
  },
  {
    id: 'solana_mev_jito',
    category: 'solana',
    query: 'Solana MEV Jito tips sandwich attacks priority fees 2025',
    extractPrompt: 'How does MEV work on Solana? Jito tips, sandwich attacks, priority fees. How much MEV is extracted daily? How does this affect regular users and token launches? Extract specific numbers.',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'solana_token_extensions',
    category: 'solana',
    query: 'Solana Token Extensions Token-2022 features transfer fees confidential transfers',
    extractPrompt: 'What are Solana Token Extensions (Token-2022)? Key features: transfer fees, confidential transfers, interest-bearing tokens, soul-bound tokens. How are they being used? Which projects adopted them?',
    ttlHours: 336,
    priority: 4,
  },
  {
    id: 'solana_mobile_saga',
    category: 'solana',
    query: 'Solana mobile Saga Seeker phone crypto adoption',
    extractPrompt: 'Status of Solana mobile (Saga, Seeker). Sales numbers, app ecosystem, dApp Store, impact on Solana adoption. Is mobile crypto gaining traction?',
    ttlHours: 168,
    priority: 3,
  },
  {
    id: 'solana_depin',
    category: 'solana',
    query: 'Solana DePIN Helium Hivemapper Render network projects',
    extractPrompt: 'DePIN on Solana: Helium, Hivemapper, Render, io.net, others. What are they, how big are they, are they generating real usage? Extract specific metrics.',
    ttlHours: 168,
    priority: 5,
  },
  {
    id: 'solana_fees_economics',
    category: 'solana',
    query: 'Solana transaction fees priority fees base fees economics revenue',
    extractPrompt: 'How do Solana fees work? Base fee, priority fees, Jito tips. Total daily fee revenue. How do fees during congestion compare to normal times? Extract specific fee numbers.',
    ttlHours: 168,
    priority: 6,
  },

  // ============================================================================
  // BITCOIN & MACRO — BTC, ETFs, institutional, macro economy
  // ============================================================================

  {
    id: 'bitcoin_price_narrative',
    category: 'bitcoin_macro',
    query: 'Bitcoin price analysis narrative institutional adoption 2025 2026',
    extractPrompt: 'Current Bitcoin situation: price level, recent price action, dominant narrative (halving cycle, ETF flows, institutional adoption). What are analysts saying? Extract specific price levels and predictions if available.',
    ttlHours: 48,
    priority: 7,
  },
  {
    id: 'bitcoin_etf_flows',
    category: 'bitcoin_macro',
    query: 'Bitcoin ETF inflows outflows BlackRock Fidelity GBTC latest',
    extractPrompt: 'Bitcoin ETF status: total AUM, recent daily inflows/outflows, which ETFs are gaining/losing. How are ETF flows affecting price? Extract specific flow numbers.',
    ttlHours: 48,
    priority: 7,
  },
  {
    id: 'ethereum_etf_updates',
    category: 'bitcoin_macro',
    query: 'Ethereum ETF staking updates flows 2025 2026',
    extractPrompt: 'Ethereum ETF status: AUM, flows, staking inclusion, how they compare to Bitcoin ETFs. Any pending regulatory changes? Extract specific numbers.',
    ttlHours: 72,
    priority: 5,
  },
  {
    id: 'crypto_macro_economy',
    category: 'bitcoin_macro',
    query: 'cryptocurrency macro economy interest rates Fed impact crypto markets 2025',
    extractPrompt: 'How is the macro economy affecting crypto? Interest rate expectations, Fed policy, inflation data, risk appetite. What macro events are crypto markets watching? Extract specific economic indicators.',
    ttlHours: 48,
    priority: 6,
  },
  {
    id: 'institutional_adoption',
    category: 'bitcoin_macro',
    query: 'institutional crypto adoption banks treasury Bitcoin corporate 2025 2026',
    extractPrompt: 'Which institutions are adopting crypto? Corporate treasuries holding Bitcoin, banks offering crypto services, sovereign wealth funds. Extract specific companies and amounts.',
    ttlHours: 72,
    priority: 5,
  },
  {
    id: 'crypto_market_cap',
    category: 'bitcoin_macro',
    query: 'total crypto market cap dominance Bitcoin Ethereum Solana percentage 2025',
    extractPrompt: 'Total crypto market cap, Bitcoin dominance percentage, top 10 by market cap, Solana market cap ranking. How has dominance shifted recently? Extract specific numbers.',
    ttlHours: 48,
    priority: 6,
  },

  // ============================================================================
  // REGULATION — SEC, global regulation, legal landscape
  // ============================================================================

  {
    id: 'us_crypto_regulation',
    category: 'regulation',
    query: 'US cryptocurrency regulation SEC latest bills legislation 2025 2026',
    extractPrompt: 'Current US crypto regulation status: pending bills, SEC enforcement actions, stablecoin legislation, market structure bills. What has passed? What is pending? Extract specific bill names and status.',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'sec_enforcement',
    category: 'regulation',
    query: 'SEC cryptocurrency enforcement actions lawsuits latest 2025 2026',
    extractPrompt: 'Recent SEC enforcement actions against crypto companies. Who is being sued? For what? Outcomes? How is this affecting the industry? Extract specific cases.',
    ttlHours: 48,
    priority: 7,
  },
  {
    id: 'global_crypto_regulation',
    category: 'regulation',
    query: 'global cryptocurrency regulation MiCA Europe Asia Dubai Hong Kong 2025',
    extractPrompt: 'Global crypto regulation landscape: EU MiCA implementation, Asia (Hong Kong, Singapore, Japan), Middle East (Dubai, UAE). Which regions are crypto-friendly? What rules are in effect? Extract specific regulatory frameworks.',
    ttlHours: 168,
    priority: 5,
  },
  {
    id: 'meme_coin_regulation',
    category: 'regulation',
    query: 'meme coin regulation legal status SEC token classification securities',
    extractPrompt: 'How are meme coins classified legally? Are they securities? Has the SEC taken action against meme token launchers? What are the legal risks of launching tokens? Extract specific rulings or guidelines.',
    ttlHours: 168,
    priority: 7,
  },
  {
    id: 'tax_crypto',
    category: 'regulation',
    query: 'cryptocurrency tax reporting rules IRS US 2025 2026',
    extractPrompt: 'Current US crypto tax rules: reporting requirements, capital gains treatment, DeFi tax events, new IRS rules. What changed recently? Extract specific thresholds and rules.',
    ttlHours: 168,
    priority: 4,
  },

  // ============================================================================
  // AI AGENTS — AI x crypto intersection
  // ============================================================================

  {
    id: 'ai_agents_crypto_landscape',
    category: 'ai_agents',
    query: 'AI agents cryptocurrency autonomous trading Solana ElizaOS latest 2025 2026',
    extractPrompt: 'What AI agents are active in crypto? Agent names, what they do, which chains, volume/activity. How is ElizaOS used? What are the notable agent projects and their results?',
    ttlHours: 72,
    priority: 8,
  },
  {
    id: 'elizaos_ecosystem',
    category: 'ai_agents',
    query: 'ElizaOS ai16z framework ecosystem plugins agents built',
    extractPrompt: 'ElizaOS ecosystem: what is it, who built it, what agents are built on it, recent updates, plugin ecosystem, community size. How is it evolving? Extract specific details.',
    ttlHours: 72,
    priority: 8,
  },
  {
    id: 'ai_agent_trust',
    category: 'ai_agents',
    query: 'AI agent trust verification autonomous commerce x402 zauth TEE',
    extractPrompt: 'How is trust being solved for autonomous AI agents? x402 protocol, zauth verification, TEE (Trusted Execution Environments), on-chain verification. Extract specific solutions and how they work.',
    ttlHours: 168,
    priority: 7,
  },
  {
    id: 'ai_tokens_market',
    category: 'ai_agents',
    query: 'AI cryptocurrency tokens market cap performance VIRTUAL ARC FET 2025',
    extractPrompt: 'AI-related crypto tokens: top tokens by market cap, price performance, what they do. Virtuals Protocol, ARC, FET, TAO, others. How is the AI narrative performing in crypto markets?',
    ttlHours: 72,
    priority: 6,
  },
  {
    id: 'ai_agent_failures',
    category: 'ai_agents',
    query: 'AI agent crypto failures losses mistakes autonomous trading gone wrong',
    extractPrompt: 'What AI agent failures have occurred in crypto? Losses from autonomous trading, agent mistakes, security issues. What went wrong and what was learned? Extract specific incidents.',
    ttlHours: 72,
    priority: 7,
  },
  {
    id: 'ai_agent_infra',
    category: 'ai_agents',
    query: 'AI agent infrastructure MCP tools blockchain crypto 2025',
    extractPrompt: 'What infrastructure exists for crypto AI agents? MCP servers, on-chain tools, wallet management, LLM integration patterns. What tools are emerging? Extract specific projects and capabilities.',
    ttlHours: 168,
    priority: 5,
  },

  // ============================================================================
  // INFRASTRUCTURE — Bridges, oracles, MEV, validators, RPCs
  // ============================================================================

  {
    id: 'bridge_security',
    category: 'infrastructure',
    query: 'cross-chain bridge hacks security Wormhole LayerZero 2025',
    extractPrompt: 'Bridge security landscape: major bridge hacks (Wormhole, Ronin, etc.), total value lost, how bridges are improving security. What are the safest bridges? Extract specific hack amounts and dates.',
    ttlHours: 168,
    priority: 6,
  },
  {
    id: 'oracle_landscape',
    category: 'infrastructure',
    query: 'blockchain oracle Chainlink Pyth Switchboard price feed comparison',
    extractPrompt: 'Oracle landscape: Chainlink, Pyth (Solana-native), Switchboard. How do they work? Market share, reliability, speed. Why does oracle choice matter for DeFi and token prices?',
    ttlHours: 336,
    priority: 4,
  },
  {
    id: 'solana_validators',
    category: 'infrastructure',
    query: 'Solana validators staking economics decentralization Nakamoto coefficient',
    extractPrompt: 'Solana validator landscape: total validators, staking APY, Nakamoto coefficient (decentralization measure), hardware requirements, validator economics. Is Solana sufficiently decentralized?',
    ttlHours: 168,
    priority: 5,
  },
  {
    id: 'rpc_infrastructure',
    category: 'infrastructure',
    query: 'Solana RPC providers Helius Quicknode Alchemy pricing reliability',
    extractPrompt: 'Solana RPC provider landscape: Helius, QuickNode, Alchemy, Triton. Pricing, features, reliability. What are the differences for builders? What do most Solana apps use?',
    ttlHours: 336,
    priority: 3,
  },

  // ============================================================================
  // EDUCATIONAL — Mechanics, tokenomics, how things work
  // ============================================================================

  {
    id: 'bonding_curve_mechanics',
    category: 'educational',
    query: 'pump.fun bonding curve how it works graduation SOL threshold mechanics',
    extractPrompt: 'How does the pump.fun bonding curve work exactly? What triggers graduation? What is the SOL threshold? How does price discovery work on the curve? How is initial liquidity formed? Extract specific mechanics.',
    ttlHours: 336,
    priority: 8,
  },
  {
    id: 'token_safety_fundamentals',
    category: 'educational',
    query: 'Solana SPL token safety mint authority freeze authority revoke importance',
    extractPrompt: 'What is mint authority and freeze authority on Solana SPL tokens? Why does revoking them matter? What can a malicious creator do with active authorities? How to verify on-chain? Extract specific risks.',
    ttlHours: 336,
    priority: 8,
  },
  {
    id: 'amm_mechanics',
    category: 'educational',
    query: 'AMM automated market maker how it works impermanent loss liquidity pools',
    extractPrompt: 'How do AMMs (Automated Market Makers) work? Constant product formula, liquidity pools, impermanent loss, slippage. How do Raydium/Jupiter AMMs differ from Uniswap? Extract key mechanics.',
    ttlHours: 336,
    priority: 5,
  },
  {
    id: 'tokenomics_basics',
    category: 'educational',
    query: 'tokenomics supply distribution vesting inflation token design best practices',
    extractPrompt: 'What makes good tokenomics? Supply mechanics (fixed, inflationary, deflationary), vesting schedules, distribution fairness, insider allocation red flags. What are best practices? Extract specific patterns.',
    ttlHours: 336,
    priority: 5,
  },
  {
    id: 'wallet_security',
    category: 'educational',
    query: 'Solana wallet security Phantom Backpack best practices private key safety',
    extractPrompt: 'Wallet security best practices: hardware wallets, seed phrase management, approval hygiene, revoke.cash equivalent for Solana. Common wallet attack vectors. What should users do to stay safe?',
    ttlHours: 336,
    priority: 5,
  },
  {
    id: 'on_chain_analysis',
    category: 'educational',
    query: 'on-chain analysis Solana whale tracking wallet analysis DEX trades',
    extractPrompt: 'How does on-chain analysis work on Solana? Tools for tracking whale wallets, DEX trades, token flows. What can you learn from on-chain data? What tools exist (Solscan, Birdeye, etc.)?',
    ttlHours: 336,
    priority: 4,
  },

  // ============================================================================
  // CULTURE — Crypto Twitter, narratives, social dynamics
  // ============================================================================

  {
    id: 'crypto_twitter_narratives',
    category: 'culture',
    query: 'crypto Twitter CT narrative trends what people talking about this week 2025',
    extractPrompt: 'What are the dominant narratives on Crypto Twitter right now? Hot topics, debates, memes, feuds, trends. What is CT talking about this week? Extract specific topics and sentiment.',
    ttlHours: 24,
    priority: 8,
  },
  {
    id: 'notable_crypto_events',
    category: 'culture',
    query: 'cryptocurrency major events conferences announcements this month 2025 2026',
    extractPrompt: 'Major crypto events happening recently or soon: conferences (TOKEN2049, Breakpoint, ETHDenver), protocol launches, airdrops, token unlocks. What should people be paying attention to?',
    ttlHours: 48,
    priority: 6,
  },
  {
    id: 'airdrop_landscape',
    category: 'culture',
    query: 'crypto airdrops latest upcoming Solana Ethereum major 2025 2026',
    extractPrompt: 'Recent and upcoming airdrops: which protocols, estimated value, eligibility criteria, controversies (Sybil filtering, low allocations). What airdrop meta is current? Extract specific drops.',
    ttlHours: 48,
    priority: 6,
  },
  {
    id: 'exchange_news',
    category: 'culture',
    query: 'Binance Coinbase Kraken exchange news listings delistings latest 2025',
    extractPrompt: 'Major exchange news: new listings, delistings, regulatory actions, product launches, fee changes. What is happening at Binance, Coinbase, Kraken, Bybit? Extract specific developments.',
    ttlHours: 48,
    priority: 6,
  },
  {
    id: 'nft_state',
    category: 'culture',
    query: 'NFT market status Solana Ethereum sales volume 2025 2026',
    extractPrompt: 'Current state of NFTs: total sales volume, top collections, Solana vs Ethereum NFTs, market recovery or continued decline. Is anything notable happening in NFTs? Extract volume and trend data.',
    ttlHours: 72,
    priority: 4,
  },
  {
    id: 'dao_governance',
    category: 'culture',
    query: 'DAO governance crypto notable votes proposals Uniswap Aave MakerDAO 2025',
    extractPrompt: 'Notable DAO governance events: controversial votes, treasury management decisions, protocol upgrades. What governance decisions are shaping DeFi? Extract specific proposals and outcomes.',
    ttlHours: 72,
    priority: 4,
  },
  {
    id: 'rwa_tokenization',
    category: 'culture',
    query: 'real world assets RWA tokenization BlackRock Ondo treasury bonds crypto 2025',
    extractPrompt: 'RWA (Real World Assets) tokenization status: treasury bonds on-chain, BlackRock BUIDL fund, Ondo Finance, total RWA TVL. Is this narrative gaining real traction? Extract specific TVL and project numbers.',
    ttlHours: 72,
    priority: 5,
  },
];

// =========================================================================
// Lazy DB init
// =========================================================================

let pgRepo: PostgresScheduleRepository | null = null;
let researchSchedulerRunning = false;

async function getRepo(): Promise<PostgresScheduleRepository | null> {
  if (pgRepo) return pgRepo;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    pgRepo = await PostgresScheduleRepository.create(dbUrl);
    return pgRepo;
  } catch (err) {
    logger.warn('[NovaResearch] Failed to init PG:', err);
    return null;
  }
}

// =========================================================================
// Core Research Functions
// =========================================================================

/**
 * Get topics that need refreshing (expired or never fetched).
 * Checks each topic individually against its expiry rather than bulk-checking.
 */
async function getStaleTopics(): Promise<ResearchTopic[]> {
  const repo = await getRepo();
  if (!repo) return RESEARCH_TOPICS; // If no DB, all are stale

  const stale: ResearchTopic[] = [];

  for (const topic of RESEARCH_TOPICS) {
    try {
      const result = await repo.query(
        `SELECT fetched_at, expires_at FROM nova_knowledge WHERE topic = $1`,
        [topic.id]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const expiresAt = new Date(row.expires_at);

        // Still fresh — skip
        if (expiresAt > new Date()) continue;
      }
    } catch { /* treat as stale */ }

    stale.push(topic);
  }

  return stale;
}

/**
 * Research a single topic: Tavily search → GPT fact extraction → store in PG
 */
async function researchTopic(topic: ResearchTopic): Promise<void> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!tavilyKey || !openaiKey) return;

  const repo = await getRepo();
  if (!repo) return;

  // Step 1: Search via Tavily
  const searchRes = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: topic.query,
      search_depth: topic.priority >= 8 ? 'advanced' : 'basic',
      include_answer: true,
      max_results: 5,
    }),
  });

  if (!searchRes.ok) {
    throw new Error(`Tavily API error: ${searchRes.status}`);
  }

  const searchData = await searchRes.json();
  const results = searchData.results || [];
  const tavilyAnswer = searchData.answer || '';

  if (results.length === 0 && !tavilyAnswer) {
    logger.debug(`[NovaResearch] No results for "${topic.id}"`);
    return;
  }

  // Step 2: Extract facts via GPT
  const sourceText = results
    .map((r: any, i: number) => `[Source ${i + 1}: ${r.title}]\n${r.content}`)
    .join('\n\n');

  const extractRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a strict fact extraction engine. You extract ONLY facts that are directly, explicitly stated in the sources below. You NEVER infer, extrapolate, round, or estimate.

Rules:
- Every fact MUST be traceable to a specific source below. If two sources give different numbers, include both with attribution.
- NEVER combine partial data to create a new statistic (e.g., don't multiply X by Y to estimate Z).
- If a source says "about" or "approximately", preserve that qualifier.
- If data seems outdated (>6 months old), note the date in the fact.
- Set confidence LOW (0.3-0.5) if sources are sparse or data is old. Only 0.8+ if multiple sources agree on specific recent numbers.
- If you find NO verifiable facts with numbers or specific claims, return {"summary": "No specific data found", "facts": [], "confidence": 0.1}

Return JSON in this exact format:
{
  "summary": "2-3 sentence summary of findings",
  "facts": ["fact 1 with specific numbers/dates from [Source N]", "fact 2", ...],
  "confidence": 0.0-1.0
}`,
        },
        {
          role: 'user',
          content: `Topic: ${topic.id}\nExtraction goal: ${topic.extractPrompt}\n\nTavily synthesis: ${tavilyAnswer}\n\nRaw sources:\n${sourceText}`,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!extractRes.ok) {
    throw new Error(`OpenAI extraction error: ${extractRes.status}`);
  }

  const extractData = await extractRes.json();
  const rawContent = extractData.choices?.[0]?.message?.content;
  if (!rawContent) {
    logger.warn(`[NovaResearch] Empty GPT response for "${topic.id}"`);
    return;
  }

  let extracted: { summary: string; facts: string[]; confidence: number };
  try {
    extracted = JSON.parse(rawContent);
  } catch {
    logger.warn(`[NovaResearch] Failed to parse GPT JSON for "${topic.id}"`);
    return;
  }

  // Step 3: Store in PostgreSQL
  const sources = results.map((r: any) => ({
    url: r.url,
    title: r.title,
    score: r.score,
  }));

  const expiresAt = new Date(Date.now() + topic.ttlHours * 60 * 60 * 1000);

  await repo.query(
    `INSERT INTO nova_knowledge (category, topic, summary, facts, sources, search_query, confidence, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (topic) DO UPDATE SET
       summary = $3, facts = $4, sources = $5, search_query = $6,
       confidence = $7, fetched_at = NOW(), expires_at = $8`,
    [topic.category, topic.id, extracted.summary, JSON.stringify(extracted.facts),
     JSON.stringify(sources), topic.query, extracted.confidence, expiresAt]
  );

  logger.info(`[NovaResearch] ✅ Stored ${extracted.facts.length} facts for "${topic.id}" (confidence: ${extracted.confidence})`);
}

/**
 * Run a research cycle — check which topics need refreshing and fetch new data.
 * Called on a schedule (3x daily) and can also be triggered manually.
 */
export async function runResearchCycle(): Promise<void> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    logger.debug('[NovaResearch] No TAVILY_API_KEY — research disabled');
    return;
  }

  const staleTopics = await getStaleTopics();

  if (staleTopics.length === 0) {
    logger.debug('[NovaResearch] All topics fresh — nothing to research');
    return;
  }

  // Sort by priority, take top 5 per cycle (rate limiting)
  const batch = staleTopics
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);

  logger.info(`[NovaResearch] Researching ${batch.length} topics: ${batch.map(t => t.id).join(', ')}`);

  for (const topic of batch) {
    try {
      await researchTopic(topic);
      // Rate limit: 1 search per 5 seconds
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      logger.warn(`[NovaResearch] Failed to research ${topic.id}: ${err}`);
    }
  }
}

// =========================================================================
// Knowledge Query Functions (for content pipeline)
// =========================================================================

/**
 * Map post types to relevant knowledge categories.
 */
const CATEGORY_MAP: Partial<Record<NovaPostType, string[]>> = {
  hot_take:           ['ecosystem', 'security', 'competitive', 'news', 'culture', 'bitcoin_macro', 'ai_agents'],
  market_commentary:  ['ecosystem', 'news', 'security', 'defi', 'bitcoin_macro', 'culture'],
  trust_talk:         ['security', 'educational', 'regulation'],
  builder_insight:    ['ecosystem', 'educational', 'competitive', 'ai_agents', 'infrastructure'],
  ai_thoughts:        ['ai_agents', 'educational', 'ecosystem', 'infrastructure'],
  degen_wisdom:       ['ecosystem', 'security', 'educational', 'culture', 'defi'],
  daily_recap:        ['news', 'culture', 'bitcoin_macro'],
  gm:                 ['news', 'culture'],
  market_roast:       ['ecosystem', 'security', 'bitcoin_macro', 'defi', 'culture'],
  behind_scenes:      ['ai_agents', 'infrastructure'],
  random_banter:      ['culture', 'ecosystem'],
  community_poll:     ['ecosystem', 'culture', 'competitive'],
  weekly_summary:     ['news', 'bitcoin_macro', 'ecosystem'],
};

/**
 * Get relevant knowledge for a specific post type.
 * Returns formatted text block to inject into GPT prompts.
 */
export async function getKnowledgeForPostType(
  type: string
): Promise<string> {
  const repo = await getRepo();
  if (!repo) return '';

  const categories = CATEGORY_MAP[type as NovaPostType];
  if (!categories || categories.length === 0) return '';

  try {
    const placeholders = categories.map((_, i) => `$${i + 1}`).join(', ');
    const result = await repo.query(
      `SELECT topic, summary, facts, confidence, category
       FROM nova_knowledge 
       WHERE category IN (${placeholders})
         AND expires_at > NOW()
         AND confidence >= 0.4
       ORDER BY 
         CASE WHEN category = 'news' THEN 0 ELSE 1 END,
         confidence DESC,
         fetched_at DESC
       LIMIT 5`,
      categories
    );

    if (result.rows.length === 0) return '';

    const lines: string[] = [];
    for (const row of result.rows) {
      const facts = row.facts || [];
      if (facts.length > 0) {
        const topFacts = facts.slice(0, 3).join('; ');
        lines.push(`[${row.category.toUpperCase()}] ${row.summary} Key facts: ${topFacts}`);
      } else {
        lines.push(`[${row.category.toUpperCase()}] ${row.summary}`);
      }
    }

    // Increment used_count for analytics
    const usedTopics = result.rows.map((r: any) => r.topic);
    repo.query(
      `UPDATE nova_knowledge SET used_count = used_count + 1 WHERE topic = ANY($1)`,
      [usedTopics]
    ).catch(() => {});

    return `\nECOSYSTEM KNOWLEDGE (verified via web research):\n${lines.join('\n')}\n\nRULES FOR USING KNOWLEDGE ABOVE:\n- You MAY reference these facts naturally in your post\n- You MUST NOT invent additional statistics, percentages, or numbers beyond what's listed above\n- If a fact says "~75%" do NOT round it to "80%" or embellish it\n- If no knowledge above is relevant to this post type, just ignore it — do NOT force it in\n- NEVER fabricate sources, URLs, or "studies show" claims\n- Hedge uncertain facts: say "reports suggest" not "data confirms"\n- If you cite a number, it MUST appear verbatim in the knowledge block above`;
  } catch (err) {
    logger.debug(`[NovaResearch] Knowledge query failed: ${err}`);
    return '';
  }
}

// =========================================================================
// On-demand Quick Search (for reply engine)
// =========================================================================

/**
 * Quick search for the reply engine.
 * Search → get Tavily's synthesized answer → return for use in reply.
 * Cached to avoid redundant searches on the same topic.
 */
export async function quickSearch(query: string): Promise<string | null> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return null;

  // Check cache first (same query within 6 hours)
  const repo = await getRepo();
  if (repo) {
    try {
      const cached = await repo.query(
        `SELECT summary, facts FROM nova_knowledge 
         WHERE search_query = $1 AND fetched_at > NOW() - INTERVAL '6 hours'
         LIMIT 1`,
        [query]
      );
      if (cached.rows.length > 0) {
        const facts = cached.rows[0].facts || [];
        return facts.length > 0 ? facts.slice(0, 2).join('. ') : cached.rows[0].summary;
      }
    } catch { /* continue to fresh search */ }
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.answer || null;
  } catch {
    return null;
  }
}

// =========================================================================
// Scheduling
// =========================================================================

/**
 * Start the research scheduler (call once from init).
 * Runs every 8 hours + initial research on startup after 2 min delay.
 */
export function startResearchScheduler(): void {
  if (researchSchedulerRunning) return;
  researchSchedulerRunning = true;

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    logger.info('[NovaResearch] No TAVILY_API_KEY — research scheduler disabled');
    return;
  }

  logger.info('[NovaResearch] Research scheduler starting (every 8h)');

  // Initial research after 2 minute delay (let DB init first)
  setTimeout(async () => {
    try {
      await runResearchCycle();
    } catch (err) {
      logger.warn('[NovaResearch] Initial research cycle failed:', err);
    }
  }, 2 * 60 * 1000);

  // Scheduled: every 8 hours
  setInterval(async () => {
    try {
      await runResearchCycle();
    } catch (err) {
      logger.warn('[NovaResearch] Scheduled research cycle failed:', err);
    }
  }, 8 * 60 * 60 * 1000);

  // Prune old knowledge daily
  setInterval(async () => {
    const repo = await getRepo();
    if (!repo) return;
    try {
      await repo.query(`DELETE FROM nova_knowledge WHERE expires_at < NOW() - INTERVAL '7 days'`);
    } catch { /* ignore */ }
  }, 24 * 60 * 60 * 1000);
}
