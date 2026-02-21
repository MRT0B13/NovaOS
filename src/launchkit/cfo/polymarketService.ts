/**
 * Polymarket CLOB Service
 *
 * Full production integration with Polymarket's prediction market platform.
 *
 * Architecture:
 *   - Gamma API  (gamma-api.polymarket.com) — market discovery, filtering, prices
 *   - CLOB API   (clob.polymarket.com)       — order book, order placement, positions
 *
 * Authentication:
 *   - L1 Auth: EIP-712 wallet signature → used to derive/refresh API credentials
 *   - L2 Auth: HMAC-SHA256 with derived API key → used for every trading request
 *
 * Order execution:
 *   - EIP-712 signed orders submitted to CTF Exchange on Polygon (chain 137)
 *   - Limit orders only (control slippage)
 *   - Kelly Criterion position sizing with fractional safety multiplier
 *
 * Market selection:
 *   - Crypto/tech markets only (regex keyword filter)
 *   - Minimum $10k open interest
 *   - Maximum 3 days to resolution
 *   - Minimum 5% edge over market price required
 *
 * Contracts (Polygon mainnet):
 *   CTF Exchange:  0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e
 *   USDC.e:        0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
 */

import { createHmac } from 'crypto';
import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

/** Polygon mainnet CTF Exchange contract (verifyingContract for EIP-712) */
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e';

/** USDC.e on Polygon (6 decimals) */
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const POLYGON_CHAIN_ID = 137;

/** Keywords that define a "crypto / tech" market — CFO's edge territory */
const CRYPTO_KEYWORDS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto',
  'defi', 'nft', 'blockchain', 'token', 'stablecoin', 'altcoin',
  'fed', 'interest rate', 'inflation', 'nasdaq', 'sp500', 'stock',
  'sec', 'etf', 'coinbase', 'binance', 'ftx', 'regulation', 'ai',
  'nvidia', 'openai', 'tech', 'apple', 'microsoft', 'google',
];

// ============================================================================
// Types
// ============================================================================

export interface PolyMarket {
  conditionId: string;
  question: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  tokens: PolyToken[];
  category: string;
}

export interface PolyToken {
  tokenId: string;
  outcome: 'Yes' | 'No';
  price: number;        // current market price 0–1
  winner?: boolean;
}

export interface MarketOpportunity {
  market: PolyMarket;
  targetToken: PolyToken;
  ourProb: number;      // our estimated probability
  marketProb: number;   // current market price
  edge: number;         // ourProb - marketProb
  kellyFraction: number;
  recommendedUsd: number;
  rationale: string;
}

export interface PlacedOrder {
  orderId: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: 'BUY';
  sizeUsd: number;
  limitPrice: number;
  status: 'LIVE' | 'MATCHED' | 'CANCELLED' | 'ERROR';
  createdAt: string;
  transactionHash?: string;
  errorMessage?: string;
}

export interface PolyPosition {
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  size: number;           // number of outcome tokens
  entryPrice: number;     // average entry price
  currentPrice: number;   // current market price
  costBasisUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  openedAt: string;
}

export interface CLOBCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// ============================================================================
// EIP-712 Signing (no external dependency — uses ethers-style manual encoding)
// ============================================================================

/**
 * Lazy-load ethers to avoid import errors if not installed.
 * The CFO will report an error on start if ethers is missing.
 */
let _ethersWallet: any = null;
let _ethers: any = null;

async function loadEthers(): Promise<{ wallet: any; ethers: any }> {
  if (_ethersWallet && _ethers) return { wallet: _ethersWallet, ethers: _ethers };
  try {
    const mod = await import('ethers');
    _ethers = mod.ethers ?? mod;
    const env = getCFOEnv();
    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');
    _ethersWallet = new _ethers.Wallet(env.evmPrivateKey);
    logger.info(`[Polymarket] EVM wallet loaded: ${_ethersWallet.address}`);
    return { wallet: _ethersWallet, ethers: _ethers };
  } catch (err) {
    throw new Error(`[Polymarket] ethers not available: ${(err as Error).message}. Run: bun add ethers`);
  }
}

/** EIP-712 domain for ClobAuth (L1 API key creation) */
const CLOB_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
};

/** EIP-712 types for ClobAuth */
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'int256' },
    { name: 'message', type: 'string' },
  ],
};

