/**
 * Treasury Scheduler
 * 
 * Handles automatic threshold-based sweeps from pump wallet to treasury.
 * This is DISABLED by default - only runs when:
 *   TREASURY_ENABLE=true AND AUTO_WITHDRAW_ENABLE=true
 * 
 * Production-safe features:
 * - Only starts if both flags are enabled
 * - Logs "disabled" only once at boot, not every interval
 * - Adds jitter to intervals to avoid synchronized spikes on deploy
 * - Uses claim-first pattern to prevent double-execution
 * - Persists caps to LaunchPack ops
 * 
 * The scheduler:
 * - Periodically checks pump wallet balance
 * - If balance > WITHDRAW_MIN_SOL, triggers a sweep
 * - Keeps WITHDRAW_KEEP_SOL as runway
 * - Enforces daily caps via guardrails
 * - Logs all operations for auditability
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { 
  executeSweepIfNeeded, 
  checkSweepTrigger 
} from './treasuryService.ts';
import { getDailyState, getEffectiveCaps } from './operatorGuardrails.ts';
import { nowIso } from './time.ts';

// ==========================================
// Scheduler State
// ==========================================

let schedulerInterval: NodeJS.Timeout | null = null;
let lastCheckTime: string | null = null;
let consecutiveErrors = 0;
let disabledLoggedOnce = false; // Only log "disabled" once per boot
const MAX_CONSECUTIVE_ERRORS = 5;

// Check interval: 15 minutes base (+/- 10% jitter)
const BASE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Add jitter to an interval to avoid synchronized spikes on deploy
 * Returns interval +/- 10%
 */
function getJitteredInterval(baseMs: number): number {
  const jitterPercent = 0.1; // 10%
  const jitter = baseMs * jitterPercent * (Math.random() * 2 - 1); // -10% to +10%
  return Math.floor(baseMs + jitter);
}

// ==========================================
// Scheduler Control
// ==========================================

/**
 * Check if scheduler should be enabled based on feature flags
 */
function shouldSchedulerRun(): boolean {
  const env = getEnv();
  // Require both TREASURY_ENABLE and AUTO_WITHDRAW_ENABLE
  return env.treasuryEnabled && env.autoWithdrawEnabled;
}

/**
 * Start the treasury sweep scheduler
 * Only starts if TREASURY_ENABLE=true AND AUTO_WITHDRAW_ENABLE=true
 */
export function startTreasuryScheduler(): void {
  const env = getEnv();
  
  // Gate: only start if enabled
  if (!shouldSchedulerRun()) {
    // Log only once at boot
    if (!disabledLoggedOnce) {
      if (!env.treasuryEnabled) {
        logger.info('[TreasuryScheduler] Not starting - TREASURY_ENABLE=false');
      } else if (!env.autoWithdrawEnabled) {
        logger.info('[TreasuryScheduler] Not starting - AUTO_WITHDRAW_ENABLE=false');
      }
      disabledLoggedOnce = true;
    }
    return;
  }
  
  if (schedulerInterval) {
    logger.warn('[TreasuryScheduler] Scheduler already running');
    return;
  }
  
  logger.info('[TreasuryScheduler] Starting treasury sweep scheduler');
  logger.info(`[TreasuryScheduler] Config: min=${env.WITHDRAW_MIN_SOL} SOL, keep=${env.WITHDRAW_KEEP_SOL} SOL, daily_cap=${env.WITHDRAW_MAX_SOL_PER_DAY} SOL`);
  
  // Run initial check after a jittered short delay (25-35 seconds)
  const initialDelay = getJitteredInterval(30 * 1000);
  setTimeout(async () => {
    await runScheduledCheck();
  }, initialDelay);
  
  // Set up recurring interval with jitter
  const interval = getJitteredInterval(BASE_CHECK_INTERVAL_MS);
  schedulerInterval = setInterval(async () => {
    await runScheduledCheck();
  }, interval);
  
  logger.info(`[TreasuryScheduler] Scheduler started (interval: ${Math.round(interval / 1000)}s with jitter)`);
}

/**
 * Stop the treasury sweep scheduler
 */
export function stopTreasuryScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[TreasuryScheduler] Scheduler stopped');
  }
}

/**
 * Check if the scheduler is currently running
 */
export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null;
}

/**
 * Get scheduler status for monitoring
 */
export function getSchedulerStatus(): {
  running: boolean;
  lastCheck: string | null;
  consecutiveErrors: number;
  dailyState: ReturnType<typeof getDailyState>;
} {
  return {
    running: isSchedulerRunning(),
    lastCheck: lastCheckTime,
    consecutiveErrors,
    dailyState: getDailyState(),
  };
}

// ==========================================
// Scheduled Check
// ==========================================

