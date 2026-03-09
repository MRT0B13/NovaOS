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
  // Advanced indicators
  adx: number;           // ADX value (>25 = trending, <20 = choppy)
  plusDI: number;        // +DI (directional indicator)
  minusDI: number;       // -DI
  atrPct: number;        // ATR as % of price (volatility)
  macdHistogram: number; // MACD histogram value
  macdHistIncreasing: boolean; // histogram increasing in trade direction
  bbPercentB: number;    // Bollinger %B (0 = lower band, 1 = upper band)
  bbSqueeze: boolean;    // Bollinger Band squeeze detected
  bbBandwidth: number;   // BB bandwidth (low = squeeze, expanding = breakout)
  nearestResistancePct: number; // distance to nearest resistance above (%)
  nearestSupportPct: number;    // distance to nearest support below (%)
  bullishDivergence: boolean;   // RSI bullish divergence
  bearishDivergence: boolean;   // RSI bearish divergence
}

export interface MTFSignal {
  coin: string;
  style: TradeStyle;
  bias: TrendBias;                // overall bias after confluence
  conviction: number;             // 0-1 combined conviction
  triggerTf: TimeframeSignal;     // lower timeframe (entry trigger)
  filterTf: TimeframeSignal;      // higher timeframe (directional filter)
  microTf?: TimeframeSignal;      // micro timeframe (1m for scalps, optional)
  reasoning: string;
  stopLossPct: number;
  takeProfitPct: number;
  leverage: number;               // style-specific base leverage
  atrPct: number;                 // ATR% on trigger TF (for dynamic stops/sizing)
  adxValue: number;               // ADX on filter TF (for regime detection)
  regimeFiltered: boolean;        // true if ADX < 20 on filter TF (choppy)
}

/** Configuration per trade style */
export interface StyleConfig {
  /** Lower timeframe (entry trigger) */
  triggerInterval: CandleInterval;
  /** Higher timeframe (bias filter) */
  filterInterval: CandleInterval;
  /** Micro timeframe for extra-tight entry confirmation (optional, e.g. 1m for scalps) */
  microTriggerInterval?: CandleInterval;
  /** Candle lookback for micro trigger TF */
  microTriggerLookback?: number;
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
  /** Default leverage for this style (scalp=3x, day=2x, swing=2x) */
  defaultLeverage: number;
}

const STYLE_CONFIGS: Record<TradeStyle, StyleConfig> = {
  scalp: {
    triggerInterval: '5m',
    filterInterval: '1h',
    microTriggerInterval: '1m',   // 1m chart for tighter entry confirmation
    microTriggerLookback: 60,     // 60 × 1m = 1h of 1m candles (enough for EMA 50)
    triggerLookback: 100,         // ~8.3 hours of 5m candles (enough for EMA 50)
    filterLookback: 60,           // 60 hours of 1h candles
    stopLossPct: 1.5,
    takeProfitPct: 3,
    maxHoldHours: 1,
    defaultLeverage: 3,           // scalps use higher leverage — tight SL limits risk
  },
  day: {
    triggerInterval: '1h',
    filterInterval: '1d',
    triggerLookback: 60,    // 60 hours of 1h candles
    filterLookback: 60,     // 60 days of daily candles
    stopLossPct: 3,
    takeProfitPct: 8,
    maxHoldHours: 24,
    defaultLeverage: 2,
  },
  swing: {
    triggerInterval: '1d',
    filterInterval: '1h',   // 1h for entry timing confirmation
    triggerLookback: 60,     // 60 days of daily candles
    filterLookback: 60,      // 60 hours of 1h candles
    stopLossPct: 5,
    takeProfitPct: 15,
    maxHoldHours: 168,       // 7 days
    defaultLeverage: 2,
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
// Advanced indicators — ADX, ATR, MACD, Bollinger Bands, S/R
// ============================================================================

/**
 * Average True Range (ATR) — measures volatility.
 * Returns an array of ATR values (first `period` values are approximate).
 */
function atr(candles: Candle[], period = 14): number[] {
  if (candles.length < 2) return candles.map(() => 0);
  const trueRanges: number[] = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].h;
    const low = candles[i].l;
    const prevClose = candles[i - 1].c;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilder smoothing
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period) {
      sum += trueRanges[i];
      result.push(sum / (i + 1));
    } else if (i === period) {
      sum += trueRanges[i];
      result.push(sum / period);
    } else {
      result.push((result[i - 1] * (period - 1) + trueRanges[i]) / period);
    }
  }
  return result;
}

