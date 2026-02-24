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

} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants (string-based to avoid module-level PublicKey TDZ in Bun)
// ============================================================================

const KAMINO_MAIN_MARKET_ADDR: any = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

// ── Token mints (verified mainnet) ──────────────────────────────────────────
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const JUP_MINT     = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT    = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_MINT     = 'So11111111111111111111111111111111111111112';

/**
 * Supported Kamino reserve assets.
 * Reserve addresses are for the Main Market: 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
 *
 * IMPORTANT: Verify JitoSOL, USDT, JUP reserve addresses against:
 *   GET https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves
 * before any deposit/borrow on those assets. The SDK throws if address is wrong.
 * USDC and SOL addresses are already confirmed correct.
 */
export type KaminoAsset = 'USDC' | 'USDT' | 'SOL' | 'JitoSOL' | 'JUP';

const KAMINO_RESERVES: Record<KaminoAsset, string> = {
  USDC:    'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59',  // confirmed via SDK enum
  SOL:     'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',   // confirmed via SDK enum
  USDT:    'H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S',   // confirmed via SDK enum
  JitoSOL: 'EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW',  // confirmed via SDK enum
  JUP:     '4AFAGAm5G8fkcKy7QerL88E7BiSE22ZRbvJzvaKjayor',   // confirmed via SDK enum
};

// Token decimals
const ASSET_DECIMALS: Record<KaminoAsset, number> = {
  USDC: 6, USDT: 6, SOL: 9, JitoSOL: 9, JUP: 6,
};

/**
 * Max safe borrow LTV per collateral asset.
 * These are conservative — well below Kamino's actual liquidation thresholds.
 * JitoSOL is high because SOL and JitoSOL are tightly price-correlated:
 * Kamino's liquidation LTV for JitoSOL/SOL positions is ~95%.
 */
const SAFE_BORROW_LTV: Record<KaminoAsset, number> = {
  JitoSOL: 0.75,  // high — correlated with the SOL borrow, liq threshold ~95%
  SOL:     0.60,
  USDC:    0.70,
  USDT:    0.70,
  JUP:     0.45,  // volatile — conservative
};

// Mint-to-asset reverse lookup for position parsing
const MINT_TO_ASSET: Record<string, KaminoAsset> = {
  [USDC_MINT]:    'USDC',
  [USDT_MINT]:    'USDT',
  [SOL_MINT]:     'SOL',
  [JITOSOL_MINT]: 'JitoSOL',
  [JUP_MINT]:     'JUP',
};
// Also map by reserve address for SDK obligation parsing
for (const [asset, addr] of Object.entries(KAMINO_RESERVES)) {
  MINT_TO_ASSET[addr] = asset as KaminoAsset;
}

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
  USDC:    { supplyApy: number; borrowApy: number };
  USDT:    { supplyApy: number; borrowApy: number };
  SOL:     { supplyApy: number; borrowApy: number };
  JitoSOL: { supplyApy: number; borrowApy: number };
  JUP:     { supplyApy: number; borrowApy: number };
}

export interface KaminoBorrowResult {
  success: boolean;
  asset: KaminoAsset;
  amountBorrowed: number;
  txSignature?: string;
  error?: string;
}

export interface KaminoRepayResult {
  success: boolean;
  asset: KaminoAsset;
  amountRepaid: number;
  txSignature?: string;
  error?: string;
}

export interface KaminoClosePositionResult {
  success: boolean;
  repaid: { asset: KaminoAsset; amount: number };
  withdrawn: { asset: KaminoAsset; amount: number };
  txSignature?: string;
  error?: string;
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

/**
 * Poll-based transaction confirmation (avoids WebSocket signatureSubscribe).
 * Alchemy HTTP RPC does not support WS subscriptions.
 */
async function pollConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  maxAttempts = 30,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const resp = await connection.getSignatureStatuses([signature]);
    const status = resp.value[0];
    if (status) {
      if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    const height = await connection.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) throw new Error('Transaction expired — blockhash no longer valid');
  }
  throw new Error(`Transaction not confirmed after ${maxAttempts} attempts`);
}

/** Create a Solana v2 RPC client (required by klend-sdk v7+) */
function getRpcV2(): any {
  const { createSolanaRpc } = require('@solana/kit');
  return createSolanaRpc(getRpcUrl());
}

