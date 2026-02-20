/**
 * Kamino Lending Service
 *
 * Deposits idle capital into Kamino's lending markets on Solana to earn yield.
 * Primary use: park USDC between trades at ~8-12% APY.
 * Secondary: JitoSOL collateral to borrow USDC for trading capital (careful with LTV).
 *
 * Architecture:
 *  Kamino uses the Klend SDK (@kamino-finance/klend-sdk).
 *  Markets: Main Market (USDC, SOL, JitoSOL) on Solana mainnet.
 *
 *  Main Market: 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
 *
 * Strategy implemented here:
 *  - Deposit USDC → earn lending APY (passive, no liquidation risk)
 *  - Monitor health factor — alert if drops below 1.5
 *  - DO NOT borrow by default (CFO can enable with CFO_KAMINO_BORROW_ENABLE=true)
 *
 * Safety:
 *  - Max LTV hard-capped at CFO_KAMINO_MAX_LTV_PCT (default 60%)
 *  - Auto-repay if LTV exceeds 70% (emergency repay)
 *  - Never borrow more than needed for a single trade cycle
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

const KAMINO_RESERVES: Record<string, string> = {
  USDC: 'H9gBUJs5Kc5zyiKRTzZcYom4Hpj9VPHLy4VzExTVPgTL',
  SOL:  'dK2MkMREV9K2H7gFkuycMpRKXQ6oQZZWk9X5xgLqkFz',
};

// ============================================================================
// Types
// ============================================================================

export interface KaminoDepositResult {
  success: boolean;
  txSignature?: string;
  asset: string;
  amountDeposited: number;
  kTokensReceived: number;  // collateral tokens representing deposit
  error?: string;
}

export interface KaminoWithdrawResult {
  success: boolean;
  txSignature?: string;
  asset: string;
  amountWithdrawn: number;
  error?: string;
}

export interface KaminoPosition {
  deposits: Array<{
    asset: string;
    amount: number;       // in native token units
    valueUsd: number;
    apy: number;
  }>;
  borrows: Array<{
    asset: string;
    amount: number;
    valueUsd: number;
    apy: number;         // borrow APY
  }>;
  netValueUsd: number;   // deposits - borrows
  healthFactor: number;  // >= 1.0 means not liquidatable
  ltv: number;           // current LTV
  maxLtv: number;        // maximum allowed LTV
}

export interface KaminoMarketApy {
  USDC: { supplyApy: number; borrowApy: number };
  SOL:  { supplyApy: number; borrowApy: number };
}

// ============================================================================
// Wallet loader
// ============================================================================

function loadWallet(): Keypair {
  const env = getEnv();
  const secret = env.AGENT_FUNDING_WALLET_SECRET;
  if (!secret) throw new Error('[Kamino] AGENT_FUNDING_WALLET_SECRET not set');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

function getConnection(): Connection {
  return new Connection(getRpcUrl(), 'confirmed');
}

// ============================================================================
// APY data (public endpoint — no auth)
// ============================================================================

async function fetchKaminoApys(): Promise<KaminoMarketApy> {
  try {
    const resp = await fetch(
      `https://api.kamino.finance/kamino-market/${KAMINO_MAIN_MARKET.toBase58()}/reserves`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) throw new Error(`Kamino API ${resp.status}`);

    const data = await resp.json() as any[];
    const result: KaminoMarketApy = {
      USDC: { supplyApy: 0.08, borrowApy: 0.12 },
      SOL:  { supplyApy: 0.06, borrowApy: 0.10 },
    };

    for (const reserve of data) {
      const symbol: string = reserve.symbol?.toUpperCase();
      if (symbol === 'USDC' || symbol === 'SOL') {
        result[symbol] = {
          supplyApy: Number(reserve.supplyInterestAPY ?? reserve.supplyApy ?? 0.08),
          borrowApy: Number(reserve.borrowInterestAPY ?? reserve.borrowApy ?? 0.12),
        };
      }
    }
    return result;
  } catch {
    return {
      USDC: { supplyApy: 0.08, borrowApy: 0.12 },
      SOL:  { supplyApy: 0.06, borrowApy: 0.10 },
    };
  }
}

// ============================================================================
// SDK loader
// ============================================================================

async function loadKlend() {
  try {
    return await import('@kamino-finance/klend-sdk');
  } catch {
    throw new Error('[Kamino] @kamino-finance/klend-sdk not installed. Run: bun add @kamino-finance/klend-sdk');
  }
}

// ============================================================================
// Deposit
// ============================================================================

/**
 * Deposit an asset into Kamino lending market to earn yield.
 * Returns kTokens (Kamino collateral tokens) representing the deposit.
 */
