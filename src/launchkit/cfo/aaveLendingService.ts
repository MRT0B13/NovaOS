/**
 * AAVE V3 Lending Service — Multi-chain EVM
 *
 * Provides supply, borrow, repay, and position-query functions against
 * AAVE V3 pools on Arbitrum, Base, Polygon, and Optimism.
 *
 * Used by the AAVE_BORROW_LP decision type in decisionEngine.ts:
 *   supply collateral → borrow stablecoins → LP with borrowed funds →
 *   earn yield > borrow cost → repay borrow → keep profit.
 *
 * Reuses evmProviderService for wallet/provider/retry infrastructure.
 *
 * Key functions:
 *   getAaveAccountData(chainId)     → health factor, LTV, borrows, deposits
 *   getAaveUserReserves(chainId)    → per-asset deposit/borrow breakdown
 *   supplyToAave(chainId, ...)      → deposit collateral
 *   borrowFromAave(chainId, ...)    → borrow asset (variable rate)
 *   repayAave(chainId, ...)         → repay borrowed asset
 *   fetchAaveApys(chainId)          → supply/borrow APYs from AAVE on-chain
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';
import {
  loadEthers,
  getEvmProvider,
  getEvmWallet,
  withRpcRetry,
  ERC20_ABI,
  getNativeTokenPrice,
  WRAPPED_NATIVE_ADDR,
} from './evmProviderService.ts';

// ============================================================================
// Types
// ============================================================================

export interface AaveAccountData {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  currentLiquidationThreshold: number;  // 0-1
  ltv: number;                          // current LTV (0-1)
  maxLtv: number;                       // max LTV before liquidation (0-1)
  healthFactor: number;                 // >= 1.0 means safe
}

export interface AaveReservePosition {
  asset: string;           // symbol
  tokenAddress: string;    // underlying token address
  depositAmount: number;   // supplied amount (native units)
  depositValueUsd: number;
  borrowAmount: number;    // borrowed amount (native units)
  borrowValueUsd: number;
  supplyApy: number;       // current supply APY
  borrowApy: number;       // current borrow APY (variable)
  decimals: number;
}

export interface AavePosition {
  chainId: number;
  chainName: string;
  deposits: Array<{
    asset: string;
    amount: number;
    valueUsd: number;
    apy: number;
  }>;
  borrows: Array<{
    asset: string;
    amount: number;
    valueUsd: number;
    apy: number;
  }>;
  netValueUsd: number;
  healthFactor: number;
  ltv: number;
  maxLtv: number;
  availableBorrowsUsd: number;
}

export interface AaveSupplyResult {
  success: boolean;
  chainId: number;
  asset: string;
  amountSupplied: number;
  txHash?: string;
  error?: string;
}

export interface AaveBorrowResult {
  success: boolean;
  chainId: number;
  asset: string;
  amountBorrowed: number;
  txHash?: string;
  error?: string;
}

export interface AaveRepayResult {
  success: boolean;
  chainId: number;
  asset: string;
  amountRepaid: number;
  txHash?: string;
  error?: string;
}

export type AaveMarketApy = Record<string, { supplyApy: number; borrowApy: number }>;

// ============================================================================
// AAVE V3 Pool addresses per chain
// ============================================================================

const AAVE_V3_POOL_CANONICAL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

export const AAVE_V3_POOLS: Record<number, string> = {
  42161: AAVE_V3_POOL_CANONICAL,                       // Arbitrum
  8453:  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Base
  137:   AAVE_V3_POOL_CANONICAL,                       // Polygon
  10:    AAVE_V3_POOL_CANONICAL,                       // Optimism
};

/** AAVE V3 UI Data Provider (for APY queries) */
const AAVE_UI_POOL_DATA_PROVIDER: Record<number, string> = {
  42161: '0x145dE30c929a065582da84Cf96F88460dB9745A7',
  8453:  '0x174446a6741300cD2E7C1b1A636Fee99c8F83502',
  137:   '0xC69728f11E9E6127733751c8410432913123acf1',
  10:    '0x91c0eA31b49B69Ea18607702c5d9aC360bf3dE7D',
};