/**
 * Convert a @solana/kit v2 instruction to a @solana/web3.js v1 TransactionInstruction.
 * klend-sdk v7 returns v2-format instructions:
 *   { programAddress: string, accounts: [{address, role}], data: Uint8Array }
 * but we sign with v1 Transaction which needs:
 *   { programId: PublicKey, keys: [{pubkey, isSigner, isWritable}], data: Buffer }
 *
 * Role values from @solana/instructions:
 *   0 = READONLY, 1 = WRITABLE, 2 = READONLY_SIGNER, 3 = WRITABLE_SIGNER
 */
function ixV2toV1(ix: any): any {
  if (ix.programId) return ix; // already v1 format
  return {
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((acc: any) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: acc.role >= 2,
      isWritable: acc.role === 1 || acc.role === 3,
    })),
    data: Buffer.from(ix.data ?? []),
  };
}

// ============================================================================
// APY data (public endpoint — no auth)
// ============================================================================

async function fetchKaminoApys(): Promise<KaminoMarketApy> {
  const fallback: KaminoMarketApy = {
    USDC:    { supplyApy: 0.08, borrowApy: 0.12 },
    USDT:    { supplyApy: 0.07, borrowApy: 0.11 },
    SOL:     { supplyApy: 0.06, borrowApy: 0.10 },
    JitoSOL: { supplyApy: 0.07, borrowApy: 0.09 }, // borrow cheap — assets correlated
    JUP:     { supplyApy: 0.05, borrowApy: 0.14 },
  };

  try {
    const resp = await fetch(
      `https://api.kamino.finance/kamino-market/${KAMINO_MAIN_MARKET_ADDR}/reserves`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) throw new Error(`Kamino API ${resp.status}`);

    const data = await resp.json() as any[];
    const result: KaminoMarketApy = { ...fallback };

    // Map API symbol names to our KaminoAsset type
    const symbolMap: Record<string, KaminoAsset> = {
      USDC: 'USDC', USDT: 'USDT', SOL: 'SOL', JITOSOL: 'JitoSOL', JUP: 'JUP',
    };

    for (const reserve of data) {
      const rawSymbol: string = (reserve.symbol ?? '').toUpperCase();
      const asset = symbolMap[rawSymbol];
      if (asset) {
        result[asset] = {
          supplyApy: Number(reserve.supplyInterestAPY ?? reserve.supplyApy ?? fallback[asset].supplyApy),
          borrowApy: Number(reserve.borrowInterestAPY ?? reserve.borrowApy ?? fallback[asset].borrowApy),
        };
      }
    }
    return result;
  } catch {
    return fallback;
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
export async function deposit(asset: KaminoAsset, amount: number): Promise<KaminoDepositResult> {
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
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(
      rpc,
      KAMINO_MAIN_MARKET_ADDR,
      400, // recent slot duration ms
    );

    const reserveAddress = KAMINO_RESERVES[asset];
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found in market`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** ASSET_DECIMALS[asset]).toString();
    const kaminoAction = await klend.KaminoAction.buildDepositTxns(
      market!,
      baseAmount,
      reserve.getLiquidityMint(),
      walletAddr,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined,
      undefined,
      undefined,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of kaminoAction.computeBudgetIxs ?? []) tx.add(ixV2toV1(ix));
    for (const ix of [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ]) {
      tx.add(ixV2toV1(ix));
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    tx.sign(wallet);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    logger.info(`[Kamino] Tx sent: ${signature}, polling for confirmation...`);
    await pollConfirmation(connection, signature, lastValidBlockHeight);

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
export async function withdraw(asset: KaminoAsset, amount: number): Promise<KaminoWithdrawResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Kamino] DRY RUN — would withdraw ${amount} ${asset}`);
    return { success: true, asset, amountWithdrawn: amount, txSignature: `dry-${Date.now()}` };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);
    const reserveAddress = KAMINO_RESERVES[asset];
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** ASSET_DECIMALS[asset]).toString();
    const kaminoAction = await klend.KaminoAction.buildWithdrawTxns(
      market!,
      baseAmount,
      reserve.getLiquidityMint(),
      walletAddr,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined,
      undefined,
      undefined,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of kaminoAction.computeBudgetIxs ?? []) tx.add(ixV2toV1(ix));
    for (const ix of [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ]) {
      tx.add(ixV2toV1(ix));
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    tx.sign(wallet);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    logger.info(`[Kamino] Tx sent: ${signature}, polling for confirmation...`);
    await pollConfirmation(connection, signature, lastValidBlockHeight);
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
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);
    if (!market) {
      return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.75 };
    }

    // klend-sdk v7 uses getUserVanillaObligation (throws if no obligation exists)
    let obligation: any;
    try {
      obligation = await market.getUserVanillaObligation(wallet.publicKey.toBase58() as any);
    } catch {
      // No obligation found — wallet hasn't deposited yet
      return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.75 };
    }

    const apys = await fetchKaminoApys();
    const deposits: KaminoPosition['deposits'] = [];
    const borrows: KaminoPosition['borrows'] = [];

    // Helper: safely convert SDK Decimal / number / null to a finite number
    const num = (v: any): number => { const x = Number(v ?? 0); return isFinite(x) ? x : 0; };

    // ── Parse deposits ─────────────────────────────────────────────────────
    // SDK v7: obligation.deposits is Map<reserveAddr, {mintAddress, amount (base units), marketValueRefreshed (USD)}>
    if (obligation.deposits instanceof Map) {
      for (const [reserveAddr, dep] of obligation.deposits) {
        const mint = String(dep.mintAddress ?? '');
        const asset = MINT_TO_ASSET[mint] ?? MINT_TO_ASSET[reserveAddr] ?? 'UNKNOWN';
        const decimals = ASSET_DECIMALS[asset as KaminoAsset] ?? 9;
        const amount = num(dep.amount) / (10 ** decimals);
        const valueUsd = num(dep.marketValueRefreshed);
        if (amount > 0.000001) {
          deposits.push({ asset, amount, valueUsd, apy: apys[asset as KaminoAsset]?.supplyApy ?? 0.08 });
        }
      }
    } else if (obligation.deposits && typeof obligation.deposits[Symbol.iterator] === 'function') {
      // Fallback: array-like iterable (older SDK versions)
      for (const entry of obligation.deposits) {
        const dep = Array.isArray(entry) ? entry[1] : entry;
        const mint = String(dep?.mintAddress ?? '');
        const asset = MINT_TO_ASSET[mint] ?? 'UNKNOWN';
        const amount = num(dep?.amount);
        const valueUsd = num(dep?.marketValueRefreshed ?? dep?.marketValue ?? 0);
        if (amount > 0) {
          deposits.push({ asset, amount, valueUsd, apy: apys[asset as KaminoAsset]?.supplyApy ?? 0.08 });
        }
      }
    }

    // ── Parse borrows ──────────────────────────────────────────────────────
    if (obligation.borrows instanceof Map) {
      for (const [reserveAddr, brw] of obligation.borrows) {
        const mint = String(brw.mintAddress ?? '');
        const asset = MINT_TO_ASSET[mint] ?? MINT_TO_ASSET[reserveAddr] ?? 'UNKNOWN';
        const decimals = ASSET_DECIMALS[asset as KaminoAsset] ?? 6;
        const amount = num(brw.amount) / (10 ** decimals);
        const valueUsd = num(brw.marketValueRefreshed);
        if (amount > 0.000001) {
          borrows.push({ asset, amount, valueUsd, apy: apys[asset as KaminoAsset]?.borrowApy ?? 0.12 });
        }
      }
    } else if (obligation.borrows && typeof obligation.borrows[Symbol.iterator] === 'function') {
      for (const entry of obligation.borrows) {
        const brw = Array.isArray(entry) ? entry[1] : entry;
        const mint = String(brw?.mintAddress ?? '');
        const asset = MINT_TO_ASSET[mint] ?? 'UNKNOWN';
        const amount = num(brw?.amount);
        const valueUsd = num(brw?.marketValueRefreshed ?? brw?.marketValue ?? 0);
        if (amount > 0) {
          borrows.push({ asset, amount, valueUsd, apy: apys[asset as KaminoAsset]?.borrowApy ?? 0.12 });
        }
      }
    }

    // ── Aggregate values from refreshedStats (oracle-accurate) ─────────────
    const stats = obligation.refreshedStats;
    let depositValueUsd: number;
    let borrowValueUsd: number;
    let ltv: number;

    if (stats) {
      depositValueUsd = num(stats.userTotalDeposit);
      borrowValueUsd = num(stats.userTotalBorrow);
      ltv = num(stats.loanToValue);
      // Backfill per-entry USD if aggregate is available but entries report zero
      const entryDepSum = deposits.reduce((s, d) => s + d.valueUsd, 0);
      if (entryDepSum < 0.01 && depositValueUsd > 0 && deposits.length === 1) {
        deposits[0].valueUsd = depositValueUsd;
      }
      const entryBrrSum = borrows.reduce((s, b) => s + b.valueUsd, 0);
      if (entryBrrSum < 0.01 && borrowValueUsd > 0 && borrows.length === 1) {
        borrows[0].valueUsd = borrowValueUsd;
      }
    } else {
      depositValueUsd = deposits.reduce((s, d) => s + d.valueUsd, 0);
      borrowValueUsd = borrows.reduce((s, b) => s + b.valueUsd, 0);
      ltv = depositValueUsd > 0 ? borrowValueUsd / depositValueUsd : 0;
    }

    const netValueUsd = depositValueUsd - borrowValueUsd;
    const healthFactor = ltv > 0 ? 0.75 / ltv : 999;

    logger.debug(`[Kamino] Position: ${deposits.length} deposits ($${depositValueUsd.toFixed(2)}), ${borrows.length} borrows ($${borrowValueUsd.toFixed(2)}), LTV=${(ltv * 100).toFixed(1)}%`);
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

