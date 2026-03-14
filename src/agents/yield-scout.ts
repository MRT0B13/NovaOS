/**
 * Yield Scout Agent
 *
 * Role: Multi-chain DeFi yield monitoring — scans EVM LP pools,
 * Orca (Solana), Kamino (Solana), and Jito (Solana) for top-yielding
 * pools/vaults and alerts when APY exceeds user-defined thresholds.
 *
 * Data sources:
 *   - DeFiLlama → EVM LP pools across Ethereum, Base, Arbitrum, Polygon, BSC, etc.
 *   - Orca Whirlpools    → Solana concentrated liquidity pools
 *   - Kamino             → Solana lending/borrowing vaults
 *   - Jito               → Solana liquid staking yield
 *
 * Philosophy: The CFO uses these services to *execute*. Yield Scout just
 * surfaces opportunities — zero execution, pure intel. Think of it as a
 * yield farming radar that runs 24/7.
 *
 * Lifecycle: Factory-spawned via `yield_monitoring` capability.
 *
 * Outgoing messages → Supervisor:
 *   - intel (medium): New high-yield opportunities detected
 *   - report (low): Periodic yield landscape summary
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Force refresh all sources
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import type { WalletConfig } from './wallet-utils.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Default poll interval: 15 minutes */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;

/** Minimum APY to include in reports (default 5%) */
const DEFAULT_MIN_APY = 5;

/** Minimum TVL to consider a pool legitimate ($50k) */
const DEFAULT_MIN_TVL = 50_000;

/** Max opportunities to report per cycle */
const MAX_OPPS_PER_CYCLE = 10;

/** APY spike threshold — alert if APY increases by this much between scans */
const APY_SPIKE_THRESHOLD = 2.0; // 2x increase

// ============================================================================
// Types
// ============================================================================

interface YieldOpportunity {
  source: 'evm_lp' | 'orca' | 'kamino' | 'jito';
  chain: string;
  protocol: string;
  pool: string;          // Pool name or pair (e.g. "ETH/USDC")
  apy: number;           // Annual percentage yield
  tvlUsd: number;        // Total value locked
  token0?: string;
  token1?: string;
  feeRate?: number;
  score: number;          // Composite score 0-100
  metadata: Record<string, unknown>;
}

interface YieldSnapshot {
  timestamp: number;
  opportunities: YieldOpportunity[];
  totalScanned: number;
  sourcesOnline: string[];
  sourcesOffline: string[];
}

// ============================================================================
// Yield Scout Agent
// ============================================================================

export class YieldScoutAgent extends BaseAgent {
  private pollIntervalMs: number;
  private minApy: number;
  private minTvl: number;
  private walletConfig?: WalletConfig;
  private cycleCount = 0;
  private totalOppsReported = 0;
  private lastSnapshot: YieldSnapshot | null = null;
  private previousApyMap: Map<string, number> = new Map(); // poolKey → lastApy

  constructor(pool: Pool, opts?: {
    pollIntervalMs?: number;
    minApy?: number;
    minTvl?: number;
    chains?: string[];
    wallet?: { chain: string; address: string; encryptedKey?: string; permissions: string[] };
  }) {
    super({
      agentId: 'nova-yield-scout',
      agentType: 'analyst',
      pool,
    });
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.minApy = opts?.minApy ?? DEFAULT_MIN_APY;
    this.minTvl = opts?.minTvl ?? DEFAULT_MIN_TVL;
    this.walletConfig = opts?.wallet as WalletConfig | undefined;
  }

  protected async onStart(): Promise<void> {
    const saved = await this.restoreState<{
      cycleCount: number;
      totalOppsReported: number;
      previousApyMap: [string, number][];
    }>();
    if (saved) {
      this.cycleCount = saved.cycleCount || 0;
      this.totalOppsReported = saved.totalOppsReported || 0;
      if (saved.previousApyMap) this.previousApyMap = new Map(saved.previousApyMap);
    }

    this.startHeartbeat(60_000);

    // First scan after 45s warmup (let services initialize)
    setTimeout(() => this.runScanCycle(), 45_000);

    // Recurring scans
    this.addInterval(() => this.runScanCycle(), this.pollIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 30_000);

    logger.info(`[yield-scout] 📈 Online — scanning EVM LP + Orca + Kamino + Jito every ${this.pollIntervalMs / 60000}min (min APY: ${this.minApy}%)`);
  }

