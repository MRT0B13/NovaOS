/**
 * reinvestmentEngine.ts — Profit Reinvestment Engine
 *
 * Routes claimed LP fees and harvested profits to the optimal yield destination.
 * Market-condition-aware: in 'danger' mode, profits are held as stables rather
 * than redeployed into risk positions.
 *
 * Yield ranking considers: Jito staking, Kamino supply, Orca LP, EVM LP, AAVE supply.
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';
import { selectBestPool, type OrcaPoolCandidate } from './orcaPoolDiscovery.ts';
import { selectBestEvmPool, type EvmPoolCandidate } from './evmPoolDiscovery.ts';

// ============================================================================
// Types
// ============================================================================

export type MarketCondition = 'bullish' | 'neutral' | 'bearish' | 'danger';

export type ReinvestTarget =
  | 'jito_stake'       // SOL → JitoSOL (Solana)
  | 'kamino_supply'    // USDC → Kamino lending (Solana)
  | 'kamino_repay'     // USDC → repay Kamino borrow (reduces interest cost)
  | 'aave_repay'       // USDC → repay AAVE borrow on EVM chain
  | 'hold_stables'     // Keep as USDC/stablecoins (danger mode or no better option)
  | 'orca_lp'          // Re-LP on Orca (high confidence only)
  | 'evm_lp';          // Re-LP on EVM (high confidence only)

export interface YieldOption {
  target: ReinvestTarget;
  chain: 'solana' | 'arbitrum' | 'base' | 'polygon' | 'optimism';
  estimatedApyPct: number;       // raw yield before deducting costs
  riskAdjustedApyPct: number;    // yield * risk factor (market+strategy-aware)
  minAmountUsd: number;          // don't bother below this (gas/tx cost threshold)
  description: string;
}

export interface ReinvestmentPlan {
  /** Where the profits originated */
  source: string;
  /** Chain where profits currently sit */
  sourceChain: 'solana' | 'arbitrum' | 'base' | 'polygon' | 'optimism';
  /** USD value of profits to reinvest */
  amountUsd: number;
  /** SOL amount (if applicable, e.g. from Orca claims) */
  solAmount?: number;
  /** USDC / stablecoin amount (if applicable) */
  usdcAmount?: number;
  /** Market condition at time of decision */
  marketCondition: MarketCondition;
  /** Ranked yield options, best first */
  rankedOptions: YieldOption[];
  /** Selected target (top-ranked option above min threshold) */
  selectedTarget: ReinvestTarget;
  /** Why this target was chosen */
  reasoning: string;
}

interface AccumulatedFees {
  solana: { solAmount: number; usdcAmount: number; lastClaimTs: number };
  evm: Record<number, { stableAmount: number; nativeAmount: number; lastClaimTs: number }>;
}

// ============================================================================
// Module state — accumulated fees across claims (reset each CFO cycle)
// ============================================================================

const _accumulated: AccumulatedFees = {
  solana: { solAmount: 0, usdcAmount: 0, lastClaimTs: 0 },
  evm: {},
};

export function resetAccumulated(): void {
  _accumulated.solana = { solAmount: 0, usdcAmount: 0, lastClaimTs: 0 };
  _accumulated.evm = {};
}

export function accumulateSolanaFees(solAmount: number, usdcAmount: number): void {
  _accumulated.solana.solAmount += solAmount;
  _accumulated.solana.usdcAmount += usdcAmount;
  _accumulated.solana.lastClaimTs = Date.now();
}

export function accumulateEvmFees(chainId: number, stableAmount: number, nativeAmount: number): void {
  if (!_accumulated.evm[chainId]) {
    _accumulated.evm[chainId] = { stableAmount: 0, nativeAmount: 0, lastClaimTs: 0 };
  }
  _accumulated.evm[chainId].stableAmount += stableAmount;
  _accumulated.evm[chainId].nativeAmount += nativeAmount;
  _accumulated.evm[chainId].lastClaimTs = Date.now();
}

export function getAccumulatedFees(): AccumulatedFees {
  return structuredClone(_accumulated);
}

