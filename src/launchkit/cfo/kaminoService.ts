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
const MSOL_MINT    = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const BSOL_MINT    = 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1';
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

/**
 * KaminoAsset: now a plain string — any symbol the registry returns is valid.
 * Kept as a type alias for readability; no more hard-coded union.
 */
export type KaminoAsset = string;

/** Subset of KaminoAsset that are liquid staking tokens (correlated to SOL). */
export type LstAsset = string;

// ── Dynamic Reserve Registry ────────────────────────────────────────────────
// Fetches ALL reserves from the Kamino API so we never hard-code pairs.

export interface KaminoReserveInfo {
  symbol: string;
  mint: string;
  reserveAddress: string;
  decimals: number;
  liqLtv: number;          // liquidation LTV from API
  safeBorrowLtv: number;   // conservative cap (liqLtv * 0.82)
  supplyApy: number;
  borrowApy: number;
  isLst: boolean;
  baseStakingYield: number; // seed from LST_YIELD_MAP or 0
}

/** Well-known mint addresses for reverse lookup. */
const WELL_KNOWN_MINTS: Record<string, string> = {
  [JITOSOL_MINT]: 'JitoSOL',
  [MSOL_MINT]:    'mSOL',
  [BSOL_MINT]:    'bSOL',
  [JUP_MINT]:     'JUP',
  [USDC_MINT]:    'USDC',
  [USDT_MINT]:    'USDT',
  [SOL_MINT]:     'SOL',
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v': 'jupSOL',
  'CgNTsyMnhbxMKLFCboo5a6HMRkMDqJnQBWcdfXe5JwG':  'stkeSOL',
  'fpSoL8EJ7UA5yJxFKWk1MFiNi9dXeFiq63v68n5AAIQ':   'fwdSOL',
  'EjmyN6qEC1Tf1JxiG1ae7HTCdNGGykPmzYGJcjud5G7J': 'PYUSD',
  '6DNSN2BJsaPFdDBBYZieXS9cTJdimAaot3xrmFG5HPdn': 'cbBTC',
};

/** Well-known decimals for tokens (API doesn't return this). */
const WELL_KNOWN_DECIMALS: Record<string, number> = {
  SOL: 9, JitoSOL: 9, mSOL: 9, bSOL: 9, jupSOL: 9, stkeSOL: 9, fwdSOL: 9,
  hSOL: 9, dSOL: 9, vSOL: 9, pSOL: 9, bonkSOL: 9, bbSOL: 9, picoSOL: 9,
  cgntSOL: 9, nxSOL: 9, adraSOL: 9, hubSOL: 9, strongSOL: 9, laineSOL: 9,
  lanternSOL: 9, cdcSOL: 9, bnSOL: 9, dfdvSOL: 9, STSOL: 9, jSOL: 9,
  USDC: 6, USDT: 6, PYUSD: 6, EURC: 6, USDH: 6, UXD: 6, FDUSD: 6,
  CASH: 6, USD1: 6, USDS: 6, USDG: 6,
  JUP: 6, JTO: 6, STEP: 6, xSTEP: 6,
  WBTC: 8, cbBTC: 8, tBTC: 8, fBTC: 8, xBTC: 8,
  ETH: 8, wstETH: 8,
  JLP: 6, CHAI: 6,
};

/** Canonical symbol casing for API normalization. */
const SYMBOL_NORMALISE: Record<string, string> = {
  JITOSOL: 'JitoSOL', MSOL: 'mSOL', BSOL: 'bSOL', JUPSOL: 'jupSOL',
  STKESOL: 'stkeSOL', FWDSOL: 'fwdSOL', INF: 'INF',
  HSOL: 'hSOL', DSOL: 'dSOL', VSOL: 'vSOL', PSOL: 'pSOL',
  PICOSOL: 'picoSOL', BBSOL: 'bbSOL', BNSOL: 'bnSOL', CGNTSOL: 'cgntSOL',
  BONKSOL: 'bonkSOL', NXSOL: 'nxSOL', ADRASOL: 'adraSOL', HUBSOL: 'hubSOL',
  STRONGSOL: 'strongSOL', LAINESOL: 'laineSOL', LANTERNSOL: 'lanternSOL',
  CDCSOL: 'cdcSOL', DFDVSOL: 'dfdvSOL', JSOL: 'jSOL',
};

/** Base staking yield seeds for LSTs (updated periodically). */
const LST_YIELD_MAP: Record<string, number> = {
  JitoSOL: 0.08, mSOL: 0.075, bSOL: 0.07, jupSOL: 0.075,
  stkeSOL: 0.07, fwdSOL: 0.06, INF: 0.07,
  hSOL: 0.07, dSOL: 0.07, vSOL: 0.07, pSOL: 0.07, picoSOL: 0.07,
  hubSOL: 0.07, bbSOL: 0.07, bonkSOL: 0.07, cgntSOL: 0.07,
  strongSOL: 0.07, laineSOL: 0.07, lanternSOL: 0.07,
  adraSOL: 0.07, nxSOL: 0.07, cdcSOL: 0.07, dfdvSOL: 0.07,
  bnSOL: 0.07, jSOL: 0.07,
};

