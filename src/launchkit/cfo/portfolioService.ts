/**
 * Portfolio Service
 *
 * Unified cross-chain portfolio snapshot for the CFO agent.
 * Aggregates balances and positions from every active strategy into
 * a single consistent view.
 *
 * Sources aggregated:
 *  Solana wallet   — SOL + USDC + JitoSOL balances
 *  Kamino          — deposited USDC + SOL earning yield
 *  Jito staking    — JitoSOL liquid staking position
 *  Jupiter USDC    — idle USDC in funding wallet
 *  Polygon wallet  — USDC for Polymarket
 *  Polymarket      — open prediction market positions
 *  Hyperliquid     — perp account equity
 *  DB positions    — all open positions from PostgresCFORepository
 *
 * Called by:
 *  - CFO daily digest
 *  - /cfo status Telegram command
 *  - Supervisor health check
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Types
// ============================================================================

export interface ChainBalance {
  chain: 'solana' | 'polygon' | 'arbitrum';
  native: number;         // SOL / MATIC / ETH
  nativeSymbol: string;
  nativeUsd: number;
  usdc: number;
  usdcUsd: number;
  other: Array<{ symbol: string; amount: number; valueUsd: number }>;
  totalUsd: number;
}

export interface StrategyAllocation {
  name: string;
  chain: string;
  valueUsd: number;
  unrealizedPnlUsd: number;
  allocationPct: number;    // % of total portfolio
  status: 'active' | 'idle' | 'error';
  details?: string;
}

export interface PortfolioSnapshot {
  timestamp: string;

  // Per-chain wallet balances
  chains: ChainBalance[];

  // Per-strategy deployed capital
  strategies: StrategyAllocation[];

  // Aggregate totals
  totalWalletUsd: number;         // uninvested balances
  totalDeployedUsd: number;       // capital in positions
  totalPortfolioUsd: number;      // wallet + deployed
  totalUnrealizedPnlUsd: number;  // open position PnL
  totalRealizedPnlUsd: number;    // closed position PnL

  // Risk metrics
  cashReservePct: number;         // % of portfolio in uninvested wallet
  largestStrategyPct: number;     // concentration risk

  // Oracle prices used (from Pyth)
  prices: Record<string, number>;

  errors: string[];               // non-fatal data fetch errors
}

// ============================================================================
// Lazy service loaders
// ============================================================================

let _pyth:    any = null;
let _jupiter: any = null;
let _evm:     any = null;
let _poly:    any = null;
let _hl:      any = null;
let _kamino:  any = null;
let _jito:    any = null;

const services = {
  pyth:    async () => _pyth    ??= await import('./pythOracleService.ts'),
  jupiter: async () => _jupiter ??= await import('./jupiterService.ts'),
  evm:     async () => _evm     ??= await import('./evmWalletService.ts'),
  poly:    async () => _poly    ??= await import('./polymarketService.ts'),
  hl:      async () => _hl      ??= await import('./hyperliquidService.ts'),
  kamino:  async () => _kamino  ??= await import('./kaminoService.ts'),
  jito:    async () => _jito    ??= await import('./jitoStakingService.ts'),
};

// ============================================================================
// Chain balance aggregation
// ============================================================================

async function getSolanaBalance(
  prices: Record<string, number>,
  errors: string[],
): Promise<ChainBalance> {
  const result: ChainBalance = {
    chain: 'solana',
    native: 0,
    nativeSymbol: 'SOL',
    nativeUsd: 0,
    usdc: 0,
    usdcUsd: 0,
    other: [],
    totalUsd: 0,
  };

  try {
    const jupMod = await services.jupiter();
    const [solBal, usdcBal] = await Promise.all([
      jupMod.getTokenBalance(jupMod.MINTS.SOL),
      jupMod.getTokenBalance(jupMod.MINTS.USDC),
    ]);
    result.native = solBal;
    result.nativeUsd = solBal * (prices['SOL'] ?? 0);
    result.usdc = usdcBal;
    result.usdcUsd = usdcBal;

    // Check JitoSOL balance
    const env = getCFOEnv();
    if (env.jitoEnabled) {
      try {
        const jitoMod = await services.jito();
        const jitoSolBal = await jupMod.getTokenBalance(jitoMod.JITOSOL_MINT);
        if (jitoSolBal > 0) {
          const jitoSolPrice = (prices['SOL'] ?? 0) * 1.05; // JitoSOL trades at ~5% premium
          result.other.push({
            symbol: 'JitoSOL',
            amount: jitoSolBal,
            valueUsd: jitoSolBal * jitoSolPrice,
          });
        }
      } catch { /* non-fatal */ }
    }

    result.totalUsd = result.nativeUsd + result.usdcUsd + result.other.reduce((s, t) => s + t.valueUsd, 0);
  } catch (err) {
    errors.push(`Solana balance: ${(err as Error).message}`);
  }

  return result;
}