// Cached LP targets from most recent rankYieldOptions() — used by execution helpers
let _lastOrcaLpTarget: OrcaPoolCandidate | null = null;
let _lastEvmLpTarget: EvmPoolCandidate | null = null;

// ============================================================================
// Yield Ranking
// ============================================================================

/** Risk multiplier per market condition — scales down risky strategies */
const MARKET_RISK_FACTOR: Record<MarketCondition, { safe: number; moderate: number; risky: number }> = {
  bullish: { safe: 0.8, moderate: 1.0, risky: 1.0 },
  neutral: { safe: 0.9, moderate: 0.9, risky: 0.7 },
  bearish: { safe: 1.0, moderate: 0.6, risky: 0.3 },
  danger:  { safe: 1.0, moderate: 0.1, risky: 0.0 },
};

function riskCategory(target: ReinvestTarget): 'safe' | 'moderate' | 'risky' {
  switch (target) {
    case 'hold_stables':
    case 'kamino_repay':
    case 'aave_repay':
      return 'safe';
    case 'jito_stake':
    case 'kamino_supply':
      return 'moderate';
    case 'orca_lp':
    case 'evm_lp':
      return 'risky';
    default:
      return 'moderate';
  }
}

/**
 * Gather current APY data from all available yield strategies.
 * Returns ranked options (best risk-adjusted yield first).
 */