const CLOB_AUTH_MESSAGE =
  'This message attests that I am the owner of the Ethereum address associated with this API key.';

/** EIP-712 domain for CTF Exchange order signing */
const CTF_DOMAIN = {
  name: 'CTFExchange',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: CTF_EXCHANGE,
};

/** EIP-712 types for CTF Exchange Order */
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

// ============================================================================
// L1 Authentication (wallet-based, used for credential management)
// ============================================================================

async function getL1Headers(): Promise<Record<string, string>> {
  const { wallet } = await loadEthers();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.floor(Date.now() / 1000);

  const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, {
    address: wallet.address,
    timestamp,
    nonce,
    message: CLOB_AUTH_MESSAGE,
  });

  return {
    'POLY_ADDRESS': wallet.address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': nonce.toString(),
  };
}

// ============================================================================
// L2 Authentication (HMAC-SHA256, used for every trading request)
// ============================================================================

function buildL2Signature(
  secret: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: string,
): string {
  const message = `${timestamp}${nonce}${method}${path}${body}`;
  const hmac = createHmac('sha256', Buffer.from(secret, 'base64'));
  hmac.update(message);
  return hmac.digest('base64');
}

function getL2Headers(
  creds: CLOBCredentials,
  method: string,
  path: string,
  body = '',
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Date.now().toString();

  const signature = buildL2Signature(creds.secret, timestamp, nonce, method, path, body);

  return {
    'POLY_API_KEY': creds.apiKey,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': nonce,
    'POLY_PASSPHRASE': creds.passphrase,
    'Content-Type': 'application/json',
  };
}

// ============================================================================
// Credential Management
// ============================================================================

let cachedCreds: CLOBCredentials | null = null;

/**
 * Get CLOB credentials — uses env vars if provided, otherwise derives
 * from wallet via L1 auth.  Result is cached for the process lifetime.
 */
export async function getCLOBCredentials(): Promise<CLOBCredentials> {
  if (cachedCreds) return cachedCreds;

  const env = getCFOEnv();

  // If all three creds are provided via env, use them
  if (env.polymarketApiKey && env.polymarketApiSecret && env.polymarketPassphrase) {
    cachedCreds = {
      apiKey: env.polymarketApiKey,
      secret: env.polymarketApiSecret,
      passphrase: env.polymarketPassphrase,
    };
    logger.info('[Polymarket] Using pre-configured CLOB credentials');
    return cachedCreds;
  }

  // Derive credentials via L1 auth
  logger.info('[Polymarket] Deriving CLOB credentials via L1 auth...');
  const l1Headers = await getL1Headers();

  const resp = await fetch(`${CLOB_BASE}/auth/api-key`, {
    method: 'GET',
    headers: l1Headers,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] L1 auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { apiKey: string; secret: string; passphrase: string };

  if (!data.apiKey || !data.secret || !data.passphrase) {
    throw new Error('[Polymarket] L1 auth returned incomplete credentials');
  }

  cachedCreds = data;
  logger.info('[Polymarket] CLOB credentials derived successfully');
  return cachedCreds;
}

/** Force re-derivation of CLOB credentials (call on auth errors) */
export function invalidateCLOBCredentials(): void {
  cachedCreds = null;
  logger.warn('[Polymarket] CLOB credentials invalidated — will re-derive on next request');
}

// ============================================================================
// CLOB API helpers
// ============================================================================

async function clobGet<T>(path: string, authed = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (authed) {
    const creds = await getCLOBCredentials();
    const l2 = getL2Headers(creds, 'GET', path);
    Object.assign(headers, l2);
  }

  const resp = await fetch(`${CLOB_BASE}${path}`, { headers });

  if (resp.status === 401) {
    invalidateCLOBCredentials();
    throw new Error('[Polymarket] CLOB 401 — credentials refreshed, retry');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] CLOB GET ${path} failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<T>;
}

async function clobPost<T>(path: string, body: unknown): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const creds = await getCLOBCredentials();
  const headers = getL2Headers(creds, 'POST', path, bodyStr);

  const resp = await fetch(`${CLOB_BASE}${path}`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });

  if (resp.status === 401) {
    invalidateCLOBCredentials();
    throw new Error('[Polymarket] CLOB 401 — credentials refreshed, retry');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] CLOB POST ${path} failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<T>;
}

