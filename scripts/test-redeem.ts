#!/usr/bin/env bun
/**
 * Test Polymarket position redemption.
 *
 * Usage:
 *   bun run scripts/test-redeem.ts              # dry run — shows redeemable positions
 *   bun run scripts/test-redeem.ts --live        # actually redeem the first redeemable position
 */

import 'dotenv/config';

const LIVE = process.argv.includes('--live');

async function main() {
  const poly = await import('../src/launchkit/cfo/polymarketService.ts');

  console.log('=== Fetching Polymarket positions ===\n');
  const positions = await poly.fetchPositions();

  if (positions.length === 0) {
    console.log('No positions found.');
    return;
  }

  console.log(`Found ${positions.length} position(s):\n`);

  for (const p of positions) {
    const tag = p.redeemable ? '🔴 REDEEMABLE' : '🟢 LIVE';
    console.log(
      `  ${tag}  "${p.question}"\n` +
      `         outcome=${p.outcome} size=${p.size.toFixed(4)} price=${p.currentPrice.toFixed(4)} ` +
      `value=$${p.currentValueUsd.toFixed(2)} negRisk=${p.negativeRisk ?? false} ` +
      `outcomeIdx=${p.outcomeIndex ?? 0}\n` +
      `         conditionId=${p.conditionId}\n` +
      `         tokenId=${p.tokenId}\n`,
    );
  }

  const redeemable = positions.filter(p => p.redeemable);
  console.log(`\n${redeemable.length} redeemable position(s) found.\n`);

  if (redeemable.length === 0) {
    console.log('Nothing to redeem.');
    return;
  }

  const target = redeemable[0];
  console.log(`Target: "${target.question}" (${target.outcome}, ${target.size.toFixed(4)} shares)\n`);

  if (!LIVE) {
    console.log('DRY RUN — pass --live to actually redeem on-chain.');
    return;
  }

  console.log('>>> LIVE: Redeeming on-chain...\n');
  const result = await poly.redeemPosition(target);

  if (result.success) {
    console.log(`✅ Redeemed successfully! tx: ${result.txHash}`);
  } else {
    console.log(`❌ Redemption failed: ${result.error}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
