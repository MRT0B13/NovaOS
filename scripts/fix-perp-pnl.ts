/**
 * fix-perp-pnl.ts — Correct inflated realized_pnl_usd on closed HL perp/hedge positions.
 *
 * Bug: closeReceivedUsd was computed as  sizeUsd (notional) + unrealizedPnl
 *      but costBasisUsd stored only the margin (sizeUsd / leverage).
 *      So realizedPnl = notional + PnL - margin = margin*(leverage-1) + actualPnL
 *      The inflation = costBasisUsd * (leverage - 1).
 *
 * Fix:  corrected_pnl = old_realized_pnl - cost_basis_usd * (leverage - 1)
 *
 * Usage: DATABASE_URL=... bun run scripts/fix-perp-pnl.ts [--dry-run]
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Find all CLOSED positions with leverage in metadata for perp strategies
    const res = await pool.query(`
      SELECT id, strategy, asset, cost_basis_usd, realized_pnl_usd,
             metadata->>'leverage' AS leverage,
             metadata->>'coin' AS coin,
             metadata->>'side' AS side,
             opened_at, closed_at
      FROM cfo_positions
      WHERE status = 'CLOSED'
        AND strategy IN ('hl_perp', 'hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing', 'hyperliquid')
        AND (metadata->>'leverage')::numeric > 1
      ORDER BY closed_at DESC
    `);

    if (res.rows.length === 0) {
      console.log('No closed leveraged positions found — nothing to fix.');
      return;
    }

    console.log(`Found ${res.rows.length} closed leveraged position(s) to correct:\n`);
    console.log('ID                              | Strategy      | Asset       | Margin   | Old PnL  | New PnL  | Leverage');
    console.log('--------------------------------|---------------|-------------|----------|----------|----------|--------');

    let totalOldPnl = 0;
    let totalNewPnl = 0;
    const updates: { id: string; newPnl: number }[] = [];

    for (const row of res.rows) {
      const leverage = Number(row.leverage);
      const costBasis = Number(row.cost_basis_usd);
      const oldPnl = Number(row.realized_pnl_usd);
      // The inflation amount = cost_basis * (leverage - 1)
      const inflation = costBasis * (leverage - 1);
      const newPnl = oldPnl - inflation;

      totalOldPnl += oldPnl;
      totalNewPnl += newPnl;
      updates.push({ id: row.id, newPnl });

      const sign = (v: number) => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
      console.log(
        `${row.id.padEnd(32)}| ${row.strategy.padEnd(14)}| ${row.asset.padEnd(12)}| $${costBasis.toFixed(2).padStart(7)}| ${sign(oldPnl).padStart(8)}| ${sign(newPnl).padStart(8)}| ${leverage}x`
      );
    }

    console.log(`\nTotal old PnL: $${totalOldPnl.toFixed(2)}`);
    console.log(`Total new PnL: $${totalNewPnl.toFixed(2)}`);
    console.log(`Inflation removed: $${(totalOldPnl - totalNewPnl).toFixed(2)}`);

    if (dryRun) {
      console.log('\n🔍 DRY RUN — no changes made. Remove --dry-run to apply.');
      return;
    }

    // Apply corrections
    console.log('\nApplying corrections...');
    let fixed = 0;
    for (const { id, newPnl } of updates) {
      await pool.query(
        `UPDATE cfo_positions SET realized_pnl_usd = $1, updated_at = NOW() WHERE id = $2`,
        [newPnl, id],
      );
      fixed++;
    }
    console.log(`✅ Fixed ${fixed} position(s).`);

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
