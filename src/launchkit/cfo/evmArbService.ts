/**
 * EVM Flash Arbitrage Service — Arbitrum
 *
 * Dynamic pool discovery + atomic flash loan execution.
 *
 * Pool list: built from DeFiLlama yields API (public, no auth).
 *   Endpoint: https://yields.llama.fi/pools
 *   Filter: chain=Arbitrum, project in [uniswap-v3, camelot-v3, pancakeswap-amm-v3, balancer-v2], tvlUsd > MIN_POOL_TVL_USD
 *   Refresh: every CFO_EVM_ARB_POOL_REFRESH_MS (default 4h)
 *
 * Quoting: direct on-chain staticCall to QuoterV2 per venue.
 *   - Uniswap v3 QuoterV2:    quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96 })
 *   - Camelot v3 (Algebra):   quoteExactInput(path, amountIn) — path-encoded, dynamic fee
 *   - PancakeSwap v3 QuoterV2: quoteExactInputSingle({ ... }) — Uni V3 fork, same ABI as Uniswap
 *   - Balancer:               queryBatchSwap() — pool identified by bytes32 poolId
 *
 * Execution: ArbFlashReceiver.sol via Aave v3 flashLoanSimple().
 *   Worst case: tx reverts → gas cost only (~$0.05 on Arbitrum).
 *   Aave fee: 0.05% of flash amount.
 *
 * Key invariant: this module never holds or moves the EVM wallet's balance.
 * All capital is Aave's for the duration of one transaction.
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Arbitrum Contract Addresses (mainnet — verified)
// ============================================================================

const ARB_ADDRESSES = {
  // DEX Routers
  UNISWAP_V3_ROUTER:    '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  CAMELOT_V3_ROUTER:    '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
  PANCAKE_V3_ROUTER:    '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', // PCS SmartRouter (verified: factory() → PCS factory)
  BALANCER_VAULT:       '0xBA12222222228d8Ba445958a75a0704d566BF2C8',

  // Quoters (view-only — no gas cost via staticCall)
  UNISWAP_V3_QUOTER:    '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2
  CAMELOT_V3_QUOTER:    '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1', // NOTE: on-chain factory() returns SushiSwap V3 factory.
                                                                      // Not used — Camelot quotes use local pool-level math instead
                                                                      // (reads globalState + liquidity directly from pool contract).
  PANCAKE_V3_QUOTER:    '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', // PCS V3 QuoterV2 (verified: factory() → PCS factory)

  // DEX Factories (for resolving pool addresses from token pairs)
  UNISWAP_V3_FACTORY:   '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  CAMELOT_V3_FACTORY:   '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B',
  PANCAKE_V3_FACTORY:   '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // verified: getPool() returns valid pools

  // Aave v3
  AAVE_POOL:            '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
} as const;

// Aave v3 flash loan fee: 0.05%
const AAVE_FLASH_FEE_BPS = 5;

// DEX type — must match Solidity contract constants exactly
const DEX_UNISWAP_V3 = 0;
const DEX_CAMELOT_V3 = 1;
const DEX_BALANCER   = 2;
type DexType = typeof DEX_UNISWAP_V3 | typeof DEX_CAMELOT_V3 | typeof DEX_BALANCER;

// DeFiLlama project identifiers (Balancer discovery uses Balancer V3 API instead — see fetchBalancerPools)
const LLAMA_PROJECTS = new Set(['uniswap-v3', 'camelot-v3', 'pancakeswap-amm-v3']);

// Minimum pool TVL to include in candidate list ($100k — balances breadth vs noise)
const MIN_POOL_TVL_USD = 100_000;

// Flash loan sizes: scale with pool TVL. Cap at env.evmArbMaxFlashUsd.
// Larger = more profit per spread, but more price impact.
const FLASH_AMOUNT_FRACTION = 0.05;  // use 5% of pool TVL as flash size

// ============================================================================
// Types
// ============================================================================

export type DexId = 'uniswap_v3' | 'camelot_v3' | 'pancake_v3' | 'balancer';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * A single liquidity pool on one venue.
 * Built from DeFiLlama discovery + on-chain metadata fetch.
 */
export interface CandidatePool {
  poolAddress: string;        // EVM pool contract address
  poolId: string;             // bytes32 Balancer pool id (zero for Uni/Camelot)
  dex: DexId;
  dexType: DexType;
  router: string;
  quoter: string;
  token0: TokenMeta;
  token1: TokenMeta;
  feeTier: number;            // Uni v3: 500/3000/10000. Camelot: 0 (dynamic). Balancer: 0.
  tvlUsd: number;
  flashAmountUsd: number;     // computed flash size for this pool
  pairKey: string;            // canonical e.g. "0xabc...123_0xdef...456" (lower address first)
}

export interface ArbOpportunity {
  pairKey: string;
  displayPair: string;          // e.g. "USDC/WETH"
  flashLoanAsset: string;       // address of token to borrow from Aave
  flashLoanSymbol: string;
  flashAmountRaw: bigint;
  flashAmountUsd: number;
  buyPool: CandidatePool;
  sellPool: CandidatePool;
  tokenOut: TokenMeta;          // intermediate token
  expectedGrossUsd: number;
  aaveFeeUsd: number;
  gasEstimateUsd: number;
  netProfitUsd: number;
  detectedAt: number;
}

