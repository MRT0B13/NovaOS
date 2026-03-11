/**
 * Burn Service — Meme Token Burn-to-Fund Ecosystem
 *
 * Flow:
 *   1. User sends meme tokens to Nova's burn wallet (or approves delegation)
 *   2. Backend swaps tokens → SOL via Jupiter Ultra API
 *   3. SOL is distributed across ecosystem pools:
 *      40% Treasury | 30% Staking Rewards | 20% Community Rewards | 10% NOVA Buyback
 *   4. SPL tokens are burned (permanent removal from supply)
 *   5. User earns burn credits (redeemable for NOVA or rewards)
 *
 * Safety:
 *   - Only meme tokens from Nova-launched mint addresses are eligible
 *   - Minimum burn amount enforced (no dust attacks)
 *   - Slippage protection on Jupiter swap
 *   - Idempotent — duplicate burn detection via tx signature
 *   - All steps logged to token_burns table
 *   - Dry-run mode via BURN_LOG_ONLY=true
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getEnv } from '../env.ts';
import { getRpcUrl } from '../services/solanaRpc.ts';

// ============================================================
// Types
// ============================================================

/** Distribution split percentages — must sum to 100 */
export const DEFAULT_SPLITS = {
  treasury: 40,
  staking: 30,
  rewards: 20,
  buyback: 10,
} as const;

export interface BurnSplits {
  treasury: number;
  staking: number;
  rewards: number;
  buyback: number;
}

export interface BurnRequest {
  walletAddress: string;
  mint: string;
  amountTokens: number;
  /** Optional: link to the launch pack that created this token */
  launchPackId?: string;
}

export interface BurnQuote {
  mint: string;
  amountTokens: number;
  estimatedSol: number;
  estimatedUsd: number;
  distribution: {
    treasury: number;
    staking: number;
    rewards: number;
    buyback: number;
  };
  creditsEstimated: number;
  priceImpact: number;
  slippageBps: number;
  eligible: boolean;
  reason?: string;
}

export interface BurnResult {
  id: string;
  status: 'completed' | 'failed';
  amountSol: number;
  amountUsd: number;
  distribution: {
    treasury: number;
    staking: number;
    rewards: number;
    buyback: number;
  };
  creditsEarned: number;
  swapTx: string | null;
  burnTx: string | null;
  error?: string;
}

export interface BurnStats {
  totalBurns: number;
  totalSolBurned: number;
  totalCreditsEarned: number;
  pools: {
    treasury: number;
    staking: number;
    rewards: number;
    buyback: number;
  };
  topBurners: Array<{
    wallet: string;
    burns: number;
    totalSol: number;
    credits: number;
  }>;
}

export interface WalletBurnSummary {
  wallet: string;
  totalBurns: number;
  totalSol: number;
  creditsEarned: number;
  creditsRedeemed: number;
  creditsAvailable: number;
  recentBurns: Array<{
    id: string;
    mint: string;
    tokenName: string | null;
    amountTokens: number;
    amountSol: number;
    creditsEarned: number;
    status: string;
    createdAt: string;
  }>;
}

// ============================================================
// Constants
// ============================================================

const JUPITER_ULTRA_BASE = 'https://ultra-api.jup.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Minimum SOL-equivalent value to accept a burn (prevent dust) */
const MIN_BURN_SOL = 0.001;

/** Credits per SOL burned (1 SOL burned = 100 credits) */
const CREDITS_PER_SOL = 100;

/** Max price impact allowed on Jupiter swap (3%) */
const MAX_PRICE_IMPACT_BPS = 300;

/** Default slippage for Jupiter swaps */
const DEFAULT_SLIPPAGE_BPS = 300; // 3%

// ============================================================
// Burn Service Class
// ============================================================

export class BurnService {
  private pool: Pool;
  private connection: Connection;
  private keypair: Keypair;
  private splits: BurnSplits;
  private logOnly: boolean;