const CHAIN_NAMES: Record<number, string> = {
  42161: 'Arbitrum',
  8453: 'Base',
  137: 'Polygon',
  10: 'Optimism',
};

// Well-known USDC addresses per chain (native USDC preferred for AAVE supply/borrow)
const WELL_KNOWN_USDC: Record<number, string> = {
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};

// ============================================================================
// AAVE V3 Pool ABI (minimal — only the functions we need)
// ============================================================================

const AAVE_POOL_ABI = [
  // Read user account summary
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',

  // Supply (deposit collateral)
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',

  // Borrow (variable rate = 2)
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',

  // Repay
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',

  // Get reserve data (for APY calculation)
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

const AAVE_ATOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function scaledBalanceOf(address user) view returns (uint256)',
];

const AAVE_DEBT_TOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function scaledBalanceOf(address user) view returns (uint256)',
];

// ============================================================================
// Known AAVE-listed tokens per chain (symbol → address)
// ============================================================================

interface AaveTokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

const AAVE_TOKENS: Record<number, AaveTokenInfo[]> = {
  42161: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC',   decimals: 6  },
    { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC.e', decimals: 6  },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH',   decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f', symbol: 'WBTC',   decimals: 8  },
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB',    decimals: 18 },
    { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', symbol: 'LINK',   decimals: 18 },
    { address: '0xda10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI',    decimals: 18 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT',   decimals: 6  },
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC',   decimals: 6  },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   decimals: 18 },
    { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH',  decimals: 18 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI',    decimals: 18 },
  ],
  137: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC',   decimals: 6  },
    { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.e', decimals: 6  },
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH',   decimals: 18 },
    { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC',   decimals: 8  },
    { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
    { address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', symbol: 'LINK',   decimals: 18 },
    { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI',    decimals: 18 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT',   decimals: 6  },
  ],
  10: [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC',   decimals: 6  },
    { address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', symbol: 'USDC.e', decimals: 6  },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   decimals: 18 },
    { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', symbol: 'WBTC',   decimals: 8  },
    { address: '0x4200000000000000000000000000000000000042', symbol: 'OP',     decimals: 18 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI',    decimals: 18 },
  ],
};

// ============================================================================
// Helpers
// ============================================================================

function getPoolAddress(chainId: number): string {
  const pool = AAVE_V3_POOLS[chainId];
  if (!pool) throw new Error(`[AaveLending] No AAVE V3 pool for chainId ${chainId}`);
  return pool;
}

function resolveTokenInfo(chainId: number, symbolOrAddress: string): AaveTokenInfo | undefined {
  const tokens = AAVE_TOKENS[chainId];
  if (!tokens) return undefined;
  const lower = symbolOrAddress.toLowerCase();
  return tokens.find(t =>
    t.symbol.toLowerCase() === lower || t.address.toLowerCase() === lower,
  );
}

/** Convert AAVE on-chain ray (1e27) rate to annualized APY */
function rayToApy(rayRate: bigint): number {
  // AAVE rates are in ray (1e27) per second, annualized
  // APY = ((1 + rate/secondsPerYear)^secondsPerYear - 1)
  // Simplified: APY ≈ rate / 1e27 (for small rates, the compound effect is minimal)
  const SECONDS_PER_YEAR = 31536000n;
  const RAY = 10n ** 27n;
  // Simpler: rate is already annualized in ray format
  // currentLiquidityRate and currentVariableBorrowRate are annualized
  return Number(rayRate * 10000n / RAY) / 10000;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get the overall AAVE V3 account summary for our wallet on a given chain.
 * Uses getUserAccountData — returned values are in AAVE's base currency (USD, 8 decimals).
 */
export async function getAaveAccountData(chainId: number): Promise<AaveAccountData> {
  const poolAddr = getPoolAddress(chainId);
  const ethers = await loadEthers();
  const wallet = await getEvmWallet(chainId);
  const provider = await getEvmProvider(chainId);

  const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, provider);

  const result = await withRpcRetry(
    () => pool.getUserAccountData(wallet.address),
    `AAVE getUserAccountData (chain ${chainId})`,
  );

  // AAVE returns values in base currency units (USD with 8 decimals)
  const BASE_DECIMALS = 8;
  const divisor = 10 ** BASE_DECIMALS;

  const totalCollateralUsd = Number(result.totalCollateralBase) / divisor;
  const totalDebtUsd = Number(result.totalDebtBase) / divisor;
  const availableBorrowsUsd = Number(result.availableBorrowsBase) / divisor;
  // liquidationThreshold and ltv are in basis points (e.g., 8250 = 82.50%)
  const currentLiquidationThreshold = Number(result.currentLiquidationThreshold) / 10000;
  const maxLtv = Number(result.ltv) / 10000;
  const ltv = totalCollateralUsd > 0 ? totalDebtUsd / totalCollateralUsd : 0;
  // healthFactor is in wad (1e18)
  const healthFactor = Number(result.healthFactor) / 1e18;

  return {
    totalCollateralUsd,
    totalDebtUsd,
    availableBorrowsUsd,
    currentLiquidationThreshold,
    ltv,
    maxLtv,
    healthFactor: isFinite(healthFactor) ? healthFactor : 999,
  };
}

/**
 * Get per-asset deposit/borrow breakdown for our wallet on a given chain.
 * Queries each known AAVE-listed token's aToken and variableDebtToken balances.
 */
export async function getAavePosition(chainId: number): Promise<AavePosition> {
  const emptyPosition: AavePosition = {
    chainId,
    chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
    deposits: [],
    borrows: [],
    netValueUsd: 0,
    healthFactor: 999,
    ltv: 0,
    maxLtv: 0.85,
    availableBorrowsUsd: 0,
  };

  try {
    const poolAddr = getPoolAddress(chainId);
    const ethers = await loadEthers();
    const provider = await getEvmProvider(chainId);
    const wallet = await getEvmWallet(chainId);
    const walletAddress = wallet.address;

    const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, provider);
    const tokens = AAVE_TOKENS[chainId];
    if (!tokens?.length) return emptyPosition;

    // Get account summary first
    const accountData = await getAaveAccountData(chainId);

    // Query reserve data for each token to get aToken/debtToken addresses and APYs
    const deposits: AavePosition['deposits'] = [];
    const borrows: AavePosition['borrows'] = [];

    // Get native token price for value estimation
    const nativePrice = await getNativeTokenPrice(chainId);

    // Process each known token
    for (const tokenInfo of tokens) {
      try {
        const reserveData = await withRpcRetry(
          () => pool.getReserveData(tokenInfo.address),
          `AAVE getReserveData ${tokenInfo.symbol} (chain ${chainId})`,
        );

        const aTokenAddr = reserveData.aTokenAddress;
        const variableDebtTokenAddr = reserveData.variableDebtTokenAddress;

        // Query aToken balance (deposits)
        const aToken = new ethers.Contract(aTokenAddr, AAVE_ATOKEN_ABI, provider);
        const depositBalRaw: bigint = await withRpcRetry(
          () => aToken.balanceOf(walletAddress),
          `aToken.balanceOf ${tokenInfo.symbol}`,
        );
        const depositAmount = Number(depositBalRaw) / (10 ** tokenInfo.decimals);

        // Query variable debt token balance (borrows)
        const debtToken = new ethers.Contract(variableDebtTokenAddr, AAVE_DEBT_TOKEN_ABI, provider);
        const borrowBalRaw: bigint = await withRpcRetry(
          () => debtToken.balanceOf(walletAddress),
          `debtToken.balanceOf ${tokenInfo.symbol}`,
        );
        const borrowAmount = Number(borrowBalRaw) / (10 ** tokenInfo.decimals);

        // Estimate USD values
        const tokenPrice = await estimateTokenPrice(tokenInfo.symbol, chainId, nativePrice);
        const supplyApy = rayToApy(reserveData.currentLiquidityRate);
        const borrowApy = rayToApy(reserveData.currentVariableBorrowRate);

        if (depositAmount > 0.000001) {
          deposits.push({
            asset: tokenInfo.symbol,
            amount: depositAmount,
            valueUsd: depositAmount * tokenPrice,
            apy: supplyApy,
          });
        }

        if (borrowAmount > 0.000001) {
          borrows.push({
            asset: tokenInfo.symbol,
            amount: borrowAmount,
            valueUsd: borrowAmount * tokenPrice,
            apy: borrowApy,
          });
        }
      } catch (err) {
        logger.debug(`[AaveLending] skip ${tokenInfo.symbol} on chain ${chainId}: ${(err as Error).message}`);
      }
    }

    return {
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      deposits,
      borrows,
      netValueUsd: accountData.totalCollateralUsd - accountData.totalDebtUsd,
      healthFactor: accountData.healthFactor,
      ltv: accountData.ltv,
      maxLtv: accountData.maxLtv,
      availableBorrowsUsd: accountData.availableBorrowsUsd,
    };
  } catch (err) {
    logger.warn(`[AaveLending] getAavePosition error (chain ${chainId}):`, err);
    return emptyPosition;
  }
}

/**
 * Supply (deposit) an asset as collateral to AAVE V3.
 */
export async function supplyToAave(
  chainId: number,
  asset: string,
  amount: number,
): Promise<AaveSupplyResult> {
  const env = getCFOEnv();
  const tokenInfo = resolveTokenInfo(chainId, asset);
  if (!tokenInfo) {
    return { success: false, chainId, asset, amountSupplied: 0, error: `Unknown asset: ${asset} on chain ${chainId}` };
  }

  if (env.dryRun) {
    logger.info(`[AaveLending] DRY RUN — would supply ${amount} ${asset} on ${CHAIN_NAMES[chainId]}`);
    return { success: true, chainId, asset, amountSupplied: amount, txHash: `dry-supply-${Date.now()}` };
  }

  if (amount <= 0) {
    return { success: false, chainId, asset, amountSupplied: 0, error: 'Amount must be positive' };
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainId);
    const poolAddr = getPoolAddress(chainId);

    const rawAmount = ethers.parseUnits(amount.toFixed(tokenInfo.decimals), tokenInfo.decimals);

    // Approve pool to spend our tokens
    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);
    const allowance: bigint = await tokenContract.allowance(wallet.address, poolAddr);
    if (allowance < rawAmount) {
      logger.info(`[AaveLending] Approving AAVE pool to spend ${amount} ${asset}...`);
      const approveTx = await tokenContract.approve(poolAddr, rawAmount);
      await approveTx.wait();
    }

    // Supply to pool
    const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, wallet);
    const tx = await pool.supply(tokenInfo.address, rawAmount, wallet.address, 0);
    const receipt = await tx.wait();

    logger.info(`[AaveLending] Supplied ${amount} ${asset} on ${CHAIN_NAMES[chainId]}: ${receipt.hash}`);
    return { success: true, chainId, asset, amountSupplied: amount, txHash: receipt.hash };
  } catch (err) {
    logger.error(`[AaveLending] supply error (${asset} on chain ${chainId}):`, err);
    return { success: false, chainId, asset, amountSupplied: 0, error: (err as Error).message };
  }
}

/**
 * Borrow an asset from AAVE V3 using variable interest rate.
 *
 * Guards:
 *  - Checks current LTV vs configured max
 *  - Checks health factor > 2.0 (safe margin)
 *  - Checks on-chain available borrow headroom
 */
export async function borrowFromAave(
  chainId: number,
  asset: string,
  amount: number,
): Promise<AaveBorrowResult> {
  const env = getCFOEnv();
  const tokenInfo = resolveTokenInfo(chainId, asset);
  if (!tokenInfo) {
    return { success: false, chainId, asset, amountBorrowed: 0, error: `Unknown asset: ${asset} on chain ${chainId}` };
  }

  if (!env.aaveBorrowLpEnabled) {
    return { success: false, chainId, asset, amountBorrowed: 0, error: 'AAVE borrow-LP disabled (set CFO_AAVE_BORROW_LP_ENABLE=true)' };
  }

  if (env.dryRun) {
    logger.info(`[AaveLending] DRY RUN — would borrow ${amount} ${asset} on ${CHAIN_NAMES[chainId]}`);
    return { success: true, chainId, asset, amountBorrowed: amount, txHash: `dry-borrow-${Date.now()}` };
  }

  if (amount <= 0) {
    return { success: false, chainId, asset, amountBorrowed: 0, error: 'Amount must be positive' };
  }

  // Pre-flight: check health factor and LTV
  const accountData = await getAaveAccountData(chainId);
  const maxLtvPct = env.aaveBorrowLpMaxLtvPct;

  if (accountData.healthFactor < 2.0) {
    return {
      success: false, chainId, asset, amountBorrowed: 0,
      error: `Health factor ${accountData.healthFactor.toFixed(2)} < 2.0 — too risky to borrow`,
    };
  }

  if (accountData.ltv >= (maxLtvPct / 100) * 0.90) {
    return {
      success: false, chainId, asset, amountBorrowed: 0,
      error: `LTV ${(accountData.ltv * 100).toFixed(1)}% too close to cap ${maxLtvPct}%`,
    };
  }

  // Check on-chain headroom
  const tokenPrice = await estimateTokenPrice(tokenInfo.symbol, chainId);
  const borrowValueUsd = amount * tokenPrice;
  if (borrowValueUsd > accountData.availableBorrowsUsd * 0.95) {
    return {
      success: false, chainId, asset, amountBorrowed: 0,
      error: `Borrow $${borrowValueUsd.toFixed(2)} exceeds on-chain limit (available: $${accountData.availableBorrowsUsd.toFixed(2)})`,
    };
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainId);
    const poolAddr = getPoolAddress(chainId);

    const rawAmount = ethers.parseUnits(amount.toFixed(tokenInfo.decimals), tokenInfo.decimals);

    // Borrow with variable rate (interestRateMode = 2)
    const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, wallet);
    const tx = await pool.borrow(tokenInfo.address, rawAmount, 2, 0, wallet.address);
    const receipt = await tx.wait();

    logger.info(`[AaveLending] Borrowed ${amount} ${asset} on ${CHAIN_NAMES[chainId]}: ${receipt.hash}`);
    return { success: true, chainId, asset, amountBorrowed: amount, txHash: receipt.hash };
  } catch (err) {
    logger.error(`[AaveLending] borrow error (${asset} on chain ${chainId}):`, err);
    return { success: false, chainId, asset, amountBorrowed: 0, error: (err as Error).message };
  }
}

/**
 * Repay a borrowed asset back to AAVE V3.
 * If amount is Infinity, repays the full borrow balance.
 */
export async function repayAave(
  chainId: number,
  asset: string,
  amount: number,
): Promise<AaveRepayResult> {
  const env = getCFOEnv();
  const tokenInfo = resolveTokenInfo(chainId, asset);
  if (!tokenInfo) {
    return { success: false, chainId, asset, amountRepaid: 0, error: `Unknown asset: ${asset} on chain ${chainId}` };
  }

  if (env.dryRun) {
    logger.info(`[AaveLending] DRY RUN — would repay ${amount} ${asset} on ${CHAIN_NAMES[chainId]}`);
    return { success: true, chainId, asset, amountRepaid: amount, txHash: `dry-repay-${Date.now()}` };
  }

  let repayAmount = amount;

  // If Infinity, look up current borrow to repay in full
  if (!isFinite(amount)) {
    const position = await getAavePosition(chainId);
    const borrowEntry = position.borrows.find(b => b.asset === tokenInfo.symbol);
    if (!borrowEntry || borrowEntry.amount <= 0) {
      return { success: true, chainId, asset, amountRepaid: 0 };
    }
    repayAmount = borrowEntry.amount * 1.001; // small buffer for accrued interest
  }

  if (repayAmount <= 0) {
    return { success: false, chainId, asset, amountRepaid: 0, error: 'Amount must be positive' };
  }

  // Pre-flight: check wallet balance
  try {
    const ethers = await loadEthers();
    const provider = await getEvmProvider(chainId);
    const wallet = await getEvmWallet(chainId);
    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, provider);
    const balRaw: bigint = await tokenContract.balanceOf(wallet.address);
    const walletBal = Number(balRaw) / (10 ** tokenInfo.decimals);
    if (walletBal < repayAmount * 0.50) {
      return { success: false, chainId, asset, amountRepaid: 0, error: `Insufficient ${asset} balance (have ${walletBal.toFixed(2)})` };
    }
    if (repayAmount > walletBal * 0.995) {
      repayAmount = walletBal * 0.995;
    }
  } catch (balErr) {
    logger.debug(`[AaveLending] repay pre-flight balance check failed (proceeding):`, balErr);
  }

  try {
    const ethers = await loadEthers();
    const wallet = await getEvmWallet(chainId);
    const poolAddr = getPoolAddress(chainId);

    const rawAmount = ethers.parseUnits(repayAmount.toFixed(tokenInfo.decimals), tokenInfo.decimals);

    // Approve pool to spend our tokens for repay
    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);
    const allowance: bigint = await tokenContract.allowance(wallet.address, poolAddr);
    if (allowance < rawAmount) {
      const approveTx = await tokenContract.approve(poolAddr, rawAmount);
      await approveTx.wait();
    }

    // Repay with variable rate (interestRateMode = 2)
    const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, wallet);
    const tx = await pool.repay(tokenInfo.address, rawAmount, 2, wallet.address);
    const receipt = await tx.wait();

    logger.info(`[AaveLending] Repaid ${repayAmount.toFixed(tokenInfo.decimals)} ${asset} on ${CHAIN_NAMES[chainId]}: ${receipt.hash}`);
    return { success: true, chainId, asset, amountRepaid: repayAmount, txHash: receipt.hash };
  } catch (err) {
    logger.error(`[AaveLending] repay error (${asset} on chain ${chainId}):`, err);
    return { success: false, chainId, asset, amountRepaid: 0, error: (err as Error).message };
  }
}