/**
 * Run a single scheduled sweep check
 * Returns immediately without DB writes or RPC calls if disabled
 */
async function runScheduledCheck(): Promise<void> {
  // Double-check enablement at runtime (in case flags changed)
  if (!shouldSchedulerRun()) {
    // Don't log every interval - just return silently
    return;
  }
  
  const env = getEnv();
  lastCheckTime = nowIso();
  
  try {
    logger.debug('[TreasuryScheduler] Running sweep check...');
    
    // First, just check if a sweep is warranted
    const checkResult = await checkSweepTrigger();
    
    if (!checkResult.shouldSweep) {
      logger.debug(`[TreasuryScheduler] No sweep needed: ${checkResult.reason}`);
      consecutiveErrors = 0; // Reset on successful check
      return;
    }
    
    logger.info(`[TreasuryScheduler] Sweep triggered: ${checkResult.reason}`);
    logger.info(`[TreasuryScheduler] Current balance: ${checkResult.currentBalance.toFixed(4)} SOL, Withdrawable: ${checkResult.withdrawableAmount.toFixed(4)} SOL`);
    
    // Check daily state before proceeding
    const dailyState = getDailyState();
    const remainingCap = env.WITHDRAW_MAX_SOL_PER_DAY - dailyState.withdrawnSol;
    
    if (remainingCap <= 0) {
      logger.info(`[TreasuryScheduler] Daily cap reached (${dailyState.withdrawnSol.toFixed(4)}/${env.WITHDRAW_MAX_SOL_PER_DAY} SOL) - skipping`);
      return;
    }
    
    // Execute sweep (treasury service handles log-only mode)
    const result = await executeSweepIfNeeded();
    
    if (result.executed && result.result) {
      logger.info(`[TreasuryScheduler] ✅ Sweep executed: ${result.result.withdrawn.toFixed(4)} SOL to ${result.result.destinationType}`);
      if (result.result.signature) {
        logger.info(`[TreasuryScheduler] Transaction: ${result.result.signature}`);
      }
      
      // Notify admin of withdrawal
      try {
        const { notifyWithdrawal } = await import('./adminNotify.ts');
        await notifyWithdrawal({
          amount: result.result.withdrawn,
          destination: result.result.destination,
          destinationType: result.result.destinationType,
          txSignature: result.result.signature,
          remainingBalance: result.checkResult?.newBalance,
        });
      } catch {
        // Non-fatal
      }
      
      // Announce to Nova channel
      try {
        const { announceWalletActivity } = await import('./novaChannel.ts');
        await announceWalletActivity({
          type: 'withdraw',
          amount: result.result.withdrawn,
          destination: result.result.destination,
          txSignature: result.result.signature,
        });
      } catch {
        // Non-fatal
      }
    } else if (result.result?.logOnly) {
      logger.info(`[TreasuryScheduler] [LOG_ONLY] Would sweep: ${result.result.withdrawn.toFixed(4)} SOL`);
    } else {
      logger.debug(`[TreasuryScheduler] Sweep not executed: ${result.checkResult.reason}`);
    }
    
    consecutiveErrors = 0;
    
  } catch (error) {
    consecutiveErrors += 1;
    logger.error(`[TreasuryScheduler] Check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
    
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      logger.error(`[TreasuryScheduler] Too many consecutive errors - stopping scheduler`);
      
      // Notify admin of critical failure
      try {
        const { notifyError } = await import('./adminNotify.ts');
        await notifyError(
          'TreasuryScheduler',
          `Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS}). Scheduler stopped.`,
          error
        );
      } catch {
        // Non-fatal
      }
      
      stopTreasuryScheduler();
    }
  }
}

/**
 * Force a manual sweep check (for testing/debugging)
 */
export async function forceSweepCheck(): Promise<{
  executed: boolean;
  message: string;
  details?: any;
}> {
  const env = getEnv();
  
  if (!env.autoWithdrawEnabled && !env.treasuryEnabled) {
    return {
      executed: false,
      message: 'Neither treasury nor auto-withdraw is enabled',
    };
  }
  
  try {
    const result = await executeSweepIfNeeded({ force: true });
    
    if (result.executed && result.result) {
      return {
        executed: true,
        message: `Swept ${result.result.withdrawn.toFixed(4)} SOL to ${result.result.destinationType}`,
        details: result.result,
      };
    } else if (result.result?.logOnly) {
      return {
        executed: false,
        message: `[LOG_ONLY] Would sweep ${result.result.withdrawn.toFixed(4)} SOL`,
        details: result.result,
      };
    } else {
      return {
        executed: false,
        message: result.checkResult.reason,
        details: result.checkResult,
      };
    }
  } catch (error) {
    return {
      executed: false,
      message: `Sweep failed: ${(error as Error).message}`,
    };
  }
}
