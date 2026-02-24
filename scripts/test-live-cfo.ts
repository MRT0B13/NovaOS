#!/usr/bin/env bun
/**
 * LIVE CFO Service Tests — Deposit, Borrow, Repay, Orca LP
 *
 * Runs real on-chain transactions to verify new implementations.
 * Uses minimal amounts to limit risk.
 *
 * Flow (full test):
 *   1. Check balances & existing positions
 *   2. Deposit JitoSOL into Kamino (creates collateral)
 *   3. Borrow USDC against JitoSOL collateral
 *   4. Open small Orca LP with borrowed USDC + SOL
 *   5. Close Orca LP
 *   6. Repay USDC borrow
 *   7. Withdraw JitoSOL from Kamino (cleanup)
 *
 * Usage:
 *   bun run scripts/test-live-cfo.ts                 # Full test
 *   bun run scripts/test-live-cfo.ts --check-only    # Read-only: balances + positions only
 *   bun run scripts/test-live-cfo.ts --borrow-only   # Deposit + borrow + repay + withdraw only
 *   bun run scripts/test-live-cfo.ts --orca-only     # Deposit + borrow + orca open only (no cleanup)
 */

import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

// ============================================================================
// Config
// ============================================================================

const CHECK_ONLY = process.argv.includes('--check-only');
const BORROW_ONLY = process.argv.includes('--borrow-only');
const ORCA_ONLY = process.argv.includes('--orca-only');

// Minimal test amounts
const TEST_DEPOSIT_JITOSOL = 0.1;    // deposit 0.1 JitoSOL as collateral (~$15-20)
const TEST_BORROW_USDC = 5;          // borrow $5 USDC (well within safe LTV on ~$15-20 collateral)
const TEST_ORCA_USDC = 2;            // $2 USDC side of LP
const TEST_ORCA_SOL = 0.01;          // ~$1.5 SOL side of LP
const ORCA_RANGE_WIDTH_PCT = 30;     // wide range to stay in range

// Token mints
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');

// ============================================================================
// Wallet & Connection
// ============================================================================

const secret = process.env.AGENT_FUNDING_WALLET_SECRET;
if (!secret) { console.error('❌ AGENT_FUNDING_WALLET_SECRET not set'); process.exit(1); }

const wallet = Keypair.fromSecretKey(bs58.decode(secret));
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcUrl, 'confirmed');

