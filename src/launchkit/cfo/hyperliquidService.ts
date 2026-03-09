/**
 * Hyperliquid Perpetuals Service
 *
 * Provides perpetual futures trading via Hyperliquid's DEX.
 * Supports:
 *  1. Treasury hedging — SHORT perps to offset on-chain exposure
 *  2. Directional perp trading — LONG/SHORT based on signals (sentiment, momentum, news)
 *
 * Architecture doc constraints (enforced in code):
 *  - Max 20% of portfolio (configurable)
 *  - Max 5x leverage (hard cap)
 *  - Perp trading gated behind CFO_HL_PERP_TRADING_ENABLE
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

/** Parameters for a directional perp trade (LONG or SHORT) driven by signals */
export interface PerpTradeParams {
  /** Coin to trade (e.g. 'BTC', 'ETH', 'SOL') */
  coin: string;
  /** Trade direction */
  side: 'LONG' | 'SHORT';
  /** USD notional size */
  sizeUsd: number;
  /** Leverage (clamped to env max) */
  leverage?: number;
  /** Stop loss % from entry (default 5%) */
  stopLossPct?: number;
  /** Take profit % from entry (default 10%) */
  takeProfitPct?: number;
  /** Signal source that triggered this trade (for logging) */
  signal?: string;
  /** Conviction score 0-1 (for logging / future sizing) */
  conviction?: number;
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

// ── Price formatting ────────────────────────────────────────────────────────
// HL perp price validation (from @nktkas/hyperliquid/utils.formatPrice):
//   1. Max decimal places = 6 - szDecimals
//   2. Max 5 significant figures
//   3. Truncate (floor) toward zero, don't round
// Without this, cheap coins like W at $0.02 get too many decimals and HL
// rejects with "Order has invalid price".
function formatLimitPrice(price: number, szDecimals: number): string {
  if (price <= 0) return '0';
  // Rule 1: HL perp max decimals = 6 - szDecimals
  const maxDecimals = Math.max(6 - szDecimals, 0);
  // Rule 2: 5 significant figures
  const magnitude = Math.floor(Math.log10(Math.abs(price)));
  const sigFigDecimals = Math.max(0, 5 - 1 - magnitude);
  // Take the stricter of the two limits
  const decimals = Math.min(maxDecimals, sigFigDecimals);
  // Truncate toward zero (like HL's formatPrice) rather than rounding
  const factor = Math.pow(10, decimals);
  return (Math.trunc(price * factor) / factor).toFixed(decimals);
}

// ── Halted coins cache ──────────────────────────────────────────────────────
// When HL returns "Trading is halted" for a coin, remember it for 30 minutes
// so the signal engine doesn't keep trying every cycle.
const _haltedCoins = new Map<string, number>(); // coin → timestamp
const HALTED_COIN_TTL_MS = 30 * 60 * 1000; // 30 min

export function isHalted(coin: string): boolean {
  const ts = _haltedCoins.get(coin);
  if (!ts) return false;
  if (Date.now() - ts > HALTED_COIN_TTL_MS) {
    _haltedCoins.delete(coin);
    return false;
  }
  return true;
}

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

    // Use aggressive slippage (2%) with IoC so we fill immediately or cancel.
    // Gtc limit orders linger as open orders if not filled, causing DB/monitor desync.
    // formatLimitPrice keeps enough decimals so slippage survives on cheap coins.
    const limitPrice = formatLimitPrice(coinPrice * 0.98, szDecimals);

    const order = await exchange.order({
      orders: [{
        a: assetIdx,
        b: false,           // SHORT
        p: limitPrice,
        s: sizeFmt.toString(),
        r: false,
        t: { limit: { tif: 'Ioc' as const } },
        c: `0x${Buffer.from(`cfo-hedge-${Date.now()}`).toString('hex').padEnd(32, '0').slice(0, 32)}`,
      }],
      grouping: 'na',
    });

    const result = (order as any)?.response?.data?.statuses?.[0];
    if (!result || (result as any).error) {
      return { success: false, error: (result as any)?.error ?? 'Order rejected' };
    }