  protected async onStop(): Promise<void> {
    await this.persistState();
    logger.info(`[yield-scout] Stopped after ${this.cycleCount} cycles, ${this.totalOppsReported} opps reported`);
  }

  // ── Main Scan Cycle ────────────────────────────────────────────

  private async runScanCycle(): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;
    await this.updateStatus('gathering');

    logger.info(`[yield-scout] 🔍 Cycle #${cycleId} — scanning yield sources...`);

    const opportunities: YieldOpportunity[] = [];
    const sourcesOnline: string[] = [];
    const sourcesOffline: string[] = [];
    let totalScanned = 0;

    // Scan all sources in parallel
    const [evmLpResult, orcaResult, kaminoResult, jitoResult] = await Promise.allSettled([
      this.scanEvmLpPools(),
      this.scanOrca(),
      this.scanKamino(),
      this.scanJito(),
    ]);

    // Process EVM LP (multi-chain)
    if (evmLpResult.status === 'fulfilled' && evmLpResult.value.length > 0) {
      opportunities.push(...evmLpResult.value);
      totalScanned += evmLpResult.value.length;
      sourcesOnline.push('evm_lp');
    } else {
      sourcesOffline.push('evm_lp');
      if (evmLpResult.status === 'rejected') {
        logger.warn(`[yield-scout] EVM LP scan failed: ${evmLpResult.reason}`);
      }
    }

    // Process Orca (Solana)
    if (orcaResult.status === 'fulfilled' && orcaResult.value.length > 0) {
      opportunities.push(...orcaResult.value);
      totalScanned += orcaResult.value.length;
      sourcesOnline.push('orca');
    } else {
      sourcesOffline.push('orca');
    }

    // Process Kamino (Solana)
    if (kaminoResult.status === 'fulfilled' && kaminoResult.value.length > 0) {
      opportunities.push(...kaminoResult.value);
      totalScanned += kaminoResult.value.length;
      sourcesOnline.push('kamino');
    } else {
      sourcesOffline.push('kamino');
    }

    // Process Jito (Solana)
    if (jitoResult.status === 'fulfilled' && jitoResult.value.length > 0) {
      opportunities.push(...jitoResult.value);
      totalScanned += jitoResult.value.length;
      sourcesOnline.push('jito');
    } else {
      sourcesOffline.push('jito');
    }

