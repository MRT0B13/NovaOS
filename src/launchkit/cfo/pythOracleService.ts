/**
 * Pyth Oracle Service
 *
 * Real-time, on-chain price feeds via the Pyth Network.
 * Used across all CFO strategies to:
 *  - Validate swap prices before executing (detect stale/manipulated prices)
 *  - Compute USD portfolio values accurately
 *  - Assess collateral value in Kamino positions
 *  - Feed Hyperliquid stop-loss calculations with reliable SOL/ETH prices
 *
 * Implementation:
 *  - Pulls latest price updates from Pyth's Hermes price service (REST, no SDK needed)
 *  - Falls back to CoinGecko public API if Hermes is unreachable
 *  - Caches prices for 30 seconds to avoid rate-limit hammering
 *  - Returns confidence intervals so callers can detect high-uncertainty conditions
 *
 * Price IDs (Pyth mainnet):
 *  SOL/USD  : 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
 *  ETH/USD  : 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
 *  BTC/USD  : 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
 *  MATIC/USD: 0xd2c2c1f2bba8e0964f9589e060c2ee97f5e19057267ac3284caef3bd50bd2cb5
 */

import { logger } from '@elizaos/core';

// ============================================================================
// Price IDs (Pyth mainnet)
// ============================================================================

export const PYTH_PRICE_IDS: Record<string, string> = {
  'SOL/USD':   'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'ETH/USD':   'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'BTC/USD':   'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'MATIC/USD': 'd2c2c1f2bba8e0964f9589e060c2ee97f5e19057267ac3284caef3bd50bd2cb5',
  'USDC/USD':  'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
};

// ============================================================================
// Types
// ============================================================================

export interface PriceData {
  symbol: string;
  price: number;
  confidence: number;     // ±confidence interval
  publishTime: number;    // unix timestamp
  emaPrice: number;       // exponential moving average (more stable)
  age: number;            // seconds since publish
  isStale: boolean;       // true if older than STALE_THRESHOLD_SECONDS
  source: 'pyth' | 'coingecko' | 'cache';
}

// ============================================================================
// Constants
// ============================================================================

const HERMES_BASE = 'https://hermes.pyth.network';
const STALE_THRESHOLD_SECONDS = 60;
const CACHE_TTL_MS = 30_000;   // 30 second cache

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry {
  data: PriceData;
  cachedAt: number;
}

const priceCache = new Map<string, CacheEntry>();

function getCached(symbol: string): PriceData | null {
  const entry = priceCache.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
  return { ...entry.data, source: 'cache', age: Math.round((Date.now() / 1000) - entry.data.publishTime) };
}

function setCache(symbol: string, data: PriceData): void {
  priceCache.set(symbol, { data, cachedAt: Date.now() });
}

// ============================================================================
// Pyth Hermes fetch
// ============================================================================