    // IoC: if order rested instead of filling, it was auto-cancelled — treat as failure
    if ((result as any).resting) {
      logger.warn(`[Hyperliquid] Hedge ${coin} order rested (not filled) — IoC auto-cancelled`);
      return { success: false, error: 'Order did not fill (IoC)' };
    }

    const orderId = (result as any).filled?.oid;
    const avgPrice = Number((result as any).filled?.avgPx ?? limitPrice);

    logger.info(
      `[Hyperliquid] ${coin} hedge opened: SHORT ${sizeFmt} ${coin} @ ~$${avgPrice} ` +
      `($${exposureUsd} exposure, ${leverage}x): order ${orderId}`,
    );

    return { success: true, orderId, avgPrice };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err ?? '');
    if (msg.includes('Insufficient margin')) {
      logger.warn(`[Hyperliquid] ${coin} hedge skipped — insufficient margin`);
      return { success: false, error: 'Insufficient margin' };
    }
    logger.error('[Hyperliquid] hedgeTreasury error:', err);
    return { success: false, error: msg };
  }
}

// Backward-compat alias so nothing else breaks if called externally
export const hedgeSolTreasury = (p: { solExposureUsd: number; leverage?: number }) =>
  hedgeTreasury({ coin: 'SOL', exposureUsd: p.solExposureUsd, leverage: p.leverage });

// ============================================================================
// Directional perp trade (signal-driven — LONG or SHORT any listed coin)
// ============================================================================

/**
 * Open a directional perp trade on Hyperliquid.
 * Supports LONG and SHORT. Used by the signal-driven decision engine
 * (Phase 1: sentiment + momentum, Phase 2: multi-asset, Phase 3: news-reactive).
 *
 * NOT a hedge — this is a conviction-based trade with its own TP/SL.
 */
