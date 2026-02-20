/**
 * Position Manager
 *
 * Single source of truth for CFO position lifecycle.
 *
 * State machine:
 *   OPEN → PARTIAL_EXIT → CLOSED
 *       ↓                    ↑
 *   STOP_HIT ────────────────┘
 *       ↓
 *   EXPIRED (market resolved with no action)
 *
 * Responsibilities:
 *  - Track total exposure per strategy (enforce caps from CFO architecture doc)
 *  - Apply stop-loss rules automatically
 *  - Price-update positions on each monitor cycle
 *  - Emit messages to CFO agent when action is needed
 */

import { logger } from '@elizaos/core';
import type { PostgresCFORepository, CFOPosition, PositionStrategy } from './postgresCFORepository.ts';
import type { PolyPosition } from './polymarketService.ts';
import type { HLPosition } from './hyperliquidService.ts';

// ============================================================================
// Strategy caps (from architecture doc)
// ============================================================================

export const STRATEGY_CAPS: Record<PositionStrategy, { maxPortfolioFraction: number; leverage: number }> = {
  polymarket:    { maxPortfolioFraction: 0.15, leverage: 1 },   // 15% of portfolio
  hyperliquid:   { maxPortfolioFraction: 0.20, leverage: 5 },   // 20%, max 5x
  kamino:        { maxPortfolioFraction: 0.30, leverage: 1 },   // 30%
  jito:          { maxPortfolioFraction: 0.25, leverage: 1 },   // 25%
  jupiter_swap:  { maxPortfolioFraction: 0.10, leverage: 1 },   // 10%
};

// ============================================================================
// Types
// ============================================================================

export interface PositionAction {
  positionId: string;
  action: 'STOP_LOSS' | 'TAKE_PROFIT' | 'EXPIRE' | 'UPDATE_PRICE';
  reason: string;
  urgency: 'critical' | 'high' | 'medium' | 'low';
}

export interface ExposureCheck {
  allowed: boolean;
  currentExposureUsd: number;
  capUsd: number;
  headroomUsd: number;
  reason?: string;
}

// ============================================================================
// Position Manager
// ============================================================================

export class PositionManager {
  private repo: PostgresCFORepository;

  constructor(repo: PostgresCFORepository) {
    this.repo = repo;
  }

  // ── Exposure Gating ───────────────────────────────────────────────

  /**
   * Check if a new position of given size fits within strategy cap.
   * totalPortfolioUsd is the current total value across all CFO wallets.
   */
  async checkExposure(
    strategy: PositionStrategy,
    newPositionUsd: number,
    totalPortfolioUsd: number,
  ): Promise<ExposureCheck> {
    const cap = STRATEGY_CAPS[strategy];
    const capUsd = cap.maxPortfolioFraction * totalPortfolioUsd;

    const openPositions = await this.repo.getOpenPositions(strategy);
    const currentExposureUsd = openPositions.reduce((s, p) => s + p.currentValueUsd, 0);
    const headroomUsd = capUsd - currentExposureUsd;

    if (newPositionUsd > headroomUsd) {
      return {
        allowed: false,
        currentExposureUsd,
        capUsd,
        headroomUsd: Math.max(0, headroomUsd),
        reason:
          `${strategy} cap: current $${currentExposureUsd.toFixed(2)} + new $${newPositionUsd.toFixed(2)} ` +
          `exceeds cap $${capUsd.toFixed(2)}`,
      };
    }

    return {
      allowed: true,
      currentExposureUsd,
      capUsd,
      headroomUsd,
    };
  }

  // ── Position Creation ─────────────────────────────────────────────

  /**
   * Open a new Polymarket position and persist it.
   */
  async openPolymarketPosition(params: {
    conditionId: string;
    question: string;
    tokenId: string;
    outcome: 'Yes' | 'No';
    orderId: string;
    sizeUsd: number;
    entryPrice: number;
    txHash?: string;
  }): Promise<CFOPosition> {
    const now = new Date().toISOString();
    const id = `poly-${params.conditionId.slice(0, 12)}-${Date.now()}`;

    const pos: CFOPosition = {
      id,
      strategy: 'polymarket',
      asset: params.tokenId,
      description: `${params.outcome} | ${params.question.slice(0, 80)}`,
      chain: 'polygon',
      status: 'OPEN',
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      sizeUnits: params.sizeUsd / params.entryPrice,
      costBasisUsd: params.sizeUsd,
      currentValueUsd: params.sizeUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      entryTxHash: params.txHash,
      externalId: params.orderId,
      metadata: {
        conditionId: params.conditionId,
        tokenId: params.tokenId,
        outcome: params.outcome,
      },
      openedAt: now,
      updatedAt: now,
    };

    await this.repo.upsertPosition(pos);
    logger.info(`[PositionManager] Opened ${id}: ${params.outcome} "${params.question.slice(0, 50)}" $${params.sizeUsd}`);
    return pos;
  }

