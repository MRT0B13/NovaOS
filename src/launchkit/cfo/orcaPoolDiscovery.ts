/**
 * Dynamic Orca Pool Discovery Service
 *
 * Replaces the hardcoded ORCA_WHIRLPOOLS map with a live registry that:
 *   1. Fetches DeFiLlama yields API for APY, TVL, volume, ML predictions
 *   2. Fetches Orca whirlpool API for on-chain addresses + token metadata
 *   3. Cross-references by matching underlying token mint addresses
 *   4. Scores and ranks pools using multi-factor analysis
 *   5. Caches results with a 2-hour TTL
 *
 * Data Sources:
 *   DeFiLlama: https://yields.llama.fi/pools  (project=orca-dex, chain=Solana)
 *   Orca:      https://api.mainnet.orca.so/v1/whirlpool/list
 *
 * Key insight: DeFiLlama `pool` field is a UUID, NOT an on-chain address.
 * We match pools by comparing DeFiLlama `underlyingTokens` mints against
 * Orca API `tokenA.mint` + `tokenB.mint` to recover the on-chain whirlpool address.
 */

import { logger } from '@elizaos/core';

// ============================================================================
// Constants
// ============================================================================

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';
const ORCA_WHIRLPOOL_LIST_URL = 'https://api.mainnet.orca.so/v1/whirlpool/list';

// Well-known Solana token mints
const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'JLP',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'WHETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'cbBTC',
  // Stablecoins
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
  CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: 'CASH',
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': 'USDG',
  AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: 'SYRUPUSDC',
  '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG': 'USX',
  A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6: 'USDY',
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: 'USDS',
  Fk6X3MCChFTzF7FvNhG8KRr6YqTdABQb9ArtYASTvVwj: 'FDUSD',
  // Memecoins & trending
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
  CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu: 'CLOUD',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiMQ': 'RENDER',
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'RNDR',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
  KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP: 'PENGU',
  KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS: 'KMNO',
};

// Minimum thresholds for pool inclusion
const MIN_TVL_USD = 200_000;          // $200k TVL minimum — filters dead or micro pools
const MIN_VOLUME_1D_USD = 50_000;     // $50k daily volume minimum — needs real activity
const MIN_APY_BASE_7D = 0.5;         // 0.5% minimum 7d APY — must generate some fees

// Which tokens we're willing to LP with
const APPROVED_QUOTE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'So11111111111111111111111111111111111111112',     // SOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);

// Prefer tick spacings that correspond to reasonable fee tiers
const PREFERRED_TICK_SPACINGS = new Set([
  1,    // 0.01% fee — stablecoin pairs
  2,    // 0.02% fee
  4,    // 0.04% fee — tight spread
  8,    // 0.08% fee
  16,   // 0.16% fee
  64,   // 0.3% fee — standard
  128,  // 1% fee — volatile pairs
  256,  // 2% fee — very volatile
]);

// Cache TTL: 2 hours
const CACHE_TTL_MS = 2 * 3600_000;

// ============================================================================
// Types
// ============================================================================

/** A DeFiLlama pool record (relevant fields only) */
interface LlamaPool {
  pool: string;               // UUID — NOT an on-chain address
  symbol: string;             // e.g. "SOL-USDC"
  tvlUsd: number;
  apyBase: number | null;     // 24h fee APY (annualized)
  apyBase7d: number | null;   // 7-day average fee APY
  apyMean30d: number | null;  // 30-day mean APY
  apyReward: number;          // reward token APY (farming incentives)
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
  underlyingTokens: string[];
  stablecoin: boolean;
  ilRisk: string;             // "yes" | "no"
  exposure: string;           // "multi" | "single"
  mu: number | null;          // mean return statistic
  sigma: number | null;       // volatility statistic
  predictions: {
    predictedClass: string;        // "Stable/Up" | "Down"
    predictedProbability: number;  // 0-100
    binnedConfidence: number;      // 1-3
  } | null;
}

