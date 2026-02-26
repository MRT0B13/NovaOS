#!/usr/bin/env bun
/**
 * Backfill & Consolidate Polymarket positions in cfo_positions.
 *
 * Problem: Each POLY_BET order creates a separate cfo_positions row.
 * The position monitor checks per-row loss (e.g. $3 cost → $2.89 value = 4% loss)
 * but the AGGREGATE position is $10.79 → $2.89 = 73% loss — should trigger stop-loss.
 *
 * This script:
 * 1. Fetches live positions from Polymarket Data API (aggregate view)
 * 2. For each API position, finds ALL matching DB rows (by tokenId/asset)
 * 3. Consolidates fragmented rows into a single row per position
 * 4. Updates with API's aggregate cost basis and current value
 * 5. Closes $0 expired positions and cleans up test rows
 *
 * Safe to run multiple times — idempotent.
 *
 * Run: DATABASE_URL=... bun run scripts/backfill-poly-positions.ts
 *
 * Flags:
 *   --dry-run   Show what would change without writing to DB
 */

import { Pool } from 'pg';

// ── Config ──────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const POLY_WALLET = process.env.CFO_EVM_PRIVATE_KEY
  ? await deriveAddress(process.env.CFO_EVM_PRIVATE_KEY)
  : process.env.POLYMARKET_WALLET_ADDRESS;

if (!POLY_WALLET) {
  console.error('❌ Need CFO_EVM_PRIVATE_KEY or POLYMARKET_WALLET_ADDRESS');
  process.exit(1);
}