export interface ArbResult {
  success: boolean;
  txHash?: string;
  profitUsd?: number;
  error?: string;
}

// ============================================================================
// ABI Fragments
// ============================================================================

// Uniswap v3 QuoterV2 — struct-based input (V2 ABI, NOT the flat-param V1 ABI)
const UNI_QUOTER_ABI = [
  `function quoteExactInputSingle(
    tuple(
      address tokenIn, address tokenOut,
      uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96
    ) params
  ) external returns (
    uint256 amountOut, uint160 sqrtPriceX96After,
    uint32 initializedTicksCrossed, uint256 gasEstimate
  )`,
];

// Balancer queryBatchSwap — GIVEN_IN = 0
const BALANCER_VAULT_ABI = [
  `function queryBatchSwap(
    uint8 kind,
    tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    tuple(address sender, bool fromInternalBalance, address payable recipient, bool toInternalBalance) funds
  ) external returns (int256[] memory)`,
];

// ERC20 + Uniswap pool metadata
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const UNI_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee()    view returns (uint24)',
];

// ArbFlashReceiver
const RECEIVER_ABI = [
  'function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external',
];

// ============================================================================
// Lazy Arbitrum provider (same private key as Polygon, different RPC)
// ============================================================================

let _provider: any = null;
let _wallet: any   = null;
let _ethers: any   = null;

async function loadArb() {
  if (_wallet) return { provider: _provider, wallet: _wallet, ethers: _ethers };

  const mod = await import('ethers');
  _ethers = mod.ethers ?? mod;

  const env = getCFOEnv();
  if (!env.evmPrivateKey)
    throw new Error('[ArbMonitor] CFO_EVM_PRIVATE_KEY not set');

  _provider = new _ethers.JsonRpcProvider(env.arbitrumRpcUrl);
  _wallet   = new _ethers.Wallet(env.evmPrivateKey, _provider);

  logger.info(`[ArbMonitor] Arbitrum provider: ${env.arbitrumRpcUrl}`);
  logger.info(`[ArbMonitor] Wallet: ${_wallet.address}`);
  return { provider: _provider, wallet: _wallet, ethers: _ethers };
}

// ============================================================================
// Pool Discovery — DeFiLlama yields API + on-chain metadata
// ============================================================================

let _candidatePools: CandidatePool[] = [];
let _poolsRefreshedAt = 0;

/**
 * Fetch top Arbitrum pools from DeFiLlama and enrich with on-chain metadata.
 * Results cached for evmArbPoolRefreshMs (default 4h).
 *
 * DeFiLlama endpoint: https://yields.llama.fi/pools
 * Response: { status: 'ok', data: Array<{ chain, project, symbol, tvlUsd, pool, underlyingTokens, apyBase }> }
 * 'pool' field is the EVM pool contract address.
 * 'underlyingTokens' is the array of token addresses in the pool.
 *
 * For Uniswap v3 and Camelot v3 pools, we call the pool contract to get fee tier.
 * For Balancer pools, we need the poolId (bytes32) — fetched from Balancer Vault.
 * Token symbols and decimals are fetched on-chain from each token contract.
 */
