/**
 * Multi-Timeframe Technical Analysis for HL Perps
 *
 * Fetches OHLCV candles from Hyperliquid's InfoClient and computes
 * a confluence-based signal across three trading styles:
 *
 *   Scalp  — 5m trend with 1h directional filter   (SL 1.5% / TP 3%)
 *   Day    — 1h trend with 1d directional filter    (SL 3%   / TP 8%)
 *   Swing  — 1d trend with 1h entry confirmation    (SL 5%   / TP 15%)
 *
 * Indicators (per timeframe):
 *   - EMA crossover  (fast 8 / slow 21)
 *   - RSI 14
 *   - Volume ratio   (current bar vs 20-bar average)
 *   - EMA 50 trend filter
 *
 * The higher timeframe sets bias; the lower timeframe triggers entries.
 * Both must agree on direction for a valid signal.
 */

import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export type TradeStyle = 'scalp' | 'day' | 'swing';

export type CandleInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';

export interface Candle {
  t: number;     // open timestamp ms
  o: number;     // open
  h: number;     // high
  l: number;     // low
  c: number;     // close
  v: number;     // volume (base)
}

export type TrendBias = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface TimeframeSignal {
  interval: CandleInterval;
  bias: TrendBias;
  emaFast: number;       // EMA 8 current value
  emaSlow: number;       // EMA 21 current value
  ema50: number;         // EMA 50 trend filter
  rsi: number;           // RSI 14
  volumeRatio: number;   // current vol / 20-bar avg vol
  lastClose: number;     // latest close price
  strength: number;      // 0-1 signal strength
}

export interface MTFSignal {
  coin: string;
  style: TradeStyle;
  bias: TrendBias;                // overall bias after confluence
  conviction: number;             // 0-1 combined conviction
  triggerTf: TimeframeSignal;     // lower timeframe (entry trigger)
  filterTf: TimeframeSignal;      // higher timeframe (directional filter)
  reasoning: string;
  stopLossPct: number;
  takeProfitPct: number;
}

/** Configuration per trade style */
export interface StyleConfig {
  /** Lower timeframe (entry trigger) */
  triggerInterval: CandleInterval;
  /** Higher timeframe (bias filter) */
  filterInterval: CandleInterval;
  /** Candle lookback for trigger TF (number of candles to fetch) */
  triggerLookback: number;
  /** Candle lookback for filter TF */
  filterLookback: number;
  /** Default stop-loss % */
  stopLossPct: number;
  /** Default take-profit % */
  takeProfitPct: number;
  /** Max hold duration in hours (0 = unlimited) */
  maxHoldHours: number;
}

const STYLE_CONFIGS: Record<TradeStyle, StyleConfig> = {
  scalp: {
    triggerInterval: '5m',
    filterInterval: '1h',
    triggerLookback: 100,   // ~8.3 hours of 5m candles (enough for EMA 50)
    filterLookback: 60,     // 60 hours of 1h candles
    stopLossPct: 1.5,
    takeProfitPct: 3,
    maxHoldHours: 1,
  },
  day: {
    triggerInterval: '1h',
    filterInterval: '1d',
    triggerLookback: 60,    // 60 hours of 1h candles
    filterLookback: 60,     // 60 days of daily candles
    stopLossPct: 3,
    takeProfitPct: 8,
    maxHoldHours: 24,
  },
  swing: {
    triggerInterval: '1d',
    filterInterval: '1h',   // 1h for entry timing confirmation
    triggerLookback: 60,     // 60 days of daily candles
    filterLookback: 60,      // 60 hours of 1h candles
    stopLossPct: 5,
    takeProfitPct: 15,
    maxHoldHours: 168,       // 7 days
  },
};

// ============================================================================
// Indicator calculations
// ============================================================================

/**
 * Exponential Moving Average.
 * Returns an array of EMA values (same length as input).
 */
function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * Returns RSI array (same length as input, first `period` values are approximate).
 */
function rsi(closes: number[], period = 14): number[] {
  if (closes.length < 2) return closes.map(() => 50);
  const result: number[] = [50]; // first value is neutral
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average over first `period` bars
  for (let i = 1; i <= Math.min(period, closes.length - 1); i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
    result.push(50); // placeholder
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) result[Math.min(period, closes.length - 1)] = 100;
  else {
    const rs = avgGain / avgLoss;
    result[Math.min(period, closes.length - 1)] = 100 - 100 / (1 + rs);
  }

  // Wilder smoothing for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) result.push(100);
    else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }
  return result;
}

