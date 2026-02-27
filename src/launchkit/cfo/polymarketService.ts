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
import { getPrices } from './pythOracleService.ts';

// ============================================================================
// Constants
// ============================================================================

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

/** Polygon mainnet CTF Exchange contract (verifyingContract for EIP-712) */
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

/** Neg-risk CTF Exchange (used for neg-risk markets, per SDK config.ts) */
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/** USDC.e on Polygon (6 decimals) */
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** ConditionalTokens (ERC-1155) on Polygon — exchanges need setApprovalForAll */
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** NegRisk Adapter — neg-risk markets route USDC through this contract.
 *  Requires BOTH USDC.e approve AND CT setApprovalForAll (in addition to NegRisk Exchange). */
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const POLYGON_CHAIN_ID = 137;

/** Keywords that define a "crypto / tech" market — CFO's edge territory */
const CRYPTO_KEYWORDS = [
  // Crypto L1/L2
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto',
  'polygon', 'matic', 'avalanche', 'avax', 'cardano', 'ada', 'xrp',
  'ripple', 'polkadot', 'dot', 'cosmos', 'atom', 'near', 'sui',
  'aptos', 'arbitrum', 'optimism', 'base', 'layer 2', 'l2',
  'ton', 'toncoin', 'sei', 'celestia', 'tia', 'injective', 'inj',
  'fantom', 'ftm', 'sonic', 'mantle', 'mnt', 'starknet', 'strk',
  'zksync', 'linea', 'scroll', 'monad', 'berachain',
  // DeFi / NFT / Web3
  'defi', 'nft', 'blockchain', 'token', 'stablecoin', 'altcoin',
  'dex', 'amm', 'yield', 'staking', 'airdrop', 'dao', 'web3',
  'uniswap', 'aave', 'lido', 'maker', 'usdc', 'usdt', 'tether',
  'curve', 'pendle', 'eigenlayer', 'restaking', 'liquid staking',
  'jito', 'marinade', 'raydium', 'jupiter', 'orca', 'drift',
  'morpho', 'compound', 'sushi', 'pancakeswap', 'gmx', 'perp',
  'ondo', 'ethena', 'ena', 'rwa', 'tokeniz',
  // Meme coins
  'doge', 'dogecoin', 'shiba', 'shib', 'pepe', 'bonk', 'wif',
  'floki', 'meme coin', 'memecoin',
  // Mining / Infrastructure
  'mining', 'hashrate', 'halving', 'miner', 'asic',
  'chainlink', 'link', 'oracle', 'pyth', 'the graph', 'grt',
  // Macro / TradFi overlap
  'fed', 'interest rate', 'inflation', 'nasdaq', 'sp500', 'stock',
  'treasury', 'rate cut', 'rate hike', 'recession', 'gdp', 'cpi',
  'tariff', 'trade war', 'sanctions', 'fomc', 'powell', 'yellen',
  'debt ceiling', 'unemployment', 'jobs report', 'nonfarm',
  'oil', 'gold', 'commodity', 'dollar', 'dxy',
  // Regulatory
  'sec', 'etf', 'coinbase', 'binance', 'ftx', 'regulation',
  'cftc', 'gensler', 'congress', 'ban crypto', 'kraken', 'okx',
  'bybit', 'bitfinex', 'delist', 'listing',
  // AI / Tech
  'ai', 'nvidia', 'openai', 'tech', 'apple', 'microsoft', 'google',
  'anthropic', 'meta', 'tesla', 'semiconductor', 'gpu', 'chatgpt',
  'deepseek', 'robot', 'agi', 'amazon', 'alphabet',
  // Geopolitics / Politics that move markets
  'china', 'russia', 'trump', 'biden', 'election', 'war', 'conflict',
  'ukraine', 'taiwan', 'iran', 'korea', 'nato', 'opec',
  'democrat', 'republican', 'senate', 'house', 'executive order',
  // Gaming / Metaverse
  'gaming', 'metaverse', 'play to earn', 'p2e', 'virtual world',
  // CBDC / Cross-border
  'cbdc', 'digital dollar', 'digital yuan', 'digital euro',
  'cross-chain', 'bridge', 'interop', 'wormhole', 'layerzero',
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
  minimumTickSize?: string; // e.g. '0.001' — from CLOB /markets response
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
  minimumTickSize?: string; // e.g. '0.001' — from CLOB /markets response
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

/** EIP-712 types for ClobAuth (must match @polymarket/clob-client exactly) */
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

/** Exact value from @polymarket/clob-client/src/signing/constants.ts */
const CLOB_AUTH_MESSAGE =
  'This message attests that I control the given wallet';

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
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 0; // SDK default — always 0 for L1 auth

  const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, {
    address: wallet.address,
    timestamp: `${timestamp}`,
    nonce,
    message: CLOB_AUTH_MESSAGE,
  });

  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_NONCE: `${nonce}`,
  };
}

// ============================================================================
// L2 Authentication (HMAC-SHA256, used for every trading request)
// ============================================================================

function buildL2Signature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body?: string,
): string {
  // Must match @polymarket/clob-client HMAC format exactly:
  // message = timestamp + method + requestPath [+ body]
  // (NO nonce — nonce is L1-only)
  let message = `${timestamp}${method}${path}`;
  if (body !== undefined) message += body;
  const hmac = createHmac('sha256', Buffer.from(secret, 'base64'));
  hmac.update(message);
  // URL-safe base64 per SDK: '+' → '-', '/' → '_'
  const sig = hmac.digest('base64');
  return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

async function getL2Headers(
  creds: CLOBCredentials,
  method: string,
  path: string,
  body?: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const { wallet } = await loadEthers();

  const signature = buildL2Signature(creds.secret, timestamp, method, path, body);

  // Must match @polymarket/clob-client L2PolyHeader exactly:
  // POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
  // (NO POLY_NONCE — nonce is L1-only)
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
    'Content-Type': 'application/json',
  };
}

// ============================================================================
// Credential Management
// ============================================================================

let cachedCreds: CLOBCredentials | null = null;
let envCredsExhausted = false; // true after env creds cause a 401

/**
 * Get CLOB credentials — uses env vars if provided (unless they already
 * caused a 401), otherwise derives from wallet via L1 auth.
 * Result is cached for the process lifetime until invalidated.
 */