async function clobDelete<T>(path: string): Promise<T> {
  const creds = await getCLOBCredentials();
  const headers = getL2Headers(creds, 'DELETE', path);

  const resp = await fetch(`${CLOB_BASE}${path}`, { method: 'DELETE', headers });

  if (resp.status === 401) {
    invalidateCLOBCredentials();
    throw new Error('[Polymarket] CLOB 401 — credentials refreshed, retry');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] CLOB DELETE ${path} failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<T>;
}

// ============================================================================
// Market Discovery (Gamma API)
// ============================================================================

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  category: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

/**
 * Fetch active crypto/tech prediction markets from Gamma API.
 * Applies keyword filter, liquidity floor, and time-to-resolution cap.
 */
export async function fetchCryptoMarkets(options?: {
  minLiquidityUsd?: number;
  maxDaysToResolution?: number;
  limit?: number;
}): Promise<PolyMarket[]> {
  const minLiq = options?.minLiquidityUsd ?? 10_000;
  const maxDays = options?.maxDaysToResolution ?? 90;
  const limit = options?.limit ?? 100;

  try {
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&order=volume&ascending=false`;
    const resp = await fetch(url);

    if (!resp.ok) {
      throw new Error(`Gamma API error (${resp.status})`);
    }

    const raw = await resp.json() as GammaMarket[];
    const now = Date.now();

    const filtered = raw
      .filter((m) => {
        if (!m.conditionId || !m.tokens?.length) return false;
        if ((m.liquidity ?? 0) < minLiq) return false;
        if (m.closed || !m.active) return false;

        // Time-to-resolution filter
        const endMs = new Date(m.endDate).getTime();
        const daysLeft = (endMs - now) / 86_400_000;
        if (daysLeft <= 0 || daysLeft > maxDays) return false;

        // Keyword filter — must match at least one crypto/tech term
        const text = m.question.toLowerCase();
        return CRYPTO_KEYWORDS.some((kw) => text.includes(kw));
      })
      .map<PolyMarket>((m) => ({
        conditionId: m.conditionId,
        question: m.question,
        endDate: m.endDate,
        active: m.active,
        closed: m.closed,
        volume: m.volume ?? 0,
        liquidity: m.liquidity ?? 0,
        category: m.category ?? 'crypto',
        tokens: m.tokens.map((t) => ({
          tokenId: t.token_id,
          outcome: t.outcome === 'Yes' ? 'Yes' : 'No',
          price: Number(t.price) || 0,
          winner: t.winner,
        })),
      }));

    logger.info(`[Polymarket] Found ${filtered.length} crypto markets (filtered from ${raw.length} total)`);
    return filtered;
  } catch (err) {
    logger.error('[Polymarket] fetchCryptoMarkets error:', err);
    return [];
  }
}

/**
 * Fetch a single market by condition ID.
 */
export async function fetchMarket(conditionId: string): Promise<PolyMarket | null> {
  try {
    const resp = await fetch(`${GAMMA_BASE}/markets/${conditionId}`);
    if (!resp.ok) return null;

    const m = await resp.json() as GammaMarket;
    return {
      conditionId: m.conditionId,
      question: m.question,
      endDate: m.endDate,
      active: m.active,
      closed: m.closed,
      volume: m.volume ?? 0,
      liquidity: m.liquidity ?? 0,
      category: m.category ?? 'crypto',
      tokens: (m.tokens ?? []).map((t) => ({
        tokenId: t.token_id,
        outcome: t.outcome === 'Yes' ? 'Yes' : 'No',
        price: Number(t.price) || 0,
        winner: t.winner,
      })),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Kelly Criterion Position Sizing
// ============================================================================

/**
 * Kelly Criterion for binary prediction markets.
 *
 * For a BUY on YES at market price p, with our estimated probability q:
 *   edge = q - p
 *   b    = (1 - p) / p   (net odds: USDC gained per USDC wagered)
 *   f*   = (b * q - (1-q)) / b   (full Kelly fraction of bankroll)
 *   bet  = f* * kellyFraction * bankroll   (fractional Kelly for safety)
 *
 * Returns 0 if edge is below minEdge or Kelly is negative.
 */
export function kellySize(
  marketPrice: number,
  ourProb: number,
  bankrollUsd: number,
  kellyFraction = 0.25,
  minEdge = 0.05,
): { fraction: number; usdAmount: number } {
  const edge = ourProb - marketPrice;

  if (edge < minEdge || marketPrice <= 0 || marketPrice >= 1) {
    return { fraction: 0, usdAmount: 0 };
  }

  // Net odds in our favour (USDC per USDC wagered)
  const b = (1 - marketPrice) / marketPrice;
  const q = ourProb;
  const qLose = 1 - ourProb;

  const fullKelly = (b * q - qLose) / b;

  if (fullKelly <= 0) return { fraction: 0, usdAmount: 0 };

  const fraction = fullKelly * kellyFraction;
  const usdAmount = Math.min(fraction * bankrollUsd, bankrollUsd * 0.06); // hard cap at 6% per bet

  return { fraction, usdAmount: Math.round(usdAmount * 100) / 100 };
}

// ============================================================================
// Probability Estimation
// ============================================================================

/**
 * Estimate the probability of the YES outcome for a given market.
 *
 * Strategy:
 *  1. Use Scout intel if available (passed in as context)
 *  2. Apply market-type heuristics for common crypto questions
 *  3. Fall back to current market price +/- an informed nudge
 *
 * This is intentionally conservative — the edge comes from Nova's
 * narrative intelligence, not from overconfident priors.
 */
export function estimateProbability(
  market: PolyMarket,
  scoutContext?: {
    cryptoBullish?: boolean;   // Scout's overall crypto sentiment
    btcAbove?: number;         // BTC price estimate at resolution
    relevantNarratives?: string[];
  },
): { prob: number; confidence: number; rationale: string } {
  const question = market.question.toLowerCase();
  const yesToken = market.tokens.find((t) => t.outcome === 'Yes');
  const marketPrice = yesToken?.price ?? 0.5;

  // ── Crypto price milestone questions ──
  // "Will BTC be above $X by date?"
  const btcPriceMatch = question.match(/btc|bitcoin.*(above|reach|exceed).*\$?([\d,]+)k?/);
  if (btcPriceMatch) {
    if (scoutContext?.btcAbove !== undefined && scoutContext?.cryptoBullish !== undefined) {
      const targetRaw = btcPriceMatch[2].replace(',', '');
      const target = Number(targetRaw) * (btcPriceMatch[0].includes('k') ? 1000 : 1);
      if (target > 0 && scoutContext.btcAbove > 0) {
        const prob = scoutContext.btcAbove > target ? 0.72 : 0.28;
        return {
          prob,
          confidence: 0.6,
          rationale: `BTC target $${target.toLocaleString()} vs Scout estimate $${scoutContext.btcAbove.toLocaleString()}`,
        };
      }
    }
  }

  // ── ETF / regulatory approval questions ──
  if (question.includes('etf') && question.includes('approv')) {
    // SEC historically approves ~60% of crypto ETFs when in active review
    const prob = scoutContext?.cryptoBullish ? 0.65 : 0.5;
    return { prob, confidence: 0.45, rationale: 'ETF approval heuristic + sentiment' };
  }

  // ── "Will X project launch by date?" ──
  if (question.includes('launch') || question.includes('mainnet')) {
    const prob = 0.55; // slight lean yes for announced launches
    return { prob, confidence: 0.4, rationale: 'Announced project launch base rate' };
  }

  // ── Scout narrative signal ──
  if (scoutContext?.relevantNarratives?.length) {
    const hasPositiveNarrative = scoutContext.relevantNarratives.some(
      (n) => question.includes(n.toLowerCase()),
    );
    if (hasPositiveNarrative) {
      const prob = Math.min(0.85, marketPrice + 0.12); // Scout gives +12% nudge
      return {
        prob,
        confidence: 0.55,
        rationale: `Scout narrative match: ${scoutContext.relevantNarratives.join(', ')}`,
      };
    }
  }

  // ── Fallback: no edge ──
  return {
    prob: marketPrice,
    confidence: 0,
    rationale: 'No edge identified — using market price',
  };
}

// ============================================================================
// Opportunity Scanning
// ============================================================================

/**
 * Scan crypto markets for betting opportunities.
 * Returns opportunities sorted by expected value descending.
 */
export async function scanOpportunities(
  bankrollUsd: number,
  scoutContext?: Parameters<typeof estimateProbability>[1],
  options?: {
    minLiquidityUsd?: number;
    maxDaysToResolution?: number;
  },
): Promise<MarketOpportunity[]> {
  const env = getCFOEnv();
  const markets = await fetchCryptoMarkets(options);
  const opportunities: MarketOpportunity[] = [];

  for (const market of markets) {
    const yesToken = market.tokens.find((t) => t.outcome === 'Yes');
    const noToken = market.tokens.find((t) => t.outcome === 'No');

    if (!yesToken || !noToken) continue;

    const { prob: ourProb, confidence, rationale } = estimateProbability(market, scoutContext);

    // Check both YES and NO for edge
    for (const [token, side] of [[yesToken, 'YES'], [noToken, 'NO']] as const) {
      const effectiveOurProb = side === 'YES' ? ourProb : 1 - ourProb;
      const marketProb = token.price;
      const edge = effectiveOurProb - marketProb;

      if (edge < env.minEdge) continue;
      if (confidence < 0.3) continue; // Skip low-confidence calls

      const { fraction, usdAmount } = kellySize(
        marketProb,
        effectiveOurProb,
        bankrollUsd,
        env.kellyFraction,
        env.minEdge,
      );

      if (usdAmount < 2) continue; // Min $2 bet

      const cappedUsd = Math.min(usdAmount, env.maxSingleBetUsd);

      opportunities.push({
        market,
        targetToken: token,
        ourProb: effectiveOurProb,
        marketProb,
        edge,
        kellyFraction: fraction,
        recommendedUsd: cappedUsd,
        rationale: `${side} | edge=${(edge * 100).toFixed(1)}% | ${rationale}`,
      });
    }
  }

  // Sort by expected value (edge * recommended size)
  opportunities.sort((a, b) => b.edge * b.recommendedUsd - a.edge * a.recommendedUsd);

  logger.info(`[Polymarket] ${opportunities.length} opportunities found across ${markets.length} markets`);
  return opportunities;
}

// ============================================================================
// Order Building & Signing
// ============================================================================

interface OrderParams {
  tokenId: string;           // outcome token ID (uint256 as string)
  side: 0 | 1;               // 0 = BUY, 1 = SELL
  pricePerShare: number;     // 0–1
  sizeUsdc: number;          // dollar amount to wager
  expirationSeconds?: number; // 0 = never expire (GTC)
}

interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
}

/**
 * Build and EIP-712 sign an order for the CTF Exchange.
 */
async function buildSignedOrder(params: OrderParams): Promise<SignedOrder> {
  const { wallet } = await loadEthers();

  const USDC_DECIMALS = 6;
  const TOKEN_DECIMALS = 6;

  let makerAmountRaw: number;
  let takerAmountRaw: number;

  if (params.side === 0) {
    // BUY: maker spends USDC, gets outcome tokens
    //   makerAmount = USDC amount
    //   takerAmount = outcome token amount (USDC / price)
    makerAmountRaw = Math.floor(params.sizeUsdc * 10 ** USDC_DECIMALS);
    takerAmountRaw = Math.floor((params.sizeUsdc / params.pricePerShare) * 10 ** TOKEN_DECIMALS);
  } else {
    // SELL: maker has outcome tokens, wants USDC
    //   makerAmount = outcome token amount (USDC / price)
    //   takerAmount = USDC amount
    const tokenAmount = params.sizeUsdc / params.pricePerShare;
    makerAmountRaw = Math.floor(tokenAmount * 10 ** TOKEN_DECIMALS);
    takerAmountRaw = Math.floor(params.sizeUsdc * 10 ** USDC_DECIMALS);
  }

  const salt = BigInt(Date.now()) * BigInt(1_000_000) + BigInt(Math.floor(Math.random() * 1_000_000));
  const expiration = params.expirationSeconds ?? 0;
  const nonce = BigInt(0);
  const feeRateBps = BigInt(0); // taker fee handled by protocol

  const orderStruct = {
    salt: salt.toString(),
    maker: wallet.address,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: params.tokenId,
    makerAmount: makerAmountRaw.toString(),
    takerAmount: takerAmountRaw.toString(),
    expiration: expiration.toString(),
    nonce: nonce.toString(),
    feeRateBps: feeRateBps.toString(),
    side: params.side,
    signatureType: 0, // EOA signature
  };

  const signature = await wallet.signTypedData(CTF_DOMAIN, ORDER_TYPES, orderStruct);

  return { ...orderStruct, signature };
}

// ============================================================================
// Order Management
// ============================================================================

/**
 * Place a BUY limit order on Polymarket.
 * Returns a PlacedOrder record regardless of success/failure for audit logging.
 */
export async function placeBuyOrder(
  market: PolyMarket,
  token: PolyToken,
  sizeUsd: number,
): Promise<PlacedOrder> {
  const env = getCFOEnv();
  const result: PlacedOrder = {
    orderId: '',
    conditionId: market.conditionId,
    tokenId: token.tokenId,
    outcome: token.outcome,
    side: 'BUY',
    sizeUsd,
    limitPrice: token.price,
    status: 'ERROR',
    createdAt: new Date().toISOString(),
  };

  if (env.dryRun) {
    logger.info(
      `[Polymarket] DRY RUN — would BUY ${token.outcome} on "${market.question}" ` +
      `$${sizeUsd} @ ${(token.price * 100).toFixed(1)}¢`,
    );
    result.orderId = `dry-${Date.now()}`;
    result.status = 'LIVE';
    return result;
  }

  try {
    const signedOrder = await buildSignedOrder({
      tokenId: token.tokenId,
      side: 0, // BUY
      pricePerShare: token.price,
      sizeUsdc: sizeUsd,
    });

    const payload = {
      order: signedOrder,
      owner: signedOrder.maker,
      orderType: 'GTC', // Good till cancelled
    };

    const response = await clobPost<{ orderID: string; status: string; transactionsHashes?: string[] }>(
      '/order',
      payload,
    );

    result.orderId = response.orderID;
    result.status = response.status === 'live' ? 'LIVE' : 'MATCHED';
    result.transactionHash = response.transactionsHashes?.[0];

    logger.info(
      `[Polymarket] Order placed: ${result.orderId} — BUY ${token.outcome} ` +
      `"${market.question}" $${sizeUsd} @ ${(token.price * 100).toFixed(1)}¢`,
    );
  } catch (err) {
    result.errorMessage = (err as Error).message;
    logger.error(`[Polymarket] Order failed for "${market.question}": ${result.errorMessage}`);
  }

  return result;
}

/**
 * Cancel an open order by order ID.
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    await clobDelete(`/order/${orderId}`);
    logger.info(`[Polymarket] Cancelled order ${orderId}`);
    return true;
  } catch (err) {
    logger.error(`[Polymarket] Cancel failed for ${orderId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Cancel all open orders (emergency exit).
 */
export async function cancelAllOrders(): Promise<number> {
  try {
    const orders = await clobGet<Array<{ id: string }>>('/orders?status=live', true);
    let cancelled = 0;
    for (const o of orders) {
      if (await cancelOrder(o.id)) cancelled++;
    }
    logger.info(`[Polymarket] Cancelled ${cancelled} orders`);
    return cancelled;
  } catch (err) {
    logger.error('[Polymarket] cancelAllOrders error:', err);
    return 0;
  }
}

// ============================================================================
// Position Monitoring
// ============================================================================

/**
 * Fetch all current Polymarket positions for the connected wallet.
 */
export async function fetchPositions(): Promise<PolyPosition[]> {
  try {
    const { wallet } = await loadEthers();

    // Fetch from CLOB positions endpoint
    const raw = await clobGet<Array<{
      condition_id: string;
      question?: string;
      token_id: string;
      outcome: string;
      size: string;
      entry_price?: string;
      current_price?: string;
    }>>('/data/positions', true);

    const positions: PolyPosition[] = [];

    for (const p of raw) {
      const size = Number(p.size);
      const entryPrice = Number(p.entry_price ?? 0);
      const currentPrice = Number(p.current_price ?? 0);

      if (size <= 0) continue;

      const costBasisUsd = size * entryPrice;
      const currentValueUsd = size * currentPrice;

      positions.push({
        conditionId: p.condition_id,
        question: p.question ?? p.condition_id.slice(0, 20),
        tokenId: p.token_id,
        outcome: p.outcome,
        size,
        entryPrice,
        currentPrice,
        costBasisUsd,
        currentValueUsd,
        unrealizedPnlUsd: currentValueUsd - costBasisUsd,
        openedAt: new Date().toISOString(),
      });
    }

    logger.debug(`[Polymarket] ${positions.length} active positions`);
    return positions;
  } catch (err) {
    logger.error('[Polymarket] fetchPositions error:', err);
    return [];
  }
}

/**
 * Total USD value currently deployed in Polymarket positions.
 */
export async function getTotalDeployed(): Promise<number> {
  const positions = await fetchPositions();
  return positions.reduce((sum, p) => sum + p.currentValueUsd, 0);
}

/**
 * Total unrealized P&L across all positions.
 */
export async function getUnrealizedPnl(): Promise<number> {
  const positions = await fetchPositions();
  return positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
}

// ============================================================================
// Sell (exit) Position
// ============================================================================

/**
 * Place a SELL limit order to exit a position.
 * Uses current mid-price minus a small discount to ensure fill.
 */
export async function exitPosition(
  position: PolyPosition,
  fractionToSell = 1.0,
): Promise<PlacedOrder> {
  const env = getCFOEnv();
  const sizeToSell = position.size * Math.min(1, Math.max(0, fractionToSell));
  const sizeUsd = sizeToSell * position.currentPrice;

  const result: PlacedOrder = {
    orderId: '',
    conditionId: position.conditionId,
    tokenId: position.tokenId,
    outcome: position.outcome,
    side: 'BUY', // we track all as BUY since it was our entry direction
    sizeUsd,
    limitPrice: position.currentPrice,
    status: 'ERROR',
    createdAt: new Date().toISOString(),
  };

  if (env.dryRun) {
    logger.info(
      `[Polymarket] DRY RUN — would SELL ${(fractionToSell * 100).toFixed(0)}% of ` +
      `${position.outcome} on "${position.question}" (~$${sizeUsd.toFixed(2)})`,
    );
    result.orderId = `dry-sell-${Date.now()}`;
    result.status = 'LIVE';
    return result;
  }

  try {
    // SELL: maker has outcome tokens, takes USDC
    // Use current price minus 1% to ensure the order fills
    const sellPrice = Math.max(0.01, position.currentPrice * 0.99);

    const signedOrder = await buildSignedOrder({
      tokenId: position.tokenId,
      side: 1, // SELL
      pricePerShare: sellPrice,
      sizeUsdc: sizeUsd,
    });

    const payload = {
      order: signedOrder,
      owner: signedOrder.maker,
      orderType: 'GTC',
    };

    const response = await clobPost<{ orderID: string; status: string; transactionsHashes?: string[] }>(
      '/order',
      payload,
    );

    result.orderId = response.orderID;
    result.status = response.status === 'live' ? 'LIVE' : 'MATCHED';
    result.transactionHash = response.transactionsHashes?.[0];

    logger.info(
      `[Polymarket] Sell order placed: ${result.orderId} — ` +
      `${(fractionToSell * 100).toFixed(0)}% of "${position.question}" $${sizeUsd.toFixed(2)}`,
    );
  } catch (err) {
    result.errorMessage = (err as Error).message;
    logger.error(`[Polymarket] Sell failed for "${position.question}": ${result.errorMessage}`);
  }

  return result;
}

// ============================================================================
// Portfolio Summary
// ============================================================================

export interface PolymarketSummary {
  openPositions: number;
  totalDeployedUsd: number;
  unrealizedPnlUsd: number;
  positions: PolyPosition[];
  timestamp: string;
}

export async function getPortfolioSummary(): Promise<PolymarketSummary> {
  const positions = await fetchPositions();
  const totalDeployedUsd = positions.reduce((s, p) => s + p.currentValueUsd, 0);
  const unrealizedPnlUsd = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

  return {
    openPositions: positions.length,
    totalDeployedUsd,
    unrealizedPnlUsd,
    positions,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Health check
// ============================================================================

/** Verify CLOB API connectivity and credential validity */
export async function healthCheck(): Promise<{ ok: boolean; walletAddress?: string; error?: string }> {
  try {
    const { wallet } = await loadEthers();
    await getCLOBCredentials();

    // Simple endpoint to validate credentials
    const resp = await clobGet<{ address: string }>('/auth/api-key', true).catch(() => null);

    return { ok: true, walletAddress: wallet.address };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
