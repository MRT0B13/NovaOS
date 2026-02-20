/**
 * EVM Wallet Service (Polygon)
 *
 * Manages all EVM-side wallet operations for the CFO agent.
 * Primary use case: Polygon wallet for Polymarket USDC deposits,
 * USDC approval to CTF Exchange, and gas reserve monitoring.
 *
 * Requires ethers v6: bun add ethers
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

/** USDC.e on Polygon (6 decimals) */
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Polymarket CTF Exchange on Polygon */
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e';

/** Minimum MATIC balance to alert low gas */
const MIN_GAS_MATIC = 0.5;

/** Minimum MATIC balance to block operations */
const CRITICAL_GAS_MATIC = 0.1;

// Minimal ERC-20 ABI (just what we need)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ============================================================================
// Types
// ============================================================================

export interface EVMWalletStatus {
  address: string;
  maticBalance: number;
  usdcBalance: number;
  usdcApproved: number;   // current CTF Exchange allowance in USDC
  gasOk: boolean;
  gasCritical: boolean;
  timestamp: string;
}

// ============================================================================
// Lazy ethers loading
// ============================================================================

let _provider: any = null;
let _wallet: any = null;
let _usdc: any = null;
let _ethers: any = null;

async function loadEthers(): Promise<{ wallet: any; provider: any; usdc: any; ethers: any }> {
  if (_wallet) return { wallet: _wallet, provider: _provider, usdc: _usdc, ethers: _ethers };

  const mod = await import('ethers');
  _ethers = mod.ethers ?? mod;

  const env = getCFOEnv();
  if (!env.evmPrivateKey) throw new Error('[EVM] CFO_EVM_PRIVATE_KEY not configured');

  _provider = new _ethers.JsonRpcProvider(env.polygonRpcUrl);
  _wallet = new _ethers.Wallet(env.evmPrivateKey, _provider);
  _usdc = new _ethers.Contract(USDC_POLYGON, ERC20_ABI, _wallet);

  logger.info(`[EVM] Wallet loaded on Polygon: ${_wallet.address}`);
  return { wallet: _wallet, provider: _provider, usdc: _usdc, ethers: _ethers };
}

// ============================================================================
// Balance & Status
// ============================================================================

/**
 * Get full wallet status including MATIC, USDC, and CTF Exchange allowance.
 */
export async function getWalletStatus(): Promise<EVMWalletStatus> {
  const { wallet, provider, usdc, ethers } = await loadEthers();

  const [maticBal, usdcRaw, allowanceRaw] = await Promise.all([
    provider.getBalance(wallet.address),
    usdc.balanceOf(wallet.address),
    usdc.allowance(wallet.address, CTF_EXCHANGE),
  ]);

  const maticBalance = Number(ethers.formatEther(maticBal));
  const usdcBalance = Number(ethers.formatUnits(usdcRaw, 6));
  const usdcApproved = Number(ethers.formatUnits(allowanceRaw, 6));

  return {
    address: wallet.address,
    maticBalance,
    usdcBalance,
    usdcApproved,
    gasOk: maticBalance >= MIN_GAS_MATIC,
    gasCritical: maticBalance < CRITICAL_GAS_MATIC,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get USDC balance on Polygon.
 */
export async function getUSDCBalance(): Promise<number> {
  const { usdc, ethers } = await loadEthers();
  const raw = await usdc.balanceOf((await loadEthers()).wallet.address);
  return Number(ethers.formatUnits(raw, 6));
}

/**
 * Get MATIC balance.
 */
export async function getMaticBalance(): Promise<number> {
  const { wallet, provider, ethers } = await loadEthers();
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

/**
 * Return wallet address without triggering wallet load (safe to call early).
 */
export function getWalletAddressFromEnv(): string | undefined {
  const env = getCFOEnv();
  if (!env.evmPrivateKey) return undefined;
  try {
    // Derive address from private key without initialising provider
    const { ethers } = require('ethers');
    return new ethers.Wallet(env.evmPrivateKey).address;
  } catch {
    return undefined;
  }
}

// ============================================================================
// USDC Approval
// ============================================================================

/**
 * Approve the CTF Exchange to spend USDC on behalf of our wallet.
 * Approves MaxUint256 (unlimited) for gas efficiency.
 * Only sends a transaction if the current allowance is below `minAllowance`.
 */
export async function ensureCTFApproval(minAllowanceUsdc = 10_000): Promise<boolean> {
  const { wallet, usdc, ethers } = await loadEthers();

  const currentAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
  const currentUsdc = Number(ethers.formatUnits(currentAllowance, 6));

  if (currentUsdc >= minAllowanceUsdc) {
    logger.debug(`[EVM] CTF Exchange already approved: ${currentUsdc.toFixed(2)} USDC`);
    return true;
  }

  logger.info(`[EVM] Approving CTF Exchange (current: ${currentUsdc.toFixed(2)} USDC)...`);

  try {
    const tx = await usdc.approve(CTF_EXCHANGE, ethers.MaxUint256);
    await tx.wait(1);
    logger.info(`[EVM] CTF Exchange approved: ${tx.hash}`);
    return true;
  } catch (err) {
    logger.error('[EVM] USDC approval failed:', err);
    return false;
  }
}

// ============================================================================
// Gas monitoring
// ============================================================================

/**
 * Check if gas (MATIC) is sufficient to continue operating.
 * Returns status object so callers can decide to pause or alert.
 */
export async function checkGas(): Promise<{ ok: boolean; matic: number; warning?: string }> {
  try {
    const matic = await getMaticBalance();

    if (matic < CRITICAL_GAS_MATIC) {
      return {
        ok: false,
        matic,
        warning: `CRITICAL: Only ${matic.toFixed(3)} MATIC — Polymarket operations suspended`,
      };
    }

    if (matic < MIN_GAS_MATIC) {
      return {
        ok: true, // not critical yet, but warn
        matic,
        warning: `LOW GAS: ${matic.toFixed(3)} MATIC — top up soon`,
      };
    }

    return { ok: true, matic };
  } catch (err) {
    return { ok: false, matic: 0, warning: `Gas check failed: ${(err as Error).message}` };
  }
}

// ============================================================================
// USDC Transfer (for moving funds between wallets)
// ============================================================================

/**
 * Send USDC to another Polygon address.
 * Used by CFO to move profits to treasury.
 */
export async function sendUSDC(toAddress: string, amountUsdc: number): Promise<string | null> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(`[EVM] DRY RUN — would send ${amountUsdc} USDC to ${toAddress}`);
    return 'dry-run-hash';
  }

  const { usdc, ethers } = await loadEthers();

  try {
    const rawAmount = ethers.parseUnits(amountUsdc.toFixed(6), 6);
    const tx = await usdc.transfer(toAddress, rawAmount);
    await tx.wait(1);
    logger.info(`[EVM] Sent ${amountUsdc} USDC to ${toAddress}: ${tx.hash}`);
    return tx.hash as string;
  } catch (err) {
    logger.error(`[EVM] USDC transfer failed:`, err);
    return null;
  }
}

// ============================================================================
// Network health check
// ============================================================================

export async function healthCheck(): Promise<{ ok: boolean; blockNumber?: number; error?: string }> {
  try {
    const { provider } = await loadEthers();
    const blockNumber = await provider.getBlockNumber();
    return { ok: true, blockNumber };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
