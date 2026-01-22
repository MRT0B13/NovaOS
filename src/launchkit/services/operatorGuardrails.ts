/**
 * Operator Guardrail Layer
 * 
 * A single gate function that every dangerous operation must pass through.
 * This ensures consistent enforcement of safety rules across all financial operations.
 * 
 * Gated operations:
 * - launch
 * - buy/sell
 * - withdraw/sweep
 * - publish
 * 
 * Gate checks:
 * - feature enabled flags
 * - caps (max sell %, max tx/hour, daily withdraw cap)
 * - allowlists (ONLY treasury address for withdrawals)
 * - cooldowns/idempotency
 * - token state validation
 * - slippage limits
 * - audit log always written
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { appendAudit } from './audit.ts';
import { nowIso } from './time.ts';

// ==========================================
// Error Codes
// ==========================================
export const ErrorCodes = {
  // Feature flags
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  TREASURY_NOT_ENABLED: 'TREASURY_NOT_ENABLED',
  TREASURY_NOT_CONFIGURED: 'TREASURY_NOT_CONFIGURED',
  AUTO_SELL_NOT_ENABLED: 'AUTO_SELL_NOT_ENABLED',
  AUTO_WITHDRAW_NOT_ENABLED: 'AUTO_WITHDRAW_NOT_ENABLED',
  
  // Destination validation
  DESTINATION_NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED',
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  INVALID_TREASURY_ADDRESS: 'INVALID_TREASURY_ADDRESS',
  TREASURY_ADDRESS_REQUIRED: 'TREASURY_ADDRESS_REQUIRED',
  
  // Custody limitations
  WITHDRAW_NOT_SUPPORTED: 'WITHDRAW_NOT_SUPPORTED',
  WALLET_SECRET_MISSING: 'WALLET_SECRET_MISSING',
  
  // Rate limits and caps
  DAILY_CAP_EXCEEDED: 'DAILY_CAP_EXCEEDED',
  CAP_EXCEEDED: 'CAP_EXCEEDED',
  HOURLY_RATE_EXCEEDED: 'HOURLY_RATE_EXCEEDED',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  MAX_PERCENTAGE_EXCEEDED: 'MAX_PERCENTAGE_EXCEEDED',
  SLIPPAGE_TOO_HIGH: 'SLIPPAGE_TOO_HIGH',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  AMOUNT_TOO_SMALL: 'AMOUNT_TOO_SMALL',
  
  // Token state
  TOKEN_NOT_LAUNCHED: 'TOKEN_NOT_LAUNCHED',
  MINT_NOT_FOUND: 'MINT_NOT_FOUND',
  
  // Claim/idempotency
  TREASURY_IN_PROGRESS: 'TREASURY_IN_PROGRESS',
  WITHDRAW_IN_PROGRESS: 'WITHDRAW_IN_PROGRESS',
  CLAIM_FAILED: 'CLAIM_FAILED',
  
  // General
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ==========================================
// Guardrail Error
// ==========================================
export class GuardrailError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
  
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ==========================================
// Operation Types
// ==========================================
export type OperationType = 
  | 'launch'
  | 'buy'
  | 'sell'
  | 'withdraw'
  | 'sweep'
  | 'deposit'
  | 'publish';

export interface GuardrailContext {
  operation: OperationType;
  launchPackId?: string;
  mintAddress?: string;
  amount?: number;
  amountSol?: number;
  percentOfHolding?: number;
  destinationAddress?: string;
  slippage?: number;
  actor?: string;
  // Persistent caps from ops.treasury_caps (passed in for consistency)
  persistentCaps?: TreasuryCaps;
  // Persistent rate limits from ops.sell_rate_limits (passed in for consistency)
  persistentRateLimits?: SellRateLimits;
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  code?: ErrorCode;
  auditEntry?: string;
  warnings?: string[];
  // Cap check details for error messages
  capDetails?: {
    withdrawnToday: number;
    maxPerDay: number;
    remaining: number;
    attemptedAmount?: number;
  };
}

// ==========================================
// Rate Limiting State (Persistence Types)
// ==========================================

/**
 * Treasury caps stored in LaunchPack ops.treasury_caps
 * These persist across restarts.
 */
