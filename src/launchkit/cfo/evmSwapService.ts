/**
 * EVM Swap Service
 *
 * Same-chain token swaps on EVM via Uniswap V3 SwapRouter02.
 * Fallback to LI.FI swap API for chains without Uniswap V3.
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
// Constants
// ============================================================================

const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const QUOTER_V2      = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const LIFI_API_BASE = 'https://li.quest/v1';

/** Chains where Uniswap V3 SwapRouter02 is deployed */
const UNISWAP_V3_CHAINS = new Set([1, 10, 137, 8453, 42161, 43114, 324, 534352, 59144]);

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
  route: 'uniswap_v3' | 'lifi';  // which router used
  gasEstimate?: number;     // gas units
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  route: 'uniswap_v3' | 'lifi';
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
  // Try Uniswap V3 on supported chains
  if (UNISWAP_V3_CHAINS.has(chainId)) {
    const uniQuote = await quoteViaUniswap(chainId, tokenInAddr, tokenOutAddr, amountInHuman, feeTier);
    if (uniQuote) return uniQuote;
  }

  // Fallback to LI.FI swap API (works on any chain)
  return quoteViaLifi(chainId, tokenInAddr, tokenOutAddr, amountInHuman);
}

async function quoteViaUniswap(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  amountInHuman: number,
  feeTier: number,
): Promise<SwapQuote | null> {
  try {
    const { getEvmProvider } = await import('./krystalService.ts');
    const ethers = await import('ethers' as string);
    const provider = await getEvmProvider(chainId);

    // Get input token decimals
    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = await inToken.decimals().catch(() => 18);
    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals);

    // Call QuoterV2 (staticCall — doesn't consume gas)
    const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      amountIn: amountInRaw,
      fee: feeTier,
      sqrtPriceLimitX96: BigInt(0),
    });

    const amountOutRaw = result[0] ?? result.amountOut;
    const gasEstimate = Number(result[3] ?? result.gasEstimate ?? 200_000);

    // Get output token decimals
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = await outToken.decimals().catch(() => 18);
    const amountOut = Number(ethers.formatUnits(amountOutRaw, outDecimals));

    const priceImpactPct = amountInHuman > 0 && amountOut > 0
      ? Math.abs(1 - amountOut / amountInHuman) * 100
      : 0;

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
    logger.debug(`[EvmSwap] Uniswap V3 quote failed on chain ${chainId}:`, err);
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
    const { getEvmProvider } = await import('./krystalService.ts');
    const provider = await getEvmProvider(chainId);

    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = await inToken.decimals().catch(() => 18);
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

    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = await outToken.decimals().catch(() => 18);
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
    logger.debug('[EvmSwap] LI.FI quote failed:', err);
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
    return executeViaUniswap(chainId, tokenInAddr, tokenOutAddr, amountInHuman, feeTier, slippagePct, quote.amountOut);
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
    const { getEvmProvider } = await import('./krystalService.ts');
    const ethers = await import('ethers' as string);
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = await getEvmProvider(chainId);
    const wallet = new ethers.Wallet(env.evmPrivateKey, provider);

    // Decimals
    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, wallet);
    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const [inDecimals, outDecimals] = await Promise.all([
      inToken.decimals().catch(() => 18),
      outToken.decimals().catch(() => 18),
    ]);

    const amountInRaw = ethers.parseUnits(amountInHuman.toString(), inDecimals);
    const amountOutMinRaw = ethers.parseUnits(
      (expectedOut * (1 - slippagePct / 100)).toFixed(outDecimals),
      outDecimals,
    );

    // Approve
    const allowance = await inToken.allowance(wallet.address, SWAP_ROUTER_02);
    if (allowance < amountInRaw) {
      const approveTx = await inToken.approve(SWAP_ROUTER_02, ethers.MaxUint256);
      await approveTx.wait();
      logger.info(`[EvmSwap] Approved ${tokenInAddr.slice(0, 10)} for SwapRouter02`);
    }

    // Execute swap
    const router = new ethers.Contract(SWAP_ROUTER_02, SWAP_ROUTER_ABI, wallet);
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
    const { getEvmProvider } = await import('./krystalService.ts');
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = await getEvmProvider(chainId);
    const wallet = new ethers.Wallet(env.evmPrivateKey, provider);

    const inToken = new ethers.Contract(tokenInAddr, ERC20_ABI, provider);
    const inDecimals = await inToken.decimals().catch(() => 18);
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

    // Execute via LI.FI SDK
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

    const outToken = new ethers.Contract(tokenOutAddr, ERC20_ABI, provider);
    const outDecimals = await outToken.decimals().catch(() => 18);
    const amountOut = Number(data.estimate?.toAmount ?? 0) / 10 ** outDecimals;

    return { success: true, txHash, amountIn: amountInHuman, amountOut, route: 'lifi' };
  } catch (err) {
    return { success: false, amountIn: amountInHuman, amountOut: 0, route: 'lifi', error: (err as Error).message };
  }
}