export async function getCLOBCredentials(): Promise<CLOBCredentials> {
  if (cachedCreds) return cachedCreds;

  const env = getCFOEnv();

  // Use env-provided creds unless they already failed with 401
  if (!envCredsExhausted && env.polymarketApiKey && env.polymarketApiSecret && env.polymarketPassphrase) {
    cachedCreds = {
      apiKey: env.polymarketApiKey,
      secret: env.polymarketApiSecret,
      passphrase: env.polymarketPassphrase,
    };
    logger.info('[Polymarket] Using pre-configured CLOB credentials');
    return cachedCreds;
  }

  // Derive fresh credentials via L1 auth
  // Polymarket CLOB API endpoints (per official SDK):
  //   POST /auth/api-key         — creates new API key (L1 headers)
  //   GET  /auth/derive-api-key  — derives deterministic key (may 400 for new wallets)
  logger.info('[Polymarket] Deriving CLOB credentials via L1 auth...');
  const l1Headers = await getL1Headers();

  // POST /auth/api-key is the reliable path (works for all wallets)
  let resp = await fetch(`${CLOB_BASE}/auth/api-key`, {
    method: 'POST',
    headers: { ...l1Headers, 'Content-Type': 'application/json' },
  });

  // Fallback: GET /auth/derive-api-key (deterministic, may fail for new wallets)
  if (!resp.ok) {
    logger.debug('[Polymarket] POST /auth/api-key returned ' + resp.status + ', trying GET /auth/derive-api-key');
    resp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
      method: 'GET',
      headers: l1Headers,
    });
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] L1 auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { apiKey: string; secret: string; passphrase: string };

  if (!data.apiKey || !data.secret || !data.passphrase) {
    throw new Error('[Polymarket] L1 auth returned incomplete credentials');
  }

  cachedCreds = data;
  logger.info('[Polymarket] CLOB credentials derived successfully via L1');
  return cachedCreds;
}

/** Force re-derivation of CLOB credentials (call on 401 errors) */
export function invalidateCLOBCredentials(): void {
  cachedCreds = null;
  envCredsExhausted = true; // env creds failed; next call will use L1 derivation
  logger.warn('[Polymarket] CLOB credentials invalidated — will re-derive via L1 on next request');
}

// ============================================================================
// CLOB API helpers
// ============================================================================

async function clobGet<T>(path: string, authed = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (authed) {
    const creds = await getCLOBCredentials();
    const l2 = await getL2Headers(creds, 'GET', path);
    Object.assign(headers, l2);
  }

  const resp = await fetch(`${CLOB_BASE}${path}`, { headers });

  if (resp.status === 401 && authed) {
    // Invalidate stale creds, derive fresh via L1, and retry once
    invalidateCLOBCredentials();
    logger.warn(`[Polymarket] CLOB GET ${path} got 401 — retrying with fresh creds`);
    const freshCreds = await getCLOBCredentials();
    const freshHeaders = await getL2Headers(freshCreds, 'GET', path);
    Object.assign(headers, freshHeaders);
    const retry = await fetch(`${CLOB_BASE}${path}`, { headers });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`[Polymarket] CLOB GET ${path} failed after retry (${retry.status}): ${text}`);
    }
    return retry.json() as Promise<T>;
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
  const headers = await getL2Headers(creds, 'POST', path, bodyStr);

  const resp = await fetch(`${CLOB_BASE}${path}`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });

  if (resp.status === 401) {
    // Invalidate stale creds, derive fresh via L1, and retry once
    invalidateCLOBCredentials();
    logger.warn(`[Polymarket] CLOB POST ${path} got 401 — retrying with fresh creds`);
    const freshCreds = await getCLOBCredentials();
    // Update owner field in body to match fresh creds (prevents "owner has to be the owner of the API KEY")
    const freshBody = typeof body === 'object' && body !== null && 'owner' in (body as Record<string, unknown>)
      ? { ...(body as Record<string, unknown>), owner: freshCreds.apiKey }
      : body;
    const freshBodyStr = JSON.stringify(freshBody);
    const freshHeaders = await getL2Headers(freshCreds, 'POST', path, freshBodyStr);
    const retry = await fetch(`${CLOB_BASE}${path}`, {
      method: 'POST',
      headers: freshHeaders,
      body: freshBodyStr,
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`[Polymarket] CLOB POST ${path} failed after retry (${retry.status}): ${text}`);
    }
    return retry.json() as Promise<T>;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[Polymarket] CLOB POST ${path} failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<T>;
}

async function clobDelete<T>(path: string): Promise<T> {
  const creds = await getCLOBCredentials();
  const headers = await getL2Headers(creds, 'DELETE', path);

  const resp = await fetch(`${CLOB_BASE}${path}`, { method: 'DELETE', headers });

  if (resp.status === 401) {
    invalidateCLOBCredentials();
    logger.warn(`[Polymarket] CLOB DELETE ${path} got 401 — retrying with fresh creds`);
    const freshCreds = await getCLOBCredentials();
    const freshHeaders = await getL2Headers(freshCreds, 'DELETE', path);
    const retry = await fetch(`${CLOB_BASE}${path}`, { method: 'DELETE', headers: freshHeaders });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`[Polymarket] CLOB DELETE ${path} failed after retry (${retry.status}): ${text}`);
    }
    return retry.json() as Promise<T>;
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
  liquidityNum?: number;
  category: string;
  // Gamma API returns flat arrays instead of nested tokens
  outcomes: string;          // JSON string e.g. '["Yes","No"]'
  outcomePrices: string;     // JSON string e.g. '["0.55","0.45"]'
  clobTokenIds: string;      // JSON string e.g. '["abc...","def..."]'
  // Legacy: some endpoints still return tokens
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
  minimum_tick_size?: string; // e.g. '0.001'
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
  const minLiq = options?.minLiquidityUsd ?? 5_000;
  const maxDays = options?.maxDaysToResolution ?? 90;
  const limit = options?.limit ?? 200;

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
        if (!m.conditionId) return false;
        // Require either legacy tokens array or Gamma flat fields
        const hasTokens = m.tokens?.length || m.clobTokenIds;
        if (!hasTokens) return false;
        if ((m.liquidity ?? m.liquidityNum ?? 0) < minLiq) return false;
        if (m.closed || !m.active) return false;

        // Time-to-resolution filter
        const endMs = new Date(m.endDate).getTime();
        const daysLeft = (endMs - now) / 86_400_000;
        if (daysLeft <= 0 || daysLeft > maxDays) return false;

        // Keyword filter — must match at least one crypto/tech term
        const text = m.question.toLowerCase();
        return CRYPTO_KEYWORDS.some((kw) => text.includes(kw));
      })
      .map<PolyMarket>((m) => {
        // Build tokens from legacy array or Gamma flat fields
        let tokens: PolyMarket['tokens'];
        if (m.tokens?.length) {
          tokens = m.tokens.map((t) => ({
            tokenId: t.token_id,
            outcome: t.outcome === 'Yes' ? 'Yes' : 'No',
            price: Number(t.price) || 0,
            winner: t.winner,
          }));
        } else {
          // Parse Gamma flat arrays
          const ids: string[] = JSON.parse(m.clobTokenIds || '[]');
          const outcomes: string[] = JSON.parse(m.outcomes || '[]');
          const prices: string[] = JSON.parse(m.outcomePrices || '[]');
          tokens = ids.map((id, i) => ({
            tokenId: id,
            outcome: outcomes[i] === 'Yes' ? 'Yes' : 'No',
            price: Number(prices[i]) || 0,
            winner: false,
          }));
        }

        return {
          conditionId: m.conditionId,
          question: m.question,
          endDate: m.endDate,
          active: m.active,
          closed: m.closed,
          volume: m.volume ?? 0,
          liquidity: m.liquidity ?? m.liquidityNum ?? 0,
          category: m.category ?? 'crypto',
          tokens,
          minimumTickSize: m.minimum_tick_size,
        };
      });

    logger.info(`[Polymarket] Found ${filtered.length} crypto markets (filtered from ${raw.length} total)`);
    return filtered;
  } catch (err) {
    logger.error('[Polymarket] fetchCryptoMarkets error:', err);
    return [];
  }
}

