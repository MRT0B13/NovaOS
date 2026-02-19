/**
 * Analyst Agent
 *
 * Role: DeFi metrics, on-chain data, narrative scoring.
 * Pulls data from DeFiLlama (public API, no key needed) and the Nova
 * research knowledge base to produce market intelligence reports.
 *
 * Runs on a schedule:
 *   - DeFi snapshot: every 4 hours (TVL, volume, top movers)
 *   - Market pulse: every 1 hour (quick price/trend check)
 *
 * Outgoing messages → Supervisor:
 *   - report (high): Significant market move or anomaly
 *   - intel (medium): Periodic DeFi snapshot
 *   - intel (low): Regular market pulse
 *
 * Data sources:
 *   - DeFiLlama API (public, no auth)
 *   - novaResearch knowledge base (via quickSearch)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// ============================================================================
// DeFiLlama API (public endpoints)
// ============================================================================

const DEFILLAMA_BASE = 'https://api.llama.fi';

interface TVLSnapshot {
  totalTvl: number;
  solanaTvl: number;
  topProtocols: Array<{ name: string; tvl: number; change24h: number }>;
  timestamp: number;
}

interface DexVolumeSnapshot {
  total24h: number;
  solana24h: number;
  topDexes: Array<{ name: string; volume24h: number }>;
  timestamp: number;
}

async function fetchSolanaTVL(): Promise<TVLSnapshot | null> {
  try {
    const [chainsRes, protocolsRes] = await Promise.all([
      fetch(`${DEFILLAMA_BASE}/v2/chains`),
      fetch(`${DEFILLAMA_BASE}/protocols`),
    ]);

    if (!chainsRes.ok || !protocolsRes.ok) return null;

    const chains = await chainsRes.json() as any[];
    const protocols = await protocolsRes.json() as any[];

    const solana = chains.find((c: any) => c.name === 'Solana');
    const totalTvl = chains.reduce((sum: number, c: any) => sum + (c.tvl || 0), 0);

    // Top Solana protocols by TVL
    const solanaProtocols = protocols
      .filter((p: any) => p.chains?.includes('Solana'))
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 5)
      .map((p: any) => ({
        name: p.name,
        tvl: p.tvl || 0,
        change24h: p.change_1d || 0,
      }));

    return {
      totalTvl,
      solanaTvl: solana?.tvl || 0,
      topProtocols: solanaProtocols,
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

    const solanaProtocols = protocols.filter(
      (p: any) => p.chains?.includes('Solana'),
    );

    const solana24h = solanaProtocols.reduce(
      (sum: number, p: any) => sum + (p.total24h || 0), 0,
    );

    const topDexes = solanaProtocols
      .sort((a: any, b: any) => (b.total24h || 0) - (a.total24h || 0))
      .slice(0, 5)
      .map((p: any) => ({ name: p.name, volume24h: p.total24h || 0 }));

    return {
      total24h: data.total24h || 0,
      solana24h,
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
  private lastSnapshot: TVLSnapshot | null = null;
  private lastVolumes: DexVolumeSnapshot | null = null;
  private previousSnapshot: TVLSnapshot | null = null;
  private cycleCount = 0;

  constructor(pool: Pool, opts?: { snapshotIntervalMs?: number; pulseIntervalMs?: number }) {
    super({
      agentId: 'nova-analyst',
      agentType: 'analyst',
      pool,
    });
    this.snapshotIntervalMs = opts?.snapshotIntervalMs ?? 4 * 60 * 60 * 1000; // 4 hours
    this.pulseIntervalMs = opts?.pulseIntervalMs ?? 60 * 60 * 1000;           // 1 hour
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Full DeFi snapshot
    this.addInterval(() => this.takeSnapshot(), this.snapshotIntervalMs);

    // Quick market pulse
    this.addInterval(() => this.marketPulse(), this.pulseIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // First snapshot shortly after start
    setTimeout(() => this.takeSnapshot(), 30_000);

    logger.info(`[analyst] Snapshot every ${this.snapshotIntervalMs / 3600000}h, pulse every ${this.pulseIntervalMs / 60000}m`);
  }

  // ── DeFi Snapshot ────────────────────────────────────────────────

  private async takeSnapshot(): Promise<void> {
    if (!this.running) return;
    try {
      await this.updateStatus('analyzing');

      const [tvl, volumes] = await Promise.all([
        fetchSolanaTVL(),
        fetchDexVolumes(),
      ]);

      this.previousSnapshot = this.lastSnapshot;
      if (tvl) this.lastSnapshot = tvl;
      if (volumes) this.lastVolumes = volumes;
      this.cycleCount++;

      // Check for significant moves
      const anomalies = this.detectAnomalies(tvl, volumes);

      if (anomalies.length > 0) {
        await this.reportToSupervisor('report', 'high', {
          source: 'defi_snapshot',
          anomalies,
          summary: anomalies.join(' | '),
          solanaTvl: tvl?.solanaTvl,
          dexVolume24h: volumes?.solana24h,
        });
      } else {
        // Regular snapshot — low priority
        await this.reportToSupervisor('intel', 'low', {
          source: 'defi_snapshot',
          solanaTvl: tvl?.solanaTvl,
          topProtocols: tvl?.topProtocols?.slice(0, 3).map(p => p.name),
          dexVolume24h: volumes?.solana24h,
          topDexes: volumes?.topDexes?.slice(0, 3).map(d => d.name),
        });
      }

      await this.updateStatus('alive');
      logger.info(`[analyst] Snapshot #${this.cycleCount}: Solana TVL=$${this.formatUSD(tvl?.solanaTvl || 0)}, DEX Vol=$${this.formatUSD(volumes?.solana24h || 0)}`);
    } catch (err) {
      logger.error('[analyst] Snapshot failed:', err);
      await this.updateStatus('error');
    }
  }

  // ── Market Pulse ─────────────────────────────────────────────────

  private async marketPulse(): Promise<void> {
    if (!this.running) return;
    try {
      // Quick volume check — lighter than full snapshot
      const volumes = await fetchDexVolumes();
      if (volumes) {
        this.lastVolumes = volumes;

        // Detect volume spikes (compared to last snapshot)
        if (this.lastSnapshot && volumes.solana24h > 0) {
          const prevSolanaVol = this.lastVolumes?.solana24h || 0;
          if (prevSolanaVol > 0) {
            const changeRatio = volumes.solana24h / prevSolanaVol;
            if (changeRatio > 2.0) {
              await this.reportToSupervisor('intel', 'high', {
                source: 'volume_spike',
                summary: `Solana DEX volume surged ${Math.round(changeRatio * 100 - 100)}% — $${this.formatUSD(volumes.solana24h)} in 24h`,
                solana24h: volumes.solana24h,
                changeRatio,
              });
            }
          }
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
      // TVL drop > 15%
      const tvlChange = (tvl.solanaTvl - this.previousSnapshot.solanaTvl) / this.previousSnapshot.solanaTvl;
      if (tvlChange < -0.15) {
        anomalies.push(`Solana TVL dropped ${Math.round(Math.abs(tvlChange) * 100)}% to $${this.formatUSD(tvl.solanaTvl)}`);
      }
      // TVL surge > 25%
      if (tvlChange > 0.25) {
        anomalies.push(`Solana TVL surged ${Math.round(tvlChange * 100)}% to $${this.formatUSD(tvl.solanaTvl)}`);
      }

      // Individual protocol moves > 30%
      for (const p of tvl.topProtocols) {
        if (Math.abs(p.change24h) > 30) {
          anomalies.push(`${p.name} TVL ${p.change24h > 0 ? 'up' : 'down'} ${Math.round(Math.abs(p.change24h))}%`);
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
      lastSnapshot: this.lastSnapshot
        ? {
            solanaTvl: this.lastSnapshot.solanaTvl,
            topProtocols: this.lastSnapshot.topProtocols.slice(0, 3).map(p => p.name),
            at: new Date(this.lastSnapshot.timestamp).toISOString(),
          }
        : null,
      lastVolumes: this.lastVolumes
        ? {
            solana24h: this.lastVolumes.solana24h,
            topDexes: this.lastVolumes.topDexes.slice(0, 3).map(d => d.name),
            at: new Date(this.lastVolumes.timestamp).toISOString(),
          }
        : null,
    };
  }

  /** Get latest data for prompt injection */
  getLatestIntel(): string | null {
    if (!this.lastSnapshot && !this.lastVolumes) return null;

    const parts: string[] = [];
    if (this.lastSnapshot) {
      parts.push(`Solana TVL: $${this.formatUSD(this.lastSnapshot.solanaTvl)}`);
      const top3 = this.lastSnapshot.topProtocols.slice(0, 3).map(p => p.name).join(', ');
      if (top3) parts.push(`Top protocols: ${top3}`);
    }
    if (this.lastVolumes) {
      parts.push(`Solana DEX 24h vol: $${this.formatUSD(this.lastVolumes.solana24h)}`);
    }
    return parts.join(' | ');
  }
}