export async function refreshCandidatePools(): Promise<CandidatePool[]> {
  const env = getCFOEnv();
  const refreshMs = env.evmArbPoolRefreshMs ?? 4 * 3600_000;

  if (_candidatePools.length > 0 && Date.now() - _poolsRefreshedAt < refreshMs) {
    return _candidatePools;
  }

  logger.info('[ArbMonitor] Refreshing candidate pool list from DeFiLlama...');

  try {
    const { provider, ethers } = await loadArb();

    // ── Fetch from DeFiLlama ────────────────────────────────────────────────
    const resp = await fetch('https://yields.llama.fi/pools');
    if (!resp.ok) throw new Error(`DeFiLlama yields API: ${resp.status}`);
    const data = await resp.json() as { status: string; data: any[] };

    // Filter: Arbitrum, supported DEXes, minimum TVL
    // Note: DeFiLlama `pool` field is a UUID, not an on-chain address.
    // Pool addresses are resolved via factory contracts in enrichPool().
    // Balancer pools with >2 tokens are included but only pairwise arbs are checked.
    const raw = data.data.filter((p: any) =>
      p.chain === 'Arbitrum' &&
      LLAMA_PROJECTS.has(p.project) &&
      (p.tvlUsd ?? 0) >= MIN_POOL_TVL_USD &&
      Array.isArray(p.underlyingTokens) &&
      p.underlyingTokens.length >= 2
    );

    // Take top pools per venue separately — smaller venues would otherwise be
    // squeezed out by Uniswap's higher TVL across all Arbitrum pools
    const uniPools = raw
      .filter((p: any) => p.project === 'uniswap-v3')
      .sort((a: any, b: any) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, 80);
    const camelotPools = raw
      .filter((p: any) => p.project === 'camelot-v3')
      .sort((a: any, b: any) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, 40);
    const pcsPools = raw
      .filter((p: any) => p.project === 'pancakeswap-amm-v3')
      .sort((a: any, b: any) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, 30);
    const top = [...uniPools, ...camelotPools, ...pcsPools];

    logger.info(
      `[ArbMonitor] DeFiLlama: ${raw.length} CLMM pools → enriching ${top.length} ` +
      `(${uniPools.length} Uni + ${camelotPools.length} Camelot + ${pcsPools.length} PCS)...`
    );

    // ── Enrich each DeFiLlama pool with on-chain metadata ──────────────────
    const pools: CandidatePool[] = [];

    // Batch on-chain calls with Promise.allSettled to avoid one failure blocking all
    const enriched = await Promise.allSettled(
      top.map((raw: any) => enrichPool(raw, provider, ethers))
    );

    for (const result of enriched) {
      if (result.status === 'fulfilled' && result.value) {
        pools.push(result.value);
      }
    }

    // ── Balancer pools from Balancer V3 API (DeFiLlama UUIDs can't resolve) ──
    const balancerPools = await fetchBalancerPools(provider, ethers);
    pools.push(...balancerPools);

    logger.info(`[ArbMonitor] Pool list ready: ${pools.length} pools (${
      pools.filter(p => p.dex !== 'balancer').length} CLMM + ${balancerPools.length} Bal) across ${
      new Set(pools.map(p => p.dex)).size
    } venues`);

    _candidatePools = pools;
    _poolsRefreshedAt = Date.now();
    return pools;

  } catch (err) {
    logger.warn('[ArbMonitor] Pool refresh failed, using cached list:', err);
    return _candidatePools; // return stale if available
  }
}

/**
 * Parse DeFiLlama poolMeta fee string to Uniswap v3 fee tier.
 * Examples: "0.01%" → 100, "0.05%" → 500, "0.3%" → 3000, "1%" → 10000
 */
function parsePoolMetaFee(poolMeta: string | undefined): number {
  if (!poolMeta) return 0;
  const match = poolMeta.match(/([\d.]+)%/);
  if (!match) return 0;
  const pct = parseFloat(match[1]);
  if (isNaN(pct) || pct <= 0) return 0;
  return Math.round(pct * 10_000); // 0.05% → 500, 0.3% → 3000
}

/**
 * Enrich a single DeFiLlama pool entry with on-chain token metadata and fee tier.
 * Returns null if the pool can't be used (e.g. missing data, non-ERC20 token).
 *
 * Pool addresses are resolved from factory contracts since DeFiLlama `pool` is a UUID.
 */
