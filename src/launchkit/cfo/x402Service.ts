/**
 * x402 Micropayment Service
 *
 * Monetises Nova's intelligence through per-call micropayments.
 * Buyers pay USDC on Solana before receiving each data response.
 *
 * The x402 protocol:
 *  - Client requests a resource
 *  - Server returns HTTP 402 with payment instructions (price, SPL token, recipient)
 *  - Client pays on-chain and retries with payment proof in X-Payment header
 *  - Server verifies payment, returns data
 *
 * This file implements the SERVER side (Nova selling data).
 *
 * Priced endpoints:
 *  GET /x402/rugcheck/:mint   — RugCheck safety report  ($0.02 USDC)
 *  GET /x402/signal/:query    — KOL signal for a token  ($0.001 USDC)
 *  GET /x402/trend            — Top 10 narrative trends ($0.10 USDC)
 *  GET /x402/portfolio        — Nova portfolio snapshot ($0.05 USDC)
 *  GET /x402/scout            — Latest scout digest     ($0.05 USDC)
 *  GET /x402/narrative        — Recent narrative shifts  ($0.03 USDC)
 *  GET /x402/lp               — Live LP positions        ($0.05 USDC)
 *
 * Revenue flows into the CFO treasury wallet for reinvestment.
 *
 * x402 spec: https://x402.org
 * SDK: @x402/core, @x402/svm (Solana verifier), @x402/express (middleware)
 */

import { logger } from '@elizaos/core';
import type { Request, Response, NextFunction, Express, Router } from 'express';
import { getCFOEnv } from './cfoEnv.ts';
import { getEnv } from '../env.ts';

// ============================================================================
// Types
// ============================================================================

export interface PaymentRequirement {
  scheme: 'exact';
  network: 'solana-mainnet';
  maxAmountRequired: string;   // lamports or token units as string
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;               // Nova's treasury wallet address
  maxTimeoutSeconds: number;
  asset: string;               // USDC mint address
  extra: {
    name: string;
    version: string;
  };
}

export interface X402Revenue {
  totalCalls: number;
  totalEarned: number;  // USDC
  last24h: number;
  byEndpoint: Record<string, { calls: number; earned: number }>;
}

// ============================================================================
// Constants
// ============================================================================

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

// ============================================================================
// Revenue tracking (in-memory cache + DB persistence)
// ============================================================================

const revenueTracker = {
  totalCalls: 0,
  totalEarned: 0,
  last24hEarned: 0,
  last24hReset: Date.now(),
  byEndpoint: {} as Record<string, { calls: number; earned: number }>,
  restored: false,
};

/** Restore revenue state from DB on first access */
async function ensureRevenueRestored(): Promise<void> {
  if (revenueTracker.restored) return;
  revenueTracker.restored = true;
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return;
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    const { rows } = await pool.query(
      `SELECT data FROM kv_store WHERE key = 'x402_revenue' LIMIT 1`,
    );
    await pool.end();
    if (rows[0]?.data) {
      const saved = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      revenueTracker.totalCalls = saved.totalCalls ?? 0;
      revenueTracker.totalEarned = saved.totalEarned ?? 0;
      revenueTracker.byEndpoint = saved.byEndpoint ?? {};
      logger.info(`[x402] Restored revenue state: $${revenueTracker.totalEarned.toFixed(4)} earned, ${revenueTracker.totalCalls} calls`);
    }
  } catch { /* non-fatal, start fresh */ }
}

/** Persist revenue state to DB */
async function persistRevenue(): Promise<void> {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return;
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    await pool.query(
      `INSERT INTO kv_store (key, data) VALUES ('x402_revenue', $1)
       ON CONFLICT (key) DO UPDATE SET data = $1`,
      [JSON.stringify({
        totalCalls: revenueTracker.totalCalls,
        totalEarned: revenueTracker.totalEarned,
        byEndpoint: revenueTracker.byEndpoint,
        updatedAt: new Date().toISOString(),
      })],
    );
    await pool.end();
  } catch { /* non-fatal */ }
}