  // ── Price Updates ─────────────────────────────────────────────────

  /**
   * Update all open Polymarket positions with fresh prices.
   * Returns list of actions needed (stop-loss hits, expiries).
   */
  async updatePolymarketPrices(freshPositions: PolyPosition[]): Promise<PositionAction[]> {
    const openPositions = await this.repo.getOpenPositions('polymarket');
    const actions: PositionAction[] = [];

    for (const dbPos of openPositions) {
      const meta = dbPos.metadata as { tokenId?: string; conditionId?: string };
      const fresh = freshPositions.find((p) => p.tokenId === meta.tokenId);

      if (!fresh) {
        // Position no longer appears in Polymarket — may be resolved
        actions.push({
          positionId: dbPos.id,
          action: 'EXPIRE',
          reason: 'Position not found in current Polymarket data — market may have resolved',
          urgency: 'high',
        });
        continue;
      }

      // Update price
      await this.repo.updatePositionPrice(dbPos.id, fresh.currentPrice, fresh.currentValueUsd);

      // Check stop-loss: close if position lost >60% of value
      const lossPct = (dbPos.costBasisUsd - fresh.currentValueUsd) / dbPos.costBasisUsd;
      if (lossPct > 0.60) {
        actions.push({
          positionId: dbPos.id,
          action: 'STOP_LOSS',
          reason: `Position down ${(lossPct * 100).toFixed(1)}% — exceeds 60% stop-loss`,
          urgency: 'critical',
        });
        continue;
      }

      // Check time decay: if market resolves within 24h and we're losing, consider exit
      const meta2 = dbPos.metadata as { endDate?: string };
      // (endDate would be stored in metadata if available)
    }

    return actions;
  }

  // ── Hyperliquid Positions ─────────────────────────────────────────

  /**
   * Open a new Hyperliquid hedge position and persist it.
   */
  async openHyperliquidPosition(params: {
    coin: string;
    side: 'LONG' | 'SHORT';
    sizeUsd: number;
    entryPrice: number;
    leverage: number;
    orderId?: number;
    txHash?: string;
  }): Promise<CFOPosition> {
    const now = new Date().toISOString();
    const id = `hl-${params.coin.toLowerCase()}-${Date.now()}`;

    const pos: CFOPosition = {
      id,
      strategy: 'hyperliquid',
      asset: `${params.coin}-PERP`,
      description: `${params.side} ${params.coin} ${params.leverage}x`,
      chain: 'arbitrum',
      status: 'OPEN',
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      sizeUnits: params.sizeUsd / params.entryPrice,
      costBasisUsd: params.sizeUsd / params.leverage, // margin used
      currentValueUsd: params.sizeUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      entryTxHash: params.txHash,
      externalId: params.orderId?.toString(),
      metadata: { coin: params.coin, side: params.side, leverage: params.leverage },
      openedAt: now,
      updatedAt: now,
    };

    await this.repo.upsertPosition(pos);
    logger.info(`[PositionManager] Opened ${id}: ${params.side} ${params.coin} $${params.sizeUsd} @ ${params.leverage}x`);
    return pos;
  }