async function deriveAddress(privateKey: string): Promise<string> {
  try {
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(privateKey);
    return wallet.address;
  } catch {
    return '';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

interface DataApiPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  outcome: string;
  endDate: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔄 Polymarket Position Consolidation${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Wallet: ${POLY_WALLET}`);
  console.log(`   DB: ${DATABASE_URL!.replace(/:[^@]+@/, ':***@')}\n`);

  // 1. Fetch live positions from Polymarket Data API
  console.log('📡 Fetching positions from Polymarket Data API...');
  const resp = await fetch(
    `https://data-api.polymarket.com/positions?user=${POLY_WALLET}`,
  );
  if (!resp.ok) {
    console.error(`❌ Data API returned ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }

  const raw: DataApiPosition[] = await resp.json();
  const apiPositions = raw.filter((p) => Number(p.size) > 0);
  console.log(`   Found ${apiPositions.length} positions from API\n`);

  // 2. Connect to DB
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: false,
  });

  try {
    // 3. Get all open polymarket positions from DB
    const dbRes = await pool.query(
      `SELECT id, asset, description, cost_basis_usd, current_value_usd, metadata
       FROM cfo_positions
       WHERE strategy = 'polymarket' AND status = 'OPEN'
       ORDER BY asset, opened_at ASC`,
    );

    console.log(`📊 DB has ${dbRes.rows.length} open polymarket rows\n`);

    // Group DB rows by asset (tokenId)
    const dbByAsset = new Map<string, any[]>();
    for (const row of dbRes.rows) {
      const arr = dbByAsset.get(row.asset) ?? [];
      arr.push(row);
      dbByAsset.set(row.asset, arr);
    }

    let consolidated = 0;
    let updated = 0;
    let closedExpired = 0;
    let inserted = 0;
    let duplicatesRemoved = 0;

    // ── Clean up test rows ──────────────────────────────────────────────
    const testRows = dbRes.rows.filter((r: any) => r.id.startsWith('test_'));
    if (testRows.length > 0) {
      console.log(`🧹 Cleaning ${testRows.length} test row(s)...`);
      if (!DRY_RUN) {
        await pool.query(
          `DELETE FROM cfo_positions WHERE id LIKE 'test_%'`,
        );
      }
      for (const r of testRows) {
        console.log(`   🗑  ${r.id}`);
      }
      console.log();
    }

    // ── Process each API position ───────────────────────────────────────
    for (const apiPos of apiPositions) {
      const tokenId = apiPos.asset;
      const costBasis = Number(apiPos.initialValue ?? 0);
      const currentValue = Number(apiPos.currentValue ?? 0);
      const curPrice = Number(apiPos.curPrice ?? 0);
      const avgPrice = Number(apiPos.avgPrice ?? 0);
      const size = Number(apiPos.size);
      const pnl = Number(apiPos.cashPnl ?? (currentValue - costBasis));
      const lossPct = costBasis > 0 ? ((costBasis - currentValue) / costBasis * 100) : 0;
      const question = apiPos.title ?? apiPos.conditionId.slice(0, 20);
      const isExpired = currentValue === 0 && curPrice <= 0.01;

      const statusEmoji = isExpired ? '💀' : lossPct > 60 ? '🔴' : lossPct > 30 ? '🟡' : '🟢';
      console.log(
        `${statusEmoji} ${apiPos.outcome.padEnd(3)} | cost=$${costBasis.toFixed(2).padStart(6)} val=$${currentValue.toFixed(2).padStart(6)} ` +
        `(${lossPct > 0 ? '-' : '+'}${Math.abs(lossPct).toFixed(1)}%) | ${question.slice(0, 55)}`,
      );

      const dbRows = dbByAsset.get(tokenId) ?? [];

      // ── Case 1: Expired/zero-value — close all DB rows ───────────────
      if (isExpired) {
        if (dbRows.length > 0) {
          console.log(`   💀 Closing ${dbRows.length} DB row(s) (expired, value=$0)`);
          if (!DRY_RUN) {
            for (const r of dbRows) {
              await pool.query(
                `UPDATE cfo_positions SET status = 'CLOSED', current_value_usd = 0,
                   current_price = 0, unrealized_pnl_usd = -cost_basis_usd,
                   realized_pnl_usd = -cost_basis_usd, closed_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [r.id],
              );
            }
          }
          closedExpired += dbRows.length;
        } else {
          console.log(`   💀 Not in DB — skipping expired position`);
        }
        continue;
      }

      // ── Case 2: Multiple DB rows → consolidate into one ──────────────
      if (dbRows.length > 1) {
        const keepRow = dbRows[0]; // keep the oldest
        const removeRows = dbRows.slice(1);

        console.log(
          `   🔀 Consolidating ${dbRows.length} rows → 1 (keep ${keepRow.id.slice(0, 30)}...)`,
        );
        console.log(
          `      DB aggregate cost: $${dbRows.reduce((s: number, r: any) => s + Number(r.cost_basis_usd), 0).toFixed(2)} → API cost: $${costBasis.toFixed(2)}`,
        );

        if (!DRY_RUN) {
          // Delete duplicate rows
          for (const r of removeRows) {
            await pool.query('DELETE FROM cfo_positions WHERE id = $1', [r.id]);
          }
          duplicatesRemoved += removeRows.length;

          // Update kept row with API aggregate values
          await pool.query(
            `UPDATE cfo_positions SET
               cost_basis_usd = $1, current_value_usd = $2, current_price = $3,
               entry_price = $4, size_units = $5, unrealized_pnl_usd = $6,
               description = $7,
               metadata = metadata || $8::jsonb,
               updated_at = NOW()
             WHERE id = $9`,
            [
              costBasis, currentValue, curPrice, avgPrice, size, pnl,
              `${apiPos.outcome} | ${question.slice(0, 80)}`,
              JSON.stringify({ consolidatedAt: new Date().toISOString(), endDate: apiPos.endDate }),
              keepRow.id,
            ],
          );
        }
        consolidated++;
        continue;
      }

      // ── Case 3: Single DB row → update with API values ───────────────
      if (dbRows.length === 1) {
        const row = dbRows[0];
        const dbCost = Number(row.cost_basis_usd);

        // Check if cost basis differs significantly (fragmented orders vs API aggregate)
        if (Math.abs(dbCost - costBasis) > 0.5) {
          console.log(
            `   📝 Updating cost basis: $${dbCost.toFixed(2)} → $${costBasis.toFixed(2)} (API aggregate)`,
          );
        } else {
          console.log(`   ✅ Already synced`);
        }

        if (!DRY_RUN) {
          await pool.query(
            `UPDATE cfo_positions SET
               cost_basis_usd = $1, current_value_usd = $2, current_price = $3,
               entry_price = $4, size_units = $5, unrealized_pnl_usd = $6,
               metadata = metadata || $7::jsonb,
               updated_at = NOW()
             WHERE id = $8`,
            [
              costBasis, currentValue, curPrice, avgPrice, size, pnl,
              JSON.stringify({ syncedAt: new Date().toISOString(), endDate: apiPos.endDate }),
              row.id,
            ],
          );
        }
        updated++;
        continue;
      }

      // ── Case 4: No DB row → insert new ───────────────────────────────
      const id = `poly-${apiPos.conditionId.slice(0, 12)}-backfill`;
      const now = new Date().toISOString();
      console.log(`   ➕ New position — inserting ${id}`);

      if (!DRY_RUN) {
        await pool.query(
          `INSERT INTO cfo_positions (
            id, strategy, asset, description, chain, status,
            entry_price, current_price, size_units,
            cost_basis_usd, current_value_usd, realized_pnl_usd, unrealized_pnl_usd,
            entry_tx_hash, exit_tx_hash, external_id, metadata,
            opened_at, closed_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (id) DO NOTHING`,
          [
            id, 'polymarket', tokenId,
            `${apiPos.outcome} | ${question.slice(0, 80)}`,
            'polygon', 'OPEN',
            avgPrice, curPrice, size,
            costBasis, currentValue, 0, pnl,
            null, null, apiPos.conditionId,
            JSON.stringify({
              conditionId: apiPos.conditionId, tokenId,
              outcome: apiPos.outcome, endDate: apiPos.endDate,
              backfilledAt: now,
            }),
            now, null, now,
          ],
        );
      }
      inserted++;
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📊 Summary:`);
    console.log(`   ${consolidated} consolidated (${duplicatesRemoved} duplicate rows removed)`);
    console.log(`   ${updated} updated with API aggregate values`);
    console.log(`   ${inserted} new positions inserted`);
    console.log(`   ${closedExpired} expired positions closed`);
    console.log(`   ${testRows.length} test rows cleaned`);

    if (!DRY_RUN) {
      // Show final state
      const finalRes = await pool.query(
        `SELECT id, LEFT(description, 55) as descr, cost_basis_usd as cost,
                current_value_usd as val, status
         FROM cfo_positions
         WHERE strategy = 'polymarket'
         ORDER BY status, current_value_usd ASC`,
      );

      console.log(`\n🔍 Final DB state (${finalRes.rows.length} rows):`);
      for (const r of finalRes.rows) {
        const cost = Number(r.cost);
        const val = Number(r.val);
        const loss = cost > 0 ? ((cost - val) / cost * 100) : 0;
        const emoji = r.status === 'CLOSED' ? '⬛'
          : loss > 60 ? '🔴 STOP-LOSS'
          : loss > 30 ? '🟡 WATCH'
          : '🟢 OK       ';
        console.log(
          `   ${r.status.padEnd(6)} ${emoji} | $${cost.toFixed(2).padStart(6)} → $${val.toFixed(2).padStart(6)} | ${r.descr}`,
        );
      }
      console.log(`\n⏰ Monitor will trigger stop-loss on next 10-minute cycle for positions down >60%\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
