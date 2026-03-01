#!/usr/bin/env bun
/**
 * Smoke test for Krystal LP fixes:
 * 1. getMultiChainEvmBalances() — verifies USDC, USDC.e, WETH, native all tracked
 * 2. fetchKrystalPositions() — verifies on-chain NFPM fallback for DB-tracked positions
 * 3. DB kv_store — checks what EVM LP records exist
 */

import 'dotenv/config';
import { Pool } from 'pg';

const WALLET = '0x77889eAac9ca631cB2874fdEf06C4F60BBc433f8';
const DB_URL = process.env.DATABASE_URL!;

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Krystal Fix Smoke Test');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Test 1: Multi-chain EVM balance scan ──────────────────────
  console.log('▶ Test 1: getMultiChainEvmBalances()');
  console.log('  Expected: Each chain shows USDC + USDC.e + WETH + native + totalValueUsd');
  console.log('  Base should show ~$140+ (not $2)\n');

  try {
    const krystal = await import('../src/launchkit/cfo/krystalService.ts');
    const balances = await krystal.getMultiChainEvmBalances();

    if (balances.length === 0) {
      console.log('  ❌ No chain balances returned — check EVM RPC config\n');
    } else {
      let totalAllChains = 0;
      for (const b of balances) {
        console.log(`  ${b.chainName} (${b.chainId}):`);
        console.log(`    Native USDC:   $${b.usdcBalance.toFixed(2)}`);
        console.log(`    Bridged USDC:  $${b.usdcBridgedBalance.toFixed(2)}`);
        console.log(`    Total Stable:  $${b.totalStableUsd.toFixed(2)}`);
        console.log(`    WETH:          ${b.wethBalance.toFixed(6)} ($${b.wethValueUsd.toFixed(2)})`);
        console.log(`    Native:        ${b.nativeBalance.toFixed(6)} ${b.nativeSymbol} ($${b.nativeValueUsd.toFixed(2)})`);
        console.log(`    ─── Total:     $${b.totalValueUsd.toFixed(2)}`);
        console.log();
        totalAllChains += b.totalValueUsd;
      }
      console.log(`  ✅ Grand total across ${balances.length} chains: $${totalAllChains.toFixed(2)}\n`);

      // Specific Base check
      const base = balances.find(b => b.chainId === 8453);
      if (base) {
        if (base.totalValueUsd > 50) {
          console.log(`  ✅ Base total $${base.totalValueUsd.toFixed(0)} — looks correct (was showing $2)`);
        } else {
          console.log(`  ⚠️  Base total only $${base.totalValueUsd.toFixed(2)} — may still be under-counting`);
        }
      } else {
        console.log('  ⚠️  Base chain not found in results');
      }
    }
  } catch (err) {
    console.log(`  ❌ Error: ${(err as Error).message}\n`);
  }

  console.log('\n───────────────────────────────────────────────────────\n');

  // ── Test 2: DB kv_store EVM LP records ────────────────────────
  console.log('▶ Test 2: EVM LP records in kv_store');
  let dbRecords: any[] = [];

  try {
    const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } as any });
    const res = await pool.query(`SELECT key, data FROM kv_store WHERE key LIKE 'cfo_evm_lp_%'`);

    if (res.rows.length === 0) {
      console.log('  ⚠️  No EVM LP records in kv_store — NFPM fallback will have nothing to scan');
      console.log('  (This is expected if no positions have been opened yet)\n');
    } else {
      console.log(`  Found ${res.rows.length} EVM LP record(s):\n`);
      for (const row of res.rows) {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        console.log(`    Key:       ${row.key}`);
        console.log(`    posId:     ${data.posId}`);
        console.log(`    chain:     ${data.chainName} (${data.chainNumericId})`);
        console.log(`    pool:      ${data.poolAddress?.slice(0, 20)}...`);
        console.log(`    pair:      ${data.token0Symbol}/${data.token1Symbol}`);
        console.log(`    entryUsd:  $${data.entryUsd}`);
        console.log(`    openedAt:  ${new Date(data.openedAt).toISOString()}`);
        console.log();
        dbRecords.push(data);
      }
    }
    await pool.end();
  } catch (err) {
    console.log(`  ❌ DB error: ${(err as Error).message}\n`);
  }

  console.log('───────────────────────────────────────────────────────\n');

  // ── Test 3: fetchKrystalPositions with NFPM fallback ──────────
  console.log('▶ Test 3: fetchKrystalPositions() — on-chain NFPM fallback');
  console.log(`  Wallet: ${WALLET}`);
  console.log(`  DB records to fall back on: ${dbRecords.length}\n`);

  try {
    const krystal = await import('../src/launchkit/cfo/krystalService.ts');
    // Provide DB records so the fallback has something to work with
    const positions = await krystal.fetchKrystalPositions(WALLET, dbRecords.length > 0 ? dbRecords : undefined);

    if (positions.length === 0) {
      if (dbRecords.length === 0) {
        console.log('  ℹ️  No positions found (no DB records either — expected if none opened yet)');
      } else {
        console.log('  ❌ No positions returned despite DB records — NFPM fallback may have failed');
        console.log('     Check if positions were closed on-chain (0 liquidity)');
      }
    } else {
      console.log(`  Found ${positions.length} position(s):\n`);
      for (const p of positions) {
        const rangeIcon = p.inRange ? '🟢' : '🔴';
        console.log(`    ${rangeIcon} ${p.token0.symbol}/${p.token1.symbol} on ${p.chainName}`);
        console.log(`       posId:    ${p.posId}`);
        console.log(`       value:    $${p.valueUsd.toFixed(2)}`);
        console.log(`       ticks:    [${p.tickLower}, ${p.tickUpper}] current=${p.currentTick}`);
        console.log(`       util:     ${p.rangeUtilisationPct.toFixed(0)}%`);
        console.log(`       fees:     $${p.feesOwedUsd.toFixed(4)} (${p.feesOwed0.toFixed(6)} ${p.token0.symbol} + ${p.feesOwed1.toFixed(6)} ${p.token1.symbol})`);
        console.log(`       pool:     ${p.poolAddress}`);
        console.log(`       protocol: ${p.protocol}`);
        console.log(`       opened:   ${new Date(p.openedAt).toISOString()}`);
        console.log();
      }
      console.log(`  ✅ Positions would appear in CFO report`);
    }
  } catch (err) {
    console.log(`  ❌ Error: ${(err as Error).message}`);
    console.error(err);
  }

  console.log('\n───────────────────────────────────────────────────────\n');

  // ── Test 4: What the report line would look like ──────────────
  console.log('▶ Test 4: Simulated report line');
  try {
    const krystal = await import('../src/launchkit/cfo/krystalService.ts');
    const balances = await krystal.getMultiChainEvmBalances();
    const chainsWithValue = balances.filter(b => b.totalValueUsd > 1);
    if (chainsWithValue.length > 0) {
      const chainParts = chainsWithValue.map(b => {
        const parts: string[] = [];
        if (b.totalStableUsd > 0.5) parts.push(`$${b.totalStableUsd.toFixed(0)} USDC`);
        if (b.wethValueUsd > 0.5) parts.push(`$${b.wethValueUsd.toFixed(0)} W${b.nativeSymbol}`);
        if (b.nativeValueUsd > 0.5) parts.push(`$${b.nativeValueUsd.toFixed(0)} ${b.nativeSymbol}`);
        return `${b.chainName}: ${parts.join(' + ')} ($${b.totalValueUsd.toFixed(0)})`;
      });
      console.log(`  Before: "EVM USDC: $2 base, $55 polygon"`);
      console.log(`  After:  "EVM wallets: ${chainParts.join(' · ')}"`);
    }
  } catch { /* */ }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Done');
  console.log('═══════════════════════════════════════════════════════');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