/**
 * Fetch current supply/borrow APYs for all listed tokens on a chain.
 * Uses on-chain getReserveData to read currentLiquidityRate and currentVariableBorrowRate.
 */
export async function fetchAaveApys(chainId: number): Promise<AaveMarketApy> {
  const fallback: AaveMarketApy = {
    USDC:   { supplyApy: 0.04, borrowApy: 0.06 },
    'USDC.e': { supplyApy: 0.04, borrowApy: 0.06 },
    WETH:   { supplyApy: 0.02, borrowApy: 0.04 },
    WBTC:   { supplyApy: 0.01, borrowApy: 0.03 },
    DAI:    { supplyApy: 0.04, borrowApy: 0.06 },
    USDT:   { supplyApy: 0.04, borrowApy: 0.06 },
  };

  try {
    const poolAddr = getPoolAddress(chainId);
    const ethers = await loadEthers();
    const provider = await getEvmProvider(chainId);
    const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, provider);
    const tokens = AAVE_TOKENS[chainId] ?? [];

    const result: AaveMarketApy = { ...fallback };

    for (const tokenInfo of tokens) {
      try {
        const reserveData = await withRpcRetry(
          () => pool.getReserveData(tokenInfo.address),
          `AAVE getReserveData ${tokenInfo.symbol}`,
        );

        result[tokenInfo.symbol] = {
          supplyApy: rayToApy(reserveData.currentLiquidityRate),
          borrowApy: rayToApy(reserveData.currentVariableBorrowRate),
        };
      } catch (err) {
        logger.debug(`[AaveLending] APY query failed for ${tokenInfo.symbol}: ${(err as Error).message}`);
      }
    }

    return result;
  } catch (err) {
    logger.warn(`[AaveLending] fetchAaveApys failed for chain ${chainId}:`, err);
    return fallback;
  }
}