/** An Orca whirlpool record from their API */
interface OrcaWhirlpool {
  address: string;            // on-chain whirlpool address
  tokenA: { mint: string; symbol: string; decimals: number };
  tokenB: { mint: string; symbol: string; decimals: number };
  tickSpacing: number;
  price: number;              // current price of tokenA in tokenB
  lpFeeRate: number;          // e.g. 0.0004 = 0.04%
}

/** A fully enriched pool candidate — merged from DeFiLlama + Orca API */
export interface OrcaPoolCandidate {
  // Identity
  whirlpoolAddress: string;   // on-chain address (from Orca API)
  llamaPoolId: string;        // DeFiLlama UUID
  pair: string;               // e.g. "SOL/USDC"

  // Token metadata (from Orca API — authoritative)
  tokenA: { mint: string; symbol: string; decimals: number };
  tokenB: { mint: string; symbol: string; decimals: number };

  // Pool characteristics
  tickSpacing: number;
  lpFeeRate: number;          // annualized fee rate
  currentPrice: number;

  // DeFiLlama metrics
  tvlUsd: number;
  apyBase24h: number;         // 24h fee APY (annualized)
  apyBase7d: number;          // 7-day average fee APY
  apyMean30d: number;         // 30-day mean APY
  apyReward: number;          // farming incentive APY
  volumeUsd1d: number;
  volumeUsd7d: number;
  stablecoin: boolean;
  ilRisk: boolean;            // true = impermanent loss risk

  // Statistical / ML
  mu: number;                 // DeFiLlama mean return
  sigma: number;              // DeFiLlama volatility
  predictedClass: string;     // "Stable/Up" | "Down"
  predictedProb: number;      // confidence 0-100
  predictedConfidence: number; // binned confidence 1-3

  // Composite score (computed by scorePool)
  score: number;
  scoreBreakdown: Record<string, number>;
  reasoning: string[];
}

/** The result of pool selection — what decisionEngine needs */
export interface PoolSelection {
  pool: OrcaPoolCandidate;
  score: number;
  reasoning: string;
  alternativesConsidered: number;
}

// ============================================================================
// Cache
// ============================================================================

let _cachedPools: OrcaPoolCandidate[] = [];
let _cacheTimestamp = 0;

// ============================================================================
// Pool Discovery
// ============================================================================

/**
 * Discover and score the top Orca Solana LP pools.
 * Returns a scored, sorted list of pool candidates.
 * Results are cached for CACHE_TTL_MS (2 hours).
 */
