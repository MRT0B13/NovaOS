import { logger } from '@elizaos/core';
import * as fs from 'fs';
import * as path from 'path';
import { getEnv } from '../env.ts';
import { PostgresPnLRepository } from '../db/postgresPnLRepository.ts';

/**
 * PnL (Profit & Loss) Tracker
 * 
 * Tracks all trading activity and calculates realized/unrealized PnL.
 * 
 * Storage:
 * - PostgreSQL when DATABASE_URL is set (Railway production)
 * - JSON file fallback for local development
 * 
 * Tracked events:
 * - Token launches (initial dev buy is cost basis)
 * - Token buys (adds to cost basis)
 * - Token sells (realizes PnL)
 * - SOL deposits/withdrawals (tracked for net flow)
 */

const PNL_DATA_FILE = './data/pnl_tracker.json';

// PostgreSQL repository (null if using file storage)
let pgRepo: PostgresPnLRepository | null = null;
let usePostgres = false;

// Trade record for a single transaction
export interface TradeRecord {
  id: string;
  timestamp: number;
  type: 'buy' | 'sell' | 'launch_buy';
  tokenMint: string;
  tokenTicker?: string;
  tokenName?: string;
  tokenAmount: number;
  solAmount: number;
  pricePerToken: number;  // SOL per token at time of trade
  signature?: string;
  launchPackId?: string;
}

// Position tracking for a token
export interface TokenPosition {
  mint: string;
  ticker?: string;
  name?: string;
  totalBought: number;      // Total tokens acquired
  totalSold: number;        // Total tokens sold
  currentBalance: number;   // Current holding
  costBasisSol: number;     // Total SOL spent to acquire
  realizedPnlSol: number;   // PnL from sells
  avgBuyPrice: number;      // Average price per token (cost basis / tokens bought)
  lastUpdated: number;
}

// SOL flow tracking
export interface SolFlowRecord {
  id: string;
  timestamp: number;
  type: 'deposit' | 'withdrawal' | 'launch_cost' | 'sell_proceeds' | 'buy_cost';
  amount: number;
  description?: string;
  signature?: string;
}

// Complete PnL state (for file-based storage)
interface PnLState {
  positions: Record<string, TokenPosition>;   // keyed by mint address
  trades: TradeRecord[];
  solFlows: SolFlowRecord[];
  totalRealizedPnl: number;
  totalSolDeposited: number;
  totalSolWithdrawn: number;
  lastUpdated: string;
}

// In-memory state (used for file storage mode)
let state: PnLState = {
  positions: {},
  trades: [],
  solFlows: [],
  totalRealizedPnl: 0,
  totalSolDeposited: 0,
  totalSolWithdrawn: 0,
  lastUpdated: new Date().toISOString(),
};

/**
 * Load PnL data from disk (file mode only)
 */
function loadFileState(): void {
  try {
    if (fs.existsSync(PNL_DATA_FILE)) {
      const data = fs.readFileSync(PNL_DATA_FILE, 'utf-8');
      state = JSON.parse(data);
      logger.info(`[PnLTracker] Loaded ${Object.keys(state.positions).length} positions, ${state.trades.length} trades from file`);
    }
  } catch (err) {
    logger.warn('[PnLTracker] Could not load PnL data from file, starting fresh');
  }
}

/**
 * Save PnL data to disk (file mode only)
 */