export async function rankYieldOptions(
  marketCondition: MarketCondition,
  chain: 'solana' | 'arbitrum' | 'base' | 'polygon' | 'optimism',
  opts?: {
    kaminoBorrowUsd?: number;   // current Kamino borrow outstanding
    aaveBorrowUsd?: number;     // current AAVE borrow outstanding
    kaminoBorrowApy?: number;   // Kamino borrow cost %
    aaveBorrowApy?: number;     // AAVE borrow cost %
  },
): Promise<YieldOption[]> {
  const env = getCFOEnv();
  const options: YieldOption[] = [];
  const riskFactors = MARKET_RISK_FACTOR[marketCondition];

  // Always available: hold stables (0% yield but 0% risk)
  options.push({
    target: 'hold_stables',
    chain,
    estimatedApyPct: 0,
    riskAdjustedApyPct: 0,
    minAmountUsd: 0,
    description: 'Hold as stablecoins — no deployment risk',
  });

  // ── Solana strategies ──
  if (chain === 'solana') {
    // Jito staking (~7% APY)
    if (env.jitoEnabled) {
      const jitoApy = 7.0; // Jito SOL staking APY is relatively stable
      options.push({
        target: 'jito_stake',
        chain: 'solana',
        estimatedApyPct: jitoApy,
        riskAdjustedApyPct: jitoApy * riskFactors.moderate,
        minAmountUsd: 1,
        description: `Stake SOL → JitoSOL (${jitoApy}% APY)`,
      });
    }

    // Kamino supply
    if (env.kaminoEnabled) {
      try {
        const kamino = await import('./kaminoService.ts');
        const pos = await kamino.getPosition();
        const supplyApy = pos.deposits.length > 0
          ? pos.deposits.reduce((sum, d) => sum + (d.apy ?? 0), 0) / pos.deposits.length * 100
          : 3.0; // default conservative estimate
        options.push({
          target: 'kamino_supply',
          chain: 'solana',
          estimatedApyPct: supplyApy,
          riskAdjustedApyPct: supplyApy * riskFactors.moderate,
          minAmountUsd: 5,
          description: `Supply to Kamino lending (${supplyApy.toFixed(1)}% APY)`,
        });
      } catch { /* non-fatal */ }
    }

    // Kamino repay (saves borrow interest — treat saved interest as "yield")
    if (opts?.kaminoBorrowUsd && opts.kaminoBorrowUsd > 1) {
      const savedApy = opts.kaminoBorrowApy ?? 5.0;
      options.push({
        target: 'kamino_repay',
        chain: 'solana',
        estimatedApyPct: savedApy,
        riskAdjustedApyPct: savedApy * riskFactors.safe, // repaying debt is always safe
        minAmountUsd: 1,
        description: `Repay Kamino borrow (saves ${savedApy.toFixed(1)}% interest)`,
      });
    }
  }

  // ── EVM strategies ──
  if (chain !== 'solana') {
    // AAVE repay (saves borrow interest)
    if (opts?.aaveBorrowUsd && opts.aaveBorrowUsd > 1) {
      const savedApy = opts.aaveBorrowApy ?? 4.0;
      options.push({
        target: 'aave_repay',
        chain,
        estimatedApyPct: savedApy,
        riskAdjustedApyPct: savedApy * riskFactors.safe,
        minAmountUsd: 2,
        description: `Repay AAVE borrow on ${chain} (saves ${savedApy.toFixed(1)}% interest)`,
      });
    }
  }

  // ── LP reinvestment targets (volatile pools for fee compounding) ──
  const preferVolatile = env.reinvestPreferVolatile ?? true;
  // Only offer LP targets in bullish/neutral — rebalance logic handles range management
  if (marketCondition !== 'danger' && marketCondition !== 'bearish') {
    // Orca LP (Solana chain)
    if (chain === 'solana' && env.orcaLpEnabled) {
      try {
        const riskTiers = preferVolatile
          ? new Set(['medium', 'high'])
          : new Set(['low', 'medium']);
        const bestPool = await selectBestPool({ marketCondition, orcaLpRiskTiers: riskTiers });
        if (bestPool) {
          const poolApy = bestPool.pool.apyBase7d;
          if (poolApy > 0) {
            options.push({
              target: 'orca_lp',
              chain: 'solana',
              estimatedApyPct: poolApy,
              riskAdjustedApyPct: poolApy * riskFactors.risky,
              minAmountUsd: 25,
              description: `Re-LP into Orca ${bestPool.pool.pair} (${poolApy.toFixed(1)}% APY, ${bestPool.pool.riskTier} risk)`,
            });
            // Stash best pool on the option for execution
            _lastOrcaLpTarget = bestPool.pool;
          }
        }
      } catch { /* non-fatal: pool discovery may fail */ }
    }

    // EVM LP (same chain where profits sit)
    if (chain !== 'solana' && env.evmLpEnabled) {
      try {
        const chainIdMap: Record<string, number> = {
          arbitrum: 42161, base: 8453, polygon: 137, optimism: 10,
        };
        const numericChainId = chainIdMap[chain];
        const riskTiers = preferVolatile
          ? new Set(['medium', 'high'])
          : new Set(['low', 'medium']);
        const bestPool = await selectBestEvmPool({
          marketCondition,
          evmLpRiskTiers: riskTiers,
          preferredChainIds: numericChainId ? [numericChainId] : undefined,
        });
        if (bestPool) {
          const poolApr = bestPool.pool.apr7d;
          if (poolApr > 0) {
            options.push({
              target: 'evm_lp',
              chain,
              estimatedApyPct: poolApr,
              riskAdjustedApyPct: poolApr * riskFactors.risky,
              minAmountUsd: getCFOEnv().evmLpMinUsd,
              description: `Re-LP into EVM ${bestPool.pool.pair} on ${bestPool.pool.chainName} (${poolApr.toFixed(1)}% APR, ${bestPool.pool.riskTier} risk)`,
            });
            _lastEvmLpTarget = bestPool.pool;
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // Sort by risk-adjusted APY descending
  options.sort((a, b) => b.riskAdjustedApyPct - a.riskAdjustedApyPct);

  return options;
}

// ============================================================================
// Reinvestment Planning
// ============================================================================

/**
 * Build a reinvestment plan for claimed fees/profits.
 * Selects the best target based on yield ranking and market condition.
 */
export async function planReinvestment(params: {
  source: string;
  sourceChain: 'solana' | 'arbitrum' | 'base' | 'polygon' | 'optimism';
  amountUsd: number;
  solAmount?: number;
  usdcAmount?: number;
  marketCondition: MarketCondition;
  kaminoBorrowUsd?: number;
  aaveBorrowUsd?: number;
  kaminoBorrowApy?: number;
  aaveBorrowApy?: number;
}): Promise<ReinvestmentPlan | null> {
  const env = getCFOEnv();
  const minReinvestUsd = env.reinvestMinUsd ?? 10;

  // Below minimum threshold — accumulate, don't act
  if (params.amountUsd < minReinvestUsd) {
    logger.debug(
      `[Reinvest] $${params.amountUsd.toFixed(2)} from ${params.source} below min $${minReinvestUsd} — accumulating`,
    );
    return null;
  }

  // Danger mode override: always hold stables
  if (params.marketCondition === 'danger') {
    return {
      ...params,
      rankedOptions: [{
        target: 'hold_stables',
        chain: params.sourceChain,
        estimatedApyPct: 0,
        riskAdjustedApyPct: 0,
        minAmountUsd: 0,
        description: 'DANGER mode — holding profits as stables',
      }],
      selectedTarget: 'hold_stables',
      reasoning: 'Market in DANGER mode — profits held as stables until conditions improve',
    };
  }

  const rankedOptions = await rankYieldOptions(params.marketCondition, params.sourceChain, {
    kaminoBorrowUsd: params.kaminoBorrowUsd,
    aaveBorrowUsd: params.aaveBorrowUsd,
    kaminoBorrowApy: params.kaminoBorrowApy,
    aaveBorrowApy: params.aaveBorrowApy,
  });

  // Select the best option that meets the minimum amount threshold
  const viable = rankedOptions.filter(o => params.amountUsd >= o.minAmountUsd);
  const selected = viable.length > 0 ? viable[0] : rankedOptions.find(o => o.target === 'hold_stables')!;

  // Special case: if we have SOL (from Orca claims) and best target is jito_stake,
  // route SOL directly without USDC conversion
  if (selected.target === 'jito_stake' && (params.solAmount ?? 0) > 0.01) {
    return {
      ...params,
      rankedOptions,
      selectedTarget: 'jito_stake',
      reasoning: `Routing ${params.solAmount!.toFixed(4)} SOL to Jito staking (${selected.estimatedApyPct.toFixed(1)}% APY, market: ${params.marketCondition})`,
    };
  }

  // Special case: repay debt first if it saves more interest than any deployment earns
  const repayOption = rankedOptions.find(o => o.target === 'kamino_repay' || o.target === 'aave_repay');
  if (repayOption && repayOption.riskAdjustedApyPct >= selected.riskAdjustedApyPct) {
    return {
      ...params,
      rankedOptions,
      selectedTarget: repayOption.target,
      reasoning: `Repaying debt saves ${repayOption.estimatedApyPct.toFixed(1)}% interest — better than deploying at ${selected.riskAdjustedApyPct.toFixed(1)}% risk-adjusted`,
    };
  }

  return {
    ...params,
    rankedOptions,
    selectedTarget: selected.target,
    reasoning: `Best yield: ${selected.description} (${selected.riskAdjustedApyPct.toFixed(1)}% risk-adj, market: ${params.marketCondition})`,
  };
}

// ============================================================================
// Execution Helpers — called from decision engine post-claim hooks
// ============================================================================

/**
 * Execute a Solana reinvestment (SOL or USDC from Orca claim).
 * Returns result with tx details.
 */
export async function executeSolanaReinvestment(plan: ReinvestmentPlan): Promise<{
  success: boolean;
  txId?: string;
  target: ReinvestTarget;
  amountUsd: number;
  error?: string;
}> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Reinvest] DRY RUN — would ${plan.selectedTarget}: $${plan.amountUsd.toFixed(2)}`);
    return { success: true, target: plan.selectedTarget, amountUsd: plan.amountUsd };
  }

  try {
    switch (plan.selectedTarget) {
      case 'jito_stake': {
        if ((plan.solAmount ?? 0) < 0.001) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'No SOL to stake' };
        }
        const jito = await import('./jitoStakingService.ts');
        const result = await jito.stakeSol(plan.solAmount!);
        logger.info(`[Reinvest] Staked ${plan.solAmount!.toFixed(4)} SOL → JitoSOL: ${result.success ? 'OK' : result.error}`);
        return { success: result.success, txId: result.txSignature, target: 'jito_stake', amountUsd: plan.amountUsd, error: result.error };
      }

      case 'kamino_supply': {
        if ((plan.usdcAmount ?? 0) < 1) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'Insufficient USDC for Kamino supply' };
        }
        const kamino = await import('./kaminoService.ts');
        const result = await kamino.deposit('USDC', plan.usdcAmount!);
        logger.info(`[Reinvest] Supplied $${plan.usdcAmount!.toFixed(2)} USDC to Kamino: ${result.success ? 'OK' : result.error}`);
        return { success: result.success, txId: result.txSignature, target: 'kamino_supply', amountUsd: plan.amountUsd, error: result.error };
      }

      case 'kamino_repay': {
        if ((plan.usdcAmount ?? 0) < 0.5) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'Insufficient USDC for Kamino repay' };
        }
        const kamino = await import('./kaminoService.ts');
        const result = await kamino.repay('USDC', plan.usdcAmount!);
        logger.info(`[Reinvest] Repaid $${plan.usdcAmount!.toFixed(2)} USDC to Kamino: ${result.success ? 'OK' : result.error}`);
        return { success: result.success, txId: result.txSignature, target: 'kamino_repay', amountUsd: plan.amountUsd, error: result.error };
      }

      case 'hold_stables':
        logger.info(`[Reinvest] Holding $${plan.amountUsd.toFixed(2)} as stables (market: ${plan.marketCondition})`);
        return { success: true, target: 'hold_stables', amountUsd: plan.amountUsd };

      case 'orca_lp': {
        if (!_lastOrcaLpTarget) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'No Orca LP pool target available' };
        }
        const pool = _lastOrcaLpTarget;
        // Split: half USDC, half token A (SOL or other)
        const usdcSide = (plan.usdcAmount ?? 0) + ((plan.solAmount ?? 0) * (plan.amountUsd / Math.max((plan.solAmount ?? 0), 0.001)));
        const halfUsdc = usdcSide / 2;
        const tokenASide = halfUsdc; // will be swapped to tokenA by openPosition
        const orca = await import('./orcaService.ts');
        // Default to ±10% range for volatile pools — the rebalance logic will manage it
        const rangeWidth = pool.riskTier === 'high' ? 15 : pool.riskTier === 'medium' ? 10 : 5;
        const result = await orca.openPosition(
          halfUsdc,           // usdcAmount
          tokenASide,         // tokenAAmount (in USD terms, will swap)
          rangeWidth,         // rangeWidthPct
          pool.whirlpoolAddress,
          pool.tokenA?.decimals ?? 9,
          pool.tokenB?.decimals ?? 6,
          pool.tickSpacing,
        );
        logger.info(`[Reinvest] Orca LP reinvest ${pool.pair}: $${plan.amountUsd.toFixed(2)} → ${result.success ? 'OK' : result.error}`);
        _lastOrcaLpTarget = null;
        return { success: result.success, txId: result.txSignature, target: 'orca_lp', amountUsd: plan.amountUsd, error: result.error };
      }

      default:
        return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: `Unsupported target: ${plan.selectedTarget}` };
    }
  } catch (err) {
    logger.error(`[Reinvest] Solana reinvestment failed:`, err);
    return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: (err as Error).message };
  }
}

/**
 * Execute EVM reinvestment (stables from EVM LP fee claim).
 */
export async function executeEvmReinvestment(plan: ReinvestmentPlan, chainId: number): Promise<{
  success: boolean;
  txHash?: string;
  target: ReinvestTarget;
  amountUsd: number;
  error?: string;
}> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Reinvest] DRY RUN — would ${plan.selectedTarget} on chain ${chainId}: $${plan.amountUsd.toFixed(2)}`);
    return { success: true, target: plan.selectedTarget, amountUsd: plan.amountUsd };
  }

  try {
    switch (plan.selectedTarget) {
      case 'aave_repay': {
        if ((plan.usdcAmount ?? 0) < 1) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'Insufficient USDC for AAVE repay' };
        }
        const aave = await import('./aaveLendingService.ts');
        const result = await aave.repayAave(chainId, 'USDC', plan.usdcAmount!);
        logger.info(`[Reinvest] Repaid $${plan.usdcAmount!.toFixed(2)} USDC to AAVE on chain ${chainId}: ${result.success ? 'OK' : result.error}`);
        return { success: result.success, txHash: result.txHash, target: 'aave_repay', amountUsd: plan.amountUsd, error: result.error };
      }

      case 'hold_stables':
        logger.info(`[Reinvest] Holding $${plan.amountUsd.toFixed(2)} as stables on chain ${chainId} (market: ${plan.marketCondition})`);
        return { success: true, target: 'hold_stables', amountUsd: plan.amountUsd };

      case 'evm_lp': {
        if (!_lastEvmLpTarget) {
          return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: 'No EVM LP pool target available' };
        }
        const pool = _lastEvmLpTarget;
        const evmLp = await import('./evmLpService.ts');
        // Use wider ticks for volatile pools — rebalance logic keeps them in range
        const rangeWidthTicks = pool.riskTier === 'high' ? 600 : pool.riskTier === 'medium' ? 450 : 300;
        const result = await evmLp.openEvmLpPosition(
          {
            chainId: pool.chainId as unknown as string,
            chainNumericId: pool.chainId,
            poolAddress: pool.poolAddress,
            token0: { ...pool.token0, name: pool.token0.symbol },
            token1: { ...pool.token1, name: pool.token1.symbol },
            protocol: { name: pool.protocol.name, factoryAddress: '' },
            feeTier: pool.feeTier,
          },
          plan.amountUsd,
          rangeWidthTicks,
        );
        logger.info(`[Reinvest] EVM LP reinvest ${pool.pair} on ${pool.chainName}: $${plan.amountUsd.toFixed(2)} → ${result.success ? 'OK' : result.error}`);
        _lastEvmLpTarget = null;
        return { success: result.success, txHash: result.txHash, target: 'evm_lp', amountUsd: plan.amountUsd, error: result.error };
      }

      default:
        return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: `Unsupported EVM target: ${plan.selectedTarget}` };
    }
  } catch (err) {
    logger.error(`[Reinvest] EVM reinvestment failed (chain ${chainId}):`, err);
    return { success: false, target: plan.selectedTarget, amountUsd: plan.amountUsd, error: (err as Error).message };
  }
}