function trackRevenue(endpoint: string, usdcAmount: number): void {
  revenueTracker.totalCalls++;
  revenueTracker.totalEarned += usdcAmount;

  // Reset 24h counter
  if (Date.now() - revenueTracker.last24hReset > 86_400_000) {
    revenueTracker.last24hEarned = 0;
    revenueTracker.last24hReset = Date.now();
  }
  revenueTracker.last24hEarned += usdcAmount;

  if (!revenueTracker.byEndpoint[endpoint]) {
    revenueTracker.byEndpoint[endpoint] = { calls: 0, earned: 0 };
  }
  revenueTracker.byEndpoint[endpoint].calls++;
  revenueTracker.byEndpoint[endpoint].earned += usdcAmount;

  // Persist every 5 calls to avoid excessive DB writes
  if (revenueTracker.totalCalls % 5 === 0) {
    persistRevenue().catch(() => {});
  }
}

export function getRevenue(): X402Revenue {
  // Trigger restore on first access (lazy)
  ensureRevenueRestored().catch(() => {});
  return {
    totalCalls: revenueTracker.totalCalls,
    totalEarned: revenueTracker.totalEarned,
    last24h: revenueTracker.last24hEarned,
    byEndpoint: { ...revenueTracker.byEndpoint },
  };
}

// ============================================================================
// Payment requirement builder
// ============================================================================

function buildPaymentRequirement(
  resource: string,
  description: string,
  priceUsdc: number,
  payToAddress: string,
): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'solana-mainnet',
    maxAmountRequired: Math.floor(priceUsdc * 10 ** USDC_DECIMALS).toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo: payToAddress,
    maxTimeoutSeconds: 300,
    asset: USDC_MINT,
    extra: { name: 'USDC', version: '1' },
  };
}

// ============================================================================
// Payment verifier (x402 SVM)
// ============================================================================

/**
 * Verify an x402 payment proof from the X-Payment header.
 * Returns true if payment is valid and amount >= required.
 */
async function verifyPayment(
  paymentHeader: string,
  requirement: PaymentRequirement,
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Try x402/svm facilitator-based verification
    const x402Svm = await import('@x402/svm');
    const x402Facilitator = await import('@x402/core/facilitator');

    // Build a facilitator and register the SVM scheme
    const facilitator = new x402Facilitator.x402Facilitator();
    (x402Svm as any).registerExactSvmScheme?.(facilitator, {});

    const verifyResult = await facilitator.verify(paymentHeader as any, requirement as any);
    return { valid: verifyResult.isValid !== false, error: (verifyResult as any).invalidReason };
  } catch {
    // SDK pipeline not available — use manual verification
    logger.debug('[x402] SDK verification not available, using manual on-chain check');
    return verifyPaymentManual(paymentHeader, requirement);
  }
}

/**
 * Manual verification fallback when x402/svm SDK is not installed.
 * Checks the payment header contains a valid Solana transaction signature
 * and verifies on-chain that the transfer went to our wallet.
 */
async function verifyPaymentManual(
  paymentHeader: string,
  requirement: PaymentRequirement,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { getRpcUrl } = await import('../services/solanaRpc.ts');

    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    const signature = decoded?.x402Version === 1 ? decoded.payload?.signature : decoded.signature;
    if (!signature) return { valid: false, error: 'No signature in payment header' };

    const connection = new Connection(getRpcUrl(), 'confirmed');
    const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) return { valid: false, error: 'Transaction not found on-chain' };

    // Check for SPL token transfer to our pay-to address of required amount
    const required = BigInt(requirement.maxAmountRequired);
    const instructions = tx.transaction.message.instructions as any[];

    for (const ix of instructions) {
      if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
        const info = ix.parsed?.info;
        if (!info) continue;
        const dest = info.destination ?? info.authority;
        const amount = BigInt(info.tokenAmount?.amount ?? info.amount ?? 0);
        if (dest === requirement.payTo && amount >= required) {
          return { valid: true };
        }
      }
    }

    return { valid: false, error: 'Payment transfer not found in transaction' };
  } catch (err) {
    return { valid: false, error: `Verification error: ${(err as Error).message}` };
  }
}