/**
 * Volume ratio: latest volume / 20-bar average volume.
 * > 1.5 = above-average volume (confirmation), < 0.5 = low conviction.
 */
function volumeRatio(volumes: number[], lookback = 20): number {
  if (volumes.length < 2) return 1;
  const recent = volumes.slice(-lookback);
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const last = volumes[volumes.length - 1];
  return avg > 0 ? last / avg : 1;
}

// ============================================================================
// Candle fetching (cached)
// ============================================================================

interface CandleCache {
  candles: Candle[];
  fetchedAt: number;
}

const _candleCache = new Map<string, CandleCache>();

/** Cache TTL per interval */
const CACHE_TTL: Partial<Record<CandleInterval, number>> = {
  '5m': 4 * 60_000,       // refresh every 4 min (just before next candle close)
  '15m': 12 * 60_000,
  '1h': 50 * 60_000,      // refresh every 50 min
  '1d': 4 * 3600_000,     // refresh every 4 hours
};

/**
 * Fetch OHLCV candles from HL, with caching.
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  lookback: number,
): Promise<Candle[]> {
  const cacheKey = `${coin}:${interval}`;
  const cacheTtl = CACHE_TTL[interval] ?? 5 * 60_000;
  const cached = _candleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cacheTtl) {
    return cached.candles;
  }

  try {
    const hl = await import('./hyperliquidService.ts');
    // loadHL() is internal — we need to call through a public getter
    // The info client is accessible via our new exported helper
    const info = await getInfoClient();

    const intervalMs = intervalToMs(interval);
    const startTime = Date.now() - lookback * intervalMs;

    const raw = await info.candleSnapshot({
      coin,
      interval,
      startTime,
    });

    const candles: Candle[] = raw.map((c: any) => ({
      t: c.t,
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v),
    }));

    _candleCache.set(cacheKey, { candles, fetchedAt: Date.now() });
    return candles;
  } catch (err) {
    logger.debug(`[TA] Failed to fetch ${coin} ${interval} candles:`, err);
    return cached?.candles ?? [];
  }
}

/** Convert interval string to milliseconds */
function intervalToMs(interval: CandleInterval): number {
  const map: Record<CandleInterval, number> = {
    '1m': 60_000,
    '3m': 3 * 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 3600_000,
    '2h': 2 * 3600_000,
    '4h': 4 * 3600_000,
    '8h': 8 * 3600_000,
    '12h': 12 * 3600_000,
    '1d': 86400_000,
    '3d': 3 * 86400_000,
    '1w': 7 * 86400_000,
    '1M': 30 * 86400_000,
  };
  return map[interval] ?? 60_000;
}

// ============================================================================
// InfoClient accessor (exported so TA can call candleSnapshot)
// ============================================================================

let _infoClient: any = null;

/**
 * Get the HL InfoClient instance. Lazily initialised, reuses across calls.
 */
export async function getInfoClient(): Promise<any> {
  if (_infoClient) return _infoClient;
  const mod = await import('@nktkas/hyperliquid');
  const { getCFOEnv } = await import('./cfoEnv.ts');
  const env = getCFOEnv();
  const transport = new mod.HttpTransport({ isTestnet: env.hyperliquidTestnet });
  _infoClient = new mod.InfoClient({ transport });
  return _infoClient;
}

// ============================================================================
// Single-timeframe analysis
// ============================================================================

/**
 * Analyse candles on a single timeframe.
 * Returns bias, indicator values, and signal strength.
 */