async function enrichPool(raw: any, provider: any, ethers: any): Promise<CandidatePool | null> {
  try {
    const env = getCFOEnv();
    const [t0addr, t1addr]: [string, string] = [
      raw.underlyingTokens[0].toLowerCase(),
      raw.underlyingTokens[1].toLowerCase(),
    ];

    // ── Map DeFiLlama project to our DexId ────────────────────────────────
    const dexMap: Record<string, DexId> = {
      'uniswap-v3': 'uniswap_v3',
      'camelot-v3': 'camelot_v3',
      'pancakeswap-amm-v3': 'pancake_v3',
      'balancer-v2': 'balancer',
    };
    const dex: DexId = dexMap[raw.project];
    const dexType: DexType = dex === 'uniswap_v3' ? DEX_UNISWAP_V3
      : dex === 'camelot_v3' ? DEX_CAMELOT_V3
      : dex === 'pancake_v3' ? DEX_UNISWAP_V3  // PCS V3 is a Uni V3 fork — same router ABI
      : DEX_BALANCER;

    const router = dex === 'uniswap_v3' ? ARB_ADDRESSES.UNISWAP_V3_ROUTER
      : dex === 'camelot_v3' ? ARB_ADDRESSES.CAMELOT_V3_ROUTER
      : dex === 'pancake_v3' ? ARB_ADDRESSES.PANCAKE_V3_ROUTER
      : ARB_ADDRESSES.BALANCER_VAULT;

    const quoter = dex === 'uniswap_v3' ? ARB_ADDRESSES.UNISWAP_V3_QUOTER
      : dex === 'camelot_v3' ? ARB_ADDRESSES.CAMELOT_V3_QUOTER
      : dex === 'pancake_v3' ? ARB_ADDRESSES.PANCAKE_V3_QUOTER
      : ARB_ADDRESSES.BALANCER_VAULT; // Balancer queryBatchSwap is on the vault

    // ── Fetch token metadata on-chain ──────────────────────────────────────
    const [t0, t1] = await Promise.all([
      fetchTokenMeta(t0addr, provider, ethers),
      fetchTokenMeta(t1addr, provider, ethers),
    ]);
    if (!t0 || !t1) return null;

    // ── Parse fee tier from DeFiLlama poolMeta (e.g. "0.05%" → 500) ───────
    // DeFiLlama `pool` field is a UUID, not an on-chain address.
    // Fee tiers and pool addresses are resolved from poolMeta + factory contracts.
    let feeTier = 0;
    let poolId = ethers.ZeroHash as string;
    let poolAddr = '';

    if (dex === 'uniswap_v3' || dex === 'pancake_v3') {
      // Parse fee from poolMeta string (e.g. "0.05%" → 500)
      feeTier = parsePoolMetaFee(raw.poolMeta);
      if (feeTier === 0) return null; // can't trade without fee tier

      // Resolve on-chain pool address from Factory (both Uni V3 and PCS V3 use getPool)
      const factoryAddr = dex === 'uniswap_v3'
        ? ARB_ADDRESSES.UNISWAP_V3_FACTORY
        : ARB_ADDRESSES.PANCAKE_V3_FACTORY;
      const factory = new ethers.Contract(factoryAddr, [
        'function getPool(address,address,uint24) view returns (address)',
      ], provider);
      poolAddr = (await factory.getPool(t0addr, t1addr, feeTier)).toLowerCase();
      if (!poolAddr || poolAddr === ethers.ZeroAddress) return null;

    } else if (dex === 'camelot_v3') {
      // Camelot (Algebra): fee is dynamic per pool, resolved by quoter. feeTier stays 0.
      const factory = new ethers.Contract(ARB_ADDRESSES.CAMELOT_V3_FACTORY, [
        'function poolByPair(address,address) view returns (address)',
      ], provider);
      poolAddr = (await factory.poolByPair(t0addr, t1addr)).toLowerCase();
      if (!poolAddr || poolAddr === ethers.ZeroAddress) return null;

    } else if (dex === 'balancer') {
      // Balancer pools are fetched directly from Balancer V3 API (see fetchBalancerPools).
      // This branch is unreachable since 'balancer-v2' was removed from LLAMA_PROJECTS.
      return null;
    }

    // ── Compute flash size ─────────────────────────────────────────────────
    const tvlUsd = raw.tvlUsd ?? 0;
    const maxFlash = env.evmArbMaxFlashUsd ?? 50_000;
    const flashAmountUsd = Math.min(tvlUsd * FLASH_AMOUNT_FRACTION, maxFlash);
    if (flashAmountUsd < 1000) return null; // too small to be worth it

    // ── Canonical pair key (lower address first for deduplication) ─────────
    const [lo, hi] = t0addr < t1addr ? [t0addr, t1addr] : [t1addr, t0addr];
    const pairKey = `${lo}_${hi}`;

    return {
      poolAddress: poolAddr,
      poolId,
      dex,
      dexType,
      router,
      quoter,
      token0: t0,
      token1: t1,
      feeTier,
      tvlUsd,
      flashAmountUsd,
      pairKey,
    };
  } catch {
    return null;
  }
}

// Cache token metadata to avoid redundant on-chain calls
const _tokenCache = new Map<string, TokenMeta>();

async function fetchTokenMeta(address: string, provider: any, ethers: any): Promise<TokenMeta | null> {
  if (_tokenCache.has(address)) return _tokenCache.get(address)!;
  try {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    const meta: TokenMeta = { address, symbol: String(symbol), decimals: Number(decimals) };
    _tokenCache.set(address, meta);
    return meta;
  } catch {
    return null;
  }
}

// ============================================================================
// Balancer Pool Discovery — Balancer V3 API (api-v3.balancer.fi)
// ============================================================================

/**
 * Fetch Balancer V2 pools from the Balancer V3 API.
 * DeFiLlama `pool` field is a UUID (not an on-chain address), so we use Balancer's
 * own API which provides pool addresses, poolIds, tokens, and TVL directly.
 *
 * Multi-token pools generate pairwise CandidatePool entries for each token pair
 * (e.g. a WBTC-WETH-USDC pool → 3 entries: WBTC/WETH, WBTC/USDC, WETH/USDC).
 */
