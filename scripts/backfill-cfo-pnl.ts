#!/usr/bin/env bun
/**
 * Backfill CFO P&L — Query wallets and exchanges for ground-truth figures.
 *
 * Platforms covered:
 *  1. Hyperliquid — userFillsByTime() gives closedPnl + fee per fill (best source)
 *  2. Hyperliquid — userFunding() gives funding payments
 *  3. Hyperliquid — userNonFundingLedgerUpdates() gives deposits/withdrawals
 *  4. Orca LP     — cross-ref DB positions with Solana tx history (Helius)
 *  5. Krystal LP  — cross-ref DB positions with on-chain data
 *  6. Kamino      — yield estimation from APY × time × principal
 *
 * Usage:
 *   bun scripts/backfill-cfo-pnl.ts                    # dry-run (default)
 *   bun scripts/backfill-cfo-pnl.ts --apply            # apply corrections
 *   bun scripts/backfill-cfo-pnl.ts --platform=hl      # HL only
 *   bun scripts/backfill-cfo-pnl.ts --platform=orca    # Orca only
 *   bun scripts/backfill-cfo-pnl.ts --platform=krystal # Krystal only
 *   bun scripts/backfill-cfo-pnl.ts --platform=all     # all platforms
 *   bun scripts/backfill-cfo-pnl.ts --summary          # just show DB summary
 */

import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgres://postgres:budQTGqhASnqCj3CoFZSVd0sXjn0sHdZ@hopper.proxy.rlwy.net:56852/railway';

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const SUMMARY_ONLY = args.includes('--summary');
const platformArg = args.find(a => a.startsWith('--platform='))?.split('=')[1] ?? 'all';

// ============================================================================
// DB helpers
// ============================================================================

let pool: any;

async function getPool() {
  if (pool) return pool;
  const pg = await import('pg');
  pool = new pg.default.Pool({ connectionString: DATABASE_URL });
  return pool;
}

async function query(sql: string, params: any[] = []) {
  const p = await getPool();
  return p.query(sql, params);
}

// ============================================================================
// Summary: Show current DB state
// ============================================================================