function analyseTimeframe(candles: Candle[], interval: CandleInterval): TimeframeSignal {
  const neutral: TimeframeSignal = {
    interval, bias: 'NEUTRAL',
    emaFast: 0, emaSlow: 0, ema50: 0,
    rsi: 50, volumeRatio: 1,
    lastClose: 0, strength: 0,
  };

  if (candles.length < 21) return neutral; // need at least 21 candles for EMA 21

  const closes = candles.map(c => c.c);
  const volumes = candles.map(c => c.v);

  // Indicators
  const emaFastArr = ema(closes, 8);
  const emaSlowArr = ema(closes, 21);
  const ema50Arr = ema(closes, Math.min(50, closes.length));
  const rsiArr = rsi(closes, 14);
  const volRatio = volumeRatio(volumes, 20);

  const lastEmaFast = emaFastArr[emaFastArr.length - 1];
  const lastEmaSlow = emaSlowArr[emaSlowArr.length - 1];
  const lastEma50 = ema50Arr[ema50Arr.length - 1];
  const lastRsi = rsiArr[rsiArr.length - 1];
  const lastClose = closes[closes.length - 1];

  // Previous EMA values (for crossover detection)
  const prevEmaFast = emaFastArr.length > 1 ? emaFastArr[emaFastArr.length - 2] : lastEmaFast;
  const prevEmaSlow = emaSlowArr.length > 1 ? emaSlowArr[emaSlowArr.length - 2] : lastEmaSlow;

  // ── Determine bias ──
  let bullPoints = 0;
  let bearPoints = 0;
  let strength = 0;

  // 1. EMA 8/21 crossover (most important)
  const emaCrossUp = prevEmaFast <= prevEmaSlow && lastEmaFast > lastEmaSlow;
  const emaCrossDown = prevEmaFast >= prevEmaSlow && lastEmaFast < lastEmaSlow;
  const emaAbove = lastEmaFast > lastEmaSlow;
  const emaBelow = lastEmaFast < lastEmaSlow;

  if (emaCrossUp) { bullPoints += 3; } // fresh cross = strong signal
  else if (emaAbove) { bullPoints += 2; } // already trending up
  if (emaCrossDown) { bearPoints += 3; }
  else if (emaBelow) { bearPoints += 2; }

  // 2. Price relative to EMA 50 (trend filter)
  if (lastClose > lastEma50) bullPoints += 1;
  else if (lastClose < lastEma50) bearPoints += 1;

  // 3. RSI zones
  if (lastRsi > 70) {
    // Overbought — bearish for scalp (reversal), but bullish momentum for swing
    bearPoints += 1; // slight caution
  } else if (lastRsi < 30) {
    bullPoints += 1; // oversold bounce potential
  } else if (lastRsi > 55) {
    bullPoints += 0.5; // mild bullish
  } else if (lastRsi < 45) {
    bearPoints += 0.5; // mild bearish
  }

  // 4. Volume confirmation
  if (volRatio > 1.5) {
    // High volume confirms the current direction
    if (bullPoints > bearPoints) bullPoints += 1;
    else if (bearPoints > bullPoints) bearPoints += 1;
  }

  const maxPoints = 5.5; // theoretical max: cross(3) + ema50(1) + rsi(1) + vol(1) − partials
  const net = bullPoints - bearPoints;
  strength = Math.min(1.0, Math.abs(net) / maxPoints);

  let bias: TrendBias = 'NEUTRAL';
  if (net > 0.5) bias = 'LONG';
  else if (net < -0.5) bias = 'SHORT';

  return {
    interval,
    bias,
    emaFast: lastEmaFast,
    emaSlow: lastEmaSlow,
    ema50: lastEma50,
    rsi: lastRsi,
    volumeRatio: volRatio,
    lastClose,
    strength,
  };
}

// ============================================================================
// Multi-timeframe confluence
// ============================================================================

/**
 * Run multi-timeframe analysis for a coin and trade style.
 * Returns null if no valid signal (timeframes disagree or too weak).
 */