// ============================================================================
// Post-Claim Hook — called directly after a fee claim execution
// ============================================================================

/**
 * Post-claim hook for Orca fee claims.
 * Evaluates the claimed amounts and either accumulates or reinvests.
 */
export async function handleOrcaClaimProceeds(params: {
  solClaimed: number;
  usdcClaimed: number;
  solPriceUsd: number;
  marketCondition: MarketCondition;
  kaminoBorrowUsd?: number;
  kaminoBorrowApy?: number;
}): Promise<{ reinvested: boolean; plan?: ReinvestmentPlan; result?: Awaited<ReturnType<typeof executeSolanaReinvestment>> }> {
  const totalUsd = (params.solClaimed * params.solPriceUsd) + params.usdcClaimed;

  // Accumulate
  accumulateSolanaFees(params.solClaimed, params.usdcClaimed);

  const plan = await planReinvestment({
    source: 'orca_lp_fees',
    sourceChain: 'solana',
    amountUsd: totalUsd,
    solAmount: params.solClaimed,
    usdcAmount: params.usdcClaimed,
    marketCondition: params.marketCondition,
    kaminoBorrowUsd: params.kaminoBorrowUsd,
    kaminoBorrowApy: params.kaminoBorrowApy,
  });

  if (!plan) return { reinvested: false }; // below threshold, accumulated

  const result = await executeSolanaReinvestment(plan);
  if (result.success) {
    // Clear accumulated since we just reinvested
    _accumulated.solana.solAmount = 0;
    _accumulated.solana.usdcAmount = 0;
  }

  return { reinvested: true, plan, result };
}