console.log('═══════════════════════════════════════════════════════════');
console.log('  CFO LIVE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Wallet:  ${wallet.publicKey.toBase58()}`);
console.log(`  RPC:     ${rpcUrl.slice(0, 50)}...`);
console.log(`  Mode:    ${CHECK_ONLY ? 'CHECK ONLY' : BORROW_ONLY ? 'BORROW ONLY' : ORCA_ONLY ? 'ORCA ONLY' : 'FULL TEST'}`);
console.log('═══════════════════════════════════════════════════════════\n');

// ============================================================================
// Helpers
// ============================================================================

async function getTokenBalance(mint: PublicKey): Promise<number> {
  try {
    const accounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint });
    if (accounts.value.length === 0) return 0;
    const info = await connection.getTokenAccountBalance(accounts.value[0].pubkey);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

function hr() { console.log('───────────────────────────────────────────────────────────'); }

// ============================================================================
// Step 1: Balance Check
// ============================================================================

async function checkBalances() {
  console.log('📊 STEP 1: Wallet Balances');
  hr();

  const solBalance = await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
  const usdcBalance = await getTokenBalance(USDC_MINT);
  const jitoSolBalance = await getTokenBalance(JITOSOL_MINT);

  console.log(`  SOL:     ${solBalance.toFixed(6)} SOL`);
  console.log(`  USDC:    ${usdcBalance.toFixed(6)} USDC`);
  console.log(`  JitoSOL: ${jitoSolBalance.toFixed(6)} JitoSOL`);
  hr();

  if (solBalance < 0.01) {
    console.error('❌ Insufficient SOL for transaction fees');
    process.exit(1);
  }

  return { solBalance, usdcBalance, jitoSolBalance };
}

// ============================================================================
// Step 2: Kamino Position Check
// ============================================================================

async function checkKaminoPosition() {
  console.log('\n📊 STEP 2: Kamino Position');
  hr();

  try {
    const { getPosition, getApys, checkLtvHealth } = await import('../src/launchkit/cfo/kaminoService.ts');

    const pos = await getPosition();
    console.log('  Deposits:');
    if (pos.deposits.length === 0) {
      console.log('    (none)');
    } else {
      for (const d of pos.deposits) {
        console.log(`    ${d.asset}: ${d.amount.toFixed(6)} ($${d.valueUsd.toFixed(2)}) | APY: ${(d.apy * 100).toFixed(1)}%`);
      }
    }

    console.log('  Borrows:');
    if (pos.borrows.length === 0) {
      console.log('    (none)');
    } else {
      for (const b of pos.borrows) {
        console.log(`    ${b.asset}: ${b.amount.toFixed(6)} ($${b.valueUsd.toFixed(2)}) | APY: ${(b.apy * 100).toFixed(1)}%`);
      }
    }

    console.log(`  Net Value:      $${pos.netValueUsd.toFixed(2)}`);
    console.log(`  LTV:            ${(pos.ltv * 100).toFixed(1)}%`);
    console.log(`  Health Factor:  ${pos.healthFactor.toFixed(2)}`);

    const health = await checkLtvHealth();
    console.log(`  LTV Health:     ${health.safe ? '✅ SAFE' : `⚠️ ${health.warning}`}`);

    const apys = await getApys();
    console.log('\n  Market APYs:');
    for (const [asset, apy] of Object.entries(apys)) {
      console.log(`    ${asset.padEnd(8)} Supply: ${(apy.supplyApy * 100).toFixed(1)}% | Borrow: ${(apy.borrowApy * 100).toFixed(1)}%`);
    }
    hr();

    return pos;
  } catch (err) {
    console.error('  ❌ Kamino position check failed:', (err as Error).message);
    hr();
    return null;
  }
}

// ============================================================================
// Step 3: Orca Position Check
// ============================================================================

async function checkOrcaPositions() {
  console.log('\n📊 STEP 3: Orca LP Positions');
  hr();

  try {
    const { getPositions } = await import('../src/launchkit/cfo/orcaService.ts');
    const positions = await getPositions();

    if (positions.length === 0) {
      console.log('  (no open positions)');
    } else {
      for (const p of positions) {
        console.log(`  Position: ${p.positionMint.slice(0, 12)}...`);
        console.log(`    Range:   $${p.lowerPrice.toFixed(2)} – $${p.upperPrice.toFixed(2)}`);
        console.log(`    Current: $${p.currentPrice.toFixed(2)} ${p.inRange ? '✅ IN RANGE' : '❌ OUT OF RANGE'}`);
        console.log(`    Util:    ${p.rangeUtilisationPct.toFixed(0)}%`);
      }
    }
    hr();
    return positions;
  } catch (err) {
    console.error('  ❌ Orca position check failed:', (err as Error).message);
    hr();
    return [];
  }
}

// ============================================================================
// Step 4: Deposit JitoSOL into Kamino (create collateral)
// ============================================================================

async function testDeposit() {
  console.log('\n🔧 STEP 4: Deposit JitoSOL into Kamino');
  hr();
  console.log(`  Depositing ${TEST_DEPOSIT_JITOSOL} JitoSOL as collateral...`);

  try {
    const { deposit } = await import('../src/launchkit/cfo/kaminoService.ts');
    const result = await deposit('JitoSOL', TEST_DEPOSIT_JITOSOL);

    if (result.success) {
      console.log(`  ✅ Deposit SUCCESS`);
      console.log(`  TX: ${result.txSignature}`);
      console.log(`  Amount: ${result.amountDeposited} JitoSOL`);
    } else {
      console.log(`  ❌ Deposit FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Deposit threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 5: Test Borrow
// ============================================================================

async function testBorrow() {
  console.log('\n🔧 STEP 5: Test Kamino Borrow');
  hr();
  console.log(`  Borrowing ${TEST_BORROW_USDC} USDC against JitoSOL collateral...`);

  try {
    const { borrow } = await import('../src/launchkit/cfo/kaminoService.ts');
    const result = await borrow('USDC', TEST_BORROW_USDC);

    if (result.success) {
      console.log(`  ✅ Borrow SUCCESS`);
      console.log(`  TX: ${result.txSignature}`);
      console.log(`  Amount: ${result.amountBorrowed} USDC`);
    } else {
      console.log(`  ❌ Borrow FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Borrow threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 6: Test Repay
// ============================================================================

async function testRepay() {
  console.log('\n🔧 STEP 6: Test Kamino Repay');
  hr();
  console.log(`  Repaying ${TEST_BORROW_USDC} USDC...`);

  try {
    const { repay } = await import('../src/launchkit/cfo/kaminoService.ts');
    const result = await repay('USDC', TEST_BORROW_USDC);

    if (result.success) {
      console.log(`  ✅ Repay SUCCESS`);
      console.log(`  TX: ${result.txSignature}`);
      console.log(`  Amount: ${result.amountRepaid} USDC`);
    } else {
      console.log(`  ❌ Repay FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Repay threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 7: Test Orca LP Open
// ============================================================================

async function testOrcaOpen() {
  console.log('\n🔧 STEP 7: Test Orca LP Open');
  hr();
  console.log(`  Opening LP: ${TEST_ORCA_USDC} USDC + ${TEST_ORCA_SOL} SOL, range ±${ORCA_RANGE_WIDTH_PCT / 2}%`);

  try {
    const { openPosition } = await import('../src/launchkit/cfo/orcaService.ts');
    const result = await openPosition(TEST_ORCA_USDC, TEST_ORCA_SOL, ORCA_RANGE_WIDTH_PCT);

    if (result.success) {
      console.log(`  ✅ Orca LP Open SUCCESS`);
      console.log(`  Position Mint: ${result.positionMint}`);
      console.log(`  TX: ${result.txSignature}`);
      console.log(`  Range: $${result.lowerPrice?.toFixed(2)} – $${result.upperPrice?.toFixed(2)}`);
    } else {
      console.log(`  ❌ Orca LP Open FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Orca LP Open threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 8: Test Orca LP Close (cleanup)
// ============================================================================

async function testOrcaClose(positionMint: string) {
  console.log('\n🔧 STEP 8: Test Orca LP Close');
  hr();
  console.log(`  Closing position ${positionMint.slice(0, 12)}...`);

  try {
    const { closePosition } = await import('../src/launchkit/cfo/orcaService.ts');
    const result = await closePosition(positionMint);

    if (result.success) {
      console.log(`  ✅ Orca Close SUCCESS`);
      console.log(`  TX: ${result.txSignature}`);
    } else {
      console.log(`  ❌ Orca Close FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Orca Close threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 9: Withdraw JitoSOL from Kamino (cleanup)
// ============================================================================

async function testWithdraw() {
  console.log('\n🔧 STEP 9: Withdraw JitoSOL from Kamino (cleanup)');
  hr();
  console.log(`  Withdrawing ${TEST_DEPOSIT_JITOSOL} JitoSOL...`);

  try {
    const { withdraw } = await import('../src/launchkit/cfo/kaminoService.ts');
    const result = await withdraw('JitoSOL', TEST_DEPOSIT_JITOSOL);

    if (result.success) {
      console.log(`  ✅ Withdraw SUCCESS`);
      console.log(`  TX: ${result.txSignature}`);
    } else {
      console.log(`  ❌ Withdraw FAILED: ${result.error}`);
    }
    hr();
    return result;
  } catch (err) {
    console.error(`  ❌ Withdraw threw: ${(err as Error).message}`);
    hr();
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Step 10: Post-test verification
// ============================================================================

async function postTestVerify() {
  console.log('\n📊 STEP 10: Post-Test Verification');
  hr();

  const solBalance = await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
  const usdcBalance = await getTokenBalance(USDC_MINT);
  const jitoSolBalance = await getTokenBalance(JITOSOL_MINT);
  console.log(`  SOL:     ${solBalance.toFixed(6)}`);
  console.log(`  USDC:    ${usdcBalance.toFixed(6)}`);
  console.log(`  JitoSOL: ${jitoSolBalance.toFixed(6)}`);

  try {
    const { getPosition } = await import('../src/launchkit/cfo/kaminoService.ts');
    const pos = await getPosition();
    console.log(`  Kamino Net:     $${pos.netValueUsd.toFixed(2)}`);
    console.log(`  Kamino LTV:     ${(pos.ltv * 100).toFixed(1)}%`);
    console.log(`  Kamino Deposits: ${pos.deposits.length > 0 ? pos.deposits.map(d => `${d.amount.toFixed(4)} ${d.asset}`).join(', ') : 'none'}`);
    console.log(`  Kamino Borrows: ${pos.borrows.length > 0 ? pos.borrows.map(b => `${b.amount.toFixed(4)} ${b.asset}`).join(', ') : 'none'}`);
  } catch {}

  try {
    const { getPositions } = await import('../src/launchkit/cfo/orcaService.ts');
    const orcaPos = await getPositions();
    console.log(`  Orca Positions: ${orcaPos.length}`);
  } catch {}

  hr();
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  // Always check balances
  const balances = await checkBalances();

  // Always check Kamino position
  const kaminoPos = await checkKaminoPosition();

  // Always check Orca positions
  await checkOrcaPositions();

  if (CHECK_ONLY) {
    console.log('\n✅ Check-only mode complete.');
    return;
  }

  // ── Flow: Deposit JitoSOL → Borrow USDC → [Orca LP] → [Close LP] → Repay → Withdraw ──

  // Step 4: Deposit JitoSOL as collateral
  if (balances.jitoSolBalance < TEST_DEPOSIT_JITOSOL) {
    console.error(`\n❌ Insufficient JitoSOL: have ${balances.jitoSolBalance}, need ${TEST_DEPOSIT_JITOSOL}`);
    process.exit(1);
  }

  const depositResult = await testDeposit();
  if (!depositResult.success) {
    console.error('\n❌ Deposit failed — cannot proceed with borrow/LP tests.');
    process.exit(1);
  }

  // Wait for chain to settle
  console.log('  ⏳ Waiting 5s for deposit to settle...\n');
  await new Promise(r => setTimeout(r, 5000));

  // Step 5: Borrow USDC against JitoSOL
  const borrowResult = await testBorrow();

  if (borrowResult.success) {
    console.log('  ⏳ Waiting 5s for borrow to settle...\n');
    await new Promise(r => setTimeout(r, 5000));

    // Step 7: Open Orca LP (if not borrow-only)
    let orcaPositionMint: string | undefined;
    if (!BORROW_ONLY) {
      const orcaResult = await testOrcaOpen();
      if (orcaResult.success && orcaResult.positionMint) {
        orcaPositionMint = orcaResult.positionMint;

        // Wait and close
        console.log('  ⏳ Waiting 5s before closing Orca position...\n');
        await new Promise(r => setTimeout(r, 5000));

        if (!ORCA_ONLY) {
          // Step 8: Close Orca LP
          await testOrcaClose(orcaPositionMint);
          console.log('  ⏳ Waiting 3s...\n');
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!ORCA_ONLY) {
      // Step 6: Repay USDC borrow
      await testRepay();
      console.log('  ⏳ Waiting 3s...\n');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!ORCA_ONLY) {
    // Step 9: Withdraw JitoSOL from Kamino (cleanup)
    await testWithdraw();
    console.log('  ⏳ Waiting 3s...\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 10: Final verification
  await postTestVerify();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Test suite complete in ${elapsed}s`);
}

main().catch(err => {
  console.error('💥 Test suite crashed:', err);
  process.exit(1);
});
