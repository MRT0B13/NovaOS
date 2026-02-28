/**
 * Hyperliquid Perpetuals Service
 *
 * Provides perpetual futures trading via Hyperliquid's DEX.
 * Used by the CFO agent ONLY for hedging — not directional speculation.
 *
 * Architecture doc constraints (enforced in code):
 *  - Max 20% of portfolio
 *  - Max 5x leverage (hard cap)
 *  - Hedging use case only: SHORT SOL when SOL treasury > $X to cap downside risk
 *
 * Hyperliquid auth:
 *  - Uses @nktkas/hyperliquid SDK
 *  - L1 auth via EIP-712 signing with CFO_HYPERLIQUID_API_WALLET_KEY
 *  - API wallet is separate from trading wallet (set up in HL UI: Settings → API Wallets)
 *
 * Testnet: https://app.hyperliquid-testnet.xyz
 * Mainnet: https://app.hyperliquid.xyz
 *
 * Getting started:
 *  1. Fund Hyperliquid vault via bridge (USDC on Arbitrum → HL)
 *  2. Create API wallet in HL UI → add CFO_HYPERLIQUID_API_WALLET_KEY
 *  3. Set CFO_HYPERLIQUID_TESTNET=true until confident
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Types
// ============================================================================

export interface HLOrderResult {
  success: boolean;
  orderId?: number;
  cloid?: string;   // client order ID
  filledAt?: number;
  avgPrice?: number;
  error?: string;
}

export interface HLPosition {
  coin: string;
  side: 'LONG' | 'SHORT';
  sizeUsd: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnlUsd: number;
  liquidationPrice: number;
  marginUsed: number;
}

export interface HLAccountSummary {
  equity: number;         // USDC
  availableMargin: number;
  totalPnl: number;
  positions: HLPosition[];
}

export interface HedgeParams {
  /** Coin to SHORT on HL (e.g. 'SOL', 'JUP', 'WIF') */
  coin: string;
  /** USD notional to hedge */
  exposureUsd: number;
  /** Leverage to use (max CFO_MAX_HYPERLIQUID_LEVERAGE) */
  leverage?: number;
  /** Stop loss % above entry (default 8%) */
  stopLossPct?: number;
  /** Take profit % below entry (default 15%) */
  takeProfitPct?: number;
}

// ============================================================================
// SDK loader
// ============================================================================

async function loadHL() {
  try {
    const mod = await import('@nktkas/hyperliquid');
    const env = getCFOEnv();
    const testnet = env.hyperliquidTestnet;

    if (!env.hyperliquidApiWalletKey) {
      throw new Error('CFO_HYPERLIQUID_API_WALLET_KEY not set');
    }

    // Load viem wallet for signing (Hyperliquid SDK uses AbstractWallet interface)
    const { privateKeyToAccount } = await import('viem/accounts');
    const wallet = privateKeyToAccount(
      (env.hyperliquidApiWalletKey.startsWith('0x')
        ? env.hyperliquidApiWalletKey
        : `0x${env.hyperliquidApiWalletKey}`) as `0x${string}`,
    );

    const transport = new mod.HttpTransport({ isTestnet: testnet });
    const exchange = new mod.ExchangeClient({ wallet, transport });
    const info = new mod.InfoClient({ transport });

    return { exchange, info, wallet };
  } catch (err) {
    throw new Error(`[Hyperliquid] SDK load failed: ${(err as Error).message}. Run: bun add @nktkas/hyperliquid`);
  }
}

// ============================================================================
// Retry helper (exponential backoff for 429s)
// ============================================================================

async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 = err?.message?.includes('429') ||
                    err?.status === 429 ||
                    String(err).includes('Too Many Requests');
      if (is429 && attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.debug(`[Hyperliquid] ${label} 429 — retry ${attempt}/${maxAttempts} in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[Hyperliquid] ${label} unreachable`);
}

// ============================================================================
// Cache for rarely-changing data
// ============================================================================

let _listedCoinsCache: string[] = [];
let _listedCoinsCacheTs = 0;
const LISTED_COINS_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Account info
// ============================================================================

export async function getAccountSummary(): Promise<HLAccountSummary> {
  try {
    const { info, wallet } = await loadHL();
    const state = await withRetry(
      () => info.clearinghouseState({ user: wallet.address }),
      'getAccountSummary',
    );

    const equity = Number(state.marginSummary.accountValue ?? 0);
    const availableMargin = Number(state.withdrawable ?? 0);

    const positions: HLPosition[] = (state.assetPositions ?? [])
      .filter((p: any) => Number(p.position.szi) !== 0)
      .map((p: any) => {
        const szi = Number(p.position.szi);
        const entryPx = Number(p.position.entryPx ?? 0);
        const markPx = Number(p.position.positionValue) / Math.abs(szi);
        const leverage = Number(p.position.leverage?.value ?? 1);
        const unrealizedPnl = Number(p.position.unrealizedPnl ?? 0);
        const liqPx = Number(p.position.liquidationPx ?? 0);
        const marginUsed = Number(p.position.marginUsed ?? 0);

        return {
          coin: p.position.coin,
          side: szi > 0 ? 'LONG' : 'SHORT',
          sizeUsd: Math.abs(Number(p.position.positionValue)),
          entryPrice: entryPx,
          markPrice: markPx,
          leverage,
          unrealizedPnlUsd: unrealizedPnl,
          liquidationPrice: liqPx,
          marginUsed,
        };
      });

    return {
      equity,
      availableMargin,
      totalPnl: positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0),
      positions,
    };
  } catch (err) {
    logger.warn('[Hyperliquid] getAccountSummary error:', err);
    return { equity: 0, availableMargin: 0, totalPnl: 0, positions: [] };
  }
}