/**
 * Fetch a single market by condition ID.
 *
 * Primary: CLOB API `/markets/{conditionId}` — reliable, returns correct
 * tokens with live prices and matching conditionId every time.
 * Fallback: Gamma API `?slug=` lookup (requires slug, not always available).
 *
 * NOTE: Gamma `?condition_id=` is broken (returns unrelated market).
 */
export async function fetchMarket(conditionId: string): Promise<PolyMarket | null> {
  try {
    // ── Primary: CLOB API — reliable conditionId lookup with live prices ──
    const clobResp = await fetch(`${CLOB_BASE}/markets/${conditionId}`);
    if (clobResp.ok) {
      const c = await clobResp.json() as any;
      if (c && (c.condition_id === conditionId || c.conditionId === conditionId) && c.tokens?.length) {
        const tokens: PolyMarket['tokens'] = c.tokens.map((t: any) => ({
          tokenId: t.token_id,
          outcome: t.outcome === 'Yes' ? 'Yes' : 'No',
          price: Number(t.price) || 0,
          winner: t.winner ?? false,
        }));

        return {
          conditionId: c.condition_id ?? c.conditionId,
          question: c.question ?? c.market_slug ?? '',
          endDate: c.end_date_iso ?? c.endDate ?? '',
          active: c.active ?? true,
          closed: c.closed ?? false,
          volume: c.volume ?? 0,
          liquidity: c.liquidity ?? 0,
          category: 'crypto',
          tokens,
          minimumTickSize: c.minimum_tick_size ?? c.minimumTickSize,
        };
      }
    }

    // ── Fallback: Gamma list with client-side conditionId match ──
    // condition_id query param is unreliable so we fetch a larger set and filter
    const gammaResp = await fetch(`${GAMMA_BASE}/markets?active=true&closed=false&limit=100&order=volume&ascending=false`);
    if (gammaResp.ok) {
      const arr = (await gammaResp.json()) as any[];
      const m = arr.find((item: any) => item.conditionId === conditionId);
      if (m) {
        let tokens: PolyMarket['tokens'];
        if (m.tokens?.length) {
          tokens = m.tokens.map((t: any) => ({
            tokenId: t.token_id,
            outcome: t.outcome === 'Yes' ? 'Yes' : 'No',
            price: Number(t.price) || 0,
            winner: t.winner ?? false,
          }));
        } else {
          const ids: string[] = JSON.parse(m.clobTokenIds || '[]');
          const outcomes: string[] = JSON.parse(m.outcomes || '[]');
          const prices: string[] = JSON.parse(m.outcomePrices || '[]');
          tokens = ids.map((id: string, i: number) => ({
            tokenId: id,
            outcome: outcomes[i] === 'Yes' ? 'Yes' : 'No',
            price: Number(prices[i]) || 0,
            winner: false,
          }));
        }

        return {
          conditionId: m.conditionId,
          question: m.question,
          endDate: m.endDate,
          active: m.active,
          closed: m.closed,
          volume: m.volume ?? 0,
          liquidity: m.liquidity ?? m.liquidityNum ?? 0,
          category: m.category ?? 'crypto',
          tokens,
          minimumTickSize: m.minimum_tick_size,
        };
      }
    }

    logger.warn(`[Polymarket] fetchMarket: no result for conditionId=${conditionId.slice(0, 20)}…`);
    return null;
  } catch (err) {
    logger.error(`[Polymarket] fetchMarket error:`, err);
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
 * Approximate standard normal CDF: P(Z ≤ x)
 * Abramowitz & Stegun rational approximation, max error ~7.5e-8
 */
function approximateNormalCDF(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Estimate the probability of the YES outcome for a given market.
 *
 * For price-target questions (BTC/ETH/SOL) we fetch live prices from Pyth
 * and use a volatility-adjusted normal CDF to compute P(reach target).
 * For other market types we fall back to heuristic/sentiment nudges.
 */
export async function estimateProbability(
  market: PolyMarket,
  scoutContext?: {
    cryptoBullish?: boolean;   // Scout's overall crypto sentiment
    btcAbove?: number;         // BTC price estimate at resolution
    relevantNarratives?: string[];
  },
): Promise<{ prob: number; confidence: number; rationale: string }> {
  const question = market.question.toLowerCase();
  const yesToken = market.tokens.find((t) => t.outcome === 'Yes');
  const marketPrice = yesToken?.price ?? 0.5;
  const bullish = scoutContext?.cryptoBullish;

  // Fetch live prices for price-target math
  const priceMap = await getPrices(['SOL/USD', 'ETH/USD', 'BTC/USD']).catch(() => new Map());
  const liveSOL = priceMap.get('SOL/USD')?.price ?? null;
  const liveETH = priceMap.get('ETH/USD')?.price ?? null;
  const liveBTC = priceMap.get('BTC/USD')?.price ?? null;

  // ── 1. BTC price milestone ──
  const btcPriceMatch = question.match(
    /(?:btc|bitcoin).*(?:above|reach|exceed|hit|surpass|break).*?\$?([\d,]+)\s*k?/
  );
  if (btcPriceMatch && liveBTC !== null) {
    const targetRaw = btcPriceMatch[1].replace(',', '');
    const target = Number(targetRaw) * (btcPriceMatch[0].includes('k') ? 1000 : 1);
    if (target > 0) {
      const daysLeft = Math.max(0, (new Date(market.endDate).getTime() - Date.now()) / 86_400_000);
      const dailyVol = 0.03;
      const periodVol = dailyVol * Math.sqrt(Math.max(daysLeft, 0.5));
      const distancePct = (target - liveBTC) / liveBTC;
      const z = distancePct / periodVol;
      const prob = approximateNormalCDF(-z);
      const confidence = daysLeft < 1 ? 0.75 : daysLeft < 7 ? 0.65 : 0.55;
      return {
        prob: Math.max(0.02, Math.min(0.98, prob)),
        confidence,
        rationale: `BTC live=$${liveBTC.toFixed(0)} target=$${target.toLocaleString()} dist=${(distancePct * 100).toFixed(1)}% vol=${(periodVol * 100).toFixed(1)}% over ${daysLeft.toFixed(1)}d`,
      };
    }
  }

  // ── 2. ETH/SOL/alt price milestone ──
  const cryptoPriceMatch = question.match(
    /(?:eth(?:ereum)?|sol(?:ana)?|bnb|avax|xrp|ada|dot|matic|near|sui|aptos).*(?:above|reach|exceed|hit|break).*?\$?([\d,.]+)/
  );
  if (cryptoPriceMatch) {
    const ticker = question.match(/\b(eth(?:ereum)?|sol(?:ana)?|bnb|avax|xrp)\b/)?.[1] ?? '';
    const isEth = /eth/.test(ticker);
    const isSol = /sol/.test(ticker);
    const livePrice = isEth ? liveETH : isSol ? liveSOL : null;

    if (livePrice !== null) {
      const targetRaw = cryptoPriceMatch[1].replace(/,/g, '');
      const target = Number(targetRaw);
      if (target > 0) {
        const daysLeft = Math.max(0, (new Date(market.endDate).getTime() - Date.now()) / 86_400_000);
        const dailyVol = isEth ? 0.04 : isSol ? 0.05 : 0.045;
        const periodVol = dailyVol * Math.sqrt(Math.max(daysLeft, 0.5));
        const distancePct = (target - livePrice) / livePrice;
        const z = distancePct / periodVol;
        const prob = approximateNormalCDF(-z);
        const confidence = daysLeft < 1 ? 0.72 : daysLeft < 7 ? 0.62 : 0.50;
        return {
          prob: Math.max(0.02, Math.min(0.98, prob)),
          confidence,
          rationale: `${ticker.toUpperCase()} live=$${livePrice.toFixed(2)} target=$${target} dist=${(distancePct * 100).toFixed(1)}% vol=${(periodVol * 100).toFixed(1)}% over ${daysLeft.toFixed(1)}d`,
        };
      }
    }
    // Fallback if no live price: use scout sentiment but with low confidence
    if (bullish !== undefined) {
      return { prob: bullish ? 0.52 : 0.48, confidence: 0.3, rationale: 'Crypto price target (no live price, sentiment only)' };
    }
  }

  // ── 3. ETF approval / launch ──
  if (question.match(/etf.*(?:approv|launch|list|trade)|(?:approv|launch).*etf/)) {
    const prob = bullish ? 0.65 : 0.5;
    return { prob, confidence: 0.45, rationale: 'ETF approval heuristic' };
  }

  // ── 4. SEC / CFTC enforcement / lawsuit ──
  if (question.match(/\bsec\b|cftc|lawsuit|sue|fine|enforcement|settle|penalty|indic/)) {
    const prob = bullish ? 0.4 : 0.6;
    return { prob, confidence: 0.35, rationale: 'Regulatory enforcement heuristic' };
  }

  // ── 5. Fed / monetary policy ──
  if (question.match(/fed(?:eral)?.*(?:cut|hike|rate|pause)|interest.*rate|fomc|powell/)) {
    // Rate cuts = bullish for risk assets → higher prob of "yes" if market expects cuts
    const prob = bullish ? 0.6 : 0.45;
    return { prob, confidence: 0.4, rationale: 'Fed/monetary policy heuristic' };
  }

  // ── 6. Recession / macro downturn ──
  if (question.match(/recession|downturn|bear.*market|crash|depression|gdp.*contract/)) {
    const prob = bullish ? 0.35 : 0.6;
    return { prob, confidence: 0.4, rationale: 'Recession/macro heuristic' };
  }

  // ── 7. Inflation / CPI ──
  if (question.match(/inflation|cpi.*(?:above|below|reach)|consumer.*price/)) {
    const prob = 0.52; // Slight lean toward "inflation persists" — base rate
    return { prob, confidence: 0.35, rationale: 'Inflation/CPI base rate' };
  }

  // ── 8. Project launch / mainnet / upgrade / merge ──
  if (question.match(/launch|mainnet|upgrade|ship|deploy|release|fork|merge|hardfork/)) {
    const prob = 0.58;
    return { prob, confidence: 0.4, rationale: 'Project launch/upgrade base rate' };
  }

  // ── 9. Adoption / TVL / users / milestone ──
  if (question.match(/(?:users|tvl|volume|market.?cap|mcap|adoption|address|wallet).*(?:reach|exceed|above|surpass|break)/)) {
    const prob = bullish ? 0.58 : 0.42;
    return { prob, confidence: 0.35, rationale: 'Adoption milestone heuristic' };
  }

  // ── 10. AI / tech sector ──
  if (question.match(/\bai\b|artificial.intell|openai|nvidia|google.*ai|microsoft.*ai|gpu|semiconductor|chatgpt|deepseek|anthropic|agi/)) {
    const prob = 0.6;
    return { prob, confidence: 0.4, rationale: 'AI/tech sector growth heuristic' };
  }

  // ── 11. Partnership / integration / listing ──
  if (question.match(/partner|integrat|listing|list.*(?:coinbase|binance|kraken)|exchang.*(?:add|list)/)) {
    const prob = 0.52;
    return { prob, confidence: 0.35, rationale: 'Partnership/listing base rate' };
  }

  // ── 12. Airdrop / token launch ──
  if (question.match(/airdrop|token.*(?:launch|distribute|drop)|tge|ido|ico/)) {
    const prob = 0.6; // Announced airdrops usually happen
    return { prob, confidence: 0.4, rationale: 'Airdrop/TGE usually delivered' };
  }

  // ── 13. Stablecoin depeg / bank risk ──
  if (question.match(/depeg|stablecoin.*(?:lose|below|fail)|usdt.*(?:crash|collapse)|bank.*(?:fail|run|collapse)/)) {
    const prob = 0.2; // Depegs/failures are rare
    return { prob, confidence: 0.45, rationale: 'Stablecoin/bank failure is rare (base rate ~20%)' };
  }

  // ── 14. Hack / exploit ──
  if (question.match(/hack|exploit|breach|stolen|drain|rug.*pull/)) {
    // Will X get hacked? Lean no — most projects don't get hacked in any given window
    const prob = 0.25;
    return { prob, confidence: 0.4, rationale: 'Hack/exploit base rate (rare in any window)' };
  }

  // ── 15. Election / political outcome → market impact ──
  if (question.match(/trump|biden|election|congress|senate|house.*(?:pass|vote|bill)|presiden/)) {
    // Political questions: slight mean-reversion (extreme prices overshoot)
    const prob = marketPrice > 0.7 ? marketPrice - 0.08 : marketPrice < 0.3 ? marketPrice + 0.08 : marketPrice;
    return { prob, confidence: 0.35, rationale: 'Political: mean-reversion on extreme prices' };
  }

  // ── 16. Tariff / trade war / sanctions ──
  if (question.match(/tariff|trade.*war|sanction|embargo|import.*(?:tax|duty)/)) {
    const prob = bullish ? 0.4 : 0.6; // Tariffs = bearish for risk assets
    return { prob, confidence: 0.35, rationale: 'Tariff/trade war heuristic' };
  }

  // ── 17. DeFi-specific (yield, TVL, protocol) ──
  if (question.match(/defi|yield|liquidity.*(?:crisis|crunch)|protocol.*(?:fail|close|shut)/)) {
    const prob = bullish ? 0.55 : 0.45;
    return { prob, confidence: 0.35, rationale: 'DeFi sector heuristic' };
  }

  // ── 18. Mining / hashrate / energy ──
  if (question.match(/mining|hashrate|hash.*rate|halving|miner|pow|proof.*work/)) {
    const prob = 0.55; // Mining metrics usually grow
    return { prob, confidence: 0.35, rationale: 'Mining/hashrate growth base rate' };
  }

  // ── 19. CBDC / digital currency ──
  if (question.match(/cbdc|digital.*(?:dollar|yuan|euro|currency)|central.*bank.*digital/)) {
    const prob = 0.5;
    return { prob, confidence: 0.3, rationale: 'CBDC uncertain — near fair value' };
  }

  // ── 20. Stock market / index milestones ──
  if (question.match(/nasdaq|s&p|sp500|dow.*jones|stock.*(?:market|index).*(?:reach|above|hit|break|all.time)/)) {
    const prob = bullish ? 0.58 : 0.42;
    return { prob, confidence: 0.35, rationale: 'Stock index milestone heuristic' };
  }

  // ── 21. Extreme market price mean-reversion ──
  // Markets priced >85% or <15% tend to be overconfident on Polymarket
  if (marketPrice > 0.85) {
    return { prob: marketPrice - 0.07, confidence: 0.35, rationale: 'Mean-reversion: market >85% often overconfident' };
  }
  if (marketPrice < 0.15) {
    return { prob: marketPrice + 0.07, confidence: 0.35, rationale: 'Mean-reversion: market <15% often overconfident' };
  }

  // ── 22. Geopolitics / war / conflict ──
  if (question.match(/war|conflict|invad|invasion|ceasefire|peace.*(?:deal|agree)|nuclear|missile/)) {
    const prob = question.match(/ceasefire|peace/) ? 0.35 : 0.55;
    return { prob, confidence: 0.3, rationale: 'Geopolitical status-quo bias' };
  }

  // ── 23. "Will [company] do X?" — corporate actions ──
  if (question.match(/(?:apple|google|meta|amazon|tesla|microsoft|nvidia).*(?:buy|acquir|merge|split|dividen|layoff|ipo)/)) {
    const prob = 0.4;
    return { prob, confidence: 0.35, rationale: 'Corporate action base rate (specific events rare)' };
  }

  // ── 24. Supply / burn / emission / halving dynamics ──
  if (question.match(/supply.*(?:decrease|burn|deflat)|burn.*(?:rate|token)|halving|emission.*(?:cut|reduce)/)) {
    const prob = bullish ? 0.6 : 0.5;
    return { prob, confidence: 0.35, rationale: 'Supply-side dynamics heuristic' };
  }

  // ── 25. Exchange-specific (Coinbase/Binance/Kraken events) ──
  if (question.match(/coinbase|binance|kraken|okx|bybit|bitfinex/)) {
    if (question.match(/delist|remove|shut|close|suspend/)) {
      const prob = 0.3; // Delistings are rarer than not
      return { prob, confidence: 0.35, rationale: 'Exchange delisting base rate (rare)' };
    }
    if (question.match(/list|add|support|launch/)) {
      const prob = 0.55; // Listings are more common
      return { prob, confidence: 0.35, rationale: 'Exchange listing base rate' };
    }
    const prob = 0.5;
    return { prob, confidence: 0.3, rationale: 'Exchange event — near fair value' };
  }

  // ── 26. Gaming / metaverse / NFT adoption ──
  if (question.match(/gaming|metaverse|play.*earn|p2e|virtual.*world|nft.*(?:volume|sale|floor)/)) {
    const prob = bullish ? 0.55 : 0.45;
    return { prob, confidence: 0.3, rationale: 'Gaming/metaverse adoption heuristic' };
  }

  // ── 27. Layer-2 / scaling ──
  if (question.match(/layer.?2|l2|rollup|zk.*(?:sync|proof|rollup)|optimistic.*rollup|scaling/)) {
    const prob = 0.6; // L2 adoption is generally expanding
    return { prob, confidence: 0.35, rationale: 'L2/scaling growth trend' };
  }

  // ── 28. RWA / tokenization ──
  if (question.match(/rwa|real.*world.*asset|tokeniz|securit.*token|ondo|blackrock.*(?:fund|token)/)) {
    const prob = 0.58; // RWA is a growing trend
    return { prob, confidence: 0.35, rationale: 'RWA/tokenization growth trend' };
  }

  // ── 29. Meme coins / viral tokens ──
  if (question.match(/meme.*coin|doge|shib|pepe|bonk|wif|(?:will|can).*(?:10x|100x|pump)/)) {
    // Meme coin specific targets are rarely hit
    const prob = question.match(/(?:10x|100x)/) ? 0.15 : 0.5;
    return { prob, confidence: 0.35, rationale: 'Meme coin heuristic (specific targets rarely hit)' };
  }

  // ── 30. Bridge / cross-chain / interop ──
  if (question.match(/bridge|cross.?chain|interop|wormhole|layerzero|chainlink.*ccip/)) {
    const prob = 0.55;
    return { prob, confidence: 0.3, rationale: 'Cross-chain/bridge adoption trend' };
  }

  // ── 31. Stablecoin dominance / market share ──
  if (question.match(/(?:usdc|usdt|dai|frax).*(?:dominan|market.*share|flipp|overtake|surpass)/)) {
    // Status quo tends to persist in stablecoin rankings
    const prob = 0.35; // Challenger rarely overtakes incumbent
    return { prob, confidence: 0.35, rationale: 'Stablecoin dominance: status quo bias' };
  }

  // ── 32. Institutional adoption (BlackRock, Fidelity, etc.) ──
  if (question.match(/institutional|blackrock|fidelity|vanguard|grayscale|state.*street|(?:pension|endowment).*(?:crypto|bitcoin)/)) {
    const prob = bullish ? 0.6 : 0.45;
    return { prob, confidence: 0.4, rationale: 'Institutional adoption heuristic' };
  }

  // ── 33. Specific date questions — time decay intelligence ──
  // Markets resolving within 7 days: current price is more informed, mean-revert less
  // Markets resolving within 30 days: moderate confidence in nudge
  {
    const daysLeft = (new Date(market.endDate).getTime() - Date.now()) / 86_400_000;
    if (daysLeft > 0 && daysLeft <= 7) {
      // Near-expiry: market is well-priced but extremes (>80/<20) still overshoot
      if (marketPrice > 0.80) {
        return { prob: marketPrice - 0.05, confidence: 0.38, rationale: `Near-expiry (${Math.ceil(daysLeft)}d): >80% still overshoots` };
      }
      if (marketPrice < 0.20) {
        return { prob: marketPrice + 0.05, confidence: 0.38, rationale: `Near-expiry (${Math.ceil(daysLeft)}d): <20% still overshoots` };
      }
      // Non-extreme near-expiry: mid-range prices are well-calibrated, small nudge
      if (bullish !== undefined) {
        const nudge = bullish ? 0.04 : -0.04;
        const prob = Math.max(0.05, Math.min(0.95, marketPrice + nudge));
        return { prob, confidence: 0.32, rationale: `Near-expiry sentiment (${Math.ceil(daysLeft)}d, ${bullish ? 'bull' : 'bear'})` };
      }
    }
  }

  // ── 34. "Will X happen this year/month/week?" — timeframe heuristics ──
  if (question.match(/this.*(?:year|month|week)|by.*(?:end.*of|year|20\d{2})|before.*(?:20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)/)) {
    // Longer timeframes: more likely things happen, lean slight yes for positive events
    if (question.match(/crash|fail|collapse|depeg|hack/)) {
      const prob = 0.2; // Bad events are rare in any given window
      return { prob, confidence: 0.35, rationale: 'Negative event in timeframe: base rate low' };
    }
    const prob = bullish !== undefined ? (bullish ? 0.58 : 0.45) : 0.52;
    return { prob, confidence: 0.32, rationale: 'Timeframe question: slight lean toward "yes" for positive events' };
  }

  // ── 35. Energy / oil / commodities (move crypto indirectly) ──
  if (question.match(/oil|opec|energy.*(?:price|crisis)|natural.*gas|commodity|gold.*(?:above|reach|hit)/)) {
    const prob = 0.5;
    return { prob, confidence: 0.3, rationale: 'Commodity/energy: near fair value' };
  }

  // ── 36. Employment / jobs / unemployment ──
  if (question.match(/unemployment|jobs.*(?:report|data)|nonfarm|payroll|labor.*market/)) {
    const prob = 0.52; // Jobs reports tend to beat expectations slightly
    return { prob, confidence: 0.3, rationale: 'Employment report: slight beat bias' };
  }

  // ── 37. Protocol governance / DAO vote ──
  if (question.match(/(?:dao|governance|proposal|vote).*(?:pass|approve|reject)/) ||
      question.match(/(?:pass|approve|reject).*(?:proposal|vote)/)) {
    const prob = 0.6; // Most governance proposals that reach a vote tend to pass
    return { prob, confidence: 0.35, rationale: 'DAO governance: proposals that reach vote usually pass' };
  }

  // ── 38. Cross-asset correlation plays ──
  // "Will crypto rally if stocks rally?" type questions
  if (question.match(/correlat|if.*(?:stock|nasdaq|sp500).*(?:then|crypto|bitcoin)/) ||
      question.match(/crypto.*(?:follow|track|correlat).*(?:stock|nasdaq)/)) {
    const prob = 0.6; // Crypto–equity correlation has been high
    return { prob, confidence: 0.35, rationale: 'Cross-asset correlation: crypto tracks equities' };
  }

  // ── 39. Scout narrative signal (keyword match) ──
  if (scoutContext?.relevantNarratives?.length) {
    const matchedNarrative = scoutContext.relevantNarratives.find(
      (n) => question.includes(n.toLowerCase()),
    );
    if (matchedNarrative) {
      const prob = Math.min(0.85, marketPrice + 0.12);
      return { prob, confidence: 0.55, rationale: `Scout narrative: "${matchedNarrative}"` };
    }
  }

  // ── 40. General crypto/tech with scout sentiment (catch-all) ──
  // If we have scout sentiment and the market passed keyword filter, apply a nudge.
  // This ensures we always have SOME edge on crypto markets when Scout is live.
  if (bullish !== undefined) {
    const sentimentNudge = bullish ? 0.07 : -0.07;
    const prob = Math.max(0.05, Math.min(0.95, marketPrice + sentimentNudge));
    return { prob, confidence: 0.32, rationale: `Scout sentiment nudge (${bullish ? 'bullish' : 'bearish'})` };
  }

  // ── 41. No scout, but market is mid-range — slight contrarian ──
  // Without scout data, we can still profit from Polymarket's tendency to overprice
  // popular outcomes. Markets in 40-60% range: slight contrarian lean.
  if (marketPrice >= 0.40 && marketPrice <= 0.60) {
    // In the 40-60 zone, lean slightly toward NO (popular=overpriced)
    return { prob: marketPrice - 0.04, confidence: 0.3, rationale: 'No scout: slight contrarian on 40-60% market' };
  }

  // ── Fallback: truly no edge ──
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

    const { prob: ourProb, confidence, rationale } = await estimateProbability(market, scoutContext);

    // Log why each market was evaluated (debug visibility)
    logger.debug(
      `[Polymarket] "${market.question.slice(0, 60)}..." → prob=${ourProb.toFixed(2)} conf=${confidence.toFixed(2)} | ${rationale}`
    );

    // Check both YES and NO for edge
    for (const [token, side] of [[yesToken, 'YES'], [noToken, 'NO']] as const) {
      const effectiveOurProb = side === 'YES' ? ourProb : 1 - ourProb;
      const marketProb = token.price;
      const edge = effectiveOurProb - marketProb;

      if (edge < env.minEdge) continue;
      if (confidence < 0.45) continue; // Only act when we have meaningful confidence

      const { fraction, usdAmount } = kellySize(
        marketProb,
        effectiveOurProb,
        bankrollUsd,
        env.kellyFraction,
        env.minEdge,
      );

      if (usdAmount < 1) continue; // Min $1 bet (actual size capped to wallet balance in decisionEngine)

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
  negRisk?: boolean;         // true → use negRiskExchange
  feeRateBps?: number;       // market-specific fee rate (fetched from API)
  tickSize?: number;         // minimum tick size (default 0.01)
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

  let makerAmountRaw: number;
  let takerAmountRaw: number;

  // Safety: prevent division-by-zero → Infinity → BigInt parse failure
  if (!params.pricePerShare || params.pricePerShare <= 0) {
    throw new Error(`Invalid pricePerShare: ${params.pricePerShare}`);
  }

  // ── Price rounding to tick size (matches SDK ROUNDING_CONFIG) ──
  // The CLOB rejects orders whose implied price isn't on a tick boundary.
  // SDK rounds price BEFORE computing amounts so the ratio = exactly roundedPrice.
  const tickSize = params.tickSize ?? 0.01;
  const tickDecimals = Math.round(-Math.log10(tickSize));
  const roundedPrice = parseFloat((Math.round(params.pricePerShare / tickSize) * tickSize).toFixed(tickDecimals));
  if (roundedPrice < tickSize || roundedPrice > 1 - tickSize) {
    throw new Error(`Price ${params.pricePerShare} rounds to ${roundedPrice} which is outside valid range [${tickSize}, ${1 - tickSize}]`);
  }

  // ── Amount calculation per SDK getOrderRawAmounts ──
  // Start from token size (not USD) so derivedPrice = makerAmt/takerAmt = roundedPrice exactly.
  // SDK ROUNDING_CONFIG for tick 0.001: price=3dp, size=2dp, amount=5dp
  // SDK ROUNDING_CONFIG for tick 0.01:  price=2dp, size=2dp, amount=4dp
  const sizeDecimals = 2;
  const amountDecimals = tickDecimals + 2; // SDK pattern: amount = price + 2

  if (params.side === 0) {
    // BUY: maker spends USDC (makerAmount), gets tokens (takerAmount)
    const rawTokenSize = Math.floor((params.sizeUsdc / roundedPrice) * 10 ** sizeDecimals) / 10 ** sizeDecimals;
    let rawUsdcCost = rawTokenSize * roundedPrice;
    // Round USDC cost to amountDecimals (SDK roundUp then roundDown pattern)
    rawUsdcCost = parseFloat(rawUsdcCost.toFixed(amountDecimals));
    makerAmountRaw = Math.round(rawUsdcCost * 1e6);
    takerAmountRaw = Math.round(rawTokenSize * 1e6);
  } else {
    // SELL: maker has tokens (makerAmount), gets USDC (takerAmount)
    const rawTokenSize = Math.floor((params.sizeUsdc / roundedPrice) * 10 ** sizeDecimals) / 10 ** sizeDecimals;
    let rawUsdcProceeds = rawTokenSize * roundedPrice;
    rawUsdcProceeds = parseFloat(rawUsdcProceeds.toFixed(amountDecimals));
    makerAmountRaw = Math.round(rawTokenSize * 1e6);
    takerAmountRaw = Math.round(rawUsdcProceeds * 1e6);
  }

  // Salt must fit in Number.MAX_SAFE_INTEGER (2^53-1) since the API payload
  // sends it as a JSON number via parseInt(). Our old BigInt(Date.now())*1M overflowed.
  const salt = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const expiration = params.expirationSeconds ?? 0;
  const nonce = BigInt(0);
  const feeRateBps = BigInt(params.feeRateBps ?? 0);

  // Use negRiskExchange for neg-risk markets (per SDK config.ts)
  const exchangeAddr = params.negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
  // Domain name must match SDK's PROTOCOL_NAME exactly: 'Polymarket CTF Exchange'
  // (not 'CTFExchange' — that was causing "invalid signature" errors)
  const domain = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: exchangeAddr,
  };

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

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderStruct);

  return { ...orderStruct, signature };
}

// ============================================================================
// USDC Allowance Management
// ============================================================================

/** Track which exchange contracts have been approved this session */
const _approvedExchanges = new Set<string>();
/** Track which exchange contracts have CT (ConditionalTokens) isApprovedForAll this session */
const _approvedCTExchanges = new Set<string>();

/**
 * Ensure the wallet has all required approvals for the target exchange.
 *
 * Polymarket requires approvals on up to 3 contracts per exchange:
 *   1. USDC.e ERC-20 approve → Exchange contract
 *   2. ConditionalTokens ERC-1155 setApprovalForAll → Exchange contract
 *   3. (Neg-risk only) USDC.e approve + CT setApprovalForAll → NegRisk Adapter
 *
 * The NegRisk Adapter (`0xd91E...5296`) is a separate contract that routes
 * USDC.e deposits for neg-risk (multi-outcome) markets.  Without it, neg-risk
 * orders fail with "not enough balance / allowance" even when the Exchange
 * itself is approved.
 *
 * Auto-approves max uint256 / true on first call per contract per session.
 */
async function ensureAllowance(negRisk: boolean): Promise<void> {
  const exchangeAddr = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
  const label = negRisk ? 'NegRisk Exchange' : 'CTF Exchange';

  // For neg-risk markets we also need the NegRisk Adapter approved
  const targets = [exchangeAddr];
  const labels = [label];
  if (negRisk) {
    targets.push(NEG_RISK_ADAPTER);
    labels.push('NegRisk Adapter');
  }

  // Quick-check: skip entirely if all targets are already approved this session
  const allApproved = targets.every(t => _approvedExchanges.has(t) && _approvedCTExchanges.has(t));
  if (allApproved) return;

  try {
    const { wallet, ethers: eth } = await loadEthers();
    const env = getCFOEnv();
    const provider = new eth.JsonRpcProvider(env.polygonRpcUrl);
    const connectedWallet = wallet.connect(provider);

    const erc20 = new eth.Contract(USDC_POLYGON, [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ], connectedWallet);

    const ct = new eth.Contract(CONDITIONAL_TOKENS, [
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function setApprovalForAll(address operator, bool approved)',
    ], connectedWallet);

    for (let i = 0; i < targets.length; i++) {
      const addr = targets[i];
      const lbl = labels[i];

      // ── USDC.e ERC-20 allowance ──
      if (!_approvedExchanges.has(addr)) {
        const currentAllowance = await erc20.allowance(wallet.address, addr);
        if (currentAllowance > eth.parseUnits('1000000000', 6)) {
          _approvedExchanges.add(addr);
          logger.debug(`[Polymarket] ${lbl} already has sufficient USDC.e allowance`);
        } else {
          logger.info(`[Polymarket] Approving USDC.e for ${lbl} (${addr})...`);
          const tx = await erc20.approve(addr, eth.MaxUint256);
          logger.info(`[Polymarket] USDC.e approval tx: ${tx.hash} — waiting...`);
          await tx.wait(1);
          logger.info(`[Polymarket] USDC.e approved for ${lbl} ✓`);
          _approvedExchanges.add(addr);
        }
      }

      // ── ConditionalTokens ERC-1155 setApprovalForAll ──
      if (!_approvedCTExchanges.has(addr)) {
        const isApproved = await ct.isApprovedForAll(wallet.address, addr);
        if (isApproved) {
          _approvedCTExchanges.add(addr);
          logger.debug(`[Polymarket] ${lbl} already has ConditionalTokens approval`);
        } else {
          logger.info(`[Polymarket] Setting ConditionalTokens approval for ${lbl} (${addr})...`);
          const tx = await ct.setApprovalForAll(addr, true);
          logger.info(`[Polymarket] CT approval tx: ${tx.hash} — waiting...`);
          await tx.wait(1);
          logger.info(`[Polymarket] ConditionalTokens approved for ${lbl} ✓`);
          _approvedCTExchanges.add(addr);
        }
      }
    }
  } catch (err) {
    // Non-fatal: log warning but let the order attempt proceed (it will fail with clear error)
    logger.warn(`[Polymarket] Failed to ensure approvals for ${label}: ${(err as Error).message}`);
  }
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

  // Guard: refuse to place order with zero or invalid price
  if (!token.price || token.price <= 0 || token.price >= 1) {
    result.errorMessage = `Invalid token price: ${token.price} (must be 0 < price < 1)`;
    logger.error(`[Polymarket] ${result.errorMessage} for "${market.question}"`);
    return result;
  }

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
    // Fetch market-specific config (negRisk, feeRate) per SDK behavior
    let negRisk = false;
    let feeRateBps = 0;
    try {
      const nrResp = await clobGet<{ neg_risk: boolean }>(`/neg-risk?token_id=${token.tokenId}`);
      negRisk = nrResp?.neg_risk ?? false;
    } catch { /* default false */ }
    try {
      const feeResp = await clobGet<{ base_fee: number }>(`/fee-rate?token_id=${token.tokenId}`);
      feeRateBps = feeResp?.base_fee ?? 0;
    } catch { /* default 0 */ }

    // Ensure USDC.e is approved for the correct exchange contract
    await ensureAllowance(negRisk);

    const tickSize = parseFloat(market.minimumTickSize || '0.01');
    const signedOrder = await buildSignedOrder({
      tokenId: token.tokenId,
      side: 0, // BUY
      pricePerShare: token.price,
      sizeUsdc: sizeUsd,
      negRisk,
      feeRateBps,
      tickSize,
    });

    // Payload format must match SDK's orderToJson() exactly:
    //   owner = API key (NOT wallet address)
    //   salt  = number  (parseInt, not string)
    //   side  = "BUY"/"SELL" string (NOT numeric 0/1 from EIP-712)
    const creds = await getCLOBCredentials();
    const payload = {
      order: {
        ...signedOrder,
        salt: parseInt(signedOrder.salt, 10),
        side: 'BUY' as const,
      },
      owner: creds.apiKey,
      orderType: 'GTC' as const,
      deferExec: false,
    };

    logger.debug(
      `[Polymarket] Order payload: negRisk=${negRisk} tick=${tickSize} ` +
      `price=${token.price} maker=${signedOrder.makerAmount} taker=${signedOrder.takerAmount} ` +
      `fee=${feeRateBps} exchange=${negRisk ? 'NegRisk' : 'CTF'}`,
    );

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
 * Check order status.
 * Returns 'MATCHED' (filled), 'LIVE' (on book), 'CANCELLED', 'EXPIRED', or null if not found.
 */
export async function getOrderStatus(orderId: string): Promise<{
  status: 'MATCHED' | 'LIVE' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN';
  filledSize?: number;
  transactionHashes?: string[];
} | null> {
  try {
    const data = await clobGet<any>(`/data/order/${orderId}`, true);
    if (!data) return null;
    const status = (data.status ?? '').toUpperCase();
    return {
      status: ['MATCHED', 'LIVE', 'CANCELLED', 'EXPIRED'].includes(status) ? status : 'UNKNOWN',
      filledSize: data.size_matched ? parseFloat(data.size_matched) : undefined,
      transactionHashes: data.transactions_hashes ?? data.transactionsHashes ?? [],
    };
  } catch (err) {
    logger.warn(`[Polymarket] getOrderStatus(${orderId}) failed: ${(err as Error).message}`);
    return null;
  }
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
    const raw = await clobGet<Array<{ id: string }>>('/data/orders', true)
      .catch((err: Error) => {
        // clobGet throws plain Error with status in message — check message text
        if (err.message.includes('404') || err.message.includes('405')) {
          logger.warn(`[Polymarket] /data/orders error (${err.message}) — assuming no open orders`);
          return [] as Array<{ id: string }>;
        }
        throw err;
      });
    const orders = Array.isArray(raw) ? raw : [];
    let cancelled = 0;
    for (const o of orders) {
      if (o?.id && await cancelOrder(o.id)) cancelled++;
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

/** Polymarket Data API — public, no auth required, returns live positions */
const DATA_API_BASE = 'https://data-api.polymarket.com';

/**
 * Raw shape returned by data-api.polymarket.com/positions?user=<addr>
 */
interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

/**
 * Fetch all current Polymarket positions for the connected wallet.
 *
 * Uses the Data API (data-api.polymarket.com) instead of the CLOB
 * /data/positions endpoint which was deprecated and returns 404.
 * The Data API is public (no auth needed) and returns enriched position
 * data including title, current value, PnL, and redeemability.
 */
export async function fetchPositions(): Promise<PolyPosition[]> {
  try {
    const { wallet } = await loadEthers();

    const resp = await fetch(
      `${DATA_API_BASE}/positions?user=${wallet.address}`,
    );

    if (!resp.ok) {
      const text = await resp.text();
      logger.warn(`[Polymarket] Data API /positions returned ${resp.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const raw: DataApiPosition[] = await resp.json();

    const positions: PolyPosition[] = [];

    for (const p of raw) {
      const size = Number(p.size);
      if (size <= 0) continue;

      const avgPrice = Number(p.avgPrice ?? 0);
      const curPrice = Number(p.curPrice ?? 0);
      const currentValueUsd = Number(p.currentValue ?? 0);
      const costBasisUsd = Number(p.initialValue ?? 0);

      positions.push({
        conditionId: p.conditionId,
        question: p.title ?? p.conditionId.slice(0, 20),
        tokenId: p.asset,
        outcome: p.outcome,
        size,
        entryPrice: avgPrice,
        currentPrice: curPrice,
        costBasisUsd,
        currentValueUsd,
        unrealizedPnlUsd: Number(p.cashPnl ?? (currentValueUsd - costBasisUsd)),
        openedAt: new Date().toISOString(),
      });
    }

    logger.info(`[Polymarket] ${positions.length} active positions (${positions.filter(p => p.currentValueUsd > 0).length} live, ${positions.filter(p => p.currentValueUsd === 0).length} expired/redeemable)`);
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

    // Fetch market-specific config (negRisk, feeRate, tickSize) per SDK behavior
    let negRisk = false;
    let feeRateBps = 0;
    let tickSize = 0.01;
    try {
      const nrResp = await clobGet<{ neg_risk: boolean }>(`/neg-risk?token_id=${position.tokenId}`);
      negRisk = nrResp?.neg_risk ?? false;
    } catch { /* default false */ }
    try {
      const feeResp = await clobGet<{ base_fee: number }>(`/fee-rate?token_id=${position.tokenId}`);
      feeRateBps = feeResp?.base_fee ?? 0;
    } catch { /* default 0 */ }
    try {
      const mktResp = await clobGet<{ minimum_tick_size?: string }>(`/markets/${position.conditionId}`);
      tickSize = parseFloat(mktResp?.minimum_tick_size || '0.01');
    } catch { /* default 0.01 */ }

    // Ensure USDC.e is approved for the correct exchange contract
    await ensureAllowance(negRisk);

    const signedOrder = await buildSignedOrder({
      tokenId: position.tokenId,
      side: 1, // SELL
      pricePerShare: sellPrice,
      sizeUsdc: sizeUsd,
      negRisk,
      feeRateBps,
      tickSize,
    });

    // Payload format must match SDK's orderToJson() exactly
    const creds = await getCLOBCredentials();
    const payload = {
      order: {
        ...signedOrder,
        salt: parseInt(signedOrder.salt, 10),
        side: 'SELL' as const,
      },
      owner: creds.apiKey,
      orderType: 'GTC' as const,
      deferExec: false,
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