export async function openPerpTrade(params: PerpTradeParams): Promise<HLOrderResult> {
  const env = getCFOEnv();
  const { coin, side, sizeUsd } = params;

  if (sizeUsd <= 0) {
    return { success: false, error: 'sizeUsd must be positive' };
  }

  // Skip coins that HL has halted (cached for 30 min)
  if (isHalted(coin)) {
    logger.info(`[Hyperliquid] Skipping ${side} ${coin}-PERP — trading halted (cached)`);
    return { success: false, error: `${coin} trading is halted` };
  }

  const leverage = Math.min(params.leverage ?? 2, env.maxHyperliquidLeverage);
  const stopLossPct = params.stopLossPct ?? 5;
  const takeProfitPct = params.takeProfitPct ?? 10;
  const isLong = side === 'LONG';
  const signalTag = params.signal ?? 'manual';
  const conviction = params.conviction ?? 0;

  if (env.dryRun) {
    logger.info(
      `[Hyperliquid] DRY RUN — would ${side} ${coin}-PERP $${sizeUsd.toFixed(0)} ` +
      `at ${leverage}x (SL: ${stopLossPct}%, TP: ${takeProfitPct}%) ` +
      `signal=${signalTag} conviction=${(conviction * 100).toFixed(0)}%`,
    );
    return { success: true, orderId: 0, cloid: `dry-perp-${Date.now()}` };
  }

  try {
    const { exchange, info, wallet } = await loadHL();

    const mids = await withRetry(() => info.allMids(), 'openPerpTrade:allMids');
    const coinPrice = Number(mids[coin] ?? 0);
    if (coinPrice <= 0) {
      return { success: false, error: `${coin} not found in HL allMids — not listed or delisted` };
    }

    const meta = await withRetry(() => info.meta(), 'openPerpTrade:meta');
    const universe = (meta as any).universe ?? [];
    const assetIdx = universe.findIndex((u: any) => u.name === coin);
    if (assetIdx < 0) {
      return { success: false, error: `${coin} not found in HL universe` };
    }
    const szDecimals: number = universe[assetIdx].szDecimals ?? 1;
    const szStep = Math.pow(10, szDecimals);

    const sizeInCoin = sizeUsd / coinPrice;
    const sizeFmt = Math.floor(sizeInCoin * szStep) / szStep;

    if (sizeFmt <= 0) {
      return { success: false, error: `Position too small after rounding to ${szDecimals} decimals` };
    }
    if (sizeFmt * coinPrice < 10) {
      return { success: false, error: `Notional $${(sizeFmt * coinPrice).toFixed(2)} below HL minimum $10` };
    }

    // Pre-check available margin to avoid noisy "Insufficient margin" errors
    const marginNeeded = sizeUsd / leverage;
    const acctState = await withRetry(
      () => info.clearinghouseState({ user: wallet.address }),
      'openPerpTrade:marginCheck',
    );
    const availableMargin = Number((acctState as any).withdrawable ?? 0);
    if (availableMargin < marginNeeded * 1.05) { // 5% buffer for fees
      logger.warn(
        `[Hyperliquid] ${side} ${coin}-PERP skipped — need $${marginNeeded.toFixed(2)} margin, only $${availableMargin.toFixed(2)} available`,
      );
      return { success: false, error: 'Insufficient margin' };
    }

    await exchange.updateLeverage({
      asset: assetIdx,
      isCross: false,
      leverage,
    });

    // Use IoC (Immediate-or-Cancel) with 2% slippage to ensure immediate fill.
    // Gtc would leave unfilled limit orders on the book, causing DB/monitor desync loops.
    // formatLimitPrice keeps enough decimals so slippage survives on cheap coins.
    const limitPrice = isLong
      ? formatLimitPrice(coinPrice * 1.02, szDecimals)
      : formatLimitPrice(coinPrice * 0.98, szDecimals);

    const order = await exchange.order({
      orders: [{
        a: assetIdx,
        b: isLong,          // true = BUY (LONG), false = SELL (SHORT)
        p: limitPrice,
        s: sizeFmt.toString(),
        r: false,
        t: { limit: { tif: 'Ioc' as const } },
        c: `0x${Buffer.from(`cfo-perp-${side.toLowerCase()}-${Date.now()}`).toString('hex').padEnd(32, '0').slice(0, 32)}`,
      }],
      grouping: 'na',
    });

    const result = (order as any)?.response?.data?.statuses?.[0];
    if (!result || (result as any).error) {
      return { success: false, error: (result as any)?.error ?? 'Order rejected' };
    }

    // IoC: if order rested instead of filling, it was auto-cancelled — treat as failure
    if ((result as any).resting) {
      logger.warn(`[Hyperliquid] ${side} ${coin}-PERP order rested (not filled) — IoC auto-cancelled`);
      return { success: false, error: 'Order did not fill (IoC)' };
    }

    const orderId = (result as any).filled?.oid;
    const avgPrice = Number((result as any).filled?.avgPx ?? limitPrice);

    logger.info(
      `[Hyperliquid] ${side} ${coin}-PERP opened: ${sizeFmt} ${coin} @ ~$${avgPrice} ` +
      `($${sizeUsd.toFixed(0)}, ${leverage}x) signal=${signalTag} ` +
      `conviction=${(conviction * 100).toFixed(0)}%: order ${orderId}`,
    );

    // ── Place native HL TP/SL trigger orders on-exchange ──────────
    // These fire even if our monitor is down. The 2-min monitor handles
    // trailing stops & partial profit; these are the safety net.
    try {
      const slPrice = isLong
        ? avgPrice * (1 - stopLossPct / 100)
        : avgPrice * (1 + stopLossPct / 100);
      const tpPrice = isLong
        ? avgPrice * (1 + takeProfitPct / 100)
        : avgPrice * (1 - takeProfitPct / 100);

      const slPriceFmt = formatLimitPrice(slPrice, szDecimals);
      const tpPriceFmt = formatLimitPrice(tpPrice, szDecimals);

      await exchange.order({
        orders: [
          {
            a: assetIdx,
            b: !isLong,        // opposite side to close
            p: slPriceFmt,     // for market trigger, p = triggerPx
            s: sizeFmt.toString(),
            r: true,           // reduce-only
            t: { trigger: { isMarket: true, triggerPx: slPriceFmt, tpsl: 'sl' as const } },
          },
          {
            a: assetIdx,
            b: !isLong,
            p: tpPriceFmt,
            s: sizeFmt.toString(),
            r: true,
            t: { trigger: { isMarket: true, triggerPx: tpPriceFmt, tpsl: 'tp' as const } },
          },
        ],
        grouping: 'positionTpsl',  // adjusts proportionally with position size
      });

      logger.info(
        `[Hyperliquid] ${coin}-PERP native TP/SL set: ` +
        `SL=$${slPriceFmt} (${stopLossPct}%), TP=$${tpPriceFmt} (${takeProfitPct}%)`,
      );
    } catch (tpslErr) {
      // Non-fatal — the 2-min monitor will still enforce SL/TP via polling
      logger.warn(`[Hyperliquid] Failed to place native TP/SL for ${coin}-PERP:`, tpslErr);
    }

    return { success: true, orderId, avgPrice };
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '');
    // "Trading is halted" is a known HL-side halt (e.g. during rugs/delistings).
    // Cache it so we don't retry every cycle and pollute logs with stack traces.
    if (msg.includes('Trading is halted') || msg.includes('trading is halted')) {
      _haltedCoins.set(coin, Date.now());
      logger.warn(`[Hyperliquid] ${coin}-PERP trading is halted on HL — skipping for 30min`);
      return { success: false, error: `${coin} trading is halted` };
    }
    if (msg.includes('Insufficient margin')) {
      logger.warn(`[Hyperliquid] ${side} ${coin}-PERP skipped — insufficient margin`);
      return { success: false, error: 'Insufficient margin' };
    }
    logger.error(`[Hyperliquid] openPerpTrade(${side} ${coin}) error:`, err);
    return { success: false, error: msg };
  }
}