/**
 * Post-claim hook for EVM LP fee claims.
 * Accumulates or reinvests (primarily AAVE repay or hold stables).
 */
export async function handleEvmClaimProceeds(params: {
  chainNumericId: number;
  estimatedUsd: number;
  marketCondition: MarketCondition;
  aaveBorrowUsd?: number;
  aaveBorrowApy?: number;
}): Promise<{ reinvested: boolean; plan?: ReinvestmentPlan; result?: Awaited<ReturnType<typeof executeEvmReinvestment>> }> {
  const chainNames: Record<number, 'arbitrum' | 'base' | 'polygon' | 'optimism'> = {
    42161: 'arbitrum', 8453: 'base', 137: 'polygon', 10: 'optimism',
  };
  const chain = chainNames[params.chainNumericId] ?? 'arbitrum';

  accumulateEvmFees(params.chainNumericId, params.estimatedUsd, 0);

  const plan = await planReinvestment({
    source: 'evm_lp_fees',
    sourceChain: chain,
    amountUsd: params.estimatedUsd,
    usdcAmount: params.estimatedUsd, // fees are mostly stables or valued in USD
    marketCondition: params.marketCondition,
    aaveBorrowUsd: params.aaveBorrowUsd,
    aaveBorrowApy: params.aaveBorrowApy,
  });

  if (!plan) return { reinvested: false };

  const result = await executeEvmReinvestment(plan, params.chainNumericId);
  if (result.success) {
    const accum = _accumulated.evm[params.chainNumericId];
    if (accum) { accum.stableAmount = 0; accum.nativeAmount = 0; }
  }

  return { reinvested: true, plan, result };
}