function saveFileState(): void {
  if (usePostgres) return; // PostgreSQL handles its own persistence
  
  try {
    const dir = path.dirname(PNL_DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PNL_DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.error(`[PnLTracker] Failed to save: ${err}`);
  }
}

/**
 * Generate a unique ID for records
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Record a token purchase (buy or launch dev buy)
 */
export async function recordBuy(params: {
  tokenMint: string;
  tokenTicker?: string;
  tokenName?: string;
  tokenAmount: number;
  solSpent: number;
  isLaunchBuy?: boolean;
  signature?: string;
  launchPackId?: string;
}): Promise<void> {
  const { tokenMint, tokenTicker, tokenName, tokenAmount, solSpent, isLaunchBuy, signature, launchPackId } = params;
  
  if (tokenAmount <= 0 || solSpent <= 0) {
    logger.warn('[PnLTracker] Invalid buy params, skipping');
    return;
  }
  
  const pricePerToken = solSpent / tokenAmount;
  
  // Create trade record
  const trade: TradeRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: isLaunchBuy ? 'launch_buy' : 'buy',
    tokenMint,
    tokenTicker,
    tokenName,
    tokenAmount,
    solAmount: solSpent,
    pricePerToken,
    signature,
    launchPackId,
  };
  
  // Create/update position
  const existingPos = usePostgres && pgRepo 
    ? await pgRepo.getPosition(tokenMint)
    : state.positions[tokenMint] || null;
  
  const pos: TokenPosition = existingPos || {
    mint: tokenMint,
    ticker: tokenTicker,
    name: tokenName,
    totalBought: 0,
    totalSold: 0,
    currentBalance: 0,
    costBasisSol: 0,
    realizedPnlSol: 0,
    avgBuyPrice: 0,
    lastUpdated: Date.now(),
  };
  
  pos.totalBought += tokenAmount;
  pos.currentBalance += tokenAmount;
  pos.costBasisSol += solSpent;
  pos.avgBuyPrice = pos.costBasisSol / pos.totalBought;
  pos.lastUpdated = Date.now();
  if (tokenTicker) pos.ticker = tokenTicker;
  if (tokenName) pos.name = tokenName;
  
  // Create SOL flow
  const flow: SolFlowRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: isLaunchBuy ? 'launch_cost' : 'buy_cost',
    amount: -solSpent,
    description: `${isLaunchBuy ? 'Launch' : 'Buy'} ${tokenTicker || tokenMint.slice(0, 8)}`,
    signature,
  };
  
  if (usePostgres && pgRepo) {
    // PostgreSQL storage
    try {
      await pgRepo.insertTrade(trade);
      await pgRepo.upsertPosition(pos);
      await pgRepo.insertSolFlow(flow);
      logger.info(`[PnLTracker] Recorded buy (PostgreSQL): ${tokenAmount.toLocaleString()} ${tokenTicker || 'tokens'} for ${solSpent.toFixed(4)} SOL`);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error recording buy: ${err}`);
    }
  } else {
    // File storage
    state.trades.push(trade);
    state.positions[tokenMint] = pos;
    state.solFlows.push(flow);
    logger.info(`[PnLTracker] Recorded buy (file): ${tokenAmount.toLocaleString()} ${tokenTicker || 'tokens'} for ${solSpent.toFixed(4)} SOL`);
    saveFileState();
  }
}

/**
 * Record a token sale
 */
export async function recordSell(params: {
  tokenMint: string;
  tokenTicker?: string;
  tokenAmount: number;
  solReceived: number;
  signature?: string;
}): Promise<void> {
  const { tokenMint, tokenTicker, tokenAmount, solReceived, signature } = params;
  
  if (tokenAmount <= 0) {
    logger.warn('[PnLTracker] Invalid sell params, skipping');
    return;
  }
  
  const pricePerToken = solReceived / tokenAmount;
  
  // Create trade record
  const trade: TradeRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'sell',
    tokenMint,
    tokenTicker,
    tokenAmount,
    solAmount: solReceived,
    pricePerToken,
    signature,
  };
  
  // Get existing position
  const existingPos = usePostgres && pgRepo 
    ? await pgRepo.getPosition(tokenMint)
    : state.positions[tokenMint] || null;
  
  let realizedPnl = 0;
  
  if (existingPos) {
    // Calculate realized PnL using FIFO cost basis
    const costBasisForSold = existingPos.avgBuyPrice * tokenAmount;
    realizedPnl = solReceived - costBasisForSold;
    
    existingPos.totalSold += tokenAmount;
    existingPos.currentBalance = Math.max(0, existingPos.currentBalance - tokenAmount);
    existingPos.realizedPnlSol += realizedPnl;
    existingPos.lastUpdated = Date.now();
  }
  
  // Create SOL flow
  const flow: SolFlowRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'sell_proceeds',
    amount: solReceived,
    description: `Sell ${tokenTicker || tokenMint.slice(0, 8)}`,
    signature,
  };
  
  if (usePostgres && pgRepo) {
    // PostgreSQL storage
    try {
      await pgRepo.insertTrade(trade);
      if (existingPos) {
        await pgRepo.upsertPosition(existingPos);
      }
      await pgRepo.insertSolFlow(flow);
      
      // Update summary - add the realized PnL
      if (realizedPnl !== 0) {
        await pgRepo.updateSummary({ addRealizedPnl: realizedPnl });
      }
      
      logger.info(`[PnLTracker] Recorded sell (PostgreSQL): ${tokenAmount.toLocaleString()} ${tokenTicker || 'tokens'} for ${solReceived.toFixed(4)} SOL (PnL: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)} SOL)`);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error recording sell: ${err}`);
    }
  } else {
    // File storage
    state.trades.push(trade);
    if (existingPos) {
      state.positions[tokenMint] = existingPos;
      state.totalRealizedPnl += realizedPnl;
    }
    state.solFlows.push(flow);
    
    if (existingPos) {
      logger.info(`[PnLTracker] Recorded sell (file): ${tokenAmount.toLocaleString()} ${tokenTicker || 'tokens'} for ${solReceived.toFixed(4)} SOL (PnL: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)} SOL)`);
    } else {
      logger.info(`[PnLTracker] Recorded sell (no cost basis): ${tokenAmount.toLocaleString()} ${tokenTicker || 'tokens'} for ${solReceived.toFixed(4)} SOL`);
    }
    saveFileState();
  }
}

