/**
 * EVM Pool Discovery Service — DeFiLlama-based multi-chain pool discovery
 *
 * Uses DeFiLlama yields API.
 * Modeled on orcaPoolDiscovery.ts — same scoring architecture, EVM-adapted.
 *
 * Data source: https://yields.llama.fi/pools filtered by:
 *   - project: uniswap-v3, pancakeswap-amm-v3, aerodrome-v2, sushiswap-v3
 *   - chain:   Ethereum, Arbitrum, Base, Optimism, Polygon, BSC
 *
 * Key functions:
 *   discoverEvmPools(forceRefresh?)   → scored list of EVM LP pool candidates
 *   selectBestEvmPool(opts)           → best pool for deployment (market-aware)
 *   getCachedEvmPools()               → in-memory cache without refresh
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';
import {
  WRAPPED_NATIVE_ADDR,
  NATIVE_SYMBOLS,
  isStablecoin,
} from './evmProviderService.ts';

// ============================================================================
// Constants
// ============================================================================

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';

/** DeFiLlama project slugs for supported concentrated-liquidity DEXes */
const SUPPORTED_PROJECTS = new Set([
  'uniswap-v3',
  'pancakeswap-amm-v3',
  'aerodrome-v2', // Aerodrome CL (Slipstream) on Base
  'sushiswap-v3',
]);

/** DeFiLlama chain name → numeric chainId mapping */
const LLAMA_CHAIN_TO_ID: Record<string, number> = {
  Ethereum:  1,
  Optimism:  10,
  BSC:       56,
  Polygon:   137,
  Base:      8453,
  Arbitrum:  42161,
  Avalanche: 43114,
};

/** Reverse: chainId → DeFiLlama chain name */
const CHAIN_ID_TO_LLAMA: Record<number, string> = {};
for (const [name, id] of Object.entries(LLAMA_CHAIN_TO_ID)) {
  CHAIN_ID_TO_LLAMA[id] = name;
}

/** Protocol quality scores (same as PROTOCOL_REGISTRY.scoreBonus in evmLpService) */
const PROTOCOL_SCORE: Record<string, { label: string; bonus: number }> = {
  'uniswap-v3':         { label: 'Uniswap V3',     bonus: 10 },
  'pancakeswap-amm-v3': { label: 'PancakeSwap V3',  bonus: 8 },
  'aerodrome-v2':       { label: 'Aerodrome CL',    bonus: 7 },
  'sushiswap-v3':       { label: 'SushiSwap V3',    bonus: 6 },
};

// Minimum thresholds for pool inclusion
const MIN_TVL_USD = 250_000;
const MIN_APR_7D = 5;             // 5% minimum 7d APR
const MIN_VOLUME_1D_USD = 50_000; // $50k daily volume minimum

// Cache TTL: 4 hours 
const CACHE_TTL_MS = (Number(process.env.CFO_EVM_LP_DISCOVERY_TTL_HOURS) || 4) * 3600_000;

// ============================================================================
// Types
// ============================================================================

/** Token info from DeFiLlama pool data */
export interface EvmPoolToken {
  address: string;
  symbol: string;
  decimals: number;
}

/** Risk tier classification */
export type LpRiskTier = 'low' | 'medium' | 'high';

/** A fully enriched EVM LP pool candidate from DeFiLlama */
export interface EvmPoolCandidate {
  // Identity
  chainId: number;
  chainName: string;
  poolAddress: string;        // on-chain pool address (from DeFiLlama underlyingTokens or pool field)
  llamaPoolId: string;        // DeFiLlama UUID
  pair: string;               // e.g. "WETH/USDC"

  // Token metadata
  token0: EvmPoolToken;
  token1: EvmPoolToken;

  // Pool characteristics
  protocol: { name: string; llamaProject: string };
  feeTier: number;

  // DeFiLlama metrics
  tvlUsd: number;
  apr7d: number;              // 7-day average fee APR (annualized, as %)
  apr24h: number;             // 24-hour fee APR (%)
  apr30d: number;             // 30-day mean APR (%)
  volumeUsd1d: number;
  volumeUsd7d: number;
  stablecoin: boolean;
  ilRisk: boolean;            // DeFiLlama IL risk flag

  // Statistical / ML
  mu: number;                 // DeFiLlama mean return
  sigma: number;              // DeFiLlama volatility
  predictedClass: string;     // "Stable/Up" | "Down"
  predictedProb: number;      // confidence 0-100