export interface TreasuryCaps {
  day: string; // YYYY-MM-DD
  withdrawn_sol: number;
  last_withdraw_at?: string;
  withdraw_count: number;
}

/**
 * Sell rate limits stored in LaunchPack ops.sell_rate_limits
 * These persist across restarts.
 */
export interface SellRateLimits {
  hour_key: string; // YYYY-MM-DDTHH
  tx_count: number;
  last_tx_at?: string;
}

/**
 * Get current day key (YYYY-MM-DD)
 */
export function getTodayKey(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current hour key (YYYY-MM-DDTHH)
 */
export function getCurrentHourKey(): string {
  const now = new Date();
  return now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Check if caps need reset (different day)
 */
export function needsCapsReset(caps: TreasuryCaps | undefined): boolean {
  if (!caps) return true;
  return caps.day !== getTodayKey();
}

/**
 * Check if rate limits need reset (different hour)
 */
export function needsRateLimitReset(limits: SellRateLimits | undefined): boolean {
  if (!limits) return true;
  return limits.hour_key !== getCurrentHourKey();
}

/**
 * Create fresh treasury caps for today
 */
export function createFreshCaps(): TreasuryCaps {
  return {
    day: getTodayKey(),
    withdrawn_sol: 0,
    withdraw_count: 0,
  };
}

/**
 * Create fresh sell rate limits for current hour
 */
export function createFreshRateLimits(): SellRateLimits {
  return {
    hour_key: getCurrentHourKey(),
    tx_count: 0,
  };
}

/**
 * Get effective caps, resetting if day changed
 */
export function getEffectiveCaps(caps: TreasuryCaps | undefined): TreasuryCaps {
  if (needsCapsReset(caps)) {
    return createFreshCaps();
  }
  return caps!;
}

/**
 * Get effective rate limits, resetting if hour changed
 */
export function getEffectiveRateLimits(limits: SellRateLimits | undefined): SellRateLimits {
  if (needsRateLimitReset(limits)) {
    return createFreshRateLimits();
  }
  return limits!;
}

// ==========================================
// Legacy In-Memory State (for backwards compatibility)
// DEPRECATED: Use persistent ops.treasury_caps instead
// ==========================================
interface DailyState {
  date: string; // YYYY-MM-DD
  withdrawnSol: number;
  sellCount: number;
  lastSellTime?: number;
  lastWithdrawTime?: number;
}

let dailyState: DailyState = {
  date: new Date().toISOString().split('T')[0],
  withdrawnSol: 0,
  sellCount: 0,
};

function resetDailyStateIfNeeded(): void {
  const today = new Date().toISOString().split('T')[0];
  if (dailyState.date !== today) {
    logger.info('[Guardrails] Resetting daily state for new day');
    dailyState = {
      date: today,
      withdrawnSol: 0,
      sellCount: 0,
    };
  }
}

/**
 * Get current daily state (for monitoring/debugging)
 * DEPRECATED: Use persistent ops.treasury_caps via pack updates instead
 */
export function getDailyState(): Readonly<DailyState> {
  resetDailyStateIfNeeded();
  return { ...dailyState };
}

/**
 * Record a successful withdrawal in daily state
 * DEPRECATED: Use recordPersistentWithdrawal with LaunchPack updates instead
 */
export function recordWithdrawal(amountSol: number): void {
  resetDailyStateIfNeeded();
  dailyState.withdrawnSol += amountSol;
  dailyState.lastWithdrawTime = Date.now();
  logger.info(`[Guardrails] Recorded withdrawal: ${amountSol} SOL (daily total: ${dailyState.withdrawnSol} SOL)`);
}

/**
 * Record a successful sell in daily state
 * DEPRECATED: Use recordPersistentSell with LaunchPack updates instead
 */
export function recordSell(): void {
  resetDailyStateIfNeeded();
  dailyState.sellCount += 1;
  dailyState.lastSellTime = Date.now();
  logger.info(`[Guardrails] Recorded sell (daily count: ${dailyState.sellCount})`);
}

// ==========================================
// Persistent Cap/Rate Limit Helpers
// ==========================================

/**
 * Check if a withdrawal would exceed daily caps (using persistent caps)
 */
export function wouldExceedDailyCap(
  caps: TreasuryCaps | undefined,
  amountSol: number,
  maxPerDay: number
): { exceeded: boolean; remaining: number; withdrawnToday: number } {
  const effective = getEffectiveCaps(caps);
  const remaining = maxPerDay - effective.withdrawn_sol;
  return {
    exceeded: amountSol > remaining,
    remaining: Math.max(0, remaining),
    withdrawnToday: effective.withdrawn_sol,
  };
}

/**
 * Check if a sell would exceed hourly rate limits (using persistent limits)
 */
export function wouldExceedHourlyRate(
  limits: SellRateLimits | undefined,
  maxPerHour: number
): { exceeded: boolean; txCount: number; remaining: number } {
  const effective = getEffectiveRateLimits(limits);
  return {
    exceeded: effective.tx_count >= maxPerHour,
    txCount: effective.tx_count,
    remaining: Math.max(0, maxPerHour - effective.tx_count),
  };
}

/**
 * Compute the updated caps after a successful withdrawal
 * Returns new caps object to be persisted to ops.treasury_caps
 */
export function computeUpdatedCaps(
  caps: TreasuryCaps | undefined,
  amountSol: number
): TreasuryCaps {
  const effective = getEffectiveCaps(caps);
  return {
    day: effective.day,
    withdrawn_sol: effective.withdrawn_sol + amountSol,
    last_withdraw_at: nowIso(),
    withdraw_count: effective.withdraw_count + 1,
  };
}

/**
 * Compute the updated rate limits after a successful sell
 * Returns new rate limits object to be persisted to ops.sell_rate_limits
 */
export function computeUpdatedRateLimits(
  limits: SellRateLimits | undefined
): SellRateLimits {
  const effective = getEffectiveRateLimits(limits);
  return {
    hour_key: effective.hour_key,
    tx_count: effective.tx_count + 1,
    last_tx_at: nowIso(),
  };
}

// ==========================================
// Core Guardrail Gate
// ==========================================

/**
 * Main guardrail gate - all dangerous operations must pass through here
 */
export async function checkGuardrails(ctx: GuardrailContext): Promise<GuardrailResult> {
  const env = getEnv();
  const warnings: string[] = [];
  
  resetDailyStateIfNeeded();
  
  const destShort = ctx.destinationAddress ? `${ctx.destinationAddress.slice(0, 8)}...` : 'n/a';
  logger.info(`[Guardrails] Checking ${ctx.operation} operation (pack=${ctx.launchPackId || 'n/a'}, amount=${ctx.amount || 'n/a'}, dest=${destShort})`);
  
  try {
    // ==========================================
    // 1. Feature Flag Checks
    // ==========================================
    
    if (ctx.operation === 'sell') {
      if (!env.autoSellEnabled) {
        // Selling is only blocked if it's AUTO sell. Manual sells may be allowed.
        // Check if this is an auto-sell context
        if (ctx.actor === 'auto-sell-scheduler') {
          return {
            allowed: false,
            code: ErrorCodes.AUTO_SELL_NOT_ENABLED,
            reason: 'Auto-sell is disabled. Set AUTO_SELL_ENABLE=true to enable.',
          };
        }
      }
      
      if (env.AUTO_SELL_MODE === 'off' && ctx.actor === 'auto-sell-scheduler') {
        return {
          allowed: false,
          code: ErrorCodes.AUTO_SELL_NOT_ENABLED,
          reason: 'Auto-sell mode is set to "off".',
        };
      }
    }
    
    // ==========================================
    // 2. Withdraw/Sweep Destination Validation
    // ==========================================
    
    if (ctx.operation === 'withdraw' || ctx.operation === 'sweep') {
      // If treasury is enabled, withdrawals MUST go to treasury
      if (env.treasuryEnabled) {
        if (!env.TREASURY_ADDRESS) {
          return {
            allowed: false,
            code: ErrorCodes.TREASURY_ADDRESS_REQUIRED,
            reason: 'Treasury is enabled but TREASURY_ADDRESS is not configured.',
          };
        }
        
        // If destination specified, it MUST match treasury address
        if (ctx.destinationAddress && ctx.destinationAddress !== env.TREASURY_ADDRESS) {
          return {
            allowed: false,
            code: ErrorCodes.DESTINATION_NOT_ALLOWED,
            reason: 'When treasury is enabled, all withdrawals must go to TREASURY_ADDRESS. Custom destinations are not allowed.',
            auditEntry: `Blocked withdrawal to non-treasury address: ${ctx.destinationAddress.slice(0, 8)}...`,
          };
        }
      }
      
      // INVARIANT: Never withdraw to pump wallet itself
      if (ctx.destinationAddress && ctx.destinationAddress === env.PUMP_PORTAL_WALLET_ADDRESS) {
        return {
          allowed: false,
          code: ErrorCodes.INVARIANT_VIOLATION,
          reason: 'Cannot withdraw to the pump wallet itself.',
          auditEntry: 'Blocked invalid withdrawal attempt to pump wallet address',
        };
      }
      
      // Auto-withdraw specific checks
      if (ctx.actor === 'auto-withdraw-scheduler') {
        if (!env.autoWithdrawEnabled) {
          return {
            allowed: false,
            code: ErrorCodes.AUTO_WITHDRAW_NOT_ENABLED,
            reason: 'Auto-withdraw is disabled. Set AUTO_WITHDRAW_ENABLE=true to enable.',
          };
        }
      }
    }
    
    // ==========================================
    // 3. Daily Caps (prefer persistent, fallback to in-memory)
    // ==========================================
    
    if (ctx.operation === 'withdraw' || ctx.operation === 'sweep') {
      const amountSol = ctx.amountSol ?? ctx.amount ?? 0;
      
      // Use persistent caps if provided, otherwise fallback to in-memory (deprecated)
      let withdrawnToday: number;
      if (ctx.persistentCaps) {
        const effective = getEffectiveCaps(ctx.persistentCaps);
        withdrawnToday = effective.withdrawn_sol;
      } else {
        withdrawnToday = dailyState.withdrawnSol;
      }
      
      const remainingCap = env.WITHDRAW_MAX_SOL_PER_DAY - withdrawnToday;
      
      if (amountSol > remainingCap) {
        return {
          allowed: false,
          code: ErrorCodes.DAILY_CAP_EXCEEDED,
          reason: `Daily withdrawal cap exceeded. Max: ${env.WITHDRAW_MAX_SOL_PER_DAY} SOL/day, Already withdrawn: ${withdrawnToday.toFixed(4)} SOL, Remaining: ${remainingCap.toFixed(4)} SOL`,
          auditEntry: `Blocked withdrawal of ${amountSol} SOL - daily cap exceeded`,
          capDetails: {
            withdrawnToday,
            maxPerDay: env.WITHDRAW_MAX_SOL_PER_DAY,
            remaining: remainingCap,
            attemptedAmount: amountSol,
          },
        };
      }
      
      if (remainingCap < env.WITHDRAW_MAX_SOL_PER_DAY * 0.2) {
        warnings.push(`Daily withdrawal cap is ${(remainingCap / env.WITHDRAW_MAX_SOL_PER_DAY * 100).toFixed(0)}% remaining`);
      }
    }
    
    // ==========================================
    // 4. Sell-specific Checks
    // ==========================================
    
    if (ctx.operation === 'sell') {
      // Max percentage per transaction
      if (ctx.percentOfHolding !== undefined) {
        if (ctx.percentOfHolding > env.AUTO_SELL_MAX_PERCENT_PER_TX) {
          return {
            allowed: false,
            code: ErrorCodes.MAX_PERCENTAGE_EXCEEDED,
            reason: `Sell percentage exceeds maximum. Max: ${env.AUTO_SELL_MAX_PERCENT_PER_TX}%, Requested: ${ctx.percentOfHolding}%`,
          };
        }
      }
      
      // Hourly rate limits (use persistent if provided, otherwise skip for manual sells)
      if (ctx.actor === 'auto-sell-scheduler') {
        const maxTxPerHour = env.AUTO_SELL_MAX_TX_PER_HOUR || 10;
        if (ctx.persistentRateLimits) {
          const rateCheck = wouldExceedHourlyRate(ctx.persistentRateLimits, maxTxPerHour);
          if (rateCheck.exceeded) {
            return {
              allowed: false,
              code: ErrorCodes.HOURLY_RATE_EXCEEDED,
              reason: `Hourly sell rate limit exceeded. Max: ${maxTxPerHour} tx/hour, Current: ${rateCheck.txCount}, Remaining: ${rateCheck.remaining}`,
            };
          }
        }
      }
      
      // Cooldown between sells (for auto-sells)
      if (ctx.actor === 'auto-sell-scheduler' && dailyState.lastSellTime) {
        const cooldownMs = env.AUTO_SELL_COOLDOWN_SECONDS * 1000;
        const timeSinceLastSell = Date.now() - dailyState.lastSellTime;
        
        if (timeSinceLastSell < cooldownMs) {
          const remainingSeconds = Math.ceil((cooldownMs - timeSinceLastSell) / 1000);
          return {
            allowed: false,
            code: ErrorCodes.COOLDOWN_ACTIVE,
            reason: `Sell cooldown active. Wait ${remainingSeconds} more seconds.`,
          };
        }
      }
      
      // Slippage check
      if (ctx.slippage !== undefined) {
        const maxSlippage = typeof env.MAX_SLIPPAGE_PERCENT === 'number' ? env.MAX_SLIPPAGE_PERCENT : 5;
        if (ctx.slippage > maxSlippage) {
          return {
            allowed: false,
            code: ErrorCodes.SLIPPAGE_TOO_HIGH,
            reason: `Slippage ${ctx.slippage}% exceeds maximum ${maxSlippage}%`,
          };
        }
      }
    }
    
    // ==========================================
    // 5. Custody Checks for Withdrawals
    // ==========================================
    
    if (ctx.operation === 'withdraw' || ctx.operation === 'sweep') {
      // Check if we have the ability to sign transactions from pump wallet
      if (!env.PUMP_PORTAL_WALLET_SECRET) {
        // Without the secret, we can't sign withdrawals
        // Note: PumpPortal may provide a withdraw API in the future
        return {
          allowed: false,
          code: ErrorCodes.WITHDRAW_NOT_SUPPORTED,
          reason: 'PUMP_PORTAL_WALLET_SECRET not configured. Cannot sign withdrawal transactions. Either set the secret or use PumpPortal withdraw endpoint if available.',
          auditEntry: 'Withdrawal blocked - custody mode does not support signing',
        };
      }
    }
    
    // ==========================================
    // All checks passed
    // ==========================================
    
    const auditEntry = `Guardrails passed for ${ctx.operation}${ctx.launchPackId ? ` (pack: ${ctx.launchPackId})` : ''}${ctx.amount ? ` amount: ${ctx.amount}` : ''}`;
    
    return {
      allowed: true,
      auditEntry,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    
  } catch (error) {
    logger.error('[Guardrails] Unexpected error during check:', error);
    return {
      allowed: false,
      code: ErrorCodes.VALIDATION_FAILED,
      reason: `Guardrail check failed: ${(error as Error).message}`,
    };
  }
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Get the effective withdrawal destination
 * Returns treasury address if enabled, otherwise funding wallet address
 */
export function getWithdrawalDestination(): { address: string; type: 'treasury' | 'funding' } {
  const env = getEnv();
  
  if (env.treasuryEnabled && env.TREASURY_ADDRESS) {
    return { address: env.TREASURY_ADDRESS, type: 'treasury' };
  }
  
  // Default: funding wallet (we derive the address from the secret)
  // Note: actual address derivation happens in fundingWallet.ts
  return { address: 'funding-wallet', type: 'funding' };
}

/**
 * Check if treasury mode is active and configured
 */
export function isTreasuryMode(): boolean {
  const env = getEnv();
  return env.treasuryEnabled && !!env.TREASURY_ADDRESS;
}

/**
 * Check if we're in log-only mode for treasury operations
 */
export function isTreasuryLogOnly(): boolean {
  const env = getEnv();
  return env.treasuryEnabled && env.treasuryLogOnly;
}

/**
 * Check withdrawal readiness (can we execute withdrawals?)
 * Enhanced version with structured output including missingKeys
 */
export interface WithdrawalReadiness {
  ready: boolean;
  mode: 'pumpportal_withdraw' | 'local_signing' | 'unsupported';
  missingKeys: string[];
  reason?: string;
}

export function checkWithdrawalReadiness(): WithdrawalReadiness {
  const env = getEnv();
  const missingKeys: string[] = [];
  
  // Mode B: We have the pump wallet secret, can sign transactions
  if (env.PUMP_PORTAL_WALLET_SECRET) {
    return {
      ready: true,
      mode: 'local_signing',
      missingKeys: [],
    };
  }
  missingKeys.push('PUMP_PORTAL_WALLET_SECRET');
  
  // Mode A: Would use PumpPortal withdraw API (check if available)
  // PumpPortal might support a withdraw endpoint with API key
  if (env.PUMP_PORTAL_API_KEY && env.PUMP_PORTAL_WALLET_ADDRESS) {
    // TODO: Verify PumpPortal actually has withdraw endpoint
    // For now, we can't confirm this works without the endpoint existing
    // return { ready: true, mode: 'pumpportal_withdraw', missingKeys: [] };
  }
  
  // If we have API key but no wallet secret, add that as missing
  if (!env.PUMP_PORTAL_API_KEY) {
    missingKeys.push('PUMP_PORTAL_API_KEY');
  }
  
  return {
    ready: false,
    mode: 'unsupported',
    missingKeys,
    reason: 'No withdrawal method available. Set PUMP_PORTAL_WALLET_SECRET to enable local signing.',
  };
}

/**
 * Get withdrawal readiness for display/reporting
 */
export function getWithdrawalReadinessReport(): {
  ready: boolean;
  mode: string;
  missingKeys: string[];
  reason?: string;
  treasuryEnabled: boolean;
  treasuryAddress?: string;
  logOnly: boolean;
} {
  const env = getEnv();
  const readiness = checkWithdrawalReadiness();
  
  return {
    ...readiness,
    treasuryEnabled: env.treasuryEnabled,
    treasuryAddress: env.TREASURY_ADDRESS,
    logOnly: env.treasuryLogOnly,
  };
}

/**
 * Create audit log entries for guardrail operations
 */
export function createGuardrailAuditEntry(
  operation: OperationType,
  result: GuardrailResult,
  ctx: GuardrailContext
): string {
  const timestamp = nowIso();
  const status = result.allowed ? 'ALLOWED' : `BLOCKED:${result.code}`;
  
  let entry = `[${timestamp}] [Guardrail] ${operation.toUpperCase()} ${status}`;
  
  if (ctx.launchPackId) {
    entry += ` pack=${ctx.launchPackId.slice(0, 8)}`;
  }
  if (ctx.amount) {
    entry += ` amount=${ctx.amount}`;
  }
  if (!result.allowed && result.reason) {
    entry += ` reason="${result.reason.slice(0, 100)}"`;
  }
  
  return entry;
}

/**
 * Validate a Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  // Base58 pattern for Solana public keys (32-44 chars)
  const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Pattern.test(address);
}

/**
 * Ensure startup invariants are valid
 * Called during service initialization
 */
export function validateStartupInvariants(): { valid: boolean; errors: string[] } {
  const env = getEnv();
  const errors: string[] = [];
  
  // Treasury validation is already done in env.ts parseEnv
  
  // Check for conflicting configurations
  if (env.autoWithdrawEnabled && !env.treasuryEnabled) {
    // Auto-withdraw without treasury means funds go to funding wallet
    logger.warn('[Guardrails] AUTO_WITHDRAW_ENABLE=true but TREASURY_ENABLE=false - withdrawals will go to funding wallet');
  }
  
  if (env.autoSellEnabled && env.AUTO_SELL_MODE === 'autonomous' && !env.PUMP_PORTAL_API_KEY) {
    errors.push('AUTO_SELL_MODE=autonomous requires PUMP_PORTAL_API_KEY for trading');
  }
  
  // Validate that pump wallet address and treasury address are different
  if (env.PUMP_PORTAL_WALLET_ADDRESS && env.TREASURY_ADDRESS) {
    if (env.PUMP_PORTAL_WALLET_ADDRESS === env.TREASURY_ADDRESS) {
      errors.push('TREASURY_ADDRESS cannot be the same as PUMP_PORTAL_WALLET_ADDRESS');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