  /**
   * Update all open Hyperliquid positions with fresh data from the exchange.
   * Returns actions for positions approaching liquidation.
   */
  async updateHyperliquidPrices(livePositions: HLPosition[]): Promise<PositionAction[]> {
    const openPositions = await this.repo.getOpenPositions('hyperliquid');
    const actions: PositionAction[] = [];

    for (const dbPos of openPositions) {
      const meta = dbPos.metadata as { coin?: string };
      const live = livePositions.find((p) => p.coin === meta.coin);

      if (!live) {
        // Position no longer open on exchange — was likely liquidated or closed externally
        actions.push({
          positionId: dbPos.id,
          action: 'EXPIRE',
          reason: `HL position for ${meta.coin} not found on exchange — may have been liquidated`,
          urgency: 'critical',
        });
        continue;
      }

      const currentValueUsd = live.sizeUsd;
      await this.repo.updatePositionPrice(dbPos.id, live.markPrice, currentValueUsd);

      // Check liquidation proximity (within 20% of liq price)
      if (live.liquidationPrice > 0) {
        const distancePct = Math.abs(live.markPrice - live.liquidationPrice) / live.markPrice;
        if (distancePct < 0.20) {
          actions.push({
            positionId: dbPos.id,
            action: 'STOP_LOSS',
            reason: `${live.coin} within ${(distancePct * 100).toFixed(1)}% of liquidation`,
            urgency: 'critical',
          });
        }
      }
    }

    return actions;
  }

  // ── Kamino Position Tracking ──────────────────────────────────────

  /**
   * Sync Kamino lending position from on-chain data into DB tracker.
   */
  async syncKaminoPosition(params: {
    deposits: Array<{ asset: string; amount: number; valueUsd: number; apy: number }>;
    healthFactor: number;
  }): Promise<void> {
    for (const dep of params.deposits) {
      const id = `kamino-${dep.asset.toLowerCase()}-deposit`;
      const pos: CFOPosition = {
        id,
        strategy: 'kamino',
        asset: dep.asset,
        description: `Kamino ${dep.asset} deposit (${(dep.apy * 100).toFixed(1)}% APY)`,
        chain: 'solana',
        status: 'OPEN',
        entryPrice: 1, // lending, not a trade
        currentPrice: 1,
        sizeUnits: dep.amount,
        costBasisUsd: dep.valueUsd,
        currentValueUsd: dep.valueUsd,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        metadata: { apy: dep.apy, healthFactor: params.healthFactor },
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.repo.upsertPosition(pos);
    }
  }

  // ── Close Positions ───────────────────────────────────────────────

  /**
   * Mark a position as closed after a sell order is confirmed.
   */
  async closePosition(
    positionId: string,
    exitPrice: number,
    exitTxHash: string,
    receivedUsd: number,
  ): Promise<void> {
    const pos = await this.repo.getPosition(positionId);
    if (!pos) {
      logger.warn(`[PositionManager] closePosition: ${positionId} not found`);
      return;
    }

    const realizedPnl = receivedUsd - pos.costBasisUsd;

    await this.repo.closePosition(positionId, exitTxHash, realizedPnl);

    logger.info(
      `[PositionManager] Closed ${positionId}: PnL ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)} ` +
      `(${pos.costBasisUsd.toFixed(2)} in → ${receivedUsd.toFixed(2)} out)`,
    );
  }

  // ── Portfolio Snapshot ────────────────────────────────────────────

  /**
   * Aggregate portfolio metrics across all open positions.
   */
  async getPortfolioMetrics(): Promise<{
    byStrategy: Record<string, { openPositions: number; totalValueUsd: number; unrealizedPnlUsd: number }>;
    totalOpenPositions: number;
    totalValueUsd: number;
    totalUnrealizedPnlUsd: number;
    totalRealizedPnlUsd: number;
  }> {
    const [openPositions, realizedPnl] = await Promise.all([
      this.repo.getOpenPositions(),
      this.repo.getTotalRealizedPnl(),
    ]);

    const byStrategy: Record<string, { openPositions: number; totalValueUsd: number; unrealizedPnlUsd: number }> = {};

    let totalValueUsd = 0;
    let totalUnrealizedPnlUsd = 0;

    for (const pos of openPositions) {
      if (!byStrategy[pos.strategy]) {
        byStrategy[pos.strategy] = { openPositions: 0, totalValueUsd: 0, unrealizedPnlUsd: 0 };
      }
      byStrategy[pos.strategy].openPositions++;
      byStrategy[pos.strategy].totalValueUsd += pos.currentValueUsd;
      byStrategy[pos.strategy].unrealizedPnlUsd += pos.unrealizedPnlUsd;
      totalValueUsd += pos.currentValueUsd;
      totalUnrealizedPnlUsd += pos.unrealizedPnlUsd;
    }

    return {
      byStrategy,
      totalOpenPositions: openPositions.length,
      totalValueUsd,
      totalUnrealizedPnlUsd,
      totalRealizedPnlUsd: realizedPnl,
    };
  }
}
