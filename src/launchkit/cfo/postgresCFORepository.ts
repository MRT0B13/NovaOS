/**
 * CFO PostgreSQL Repository
 *
 * Persistent storage for all CFO financial data:
 *  - cfo_positions      — open/closed trading positions across all strategies
 *  - cfo_transactions   — every executed transaction for full audit trail
 *  - cfo_daily_snapshots — daily portfolio snapshots for P&L reporting
 *
 * Follows the same pattern as postgresPnLRepository.ts:
 *  - Static factory method
 *  - ensureSchema() idempotent on every start
 *  - All amounts stored as DOUBLE PRECISION (NUMERIC causes type issues with JS)
 */

import { Pool, type PoolConfig } from 'pg';
import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export type PositionStatus = 'OPEN' | 'PARTIAL_EXIT' | 'CLOSED' | 'STOP_HIT' | 'EXPIRED';
export type PositionStrategy = 'polymarket' | 'hyperliquid' | 'kamino' | 'jito' | 'jupiter_swap';

export interface CFOPosition {
  id: string;
  strategy: PositionStrategy;
  asset: string;                // ticker or condition_id or token_id
  description: string;          // human-readable (market question or pair)
  chain: 'solana' | 'polygon' | 'arbitrum' | 'base';
  status: PositionStatus;
  entryPrice: number;
  currentPrice: number;
  sizeUnits: number;            // tokens or outcome tokens
  costBasisUsd: number;
  currentValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  entryTxHash?: string;
  exitTxHash?: string;
  externalId?: string;          // order ID, condition_id, etc.
  metadata: Record<string, unknown>;
  openedAt: string;
  closedAt?: string;
  updatedAt: string;
}

export type TransactionType =
  | 'swap'
  | 'stake'
  | 'unstake'
  | 'deposit'
  | 'withdraw'
  | 'bridge'
  | 'prediction_buy'
  | 'prediction_sell'
  | 'fee_collect';

export interface CFOTransaction {
  id: string;
  timestamp: string;
  chain: string;
  strategyTag: PositionStrategy;
  txType: TransactionType;
  tokenIn?: string;
  amountIn?: number;
  tokenOut?: string;
  amountOut?: number;
  feeUsd: number;
  txHash?: string;
  walletAddress: string;
  positionId?: string;
  status: 'confirmed' | 'pending' | 'failed';
  errorMessage?: string;
  metadata: Record<string, unknown>;
}

export interface CFODailySnapshot {
  date: string;                 // YYYY-MM-DD
  totalPortfolioUsd: number;
  solPriceUsd: number;
  byStrategy: Record<string, { valueUsd: number; pnl24h: number; notes?: string }>;
  realizedPnl24h: number;
  unrealizedPnl: number;
  yieldEarned24h: number;
  x402Revenue24h: number;
  polymarketPnl24h: number;
  openPositions: number;
}

// ============================================================================
// Schema
// ============================================================================

