/**
 * EVM Provider Service — Shared multi-chain provider infrastructure
 *
 * Extracted from krystalService.ts so that all EVM services (LP, AAVE, arb,
 * bridge) share one cached provider pool without coupling to LP internals.
 *
 * Key functions:
 *   getEvmProvider(chainId)          → lazily-created ethers provider per chain
 *   getEvmWallet(chainId)            → ethers Wallet connected to provider
 *   getMultiChainEvmBalances()       → USDC/WETH/native balances across all chains
 *   withRpcRetry(fn, label, max)     → exponential backoff for transient RPC errors
 *   loadEthers()                     → lazy ethers import
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Ethers lazy import
// ============================================================================

let _ethers: typeof import('ethers') | null = null;
export async function loadEthers(): Promise<typeof import('ethers')> {
  if (!_ethers) _ethers = await import('ethers' as string);
  return _ethers!;
}

// ============================================================================
// Provider pooling
// ============================================================================

const _providerCache = new Map<number, any>();

export async function getEvmProvider(numericChainId: number): Promise<any> {
  if (_providerCache.has(numericChainId)) return _providerCache.get(numericChainId)!;

  const env = getCFOEnv();
  const url = env.evmRpcUrls[numericChainId]
    ?? (numericChainId === 42161 ? env.arbitrumRpcUrl : undefined);
  if (!url) throw new Error(`[EvmProvider] No RPC URL configured for chainId ${numericChainId}`);

  const ethers = await loadEthers();
  const staticNetwork = ethers.Network.from(numericChainId);
  // Disable ENS on non-mainnet chains — ethers v6 still attempts resolver()
  // calls even with staticNetwork, which fails on L2s without ENS registries.
  if (numericChainId !== 1) {
    staticNetwork.attachPlugin(new ethers.EnsPlugin(null));
  }
  const provider = new ethers.JsonRpcProvider(url, staticNetwork, { staticNetwork: true });
  _providerCache.set(numericChainId, provider);
  return provider;
}

/** Evict cached provider so next call creates a fresh one (e.g. after RPC failures). */
export function evictProvider(numericChainId: number): void {
  _providerCache.delete(numericChainId);
}

// ============================================================================
// RPC retry helper — exponential backoff for transient errors (503, 429, timeout)
// ============================================================================

export const TRANSIENT_RPC_CODES = ['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'];

export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const code  = err?.code ?? '';
      const msg   = String(err?.message ?? err ?? '');
      const isTransient =
        TRANSIENT_RPC_CODES.includes(code) ||
        msg.includes('503')  ||
        msg.includes('429')  ||
        msg.includes('overloaded') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT');

      if (isTransient && attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        logger.debug(`[EvmProvider] ${label} transient error — retry ${attempt}/${maxAttempts} in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[EvmProvider] ${label} unreachable`);
}

// ============================================================================
// Wallet helper
// ============================================================================

export async function getEvmWallet(numericChainId: number): Promise<any> {
  const env = getCFOEnv();
  if (!env.evmPrivateKey) throw new Error('[EvmProvider] CFO_EVM_PRIVATE_KEY not set');
  const ethers = await loadEthers();
  const provider = await getEvmProvider(numericChainId);
  return new ethers.Wallet(env.evmPrivateKey, provider);
}

// ============================================================================
// Well-known token addresses (shared across services)
// ============================================================================

export const WRAPPED_NATIVE_ADDR: Record<number, string> = {
  1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  10:    '0x4200000000000000000000000000000000000006', // WETH (Optimism)
  56:    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB (BSC)
  137:   '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
  8453:  '0x4200000000000000000000000000000000000006', // WETH (Base)
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH (Arbitrum)
  43114: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
};

export const NATIVE_SYMBOLS: Record<number, string> = {
  1: 'ETH', 10: 'ETH', 56: 'BNB', 137: 'MATIC',
  8453: 'ETH', 42161: 'ETH', 43114: 'AVAX',
  324: 'ETH', 534352: 'ETH', 59144: 'ETH',
};

/** Well-known bridged USDC variants */
export const BRIDGED_USDC: Record<number, string> = {
  42161: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC.e on Arbitrum
  10:    '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC.e on Optimism
  137:   '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e on Polygon
  43114: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', // USDC.e on Avalanche
};

