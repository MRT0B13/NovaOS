/**
 * Test Kamino getPosition() + repayAndWithdraw() — close the live position.
 *
 * Current on-chain state:
 *   - 0.1 JitoSOL deposited as collateral
 *   - 5 USDC borrowed
 *
 * This script:
 *   1. Tests getPosition() to verify it now parses the v7 SDK Map format
 *   2. Calls repayAndWithdraw() to atomically close the position
 *   3. Re-checks getPosition() to confirm zero state
 */

import 'dotenv/config';

async function main() {
  const { getPosition, repayAndWithdraw } = await import('../src/launchkit/cfo/kaminoService.ts');

  console.log('\n========================================');
  console.log('  STEP 1: Test getPosition()');
  console.log('========================================\n');

  const pos = await getPosition();
  console.log('Position result:');
  console.log('  deposits:', JSON.stringify(pos.deposits, null, 2));
  console.log('  borrows:', JSON.stringify(pos.borrows, null, 2));
  console.log(`  netValueUsd: $${pos.netValueUsd.toFixed(4)}`);
  console.log(`  ltv: ${(pos.ltv * 100).toFixed(2)}%`);
  console.log(`  healthFactor: ${pos.healthFactor.toFixed(2)}`);

  if (pos.deposits.length === 0 && pos.borrows.length === 0) {
    console.log('\n⚠️  No position found — either already closed or getPosition still broken.');
    console.log('    If you expect a position, check the debug-kamino-position.ts script.');
    return;
  }

  // Get exact amounts for the close (add 0.5% buffer for interest)
  const borrowEntry = pos.borrows.find(b => b.asset === 'USDC');
  const depositEntry = pos.deposits.find(d => d.asset === 'JitoSOL');

  if (!borrowEntry || !depositEntry) {
    console.log('\n⚠️  Expected USDC borrow + JitoSOL deposit, got:', {
      borrows: pos.borrows.map(b => b.asset),
      deposits: pos.deposits.map(d => d.asset),
    });
    return;
  }

  const repayAmount = Math.min(borrowEntry.amount, 5.0); // wallet has 5 USDC — don't overshoot
  // Withdraw 99% — can't withdraw 100% while dust borrow remains (interest we can't pay)
  const withdrawAmount = depositEntry.amount * 0.99;

  console.log(`\n  → Will repay ${repayAmount.toFixed(6)} USDC (borrowed: ${borrowEntry.amount.toFixed(6)})`);
  console.log(`  → Will withdraw ${withdrawAmount.toFixed(9)} JitoSOL (deposited: ${depositEntry.amount.toFixed(9)})`);

  console.log('\n========================================');
  console.log('  STEP 2: repayAndWithdraw() — atomic close');
  console.log('========================================\n');

  const result = await repayAndWithdraw('USDC', repayAmount, 'JitoSOL', withdrawAmount);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (!result.success) {
    console.log('\n❌ repayAndWithdraw FAILED:', result.error);
    return;
  }

  console.log(`\n✅ Position closed! TX: ${result.txSignature}`);

  // Brief pause for confirmation
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n========================================');
  console.log('  STEP 3: Verify position is clear');
  console.log('========================================\n');

  const posAfter = await getPosition();
  console.log('Position after close:');
  console.log('  deposits:', posAfter.deposits.length);
  console.log('  borrows:', posAfter.borrows.length);
  console.log(`  netValueUsd: $${posAfter.netValueUsd.toFixed(4)}`);
  console.log(`  ltv: ${(posAfter.ltv * 100).toFixed(2)}%`);

  if (posAfter.deposits.length === 0 && posAfter.borrows.length === 0) {
    console.log('\n✅ All clear — position fully closed.');
  } else {
    console.log('\n⚠️  Residual position remains (may be dust).');
    console.log('    deposits:', JSON.stringify(posAfter.deposits));
    console.log('    borrows:', JSON.stringify(posAfter.borrows));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