/**
 * Record a SOL deposit to pump wallet
 */
export async function recordDeposit(amount: number, signature?: string): Promise<void> {
  const flow: SolFlowRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'deposit',
    amount,
    description: 'Deposit to pump wallet',
    signature,
  };
  
  if (usePostgres && pgRepo) {
    try {
      await pgRepo.insertSolFlow(flow);
      await pgRepo.updateSummary({ addDeposited: amount });
      logger.info(`[PnLTracker] Recorded deposit (PostgreSQL): ${amount.toFixed(4)} SOL`);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error recording deposit: ${err}`);
    }
  } else {
    state.solFlows.push(flow);
    state.totalSolDeposited += amount;
    logger.info(`[PnLTracker] Recorded deposit (file): ${amount.toFixed(4)} SOL`);
    saveFileState();
  }
}

/**
 * Record a SOL withdrawal from pump wallet
 */
export async function recordWithdrawal(amount: number, signature?: string): Promise<void> {
  const flow: SolFlowRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'withdrawal',
    amount: -amount,
    description: 'Withdrawal from pump wallet',
    signature,
  };
  
  if (usePostgres && pgRepo) {
    try {
      await pgRepo.insertSolFlow(flow);
      await pgRepo.updateSummary({ addWithdrawn: amount });
      logger.info(`[PnLTracker] Recorded withdrawal (PostgreSQL): ${amount.toFixed(4)} SOL`);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error recording withdrawal: ${err}`);
    }
  } else {
    state.solFlows.push(flow);
    state.totalSolWithdrawn += amount;
    logger.info(`[PnLTracker] Recorded withdrawal (file): ${amount.toFixed(4)} SOL`);
    saveFileState();
  }
}

/**
 * Calculate unrealized PnL for a position given current price
 */
export function calculateUnrealizedPnl(position: TokenPosition, currentPricePerToken: number): number {
  if (position.currentBalance <= 0) return 0;
  
  const currentValue = position.currentBalance * currentPricePerToken;
  const costBasis = position.avgBuyPrice * position.currentBalance;
  
  return currentValue - costBasis;
}

/**
 * Get all active positions (with balance > 0)
 */
export async function getActivePositions(): Promise<TokenPosition[]> {
  if (usePostgres && pgRepo) {
    try {
      return await pgRepo.getActivePositions();
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error getting active positions: ${err}`);
      return [];
    }
  }
  return Object.values(state.positions).filter(p => p.currentBalance > 0);
}

/**
 * Get all positions (including closed)
 */
export async function getAllPositions(): Promise<TokenPosition[]> {
  if (usePostgres && pgRepo) {
    try {
      return await pgRepo.getAllPositions();
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error getting all positions: ${err}`);
      return [];
    }
  }
  return Object.values(state.positions);
}

/**
 * Get position for a specific token
 */
export async function getPosition(tokenMint: string): Promise<TokenPosition | null> {
  if (usePostgres && pgRepo) {
    try {
      return await pgRepo.getPosition(tokenMint);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error getting position: ${err}`);
      return null;
    }
  }
  return state.positions[tokenMint] || null;
}

/**
 * Get recent trades (last N)
 */
export async function getRecentTrades(limit: number = 10): Promise<TradeRecord[]> {
  if (usePostgres && pgRepo) {
    try {
      return await pgRepo.getRecentTrades(limit);
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error getting recent trades: ${err}`);
      return [];
    }
  }
  return state.trades.slice(-limit).reverse();
}

/**
 * Get PnL summary for display
 */
export interface PnLSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
  totalSolDeposited: number;
  totalSolWithdrawn: number;
  netSolFlow: number;  // deposits - withdrawals
  activePositions: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
}

/**
 * Get PnL summary with unrealized PnL calculation
 * @param currentPrices - Map of mint address to current price per token in SOL
 */
