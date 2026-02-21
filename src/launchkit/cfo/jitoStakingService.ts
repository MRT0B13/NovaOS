/**
 * Jito Liquid Staking Service
 *
 * Stakes SOL into Jito's liquid staking pool to earn ~7-8% APY via MEV rewards.
 * Returns JitoSOL which remains liquid — can be used as collateral in Kamino.
 *
 * Implementation:
 *  Jito does NOT have a TypeScript SDK for staking — it's a direct Solana
 *  program call to the Jito Stake Pool program.
 *
 *  Program: Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Posko (mainnet)
 *  JitoSOL mint: J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn
 *
 *  Staking:
 *    depositSol(stakePool, reserveStakeAccount, userWallet, poolTokenRecipient, amount)
 *
 *  The SPL Stake Pool program (spl-stake-pool) handles the math.
 *  We use the @solana/spl-stake-pool package which wraps these calls.
 *
 *  Unstaking (delayed):
 *    withdrawSol → creates a stake account that unlocks after 2-3 epochs (~2-3 days)
 *  Instant unstake:
 *    Use Jupiter to swap JitoSOL → SOL at market rate (slight discount vs NAV)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants — lazy-init PublicKey to avoid Bun TDZ issues with dynamic imports
// ============================================================================

const JITO_STAKE_POOL_STR = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb';
const JITOSOL_MINT_STR = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const JITO_RESERVE_STAKE_STR = 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL';
const JITO_FEE_ACCOUNT_STR = '8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa';

let _JITO_STAKE_POOL: PublicKey | null = null;
let _JITOSOL_MINT: PublicKey | null = null;
let _JITO_RESERVE_STAKE: PublicKey | null = null;
let _JITO_FEE_ACCOUNT: PublicKey | null = null;

function getJitoStakePool(): PublicKey { return _JITO_STAKE_POOL ??= new PublicKey(JITO_STAKE_POOL_STR); }
function getJitoSolMint(): PublicKey { return _JITOSOL_MINT ??= new PublicKey(JITOSOL_MINT_STR); }
function getJitoReserveStake(): PublicKey { return _JITO_RESERVE_STAKE ??= new PublicKey(JITO_RESERVE_STAKE_STR); }
function getJitoFeeAccount(): PublicKey { return _JITO_FEE_ACCOUNT ??= new PublicKey(JITO_FEE_ACCOUNT_STR); }

// Re-exported as string for consumers (portfolioService passes to getTokenBalance which takes string)
const JITOSOL_MINT = JITOSOL_MINT_STR;

// Minimum stake amount (Jito enforces 0.01 SOL minimum)
const MIN_STAKE_SOL = 0.01;

// Leave this much SOL unstaked for transaction fees
const GAS_RESERVE_SOL = 0.05;

// ============================================================================
// Types
// ============================================================================

export interface JitoStakeResult {
  success: boolean;
  txSignature?: string;
  stakedSol: number;
  jitoSolReceived: number;
  error?: string;
}

export interface JitoUnstakeResult {
  success: boolean;
  txSignature?: string;
  jitoSolBurned: number;
  solReceived: number;    // for instant unstake via Jupiter swap
  method: 'delayed' | 'instant';
  error?: string;
}

export interface JitoStakePosition {
  jitoSolBalance: number;
  jitoSolValueSol: number;      // JitoSOL balance * current exchange rate
  jitoSolValueUsd: number;
  exchangeRate: number;         // SOL per JitoSOL
  apy: number;
  stakingRewardsEarned: number; // unrealised, in SOL
}

// ============================================================================
// Wallet loader
// ============================================================================

function loadWallet(): Keypair {
  const env = getEnv();
  const secret = env.AGENT_FUNDING_WALLET_SECRET;
  if (!secret) throw new Error('[Jito] AGENT_FUNDING_WALLET_SECRET not set');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

function getConnection(): Connection {
  return new Connection(getRpcUrl(), 'confirmed');
}

// ============================================================================
// Exchange rate (SOL per JitoSOL)
// Fetched from Jito's public stats API — no auth required.
// ============================================================================

interface JitoStats {
  apy: number;
  tvl: number;
  exchange_rate: number;  // SOL per JitoSOL
}

// Use `var` to avoid Bun temporal-dead-zone issues when module is loaded via dynamic import
var _statsCache: { data: JitoStats; at: number } | null = null;

async function getJitoStats(): Promise<JitoStats> {
  if (_statsCache && Date.now() - _statsCache.at < 5 * 60_000) return _statsCache.data;

  try {
    const resp = await fetch('https://kobe.mainnet.jito.network/api/v1/pool_stats', {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json() as JitoStats;
      _statsCache = { data, at: Date.now() };
      return data;
    }
  } catch { /* fall through to default */ }

  // Fallback to known conservative values
  return { apy: 7.5, tvl: 0, exchange_rate: 1.05 };
}

