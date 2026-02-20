import { logger } from '@elizaos/core';
import { getRpcUrl } from './solanaRpc.ts';

/**
 * Price Service
 * 
 * Fetches real-time token price data from multiple sources:
 * 1. DexScreener API - for tokens that have graduated to Raydium
 * 2. PumpPortal WebSocket - for tokens still on the bonding curve
 * 
 * Free tier limits:
 * - DexScreener: 300 requests/minute
 * - PumpPortal WebSocket: single connection, many subscriptions
 */

// SOL price cache for USD conversion
let solPriceUsd: number = 130; // Default fallback
let solPriceUpdatedAt = 0;
const SOL_PRICE_TTL_MS = 5 * 60_000; // 5 minutes

export interface TokenPriceData {
  priceUsd: number | null;
  priceNative: number | null;  // Price in SOL
  marketCap: number | null;
  fdv: number | null;          // Fully diluted valuation
  volume24h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  liquidity: number | null;
  buys24h: number | null;
  sells24h: number | null;
  dexId: string | null;        // 'pumpfun', 'raydium', etc.
  pairAddress: string | null;
  lastUpdated: string;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns?: {
    h24?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    m5?: { buys: number; sells: number };
  };
  volume?: { h24?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h1?: number; m5?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
}

// Simple in-memory cache to avoid hammering the API
const priceCache = new Map<string, { data: TokenPriceData; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minute cache (bonding curve tokens barely move)

// Cache the @solana/web3.js import and Connection so we don't re-import + re-create every call
let _solanaWeb3: typeof import('@solana/web3.js') | null = null;
let _rpcConnection: InstanceType<typeof import('@solana/web3.js').Connection> | null = null;
let _rpcUrl: string | null = null;

async function getSolanaWeb3() {
  if (!_solanaWeb3) {
    _solanaWeb3 = await import('@solana/web3.js');
  }
  return _solanaWeb3;
}

async function getRpcConnection() {
  const rpcUrl = getRpcUrl();
  if (!_rpcConnection || _rpcUrl !== rpcUrl) {
    const { Connection } = await getSolanaWeb3();
    _rpcConnection = new Connection(rpcUrl, 'confirmed');
    _rpcUrl = rpcUrl;
  }
  return _rpcConnection;
}

/**
 * Fetch token price data from DexScreener
 * Uses the /tokens/v1/solana/{address} endpoint
 */
export async function getTokenPrice(mintAddress: string): Promise<TokenPriceData | null> {
  if (!mintAddress || mintAddress === 'N/A') {
    return null;
  }

  // Check cache first
  const cached = priceCache.get(mintAddress);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logger.debug(`[PriceService] Cache hit for ${mintAddress}`);
    return cached.data;
  }

  try {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`;
    logger.debug(`[PriceService] Fetching price for ${mintAddress.slice(0,8)}...`);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LaunchKit/1.0'
      }
    });

    if (!response.ok) {
      logger.warn(`[PriceService] DexScreener returned ${response.status} for ${mintAddress.slice(0,8)}...`);
      return null;
    }

    const pairs: DexScreenerPair[] = await response.json();

    if (!pairs || pairs.length === 0) {
      logger.debug(`[PriceService] No DexScreener pairs for ${mintAddress.slice(0,8)}..., trying bonding curve...`);
      // Fallback to bonding curve price
      return await getBondingCurvePrice(mintAddress);
    }

    // Use the first/best pair (DexScreener returns them sorted by liquidity)
    const pair = pairs[0];

    const priceData: TokenPriceData = {
      priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      priceNative: pair.priceNative ? parseFloat(pair.priceNative) : null,
      marketCap: pair.marketCap ?? null,
      fdv: pair.fdv ?? null,
      volume24h: pair.volume?.h24 ?? null,
      priceChange5m: pair.priceChange?.m5 ?? null,
      priceChange1h: pair.priceChange?.h1 ?? null,
      priceChange24h: pair.priceChange?.h24 ?? null,
      liquidity: pair.liquidity?.usd ?? null,
      buys24h: pair.txns?.h24?.buys ?? null,
      sells24h: pair.txns?.h24?.sells ?? null,
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
      lastUpdated: new Date().toISOString(),
    };

    // Cache the result
    priceCache.set(mintAddress, { data: priceData, fetchedAt: Date.now() });

    logger.info(`[PriceService] ${pair.baseToken.symbol}: $${priceData.priceUsd?.toFixed(8)} | MC: $${formatNumber(priceData.marketCap)} | Vol: $${formatNumber(priceData.volume24h)}`);

    return priceData;
  } catch (error) {
    logger.error(`[PriceService] Error fetching price for ${mintAddress}:`, error);
    // Try bonding curve as last resort
    return await getBondingCurvePrice(mintAddress);
  }
}

/**
 * Fetch current SOL price in USD from DexScreener
 */
export async function getSolPriceUsd(): Promise<number> {
  // Use cached value if fresh
  if (Date.now() - solPriceUpdatedAt < SOL_PRICE_TTL_MS) {
    return solPriceUsd;
  }
  
  try {
    // Fetch SOL/USDC price from DexScreener
    const response = await fetch('https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112');
    if (response.ok) {
      const pairs = await response.json();
      if (pairs?.[0]?.priceUsd) {
        solPriceUsd = parseFloat(pairs[0].priceUsd);
        solPriceUpdatedAt = Date.now();
        logger.debug(`[PriceService] Updated SOL price: $${solPriceUsd}`);
      }
    }
  } catch (error) {
    logger.warn('[PriceService] Failed to fetch SOL price, using cached value');
  }
  
  return solPriceUsd;
}

// Pump.fun program ID for bonding curve PDA derivation
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Fetch bonding curve data directly from Solana RPC
 * This is the most reliable method - works for all tokens on bonding curve
 * regardless of trade activity
 */
async function getBondingCurveFromRPC(mintAddress: string): Promise<TokenPriceData | null> {
  logger.debug(`[PriceService] RPC bonding curve fetch for ${mintAddress.slice(0,8)}...`);
  try {
    const { PublicKey } = await getSolanaWeb3();
    const connection = await getRpcConnection();
    
    const mint = new PublicKey(mintAddress);
    const programId = new PublicKey(PUMP_PROGRAM_ID);
    
    // Derive bonding curve PDA
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      programId
    );
    
    // Fetch account data
    const accountInfo = await connection.getAccountInfo(bondingCurvePda);
    
    if (!accountInfo || !accountInfo.data) {
      logger.debug(`[PriceService] No bonding curve account for ${mintAddress.slice(0,8)}...`);
      return null;
    }
    
    const data = accountInfo.data;
    
    // Parse bonding curve account data
    // Layout: discriminator(8) + virtualTokenReserves(8) + virtualSolReserves(8) + 
    //         realTokenReserves(8) + realSolReserves(8) + tokenTotalSupply(8) + complete(1)
    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);
    const tokenTotalSupply = data.readBigUInt64LE(40);
    const complete = data[48] === 1;
    
    if (complete) {
      logger.debug(`[PriceService] Token ${mintAddress.slice(0,8)}... has graduated, no bonding curve price`);
      return null;
    }
    
    // Calculate price: SOL reserves / token reserves
    // Token has 6 decimals, SOL has 9 decimals
    const vTokens = Number(virtualTokenReserves) / 1e6;  // to token units
    const vSol = Number(virtualSolReserves) / 1e9;       // to SOL
    const totalSupply = Number(tokenTotalSupply) / 1e6;  // to token units
    
    const priceInSol = vSol / vTokens;
    const marketCapSol = priceInSol * totalSupply;
    
    // Get SOL price for USD conversion
    const solPrice = await getSolPriceUsd();
    const priceUsd = priceInSol * solPrice;
    const marketCapUsd = marketCapSol * solPrice;
    
    const priceData: TokenPriceData = {
      priceUsd,
      priceNative: priceInSol,
      marketCap: marketCapUsd,
      fdv: marketCapUsd,
      volume24h: null,        // Not available from on-chain data
      priceChange5m: null,
      priceChange1h: null,
      priceChange24h: null,
      liquidity: vSol * solPrice,  // SOL in bonding curve
      buys24h: null,
      sells24h: null,
      dexId: 'pumpfun',
      pairAddress: bondingCurvePda.toString(),
      lastUpdated: new Date().toISOString(),
    };
    
    // Cache the result
    priceCache.set(mintAddress, { data: priceData, fetchedAt: Date.now() });
    
    logger.debug(`[PriceService] BC ${mintAddress.slice(0,8)}...: $${priceUsd.toFixed(10)} | MC: $${formatNumber(marketCapUsd)} | ${vSol.toFixed(2)} SOL`);
    
    return priceData;
  } catch (error) {
    logger.warn(`[PriceService] RPC bonding curve failed for ${mintAddress.slice(0,8)}...: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Fetch bonding curve price from PumpPortal WebSocket
 * Uses a one-shot subscription - only works if there's recent trade activity
 * Returns null quickly if no trades happen (token might be inactive)
 */
async function getBondingCurvePrice(mintAddress: string): Promise<TokenPriceData | null> {
  // Check cache first
  const cached = priceCache.get(mintAddress);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  // Try direct RPC fetch first (more reliable than WebSocket for inactive tokens)
  const rpcResult = await getBondingCurveFromRPC(mintAddress);
  if (rpcResult) {
    return rpcResult;
  }

  // Fallback to WebSocket for real-time data (if token has active trades)
  return new Promise((resolve) => {
    let resolved = false;
    // Short timeout - if no trades in 2 seconds, token is likely inactive
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.info(`[PriceService] No recent trades for ${mintAddress.slice(0,8)}... (bonding curve price unavailable)`);
        resolve(null);
        try { ws.close(); } catch {}
      }
    }, 2000);

    let ws: any;
    try {
      const WebSocket = require('ws');
      ws = new WebSocket('wss://pumpportal.fun/api/data');

      ws.on('open', () => {
        // Subscribe to trades on this specific token
        ws.send(JSON.stringify({
          method: 'subscribeTokenTrade',
          keys: [mintAddress]
        }));
      });

      ws.on('message', async (data: Buffer) => {
        if (resolved) return;
        
        try {
          const msg = JSON.parse(data.toString());
          
          // Skip subscription confirmation
          if (msg.message) return;
          
          // Got trade data - extract bonding curve info
          if (msg.vSolInBondingCurve !== undefined && msg.vTokensInBondingCurve !== undefined) {
            resolved = true;
            clearTimeout(timeout);
            
            const solPrice = await getSolPriceUsd();
            const marketCapSol = msg.marketCapSol || 0;
            const marketCapUsd = marketCapSol * solPrice;
            
            // Calculate price: vSol / vTokens gives price per token in SOL
            const priceInSol = msg.vSolInBondingCurve / msg.vTokensInBondingCurve;
            const priceUsd = priceInSol * solPrice;
            
            const priceData: TokenPriceData = {
              priceUsd,
              priceNative: priceInSol,
              marketCap: marketCapUsd,
              fdv: marketCapUsd, // Same for bonding curve
              volume24h: null,
              priceChange5m: null,
              priceChange1h: null,
              priceChange24h: null,
              liquidity: null,
              buys24h: null,
              sells24h: null,
              dexId: 'pumpfun',
              pairAddress: msg.bondingCurveKey || null,
              lastUpdated: new Date().toISOString(),
            };
            
            // Cache the result
            priceCache.set(mintAddress, { data: priceData, fetchedAt: Date.now() });
            
            logger.info(`[PriceService] Bonding curve ${msg.symbol || mintAddress.slice(0,8)}: $${priceUsd.toFixed(10)} | MC: $${formatNumber(marketCapUsd)}`);
            
            ws.close();
            resolve(priceData);
          }
        } catch (parseError) {
          logger.warn('[PriceService] Failed to parse bonding curve message');
        }
      });

      ws.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          logger.warn(`[PriceService] Bonding curve WebSocket error: ${err.message}`);
          resolve(null);
        }
      });

      ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    } catch (error) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        logger.error('[PriceService] Failed to connect to PumpPortal WebSocket:', error);
        resolve(null);
      }
    }
  });
}