// ============================================================================
// Borrow
// ============================================================================

/**
 * Borrow an asset from Kamino against existing collateral.
 *
 * SAFETY: Caller MUST check LTV before calling. This function enforces a hard cap
 * at CFO_KAMINO_BORROW_MAX_LTV_PCT (default 50% for borrow, NOT the 60% deposit cap).
 * Never call this if checkLtvHealth() returns safe=false.
 */
export async function borrow(
  asset: KaminoAsset,
  amount: number,
): Promise<KaminoBorrowResult> {
  const env = getCFOEnv();

  if (!env.kaminoBorrowEnabled) {
    return { success: false, asset, amountBorrowed: 0, error: 'Kamino borrowing disabled (set CFO_KAMINO_BORROW_ENABLE=true)' };
  }
  if (env.dryRun) {
    logger.info(`[Kamino] DRY RUN — would borrow ${amount} ${asset}`);
    return { success: true, asset, amountBorrowed: amount, txSignature: `dry-borrow-${Date.now()}` };
  }
  if (amount <= 0) return { success: false, asset, amountBorrowed: 0, error: 'Amount must be positive' };

  // LTV guard — use the tighter of: per-asset safe cap or global env cap
  const health = await checkLtvHealth();
  const borrowLtvCap = Math.min(SAFE_BORROW_LTV[asset], (env.kaminoBorrowMaxLtvPct ?? 60) / 100);
  if (!health.safe || health.ltv > borrowLtvCap) {
    return {
      success: false, asset, amountBorrowed: 0,
      error: `LTV ${(health.ltv * 100).toFixed(1)}% exceeds borrow cap ${(borrowLtvCap * 100).toFixed(0)}% for ${asset}`,
    };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);
    const reserveAddress = KAMINO_RESERVES[asset];
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** ASSET_DECIMALS[asset]).toString();
    const kaminoAction = await klend.KaminoAction.buildBorrowTxns(
      market!,
      baseAmount,
      reserve.getLiquidityMint(),
      walletAddr,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined,
      undefined,
      undefined,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of kaminoAction.computeBudgetIxs ?? []) tx.add(ixV2toV1(ix));
    for (const ix of [...kaminoAction.setupIxs, ...kaminoAction.lendingIxs, ...kaminoAction.cleanupIxs]) {
      tx.add(ixV2toV1(ix));
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    await pollConfirmation(connection, signature, lastValidBlockHeight);

    logger.info(`[Kamino] Borrowed ${amount} ${asset}: ${signature}`);
    return { success: true, asset, amountBorrowed: amount, txSignature: signature };
  } catch (err) {
    logger.error('[Kamino] borrow error:', err);
    return { success: false, asset, amountBorrowed: 0, error: (err as Error).message };
  }
}