// ============================================================================
// Token account helper
// ============================================================================

async function getOrCreateJitoSolTokenAccount(
  connection: Connection,
  wallet: Keypair,
): Promise<PublicKey> {
  // Use @solana/spl-token if available, otherwise derive ATA manually
  try {
    const splToken = await import('@solana/spl-token');
    const ata = await splToken.getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      getJitoSolMint(),
      wallet.publicKey,
    );
    return ata.address;
  } catch (err) {
    throw new Error(`[Jito] Failed to get/create JitoSOL token account: ${(err as Error).message}. Run: bun add @solana/spl-token`);
  }
}

// ============================================================================
// Stake SOL → JitoSOL
// ============================================================================

/**
 * Deposit SOL into the Jito stake pool and receive JitoSOL in return.
 */
export async function stakeSol(solAmount: number): Promise<JitoStakeResult> {
  const env = getCFOEnv();

  if (solAmount < MIN_STAKE_SOL) {
    return { success: false, stakedSol: 0, jitoSolReceived: 0, error: `Minimum stake is ${MIN_STAKE_SOL} SOL` };
  }

  // Enforce maxJitoSol cap
  const maxSol = env.maxJitoSol;
  if (maxSol > 0 && solAmount > maxSol) {
    return { success: false, stakedSol: 0, jitoSolReceived: 0, error: `Amount ${solAmount} SOL exceeds max cap ${maxSol} SOL` };
  }

  if (env.dryRun) {
    logger.info(`[Jito] DRY RUN — would stake ${solAmount} SOL`);
    const stats = await getJitoStats();
    return {
      success: true,
      txSignature: `dry-${Date.now()}`,
      stakedSol: solAmount,
      jitoSolReceived: solAmount / stats.exchange_rate,
    };
  }

  try {
    const wallet = loadWallet();
    const connection = getConnection();

    // Check balance
    const balance = await connection.getBalance(wallet.publicKey);
    const balSol = balance / LAMPORTS_PER_SOL;
    if (balSol < solAmount + GAS_RESERVE_SOL) {
      return {
        success: false,
        stakedSol: 0,
        jitoSolReceived: 0,
        error: `Insufficient balance: ${balSol.toFixed(3)} SOL (need ${(solAmount + GAS_RESERVE_SOL).toFixed(3)})`,
      };
    }

    // Try using @solana/spl-stake-pool
    const stakePoolLib = await import('@solana/spl-stake-pool');

    const jitoSolAta = await getOrCreateJitoSolTokenAccount(connection, wallet);
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    const { instructions, signers } = await stakePoolLib.depositSol(
      connection as any,
      getJitoStakePool() as any,
      wallet.publicKey as any,
      lamports as any,
      jitoSolAta as any,     // destinationTokenAccount
    );

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signature = await sendAndConfirmTransaction(connection, tx, [wallet, ...signers]);

    // Calculate JitoSOL received (approximate from exchange rate)
    const stats = await getJitoStats();
    const jitoSolReceived = solAmount / stats.exchange_rate;

    logger.info(`[Jito] Staked ${solAmount} SOL → ${jitoSolReceived.toFixed(4)} JitoSOL: ${signature}`);
    return { success: true, txSignature: signature, stakedSol: solAmount, jitoSolReceived };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('[Jito] stakeSol error:', err);
    return { success: false, stakedSol: 0, jitoSolReceived: 0, error };
  }
}