/**
 * ATR as a percentage of the current price.
 * Useful for volatility-normalized stop-losses and sizing.
 */
function atrPercent(candles: Candle[], period = 14): number {
  const atrVals = atr(candles, period);
  const lastAtr = atrVals[atrVals.length - 1];
  const lastClose = candles[candles.length - 1]?.c ?? 1;
  return lastClose > 0 ? (lastAtr / lastClose) * 100 : 0;
}

/**
 * Average Directional Index (ADX) with +DI / -DI.
 * ADX > 25 = trending, ADX < 20 = ranging/choppy.
 * Returns { adx, plusDI, minusDI } for latest bar.
 */
function adx(candles: Candle[], period = 14): { adx: number; plusDI: number; minusDI: number } {
  if (candles.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const high = candles[i].h;
    const low = candles[i].l;
    const prevClose = candles[i - 1].c;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Wilder smoothing for +DM, -DM, TR
  const smooth = (vals: number[]): number[] => {
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      if (i < period) {
        sum += vals[i];
        result.push(sum);
      } else if (i === period - 1) {
        result[i] = sum;
      } else {
        result.push(result[i - 1] - result[i - 1] / period + vals[i]);
      }
    }
    return result;
  };

  const smoothPlusDM = smooth(plusDMs);
  const smoothMinusDM = smooth(minusDMs);
  const smoothTR = smooth(trueRanges);

  // +DI and -DI series
  const plusDISeries: number[] = [];
  const minusDISeries: number[] = [];
  const dxSeries: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const tr = smoothTR[i];
    if (tr === 0) {
      plusDISeries.push(0);
      minusDISeries.push(0);
      dxSeries.push(0);
      continue;
    }
    const pdi = (smoothPlusDM[i] / tr) * 100;
    const mdi = (smoothMinusDM[i] / tr) * 100;
    plusDISeries.push(pdi);
    minusDISeries.push(mdi);
    const diSum = pdi + mdi;
    dxSeries.push(diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0);
  }

  // ADX = smoothed DX (Wilder's)
  let adxVal = 0;
  if (dxSeries.length >= period) {
    adxVal = dxSeries.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < dxSeries.length; i++) {
      adxVal = (adxVal * (period - 1) + dxSeries[i]) / period;
    }
  }

  return {
    adx: adxVal,
    plusDI: plusDISeries[plusDISeries.length - 1] ?? 0,
    minusDI: minusDISeries[minusDISeries.length - 1] ?? 0,
  };
}

/**
 * MACD (12, 26, 9) — momentum oscillator.
 * Returns { macdLine, signalLine, histogram } for latest bar.
 * histogram > 0 and increasing = bullish momentum.
 */
function macd(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): {
  macdLine: number; signalLine: number; histogram: number;
  prevHistogram: number; histogramIncreasing: boolean;
} {
  const neutral = { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0, histogramIncreasing: false };
  if (closes.length < slowPeriod + signalPeriod) return neutral;

  const emaFastArr = ema(closes, fastPeriod);
  const emaSlowArr = ema(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLineArr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLineArr.push(emaFastArr[i] - emaSlowArr[i]);
  }

  // Signal line = EMA of MACD line
  const signalLineArr = ema(macdLineArr, signalPeriod);

  // Histogram
  const histArr: number[] = [];
  for (let i = 0; i < macdLineArr.length; i++) {
    histArr.push(macdLineArr[i] - signalLineArr[i]);
  }

  const lastHist = histArr[histArr.length - 1];
  const prevHist = histArr.length > 1 ? histArr[histArr.length - 2] : 0;

  return {
    macdLine: macdLineArr[macdLineArr.length - 1],
    signalLine: signalLineArr[signalLineArr.length - 1],
    histogram: lastHist,
    prevHistogram: prevHist,
    histogramIncreasing: lastHist > prevHist,
  };
}

/**
 * Bollinger Bands (20, 2).
 * Returns { upper, middle, lower, bandwidth, percentB, squeeze }.
 * squeeze = true when bandwidth is in the lowest 20% of recent history (25 bars).
 */
