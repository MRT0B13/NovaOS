/**
 * Krystal EVM LP Service
 *
 * Data:      Krystal Cloud API  → pool discovery + position tracking (all chains, all tokens)
 * Execution: Uniswap V3 NonfungiblePositionManager (direct on-chain, no Krystal operator needed)
 * Chains:    Discovered dynamically from API — zero hardcoding
 * Tokens:    Read from pool data — zero hardcoding
 *
 * Key functions:
 *   discoverKrystalPools()        → top pools across ALL Krystal-supported chains, scored
 *   fetchKrystalPositions(addr)   → all open EVM LP positions for wallet
 *   openEvmLpPosition(pool, usd)  → mint LP NFT on target chain
 *   closeEvmLpPosition(pos)       → burn LP NFT and recover tokens
 *   claimEvmLpFees(pos)           → collect accumulated fees
 *   getEvmProvider(chainId)       → lazily-created ethers provider per chain
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

const KRYSTAL_BASE_URL = 'https://cloud-api.krystal.app';

// NonfungiblePositionManager — Uniswap V3 canonical (same on all chains)
const NFPM_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

const NFPM_ABI = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const MaxUint128 = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

// Uniswap V3 SwapRouter02 (universal, for pre-position swaps)
const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

// Chains with concentrated-liquidity DEXes on Krystal
// Eth(1), Optimism(10), BSC(56), Polygon(137), Base(8453), Arbitrum(42161),
// Avalanche(43114), zkSync(324), Scroll(534352), Linea(59144)
const KRYSTAL_LP_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 324, 534352, 59144]);

// Krystal V3Utils contract addresses per chain (single-token → LP zap)
// Placeholder addresses — replace with actual V3Utils contract when known per chain
const KRYSTAL_V3UTILS: Record<number, string> = {
  // Will be populated when Krystal publishes V3Utils addresses per chain
  // 42161: '0x...', // Arbitrum
  // 8453:  '0x...', // Base
};

const V3UTILS_ABI = [
  'function swapAndMint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0, uint256 amount1, address recipient, uint256 deadline, bytes swapData0, bytes swapData1)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

// ============================================================================
// Types
// ============================================================================

export interface KrystalPoolToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
}

export interface KrystalPool {
  chainId: string;           // "arbitrum@42161"
  poolAddress: string;
  protocol: { name: string; factoryAddress: string };
  feeTier: number;
  token0: KrystalPoolToken;
  token1: KrystalPoolToken;
  tvl: string;               // USD string
  stats1h?: { volume: string; fee: string; apr: string };
  stats24h?: { volume: string; fee: string; apr: string };
  stats7d?: { volume: string; fee: string; apr: string };
  stats30d?: { volume: string; fee: string; apr: string };
}

export interface ScoredKrystalPool extends KrystalPool {
  chainNumericId: number;
  chainName: string;
  tvlUsd: number;
  apr24h: number;
  apr7d: number;
  apr30d: number;
  score: number;
  scoreBreakdown: Record<string, number>;
  reasoning: string[];
}

export interface KrystalPosition {
  posId: string;
  chainId: string;
  chainNumericId: number;
  chainName: string;
  protocol: string;
  poolAddress: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  valueUsd: number;
  inRange: boolean;
  rangeUtilisationPct: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  feesOwed0: number;
  feesOwed1: number;
  feesOwedUsd: number;
  openedAt: number;
}

export interface EvmLpOpenResult {
  success: boolean;
  tokenId?: string;
  txHash?: string;
  error?: string;
}

export interface EvmLpCloseResult {
  success: boolean;
  txHash?: string;
  error?: string;
  amount0Recovered: bigint;
  amount1Recovered: bigint;
  valueRecoveredUsd: number;
  feeTier: number;
  chainName: string;
}

export interface EvmLpClaimResult {
  success: boolean;
  txHash?: string;
  error?: string;
  amount0Claimed?: bigint;
  amount1Claimed?: bigint;
}

export interface EvmLpRecord {
  posId: string;
  chainId: string;
  chainNumericId: number;
  chainName: string;
  protocol: string;
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  entryUsd: number;
  openedAt: number;
}

/** Per-chain balance snapshot for multi-chain portfolio scanning */
export interface ChainBalance {
  chainId: number;
  chainName: string;
  usdcBalance: number;        // USDC (native or bridged) in human units
  nativeBalance: number;      // ETH/MATIC/AVAX etc. in human units
  nativeSymbol: string;
  nativeValueUsd: number;     // nativeBalance × price estimate
}

// ============================================================================
// Chain helpers
// ============================================================================

export function parseKrystalChainId(raw: string): { name: string; numericId: number } {
  const parts = raw.split('@');
  return { name: parts[0] ?? raw, numericId: parseInt(parts[1] ?? '0', 10) };
}

function computeRangeUtilisation(tickLower: number, tickUpper: number, currentTick: number): number {
  if (currentTick <= tickLower || currentTick >= tickUpper) return 0;
  const rangeHalf = (tickUpper - tickLower) / 2;
  const centre = (tickLower + tickUpper) / 2;
  const distanceFromCentre = Math.abs(currentTick - centre);
  return Math.max(0, Math.round((1 - distanceFromCentre / rangeHalf) * 100));
}

// ============================================================================
// Provider pooling
// ============================================================================

let _ethers: typeof import('ethers') | null = null;
async function loadEthers(): Promise<typeof import('ethers')> {
  if (!_ethers) _ethers = await import('ethers' as string);
  return _ethers!;
}

const _providerCache = new Map<number, any>();

export async function getEvmProvider(numericChainId: number): Promise<any> {
  if (_providerCache.has(numericChainId)) return _providerCache.get(numericChainId)!;

  const env = getCFOEnv();
  const url = env.evmRpcUrls[numericChainId]
    ?? (numericChainId === 42161 ? env.arbitrumRpcUrl : undefined);
  if (!url) throw new Error(`[Krystal] No RPC URL configured for chainId ${numericChainId}`);

  const ethers = await loadEthers();
  const provider = new ethers.JsonRpcProvider(url);
  _providerCache.set(numericChainId, provider);
  return provider;
}

async function getEvmWallet(numericChainId: number): Promise<any> {
  const env = getCFOEnv();
  if (!env.evmPrivateKey) throw new Error('[Krystal] CFO_EVM_PRIVATE_KEY not set');
  const ethers = await loadEthers();
  const provider = await getEvmProvider(numericChainId);
  return new ethers.Wallet(env.evmPrivateKey, provider);
}

// ============================================================================
// Krystal API helpers
// ============================================================================