/**
 * Get all mid prices from HL (for signal engine price comparison).
 * Cached briefly to avoid 429s during multi-coin scoring.
 */
let _allMidsCache: Record<string, number> = {};
let _allMidsCacheTs = 0;
const ALL_MIDS_TTL_MS = 30_000; // 30 seconds

export async function getAllMidPrices(): Promise<Record<string, number>> {
  if (Object.keys(_allMidsCache).length > 0 && Date.now() - _allMidsCacheTs < ALL_MIDS_TTL_MS) {
    return _allMidsCache;
  }
  try {
    const { info } = await loadHL();
    const mids = await withRetry(() => info.allMids(), 'getAllMidPrices');
    const result: Record<string, number> = {};
    for (const [coin, price] of Object.entries(mids)) {
      result[coin] = Number(price);
    }
    _allMidsCache = result;
    _allMidsCacheTs = Date.now();
    return result;
  } catch (err) {
    logger.warn('[Hyperliquid] getAllMidPrices error:', err);
    return _allMidsCache; // return stale cache if available
  }
}

// ============================================================================
// Funding rates + Open Interest (per asset context)
// ============================================================================

export interface AssetContext {
  coin: string;
  funding: number;        // current hourly funding rate (e.g. 0.0001 = 0.01%/hr)
  openInterest: number;   // open interest in USD
  dayNtlVlm: number;      // 24h notional volume in USD
  markPx: number;
}

let _assetCtxCache: Map<string, AssetContext> = new Map();
let _assetCtxCacheTs = 0;
const ASSET_CTX_TTL_MS = 60_000; // 1 minute — funding changes slowly

/** Get per-asset context (funding rate, OI, volume) from HL.
 *  Cached for 60s. Returns Map<coin, AssetContext>. */