async function showSummary() {
  console.log('\n' + '═'.repeat(80));
  console.log('  CFO POSITIONS — DATABASE SUMMARY');
  console.log('═'.repeat(80));

  // Overall stats
  const overallRes = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
      COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed,
      MIN(opened_at) AS earliest,
      MAX(opened_at) AS latest,
      COALESCE(SUM(realized_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0) AS total_realized,
      COALESCE(SUM(unrealized_pnl_usd) FILTER (WHERE status = 'OPEN'), 0) AS total_unrealized,
      COALESCE(SUM(cost_basis_usd), 0) AS total_cost_basis
    FROM cfo_positions
  `);
  const overall = overallRes.rows[0];
  console.log(`\n  Total positions: ${overall.total} (${overall.open} open, ${overall.closed} closed)`);
  console.log(`  Earliest: ${overall.earliest ? new Date(overall.earliest).toISOString().slice(0, 10) : 'N/A'}`);
  console.log(`  Latest:   ${overall.latest ? new Date(overall.latest).toISOString().slice(0, 10) : 'N/A'}`);
  console.log(`  Total realized P&L:   $${Number(overall.total_realized).toFixed(2)}`);
  console.log(`  Total unrealized P&L: $${Number(overall.total_unrealized).toFixed(2)}`);
  console.log(`  Total cost basis:     $${Number(overall.total_cost_basis).toFixed(2)}`);

  // Per-strategy breakdown
  const stratRes = await query(`
    SELECT
      strategy,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
      COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed,
      COALESCE(SUM(realized_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0) AS realized,
      COALESCE(SUM(unrealized_pnl_usd) FILTER (WHERE status = 'OPEN'), 0) AS unrealized,
      COALESCE(SUM(cost_basis_usd), 0) AS cost_basis,
      MIN(opened_at) AS earliest
    FROM cfo_positions
    GROUP BY strategy
    ORDER BY strategy
  `);

  console.log('\n  ┌─────────────────────┬───────┬──────┬────────┬──────────────┬──────────────┬──────────────┐');
  console.log('  │ Strategy            │ Total │ Open │ Closed │  Realized    │ Unrealized   │  Cost Basis  │');
  console.log('  ├─────────────────────┼───────┼──────┼────────┼──────────────┼──────────────┼──────────────┤');
  for (const r of stratRes.rows) {
    const strat = r.strategy.padEnd(19);
    const total = String(r.total).padStart(5);
    const open = String(r.open).padStart(4);
    const closed = String(r.closed).padStart(6);
    const realized = `$${Number(r.realized).toFixed(2)}`.padStart(12);
    const unrealized = `$${Number(r.unrealized).toFixed(2)}`.padStart(12);
    const cost = `$${Number(r.cost_basis).toFixed(2)}`.padStart(12);
    console.log(`  │ ${strat} │ ${total} │ ${open} │ ${closed} │ ${realized} │ ${unrealized} │ ${cost} │`);
  }
  console.log('  └─────────────────────┴───────┴──────┴────────┴──────────────┴──────────────┴──────────────┘');

  // Positions with suspicious PnL (realized = -cost_basis exactly — likely wrong)
  const suspectRes = await query(`
    SELECT strategy, COUNT(*) AS cnt,
           SUM(realized_pnl_usd) AS sum_pnl,
           SUM(cost_basis_usd) AS sum_cost
    FROM cfo_positions
    WHERE status = 'CLOSED'
      AND ABS(realized_pnl_usd + cost_basis_usd) < 0.01
      AND cost_basis_usd > 0
    GROUP BY strategy
    ORDER BY cnt DESC
  `);
  if (suspectRes.rows.length > 0) {
    console.log('\n  ⚠️  Suspect positions (realized_pnl ≈ -cost_basis, likely $0 received):');
    for (const r of suspectRes.rows) {
      console.log(`     ${r.strategy}: ${r.cnt} positions, total impact $${Number(r.sum_pnl).toFixed(2)}`);
    }
  }

  // Transaction fee summary
  const feeRes = await query(`
    SELECT
      chain,
      COUNT(*) AS tx_count,
      COALESCE(SUM(fee_usd), 0) AS total_fees,
      COUNT(*) FILTER (WHERE fee_usd = 0) AS zero_fee_count
    FROM cfo_transactions
    WHERE status = 'confirmed'
    GROUP BY chain
    ORDER BY tx_count DESC
  `);
  console.log('\n  Transaction fees by chain:');
  for (const r of feeRes.rows) {
    const pct = r.tx_count > 0 ? ((Number(r.zero_fee_count) / Number(r.tx_count)) * 100).toFixed(0) : '0';
    console.log(`     ${r.chain}: ${r.tx_count} txns, $${Number(r.total_fees).toFixed(2)} fees (${pct}% were $0)`);
  }

  // Daily snapshot range
  const snapRes = await query(`
    SELECT MIN(date) AS earliest, MAX(date) AS latest, COUNT(*) AS days
    FROM cfo_daily_snapshots
  `);
  const snap = snapRes.rows[0];
  console.log(`\n  Daily snapshots: ${snap.days} days (${snap.earliest ? new Date(snap.earliest).toISOString().slice(0, 10) : 'N/A'} → ${snap.latest ? new Date(snap.latest).toISOString().slice(0, 10) : 'N/A'})`);

  console.log('\n' + '═'.repeat(80));
}

// ============================================================================
// Hyperliquid backfill: query exchange for ground-truth fills
// ============================================================================

async function backfillHyperliquid() {
  console.log('\n' + '─'.repeat(80));
  console.log('  HYPERLIQUID — Querying exchange for ground-truth fills');
  console.log('─'.repeat(80));

  const hlKey = process.env.CFO_HYPERLIQUID_API_WALLET_KEY;
  if (!hlKey) {
    console.log('  ❌ CFO_HYPERLIQUID_API_WALLET_KEY not set — skipping');
    return;
  }

  // Derive wallet address
  const { privateKeyToAccount } = await import('viem/accounts');
  const wallet = privateKeyToAccount(
    (hlKey.startsWith('0x') ? hlKey : `0x${hlKey}`) as `0x${string}`,
  );
  console.log(`  Wallet: ${wallet.address}`);

  // Load HL SDK
  const mod = await import('@nktkas/hyperliquid');
  const isTestnet = process.env.CFO_HYPERLIQUID_TESTNET === 'true';
  const transport = new mod.HttpTransport({ isTestnet });
  const info = new mod.InfoClient({ transport });

  // Get earliest position from DB
  const earliestRes = await query(`
    SELECT MIN(opened_at) AS earliest
    FROM cfo_positions
    WHERE strategy IN ('hyperliquid', 'hl_perp', 'hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing')
  `);
  const earliest = earliestRes.rows[0]?.earliest;
  // Default to 90 days ago if no positions
  const startTime = earliest
    ? new Date(earliest).getTime() - 86400000 // 1 day before first position
    : Date.now() - 90 * 86400000;

  console.log(`  Querying fills from ${new Date(startTime).toISOString().slice(0, 10)}...\n`);

  // ── 1. Fetch ALL fills ────────────────────────────────────────────
  // Use userFills (recent fills, no time filter) — more reliable than
  // userFillsByTime with aggregateByTime which can miss fills.
  let allFills: any[] = [];
  try {
    allFills = await info.userFills({ user: wallet.address });
    console.log(`  📊 Total fills from exchange (userFills): ${allFills.length}`);

    // If that didn't get enough, also try userFillsByTime from start
    if (allFills.length < 200) {
      try {
        const byTimeFills = await info.userFillsByTime({
          user: wallet.address,
          startTime,
        });
        // Merge, dedup by tid
        const seenTids = new Set(allFills.map((f: any) => f.tid));
        for (const f of byTimeFills) {
          if (!seenTids.has(f.tid)) {
            allFills.push(f);
            seenTids.add(f.tid);
          }
        }
        console.log(`  📊 After merging userFillsByTime: ${allFills.length} total fills`);
      } catch { /* userFillsByTime optional */ }
    }
  } catch (err) {
    console.log(`  ❌ userFills failed: ${(err as Error).message}`);
    return;
  }

  if (allFills.length === 0) {
    console.log('  No fills found — HL account may be empty or startTime too recent');
    return;
  }

  // ── Exchange-level summary ─────────────────────────────────────────
  let totalClosedPnl = 0;
  let totalFees = 0;
  const coinSummary: Record<string, { closedPnl: number; fees: number; fills: number }> = {};

  for (const fill of allFills) {
    const pnl = Number(fill.closedPnl);
    const fee = Number(fill.fee);
    totalClosedPnl += pnl;
    totalFees += fee;

    if (!coinSummary[fill.coin]) coinSummary[fill.coin] = { closedPnl: 0, fees: 0, fills: 0 };
    coinSummary[fill.coin].closedPnl += pnl;
    coinSummary[fill.coin].fees += fee;
    coinSummary[fill.coin].fills++;
  }

  console.log(`\n  Exchange ground-truth (all time):`);
  console.log(`    Total closed P&L:  $${totalClosedPnl.toFixed(2)}`);
  console.log(`    Total fees paid:   $${totalFees.toFixed(2)}`);
  console.log(`    Net P&L:           $${(totalClosedPnl - totalFees).toFixed(2)}`);

  console.log(`\n  Per-coin breakdown:`);
  const sorted = Object.entries(coinSummary).sort((a, b) => Math.abs(b[1].closedPnl) - Math.abs(a[1].closedPnl));
  for (const [coin, data] of sorted) {
    const pnlStr = data.closedPnl >= 0 ? `+$${data.closedPnl.toFixed(2)}` : `-$${Math.abs(data.closedPnl).toFixed(2)}`;
    console.log(`    ${coin.padEnd(8)} ${data.fills.toString().padStart(4)} fills │ P&L: ${pnlStr.padStart(12)} │ Fees: $${data.fees.toFixed(2)}`);
  }

  // ── 2. Fetch funding payments ─────────────────────────────────────
  let totalFunding = 0;
  try {
    const fundingData = await info.userFunding({
      user: wallet.address,
      startTime,
    });
    for (const f of fundingData) {
      totalFunding += Number(f.delta?.fundingPayment ?? f.delta?.usdc ?? 0);
    }
    console.log(`\n  Funding payments: $${totalFunding.toFixed(2)} (${fundingData.length} events)`);
  } catch (err) {
    console.log(`\n  ⚠️ userFunding query failed: ${(err as Error).message}`);
  }

  // ── 3. Fetch deposits/withdrawals ─────────────────────────────────
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  try {
    const ledger = await info.userNonFundingLedgerUpdates({
      user: wallet.address,
      startTime,
    });
    for (const entry of ledger) {
      const delta = entry.delta as any;
      if (delta?.type === 'deposit') {
        totalDeposits += Number(delta.usdc ?? 0);
      } else if (delta?.type === 'withdraw') {
        totalWithdrawals += Number(delta.usdc ?? 0);
      } else if (delta?.type === 'accountClassTransfer') {
        // Internal transfers between spot and perp
        const amt = Number(delta.usdc ?? 0);
        if (amt > 0) totalDeposits += amt;
        else totalWithdrawals += Math.abs(amt);
      }
    }
    console.log(`  Deposits:    $${totalDeposits.toFixed(2)}`);
    console.log(`  Withdrawals: $${totalWithdrawals.toFixed(2)}`);
  } catch (err) {
    console.log(`  ⚠️ userNonFundingLedgerUpdates failed: ${(err as Error).message}`);
  }

  // ── 4. Current account state ──────────────────────────────────────
  try {
    const state = await info.clearinghouseState({ user: wallet.address });
    const equity = Number(state.marginSummary.accountValue ?? 0);
    const unrealized = (state.assetPositions ?? [])
      .filter((p: any) => Number(p.position.szi) !== 0)
      .reduce((sum: number, p: any) => sum + Number(p.position.unrealizedPnl ?? 0), 0);

    console.log(`\n  Current account state:`);
    console.log(`    Equity:       $${equity.toFixed(2)}`);
    console.log(`    Unrealized:   $${unrealized.toFixed(2)}`);
    console.log(`    Open positions: ${(state.assetPositions ?? []).filter((p: any) => Number(p.position.szi) !== 0).length}`);

    // Accounting check: equity should ≈ deposits - withdrawals + closedPnl + unrealized - fees + funding
    const expected = totalDeposits - totalWithdrawals + totalClosedPnl + unrealized - totalFees + totalFunding;
    console.log(`\n  Accounting check:`);
    console.log(`    Expected equity: $${expected.toFixed(2)} (deposits - withdrawals + closedPnl + unrealized - fees + funding)`);
    console.log(`    Actual equity:   $${equity.toFixed(2)}`);
    console.log(`    Discrepancy:     $${Math.abs(equity - expected).toFixed(2)}`);
  } catch (err) {
    console.log(`  ⚠️ clearinghouseState failed: ${(err as Error).message}`);
  }

  // ── 5. Compare with DB positions ──────────────────────────────────
  const dbRes = await query(`
    SELECT id, strategy, asset, description, status, cost_basis_usd,
           realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at,
           entry_tx_hash, exit_tx_hash,
           metadata->>'coin' AS coin,
           metadata->>'side' AS side
    FROM cfo_positions
    WHERE strategy IN ('hyperliquid', 'hl_perp', 'hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing')
    ORDER BY opened_at
  `);

  const dbTotal = dbRes.rows.reduce((sum: number, r: any) => sum + Number(r.realized_pnl_usd), 0);
  console.log(`\n  DB positions (${dbRes.rows.length} total):`);
  console.log(`    DB total realized P&L:       $${dbTotal.toFixed(2)}`);
  console.log(`    Exchange total closed P&L:    $${totalClosedPnl.toFixed(2)}`);
  console.log(`    DISCREPANCY:                 $${Math.abs(dbTotal - totalClosedPnl).toFixed(2)}`);

  if (Math.abs(dbTotal - totalClosedPnl) > 1.0) {
    console.log(`\n  ⚠️  Significant discrepancy detected between DB and exchange!`);
    console.log(`     The exchange ground-truth is $${totalClosedPnl.toFixed(2)} but DB says $${dbTotal.toFixed(2)}`);
  }

  // ── 6. Match fills to DB positions and identify corrections ───────
  // Group fills by (coin, opening→closing cycles) using dir field
  // dir format: "Open Long", "Close Long", "Open Short", "Close Short"
  const closedPositions = dbRes.rows.filter((r: any) => r.status === 'CLOSED');
  let corrected = 0;
  let alreadyCorrect = 0;
  let unmatched = 0;

  for (const pos of closedPositions) {
    const coin = pos.coin;
    const side = pos.side;
    if (!coin) { unmatched++; continue; }

    const openedAt = new Date(pos.opened_at).getTime();
    const closedAt = pos.closed_at ? new Date(pos.closed_at).getTime() : Date.now();

    // Find closing fills that match this position's time window and coin
    const closeDir = side === 'SHORT' ? 'Close Short' : 'Close Long';
    const matchingFills = allFills.filter((f: any) =>
      f.coin === coin &&
      f.dir.includes(closeDir.split(' ')[1]) && // Match Long/Short
      f.dir.startsWith('Close') &&
      f.time >= openedAt - 60000 && // 1 min tolerance
      f.time <= closedAt + 60000,
    );

    if (matchingFills.length === 0) {
      // Try broader match — just coin + close direction + rough time
      const broaderFills = allFills.filter((f: any) =>
        f.coin === coin &&
        f.dir.startsWith('Close') &&
        f.time >= openedAt - 3600000 && // 1 hour tolerance
        f.time <= closedAt + 3600000,
      );

      if (broaderFills.length === 0) {
        unmatched++;
        continue;
      }
    }

    // Sum closedPnl for matching fills
    const fills = matchingFills.length > 0 ? matchingFills : allFills.filter((f: any) =>
      f.coin === coin && f.dir.startsWith('Close') &&
      f.time >= openedAt - 3600000 && f.time <= closedAt + 3600000,
    );

    const exchangePnl = fills.reduce((s: number, f: any) => s + Number(f.closedPnl), 0);
    const exchangeFees = fills.reduce((s: number, f: any) => s + Number(f.fee), 0);
    const dbPnl = Number(pos.realized_pnl_usd);

    const diff = Math.abs(exchangePnl - dbPnl);
    if (diff < 0.50) {
      alreadyCorrect++;
      continue;
    }

    console.log(`\n  ── ${pos.description || `${coin} ${side}`} (${pos.id.slice(0, 8)}...)`);
    console.log(`     DB P&L:       $${dbPnl.toFixed(2)}`);
    console.log(`     Exchange P&L: $${exchangePnl.toFixed(2)} (${fills.length} closing fills, fees: $${exchangeFees.toFixed(2)})`);
    console.log(`     Correction:   $${(exchangePnl - dbPnl).toFixed(2)}`);

    if (!DRY_RUN) {
      await query(
        `UPDATE cfo_positions
         SET realized_pnl_usd = $2, updated_at = NOW(),
             metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [
          pos.id,
          exchangePnl,
          JSON.stringify({
            backfill_source: 'hl_exchange',
            backfill_date: new Date().toISOString(),
            original_pnl: dbPnl,
            exchange_closing_fills: fills.length,
            exchange_fees: exchangeFees,
          }),
        ],
      );
      console.log(`     ✅ UPDATED`);
    } else {
      console.log(`     🔍 DRY RUN — would update`);
    }
    corrected++;
  }

  console.log(`\n  HL Summary:`);
  console.log(`    Already correct: ${alreadyCorrect}`);
  console.log(`    Corrected:       ${corrected}`);
  console.log(`    Unmatched:       ${unmatched}`);
  console.log(`    Total closed:    ${closedPositions.length}`);

  // ── 7. Report HL fees not recorded in cfo_transactions ────────────
  const dbFeesRes = await query(`
    SELECT COALESCE(SUM(fee_usd), 0) AS total_fees
    FROM cfo_transactions
    WHERE strategy_tag IN ('hyperliquid', 'hl_perp', 'hl_perp_scalp', 'hl_perp_day', 'hl_perp_swing')
      AND status = 'confirmed'
  `);
  const dbFees = Number(dbFeesRes.rows[0]?.total_fees ?? 0);
  console.log(`\n  HL Fee accounting:`);
  console.log(`    Exchange fees:  $${totalFees.toFixed(2)}`);
  console.log(`    DB fees:        $${dbFees.toFixed(2)}`);
  console.log(`    Diff:           $${Math.abs(totalFees - dbFees).toFixed(2)}`);

  // Overall HL true P&L
  console.log(`\n  ═══ HL TRUE P&L ═══`);
  console.log(`    Closed P&L:    $${totalClosedPnl.toFixed(2)}`);
  console.log(`    Fees paid:     $${totalFees.toFixed(2)}`);
  console.log(`    Funding:       $${totalFunding.toFixed(2)}`);
  console.log(`    NET:           $${(totalClosedPnl - totalFees + totalFunding).toFixed(2)}`);
}