export async function getPnLSummary(currentPrices?: Record<string, number>): Promise<PnLSummary> {
  if (usePostgres && pgRepo) {
    // PostgreSQL mode
    try {
      const summary = await pgRepo.getSummary();
      const positions = await pgRepo.getActivePositions();
      const tradeCount = await pgRepo.getTradeCount();
      const { wins, losses } = await pgRepo.getWinLossStats();
      
      let totalUnrealizedPnl = 0;
      if (currentPrices) {
        for (const pos of positions) {
          if (pos.currentBalance > 0 && currentPrices[pos.mint]) {
            totalUnrealizedPnl += calculateUnrealizedPnl(pos, currentPrices[pos.mint]);
          }
        }
      }
      
      const totalClosedTrades = wins + losses;
      
      return {
        totalRealizedPnl: summary.totalRealizedPnl,
        totalUnrealizedPnl,
        totalPnl: summary.totalRealizedPnl + totalUnrealizedPnl,
        totalSolDeposited: summary.totalSolDeposited,
        totalSolWithdrawn: summary.totalSolWithdrawn,
        netSolFlow: summary.totalSolDeposited - summary.totalSolWithdrawn,
        activePositions: positions.length,
        totalTrades: tradeCount,
        winningTrades: wins,
        losingTrades: losses,
        winRate: totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0,
      };
    } catch (err) {
      logger.error(`[PnLTracker] PostgreSQL error getting summary: ${err}`);
      // Return zeros on error
      return {
        totalRealizedPnl: 0,
        totalUnrealizedPnl: 0,
        totalPnl: 0,
        totalSolDeposited: 0,
        totalSolWithdrawn: 0,
        netSolFlow: 0,
        activePositions: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
      };
    }
  }
  
  // File mode
  let totalUnrealizedPnl = 0;
  
  // Calculate unrealized PnL if current prices provided
  if (currentPrices) {
    for (const pos of Object.values(state.positions)) {
      if (pos.currentBalance > 0 && currentPrices[pos.mint]) {
        totalUnrealizedPnl += calculateUnrealizedPnl(pos, currentPrices[pos.mint]);
      }
    }
  }
  
  // Count winning vs losing trades (sells only)
  const sells = state.trades.filter(t => t.type === 'sell');
  let winningTrades = 0;
  let losingTrades = 0;
  
  for (const sell of sells) {
    const pos = state.positions[sell.tokenMint];
    if (pos) {
      // Compare sell price to avg buy price
      if (sell.pricePerToken > pos.avgBuyPrice) {
        winningTrades++;
      } else {
        losingTrades++;
      }
    }
  }
  
  const totalClosedTrades = winningTrades + losingTrades;
  
  return {
    totalRealizedPnl: state.totalRealizedPnl,
    totalUnrealizedPnl,
    totalPnl: state.totalRealizedPnl + totalUnrealizedPnl,
    totalSolDeposited: state.totalSolDeposited,
    totalSolWithdrawn: state.totalSolWithdrawn,
    netSolFlow: state.totalSolDeposited - state.totalSolWithdrawn,
    activePositions: Object.values(state.positions).filter(p => p.currentBalance > 0).length,
    totalTrades: state.trades.length,
    winningTrades,
    losingTrades,
    winRate: totalClosedTrades > 0 ? (winningTrades / totalClosedTrades) * 100 : 0,
  };
}

/**
 * Format PnL for display (with + or - and SOL suffix)
 */
export function formatPnL(solAmount: number): string {
  const sign = solAmount >= 0 ? '+' : '';
  return `${sign}${solAmount.toFixed(4)} SOL`;
}

/**
 * Format PnL with emoji indicator
 */
export function formatPnLWithEmoji(solAmount: number): string {
  const emoji = solAmount >= 0 ? '🟢' : '🔴';
  const sign = solAmount >= 0 ? '+' : '';
  return `${emoji} ${sign}${solAmount.toFixed(4)} SOL`;
}

/**
 * Initialize PnL tracker
 * - Uses PostgreSQL if DATABASE_URL is set (Railway production)
 * - Falls back to file storage for local development
 */
export async function initPnLTracker(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    // Railway PostgreSQL mode
    try {
      const { PostgresPnLRepository } = await import('../db/postgresPnLRepository.ts');
      pgRepo = await PostgresPnLRepository.create(databaseUrl);
      usePostgres = true;
      logger.info('[PnLTracker] Initialized with PostgreSQL storage (Railway)');
    } catch (err) {
      logger.error(`[PnLTracker] Failed to connect to PostgreSQL, falling back to file: ${err}`);
      loadFileState();
      logger.info('[PnLTracker] Initialized with file storage (fallback)');
    }
  } else {
    // Local file mode
    loadFileState();
    logger.info('[PnLTracker] Initialized with file storage (local)');
  }
}

/**
 * Check if PostgreSQL mode is active
 */
export function isUsingPostgres(): boolean {
  return usePostgres;
}

// Export the state getter for debugging
export function getPnLState(): PnLState {
  return { ...state };
}