function bollingerBands(closes: number[], period = 20, stdDevMult = 2): {
  upper: number; middle: number; lower: number;
  bandwidth: number; percentB: number; squeeze: boolean;
} {
  const neutral = { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0.5, squeeze: false };
  if (closes.length < period) return neutral;

  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;

  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMult * stdDev;
  const lower = middle - stdDevMult * stdDev;
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
  const lastClose = closes[closes.length - 1];
  const percentB = (upper - lower) > 0 ? (lastClose - lower) / (upper - lower) : 0.5;

  // Squeeze detection: compare current bandwidth to recent history
  let squeeze = false;
  if (closes.length >= period + 25) {
    const recentBWs: number[] = [];
    for (let i = closes.length - 25; i <= closes.length; i++) {
      if (i < period) continue;
      const s = closes.slice(i - period, i);
      const m = s.reduce((sum, v) => sum + v, 0) / period;
      const v = s.reduce((sum, val) => sum + Math.pow(val - m, 2), 0) / period;
      const sd = Math.sqrt(v);
      const u = m + stdDevMult * sd;
      const l = m - stdDevMult * sd;
      recentBWs.push(m > 0 ? (u - l) / m : 0);
    }
    if (recentBWs.length >= 10) {
      const sortedBWs = [...recentBWs].sort((a, b) => a - b);
      const percentile20 = sortedBWs[Math.floor(sortedBWs.length * 0.2)];
      squeeze = bandwidth <= percentile20;
    }
  }

  return { upper, middle, lower, bandwidth, percentB, squeeze };
}

/**
 * Detect recent swing highs and swing lows (support/resistance levels).
 * A swing high = bar whose high is higher than `lookback` bars on each side.
 * Returns the nearest resistance (above) and support (below) relative to last close.
 */
function detectSwingLevels(candles: Candle[], lookback = 5): {
  nearestResistance: number | null;
  nearestSupport: number | null;
  distToResistancePct: number;  // >0, how far above current price
  distToSupportPct: number;     // >0, how far below current price
} {
  const result = { nearestResistance: null as number | null, nearestSupport: null as number | null, distToResistancePct: Infinity, distToSupportPct: Infinity };
  if (candles.length < lookback * 2 + 1) return result;

  const lastClose = candles[candles.length - 1].c;
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  // Don't check the last `lookback` candles (need right-side confirmation)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].h >= h || candles[i + j].h >= h) isSwingHigh = false;
      if (candles[i - j].l <= l || candles[i + j].l <= l) isSwingLow = false;
    }
    if (isSwingHigh) swingHighs.push(h);
    if (isSwingLow) swingLows.push(l);
  }

  // Nearest resistance = closest swing high ABOVE current price
  for (const sh of swingHighs) {
    if (sh > lastClose) {
      const dist = ((sh - lastClose) / lastClose) * 100;
      if (dist < result.distToResistancePct) {
        result.nearestResistance = sh;
        result.distToResistancePct = dist;
      }
    }
  }

  // Nearest support = closest swing low BELOW current price
  for (const sl of swingLows) {
    if (sl < lastClose) {
      const dist = ((lastClose - sl) / lastClose) * 100;
      if (dist < result.distToSupportPct) {
        result.nearestSupport = sl;
        result.distToSupportPct = dist;
      }
    }
  }

  return result;
}

/**
 * RSI divergence detection.
 * Bullish divergence: price makes lower low but RSI makes higher low.
 * Bearish divergence: price makes higher high but RSI makes lower high.
 * Checks the last `window` candles for divergence patterns.
 */
