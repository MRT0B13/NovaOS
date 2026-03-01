/**
 * Orca Whirlpool Concentrated LP Service
 *
 * Opens and manages concentrated liquidity positions on Orca's SOL/USDC Whirlpool.
 * Earns fee APY from trades happening within the price range.
 *
 * Strategy:
 *  - Open a position ±N% around current SOL price (range width configurable)
 *  - Monitor: if SOL price moves within X% of range edge → close and reopen centred on new price
 *  - Close position: withdraw liquidity + collect accrued fees → net gain
 *
 * Whirlpool: SOL/USDC on Orca mainnet
 * Address: HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ (fee tier 0.3%)
 * Tick spacing: 64 (standard SOL/USDC)
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';
import { getCFOEnv } from './cfoEnv.ts';
import bs58 from 'bs58';
// @ts-ignore — bn.js types excluded by tsconfig "types": ["bun-types"]
import BN from 'bn.js';
import Decimal from 'decimal.js';

// SOL/USDC Whirlpool (0.3% fee tier) — highest liquidity, most fee revenue
const SOL_USDC_WHIRLPOOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ';
const DEFAULT_TICK_SPACING = 64;

/**
 * Dynamic pool decimal registry.
 *
 * Previously hardcoded to 4 pools. Now populated at runtime from
 * orcaPoolDiscovery.ts or by the decisionEngine when opening positions.
 *
 * Callers can register decimals via registerPoolDecimals() before
 * opening/reading positions. Falls back to SOL/USDC (9/6) if unknown.
 */
const _poolDecimalRegistry: Record<string, { tokenADecimals: number; tokenBDecimals: number; tokenASymbol?: string; tokenBSymbol?: string }> = {
  // Seed with SOL/USDC so it always works even before discovery runs
  'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ': { tokenADecimals: 9, tokenBDecimals: 6, tokenASymbol: 'SOL', tokenBSymbol: 'USDC' }, // SOL/USDC
};

/**
 * Register token decimals for a whirlpool address.
 * Called by decisionEngine/orcaPoolDiscovery before opening positions on dynamic pools.
 */
export function registerPoolDecimals(
  whirlpoolAddress: string,
  tokenADecimals: number,
  tokenBDecimals: number,
  tokenASymbol?: string,
  tokenBSymbol?: string,
): void {
  _poolDecimalRegistry[whirlpoolAddress] = { tokenADecimals, tokenBDecimals, tokenASymbol, tokenBSymbol };
}

/**
 * Bulk-register decimals from discovered pools.
 * Convenience wrapper for orcaPoolDiscovery integration.
 */