export async function analyseMultiTimeframe(
  coin: string,
  style: TradeStyle,
): Promise<MTFSignal | null> {
  const cfg = STYLE_CONFIGS[style];

  // Fetch candles for both timeframes in parallel
  const [triggerCandles, filterCandles] = await Promise.all([
    fetchCandles(coin, cfg.triggerInterval, cfg.triggerLookback),
    fetchCandles(coin, cfg.filterInterval, cfg.filterLookback),
  ]);

  if (triggerCandles.length < 21 || filterCandles.length < 21) {
    return null; // not enough data
  }

  const triggerTf = analyseTimeframe(triggerCandles, cfg.triggerInterval);
  const filterTf = analyseTimeframe(filterCandles, cfg.filterInterval);

  // ── Confluence check ──
  // For scalp & day: filter TF sets the allowed direction, trigger TF must agree
  // For swing: daily trend is primary, 1h confirms entry timing
  let bias: TrendBias = 'NEUTRAL';
  let conviction = 0;

  if (style === 'swing') {
    // Swing: daily trend is king, 1h just confirms entry timing
    if (triggerTf.bias === 'NEUTRAL') return null;
    if (filterTf.bias === triggerTf.bias || filterTf.bias === 'NEUTRAL') {
      // 1h agrees or is neutral — good entry timing
      bias = triggerTf.bias;
      conviction = triggerTf.strength * 0.7 + filterTf.strength * 0.3;
    } else {
      // 1h disagrees — skip (bad entry timing even if daily trend is clear)
      return null;
    }
  } else {
    // Scalp & Day: filter TF (higher) sets direction, trigger TF (lower) must agree
    if (filterTf.bias === 'NEUTRAL') return null; // no higher-timeframe trend
    if (triggerTf.bias !== filterTf.bias) return null; // timeframes disagree

    bias = filterTf.bias;
    // Conviction = weighted blend: trigger strength matters more for entry timing
    conviction = triggerTf.strength * 0.6 + filterTf.strength * 0.4;
  }

  if (conviction < 0.2) return null; // too weak

  // ── RSI guard — avoid entries into extreme zones ──
  // Don't go LONG if RSI > 80 on trigger TF (overbought) — for scalps especially
  if (style === 'scalp') {
    if (bias === 'LONG' && triggerTf.rsi > 75) return null;
    if (bias === 'SHORT' && triggerTf.rsi < 25) return null;
  }

  // ── Build reasoning string ──
  const emaCrossLabel = triggerTf.emaFast > triggerTf.emaSlow
    ? `EMA8>${Math.round(triggerTf.emaSlow)}` : `EMA8<${Math.round(triggerTf.emaSlow)}`;
  const trendLabel = triggerTf.lastClose > triggerTf.ema50 ? 'above-EMA50' : 'below-EMA50';
  const volLabel = triggerTf.volumeRatio > 1.5 ? '🔊 high-vol' : triggerTf.volumeRatio < 0.5 ? '🔇 low-vol' : '';
  const rsiLabel = `RSI:${triggerTf.rsi.toFixed(0)}`;

  const reasoning = [
    `${style}:${bias}`,
    `${cfg.triggerInterval} ${emaCrossLabel}`,
    `${cfg.filterInterval} filter:${filterTf.bias}`,
    trendLabel,
    rsiLabel,
    volLabel,
    `conviction:${(conviction * 100).toFixed(0)}%`,
  ].filter(Boolean).join(', ');

  return {
    coin,
    style,
    bias,
    conviction,
    triggerTf,
    filterTf,
    reasoning,
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
  };
}

// ============================================================================
// Batch analysis — score all coins across all styles
// ============================================================================

/**
 * Analyse a set of coins across all trade styles, returning the best signals.
 * Filters out weak/conflicting signals and returns sorted by conviction.
 */
export async function scoreCoins(
  coins: string[],
  enabledStyles: TradeStyle[] = ['scalp', 'day', 'swing'],
): Promise<MTFSignal[]> {
  const results: MTFSignal[] = [];

  // Process in batches to avoid hammering the API
  const BATCH_SIZE = 3; // 3 coins at a time, each with 2 TF fetches = 6 API calls
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    const batchPromises: Promise<MTFSignal | null>[] = [];

    for (const coin of batch) {
      for (const style of enabledStyles) {
        batchPromises.push(
          analyseMultiTimeframe(coin, style).catch(err => {
            logger.debug(`[TA] Error analysing ${coin}/${style}:`, err);
            return null;
          }),
        );
      }
    }

    const batchResults = await Promise.all(batchPromises);
    for (const sig of batchResults) {
      if (sig) results.push(sig);
    }
  }

  // Sort by conviction descending
  results.sort((a, b) => b.conviction - a.conviction);
  return results;
}

// ============================================================================
// Style config getters (for use by decision engine)
// ============================================================================

export function getStyleConfig(style: TradeStyle): StyleConfig {
  return { ...STYLE_CONFIGS[style] };
}

export function getMaxHoldHours(style: TradeStyle): number {
  return STYLE_CONFIGS[style].maxHoldHours;
}

/**
 * Check if a position has exceeded its max hold duration.
 * Returns true if the position should be force-closed.
 */
export function isHoldExpired(style: TradeStyle, openedAtIso: string): boolean {
  const maxHours = STYLE_CONFIGS[style].maxHoldHours;
  if (maxHours <= 0) return false;
  const openedMs = new Date(openedAtIso).getTime();
  const holdMs = Date.now() - openedMs;
  return holdMs > maxHours * 3600_000;
}

/**
 * Clear candle cache (useful for testing or forced refresh).
 */
export function clearCandleCache(): void {
  _candleCache.clear();
}