/**
 * Aggregate AAVE positions across all configured chains.
 */
export async function getMultiChainAavePositions(): Promise<AavePosition[]> {
  const chainIds = Object.keys(AAVE_V3_POOLS).map(Number);
  const results: AavePosition[] = [];

  for (const chainId of chainIds) {
    try {
      const pos = await getAavePosition(chainId);
      // Only include if there's activity
      if (pos.deposits.length > 0 || pos.borrows.length > 0) {
        results.push(pos);
      }
    } catch (err) {
      logger.debug(`[AaveLending] skip chain ${chainId}: ${(err as Error).message}`);
    }
  }

  return results;
}

/**
 * Get the best chain to borrow on based on available headroom and borrow rates.
 * Returns chainId with the most available borrowing capacity and lowest borrow APY.
 */
export async function selectBestBorrowChain(
  asset: string = 'USDC',
): Promise<{ chainId: number; chainName: string; availableBorrowsUsd: number; borrowApy: number } | null> {
  const chainIds = Object.keys(AAVE_V3_POOLS).map(Number);
  let best: { chainId: number; chainName: string; availableBorrowsUsd: number; borrowApy: number } | null = null;

  for (const chainId of chainIds) {
    try {
      const accountData = await getAaveAccountData(chainId);
      if (accountData.totalCollateralUsd < 10) continue; // no collateral here
      if (accountData.healthFactor < 2.0) continue;      // too risky

      const apys = await fetchAaveApys(chainId);
      const tokenInfo = resolveTokenInfo(chainId, asset);
      const borrowApy = tokenInfo ? (apys[tokenInfo.symbol]?.borrowApy ?? 0.06) : 0.06;

      if (
        !best ||
        accountData.availableBorrowsUsd > best.availableBorrowsUsd ||
        (accountData.availableBorrowsUsd > best.availableBorrowsUsd * 0.8 && borrowApy < best.borrowApy)
      ) {
        best = {
          chainId,
          chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
          availableBorrowsUsd: accountData.availableBorrowsUsd,
          borrowApy,
        };
      }
    } catch {
      continue;
    }
  }

  return best;
}