async function krystalFetch(path: string, params?: Record<string, string>): Promise<any> {
  const env = getCFOEnv();
  const apiKey = env.krystalApiKey;

  const url = new URL(path, KRYSTAL_BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['KC-APIKey'] = apiKey;

  const resp = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[Krystal] API ${resp.status}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

// ============================================================================
// Pool Discovery + Scoring
// ============================================================================

let _cachedPools: ScoredKrystalPool[] = [];
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60_000; // 1 hour

export async function discoverKrystalPools(forceRefresh = false): Promise<ScoredKrystalPool[]> {
  if (!forceRefresh && _cachedPools.length > 0 && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedPools;
  }

  const env = getCFOEnv();
  if (!env.krystalLpEnabled) return _cachedPools;

  // Query per-chain with pagination for full coverage
  const targetChains = Array.from(KRYSTAL_LP_CHAINS);
  const PAGES_PER_CHAIN = 5;
  const PER_PAGE = 200;
  logger.info(`[KrystalDiscovery] Refreshing pool list across ${targetChains.length} chains (${PAGES_PER_CHAIN} pages each)…`);

  try {
    // Build fetch tasks: each chain × each page (offset-based — Krystal ignores 'page')
    const fetchTasks: Array<{ chainId: number; offset: number }> = [];
    for (const chainId of targetChains) {
      for (let p = 0; p < PAGES_PER_CHAIN; p++) {
        fetchTasks.push({ chainId, offset: p * PER_PAGE });
      }
    }

    const perChainResults = await Promise.allSettled(
      fetchTasks.map(({ chainId, offset }) =>
        krystalFetch('/v1/pools', {
          sortBy: '0',
          limit: String(PER_PAGE),
          chainId: String(chainId),
          offset: String(offset),
        }),
      ),
    );

    const rawPools: any[] = [];
    let failCount = 0;
    for (const result of perChainResults) {
      if (result.status !== 'fulfilled') { failCount++; continue; }
      const data = result.value;
      const arr = data?.pools ?? (Array.isArray(data) ? data : []);
      if (Array.isArray(arr)) rawPools.push(...arr);
    }
    if (failCount > 0) logger.warn(`[KrystalDiscovery] ${failCount}/${fetchTasks.length} fetch tasks failed`);

    if (rawPools.length === 0) {
      logger.warn('[KrystalDiscovery] No pools returned from any chain');
      return _cachedPools;
    }

    logger.info(`[KrystalDiscovery] Fetched ${rawPools.length} raw pools across ${targetChains.length} chains`);

    // Deduplicate by chainId + poolAddress
    const seenPools = new Set<string>();
    const uniquePools: any[] = [];
    for (const raw of rawPools) {
      const chainId = raw.chain?.id ?? raw.chainId ?? 0;
      const addr = raw.poolAddress ?? '';
      const key = `${chainId}_${addr}`;
      if (seenPools.has(key)) continue;
      seenPools.add(key);
      uniquePools.push(raw);
    }
    logger.info(`[KrystalDiscovery] ${uniquePools.length} unique pools after dedup`);

    const candidates: ScoredKrystalPool[] = [];

    for (const raw of uniquePools) {
      // ── Normalise Krystal API shape → our KrystalPool type ──
      // API returns: { chain: { name, id }, token0: { token: { address, symbol, ... } }, tvl: number, ... }
      // We need:     { chainId: "polygon@137", token0: { address, symbol, ... }, tvl: "296321", ... }
      const chainObj = raw.chain ?? {};
      const chainNumId = Number(chainObj.id ?? raw.chainId ?? 0);
      const chainName  = String(chainObj.name ?? raw.chainName ?? 'unknown').toLowerCase();
      const chainIdStr = `${chainName}@${chainNumId}`;

      // Flatten token objects — API nests under .token subkey
      const t0raw = raw.token0 ?? {};
      const t1raw = raw.token1 ?? {};
      const token0: KrystalPoolToken = {
        address:  t0raw.token?.address ?? t0raw.address ?? '',
        symbol:   t0raw.token?.symbol  ?? t0raw.symbol  ?? '?',
        name:     t0raw.token?.name    ?? t0raw.name    ?? '',
        decimals: Number(t0raw.token?.decimals ?? t0raw.decimals ?? 18),
        logo:     t0raw.token?.logo    ?? t0raw.logo,
      };
      const token1: KrystalPoolToken = {
        address:  t1raw.token?.address ?? t1raw.address ?? '',
        symbol:   t1raw.token?.symbol  ?? t1raw.symbol  ?? '?',
        name:     t1raw.token?.name    ?? t1raw.name    ?? '',
        decimals: Number(t1raw.token?.decimals ?? t1raw.decimals ?? 18),
        logo:     t1raw.token?.logo    ?? t1raw.logo,
      };

      // Protocol normalisation
      const protoRaw = raw.protocol ?? {};
      const protocol = {
        name: protoRaw.name ?? protoRaw.key ?? 'unknown',
        factoryAddress: protoRaw.factoryAddress ?? '',
      };

      // Support all concentrated-liquidity V3-compatible protocols
      // (Uniswap V3, QuickSwap V3, PancakeSwap V3, SushiSwap V3, Camelot V3, Aerodrome CL)
      const protoKey = String(protoRaw.key ?? protoRaw.name ?? '').toLowerCase();
      const isV3Compatible = protoKey.includes('v3') || protoKey.includes('cl');
      // Exclude V4 and plain V2 (no concentrated liquidity)
      const isExcluded = protoKey.includes('v4') || (protoKey.includes('v2') && !protoKey.includes('v3'));
      if (!isV3Compatible || isExcluded) continue;

      // Numeric stats — API returns numbers, our interface allows strings
      const tvlUsd = Number(raw.tvl ?? 0);
      const apr24h = Number(raw.stats24h?.apr ?? 0);
      const apr7d  = Number(raw.stats7d?.apr  ?? 0);
      const apr30d = Number(raw.stats30d?.apr ?? 0);
      const feeTier = Number(raw.feeTier ?? 0);

      // Quality floor — only pools with meaningful liquidity
      if (tvlUsd < 250_000) continue;
      if (apr7d < 5) continue;

      // Register token addresses in the dynamic bridge/swap registry
      try {
        const { registerTokenAddress } = await import('./wormholeService.ts');
        if (token0.address) registerTokenAddress(chainNumId, token0.symbol, token0.address);
        if (token1.address) registerTokenAddress(chainNumId, token1.symbol, token1.address);
      } catch { /* non-fatal — wormholeService may not be available */ }

      const pool: KrystalPool = {
        chainId: chainIdStr,
        poolAddress: raw.poolAddress ?? '',
        protocol,
        feeTier,
        token0,
        token1,
        tvl: String(tvlUsd),
        stats1h:  raw.stats1h  ? { volume: String(raw.stats1h.volume  ?? 0), fee: String(raw.stats1h.fee  ?? 0), apr: String(raw.stats1h.apr  ?? 0) } : undefined,
        stats24h: raw.stats24h ? { volume: String(raw.stats24h.volume ?? 0), fee: String(raw.stats24h.fee ?? 0), apr: String(raw.stats24h.apr ?? 0) } : undefined,
        stats7d:  raw.stats7d  ? { volume: String(raw.stats7d.volume  ?? 0), fee: String(raw.stats7d.fee  ?? 0), apr: String(raw.stats7d.apr  ?? 0) } : undefined,
        stats30d: raw.stats30d ? { volume: String(raw.stats30d.volume ?? 0), fee: String(raw.stats30d.fee ?? 0), apr: String(raw.stats30d.apr ?? 0) } : undefined,
      };

      candidates.push({
        ...pool,
        chainNumericId: chainNumId,
        chainName,
        tvlUsd,
        apr24h,
        apr7d,
        apr30d,
        score: 0,
        scoreBreakdown: {},
        reasoning: [],
      });
    }

    // Score all candidates
    for (const c of candidates) scoreKrystalPool(c);

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    _cachedPools = candidates;
    _cacheTimestamp = Date.now();

    const top10 = candidates.slice(0, 10).map((c, i) =>
      `${i + 1}. ${c.token0.symbol}/${c.token1.symbol} (${c.chainName}) score=${c.score.toFixed(0)} APR7d=${c.apr7d.toFixed(1)}% TVL=$${(c.tvlUsd / 1e6).toFixed(1)}M`,
    ).join('\n');
    logger.info(`[KrystalDiscovery] ${candidates.length} pools scored. Top 10:\n${top10}`);

    return candidates;
  } catch (err) {
    logger.warn('[KrystalDiscovery] Pool refresh failed, using cached list:', err);
    return _cachedPools;
  }
}

/**
 * Score a Krystal pool candidate using multi-factor analysis.
 * Mirrors orcaPoolDiscovery.scorePool() logic.
 *
 * Factors (total ~100 points):
 *   1. APR 7d (40%): primary income signal
 *   2. TVL (25%): stability / depth
 *   3. Volume Consistency (20%): 24h vs 7d APR consistency
 *   4. Protocol (10%): V3-compatible protocol bonus
 *   5. Range Safety (5%): stablecoin pairs less IL
 */
function scoreKrystalPool(pool: ScoredKrystalPool): void {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];

  // ── 1. APR 7d (0-40 pts) ──
  const apr = Math.min(pool.apr7d, 200); // cap at 200%
  if (apr >= 100) { breakdown.apr7d = 40; reasons.push(`very high APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 50) { breakdown.apr7d = 33; reasons.push(`high APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 25) { breakdown.apr7d = 25; reasons.push(`good APR ${pool.apr7d.toFixed(0)}%`); }
  else if (apr >= 15) { breakdown.apr7d = 18; }
  else if (apr >= 10) { breakdown.apr7d = 12; }
  else if (apr >= 5) { breakdown.apr7d = 6; }
  else { breakdown.apr7d = 0; }

  // ── 2. TVL (0-25 pts) ──
  const tvl = pool.tvlUsd;
  if (tvl >= 10e6) { breakdown.tvl = 25; reasons.push(`deep TVL $${(tvl / 1e6).toFixed(1)}M`); }
  else if (tvl >= 5e6) { breakdown.tvl = 20; }
  else if (tvl >= 1e6) { breakdown.tvl = 15; }
  else if (tvl >= 500_000) { breakdown.tvl = 10; }
  else { breakdown.tvl = 5; }

  // ── 3. Volume Consistency (0-20 pts) ──
  // Compare 24h APR vs 7d APR — penalise spike-and-die pools
  if (pool.apr7d > 0 && pool.apr24h > 0) {
    const ratio = pool.apr24h / pool.apr7d;
    if (ratio >= 0.6 && ratio <= 1.6) {
      breakdown.consistency = 20;
      reasons.push('consistent APR');
    } else if (ratio >= 0.3 && ratio <= 2.5) {
      breakdown.consistency = 12;
    } else if (ratio > 2.5) {
      breakdown.consistency = 5;
      reasons.push('recent APR spike — may be unsustainable');
    } else {
      breakdown.consistency = 5;
      reasons.push('declining volume');
    }
  } else {
    breakdown.consistency = 10; // insufficient data
  }

  // ── 4. Protocol (0-10 pts) ──
  const proto = pool.protocol.name.toLowerCase();
  if (proto.includes('uniswap')) { breakdown.protocol = 10; reasons.push('Uniswap V3'); }
  else if (proto.includes('pancake')) { breakdown.protocol = 8; reasons.push('PancakeSwap V3'); }
  else if (proto.includes('sushi')) { breakdown.protocol = 8; reasons.push('SushiSwap V3'); }
  else if (proto.includes('quickswap')) { breakdown.protocol = 7; reasons.push('QuickSwap V3'); }
  else if (proto.includes('algebra') || proto.includes('camelot')) { breakdown.protocol = 7; }
  else if (proto.includes('aerodrome')) { breakdown.protocol = 7; reasons.push('Aerodrome CL'); }
  else { breakdown.protocol = 5; }

  // ── 5. Range Safety (0-5 pts) ──
  const stableSymbols = ['USDC', 'USDT', 'DAI', 'USDG', 'FRAX', 'TUSD', 'BUSD', 'USDCE'];
  const isStable = stableSymbols.includes(pool.token0.symbol.toUpperCase()) &&
                   stableSymbols.includes(pool.token1.symbol.toUpperCase());
  if (isStable) {
    breakdown.range = 5;
    reasons.push('stablecoin pair — minimal IL');
  } else if (stableSymbols.includes(pool.token0.symbol.toUpperCase()) ||
             stableSymbols.includes(pool.token1.symbol.toUpperCase())) {
    breakdown.range = 3; // one stable side
  } else {
    breakdown.range = 1; // volatile pair
  }

  pool.score = Object.values(breakdown).reduce((s, v) => s + v, 0);
  pool.scoreBreakdown = breakdown;
  pool.reasoning = reasons;
}

// ============================================================================
// Position tracking
// ============================================================================

// Cache for slot0 reads (per pool address per chain), 60s TTL
const _slot0Cache = new Map<string, { tick: number; ts: number }>();
const SLOT0_CACHE_TTL = 60_000;

export async function fetchKrystalPositions(
  ownerAddress: string,
  dbRecords?: EvmLpRecord[],
): Promise<KrystalPosition[]> {
  const env = getCFOEnv();
  if (!env.krystalLpEnabled) return [];

  try {
    const data = await krystalFetch('/v1/positions', { wallet: ownerAddress });
    const rawPositions: any[] = Array.isArray(data) ? data : (data?.positions ?? []);
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) return [];

    // Build lookup from DB records for openedAt timestamps
    const dbLookup = new Map<string, EvmLpRecord>();
    if (dbRecords) {
      for (const r of dbRecords) dbLookup.set(`${r.posId}_${r.chainNumericId}`, r);
    }

    const positions: KrystalPosition[] = [];

    for (const pos of rawPositions) {
      // Skip closed positions
      if (pos.status === 'CLOSED') continue;

      // ── Normalise Krystal positions API shape ──
      // chain: { name, id } → chainId string
      const chainObj = pos.chain ?? {};
      const numericId = Number(chainObj.id ?? 0);
      const name = String(chainObj.name ?? 'unknown').toLowerCase();
      const chainIdStr = `${name}@${numericId}`;

      // tokenId (the NFT ID to pass to NFPM)
      const posId = String(pos.tokenId ?? pos.posId ?? '');
      if (!posId) continue;

      // Pool address from nested pool object
      const poolAddress = pos.pool?.poolAddress ?? pos.poolAddress ?? '';

      // Protocol
      const protocol = pos.pool?.protocol?.name ?? pos.protocol?.name ?? 'unknown';

      // Tokens from currentAmounts array (or flat token0/token1 fallback)
      const amt0 = pos.currentAmounts?.[0] ?? {};
      const amt1 = pos.currentAmounts?.[1] ?? {};
      const token0: Omit<KrystalPoolToken, 'logo' | 'name'> & { name?: string } = {
        address:  amt0.token?.address ?? pos.token0?.token?.address ?? pos.token0?.address ?? '',
        symbol:   amt0.token?.symbol  ?? pos.token0?.token?.symbol  ?? pos.token0?.symbol  ?? '?',
        decimals: Number(amt0.token?.decimals ?? pos.token0?.token?.decimals ?? pos.token0?.decimals ?? 18),
      };
      const token1: Omit<KrystalPoolToken, 'logo' | 'name'> & { name?: string } = {
        address:  amt1.token?.address ?? pos.token1?.token?.address ?? pos.token1?.address ?? '',
        symbol:   amt1.token?.symbol  ?? pos.token1?.token?.symbol  ?? pos.token1?.symbol  ?? '?',
        decimals: Number(amt1.token?.decimals ?? pos.token1?.token?.decimals ?? pos.token1?.decimals ?? 18),
      };

      // Read tick range from on-chain NFPM.positions() — API doesn't provide ticks
      let tickLower = 0;
      let tickUpper = 0;
      let currentTick = 0;
      let feeTier = 0;

      if (env.evmRpcUrls[numericId] && posId) {
        try {
          const ethers = await loadEthers();
          const provider = await getEvmProvider(numericId);
          const nfpm = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, provider);
          const posData = await nfpm.positions(posId);
          tickLower = Number(posData.tickLower ?? posData[5] ?? 0);
          tickUpper = Number(posData.tickUpper ?? posData[6] ?? 0);
          feeTier = Number(posData.fee ?? posData[4] ?? 0);

          // Get current tick from pool slot0 (cached)
          if (poolAddress) {
            const poolKey = `${numericId}_${poolAddress}`;
            const cached = _slot0Cache.get(poolKey);
            if (cached && Date.now() - cached.ts < SLOT0_CACHE_TTL) {
              currentTick = cached.tick;
            } else {
              const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
              const slot0 = await poolContract.slot0();
              currentTick = Number(slot0.tick ?? slot0[1] ?? 0);
              _slot0Cache.set(poolKey, { tick: currentTick, ts: Date.now() });
            }
          }
        } catch (err) {
          logger.warn(`[Krystal] Failed to read on-chain data for position ${posId}:`, err);
        }
      }

      const inRange = currentTick !== 0 ? (currentTick > tickLower && currentTick < tickUpper) : (pos.status !== 'OUT_OF_RANGE');
      const rangeUtilisationPct = currentTick !== 0
        ? computeRangeUtilisation(tickLower, tickUpper, currentTick)
        : (inRange ? 50 : 0);

      // Fees from tradingFee.pending array
      const pendingFees = pos.tradingFee?.pending ?? [];
      const feesOwed0 = parseFloat(pendingFees[0]?.balance ?? '0') / (10 ** token0.decimals);
      const feesOwed1 = parseFloat(pendingFees[1]?.balance ?? '0') / (10 ** token1.decimals);
      const feesOwedUsd = (feesOwed0 * (pendingFees[0]?.price ?? 0)) + (feesOwed1 * (pendingFees[1]?.price ?? 0));

      // Current value
      const valueUsd = (parseFloat(amt0.balance ?? '0') / (10 ** token0.decimals) * (amt0.price ?? 0))
                      + (parseFloat(amt1.balance ?? '0') / (10 ** token1.decimals) * (amt1.price ?? 0));

      // Look up openedAt from DB record or API openedTime
      const dbKey = `${posId}_${numericId}`;
      const dbRec = dbLookup.get(dbKey);
      const openedAt = dbRec?.openedAt ?? (pos.openedTime ? pos.openedTime * 1000 : Date.now());

      positions.push({
        posId,
        chainId: chainIdStr,
        chainNumericId: numericId,
        chainName: name,
        protocol,
        poolAddress,
        token0: { address: token0.address, symbol: token0.symbol, decimals: token0.decimals },
        token1: { address: token1.address, symbol: token1.symbol, decimals: token1.decimals },
        valueUsd,
        inRange,
        rangeUtilisationPct,
        tickLower,
        tickUpper,
        currentTick,
        feesOwed0,
        feesOwed1,
        feesOwedUsd,
        openedAt,
      });
    }

    // Cross-reference: if DB has positions not in API response, they may have been closed externally
    if (dbRecords) {
      const apiPosIds = new Set(positions.map(p => `${p.posId}_${p.chainNumericId}`));
      for (const dbRec of dbRecords) {
        const key = `${dbRec.posId}_${dbRec.chainNumericId}`;
        if (!apiPosIds.has(key)) {
          logger.warn(`[Krystal] DB position ${dbRec.posId} (${dbRec.chainName}) not found in API — may have been closed externally`);
        }
      }
    }

    return positions;
  } catch (err) {
    logger.warn('[Krystal] fetchKrystalPositions failed:', err);
    return [];
  }
}

