/**
 * Hyperliquid Trading Service
 *
 * Provides perpetual futures + spot trading via Hyperliquid's DEX.
 * Supports:
 *  1. Treasury hedging — SHORT perps to offset on-chain exposure
 *  2. Directional perp trading — LONG/SHORT based on signals (sentiment, momentum, news)
 *  3. Spot trading — BUY/SELL spot tokens for TA-driven trades + treasury accumulation
 *
 * Architecture doc constraints (enforced in code):
 *  - Max 20% of portfolio for perps (configurable)
 *  - Max 5x leverage (hard cap, perps only — spot is 1x)
 *  - Perp trading gated behind CFO_HL_PERP_TRADING_ENABLE
 *  - Spot trading gated behind CFO_HL_SPOT_TRADING_ENABLE
 *
 * Hyperliquid auth:
 *  - Uses @nktkas/hyperliquid SDK
 *  - L1 auth via EIP-712 signing with CFO_HYPERLIQUID_API_WALLET_KEY
 *  - API wallet is separate from trading wallet (set up in HL UI: Settings → API Wallets)
 *
 * Spot details:
 *  - Same exchange.order() method but with pair indices starting at 10000
 *  - No leverage, no reduce-only, no native TP/SL trigger orders
 *  - Separate spot clearinghouse (spotClearinghouseState) for balances
 *  - Candle data: "COIN/USDC" format for spotCandleSnapshot / candleSnapshot
 *  - USDC must be transferred to spot account via usdClassTransfer()
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

/** Parameters for a spot trade on HL (BUY or SELL) */
export interface SpotTradeParams {
  /** Coin to trade (e.g. 'HYPE', 'BTC', 'SOL') */
  coin: string;
  /** Trade direction — BUY = acquire base token, SELL = dispose base token */
  side: 'BUY' | 'SELL';
  /** USD notional size */
  sizeUsd: number;
  /** Signal source (for logging) */
  signal?: string;
  /** Conviction score 0-1 (for logging) */
  conviction?: number;
}

/** Spot balance for a single token */
export interface HLSpotBalance {
  coin: string;
  total: number;       // total balance (includes held/in-order)
  hold: number;        // amount held in open orders
  available: number;   // total - hold
  entryNtl: number;    // entry notional in USDC
  valueUsd: number;    // current value based on mid price
}