export function registerPoolDecimalsBulk(
  pools: Array<{ whirlpoolAddress: string; tokenA: { decimals: number; symbol?: string }; tokenB: { decimals: number; symbol?: string } }>,
): void {
  for (const p of pools) {
    _poolDecimalRegistry[p.whirlpoolAddress] = {
      tokenADecimals: p.tokenA.decimals,
      tokenBDecimals: p.tokenB.decimals,
      tokenASymbol: p.tokenA.symbol,
      tokenBSymbol: p.tokenB.symbol,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build, send, and confirm a TransactionBuilder using polling (not websockets).
 * Alchemy and some RPC providers don't support `signatureSubscribe`, which
 * the SDK's `buildAndExecute()` uses under the hood.
 */
async function buildSendAndConfirm(
  txBuilder: any,
  connection: Connection,
  wallet: Keypair,
): Promise<string> {
  const { transaction, signers } = await txBuilder.build();

  // Sign with wallet + any additional signers from the SDK
  const allSigners = [wallet, ...signers.filter((s: any) => s.publicKey && !s.publicKey.equals(wallet.publicKey))];
  if ('version' in transaction) {
    // VersionedTransaction.sign expects Signer[]
    transaction.sign(allSigners);
  } else {
    // Legacy Transaction
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(...allSigners);
  }

  const rawTx = transaction.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  // Poll for confirmation (avoids websocket signatureSubscribe)
  for (let i = 0; i < 60; i++) {
    const status = await connection.getSignatureStatuses([signature]);
    const val = status.value[0];
    if (val?.err) throw new Error(`Transaction failed: ${JSON.stringify(val.err)}`);
    if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') {
      return signature;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  // If we timed out but still got a signature, return it — it may confirm later
  logger.warn(`[Orca] TX ${signature.slice(0, 12)}… confirmation timed out, may still land`);
  return signature;
}

// ============================================================================
// Types
// ============================================================================

export interface OrcaPosition {
  positionMint: string;
  whirlpoolAddress?: string;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  liquidityUsd: number;
  unclaimedFeesUsdc: number;
  unclaimedFeesSol: number;
  inRange: boolean;
  rangeUtilisationPct: number;  // 0-100: how centred the current price is in the range
}

export interface OrcaOpenResult {
  success: boolean;
  positionMint?: string;
  txSignature?: string;
  lowerPrice?: number;
  upperPrice?: number;
  error?: string;
}

export interface OrcaCloseResult {
  success: boolean;
  usdcReceived?: number;
  solReceived?: number;
  feesCollectedUsdc?: number;
  feesCollectedSol?: number;
  txSignature?: string;
  error?: string;
}

// ============================================================================
// Wallet loader (same pattern as kaminoService)
// ============================================================================

function loadWallet(): Keypair {
  const env = getEnv();
  const secret = env.AGENT_FUNDING_WALLET_SECRET;
  if (!secret) throw new Error('[Orca] AGENT_FUNDING_WALLET_SECRET not set');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

// SDK loader (same pattern as kaminoService loadKlend)
async function loadOrcaSdk() {
  try {
    return await import('@orca-so/whirlpools-sdk' as string);
  } catch {
    throw new Error('[Orca] @orca-so/whirlpools-sdk not installed. Run: bun add @orca-so/whirlpools-sdk');
  }
}

async function loadAnchor() {
  try {
    return await import('@coral-xyz/anchor' as string);
  } catch {
    throw new Error('[Orca] @coral-xyz/anchor not installed. Run: bun add @coral-xyz/anchor');
  }
}

// ============================================================================
// Open Position
// ============================================================================

/**
 * Open a new concentrated LP position centred on current price.
 * @param usdcAmount       USDC to deposit as one side of the LP
 * @param tokenAAmount     TokenA to deposit as the other side (SOL, BONK, WIF, etc.)
 * @param rangeWidthPct    total range width as % of current price (e.g. 20 = ±10%)
 * @param whirlpoolAddress optional whirlpool address (defaults to SOL/USDC)
 * @param tokenADecimals   decimals for tokenA (default 9 = SOL; 5 = BONK, 6 = WIF/JUP)
 * @param tokenBDecimals   decimals for tokenB (default 6 = USDC)
 */
export async function openPosition(
  usdcAmount: number,
  tokenAAmount: number,
  rangeWidthPct?: number,
  whirlpoolAddress?: string,
  tokenADecimals = 9,
  tokenBDecimals = 6,
  tickSpacing?: number,
): Promise<OrcaOpenResult> {
  const env = getCFOEnv();
  const halfRange = (rangeWidthPct ?? env.orcaLpRangeWidthPct ?? 20) / 2 / 100;
  const poolAddress = whirlpoolAddress ?? SOL_USDC_WHIRLPOOL;

  if (env.dryRun) {
    logger.info(`[Orca] DRY RUN — would open LP: $${usdcAmount} USDC + ${tokenAAmount} tokenA, range ±${halfRange * 100}%`);
    return { success: true, positionMint: `dry-position-${Date.now()}`, lowerPrice: 0, upperPrice: 0 };
  }

  try {
    const { WhirlpoolContext, buildWhirlpoolClient, PriceMath, TickUtil,
            TickArrayUtil, WhirlpoolIx, PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID,
            IGNORE_CACHE, toTx,
            increaseLiquidityQuoteByInputTokenWithParams, NO_TOKEN_EXTENSION_CONTEXT,
          } = await loadOrcaSdk();
    const { AnchorProvider, Wallet } = await loadAnchor();
    const { Percentage } = await import('@orca-so/common-sdk' as string);

    const walletKeypair = loadWallet();
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {});
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    const whirlpool = await client.getPool(new PublicKey(poolAddress));
    const whirlpoolData = whirlpool.getData();
    // BN and Decimal imported at top level
    const currentPriceDec = PriceMath.sqrtPriceX64ToPrice(
      whirlpoolData.sqrtPrice,
      tokenADecimals,
      tokenBDecimals,
    );
    const currentPrice = currentPriceDec.toNumber();

    // Calculate tick range centred on current price — PriceMath needs Decimal
    const lowerPriceDec = currentPriceDec.mul(1 - halfRange);
    const upperPriceDec = currentPriceDec.mul(1 + halfRange);
    // Use pool-specific tick spacing (from discovery) or read from on-chain data, fall back to 64
    const effectiveTickSpacing = tickSpacing ?? whirlpoolData.tickSpacing ?? DEFAULT_TICK_SPACING;
    logger.info(`[Orca] Using tickSpacing=${effectiveTickSpacing} for pool ${poolAddress.slice(0, 8)}`);

    const lowerTick = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(lowerPriceDec, tokenADecimals, tokenBDecimals),
      effectiveTickSpacing,
    );
    const upperTick = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(upperPriceDec, tokenADecimals, tokenBDecimals),
      effectiveTickSpacing,
    );

    // Build liquidity quote — pick the token with the larger USD value as input
    const tokenAInputBN = new BN(Math.floor(tokenAAmount * (10 ** tokenADecimals)));
    const usdcInputBN = new BN(Math.floor(usdcAmount * (10 ** tokenBDecimals)));

    // Use whichever side the user provided more of (by USD-equivalent)
    const tokenAValueUsd = tokenAAmount * currentPrice;
    const useUsdc = usdcAmount > 0 && usdcAmount >= tokenAValueUsd;
    const inputTokenMint = useUsdc ? whirlpoolData.tokenMintB : whirlpoolData.tokenMintA;
    const inputTokenAmount = useUsdc ? usdcInputBN : tokenAInputBN;

    const slippageTolerance = Percentage.fromFraction(10, 1000); // 1%
    const quote = increaseLiquidityQuoteByInputTokenWithParams({
      tokenMintA: whirlpoolData.tokenMintA,
      tokenMintB: whirlpoolData.tokenMintB,
      sqrtPrice: whirlpoolData.sqrtPrice,
      tickCurrentIndex: whirlpoolData.tickCurrentIndex,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      inputTokenMint,
      inputTokenAmount,
      slippageTolerance,
      tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
    });

    // The quote doesn't include minSqrtPrice/maxSqrtPrice, but ByTokenAmountsParams
    // requires them—otherwise the program errors with PriceSlippageOutOfBounds (6069).
    // Compute from current sqrtPrice ± slippage.
    const SLIPPAGE_NUM = 10;   // numerator  (1%)
    const SLIPPAGE_DEN = 1000; // denominator
    const minSqrtPrice = whirlpoolData.sqrtPrice
      .mul(new BN(SLIPPAGE_DEN - SLIPPAGE_NUM))
      .div(new BN(SLIPPAGE_DEN));
    const maxSqrtPrice = whirlpoolData.sqrtPrice
      .mul(new BN(SLIPPAGE_DEN + SLIPPAGE_NUM))
      .div(new BN(SLIPPAGE_DEN));

    const liquidityInput = {
      tokenMaxA: quote.tokenMaxA,
      tokenMaxB: quote.tokenMaxB,
      minSqrtPrice,
      maxSqrtPrice,
    };

    logger.info(`[Orca] Opening position: lowerTick=${lowerTick}, upperTick=${upperTick}, ` +
      `tokenMaxA=${quote.tokenMaxA.toString()}, tokenMaxB=${quote.tokenMaxB.toString()}, ` +
      `minSqrt=${minSqrtPrice.toString()}, maxSqrt=${maxSqrtPrice.toString()}`);

    // Ensure tick arrays exist for this range.
    // Exotic pools (USDG/USDC, BONK/SOL, etc.) may not have tick arrays initialized
    // at the LP range we need. If they don't exist, the IncreaseLiquidity instruction
    // fails with 0xBBF (AccountOwnedByWrongProgram) because the PDA resolves to an
    // uninitialized account owned by SystemProgram instead of the Whirlpool program.
    const uninitArrays = await TickArrayUtil.getUninitializedArraysPDAs(
      [lowerTick, upperTick],
      ORCA_WHIRLPOOL_PROGRAM_ID,
      new PublicKey(poolAddress),
      effectiveTickSpacing,
      ctx.fetcher,
      IGNORE_CACHE,
    );
    if (uninitArrays.length > 0) {
      logger.info(`[Orca] Found ${uninitArrays.length} uninitialized tick array(s) — initializing...`);
      for (const arr of uninitArrays) {
        const ix = WhirlpoolIx.initTickArrayIx(ctx.program, {
          whirlpool: new PublicKey(poolAddress),
          tickArrayPda: arr.pda,
          startTick: arr.startIndex,
          funder: walletKeypair.publicKey,
        });
        const txBuilder = toTx(ctx, ix);
        const initSig = await buildSendAndConfirm(txBuilder, connection, walletKeypair);
        logger.info(`[Orca] Tick array initialized (startTick=${arr.startIndex}): ${initSig}`);
      }
    }

    // Open LP position
    const { tx, positionMint } = await whirlpool.openPosition(
      lowerTick,
      upperTick,
      liquidityInput,
      walletKeypair.publicKey,
    );

    const signature = await buildSendAndConfirm(tx, connection, walletKeypair);
    const lowerPrice = lowerPriceDec.toNumber();
    const upperPrice = upperPriceDec.toNumber();
    logger.info(`[Orca] Opened LP position: ${positionMint.toBase58()} | range $${lowerPrice.toFixed(2)}-$${upperPrice.toFixed(2)} | tx: ${signature}`);

    return {
      success: true,
      positionMint: positionMint.toBase58(),
      txSignature: signature,
      lowerPrice,
      upperPrice,
    };
  } catch (err) {
    logger.error('[Orca] openPosition error:', err);
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Close Position
// ============================================================================

/**
 * Close an existing LP position — collects all fees and withdraws liquidity.
 */
export async function closePosition(positionMint: string): Promise<OrcaCloseResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[Orca] DRY RUN — would close position ${positionMint.slice(0, 8)}`);
    return { success: true, usdcReceived: 0, solReceived: 0, feesCollectedUsdc: 0 };
  }

  try {
    const { WhirlpoolContext, buildWhirlpoolClient, PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID } = await loadOrcaSdk();
    const { AnchorProvider, Wallet } = await loadAnchor();
    const { Percentage } = await import('@orca-so/common-sdk' as string);

    const walletKeypair = loadWallet();
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {});
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    // Derive position PDA from the mint (the SDK expects the PDA, not the mint)
    const mintPubkey = new PublicKey(positionMint);
    const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);
    logger.info(`[Orca] Position PDA: ${positionPda.publicKey.toBase58()} (mint: ${positionMint.slice(0, 8)}…)`);

    // Snapshot wallet balances BEFORE closing so we can report what we got back
    const solBefore = await connection.getBalance(walletKeypair.publicKey);
    const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = await import('@solana/spl-token' as string);
    const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const usdcAta = await getAssociatedTokenAddress(USDC_MINT, walletKeypair.publicKey);
    let usdcBefore = 0;
    try {
      const usdcAcct = await connection.getTokenAccountBalance(usdcAta);
      usdcBefore = Number(usdcAcct.value.uiAmount ?? 0);
    } catch { /* ATA may not exist yet */ }

    // Use the whirlpool's closePosition which handles:
    // decrease liquidity → collect fees → collect rewards → close position account
    const position = await client.getPosition(positionPda.publicKey);
    const posData = position.getData();
    const whirlpool = await client.getPool(posData.whirlpool);
    const closeTxs = await whirlpool.closePosition(
      positionPda.publicKey,
      Percentage.fromFraction(10, 1000), // 1% slippage
      walletKeypair.publicKey,           // destination wallet
      walletKeypair.publicKey,           // position wallet (owns the NFT)
      walletKeypair.publicKey,           // payer
    );

    // closeTxs may be an array of TransactionBuilders or a single builder
    const txBuilders = Array.isArray(closeTxs) ? closeTxs : [closeTxs];
    let lastSig = '';
    for (const txBuilder of txBuilders) {
      lastSig = await buildSendAndConfirm(txBuilder, connection, walletKeypair);
    }

    // Snapshot balances AFTER to compute received amounts
    await new Promise(r => setTimeout(r, 2000)); // wait for balance finality
    const solAfter = await connection.getBalance(walletKeypair.publicKey);
    let usdcAfter = 0;
    try {
      const usdcAcct = await connection.getTokenAccountBalance(usdcAta);
      usdcAfter = Number(usdcAcct.value.uiAmount ?? 0);
    } catch { /* ATA may not exist */ }

    const solReceived = Math.max(0, (solAfter - solBefore) / 1e9);
    const usdcReceived = Math.max(0, usdcAfter - usdcBefore);

    logger.info(`[Orca] Closed LP position ${positionMint.slice(0, 8)}: ${lastSig} | ` +
      `received ${solReceived.toFixed(6)} SOL + ${usdcReceived.toFixed(4)} USDC`);
    return {
      success: true,
      txSignature: lastSig,
      solReceived,
      usdcReceived,
      feesCollectedUsdc: 0, // fees are included in the withdrawn amounts
      feesCollectedSol: 0,
    };
  } catch (err) {
    logger.error('[Orca] closePosition error:', err);
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Rebalance Position
// ============================================================================

/**
 * Rebalance an existing LP position: close it and reopen centred on current price.
 * Used when price drifts near range edge or goes out of range.
 * @param positionMint  NFT mint of the position to rebalance
 * @param rangeWidthPct total range width as % of current price (e.g. 20 = ±10%)
 */
export interface OrcaRebalanceResult {
  success: boolean;
  newPositionMint?: string;
  txSignature?: string;
  error?: string;
  /** USD value recovered from closing the old position (SOL converted at market) */
  valueRecoveredUsd?: number;
  /** USDC received from close */
  usdcReceived?: number;
  /** SOL received from close */
  solReceived?: number;
}

export async function rebalancePosition(
  positionMint: string,
  rangeWidthPct?: number,
  whirlpoolAddress?: string,
): Promise<OrcaRebalanceResult> {
  const env = getCFOEnv();
  const width = rangeWidthPct ?? env.orcaLpRangeWidthPct ?? 20;

  if (env.dryRun) {
    logger.info(`[Orca] DRY RUN — would rebalance position ${positionMint.slice(0, 8)} with ±${width / 2}% range`);
    return { success: true, newPositionMint: `dry-rebalance-${Date.now()}` };
  }

  logger.info(`[Orca] Rebalancing position ${positionMint.slice(0, 8)}… closing then reopening ±${width / 2}%`);

  // Step 1: Close existing position — get back SOL + USDC
  const closeResult = await closePosition(positionMint);
  if (!closeResult.success) {
    return { success: false, error: `Close failed: ${closeResult.error}` };
  }

  const usdcReceived = closeResult.usdcReceived ?? 0;
  const solReceived = closeResult.solReceived ?? 0;

  // Compute USD value recovered (SOL at market price + USDC at $1)
  let solPriceUsd = 85;
  try {
    const pyth = await import('./pythOracleService.ts');
    solPriceUsd = await pyth.getSolPrice();
  } catch { /* fallback */ }
  const valueRecoveredUsd = usdcReceived + solReceived * solPriceUsd;

  if (usdcReceived <= 0 && solReceived <= 0) {
    logger.warn(`[Orca] Rebalance: position closed but got no tokens back (already empty?)`);
    return { success: true, txSignature: closeResult.txSignature, valueRecoveredUsd: 0, usdcReceived, solReceived };
  }

  // Step 2: Reopen centred on current price using the tokens we got back
  logger.info(`[Orca] Rebalance: reopening with ${solReceived.toFixed(6)} SOL + ${usdcReceived.toFixed(4)} USDC (≈$${valueRecoveredUsd.toFixed(2)})`);
  const openResult = await openPosition(usdcReceived, solReceived, width, whirlpoolAddress);
  if (!openResult.success) {
    return { success: false, error: `Reopen failed: ${openResult.error} (closed OK, funds in wallet)`, valueRecoveredUsd, usdcReceived, solReceived };
  }

  logger.info(`[Orca] Rebalance complete: old=${positionMint.slice(0, 8)} → new=${openResult.positionMint?.slice(0, 8)} ` +
    `range $${openResult.lowerPrice?.toFixed(2)}-$${openResult.upperPrice?.toFixed(2)}`);
  return {
    success: true,
    newPositionMint: openResult.positionMint,
    txSignature: openResult.txSignature,
    valueRecoveredUsd,
    usdcReceived,
    solReceived,
  };
}

// ============================================================================
// Get Positions
// ============================================================================

/**
 * Get current state of all open Orca LP positions.
 * Returns live price, range status, unclaimed fees, and range utilisation.
 */
export async function getPositions(): Promise<OrcaPosition[]> {
  try {
    const { WhirlpoolContext, buildWhirlpoolClient, PriceMath, PDAUtil,
            ORCA_WHIRLPOOL_PROGRAM_ID, PoolUtil } = await loadOrcaSdk();
    const { AnchorProvider, Wallet } = await loadAnchor();

    const walletKeypair = loadWallet();
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {});
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    // Fetch SOL price once for USD conversion (token A is typically SOL)
    let solPriceUsd = 85; // fallback
    try {
      const pyth = await import('./pythOracleService.ts');
      solPriceUsd = await pyth.getSolPrice();
    } catch { /* use fallback */ }

    // Do NOT pre-fetch currentPrice here — each position belongs to a different pool.
    // currentPrice is fetched per-position inside the loop.

    // Enumerate all token accounts owned by the wallet to find position NFTs.
    // Position NFTs have amount=1 and can be checked via PDA derivation.
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token' as string);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletKeypair.publicKey,
      { programId: TOKEN_PROGRAM_ID },
    );

    const result: OrcaPosition[] = [];
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed || parsed.tokenAmount?.uiAmount !== 1) continue;

      const mintPk = new PublicKey(parsed.mint);
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPk);

      try {
        const position = await client.getPosition(positionPda.publicKey);
        const data = position.getData();

        // Fetch the actual pool this position belongs to
        const posWhirlpool = await client.getPool(data.whirlpool);
        const poolData = posWhirlpool.getData();

        // Determine token decimals for this pool from our dynamic registry; fall back to 9/6 (SOL/USDC).
        const poolAddress = data.whirlpool.toBase58();
        const knownPool = _poolDecimalRegistry[poolAddress];
        const tokenADec = knownPool?.tokenADecimals ?? 9;
        const tokenBDec = knownPool?.tokenBDecimals ?? 6;

        const currentPrice = PriceMath.sqrtPriceX64ToPrice(
          poolData.sqrtPrice,
          tokenADec,
          tokenBDec,
        ).toNumber();

        const lowerPrice = PriceMath.tickIndexToPrice(data.tickLowerIndex, tokenADec, tokenBDec).toNumber();
        const upperPrice = PriceMath.tickIndexToPrice(data.tickUpperIndex, tokenADec, tokenBDec).toNumber();
        const inRange = currentPrice >= lowerPrice && currentPrice <= upperPrice;

        const midPrice = (lowerPrice + upperPrice) / 2;
        const rangeHalf = (upperPrice - lowerPrice) / 2;
        const distFromCentre = Math.abs(currentPrice - midPrice);
        const rangeUtilisationPct = rangeHalf > 0
          ? Math.max(0, (1 - distFromCentre / rangeHalf) * 100)
          : 0;

        // ── Compute real liquidityUsd from on-chain position data ──
        // PoolUtil.getTokenAmountsFromLiquidity returns the underlying token
        // amounts for the position's liquidity at the current pool price.
        let liquidityUsd = 0;
        let unclaimedFeesSol = 0;
        let unclaimedFeesUsdc = 0;
        try {
          const lowerSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(data.tickLowerIndex);
          const upperSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(data.tickUpperIndex);
          const amounts = PoolUtil.getTokenAmountsFromLiquidity(
            data.liquidity,
            poolData.sqrtPrice,
            lowerSqrtPrice,
            upperSqrtPrice,
            false,
          );
          const tokenAUi = Number(amounts.tokenA.toString()) / (10 ** tokenADec);
          const tokenBUi = Number(amounts.tokenB.toString()) / (10 ** tokenBDec);
          // Token B is typically the quote token (USDC/stables) priced at $1
          // Token A is typically the base token (SOL, etc.) priced via oracle
          const tokenAIsStable = _isStableToken(knownPool?.tokenASymbol);
          const tokenBIsStable = _isStableToken(knownPool?.tokenBSymbol);
          const tokenAPriceUsd = tokenAIsStable ? 1 : (currentPrice > 0 ? solPriceUsd : 1);
          const tokenBPriceUsd = tokenBIsStable ? 1 : solPriceUsd;
          liquidityUsd = tokenAUi * tokenAPriceUsd + tokenBUi * tokenBPriceUsd;
        } catch (liqErr) {
          logger.debug('[Orca] liquidityUsd calc failed, defaulting to 0:', liqErr);
          liquidityUsd = 0;
        }

        // ── Unclaimed fees from on-chain position data ──
        // Wrapped in try/catch so fee-read failures don't kill the position scan
        try {
          const feeOwedAUi = Number(data.feeOwedA?.toString?.() ?? '0') / (10 ** tokenADec);
          const feeOwedBUi = Number(data.feeOwedB?.toString?.() ?? '0') / (10 ** tokenBDec);
          unclaimedFeesSol = feeOwedAUi;    // tokenA fees (in tokenA units, typically SOL)
          unclaimedFeesUsdc = feeOwedBUi;   // tokenB fees (in tokenB units, typically USDC)
        } catch (feeErr) {
          logger.debug('[Orca] fee calc failed, defaulting to 0:', feeErr);
        }

        result.push({
          positionMint: parsed.mint,
          whirlpoolAddress: poolAddress,
          lowerPrice,
          upperPrice,
          currentPrice,
          liquidityUsd,
          unclaimedFeesUsdc,
          unclaimedFeesSol,
          inRange,
          rangeUtilisationPct,
        });
      } catch (posErr) {
        // Not a Whirlpool position or pool not found — skip silently
        // Only log if it looks like a real position that failed
        if (posErr instanceof Error && !posErr.message?.includes('Account does not exist')) {
          logger.warn(`[Orca] getPositions: position error for mint=${parsed?.mint?.slice?.(0, 8)}: ${posErr.message}`);
        }
        continue;
      }
    }

    return result;
  } catch (err) {
    logger.warn('[Orca] getPositions top-level error (returning []):', err);
    return [];
  }
}

// Helper: determine if a token symbol is a stablecoin
function _isStableToken(symbol?: string): boolean {
  if (!symbol) return false;
  const stables = new Set(['USDC', 'USDT', 'DAI', 'USDH', 'UXD', 'PYUSD', 'USDG', 'USDS']);
  return stables.has(symbol.toUpperCase());
}