  // Composite score
  score: number;
  scoreBreakdown: Record<string, number>;
  reasoning: string[];

  // Risk classification
  riskTier: LpRiskTier;
}

/** Result of pool selection for decisionEngine */
export interface EvmPoolSelection {
  pool: EvmPoolCandidate;
  score: number;
  reasoning: string;
  alternativesConsidered: number;
}

// ============================================================================
// Cache
// ============================================================================

let _cachedPools: EvmPoolCandidate[] = [];
let _cacheTimestamp = 0;

// ============================================================================
// Pool Discovery
// ============================================================================

/**
 * Discover and score EVM LP pools from DeFiLlama yields API.
 * Returns a scored, sorted list of pool candidates.
 * Results cached for CACHE_TTL_MS (4 hours).
 */
export async function discoverEvmPools(forceRefresh = false): Promise<EvmPoolCandidate[]> {
  if (!forceRefresh && _cachedPools.length > 0 && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedPools;
  }

  const env = getCFOEnv();
  if (!env.evmLpEnabled) return _cachedPools;

  logger.info('[EvmPoolDiscovery] Refreshing pool list from DeFiLlama…');

  try {
    const resp = await fetch(DEFILLAMA_YIELDS_URL, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`DeFiLlama yields API: ${resp.status}`);

    const data = await resp.json() as { status: string; data: any[] };
    if (!Array.isArray(data?.data)) throw new Error('DeFiLlama: unexpected response shape');

    // Determine which chains have configured RPC URLs
    const configuredChainIds = new Set(Object.keys(env.evmRpcUrls).map(Number));

    // Filter to supported projects + chains with RPC configured
    const evmPools = data.data.filter((p: any) => {
      if (!SUPPORTED_PROJECTS.has(p.project)) return false;
      const chainId = LLAMA_CHAIN_TO_ID[p.chain];
      if (!chainId || !configuredChainIds.has(chainId)) return false;
      if ((p.tvlUsd ?? 0) < MIN_TVL_USD) return false;
      if ((p.volumeUsd1d ?? 0) < MIN_VOLUME_1D_USD) return false;
      if (!Array.isArray(p.underlyingTokens) || p.underlyingTokens.length < 2) return false;
      return true;
    });

    const totalMatching = data.data.filter(
      (p: any) => SUPPORTED_PROJECTS.has(p.project) && LLAMA_CHAIN_TO_ID[p.chain],
    ).length;
    logger.info(`[EvmPoolDiscovery] DeFiLlama: ${evmPools.length} pools pass filters (of ${totalMatching} total CL pools)`);

    // Build candidates
    const candidates: EvmPoolCandidate[] = [];

    for (const llama of evmPools) {
      const chainId = LLAMA_CHAIN_TO_ID[llama.chain];
      if (!chainId) continue;
      const chainName = llama.chain.toLowerCase();

      // Parse APR/APY — DeFiLlama returns as fraction (0.15 = 15%), convert to %
      const apr7d = (llama.apyBase7d ?? llama.apyBase ?? 0) * 100;
      const apr24h = (llama.apyBase ?? 0) * 100;
      const apr30d = (llama.apyMean30d ?? 0) * 100;

      // Min APR filter
      if (apr7d < MIN_APR_7D) continue;

      // Parse pool address from DeFiLlama
      // DeFiLlama 'pool' field is a UUID, but for EVM pools it often contains
      // the on-chain address embedded or in underlyingTokens
      const poolAddress = extractPoolAddress(llama);

      // Parse fee tier from symbol or pool metadata
      const feeTier = parseFeeTier(llama);

      // Token metadata — DeFiLlama provides underlyingTokens addresses
      const token0Addr = llama.underlyingTokens[0] ?? '';
      const token1Addr = llama.underlyingTokens[1] ?? '';
      const symbolParts = (llama.symbol ?? '').split('-');
      const sym0 = symbolParts[0] ?? token0Addr.slice(0, 8);
      const sym1 = symbolParts[1] ?? token1Addr.slice(0, 8);

      const pred = llama.predictions;

      candidates.push({
        chainId,
        chainName,
        poolAddress,
        llamaPoolId: llama.pool,
        pair: `${sym0}/${sym1}`,
        token0: { address: token0Addr, symbol: sym0, decimals: 18 }, // decimals resolved on-chain during execution
        token1: { address: token1Addr, symbol: sym1, decimals: 18 },
        protocol: {
          name: PROTOCOL_SCORE[llama.project]?.label ?? llama.project,
          llamaProject: llama.project,
        },
        feeTier,
        tvlUsd: llama.tvlUsd ?? 0,
        apr7d,
        apr24h,
        apr30d,
        volumeUsd1d: llama.volumeUsd1d ?? 0,
        volumeUsd7d: llama.volumeUsd7d ?? 0,
        stablecoin: llama.stablecoin ?? false,
        ilRisk: llama.ilRisk === 'yes',
        mu: llama.mu ?? 0,
        sigma: llama.sigma ?? 0,
        predictedClass: pred?.predictedClass ?? 'Unknown',
        predictedProb: pred?.predictedProbability ?? 50,
        score: 0,
        scoreBreakdown: {},
        reasoning: [],
        riskTier: 'medium',
      });
    }

    // Score all candidates (pass learned best pairs for bonus)
    let lpBestPairs: string[] = [];
    try {
      const { getAdaptiveParams } = await import('./learningEngine.ts');
      lpBestPairs = getAdaptiveParams().lpBestPairs ?? [];
    } catch { /* learning engine may not be initialized */ }

    for (const c of candidates) scoreEvmPool(c, lpBestPairs);

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    _cachedPools = candidates;
    _cacheTimestamp = Date.now();

    // Log top 10 + tier counts
    const tierCounts = { low: 0, medium: 0, high: 0 };
    for (const c of candidates) tierCounts[c.riskTier]++;
    const top10 = candidates.slice(0, 10).map((c, i) =>
      `${i + 1}. [${c.riskTier.toUpperCase()}] ${c.pair} (${c.chainName}) score=${c.score.toFixed(0)} APR7d=${c.apr7d.toFixed(1)}% TVL=$${(c.tvlUsd / 1e6).toFixed(1)}M pred=${c.predictedClass}`,
    ).join('\n');
    logger.info(
      `[EvmPoolDiscovery] ${candidates.length} pools scored (low:${tierCounts.low} med:${tierCounts.medium} high:${tierCounts.high}). Top 10:\n${top10}`,
    );

    return candidates;

  } catch (err) {
    logger.warn('[EvmPoolDiscovery] Pool refresh failed, using cached list:', err);
    return _cachedPools;
  }
}