/** HL spot pair metadata */
export interface HLSpotPair {
  name: string;       // e.g. "PURR/USDC"
  coin: string;       // base coin e.g. "PURR"
  index: number;      // pair index (10000+)
  szDecimals: number; // size decimal precision
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

// ── OI-capped coins cache ───────────────────────────────────────────────────
// When HL rejects an order because open interest is at cap, remember it for
// 15 minutes so we don't keep wasting API calls on the same coin.
const _oiCappedCoins = new Map<string, number>(); // coin → timestamp
const OI_CAP_TTL_MS = 15 * 60 * 1000; // 15 min

export function isOICapped(coin: string): boolean {
  const ts = _oiCappedCoins.get(coin);
  if (!ts) return false;
  if (Date.now() - ts > OI_CAP_TTL_MS) {
    _oiCappedCoins.delete(coin);
    return false;
  }
  return true;
}

function markOICapped(coin: string): void {
  _oiCappedCoins.set(coin, Date.now());
  logger.info(`[Hyperliquid] ${coin} marked OI-capped for ${OI_CAP_TTL_MS / 60000} minutes`);
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
  // Skip coins at OI cap (cached for 15 min after rejection)
  if (isOICapped(coin)) {
    logger.info(`[Hyperliquid] Skipping ${side} ${coin}-PERP — OI capped (cached)`);
    return { success: false, error: `${coin} open interest at cap` };
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
      const errMsg: string = (result as any)?.error ?? 'Order rejected';
      // Cache OI-capped coins to avoid retrying every cycle
      if (errMsg.toLowerCase().includes('open interest') && errMsg.toLowerCase().includes('cap')) {
        markOICapped(coin);
      }
      return { success: false, error: errMsg };
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
    // OI cap — HL rejects new positions when the exchange's OI limit is reached
    if (msg.toLowerCase().includes('open interest') && msg.toLowerCase().includes('cap')) {
      markOICapped(coin);
      return { success: false, error: `${coin} open interest at cap` };
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
// Spot trading — BUY/SELL spot tokens on Hyperliquid
// ============================================================================

// ── Spot metadata cache ─────────────────────────────────────────────────────
let _spotPairsCache: HLSpotPair[] = [];
let _spotPairsCacheTs = 0;
const SPOT_PAIRS_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get all spot trading pairs on Hyperliquid.
 * Returns pairs with index (10000+), base coin symbol, and szDecimals.
 * Cached for 10 minutes.
 */
export async function getSpotPairs(): Promise<HLSpotPair[]> {
  if (_spotPairsCache.length > 0 && Date.now() - _spotPairsCacheTs < SPOT_PAIRS_TTL_MS) {
    return _spotPairsCache;
  }
  try {
    const { info } = await loadHL();
    const data = await withRetry(() => info.spotMeta(), 'getSpotPairs');
    const universe = (data as any)?.universe ?? [];
    const tokens = (data as any)?.tokens ?? [];

    const pairs: HLSpotPair[] = [];
    for (const u of universe) {
      const name: string = u.name; // e.g. "PURR/USDC" or "@107" (most pairs use @N index format)
      const pairIndex: number = u.index;
      const baseTokenIdx: number = u.tokens?.[0];
      const quoteTokenIdx: number = u.tokens?.[1] ?? 0;
      const baseToken = tokens.find((t: any) => t.index === baseTokenIdx);
      if (!baseToken) continue; // skip pairs with unknown base token
      // Only include USDC-quoted pairs (quoteTokenIdx 0 = USDC)
      if (quoteTokenIdx !== 0) continue;
      const szDecimals: number = baseToken?.szDecimals ?? 2;
      // Use the token name (e.g. "HYPE", "PURR", "TRUMP") not the pair name (@107)
      const coin: string = baseToken.name;
      if (!coin || coin === 'USDC') continue;
      pairs.push({ name, coin, index: pairIndex, szDecimals });
    }

    _spotPairsCache = pairs;
    _spotPairsCacheTs = Date.now();
    return pairs;
  } catch (err) {
    logger.warn('[Hyperliquid] getSpotPairs error:', err);
    return _spotPairsCache.length > 0 ? _spotPairsCache : [];
  }
}

/**
 * Get list of coins available for spot trading on HL.
 * Returns base coin symbols (e.g. ['PURR', 'HYPE', 'TRUMP']).
 * Note: HL spot does NOT have BTC/ETH/SOL — only HyperEVM native tokens.
 */
export async function getHLSpotListedCoins(): Promise<string[]> {
  const pairs = await getSpotPairs();
  return pairs.map(p => p.coin);
}

/**
 * Get top spot pairs by 24h volume — the dynamic universe for spot trading.
 * Fetches spotMetaAndAssetCtxs in one call, filters by minimum volume,
 * and returns sorted by descending volume.
 * Cached for 10 minutes (same as spotMeta).
 */
let _topSpotCache: { coin: string; vol24h: number; midPx: number }[] = [];
let _topSpotCacheTs = 0;

export async function getTopSpotByVolume(
  minVol24h: number = 10_000,
  maxCoins: number = 25,
): Promise<{ coin: string; vol24h: number; midPx: number }[]> {
  if (_topSpotCache.length > 0 && Date.now() - _topSpotCacheTs < SPOT_PAIRS_TTL_MS) {
    return _topSpotCache.filter(s => s.vol24h >= minVol24h).slice(0, maxCoins);
  }
  try {
    const { info } = await loadHL();
    const data = await withRetry(
      () => info.spotMetaAndAssetCtxs(),
      'getTopSpotByVolume',
    );
    // Response: [spotMeta, assetCtx[]]
    const raw = data as any;
    const meta = Array.isArray(raw) ? raw[0] : raw;
    const ctxs: any[] = Array.isArray(raw) ? raw[1] : [];
    const tokens: Record<number, string> = {};
    for (const t of (meta?.tokens ?? [])) tokens[t.index] = t.name;

    const universe = meta?.universe ?? [];
    const items: { coin: string; vol24h: number; midPx: number }[] = [];

    for (let i = 0; i < Math.min(universe.length, ctxs.length); i++) {
      const u = universe[i];
      const ctx = ctxs[i];
      const baseIdx = u.tokens?.[0];
      const quoteIdx = u.tokens?.[1] ?? -1;
      if (quoteIdx !== 0) continue; // only USDC pairs
      const coin = tokens[baseIdx];
      if (!coin || coin === 'USDC') continue;
      const vol24h = parseFloat(ctx?.dayNtlVlm ?? '0');
      const midPx = parseFloat(ctx?.midPx ?? '0');
      if (midPx <= 0) continue; // skip dead pairs
      items.push({ coin, vol24h, midPx });
    }

    items.sort((a, b) => b.vol24h - a.vol24h);
    _topSpotCache = items;
    _topSpotCacheTs = Date.now();

    const filtered = items.filter(s => s.vol24h >= minVol24h).slice(0, maxCoins);
    logger.debug(
      `[Hyperliquid] Top spot by volume: ${filtered.length} pairs with >$${(minVol24h / 1000).toFixed(0)}k vol ` +
      `(top: ${filtered.slice(0, 5).map(s => `${s.coin}=$${(s.vol24h / 1000).toFixed(0)}k`).join(', ')})`,
    );
    return filtered;
  } catch (err) {
    logger.warn('[Hyperliquid] getTopSpotByVolume error:', err);
    // If cache has data, use it
    if (_topSpotCache.length > 0) {
      return _topSpotCache.filter(s => s.vol24h >= minVol24h).slice(0, maxCoins);
    }
    // Cache empty too — fall back to getSpotPairs() (no volume data, but at least we get coins)
    try {
      const pairs = await getSpotPairs();
      const fallback = pairs.map(p => ({ coin: p.coin, vol24h: 0, midPx: 0 }));
      logger.info(`[Hyperliquid] getTopSpotByVolume fallback: ${fallback.length} coins from getSpotPairs (no volume data)`);
      return fallback.slice(0, maxCoins);
    } catch {
      return [];
    }
  }
}

/**
 * Get spot token balances from HL's spot clearinghouse.
 * Returns non-zero balances with current USD value.
 */
export async function getSpotBalances(): Promise<HLSpotBalance[]> {
  try {
    const { info, wallet } = await loadHL();
    const state = await withRetry(
      () => info.spotClearinghouseState({ user: wallet.address }),
      'getSpotBalances',
    );

    const balances: HLSpotBalance[] = [];
    const bals = (state as any)?.balances ?? [];

    // Get mid prices for valuation
    const mids = await getAllMidPrices();

    for (const b of bals) {
      const coin: string = b.coin;
      const total = Number(b.total ?? 0);
      const hold = Number(b.hold ?? 0);
      const entryNtl = Number(b.entryNtl ?? 0);

      if (Math.abs(total) < 0.000001) continue; // skip dust

      // Spot mid prices are keyed as "COIN/USDC" or bare coin
      let price = mids[`${coin}/USDC`] ?? mids[coin] ?? 0;
      if (coin === 'USDC') price = 1; // USDC is always $1

      balances.push({
        coin,
        total,
        hold,
        available: total - hold,
        entryNtl,
        valueUsd: total * price,
      });
    }

    return balances;
  } catch (err) {
    logger.warn('[Hyperliquid] getSpotBalances error:', err);
    return [];
  }
}

/**
 * Get total USDC balance in the spot account (available for spot buys).
 */
export async function getSpotUsdcBalance(): Promise<number> {
  const balances = await getSpotBalances();
  const usdc = balances.find(b => b.coin === 'USDC');
  return usdc?.available ?? 0;
}

/**
 * Transfer USDC between perp and spot accounts.
 * @param amount USDC amount to transfer
 * @param toPerp true = spot→perp, false = perp→spot
 */
export async function transferUsdcBetweenAccounts(amount: number, toPerp: boolean): Promise<boolean> {
  const env = getCFOEnv();
  if (env.dryRun) {
    logger.info(`[Hyperliquid] DRY RUN — would transfer $${amount.toFixed(2)} ${toPerp ? 'spot→perp' : 'perp→spot'}`);
    return true;
  }
  try {
    const { exchange } = await loadHL();
    await exchange.usdClassTransfer({
      amount: amount.toFixed(2),
      toPerp,
    });
    logger.info(`[Hyperliquid] Transferred $${amount.toFixed(2)} ${toPerp ? 'spot→perp' : 'perp→spot'}`);
    return true;
  } catch (err) {
    logger.error(`[Hyperliquid] USDC transfer error:`, err);
    return false;
  }
}

/**
 * Open a spot trade on Hyperliquid.
 * BUY = acquire base token, SELL = dispose base token.
 * No leverage. No native TP/SL (software-managed by the monitor).
 */
export async function openSpotTrade(params: SpotTradeParams): Promise<HLOrderResult> {
  const env = getCFOEnv();
  const { coin, side, sizeUsd } = params;
  const isBuy = side === 'BUY';
  const signalTag = params.signal ?? 'manual';
  const conviction = params.conviction ?? 0;

  if (sizeUsd <= 0) {
    return { success: false, error: 'sizeUsd must be positive' };
  }

  if (env.dryRun) {
    logger.info(
      `[Hyperliquid] DRY RUN — would ${side} ${coin}-SPOT $${sizeUsd.toFixed(0)} ` +
      `signal=${signalTag} conviction=${(conviction * 100).toFixed(0)}%`,
    );
    return { success: true, orderId: 0, cloid: `dry-spot-${Date.now()}` };
  }

  try {
    const { exchange, info, wallet } = await loadHL();

    // Resolve spot pair
    const pairs = await getSpotPairs();
    const pair = pairs.find(p => p.coin === coin);
    if (!pair) {
      return { success: false, error: `${coin} not found in HL spot pairs` };
    }

    // Get current price (spot uses "COIN/USDC" keys in allMids)
    const mids = await withRetry(() => info.allMids(), 'openSpotTrade:allMids');
    const coinPrice = Number(mids[`${coin}/USDC`] ?? mids[coin] ?? 0);
    if (coinPrice <= 0) {
      return { success: false, error: `${coin} no spot price in HL allMids` };
    }

    const szDecimals = pair.szDecimals;
    const szStep = Math.pow(10, szDecimals);

    const sizeInCoin = sizeUsd / coinPrice;
    const sizeFmt = Math.floor(sizeInCoin * szStep) / szStep;

    if (sizeFmt <= 0) {
      return { success: false, error: `Position too small after rounding to ${szDecimals} decimals` };
    }

    // Check USDC balance for buys
    if (isBuy) {
      const spotUsdc = await getSpotUsdcBalance();
      if (spotUsdc < sizeUsd * 1.005) { // 0.5% buffer for fees
        // Try auto-transfer from perp account
        const shortfall = sizeUsd * 1.005 - spotUsdc;
        const perp = await getAccountSummary();
        
        // Dynamic reserve: keep at least 5% of equity or $5, whichever is larger
        const minReserve = Math.max(perp.equity * 0.05, 5);
        const canTransfer = Math.max(0, perp.availableMargin - minReserve);
        
        logger.info(
          `[HL:SpotBuy] Need $${shortfall.toFixed(2)} transfer: ` +
          `spot USDC=$${spotUsdc.toFixed(2)}, perp available=$${perp.availableMargin.toFixed(2)}, ` +
          `perp equity=$${perp.equity.toFixed(2)}, min reserve=$${minReserve.toFixed(2)}, ` +
          `can transfer=$${canTransfer.toFixed(2)}`,
        );
        
        if (canTransfer >= shortfall) {
          const transferred = await transferUsdcBetweenAccounts(shortfall, false); // perp→spot
          if (!transferred) {
            return { success: false, error: `Insufficient spot USDC ($${spotUsdc.toFixed(2)}) and transfer failed` };
          }
        } else {
          return { 
            success: false, 
            error: `Insufficient spot USDC ($${spotUsdc.toFixed(2)}) and perp margin too low ` +
                   `(available=$${perp.availableMargin.toFixed(2)}, need=$${shortfall.toFixed(2)}+$${minReserve.toFixed(2)} reserve)`,
          };
        }
      }
    }

    // For sells, check we have enough of the base token
    if (!isBuy) {
      const balances = await getSpotBalances();
      const tokenBal = balances.find(b => b.coin === coin);
      if (!tokenBal || tokenBal.available < sizeFmt) {
        return { success: false, error: `Insufficient ${coin} balance: have ${tokenBal?.available?.toFixed(szDecimals) ?? '0'}, need ${sizeFmt}` };
      }
    }

    // Use IoC with 2% slippage for immediate fill
    const limitPrice = isBuy
      ? formatLimitPrice(coinPrice * 1.02, szDecimals)
      : formatLimitPrice(coinPrice * 0.98, szDecimals);

    const order = await exchange.order({
      orders: [{
        a: pair.index,        // spot pair index (10000+)
        b: isBuy,             // true = buy base token, false = sell base token
        p: limitPrice,
        s: sizeFmt.toString(),
        r: false,             // no reduce-only for spot
        t: { limit: { tif: 'Ioc' as const } },
        c: `0x${Buffer.from(`cfo-spot-${side.toLowerCase()}-${Date.now()}`).toString('hex').padEnd(32, '0').slice(0, 32)}`,
      }],
      grouping: 'na',
    });

    const result = (order as any)?.response?.data?.statuses?.[0];
    if (!result || (result as any).error) {
      const errMsg: string = (result as any)?.error ?? 'Order rejected';
      return { success: false, error: errMsg };
    }

    // IoC: rested = not filled
    if ((result as any).resting) {
      logger.warn(`[Hyperliquid] ${side} ${coin}-SPOT order rested (not filled) — IoC auto-cancelled`);
      return { success: false, error: 'Order did not fill (IoC)' };
    }

    const orderId = (result as any).filled?.oid;
    const avgPrice = Number((result as any).filled?.avgPx ?? limitPrice);

    logger.info(
      `[Hyperliquid] ${side} ${coin}-SPOT: ${sizeFmt} ${coin} @ ~$${avgPrice} ` +
      `($${sizeUsd.toFixed(0)}) signal=${signalTag} ` +
      `conviction=${(conviction * 100).toFixed(0)}%: order ${orderId}`,
    );

    return { success: true, orderId, avgPrice };
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '');
    if (msg.includes('Trading is halted') || msg.includes('trading is halted')) {
      _haltedCoins.set(coin, Date.now());
      logger.warn(`[Hyperliquid] ${coin}-SPOT trading is halted — skipping for 30min`);
      return { success: false, error: `${coin} trading is halted` };
    }
    logger.error(`[Hyperliquid] openSpotTrade(${side} ${coin}) error:`, err);
    return { success: false, error: msg };
  }
}

/**
 * Close a spot position (sell all holdings of a coin).
 */
export async function closeSpotPosition(coin: string, sizeInCoin?: number): Promise<HLOrderResult> {
  const balances = await getSpotBalances();
  const bal = balances.find(b => b.coin === coin);
  if (!bal || bal.available <= 0) {
    return { success: false, error: `No ${coin} balance to sell` };
  }

  const sellSize = sizeInCoin ?? bal.available;
  const mids = await getAllMidPrices();
  const price = mids[`${coin}/USDC`] ?? mids[coin] ?? 0;
  const sizeUsd = sellSize * price;

  return openSpotTrade({
    coin,
    side: 'SELL',
    sizeUsd,
    signal: 'close-position',
    conviction: 1,
  });
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