    // Filter by minimum APY and TVL
    const qualified = opportunities
      .filter(o => o.apy >= this.minApy && o.tvlUsd >= this.minTvl)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_OPPS_PER_CYCLE);

    // Detect APY spikes (opportunities where APY jumped significantly)
    const spikes: YieldOpportunity[] = [];
    for (const opp of qualified) {
      const key = `${opp.source}:${opp.chain}:${opp.pool}`;
      const prevApy = this.previousApyMap.get(key);
      if (prevApy && opp.apy >= prevApy * APY_SPIKE_THRESHOLD) {
        spikes.push(opp);
      }
      this.previousApyMap.set(key, opp.apy);
    }

    // Cap the APY map size to prevent unbounded growth
    if (this.previousApyMap.size > 500) {
      const entries = [...this.previousApyMap.entries()];
      this.previousApyMap = new Map(entries.slice(-300));
    }

    // Save snapshot
    this.lastSnapshot = {
      timestamp: Date.now(),
      opportunities: qualified,
      totalScanned,
      sourcesOnline,
      sourcesOffline,
    };

    await this.updateStatus('alive');

    // Report to Supervisor
    if (qualified.length > 0) {
      this.totalOppsReported += qualified.length;

      const topOpps = qualified.slice(0, 5).map(o =>
        `${o.source}/${o.chain}: ${o.pool} → ${o.apy.toFixed(1)}% APY ($${(o.tvlUsd / 1000).toFixed(0)}k TVL)`
      ).join('\n  ');

      await this.reportToSupervisor('intel', 'medium', {
        type: 'yield_scan',
        cycle: cycleId,
        found: qualified.length,
        totalScanned,
        sourcesOnline,
        sourcesOffline,
        spikeCount: spikes.length,
        topOpportunities: qualified.slice(0, 5),
        summary: `Cycle #${cycleId}: ${qualified.length} yield opps above ${this.minApy}% APY across ${sourcesOnline.length} sources\n  ${topOpps}`,
      });

      // If there are APY spikes, send a separate high-priority alert
      if (spikes.length > 0) {
        await this.reportToSupervisor('alert', 'high', {
          type: 'yield_spike',
          spikes: spikes.map(s => ({
            source: s.source,
            chain: s.chain,
            pool: s.pool,
            apy: s.apy,
            previousApy: this.previousApyMap.get(`${s.source}:${s.chain}:${s.pool}`),
          })),
          summary: `⚡ ${spikes.length} APY spike(s) detected — yields jumped ${APY_SPIKE_THRESHOLD}x+`,
        });
      }
    }

    logger.info(
      `[yield-scout] Cycle #${cycleId} complete: ${qualified.length}/${totalScanned} opps qualified ` +
      `(${sourcesOnline.length} sources online, ${spikes.length} spikes)`
    );

    await this.persistState();
  }

  // ── EVM LP (Multi-Chain) ──────────────────────────────────

  private async scanEvmLpPools(): Promise<YieldOpportunity[]> {
    try {
      const { discoverEvmPools } = await import('../launchkit/cfo/evmPoolDiscovery.ts');
      const pools = await discoverEvmPools();

      return pools
        .filter((p: any) => p.tvlUsd >= this.minTvl)
        .map((p: any) => {
          // EVM pools have feeApy, rewardApy fields
          const totalApy = (p.feeApy || 0) + (p.rewardApy || 0);
          const chainName = p.chainName || p.chain || `chain-${p.chainId}`;

          return {
            source: 'evm_lp' as const,
            chain: chainName,
            protocol: p.protocol || p.dex || 'unknown',
            pool: `${p.token0Symbol || '?'}/${p.token1Symbol || '?'}`,
            apy: totalApy,
            tvlUsd: p.tvlUsd || 0,
            token0: p.token0Symbol,
            token1: p.token1Symbol,
            feeRate: p.feeTier,
            score: this.scoreYield(totalApy, p.tvlUsd || 0, 'evm_lp', p.score || 0),
            metadata: {
              poolAddress: p.poolAddress,
              chainId: p.chainId,
              protocol: p.protocol,
              feeApy: p.feeApy,
              rewardApy: p.rewardApy,
              volume24h: p.volume24h,
              evmPoolScore: p.score,
            },
          };
        })
        .filter((o: YieldOpportunity) => o.apy >= this.minApy);
    } catch (err: any) {
      logger.warn(`[yield-scout] EVM LP scan failed: ${err.message}`);
      return [];
    }
  }

  // ── Orca (Solana CL Pools) ─────────────────────────────────────

  private async scanOrca(): Promise<YieldOpportunity[]> {
    try {
      const orcaDiscovery = await import('../launchkit/cfo/orcaPoolDiscovery.ts');
      const pools = await orcaDiscovery.discoverOrcaPools?.();

      if (!pools || !Array.isArray(pools)) return [];

      return pools
        .filter((p: any) => (p.tvlUsd || p.tvl || 0) >= this.minTvl)
        .map((p: any) => {
          const apy = p.apy || p.feeApy || 0;
          return {
            source: 'orca' as const,
            chain: 'Solana',
            protocol: 'Orca Whirlpools',
            pool: p.name || `${p.tokenA?.symbol || '?'}/${p.tokenB?.symbol || '?'}`,
            apy,
            tvlUsd: p.tvlUsd || p.tvl || 0,
            token0: p.tokenA?.symbol,
            token1: p.tokenB?.symbol,
            feeRate: p.feeRate,
            score: this.scoreYield(apy, p.tvlUsd || p.tvl || 0, 'orca'),
            metadata: {
              poolAddress: p.address,
              volume24h: p.volume24h,
              feeRate: p.feeRate,
            },
          };
        })
        .filter((o: YieldOpportunity) => o.apy >= this.minApy);
    } catch (err: any) {
      logger.warn(`[yield-scout] Orca scan failed: ${err.message}`);
      return [];
    }
  }

  // ── Kamino (Solana Lending) ────────────────────────────────────

  private async scanKamino(): Promise<YieldOpportunity[]> {
    try {
      const kamino = await import('../launchkit/cfo/kaminoService.ts');
      // Use getReserveRegistry to get all lending reserves with APY data
      const reserves = await kamino.getReserveRegistry();

      if (!reserves || !Array.isArray(reserves)) return [];

      return reserves
        .filter((r: any) => (r.depositTvl || r.totalSupply || 0) >= this.minTvl)
        .map((r: any) => {
          const apy = r.supplyApy || r.apy || 0;
          const tvl = r.depositTvl || r.totalSupply || 0;
          return {
            source: 'kamino' as const,
            chain: 'Solana',
            protocol: 'Kamino Finance',
            pool: r.symbol || r.name || 'reserve',
            apy: apy * 100, // Convert from decimal to percentage if needed
            tvlUsd: tvl,
            token0: r.symbol,
            score: this.scoreYield(apy > 1 ? apy : apy * 100, tvl, 'kamino'),
            metadata: {
              reserveAddress: r.address || r.reserve,
              ltv: r.ltv,
              borrowApy: r.borrowApy,
            },
          };
        })
        .filter((o: YieldOpportunity) => o.apy >= this.minApy);
    } catch (err: any) {
      logger.warn(`[yield-scout] Kamino scan failed: ${err.message}`);
      return [];
    }
  }

  // ── Jito (Solana Liquid Staking) ───────────────────────────────

  private async scanJito(): Promise<YieldOpportunity[]> {
    try {
      const jito = await import('../launchkit/cfo/jitoStakingService.ts');
      // getStakePosition needs SOL price — get from Pyth
      let solPrice = 150;
      try {
        const { getSolPrice } = await import('../launchkit/cfo/pythOracleService.ts');
        solPrice = await getSolPrice();
      } catch { /* fallback */ }

      const data = await jito.getStakePosition(solPrice) as any;

      if (!data) return [];

      // Jito APY is typically ~7-8% from MEV rewards
      const apy = data.apy || data.annualizedYield || 7.5;
      const tvl = data.valueUsd || data.totalStakedUsd || 0;

      if (apy < this.minApy || tvl < this.minTvl) return [];

      return [{
        source: 'jito' as const,
        chain: 'Solana',
        protocol: 'Jito Liquid Staking',
        pool: 'JitoSOL',
        apy,
        tvlUsd: tvl,
        token0: 'SOL',
        token1: 'JitoSOL',
        score: this.scoreYield(apy, tvl, 'jito'),
        metadata: {
          stakingRate: data.stakingRate,
          totalStaked: data.totalStaked,
        },
      }];
    } catch (err: any) {
      logger.warn(`[yield-scout] Jito scan failed: ${err.message}`);
      return [];
    }
  }

  // ── Scoring ────────────────────────────────────────────────────

  /**
   * Composite yield score (0-100).
   * Factors: APY magnitude, TVL safety, source quality, sustainability.
   */
  private scoreYield(apy: number, tvlUsd: number, source: string, externalScore?: number): number {
    let score = 0;

    // APY tier (0-35 points) — diminishing returns above 50%
    if (apy >= 100) score += 35;
    else if (apy >= 50) score += 30;
    else if (apy >= 25) score += 25;
    else if (apy >= 15) score += 20;
    else if (apy >= 10) score += 15;
    else if (apy >= 5) score += 10;
    else score += 5;

    // TVL safety (0-25 points) — larger TVL = more trustworthy
    if (tvlUsd >= 10_000_000) score += 25;
    else if (tvlUsd >= 5_000_000) score += 22;
    else if (tvlUsd >= 1_000_000) score += 18;
    else if (tvlUsd >= 500_000) score += 14;
    else if (tvlUsd >= 100_000) score += 10;
    else score += 5;

    // Source quality (0-15 points)
    const sourceScores: Record<string, number> = {
      evm_lp: 15,    // Multi-chain DeFiLlama pools
      orca: 14,        // Solana blue-chip
      kamino: 13,      // Solana lending leader
      jito: 12,        // Liquid staking, safe
    };
    score += sourceScores[source] || 8;

    // External score bonus (from DeFiLlama scoring) (0-10 points)
    if (externalScore) {
      score += Math.min(10, Math.round(externalScore / 10));
    }

    // Sustainability penalty — extremely high APY is often unsustainable
    if (apy > 200) score -= 10;
    else if (apy > 100) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  // ── Command Processing ─────────────────────────────────────────

  private async processCommands(): Promise<void> {
    const messages = await this.readMessages(5);
    for (const msg of messages) {
      const payload = msg.payload;
      if (payload?.command === 'immediate_scan') {
        logger.info('[yield-scout] Received immediate_scan command');
        await this.runScanCycle();
      }
      await this.acknowledgeMessage(msg.id!);
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      totalOppsReported: this.totalOppsReported,
      previousApyMap: [...this.previousApyMap.entries()].slice(-200),
    });
  }
}