// ============================================================================
// Instant Unstake (Jupiter swap JitoSOL → SOL)
// ============================================================================

/**
 * Instant unstake by swapping JitoSOL → SOL via Jupiter.
 * Slightly worse rate than NAV but immediate liquidity.
 */
export async function instantUnstake(jitoSolAmount: number): Promise<JitoUnstakeResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    const stats = await getJitoStats();
    const solReceived = jitoSolAmount * stats.exchange_rate * 0.997; // ~0.3% slippage
    logger.info(`[Jito] DRY RUN — would instant-unstake ${jitoSolAmount} JitoSOL → ~${solReceived.toFixed(4)} SOL`);
    return { success: true, jitoSolBurned: jitoSolAmount, solReceived, method: 'instant', txSignature: `dry-${Date.now()}` };
  }

  try {
    // Import Jupiter service to do the swap
    const { getQuote, executeSwap } = await import('./jupiterService.ts');
    const { MINTS } = await import('./jupiterService.ts');

    const JITOSOL_MINT_STR_VAL = getJitoSolMint().toBase58();

    const quote = await getQuote(JITOSOL_MINT_STR_VAL, MINTS.SOL, jitoSolAmount, 100); // 1% slippage
    if (!quote) {
      return { success: false, jitoSolBurned: 0, solReceived: 0, method: 'instant', error: 'Failed to get swap quote' };
    }

    const result = await executeSwap(quote, { maxPriceImpactPct: 1.5 });
    if (!result.success) {
      return { success: false, jitoSolBurned: jitoSolAmount, solReceived: 0, method: 'instant', error: result.error };
    }

    logger.info(`[Jito] Instant unstake ${jitoSolAmount} JitoSOL → ${result.outputAmount.toFixed(4)} SOL: ${result.txSignature}`);
    return {
      success: true,
      txSignature: result.txSignature,
      jitoSolBurned: jitoSolAmount,
      solReceived: result.outputAmount,
      method: 'instant',
    };
  } catch (err) {
    return { success: false, jitoSolBurned: 0, solReceived: 0, method: 'instant', error: (err as Error).message };
  }
}

// ============================================================================
// Portfolio status
// ============================================================================

/**
 * Get current Jito staking position for the agent wallet.
 */
export async function getStakePosition(solPriceUsd: number): Promise<JitoStakePosition> {
  const zero: JitoStakePosition = { jitoSolBalance: 0, jitoSolValueSol: 0, jitoSolValueUsd: 0, exchangeRate: 1.05, apy: 7.5, stakingRewardsEarned: 0 };
  try {
    let wallet: ReturnType<typeof loadWallet>;
    try { wallet = loadWallet(); } catch { return zero; }
    const connection = getConnection();
    const stats = await getJitoStats();

    // Get JitoSOL token account balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: getJitoSolMint(),
    });

    const jitoSolBalance = tokenAccounts.value.length > 0
      ? Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount) || 0
      : 0;

    const jitoSolValueSol = jitoSolBalance * stats.exchange_rate;
    const jitoSolValueUsd = jitoSolValueSol * solPriceUsd;

    // Approximate staking rewards: value minus principal (not perfect but directionally correct)
    const stakingRewardsEarned = Math.max(0, jitoSolValueSol - jitoSolBalance);

    return {
      jitoSolBalance,
      jitoSolValueSol,
      jitoSolValueUsd,
      exchangeRate: stats.exchange_rate,
      apy: stats.apy,
      stakingRewardsEarned,
    };
  } catch (err) {
    logger.warn('[Jito] getStakePosition error:', err);
    return zero;
  }
}

export { JITOSOL_MINT };
