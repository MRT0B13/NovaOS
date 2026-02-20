/**
 * Analyst Agent
 *
 * Role: DeFi metrics, on-chain data, token price tracking, narrative scoring.
 * Pulls data from DeFiLlama + CoinGecko (public APIs, no key needed) and
 * the Nova data pools to produce market intelligence reports.
 *
 * Runs on a schedule:
 *   - DeFi snapshot: every 4 hours (multi-chain TVL, volume, top movers)
 *   - Market pulse: every 1 hour (token prices, volume spikes)
 *   - Price check: every 15 minutes (SOL, ETH, BTC + Nova-launched tokens)
 *
 * Outgoing messages → Supervisor:
 *   - report (high): Significant market move or anomaly
 *   - intel (high): Price alert (>5% move on majors, >10% on project tokens)
 *   - intel (medium): Periodic DeFi snapshot
 *   - intel (low): Regular market pulse
 *
 * Data sources:
 *   - DeFiLlama API (public, no auth) — TVL, DEX volumes
 *   - CoinGecko API (public, no auth) — Token prices
 *   - DexScreener API (public, no auth) — Nova-launched token prices
 *   - Nova data pools (TrendPool, PnL, SystemReporter)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Lazy imports — data pools
let _getPoolStats: (() => any) | null = null;
let _getPnLSummary: ((prices?: Record<string, number>) => Promise<any>) | null = null;
let _getMetrics: (() => any) | null = null;

async function loadDataPools() {
  try {
    if (!_getPoolStats) {
      const tp = await import('../launchkit/services/trendPool.ts');
      _getPoolStats = tp.getPoolStats;
    }
  } catch { /* not init */ }
  try {
    if (!_getPnLSummary) {
      const pnl = await import('../launchkit/services/pnlTracker.ts');
      _getPnLSummary = pnl.getPnLSummary;
    }
  } catch { /* not init */ }
  try {
    if (!_getMetrics) {
      const sr = await import('../launchkit/services/systemReporter.ts');
      _getMetrics = sr.getMetrics;
    }
  } catch { /* not init */ }
}

// ============================================================================
// DeFiLlama API (public endpoints)
// ============================================================================

const DEFILLAMA_BASE = 'https://api.llama.fi';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// ── Major tokens tracked on every pulse ──
const TRACKED_TOKENS: Record<string, string> = {
  solana: 'SOL',
  ethereum: 'ETH',
  bitcoin: 'BTC',
};

// ── Chains tracked for TVL / DEX volume ──
const TRACKED_CHAINS = ['Solana', 'Ethereum', 'Base'] as const;

interface TokenPrice {
  id: string;
  symbol: string;
  usd: number;
  usd_24h_change: number;
  usd_24h_vol: number;
  timestamp: number;
}

interface TVLSnapshot {
  totalTvl: number;
  solanaTvl: number;
  chainTvl: Record<string, number>;            // e.g. { Solana: 8.2B, Ethereum: 48B, Base: 2.1B }
  topProtocols: Array<{ name: string; tvl: number; change24h: number; chain?: string }>;
  timestamp: number;
}

interface DexVolumeSnapshot {
  total24h: number;
  solana24h: number;
  chainVolume: Record<string, number>;          // per-chain 24h DEX volume
  topDexes: Array<{ name: string; volume24h: number; chain?: string }>;
  timestamp: number;
}

// ── CoinGecko: Token Prices ────────────────────────────────────────