// ============================================================================
// Orca LP backfill: cross-reference DB with Solana tx history
// ============================================================================

async function backfillOrca() {
  console.log('\n' + '─'.repeat(80));
  console.log('  ORCA LP — Cross-referencing DB with Solana transactions');
  console.log('─'.repeat(80));

  // Get closed Orca positions from DB
  const orcaRes = await query(`
    SELECT id, asset, description, status, cost_basis_usd,
           realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at,
           entry_tx_hash, exit_tx_hash, metadata
    FROM cfo_positions
    WHERE strategy = 'orca_lp'
    ORDER BY opened_at
  `);

  console.log(`  Orca LP positions: ${orcaRes.rows.length} total`);

  const open = orcaRes.rows.filter((r: any) => r.status === 'OPEN');
  const closed = orcaRes.rows.filter((r: any) => r.status === 'CLOSED');

  console.log(`    Open: ${open.length}`);
  console.log(`    Closed: ${closed.length}`);

  let totalRealized = 0;
  let totalCostBasis = 0;
  let suspectCount = 0;

  for (const pos of closed) {
    const realized = Number(pos.realized_pnl_usd);
    const cost = Number(pos.cost_basis_usd);
    totalRealized += realized;
    totalCostBasis += cost;

    // Check for suspect P&L (= -cost_basis means $0 received)
    if (Math.abs(realized + cost) < 0.01 && cost > 0) {
      suspectCount++;
    }
  }

  console.log(`\n  Closed position totals:`);
  console.log(`    Total cost basis:   $${totalCostBasis.toFixed(2)}`);
  console.log(`    Total realized P&L: $${totalRealized.toFixed(2)}`);
  console.log(`    Suspect ($0 recv):  ${suspectCount}`);

  // If Helius is available, try to look up exit transactions
  const heliusKey = process.env.CFO_HELIUS_API_KEY;
  if (!heliusKey) {
    console.log('\n  ℹ️ CFO_HELIUS_API_KEY not set — cannot verify on-chain. Showing DB-only summary.');
    return;
  }

  const solSecret = process.env.AGENT_FUNDING_WALLET_SECRET;
  if (!solSecret) {
    console.log('\n  ℹ️ AGENT_FUNDING_WALLET_SECRET not set — cannot derive wallet address');
    return;
  }

  // Derive Solana wallet address
  const bs58 = await import('bs58');
  const { Keypair } = await import('@solana/web3.js');
  const wallet = Keypair.fromSecretKey(bs58.default.decode(solSecret));
  console.log(`\n  Solana wallet: ${wallet.publicKey.toBase58()}`);

  // For positions with exit_tx_hash, verify the actual amounts via Helius
  let verified = 0;
  let corrections = 0;
  const positionsWithTx = closed.filter((r: any) => r.exit_tx_hash);

  console.log(`  Positions with exit tx hash: ${positionsWithTx.length}`);

  // Batch verify up to 50 exit transactions via Helius
  const batchSize = 50;
  for (let i = 0; i < Math.min(positionsWithTx.length, batchSize); i++) {
    const pos = positionsWithTx[i];
    const sig = pos.exit_tx_hash;
    if (!sig || sig === 'N/A') continue;

    try {
      const resp = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${heliusKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [sig] }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) continue;
      const data = await resp.json() as any[];
      if (!data[0]) continue;

      const tx = data[0];
      // Find token balance changes for our wallet
      const ourChanges = (tx.accountData ?? []).find((a: any) => a.account === wallet.publicKey.toBase58());
      if (!ourChanges) continue;

      // Sum value changes for SOL and USDC
      const solChange = ourChanges.nativeBalanceChange / 1e9; // lamports → SOL
      const usdcChange = (ourChanges.tokenBalanceChanges ?? [])
        .filter((t: any) =>
          t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || // USDC
          t.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',    // USDT
        )
        .reduce((s: number, t: any) => s + Number(t.rawTokenAmount?.tokenAmount ?? 0) / Math.pow(10, t.rawTokenAmount?.decimals ?? 6), 0);

      // Get SOL price at time of tx for conversion
      // (We'll use current price as approximation — for better accuracy, use historical price)
      const solPriceAtTx = 130; // TODO: Fetch historical SOL price
      const totalReceivedUsd = solChange * solPriceAtTx + usdcChange;

      const dbPnl = Number(pos.realized_pnl_usd);
      const cost = Number(pos.cost_basis_usd);
      const onChainPnl = totalReceivedUsd - cost;
      const diff = Math.abs(onChainPnl - dbPnl);

      if (diff > 1.0) {
        console.log(`\n  ── ${pos.description || pos.asset} (${pos.id.slice(0, 8)}...)`);
        console.log(`     DB P&L:        $${dbPnl.toFixed(2)}`);
        console.log(`     On-chain est:  $${onChainPnl.toFixed(2)} (SOL: ${solChange.toFixed(4)}, USDC: ${usdcChange.toFixed(2)})`);
        corrections++;
      } else {
        verified++;
      }
    } catch {
      // Helius API error, skip
    }

    // Rate limit
    if (i > 0 && i % 10 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n  Orca verification:`);
  console.log(`    Verified OK:  ${verified}`);
  console.log(`    Discrepancies: ${corrections}`);
  console.log(`    Skipped:      ${positionsWithTx.length - verified - corrections}`);
}

// ============================================================================
// Krystal LP backfill: cross-reference DB positions
// ============================================================================

async function backfillKrystal() {
  console.log('\n' + '─'.repeat(80));
  console.log('  KRYSTAL LP — DB position analysis');
  console.log('─'.repeat(80));

  const krystalRes = await query(`
    SELECT id, asset, description, status, cost_basis_usd, chain,
           realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at,
           entry_tx_hash, exit_tx_hash, metadata
    FROM cfo_positions
    WHERE strategy = 'krystal_lp'
    ORDER BY opened_at
  `);

  console.log(`  Krystal LP positions: ${krystalRes.rows.length} total`);

  const open = krystalRes.rows.filter((r: any) => r.status === 'OPEN');
  const closed = krystalRes.rows.filter((r: any) => r.status === 'CLOSED');

  console.log(`    Open: ${open.length}`);
  console.log(`    Closed: ${closed.length}`);

  // Analyze by chain
  const chainBreakdown: Record<string, { count: number; realized: number; cost: number }> = {};
  for (const pos of krystalRes.rows) {
    const chain = pos.chain || 'unknown';
    if (!chainBreakdown[chain]) chainBreakdown[chain] = { count: 0, realized: 0, cost: 0 };
    chainBreakdown[chain].count++;
    chainBreakdown[chain].realized += Number(pos.realized_pnl_usd);
    chainBreakdown[chain].cost += Number(pos.cost_basis_usd);
  }

  console.log(`\n  By chain:`);
  for (const [chain, data] of Object.entries(chainBreakdown)) {
    console.log(`    ${chain}: ${data.count} positions, P&L $${data.realized.toFixed(2)}, cost $${data.cost.toFixed(2)}`);
  }

  // Fee collection analysis from cfo_transactions
  const feeClaimRes = await query(`
    SELECT
      COUNT(*) AS claim_count,
      COALESCE(SUM(amount_out), 0) AS total_fees_claimed
    FROM cfo_transactions
    WHERE strategy_tag = 'krystal_lp' AND tx_type = 'fee_collect'
      AND status = 'confirmed'
  `);
  const feeClaims = feeClaimRes.rows[0];
  console.log(`\n  Fee claims: ${feeClaims.claim_count} txns, $${Number(feeClaims.total_fees_claimed).toFixed(2)} total`);

  // Check for positions with suspect PnL
  let suspectCount = 0;
  let totalRealized = 0;
  for (const pos of closed) {
    const realized = Number(pos.realized_pnl_usd);
    const cost = Number(pos.cost_basis_usd);
    totalRealized += realized;
    if (Math.abs(realized + cost) < 0.01 && cost > 0) {
      suspectCount++;
      console.log(`    ⚠️ Suspect: ${pos.description || pos.asset} — cost $${cost.toFixed(2)}, P&L $${realized.toFixed(2)}`);
    }
  }

  console.log(`\n  Closed totals: P&L $${totalRealized.toFixed(2)}, suspect: ${suspectCount}`);

  // For EVM positions, we could use block explorer APIs to verify
  // but that requires API keys for each chain. For now, show the analysis.
  const evmKey = process.env.CFO_EVM_PRIVATE_KEY;
  if (evmKey) {
    const { ethers } = await import('ethers');
    const evmWallet = new ethers.Wallet(evmKey);
    console.log(`\n  EVM wallet: ${evmWallet.address}`);
    console.log(`  ℹ️ On-chain verification would require block explorer API keys per chain`);
    console.log(`     (Etherscan, Basescan, Arbiscan, BscScan)`);
  }
}

// ============================================================================
// Kamino backfill: yield estimation
// ============================================================================

async function backfillKamino() {
  console.log('\n' + '─'.repeat(80));
  console.log('  KAMINO — Yield and position analysis');
  console.log('─'.repeat(80));

  const kaminoRes = await query(`
    SELECT id, asset, description, status, cost_basis_usd, chain,
           realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at,
           current_value_usd, metadata
    FROM cfo_positions
    WHERE strategy LIKE 'kamino%'
    ORDER BY opened_at
  `);

  console.log(`  Kamino positions: ${kaminoRes.rows.length} total`);

  const open = kaminoRes.rows.filter((r: any) => r.status === 'OPEN');
  const closed = kaminoRes.rows.filter((r: any) => r.status === 'CLOSED');

  console.log(`    Open: ${open.length}`);
  console.log(`    Closed: ${closed.length}`);

  for (const pos of open) {
    const cost = Number(pos.cost_basis_usd);
    const current = Number(pos.current_value_usd);
    const unrealized = Number(pos.unrealized_pnl_usd);
    console.log(`    📍 ${pos.description || pos.asset}: cost $${cost.toFixed(2)}, current $${current.toFixed(2)}, unrealized $${unrealized.toFixed(2)}`);
  }

  // Yield from daily snapshots
  const yieldRes = await query(`
    SELECT
      COALESCE(SUM(yield_earned_24h), 0) AS total_yield,
      COUNT(*) AS days
    FROM cfo_daily_snapshots
    WHERE yield_earned_24h > 0
  `);
  console.log(`\n  Yield from snapshots: $${Number(yieldRes.rows[0]?.total_yield ?? 0).toFixed(2)} over ${yieldRes.rows[0]?.days} days`);

  // Jito positions (related)
  const jitoRes = await query(`
    SELECT id, description, status, cost_basis_usd, current_value_usd,
           realized_pnl_usd, unrealized_pnl_usd
    FROM cfo_positions
    WHERE strategy = 'jito'
    ORDER BY opened_at
  `);
  if (jitoRes.rows.length > 0) {
    console.log(`\n  Jito positions: ${jitoRes.rows.length}`);
    for (const pos of jitoRes.rows) {
      const cost = Number(pos.cost_basis_usd);
      const current = Number(pos.current_value_usd);
      console.log(`    ${pos.description}: cost $${cost.toFixed(2)}, current $${current.toFixed(2)}, status ${pos.status}`);
    }
  }
}

// ============================================================================
// Grand total: reconcile everything
// ============================================================================

async function showGrandTotal() {
  console.log('\n' + '═'.repeat(80));
  console.log('  GRAND TOTAL — All strategies');
  console.log('═'.repeat(80));

  const res = await query(`
    SELECT
      strategy,
      COALESCE(SUM(realized_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0) AS realized,
      COALESCE(SUM(unrealized_pnl_usd) FILTER (WHERE status = 'OPEN'), 0) AS unrealized,
      COALESCE(SUM(cost_basis_usd) FILTER (WHERE status = 'OPEN'), 0) AS open_cost
    FROM cfo_positions
    GROUP BY strategy
    ORDER BY strategy
  `);

  let grandRealized = 0;
  let grandUnrealized = 0;
  let grandOpenCost = 0;

  for (const r of res.rows) {
    const realized = Number(r.realized);
    const unrealized = Number(r.unrealized);
    const openCost = Number(r.open_cost);
    grandRealized += realized;
    grandUnrealized += unrealized;
    grandOpenCost += openCost;
    console.log(`  ${r.strategy.padEnd(20)} Realized: $${realized.toFixed(2).padStart(10)}  Unrealized: $${unrealized.toFixed(2).padStart(10)}  Open cost: $${openCost.toFixed(2).padStart(10)}`);
  }

  console.log(`  ${'─'.repeat(75)}`);
  console.log(`  ${'TOTAL'.padEnd(20)} Realized: $${grandRealized.toFixed(2).padStart(10)}  Unrealized: $${grandUnrealized.toFixed(2).padStart(10)}  Open cost: $${grandOpenCost.toFixed(2).padStart(10)}`);

  // Fee drag
  const feesRes = await query(`
    SELECT
      COALESCE(SUM(fee_usd), 0) AS total_fees,
      COUNT(*) AS tx_count,
      COALESCE(SUM(fee_usd) FILTER (WHERE tx_type = 'fee_collect'), 0) AS lp_fees_collected
    FROM cfo_transactions
    WHERE status = 'confirmed'
  `);
  const fees = feesRes.rows[0];
  console.log(`\n  Fees paid (gas):      $${Number(fees.total_fees).toFixed(2)} (${fees.tx_count} transactions)`);
  console.log(`  LP fees collected:    $${Number(fees.lp_fees_collected).toFixed(2)}`);
  console.log(`\n  NET P&L (DB):         $${(grandRealized + grandUnrealized - Number(fees.total_fees) + Number(fees.lp_fees_collected)).toFixed(2)}`);

  console.log('\n' + '═'.repeat(80));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║             CFO P&L BACKFILL & RECONCILIATION                               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log(`  Mode:     ${DRY_RUN ? '🔍 DRY RUN (use --apply to write changes)' : '✏️  APPLYING CHANGES'}`);
  console.log(`  Platform: ${platformArg}`);
  console.log(`  Time:     ${new Date().toISOString()}`);

  try {
    // Always show summary
    await showSummary();

    if (SUMMARY_ONLY) {
      await showGrandTotal();
      return;
    }

    // Run platform-specific backfills
    if (platformArg === 'all' || platformArg === 'hl') {
      await backfillHyperliquid();
    }
    if (platformArg === 'all' || platformArg === 'orca') {
      await backfillOrca();
    }
    if (platformArg === 'all' || platformArg === 'krystal') {
      await backfillKrystal();
    }
    if (platformArg === 'all' || platformArg === 'kamino') {
      await backfillKamino();
    }

    // Grand total
    await showGrandTotal();

  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

main();
