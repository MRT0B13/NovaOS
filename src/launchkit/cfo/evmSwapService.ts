/**
 * EVM Swap Service
 *
 * Same-chain token swaps on EVM via Uniswap V3 SwapRouter02.
 * Fallback 1: LI.FI swap API (all chains, any token).
 * Fallback 2: Aerodrome/Velodrome Router v2 (Base / Optimism) — handles tokens
 *             that only trade on Aerodrome (e.g. VIRTUAL, AERO, VELO).
 *             Routes: direct USDC→TOKEN or 2-hop USDC→WETH→TOKEN.
 *
 * SwapRouter02:  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45  (universal all chains)
 * QuoterV2:      0x61fFE014bA17989E743c5F6cB21bF9697530B21e  (universal all chains)
 *
 * Uniswap V3 supported chains:
 *   1 (ETH), 10 (OP), 137 (Polygon), 8453 (Base), 42161 (Arb),
 *   43114 (Avax), 324 (zkSync), 534352 (Scroll), 59144 (Linea)
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Swap Failure Cache
// ============================================================================

// Tracks token+chain combos where swap quotes have recently failed.
// Key: `${chainId}_${tokenAddr.toLowerCase()}`, Value: timestamp
// TTL: 2 hours — prevents the engine from repeatedly bridging then failing on
// the same unswappable token (e.g. VIRTUAL on Uniswap V3).
const _swapFailureCache = new Map<string, number>();
const SWAP_FAILURE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

export function recordSwapFailure(chainId: number, tokenAddr: string): void {
  _swapFailureCache.set(`${chainId}_${tokenAddr.toLowerCase()}`, Date.now());
}

export function hasSwapFailure(chainId: number, tokenAddr: string): boolean {
  const key = `${chainId}_${tokenAddr.toLowerCase()}`;
  const ts = _swapFailureCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > SWAP_FAILURE_TTL_MS) {
    _swapFailureCache.delete(key);
    return false;
  }
  return true;
}

/**
 * Quick pre-flight check: can we swap USDC → tokenAddr on this chain?
 * Uses QuoterV2 with a $2 probe. Returns true if any standard fee tier quotes.
 * Also checks LIFI as fallback. Caches failures for 2h.
 */
export async function canSwapFromUsdc(
  chainId: number,
  usdcAddr: string,
  tokenAddr: string,
): Promise<boolean> {
  // Already known to fail
  if (hasSwapFailure(chainId, tokenAddr)) return false;
  // USDC→USDC is trivially true
  if (tokenAddr.toLowerCase() === usdcAddr.toLowerCase()) return true;

  const quote = await quoteEvmSwap(chainId, usdcAddr, tokenAddr, 2);
  if (quote) return true;
  recordSwapFailure(chainId, tokenAddr);
  logger.warn(`[EvmSwap] Pre-flight: no swap route USDC→${tokenAddr.slice(0, 10)} on chain ${chainId} — recording failure (2h)`);
  return false;
}

// ============================================================================
// Constants
// ============================================================================

/** Default SwapRouter02 / QuoterV2 — works on ETH, OP, Polygon, Arb, etc. */
const DEFAULT_SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const DEFAULT_QUOTER_V2   = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

/** Chain-specific overrides (Base & newer chains use different deployer addresses) */
const CHAIN_SWAP_ROUTER: Record<number, string> = {
  56:     '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', // PancakeSwap V3 SmartRouter (BSC)
  8453:   '0x2626664c2603336E57B271c5C0b26F421741e481', // Base
  43114:  '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE', // Avalanche
};
const CHAIN_QUOTER_V2: Record<number, string> = {
  56:     '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', // PancakeSwap V3 QuoterV2 (BSC)
  8453:   '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // Base
  43114:  '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F', // Avalanche
};

function getSwapRouter(chainId: number): string {
  return CHAIN_SWAP_ROUTER[chainId] ?? DEFAULT_SWAP_ROUTER;
}
function getQuoterV2(chainId: number): string {
  return CHAIN_QUOTER_V2[chainId] ?? DEFAULT_QUOTER_V2;
}

