#!/usr/bin/env bun
/**
 * close-lp-position.ts — Close a specific LP position by tokenId.
 *
 * Usage:
 *   bun run scripts/close-lp-position.ts <tokenId> <chainId>
 *
 * Example:
 *   bun run scripts/close-lp-position.ts 5335484 42161
 */

import 'dotenv/config';

async function main() {
  const tokenId = process.argv[2];
  const chainId = Number(process.argv[3] || 42161);

  if (!tokenId) {
    console.error('Usage: bun run scripts/close-lp-position.ts <tokenId> [chainId]');
    process.exit(1);
  }

  console.log(`Closing LP position tokenId=${tokenId} on chain ${chainId}...`);

  const { closeEvmLpPosition } = await import('../src/launchkit/cfo/krystalService.ts');

  const result = await closeEvmLpPosition({
    posId: tokenId,
    chainId: `arbitrum@${chainId}`,
    chainNumericId: chainId,
    token0: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    token1: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  });

  if (result.success) {
    console.log(`✅ Closed! tx=${result.txHash}`);
    console.log(`  Recovered: WETH=${result.amount0Recovered}, USDC=${result.amount1Recovered}`);
    console.log(`  Estimated value: $${result.valueRecoveredUsd.toFixed(2)}`);
  } else {
    console.error(`❌ Failed: ${result.error}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
