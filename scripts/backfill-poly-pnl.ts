#!/usr/bin/env bun
/**
 * Backfill Polymarket PnL for closed positions.
 *
 * Bug: All closed Polymarket positions had realized_pnl = -cost_basis (i.e. $0 received)
 * because when positions disappeared from the API, the EXPIRE handler closed them with $0
 * instead of querying the market resolution.
 *
 * This script:
 * 1. Fetches all CLOSED polymarket positions with realized_pnl = -cost_basis
 * 2. Queries the Gamma API for each market's resolution
 * 3. If the market resolved and our side won: sets realized_pnl = sizeUnits * 1.0 - costBasis
 *    (each winning Polymarket token is worth $1 USDC)
 * 4. If the market resolved and our side lost: leaves PnL as is (correct at -cost_basis)
 * 5. If not resolved: reports as needing manual review
 */

const CLOB_BASE = 'https://clob.polymarket.com';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:budQTGqhASnqCj3CoFZSVd0sXjn0sHdZ@hopper.proxy.rlwy.net:56852/railway';

async function queryResolution(conditionId: string): Promise<{ resolved: boolean; winningOutcome?: string }> {
  try {
    const resp = await fetch(`${CLOB_BASE}/markets/${conditionId}`);
    if (!resp.ok) return { resolved: false };
    const data = await resp.json() as any;
    if (!data.closed) return { resolved: false };
    const winner = data.tokens?.find((t: any) => t.winner);
    if (winner) return { resolved: true, winningOutcome: winner.outcome };
    return { resolved: true };
  } catch (err) {
    console.log(`   ⚠️ CLOB API error: ${(err as Error).message}`);
    return { resolved: false };
  }
}

async function main() {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: DATABASE_URL });

  console.log('Fetching closed Polymarket positions with suspect PnL...\n');

  const { rows } = await pool.query(`
    SELECT id, description, cost_basis_usd, size_units, realized_pnl_usd,
           metadata->>'conditionId' as condition_id,
           metadata->>'outcome' as outcome,
           metadata->>'tokenId' as token_id
    FROM cfo_positions
    WHERE strategy = 'polymarket' AND status = 'CLOSED'
      AND realized_pnl_usd <= -cost_basis_usd * 0.99
    ORDER BY closed_at DESC
  `);

  console.log(`Found ${rows.length} positions with total-loss PnL.\n`);

  let corrected = 0;
  let confirmedLoss = 0;
  let unresolved = 0;

  for (const row of rows) {
    const { id, description, cost_basis_usd, size_units, condition_id, outcome } = row;
    const costBasis = Number(cost_basis_usd);
    const sizeUnits = Number(size_units);
    const ourOutcome = description.split(' | ')[0]?.trim(); // "Yes" or "No"

    console.log(`\n── ${description.slice(0, 70)}`);
    console.log(`   Cost: $${costBasis.toFixed(2)} | Shares: ${sizeUnits.toFixed(2)} | Outcome: ${ourOutcome}`);

    if (!condition_id) {
      console.log('   ⚠️ No conditionId — skipping');
      unresolved++;
      continue;
    }

    // Query CLOB API for market resolution
    try {
      const resolution = await queryResolution(condition_id);

      if (!resolution.resolved) {
        console.log(`   ℹ️ Market not resolved yet — position was closed prematurely`);
        unresolved++;
        continue;
      }

      const winnerOutcome = resolution.winningOutcome;
      console.log(`   Winner: ${winnerOutcome ?? 'unknown'} | Our bet: ${ourOutcome}`);

      if (!winnerOutcome) {
        console.log('   ⚠️ Could not determine winner');
        unresolved++;
        continue;
      }

      const ourSideWon = winnerOutcome.toLowerCase() === (ourOutcome ?? '').toLowerCase();

      if (ourSideWon) {
        // Each winning token = $1 USDC
        const receivedUsd = sizeUnits; // sizeUnits tokens × $1 each
        const correctPnl = receivedUsd - costBasis;
        console.log(`   ✅ WON! Correct PnL: +$${correctPnl.toFixed(2)} (was -$${costBasis.toFixed(2)})`);

        await pool.query(
          `UPDATE cfo_positions SET realized_pnl_usd = $1, metadata = metadata || '{"pnlBackfilled": true}'::jsonb WHERE id = $2`,
          [correctPnl, id],
        );
        corrected++;
      } else {
        console.log(`   ❌ LOST — PnL correctly recorded as -$${costBasis.toFixed(2)}`);
        confirmedLoss++;
      }
    } catch (err) {
      console.log(`   ⚠️ Error: ${(err as Error).message}`);
      unresolved++;
    }
  }

  console.log('\n════════════════════════════════════════');
  console.log(`Corrected: ${corrected} (winning bets with wrong PnL)`);
  console.log(`Confirmed losses: ${confirmedLoss}`);
  console.log(`Unresolved: ${unresolved}`);
  console.log('════════════════════════════════════════\n');

  await pool.end();
}

main().catch(console.error);