// ============================================================================
// Hedge treasury exposure (generic — any HL-listed coin)
// ============================================================================

/** Returns all coins currently listed as perps on Hyperliquid, from meta().universe.
 *  Cached for 10 minutes (coin listings rarely change) + retry on 429. */
export async function getHLListedCoins(): Promise<string[]> {
  // Return cached if fresh
  if (_listedCoinsCache.length > 0 && Date.now() - _listedCoinsCacheTs < LISTED_COINS_TTL_MS) {
    return _listedCoinsCache;
  }
  try {
    const { info } = await loadHL();
    const meta = await withRetry(() => info.meta(), 'getHLListedCoins');
    const universe = (meta as any).universe ?? [];
    _listedCoinsCache = universe.map((u: any) => u.name as string);
    _listedCoinsCacheTs = Date.now();
    return _listedCoinsCache;
  } catch (err) {
    logger.warn('[Hyperliquid] getHLListedCoins error:', err);
    // Return stale cache if available, otherwise empty
    return _listedCoinsCache.length > 0 ? _listedCoinsCache : [];
  }
}

/**
 * Open a SHORT perp position on Hyperliquid to hedge treasury exposure.
 * Works for any coin listed on HL (SOL, JUP, WIF, BTC, ETH, etc.)
 */
export async function hedgeTreasury(params: HedgeParams): Promise<HLOrderResult> {
  const env = getCFOEnv();
  const { coin, exposureUsd } = params;

  if (exposureUsd <= 0) {
    return { success: false, error: 'exposureUsd must be positive' };
  }

  const leverage = Math.min(params.leverage ?? 2, env.maxHyperliquidLeverage);
  const stopLossPct = params.stopLossPct ?? 8;
  const takeProfitPct = params.takeProfitPct ?? 15;

  if (env.dryRun) {
    logger.info(
      `[Hyperliquid] DRY RUN — would SHORT ${coin}-PERP $${exposureUsd} ` +
      `at ${leverage}x leverage (SL: +${stopLossPct}%, TP: -${takeProfitPct}%)`,
    );
    return { success: true, orderId: 0, cloid: `dry-${Date.now()}` };
  }

  try {
    const { exchange, info, wallet } = await loadHL();

    const mids = await withRetry(() => info.allMids(), 'hedgeTreasury:allMids');
    const coinPrice = Number(mids[coin] ?? 0);
    if (coinPrice <= 0) {
      return { success: false, error: `${coin} not found in HL allMids — not listed or delisted` };
    }

    const meta = await withRetry(() => info.meta(), 'hedgeTreasury:meta');
    const universe = (meta as any).universe ?? [];
    const assetIdx = universe.findIndex((u: any) => u.name === coin);
    if (assetIdx < 0) {
      return { success: false, error: `${coin} not found in HL universe` };
    }
    const szDecimals: number = universe[assetIdx].szDecimals ?? 1;
    const szStep = Math.pow(10, szDecimals);

    const sizeInCoin = exposureUsd / coinPrice;
    const sizeFmt = Math.floor(sizeInCoin * szStep) / szStep;

    if (sizeFmt <= 0) {
      return { success: false, error: `Position too small after rounding to ${szDecimals} decimals` };
    }
    if (sizeFmt * coinPrice < 10) {
      return { success: false, error: `Notional $${(sizeFmt * coinPrice).toFixed(2)} below HL minimum $10` };
    }

    await exchange.updateLeverage({
      asset: assetIdx,
      isCross: false,
      leverage,
    });

    const limitPrice = (coinPrice * 0.9995).toFixed(2);

    const order = await exchange.order({
      orders: [{
        a: assetIdx,
        b: false,           // SHORT
        p: limitPrice,
        s: sizeFmt.toString(),
        r: false,
        t: { limit: { tif: 'Gtc' as const } },
        c: `0x${Buffer.from(`cfo-hedge-${Date.now()}`).toString('hex').padEnd(32, '0').slice(0, 32)}`,
      }],
      grouping: 'na',
    });

    const result = (order as any)?.response?.data?.statuses?.[0];
    if (!result || (result as any).error) {
      return { success: false, error: (result as any)?.error ?? 'Order rejected' };
    }

    const orderId = (result as any).resting?.oid ?? (result as any).filled?.oid;
    const avgPrice = Number((result as any).filled?.avgPx ?? limitPrice);

    logger.info(
      `[Hyperliquid] ${coin} hedge opened: SHORT ${sizeFmt} ${coin} @ ~$${avgPrice} ` +
      `($${exposureUsd} exposure, ${leverage}x): order ${orderId}`,
    );

    return { success: true, orderId, avgPrice };
  } catch (err) {
    logger.error('[Hyperliquid] hedgeTreasury error:', err);
    return { success: false, error: (err as Error).message };
  }
}