// ============================================================================
// Open Position — mint LP NFT via NonfungiblePositionManager
// ============================================================================

export async function openEvmLpPosition(
  pool: {
    chainId: string;
    chainNumericId?: number;
    poolAddress: string;
    token0: KrystalPoolToken;
    token1: KrystalPoolToken;
    protocol: { name: string; factoryAddress: string } | string;
    feeTier: number;
  },
  deployUsd: number,
  rangeWidthTicks = 400,
  /** Optional: attempt to bridge USDC from another chain if local balance insufficient */
  bridgeFunding?: {
    sourceChainId: number;    // chain with available USDC
    walletAddress: string;    // EVM wallet address
  },
): Promise<EvmLpOpenResult> {
  const env = getCFOEnv();
  const { numericId: chainNumericId } = pool.chainNumericId
    ? { numericId: pool.chainNumericId }
    : parseKrystalChainId(pool.chainId);

  if (env.dryRun) {
    logger.info(`[Krystal] DRY RUN — would open LP: $${deployUsd} on ${pool.token0.symbol}/${pool.token1.symbol} (chain ${chainNumericId})`);
    return { success: true, tokenId: `dry-evm-lp-${Date.now()}` };
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainNumericId);
    const provider = await getEvmProvider(chainNumericId);

    // 1. Read current tick from pool
    const poolContract = new ethers.Contract(pool.poolAddress, POOL_ABI, provider);
    const slot0 = await poolContract.slot0();
    const currentTick = Number(slot0.tick ?? slot0[1]);

    // 2. Compute tick range centred on current tick, aligned to tick spacing
    const feeToTickSpacing: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
    const tickSpacing = feeToTickSpacing[pool.feeTier] ?? 60;
    const rawLower = currentTick - rangeWidthTicks;
    const rawUpper = currentTick + rangeWidthTicks;
    const tickLower = Math.floor(rawLower / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil(rawUpper / tickSpacing) * tickSpacing;

    // 3. Check wallet balances for token0 and token1
    const token0Contract = new ethers.Contract(pool.token0.address, ERC20_ABI, provider);
    const token1Contract = new ethers.Contract(pool.token1.address, ERC20_ABI, provider);

    let [bal0, bal1] = await Promise.all([
      token0Contract.balanceOf(wallet.address).catch(() => BigInt(0)),
      token1Contract.balanceOf(wallet.address).catch(() => BigInt(0)),
    ]);

    // ── Bridge + Swap Funding Flow ──────────────────────────────────
    // If both token balances are zero/insufficient and bridge funding is requested,
    // bridge USDC from source chain → target chain, then swap into pool tokens.
    if (bal0 === BigInt(0) && bal1 === BigInt(0) && bridgeFunding) {
      logger.info(`[Krystal] No token balances on chain ${chainNumericId} — attempting bridge funding from chain ${bridgeFunding.sourceChainId}`);
      try {
        const bridge = await import('./wormholeService.ts');

        // Check if LI.FI is enabled and we have USDC on source chain
        if (!env.lifiEnabled) {
          logger.warn('[Krystal] Bridge funding skipped — LI.FI not enabled');
        } else {
          const sourceUsdcAddr = bridge.resolveTokenAddress(bridgeFunding.sourceChainId, 'USDC');
          if (sourceUsdcAddr) {
            const sourceBalance = await bridge.getEvmTokenBalance(
              bridgeFunding.sourceChainId,
              sourceUsdcAddr,
              bridgeFunding.walletAddress,
            );

            if (sourceBalance >= deployUsd) {
              // Bridge USDC to target chain
              const bridgeResult = await bridge.bridgeEvmToEvm(
                bridgeFunding.sourceChainId,
                chainNumericId,
                'USDC',
                deployUsd,
                bridgeFunding.walletAddress,
                wallet.address,
              );

              if (bridgeResult.success && bridgeResult.txHash) {
                // Wait for bridge to complete (poll every 15s, max 5min)
                const bridgeStatus = await bridge.awaitBridgeCompletion(
                  bridgeResult.txHash,
                  bridge.chainIdToName(bridgeFunding.sourceChainId),
                );
                if (bridgeStatus !== 'DONE') {
                  logger.warn(`[Krystal] Bridge ${bridgeStatus} — proceeding with whatever balance is available`);
                } else {
                  logger.info(`[Krystal] Bridge completed — USDC now on chain ${chainNumericId}`);
                }
              } else {
                logger.warn(`[Krystal] Bridge failed: ${bridgeResult.error}`);
              }
            } else {
              logger.warn(`[Krystal] Insufficient USDC on source chain: $${sourceBalance.toFixed(2)} < $${deployUsd}`);
            }
          }
        }
      } catch (err) {
        logger.warn('[Krystal] Bridge funding failed (non-fatal):', err);
      }

      // After bridge, swap USDC into pool tokens if needed
      try {
        const swap = await import('./evmSwapService.ts');
        const bridge = await import('./wormholeService.ts');
        const usdcAddr = bridge.resolveTokenAddress(chainNumericId, 'USDC');

        if (usdcAddr) {
          const usdcBal = await bridge.getEvmTokenBalance(chainNumericId, usdcAddr, wallet.address);

          if (usdcBal > 0) {
            const halfUsdc = usdcBal / 2;

            // Check if either pool token is USDC — if so, only swap one side
            const isToken0Usdc = pool.token0.address.toLowerCase() === usdcAddr.toLowerCase();
            const isToken1Usdc = pool.token1.address.toLowerCase() === usdcAddr.toLowerCase();

            if (!isToken0Usdc && halfUsdc > 0.5) {
              // Quote first — guard against excessive price impact
              const quote0 = await swap.quoteEvmSwap(chainNumericId, usdcAddr, pool.token0.address, halfUsdc, pool.feeTier);
              if (quote0 && quote0.priceImpactPct > 3) {
                logger.warn(`[Krystal] Swap USDC→${pool.token0.symbol} price impact ${quote0.priceImpactPct.toFixed(1)}% > 3% — skipping`);
              } else {
                const swapResult = await swap.executeEvmSwap(
                  chainNumericId, usdcAddr, pool.token0.address, halfUsdc, pool.feeTier,
                );
                if (swapResult.success) logger.info(`[Krystal] Swapped $${halfUsdc.toFixed(2)} USDC → ${pool.token0.symbol}`);
              }
            }

            if (!isToken1Usdc && halfUsdc > 0.5) {
              // Quote first — guard against excessive price impact
              const quote1 = await swap.quoteEvmSwap(chainNumericId, usdcAddr, pool.token1.address, halfUsdc, pool.feeTier);
              if (quote1 && quote1.priceImpactPct > 3) {
                logger.warn(`[Krystal] Swap USDC→${pool.token1.symbol} price impact ${quote1.priceImpactPct.toFixed(1)}% > 3% — skipping`);
              } else {
                const swapResult = await swap.executeEvmSwap(
                  chainNumericId, usdcAddr, pool.token1.address, halfUsdc, pool.feeTier,
                );
                if (swapResult.success) logger.info(`[Krystal] Swapped $${halfUsdc.toFixed(2)} USDC → ${pool.token1.symbol}`);
              }
            }
          }
        }
      } catch (err) {
        logger.warn('[Krystal] Pre-position swap failed (non-fatal):', err);
      }

      // Re-check balances after bridge + swap
      [bal0, bal1] = await Promise.all([
        token0Contract.balanceOf(wallet.address).catch(() => BigInt(0)),
        token1Contract.balanceOf(wallet.address).catch(() => BigInt(0)),
      ]);
    }

    // 4. Calculate desired amounts — cap at deployUsd equivalent
    //    Use sqrtPriceX96 to derive token0 price in token1 terms, then limit each side.
    const sqrtPriceX96 = slot0.sqrtPriceX96 ?? slot0[0] ?? BigInt(0);
    const dec0 = pool.token0.decimals ?? 18;
    const dec1 = pool.token1.decimals ?? 18;

    // price = (sqrtPriceX96 / 2^96)^2  in token1-per-token0 (adjusted for decimals)
    const sqrtP = Number(sqrtPriceX96) / (2 ** 96);
    const rawPrice = sqrtP * sqrtP;                 // token1-units-per-token0-unit (raw)
    const price0In1 = rawPrice * (10 ** dec0) / (10 ** dec1);   // human-readable

    // We want ~deployUsd / 2 worth of each token
    // Need a USD price for at least one token. Heuristic: if one token is a stablecoin, its price ≈ $1
    const stableSymbols = ['USDC', 'USDT', 'DAI', 'BUSD', 'USDCE', 'USDC.E', 'USDT0'];
    const is0Stable = stableSymbols.includes(pool.token0.symbol.toUpperCase());
    const is1Stable = stableSymbols.includes(pool.token1.symbol.toUpperCase());

    let usdPerToken0: number;
    let usdPerToken1: number;

    if (is1Stable) {
      usdPerToken1 = 1;
      usdPerToken0 = price0In1; // token0 costs price0In1 stablecoin units
    } else if (is0Stable) {
      usdPerToken0 = 1;
      usdPerToken1 = 1 / price0In1;
    } else {
      // Neither is stable — use native token price heuristic
      const nPrice = await getNativeTokenPrice(chainNumericId);
      usdPerToken0 = nPrice; // rough — assumes token0 is the native-like one
      usdPerToken1 = nPrice * price0In1;
    }

    const halfUsd = deployUsd / 2;
    const maxToken0 = BigInt(Math.floor((halfUsd / usdPerToken0) * (10 ** dec0)));
    const maxToken1 = BigInt(Math.floor((halfUsd / usdPerToken1) * (10 ** dec1)));

    const amount0Desired = bal0 < maxToken0 ? bal0 : maxToken0;
    const amount1Desired = bal1 < maxToken1 ? bal1 : maxToken1;

    logger.info(`[Krystal] Deploy cap: $${deployUsd} → token0 max=${ethers.formatUnits(maxToken0, dec0)} (have ${ethers.formatUnits(bal0, dec0)}), token1 max=${ethers.formatUnits(maxToken1, dec1)} (have ${ethers.formatUnits(bal1, dec1)})`);

    // If both balances are zero, we can't open
    if (amount0Desired === BigInt(0) && amount1Desired === BigInt(0)) {
      return { success: false, error: 'No token0 or token1 balance on target chain' };
    }

    // 5. Try V3Utils zap path if available (single-token → LP)
    const v3UtilsAddr = KRYSTAL_V3UTILS[chainNumericId];
    if (v3UtilsAddr && (amount0Desired === BigInt(0) || amount1Desired === BigInt(0))) {
      try {
        const result = await openViaV3UtilsZap(
          ethers, wallet, provider, v3UtilsAddr,
          pool, tickLower, tickUpper,
          amount0Desired, amount1Desired,
        );
        if (result) return result;
      } catch (err) {
        logger.warn('[Krystal] V3Utils zap failed, falling back to NFPM mint:', err);
      }
    }

    // 6. Gas estimate check — skip if gas > 5% of deployUsd
    const nfpmContract = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, wallet);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? BigInt(0);
    const estimatedGas = BigInt(500_000); // conservative estimate for mint
    const gasCostWei = gasPrice * estimatedGas;
    const nativePrice = await getNativeTokenPrice(chainNumericId);
    const gasCostUsd = Number(ethers.formatEther(gasCostWei)) * nativePrice;

    if (gasCostUsd > deployUsd * 0.05) {
      logger.warn(`[Krystal] Gas cost $${gasCostUsd.toFixed(2)} > 5% of deploy $${deployUsd} — skipping`);
      return { success: false, error: `Gas too expensive: $${gasCostUsd.toFixed(2)}` };
    }

    // 7. Approve tokens for NFPM
    const token0Signer = new ethers.Contract(pool.token0.address, ERC20_ABI, wallet);
    const token1Signer = new ethers.Contract(pool.token1.address, ERC20_ABI, wallet);

    const [allowance0, allowance1] = await Promise.all([
      token0Signer.allowance(wallet.address, NFPM_ADDRESS),
      token1Signer.allowance(wallet.address, NFPM_ADDRESS),
    ]);

    if (allowance0 < amount0Desired) {
      const approveTx = await token0Signer.approve(NFPM_ADDRESS, ethers.MaxUint256);
      await approveTx.wait();
      logger.info(`[Krystal] Approved ${pool.token0.symbol} for NFPM`);
    }
    if (allowance1 < amount1Desired) {
      const approveTx = await token1Signer.approve(NFPM_ADDRESS, ethers.MaxUint256);
      await approveTx.wait();
      logger.info(`[Krystal] Approved ${pool.token1.symbol} for NFPM`);
    }

    // 8. Slippage: For V3 concentrated LP mints, set mins to 0.
    //    The NFPM deposits tokens in the ratio dictated by the tick range
    //    and current price — not our requested ratio. Excess tokens stay
    //    in the wallet. Setting min > 0 causes "Price slippage check" reverts
    //    whenever the pool's required ratio differs from our even split.
    //    Protection comes from: (a) capping desired amounts, (b) the deadline,
    //    (c) choosing the tick range ourselves.
    const amount0Min = BigInt(0);
    const amount1Min = BigInt(0);

    // 9. Mint LP position
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes
    const mintParams = {
      token0: pool.token0.address,
      token1: pool.token1.address,
      fee: pool.feeTier,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: wallet.address,
      deadline,
    };

    logger.info(
      `[Krystal] Minting LP: ${pool.token0.symbol}/${pool.token1.symbol} on chain ${chainNumericId}, ` +
      `ticks [${tickLower}, ${tickUpper}], fee ${pool.feeTier}`,
    );

    const tx = await nfpmContract.mint(mintParams);
    const receipt = await tx.wait();

    // Parse tokenId from Transfer event (ERC721)
    let tokenId: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = nfpmContract.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'IncreaseLiquidity' || parsed?.name === 'Transfer') {
          tokenId = parsed.args?.tokenId?.toString();
          if (tokenId) break;
        }
      } catch { /* skip non-NFPM logs */ }
    }

    if (!tokenId) {
      // Fallback: try to extract from receipt logs
      tokenId = `unknown-${receipt.hash.slice(0, 12)}`;
    }

    logger.info(`[Krystal] LP minted: tokenId=${tokenId} tx=${receipt.hash}`);
    return { success: true, tokenId, txHash: receipt.hash };
  } catch (err) {
    logger.error('[Krystal] openEvmLpPosition error:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Open LP position via Krystal V3Utils zap (single-token → LP).
 * Returns result if successful, null if V3Utils not available or failed.
 */
async function openViaV3UtilsZap(
  ethers: typeof import('ethers'),
  wallet: any,
  provider: any,
  v3UtilsAddr: string,
  pool: { token0: KrystalPoolToken; token1: KrystalPoolToken; feeTier: number },
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): Promise<EvmLpOpenResult | null> {
  const v3Utils = new ethers.Contract(v3UtilsAddr, V3UTILS_ABI, wallet);

  // Approve whichever token we have for v3Utils
  if (amount0 > BigInt(0)) {
    const token0 = new ethers.Contract(pool.token0.address, ERC20_ABI, wallet);
    const allowance = await token0.allowance(wallet.address, v3UtilsAddr);
    if (allowance < amount0) {
      const tx = await token0.approve(v3UtilsAddr, ethers.MaxUint256);
      await tx.wait();
    }
  }
  if (amount1 > BigInt(0)) {
    const token1 = new ethers.Contract(pool.token1.address, ERC20_ABI, wallet);
    const allowance = await token1.allowance(wallet.address, v3UtilsAddr);
    if (allowance < amount1) {
      const tx = await token1.approve(v3UtilsAddr, ethers.MaxUint256);
      await tx.wait();
    }
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await v3Utils.swapAndMint({
    token0: pool.token0.address,
    token1: pool.token1.address,
    fee: pool.feeTier,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    recipient: wallet.address,
    deadline,
    swapData0: '0x', // V3Utils auto-routes internally
    swapData1: '0x',
  });

  const receipt = await tx.wait();
  // Parse tokenId from logs
  let tokenId: string | undefined;
  const nfpmIface = new ethers.Interface(NFPM_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = nfpmIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'IncreaseLiquidity' || parsed?.name === 'Transfer') {
        tokenId = parsed.args?.tokenId?.toString();
        if (tokenId) break;
      }
    } catch { /* skip */ }
  }

  logger.info(`[Krystal] V3Utils zap success: tokenId=${tokenId} tx=${receipt.hash}`);
  return { success: true, tokenId: tokenId ?? `zap-${receipt.hash.slice(0, 12)}`, txHash: receipt.hash };
}

// ============================================================================
// Close Position — decreaseLiquidity + collect + burn
// ============================================================================

export async function closeEvmLpPosition(params: {
  posId: string;
  chainId: string;
  chainNumericId: number;
  /** Token info for USD value estimation (optional — improves rebalance sizing) */
  token0?: { address: string; symbol: string; decimals: number };
  token1?: { address: string; symbol: string; decimals: number };
}): Promise<EvmLpCloseResult> {
  const env = getCFOEnv();
  const { posId, chainNumericId } = params;
  const { name: chainName } = parseKrystalChainId(params.chainId);

  const failResult: EvmLpCloseResult = {
    success: false,
    amount0Recovered: BigInt(0),
    amount1Recovered: BigInt(0),
    valueRecoveredUsd: 0,
    feeTier: 0,
    chainName,
  };

  if (env.dryRun) {
    logger.info(`[Krystal] DRY RUN — would close LP tokenId=${posId} on ${chainName}`);
    return { ...failResult, success: true };
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainNumericId);
    const nfpm = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, wallet);

    // 1. Read position data
    const posData = await nfpm.positions(posId);
    const liquidity = posData.liquidity ?? posData[7];
    const feeTier = Number(posData.fee ?? posData[4] ?? 0);

    if (liquidity === BigInt(0)) {
      logger.warn(`[Krystal] Position ${posId} has zero liquidity — just collecting and burning`);
    }

    // 2. Decrease liquidity (withdraw all)
    if (liquidity > BigInt(0)) {
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const decreaseTx = await nfpm.decreaseLiquidity({
        tokenId: posId,
        liquidity,
        amount0Min: BigInt(0),
        amount1Min: BigInt(0),
        deadline,
      });
      await decreaseTx.wait();
      logger.info(`[Krystal] decreaseLiquidity done for ${posId}`);
    }

    // 3. Collect all tokens + fees
    const collectTx = await nfpm.collect({
      tokenId: posId,
      recipient: wallet.address,
      amount0Max: MaxUint128,
      amount1Max: MaxUint128,
    });
    const collectReceipt = await collectTx.wait();

    // Parse collected amounts from Collect event
    let amount0Recovered = BigInt(0);
    let amount1Recovered = BigInt(0);
    for (const log of collectReceipt.logs) {
      try {
        const parsed = nfpm.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'Collect') {
          amount0Recovered = parsed.args?.amount0 ?? BigInt(0);
          amount1Recovered = parsed.args?.amount1 ?? BigInt(0);
          break;
        }
      } catch { /* skip */ }
    }
    logger.info(`[Krystal] Collected: token0=${amount0Recovered}, token1=${amount1Recovered}`);

    // 4. Burn the NFT
    try {
      const burnTx = await nfpm.burn(posId);
      await burnTx.wait();
      logger.info(`[Krystal] Burned NFT ${posId}`);
    } catch (burnErr) {
      // Burn can fail if tokens are still owed — non-fatal
      logger.warn(`[Krystal] Burn failed (non-fatal): ${(burnErr as Error).message}`);
    }

    // Estimate USD value from recovered token amounts
    let valueRecoveredUsd = 0;
    try {
      const stableSymbols = ['USDC', 'USDT', 'DAI', 'BUSD', 'USDCE', 'USDC.E', 'USDT0'];
      const t0 = params.token0;
      const t1 = params.token1;
      if (t0 && t1) {
        const dec0 = t0.decimals ?? 18;
        const dec1 = t1.decimals ?? 18;
        const human0 = Number(amount0Recovered) / (10 ** dec0);
        const human1 = Number(amount1Recovered) / (10 ** dec1);
        const is0Stable = stableSymbols.includes(t0.symbol.toUpperCase());
        const is1Stable = stableSymbols.includes(t1.symbol.toUpperCase());

        if (is0Stable && is1Stable) {
          valueRecoveredUsd = human0 + human1;
        } else if (is0Stable) {
          // token0 is $1 → token1 value ≈ human0 equivalent (symmetric LP)
          valueRecoveredUsd = human0 * 2; // approximate: LP is ~50/50
        } else if (is1Stable) {
          valueRecoveredUsd = human1 * 2;
        } else {
          // Neither is stable — use native price heuristic
          const nPrice = await getNativeTokenPrice(chainNumericId);
          valueRecoveredUsd = (human0 + human1) * nPrice; // rough
        }
      }
      if (valueRecoveredUsd > 0) {
        logger.info(`[Krystal] Estimated value recovered: $${valueRecoveredUsd.toFixed(2)}`);
      }
    } catch { /* non-fatal — fallback to 0 */ }

    return {
      success: true,
      txHash: collectReceipt.hash,
      amount0Recovered,
      amount1Recovered,
      valueRecoveredUsd,
      feeTier,
      chainName,
    };
  } catch (err) {
    logger.error(`[Krystal] closeEvmLpPosition error (${posId}):`, err);
    return { ...failResult, error: (err as Error).message };
  }
}

