import { logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import { notifyError } from './adminNotify.ts';
import { recordMessageReceivedPersistent, getTotalMessagesReceived } from './systemReporter.ts';
import { getEnv } from '../env.ts';

/**
 * Telegram Health Monitor
 * 
 * Tracks when Nova last received/sent messages via Telegram
 * and alerts admin if the bot appears stuck or disconnected.
 * 
 * The ElizaOS Telegram plugin can silently drop its connection,
 * leaving scheduled tasks running but message handling dead.
 * 
 * NEW: Auto-restart capability - attempts to restart Telegram polling
 * if connection appears dead for too long.
 */

interface TelegramHealthState {
  lastMessageReceived: Date | null;
  lastMessageSent: Date | null;
  lastAdminAlert: Date | null;
  lastRestartAttempt: Date | null;
  restartAttempts: number;
  messageCount: number;
  isHealthy: boolean;
}

const state: TelegramHealthState = {
  lastMessageReceived: null,
  lastMessageSent: null,
  lastAdminAlert: null,
  lastRestartAttempt: null,
  restartAttempts: 0,
  messageCount: 0,
  isHealthy: true,
};

// Alert if no messages received in this time (30 minutes)
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
// Attempt restart if no messages for 45 minutes
const RESTART_THRESHOLD_MS = 45 * 60 * 1000;
// Don't spam alerts - wait at least 2 hours between alerts
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Wait at least 30 min between restart attempts
const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
// Max restart attempts before giving up (resets on success)
const MAX_RESTART_ATTEMPTS = 3;

let healthCheckInterval: NodeJS.Timeout | null = null;
let runtimeRef: IAgentRuntime | null = null;

/**
 * Record that a message was received from Telegram
 * Call this from message handlers/events
 */
export function recordMessageReceived(): void {
  state.lastMessageReceived = new Date();
  state.messageCount++;
  state.isHealthy = true;
  
  // Also persist to metrics file
  recordMessageReceivedPersistent();
  
  // Reset restart attempts on successful message - connection is working
  if (state.restartAttempts > 0) {
    logger.info(`[TelegramHealth] ✅ Connection recovered after ${state.restartAttempts} restart attempt(s)`);
    state.restartAttempts = 0;
  }
}

/**
 * Record that a message was sent to Telegram
 * Call this from send functions
 */
export function recordMessageSent(): void {
  state.lastMessageSent = new Date();
  state.isHealthy = true;
}

/**
 * Attempt to restart the Telegram polling connection
 * Disabled when TG_DISABLE_AUTO_RESTART=true (for webhook mode)
 */
async function attemptRestart(): Promise<boolean> {
  // Check if auto-restart is disabled (e.g., when using webhooks)
  const env = getEnv();
  if (env.TG_DISABLE_AUTO_RESTART === 'true') {
    logger.debug('[TelegramHealth] Auto-restart disabled (TG_DISABLE_AUTO_RESTART=true)');
    return false;
  }
  
  if (!runtimeRef) {
    logger.warn('[TelegramHealth] Cannot restart - no runtime reference');
    return false;
  }
  
  const now = Date.now();
  
  // Check restart cooldown
  if (state.lastRestartAttempt && 
      now - state.lastRestartAttempt.getTime() < RESTART_COOLDOWN_MS) {
    return false;
  }
  
  // Check max attempts
  if (state.restartAttempts >= MAX_RESTART_ATTEMPTS) {
    logger.error(`[TelegramHealth] ❌ Exhausted ${MAX_RESTART_ATTEMPTS} restart attempts - manual intervention required`);
    return false;
  }
  
  state.lastRestartAttempt = new Date();
  state.restartAttempts++;
  
  logger.warn(`[TelegramHealth] 🔄 Attempting Telegram restart (attempt ${state.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
  
  try {
    const telegramService = runtimeRef.getService('telegram') as any;
    
    if (!telegramService) {
      logger.error('[TelegramHealth] No Telegram service found');
      return false;
    }
    
    const bot = telegramService.messageManager?.bot;
    
    if (!bot) {
      logger.error('[TelegramHealth] No bot instance found');
      return false;
    }
    
    // Stop current polling
    try {
      await bot.stop();
      logger.info('[TelegramHealth] Stopped existing polling');
    } catch (stopErr: any) {
      logger.debug(`[TelegramHealth] Stop error (may be ok): ${stopErr.message}`);
    }
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Restart polling
    bot.launch({ dropPendingUpdates: false }).catch((err: any) => {
      logger.error(`[TelegramHealth] Restart launch error: ${err.message}`);
    });
    
    logger.info('[TelegramHealth] ✅ Restarted Telegram polling');
    
    await notifyError({
      source: 'TelegramHealth',
      error: `Telegram connection restarted (attempt ${state.restartAttempts})`,
      context: 'The bot detected a stale connection and automatically restarted polling.',
      severity: 'low',
    });
    
    return true;
  } catch (err: any) {
    logger.error(`[TelegramHealth] Restart failed: ${err.message}`);
    return false;
  }
}

/**
 * Check Telegram health and alert if needed
 */
async function checkHealth(): Promise<void> {
  const now = Date.now();
  
  // If we've never received a message, skip (bot might just be starting)
  if (!state.lastMessageReceived) {
    return;
  }
  
  const timeSinceLastReceived = now - state.lastMessageReceived.getTime();
  
  // If we've received a message recently, we're healthy
  if (timeSinceLastReceived < STALE_THRESHOLD_MS) {
    state.isHealthy = true;
    return;
  }
  
  // We haven't received messages in a while - might be disconnected
  state.isHealthy = false;
  
  const minutesAgo = Math.round(timeSinceLastReceived / 60000);
  
  // If past restart threshold, attempt restart
  if (timeSinceLastReceived >= RESTART_THRESHOLD_MS) {
    const restarted = await attemptRestart();
    if (restarted) {
      return; // Don't also alert on same check
    }
  }
  
  // Check if we should alert
  const shouldAlert = !state.lastAdminAlert || 
    (now - state.lastAdminAlert.getTime() >= ALERT_COOLDOWN_MS);
  
  if (shouldAlert) {
    logger.warn(`[TelegramHealth] ⚠️ No messages received in ${minutesAgo} minutes - bot may be disconnected`);
    
    const restartInfo = state.restartAttempts > 0 
      ? `\n\nRestart attempts: ${state.restartAttempts}/${MAX_RESTART_ATTEMPTS}`
      : '';
    
    await notifyError({
      source: 'TelegramHealth',
      error: `No messages received in ${minutesAgo} minutes`,
      context: `The Telegram bot may have lost its connection. Consider restarting if this persists.${restartInfo}`,
      severity: 'medium',
    });
    
    state.lastAdminAlert = new Date();
  }
}

/**
 * Start the health monitor
 * @param runtime - The agent runtime (optional, enables auto-restart)
 */
export function startTelegramHealthMonitor(runtime?: IAgentRuntime): void {
  if (healthCheckInterval) {
    return; // Already running
  }
  
  // Store runtime reference for restart capability
  if (runtime) {
    runtimeRef = runtime;
    logger.info('[TelegramHealth] Runtime reference stored - auto-restart enabled');
  }
  
  // Check every 5 minutes
  healthCheckInterval = setInterval(checkHealth, 5 * 60 * 1000);
  
  logger.info('[TelegramHealth] ✅ Started (will alert if no messages for 30min, auto-restart after 45min)');
}

/**
 * Stop the health monitor
 */
export function stopTelegramHealthMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Get current health status
 */
export function getTelegramHealthStatus(): {
  isHealthy: boolean;
  lastMessageReceived: Date | null;
  lastMessageSent: Date | null;
  messageCount: number;
  minutesSinceLastMessage: number | null;
} {
  const minutesSinceLastMessage = state.lastMessageReceived
    ? Math.round((Date.now() - state.lastMessageReceived.getTime()) / 60000)
    : null;
  
  return {
    isHealthy: state.isHealthy,
    lastMessageReceived: state.lastMessageReceived,
    lastMessageSent: state.lastMessageSent,
    messageCount: state.messageCount,
    minutesSinceLastMessage,
  };
}