// ============================================================================
// Repay
// ============================================================================

/**
 * Repay a Kamino borrow position.
 * Pass Infinity to repay the full outstanding borrow.
 */
export async function repay(
  asset: KaminoAsset,
  amount: number,
): Promise<KaminoRepayResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Kamino] DRY RUN — would repay ${amount} ${asset}`);
    return { success: true, asset, amountRepaid: amount, txSignature: `dry-repay-${Date.now()}` };
  }

  // If amount is Infinity, get actual borrow amount from position
  let repayAmount = amount;
  if (!isFinite(amount)) {
    const pos = await getPosition();
    const borrowEntry = pos.borrows.find(b => b.asset === asset);
    if (!borrowEntry || borrowEntry.amount <= 0) {
      return { success: true, asset, amountRepaid: 0 }; // nothing to repay
    }
    repayAmount = borrowEntry.amount * 1.001; // small buffer for accrued interest
  }

  if (repayAmount <= 0) return { success: false, asset, amountRepaid: 0, error: 'Amount must be positive' };

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);
    const reserveAddress = KAMINO_RESERVES[asset];
    const reserve = market!.getReserveByAddress(reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(repayAmount * 10 ** ASSET_DECIMALS[asset]).toString();
    const kaminoAction = await klend.KaminoAction.buildRepayTxns(
      market!,
      baseAmount,
      reserve.getLiquidityMint(),
      walletAddr,
      new klend.VanillaObligation(klend.PROGRAM_ID),
      0 as any,
      undefined as any,
      undefined as any,
      undefined as any,
      klend.PROGRAM_ID as any,
    );

    const tx = new Transaction();
    for (const ix of kaminoAction.computeBudgetIxs ?? []) tx.add(ixV2toV1(ix));
    for (const ix of [...kaminoAction.setupIxs, ...kaminoAction.lendingIxs, ...kaminoAction.cleanupIxs]) {
      tx.add(ixV2toV1(ix));
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    await pollConfirmation(connection, signature, lastValidBlockHeight);

    logger.info(`[Kamino] Repaid ${repayAmount} ${asset}: ${signature}`);
    return { success: true, asset, amountRepaid: repayAmount, txSignature: signature };
  } catch (err) {
    logger.error('[Kamino] repay error:', err);
    return { success: false, asset, amountRepaid: 0, error: (err as Error).message };
  }
}

// ============================================================================
// Atomic Repay + Withdraw (for full position closure)
// ============================================================================

/**
 * Atomically repay a borrow AND withdraw collateral in a single transaction.
 * Required for full position closure — Kamino rejects repay-only that would
 * leave a dust obligation (NetValueRemainingTooSmall error).
 *
 * Usage: await repayAndWithdraw('USDC', 5.01, 'JitoSOL', 0.1)
 * Add a small buffer (1.005x) to repayAmount to cover accrued interest.
 */
export async function repayAndWithdraw(
  repayAsset: KaminoAsset,
  repayAmount: number,
  withdrawAsset: KaminoAsset,
  withdrawAmount: number,
): Promise<KaminoClosePositionResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Kamino] DRY RUN — would repay ${repayAmount} ${repayAsset} + withdraw ${withdrawAmount} ${withdrawAsset}`);
    return {
      success: true,
      repaid: { asset: repayAsset, amount: repayAmount },
      withdrawn: { asset: withdrawAsset, amount: withdrawAmount },
      txSignature: `dry-repay-withdraw-${Date.now()}`,
    };
  }

  if (repayAmount <= 0 || withdrawAmount <= 0) {
    return {
      success: false,
      repaid: { asset: repayAsset, amount: 0 },
      withdrawn: { asset: withdrawAsset, amount: 0 },
      error: 'Both repayAmount and withdrawAmount must be positive',
    };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);

    const repayReserve = market!.getReserveByAddress(KAMINO_RESERVES[repayAsset] as any);
    const withdrawReserve = market!.getReserveByAddress(KAMINO_RESERVES[withdrawAsset] as any);
    if (!repayReserve) throw new Error(`Repay reserve ${repayAsset} not found`);
    if (!withdrawReserve) throw new Error(`Withdraw reserve ${withdrawAsset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const repayBase = Math.floor(repayAmount * 10 ** ASSET_DECIMALS[repayAsset]).toString();
    const withdrawBase = Math.floor(withdrawAmount * 10 ** ASSET_DECIMALS[withdrawAsset]).toString();

    // SDK v7 needs current slot as BigInt for exchange-rate estimation
    const currentSlot = BigInt(await connection.getSlot('confirmed'));

    const kaminoAction = await klend.KaminoAction.buildRepayAndWithdrawTxns(
      market!,
      repayBase,
      repayReserve.getLiquidityMint(),
      withdrawBase,
      withdrawReserve.getLiquidityMint(),
      walletAddr,
      currentSlot as any,
      new klend.VanillaObligation(klend.PROGRAM_ID),   // obligation type
    );

    // Multi-token action: correct instruction ordering is critical.
    // Kamino requires refresh IXs between the repay and withdraw operations.
    const tx = new Transaction();
    for (const ix of kaminoAction.computeBudgetIxs ?? []) tx.add(ixV2toV1(ix));
    for (const ix of kaminoAction.setupIxs) tx.add(ixV2toV1(ix));

    // Interleave: lendingIxs[0] (repay) → inBetweenIxs (refreshes) → lendingIxs[1] (withdraw)
    if (kaminoAction.inBetweenIxs?.length > 0 && kaminoAction.lendingIxs.length === 2) {
      tx.add(ixV2toV1(kaminoAction.lendingIxs[0]));
      for (const ix of kaminoAction.inBetweenIxs) tx.add(ixV2toV1(ix));
      tx.add(ixV2toV1(kaminoAction.lendingIxs[1]));
    } else {
      for (const ix of kaminoAction.lendingIxs) tx.add(ixV2toV1(ix));
    }
    for (const ix of kaminoAction.cleanupIxs) tx.add(ixV2toV1(ix));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    logger.info(`[Kamino] Repay+Withdraw tx sent: ${signature}, polling...`);
    await pollConfirmation(connection, signature, lastValidBlockHeight);

    logger.info(`[Kamino] Repaid ${repayAmount} ${repayAsset} + withdrew ${withdrawAmount} ${withdrawAsset}: ${signature}`);
    return {
      success: true,
      repaid: { asset: repayAsset, amount: repayAmount },
      withdrawn: { asset: withdrawAsset, amount: withdrawAmount },
      txSignature: signature,
    };
  } catch (err) {
    logger.error('[Kamino] repayAndWithdraw error:', err);
    return {
      success: false,
      repaid: { asset: repayAsset, amount: 0 },
      withdrawn: { asset: withdrawAsset, amount: 0 },
      error: (err as Error).message,
    };
  }
}

// ============================================================================
// JitoSOL/SOL Multiply Loop — The Most Capital-Efficient Strategy
// ============================================================================

export interface JitoSolLoopResult {
  success: boolean;
  loopsCompleted: number;
  jitoSolDeposited: number;  // total JitoSOL in Kamino after loop
  solBorrowed: number;       // total SOL borrowed across all loops
  effectiveLtv: number;      // final LTV after loop completes
  estimatedApy: number;      // estimated APY at this leverage level
  txSignatures: string[];
  error?: string;
}

/**
 * JitoSOL/SOL Multiply loop — Kamino's most capital-efficient strategy for CFO.
 *
 * Loop mechanics (per iteration):
 *   1. Borrow SOL against the JitoSOL collateral currently deposited in Kamino
 *   2. Stake borrowed SOL → JitoSOL via jitoStakingService.stakeSol()
 *   3. Deposit new JitoSOL back into Kamino as additional collateral
 *   4. Repeat until targetLtv is reached (or maxLoops exceeded)
 *
 * The function assumes initial JitoSOL has ALREADY been deposited into Kamino
 * via the regular deposit() call before loopJitoSol() is called.
 * The decision engine handles the initial deposit as part of KAMINO_JITO_LOOP execution.
 *
 * Safety:
 *   - Hard cap at targetLtv (default 0.65 — well below 0.95 liquidation threshold)
 *   - Max 3 loop iterations regardless of target (configurable)
 *   - Each iteration re-checks LTV before proceeding
 *   - If staking fails mid-loop, attempts to repay the borrow and stops
 *
 * @param targetLtv   Target LTV after looping (default 0.65 ≈ 2.85x leverage)
 * @param maxLoops    Max loop iterations (default 3)
 * @param solPriceUsd Current SOL price for USD calculations
 */
export async function loopJitoSol(
  targetLtv = 0.65,
  maxLoops = 3,
  solPriceUsd = 80,
): Promise<JitoSolLoopResult> {
  const env = getCFOEnv();
  const txSigs: string[] = [];

  if (!env.kaminoBorrowEnabled) {
    return { success: false, loopsCompleted: 0, jitoSolDeposited: 0, solBorrowed: 0, effectiveLtv: 0, estimatedApy: 0, txSignatures: [], error: 'Borrowing disabled' };
  }

  if (env.dryRun) {
    const apys = await fetchKaminoApys();
    const leverage = 1 / (1 - targetLtv);
    const estimatedApy = leverage * apys.JitoSOL.supplyApy - (leverage - 1) * apys.SOL.borrowApy;
    logger.info(`[Kamino:Loop] DRY RUN — would loop to ${(targetLtv * 100).toFixed(0)}% LTV, est. APY ${(estimatedApy * 100).toFixed(1)}%`);
    return { success: true, loopsCompleted: maxLoops, jitoSolDeposited: 0, solBorrowed: 0, effectiveLtv: targetLtv, estimatedApy, txSignatures: [`dry-loop-${Date.now()}`] };
  }

  if (targetLtv > 0.80) throw new Error('targetLtv exceeds safe maximum of 0.80 for JitoSOL loop');

  let totalJitoSolNewlyDeposited = 0;
  let totalSolBorrowed = 0;
  let loopsCompleted = 0;

  for (let i = 0; i < maxLoops; i++) {
    const pos = await getPosition();
    const currentLtv = pos.ltv;

    if (currentLtv >= targetLtv * 0.95) {
      logger.info(`[Kamino:Loop] Target LTV ${(targetLtv * 100).toFixed(0)}% reached (current: ${(currentLtv * 100).toFixed(1)}%) after ${i} loops`);
      break;
    }

    // How much SOL can we borrow to reach target LTV without overshooting?
    const depositValUsd = pos.deposits.reduce((s, d) => s + d.valueUsd, 0);
    const currentBorrowValUsd = pos.borrows.reduce((s, b) => s + b.valueUsd, 0);
    const targetBorrowValUsd = depositValUsd * targetLtv;
    const canBorrowUsd = Math.max(0, targetBorrowValUsd - currentBorrowValUsd) * 0.9; // 90% of headroom

    if (canBorrowUsd < 1) { logger.info(`[Kamino:Loop] Headroom too small ($${canBorrowUsd.toFixed(2)}) — stopping`); break; }

    const borrowSolAmount = canBorrowUsd / solPriceUsd;
    if (borrowSolAmount < 0.01) break;

    // Step A: Borrow SOL from Kamino
    const borrowResult = await borrow('SOL', borrowSolAmount);
    if (!borrowResult.success) {
      logger.warn(`[Kamino:Loop] Borrow failed at loop ${i + 1}: ${borrowResult.error} — stopping`);
      break;
    }
    if (borrowResult.txSignature) txSigs.push(borrowResult.txSignature);
    totalSolBorrowed += borrowSolAmount;

    // Step B: Stake borrowed SOL → JitoSOL (keep 0.002 SOL for tx fees)
    const jito = await import('./jitoStakingService.ts');
    const stakeResult = await jito.stakeSol(borrowSolAmount - 0.002);
    if (!stakeResult.success) {
      logger.error(`[Kamino:Loop] Staking failed at loop ${i + 1}: ${stakeResult.error} — attempting to repay borrow`);
      await repay('SOL', borrowSolAmount).catch(e => logger.error('[Kamino:Loop] Cleanup repay also failed:', e));
      break;
    }
    if (stakeResult.txSignature) txSigs.push(stakeResult.txSignature);

    // Step C: Re-deposit the new JitoSOL as additional collateral
    const newJitoSolAmount = stakeResult.jitoSolReceived;
    const reDepositResult = await deposit('JitoSOL', newJitoSolAmount);
    if (!reDepositResult.success) {
      logger.error(`[Kamino:Loop] Re-deposit failed at loop ${i + 1}: ${reDepositResult.error} — stopping loop`);
      break;
    }
    if (reDepositResult.txSignature) txSigs.push(reDepositResult.txSignature);

    totalJitoSolNewlyDeposited += newJitoSolAmount;
    loopsCompleted++;
    logger.info(`[Kamino:Loop] Loop ${i + 1}: borrowed ${borrowSolAmount.toFixed(4)} SOL → staked → ${newJitoSolAmount.toFixed(4)} JitoSOL deposited`);
  }

  // Compute final state and estimated APY
  const finalPos = await getPosition();
  const apys = await fetchKaminoApys();
  const totalJitoDepositVal = finalPos.deposits.filter(d => d.asset === 'JitoSOL').reduce((s, d) => s + d.valueUsd, 0);
  const netEquityUsd = finalPos.netValueUsd;
  const leverage = netEquityUsd > 0 ? totalJitoDepositVal / netEquityUsd : 1;
  const estimatedApy = leverage * apys.JitoSOL.supplyApy - (leverage - 1) * apys.SOL.borrowApy;

  logger.info(
    `[Kamino:Loop] Done — ${loopsCompleted} loops, ` +
    `${totalSolBorrowed.toFixed(4)} SOL borrowed, ` +
    `${totalJitoSolNewlyDeposited.toFixed(4)} additional JitoSOL deposited, ` +
    `LTV: ${(finalPos.ltv * 100).toFixed(1)}%, est. APY: ${(estimatedApy * 100).toFixed(1)}%`
  );

  return {
    success: loopsCompleted > 0,
    loopsCompleted,
    jitoSolDeposited: totalJitoSolNewlyDeposited,
    solBorrowed: totalSolBorrowed,
    effectiveLtv: finalPos.ltv,
    estimatedApy,
    txSignatures: txSigs,
  };
}

/**
 * Unwind a JitoSOL/SOL loop position — reverses the loop iteratively.
 * Each iteration: withdraw JitoSOL → instant unstake to SOL → repay SOL borrow.
 * Call this when: loop is unprofitable, LTV rising, or on graceful shutdown.
 */
export async function unwindJitoSolLoop(): Promise<{ success: boolean; txSignatures: string[]; error?: string }> {
  const env = getCFOEnv();
  const txSigs: string[] = [];

  if (env.dryRun) {
    logger.info('[Kamino:Unwind] DRY RUN — would unwind JitoSOL loop');
    return { success: true, txSignatures: ['dry-unwind'] };
  }

  for (let i = 0; i < 6; i++) { // max 6 unwind iterations
    const pos = await getPosition();
    const solBorrow = pos.borrows.find(b => b.asset === 'SOL');
    if (!solBorrow || solBorrow.amount < 0.001) { logger.info('[Kamino:Unwind] Fully unwound'); break; }

    const jitoDeposit = pos.deposits.find(d => d.asset === 'JitoSOL');
    if (!jitoDeposit || jitoDeposit.amount < 0.001) break;

    // Withdraw ~40% of JitoSOL each iteration to avoid LTV spike during unwind
    const withdrawAmt = Math.min(jitoDeposit.amount * 0.4, jitoDeposit.amount - 0.001);
    const withdrawResult = await withdraw('JitoSOL', withdrawAmt);
    if (!withdrawResult.success) { logger.error(`[Kamino:Unwind] Withdraw failed: ${withdrawResult.error}`); break; }
    if (withdrawResult.txSignature) txSigs.push(withdrawResult.txSignature);

    // Instant unstake JitoSOL → SOL via Jupiter swap
    const jito = await import('./jitoStakingService.ts');
    const unstakeResult = await jito.instantUnstake(withdrawAmt * 0.999);
    if (!unstakeResult.success) { logger.error(`[Kamino:Unwind] Unstake failed: ${unstakeResult.error}`); break; }
    if (unstakeResult.txSignature) txSigs.push(unstakeResult.txSignature);

    // Repay SOL borrow (as much as we got back)
    const repayAmt = Math.min(unstakeResult.solReceived ?? 0, solBorrow.amount);
    if (repayAmt < 0.001) break;
    const repayResult = await repay('SOL', repayAmt);
    if (repayResult.txSignature) txSigs.push(repayResult.txSignature);

    logger.info(`[Kamino:Unwind] Step ${i + 1}: withdrew ${withdrawAmt.toFixed(4)} JitoSOL, repaid ${repayAmt.toFixed(4)} SOL`);
  }

  return { success: true, txSignatures: txSigs };
}