async function getPolygonBalance(
  errors: string[],
): Promise<ChainBalance> {
  const result: ChainBalance = {
    chain: 'polygon',
    native: 0,
    nativeSymbol: 'MATIC',
    nativeUsd: 0,
    usdc: 0,
    usdcUsd: 0,
    other: [],
    totalUsd: 0,
  };

  const env = getCFOEnv();
  if (!env.polymarketEnabled) return result;

  try {
    const evmMod = await services.evm();
    const status = await evmMod.getWalletStatus();
    result.native = status.maticBalance;

    // Fetch MATIC/USD from Pyth instead of hardcoded price
    const pythMod = await services.pyth();
    const maticPrice = await pythMod.getPrice('MATIC/USD');
    const maticUsd = maticPrice?.price ?? 0; // 0 if oracle unavailable, not hardcoded
    if (!maticPrice) errors.push('MATIC/USD oracle unavailable');

    result.nativeUsd = status.maticBalance * maticUsd;
    result.usdc = status.usdcBalance;
    result.usdcUsd = status.usdcBalance;
    result.totalUsd = result.nativeUsd + result.usdcUsd;
  } catch (err) {
    errors.push(`Polygon balance: ${(err as Error).message}`);
  }

  return result;
}

// ============================================================================
// Strategy allocation breakdown
// ============================================================================