async function fetchTokenPrices(ids: string[]): Promise<TokenPrice[]> {
  try {
    const idsParam = ids.join(',');
    const res = await fetch(
      `${COINGECKO_BASE}/simple/price?ids=${idsParam}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
    );
    if (!res.ok) return [];

    const data = await res.json() as Record<string, any>;
    const prices: TokenPrice[] = [];
    for (const [id, info] of Object.entries(data)) {
      if (info?.usd) {
        prices.push({
          id,
          symbol: TRACKED_TOKENS[id] || id.toUpperCase(),
          usd: info.usd,
          usd_24h_change: info.usd_24h_change || 0,
          usd_24h_vol: info.usd_24h_vol || 0,
          timestamp: Date.now(),
        });
      }
    }
    return prices;
  } catch (err) {
    logger.warn('[analyst] Failed to fetch token prices:', err);
    return [];
  }
}

/** Fetch prices for Nova-launched tokens via DexScreener (free, no auth) */
async function fetchDexScreenerPrices(mintAddresses: string[]): Promise<TokenPrice[]> {
  if (mintAddresses.length === 0) return [];
  const prices: TokenPrice[] = [];
  try {
    // DexScreener supports up to 30 addresses per call
    const batch = mintAddresses.slice(0, 30).join(',');
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`);
    if (!res.ok) return [];

    const data = await res.json() as any;
    const seen = new Set<string>();
    for (const pair of data.pairs || []) {
      const addr = pair.baseToken?.address;
      if (addr && !seen.has(addr)) {
        seen.add(addr);
        prices.push({
          id: addr,
          symbol: pair.baseToken?.symbol || addr.slice(0, 6),
          usd: parseFloat(pair.priceUsd) || 0,
          usd_24h_change: pair.priceChange?.h24 || 0,
          usd_24h_vol: pair.volume?.h24 || 0,
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    logger.debug('[analyst] DexScreener price fetch failed:', err);
  }
  return prices;
}

// ── DeFiLlama: Multi-Chain TVL ────────────────────────────────────

async function fetchMultiChainTVL(): Promise<TVLSnapshot | null> {
  try {
    const [chainsRes, protocolsRes] = await Promise.all([
      fetch(`${DEFILLAMA_BASE}/v2/chains`),
      fetch(`${DEFILLAMA_BASE}/protocols`),
    ]);

    if (!chainsRes.ok || !protocolsRes.ok) return null;

    const chains = await chainsRes.json() as any[];
    const protocols = await protocolsRes.json() as any[];

    const totalTvl = chains.reduce((sum: number, c: any) => sum + (c.tvl || 0), 0);

    // Per-tracked-chain TVL
    const chainTvl: Record<string, number> = {};
    for (const name of TRACKED_CHAINS) {
      const chain = chains.find((c: any) => c.name === name);
      chainTvl[name] = chain?.tvl || 0;
    }

    // Top protocols across ALL tracked chains (deduplicated, sorted by TVL)
    const trackedSet = new Set<string>(TRACKED_CHAINS);
    const topProtocols = protocols
      .filter((p: any) => p.chains?.some((c: string) => trackedSet.has(c)))
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 10)
      .map((p: any) => {
        // Find which tracked chain this protocol is primarily on
        const primaryChain = TRACKED_CHAINS.find(c => p.chains?.includes(c));
        return {
          name: p.name,
          tvl: p.tvl || 0,
          change24h: p.change_1d || 0,
          chain: primaryChain,
        };
      });

    return {
      totalTvl,
      solanaTvl: chainTvl['Solana'] || 0,
      chainTvl,
      topProtocols,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.warn('[analyst] Failed to fetch TVL data:', err);
    return null;
  }
}

async function fetchDexVolumes(): Promise<DexVolumeSnapshot | null> {
  try {
    const res = await fetch(`${DEFILLAMA_BASE}/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const protocols = data.protocols || [];

    // Per-chain volume aggregation
    const chainVolume: Record<string, number> = {};
    const trackedSet = new Set<string>(TRACKED_CHAINS);

    for (const chain of TRACKED_CHAINS) {
      const chainProtos = protocols.filter((p: any) => p.chains?.includes(chain));
      chainVolume[chain] = chainProtos.reduce((sum: number, p: any) => sum + (p.total24h || 0), 0);
    }

    // Top DEXs across all tracked chains
    const topDexes = protocols
      .filter((p: any) => p.chains?.some((c: string) => trackedSet.has(c)))
      .sort((a: any, b: any) => (b.total24h || 0) - (a.total24h || 0))
      .slice(0, 8)
      .map((p: any) => {
        const primaryChain = TRACKED_CHAINS.find(c => p.chains?.includes(c));
        return { name: p.name, volume24h: p.total24h || 0, chain: primaryChain };
      });

    return {
      total24h: data.total24h || 0,
      solana24h: chainVolume['Solana'] || 0,
      chainVolume,
      topDexes,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.warn('[analyst] Failed to fetch DEX volume:', err);
    return null;
  }
}

// ============================================================================
// Analyst Agent
// ============================================================================

export class AnalystAgent extends BaseAgent {
  private snapshotIntervalMs: number;
  private pulseIntervalMs: number;
  private priceCheckIntervalMs: number;
  private lastSnapshot: TVLSnapshot | null = null;
  private lastVolumes: DexVolumeSnapshot | null = null;
  private previousSnapshot: TVLSnapshot | null = null;
  private cycleCount = 0;

  // ── Token Price State ──
  private lastPrices: Map<string, TokenPrice> = new Map();          // id → latest
  private previousPrices: Map<string, TokenPrice> = new Map();      // id → previous
  private launchedTokenMints: string[] = [];                         // Nova-launched token addresses

  constructor(pool: Pool, opts?: { snapshotIntervalMs?: number; pulseIntervalMs?: number; priceCheckIntervalMs?: number }) {
    super({
      agentId: 'nova-analyst',
      agentType: 'analyst',
      pool,
    });
    this.snapshotIntervalMs = opts?.snapshotIntervalMs ?? 4 * 60 * 60 * 1000; // 4 hours
    this.pulseIntervalMs = opts?.pulseIntervalMs ?? 60 * 60 * 1000;           // 1 hour
    this.priceCheckIntervalMs = opts?.priceCheckIntervalMs ?? 15 * 60 * 1000;  // 15 min
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Full DeFi snapshot (multi-chain TVL + volume + data pools)
    this.addInterval(() => this.takeSnapshot(), this.snapshotIntervalMs);

    // Quick market pulse (DEX volumes + volume spikes)
    this.addInterval(() => this.marketPulse(), this.pulseIntervalMs);

    // Token price checks (SOL, ETH, BTC + Nova launched tokens)
    this.addInterval(() => this.priceCheck(), this.priceCheckIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // Load launched tokens for tracking
    await this.loadLaunchedTokens();

    // First snapshot shortly after start
    setTimeout(() => this.takeSnapshot(), 30_000);
    // First price check after 15s
    setTimeout(() => this.priceCheck(), 15_000);

    logger.info(`[analyst] Snapshot every ${this.snapshotIntervalMs / 3600000}h, pulse every ${this.pulseIntervalMs / 60000}m, prices every ${this.priceCheckIntervalMs / 60000}m`);
  }

  /** Load Nova-launched token mint addresses from kv_store for price tracking */
  private async loadLaunchedTokens(): Promise<void> {
    try {
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'kv_store' LIMIT 1`,
      );
      if (tableCheck.rows.length === 0) return;

      const result = await this.pool.query(
        `SELECT data FROM kv_store WHERE key LIKE 'launchpack:%'`,
      );
      const mints: string[] = [];
      for (const row of result.rows) {
        try {
          const pack = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          if (pack?.launch?.mint) mints.push(pack.launch.mint);
        } catch { /* skip */ }
      }
      this.launchedTokenMints = mints;
      if (mints.length > 0) {
        logger.info(`[analyst] Tracking ${mints.length} Nova-launched tokens for price alerts`);
      }
    } catch {
      // kv_store may not exist
    }
  }

  // ── DeFi Snapshot ────────────────────────────────────────────────

  private async takeSnapshot(): Promise<void> {
    if (!this.running) return;
    try {
      await this.updateStatus('analyzing');
      await loadDataPools();

      const [tvl, volumes] = await Promise.all([
        fetchMultiChainTVL(),
        fetchDexVolumes(),
      ]);

      this.previousSnapshot = this.lastSnapshot;
      if (tvl) this.lastSnapshot = tvl;
      if (volumes) this.lastVolumes = volumes;
      this.cycleCount++;

      // ── Gather Nova data pool metrics ──
      let trendStats: { available: number; topTrends: Array<{ topic: string; score: number }> } | undefined;
      let pnlSummary: { totalPnl: number; activePositions: number; winRate: number } | undefined;
      let systemMetrics: { tweetsSentToday: number; tgPostsSentToday: number; errors24h: number } | undefined;

      try {
        if (_getPoolStats) {
          const ps = _getPoolStats();
          trendStats = { available: ps.available, topTrends: ps.topTrends.slice(0, 3) };
        }
      } catch { /* ok */ }
      try {
        if (_getPnLSummary) {
          const pnl = await _getPnLSummary();
          pnlSummary = { totalPnl: pnl.totalPnl, activePositions: pnl.activePositions, winRate: pnl.winRate };
        }
      } catch { /* ok */ }
      try {
        if (_getMetrics) {
          const m = _getMetrics();
          systemMetrics = { tweetsSentToday: m.tweetsSentToday, tgPostsSentToday: m.tgPostsSentToday, errors24h: m.errors24h };
        }
      } catch { /* ok */ }

      // Check for significant moves
      const anomalies = this.detectAnomalies(tvl, volumes);

      if (anomalies.length > 0) {
        await this.reportToSupervisor('report', 'high', {
          source: 'defi_snapshot',
          anomalies,
          summary: anomalies.join(' | '),
          solanaTvl: tvl?.solanaTvl,
          chainTvl: tvl?.chainTvl,
          dexVolume24h: volumes?.solana24h,
          chainVolume: volumes?.chainVolume,
          trendStats,
          pnlSummary,
        });
      } else {
        // Regular snapshot — includes full multi-chain + Nova data landscape
        const latestPrices = this.getPricesSummary();
        await this.reportToSupervisor('intel', 'low', {
          source: 'defi_snapshot',
          solanaTvl: tvl?.solanaTvl,
          chainTvl: tvl?.chainTvl,
          topProtocols: tvl?.topProtocols?.slice(0, 5).map(p => `${p.name} (${p.chain})`),
          dexVolume24h: volumes?.solana24h,
          chainVolume: volumes?.chainVolume,
          topDexes: volumes?.topDexes?.slice(0, 5).map(d => `${d.name} (${d.chain})`),
          tokenPrices: latestPrices,
          trendStats,
          pnlSummary,
          systemMetrics,
        });
      }

      // Enhanced logging with multi-chain + price data
      const chainStr = tvl?.chainTvl
        ? Object.entries(tvl.chainTvl).map(([c, v]) => `${c}=$${this.formatUSD(v)}`).join(', ')
        : '';
      const priceStr = this.getPriceLogLine();
      const trendStr = trendStats ? `, Trends=${trendStats.available}` : '';
      const pnlStr = pnlSummary ? `, PnL=${pnlSummary.totalPnl.toFixed(4)} SOL` : '';
      const sysStr = systemMetrics ? `, Tweets=${systemMetrics.tweetsSentToday}` : '';
      await this.updateStatus('alive');
      logger.info(`[analyst] Snapshot #${this.cycleCount}: TVL=[${chainStr}], DEX Vol=$${this.formatUSD(volumes?.solana24h || 0)}${priceStr}${trendStr}${pnlStr}${sysStr}`);
    } catch (err) {
      logger.error('[analyst] Snapshot failed:', err);
      await this.updateStatus('error');
    }
  }

  // ── Token Price Check ────────────────────────────────────────────

  private async priceCheck(): Promise<void> {
    if (!this.running) return;
    try {
      // 1. Major tokens via CoinGecko
      const majorIds = Object.keys(TRACKED_TOKENS);
      const majorPrices = await fetchTokenPrices(majorIds);

      // 2. Nova-launched tokens via DexScreener
      const novaPrices = await fetchDexScreenerPrices(this.launchedTokenMints);

      // 3. Combine and detect alerts
      const allPrices = [...majorPrices, ...novaPrices];
      const alerts: string[] = [];

      for (const price of allPrices) {
        // Save previous before updating
        const prev = this.lastPrices.get(price.id);
        if (prev) this.previousPrices.set(price.id, prev);
        this.lastPrices.set(price.id, price);

        // Alert thresholds: 5% for majors, 10% for Nova tokens
        const isMajor = majorIds.includes(price.id);
        const threshold = isMajor ? 5 : 10;
        const prevPrice = this.previousPrices.get(price.id);

        if (prevPrice && prevPrice.usd > 0) {
          const changePercent = ((price.usd - prevPrice.usd) / prevPrice.usd) * 100;

          if (Math.abs(changePercent) >= threshold) {
            const direction = changePercent > 0 ? '⬆️' : '⬇️';
            const alert = `${direction} ${price.symbol} ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% ($${price.usd.toFixed(price.usd < 1 ? 6 : 2)})`;
            alerts.push(alert);
          }
        }
      }

      // Log all tracked prices
      const priceLog = allPrices.map(p => `${p.symbol}=$${p.usd < 1 ? p.usd.toFixed(6) : p.usd.toFixed(2)}`).join(', ');
      logger.info(`[analyst] Prices: ${priceLog || 'none fetched'}`);

      // Report price alerts to supervisor
      if (alerts.length > 0) {
        await this.reportToSupervisor('intel', 'high', {
          source: 'price_alert',
          summary: alerts.join(' | '),
          alerts,
          prices: allPrices.map(p => ({ symbol: p.symbol, usd: p.usd, change24h: p.usd_24h_change })),
        });
        logger.warn(`[analyst] ⚠️ Price alerts: ${alerts.join(', ')}`);
      }

      // Refresh launched tokens periodically (new launches may have appeared)
      if (this.cycleCount % 4 === 0) {
        await this.loadLaunchedTokens();
      }
    } catch (err) {
      logger.debug('[analyst] Price check failed:', err);
    }
  }

  /** Get a dictionary of latest prices for the snapshot payload */
  private getPricesSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const [, price] of this.lastPrices) {
      summary[price.symbol] = price.usd;
    }
    return summary;
  }

  /** One-line price summary for logging */
  private getPriceLogLine(): string {
    const parts: string[] = [];
    // Only include majors in the log line
    for (const [id, symbol] of Object.entries(TRACKED_TOKENS)) {
      const p = this.lastPrices.get(id);
      if (p) parts.push(`${symbol}=$${p.usd.toFixed(2)}`);
    }
    return parts.length > 0 ? `, ${parts.join(', ')}` : '';
  }

  // ── Market Pulse ─────────────────────────────────────────────────

  private async marketPulse(): Promise<void> {
    if (!this.running) return;
    try {
      // Quick volume check — lighter than full snapshot
      const volumes = await fetchDexVolumes();
      if (volumes) {
        // Save previous values BEFORE updating
        const prevChainVol = this.lastVolumes?.chainVolume || {};
        this.lastVolumes = volumes;

        // Detect volume spikes per chain (compared to last pulse)
        const spikes: string[] = [];
        for (const chain of TRACKED_CHAINS) {
          const prevVol = prevChainVol[chain] || 0;
          const newVol = volumes.chainVolume[chain] || 0;
          if (prevVol > 0 && newVol > 0) {
            const changeRatio = newVol / prevVol;
            if (changeRatio > 2.0) {
              spikes.push(`${chain} DEX volume surged ${Math.round(changeRatio * 100 - 100)}% — $${this.formatUSD(newVol)} in 24h`);
            }
          }
        }

        if (spikes.length > 0) {
          await this.reportToSupervisor('intel', 'high', {
            source: 'volume_spike',
            summary: spikes.join(' | '),
            chainVolume: volumes.chainVolume,
          });
        }
      }
    } catch (err) {
      logger.debug('[analyst] Pulse check failed:', err);
    }
  }

  // ── Anomaly Detection ────────────────────────────────────────────

  private detectAnomalies(tvl: TVLSnapshot | null, volumes: DexVolumeSnapshot | null): string[] {
    const anomalies: string[] = [];

    if (tvl && this.previousSnapshot) {
      // Per-chain TVL moves
      for (const chain of TRACKED_CHAINS) {
        const prevTvl = this.previousSnapshot.chainTvl?.[chain] || 0;
        const currTvl = tvl.chainTvl[chain] || 0;
        if (prevTvl > 0 && currTvl > 0) {
          const tvlChange = (currTvl - prevTvl) / prevTvl;
          if (tvlChange < -0.15) {
            anomalies.push(`${chain} TVL dropped ${Math.round(Math.abs(tvlChange) * 100)}% to $${this.formatUSD(currTvl)}`);
          }
          if (tvlChange > 0.25) {
            anomalies.push(`${chain} TVL surged ${Math.round(tvlChange * 100)}% to $${this.formatUSD(currTvl)}`);
          }
        }
      }

      // Individual protocol moves > 30%
      for (const p of tvl.topProtocols) {
        if (Math.abs(p.change24h) > 30) {
          anomalies.push(`${p.name}${p.chain ? ` (${p.chain})` : ''} TVL ${p.change24h > 0 ? 'up' : 'down'} ${Math.round(Math.abs(p.change24h))}%`);
        }
      }
    }

    return anomalies;
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command' && msg.payload?.action === 'snapshot') {
          logger.info('[analyst] Snapshot requested by supervisor');
          await this.takeSnapshot();
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private formatUSD(value: number): string {
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
    return value.toFixed(0);
  }

  // ── Public API ───────────────────────────────────────────────────

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      cycleCount: this.cycleCount,
      trackedChains: [...TRACKED_CHAINS],
      trackedTokens: Object.values(TRACKED_TOKENS),
      launchedTokensTracked: this.launchedTokenMints.length,
      lastSnapshot: this.lastSnapshot
        ? {
            chainTvl: this.lastSnapshot.chainTvl,
            topProtocols: this.lastSnapshot.topProtocols.slice(0, 5).map(p => `${p.name} (${p.chain})`),
            at: new Date(this.lastSnapshot.timestamp).toISOString(),
          }
        : null,
      lastVolumes: this.lastVolumes
        ? {
            chainVolume: this.lastVolumes.chainVolume,
            topDexes: this.lastVolumes.topDexes.slice(0, 5).map(d => `${d.name} (${d.chain})`),
            at: new Date(this.lastVolumes.timestamp).toISOString(),
          }
        : null,
      lastPrices: this.getPricesSummary(),
    };
  }

  /** Get latest data for prompt injection */
  getLatestIntel(): string | null {
    if (!this.lastSnapshot && !this.lastVolumes && this.lastPrices.size === 0) return null;

    const parts: string[] = [];

    // Chain TVL
    if (this.lastSnapshot?.chainTvl) {
      const tvlParts = Object.entries(this.lastSnapshot.chainTvl)
        .map(([chain, tvl]) => `${chain}: $${this.formatUSD(tvl)}`)
        .join(', ');
      parts.push(`TVL [${tvlParts}]`);
    }

    // Top protocols
    if (this.lastSnapshot) {
      const top3 = this.lastSnapshot.topProtocols.slice(0, 3).map(p => `${p.name} (${p.chain})`).join(', ');
      if (top3) parts.push(`Top: ${top3}`);
    }

    // Chain volumes
    if (this.lastVolumes?.chainVolume) {
      const volParts = Object.entries(this.lastVolumes.chainVolume)
        .filter(([, v]) => v > 0)
        .map(([chain, vol]) => `${chain}: $${this.formatUSD(vol)}`)
        .join(', ');
      if (volParts) parts.push(`DEX Vol [${volParts}]`);
    }

    // Major token prices
    const priceParts: string[] = [];
    for (const [id, symbol] of Object.entries(TRACKED_TOKENS)) {
      const p = this.lastPrices.get(id);
      if (p) priceParts.push(`${symbol}=$${p.usd.toFixed(2)}`);
    }
    if (priceParts.length > 0) parts.push(priceParts.join(', '));

    return parts.join(' | ');
  }
}