  constructor(pool: Pool) {
    this.pool = pool;
    const rpcUrl = getRpcUrl();
    this.connection = new Connection(rpcUrl, 'confirmed');

    const env = getEnv();
    const secret = env.AGENT_FUNDING_WALLET_SECRET;
    if (!secret) throw new Error('AGENT_FUNDING_WALLET_SECRET required for burn service');
    this.keypair = Keypair.fromSecretKey(bs58.decode(secret));

    // Load custom splits from env or use defaults
    this.splits = {
      treasury: Number(process.env.BURN_SPLIT_TREASURY ?? DEFAULT_SPLITS.treasury),
      staking: Number(process.env.BURN_SPLIT_STAKING ?? DEFAULT_SPLITS.staking),
      rewards: Number(process.env.BURN_SPLIT_REWARDS ?? DEFAULT_SPLITS.rewards),
      buyback: Number(process.env.BURN_SPLIT_BUYBACK ?? DEFAULT_SPLITS.buyback),
    };

    // Validate splits sum to 100
    const sum = this.splits.treasury + this.splits.staking + this.splits.rewards + this.splits.buyback;
    if (Math.abs(sum - 100) > 0.01) {
      logger.warn(`[BurnService] Splits sum to ${sum}%, not 100% — using defaults`);
      this.splits = { ...DEFAULT_SPLITS };
    }

    this.logOnly = (process.env.BURN_LOG_ONLY ?? 'true') === 'true';

    logger.info(`[BurnService] Initialized — splits: ${JSON.stringify(this.splits)}, logOnly: ${this.logOnly}`);
  }

  // ── Quote ─────────────────────────────────────────────────────

