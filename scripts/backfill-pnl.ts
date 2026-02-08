#!/usr/bin/env bun
/**
 * Backfill PnL Tracker from historical launch data.
 * 
 * This script:
 * 1. Connects to PostgreSQL (Railway)
 * 2. Loads all launched packs with dev buys
 * 3. Queries on-chain token balances for each
 * 4. Records them in the PnL tracker tables
 * 
 * Run: DATABASE_URL=... bun run scripts/backfill-pnl.ts
 */

import { Pool } from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMP_WALLET = process.env.PUMP_PORTAL_WALLET_ADDRESS;

if (!PUMP_WALLET) {
  console.error('❌ PUMP_PORTAL_WALLET_ADDRESS not set');
  process.exit(1);
}

const pool = new Pool({ 
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const walletPubkey = new PublicKey(PUMP_WALLET);

async function main() {
  console.log('🔄 Backfilling PnL data from historical launches...\n');
  
  // Ensure PnL tables exist
  await ensurePnLSchema();
  
  // Check what's already in PnL
  const existingTrades = await pool.query('SELECT COUNT(*) as count FROM pnl_trades');
  const existingPositions = await pool.query('SELECT COUNT(*) as count FROM pnl_positions');
  console.log(`📊 Current PnL state: ${existingTrades.rows[0].count} trades, ${existingPositions.rows[0].count} positions\n`);
  
  // Get all launched packs with dev buys
  const result = await pool.query(`
    SELECT id, data, created_at 
    FROM launch_packs 
    WHERE launch_status = 'launched'
    ORDER BY created_at ASC
  `);
  
  console.log(`📦 Found ${result.rows.length} launched packs\n`);
  
  let recorded = 0;
  let skipped = 0;
  let failed = 0;
  
  for (const row of result.rows) {
    const pack = row.data as any;
    const mint = pack?.launch?.mint;
    const devBuy = pack?.launch?.dev_buy;
    const ticker = pack?.brand?.ticker || '???';
    const name = pack?.brand?.name || 'Unknown';
    
    if (!mint || !devBuy?.enabled || !devBuy?.amount_sol) {
      console.log(`  ⏭️  $${ticker} — no dev buy or no mint, skipping`);
      skipped++;
      continue;
    }
    
    // Check if already recorded
    const existing = await pool.query(
      'SELECT id FROM pnl_trades WHERE launch_pack_id = $1 AND type = $2',
      [row.id, 'launch_buy']
    );
    
    if (existing.rows.length > 0) {
      console.log(`  ✅ $${ticker} — already recorded, skipping`);
      skipped++;
      continue;
    }
    
    // Try to get on-chain token balance
    let tokensReceived = devBuy.tokens_received || 0;
    
    if (tokensReceived <= 0) {
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          walletPubkey,
          { mint: new PublicKey(mint) }
        );
        
        if (tokenAccounts.value.length > 0) {
          const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
          tokensReceived = parseFloat(balance.uiAmount || balance.uiAmountString || '0');
        }
      } catch (err: any) {
        console.log(`  ⚠️  $${ticker} — on-chain query failed: ${err.message}`);
      }
    }
    
    // Estimate if still no tokens
    if (tokensReceived <= 0) {
      // Pump.fun initial price ~0.000000030 SOL/token
      tokensReceived = Math.floor(devBuy.amount_sol / 0.000000030);
      console.log(`  📐 $${ticker} — using estimate: ${tokensReceived.toLocaleString()} tokens`);
    }
    
    // Record the trade
    const tradeId = `backfill-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const timestamp = new Date(pack?.launch?.launched_at || row.created_at).getTime();
    
    try {
      // Insert trade
      await pool.query(`
        INSERT INTO pnl_trades (id, timestamp, type, token_mint, token_ticker, token_name,
                                token_amount, sol_amount, price_per_token, signature, launch_pack_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO NOTHING
      `, [
        tradeId,
        timestamp,
        'launch_buy',
        mint,
        ticker,
        name,
        tokensReceived,
        devBuy.amount_sol,
        tokensReceived > 0 ? devBuy.amount_sol / tokensReceived : 0,
        pack?.launch?.tx_signature || null,
        row.id,
      ]);
      
      // Upsert position
      await pool.query(`
        INSERT INTO pnl_positions (mint, ticker, name, total_bought, total_sold, current_balance,
                                    cost_basis_sol, realized_pnl_sol, avg_buy_price, last_updated)
        VALUES ($1, $2, $3, $4, 0, $4, $5, 0, $6, $7)
        ON CONFLICT (mint) DO UPDATE SET
          ticker = COALESCE(EXCLUDED.ticker, pnl_positions.ticker),
          name = COALESCE(EXCLUDED.name, pnl_positions.name),
          total_bought = pnl_positions.total_bought + EXCLUDED.total_bought,
          current_balance = pnl_positions.current_balance + EXCLUDED.total_bought,
          cost_basis_sol = pnl_positions.cost_basis_sol + EXCLUDED.cost_basis_sol,
          avg_buy_price = CASE 
            WHEN (pnl_positions.total_bought + EXCLUDED.total_bought) > 0 
            THEN (pnl_positions.cost_basis_sol + EXCLUDED.cost_basis_sol) / (pnl_positions.total_bought + EXCLUDED.total_bought)
            ELSE 0 
          END,
          last_updated = EXCLUDED.last_updated
      `, [
        mint,
        ticker,
        name,
        tokensReceived,
        devBuy.amount_sol,
        tokensReceived > 0 ? devBuy.amount_sol / tokensReceived : 0,
        timestamp,
      ]);
      
      // Insert SOL flow
      await pool.query(`
        INSERT INTO pnl_sol_flows (id, timestamp, type, amount, description, signature)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [
        `flow-${tradeId}`,
        timestamp,
        'launch_cost',
        -devBuy.amount_sol,
        `Launch $${ticker}`,
        pack?.launch?.tx_signature || null,
      ]);
      
      console.log(`  ✅ $${ticker} — recorded: ${tokensReceived.toLocaleString()} tokens for ${devBuy.amount_sol} SOL (mint: ${mint.slice(0, 8)}...)`);
      recorded++;
    } catch (err: any) {
      console.log(`  ❌ $${ticker} — DB error: ${err.message}`);
      failed++;
    }
    
    // Small delay for RPC rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  // Recalculate summary totals
  console.log('\n🔄 Recalculating PnL summary...');
  
  const totalCostBasis = await pool.query(`
    SELECT COALESCE(SUM(sol_amount), 0) as total 
    FROM pnl_trades WHERE type IN ('launch_buy', 'buy')
  `);
  
  const totalSellProceeds = await pool.query(`
    SELECT COALESCE(SUM(sol_amount), 0) as total 
    FROM pnl_trades WHERE type = 'sell'
  `);
  
  const totalDeposits = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total 
    FROM pnl_sol_flows WHERE type = 'deposit'
  `);
  
  const totalWithdrawals = await pool.query(`
    SELECT COALESCE(ABS(SUM(amount)), 0) as total 
    FROM pnl_sol_flows WHERE type = 'withdrawal'
  `);
  
  const totalRealizedPnl = await pool.query(`
    SELECT COALESCE(SUM(realized_pnl_sol), 0) as total 
    FROM pnl_positions
  `);
  
  // Update summary
  await pool.query(`
    UPDATE pnl_summary SET
      total_realized_pnl = $1,
      total_sol_deposited = $2,
      total_sol_withdrawn = $3,
      updated_at = NOW()
    WHERE id = 'main'
  `, [
    parseFloat(totalRealizedPnl.rows[0].total),
    parseFloat(totalDeposits.rows[0].total),
    parseFloat(totalWithdrawals.rows[0].total),
  ]);
  
  // Final summary
  const finalPositions = await pool.query('SELECT COUNT(*) as count FROM pnl_positions WHERE current_balance > 0');
  const finalTrades = await pool.query('SELECT COUNT(*) as count FROM pnl_trades');
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 PnL Backfill Complete');
  console.log('='.repeat(50));
  console.log(`  Recorded: ${recorded}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total trades:     ${finalTrades.rows[0].count}`);
  console.log(`  Active positions: ${finalPositions.rows[0].count}`);
  console.log(`  Total cost basis: ${parseFloat(totalCostBasis.rows[0].total).toFixed(4)} SOL`);
  console.log(`  Realized PnL:     ${parseFloat(totalRealizedPnl.rows[0].total).toFixed(4)} SOL`);
  console.log(`  Net deposits:     ${(parseFloat(totalDeposits.rows[0].total) - parseFloat(totalWithdrawals.rows[0].total)).toFixed(4)} SOL`);
  console.log('='.repeat(50));
  
  await pool.end();
}

async function ensurePnLSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_trades (
      id TEXT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      type TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_ticker TEXT,
      token_name TEXT,
      token_amount DOUBLE PRECISION NOT NULL,
      sol_amount DOUBLE PRECISION NOT NULL,
      price_per_token DOUBLE PRECISION NOT NULL,
      signature TEXT,
      launch_pack_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_positions (
      mint TEXT PRIMARY KEY,
      ticker TEXT,
      name TEXT,
      total_bought DOUBLE PRECISION DEFAULT 0,
      total_sold DOUBLE PRECISION DEFAULT 0,
      current_balance DOUBLE PRECISION DEFAULT 0,
      cost_basis_sol DOUBLE PRECISION DEFAULT 0,
      realized_pnl_sol DOUBLE PRECISION DEFAULT 0,
      avg_buy_price DOUBLE PRECISION DEFAULT 0,
      last_updated BIGINT
    );
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_sol_flows (
      id TEXT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      type TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      description TEXT,
      signature TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_summary (
      id TEXT PRIMARY KEY DEFAULT 'main',
      total_realized_pnl DOUBLE PRECISION DEFAULT 0,
      total_sol_deposited DOUBLE PRECISION DEFAULT 0,
      total_sol_withdrawn DOUBLE PRECISION DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`
    INSERT INTO pnl_summary (id, total_realized_pnl, total_sol_deposited, total_sol_withdrawn)
    VALUES ('main', 0, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_trades_mint_idx ON pnl_trades (token_mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_trades_timestamp_idx ON pnl_trades (timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_trades_pack_idx ON pnl_trades (launch_pack_id);`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