/** Well-known USDT addresses */
export const WELL_KNOWN_USDT: Record<number, string> = {
  1:     '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  56:    '0x55d398326f99059fF775485246999027B3197955',
  137:   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  10:    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  8453:  '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  43114: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
};

// ============================================================================
// Native token price helper
// ============================================================================

const _nativePriceCache = new Map<number, { price: number; ts: number }>();
const NATIVE_PRICE_TTL = 5 * 60_000; // 5 min

export async function getNativeTokenPrice(chainId: number): Promise<number> {
  const cached = _nativePriceCache.get(chainId);
  if (cached && Date.now() - cached.ts < NATIVE_PRICE_TTL) return cached.price;

  // Map chainId to CoinGecko ID
  const cgIds: Record<number, string> = {
    1: 'ethereum', 10: 'ethereum', 8453: 'ethereum', 42161: 'ethereum',
    324: 'ethereum', 534352: 'ethereum', 59144: 'ethereum',
    137: 'matic-network', 56: 'binancecoin', 43114: 'avalanche-2',
  };
  const cgId = cgIds[chainId] ?? 'ethereum';

  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (resp.ok) {
      const data = await resp.json();
      const price = data[cgId]?.usd ?? 0;
      if (price > 0) {
        _nativePriceCache.set(chainId, { price, ts: Date.now() });
        return price;
      }
    }
  } catch { /* fall through to cached/default */ }

  return cached?.price ?? 3000; // fallback
}

// ============================================================================
// ERC20 ABI (shared)
// ============================================================================

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ============================================================================
// Multi-chain balance scanning
// ============================================================================

/** Per-chain balance snapshot for multi-chain portfolio scanning */
export interface ChainBalance {
  chainId: number;
  chainName: string;
  usdcBalance: number;
  usdcBridgedBalance: number;
  usdtBalance: number;
  totalStableUsd: number;
  wethBalance: number;
  wethValueUsd: number;
  nativeBalance: number;
  nativeSymbol: string;
  nativeValueUsd: number;
  totalValueUsd: number;
}

/**
 * Scan all configured EVM chains for USDC (native + bridged), WETH, and native token balances.
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

  const promises = chainIds.map(async (chainId) => {
    try {
      const bridge = await import('./wormholeService.ts');
      const usdcAddr = bridge.WELL_KNOWN_USDC[chainId];
      const bridgedUsdcAddr = BRIDGED_USDC[chainId];
      const usdtAddr = WELL_KNOWN_USDT[chainId];
      const wethAddr = WRAPPED_NATIVE_ADDR[chainId];
      const chainName = bridge.chainIdToName(chainId);

      const [usdcBalance, usdcBridgedBalance, usdtBalance, wethBalance, nativeBalance] = await Promise.all([
        usdcAddr
          ? bridge.getEvmTokenBalance(chainId, usdcAddr, walletAddress)
          : Promise.resolve(0),
        bridgedUsdcAddr
          ? bridge.getEvmTokenBalance(chainId, bridgedUsdcAddr, walletAddress)
          : Promise.resolve(0),
        usdtAddr
          ? bridge.getEvmTokenBalance(chainId, usdtAddr, walletAddress)
          : Promise.resolve(0),
        wethAddr
          ? bridge.getEvmTokenBalance(chainId, wethAddr, walletAddress)
          : Promise.resolve(0),
        bridge.getEvmNativeBalance(chainId, walletAddress),
      ]);

      const nativePrice = await getNativeTokenPrice(chainId);
      const nativeSymbol = NATIVE_SYMBOLS[chainId] ?? 'ETH';
      const totalStableUsd = usdcBalance + usdcBridgedBalance + usdtBalance;
      const wethValueUsd = wethBalance * nativePrice;
      const nativeValueUsd = nativeBalance * nativePrice;

      return {
        chainId,
        chainName,
        usdcBalance,
        usdcBridgedBalance,
        usdtBalance,
        totalStableUsd,
        wethBalance,
        wethValueUsd,
        nativeBalance,
        nativeSymbol,
        nativeValueUsd,
        totalValueUsd: totalStableUsd + wethValueUsd + nativeValueUsd,
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
// Stablecoin helpers (shared)
// ============================================================================

const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'BUSD', 'USDCE', 'USDC.E', 'USDT0', 'FRAX', 'TUSD', 'USDG',
]);

export function isStablecoin(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}
