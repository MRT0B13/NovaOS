/**
 * Auto-Sell Policy Service
 * 
 * Handles the plumbing for auto-selling tokens based on take-profit policies.
 * This is DISABLED by default - no autonomous trading occurs without explicit enablement.
 * 
 * Features:
 * - Policy parsing and validation
 * - Take-profit ladder evaluation
 * - Trailing stop detection
 * - Time-based exit triggers
 * - Manual approval mode (creates intents, doesn't execute)
 * 
 * The actual trading execution uses existing primitives in fundingWallet.ts.
 */

import { logger } from '@elizaos/core';
import { z } from 'zod';
import { getEnv } from '../env.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import {
  checkGuardrails,
  recordSell,
  ErrorCodes,
  GuardrailError,
} from './operatorGuardrails.ts';

// ==========================================
// Types
// ==========================================

export interface TakeProfitLevel {
  threshold_x: number;  // e.g., 2 = 2x gain
  sell_percent: number; // e.g., 20 = sell 20%
  executed?: boolean;
  executed_at?: string;
  tx_signature?: string;
}

export interface TrailingStopConfig {
  enabled: boolean;
  activate_at_x?: number;   // Activate after this gain (e.g., 2 = 2x)
  drop_percent?: number;    // Trigger if drops this % from peak
  sell_percent?: number;    // How much to sell when triggered
}

export interface TimeStopConfig {
  enabled: boolean;
  hours_inactive?: number;  // Trigger after this many hours of low activity
  sell_percent?: number;    // How much to sell
}

export interface SellPolicy {
  enabled: boolean;
  take_profit_levels: TakeProfitLevel[];
  trailing_stop?: TrailingStopConfig;
  time_stop?: TimeStopConfig;
  moonbag_percent?: number;  // Tokens to hold indefinitely
  validation_error?: string;
}

export interface SellState {
  last_check_at?: string;
  next_check_at?: string;
  peak_price_sol?: number;
  peak_seen_at?: string;
  entry_price_sol?: number;
  current_price_sol?: number;
  current_price_at?: string;
  executed_sells: Array<{
    at: string;
    trigger: string;
    percent_sold: number;
    amount_tokens?: number;
    amount_sol_received?: number;
    tx_signature?: string;
    status: 'success' | 'failed' | 'pending';
    error?: string;
  }>;
  pending_intent?: {
    trigger: string;
    percent_to_sell: number;
    reason: string;
    created_at: string;
    notified?: boolean;
  };
  tokens_held?: number;
  tokens_sold?: number;
  total_sol_received?: number;
}

export interface PolicyEvaluationResult {
  should_sell: boolean;
  trigger?: string;
  percent_to_sell?: number;
  reason?: string;
  is_manual_approve?: boolean;
}

// ==========================================
// Default Policy
// ==========================================

/**
 * Default deterministic policy when AUTO_SELL_POLICY_JSON is not provided
 */
export const DEFAULT_SELL_POLICY: SellPolicy = {
  enabled: false, // Disabled by default
  take_profit_levels: [
    { threshold_x: 2, sell_percent: 20 },  // TP1: sell 20% at 2x
    { threshold_x: 4, sell_percent: 20 },  // TP2: sell 20% at 4x
    { threshold_x: 8, sell_percent: 20 },  // TP3: sell 20% at 8x
  ],
  trailing_stop: {
    enabled: true,
    activate_at_x: 2,      // Activate after 2x
    drop_percent: 35,      // Trigger if -35% from peak
    sell_percent: 30,      // Sell 30%
  },
  time_stop: {
    enabled: false,        // Disabled by default
    hours_inactive: 24,    // If no volume/movement for 24 hours
    sell_percent: 50,      // Exit half position
  },
  moonbag_percent: 20,     // Keep 20% indefinitely
};

// ==========================================
// Policy Parsing & Validation
// ==========================================

const policyJsonSchema = z.object({
  take_profit: z.array(z.object({
    at_x: z.number().min(1.1),
    sell: z.number().min(1).max(100),
  })).optional(),
  trailing_stop: z.object({
    activate_x: z.number().optional(),
    drop_percent: z.number().optional(),
    sell_percent: z.number().optional(),
  }).optional(),
  time_stop: z.object({
    hours: z.number().optional(),
    sell_percent: z.number().optional(),
  }).optional(),
  moonbag: z.number().min(0).max(100).optional(),
}).passthrough();

/**
 * Parse and validate a policy from JSON string
 */