// ============================================================================
// Claim Fees — collect without decreasing liquidity
// ============================================================================

export async function claimEvmLpFees(params: {
  posId: string;
  chainId: string;
  chainNumericId: number;
}): Promise<EvmLpClaimResult> {
  const env = getCFOEnv();
  const { posId, chainNumericId } = params;

  if (env.dryRun) {
    logger.info(`[Krystal] DRY RUN — would claim fees for tokenId=${posId}`);
    return { success: true };
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainNumericId);
    const nfpm = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, wallet);

    const tx = await nfpm.collect({
      tokenId: posId,
      recipient: wallet.address,
      amount0Max: MaxUint128,
      amount1Max: MaxUint128,
    });
    const receipt = await tx.wait();

    let amount0Claimed = BigInt(0);
    let amount1Claimed = BigInt(0);
    for (const log of receipt.logs) {
      try {
        const parsed = nfpm.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'Collect') {
          amount0Claimed = parsed.args?.amount0 ?? BigInt(0);
          amount1Claimed = parsed.args?.amount1 ?? BigInt(0);
          break;
        }
      } catch { /* skip */ }
    }

    logger.info(`[Krystal] Fees claimed for ${posId}: token0=${amount0Claimed}, token1=${amount1Claimed}`);
    return { success: true, txHash: receipt.hash, amount0Claimed, amount1Claimed };
  } catch (err) {
    logger.error(`[Krystal] claimEvmLpFees error (${posId}):`, err);
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Module-level price cache — set by `setAnalystPrices()` from decision engine.
 * Maps symbol → USD price. Populated each cycle from swarm intel.
 */
const _analystPrices: Record<string, number> = {};

/** Update native token prices from analyst/oracle data. Call once per decision cycle. */
export function setAnalystPrices(prices: Record<string, number>): void {
  Object.assign(_analystPrices, prices);
}

/** Chain → native token symbol mapping for price lookups */
const CHAIN_NATIVE_SYMBOL: Record<number, string> = {
  1: 'ETH', 42161: 'ETH', 10: 'ETH', 8453: 'ETH', 324: 'ETH', 534352: 'ETH', 59144: 'ETH',
  137: 'MATIC', 56: 'BNB', 43114: 'AVAX', 250: 'FTM',
};

/**
 * Get native token price for gas cost estimation.
 * Uses analyst prices when available, falls back to hardcoded estimates.
 */
async function getNativeTokenPrice(chainId: number): Promise<number> {
  // 1. Try analyst prices (updated each decision cycle)
  const symbol = CHAIN_NATIVE_SYMBOL[chainId];
  if (symbol && _analystPrices[symbol] > 0) return _analystPrices[symbol];
  // Also try common aliases
  if (symbol === 'ETH' && _analystPrices['WETH'] > 0) return _analystPrices['WETH'];
  if (symbol === 'MATIC' && _analystPrices['POL'] > 0) return _analystPrices['POL'];

  // 2. Fallback to conservative hardcoded estimates
  const estimates: Record<number, number> = {
    1: 2500, 42161: 2500, 10: 2500, 8453: 2500, 324: 2500, 534352: 2500, 59144: 2500,
    137: 0.5, 56: 300, 43114: 25, 250: 0.3,
  };
  return estimates[chainId] ?? 2500;
}

// ============================================================================
// Multi-Chain EVM Balance Scanner
// ============================================================================

/** Native token symbol per chain */
const NATIVE_SYMBOLS: Record<number, string> = {
  1: 'ETH', 10: 'ETH', 42161: 'ETH', 8453: 'ETH', 59144: 'ETH', 534352: 'ETH', 81457: 'ETH',
  137: 'MATIC', 56: 'BNB', 43114: 'AVAX', 324: 'ETH', 5000: 'MNT',
};

/**
 * Scan all configured EVM chains for USDC and native token balances.
 * Returns per-chain balances for portfolio tracking.
 */
export async function getMultiChainEvmBalances(): Promise<ChainBalance[]> {
  const env = getCFOEnv();
  if (!env.evmPrivateKey) return [];

  const ethers = await loadEthers();
  const walletAddress = ethers.computeAddress(env.evmPrivateKey);

  const chainIds = Object.keys(env.evmRpcUrls).map(Number);
  if (chainIds.length === 0) return [];

  const results: ChainBalance[] = [];

  // Scan all configured chains in parallel
  const promises = chainIds.map(async (chainId) => {
    try {
      const bridge = await import('./wormholeService.ts');
      const usdcAddr = bridge.WELL_KNOWN_USDC[chainId];
      const chainName = bridge.chainIdToName(chainId);

      const [usdcBalance, nativeBalance] = await Promise.all([
        usdcAddr
          ? bridge.getEvmTokenBalance(chainId, usdcAddr, walletAddress)
          : Promise.resolve(0),
        bridge.getEvmNativeBalance(chainId, walletAddress),
      ]);

      const nativePrice = await getNativeTokenPrice(chainId);
      const nativeSymbol = NATIVE_SYMBOLS[chainId] ?? 'ETH';

      return {
        chainId,
        chainName,
        usdcBalance,
        nativeBalance,
        nativeSymbol,
        nativeValueUsd: nativeBalance * nativePrice,
      } satisfies ChainBalance;
    } catch {
      return null;
    }
  });

  const settled = await Promise.all(promises);
  for (const r of settled) {
    if (r) results.push(r);
  }

  return results;
}

// ============================================================================
// Standalone rebalance (close + reopen in one call)
// ============================================================================

/**
 * Rebalance an out-of-range EVM LP position (close + reopen centred on current tick).
 *
 * @param posId           Position NFT token ID
 * @param chainId         Krystal-format chain ID (e.g. "arbitrum@42161")
 * @param chainNumericId  Numeric chain ID
 * @param rangeWidthTicks New range width in ticks
 * @param closeOnly       If true, just close without reopening
 *
 * Returns the close result + optional open result.
 */
export async function rebalanceEvmLpPosition(params: {
  posId: string;
  chainId: string;
  chainNumericId: number;
  rangeWidthTicks: number;
  closeOnly?: boolean;
  /** Token info for USD value estimation (improves rebalance deploy sizing) */
  token0?: { address: string; symbol: string; decimals: number };
  token1?: { address: string; symbol: string; decimals: number };
}): Promise<{
  closeResult: EvmLpCloseResult;
  openResult?: EvmLpOpenResult;
}> {
  const { posId, chainId, chainNumericId, rangeWidthTicks, closeOnly } = params;
  const env = getCFOEnv();

  // Step 1: Close existing position (pass token info for USD estimation)
  const closeResult = await closeEvmLpPosition({
    posId, chainId, chainNumericId,
    token0: params.token0,
    token1: params.token1,
  });
  if (!closeResult.success) {
    return { closeResult };
  }
  logger.info(`[Krystal] Rebalance: closed posId=${posId} | tx=${closeResult.txHash}`);

  if (closeOnly) {
    return { closeResult };
  }

  // Step 2: Discover current best pool on the same chain and reopen
  const pools = await discoverKrystalPools();
  const eligible = pools.filter(p =>
    p.chainNumericId === chainNumericId &&
    p.tvlUsd >= env.krystalLpMinTvlUsd,
  );

  if (eligible.length === 0) {
    logger.warn(`[Krystal] Rebalance: no eligible pools on chain ${chainNumericId} — close only`);
    return { closeResult };
  }

  const best = eligible[0]; // already sorted by score
  // Use recovered value if computed, otherwise fallback to 50% of max (conservative)
  const deployUsd = closeResult.valueRecoveredUsd > 1
    ? closeResult.valueRecoveredUsd
    : env.krystalLpMaxUsd * 0.5;

  const openResult = await openEvmLpPosition(
    {
      chainId: best.chainId,
      chainNumericId: best.chainNumericId,
      poolAddress: best.poolAddress,
      token0: best.token0,
      token1: best.token1,
      protocol: best.protocol,
      feeTier: best.feeTier,
    },
    deployUsd,
    rangeWidthTicks,
  );

  return { closeResult, openResult };
}
