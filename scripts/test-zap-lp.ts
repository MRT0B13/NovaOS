#!/usr/bin/env bun
/**
 * test-zap-lp.ts — End-to-end test: zap into an LP position, then close it.
 *
 * Steps:
 *  1. Scan multi-chain balances → pick chain with most funds (that has NFPM)
 *  2. Discover Krystal pools on that chain, pick a safe WETH/USDC or similar pool
 *  3. Open a small LP position ($10) using self-zap (single-asset entry)
 *  4. Wait 5 seconds
 *  5. Close the position and recover tokens
 *
 * Usage:
 *   bun run scripts/test-zap-lp.ts
 *
 * Env: Reads from .env (same as production CFO agent)
 */

import 'dotenv/config';

// ── Helpers ──────────────────────────────────────────────────────────
function log(msg: string) { console.log(`[test-zap-lp] ${msg}`); }
function logErr(msg: string) { console.error(`[test-zap-lp] ❌ ${msg}`); }
function logOk(msg: string) { console.log(`[test-zap-lp] ✅ ${msg}`); }

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Chains that have a Uniswap V3 NFPM deployed (must match NFPM_BY_CHAIN in krystalService)
const NFPM_CHAINS = new Set([1, 10, 137, 8453, 42161]);

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  log('Starting zap LP e2e test...\n');

  // ----- Step 0: Load modules (lazy imports — same as production) -----
  const {
    getMultiChainEvmBalances,
    discoverKrystalPools,
    openEvmLpPosition,
    closeEvmLpPosition,
  } = await import('../src/launchkit/cfo/krystalService.ts');

  // ----- Step 1: Scan chain balances -----
  log('Step 1: Scanning multi-chain EVM balances...');
  const balances = await getMultiChainEvmBalances();
  if (balances.length === 0) {
    logErr('No chain balances found — check CFO_EVM_PRIVATE_KEY and RPC URLs');
    process.exit(1);
  }

  for (const b of balances) {
    const hasNfpm = NFPM_CHAINS.has(b.chainId) ? '' : ' (no NFPM)';
    log(`  ${b.chainName} (${b.chainId}): USDC=$${b.usdcBalance.toFixed(2)}, ${b.nativeSymbol}=${b.nativeBalance.toFixed(4)} ($${b.nativeValueUsd.toFixed(2)})${hasNfpm}`);
  }

  // Pick chain with highest total value among chains that have NFPM
  // Prefer chains with canonical Uniswap V3 (1, 10, 137, 42161) since
  // Base's NFPM v1.3.0 uses a different factory and not all pools are compatible.
  const CANONICAL_NFPM_CHAINS = new Set([1, 10, 137, 42161]);
  const eligible = balances
    .filter(b => NFPM_CHAINS.has(b.chainId) && (b.usdcBalance + b.nativeValueUsd) >= 5)
    .sort((a, b) => {
      // Prefer canonical chains, then by total value
      const aCanonical = CANONICAL_NFPM_CHAINS.has(a.chainId) ? 1 : 0;
      const bCanonical = CANONICAL_NFPM_CHAINS.has(b.chainId) ? 1 : 0;
      if (bCanonical !== aCanonical) return bCanonical - aCanonical;
      return (b.usdcBalance + b.nativeValueUsd) - (a.usdcBalance + a.nativeValueUsd);
    });

  if (eligible.length === 0) {
    logErr('No chains with NFPM have funds');
    process.exit(1);
  }

  const bestChain = eligible[0];
  const totalVal = bestChain.usdcBalance + bestChain.nativeValueUsd;
  log(`\n  Best chain (with NFPM): ${bestChain.chainName} (${bestChain.chainId}) — total $${totalVal.toFixed(2)}`);

  if (totalVal < 5) {
    logErr(`Insufficient funds on best chain ($${totalVal.toFixed(2)} < $5 minimum)`);
    process.exit(1);
  }

  // ----- Step 2: Discover pools on that chain -----
  log('\nStep 2: Discovering Krystal pools...');
  const allPools = await discoverKrystalPools(true);
  const chainPools = allPools.filter(p => p.chainNumericId === bestChain.chainId);
  log(`  Found ${chainPools.length} pools on ${bestChain.chainName}`);

  if (chainPools.length === 0) {
    logErr(`No eligible pools on ${bestChain.chainName}`);
    process.exit(1);
  }

  // Prefer WETH/USDC pool (best liquidity, easiest swap routing)
  const stables = ['USDC', 'USDT', 'DAI', 'USDC.E', 'USDCE'];
  const majors = ['WETH', 'ETH', 'WMATIC', 'MATIC', 'WBTC'];
  
  // Score pools: WETH/USDC(T) best, then major/stable, then any stable
  const scoredPools = chainPools.map(p => {
    const syms = [p.token0.symbol.toUpperCase(), p.token1.symbol.toUpperCase()];
    const hasStable = syms.some(s => stables.includes(s));
    const hasMajor = syms.some(s => majors.includes(s));
    const hasWeth = syms.some(s => s === 'WETH' || s === 'ETH');
    const hasUsdc = syms.some(s => s === 'USDC' || s === 'USDC.E');
    
    let poolScore = 0;
    if (hasWeth && hasUsdc) poolScore = 100;       // WETH/USDC — best
    else if (hasWeth && hasStable) poolScore = 80;  // WETH/USDT etc
    else if (hasMajor && hasStable) poolScore = 50; // WBTC/USDC etc
    else if (hasStable) poolScore = 30;             // stable paired
    
    return { pool: p, poolScore };
  }).sort((a, b) => b.poolScore - a.poolScore);
  
  const safePool = scoredPools[0]?.pool ?? chainPools[0];

  log(`  Selected pool: ${safePool.token0.symbol}/${safePool.token1.symbol} (${safePool.protocol.name})`);
  log(`    Pool address: ${safePool.poolAddress}`);
  log(`    Fee tier: ${safePool.feeTier}`);
  log(`    TVL: $${(safePool.tvlUsd / 1e6).toFixed(1)}M`);
  log(`    APR 7d: ${safePool.apr7d.toFixed(1)}%`);
  log(`    Score: ${safePool.score.toFixed(0)}`);

  // ----- Step 3: Open LP position via zap -----
  const deployUsd = Math.min(10, totalVal * 0.5);  // $10 or 50% of available, whichever is less
  log(`\nStep 3: Opening LP position via zap — $${deployUsd.toFixed(2)}...`);
  log(`  This will trigger the self-zap flow if only one pool token is available\n`);

  const openResult = await openEvmLpPosition(
    {
      chainId: `${bestChain.chainName}@${bestChain.chainId}`,
      chainNumericId: bestChain.chainId,
      poolAddress: safePool.poolAddress,
      token0: safePool.token0,
      token1: safePool.token1,
      protocol: safePool.protocol,
      feeTier: safePool.feeTier,
    },
    deployUsd,
    400,  // rangeWidthTicks — ±200 ticks from current (moderate range)
  );

  if (!openResult.success) {
    logErr(`Open LP failed: ${openResult.error}`);
    process.exit(1);
  }

  logOk(`LP opened! tokenId=${openResult.tokenId} tx=${openResult.txHash}`);

  // Sanity check: tokenId should be a numeric string
  if (openResult.tokenId?.startsWith('unknown')) {
    logErr(`TokenId parsing failed — got ${openResult.tokenId}. Position exists on-chain but we can't close it by tokenId.`);
    logErr(`Check tx on block explorer: ${openResult.txHash}`);
    process.exit(1);
  }

  // ----- Step 4: Wait a moment -----
  log('\nStep 4: Waiting 5 seconds before closing...');
  await sleep(5000);

  // ----- Step 5: Close the position -----
  log('\nStep 5: Closing LP position...');
  const closeResult = await closeEvmLpPosition({
    posId: openResult.tokenId!,
    chainId: `${bestChain.chainName}@${bestChain.chainId}`,
    chainNumericId: bestChain.chainId,
    token0: { address: safePool.token0.address, symbol: safePool.token0.symbol, decimals: safePool.token0.decimals },
    token1: { address: safePool.token1.address, symbol: safePool.token1.symbol, decimals: safePool.token1.decimals },
  });

  if (!closeResult.success) {
    logErr(`Close LP failed: ${closeResult.error}`);
    logErr(`Position tokenId=${openResult.tokenId} may still be open — check on-chain`);
    process.exit(1);
  }

  logOk(`LP closed! tx=${closeResult.txHash}`);
  log(`  Recovered: token0=${closeResult.amount0Recovered}, token1=${closeResult.amount1Recovered}`);
  log(`  Estimated value: $${closeResult.valueRecoveredUsd.toFixed(2)}`);
  log(`  Fee tier: ${closeResult.feeTier}`);

  // ----- Summary -----
  log('\n════════════════════════════════════════════════════════');
  logOk('ZAP LP E2E TEST PASSED');
  log('════════════════════════════════════════════════════════');
  log(`  Chain:     ${bestChain.chainName} (${bestChain.chainId})`);
  log(`  Pool:      ${safePool.token0.symbol}/${safePool.token1.symbol}`);
  log(`  Deployed:  $${deployUsd.toFixed(2)}`);
  log(`  Recovered: $${closeResult.valueRecoveredUsd.toFixed(2)}`);
  log(`  Slippage:  $${(deployUsd - closeResult.valueRecoveredUsd).toFixed(2)} (${((1 - closeResult.valueRecoveredUsd / deployUsd) * 100).toFixed(1)}%)`);
  log(`  Open tx:   ${openResult.txHash}`);
  log(`  Close tx:  ${closeResult.txHash}`);
  log('════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  logErr(`Unhandled error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