/**
 * Format a number for display (1000 -> 1K, 1000000 -> 1M)
 */
function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
}

/**
 * Format price for display with appropriate decimals
 */
export function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  if (price < 0.00000001) return price.toExponential(2);
  if (price < 0.0001) return price.toFixed(8);
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(2);
  return price.toFixed(0);
}

/**
 * Format market cap with $ prefix
 */
export function formatMarketCap(mc: number | null): string {
  if (mc === null) return 'N/A';
  return `$${formatNumber(mc)}`;
}

/**
 * Format percentage change with emoji
 */
export function formatPriceChange(change: number | null): string {
  if (change === null) return '';
  const emoji = change >= 0 ? '📈' : '📉';
  const sign = change >= 0 ? '+' : '';
  return `${emoji} ${sign}${change.toFixed(1)}%`;
}

/**
 * Get a summary string suitable for tweets
 */
export function getPriceSummary(data: TokenPriceData): string {
  const parts: string[] = [];
  
  if (data.priceUsd !== null) {
    parts.push(`💰 $${formatPrice(data.priceUsd)}`);
  }
  
  if (data.marketCap !== null) {
    parts.push(`📊 MC: ${formatMarketCap(data.marketCap)}`);
  }
  
  if (data.priceChange24h !== null) {
    parts.push(formatPriceChange(data.priceChange24h));
  } else if (data.priceChange1h !== null) {
    parts.push(formatPriceChange(data.priceChange1h) + ' (1h)');
  }
  
  if (data.volume24h !== null && data.volume24h > 0) {
    parts.push(`📈 Vol: $${formatNumber(data.volume24h)}`);
  }
  
  return parts.join(' | ');
}