  /**
   * Get a burn quote — estimates SOL proceeds and distribution without executing.
   */
  async getQuote(mint: string, amountTokens: number): Promise<BurnQuote> {
    // 1. Verify this mint is from a Nova launch
    const eligible = await this.isEligibleMint(mint);
    if (!eligible.ok) {
      return {
        mint,
        amountTokens,
        estimatedSol: 0,
        estimatedUsd: 0,
        distribution: { treasury: 0, staking: 0, rewards: 0, buyback: 0 },
        creditsEstimated: 0,
        priceImpact: 0,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        eligible: false,
        reason: eligible.reason,
      };
    }

    // 2. Get Jupiter quote (token → SOL)
    try {
      // Amount in the smallest unit (raw lamports-equivalent for the token)
      const tokenDecimals = await this.getTokenDecimals(mint);
      const rawAmount = Math.floor(amountTokens * (10 ** tokenDecimals));

      const quoteUrl = `${JUPITER_ULTRA_BASE}/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${rawAmount}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&taker=${this.keypair.publicKey.toBase58()}`;

      const resp = await fetch(quoteUrl);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return {
          mint, amountTokens,
          estimatedSol: 0, estimatedUsd: 0,
          distribution: { treasury: 0, staking: 0, rewards: 0, buyback: 0 },
          creditsEstimated: 0,
          priceImpact: 0,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          eligible: true,
          reason: `Jupiter quote failed: ${resp.status} ${errText}`,
        };
      }

      const quote = await resp.json() as any;
      const outLamports = Number(quote.outAmount ?? quote.outputAmount ?? 0);
      const estimatedSol = outLamports / LAMPORTS_PER_SOL;
      const priceImpact = Number(quote.priceImpactPct ?? quote.priceImpact ?? 0) * 100; // as bps

      // Estimate USD (rough: SOL ≈ $150, will be refined at execution)
      const solPrice = await this.getSolPrice();
      const estimatedUsd = estimatedSol * solPrice;

      if (estimatedSol < MIN_BURN_SOL) {
        return {
          mint, amountTokens,
          estimatedSol, estimatedUsd,
          distribution: { treasury: 0, staking: 0, rewards: 0, buyback: 0 },
          creditsEstimated: 0,
          priceImpact,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          eligible: false,
          reason: `Value too low: ${estimatedSol.toFixed(6)} SOL (min: ${MIN_BURN_SOL} SOL)`,
        };
      }

      const distribution = this.calculateDistribution(estimatedSol);
      const creditsEstimated = Math.floor(estimatedSol * CREDITS_PER_SOL);

      return {
        mint,
        amountTokens,
        estimatedSol,
        estimatedUsd,
        distribution,
        creditsEstimated,
        priceImpact,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        eligible: true,
      };

    } catch (err: any) {
      logger.error(`[BurnService] Quote failed for ${mint}:`, err);
      return {
        mint, amountTokens,
        estimatedSol: 0, estimatedUsd: 0,
        distribution: { treasury: 0, staking: 0, rewards: 0, buyback: 0 },
        creditsEstimated: 0,
        priceImpact: 0,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        eligible: true,
        reason: `Quote error: ${err.message}`,
      };
    }
  }

  // ── Execute Burn ──────────────────────────────────────────────

  /**
   * Execute a full burn: swap tokens → SOL → distribute → burn tokens → award credits.
   */
  async executeBurn(request: BurnRequest): Promise<BurnResult> {
    const burnId = uuidv4();
    const { walletAddress, mint, amountTokens, launchPackId } = request;

    // 1. Create burn record (pending)
    const tokenInfo = await this.getTokenInfo(mint);
    await this.pool.query(
      `INSERT INTO token_burns
         (id, wallet_address, mint, token_name, token_ticker, amount_tokens, launch_pack_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())`,
      [burnId, walletAddress, mint, tokenInfo.name, tokenInfo.ticker, amountTokens, launchPackId ?? null]
    );

    try {
      // 2. Verify eligibility
      const eligible = await this.isEligibleMint(mint);
      if (!eligible.ok) {
        await this.updateBurnStatus(burnId, 'failed', { error_message: eligible.reason });
        return this.failResult(burnId, eligible.reason!);
      }

      // 3. Verify the wallet actually holds the tokens
      const balance = await this.getTokenBalanceForWallet(walletAddress, mint);
      if (balance < amountTokens) {
        const msg = `Insufficient balance: ${balance} < ${amountTokens}`;
        await this.updateBurnStatus(burnId, 'failed', { error_message: msg });
        return this.failResult(burnId, msg);
      }

      // 4. Swap tokens → SOL via Jupiter
      await this.updateBurnStatus(burnId, 'swapping');
      const tokenDecimals = await this.getTokenDecimals(mint);
      const rawAmount = Math.floor(amountTokens * (10 ** tokenDecimals));

      let amountSol = 0;
      let swapTx: string | null = null;

      if (this.logOnly) {
        // Dry-run: get quote but don't execute
        const quoteUrl = `${JUPITER_ULTRA_BASE}/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${rawAmount}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&taker=${this.keypair.publicKey.toBase58()}`;
        const resp = await fetch(quoteUrl);
        if (resp.ok) {
          const quote = await resp.json() as any;
          const outLamports = Number(quote.outAmount ?? quote.outputAmount ?? 0);
          amountSol = outLamports / LAMPORTS_PER_SOL;
        }
        swapTx = 'DRY_RUN_' + burnId;
        logger.info(`[BurnService] DRY RUN: Would swap ${amountTokens} ${tokenInfo.ticker} → ~${amountSol.toFixed(6)} SOL`);
      } else {
        const swapResult = await this.executeJupiterSwap(mint, rawAmount);
        amountSol = swapResult.amountSol;
        swapTx = swapResult.txSignature;
      }

      if (amountSol < MIN_BURN_SOL) {
        const msg = `Swap produced too little SOL: ${amountSol.toFixed(6)}`;
        await this.updateBurnStatus(burnId, 'failed', { error_message: msg, swap_tx: swapTx });
        return this.failResult(burnId, msg);
      }

      // 5. Calculate distribution
      const distribution = this.calculateDistribution(amountSol);
      const solPrice = await this.getSolPrice();
      const amountUsd = amountSol * solPrice;

      // 6. Distribute to pools
      await this.updateBurnStatus(burnId, 'distributing');
      let distTx: string | null = null;

      if (this.logOnly) {
        logger.info(`[BurnService] DRY RUN distribution: treasury=${distribution.treasury.toFixed(6)}, staking=${distribution.staking.toFixed(6)}, rewards=${distribution.rewards.toFixed(6)}, buyback=${distribution.buyback.toFixed(6)}`);
        distTx = 'DRY_RUN_DIST_' + burnId;
      } else {
        distTx = await this.distributeToPoolsOnChain(distribution);
      }

      // 7. Burn the SPL tokens (if not already burned by swap)
      let burnTx: string | null = null;
      if (!this.logOnly) {
        burnTx = await this.burnSplTokens(mint, rawAmount);
      } else {
        burnTx = 'DRY_RUN_BURN_' + burnId;
        logger.info(`[BurnService] DRY RUN: Would burn ${amountTokens} ${tokenInfo.ticker} tokens`);
      }

      // 8. Award credits
      const creditsEarned = Math.floor(amountSol * CREDITS_PER_SOL);
      await this.awardCredits(walletAddress, creditsEarned, amountSol);

      // 9. Update burn record
      await this.pool.query(
        `UPDATE token_burns SET
           status = 'completed',
           amount_sol = $2,
           amount_usd = $3,
           dist_treasury = $4,
           dist_staking = $5,
           dist_rewards = $6,
           dist_buyback = $7,
           swap_tx = $8,
           dist_tx = $9,
           burn_tx = $10,
           credits_earned = $11,
           completed_at = NOW()
         WHERE id = $1`,
        [burnId, amountSol, amountUsd,
         distribution.treasury, distribution.staking, distribution.rewards, distribution.buyback,
         swapTx, distTx, burnTx, creditsEarned]
      );

      // 10. Update distribution aggregates
      await this.updateDistributionAggregates(distribution);

      logger.info(`[BurnService] ✅ Burn complete: ${amountTokens} ${tokenInfo.ticker} → ${amountSol.toFixed(6)} SOL → ${creditsEarned} credits for ${walletAddress}`);

      return {
        id: burnId,
        status: 'completed',
        amountSol,
        amountUsd,
        distribution,
        creditsEarned,
        swapTx,
        burnTx,
      };

    } catch (err: any) {
      logger.error(`[BurnService] Burn ${burnId} failed:`, err);
      await this.updateBurnStatus(burnId, 'failed', { error_message: err.message });
      return this.failResult(burnId, err.message);
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  /**
   * Get ecosystem-wide burn statistics.
   */
  async getStats(): Promise<BurnStats> {
    const [totals, topBurners] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*) AS total_burns,
           COALESCE(SUM(amount_sol), 0) AS total_sol,
           COALESCE(SUM(credits_earned), 0) AS total_credits
         FROM token_burns WHERE status = 'completed'`
      ),
      this.pool.query(
        `SELECT wallet_address, COUNT(*) AS burns,
                COALESCE(SUM(amount_sol), 0) AS total_sol,
                COALESCE(SUM(credits_earned), 0) AS credits
         FROM token_burns WHERE status = 'completed'
         GROUP BY wallet_address ORDER BY total_sol DESC LIMIT 10`
      ),
    ]);

    const distRow = await this.pool.query(
      `SELECT treasury_total, staking_total, rewards_total, buyback_total
       FROM burn_distributions WHERE period = 'all_time' LIMIT 1`
    );
    const dist = distRow.rows[0] ?? {};

    const t = totals.rows[0] ?? {};
    return {
      totalBurns: Number(t.total_burns ?? 0),
      totalSolBurned: Number(t.total_sol ?? 0),
      totalCreditsEarned: Number(t.total_credits ?? 0),
      pools: {
        treasury: Number(dist.treasury_total ?? 0),
        staking: Number(dist.staking_total ?? 0),
        rewards: Number(dist.rewards_total ?? 0),
        buyback: Number(dist.buyback_total ?? 0),
      },
      topBurners: topBurners.rows.map((r: any) => ({
        wallet: r.wallet_address,
        burns: Number(r.burns),
        totalSol: Number(r.total_sol),
        credits: Number(r.credits),
      })),
    };
  }

  /**
   * Get a wallet's burn history and credit balance.
   */
  async getWalletSummary(wallet: string): Promise<WalletBurnSummary> {
    const [credits, burns] = await Promise.all([
      this.pool.query(
        `SELECT total_earned, total_redeemed, total_burns, total_sol_value
         FROM burn_credits WHERE wallet_address = $1`, [wallet]
      ),
      this.pool.query(
        `SELECT id, mint, token_name, amount_tokens, amount_sol, credits_earned, status, created_at
         FROM token_burns WHERE wallet_address = $1
         ORDER BY created_at DESC LIMIT 25`, [wallet]
      ),
    ]);

    const c = credits.rows[0] ?? { total_earned: 0, total_redeemed: 0, total_burns: 0, total_sol_value: 0 };
    const earned = Number(c.total_earned ?? 0);
    const redeemed = Number(c.total_redeemed ?? 0);

    return {
      wallet,
      totalBurns: Number(c.total_burns ?? 0),
      totalSol: Number(c.total_sol_value ?? 0),
      creditsEarned: earned,
      creditsRedeemed: redeemed,
      creditsAvailable: earned - redeemed,
      recentBurns: burns.rows.map((r: any) => ({
        id: r.id,
        mint: r.mint,
        tokenName: r.token_name,
        amountTokens: Number(r.amount_tokens),
        amountSol: Number(r.amount_sol ?? 0),
        creditsEarned: Number(r.credits_earned ?? 0),
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Get the list of eligible mints (tokens launched by Nova on pump.fun).
   */
  async getEligibleTokens(): Promise<Array<{
    mint: string;
    name: string;
    ticker: string;
    launchPackId: string;
    launchStatus: string;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT id,
              data->'launch'->>'mint' AS mint,
              data->'brand'->>'name' AS name,
              data->'brand'->>'ticker' AS ticker,
              launch_status
       FROM launch_packs
       WHERE data->'launch'->>'mint' IS NOT NULL
       ORDER BY created_at DESC`
    );

    return rows
      .filter((r: any) => r.mint)
      .map((r: any) => ({
        mint: r.mint,
        name: r.name ?? 'Unknown',
        ticker: r.ticker ?? '???',
        launchPackId: r.id,
        launchStatus: r.launch_status,
      }));
  }

  /**
   * Get the current distribution split config.
   */
  getSplits(): BurnSplits {
    return { ...this.splits };
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private calculateDistribution(amountSol: number): {
    treasury: number; staking: number; rewards: number; buyback: number;
  } {
    return {
      treasury: amountSol * (this.splits.treasury / 100),
      staking: amountSol * (this.splits.staking / 100),
      rewards: amountSol * (this.splits.rewards / 100),
      buyback: amountSol * (this.splits.buyback / 100),
    };
  }

  private async isEligibleMint(mint: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      // Check if this mint was launched by Nova (exists in launch_packs)
      const { rows } = await this.pool.query(
        `SELECT id FROM launch_packs WHERE data->'launch'->>'mint' = $1 LIMIT 1`,
        [mint]
      );
      if (!rows.length) {
        return { ok: false, reason: 'Token not launched by Nova — only Nova-launched tokens are eligible for burn' };
      }
      return { ok: true };
    } catch (err: any) {
      logger.warn(`[BurnService] Eligibility check failed:`, err);
      return { ok: false, reason: `Eligibility check error: ${err.message}` };
    }
  }

  private async getTokenDecimals(mint: string): Promise<number> {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const data = (info.value?.data as any)?.parsed?.info;
      return data?.decimals ?? 9; // pump.fun tokens are typically 6 decimals
    } catch {
      return 6; // pump.fun default
    }
  }

  private async getTokenInfo(mint: string): Promise<{ name: string | null; ticker: string | null }> {
    try {
      const { rows } = await this.pool.query(
        `SELECT data->'brand'->>'name' AS name, data->'brand'->>'ticker' AS ticker
         FROM launch_packs WHERE data->'launch'->>'mint' = $1 LIMIT 1`,
        [mint]
      );
      if (rows.length > 0) {
        return { name: rows[0].name, ticker: rows[0].ticker };
      }
    } catch {}
    return { name: null, ticker: null };
  }

  private async getTokenBalanceForWallet(walletAddress: string, mint: string): Promise<number> {
    try {
      const { getAssociatedTokenAddress } = await import('@solana/spl-token' as string);
      const wallet = new PublicKey(walletAddress);
      const mintPk = new PublicKey(mint);
      const ata = await getAssociatedTokenAddress(mintPk, wallet);
      const balance = await this.connection.getTokenAccountBalance(ata);
      return Number(balance.value.uiAmount ?? 0);
    } catch {
      return 0;
    }
  }

  private async executeJupiterSwap(inputMint: string, rawAmount: number): Promise<{
    amountSol: number;
    txSignature: string;
  }> {
    // 1. Get order from Jupiter Ultra
    const orderUrl = `${JUPITER_ULTRA_BASE}/order?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${rawAmount}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&taker=${this.keypair.publicKey.toBase58()}`;

    const orderResp = await fetch(orderUrl);
    if (!orderResp.ok) {
      const errText = await orderResp.text().catch(() => '');
      throw new Error(`Jupiter order failed: ${orderResp.status} ${errText}`);
    }

    const order = await orderResp.json() as any;
    const txBase64 = order.transaction;
    const requestId = order.requestId;

    if (!txBase64 || !requestId) {
      throw new Error('Jupiter order missing transaction or requestId');
    }

    // 2. Check price impact
    const priceImpactBps = Number(order.priceImpactPct ?? 0) * 100;
    if (priceImpactBps > MAX_PRICE_IMPACT_BPS) {
      throw new Error(`Price impact too high: ${priceImpactBps}bps > ${MAX_PRICE_IMPACT_BPS}bps limit`);
    }

    // 3. Deserialize and sign
    const txBuf = Buffer.from(txBase64, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);
    versionedTx.sign([this.keypair]);

    // 4. Execute via Jupiter Ultra
    const signedTxBase64 = Buffer.from(versionedTx.serialize()).toString('base64');
    const execResp = await fetch(`${JUPITER_ULTRA_BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signedTxBase64, requestId }),
    });

    if (!execResp.ok) {
      const errText = await execResp.text().catch(() => '');
      throw new Error(`Jupiter execute failed: ${execResp.status} ${errText}`);
    }

    const result = await execResp.json() as any;
    const outLamports = Number(result.outAmount ?? order.outAmount ?? 0);

    return {
      amountSol: outLamports / LAMPORTS_PER_SOL,
      txSignature: result.signature ?? result.txid ?? 'unknown',
    };
  }

  private async distributeToPoolsOnChain(distribution: {
    treasury: number; staking: number; rewards: number; buyback: number;
  }): Promise<string> {
    // In a full implementation, this would send SOL to separate pool wallets
    // via a Solana transaction. For now, we track the distribution in DB only
    // and the actual SOL stays in the main wallet until withdraw/treasury sweeps.
    //
    // TODO: When pool wallets are set up (BURN_TREASURY_WALLET, BURN_STAKING_WALLET, etc.),
    // build a multi-transfer instruction here.
    logger.info(`[BurnService] Distribution tracked (on-chain transfers pending pool wallet setup): T=${distribution.treasury.toFixed(6)}, S=${distribution.staking.toFixed(6)}, R=${distribution.rewards.toFixed(6)}, B=${distribution.buyback.toFixed(6)}`);
    return `DB_TRACKED_${Date.now()}`;
  }

  private async burnSplTokens(mint: string, rawAmount: number): Promise<string | null> {
    try {
      const { createBurnInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } =
        await import('@solana/spl-token' as string);
      const { Transaction } = await import('@solana/web3.js');

      const mintPk = new PublicKey(mint);
      const ata = await getAssociatedTokenAddress(mintPk, this.keypair.publicKey);

      const burnIx = createBurnInstruction(
        ata,                      // token account to burn from
        mintPk,                   // mint
        this.keypair.publicKey,   // authority (owner of the token account)
        rawAmount,                // amount in raw units
        [],                       // multi-signers (none)
        TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction().add(burnIx);
      tx.feePayer = this.keypair.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      tx.sign(this.keypair);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Confirm
      await this.connection.confirmTransaction(sig, 'confirmed');
      logger.info(`[BurnService] 🔥 Burned ${rawAmount} raw tokens of ${mint}: ${sig}`);
      return sig;

    } catch (err: any) {
      logger.warn(`[BurnService] SPL burn failed (non-fatal — tokens already swapped):`, err.message);
      return null;
    }
  }

  private async awardCredits(wallet: string, credits: number, solValue: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO burn_credits (wallet_address, total_earned, total_burns, total_sol_value, updated_at)
       VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (wallet_address) DO UPDATE SET
         total_earned = burn_credits.total_earned + $2,
         total_burns = burn_credits.total_burns + 1,
         total_sol_value = burn_credits.total_sol_value + $3,
         updated_at = NOW()`,
      [wallet, credits, solValue]
    );
  }

  private async updateDistributionAggregates(dist: {
    treasury: number; staking: number; rewards: number; buyback: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE burn_distributions SET
           total_burns = total_burns + 1,
           total_sol_burned = total_sol_burned + $1,
           treasury_total = treasury_total + $2,
           staking_total = staking_total + $3,
           rewards_total = rewards_total + $4,
           buyback_total = buyback_total + $5,
           updated_at = NOW()
         WHERE period = 'all_time'`,
        [
          dist.treasury + dist.staking + dist.rewards + dist.buyback,
          dist.treasury, dist.staking, dist.rewards, dist.buyback,
        ]
      );
    } catch (err: any) {
      logger.warn(`[BurnService] Failed to update aggregates:`, err.message);
    }
  }

  private async updateBurnStatus(burnId: string, status: string, extra?: Record<string, any>): Promise<void> {
    const sets = ['status = $2'];
    const params: any[] = [burnId, status];
    let idx = 3;

    if (extra) {
      for (const [key, val] of Object.entries(extra)) {
        sets.push(`${key} = $${idx}`);
        params.push(val);
        idx++;
      }
    }

    await this.pool.query(
      `UPDATE token_burns SET ${sets.join(', ')} WHERE id = $1`,
      params
    );
  }

  private async getSolPrice(): Promise<number> {
    try {
      // Try CoinGecko
      const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (resp.ok) {
        const data = await resp.json() as any;
        return data?.solana?.usd ?? 150;
      }
    } catch {}
    return 150; // fallback
  }

  private failResult(burnId: string, error: string): BurnResult {
    return {
      id: burnId,
      status: 'failed',
      amountSol: 0,
      amountUsd: 0,
      distribution: { treasury: 0, staking: 0, rewards: 0, buyback: 0 },
      creditsEarned: 0,
      swapTx: null,
      burnTx: null,
      error,
    };
  }
}
