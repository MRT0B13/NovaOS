import { Pool, type PoolConfig } from 'pg';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import type { TradeRecord, TokenPosition, SolFlowRecord, PnLSummary } from '../services/pnlTracker.ts';

/**
 * PostgreSQL-backed PnL Repository
 * 
 * Stores trades, positions, and SOL flows in PostgreSQL for persistence
 * across Railway restarts.
 */

function buildPool(databaseUrl: string): Pool {
  const sslNeeded = databaseUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (sslNeeded) {
    config.ssl = { rejectUnauthorized: false } as any;
  }
  return new Pool(config);
}

async function ensurePnLSchema(pool: Pool): Promise<void> {
  // Trades table - records every buy/sell
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
  
  // Positions table - aggregated per token
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
  
  // SOL flows table - deposits/withdrawals
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
  
  // Summary table - cached totals
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_summary (
      id TEXT PRIMARY KEY DEFAULT 'main',
      total_realized_pnl DOUBLE PRECISION DEFAULT 0,
      total_sol_deposited DOUBLE PRECISION DEFAULT 0,
      total_sol_withdrawn DOUBLE PRECISION DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  // Create indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_trades_mint_idx ON pnl_trades (token_mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_trades_timestamp_idx ON pnl_trades (timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_sol_flows_timestamp_idx ON pnl_sol_flows (timestamp DESC);`);
  
  // Insert default summary row if not exists
  await pool.query(`
    INSERT INTO pnl_summary (id, total_realized_pnl, total_sol_deposited, total_sol_withdrawn)
    VALUES ('main', 0, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
  
  logger.info('[PnLRepository] Schema ensured');
}

export class PostgresPnLRepository {
  private constructor(private pool: Pool) {}
  
  static async create(databaseUrl: string): Promise<PostgresPnLRepository> {
    const pool = buildPool(databaseUrl);
    await ensurePnLSchema(pool);
    return new PostgresPnLRepository(pool);
  }
  
  async close(): Promise<void> {
    await this.pool.end();
  }
  
  // ============================================================================
  // Trades
  // ============================================================================
  
  async insertTrade(trade: TradeRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO pnl_trades (id, timestamp, type, token_mint, token_ticker, token_name, 
                              token_amount, sol_amount, price_per_token, signature, launch_pack_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      trade.id,
      trade.timestamp,
      trade.type,
      trade.tokenMint,
      trade.tokenTicker || null,
      trade.tokenName || null,
      trade.tokenAmount,
      trade.solAmount,
      trade.pricePerToken,
      trade.signature || null,
      trade.launchPackId || null,
    ]);
  }
  
  async getRecentTrades(limit: number = 10): Promise<TradeRecord[]> {
    const result = await this.pool.query(`
      SELECT id, timestamp, type, token_mint, token_ticker, token_name,
             token_amount, sol_amount, price_per_token, signature, launch_pack_id
      FROM pnl_trades
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      type: row.type as 'buy' | 'sell' | 'launch_buy',
      tokenMint: row.token_mint,
      tokenTicker: row.token_ticker,
      tokenName: row.token_name,
      tokenAmount: Number(row.token_amount),
      solAmount: Number(row.sol_amount),
      pricePerToken: Number(row.price_per_token),
      signature: row.signature,
      launchPackId: row.launch_pack_id,
    }));
  }
  
  async getTradeCount(): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*) as count FROM pnl_trades`);
    return Number(result.rows[0]?.count || 0);
  }
  
  // ============================================================================
  // Positions
  // ============================================================================
  
  async upsertPosition(position: TokenPosition): Promise<void> {
    await this.pool.query(`
      INSERT INTO pnl_positions (mint, ticker, name, total_bought, total_sold, current_balance,
                                  cost_basis_sol, realized_pnl_sol, avg_buy_price, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (mint) DO UPDATE SET
        ticker = COALESCE(EXCLUDED.ticker, pnl_positions.ticker),
        name = COALESCE(EXCLUDED.name, pnl_positions.name),
        total_bought = EXCLUDED.total_bought,
        total_sold = EXCLUDED.total_sold,
        current_balance = EXCLUDED.current_balance,
        cost_basis_sol = EXCLUDED.cost_basis_sol,
        realized_pnl_sol = EXCLUDED.realized_pnl_sol,
        avg_buy_price = EXCLUDED.avg_buy_price,
        last_updated = EXCLUDED.last_updated
    `, [
      position.mint,
      position.ticker || null,
      position.name || null,
      position.totalBought,
      position.totalSold,
      position.currentBalance,
      position.costBasisSol,
      position.realizedPnlSol,
      position.avgBuyPrice,
      position.lastUpdated,
    ]);
  }
  
  async getPosition(mint: string): Promise<TokenPosition | null> {
    const result = await this.pool.query(`
      SELECT * FROM pnl_positions WHERE mint = $1
    `, [mint]);
    
    if (!result.rows[0]) return null;
    
    const row = result.rows[0];
    return {
      mint: row.mint,
      ticker: row.ticker,
      name: row.name,
      totalBought: Number(row.total_bought),
      totalSold: Number(row.total_sold),
      currentBalance: Number(row.current_balance),
      costBasisSol: Number(row.cost_basis_sol),
      realizedPnlSol: Number(row.realized_pnl_sol),
      avgBuyPrice: Number(row.avg_buy_price),
      lastUpdated: Number(row.last_updated),
    };
  }
  
  async getAllPositions(): Promise<TokenPosition[]> {
    const result = await this.pool.query(`SELECT * FROM pnl_positions`);
    
    return result.rows.map(row => ({
      mint: row.mint,
      ticker: row.ticker,
      name: row.name,
      totalBought: Number(row.total_bought),
      totalSold: Number(row.total_sold),
      currentBalance: Number(row.current_balance),
      costBasisSol: Number(row.cost_basis_sol),
      realizedPnlSol: Number(row.realized_pnl_sol),
      avgBuyPrice: Number(row.avg_buy_price),
      lastUpdated: Number(row.last_updated),
    }));
  }
  
  async getActivePositions(): Promise<TokenPosition[]> {
    const result = await this.pool.query(`
      SELECT * FROM pnl_positions WHERE current_balance > 0
    `);
    
    return result.rows.map(row => ({
      mint: row.mint,
      ticker: row.ticker,
      name: row.name,
      totalBought: Number(row.total_bought),
      totalSold: Number(row.total_sold),
      currentBalance: Number(row.current_balance),
      costBasisSol: Number(row.cost_basis_sol),
      realizedPnlSol: Number(row.realized_pnl_sol),
      avgBuyPrice: Number(row.avg_buy_price),
      lastUpdated: Number(row.last_updated),
    }));
  }
  
  // ============================================================================
  // SOL Flows
  // ============================================================================
  
  async insertSolFlow(flow: SolFlowRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO pnl_sol_flows (id, timestamp, type, amount, description, signature)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      flow.id,
      flow.timestamp,
      flow.type,
      flow.amount,
      flow.description || null,
      flow.signature || null,
    ]);
  }
  
  // ============================================================================
  // Summary
  // ============================================================================
  
  async updateSummary(updates: {
    addRealizedPnl?: number;
    addDeposited?: number;
    addWithdrawn?: number;
  }): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (updates.addRealizedPnl !== undefined) {
      sets.push(`total_realized_pnl = total_realized_pnl + $${paramIndex++}`);
      values.push(updates.addRealizedPnl);
    }
    if (updates.addDeposited !== undefined) {
      sets.push(`total_sol_deposited = total_sol_deposited + $${paramIndex++}`);
      values.push(updates.addDeposited);
    }
    if (updates.addWithdrawn !== undefined) {
      sets.push(`total_sol_withdrawn = total_sol_withdrawn + $${paramIndex++}`);
      values.push(updates.addWithdrawn);
    }
    
    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      await this.pool.query(`
        UPDATE pnl_summary SET ${sets.join(', ')} WHERE id = 'main'
      `, values);
    }
  }
  
  async getSummary(): Promise<{
    totalRealizedPnl: number;
    totalSolDeposited: number;
    totalSolWithdrawn: number;
  }> {
    const result = await this.pool.query(`
      SELECT total_realized_pnl, total_sol_deposited, total_sol_withdrawn
      FROM pnl_summary WHERE id = 'main'
    `);
    
    const row = result.rows[0];
    return {
      totalRealizedPnl: Number(row?.total_realized_pnl || 0),
      totalSolDeposited: Number(row?.total_sol_deposited || 0),
      totalSolWithdrawn: Number(row?.total_sol_withdrawn || 0),
    };
  }
  
  async getWinLossStats(): Promise<{ wins: number; losses: number }> {
    // Count sells where price > avg buy price = win
    const result = await this.pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE t.price_per_token > p.avg_buy_price) as wins,
        COUNT(*) FILTER (WHERE t.price_per_token <= p.avg_buy_price) as losses
      FROM pnl_trades t
      JOIN pnl_positions p ON t.token_mint = p.mint
      WHERE t.type = 'sell'
    `);
    
    const row = result.rows[0];
    return {
      wins: Number(row?.wins || 0),
      losses: Number(row?.losses || 0),
    };
  }
}