// ============================================================================
// Express middleware factory
// ============================================================================

/**
 * Create an Express middleware that enforces x402 payment before handler runs.
 * Usage:
 *   router.get('/rugcheck/:mint', requirePayment('rugcheck', env.x402PriceRugcheck), handler)
 */
export function requirePayment(endpoint: string, priceUsdc: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const env = getCFOEnv();
    const solEnv = getEnv();

    const payToAddress = solEnv.AGENT_FUNDING_WALLET_SECRET
      ? (() => {
          try {
            const { Keypair } = require('@solana/web3.js');
            const bs58 = require('bs58');
            return Keypair.fromSecretKey(bs58.decode(solEnv.AGENT_FUNDING_WALLET_SECRET)).publicKey.toBase58();
          } catch {
            logger.warn('[x402] Could not derive payTo wallet address — payment verification may fail');
            return '11111111111111111111111111111111'; // system program (will reject, but safer than URL)
          }
        })()
      : (() => {
          logger.warn('[x402] AGENT_FUNDING_WALLET_SECRET not set — payment collection disabled');
          return '11111111111111111111111111111111';
        })();

    const resource = `${env.x402BaseUrl}${req.path}`;
    const requirement = buildPaymentRequirement(
      resource,
      `Nova AI data: ${endpoint}`,
      priceUsdc,
      payToAddress,
    );

    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (!paymentHeader) {
      // Return 402 with payment instructions
      res.status(402).json({
        x402Version: 1,
        error: 'Payment required',
        accepts: [requirement],
      });
      return;
    }

    // Verify the payment
    const { valid, error } = await verifyPayment(paymentHeader, requirement);
    if (!valid) {
      res.status(402).json({
        x402Version: 1,
        error: error ?? 'Invalid payment',
        accepts: [requirement],
      });
      return;
    }

    // Payment verified — track revenue and proceed
    trackRevenue(endpoint, priceUsdc);
    logger.info(`[x402] Payment verified for ${endpoint}: $${priceUsdc} USDC`);
    next();
  };
}

// ============================================================================
// Route registration
// ============================================================================

/**
 * Register all x402 revenue-generating routes onto an Express router.
 * Call this in the main launchkit server setup.
 *
 * Usage:
 *   const router = express.Router();
 *   registerX402Routes(router);
 *   app.use('/x402', router);
 */