export async function discoverOrcaPools(forceRefresh = false): Promise<OrcaPoolCandidate[]> {
  if (!forceRefresh && _cachedPools.length > 0 && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedPools;
  }

  logger.info('[OrcaDiscovery] Refreshing dynamic pool list…');

  try {
    // ── Parallel fetch from both APIs ─────────────────────────────────
    const [llamaResp, orcaResp] = await Promise.all([
      fetchWithTimeout(DEFILLAMA_YIELDS_URL, 15_000),
      fetchWithTimeout(ORCA_WHIRLPOOL_LIST_URL, 30_000), // 18MB response, needs time
    ]);

    if (!llamaResp.ok) throw new Error(`DeFiLlama: ${llamaResp.status}`);
    if (!orcaResp.ok) throw new Error(`Orca API: ${orcaResp.status}`);

    const llamaData = await llamaResp.json() as { status: string; data: LlamaPool[] };
    const orcaData = await orcaResp.json() as { whirlpools: OrcaWhirlpool[] };

    // ── Filter DeFiLlama pools ────────────────────────────────────────
    const orcaPools = llamaData.data.filter((p: any) =>
      p.chain === 'Solana' &&
      p.project === 'orca-dex' &&
      (p.tvlUsd ?? 0) >= MIN_TVL_USD &&
      (p.volumeUsd1d ?? 0) >= MIN_VOLUME_1D_USD &&
      Array.isArray(p.underlyingTokens) &&
      p.underlyingTokens.length === 2 &&
      // At least one side must be an approved quote token (USDC, SOL, USDT)
      p.underlyingTokens.some((m: string) => APPROVED_QUOTE_MINTS.has(m))
    );

    logger.info(`[OrcaDiscovery] DeFiLlama: ${orcaPools.length} Orca pools pass filters (of ${llamaData.data.filter((p: any) => p.project === 'orca-dex' && p.chain === 'Solana').length} total)`);

    // ── Build Orca lookup index: mint pair → whirlpool(s) ────────────
    // Key = sorted mint addresses joined with '_', value = array of whirlpools for that pair
    const orcaIndex = new Map<string, OrcaWhirlpool[]>();
    for (const wp of orcaData.whirlpools) {
      if (!wp.tokenA?.mint || !wp.tokenB?.mint) continue;
      const key = makeMintPairKey(wp.tokenA.mint, wp.tokenB.mint);
      const existing = orcaIndex.get(key) ?? [];
      existing.push(wp);
      orcaIndex.set(key, existing);
    }

    logger.info(`[OrcaDiscovery] Orca API: ${orcaData.whirlpools.length} whirlpools indexed into ${orcaIndex.size} unique pairs`);

    // ── Cross-reference: match DeFiLlama pools with Orca whirlpools ──
    const candidates: OrcaPoolCandidate[] = [];

    for (const llama of orcaPools) {
      const mintKey = makeMintPairKey(llama.underlyingTokens[0], llama.underlyingTokens[1]);
      const matchingWhirlpools = orcaIndex.get(mintKey);
      if (!matchingWhirlpools || matchingWhirlpools.length === 0) continue;

      // Pick the best whirlpool for this pair:
      // - Prefer tick spacings in our preferred set
      // - Among those, pick the one with the highest fee rate (more revenue)
      const ranked = matchingWhirlpools
        .filter(wp => PREFERRED_TICK_SPACINGS.has(wp.tickSpacing))
        .sort((a, b) => {
          // Prefer the tick spacing that best matches the APY we're seeing
          // Higher fee rate = more revenue per trade, but also wider spread = less volume
          // Use a heuristic: for volatile pairs, prefer higher fee tiers; for stable, lower
          const isStable = llama.stablecoin;
          if (isStable) {
            return a.tickSpacing - b.tickSpacing; // prefer tightest for stables
          }
          return b.lpFeeRate - a.lpFeeRate; // prefer highest fee for volatile
        });

      const bestWp = ranked[0] ?? matchingWhirlpools[0]; // fallback to any if no preferred tick spacing
      if (!bestWp) continue;

      const symbolA = resolveSymbol(bestWp.tokenA.mint, bestWp.tokenA.symbol);
      const symbolB = resolveSymbol(bestWp.tokenB.mint, bestWp.tokenB.symbol);
      const pair = `${symbolA}/${symbolB}`;

      const pred = llama.predictions;
      const apyBase7d = (llama.apyBase7d ?? llama.apyBase ?? 0) * 100; // convert to percentage

      candidates.push({
        whirlpoolAddress: bestWp.address,
        llamaPoolId: llama.pool,
        pair,
        tokenA: { mint: bestWp.tokenA.mint, symbol: symbolA, decimals: bestWp.tokenA.decimals },
        tokenB: { mint: bestWp.tokenB.mint, symbol: symbolB, decimals: bestWp.tokenB.decimals },
        tickSpacing: bestWp.tickSpacing,
        lpFeeRate: bestWp.lpFeeRate,
        currentPrice: bestWp.price,
        tvlUsd: llama.tvlUsd,
        apyBase24h: (llama.apyBase ?? 0) * 100,
        apyBase7d,
        apyMean30d: (llama.apyMean30d ?? 0) * 100,
        apyReward: (llama.apyReward ?? 0) * 100,
        volumeUsd1d: llama.volumeUsd1d ?? 0,
        volumeUsd7d: llama.volumeUsd7d ?? 0,
        stablecoin: llama.stablecoin ?? false,
        ilRisk: llama.ilRisk === 'yes',
        mu: llama.mu ?? 0,
        sigma: llama.sigma ?? 0,
        predictedClass: pred?.predictedClass ?? 'Unknown',
        predictedProb: pred?.predictedProbability ?? 50,
        predictedConfidence: pred?.binnedConfidence ?? 1,
        score: 0,
        scoreBreakdown: {},
        reasoning: [],
      });
    }

    logger.info(`[OrcaDiscovery] Cross-referenced: ${candidates.length} enriched pool candidates`);

    // Score all candidates
    for (const candidate of candidates) {
      scorePool(candidate);
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    _cachedPools = candidates;
    _cacheTimestamp = Date.now();

    // Log top 10 for observability
    const top10 = candidates.slice(0, 10).map((c, i) =>
      `${i + 1}. ${c.pair} score=${c.score.toFixed(0)} APY7d=${c.apyBase7d.toFixed(1)}% TVL=$${(c.tvlUsd / 1e6).toFixed(1)}M vol=$${(c.volumeUsd1d / 1e6).toFixed(1)}M pred=${c.predictedClass}`
    ).join('\n');
    logger.info(`[OrcaDiscovery] Top 10 pools:\n${top10}`);

    return candidates;

  } catch (err) {
    logger.warn('[OrcaDiscovery] Pool refresh failed, using cached list:', err);
    return _cachedPools;
  }
}

// ============================================================================
// Pool Scoring — Multi-Factor Analysis
// ============================================================================

/**
 * Score a pool candidate using multi-factor analysis.
 * Mutates the candidate's score, scoreBreakdown, and reasoning fields.
 *
 * Factors (total 100 points):
 *   1. Fee Revenue (30pts): 7-day APY — the actual income for LPs
 *   2. Volume Consistency (20pts): volume trend + daily volume vs TVL
 *   3. TVL Depth (15pts): deeper pools = less IL, more reliable APY
 *   4. ML Prediction (15pts): DeFiLlama's ML yield prediction
 *   5. Volatility Risk (10pts): sigma — lower = more predictable
 *   6. Stablecoin / IL Safety (10pts): stablecoin pairs = minimal IL
 */
function scorePool(pool: OrcaPoolCandidate): void {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];

  // ── 1. Fee Revenue (0-30 pts) ─────────────────────────────────────
  // Use 7-day APY as the primary signal (smooths out daily spikes).
  // Cap at reasonable levels to avoid rewarding unsustainable spikes.
  const apy7d = Math.min(pool.apyBase7d, 500); // cap at 500% — beyond this is noise
  if (apy7d >= 100) {
    breakdown.feeRevenue = 30;
    reasons.push(`very high APY ${pool.apyBase7d.toFixed(0)}%`);
  } else if (apy7d >= 50) {
    breakdown.feeRevenue = 25;
    reasons.push(`high APY ${pool.apyBase7d.toFixed(0)}%`);
  } else if (apy7d >= 20) {
    breakdown.feeRevenue = 20;
    reasons.push(`good APY ${pool.apyBase7d.toFixed(0)}%`);
  } else if (apy7d >= 10) {
    breakdown.feeRevenue = 15;
    reasons.push(`moderate APY ${pool.apyBase7d.toFixed(0)}%`);
  } else if (apy7d >= 5) {
    breakdown.feeRevenue = 10;
  } else if (apy7d >= MIN_APY_BASE_7D) {
    breakdown.feeRevenue = 5;
  } else {
    breakdown.feeRevenue = 0;
    reasons.push('low APY');
  }

  // Bonus: APY consistency — 30d mean close to 7d mean = sustainable
  if (pool.apyMean30d > 0 && pool.apyBase7d > 0) {
    const ratio = pool.apyBase7d / pool.apyMean30d;
    if (ratio >= 0.7 && ratio <= 1.5) {
      breakdown.feeRevenue += 5; // sustainable — not a temporary spike
      reasons.push('consistent APY');
    } else if (ratio > 2) {
      breakdown.feeRevenue -= 3; // recent spike — may be unsustainable
    }
  }
  breakdown.feeRevenue = Math.max(0, Math.min(35, breakdown.feeRevenue)); // clamp

  // ── 2. Volume Consistency (0-20 pts) ──────────────────────────────
  // Volume/TVL ratio = capital efficiency. Higher = more fee revenue per $ deployed.
  const volTvlRatio = pool.tvlUsd > 0 ? pool.volumeUsd1d / pool.tvlUsd : 0;
  if (volTvlRatio >= 5) {
    breakdown.volumeConsistency = 15;
    reasons.push(`intense trading ${volTvlRatio.toFixed(1)}x TVL/day`);
  } else if (volTvlRatio >= 1) {
    breakdown.volumeConsistency = 12;
    reasons.push(`active trading ${volTvlRatio.toFixed(1)}x TVL/day`);
  } else if (volTvlRatio >= 0.3) {
    breakdown.volumeConsistency = 8;
  } else if (volTvlRatio >= 0.1) {
    breakdown.volumeConsistency = 4;
  } else {
    breakdown.volumeConsistency = 0;
    reasons.push('thin volume');
  }

  // Volume trend: compare 1d volume to 7d daily average
  const avgDaily7d = pool.volumeUsd7d > 0 ? pool.volumeUsd7d / 7 : 0;
  if (avgDaily7d > 0 && pool.volumeUsd1d > 0) {
    const volTrend = pool.volumeUsd1d / avgDaily7d;
    if (volTrend >= 1.5) {
      breakdown.volumeConsistency += 5; // volume growing
      reasons.push(`vol trending up ${volTrend.toFixed(1)}x`);
    } else if (volTrend >= 0.8) {
      breakdown.volumeConsistency += 3; // stable volume
    } else {
      breakdown.volumeConsistency += 0; // declining
    }
  }
  breakdown.volumeConsistency = Math.min(20, breakdown.volumeConsistency);

  // ── 3. TVL Depth (0-15 pts) ───────────────────────────────────────
  // Deeper pools = our LP position has less impact, less IL from large trades
  if (pool.tvlUsd >= 10_000_000) {
    breakdown.tvlDepth = 15;
    reasons.push(`deep $${(pool.tvlUsd / 1e6).toFixed(0)}M TVL`);
  } else if (pool.tvlUsd >= 5_000_000) {
    breakdown.tvlDepth = 12;
  } else if (pool.tvlUsd >= 2_000_000) {
    breakdown.tvlDepth = 10;
  } else if (pool.tvlUsd >= 1_000_000) {
    breakdown.tvlDepth = 7;
  } else if (pool.tvlUsd >= MIN_TVL_USD) {
    breakdown.tvlDepth = 4;
  } else {
    breakdown.tvlDepth = 0;
  }

  // ── 4. ML Prediction (0-15 pts) ───────────────────────────────────
  // DeFiLlama runs ML models predicting whether APY will go up or down.
  // "Stable/Up" with high confidence = good (APY will persist or grow)
  // "Down" = APY likely to fall (less attractive)
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
      reasons.push(`ML: Down (${pool.predictedProb}%) — APY declining`);
    } else if (pool.predictedProb >= 60) {
      breakdown.mlPrediction = 3;
    } else {
      breakdown.mlPrediction = 5; // low confidence down — don't penalize too much
    }
  } else {
    breakdown.mlPrediction = 7; // unknown
  }

  // ── 5. Volatility Risk (0-10 pts) ─────────────────────────────────
  // sigma = APY volatility. High sigma = APY swings wildly = unreliable.
  // For LPs: want stable fee income, not boom-bust cycles.
  const sigma = pool.sigma ?? 0;
  if (sigma <= 0.05) {
    breakdown.volatilityRisk = 10;
    reasons.push('very stable');
  } else if (sigma <= 0.15) {
    breakdown.volatilityRisk = 8;
  } else if (sigma <= 0.5) {
    breakdown.volatilityRisk = 5;
  } else if (sigma <= 1.0) {
    breakdown.volatilityRisk = 3;
  } else {
    breakdown.volatilityRisk = 0;
    reasons.push('high APY volatility');
  }

  // ── 6. Stablecoin / IL Safety (0-10 pts) ──────────────────────────
  // Stablecoin pairs: no IL risk, predictable returns
  // SOL/USDC: moderate IL risk but high volume
  // Alt/USDC: highest IL risk
  if (pool.stablecoin && !pool.ilRisk) {
    breakdown.ilSafety = 10;
    reasons.push('stablecoin pair (no IL)');
  } else if (!pool.ilRisk) {
    breakdown.ilSafety = 8;
  } else {
    // IL risk pools — score based on whether it's a blue chip
    const symbolA = pool.tokenA.symbol.toUpperCase();
    if (['SOL', 'BTC', 'WBTC', 'CBBTC', 'ETH', 'WHETH'].includes(symbolA)) {
      breakdown.ilSafety = 5; // blue chip — manageable IL
    } else if (['BONK', 'WIF', 'JUP', 'PENGU', 'JLP', 'KMNO'].includes(symbolA)) {
      breakdown.ilSafety = 3; // established alts — moderate IL
    } else {
      breakdown.ilSafety = 1; // unknown alts — high IL risk
      reasons.push('unknown token IL risk');
    }
  }

  // ── Compute final score ───────────────────────────────────────────
  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  pool.score = score;
  pool.scoreBreakdown = breakdown;
  pool.reasoning = reasons;
}