async function ensureCFOSchema(pool: Pool): Promise<void> {
  // Ensure kv_store exists (used by CFO for daily digest deduplication)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cfo_positions (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      asset TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      chain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      current_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      size_units DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost_basis_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      current_value_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      realized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      entry_tx_hash TEXT,
      exit_tx_hash TEXT,
      external_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cfo_transactions (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      chain TEXT NOT NULL,
      strategy_tag TEXT NOT NULL,
      tx_type TEXT NOT NULL,
      token_in TEXT,
      amount_in DOUBLE PRECISION,
      token_out TEXT,
      amount_out DOUBLE PRECISION,
      fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tx_hash TEXT,
      wallet_address TEXT NOT NULL,
      position_id TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cfo_daily_snapshots (
      date DATE PRIMARY KEY,
      total_portfolio_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      sol_price_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      by_strategy JSONB NOT NULL DEFAULT '{}',
      realized_pnl_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
      unrealized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
      yield_earned_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
      x402_revenue_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
      polymarket_pnl_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
      open_positions INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_positions_strategy_idx ON cfo_positions (strategy);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_positions_status_idx ON cfo_positions (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_positions_external_idx ON cfo_positions (external_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_transactions_timestamp_idx ON cfo_transactions (timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_transactions_strategy_idx ON cfo_transactions (strategy_tag);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cfo_transactions_position_idx ON cfo_transactions (position_id);`);

  logger.info('[CFORepository] Schema ensured');
}

// ============================================================================
// Repository class
// ============================================================================

export class PostgresCFORepository {
  private constructor(private pool: Pool) {}

  static async create(databaseUrl: string): Promise<PostgresCFORepository> {
    const sslNeeded = databaseUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
    const config: PoolConfig = { connectionString: databaseUrl };
    if (sslNeeded) config.ssl = { rejectUnauthorized: false } as any;

    const pool = new Pool(config);
    const repo = new PostgresCFORepository(pool);
    await ensureCFOSchema(pool);
    return repo;
  }

  // ── Positions ─────────────────────────────────────────────────────

  async upsertPosition(pos: CFOPosition): Promise<void> {
    try {
      await this.pool.query(
      `INSERT INTO cfo_positions (
        id, strategy, asset, description, chain, status,
        entry_price, current_price, size_units,
        cost_basis_usd, current_value_usd, realized_pnl_usd, unrealized_pnl_usd,
        entry_tx_hash, exit_tx_hash, external_id, metadata,
        opened_at, closed_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        current_price = EXCLUDED.current_price,
        current_value_usd = EXCLUDED.current_value_usd,
        unrealized_pnl_usd = EXCLUDED.unrealized_pnl_usd,
        realized_pnl_usd = EXCLUDED.realized_pnl_usd,
        exit_tx_hash = EXCLUDED.exit_tx_hash,
        closed_at = EXCLUDED.closed_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()`,
      [
        pos.id, pos.strategy, pos.asset, pos.description, pos.chain, pos.status,
        pos.entryPrice, pos.currentPrice, pos.sizeUnits,
        pos.costBasisUsd, pos.currentValueUsd, pos.realizedPnlUsd, pos.unrealizedPnlUsd,
        pos.entryTxHash ?? null, pos.exitTxHash ?? null, pos.externalId ?? null,
        JSON.stringify(pos.metadata),
        pos.openedAt, pos.closedAt ?? null, pos.updatedAt,
      ],
    );
    } catch (err) {
      logger.error(`[CFORepository] upsertPosition error for ${pos.id}:`, err);
      throw err;
    }
  }

  async getPosition(id: string): Promise<CFOPosition | null> {
    const res = await this.pool.query('SELECT * FROM cfo_positions WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToPosition(res.rows[0]) : null;
  }

  async getPositionByExternalId(externalId: string): Promise<CFOPosition | null> {
    const res = await this.pool.query(
      'SELECT * FROM cfo_positions WHERE external_id = $1 LIMIT 1',
      [externalId],
    );
    return res.rows[0] ? this.rowToPosition(res.rows[0]) : null;
  }

  async getOpenPositions(strategy?: PositionStrategy): Promise<CFOPosition[]> {
    const q = strategy
      ? `SELECT * FROM cfo_positions WHERE status = 'OPEN' AND strategy = $1 ORDER BY opened_at DESC`
      : `SELECT * FROM cfo_positions WHERE status = 'OPEN' ORDER BY opened_at DESC`;
    const res = await this.pool.query(q, strategy ? [strategy] : []);
    return res.rows.map((r) => this.rowToPosition(r));
  }

  async closePosition(id: string, exitTxHash: string, realizedPnlUsd: number): Promise<void> {
    await this.pool.query(
      `UPDATE cfo_positions
       SET status = 'CLOSED', exit_tx_hash = $2, realized_pnl_usd = $3,
           unrealized_pnl_usd = 0, current_value_usd = 0,
           closed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, exitTxHash, realizedPnlUsd],
    );
  }

  async updatePositionPrice(id: string, currentPrice: number, currentValueUsd: number): Promise<void> {
    const unrealizedPnl = await this.pool.query(
      `SELECT cost_basis_usd FROM cfo_positions WHERE id = $1`,
      [id],
    );
    const costBasis = Number(unrealizedPnl.rows[0]?.cost_basis_usd ?? 0);
    await this.pool.query(
      `UPDATE cfo_positions
       SET current_price = $2, current_value_usd = $3,
           unrealized_pnl_usd = $3 - $4, updated_at = NOW()
       WHERE id = $1`,
      [id, currentPrice, currentValueUsd, costBasis],
    );
  }

  async getTotalUnrealizedPnl(): Promise<number> {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(unrealized_pnl_usd), 0) AS total FROM cfo_positions WHERE status = 'OPEN'`,
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async getTotalRealizedPnl(): Promise<number> {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(realized_pnl_usd), 0) AS total FROM cfo_positions WHERE status = 'CLOSED'`,
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  // ── Transactions ──────────────────────────────────────────────────

  async insertTransaction(tx: CFOTransaction): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO cfo_transactions (
          id, timestamp, chain, strategy_tag, tx_type,
          token_in, amount_in, token_out, amount_out, fee_usd,
          tx_hash, wallet_address, position_id, status, error_message, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO NOTHING`,
        [
          tx.id, tx.timestamp, tx.chain, tx.strategyTag, tx.txType,
          tx.tokenIn ?? null, tx.amountIn ?? null, tx.tokenOut ?? null, tx.amountOut ?? null,
          tx.feeUsd, tx.txHash ?? null, tx.walletAddress,
          tx.positionId ?? null, tx.status, tx.errorMessage ?? null,
          JSON.stringify(tx.metadata),
        ],
      );
    } catch (err) {
      logger.error(`[CFORepository] insertTransaction error for ${tx.id}:`, err);
      throw err;
    }
  }

  async getRecentTransactions(limit = 50, strategy?: PositionStrategy): Promise<CFOTransaction[]> {
    const q = strategy
      ? `SELECT * FROM cfo_transactions WHERE strategy_tag = $1 ORDER BY timestamp DESC LIMIT $2`
      : `SELECT * FROM cfo_transactions ORDER BY timestamp DESC LIMIT $1`;
    const res = await this.pool.query(q, strategy ? [strategy, limit] : [limit]);
    return res.rows.map((r) => this.rowToTransaction(r));
  }

  async getDailyRevenue(date: string): Promise<{ realized: number; fees: number }> {
    const res = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tx_type IN ('prediction_sell','fee_collect') THEN amount_out ELSE 0 END), 0) AS realized,
         COALESCE(SUM(fee_usd), 0) AS fees
       FROM cfo_transactions
       WHERE timestamp::date = $1::date AND status = 'confirmed'`,
      [date],
    );
    return {
      realized: Number(res.rows[0]?.realized ?? 0),
      fees: Number(res.rows[0]?.fees ?? 0),
    };
  }

  // ── Daily Snapshots ───────────────────────────────────────────────

  async upsertDailySnapshot(snap: CFODailySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO cfo_daily_snapshots (
        date, total_portfolio_usd, sol_price_usd, by_strategy,
        realized_pnl_24h, unrealized_pnl, yield_earned_24h,
        x402_revenue_24h, polymarket_pnl_24h, open_positions
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (date) DO UPDATE SET
        total_portfolio_usd = EXCLUDED.total_portfolio_usd,
        sol_price_usd = EXCLUDED.sol_price_usd,
        by_strategy = EXCLUDED.by_strategy,
        realized_pnl_24h = EXCLUDED.realized_pnl_24h,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        yield_earned_24h = EXCLUDED.yield_earned_24h,
        x402_revenue_24h = EXCLUDED.x402_revenue_24h,
        polymarket_pnl_24h = EXCLUDED.polymarket_pnl_24h,
        open_positions = EXCLUDED.open_positions`,
      [
        snap.date, snap.totalPortfolioUsd, snap.solPriceUsd,
        JSON.stringify(snap.byStrategy),
        snap.realizedPnl24h, snap.unrealizedPnl, snap.yieldEarned24h,
        snap.x402Revenue24h, snap.polymarketPnl24h, snap.openPositions,
      ],
    );
  }

  async getSnapshots(days = 30): Promise<CFODailySnapshot[]> {
    const res = await this.pool.query(
      `SELECT * FROM cfo_daily_snapshots ORDER BY date DESC LIMIT $1`,
      [days],
    );
    return res.rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      totalPortfolioUsd: Number(r.total_portfolio_usd),
      solPriceUsd: Number(r.sol_price_usd),
      byStrategy: typeof r.by_strategy === 'string' ? JSON.parse(r.by_strategy) : r.by_strategy,
      realizedPnl24h: Number(r.realized_pnl_24h),
      unrealizedPnl: Number(r.unrealized_pnl),
      yieldEarned24h: Number(r.yield_earned_24h),
      x402Revenue24h: Number(r.x402_revenue_24h),
      polymarketPnl24h: Number(r.polymarket_pnl_24h),
      openPositions: Number(r.open_positions),
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private rowToPosition(r: any): CFOPosition {
    return {
      id: r.id,
      strategy: r.strategy,
      asset: r.asset,
      description: r.description,
      chain: r.chain,
      status: r.status,
      entryPrice: Number(r.entry_price),
      currentPrice: Number(r.current_price),
      sizeUnits: Number(r.size_units),
      costBasisUsd: Number(r.cost_basis_usd),
      currentValueUsd: Number(r.current_value_usd),
      realizedPnlUsd: Number(r.realized_pnl_usd),
      unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
      entryTxHash: r.entry_tx_hash ?? undefined,
      exitTxHash: r.exit_tx_hash ?? undefined,
      externalId: r.external_id ?? undefined,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {},
      openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at,
      closedAt: r.closed_at ? (r.closed_at instanceof Date ? r.closed_at.toISOString() : r.closed_at) : undefined,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    };
  }

  private rowToTransaction(r: any): CFOTransaction {
    return {
      id: r.id,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      chain: r.chain,
      strategyTag: r.strategy_tag,
      txType: r.tx_type,
      tokenIn: r.token_in ?? undefined,
      amountIn: r.amount_in !== null ? Number(r.amount_in) : undefined,
      tokenOut: r.token_out ?? undefined,
      amountOut: r.amount_out !== null ? Number(r.amount_out) : undefined,
      feeUsd: Number(r.fee_usd),
      txHash: r.tx_hash ?? undefined,
      walletAddress: r.wallet_address,
      positionId: r.position_id ?? undefined,
      status: r.status,
      errorMessage: r.error_message ?? undefined,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {},
    };
  }
}