export function parsePolicyFromJson(jsonString: string): SellPolicy {
  try {
    const raw = JSON.parse(jsonString);
    const parsed = policyJsonSchema.parse(raw);
    
    // Convert to internal format
    const levels: TakeProfitLevel[] = (parsed.take_profit || [])
      .map(tp => ({
        threshold_x: tp.at_x,
        sell_percent: tp.sell,
      }))
      .sort((a, b) => a.threshold_x - b.threshold_x);
    
    // Validate: percentages should sum to <= 100%
    const totalPercent = levels.reduce((sum, l) => sum + l.sell_percent, 0) 
      + (parsed.moonbag ?? 0);
    
    if (totalPercent > 100) {
      return {
        ...DEFAULT_SELL_POLICY,
        enabled: false,
        validation_error: `Total sell percentages (${totalPercent}%) exceed 100%`,
      };
    }
    
    // Validate: thresholds must be ordered
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].threshold_x <= levels[i-1].threshold_x) {
        return {
          ...DEFAULT_SELL_POLICY,
          enabled: false,
          validation_error: 'Take-profit thresholds must be in ascending order',
        };
      }
    }
    
    return {
      enabled: true,
      take_profit_levels: levels,
      trailing_stop: parsed.trailing_stop ? {
        enabled: true,
        activate_at_x: parsed.trailing_stop.activate_x,
        drop_percent: parsed.trailing_stop.drop_percent,
        sell_percent: parsed.trailing_stop.sell_percent,
      } : DEFAULT_SELL_POLICY.trailing_stop,
      time_stop: parsed.time_stop ? {
        enabled: true,
        hours_inactive: parsed.time_stop.hours,
        sell_percent: parsed.time_stop.sell_percent,
      } : DEFAULT_SELL_POLICY.time_stop,
      moonbag_percent: parsed.moonbag ?? DEFAULT_SELL_POLICY.moonbag_percent,
    };
    
  } catch (error) {
    logger.error('[AutoSell] Failed to parse policy JSON:', error);
    return {
      ...DEFAULT_SELL_POLICY,
      enabled: false,
      validation_error: `Invalid policy JSON: ${(error as Error).message}`,
    };
  }
}

/**
 * Get the effective sell policy from environment
 */
export function getEffectivePolicy(): SellPolicy {
  const env = getEnv();
  
  if (!env.autoSellEnabled) {
    return { ...DEFAULT_SELL_POLICY, enabled: false };
  }
  
  if (env.AUTO_SELL_POLICY_JSON) {
    const parsed = parsePolicyFromJson(env.AUTO_SELL_POLICY_JSON);
    // Override enabled based on env
    return {
      ...parsed,
      enabled: env.AUTO_SELL_MODE !== 'off',
    };
  }
  
  return {
    ...DEFAULT_SELL_POLICY,
    enabled: env.AUTO_SELL_MODE !== 'off',
  };
}

// ==========================================
// Policy Evaluation
// ==========================================

/**
 * Evaluate if a sell should be triggered based on current conditions
 */
export function evaluatePolicy(
  policy: SellPolicy,
  state: SellState,
  currentPrice: number,
  entryPrice: number
): PolicyEvaluationResult {
  const env = getEnv();
  
  if (!policy.enabled) {
    return { should_sell: false, reason: 'Policy disabled' };
  }
  
  const gain = currentPrice / entryPrice;
  const moonbag = policy.moonbag_percent ?? 0;
  
  // Calculate how much has already been sold
  const totalSold = state.executed_sells
    .filter(s => s.status === 'success')
    .reduce((sum, s) => sum + s.percent_sold, 0);
  
  const remainingToSell = 100 - moonbag - totalSold;
  
  if (remainingToSell <= 0) {
    return { should_sell: false, reason: 'Already at moonbag level' };
  }
  
  // Check take-profit levels
  for (const level of policy.take_profit_levels) {
    if (level.executed) continue;
    
    if (gain >= level.threshold_x) {
      const percentToSell = Math.min(level.sell_percent, remainingToSell);
      return {
        should_sell: true,
        trigger: `TP${policy.take_profit_levels.indexOf(level) + 1}`,
        percent_to_sell: percentToSell,
        reason: `Take-profit at ${level.threshold_x}x triggered (current: ${gain.toFixed(2)}x)`,
        is_manual_approve: env.AUTO_SELL_MODE === 'manual_approve',
      };
    }
  }
  
  // Check trailing stop
  if (policy.trailing_stop?.enabled) {
    const peakPrice = state.peak_price_sol ?? currentPrice;
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
    const activationThreshold = policy.trailing_stop.activate_at_x ?? 2;
    
    if (gain >= activationThreshold && dropFromPeak >= (policy.trailing_stop.drop_percent ?? 35)) {
      const percentToSell = Math.min(
        policy.trailing_stop.sell_percent ?? 30,
        remainingToSell
      );
      return {
        should_sell: true,
        trigger: 'trailing_stop',
        percent_to_sell: percentToSell,
        reason: `Trailing stop triggered: ${dropFromPeak.toFixed(1)}% drop from peak`,
        is_manual_approve: env.AUTO_SELL_MODE === 'manual_approve',
      };
    }
  }
  
  // Check time stop (not implemented in detail - would need volume data)
  // This is a placeholder for the data model
  
  return { should_sell: false };
}

/**
 * Create a pending sell intent (for manual_approve mode)
 */
export function createPendingIntent(
  result: PolicyEvaluationResult,
  launchPackId: string
): SellState['pending_intent'] {
  if (!result.should_sell || !result.trigger) {
    return undefined;
  }
  
  return {
    trigger: result.trigger,
    percent_to_sell: result.percent_to_sell!,
    reason: result.reason!,
    created_at: nowIso(),
    notified: false,
  };
}