// ============================================================================
// Smart Pool Selection (for decisionEngine)
// ============================================================================

/**
 * Select the best pool for LP deployment, considering:
 *  - Pool scores from multi-factor analysis
 *  - Market condition (bearish → prefer stablecoins, bullish → allow volatile)
 *  - Guardian intel (token safety, trending)
 *  - Analyst price intel (24h change, trending tokens)
 *  - Whether the agent has the right tokens
 *
 * @param marketCondition  From SwarmIntel.marketCondition
 * @param guardianTokens   From SwarmIntel.guardianTokens (optional)
 * @param analystPrices    From SwarmIntel.analystPrices (optional)
 * @param analystTrending  From SwarmIntel.analystTrending (optional)
 * @param maxResults       Number of top candidates to consider (default 5)
 */
export async function selectBestPool(opts: {
  marketCondition: string;
  guardianTokens?: Array<{
    mint: string; ticker: string; priceUsd: number;
    liquidityUsd: number; volume24h: number; rugScore: number | null; safe: boolean;
  }>;
  analystPrices?: Record<string, { usd: number; change24h: number }>;
  analystTrending?: string[];
  maxResults?: number;
}): Promise<PoolSelection | null> {
  const pools = await discoverOrcaPools();
  if (pools.length === 0) {
    logger.warn('[OrcaDiscovery] No pools available for selection');
    return null;
  }

  const maxResults = opts.maxResults ?? 5;

  // ── Apply market condition adjustments ──────────────────────────────
  const scored = pools.map(p => {
    let adjustedScore = p.score;
    const adjustReasons: string[] = [...p.reasoning];

    // Market condition modifiers
    if (opts.marketCondition === 'bearish' || opts.marketCondition === 'danger') {
      if (p.stablecoin) {
        adjustedScore += 15; // boost stablecoins in bearish markets
        adjustReasons.push('stablecoin safe haven');
      } else if (p.ilRisk) {
        adjustedScore -= 20; // penalize IL-risky pools in bearish markets
        adjustReasons.push('IL risk in bearish market');
      }
    } else if (opts.marketCondition === 'bullish') {
      if (p.ilRisk && !p.stablecoin) {
        adjustedScore += 5; // slight boost to volatile pairs in bull market (more upside)
      }
    }

    // ── Guardian intel adjustments ─────────────────────────────────────
    if (opts.guardianTokens?.length) {
      const tokenASymbol = p.tokenA.symbol.toUpperCase();
      const tokenBSymbol = p.tokenB.symbol.toUpperCase();

      for (const sym of [tokenASymbol, tokenBSymbol]) {
        if (['USDC', 'USDT', 'SOL'].includes(sym)) continue; // skip known-safe tokens

        const guardian = opts.guardianTokens.find(g => g.ticker === sym);
        if (guardian) {
          if (!guardian.safe) {
            adjustedScore -= 30; // rug risk — heavy penalty
            adjustReasons.push(`${sym} rug risk`);
          } else {
            adjustedScore += 5; // guardian-verified safe
            adjustReasons.push(`${sym} guardian-safe`);
          }

          // Volume confirmation from guardian
          if (guardian.volume24h > 1_000_000) {
            adjustedScore += 5;
          }

          // Liquidity depth from guardian
          if (guardian.liquidityUsd >= 500_000) {
            adjustedScore += 3;
          }
        }
      }
    }

    // ── Analyst price intel adjustments ─────────────────────────────────
    if (opts.analystPrices) {
      const tokenA = p.tokenA.symbol.toUpperCase();
      const priceData = opts.analystPrices[tokenA];
      if (priceData && !['USDC', 'USDT'].includes(tokenA)) {
        const change = priceData.change24h;
        if (change > 10) {
          adjustedScore += 10; // strong uptrend — LP benefits from both fees + appreciation
          adjustReasons.push(`${tokenA} +${change.toFixed(0)}% 24h`);
        } else if (change > 5) {
          adjustedScore += 5;
        } else if (change < -15) {
          adjustedScore -= 15; // crashing — IL risk extreme
          adjustReasons.push(`${tokenA} ${change.toFixed(0)}% crash`);
        } else if (change < -10) {
          adjustedScore -= 8;
        }
      }
    }

    // ── Trending token bonus ───────────────────────────────────────────
    if (opts.analystTrending?.length) {
      const tokenASymbol = p.tokenA.symbol.toUpperCase();
      if (opts.analystTrending.includes(tokenASymbol)) {
        adjustedScore += 8;
        adjustReasons.push(`${tokenASymbol} trending`);
      }
    }

    return {
      ...p,
      score: adjustedScore,
      reasoning: adjustReasons,
    };
  });

  // Sort by adjusted score
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 20) {
    logger.warn(`[OrcaDiscovery] Best pool score too low: ${best?.pair} = ${best?.score}`);
    return null;
  }

  return {
    pool: best,
    score: best.score,
    reasoning: best.reasoning.slice(0, 6).join(', '), // top 6 reasons
    alternativesConsidered: scored.length,
  };
}

