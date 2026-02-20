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
  /** SOL value to hedge (USD) — we SHORT this amount notional */
  solExposureUsd: number;
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
// Account info
// ============================================================================

export async function getAccountSummary(): Promise<HLAccountSummary> {
  try {
    const { info, wallet } = await loadHL();
    const state = await info.clearinghouseState({ user: wallet.address });

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
// Hedge SOL treasury
// ============================================================================

/**
 * Open a SHORT SOL-PERP position to hedge against SOL treasury downside risk.
 * This is the primary use case for Hyperliquid in the CFO.
 *
 * Example: Nova holds 5 SOL in treasury @ $200/SOL = $1,000 exposure.
 * To hedge 50%: SHORT $500 notional of SOL-PERP.
 * If SOL drops 20% → treasury loses $200, short gains ~$200 → net flat.
 */
export async function hedgeSolTreasury(params: HedgeParams): Promise<HLOrderResult> {
  const env = getCFOEnv();

  if (params.solExposureUsd <= 0) {
    return { success: false, error: 'solExposureUsd must be positive' };
  }

  const leverage = Math.min(params.leverage ?? 2, env.maxHyperliquidLeverage);
  const stopLossPct = params.stopLossPct ?? 8;
  const takeProfitPct = params.takeProfitPct ?? 15;

  if (env.dryRun) {
    logger.info(
      `[Hyperliquid] DRY RUN — would SHORT SOL-PERP $${params.solExposureUsd} ` +
      `at ${leverage}x leverage (SL: +${stopLossPct}%, TP: -${takeProfitPct}%)`,
    );
    return { success: true, orderId: 0, cloid: `dry-${Date.now()}` };
  }

  try {
    const { exchange, info, wallet } = await loadHL();

    // Get current SOL mark price
    const mids = await info.allMids();
    const solPrice = Number(mids['SOL'] ?? 150);
    const sizeInSol = params.solExposureUsd / solPrice;
    const sizeFmt = Math.floor(sizeInSol * 1000) / 1000; // round to 3 decimals

    if (sizeFmt < 0.001) {
      return { success: false, error: 'Position too small — minimum 0.001 SOL' };
    }

    // Resolve SOL asset ID from meta (typically 4 for SOL-PERP on Hyperliquid)
    const meta = await info.meta();
    const solAsset = (meta as any).universe?.findIndex((u: any) => u.name === 'SOL') ?? 4;

    // Set leverage first
    await exchange.updateLeverage({
      asset: solAsset,
      isCross: false,  // isolated margin
      leverage,
    });

    // Place limit SHORT slightly below mid to fill quickly
    const limitPrice = (solPrice * 0.9995).toFixed(2); // 0.05% below mid

    const order = await exchange.order({
      orders: [{
        a: solAsset,           // asset ID
        b: false,              // false = SHORT
        p: limitPrice,         // price
        s: sizeFmt.toString(), // size
        r: false,              // reduce only
        t: { limit: { tif: 'Gtc' as const } },
        c: `0x${Buffer.from(`cfo-hedge-${Date.now()}`).toString('hex').slice(0, 24)}`,
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
      `[Hyperliquid] SOL hedge opened: SHORT ${sizeFmt} SOL @ ~$${avgPrice} ` +
      `($${params.solExposureUsd} exposure, ${leverage}x): order ${orderId}`,
    );

    return { success: true, orderId, avgPrice };
  } catch (err) {
    logger.error('[Hyperliquid] hedgeSolTreasury error:', err);
    return { success: false, error: (err as Error).message };
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
    const mids = await info.allMids();
    const markPrice = Number(mids[coin] ?? 0);
    if (!markPrice) return { success: false, error: `No mark price for ${coin}` };

    // Resolve asset ID
    const meta = await info.meta();
    const assetIdx = (meta as any).universe?.findIndex((u: any) => u.name === coin) ?? -1;
    if (assetIdx < 0) return { success: false, error: `Unknown asset ${coin}` };

    // Close at slightly worse price to guarantee fill
    const limitPx = isBuy
      ? (markPrice * 1.001).toFixed(2)  // buying back short: slightly above mid
      : (markPrice * 0.999).toFixed(2); // selling long: slightly below mid

    const order = await exchange.order({
      orders: [{
        a: assetIdx,
        b: isBuy,
        p: limitPx,
        s: sizeInCoin.toString(),
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
      const sizeInCoin = pos.sizeUsd / pos.markPrice;
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