async function getStrategyAllocations(
  prices: Record<string, number>,
  errors: string[],
): Promise<StrategyAllocation[]> {
  const env = getCFOEnv();
  const allocations: StrategyAllocation[] = [];

  // ── Kamino lending ────────────────────────────────────────────────
  if (env.kaminoEnabled) {
    try {
      const kaminoMod = await services.kamino();
      const pos = await kaminoMod.getPosition();
      const totalDeposited = pos.deposits.reduce((s: number, d: any) => s + d.valueUsd, 0);
      if (totalDeposited > 0) {
        allocations.push({
          name: 'Kamino Lending',
          chain: 'solana',
          valueUsd: totalDeposited,
          unrealizedPnlUsd: 0, // accrued interest reflected in balance
          allocationPct: 0,
          status: pos.healthFactor > 1.5 ? 'active' : 'error',
          details: `health ${pos.healthFactor.toFixed(2)} | ${pos.deposits.length} deposits`,
        });
      }
    } catch (err) {
      errors.push(`Kamino: ${(err as Error).message}`);
    }
  }

  // ── Jito staking ──────────────────────────────────────────────────
  if (env.jitoEnabled) {
    try {
      const jitoMod = await services.jito();
      const solPrice = prices['SOL'] ?? 0;
      if (solPrice > 0) {
        const pos = await jitoMod.getStakePosition(solPrice);
        if (pos.jitoSolBalance > 0) {
          allocations.push({
            name: 'Jito Staking',
            chain: 'solana',
            valueUsd: pos.jitoSolValueUsd,
            unrealizedPnlUsd: 0,
            allocationPct: 0,
            status: 'active',
            details: `${pos.jitoSolBalance.toFixed(4)} JitoSOL | ${pos.apy.toFixed(1)}% APY`,
          });
        }
      }
    } catch (err) {
      errors.push(`Jito: ${(err as Error).message}`);
    }
  }

  // ── Polymarket ────────────────────────────────────────────────────
  if (env.polymarketEnabled) {
    try {
      const polyMod = await services.poly();
      const summary = await polyMod.getPortfolioSummary();
      if (summary.totalDeployedUsd > 0 || summary.openPositions > 0) {
        allocations.push({
          name: 'Polymarket',
          chain: 'polygon',
          valueUsd: summary.totalDeployedUsd,
          unrealizedPnlUsd: summary.unrealizedPnlUsd,
          allocationPct: 0,
          status: 'active',
          details: `${summary.openPositions} positions | PnL ${summary.unrealizedPnlUsd >= 0 ? '+' : ''}$${summary.unrealizedPnlUsd.toFixed(2)}`,
        });
      }
    } catch (err) {
      errors.push(`Polymarket: ${(err as Error).message}`);
    }
  }

  // ── Hyperliquid ───────────────────────────────────────────────────
  if (env.hyperliquidEnabled) {
    try {
      const hlMod = await services.hl();
      const summary = await hlMod.getAccountSummary();
      if (summary.equity > 0) {
        allocations.push({
          name: 'Hyperliquid Perps',
          chain: 'arbitrum',
          valueUsd: summary.equity,
          unrealizedPnlUsd: summary.totalPnl,
          allocationPct: 0,
          status: summary.positions.length > 0 ? 'active' : 'idle',
          details: `equity $${summary.equity.toFixed(2)} | ${summary.positions.length} pos | PnL ${summary.totalPnl >= 0 ? '+' : ''}$${summary.totalPnl.toFixed(2)}`,
        });
      }
    } catch (err) {
      errors.push(`Hyperliquid: ${(err as Error).message}`);
    }
  }

  return allocations;
}

// ============================================================================
// Main snapshot function
// ============================================================================

/**
 * Build a complete cross-chain portfolio snapshot.
 * All fetches run in parallel where possible; errors are collected
 * non-fatally so a single failing service doesn't break the whole snapshot.
 */
export async function getPortfolioSnapshot(repo?: any): Promise<PortfolioSnapshot> {
  const errors: string[] = [];

  // ── Fetch prices first (needed for USD conversions) ────────────────
  let prices: Record<string, number> = { SOL: 0, ETH: 0, BTC: 0 };
  try {
    const pythMod = await services.pyth();
    const priceMap = await pythMod.getPrices(['SOL/USD', 'ETH/USD', 'BTC/USD']);
    prices = {
      SOL: priceMap.get('SOL/USD')?.price ?? 0,
      ETH: priceMap.get('ETH/USD')?.price ?? 0,
      BTC: priceMap.get('BTC/USD')?.price ?? 0,
    };
  } catch (err) {
    errors.push(`Pyth prices: ${(err as Error).message}`);
  }

  // ── Fetch all data in parallel ─────────────────────────────────────
  const [solChain, polygonChain, strategies] = await Promise.all([
    getSolanaBalance(prices, errors),
    getPolygonBalance(errors),
    getStrategyAllocations(prices, errors),
  ]);

  // ── DB positions (if repo available) ──────────────────────────────
  let totalRealizedPnlUsd = 0;
  if (repo) {
    try {
      totalRealizedPnlUsd = await repo.getTotalRealizedPnl();
    } catch { /* non-fatal */ }
  }

  // ── Compute totals ─────────────────────────────────────────────────
  const chains = [solChain, polygonChain];
  const totalWalletUsd = chains.reduce((s, c) => s + c.totalUsd, 0);
  const totalDeployedUsd = strategies.reduce((s, a) => s + a.valueUsd, 0);
  const totalPortfolioUsd = totalWalletUsd + totalDeployedUsd;
  const totalUnrealizedPnlUsd = strategies.reduce((s, a) => s + a.unrealizedPnlUsd, 0);

  // Fill in allocation percentages
  for (const strat of strategies) {
    strat.allocationPct = totalPortfolioUsd > 0
      ? (strat.valueUsd / totalPortfolioUsd) * 100
      : 0;
  }

  const cashReservePct = totalPortfolioUsd > 0 ? (totalWalletUsd / totalPortfolioUsd) * 100 : 100;
  const largestStrategyPct = strategies.length > 0
    ? Math.max(...strategies.map((s) => s.allocationPct))
    : 0;

  return {
    timestamp: new Date().toISOString(),
    chains,
    strategies,
    totalWalletUsd,
    totalDeployedUsd,
    totalPortfolioUsd,
    totalUnrealizedPnlUsd,
    totalRealizedPnlUsd,
    cashReservePct,
    largestStrategyPct,
    prices,
    errors,
  };
}