/**
 * Get a pool candidate by whirlpool address (for rebalance operations).
 * Returns null if the pool is not in the discovered set.
 */
export async function getPoolByAddress(whirlpoolAddress: string): Promise<OrcaPoolCandidate | null> {
  const pools = await discoverOrcaPools();
  return pools.find(p => p.whirlpoolAddress === whirlpoolAddress) ?? null;
}

/**
 * Get the SOL/USDC pool as a fallback (always available).
 * Uses the highest-TVL SOL/USDC whirlpool from discovery, or a hardcoded fallback.
 */
export async function getSolUsdcFallback(): Promise<OrcaPoolCandidate | null> {
  const pools = await discoverOrcaPools();
  const solUsdc = pools.find(p =>
    p.tokenA.symbol === 'SOL' && p.tokenB.symbol === 'USDC'
  );
  return solUsdc ?? null;
}

/**
 * Get the cached pool list without triggering a refresh.
 * Useful for display/reporting where we don't want to block on API calls.
 */
export function getCachedPools(): OrcaPoolCandidate[] {
  return _cachedPools;
}

/**
 * Get pool age (time since last refresh) in milliseconds.
 */
export function getPoolCacheAge(): number {
  return _cacheTimestamp > 0 ? Date.now() - _cacheTimestamp : Infinity;
}

// ============================================================================
// Helpers
// ============================================================================

/** Create a canonical key from two mint addresses (sorted alphabetically) */
function makeMintPairKey(mintA: string, mintB: string): string {
  const [lo, hi] = mintA < mintB ? [mintA, mintB] : [mintB, mintA];
  return `${lo}_${hi}`;
}

/** Resolve a human-readable symbol from a mint address */
function resolveSymbol(mint: string, orcaSymbol: string): string {
  // 1. Check our curated mint registry
  if (KNOWN_MINTS[mint]) return KNOWN_MINTS[mint];
  // 2. Use Orca API symbol if non-empty
  if (orcaSymbol && orcaSymbol.trim().length > 0) return orcaSymbol;
  // 3. Fallback to truncated mint address
  return mint.slice(0, 8);
}

/** fetch with a timeout to prevent API hangs */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