// ============================================================================
// Pool Scoring — Multi-Factor Analysis
// ============================================================================

/**
 * Score an EVM pool using multi-factor analysis.
 * Uses DeFiLlama ML signals.
 *
 * Factors (total ~100 points):
 *   1. APR 7d (40pts):             primary income signal
 *   2. TVL Depth (25pts):          stability / slippage resistance
 *   3. Volume Consistency (20pts): trading activity + APR sustainability
 *   4. Protocol Quality (10pts):   DEX reputation + audit track record
 *   5. Range Safety (5pts):        stablecoin pairs = minimal IL
 *
 * ML & statistical bonuses (up to +25pts):
 *   - ML prediction (Stable/Up with high confidence: +15)
 *   - APR consistency (30d vs 7d alignment: +5)
 *   - Volatility risk (low sigma: +5)
 *   - Learning bonus (historically profitable pair: +5)
 */
function scoreEvmPool(pool: EvmPoolCandidate, lpBestPairs: string[] = []): void {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];

  // ── 1. APR 7d (0-40 pts) ──────────────────────────────────────────
  const apr = Math.min(pool.apr7d, 200); // cap at 200%
  if (apr >= 100)     { breakdown.apr7d = 40; reasons.push(`very high APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 50) { breakdown.apr7d = 33; reasons.push(`high APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 25) { breakdown.apr7d = 25; reasons.push(`good APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 15) { breakdown.apr7d = 18; }
  else if (apr >= 10) { breakdown.apr7d = 12; }
  else if (apr >= 5)  { breakdown.apr7d = 6; }
  else                { breakdown.apr7d = 0; }

  // APR consistency — 30d mean close to 7d = sustainable income
  if (pool.apr30d > 0 && pool.apr7d > 0) {
    const ratio = pool.apr7d / pool.apr30d;
    if (ratio >= 0.7 && ratio <= 1.5) {
      breakdown.apr7d += 5;
      reasons.push('consistent APR');
    } else if (ratio > 2.5) {
      breakdown.apr7d -= 3;
      reasons.push('recent APR spike — may be unsustainable');
    }
  }
  breakdown.apr7d = Math.max(0, Math.min(45, breakdown.apr7d)); // clamp

  // ── 2. TVL Depth (0-25 pts) ───────────────────────────────────────
  const tvl = pool.tvlUsd;
  if (tvl >= 10e6)         { breakdown.tvl = 25; reasons.push(`deep TVL $${(tvl / 1e6).toFixed(1)}M`); }
  else if (tvl >= 5e6)     { breakdown.tvl = 20; }
  else if (tvl >= 2e6)     { breakdown.tvl = 17; }
  else if (tvl >= 1e6)     { breakdown.tvl = 15; }
  else if (tvl >= 500_000) { breakdown.tvl = 10; }
  else                     { breakdown.tvl = 5; }

  // ── 3. Volume Consistency (0-20 pts) ──────────────────────────────
  // Compare 24h APR vs 7d APR — penalise spike-and-die pools
  if (pool.apr7d > 0 && pool.apr24h > 0) {
    const ratio = pool.apr24h / pool.apr7d;
    if (ratio >= 0.6 && ratio <= 1.6) {
      breakdown.consistency = 20;
      reasons.push('consistent volume');
    } else if (ratio >= 0.3 && ratio <= 2.5) {
      breakdown.consistency = 12;
    } else if (ratio > 2.5) {
      breakdown.consistency = 5;
      reasons.push('volume spike — may be unsustainable');
    } else {
      breakdown.consistency = 5;
      reasons.push('declining volume');
    }
  } else {
    breakdown.consistency = 10; // insufficient data
  }

  // Volume/TVL ratio bonus
  const volTvlRatio = tvl > 0 ? pool.volumeUsd1d / tvl : 0;
  if (volTvlRatio >= 3) {
    breakdown.consistency = Math.min(20, (breakdown.consistency ?? 0) + 5);
    reasons.push(`intensely traded ${volTvlRatio.toFixed(1)}x TVL/day`);
  }

  // ── 4. Protocol Quality (0-10 pts) ────────────────────────────────
  const protoInfo = PROTOCOL_SCORE[pool.protocol.llamaProject];
  breakdown.protocol = protoInfo?.bonus ?? 5;
  reasons.push(protoInfo?.label ?? pool.protocol.name);

  // ── 5. Range Safety / IL Risk (0-5 pts) ───────────────────────────
  const sym0 = pool.token0.symbol.toUpperCase();
  const sym1 = pool.token1.symbol.toUpperCase();
  const is0Stable = isStablecoin(sym0);
  const is1Stable = isStablecoin(sym1);

  if (is0Stable && is1Stable) {
    breakdown.range = 5;
    reasons.push('stablecoin pair, minimal IL');
  } else if (is0Stable || is1Stable) {
    breakdown.range = 3;
    reasons.push('one volatile side');
  } else {
    breakdown.range = 1;
    reasons.push('volatile pair, higher IL but higher APR');
  }

  // ── ML Prediction bonus (0-15 pts) ────────────────────────────────
  if (pool.predictedClass === 'Stable/Up') {
    if (pool.predictedProb >= 70) {
      breakdown.mlPrediction = 15;
      reasons.push(`ML: Stable/Up (${pool.predictedProb}%)`);
    } else if (pool.predictedProb >= 55) {
      breakdown.mlPrediction = 10;
    } else {
      breakdown.mlPrediction = 7;
    }
  } else if (pool.predictedClass === 'Down') {
    if (pool.predictedProb >= 80) {
      breakdown.mlPrediction = 0;
      reasons.push(`ML: Down (${pool.predictedProb}%) — APR declining`);
    } else if (pool.predictedProb >= 60) {
      breakdown.mlPrediction = 3;
    } else {
      breakdown.mlPrediction = 5;
    }
  } else {
    breakdown.mlPrediction = 7; // unknown
  }

  // ── Volatility Risk bonus (0-5 pts) ───────────────────────────────
  const sigma = pool.sigma ?? 0;
  if (sigma <= 0.05)      { breakdown.volatilityRisk = 5; reasons.push('very stable'); }
  else if (sigma <= 0.15) { breakdown.volatilityRisk = 4; }
  else if (sigma <= 0.5)  { breakdown.volatilityRisk = 3; }
  else if (sigma <= 1.0)  { breakdown.volatilityRisk = 1; }
  else                    { breakdown.volatilityRisk = 0; reasons.push('high APR volatility'); }

  // ── Compute base score ────────────────────────────────────────────
  pool.score = Object.values(breakdown).reduce((s, v) => s + v, 0);

  // ── Learning bonus — historically profitable pairs get a boost ────
  if (lpBestPairs.length > 0) {
    const pairKey = `${sym0}/${sym1}`;
    const pairKeyReverse = `${sym1}/${sym0}`;
    if (lpBestPairs.includes(pairKey) || lpBestPairs.includes(pairKeyReverse)) {
      breakdown.learning = 5;
      pool.score += 5;
      reasons.push('historically profitable pair');
    }
  }

  pool.scoreBreakdown = breakdown;
  pool.reasoning = reasons;
  pool.riskTier = classifyEvmPoolRisk(pool);
}

/**
 * Classify EVM pool risk using DeFiLlama structural fields + score signals.
 *
 * LOW    = both tokens price-stable (stablecoin pair, range=5), OR
 *          one stable side with deep TVL (>=20), consistent APR (>=12), reputable protocol (>=8)
 * HIGH   = both volatile with thin TVL (<=10) or spiked APR (<=5),
 *          OR sigma > 1.0 (boom-bust), OR ML strongly predicts APR decline
 * MEDIUM = everything else
 */
function classifyEvmPoolRisk(pool: EvmPoolCandidate): LpRiskTier {
  const range = pool.scoreBreakdown.range       ?? 1;
  const cons  = pool.scoreBreakdown.consistency ?? 0;
  const tvl   = pool.scoreBreakdown.tvl         ?? 0;
  const prot  = pool.scoreBreakdown.protocol    ?? 0;
  const sigma = pool.sigma ?? 0;

  // Boom-bust fee cycles
  if (sigma > 1.0) return 'high';

  // ML strongly predicts APR decline
  if (pool.predictedClass === 'Down' && pool.predictedProb >= 70) return 'high';

  // Both tokens price-stable
  if (range === 5) return 'low';

  // One stable side, well-cushioned
  if (range === 3 && tvl >= 20 && cons >= 12 && prot >= 8) return 'low';

  // Both volatile with thin TVL
  if (range === 1 && tvl <= 10) return 'high';

  // Both volatile with spiked/collapsing APR
  if (range === 1 && cons <= 5) return 'high';

  return 'medium';
}

// ============================================================================
// Smart Pool Selection (for decisionEngine)
// ============================================================================

/**
 * Select the best EVM pool for LP deployment, considering:
 *  - Pool scores from multi-factor analysis
 *  - Market condition (bearish → prefer stablecoins)
 *  - Risk tier filtering
 *  - Chain-specific constraints (which chains have RPC configured)
 */
export async function selectBestEvmPool(opts: {
  marketCondition: string;
  analystPrices?: Record<string, { usd: number; change24h: number }>;
  analystTrending?: string[];
  maxResults?: number;
  evmLpRiskTiers?: Set<string>;
  preferredChainIds?: number[];
}): Promise<EvmPoolSelection | null> {
  const pools = await discoverEvmPools();
  if (pools.length === 0) {
    logger.warn('[EvmPoolDiscovery] No pools available for selection');
    return null;
  }

  const allowedTiers = opts.evmLpRiskTiers;
  let filtered = (allowedTiers && allowedTiers.size > 0 && allowedTiers.size < 3)
    ? pools.filter(p => allowedTiers.has(p.riskTier))
    : pools;

  // Chain filter
  if (opts.preferredChainIds?.length) {
    const chainSet = new Set(opts.preferredChainIds);
    const chainFiltered = filtered.filter(p => chainSet.has(p.chainId));
    if (chainFiltered.length > 0) filtered = chainFiltered;
    // If no pools on preferred chains, fall back to all chains
  }

  if (filtered.length === 0) {
    logger.warn('[EvmPoolDiscovery] No pools match risk tier / chain filters');
    return null;
  }

  // Apply market condition adjustments
  const scored = filtered.map(p => {
    let adjustedScore = p.score;
    const adjustReasons = [...p.reasoning];

    // Market condition modifiers
    if (opts.marketCondition === 'bearish' || opts.marketCondition === 'danger') {
      if (p.stablecoin) {
        adjustedScore += 15;
        adjustReasons.push('stablecoin safe haven');
      } else if (p.ilRisk) {
        adjustedScore -= 20;
        adjustReasons.push('IL risk in bearish market');
      }
    } else if (opts.marketCondition === 'bullish') {
      if (p.ilRisk && !p.stablecoin) {
        adjustedScore += 5;
      }
    }

    // Analyst price intel adjustments
    if (opts.analystPrices) {
      const tokenA = p.token0.symbol.toUpperCase();
      if (!isStablecoin(tokenA)) {
        const priceData = opts.analystPrices[tokenA];
        if (priceData) {
          const change = priceData.change24h;
          if (change > 10) {
            adjustedScore += 10;
            adjustReasons.push(`${tokenA} +${change.toFixed(0)}% 24h`);
          } else if (change > 5) {
            adjustedScore += 5;
          } else if (change < -15) {
            adjustedScore -= 15;
            adjustReasons.push(`${tokenA} ${change.toFixed(0)}% crash`);
          } else if (change < -10) {
            adjustedScore -= 8;
          }
        }
      }
    }

    // Trending token bonus
    if (opts.analystTrending?.length) {
      const tokenA = p.token0.symbol.toUpperCase();
      if (opts.analystTrending.includes(tokenA)) {
        adjustedScore += 8;
        adjustReasons.push(`${tokenA} trending`);
      }
    }

    return {
      ...p,
      score: adjustedScore,
      reasoning: adjustReasons,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 20) {
    logger.warn(`[EvmPoolDiscovery] Best pool score too low: ${best?.pair} = ${best?.score}`);
    return null;
  }

  return {
    pool: best,
    score: best.score,
    reasoning: best.reasoning.slice(0, 6).join(', '),
    alternativesConsidered: scored.length,
  };
}

// ============================================================================
// Cache Accessors
// ============================================================================

/** Get the cached pool list without triggering a refresh. */
export function getCachedEvmPools(): EvmPoolCandidate[] {
  return _cachedPools;
}

/** Get cache age in milliseconds. */
export function getEvmPoolCacheAge(): number {
  return _cacheTimestamp > 0 ? Date.now() - _cacheTimestamp : Infinity;
}

/** Get a pool candidate by pool address (for rebalance operations). */
export async function getEvmPoolByAddress(
  chainId: number,
  poolAddress: string,
): Promise<EvmPoolCandidate | null> {
  const pools = await discoverEvmPools();
  return pools.find(
    p => p.chainId === chainId && p.poolAddress.toLowerCase() === poolAddress.toLowerCase(),
  ) ?? null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract pool address from DeFiLlama pool record.
 * DeFiLlama's `pool` field is a UUID for most chains, but the actual
 * on-chain pool address is often extractable from the UUID or stored
 * in pool metadata.
 */
function extractPoolAddress(llama: any): string {
  // DeFiLlama pool field format for EVM: often "{address}-{chain}" or just UUID
  const poolField = String(llama.pool ?? '');

  // If pool field starts with 0x and has right length, it's the address
  if (/^0x[a-fA-F0-9]{40}/i.test(poolField)) {
    return poolField.slice(0, 42);
  }

  // Some DeFiLlama records include the address in the pool UUID pattern
  const hexMatch = poolField.match(/^([a-fA-F0-9]{40})/);
  if (hexMatch) {
    return '0x' + hexMatch[1];
  }

  // Fallback: use the pool UUID as-is (will need factory lookup during execution)
  return poolField;
}

/** Parse fee tier from DeFiLlama pool symbol or metadata */
function parseFeeTier(llama: any): number {
  // DeFiLlama symbol format: "TOKEN0-TOKEN1 0.3%" or "TOKEN0-TOKEN1"
  const symbol = String(llama.symbol ?? '');
  const feeMatch = symbol.match(/([\d.]+)%/);
  if (feeMatch) {
    const pct = parseFloat(feeMatch[1]);
    // Convert percent to Uniswap V3 fee units (0.3% = 3000)
    return Math.round(pct * 10_000);
  }

  // Default fee tiers by protocol
  if (llama.project === 'uniswap-v3' || llama.project === 'sushiswap-v3') return 3000;   // 0.3%
  if (llama.project === 'pancakeswap-amm-v3') return 2500;                               // 0.25%
  if (llama.project === 'aerodrome-v2') return 3000;                                     // varies

  return 3000; // safe default
}