const LIFI_API_BASE = 'https://li.quest/v1';

// ── Aerodrome / Velodrome Router v2 ─────────────────────────────────────────
// These are the primary DEX on Base/Optimism — many tokens ONLY exist here
// (VIRTUAL, AERO, VELO, etc.) and have no Uniswap V3 pools.
const AERODROME_ROUTER: Record<number, string> = {
  8453: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', // Aerodrome on Base
  10:   '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858', // Velodrome on Optimism
};
const AERODROME_VOLATILE_FACTORY: Record<number, string> = {
  8453: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome volatile factory
  10:   '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746', // Velodrome volatile factory
};
// WETH address per chain (needed for 2-hop USDC→WETH→TOKEN routes)
const WETH_ADDR: Record<number, string> = {
  1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  10:    '0x4200000000000000000000000000000000000006',
  56:    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  137:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  8453:  '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  43114: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
};

const AERODROME_ROUTER_ABI = [
  // getAmountsOut for quoting (view — no gas)
  'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  // swap execution
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
];

/** Chains where Uniswap V3 / PancakeSwap V3 SwapRouter02 is deployed */
const UNISWAP_V3_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 324, 534352, 59144]);

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

// ============================================================================
// Types
// ============================================================================

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;         // human readable
  amountOut: number;        // expected output (human readable)
  fee: number;              // Uniswap fee tier (e.g. 3000)
  priceImpactPct: number;   // rough estimate
  route: 'uniswap_v3' | 'lifi' | 'aerodrome';  // which router used
  gasEstimate?: number;     // gas units
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  route: 'uniswap_v3' | 'lifi' | 'aerodrome';
  error?: string;
}

// ============================================================================
// Quote
// ============================================================================

/**
 * Get a quote for swapping tokenIn → tokenOut on a given chain.
 * Tries Uniswap V3 QuoterV2 first, falls back to LI.FI.
 *
 * @param chainId       Numeric chain ID
 * @param tokenInAddr   ERC-20 address of input token
 * @param tokenOutAddr  ERC-20 address of output token
 * @param amountInHuman Human-readable input amount
 * @param feeTier       Uniswap fee tier (100, 500, 3000, 10000) — default 3000
 */
export async function quoteEvmSwap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  feeTier = 3000,
): Promise<SwapQuote | null> {
  // Standard Uniswap V3 fee tiers — try the requested tier first, then fall back
  // to common tiers. Aerodrome/Slipstream pools pass non-standard fee tiers (e.g. 668, 471)
  // which don't correspond to any Uniswap V3 pool → quote silently fails.
  const STANDARD_TIERS = [500, 3000, 10000, 100];
  const isStandardTier = STANDARD_TIERS.includes(feeTier);
  const tiersToTry = isStandardTier
    ? [feeTier, ...STANDARD_TIERS.filter(t => t !== feeTier)]
    : STANDARD_TIERS; // Non-standard tier (Aerodrome etc.) — skip it, only try standard

  // Try Uniswap V3 on supported chains (multiple fee tiers)
  if (UNISWAP_V3_CHAINS.has(chainId)) {
    for (const tier of tiersToTry) {
      const uniQuote = await quoteViaUniswap(chainId, tokenInAddr, tokenOutAddr, amountInHuman, tier);
      if (uniQuote) return uniQuote;
    }
  }

  // Fallback 1: LI.FI swap API (works on any chain)
  const lifiQuote = await quoteViaLifi(chainId, tokenInAddr, tokenOutAddr, amountInHuman);
  if (lifiQuote) return lifiQuote;

  // Fallback 2: Aerodrome/Velodrome Router v2 (Base / Optimism)
  // Many tokens (VIRTUAL, AERO, VELO, SONNE etc.) ONLY exist on Aerodrome/Velodrome
  // and have no Uniswap V3 or LIFI support.
  if (AERODROME_ROUTER[chainId]) {
    const aeroQuote = await quoteViaAerodrome(chainId, tokenInAddr, tokenOutAddr, amountInHuman);
    if (aeroQuote) return aeroQuote;
  }

  return null;
}

