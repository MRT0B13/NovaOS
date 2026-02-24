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

// SOL/USDC Whirlpool (0.3% fee tier) — highest liquidity, most fee revenue
const SOL_USDC_WHIRLPOOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ';
const TICK_SPACING = 64;

// ============================================================================
// Types
// ============================================================================

export interface OrcaPosition {
  positionMint: string;
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
 * Open a new concentrated LP position centred on current SOL price.
 * @param usdcAmount  USDC to deposit as one side of the LP
 * @param solAmount   SOL to deposit as the other side (should be ~equal USD value)
 * @param rangeWidthPct  total range width as % of current price (e.g. 20 = ±10%)
 * @param whirlpoolAddress  optional whirlpool address (defaults to SOL/USDC)
 */
export async function openPosition(
  usdcAmount: number,
  solAmount: number,
  rangeWidthPct?: number,
  whirlpoolAddress?: string,
): Promise<OrcaOpenResult> {
  const env = getCFOEnv();
  const halfRange = (rangeWidthPct ?? env.orcaLpRangeWidthPct ?? 20) / 2 / 100;
  const poolAddress = whirlpoolAddress ?? SOL_USDC_WHIRLPOOL;

  if (env.dryRun) {
    logger.info(`[Orca] DRY RUN — would open LP: $${usdcAmount} USDC + ${solAmount} SOL, range ±${halfRange * 100}%`);
    return { success: true, positionMint: `dry-position-${Date.now()}`, lowerPrice: 0, upperPrice: 0 };
  }

  try {
    const { WhirlpoolContext, buildWhirlpoolClient, PriceMath, TickUtil,
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
    const Decimal = (await import('decimal.js')).default;
    const BN = (await import('bn.js')).default;
    const currentPriceDec = PriceMath.sqrtPriceX64ToPrice(
      whirlpoolData.sqrtPrice,
      9,  // SOL decimals
      6,  // USDC decimals
    );
    const currentPrice = currentPriceDec.toNumber();

    // Calculate tick range centred on current price — PriceMath needs Decimal
    const lowerPriceDec = currentPriceDec.mul(1 - halfRange);
    const upperPriceDec = currentPriceDec.mul(1 + halfRange);
    const lowerTick = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(lowerPriceDec, 9, 6),
      TICK_SPACING,
    );
    const upperTick = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(upperPriceDec, 9, 6),
      TICK_SPACING,
    );

    // Build liquidity quote from the USDC input amount (token A = USDC in SOL/USDC pool)
    const tokenAMint = whirlpoolData.tokenMintA; // USDC
    const usdcInputAmount = new BN(Math.floor(usdcAmount * 1e6));
    const liquidityInput = increaseLiquidityQuoteByInputTokenWithParams({
      tokenMintA: whirlpoolData.tokenMintA,
      tokenMintB: whirlpoolData.tokenMintB,
      sqrtPrice: whirlpoolData.sqrtPrice,
      tickCurrentIndex: whirlpoolData.tickCurrentIndex,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      inputTokenMint: tokenAMint,
      inputTokenAmount: usdcInputAmount,
      slippageTolerance: Percentage.fromFraction(10, 1000), // 1% slippage
      tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
    });

    // Open LP position
    const { tx, positionMint } = await whirlpool.openPosition(
      lowerTick,
      upperTick,
      liquidityInput,
      walletKeypair.publicKey,
    );

    const signature = await tx.buildAndExecute();
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
    const { WhirlpoolContext, buildWhirlpoolClient } = await loadOrcaSdk();
    const { AnchorProvider, Wallet } = await loadAnchor();
    const { Percentage } = await import('@orca-so/common-sdk' as string);

    const walletKeypair = loadWallet();
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {});
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    // Use the whirlpool's closePosition which handles:
    // decrease liquidity → collect fees → collect rewards → close position account
    const position = await client.getPosition(new PublicKey(positionMint));
    const posData = position.getData();
    const whirlpool = await client.getPool(posData.whirlpool);
    const closeTxs = await whirlpool.closePosition(
      new PublicKey(positionMint),
      Percentage.fromFraction(10, 1000), // 1% slippage
      walletKeypair.publicKey,           // destination wallet
      walletKeypair.publicKey,           // position wallet (owns the NFT)
      walletKeypair.publicKey,           // payer
    );

    // closeTxs may be an array of TransactionBuilders or a single builder
    const txBuilders = Array.isArray(closeTxs) ? closeTxs : [closeTxs];
    let lastSig = '';
    for (const txBuilder of txBuilders) {
      lastSig = await txBuilder.buildAndExecute();
    }

    logger.info(`[Orca] Closed LP position ${positionMint.slice(0, 8)}: ${lastSig}`);
    return { success: true, txSignature: lastSig };
  } catch (err) {
    logger.error('[Orca] closePosition error:', err);
    return { success: false, error: (err as Error).message };
  }
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
    const { WhirlpoolContext, buildWhirlpoolClient, PriceMath } = await loadOrcaSdk();
    const { AnchorProvider, Wallet } = await loadAnchor();

    const walletKeypair = loadWallet();
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {});
    const ctx = WhirlpoolContext.withProvider(provider);
    const client = buildWhirlpoolClient(ctx);

    const whirlpool = await client.getPool(new PublicKey(SOL_USDC_WHIRLPOOL));
    const whirlpoolData = whirlpool.getData();
    const currentPrice = PriceMath.sqrtPriceX64ToPrice(whirlpoolData.sqrtPrice, 9, 6).toNumber();

    // Fetch all positions owned by this wallet for this whirlpool
    const positions = await (client as any).getPositionsByOwner(walletKeypair.publicKey);
    const result: OrcaPosition[] = [];

    for (const pos of positions) {
      const data = pos.getData();
      const lowerPrice = PriceMath.tickIndexToPrice(data.tickLowerIndex, 9, 6).toNumber();
      const upperPrice = PriceMath.tickIndexToPrice(data.tickUpperIndex, 9, 6).toNumber();
      const inRange = currentPrice >= lowerPrice && currentPrice <= upperPrice;

      // Range utilisation: 100% = exactly centred, 0% = at range edge
      const midPrice = (lowerPrice + upperPrice) / 2;
      const rangeHalf = (upperPrice - lowerPrice) / 2;
      const distFromCentre = Math.abs(currentPrice - midPrice);
      const rangeUtilisationPct = rangeHalf > 0
        ? Math.max(0, (1 - distFromCentre / rangeHalf) * 100)
        : 0;

      result.push({
        positionMint: pos.getAddress().toBase58(),
        lowerPrice,
        upperPrice,
        currentPrice,
        liquidityUsd: 0, // TODO: calculate from liquidity units + current prices
        unclaimedFeesUsdc: 0, // TODO: fetch from fees_owed
        unclaimedFeesSol: 0,
        inRange,
        rangeUtilisationPct,
      });
    }

    return result;
  } catch (err) {
    logger.debug('[Orca] getPositions error:', err);
    return [];
  }
}