async function fetchBalancerPools(provider: any, ethers: any): Promise<CandidatePool[]> {
  try {
    const query = `{
      poolGetPools(
        where: { chainIn: [ARBITRUM], minTvl: ${MIN_POOL_TVL_USD} }
        orderBy: totalLiquidity
        orderDirection: desc
        first: 20
      ) {
        id
        address
        name
        type
        dynamicData { totalLiquidity }
        poolTokens { address symbol decimals }
      }
    }`;

    const resp = await fetch('https://api-v3.balancer.fi/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) throw new Error(`Balancer API: ${resp.status}`);

    const data = await resp.json() as any;
    const apiPools = data.data?.poolGetPools;
    if (!apiPools?.length) return [];

    const env = getCFOEnv();
    const maxFlash = env.evmArbMaxFlashUsd ?? 50_000;
    const pools: CandidatePool[] = [];

    for (const p of apiPools) {
      // Only WEIGHTED, STABLE, COMPOSABLE_STABLE are standard pool types
      if (!['WEIGHTED', 'STABLE', 'COMPOSABLE_STABLE'].includes(p.type)) continue;

      const tvlUsd = parseFloat(p.dynamicData?.totalLiquidity ?? '0');
      if (tvlUsd < MIN_POOL_TVL_USD) continue;

      const poolAddr = p.address.toLowerCase();
      const poolId = p.id as string; // bytes32 poolId

      // Filter out BPT (pool's own token which appears in COMPOSABLE_STABLE pools)
      const tokens = (p.poolTokens ?? []).filter(
        (t: any) => t.address.toLowerCase() !== poolAddr
      );
      if (tokens.length < 2) continue;

      // Fetch on-chain metadata for all tokens in this pool (cached)
      const tokenMetas = await Promise.all(
        tokens.map((t: any) => fetchTokenMeta(t.address.toLowerCase(), provider, ethers))
      );

      // Generate pairwise CandidatePool entries for each valid token combination
      for (let i = 0; i < tokenMetas.length; i++) {
        for (let j = i + 1; j < tokenMetas.length; j++) {
          const t0 = tokenMetas[i];
          const t1 = tokenMetas[j];
          if (!t0 || !t1) continue;

          const flashAmountUsd = Math.min(tvlUsd * FLASH_AMOUNT_FRACTION, maxFlash);
          if (flashAmountUsd < 1000) continue;

          const [lo, hi] = t0.address < t1.address
            ? [t0.address, t1.address]
            : [t1.address, t0.address];

          pools.push({
            poolAddress: poolAddr,
            poolId,
            dex: 'balancer',
            dexType: DEX_BALANCER,
            router: ARB_ADDRESSES.BALANCER_VAULT,
            quoter: ARB_ADDRESSES.BALANCER_VAULT,
            token0: t0,
            token1: t1,
            feeTier: 0,
            tvlUsd,
            flashAmountUsd,
            pairKey: `${lo}_${hi}`,
          });
        }
      }
    }

    logger.info(`[ArbMonitor] Balancer API: ${apiPools.length} pools → ${pools.length} pairwise entries`);
    return pools;
  } catch (err) {
    logger.warn('[ArbMonitor] Balancer API fetch failed, skipping Balancer pools:', err);
    return [];
  }
}

// ============================================================================
// On-chain Quoting (staticCall — free, no gas)
// ============================================================================

/**
 * Quote Uniswap v3: quoteExactInputSingle with fee tier in the request.
 * Uses staticCall — simulates without broadcasting.
 */
async function quoteUniswapV3(
  quoterAddr: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, feeTier: number, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const quoter = new ethers.Contract(quoterAddr, UNI_QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0,
    });
    return result.amountOut as bigint;
  } catch (err) {
    logger.debug(`[ArbMonitor] Uniswap quote failed ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)}: ${(err as Error).message?.slice(0, 80)}`);
    return null;
  }
}

// Algebra pool ABI for local pool-level quoting (Camelot V3)
const ALGEBRA_POOL_ABI = [
  'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint16 communityFeeToken0, uint16 communityFeeToken1, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
];

/**
 * Quote Camelot v3 (Algebra): local concentrated-liquidity math.
 *
 * Reads pool's globalState() + liquidity() on-chain and computes output locally.
 * This avoids needing a deployed Algebra QuoterV2 contract (which is unresolved
 * on Arbitrum — the address 0x0524... belongs to SushiSwap, not Camelot).
 *
 * Math is identical to Uniswap V3 single-tick formula:
 *   zeroToOne: sqrtPNew = sqrtP * L / (L * Q96 + amountInAfterFee * sqrtP)
 *              amountOut = L * (sqrtP - sqrtPNew) / Q96
 *   oneToZero: sqrtPNew = sqrtP + amountInAfterFee * Q96 / L
 *              amountOut = L * (sqrtPNew - sqrtP) * Q96 / (sqrtPNew * sqrtP)
 *
 * Accurate for amounts that don't cross initialized ticks (our flash = 5% of TVL).
 */
async function quoteCamelotV3(
  poolAddress: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
    const [gs, liq, t0] = await Promise.all([
      pool.globalState(), pool.liquidity(), pool.token0(),
    ]);

    const sqrtP: bigint = gs.price;
    const L: bigint = liq;
    const fee: bigint = BigInt(gs.fee); // Algebra fee in 1e-6 units (e.g. 100 = 0.01%)
    if (L === 0n || sqrtP === 0n) return null;

    const Q96 = 1n << 96n;
    const amountInAfterFee = amountIn * (1_000_000n - fee) / 1_000_000n;
    const zeroToOne = tokenIn.toLowerCase() === t0.toLowerCase();

    let amountOut: bigint;
    if (zeroToOne) {
      // Selling token0, buying token1
      const num = sqrtP * L;
      const den = L * Q96 + amountInAfterFee * sqrtP;
      const sqrtPNew = num * Q96 / den;
      amountOut = L * (sqrtP - sqrtPNew) / Q96;
    } else {
      // Selling token1, buying token0
      const sqrtPNew = sqrtP + amountInAfterFee * Q96 / L;
      amountOut = L * Q96 * (sqrtPNew - sqrtP) / (sqrtPNew * sqrtP);
    }

    return amountOut > 0n ? amountOut : null;
  } catch (err) {
    logger.debug(`[ArbMonitor] Camelot quote failed ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)}: ${(err as Error).message?.slice(0, 80)}`);
    return null;
  }
}