/**
 * Batch fetch prices for multiple mints in one go.
 * Uses DexScreener's multi-token endpoint (up to 30 addresses per call)
 * then falls back to bonding curve RPC for tokens not found on DexScreener.
 * 
 * Much more efficient than calling getTokenPrice() in a loop.
 */
export async function getTokenPrices(mintAddresses: string[]): Promise<Map<string, TokenPriceData>> {
  const results = new Map<string, TokenPriceData>();
  const uncached: string[] = [];

  // 1. Check cache first
  for (const mint of mintAddresses) {
    if (!mint || mint === 'N/A') continue;
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      results.set(mint, cached.data);
    } else {
      uncached.push(mint);
    }
  }

  if (uncached.length === 0) {
    logger.debug(`[PriceService] Batch: all ${mintAddresses.length} prices from cache`);
    return results;
  }

  logger.info(`[PriceService] Batch: ${results.size} cached, ${uncached.length} to fetch`);

  // 2. Batch DexScreener call (max 30 addresses comma-separated)
  const needBondingCurve: string[] = [];
  const BATCH_SIZE = 30;

  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    try {
      const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'LaunchKit/1.0' }
      });

      if (response.ok) {
        const pairs: DexScreenerPair[] = await response.json();
        const foundMints = new Set<string>();

        for (const pair of (pairs || [])) {
          const mint = pair.baseToken?.address;
          if (!mint || foundMints.has(mint)) continue;
          foundMints.add(mint);

          const priceData: TokenPriceData = {
            priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
            priceNative: pair.priceNative ? parseFloat(pair.priceNative) : null,
            marketCap: pair.marketCap ?? null,
            fdv: pair.fdv ?? null,
            volume24h: pair.volume?.h24 ?? null,
            priceChange5m: pair.priceChange?.m5 ?? null,
            priceChange1h: pair.priceChange?.h1 ?? null,
            priceChange24h: pair.priceChange?.h24 ?? null,
            liquidity: pair.liquidity?.usd ?? null,
            buys24h: pair.txns?.h24?.buys ?? null,
            sells24h: pair.txns?.h24?.sells ?? null,
            dexId: pair.dexId,
            pairAddress: pair.pairAddress,
            lastUpdated: new Date().toISOString(),
          };

          results.set(mint, priceData);
          priceCache.set(mint, { data: priceData, fetchedAt: Date.now() });
        }

        // Tokens NOT found on DexScreener need bonding curve lookup
        for (const mint of batch) {
          if (!foundMints.has(mint)) {
            needBondingCurve.push(mint);
          }
        }
      } else {
        // DexScreener failed — all go to bonding curve
        needBondingCurve.push(...batch);
      }
    } catch (error) {
      logger.warn(`[PriceService] Batch DexScreener failed: ${error instanceof Error ? error.message : String(error)}`);
      needBondingCurve.push(...batch);
    }
  }

  // 3. Bonding curve fallback for tokens not on DexScreener
  if (needBondingCurve.length > 0) {
    logger.debug(`[PriceService] Batch: ${needBondingCurve.length} tokens need bonding curve lookup`);
    // Fetch bonding curve prices in parallel (they're independent RPC calls)
    const bcResults = await Promise.allSettled(
      needBondingCurve.map(mint => getBondingCurveFromRPC(mint))
    );

    for (let i = 0; i < needBondingCurve.length; i++) {
      const result = bcResults[i];
      if (result.status === 'fulfilled' && result.value) {
        results.set(needBondingCurve[i], result.value);
      }
    }
  }

  logger.info(`[PriceService] Batch complete: ${results.size}/${mintAddresses.length} prices fetched`);
  return results;
}

/**
 * Clear the price cache (useful for testing)
 */
export function clearPriceCache(): void {
  priceCache.clear();
}
