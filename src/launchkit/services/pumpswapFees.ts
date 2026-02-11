import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';

/**
 * PumpSwap Creator Fee Service
 * 
 * Tracks creator fees earned from PumpSwap pools for graduated tokens.
 * PumpSwap charges 0.25% fee on each swap, with 0.05% going to the creator
 * if they set up a creator fee recipient.
 * 
 * Uses Solana RPC + Helius/Jupiter APIs to track fee accrual.
 */

// ============================================================================
// Types
// ============================================================================

export interface CreatorFeeRecord {
  mint: string;
  ticker: string;
  feeAmountSol: number;
  feeAmountUsd?: number;
  poolAddress?: string;
  txSignature?: string;
  claimedAt?: string;
  createdAt: string;
}

export interface FeesSummary {
  totalFeesSOL: number;
  totalFeesUSD: number;
  feesByToken: Array<{
    mint: string;
    ticker: string;
    feesSOL: number;
    feesUSD: number;
    poolAddress?: string;
  }>;
  lastUpdated: string;
}

// In-memory cache
const state = {
  fees: new Map<string, CreatorFeeRecord[]>(),
  lastCheck: 0,
  totalAccrued: 0,
  // Cooldown: don't re-check same token within 1 hour
  tokenLastChecked: new Map<string, number>(),
  // Dedup: skip already-parsed transaction signatures
  processedSignatures: new Set<string>(),
};

const TOKEN_CHECK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const MAX_SIGNATURES = 5;   // Down from 20 — limits RPC calls to 6 per invocation (1 + 5)
const MAX_PROCESSED_SIGS = 500; // Trim dedup set when it gets too large

// ============================================================================
// Fee Tracking
// ============================================================================

/**
 * Check PumpSwap pools for creator fee accrual on a specific token
 * 
 * Uses the Solana RPC to check the pool's creator fee account.
 * If the token has graduated from pump.fun to Raydium/PumpSwap,
 * the creator receives 0.05% of all swap volume.
 */
export async function checkCreatorFees(mint: string, ticker: string): Promise<CreatorFeeRecord | null> {
  try {
    const env = getEnv();
    const rpcUrl = env.SOLANA_RPC_URL;
    
    if (!rpcUrl) {
      logger.debug('[PumpSwapFees] No RPC URL configured');
      return null;
    }

    // Cooldown: don't re-check same token within 1 hour
    const lastChecked = state.tokenLastChecked.get(mint) || 0;
    if (Date.now() - lastChecked < TOKEN_CHECK_COOLDOWN_MS) {
      logger.debug(`[PumpSwapFees] Cooldown: ${ticker} checked ${Math.round((Date.now() - lastChecked) / 60000)}m ago`);
      return null;
    }
    state.tokenLastChecked.set(mint, Date.now());
    
    const walletAddress = env.PUMP_PORTAL_WALLET_ADDRESS;
    if (!walletAddress) return null;

    // Query recent transactions — LIMITED to MAX_SIGNATURES to cap RPC calls
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: MAX_SIGNATURES }],
      }),
    });

    if (!res.ok) {
      logger.warn(`[PumpSwapFees] RPC returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const signatures = data.result || [];

    for (const sig of signatures) {
      if (sig.err) continue;
      
      // Skip already-processed signatures
      if (state.processedSignatures.has(sig.signature)) continue;
      state.processedSignatures.add(sig.signature);
      
      // Trim dedup set if needed
      if (state.processedSignatures.size > MAX_PROCESSED_SIGS) {
        const arr = [...state.processedSignatures];
        state.processedSignatures = new Set(arr.slice(-250));
      }
      
      // Check if this transaction involves the token mint
      // This is a simplified check — production would parse instruction data
      try {
        const txRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
          }),
        });

        const txData = await txRes.json();
        const tx = txData.result;
        
        if (!tx) continue;

        // Check if this transaction involves our token mint
        const accountKeys = tx.transaction?.message?.accountKeys?.map((k: any) => 
          typeof k === 'string' ? k : k.pubkey
        ) || [];
        
        if (!accountKeys.includes(mint)) continue;

        // Check for SOL balance changes (fee receipt)
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        
        // Find wallet's index in account keys
        const walletIndex = accountKeys.indexOf(walletAddress);
        if (walletIndex < 0) continue;

        const balanceChange = (postBalances[walletIndex] - preBalances[walletIndex]) / 1e9; // lamports to SOL
        
        if (balanceChange > 0 && balanceChange < 1) { // Reasonable fee range
          const record: CreatorFeeRecord = {
            mint,
            ticker,
            feeAmountSol: balanceChange,
            txSignature: sig.signature,
            claimedAt: new Date(sig.blockTime * 1000).toISOString(),
            createdAt: new Date().toISOString(),
          };
          
          // Cache it
          if (!state.fees.has(mint)) state.fees.set(mint, []);
          state.fees.get(mint)!.push(record);
          state.totalAccrued += balanceChange;
          
          logger.info(`[PumpSwapFees] Found fee: ${balanceChange.toFixed(6)} SOL for $${ticker}`);
          return record;
        }
      } catch {
        // Skip invalid transactions
        continue;
      }
    }

    return null;
  } catch (err) {
    logger.error(`[PumpSwapFees] Error checking fees for ${mint}:`, err);
    return null;
  }
}

/**
 * Get accumulated fees summary across all tracked tokens
 */
export function getFeesSummary(): FeesSummary {
  const feesByToken: FeesSummary['feesByToken'] = [];
  
  for (const [mint, records] of state.fees) {
    const totalSOL = records.reduce((sum, r) => sum + r.feeAmountSol, 0);
    feesByToken.push({
      mint,
      ticker: records[0]?.ticker || 'UNKNOWN',
      feesSOL: totalSOL,
      feesUSD: 0, // Would need price API
      poolAddress: records[0]?.poolAddress,
    });
  }
  
  return {
    totalFeesSOL: state.totalAccrued,
    totalFeesUSD: 0,
    feesByToken,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Format fee summary for tweet
 */
export function formatFeesForTweet(summary: FeesSummary): string {
  if (summary.totalFeesSOL === 0) return '';
  
  let text = `📊 PumpSwap Creator Fees Update\n\n`;
  text += `Total earned: ${summary.totalFeesSOL.toFixed(4)} SOL\n`;
  
  if (summary.feesByToken.length > 0) {
    text += `\nBy token:\n`;
    for (const t of summary.feesByToken.slice(0, 3)) {
      text += `$${t.ticker}: ${t.feesSOL.toFixed(4)} SOL\n`;
    }
  }
  
  text += `\nAll on-chain, all verifiable.`;
  return text;
}

/**
 * Format fee summary for Telegram (HTML)
 */
export function formatFeesForTelegram(summary: FeesSummary): string {
  if (summary.totalFeesSOL === 0) return '';
  
  let text = `📊 <b>PumpSwap Creator Fees</b>\n\n`;
  text += `Total earned: <b>${summary.totalFeesSOL.toFixed(4)} SOL</b>\n\n`;
  
  if (summary.feesByToken.length > 0) {
    for (const t of summary.feesByToken) {
      text += `• $${t.ticker}: ${t.feesSOL.toFixed(4)} SOL\n`;
    }
  }
  
  text += `\n<i>Updated ${new Date().toLocaleTimeString()}</i>`;
  return text;
}

export default {
  checkCreatorFees,
  getFeesSummary,
  formatFeesForTweet,
  formatFeesForTelegram,
};