export function registerX402Routes(router: Router): void {
  const env = getCFOEnv();

  // ── RugCheck report ─────────────────────────────────────────────
  router.get(
    '/rugcheck/:mint',
    requirePayment('rugcheck', env.x402PriceRugcheck),
    async (req: Request, res: Response) => {
      try {
        const { scanToken, formatReportForTelegram } = await import('../services/rugcheck.ts');
        const report = await scanToken(req.params.mint);
        if (!report) {
          res.status(404).json({ error: 'Token not found or scan failed' });
          return;
        }
        res.json({ mint: req.params.mint, report, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── KOL signal ──────────────────────────────────────────────────
  router.get(
    '/signal',
    requirePayment('signal', env.x402PriceSignal),
    async (req: Request, res: Response) => {
      try {
        const { getReplyIntel } = await import('../services/novaResearch.ts');
        const query = (req.query.q as string) ?? 'latest crypto signal';
        const intel = await getReplyIntel(query);
        res.json({ query, intel, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Trend report ─────────────────────────────────────────────────
  router.get(
    '/trend',
    requirePayment('trend', env.x402PriceTrend),
    async (req: Request, res: Response) => {
      try {
        const { getPoolStats } = await import('../services/trendPool.ts');
        const stats = getPoolStats();
        res.json({ trends: stats.topTrends, totalInPool: stats.totalInPool, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Nova portfolio snapshot (premium) ─────────────────────────────
  router.get(
    '/portfolio',
    requirePayment('portfolio', 0.05),
    async (req: Request, res: Response) => {
      try {
        const { getPnLSummary } = await import('../services/pnlTracker.ts');
        const summary = await getPnLSummary();
        res.json({ summary, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Scout digest — latest batched intel summary ──────────────────
  router.get(
    '/scout',
    requirePayment('scout', env.x402PriceScoutDigest),
    async (req: Request, res: Response) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        let scoutData: any = null;
        try {
          const raw = fs.readFileSync(path.resolve('./data/system_metrics.json'), 'utf-8');
          const metrics = JSON.parse(raw);
          scoutData = metrics?.scoutDigest ?? metrics?.lastScoutDigest ?? null;
        } catch { /* file may not exist */ }
        if (!scoutData) {
          res.status(404).json({ error: 'No scout digest available yet' });
          return;
        }
        res.json({ scoutDigest: scoutData, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Narrative shifts — recent narrative shift alerts ──────────────
  router.get(
    '/narrative',
    requirePayment('narrative', env.x402PriceNarrativeShift),
    async (req: Request, res: Response) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        let trendData: any = null;
        try {
          const raw = fs.readFileSync(path.resolve('./data/trend_pool.json'), 'utf-8');
          trendData = JSON.parse(raw);
        } catch { /* file may not exist */ }
        const narratives = trendData?.narrativeShifts ?? trendData?.trends?.filter((t: any) => t.type === 'narrative_shift') ?? [];
        res.json({ narrativeShifts: narratives.slice(0, 10), generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── LP positions — current Orca / DeFi LP positions ──────────────
  router.get(
    '/lp',
    requirePayment('lp', env.x402PriceLpPositions),
    async (req: Request, res: Response) => {
      try {
        const { getPnLSummary } = await import('../services/pnlTracker.ts');
        const summary = await getPnLSummary();
        const lpPositions = (summary as any)?.positions?.filter((p: any) =>
          p.strategy === 'orca_lp' || p.strategy === 'kamino' || p.type === 'LP'
        ) ?? [];
        res.json({ lpPositions, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Revenue stats (free — for transparency / marketing) ────────────
  router.get('/stats', (req: Request, res: Response) => {
    res.json(getRevenue());
  });

  logger.info('[x402] Routes registered: /rugcheck/:mint, /signal, /trend, /portfolio, /scout, /narrative, /lp, /stats');
}

// ============================================================================
// x402 Client (Nova buying data from other x402 services)
// ============================================================================

/**
 * Make a paid request to an x402-protected external API.
 * Nova can BUY data from other AI agents / data providers.
 *
 * Flow:
 *  1. GET resource → 402 response with payment instructions
 *  2. Pay on-chain
 *  3. Retry GET with X-Payment header containing signed payment proof
 */
export async function x402Fetch(url: string, maxPriceUsdc = 0.10): Promise<unknown> {
  const env = getEnv();
  const walletSecret = env.AGENT_FUNDING_WALLET_SECRET;
  if (!walletSecret) throw new Error('[x402] AGENT_FUNDING_WALLET_SECRET not set for x402 client');

  // Step 1: initial request to get payment instructions
  const resp402 = await fetch(url);
  if (resp402.ok) {
    return resp402.json(); // resource is free
  }
  if (resp402.status !== 402) {
    throw new Error(`[x402] Unexpected status ${resp402.status} from ${url}`);
  }

  const paymentInfo = await resp402.json() as { accepts?: PaymentRequirement[] };
  const requirement = paymentInfo.accepts?.[0];
  if (!requirement) throw new Error('[x402] No payment requirements in 402 response');

  // Validate price
  const requiredUsdc = Number(requirement.maxAmountRequired) / 10 ** USDC_DECIMALS;
  if (requiredUsdc > maxPriceUsdc) {
    throw new Error(`[x402] Price $${requiredUsdc} exceeds max $${maxPriceUsdc}`);
  }

  // Step 2: Pay using Jupiter service (send USDC to payTo address)
  if (getCFOEnv().dryRun) {
    logger.info(`[x402] DRY RUN — would pay $${requiredUsdc} USDC to ${requirement.payTo} for ${url}`);
    return { dryRun: true, resource: url };
  }

  // Use @x402/core client if available
  try {
    const x402Client = await import('@x402/core/client');
    const x402Svm = await import('@x402/svm');

    // Build x402 client and register SVM scheme
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = await import('bs58');
    const keypair = Keypair.fromSecretKey(bs58.default ? (bs58.default as any).decode(walletSecret) : (bs58 as any).decode(walletSecret));

    const client = new x402Client.x402Client();
    const svmSigner = (x402Svm as any).toClientSvmSigner?.(keypair) ?? null;
    if (svmSigner) {
      (x402Svm as any).registerExactSvmScheme?.(client, { signer: svmSigner });
    }

    const paymentPayload = await client.createPaymentPayload(requirement as any);
    const paymentHeader = typeof paymentPayload === 'string'
      ? paymentPayload
      : Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const retryResp = await fetch(url, {
      headers: { 'X-Payment': paymentHeader },
    });

    if (!retryResp.ok) throw new Error(`[x402] Retry failed: ${retryResp.status}`);
    return retryResp.json();
  } catch (sdkErr) {
    throw new Error(`[x402] Client payment failed: ${(sdkErr as Error).message}`);
  }
}

// ============================================================================
// Raw HTTP handler (for non-Express servers like server.ts)
// ============================================================================

/**
 * Handle an x402 request from the raw HTTP server.
 * Enforces payment: returns 402 with payment instructions if no X-Payment header,
 * verifies on-chain payment if header is provided, then serves data.
 * Returns { status, body } for the server to send.
 */
export async function handleX402Request(
  pathname: string,
  searchParams: URLSearchParams,
  _pool: any,
  paymentHeader?: string,
): Promise<{ status: number; body: any }> {
  const env = getCFOEnv();

  if (!env.x402Enabled) {
    return { status: 404, body: { error: 'x402 service is disabled' } };
  }

  // Derive pay-to wallet address
  const solEnv = getEnv();
  const payToAddress = (() => {
    try {
      if (!solEnv.AGENT_FUNDING_WALLET_SECRET) return null;
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      return Keypair.fromSecretKey(bs58.decode(solEnv.AGENT_FUNDING_WALLET_SECRET)).publicKey.toBase58();
    } catch { return null; }
  })();

  /** Gate a paid endpoint — returns null if payment is valid, or a 402 response */
  async function gatePayment(
    endpoint: string,
    priceUsdc: number,
  ): Promise<{ status: number; body: any } | null> {
    // /x402/revenue is always free
    if (endpoint === 'revenue') return null;

    const resource = `${env.x402BaseUrl}${pathname}`;
    const requirement = buildPaymentRequirement(
      resource,
      `Nova AI data: ${endpoint}`,
      priceUsdc,
      payToAddress ?? '11111111111111111111111111111111',
    );

    if (!paymentHeader) {
      return {
        status: 402,
        body: { x402Version: 1, error: 'Payment required', accepts: [requirement] },
      };
    }

    const { valid, error } = await verifyPayment(paymentHeader, requirement);
    if (!valid) {
      return {
        status: 402,
        body: { x402Version: 1, error: error ?? 'Invalid payment', accepts: [requirement] },
      };
    }

    // Payment verified — track revenue
    trackRevenue(endpoint, priceUsdc);
    logger.info(`[x402] Payment verified for ${endpoint}: $${priceUsdc} USDC`);
    return null; // proceed to serve data
  }

  // Route: /x402/rugcheck/:mint
  const rugcheckMatch = pathname.match(/^\/x402\/rugcheck\/([A-Za-z0-9]+)$/);
  if (rugcheckMatch) {
    const gate = await gatePayment('rugcheck', env.x402PriceRugcheck);
    if (gate) return gate;
    try {
      const { scanToken } = await import('../services/rugcheck.ts');
      const report = await scanToken(rugcheckMatch[1]);
      if (!report) return { status: 404, body: { error: 'Token not found or scan failed' } };
      return { status: 200, body: { mint: rugcheckMatch[1], report, generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  // Route: /x402/signal
  if (pathname === '/x402/signal') {
    const gate = await gatePayment('signal', env.x402PriceSignal);
    if (gate) return gate;
    try {
      const { getReplyIntel } = await import('../services/novaResearch.ts');
      const query = searchParams.get('q') ?? 'latest crypto signal';
      const intel = await getReplyIntel(query);
      return { status: 200, body: { query, intel, generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  // Route: /x402/trend
  if (pathname === '/x402/trend') {
    const gate = await gatePayment('trend', env.x402PriceTrend);
    if (gate) return gate;
    try {
      const fs = await import('fs');
      const path = await import('path');
      let trends: any = null;
      try {
        const raw = fs.readFileSync(path.resolve('./data/trend_pool.json'), 'utf-8');
        trends = JSON.parse(raw);
      } catch { /* file may not exist */ }
      return { status: 200, body: { trends: trends?.trends?.slice(0, 10) ?? [], generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  // Route: /x402/revenue — public stats (no payment required)
  if (pathname === '/x402/revenue') {
    return { status: 200, body: { data: getRevenue() } };
  }

  // Route: /x402/scout — latest scout digest
  if (pathname === '/x402/scout') {
    const gate = await gatePayment('scout', env.x402PriceScoutDigest);
    if (gate) return gate;
    try {
      const fs = await import('fs');
      const path = await import('path');
      let scoutData: any = null;
      try {
        const raw = fs.readFileSync(path.resolve('./data/system_metrics.json'), 'utf-8');
        const metrics = JSON.parse(raw);
        scoutData = metrics?.scoutDigest ?? metrics?.lastScoutDigest ?? null;
      } catch { /* file may not exist */ }
      if (!scoutData) return { status: 404, body: { error: 'No scout digest available yet' } };
      return { status: 200, body: { scoutDigest: scoutData, generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  // Route: /x402/narrative — recent narrative shifts
  if (pathname === '/x402/narrative') {
    const gate = await gatePayment('narrative', env.x402PriceNarrativeShift);
    if (gate) return gate;
    try {
      const fs = await import('fs');
      const path = await import('path');
      let trendData: any = null;
      try {
        const raw = fs.readFileSync(path.resolve('./data/trend_pool.json'), 'utf-8');
        trendData = JSON.parse(raw);
      } catch { /* file may not exist */ }
      const narratives = trendData?.narrativeShifts ?? trendData?.trends?.filter((t: any) => t.type === 'narrative_shift') ?? [];
      return { status: 200, body: { narrativeShifts: narratives.slice(0, 10), generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  // Route: /x402/lp — live LP positions
  if (pathname === '/x402/lp') {
    const gate = await gatePayment('lp', env.x402PriceLpPositions);
    if (gate) return gate;
    try {
      const { getPnLSummary } = await import('../services/pnlTracker.ts');
      const summary = await getPnLSummary();
      const lpPositions = (summary as any)?.positions?.filter((p: any) =>
        p.strategy === 'orca_lp' || p.strategy === 'kamino' || p.type === 'LP'
      ) ?? [];
      return { status: 200, body: { lpPositions, generatedAt: new Date().toISOString() } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  return { status: 404, body: { error: 'Unknown x402 endpoint' } };
}
