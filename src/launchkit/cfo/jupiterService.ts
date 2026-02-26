/**
 * Jupiter Swap Service
 *
 * Wraps Jupiter's Ultra Swap API v6 for all Solana-side token swaps.
 *
 * Features:
 *  - Quote with slippage check before executing
 *  - Single-swap execution with confirmation polling
 *  - TWAP execution: breaks large orders into time-weighted chunks
 *  - Price impact guard (refuse swaps with >2% impact by default)
 *
 * Endpoint: https://ultra-api.jup.ag (public, no key required)
 * Auth:     Wallet signing only — uses AGENT_FUNDING_WALLET_SECRET from env
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';

// ============================================================================
// Constants
// ============================================================================

const JUPITER_ULTRA_BASE = 'https://ultra-api.jup.ag';

/** Well-known token mint addresses */
export const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;

// ============================================================================
// Types
// ============================================================================

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;       // lamports / raw units
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: number;
  slippageBps: number;
  routePlan: Array<{ swapInfo: { label: string } }>;
  quoteResponse: unknown;  // raw Jupiter response — passed back to /swap
}

export interface SwapResult {
  success: boolean;
  txSignature?: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;   // human-readable
  outputAmount: number;  // human-readable
  priceImpactPct: number;
  error?: string;
}

export interface TWAPConfig {
  totalInputAmount: number;   // total tokens to swap (human-readable)
  numChunks: number;          // how many sub-swaps (e.g., 12)
  intervalMs: number;         // ms between chunks (e.g., 5 * 60_000 for 5 min)
  inputMint: string;
  outputMint: string;
  maxPriceImpactPct?: number; // skip chunk if impact too high
}

// ============================================================================
// Wallet loading
// ============================================================================