// ============================================================================
// Formatted summary for Telegram
// ============================================================================

/**
 * Format a portfolio snapshot into a Telegram-friendly message.
 */
export function formatPortfolioMessage(snap: PortfolioSnapshot): string {
  const lines: string[] = [
    `🏦 *Portfolio Snapshot*`,
    `_${new Date(snap.timestamp).toUTCString()}_\n`,
    `*Total: $${snap.totalPortfolioUsd.toFixed(2)}*`,
    `  Deployed: $${snap.totalDeployedUsd.toFixed(2)}`,
    `  Wallet:   $${snap.totalWalletUsd.toFixed(2)}`,
    `  PnL (open): ${snap.totalUnrealizedPnlUsd >= 0 ? '+' : ''}$${snap.totalUnrealizedPnlUsd.toFixed(2)}`,
    `  PnL (closed): ${snap.totalRealizedPnlUsd >= 0 ? '+' : ''}$${snap.totalRealizedPnlUsd.toFixed(2)}`,
  ];

  // Prices
  if (snap.prices.SOL > 0) {
    lines.push(`\n*Prices:* SOL $${snap.prices.SOL.toFixed(2)} | ETH $${snap.prices.ETH.toFixed(0)} | BTC $${snap.prices.BTC.toFixed(0)}`);
  }

  // Chain balances
  lines.push('\n*Wallets:*');
  for (const c of snap.chains) {
    if (c.totalUsd < 0.01) continue;
    const parts = [];
    if (c.usdc > 0) parts.push(`$${c.usdc.toFixed(2)} USDC`);
    if (c.native > 0.001) parts.push(`${c.native.toFixed(3)} ${c.nativeSymbol}`);
    for (const other of c.other) parts.push(`${other.amount.toFixed(4)} ${other.symbol}`);
    lines.push(`  ${c.chain.charAt(0).toUpperCase() + c.chain.slice(1)}: ${parts.join(' | ')} = $${c.totalUsd.toFixed(2)}`);
  }

  // Strategy allocations
  if (snap.strategies.length > 0) {
    lines.push('\n*Strategies:*');
    for (const s of snap.strategies.sort((a, b) => b.valueUsd - a.valueUsd)) {
      const pnlStr = s.unrealizedPnlUsd !== 0
        ? ` PnL ${s.unrealizedPnlUsd >= 0 ? '+' : ''}$${s.unrealizedPnlUsd.toFixed(2)}`
        : '';
      lines.push(`  ${s.name}: $${s.valueUsd.toFixed(2)} (${s.allocationPct.toFixed(1)}%)${pnlStr}`);
      if (s.details) lines.push(`    _${s.details}_`);
    }
  }

  // Risk warnings
  if (snap.cashReservePct < 10) {
    lines.push(`\n⚠️ *Cash reserve low: ${snap.cashReservePct.toFixed(1)}%*`);
  }
  if (snap.largestStrategyPct > 40) {
    lines.push(`⚠️ *Concentration: largest strategy ${snap.largestStrategyPct.toFixed(1)}% of portfolio*`);
  }

  if (snap.errors.length > 0) {
    lines.push(`\n_${snap.errors.length} data error(s): ${snap.errors[0]}_`);
  }

  return lines.join('\n');
}