function detectRSIDivergence(closes: number[], rsiArr: number[], window = 30): {
  bullishDivergence: boolean;
  bearishDivergence: boolean;
} {
  const result = { bullishDivergence: false, bearishDivergence: false };
  if (closes.length < window || rsiArr.length < window) return result;

  const startIdx = closes.length - window;
  const endIdx = closes.length - 1;

  // Find local lows and highs in the window
  const priceLows: { idx: number; val: number }[] = [];
  const priceHighs: { idx: number; val: number }[] = [];

  for (let i = startIdx + 2; i < endIdx - 1; i++) {
    if (closes[i] <= closes[i - 1] && closes[i] <= closes[i - 2] &&
        closes[i] <= closes[i + 1] && closes[i] <= closes[i + 2]) {
      priceLows.push({ idx: i, val: closes[i] });
    }
    if (closes[i] >= closes[i - 1] && closes[i] >= closes[i - 2] &&
        closes[i] >= closes[i + 1] && closes[i] >= closes[i + 2]) {
      priceHighs.push({ idx: i, val: closes[i] });
    }
  }

  // Bullish divergence: price lower low, RSI higher low
  if (priceLows.length >= 2) {
    const recent = priceLows[priceLows.length - 1];
    const prev = priceLows[priceLows.length - 2];
    if (recent.val < prev.val && rsiArr[recent.idx] > rsiArr[prev.idx]) {
      result.bullishDivergence = true;
    }
  }

  // Bearish divergence: price higher high, RSI lower high
  if (priceHighs.length >= 2) {
    const recent = priceHighs[priceHighs.length - 1];
    const prev = priceHighs[priceHighs.length - 2];
    if (recent.val > prev.val && rsiArr[recent.idx] < rsiArr[prev.idx]) {
      result.bearishDivergence = true;
    }
  }

  return result;
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
    adx: 0, plusDI: 0, minusDI: 0,
    atrPct: 0, macdHistogram: 0, macdHistIncreasing: false,
    bbPercentB: 0.5, bbSqueeze: false, bbBandwidth: 0,
    nearestResistancePct: Infinity, nearestSupportPct: Infinity,
    bullishDivergence: false, bearishDivergence: false,
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

  // Advanced indicators
  const adxResult = adx(candles, 14);
  const atrPctResult = atrPercent(candles, 14);
  const macdResult = macd(closes, 12, 26, 9);
  const bbResult = bollingerBands(closes, 20, 2);
  const srLevels = detectSwingLevels(candles, 5);
  const rsiDivergence = detectRSIDivergence(closes, rsiArr, 30);

  const lastEmaFast = emaFastArr[emaFastArr.length - 1];
  const lastEmaSlow = emaSlowArr[emaSlowArr.length - 1];
  const lastEma50 = ema50Arr[ema50Arr.length - 1];
  const lastRsi = rsiArr[rsiArr.length - 1];
  const lastClose = closes[closes.length - 1];

  // Previous EMA values (for crossover detection)
  const prevEmaFast = emaFastArr.length > 1 ? emaFastArr[emaFastArr.length - 2] : lastEmaFast;
  const prevEmaSlow = emaSlowArr.length > 1 ? emaSlowArr[emaSlowArr.length - 2] : lastEmaSlow;

  // ── Determine bias ──
  // Scoring system: max ~10 points possible per side (was 5.5 — now richer)
  let bullPoints = 0;
  let bearPoints = 0;
  let strength = 0;

  // 1. EMA 8/21 crossover (most important — directional backbone)
  const emaCrossUp = prevEmaFast <= prevEmaSlow && lastEmaFast > lastEmaSlow;
  const emaCrossDown = prevEmaFast >= prevEmaSlow && lastEmaFast < lastEmaSlow;
  const emaAbove = lastEmaFast > lastEmaSlow;
  const emaBelow = lastEmaFast < lastEmaSlow;

  if (emaCrossUp) { bullPoints += 2.5; }
  else if (emaAbove) { bullPoints += 1.5; }
  if (emaCrossDown) { bearPoints += 2.5; }
  else if (emaBelow) { bearPoints += 1.5; }

  // 2. Price relative to EMA 50 (trend filter)
  if (lastClose > lastEma50) bullPoints += 1;
  else if (lastClose < lastEma50) bearPoints += 1;

  // 3. RSI zones
  if (lastRsi > 70) {
    bearPoints += 1;
  } else if (lastRsi < 30) {
    bullPoints += 1;
  } else if (lastRsi > 55) {
    bullPoints += 0.5;
  } else if (lastRsi < 45) {
    bearPoints += 0.5;
  }

  // 4. Volume confirmation
  if (volRatio > 1.5) {
    if (bullPoints > bearPoints) bullPoints += 1;
    else if (bearPoints > bullPoints) bearPoints += 1;
  }

  // 5. MACD histogram — momentum confirmation (NEW)
  // Histogram increasing in the direction of the bias = momentum agreement
  if (macdResult.histogram > 0 && macdResult.histogramIncreasing) {
    bullPoints += 1.5; // bullish momentum accelerating
  } else if (macdResult.histogram < 0 && !macdResult.histogramIncreasing) {
    bearPoints += 1.5; // bearish momentum accelerating (histogram decreasing = more negative)
  }
  // MACD cross (histogram flipping sign) is a strong signal
  if (macdResult.histogram > 0 && macdResult.prevHistogram <= 0) {
    bullPoints += 0.5; // MACD bullish cross
  } else if (macdResult.histogram < 0 && macdResult.prevHistogram >= 0) {
    bearPoints += 0.5; // MACD bearish cross
  }

  // 6. Bollinger Bands — mean reversion + breakout (NEW)
  if (bbResult.percentB > 1.0) {
    // Price above upper band — overbought (reversal risk for shorts)
    bearPoints += 0.5;
  } else if (bbResult.percentB < 0.0) {
    // Price below lower band — oversold (bounce potential)
    bullPoints += 0.5;
  }

  // 7. RSI divergence — powerful reversal signal (NEW)
  if (rsiDivergence.bullishDivergence) {
    bullPoints += 1.5; // price making lower lows but RSI making higher lows
  }
  if (rsiDivergence.bearishDivergence) {
    bearPoints += 1.5; // price making higher highs but RSI making lower highs
  }

  // 8. ADX directional agreement — +DI/-DI confirms bias (NEW)
  if (adxResult.adx > 20) {
    if (adxResult.plusDI > adxResult.minusDI) bullPoints += 0.5;
    else if (adxResult.minusDI > adxResult.plusDI) bearPoints += 0.5;
  }

  const maxPoints = 10.0; // theoretical max: EMA(2.5) + EMA50(1) + RSI(1) + Vol(1) + MACD(2) + BB(0.5) + Div(1.5) + ADX(0.5)
  const net = bullPoints - bearPoints;
  strength = Math.min(1.0, Math.abs(net) / maxPoints);

  let bias: TrendBias = 'NEUTRAL';
  if (net > 1.0) bias = 'LONG';   // higher threshold to reduce noise (was 0.5)
  else if (net < -1.0) bias = 'SHORT';

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
    adx: adxResult.adx,
    plusDI: adxResult.plusDI,
    minusDI: adxResult.minusDI,
    atrPct: atrPctResult,
    macdHistogram: macdResult.histogram,
    macdHistIncreasing: macdResult.histogramIncreasing,
    bbPercentB: bbResult.percentB,
    bbSqueeze: bbResult.squeeze,
    bbBandwidth: bbResult.bandwidth,
    nearestResistancePct: srLevels.distToResistancePct,
    nearestSupportPct: srLevels.distToSupportPct,
    bullishDivergence: rsiDivergence.bullishDivergence,
    bearishDivergence: rsiDivergence.bearishDivergence,
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

  // Fetch candles for both timeframes in parallel (+ micro TF if configured)
  const fetches: Promise<Candle[]>[] = [
    fetchCandles(coin, cfg.triggerInterval, cfg.triggerLookback),
    fetchCandles(coin, cfg.filterInterval, cfg.filterLookback),
  ];
  if (cfg.microTriggerInterval && cfg.microTriggerLookback) {
    fetches.push(fetchCandles(coin, cfg.microTriggerInterval, cfg.microTriggerLookback));
  }
  const [triggerCandles, filterCandles, microCandles] = await Promise.all(fetches);

  if (triggerCandles.length < 21 || filterCandles.length < 21) {
    return null; // not enough data
  }

  const triggerTf = analyseTimeframe(triggerCandles, cfg.triggerInterval);
  const filterTf = analyseTimeframe(filterCandles, cfg.filterInterval);

  // Micro timeframe analysis (1m for scalps — tighter entry confirmation)
  let microTf: TimeframeSignal | undefined;
  if (microCandles && microCandles.length >= 21) {
    microTf = analyseTimeframe(microCandles, cfg.microTriggerInterval!);
  }

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

    // Scalp with micro TF: 1m must agree or be neutral for higher conviction
    if (style === 'scalp' && microTf) {
      if (microTf.bias === bias) {
        // All 3 timeframes agree (1m + 5m + 1h) — boost conviction for precision entry
        conviction = Math.min(1.0, conviction + microTf.strength * 0.15);
      } else if (microTf.bias !== 'NEUTRAL') {
        // 1m disagrees with 5m+1h — dampen conviction (short-term counter-move)
        conviction *= 0.7;
      }
      // 1m neutral = no adjustment, 5m+1h alone are sufficient
    }
  }

  if (conviction < 0.2) return null; // too weak

  // ── RSI guard — avoid entries into extreme zones ──
  if (style === 'scalp') {
    if (bias === 'LONG' && triggerTf.rsi > 75) return null;
    if (bias === 'SHORT' && triggerTf.rsi < 25) return null;
  }

  // ── ADX regime filter — avoid choppy/range-bound markets ──
  const adxValue = filterTf.adx;
  const regimeFiltered = adxValue < 20; // ADX < 20 = no trend, market is choppy
  if (regimeFiltered) {
    // In choppy markets, dampen conviction heavily — only accept very strong signals
    conviction *= 0.4;
    if (conviction < 0.35) return null; // too weak after choppy penalty
  }

  // ── S/R proximity guard — don't enter into nearby resistance/support ──
  if (bias === 'LONG' && triggerTf.nearestResistancePct < 0.8) {
    // Resistance is < 0.8% away — limited upside, skip or dampen
    conviction *= 0.5;
    if (conviction < 0.3) return null;
  }
  if (bias === 'SHORT' && triggerTf.nearestSupportPct < 0.8) {
    // Support is < 0.8% away — limited downside, skip or dampen
    conviction *= 0.5;
    if (conviction < 0.3) return null;
  }

  // ── BB squeeze boost — volatility expansion breakout ──
  if (triggerTf.bbSqueeze) {
    // Low volatility compression → breakout imminent
    // If bias aligns with BB %B direction, boost conviction
    if (bias === 'LONG' && triggerTf.bbPercentB > 0.5) {
      conviction = Math.min(1.0, conviction * 1.1);
    } else if (bias === 'SHORT' && triggerTf.bbPercentB < 0.5) {
      conviction = Math.min(1.0, conviction * 1.1);
    }
  }

  // ── ATR for dynamic stop/size (trigger TF) ──
  const atrPct = triggerTf.atrPct;

  // ── Build reasoning string ──
  const emaCrossLabel = triggerTf.emaFast > triggerTf.emaSlow
    ? `EMA8>${Math.round(triggerTf.emaSlow)}` : `EMA8<${Math.round(triggerTf.emaSlow)}`;
  const trendLabel = triggerTf.lastClose > triggerTf.ema50 ? 'above-EMA50' : 'below-EMA50';
  const volLabel = triggerTf.volumeRatio > 1.5 ? '🔊 high-vol' : triggerTf.volumeRatio < 0.5 ? '🔇 low-vol' : '';
  const rsiLabel = `RSI:${triggerTf.rsi.toFixed(0)}`;
  const adxLabel = `ADX:${adxValue.toFixed(0)}${regimeFiltered ? '⚠choppy' : ''}`;
  const macdLabel = triggerTf.macdHistIncreasing ? 'MACD↑' : 'MACD↓';
  const atrLabel = `ATR:${(atrPct * 100).toFixed(2)}%`;
  const divLabel = triggerTf.bullishDivergence ? '🐂div' : triggerTf.bearishDivergence ? '🐻div' : '';
  const srLabel = `R:${(triggerTf.nearestResistancePct * 100).toFixed(1)}%/S:${(triggerTf.nearestSupportPct * 100).toFixed(1)}%`;

  const reasoning = [
    `${style}:${bias}`,
    `${cfg.triggerInterval} ${emaCrossLabel}`,
    ...(microTf ? [`${cfg.microTriggerInterval} micro:${microTf.bias}`] : []),
    `${cfg.filterInterval} filter:${filterTf.bias}`,
    trendLabel,
    rsiLabel,
    adxLabel,
    macdLabel,
    atrLabel,
    srLabel,
    volLabel,
    divLabel,
    `conviction:${(conviction * 100).toFixed(0)}%`,
  ].filter(Boolean).join(', ');

  return {
    coin,
    style,
    bias,
    conviction,
    triggerTf,
    filterTf,
    microTf,
    reasoning,
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
    leverage: cfg.defaultLeverage,
    atrPct,
    adxValue,
    regimeFiltered,
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
