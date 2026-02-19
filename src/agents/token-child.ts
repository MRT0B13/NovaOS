/**
 * Token Child Agent
 *
 * Spawned by the Supervisor when Nova launches a new token on pump.fun.
 * Each child agent is lightweight — no LLM calls unless directly requested.
 *
 * Responsibilities:
 *   - Monitor token price & volume via priceService / on-chain data
 *   - Track X mentions of the token symbol
 *   - Report engagement metrics to Supervisor every 10 minutes
 *   - Auto-deactivate after configurable hours of zero volume (default: 24h)
 *
 * Lifecycle:
 *   1. Supervisor calls `spawnChild(config)` after a pump.fun launch
 *   2. Child registers in agent_registry with type 'token-child'
 *   3. Child sends periodic `report` messages to Supervisor
 *   4. Child self-deactivates when no volume for N hours
 *   5. Health Agent sees children in its monitoring via agent_heartbeats
 *
 * Communication:
 *   Outgoing → Supervisor:
 *     - report (low): Periodic metrics (price, volume, holders, mentions)
 *     - alert (high): Significant event (graduation, rug flag, price spike/crash)
 *     - status (medium): Deactivation notice
 *
 *   Incoming ← Supervisor:
 *     - command: force_deactivate, force_scan, get_metrics
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface TokenChildConfig {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;    // e.g., "MOONDOG" (without $)
  personality?: string;   // auto-generated based on token theme
  launchedAt: Date;
  autoDeactivateAfterHours: number;  // default: 24
  chatId?: string;        // TG group chat ID for this token
}

interface TokenMetrics {
  price: number;
  volume24h: number;
  holders: number;
  xMentions: number;
  mcap: number;
  lastUpdated: number;
}

// ============================================================================
// Token Child Agent
// ============================================================================

export class TokenChildAgent extends BaseAgent {
  private config: TokenChildConfig;
  private active = true;
  private metrics: TokenMetrics = { price: 0, volume24h: 0, holders: 0, xMentions: 0, mcap: 0, lastUpdated: 0 };
  private previousMetrics: TokenMetrics | null = null;
  private reportIntervalMs: number;
  private deactivationCheckMs: number;
  private zeroVolumeStreak = 0;

  constructor(pool: Pool, config: TokenChildConfig) {
    super({
      agentId: `child-${config.tokenSymbol.replace(/\$/g, '').toLowerCase()}`,
      agentType: 'community', // token-child shares community type for registry compat
      pool,
    });
    this.config = config;
    this.reportIntervalMs = 10 * 60 * 1000; // 10 minutes
    this.deactivationCheckMs = 60 * 60 * 1000; // 1 hour
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Report metrics periodically
    this.addInterval(() => this.gatherAndReport(), this.reportIntervalMs);

    // Check deactivation conditions
    this.addInterval(() => this.checkDeactivation(), this.deactivationCheckMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 15_000);

    // First report shortly after start
    setTimeout(() => this.gatherAndReport(), 30_000);

    logger.info(`[child:${this.config.tokenSymbol}] Started monitoring ${this.config.tokenAddress.slice(0, 8)}...`);
  }

  protected async onStop(): Promise<void> {
    this.active = false;
    // Notify supervisor of deactivation
    await this.reportToSupervisor('status', 'medium', {
      event: 'deactivated',
      tokenAddress: this.config.tokenAddress,
      tokenSymbol: this.config.tokenSymbol,
      reason: 'stopped',
      uptime: Date.now() - this.config.launchedAt.getTime(),
    });
  }

  // ── Metrics Gathering ────────────────────────────────────────────

  private async gatherAndReport(): Promise<void> {
    if (!this.active) return;

    try {
      await this.updateStatus('gathering');

      // Gather on-chain metrics
      const newMetrics = await this.fetchMetrics();
      this.previousMetrics = { ...this.metrics };
      this.metrics = newMetrics;

      // Check for significant events
      await this.detectEvents();

      // Report to supervisor
      await this.reportToSupervisor('report', 'low', {
        source: 'token_metrics',
        tokenAddress: this.config.tokenAddress,
        tokenSymbol: this.config.tokenSymbol,
        tokenName: this.config.tokenName,
        metrics: {
          price: this.metrics.price,
          volume24h: this.metrics.volume24h,
          holders: this.metrics.holders,
          mcap: this.metrics.mcap,
        },
        hoursSinceLaunch: (Date.now() - this.config.launchedAt.getTime()) / (3600 * 1000),
      });

      await this.updateStatus('alive');
    } catch (err) {
      logger.warn(`[child:${this.config.tokenSymbol}] Metrics gather failed:`, err);
    }
  }

  /**
   * Fetch token metrics.
   * Uses DexScreener public API (no auth needed) or falls back to price service.
   */
  private async fetchMetrics(): Promise<TokenMetrics> {
    try {
      // DexScreener public API — works for any Solana token
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${this.config.tokenAddress}`,
      );

      if (res.ok) {
        const data = await res.json() as any;
        const pair = data.pairs?.[0]; // Most liquid pair
        if (pair) {
          return {
            price: parseFloat(pair.priceUsd) || 0,
            volume24h: pair.volume?.h24 || 0,
            holders: pair.holders?.total || 0,
            xMentions: 0, // Would need X search — handled by Scout
            mcap: pair.marketCap || pair.fdv || 0,
            lastUpdated: Date.now(),
          };
        }
      }
    } catch {
      // Fallback — return zeros
    }

    return { ...this.metrics, lastUpdated: Date.now() };
  }

  // ── Event Detection ──────────────────────────────────────────────

  private async detectEvents(): Promise<void> {
    if (!this.previousMetrics || this.previousMetrics.lastUpdated === 0) return;

    const prev = this.previousMetrics;
    const curr = this.metrics;

    // Price spike > 100%
    if (prev.price > 0 && curr.price > prev.price * 2) {
      await this.reportToSupervisor('alert', 'high', {
        event: 'price_spike',
        tokenSymbol: this.config.tokenSymbol,
        tokenAddress: this.config.tokenAddress,
        previousPrice: prev.price,
        currentPrice: curr.price,
        changePercent: ((curr.price - prev.price) / prev.price * 100).toFixed(1),
      });
    }

    // Price crash > 50%
    if (prev.price > 0 && curr.price < prev.price * 0.5) {
      await this.reportToSupervisor('alert', 'high', {
        event: 'price_crash',
        tokenSymbol: this.config.tokenSymbol,
        tokenAddress: this.config.tokenAddress,
        previousPrice: prev.price,
        currentPrice: curr.price,
        changePercent: ((curr.price - prev.price) / prev.price * 100).toFixed(1),
      });
    }

    // Mcap milestone (first time crossing $100k, $500k, $1M)
    const milestones = [100_000, 500_000, 1_000_000, 5_000_000];
    for (const milestone of milestones) {
      if (prev.mcap < milestone && curr.mcap >= milestone) {
        await this.reportToSupervisor('alert', 'high', {
          event: 'mcap_milestone',
          tokenSymbol: this.config.tokenSymbol,
          tokenAddress: this.config.tokenAddress,
          milestone,
          currentMcap: curr.mcap,
        });
      }
    }

    // Volume tracking for deactivation
    if (curr.volume24h === 0) {
      this.zeroVolumeStreak++;
    } else {
      this.zeroVolumeStreak = 0;
    }
  }

  // ── Auto-Deactivation ───────────────────────────────────────────

  private async checkDeactivation(): Promise<void> {
    if (!this.active) return;

    const hoursSinceLaunch = (Date.now() - this.config.launchedAt.getTime()) / (3600 * 1000);

    // Only eligible for deactivation after the configured hours
    if (hoursSinceLaunch < this.config.autoDeactivateAfterHours) return;

    // Check if volume has been zero for the deactivation threshold
    // zeroVolumeStreak is incremented every reportIntervalMs (~10min)
    // autoDeactivateAfterHours worth of zero-volume checks
    const checksPerHour = 60 / (this.reportIntervalMs / 60000);
    const requiredZeroChecks = this.config.autoDeactivateAfterHours * checksPerHour;

    if (this.zeroVolumeStreak >= requiredZeroChecks) {
      logger.info(`[child:${this.config.tokenSymbol}] Auto-deactivating — zero volume for ${this.config.autoDeactivateAfterHours}h`);
      await this.reportToSupervisor('status', 'medium', {
        event: 'auto_deactivated',
        tokenSymbol: this.config.tokenSymbol,
        tokenAddress: this.config.tokenAddress,
        hoursSinceLaunch,
        zeroVolumeStreak: this.zeroVolumeStreak,
        reason: `No volume for ${this.config.autoDeactivateAfterHours}h`,
      });
      await this.stop();
    }
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command') {
          switch (msg.payload?.action) {
            case 'force_deactivate':
              logger.info(`[child:${this.config.tokenSymbol}] Force deactivation by supervisor`);
              await this.stop();
              break;
            case 'force_scan':
              await this.gatherAndReport();
              break;
            case 'get_metrics':
              await this.reportToSupervisor('report', 'medium', {
                source: 'metrics_on_demand',
                tokenAddress: this.config.tokenAddress,
                tokenSymbol: this.config.tokenSymbol,
                metrics: this.metrics,
                zeroVolumeStreak: this.zeroVolumeStreak,
                hoursSinceLaunch: (Date.now() - this.config.launchedAt.getTime()) / (3600 * 1000),
              });
              break;
          }
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      tokenSymbol: this.config.tokenSymbol,
      tokenAddress: this.config.tokenAddress,
      metrics: this.metrics,
      zeroVolumeStreak: this.zeroVolumeStreak,
      hoursSinceLaunch: (Date.now() - this.config.launchedAt.getTime()) / (3600 * 1000),
      autoDeactivateAfterHours: this.config.autoDeactivateAfterHours,
    };
  }

  getTokenAddress(): string {
    return this.config.tokenAddress;
  }

  getTokenSymbol(): string {
    return this.config.tokenSymbol;
  }
}