const KNOWN_LST_SYMBOLS = new Set(Object.keys(LST_YIELD_MAP));

let _registryCache: KaminoReserveInfo[] | null = null;
let _registryCacheTime = 0;
const REGISTRY_TTL_MS = 10 * 60 * 1000; // 10 min

// Backoff state for registry fetch failures
let _registryFailCount = 0;
let _registryLastFailTime = 0;
const REGISTRY_BACKOFF_BASE_MS = 30_000; // 30s initial backoff
const REGISTRY_MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 min max backoff

/**
 * Fetch ALL reserves from the Kamino API. Cached for 10 min.
 * Returns enriched KaminoReserveInfo[] with all fields populated.
 */
export async function getReserveRegistry(forceRefresh = false): Promise<KaminoReserveInfo[]> {
  if (!forceRefresh && _registryCache && Date.now() - _registryCacheTime < REGISTRY_TTL_MS) {
    return _registryCache;
  }

  // Exponential backoff: skip fetch if we recently failed and still within cooldown
  if (_registryFailCount > 0 && !forceRefresh) {
    const backoffMs = Math.min(REGISTRY_BACKOFF_BASE_MS * Math.pow(2, _registryFailCount - 1), REGISTRY_MAX_BACKOFF_MS);
    const elapsed = Date.now() - _registryLastFailTime;
    if (elapsed < backoffMs) {
      if (_registryCache) return _registryCache;
      return _buildSeedRegistry();
    }
  }

  try {
    const resp = await fetch(
      `https://api.kamino.finance/kamino-market/${KAMINO_MAIN_MARKET_ADDR}/reserves/metrics`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) throw new Error(`Kamino API ${resp.status}`);
    const data = await resp.json() as any[];

    _registryCache = data.map((r: any) => {
      const rawSymbol: string = r.liquidityToken ?? '';
      const symbol = SYMBOL_NORMALISE[rawSymbol.toUpperCase()] ?? rawSymbol;
      const mint: string = r.liquidityTokenMint ?? '';
      const reserveAddress: string = r.reserve ?? '';
      // API doesn't return decimals — infer from well-known tokens
      const decimals: number = WELL_KNOWN_DECIMALS[symbol] ?? WELL_KNOWN_DECIMALS[rawSymbol] ?? 6;
      const liqLtv = Number(r.maxLtv ?? 0.75);
      const safeBorrowLtv = Math.round(liqLtv * 82) / 100;
      const supplyApy = Number(r.supplyApy ?? 0);
      const borrowApy = Number(r.borrowApy ?? 0);
      const isLst = KNOWN_LST_SYMBOLS.has(symbol);
      const baseStakingYield = LST_YIELD_MAP[symbol] ?? 0;

      // Enrich WELL_KNOWN_MINTS if we discover new mints
      if (mint && !(mint in WELL_KNOWN_MINTS)) {
        WELL_KNOWN_MINTS[mint] = symbol;
      }

      return { symbol, mint, reserveAddress, decimals, liqLtv, safeBorrowLtv, supplyApy, borrowApy, isLst, baseStakingYield };
    });

    _registryCacheTime = Date.now();
    _registryFailCount = 0; // Reset backoff on success
    logger.debug(`[Kamino] Registry refreshed: ${_registryCache.length} reserves`);
    return _registryCache;
  } catch (err) {
    _registryFailCount++;
    _registryLastFailTime = Date.now();
    const nextBackoff = Math.min(REGISTRY_BACKOFF_BASE_MS * Math.pow(2, _registryFailCount - 1), REGISTRY_MAX_BACKOFF_MS) / 1000;
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Kamino] Registry fetch failed (attempt #${_registryFailCount}, next retry in ${nextBackoff}s): ${errMsg}`);
    if (_registryCache) return _registryCache;
    return _buildSeedRegistry();
  }
}