async function quoteViaUniswap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  feeTier: number,
): Promise<SwapQuote | null> {
  try {
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const ethers = await import('ethers' as string);
    const provider = await getEvmProvider(chainId);

    // Get input token decimals
    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = Number(await inToken.decimals().catch(() => 18));
    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals);

    // Call QuoterV2 (staticCall — doesn't consume gas)
    const quoter = new ethers.Contract(getQuoterV2(chainId), QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      amountIn: amountInRaw,
      fee: feeTier,
      sqrtPriceLimitX96: BigInt(0),
    });

    const amountOutRaw = result[0] ?? result.amountOut;
    const sqrtPriceX96After = result[1] ?? BigInt(0);
    const gasEstimate = Number(result[3] ?? result.gasEstimate ?? 200_000);

    // Get output token decimals
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = Number(await outToken.decimals().catch(() => 18));
    const amountOut = Number(ethers.formatUnits(amountOutRaw, outDecimals));

    // Compute price impact from sqrtPriceX96 shift (works for cross-asset swaps)
    // Read current sqrtPriceX96 from pool for comparison
    let priceImpactPct = 0;
    try {
      // PancakeSwap V3 uses a different factory on BSC
      const CHAIN_POOL_FACTORY: Record<number, string> = {
        56: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3 (BSC)
      };
      const poolFactoryAddr = CHAIN_POOL_FACTORY[chainId] ?? '0x1F98431c8aD98523631AE4a59f267346ea31F984';
      const factoryAbi = ['function getPool(address,address,uint24) view returns (address)'];
      const factory = new ethers.Contract(poolFactoryAddr, factoryAbi, provider);
      const poolAddr = await factory.getPool(tokenInAddr, tokenOutAddr, feeTier);
      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const poolAbi = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
        const pool = new ethers.Contract(poolAddr, poolAbi, provider);
        const slot0 = await pool.slot0();
        const sqrtPriceBefore = Number(slot0[0]);
        const sqrtPriceAfter = Number(sqrtPriceX96After);
        if (sqrtPriceBefore > 0 && sqrtPriceAfter > 0) {
          // Price impact = |1 - (priceAfter / priceBefore)| × 100
          // price ∝ sqrtPrice², so ratio = (sqrtAfter/sqrtBefore)²
          const ratio = (sqrtPriceAfter / sqrtPriceBefore) ** 2;
          priceImpactPct = Math.abs(1 - ratio) * 100;
        }
      }
    } catch {
      // Non-fatal — impact stays 0 (no guard will fire)
    }

    return {
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      amountIn: amountInHuman,
      amountOut,
      fee: feeTier,
      priceImpactPct,
      route: 'uniswap_v3',
      gasEstimate,
    };
  } catch (err) {
    logger.warn(`[EvmSwap] Uniswap V3 quote failed (chain ${chainId}, fee ${feeTier}): ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

async function quoteViaLifi(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
): Promise<SwapQuote | null> {
  try {
    const ethers = await import('ethers' as string);
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const provider = await getEvmProvider(chainId);

    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = Number(await inToken.decimals().catch(() => 18));
    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals).toString();

    // LI.FI supports same-chain swaps via /quote with fromChain === toChain
    const env = getCFOEnv();
    const walletAddr = env.evmPrivateKey
      ? ethers.computeAddress(env.evmPrivateKey)
      : '0x0000000000000000000000000000000000000001';

    const params = new URLSearchParams({
      fromChain: chainId.toString(),
      toChain: chainId.toString(),
      fromToken: tokenInAddr,
      toToken: tokenOutAddr,
      fromAmount: amountInRaw,
      fromAddress: walletAddr,
      toAddress: walletAddr,
      slippage: '0.005',
    });

    const resp = await fetch(`${LIFI_API_BASE}/quote?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.warn(`[EvmSwap] LI.FI quote ${resp.status} on chain ${chainId} ($${amountInHuman.toFixed(2)} ${tokenInAddr.slice(0,10)}→${tokenOutAddr.slice(0,10)}): ${body.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json() as any;
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = Number(await outToken.decimals().catch(() => 18));
    const amountOut = Number(data.estimate?.toAmount ?? 0) / 10 ** outDecimals;

    return {
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      amountIn: amountInHuman,
      amountOut,
      fee: 0,
      priceImpactPct: 0,
      route: 'lifi',
    };
  } catch (err) {
    logger.warn(`[EvmSwap] LI.FI quote failed on chain ${chainId} (${tokenInAddr.slice(0,10)}→${tokenOutAddr.slice(0,10)}, $${amountInHuman.toFixed(2)}): ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Quote via Aerodrome (Base) / Velodrome (Optimism) Router v2.
 * Tries direct route first, then 2-hop via WETH.
 * Handles tokens with no Uniswap V3 pool (VIRTUAL, AERO, VELO, etc.)
 */
async function quoteViaAerodrome(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
): Promise<SwapQuote | null> {
  const routerAddr = AERODROME_ROUTER[chainId];
  const factory = AERODROME_VOLATILE_FACTORY[chainId] ?? '0x0000000000000000000000000000000000000000';
  if (!routerAddr) return null;

  try {
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const ethers = await import('ethers' as string);
    const provider = await getEvmProvider(chainId);

    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const [inDecimals, outDecimals] = await Promise.all([
      inToken.decimals().then(Number).catch(() => 18),
      outToken.decimals().then(Number).catch(() => 18),
    ]);
    const amountInRaw = ethers.parseUnits(amountInHuman.toFixed(inDecimals), inDecimals);

    const router = new ethers.Contract(routerAddr, AERODROME_ROUTER_ABI, provider);

    // Try direct volatile route: tokenIn → tokenOut
    const directRoutes = [{ from: tokenInAddr, to: tokenOutAddr, stable: false, factory }];
    try {
      const amounts = await router.getAmountsOut(amountInRaw, directRoutes);
      const amountOut = Number(ethers.formatUnits(amounts[amounts.length - 1], outDecimals));
      if (amountOut > 0) {
        logger.debug(`[EvmSwap] Aerodrome direct quote: $${amountInHuman.toFixed(2)} → ${amountOut.toFixed(6)} on chain ${chainId}`);
        return { tokenIn: tokenInAddr, tokenOut: tokenOutAddr, amountIn: amountInHuman, amountOut, fee: 0, priceImpactPct: 0, route: 'aerodrome' };
      }
    } catch { /* no direct pool — try 2-hop */ }

    // Try 2-hop route via WETH: tokenIn → WETH → tokenOut
    const wethAddr = WETH_ADDR[chainId];
    if (wethAddr && tokenInAddr.toLowerCase() !== wethAddr.toLowerCase() && tokenOutAddr.toLowerCase() !== wethAddr.toLowerCase()) {
      const hopRoutes = [
        { from: tokenInAddr, to: wethAddr,    stable: false, factory },
        { from: wethAddr,    to: tokenOutAddr, stable: false, factory },
      ];
      try {
        const amounts = await router.getAmountsOut(amountInRaw, hopRoutes);
        const amountOut = Number(ethers.formatUnits(amounts[amounts.length - 1], outDecimals));
        if (amountOut > 0) {
          logger.debug(`[EvmSwap] Aerodrome 2-hop quote (→WETH→): $${amountInHuman.toFixed(2)} → ${amountOut.toFixed(6)} on chain ${chainId}`);
          return { tokenIn: tokenInAddr, tokenOut: tokenOutAddr, amountIn: amountInHuman, amountOut, fee: 0, priceImpactPct: 0, route: 'aerodrome' };
        }
      } catch { /* 2-hop also failed */ }
    }

    logger.debug(`[EvmSwap] Aerodrome: no route found for ${tokenInAddr.slice(0,10)}→${tokenOutAddr.slice(0,10)} on chain ${chainId}`);
    return null;
  } catch (err) {
    logger.debug(`[EvmSwap] Aerodrome quote failed (chain ${chainId}): ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

// ============================================================================
// Execute
// ============================================================================

/**
 * Execute a swap on a given EVM chain.
 * Uses Uniswap V3 SwapRouter02 on supported chains, LI.FI elsewhere.
 */
export async function executeEvmSwap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  feeTier = 3000,
  slippagePct = 2,
): Promise<SwapResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(
      `[EvmSwap] DRY RUN — would swap ${amountInHuman} ` +
      `(${tokenInAddr.slice(0, 10)}→${tokenOutAddr.slice(0, 10)}) on chain ${chainId}`,
    );
    return { success: true, txHash: `dry-swap-${Date.now()}`, amountIn: amountInHuman, amountOut: amountInHuman * 0.998, route: 'uniswap_v3' };
  }

  // Get quote first to determine route + expected output
  const quote = await quoteEvmSwap(chainId, tokenInAddr, tokenOutAddr, amountInHuman, feeTier);
  if (!quote) {
    return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'uniswap_v3', error: 'No swap route available' };
  }

  if (quote.route === 'uniswap_v3') {
    // Use quote.fee (the tier that actually got a quote) — may differ from the
    // requested feeTier if we fell back to a standard tier during quoting.
    return executeViaUniswap(chainId, tokenInAddr, tokenOutAddr, amountInHuman, quote.fee, slippagePct, quote.amountOut);
  } else if (quote.route === 'aerodrome') {
    return executeViaAerodrome(chainId, tokenInAddr, tokenOutAddr, amountInHuman, quote.amountOut, slippagePct);
  } else {
    return executeViaLifiSwap(chainId, tokenInAddr, tokenOutAddr, amountInHuman);
  }
}

async function executeViaUniswap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  feeTier: number,
  slippagePct: number,
  expectedOut: number,
): Promise<SwapResult> {
  try {
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const ethers = await import('ethers' as string);
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = await getEvmProvider(chainId);
    const wallet = new ethers.Wallet(env.evmPrivateKey, provider);

    // Decimals
    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, wallet);
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const [inDecimals, outDecimals] = await Promise.all([
      inToken.decimals().then(Number).catch(() => 18),
      outToken.decimals().then(Number).catch(() => 18),
    ]);

    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals);
    const amountOutMinRaw = ethers.parseUnits(
      (expectedOut * (1 - slippagePct / 100)).toFixed(outDecimals),
      outDecimals,
    );

    // Approve
    const swapRouterAddr = getSwapRouter(chainId);
    const allowance = await inToken.allowance(wallet.address, swapRouterAddr);
    if (allowance < amountInRaw) {
      // Reset allowance to 0 first for non-standard tokens (USDT on ETH mainnet)
      if (allowance > BigInt(0)) {
        try {
          const resetTx = await inToken.approve(swapRouterAddr, 0);
          await resetTx.wait();
        } catch { /* non-fatal */ }
      }
      const approveTx = await inToken.approve(swapRouterAddr, ethers.MaxUint256);
      await approveTx.wait();
      logger.info(`[EvmSwap] Approved ${tokenInAddr.slice(0, 10)} for SwapRouter02`);
    }

    // Execute swap
    const router = new ethers.Contract(swapRouterAddr, SWAP_ROUTER_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const tx = await router.exactInputSingle({
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      fee: feeTier,
      recipient: wallet.address,
      amountIn: amountInRaw,
      amountOutMinimum: amountOutMinRaw,
      sqrtPriceLimitX96: BigInt(0),
    });

    const receipt = await tx.wait();
    logger.info(`[EvmSwap] Swap executed: ${amountInHuman} → ~${expectedOut.toFixed(4)} on chain ${chainId} tx=${receipt.hash}`);

    return {
      success: true,
      txHash: receipt.hash,
      amountIn: amountInHuman,
      amountOut: expectedOut,
      route: 'uniswap_v3',
    };
  } catch (err) {
    return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'uniswap_v3', error: (err as Error).message };
  }
}

async function executeViaLifiSwap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
): Promise<SwapResult> {
  try {
    const ethers = await import('ethers' as string);
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = await getEvmProvider(chainId);
    const wallet = new ethers.Wallet(env.evmPrivateKey, provider);

    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = Number(await inToken.decimals().catch(() => 18));
    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals).toString();

    // Get LI.FI quote (same-chain swap)
    const params = new URLSearchParams({
      fromChain: chainId.toString(),
      toChain: chainId.toString(),
      fromToken: tokenInAddr,
      toToken: tokenOutAddr,
      fromAmount: amountInRaw,
      fromAddress: wallet.address,
      toAddress: wallet.address,
      slippage: '0.005',
    });

    const resp = await fetch(`${LIFI_API_BASE}/quote?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`LI.FI swap quote failed: ${resp.status}`);

    const data = await resp.json() as any;

    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = Number(await outToken.decimals().catch(() => 18));
    const amountOut = Number(data.estimate?.toAmount ?? 0) / 10 ** outDecimals;

    // ── Same-chain: send transactionRequest directly (no SDK needed) ──
    // The LI.FI /quote response includes a ready-to-send transactionRequest
    // for same-chain swaps. Using executeRoute() can crash on missing `steps`.
    if (data.transactionRequest) {
      const txReq = data.transactionRequest;

      // Approve if needed (LI.FI response includes the spender in txReq.to)
      const allowance = await inToken.allowance(wallet.address, txReq.to);
      const amountInBigInt = BigInt(amountInRaw);
      if (allowance < amountInBigInt) {
        // Some tokens (notably USDT on Ethereum mainnet) require resetting
        // allowance to 0 before setting a new non-zero value.
        if (allowance > BigInt(0)) {
          try {
            const resetTx = await (new ethers.Contract(tokenInAddr, ERC20_ABI, wallet)).approve(txReq.to, 0);
            await resetTx.wait();
            logger.info(`[EvmSwap:LiFi] Reset approval to 0 for ${tokenInAddr.slice(0, 10)}`);
          } catch { /* non-fatal — standard tokens don't need this */ }
        }
        const approveTx = await (new ethers.Contract(tokenInAddr, ERC20_ABI, wallet)).approve(txReq.to, ethers.MaxUint256);
        await approveTx.wait();
        logger.info(`[EvmSwap:LiFi] Approved ${tokenInAddr.slice(0, 10)} for LI.FI router`);
      }

      const tx = await wallet.sendTransaction({
        to: txReq.to,
        data: txReq.data,
        value: txReq.value ? BigInt(txReq.value) : BigInt(0),
        gasLimit: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
      });
      const receipt = await tx.wait();
      logger.info(`[EvmSwap:LiFi] Swap executed on chain ${chainId} tx=${receipt.hash}`);

      return { success: true, txHash: receipt.hash, amountIn: amountInHuman, amountOut, route: 'lifi' };
    }

    // ── Fallback: SDK executeRoute (cross-chain / bridge scenarios) ──
    if (!data.steps || !Array.isArray(data.steps) || data.steps.length === 0) {
      throw new Error('LI.FI quote returned no steps or transactionRequest — swap not available for this pair');
    }

    const lifi = await import('@lifi/sdk');
    lifi.createConfig({ integrator: 'nova-cfo' });

    const execution = await lifi.executeRoute(data, {
      updateRouteHook: (updatedRoute: any) => {
        const step = updatedRoute.steps?.[0];
        logger.debug(`[EvmSwap:LiFi] Step status: ${step?.execution?.status}`);
      },
    });

    const lastStep = (execution as any).steps?.at(-1);
    const txHash = lastStep?.execution?.process?.at(-1)?.txHash;

    return { success: true, txHash, amountIn: amountInHuman, amountOut, route: 'lifi' };
  } catch (err) {
    return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'lifi', error: (err as Error).message };
  }
}

/**
 * Execute swap via Aerodrome (Base) / Velodrome (Optimism) Router v2.
 * Mirrors quoteViaAerodrome — tries direct route, then 2-hop USDC→WETH→TOKEN.
 */
async function executeViaAerodrome(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  expectedOut: number,
  slippagePct = 0.5,
): Promise<SwapResult> {
  const routerAddr = AERODROME_ROUTER[chainId];
  const factory   = AERODROME_VOLATILE_FACTORY[chainId] ?? '0x0000000000000000000000000000000000000000';

  try {
    const { getEvmProvider } = await import('./evmProviderService.ts');
    const ethers = await import('ethers' as string);
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = await getEvmProvider(chainId);
    const wallet   = new ethers.Wallet(env.evmPrivateKey, provider);

    const inToken  = new ethers.Contract(tokenInAddr, ERC20_ABI, wallet);
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const [inDecimals, outDecimals] = await Promise.all([
      inToken.decimals().then(Number).catch(() => 18),
      outToken.decimals().then(Number).catch(() => 18),
    ]);
    const amountInRaw = ethers.parseUnits(amountInHuman.toFixed(inDecimals), inDecimals);
    const slippage    = 1 - slippagePct / 100;
    const minOut      = ethers.parseUnits((expectedOut * slippage).toFixed(outDecimals), outDecimals);
    const deadline    = Math.floor(Date.now() / 1000) + 300;

    // Approve router to spend tokenIn
    const routerContract = new ethers.Contract(routerAddr, AERODROME_ROUTER_ABI, wallet);
    const allowance: bigint = await inToken.allowance(wallet.address, routerAddr);
    if (allowance < amountInRaw) {
      const approveTx = await inToken.approve(routerAddr, amountInRaw * 10n);
      await approveTx.wait();
      logger.debug(`[EvmSwap:Aerodrome] Approved ${amountInHuman.toFixed(4)} tokenIn for router`);
    }

    // Determine route: direct first, 2-hop as fallback
    const wethAddr = WETH_ADDR[chainId];
    let routes: Array<{ from: string; to: string; stable: boolean; factory: string }>;

    // Check if direct route has liquidity
    let useDirect = false;
    const directRoutes = [{ from: tokenInAddr, to: tokenOutAddr, stable: false, factory }];
    try {
      const amounts = await routerContract.getAmountsOut(amountInRaw, directRoutes);
      if ((amounts[amounts.length - 1] as bigint) > 0n) useDirect = true;
    } catch { /* fall through to 2-hop */ }

    if (useDirect) {
      routes = directRoutes;
    } else if (wethAddr && tokenInAddr.toLowerCase() !== wethAddr.toLowerCase() && tokenOutAddr.toLowerCase() !== wethAddr.toLowerCase()) {
      routes = [
        { from: tokenInAddr, to: wethAddr,    stable: false, factory },
        { from: wethAddr,    to: tokenOutAddr, stable: false, factory },
      ];
    } else {
      return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'aerodrome', error: 'No Aerodrome route available' };
    }

    const walletAddr = wallet.address;
    const tx = await routerContract.swapExactTokensForTokens(amountInRaw, minOut, routes, walletAddr, deadline);
    const receipt = await tx.wait();
    const txHash: string = receipt.hash ?? tx.hash;

    logger.info(`[EvmSwap:Aerodrome] Swap completed: $${amountInHuman.toFixed(2)} → ~${expectedOut.toFixed(6)} on chain ${chainId} | tx ${txHash}`);
    return { success: true, txHash, amountIn: amountInHuman, amountOut: expectedOut, route: 'aerodrome' };
  } catch (err) {
    return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'aerodrome', error: (err as Error).message };
  }
}