/**
 * Quote Balancer: queryBatchSwap with GIVEN_IN (kind=0).
 * Returns negative int256 for output token (Balancer's sign convention).
 */
async function quoteBalancer(
  poolId: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const vault = new ethers.Contract(ARB_ADDRESSES.BALANCER_VAULT, BALANCER_VAULT_ABI, provider);
    const assets = [tokenIn, tokenOut];
    const swaps = [{ poolId, assetInIndex: 0, assetOutIndex: 1, amount: amountIn, userData: '0x' }];
    const funds = {
      sender: ethers.ZeroAddress, fromInternalBalance: false,
      recipient: ethers.ZeroAddress, toInternalBalance: false,
    };
    const deltas: bigint[] = await vault.queryBatchSwap(0, swaps, assets, funds);
    // deltas[1] is negative = vault pays out tokenOut
    const out = deltas[1] < 0n ? -deltas[1] : 0n;
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * Get a quote for tokenIn → tokenOut on a given pool.
 * Dispatches to the correct quoter based on pool.dex.
 */
async function getPoolQuote(
  pool: CandidatePool, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  if (pool.dex === 'uniswap_v3' || pool.dex === 'pancake_v3') {
    // Both use Uniswap V3 QuoterV2 ABI (PCS V3 is a Uni V3 fork)
    return quoteUniswapV3(pool.quoter, tokenIn, tokenOut, amountIn, pool.feeTier, ethers, provider);
  } else if (pool.dex === 'camelot_v3') {
    // Local pool-level math — reads globalState + liquidity from pool contract directly
    return quoteCamelotV3(pool.poolAddress, tokenIn, tokenOut, amountIn, ethers, provider);
  } else {
    return quoteBalancer(pool.poolId, tokenIn, tokenOut, amountIn, ethers, provider);
  }
}

// ============================================================================
// Opportunity Scanner
// ============================================================================

/**
 * Find the best arb opportunity across all candidate pool pairs.
 *
 * Algorithm:
 * 1. Group pools by pairKey (same token pair, different venues)
 * 2. For groups with 2+ pools: quote amountIn on all venues
 * 3. Pick best buy (highest tokenOut) and best sell (highest tokenIn back)
 * 4. Calculate net profit after Aave fee + gas
 * 5. Return best opportunity above threshold, or null
 *
 * @param ethPriceUsd   ETH price for gas cost conversion (from Analyst intel)
 */
export async function scanForOpportunity(ethPriceUsd: number): Promise<ArbOpportunity | null> {
  const env = getCFOEnv();
  if (!env.evmArbEnabled) return null;

  const { provider, ethers } = await loadArb();
  const pools = await refreshCandidatePools();
  if (pools.length === 0) return null;

  const minProfit = env.evmArbMinProfitUsdc ?? 2;

  // ── Group pools by pair ─────────────────────────────────────────────────
  const byPair = new Map<string, CandidatePool[]>();
  for (const pool of pools) {
    const arr = byPair.get(pool.pairKey) ?? [];
    arr.push(pool);
    byPair.set(pool.pairKey, arr);
  }

  const crossVenuePairs = [...byPair.entries()].filter(([, p]) => p.length >= 2);
  logger.info(
    `[ArbMonitor] ${byPair.size} unique pairs, ${crossVenuePairs.length} cross-venue ` +
    `(2+ venues). Top candidates: ${
      crossVenuePairs.slice(0, 5).map(([, p]) =>
        `${p[0].token0.symbol}/${p[0].token1.symbol}(${p.map(pp => pp.dex).join('+')})`
      ).join(', ') || 'none'
    }`
  );

  if (crossVenuePairs.length === 0) {
    logger.warn('[ArbMonitor] No cross-venue pairs — pool fetch or Camelot quoter issue');
    return null;
  }

  let best: ArbOpportunity | null = null;

  // ── Fetch live gas price for accurate cost estimation ─────────────────────
  let gasPriceGwei = 0.1; // fallback: 0.1 gwei on Arbitrum
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice) gasPriceGwei = Number(feeData.gasPrice) / 1e9;
  } catch { /* use fallback */ }

  for (const [pairKey, pairPools] of byPair) {
    if (pairPools.length < 2) continue; // need at least 2 venues to arb

    // Determine which token to use as flash loan asset (prefer USDC/USDT/WETH — Aave listed)
    // Aave v3 Arbitrum supports: USDC, USDC.e, WETH, WBTC, ARB, LINK, DAI
    const AAVE_LISTED = new Set([
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC native
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
      '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
      '0xf97f4df75117a78c1a5a0dbb814af92458539fb4', // LINK
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    ]);

    const pool0 = pairPools[0];
    const t0 = pool0.token0.address;
    const t1 = pool0.token1.address;

    // Flash loan asset = whichever token is Aave-listed (prefer token0)
    const flashAsset = AAVE_LISTED.has(t0) ? pool0.token0
      : AAVE_LISTED.has(t1) ? pool0.token1
      : null;
    if (!flashAsset) continue;

    const tokenOut = flashAsset.address === t0 ? pool0.token1 : pool0.token0;

    // Flash amount: smallest pool's computed size (conservative)
    const flashAmountUsd = Math.min(...pairPools.map(p => p.flashAmountUsd));
    const flashAmountRaw = BigInt(
      Math.floor(flashAmountUsd * 10 ** flashAsset.decimals)
    );

    try {
      // ── Quote buy leg: flashAsset → tokenOut on each venue ───────────────
      const buyQuotes: Array<{ pool: CandidatePool; amountOut: bigint }> = [];
      await Promise.all(pairPools.map(async pool => {
        const out = await getPoolQuote(pool, flashAsset.address, tokenOut.address, flashAmountRaw, ethers, provider);
        if (out && out > 0n) buyQuotes.push({ pool, amountOut: out });
      }));
      if (buyQuotes.length < 2) continue;

      // Best buy = most tokenOut for our flashAsset
      buyQuotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
      const buyBest = buyQuotes[0];

      // ── Quote sell leg: tokenOut → flashAsset, on remaining venues ────────
      // Use the OTHER pools (not the buy pool) for sell leg
      const sellCandidates = pairPools.filter(p => p.poolAddress !== buyBest.pool.poolAddress);
      const sellQuotes: Array<{ pool: CandidatePool; amountOut: bigint }> = [];

      await Promise.all(sellCandidates.map(async pool => {
        const out = await getPoolQuote(pool, tokenOut.address, flashAsset.address, buyBest.amountOut, ethers, provider);
        if (out && out > 0n) sellQuotes.push({ pool, amountOut: out });
      }));
      if (sellQuotes.length === 0) continue;

      sellQuotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
      const sellBest = sellQuotes[0];

      // ── Profit calculation ─────────────────────────────────────────────────
      if (sellBest.amountOut <= flashAmountRaw) continue; // no gross profit

      const grossRaw = sellBest.amountOut - flashAmountRaw;
      const grossUsd = Number(grossRaw) / (10 ** flashAsset.decimals);
      const aaveFeeUsd = flashAmountUsd * (AAVE_FLASH_FEE_BPS / 10_000);
      // Gas: ~800k units × live gas price (gwei) → ETH → USD
      const gasEstimateUsd = (800_000 * gasPriceGwei * 1e-9) * ethPriceUsd;
      const netProfitUsd = grossUsd - aaveFeeUsd - gasEstimateUsd;

      if (netProfitUsd < minProfit) continue;

      const displayPair = `${flashAsset.symbol}/${tokenOut.symbol}`;
      logger.info(
        `[ArbMonitor] 💡 ${displayPair} | ${buyBest.pool.dex}→${sellBest.pool.dex} | ` +
        `gross:$${grossUsd.toFixed(3)} aave:$${aaveFeeUsd.toFixed(3)} ` +
        `gas:$${gasEstimateUsd.toFixed(3)} net:$${netProfitUsd.toFixed(3)}`
      );

      const opp: ArbOpportunity = {
        pairKey,
        displayPair,
        flashLoanAsset: flashAsset.address,
        flashLoanSymbol: flashAsset.symbol,
        flashAmountRaw,
        flashAmountUsd,
        buyPool: buyBest.pool,
        sellPool: sellBest.pool,
        tokenOut,
        expectedGrossUsd: grossUsd,
        aaveFeeUsd,
        gasEstimateUsd,
        netProfitUsd,
        detectedAt: Date.now(),
      };

      if (!best || opp.netProfitUsd > best.netProfitUsd) best = opp;

    } catch (err) {
      logger.debug(`[ArbMonitor] Pair ${pairKey} scan error:`, err);
    }
  }

  return best;
}