// ============================================================================
// Rebalance suggestions
// ============================================================================

/**
 * Analyse the current portfolio and suggest rebalancing actions.
 * Called by CFO agent on the hourly scan cycle.
 */
export function analyseRebalance(snap: PortfolioSnapshot): Array<{
  priority: 'high' | 'medium' | 'low';
  action: string;
  reason: string;
}> {
  const env = getCFOEnv();
  const suggestions: Array<{ priority: 'high' | 'medium' | 'low'; action: string; reason: string }> = [];

  const total = snap.totalPortfolioUsd;
  if (total < 1) return suggestions;

  // Cash too low for safe operations
  if (snap.cashReservePct < 10) {
    suggestions.push({
      priority: 'high',
      action: 'Reduce deployed capital or add funds',
      reason: `Cash reserve ${snap.cashReservePct.toFixed(1)}% < 10% minimum`,
    });
  }

  // Idle USDC on Solana could be earning in Kamino
  const solChain = snap.chains.find((c) => c.chain === 'solana');
  if (solChain && solChain.usdc > 100 && env.kaminoEnabled) {
    const kaminoAlloc = snap.strategies.find((s) => s.name === 'Kamino Lending');
    if (!kaminoAlloc || kaminoAlloc.valueUsd < solChain.usdc * 0.5) {
      suggestions.push({
        priority: 'medium',
        action: `Deposit $${(solChain.usdc * 0.5).toFixed(0)} USDC into Kamino`,
        reason: `$${solChain.usdc.toFixed(0)} idle USDC earning 0% when Kamino offers ~8-12% APY`,
      });
    }
  }

  // Idle SOL could be staked in Jito
  if (solChain && solChain.native > 2 && env.jitoEnabled) {
    const jitoAlloc = snap.strategies.find((s) => s.name === 'Jito Staking');
    const jitoValueSol = (jitoAlloc?.valueUsd ?? 0) / (snap.prices['SOL'] ?? 1);
    if (solChain.native > jitoValueSol * 2) {
      suggestions.push({
        priority: 'low',
        action: `Stake ${(solChain.native * 0.5).toFixed(2)} SOL via Jito`,
        reason: `${solChain.native.toFixed(2)} SOL idle when Jito offers ~7% APY via MEV rewards`,
      });
    }
  }

  // Polymarket underfunded (USDC on Polygon low but Polymarket cap not reached)
  const polygonChain = snap.chains.find((c) => c.chain === 'polygon');
  if (polygonChain && env.polymarketEnabled) {
    const polyDeployed = snap.strategies.find((s) => s.name === 'Polymarket')?.valueUsd ?? 0;
    if (polygonChain.usdc < 20 && polyDeployed < env.maxPolymarketUsd * 0.5) {
      suggestions.push({
        priority: 'medium',
        action: `Bridge $100 USDC Solana → Polygon`,
        reason: `Polymarket wallet low ($${polygonChain.usdc.toFixed(2)} USDC) with ${((1 - polyDeployed / env.maxPolymarketUsd) * 100).toFixed(0)}% capacity unused`,
      });
    }
  }

  // Concentration risk
  if (snap.largestStrategyPct > 35) {
    suggestions.push({
      priority: 'low',
      action: 'Diversify — single strategy over 35% of portfolio',
      reason: `${snap.strategies.find((s) => s.allocationPct === snap.largestStrategyPct)?.name ?? 'unknown'} at ${snap.largestStrategyPct.toFixed(1)}%`,
    });
  }

  return suggestions;
}