// ==========================================
// Scheduler Stub
// ==========================================

let autoSellInterval: NodeJS.Timeout | null = null;
let autoSellDisabledLoggedOnce = false; // Only log "disabled" once per boot

/**
 * Add jitter to an interval to avoid synchronized spikes on deploy
 * Returns interval +/- 10%
 */
function getJitteredIntervalMs(baseMs: number): number {
  const jitterPercent = 0.1;
  const jitter = baseMs * jitterPercent * (Math.random() * 2 - 1);
  return Math.floor(baseMs + jitter);
}

/**
 * Check if auto-sell scheduler should run
 */
function shouldAutoSellRun(): boolean {
  const env = getEnv();
  return env.autoSellEnabled && env.AUTO_SELL_MODE !== 'off';
}

/**
 * Start the auto-sell scheduler (evaluates policies periodically)
 * Only starts if AUTO_SELL_ENABLE=true AND AUTO_SELL_MODE != 'off'
 */
export function startAutoSellScheduler(): void {
  const env = getEnv();
  
  if (!shouldAutoSellRun()) {
    // Log only once at boot
    if (!autoSellDisabledLoggedOnce) {
      logger.info('[AutoSell] Scheduler not started - auto-sell is disabled or mode is off');
      autoSellDisabledLoggedOnce = true;
    }
    return;
  }
  
  if (autoSellInterval) {
    logger.warn('[AutoSell] Scheduler already running');
    return;
  }
  
  // Check every 5 minutes with jitter
  const baseIntervalMs = 5 * 60 * 1000;
  const intervalMs = getJitteredIntervalMs(baseIntervalMs);
  
  logger.info(`[AutoSell] Starting scheduler (mode: ${env.AUTO_SELL_MODE}, interval: ${Math.round(intervalMs / 1000)}s)`);
  
  autoSellInterval = setInterval(async () => {
    await runAutoSellCheck();
  }, intervalMs);
}

/**
 * Stop the auto-sell scheduler
 */
export function stopAutoSellScheduler(): void {
  if (autoSellInterval) {
    clearInterval(autoSellInterval);
    autoSellInterval = null;
    logger.info('[AutoSell] Scheduler stopped');
  }
}

/**
 * Run a single auto-sell check cycle
 * This would be called by the scheduler
 * Returns immediately without DB/RPC calls if disabled
 */
export async function runAutoSellCheck(): Promise<void> {
  // Double-check at runtime (in case flags changed)
  if (!shouldAutoSellRun()) {
    // Don't log every interval - just return silently
    return;
  }
  
  const env = getEnv();
  
  logger.debug('[AutoSell] Running scheduled check...');
  
  // In manual_approve mode, we would:
  // 1. Fetch launched tokens
  // 2. Check current prices
  // 3. Evaluate policies
  // 4. Create pending intents (not execute)
  // 5. Notify via TG if configured
  
  // In autonomous mode, we would also execute trades
  // But we don't have the trading primitives enabled by default
  
  logger.debug(`[AutoSell] Check complete (mode: ${env.AUTO_SELL_MODE})`);
  
  // TODO: Implement actual check logic when trading primitives are available
  // For now, this is just the scheduler plumbing
}

// ==========================================
// Execution Safety
// ==========================================

/**
 * Validate a sell operation before execution
 */
export async function validateSellOperation(
  mintAddress: string,
  percentToSell: number,
  slippage: number,
  launchPackId?: string
): Promise<{ valid: boolean; error?: string }> {
  const env = getEnv();
  
  // Check guardrails
  const guardrailResult = await checkGuardrails({
    operation: 'sell',
    mintAddress,
    percentOfHolding: percentToSell,
    slippage,
    launchPackId,
    actor: 'auto-sell-scheduler',
  });
  
  if (!guardrailResult.allowed) {
    return {
      valid: false,
      error: `${guardrailResult.code}: ${guardrailResult.reason}`,
    };
  }
  
  // Max sell per tx
  if (percentToSell > env.AUTO_SELL_MAX_PERCENT_PER_TX) {
    return {
      valid: false,
      error: `Sell percentage ${percentToSell}% exceeds max ${env.AUTO_SELL_MAX_PERCENT_PER_TX}%`,
    };
  }
  
  // Slippage cap
  const maxSlippage = typeof env.MAX_SLIPPAGE_PERCENT === 'number' ? env.MAX_SLIPPAGE_PERCENT : 5;
  if (slippage > maxSlippage) {
    return {
      valid: false,
      error: `Slippage ${slippage}% exceeds max ${maxSlippage}%`,
    };
  }
  
  return { valid: true };
}

/**
 * Add jitter to cooldown to avoid predictable patterns
 */
export function getJitteredCooldown(baseSeconds: number): number {
  // Add 0-50% jitter
  const jitter = baseSeconds * 0.5 * Math.random();
  return Math.floor(baseSeconds + jitter);
}