// ============================================================================
// Flash Loan Executor
// ============================================================================

export async function executeFlashArb(opp: ArbOpportunity, ethPriceUsd = 3000): Promise<ArbResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(
      `[ArbMonitor] DRY RUN — ${opp.displayPair} | ` +
      `${opp.buyPool.dex}→${opp.sellPool.dex} | net:$${opp.netProfitUsd.toFixed(3)}`
    );
    return { success: true, profitUsd: opp.netProfitUsd, txHash: `dry-arb-${Date.now()}` };
  }

  // ── Staleness guard: quotes drift fast, reject opportunities older than 30s ──
  const ageMs = Date.now() - opp.detectedAt;
  if (ageMs > 30_000) {
    logger.warn(`[ArbMonitor] Stale opportunity — detected ${(ageMs / 1000).toFixed(0)}s ago, skipping`);
    return { success: false, error: `Opportunity stale (${(ageMs / 1000).toFixed(0)}s old)` };
  }

  if (!env.evmArbReceiverAddress) {
    return { success: false, error: 'CFO_EVM_ARB_RECEIVER_ADDRESS not set — deploy contract first' };
  }

  const { wallet, ethers } = await loadArb();

  // minProfit = 80% of expected (allows small quote drift between scan and execution)
  const minProfitRaw = BigInt(Math.floor(opp.netProfitUsd * 0.8 * 10 ** 6));

  const dexTypeFor = (pool: CandidatePool): number =>
    pool.dex === 'uniswap_v3' ? DEX_UNISWAP_V3
    : pool.dex === 'pancake_v3' ? DEX_UNISWAP_V3  // PCS V3 fork — same swap ABI as Uni V3
    : pool.dex === 'camelot_v3' ? DEX_CAMELOT_V3
    : DEX_BALANCER;

  // Encode params for ArbFlashReceiver.executeOperation()
  const params = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address','uint8','bytes32','uint24','address','uint8','bytes32','uint24','address','uint256'],
    [
      opp.buyPool.router,
      dexTypeFor(opp.buyPool),
      opp.buyPool.poolId,
      opp.buyPool.feeTier,
      opp.sellPool.router,
      dexTypeFor(opp.sellPool),
      opp.sellPool.poolId,
      opp.sellPool.feeTier,
      opp.tokenOut.address,
      minProfitRaw,
    ]
  );

  const receiver = new ethers.Contract(env.evmArbReceiverAddress, RECEIVER_ABI, wallet);

  logger.info(
    `[ArbMonitor] 🚀 ${opp.displayPair} | ${opp.buyPool.dex}→${opp.sellPool.dex} | ` +
    `flash:$${opp.flashAmountUsd.toLocaleString()} | est net:$${opp.netProfitUsd.toFixed(3)}`
  );

  try {
    const tx      = await receiver.requestFlashLoan(opp.flashLoanAsset, opp.flashAmountRaw, params, { gasLimit: 1_400_000 });
    const receipt = await tx.wait(1);

    if (receipt.status === 0) {
      return { success: false, txHash: tx.hash, error: 'Reverted — spread closed before execution' };
    }

    // Estimate actual gas cost
    const gasUsedEth = Number(receipt.gasUsed) * Number(receipt.gasPrice ?? 0) / 1e18;
    const actualGasCostUsd = gasUsedEth * ethPriceUsd;
    const estimatedActualProfit = opp.expectedGrossUsd - opp.aaveFeeUsd - actualGasCostUsd;

    logger.info(
      `[ArbMonitor] ✅ Confirmed | ${opp.displayPair} | tx:${tx.hash} | ` +
      `gas:${Number(receipt.gasUsed).toLocaleString()} | est profit:$${estimatedActualProfit.toFixed(3)}`
    );

    return { success: true, txHash: tx.hash, profitUsd: estimatedActualProfit };

  } catch (err: any) {
    logger.error(`[ArbMonitor] Execution failed: ${err?.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ============================================================================
// Status helpers
// ============================================================================

export async function getArbUsdcBalance(): Promise<number> {
  try {
    const { wallet, ethers, provider } = await loadArb();
    const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const usdc = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
    return Number(await usdc.balanceOf(wallet.address)) / 1e6;
  } catch { return 0; }
}

export function getCandidatePoolCount(): number { return _candidatePools.length; }
export function getPoolsRefreshedAt(): number    { return _poolsRefreshedAt; }

// ── 24h profit tracker (in-memory, resets on restart) ──────────────────────
const _profitLog: Array<{ timestamp: number; profitUsd: number }> = [];
let _profitHydrated = false;

export function recordProfit(profitUsd: number): void {
  _profitLog.push({ timestamp: Date.now(), profitUsd });
  const cutoff = Date.now() - 48 * 3600_000;
  while (_profitLog.length > 0 && _profitLog[0].timestamp < cutoff) _profitLog.shift();
}

export function getProfit24h(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return _profitLog.filter(p => p.timestamp >= cutoff).reduce((s, p) => s + p.profitUsd, 0);
}

/**
 * One-shot hydration: load confirmed arb profits from the DB so in-memory
 * tracker survives process restarts. Call once at startup or first cycle.
 */
export async function hydrateProfit24hFromDb(pool: any): Promise<void> {
  if (_profitHydrated || !pool) return;
  try {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await pool.query(
      `SELECT timestamp, metadata->>'netProfitUsd' AS profit
       FROM cfo_transactions
       WHERE strategy_tag = 'evm_flash_arb' AND status = 'confirmed'
         AND timestamp >= $1
       ORDER BY timestamp ASC`,
      [cutoff],
    );
    let count = 0;
    for (const row of res.rows) {
      const profitUsd = parseFloat(row.profit);
      if (!isNaN(profitUsd) && profitUsd > 0) {
        const ts = new Date(row.timestamp).getTime();
        // Avoid duplicates: only add if not already in the log
        if (!_profitLog.some(p => Math.abs(p.timestamp - ts) < 5000)) {
          _profitLog.push({ timestamp: ts, profitUsd });
          count++;
        }
      }
    }
    _profitHydrated = true;
    if (count > 0) logger.info(`[ArbMonitor] Hydrated ${count} arb profits from DB (24h total: $${getProfit24h().toFixed(2)})`);
  } catch (err) {
    logger.debug('[ArbMonitor] DB profit hydration failed (non-fatal):', err);
  }
}