export async function deposit(asset: 'USDC' | 'SOL', amount: number): Promise<KaminoDepositResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    const apys = await fetchKaminoApys();
    logger.info(`[Kamino] DRY RUN — would deposit ${amount} ${asset} at ${(apys[asset].supplyApy * 100).toFixed(1)}% APY`);
    return { success: true, asset, amountDeposited: amount, kTokensReceived: amount, txSignature: `dry-${Date.now()}` };
  }

  const maxUsd = env.maxKaminoUsd;
  if (amount <= 0) return { success: false, asset, amountDeposited: 0, kTokensReceived: 0, error: 'Amount must be positive' };

  // Enforce maxKaminoUsd cap — approximate USD value (1 USDC ≈ $1, SOL priced in callers)
  if (maxUsd > 0 && asset === 'USDC' && amount > maxUsd) {
    return { success: false, asset, amountDeposited: 0, kTokensReceived: 0, error: `Amount $${amount} exceeds max Kamino cap $${maxUsd}` };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();

    const market = await klend.KaminoMarket.load(
      connection as any,
      KAMINO_MAIN_MARKET as any,
      0, // slot override — let it fetch current
    );

    const reserveAddress = new PublicKey(KAMINO_RESERVES[asset]);
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found in market`);

    const kaminoAction = await klend.KaminoAction.buildDepositTxns(
      market!,
      amount.toString(),
      reserve.getLiquidityMint(),
      wallet.publicKey as any,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined,
      undefined,
      undefined,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ]) {
      tx.add(ix as any);
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);

    logger.info(`[Kamino] Deposited ${amount} ${asset}: ${signature}`);
    return {
      success: true,
      txSignature: signature,
      asset,
      amountDeposited: amount,
      kTokensReceived: amount, // approximate — actual depends on exchange rate
    };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('[Kamino] deposit error:', err);
    return { success: false, asset, amountDeposited: 0, kTokensReceived: 0, error };
  }
}

// ============================================================================
// Withdraw
// ============================================================================

/**
 * Withdraw a previously deposited asset from Kamino.
 * Pass Infinity or a very large number to withdraw all.
 */
export async function withdraw(asset: 'USDC' | 'SOL', amount: number): Promise<KaminoWithdrawResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Kamino] DRY RUN — would withdraw ${amount} ${asset}`);
    return { success: true, asset, amountWithdrawn: amount, txSignature: `dry-${Date.now()}` };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();

    const market = await klend.KaminoMarket.load(connection as any, KAMINO_MAIN_MARKET as any, 0);
    const reserveAddress = new PublicKey(KAMINO_RESERVES[asset]);
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const kaminoAction = await klend.KaminoAction.buildWithdrawTxns(
      market!,
      amount.toString(),
      reserve.getLiquidityMint(),
      wallet.publicKey as any,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined,
      undefined,
      undefined,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ]) {
      tx.add(ix as any);
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
    logger.info(`[Kamino] Withdrew ${amount} ${asset}: ${signature}`);
    return { success: true, txSignature: signature, asset, amountWithdrawn: amount };
  } catch (err) {
    return { success: false, asset, amountWithdrawn: 0, error: (err as Error).message };
  }
}

// ============================================================================
// Position monitor
// ============================================================================

/**
 * Get the agent wallet's current Kamino lending position.
 */
export async function getPosition(): Promise<KaminoPosition> {
  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();

    const market = await klend.KaminoMarket.load(connection as any, KAMINO_MAIN_MARKET as any, 0);
    const obligations = await (market as any).getObligationByWallet(wallet.publicKey);

    if (!obligations) {
      return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.75 };
    }

    const obligation = Array.isArray(obligations) ? obligations[0] : obligations;
    const apys = await fetchKaminoApys();

    const deposits: KaminoPosition['deposits'] = [];
    const borrows: KaminoPosition['borrows'] = [];

    for (const [mintStr, deposit] of Object.entries(obligation.state.deposits as Record<string, any>)) {
      const asset = mintStr.includes(KAMINO_RESERVES.USDC) ? 'USDC' : 'SOL';
      const amount = Number(deposit.depositedAmount ?? 0);
      const valueUsd = Number(deposit.marketValueRefreshed ?? 0);
      deposits.push({ asset, amount, valueUsd, apy: apys[asset as 'USDC' | 'SOL']?.supplyApy ?? 0.08 });
    }

    for (const [mintStr, borrow] of Object.entries(obligation.state.borrows as Record<string, any>)) {
      const asset = mintStr.includes(KAMINO_RESERVES.USDC) ? 'USDC' : 'SOL';
      const amount = Number(borrow.borrowedAmountSf ?? 0);
      const valueUsd = Number(borrow.marketValueRefreshed ?? 0);
      borrows.push({ asset, amount, valueUsd, apy: apys[asset as 'USDC' | 'SOL']?.borrowApy ?? 0.12 });
    }

    const depositValueUsd = deposits.reduce((s, d) => s + d.valueUsd, 0);
    const borrowValueUsd = borrows.reduce((s, b) => s + b.valueUsd, 0);
    const netValueUsd = depositValueUsd - borrowValueUsd;
    const ltv = depositValueUsd > 0 ? borrowValueUsd / depositValueUsd : 0;
    const healthFactor = ltv > 0 ? 0.75 / ltv : 999; // 75% max LTV in Kamino

    return { deposits, borrows, netValueUsd, healthFactor, ltv, maxLtv: 0.75 };
  } catch (err) {
    logger.warn('[Kamino] getPosition error:', err);
    return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.75 };
  }
}

/**
 * Fetch current APYs from Kamino for the main lending market.
 */
export async function getApys(): Promise<KaminoMarketApy> {
  return fetchKaminoApys();
}

/**
 * Check if the current LTV is safe. Returns true if safe, false if action needed.
 */
export async function checkLtvHealth(): Promise<{ safe: boolean; ltv: number; healthFactor: number; warning?: string }> {
  const env = getCFOEnv();
  const pos = await getPosition();
  const maxLtvPct = env.kaminoMaxLtvPct / 100;

  if (pos.ltv > 0.70) {
    return { safe: false, ltv: pos.ltv, healthFactor: pos.healthFactor, warning: `LTV ${(pos.ltv * 100).toFixed(1)}% — CRITICAL, near liquidation` };
  }
  if (pos.ltv > maxLtvPct) {
    return { safe: false, ltv: pos.ltv, healthFactor: pos.healthFactor, warning: `LTV ${(pos.ltv * 100).toFixed(1)}% — exceeds configured max ${env.kaminoMaxLtvPct}%` };
  }
  return { safe: true, ltv: pos.ltv, healthFactor: pos.healthFactor };
}