interface HermesResponse {
  parsed: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
    ema_price: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

async function fetchFromPyth(symbols: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  const ids = symbols.map((s) => PYTH_PRICE_IDS[s]).filter(Boolean);

  if (!ids.length) return result;

  const params = ids.map((id) => `ids[]=${id}`).join('&');
  const url = `${HERMES_BASE}/v2/updates/price/latest?${params}&parsed=true`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Pyth Hermes ${resp.status}`);

  const body = await resp.json() as HermesResponse;

  for (const p of body.parsed) {
    const symbol = Object.entries(PYTH_PRICE_IDS).find(([, id]) => id === p.id)?.[0];
    if (!symbol) continue;

    const expo = p.price.expo;
    const multiplier = Math.pow(10, expo);
    const price = Number(p.price.price) * multiplier;
    const confidence = Number(p.price.conf) * multiplier;
    const emaPrice = Number(p.ema_price.price) * Math.pow(10, p.ema_price.expo);
    const age = Math.round(Date.now() / 1000) - p.price.publish_time;

    const data: PriceData = {
      symbol,
      price,
      confidence,
      emaPrice,
      publishTime: p.price.publish_time,
      age,
      isStale: age > STALE_THRESHOLD_SECONDS,
      source: 'pyth',
    };

    result.set(symbol, data);
    setCache(symbol, data);
  }

  return result;
}

// ============================================================================
// CoinGecko fallback
// ============================================================================

const COINGECKO_IDS: Record<string, string> = {
  'SOL/USD':   'solana',
  'ETH/USD':   'ethereum',
  'BTC/USD':   'bitcoin',
  'MATIC/USD': 'matic-network',
  'USDC/USD':  'usd-coin',
};

async function fetchFromCoinGecko(symbols: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  const ids = symbols.map((s) => COINGECKO_IDS[s]).filter(Boolean);
  if (!ids.length) return result;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);

  const body = await resp.json() as Record<string, { usd: number }>;
  const now = Math.round(Date.now() / 1000);

  for (const symbol of symbols) {
    const cgId = COINGECKO_IDS[symbol];
    if (!cgId || !body[cgId]?.usd) continue;

    const price = body[cgId].usd;
    const data: PriceData = {
      symbol,
      price,
      confidence: price * 0.005,   // approximate 0.5% confidence
      emaPrice: price,
      publishTime: now,
      age: 0,
      isStale: false,
      source: 'coingecko',
    };

    result.set(symbol, data);
    setCache(symbol, data);
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get latest price for a symbol. Returns cached if fresh enough.
 * Falls back to CoinGecko if Pyth is unreachable.
 */
export async function getPrice(symbol: string): Promise<PriceData | null> {
  const cached = getCached(symbol);
  if (cached) return cached;

  try {
    const prices = await fetchFromPyth([symbol]);
    return prices.get(symbol) ?? null;
  } catch (pythErr) {
    logger.debug(`[Pyth] Hermes failed for ${symbol}, falling back to CoinGecko: ${pythErr}`);
    try {
      const prices = await fetchFromCoinGecko([symbol]);
      return prices.get(symbol) ?? null;
    } catch (cgErr) {
      logger.warn(`[Pyth] All price sources failed for ${symbol}: ${cgErr}`);
      return null;
    }
  }
}

/**
 * Fetch multiple prices in a single request. Efficient for portfolio valuation.
 */
export async function getPrices(symbols: string[]): Promise<Map<string, PriceData>> {
  // Return cached ones immediately, only fetch uncached
  const result = new Map<string, PriceData>();
  const toFetch: string[] = [];

  for (const sym of symbols) {
    const cached = getCached(sym);
    if (cached) result.set(sym, cached);
    else toFetch.push(sym);
  }

  if (!toFetch.length) return result;

  try {
    const fresh = await fetchFromPyth(toFetch);
    for (const [sym, data] of fresh) result.set(sym, data);

    // Fallback for any still missing
    const stillMissing = toFetch.filter((s) => !fresh.has(s));
    if (stillMissing.length) {
      const fallback = await fetchFromCoinGecko(stillMissing);
      for (const [sym, data] of fallback) result.set(sym, data);
    }
  } catch {
    try {
      const fallback = await fetchFromCoinGecko(toFetch);
      for (const [sym, data] of fallback) result.set(sym, data);
    } catch (err) {
      logger.warn('[Pyth] getPrices: all sources failed:', err);
    }
  }

  return result;
}

/** Convenience: SOL price in USD. Returns NaN if all oracles fail — callers MUST check. */
export async function getSolPrice(): Promise<number> {
  const data = await getPrice('SOL/USD');
  if (!data) {
    logger.warn('[Pyth] getSolPrice: all oracles failed — returning NaN');
    return NaN;
  }
  return data.price;
}

/** Convenience: ETH price in USD. Returns NaN if all oracles fail — callers MUST check. */
export async function getEthPrice(): Promise<number> {
  const data = await getPrice('ETH/USD');
  if (!data) {
    logger.warn('[Pyth] getEthPrice: all oracles failed — returning NaN');
    return NaN;
  }
  return data.price;
}

/**
 * Validate that a swap price is within acceptable bounds of oracle price.
 * Returns false if the execution price deviates more than `maxSlippagePct` from oracle.
 */
export async function validateSwapPrice(
  symbol: string,
  executionPrice: number,
  maxSlippagePct = 1.0,
): Promise<{ ok: boolean; oraclePrice: number; deviationPct: number; warning?: string }> {
  const oracle = await getPrice(symbol);
  if (!oracle) {
    return { ok: true, oraclePrice: executionPrice, deviationPct: 0, warning: 'No oracle data — skipping validation' };
  }

  if (oracle.isStale) {
    return { ok: false, oraclePrice: oracle.price, deviationPct: 0, warning: `Oracle data stale (${oracle.age}s old)` };
  }

  const deviationPct = Math.abs(executionPrice - oracle.price) / oracle.price * 100;
  const ok = deviationPct <= maxSlippagePct;

  return {
    ok,
    oraclePrice: oracle.price,
    deviationPct,
    warning: ok ? undefined : `Price deviation ${deviationPct.toFixed(2)}% exceeds max ${maxSlippagePct}%`,
  };
}

/** Force clear cache (useful for testing or after large market moves) */
export function clearPriceCache(): void {
  priceCache.clear();
}