function loadWallet(): Keypair {
  const env = getEnv();
  const secret = env.AGENT_FUNDING_WALLET_SECRET;
  if (!secret) throw new Error('[Jupiter] AGENT_FUNDING_WALLET_SECRET not set');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

// ============================================================================
// Decimal helpers
// ============================================================================

const TOKEN_DECIMALS: Record<string, number> = {
  [MINTS.SOL]:  9,
  [MINTS.USDC]: 6,
  [MINTS.USDT]: 6,
};

function toRaw(humanAmount: number, mint: string): string {
  const decimals = TOKEN_DECIMALS[mint] ?? 9;
  return Math.floor(humanAmount * 10 ** decimals).toString();
}

function fromRaw(rawAmount: string | number, mint: string): number {
  const decimals = TOKEN_DECIMALS[mint] ?? 9;
  return Number(rawAmount) / 10 ** decimals;
}

// ============================================================================
// Quote
// ============================================================================

/**
 * Get a swap quote from Jupiter.
 * Returns null if the pair has insufficient liquidity or quote fails.
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  inputAmount: number,
  slippageBps = 50, // 0.5%
): Promise<SwapQuote | null> {
  try {
    const rawAmount = toRaw(inputAmount, inputMint);
    const url =
      `${JUPITER_ULTRA_BASE}/order?inputMint=${inputMint}` +
      `&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=${slippageBps}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn(`[Jupiter] Quote failed (${resp.status}): ${await resp.text()}`);
      return null;
    }

    const data = await resp.json() as any;

    return {
      inputMint,
      outputMint,
      inAmount: data.inAmount ?? rawAmount,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold ?? data.outAmount,
      priceImpactPct: Number(data.priceImpactPct ?? 0),
      slippageBps,
      routePlan: data.routePlan ?? [],
      quoteResponse: data,
    };
  } catch (err) {
    logger.error('[Jupiter] getQuote error:', err);
    return null;
  }
}

// ============================================================================
// Execute swap
// ============================================================================

/**
 * Execute a swap from a quote.
 * Polls for transaction confirmation with up to 60 seconds of retries.
 */
export async function executeSwap(
  quote: SwapQuote,
  options?: {
    maxPriceImpactPct?: number;
  },
): Promise<SwapResult> {
  const maxImpact = options?.maxPriceImpactPct ?? 2;

  const result: SwapResult = {
    success: false,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inputAmount: fromRaw(quote.inAmount, quote.inputMint),
    outputAmount: fromRaw(quote.outAmount, quote.outputMint),
    priceImpactPct: quote.priceImpactPct,
  };

  if (quote.priceImpactPct > maxImpact) {
    result.error = `Price impact ${quote.priceImpactPct.toFixed(2)}% exceeds max ${maxImpact}%`;
    logger.warn(`[Jupiter] Swap blocked — ${result.error}`);
    return result;
  }

  try {
    const wallet = loadWallet();
    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    // Build the transaction via Jupiter /swap endpoint
    const swapResp = await fetch(`${JUPITER_ULTRA_BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote.quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: { maxBps: quote.slippageBps * 2 },
      }),
    });

    if (!swapResp.ok) {
      const text = await swapResp.text();
      throw new Error(`Jupiter /execute (${swapResp.status}): ${text}`);
    }

    const swapData = await swapResp.json() as { swapTransaction: string };
    if (!swapData.swapTransaction) throw new Error('No swapTransaction in response');

    // Deserialize and sign
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    // Send
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    // Poll for confirmation (avoid WebSocket)
    const confirmed = await pollConfirmation(connection, signature, 60_000);
    if (!confirmed) {
      throw new Error(`Transaction ${signature} not confirmed within 60s`);
    }

    result.success = true;
    result.txSignature = signature;

    logger.info(
      `[Jupiter] Swap confirmed ${signature}: ` +
      `${result.inputAmount.toFixed(4)} → ${result.outputAmount.toFixed(4)} ` +
      `(impact: ${quote.priceImpactPct.toFixed(2)}%)`,
    );
  } catch (err) {
    result.error = (err as Error).message;
    logger.error('[Jupiter] executeSwap error:', err);
  }

  return result;
}

// ============================================================================
// Convenience: swap SOL → USDC
// ============================================================================

export async function swapSolToUsdc(
  solAmount: number,
  slippageBps = 50,
): Promise<SwapResult> {
  const quote = await getQuote(MINTS.SOL, MINTS.USDC, solAmount, slippageBps);
  if (!quote) {
    return {
      success: false,
      inputMint: MINTS.SOL,
      outputMint: MINTS.USDC,
      inputAmount: solAmount,
      outputAmount: 0,
      priceImpactPct: 0,
      error: 'Failed to get quote',
    };
  }
  return executeSwap(quote);
}

export async function swapUsdcToSol(
  usdcAmount: number,
  slippageBps = 50,
): Promise<SwapResult> {
  const quote = await getQuote(MINTS.USDC, MINTS.SOL, usdcAmount, slippageBps);
  if (!quote) {
    return {
      success: false,
      inputMint: MINTS.USDC,
      outputMint: MINTS.SOL,
      inputAmount: usdcAmount,
      outputAmount: 0,
      priceImpactPct: 0,
      error: 'Failed to get quote',
    };
  }
  return executeSwap(quote);
}

// ============================================================================
// TWAP execution
// ============================================================================

/**
 * Execute a large swap as time-weighted average price (TWAP).
 * Breaks the total amount into `numChunks` equal-sized swaps separated by
 * `intervalMs` milliseconds.
 *
 * Skips a chunk if price impact is above threshold.
 * Stops early if the wallet balance drops below minimum.
 *
 * Returns array of individual SwapResults.
 */
export async function executeTWAP(
  config: TWAPConfig,
  onChunkComplete?: (result: SwapResult, chunkIndex: number, total: number) => void,
): Promise<SwapResult[]> {
  const {
    totalInputAmount,
    numChunks,
    intervalMs,
    inputMint,
    outputMint,
    maxPriceImpactPct = 1.5,
  } = config;

  const chunkSize = totalInputAmount / numChunks;
  const results: SwapResult[] = [];

  logger.info(
    `[Jupiter] TWAP: ${totalInputAmount} in ${numChunks} chunks of ${chunkSize.toFixed(4)} ` +
    `every ${(intervalMs / 60_000).toFixed(1)}min`,
  );

  for (let i = 0; i < numChunks; i++) {
    // Check balance before each chunk
    const balance = await getTokenBalance(inputMint);
    if (balance < chunkSize * 0.95) {
      logger.warn(`[Jupiter] TWAP: insufficient balance (${balance.toFixed(4)}) for chunk ${i + 1}, stopping`);
      break;
    }

    const quote = await getQuote(inputMint, outputMint, chunkSize);
    if (!quote) {
      logger.warn(`[Jupiter] TWAP: quote failed for chunk ${i + 1}, skipping`);
      results.push({
        success: false,
        inputMint,
        outputMint,
        inputAmount: chunkSize,
        outputAmount: 0,
        priceImpactPct: 0,
        error: 'Quote failed',
      });
    } else if (quote.priceImpactPct > maxPriceImpactPct) {
      logger.warn(
        `[Jupiter] TWAP: chunk ${i + 1} skipped — impact ${quote.priceImpactPct.toFixed(2)}% > ${maxPriceImpactPct}%`,
      );
      results.push({
        success: false,
        inputMint,
        outputMint,
        inputAmount: chunkSize,
        outputAmount: 0,
        priceImpactPct: quote.priceImpactPct,
        error: `Price impact ${quote.priceImpactPct.toFixed(2)}% too high`,
      });
    } else {
      const result = await executeSwap(quote, { maxPriceImpactPct });
      results.push(result);
      onChunkComplete?.(result, i + 1, numChunks);
    }

    // Wait before next chunk (skip on last chunk)
    if (i < numChunks - 1) {
      await sleep(intervalMs);
    }
  }

  const successful = results.filter((r) => r.success).length;
  logger.info(`[Jupiter] TWAP complete: ${successful}/${numChunks} chunks executed`);
  return results;
}

// ============================================================================
// Balance check
// ============================================================================

/**
 * Get the agent wallet's balance of a given token mint.
 * Returns amount in human-readable units.
 */
export async function getTokenBalance(mint: string): Promise<number> {
  try {
    const wallet = loadWallet();
    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    if (mint === MINTS.SOL) {
      const bal = await connection.getBalance(wallet.publicKey);
      return bal / LAMPORTS_PER_SOL;
    }

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mint),
    });

    if (!tokenAccounts.value.length) return 0;

    const amount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return Number(amount.uiAmount) || 0;
  } catch (err) {
    logger.warn(`[Jupiter] getTokenBalance(${mint}) error:`, err);
    return 0;
  }
}

// ============================================================================
// Wallet Token Scanner
// ============================================================================

export interface WalletTokenBalance {
  mint: string;
  symbol: string | null;    // null if unknown — caller resolves via guardian/analyst intel
  balance: number;          // human-readable
  decimals: number;
}

/**
 * Scan the agent's Solana wallet and return all SPL token balances above `minBalance`.
 * SOL is always included (as pseudo-mint So11...112).
 * Used by the CFO to discover what's in the treasury without hardcoding symbols.
 */
export async function getWalletTokenBalances(
  minBalanceUsd = 10,
  priceMap?: Map<string, number>,
): Promise<WalletTokenBalance[]> {
  try {
    const wallet = loadWallet();
    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token' as string);

    const results: WalletTokenBalance[] = [];

    // Always include native SOL
    const solLamports = await connection.getBalance(wallet.publicKey);
    const solBalance = solLamports / LAMPORTS_PER_SOL;
    results.push({ mint: MINTS.SOL, symbol: 'SOL', balance: solBalance, decimals: 9 });

    // All SPL tokens
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: TOKEN_PROGRAM_ID },
    );

    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;
      const uiAmount = Number(parsed.tokenAmount?.uiAmount ?? 0);
      if (uiAmount <= 0) continue;

      // Skip Orca LP position NFTs (amount = 1, decimals = 0)
      const decimals = parsed.tokenAmount?.decimals ?? 0;
      if (decimals === 0 && uiAmount === 1) continue;

      const mint: string = parsed.mint;

      // Known mints → symbol lookup
      const knownSymbol: Record<string, string> = {
        [MINTS.USDC]: 'USDC',
        [MINTS.USDT]: 'USDT',
        // JitoSOL, mSOL, etc. will be symbol=null until resolved by guardian intel
      };

      results.push({
        mint,
        symbol: knownSymbol[mint] ?? null,
        balance: uiAmount,
        decimals,
      });
    }

    return results;
  } catch (err) {
    logger.warn('[Jupiter] getWalletTokenBalances error:', err);
    return [];
  }
}

// ============================================================================
// Utilities
// ============================================================================

async function pollConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return true;
    }
    if (status?.err) {
      logger.error(`[Jupiter] TX ${signature} error:`, JSON.stringify(status.err));
      return false;
    }
    await sleep(2000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