export async function getAssetContexts(): Promise<Map<string, AssetContext>> {
  if (_assetCtxCache.size > 0 && Date.now() - _assetCtxCacheTs < ASSET_CTX_TTL_MS) {
    return _assetCtxCache;
  }
  try {
    const { info } = await loadHL();
    const data = await withRetry(() => info.metaAndAssetCtxs(), 'getAssetContexts');
    const universe = (data as any)?.[0]?.universe ?? (data as any)?.meta?.universe ?? [];
    const ctxs = (data as any)?.[1] ?? (data as any)?.assetCtxs ?? [];
    const result = new Map<string, AssetContext>();
    for (let i = 0; i < universe.length && i < ctxs.length; i++) {
      const name: string = universe[i].name;
      const ctx = ctxs[i];
      result.set(name, {
        coin: name,
        funding: Number(ctx.funding ?? 0),
        openInterest: Number(ctx.openInterest ?? 0),
        dayNtlVlm: Number(ctx.dayNtlVlm ?? 0),
        markPx: Number(ctx.markPx ?? 0),
      });
    }
    _assetCtxCache = result;
    _assetCtxCacheTs = Date.now();
    return result;
  } catch (err) {
    logger.warn('[Hyperliquid] getAssetContexts error:', err);
    return _assetCtxCache; // return stale if available
  }
}

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
    // Use 1% slippage with formatLimitPrice for proper precision on cheap coins
    const limitPx = isBuy
      ? formatLimitPrice(markPrice * 1.01, szDecimals)  // buying back short: above mid
      : formatLimitPrice(markPrice * 0.99, szDecimals); // selling long: below mid

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
 * Cancel all open (resting) orders. Cleans up stale Gtc orders that never filled.
 */
export async function cancelAllOpenOrders(): Promise<{ cancelled: number; errors: string[] }> {
  let cancelled = 0;
  const errors: string[] = [];
  try {
    const { exchange, info, wallet } = await loadHL();
    const openOrders = await info.openOrders({ user: wallet.address });
    if (!openOrders || openOrders.length === 0) return { cancelled: 0, errors: [] };

    // Map coin name → asset index for the cancel API
    const meta = await info.meta();
    const universe = (meta as any).universe ?? [];
    const coinToAsset = new Map<string, number>();
    for (let i = 0; i < universe.length; i++) {
      coinToAsset.set(universe[i].name, i);
    }

    for (const o of openOrders) {
      try {
        const assetIdx = coinToAsset.get(o.coin);
        if (assetIdx === undefined) {
          errors.push(`${o.coin}: unknown asset`);
          continue;
        }
        await exchange.cancel({ cancels: [{ a: assetIdx, o: o.oid }] });
        cancelled++;
        logger.info(`[Hyperliquid] Cancelled stale order ${o.oid} (${o.coin} ${o.side === 'B' ? 'BUY' : 'SELL'})`);
      } catch (e) {
        errors.push(`${o.coin}/${o.oid}: ${(e as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`cancelAllOpenOrders: ${(err as Error).message}`);
  }
  if (cancelled > 0) logger.info(`[Hyperliquid] Cancelled ${cancelled} stale open orders`);
  return { cancelled, errors };
}

/**
 * Cancel all trigger (TP/SL) orders for a specific coin.
 * Call this when the monitor closes a position to prevent stale triggers
 * from firing on a future position in the same coin.
 */
export async function cancelTriggerOrdersForCoin(coin: string): Promise<void> {
  try {
    const { exchange, info, wallet } = await loadHL();
    const openOrders = await info.openOrders({ user: wallet.address });
    if (!openOrders || openOrders.length === 0) return;

    const meta = await info.meta();
    const universe = (meta as any).universe ?? [];
    const assetIdx = universe.findIndex((u: any) => u.name === coin);
    if (assetIdx < 0) return;

    const coinOrders = openOrders.filter((o: any) => o.coin === coin);
    for (const o of coinOrders) {
      try {
        await exchange.cancel({ cancels: [{ a: assetIdx, o: o.oid }] });
        logger.info(`[Hyperliquid] Cancelled trigger order ${o.oid} for ${coin}`);
      } catch (e) {
        logger.debug(`[Hyperliquid] Failed to cancel order ${o.oid} for ${coin}: ${(e as Error).message}`);
      }
    }
  } catch (err) {
    logger.debug(`[Hyperliquid] cancelTriggerOrdersForCoin(${coin}) error:`, err);
  }
}

/**
 * Emergency close ALL open positions. Used by kill switch and Guardian alerts.
 */
export async function closeAllPositions(): Promise<{ closed: number; errors: string[] }> {
  let closed = 0;
  const errors: string[] = [];

  try {
    // Cancel any open (resting) orders first — they use margin and could interfere
    await cancelAllOpenOrders().catch(e => errors.push(`cancelOrders: ${(e as Error).message}`));

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