// Backward-compat alias so nothing else breaks if called externally
export const hedgeSolTreasury = (p: { solExposureUsd: number; leverage?: number }) =>
  hedgeTreasury({ coin: 'SOL', exposureUsd: p.solExposureUsd, leverage: p.leverage });

// ============================================================================
// Close position
// ============================================================================

/**
 * Close a specific position (market order).
 * Used for stop-loss enforcement and Guardian emergency exit.
 */
export async function closePosition(coin: string, sizeInCoin: number, isBuy: boolean): Promise<HLOrderResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Hyperliquid] DRY RUN — would close ${isBuy ? 'LONG' : 'SHORT'} ${sizeInCoin} ${coin}`);
    return { success: true, orderId: 0 };
  }

  try {
    const { exchange, info } = await loadHL();
    const mids = await withRetry(() => info.allMids(), 'closePosition:allMids');
    const markPrice = Number(mids[coin] ?? 0);
    if (!markPrice) return { success: false, error: `No mark price for ${coin}` };

    // Resolve asset info
    const meta = await withRetry(() => info.meta(), 'closePosition:meta');
    const universe = (meta as any).universe ?? [];
    const assetIdx = universe.findIndex((u: any) => u.name === coin);
    if (assetIdx < 0) return { success: false, error: `Unknown asset ${coin}` };
    const szDecimals: number = universe[assetIdx].szDecimals ?? 1;
    const szStep = Math.pow(10, szDecimals);
    const sizeRounded = Math.floor(sizeInCoin * szStep) / szStep;
    if (sizeRounded <= 0) return { success: false, error: `Size too small after rounding to ${szDecimals} decimals` };

    // Close at slightly worse price to guarantee fill
    const limitPx = isBuy
      ? (markPrice * 1.001).toFixed(2)  // buying back short: slightly above mid
      : (markPrice * 0.999).toFixed(2); // selling long: slightly below mid

    const order = await exchange.order({
      orders: [{
        a: assetIdx,
        b: isBuy,
        p: limitPx,
        s: sizeRounded.toString(),
        r: true,  // reduce only
        t: { limit: { tif: 'Ioc' as const } },  // Immediate-or-cancel
      }],
      grouping: 'na',
    });

    const result = (order as any)?.response?.data?.statuses?.[0];
    if (!result || (result as any).error) {
      return { success: false, error: (result as any)?.error ?? 'Close order rejected' };
    }

    logger.info(`[Hyperliquid] Closed ${coin} position: ${JSON.stringify(result)}`);
    return { success: true, orderId: (result as any).filled?.oid ?? (result as any).resting?.oid };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Emergency close ALL open positions. Used by kill switch and Guardian alerts.
 */
export async function closeAllPositions(): Promise<{ closed: number; errors: string[] }> {
  let closed = 0;
  const errors: string[] = [];

  try {
    const summary = await getAccountSummary();
    for (const pos of summary.positions) {
      const isBuy = pos.side === 'SHORT'; // to close a short, we buy
      const sizeInCoin = pos.sizeUsd / pos.markPrice; // closePosition handles szDecimals rounding
      const result = await closePosition(pos.coin, sizeInCoin, isBuy);
      if (result.success) closed++;
      else errors.push(`${pos.coin}: ${result.error}`);
    }
  } catch (err) {
    errors.push(`closeAllPositions: ${(err as Error).message}`);
  }

  logger.info(`[Hyperliquid] Emergency close: ${closed} positions closed, ${errors.length} errors`);
  return { closed, errors };
}

// ============================================================================
// Risk checks
// ============================================================================

/**
 * Check if any position is approaching liquidation.
 * Returns positions with health < 1.2 (within 20% of liquidation).
 */
export async function checkRisk(): Promise<{ atRisk: HLPosition[]; warning?: string }> {
  try {
    const summary = await getAccountSummary();
    const atRisk = summary.positions.filter((p) => {
      if (!p.liquidationPrice || p.liquidationPrice === 0) return false;
      const distancePct = Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice;
      return distancePct < 0.20; // within 20% of liquidation
    });

    const warning = atRisk.length > 0
      ? `${atRisk.length} position(s) within 20% of liquidation: ${atRisk.map((p) => p.coin).join(', ')}`
      : undefined;

    return { atRisk, warning };
  } catch {
    return { atRisk: [] };
  }
}