function _buildSeedRegistry(): KaminoReserveInfo[] {
  // Reserve addresses and LTVs from Kamino Main Market API (2025-02)
  const seeds: Array<[string, string, string, number, number]> = [
    ['USDC', USDC_MINT, 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59', 6, 0.80],
    ['USDT', USDT_MINT, 'H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S', 6, 0.80],
    ['SOL',  SOL_MINT,  'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',  9, 0.74],
    ['JitoSOL', JITOSOL_MINT, 'EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW', 9, 0.59],
    ['mSOL', MSOL_MINT, 'FBSyPnxtHKLBZ4UeeUyAnbtFuAmTHLtso9YtsqRDRWpM', 9, 0.59],
    ['bSOL', BSOL_MINT, 'H9vmCVd77NHkpLz2WqBAHSMhEMD7kSNfaPdmu2jiPctF', 9, 0.45],
    ['jupSOL', 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', 'DGQZWCY17gSdHHkhXDFMitr8rBHnxZPHCbFhLXNqg6bP', 9, 0.59],
    ['JUP',  JUP_MINT,  '4AFAGAm5G8fkcKy7QerL88E7BiSE22ZRbvJzvaKjayor',  6, 0.00],
  ];
  return seeds.map(([symbol, mint, reserveAddress, decimals, liqLtv]) => ({
    symbol, mint, reserveAddress, decimals, liqLtv,
    safeBorrowLtv: Math.round(liqLtv * 82) / 100,
    supplyApy: 0.06, borrowApy: 0.10,
    isLst: KNOWN_LST_SYMBOLS.has(symbol),
    baseStakingYield: LST_YIELD_MAP[symbol] ?? 0,
  }));
}

// ── Convenience lookups ─────────────────────────────────────────────────────

/** Get a single reserve by symbol (e.g. 'JitoSOL', 'USDC'). */
export async function getReserve(symbol: string): Promise<KaminoReserveInfo | undefined> {
  const registry = await getReserveRegistry();
  return registry.find(r => r.symbol === symbol);
}

/** Get a reserve by mint address. */
export async function getReserveByMint(mint: string): Promise<KaminoReserveInfo | undefined> {
  const registry = await getReserveRegistry();
  return registry.find(r => r.mint === mint);
}

/** Get all LST reserves (isLst=true). */
export async function getLstAssets(): Promise<KaminoReserveInfo[]> {
  const registry = await getReserveRegistry();
  return registry.filter(r => r.isLst);
}

/** Get all asset symbols in the registry. */
export async function getAllAssetSymbols(): Promise<string[]> {
  const registry = await getReserveRegistry();
  return registry.map(r => r.symbol);
}

/** Mint address → symbol. */
export function mintToSymbol(mint: string): string {
  return WELL_KNOWN_MINTS[mint] ?? mint.slice(0, 8);
}

/** Symbol → mint address (from registry). */
export async function symbolToMint(sym: string): Promise<string | undefined> {
  const r = await getReserve(sym);
  return r?.mint;
}

// ── Backward-compatible sync exports (deprecated — use registry) ────────────
/** @deprecated Use getLstAssets() */
export const LST_ASSETS: string[] = ['JitoSOL', 'mSOL', 'bSOL'];
/** @deprecated Use getReserve(lst)?.mint */
export const LST_MINTS: Record<string, string> = {
  JitoSOL: JITOSOL_MINT, mSOL: MSOL_MINT, bSOL: BSOL_MINT,
};
/** @deprecated Use getReserve(lst)?.baseStakingYield */
export const LST_BASE_STAKING_YIELD: Record<string, number> = { ...LST_YIELD_MAP };

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

export type KaminoMarketApy = { [symbol: string]: { supplyApy: number; borrowApy: number } };

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
    mSOL:    { supplyApy: 0.065, borrowApy: 0.09 },
    bSOL:    { supplyApy: 0.06, borrowApy: 0.09 },
    JUP:     { supplyApy: 0.05, borrowApy: 0.14 },
  };

  try {
    const resp = await fetch(
      `https://api.kamino.finance/kamino-market/${KAMINO_MAIN_MARKET_ADDR}/reserves/metrics`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) throw new Error(`Kamino API ${resp.status}`);

    const data = await resp.json() as any[];
    const result: KaminoMarketApy = { ...fallback };

    for (const reserve of data) {
      const rawSymbol: string = (reserve.liquidityToken ?? '');
      const asset = SYMBOL_NORMALISE[rawSymbol.toUpperCase()] ?? rawSymbol;
      if (asset) {
        result[asset] = {
          supplyApy: Number(reserve.supplyApy ?? fallback[asset]?.supplyApy ?? 0.06),
          borrowApy: Number(reserve.borrowApy ?? fallback[asset]?.borrowApy ?? 0.10),
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
    logger.info(`[Kamino] DRY RUN — would deposit ${amount} ${asset} at ${((apys[asset]?.supplyApy ?? 0) * 100).toFixed(1)}% APY`);
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

    const reserveInfo = await getReserve(asset);
    if (!reserveInfo) throw new Error(`Unknown asset: ${asset} — not in Kamino registry`);
    const reserve = market!.getReserveByAddress(reserveInfo.reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found in market`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** reserveInfo.decimals).toString();
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
    const reserveInfo = await getReserve(asset);
    if (!reserveInfo) throw new Error(`Unknown asset: ${asset} — not in Kamino registry`);
    const reserve = market!.getReserveByAddress(reserveInfo.reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** reserveInfo.decimals).toString();
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
      return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.85 };
    }

    // klend-sdk v7 uses getUserVanillaObligation (throws if no obligation exists)
    let obligation: any;
    try {
      obligation = await market.getUserVanillaObligation(wallet.publicKey.toBase58() as any);
    } catch {
      // No obligation found — wallet hasn't deposited yet
      return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.85 };
    }

    const apys = await fetchKaminoApys();
    const registry = await getReserveRegistry();
    const deposits: KaminoPosition['deposits'] = [];
    const borrows: KaminoPosition['borrows'] = [];

    // Helper: safely convert SDK Decimal / number / null to a finite number
    const num = (v: any): number => { const x = Number(v ?? 0); return isFinite(x) ? x : 0; };

    // Helper: resolve mint or reserve address → symbol + decimals from registry
    const resolveAsset = (mint: string, reserveAddr?: string): { symbol: string; decimals: number } => {
      const byMint = registry.find(r => r.mint === mint);
      if (byMint) return { symbol: byMint.symbol, decimals: byMint.decimals };
      if (reserveAddr) {
        const byRes = registry.find(r => r.reserveAddress === reserveAddr);
        if (byRes) return { symbol: byRes.symbol, decimals: byRes.decimals };
      }
      const sym = WELL_KNOWN_MINTS[mint] ?? mint.slice(0, 8);
      return { symbol: sym, decimals: 9 };
    };

    // ── Parse deposits ─────────────────────────────────────────────────────
    // SDK v7: obligation.deposits is Map<reserveAddr, {mintAddress, amount (base units), marketValueRefreshed (USD)}>
    if (obligation.deposits instanceof Map) {
      for (const [reserveAddr, dep] of obligation.deposits) {
        const mint = String(dep.mintAddress ?? '');
        const { symbol: asset, decimals } = resolveAsset(mint, reserveAddr);
        const amount = num(dep.amount) / (10 ** decimals);
        const valueUsd = num(dep.marketValueRefreshed);
        if (amount > 0.000001) {
          deposits.push({ asset, amount, valueUsd, apy: apys[asset]?.supplyApy ?? 0.08 });
        }
      }
    } else if (obligation.deposits && typeof obligation.deposits[Symbol.iterator] === 'function') {
      // Fallback: array-like iterable (older SDK versions)
      for (const entry of obligation.deposits) {
        const dep = Array.isArray(entry) ? entry[1] : entry;
        const mint = String(dep?.mintAddress ?? '');
        const { symbol: asset } = resolveAsset(mint);
        const amount = num(dep?.amount);
        const valueUsd = num(dep?.marketValueRefreshed ?? dep?.marketValue ?? 0);
        if (amount > 0) {
          deposits.push({ asset, amount, valueUsd, apy: apys[asset]?.supplyApy ?? 0.08 });
        }
      }
    }

    // ── Parse borrows ──────────────────────────────────────────────────────
    if (obligation.borrows instanceof Map) {
      for (const [reserveAddr, brw] of obligation.borrows) {
        const mint = String(brw.mintAddress ?? '');
        const { symbol: asset, decimals } = resolveAsset(mint, reserveAddr);
        const amount = num(brw.amount) / (10 ** decimals);
        const valueUsd = num(brw.marketValueRefreshed);
        if (amount > 0.000001) {
          borrows.push({ asset, amount, valueUsd, apy: apys[asset]?.borrowApy ?? 0.12 });
        }
      }
    } else if (obligation.borrows && typeof obligation.borrows[Symbol.iterator] === 'function') {
      for (const entry of obligation.borrows) {
        const brw = Array.isArray(entry) ? entry[1] : entry;
        const mint = String(brw?.mintAddress ?? '');
        const { symbol: asset } = resolveAsset(mint);
        const amount = num(brw?.amount);
        const valueUsd = num(brw?.marketValueRefreshed ?? brw?.marketValue ?? 0);
        if (amount > 0) {
          borrows.push({ asset, amount, valueUsd, apy: apys[asset]?.borrowApy ?? 0.12 });
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

    /**
     * Health factor calculation.
     *
     * Prefer the SDK's own computed value when available (stats.healthFactor or
     * stats.borrowUtilization). The SDK applies per-asset liquidation thresholds
     * correctly — e.g. JitoSOL/SOL positions have ~0.90-0.92 liquidation LTV,
     * not 0.75 like stablecoin pairs.
     *
     * Fallback formula uses 0.90 (covers JitoSOL/SOL safely; still conservative
     * for USDC-only positions which liquidate at ~0.80).
     *
     * NEVER use 0.75 as the constant — it under-reports health for JitoSOL/SOL
     * loops and causes the auto-unwind to fire immediately after the loop opens.
     */
    let healthFactor: number;
    if (stats?.healthFactor && Number(stats.healthFactor) > 0 && isFinite(Number(stats.healthFactor))) {
      // SDK computes this correctly against per-asset liquidation thresholds
      healthFactor = Number(stats.healthFactor);
    } else if (stats?.borrowUtilization && Number(stats.borrowUtilization) > 0) {
      // borrowUtilization = borrowValue / (depositValue * liquidationThreshold)
      // healthFactor = 1 / borrowUtilization
      healthFactor = 1 / Number(stats.borrowUtilization);
    } else {
      // Fallback: use 0.90 (safe for JitoSOL/SOL; conservative for USDC positions)
      healthFactor = ltv > 0 ? 0.90 / ltv : 999;
    }

    /**
     * maxLtv: use the SDK's unhealthyBorrowValue / depositValue when available.
     * Fallback 0.85 is a conservative estimate across all asset pairs.
     */
    const maxLtv = (stats?.unhealthyBorrowValue && depositValueUsd > 0)
      ? Number(stats.unhealthyBorrowValue) / depositValueUsd
      : 0.85;

    logger.debug(
      `[Kamino] Position: ${deposits.length} deposits ($${depositValueUsd.toFixed(2)}), ` +
      `${borrows.length} borrows ($${borrowValueUsd.toFixed(2)}), ` +
      `LTV=${(ltv * 100).toFixed(1)}%, health=${healthFactor.toFixed(3)}`
    );
    return { deposits, borrows, netValueUsd, healthFactor, ltv, maxLtv };
  } catch (err) {
    logger.warn('[Kamino] getPosition error:', err);
    return { deposits: [], borrows: [], netValueUsd: 0, healthFactor: 999, ltv: 0, maxLtv: 0.85 };
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

  // LTV guard — fetch position directly to avoid checkLtvHealth()'s kaminoMaxLtvPct threshold,
  // which is calibrated for alerts, not for gating borrow calls.
  // SOL borrows are always for the LST loop and use a higher LTV cap (correlated collateral).
  const reserveInfo = await getReserve(asset);
  if (!reserveInfo) return { success: false, asset, amountBorrowed: 0, error: `Unknown asset: ${asset}` };

  const pos = await getPosition();
  const isLstLoopBorrow = asset === 'SOL';
  const configuredCap = isLstLoopBorrow
    ? (env.kaminoJitoLoopMaxLtvPct ?? 72) / 100
    : (env.kaminoBorrowMaxLtvPct ?? 60) / 100;
  const borrowLtvCap = Math.min(reserveInfo.safeBorrowLtv, configuredCap);
  if (pos.ltv > borrowLtvCap) {
    return {
      success: false, asset, amountBorrowed: 0,
      error: `LTV ${(pos.ltv * 100).toFixed(1)}% exceeds borrow cap ${(borrowLtvCap * 100).toFixed(0)}% for ${asset}`,
    };
  }

  try {
    const klend = await loadKlend();
    const wallet = loadWallet();
    const connection = getConnection();
    const rpc = getRpcV2();

    const market = await klend.KaminoMarket.load(rpc, KAMINO_MAIN_MARKET_ADDR, 400);
    const reserve = market!.getReserveByAddress(reserveInfo.reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(amount * 10 ** reserveInfo.decimals).toString();
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
    const reserveInfo = await getReserve(asset);
    if (!reserveInfo) throw new Error(`Unknown asset: ${asset} — not in Kamino registry`);
    const reserve = market!.getReserveByAddress(reserveInfo.reserveAddress as any);
    if (!reserve) throw new Error(`Reserve ${asset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const baseAmount = Math.floor(repayAmount * 10 ** reserveInfo.decimals).toString();
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

    const repayReserveInfo = await getReserve(repayAsset);
    const withdrawReserveInfo = await getReserve(withdrawAsset);
    if (!repayReserveInfo) throw new Error(`Unknown repay asset: ${repayAsset}`);
    if (!withdrawReserveInfo) throw new Error(`Unknown withdraw asset: ${withdrawAsset}`);

    const repayReserve = market!.getReserveByAddress(repayReserveInfo.reserveAddress as any);
    const withdrawReserve = market!.getReserveByAddress(withdrawReserveInfo.reserveAddress as any);
    if (!repayReserve) throw new Error(`Repay reserve ${repayAsset} not found`);
    if (!withdrawReserve) throw new Error(`Withdraw reserve ${withdrawAsset} not found`);

    const walletAddr = { address: wallet.publicKey.toBase58() } as any;
    const repayBase = Math.floor(repayAmount * 10 ** repayReserveInfo.decimals).toString();
    const withdrawBase = Math.floor(withdrawAmount * 10 ** withdrawReserveInfo.decimals).toString();

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
      false,       // useV2Ixs
      undefined,   // scopeRefreshConfig
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

// ============================================================================
// Generic LST/SOL Multiply Loop — works for JitoSOL, mSOL, bSOL
// ============================================================================

/**
 * Generic LST/SOL Multiply loop.
 * Same mechanic as loopJitoSol but for any supported LST:
 *   1. Deposit LST as collateral
 *   2. Borrow SOL against it
 *   3. Swap SOL → LST (via Jupiter)
 *   4. Re-deposit LST
 *   5. Repeat
 *
 * For JitoSOL specifically, the SOL→JitoSOL step can use Jito's staking pool
 * (better rate). For mSOL/bSOL we use Jupiter swap.
 */
export async function loopLst(
  lst: LstAsset,
  targetLtv = 0.65,
  maxLoops = 3,
  solPriceUsd = 80,
): Promise<JitoSolLoopResult> {
  // JitoSOL path uses the existing optimised function
  if (lst === 'JitoSOL') return loopJitoSol(targetLtv, maxLoops, solPriceUsd);

  const env = getCFOEnv();
  const txSigs: string[] = [];

  if (!env.kaminoBorrowEnabled) {
    return { success: false, loopsCompleted: 0, jitoSolDeposited: 0, solBorrowed: 0, effectiveLtv: 0, estimatedApy: 0, txSignatures: [], error: 'Borrowing disabled' };
  }

  if (env.dryRun) {
    const apys = await fetchKaminoApys();
    const leverage = 1 / (1 - targetLtv);
    const lstDryInfo = await getReserve(lst);
    const baseYield = lstDryInfo?.baseStakingYield ?? 0.07;
    const supplyApy = Math.max(apys[lst]?.supplyApy ?? 0, baseYield);
    const estimatedApy = leverage * supplyApy - (leverage - 1) * (apys.SOL?.borrowApy ?? 0);
    logger.info(`[Kamino:Loop:${lst}] DRY RUN — would loop to ${(targetLtv * 100).toFixed(0)}% LTV, est. APY ${(estimatedApy * 100).toFixed(1)}%`);
    return { success: true, loopsCompleted: maxLoops, jitoSolDeposited: 0, solBorrowed: 0, effectiveLtv: targetLtv, estimatedApy, txSignatures: [`dry-loop-${lst}-${Date.now()}`] };
  }

  if (targetLtv > 0.80) throw new Error(`targetLtv exceeds safe maximum of 0.80 for ${lst} loop`);

  let totalLstDeposited = 0;
  let totalSolBorrowed = 0;
  let loopsCompleted = 0;

  for (let i = 0; i < maxLoops; i++) {
    const pos = await getPosition();
    const currentLtv = pos.ltv;

    if (currentLtv >= targetLtv * 0.95) {
      logger.info(`[Kamino:Loop:${lst}] Target LTV ${(targetLtv * 100).toFixed(0)}% reached (current: ${(currentLtv * 100).toFixed(1)}%) after ${i} loops`);
      break;
    }

    const depositValUsd = pos.deposits.reduce((s, d) => s + d.valueUsd, 0);
    const currentBorrowValUsd = pos.borrows.reduce((s, b) => s + b.valueUsd, 0);
    const targetBorrowValUsd = depositValUsd * targetLtv;
    const canBorrowUsd = Math.max(0, targetBorrowValUsd - currentBorrowValUsd) * 0.9;

    if (canBorrowUsd < 1) { logger.info(`[Kamino:Loop:${lst}] Headroom too small ($${canBorrowUsd.toFixed(2)}) — stopping`); break; }

    const solToBorrow = canBorrowUsd / solPriceUsd;

    // Step 1: Borrow SOL
    const borrowResult = await borrow('SOL', solToBorrow);
    if (!borrowResult.success) {
      logger.error(`[Kamino:Loop:${lst}] Borrow SOL failed: ${borrowResult.error}`);
      break;
    }
    if (borrowResult.txSignature) txSigs.push(borrowResult.txSignature);
    totalSolBorrowed += solToBorrow;

    // Step 2: Swap SOL → LST via Jupiter
    const lstSwapInfo = await getReserve(lst);
    if (!lstSwapInfo?.mint) { logger.error(`[Kamino:Loop:${lst}] No mint found for ${lst}`); break; }
    const lstMint = lstSwapInfo.mint;
    try {
      const jupiter = await import('./jupiterService.ts');
      const quote = await jupiter.getQuote(jupiter.MINTS.SOL, lstMint, solToBorrow, 100); // 1% slippage
      if (!quote) throw new Error('No Jupiter quote');
      const swapResult = await jupiter.executeSwap(quote, { maxPriceImpactPct: 1.5 });
      if (!swapResult.success) throw new Error(swapResult.error);
      if (swapResult.txSignature) txSigs.push(swapResult.txSignature);

      const lstReceived = swapResult.outputAmount;
      logger.info(`[Kamino:Loop:${lst}] Swapped ${solToBorrow.toFixed(4)} SOL → ${lstReceived.toFixed(4)} ${lst}`);

      await new Promise(r => setTimeout(r, 2000));

      // Step 3: Deposit LST back into Kamino
      const depositResult = await deposit(lst, lstReceived);
      if (!depositResult.success) {
        logger.error(`[Kamino:Loop:${lst}] Deposit failed: ${depositResult.error}`);
        // Attempt to repay the borrow to unwind this iteration
        await repay('SOL', solToBorrow).catch(() => {});
        break;
      }
      if (depositResult.txSignature) txSigs.push(depositResult.txSignature);
      totalLstDeposited += lstReceived;
      loopsCompleted++;
    } catch (err) {
      logger.error(`[Kamino:Loop:${lst}] Jupiter swap failed:`, err);
      // Attempt to repay the borrow
      await repay('SOL', solToBorrow).catch(() => {});
      break;
    }
  }

  const finalPos = await getPosition();
  const apys = await fetchKaminoApys();
  const lstFinalInfo = await getReserve(lst);
  const baseYield = lstFinalInfo?.baseStakingYield ?? 0.07;
  const effectiveSupplyApy = Math.max(apys[lst]?.supplyApy ?? 0, baseYield);
  const leverage = finalPos.netValueUsd > 0
    ? finalPos.deposits.filter(d => d.asset === lst).reduce((s, d) => s + d.valueUsd, 0) / finalPos.netValueUsd
    : 1;
  const estimatedApy = leverage * effectiveSupplyApy - (leverage - 1) * apys.SOL.borrowApy;

  return {
    success: loopsCompleted > 0,
    loopsCompleted,
    jitoSolDeposited: totalLstDeposited,   // field name kept for compat but represents any LST
    solBorrowed: totalSolBorrowed,
    effectiveLtv: finalPos.ltv,
    estimatedApy,
    txSignatures: txSigs,
  };
}

/**
 * Unwind any LST/SOL loop — withdraw LST → swap to SOL → repay SOL borrow.
 * Works for JitoSOL, mSOL, bSOL.
 */
export async function unwindLstLoop(lst: LstAsset): Promise<{ success: boolean; txSignatures: string[]; error?: string }> {
  if (lst === 'JitoSOL') return unwindJitoSolLoop();

  const env = getCFOEnv();
  const txSigs: string[] = [];

  if (env.dryRun) {
    logger.info(`[Kamino:Unwind:${lst}] DRY RUN — would unwind ${lst} loop`);
    return { success: true, txSignatures: ['dry-unwind'] };
  }

  for (let i = 0; i < 6; i++) {
    const pos = await getPosition();
    const solBorrow = pos.borrows.find(b => b.asset === 'SOL');
    if (!solBorrow || solBorrow.amount < 0.001) { logger.info(`[Kamino:Unwind:${lst}] Fully unwound`); break; }

    const lstDeposit = pos.deposits.find(d => d.asset === lst);
    if (!lstDeposit || lstDeposit.amount < 0.001) break;

    const withdrawAmt = Math.min(lstDeposit.amount * 0.4, lstDeposit.amount - 0.001);
    const withdrawResult = await withdraw(lst, withdrawAmt);
    if (!withdrawResult.success) { logger.error(`[Kamino:Unwind:${lst}] Withdraw failed: ${withdrawResult.error}`); break; }
    if (withdrawResult.txSignature) txSigs.push(withdrawResult.txSignature);

    // Swap LST → SOL via Jupiter
    try {
      const jupiter = await import('./jupiterService.ts');
      const lstUnwindInfo = await getReserve(lst);
      if (!lstUnwindInfo?.mint) throw new Error(`No mint for ${lst}`);
      const quote = await jupiter.getQuote(lstUnwindInfo.mint, jupiter.MINTS.SOL, withdrawAmt * 0.999, 100);
      if (!quote) throw new Error('No quote');
      const swapResult = await jupiter.executeSwap(quote, { maxPriceImpactPct: 1.5 });
      if (!swapResult.success) throw new Error(swapResult.error);
      if (swapResult.txSignature) txSigs.push(swapResult.txSignature);

      const solReceived = swapResult.outputAmount;
      const repayAmt = Math.min(solReceived, solBorrow.amount);
      if (repayAmt < 0.001) break;
      const repayResult = await repay('SOL', repayAmt);
      if (repayResult.txSignature) txSigs.push(repayResult.txSignature);

      logger.info(`[Kamino:Unwind:${lst}] Step ${i + 1}: withdrew ${withdrawAmt.toFixed(4)} ${lst}, repaid ${repayAmt.toFixed(4)} SOL`);
    } catch (err) {
      logger.error(`[Kamino:Unwind:${lst}] Swap/repay failed:`, err);
      break;
    }
  }

  return { success: true, txSignatures: txSigs };
}

// ============================================================================
// Kamino Multiply Vaults — managed leverage, auto-rebalancing
// ============================================================================

/** A Kamino Multiply vault — pre-built auto-managed leverage strategy. */
export interface KaminoMultiplyVault {
  address: string;       // vault pubkey
  name: string;          // e.g. "JitoSOL-SOL Multiply"
  collateralToken: string;  // e.g. "JitoSOL"
  debtToken: string;     // e.g. "SOL"
  leverage: number;      // current effective leverage (e.g. 3.0)
  maxLeverage: number;   // protocol max leverage
  apy: number;           // estimated APY (already leveraged)
  tvl: number;           // total value locked in USD
  status: 'active' | 'paused';
}

/** Cache for vault data (refresh every 10 min) */
let _vaultCache: { data: KaminoMultiplyVault[]; at: number } | null = null;

/**
 * Fetch available Kamino Multiply vaults from the public API.
 * Returns vaults sorted by APY descending with LST/SOL pairs prioritised.
 */
export async function getMultiplyVaults(): Promise<KaminoMultiplyVault[]> {
  if (_vaultCache && Date.now() - _vaultCache.at < 10 * 60_000) return _vaultCache.data;

  const vaults: KaminoMultiplyVault[] = [];

  try {
    // Kamino Multiply API endpoint (public, no auth)
    const resp = await fetch(
      'https://api.kamino.finance/strategies/metrics?env=mainnet-beta&status=LIVE&strategyType=MULTIPLY',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) throw new Error(`Kamino Vault API ${resp.status}`);

    const data = await resp.json() as any[];

    // Map known LST symbols
    const lstSymbols = new Set(['JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'WSOL']);

    for (const vault of data) {
      const collateralSymbol = (vault.tokenASymbol ?? vault.collateralTokenSymbol ?? '').toUpperCase();
      const debtSymbol = (vault.tokenBSymbol ?? vault.debtTokenSymbol ?? '').toUpperCase();

      // We only care about LST/SOL multiply vaults
      if (!lstSymbols.has(collateralSymbol) && !lstSymbols.has(debtSymbol)) continue;

      // Normalise symbol names to our convention
      const nameMap: Record<string, string> = {
        JITOSOL: 'JitoSOL', MSOL: 'mSOL', BSOL: 'bSOL', WSOL: 'SOL',
        JUPSOL: 'jupSOL', INF: 'INF', SOL: 'SOL',
      };
      const collateral = nameMap[collateralSymbol] ?? collateralSymbol;
      const debt = nameMap[debtSymbol] ?? debtSymbol;

      vaults.push({
        address: vault.address ?? vault.strategy ?? '',
        name: `${collateral}-${debt} Multiply`,
        collateralToken: collateral,
        debtToken: debt,
        leverage: Number(vault.leverage ?? vault.currentLeverage ?? 2),
        maxLeverage: Number(vault.maxLeverage ?? 5),
        apy: Number(vault.apy ?? vault.totalApy ?? vault.strategyApy ?? 0),
        tvl: Number(vault.tvl ?? vault.tvlUsd ?? 0),
        status: 'active',
      });
    }

    // Sort: highest APY first
    vaults.sort((a, b) => b.apy - a.apy);
  } catch (err) {
    logger.debug('[Kamino:Vaults] Failed to fetch multiply vaults (non-fatal):', err);

    // Return hardcoded fallback so the decision engine still has data
    vaults.push(
      { address: '', name: 'JitoSOL-SOL Multiply', collateralToken: 'JitoSOL', debtToken: 'SOL', leverage: 3.0, maxLeverage: 5, apy: 0.18, tvl: 50_000_000, status: 'active' },
      { address: '', name: 'mSOL-SOL Multiply',    collateralToken: 'mSOL',    debtToken: 'SOL', leverage: 3.0, maxLeverage: 5, apy: 0.16, tvl: 20_000_000, status: 'active' },
      { address: '', name: 'bSOL-SOL Multiply',    collateralToken: 'bSOL',    debtToken: 'SOL', leverage: 3.0, maxLeverage: 5, apy: 0.15, tvl: 10_000_000, status: 'active' },
    );
  }

  _vaultCache = { data: vaults, at: Date.now() };
  return vaults;
}

/**
 * Get the best-yield Multiply vault among our supported LSTs.
 * Returns the vault with highest APY that has sufficient TVL (>$100k).
 */
export async function getBestMultiplyVault(minTvl = 100_000): Promise<KaminoMultiplyVault | null> {
  const vaults = await getMultiplyVaults();
  const supportedCollateral = new Set(['JitoSOL', 'mSOL', 'bSOL']);
  return vaults.find(
    v => v.status === 'active' && supportedCollateral.has(v.collateralToken) && v.debtToken === 'SOL' && v.tvl >= minTvl,
  ) ?? null;
}