/**
 * Periodic sweep — called from decision engine to check for accumulated idle profits
 * across all chains and reinvest them if they've exceeded the threshold.
 */
export async function sweepAccumulatedProfits(params: {
  marketCondition: MarketCondition;
  solPriceUsd: number;
  kaminoBorrowUsd?: number;
  kaminoBorrowApy?: number;
  aaveBorrowUsd?: number;
  aaveBorrowApy?: number;
}): Promise<Array<{ chain: string; result: Awaited<ReturnType<typeof executeSolanaReinvestment>> | Awaited<ReturnType<typeof executeEvmReinvestment>> }>> {
  const env = getCFOEnv();
  const minSweepUsd = env.reinvestMinUsd ?? 10;
  const results: Array<{ chain: string; result: any }> = [];

  // Solana sweep
  const solanaUsd = (_accumulated.solana.solAmount * params.solPriceUsd) + _accumulated.solana.usdcAmount;
  if (solanaUsd >= minSweepUsd) {
    const plan = await planReinvestment({
      source: 'accumulated_solana',
      sourceChain: 'solana',
      amountUsd: solanaUsd,
      solAmount: _accumulated.solana.solAmount,
      usdcAmount: _accumulated.solana.usdcAmount,
      marketCondition: params.marketCondition,
      kaminoBorrowUsd: params.kaminoBorrowUsd,
      kaminoBorrowApy: params.kaminoBorrowApy,
    });

    if (plan) {
      const result = await executeSolanaReinvestment(plan);
      results.push({ chain: 'solana', result });
      if (result.success) {
        _accumulated.solana.solAmount = 0;
        _accumulated.solana.usdcAmount = 0;
      }
    }
  }

  // EVM sweeps per chain
  for (const [chainIdStr, accum] of Object.entries(_accumulated.evm)) {
    const chainId = Number(chainIdStr);
    const evmUsd = accum.stableAmount; // already in USD terms
    if (evmUsd >= minSweepUsd) {
      const chainNames: Record<number, 'arbitrum' | 'base' | 'polygon' | 'optimism'> = {
        42161: 'arbitrum', 8453: 'base', 137: 'polygon', 10: 'optimism',
      };
      const chain = chainNames[chainId] ?? 'arbitrum';

      const plan = await planReinvestment({
        source: `accumulated_${chain}`,
        sourceChain: chain,
        amountUsd: evmUsd,
        usdcAmount: evmUsd,
        marketCondition: params.marketCondition,
        aaveBorrowUsd: params.aaveBorrowUsd,
        aaveBorrowApy: params.aaveBorrowApy,
      });

      if (plan) {
        const result = await executeEvmReinvestment(plan, chainId);
        results.push({ chain, result });
        if (result.success) {
          accum.stableAmount = 0;
          accum.nativeAmount = 0;
        }
      }
    }
  }

  return results;
}