// ============================================================================
// Token price estimation (fallback for USD value calculation)
// ============================================================================

const _tokenPriceCache = new Map<string, { price: number; ts: number }>();
const TOKEN_PRICE_TTL = 5 * 60_000;

async function estimateTokenPrice(symbol: string, chainId: number, nativePrice?: number): Promise<number> {
  // Stablecoins
  const stables = ['USDC', 'USDC.e', 'USDT', 'DAI', 'USDbC'];
  if (stables.includes(symbol)) return 1.0;

  const cacheKey = `${symbol}-${chainId}`;
  const cached = _tokenPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TOKEN_PRICE_TTL) return cached.price;

  // ETH-based tokens
  if (['WETH', 'ETH', 'cbETH'].includes(symbol)) {
    const price = nativePrice ?? await getNativeTokenPrice(chainId);
    _tokenPriceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  }

  // WMATIC
  if (symbol === 'WMATIC') {
    const price = await getNativeTokenPrice(137);
    _tokenPriceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  }

  // CoinGecko fallback for other tokens
  const cgIds: Record<string, string> = {
    WBTC: 'bitcoin',
    ARB: 'arbitrum',
    OP: 'optimism',
    LINK: 'chainlink',
  };

  const cgId = cgIds[symbol];
  if (cgId) {
    try {
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) {
        const data = await resp.json();
        const price = data[cgId]?.usd;
        if (price && price > 0) {
          _tokenPriceCache.set(cacheKey, { price, ts: Date.now() });
          return price;
        }
      }
    } catch { /* fallback below */ }
  }

  return cached?.price ?? 1.0;
}
