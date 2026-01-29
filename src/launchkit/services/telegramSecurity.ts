import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { recordFailedAttempt } from './systemReporter.ts';

/**
 * Telegram Security Service
 * 
 * Provides authentication and authorization for Telegram commands:
 * - Admin verification: Only users in TELEGRAM_ADMIN_IDS can run sensitive commands
 * - Webhook signature: Validates requests are actually from Telegram
 * - Audit logging: Records all admin command attempts
 */

// ============================================================================
// Types
// ============================================================================

export interface AdminCommandLog {
  timestamp: number;
  userId: number;
  username?: string;
  chatId: number;
  command: string;
  args?: string;
  allowed: boolean;
  reason?: string;
}

// ============================================================================
// State
// ============================================================================

let adminIds: Set<number> | null = null;
let webhookSecret: string | null = null;
const commandLog: AdminCommandLog[] = [];
const MAX_LOG_SIZE = 1000;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize security settings from environment
 */
export function initTelegramSecurity(): void {
  const env = getEnv();
  
  // Parse admin IDs
  if (env.TELEGRAM_ADMIN_IDS) {
    const ids = env.TELEGRAM_ADMIN_IDS
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n));
    
    adminIds = new Set(ids);
    logger.info(`[TG Security] ✅ Admin IDs configured: ${ids.length} admin(s)`);
  } else {
    adminIds = null;
    logger.warn('[TG Security] ⚠️ No TELEGRAM_ADMIN_IDS configured - admin commands will be OPEN to anyone!');
  }
  
  // Store webhook secret
  if (env.TG_WEBHOOK_SECRET) {
    webhookSecret = env.TG_WEBHOOK_SECRET;
    logger.info('[TG Security] ✅ Webhook secret configured');
  } else {
    webhookSecret = null;
    logger.warn('[TG Security] ⚠️ No TG_WEBHOOK_SECRET configured - webhook requests are NOT verified!');
  }
}

// ============================================================================
// Admin Verification
// ============================================================================

/**
 * Check if a user ID is an admin
 * Returns true if:
 * 1. User ID is in TELEGRAM_ADMIN_IDS list, OR
 * 2. No admin IDs configured (open mode - logs warning)
 */
export function isAdmin(userId: number): boolean {
  // If not initialized, initialize now
  if (adminIds === null && webhookSecret === null) {
    initTelegramSecurity();
  }
  
  // If no admin IDs configured, allow all (but warn)
  if (!adminIds || adminIds.size === 0) {
    return true; // Open mode - caller should handle this case
  }
  
  return adminIds.has(userId);
}

/**
 * Check if admin security is configured
 */
export function isAdminSecurityEnabled(): boolean {
  if (adminIds === null) {
    initTelegramSecurity();
  }
  return adminIds !== null && adminIds.size > 0;
}

/**
 * Get the list of admin IDs (for debugging)
 */
export function getAdminIds(): number[] {
  if (adminIds === null) {
    initTelegramSecurity();
  }
  return adminIds ? Array.from(adminIds) : [];
}

/**
 * Add an admin ID at runtime (useful for setup)
 */
export function addAdminId(userId: number): void {
  if (adminIds === null) {
    adminIds = new Set();
  }
  adminIds.add(userId);
  logger.info(`[TG Security] Added admin ID: ${userId}`);
}

// ============================================================================
// Webhook Signature Verification
// ============================================================================

/**
 * Verify a webhook request signature
 * Returns true if:
 * 1. The X-Telegram-Bot-Api-Secret-Token header matches TG_WEBHOOK_SECRET, OR
 * 2. No secret configured (open mode - logs warning)
 */
export function verifyWebhookSignature(headers: Record<string, string | string[] | undefined>): boolean {
  // If not initialized, initialize now
  if (adminIds === null && webhookSecret === null) {
    initTelegramSecurity();
  }
  
  // If no secret configured, allow all (but this was warned at startup)
  if (!webhookSecret) {
    return true;
  }
  
  // Get the token from headers (case-insensitive)
  const headerKey = Object.keys(headers).find(
    k => k.toLowerCase() === 'x-telegram-bot-api-secret-token'
  );
  
  const providedToken = headerKey ? headers[headerKey] : undefined;
  
  // Handle array case (shouldn't happen but be safe)
  const tokenValue = Array.isArray(providedToken) ? providedToken[0] : providedToken;
  
  if (!tokenValue) {
    logger.warn('[TG Security] 🚨 Webhook request missing secret token header');
    return false;
  }
  
  // Constant-time comparison to prevent timing attacks
  if (tokenValue.length !== webhookSecret.length) {
    logger.warn('[TG Security] 🚨 Webhook secret token length mismatch');
    return false;
  }
  
  let mismatch = 0;
  for (let i = 0; i < webhookSecret.length; i++) {
    mismatch |= tokenValue.charCodeAt(i) ^ webhookSecret.charCodeAt(i);
  }
  
  if (mismatch !== 0) {
    logger.warn('[TG Security] 🚨 Webhook secret token mismatch - rejecting request');
    return false;
  }
  
  return true;
}

/**
 * Check if webhook security is configured
 */
export function isWebhookSecurityEnabled(): boolean {
  if (webhookSecret === null && adminIds === null) {
    initTelegramSecurity();
  }
  return webhookSecret !== null && webhookSecret.length > 0;
}

// ============================================================================
// Audit Logging
// ============================================================================

/**
 * Log an admin command attempt
 */
export function logAdminCommand(log: AdminCommandLog): void {
  commandLog.push(log);
  
  // Trim log if too large
  if (commandLog.length > MAX_LOG_SIZE) {
    commandLog.splice(0, commandLog.length - MAX_LOG_SIZE);
  }
  
  // Also log to console
  const status = log.allowed ? '✅' : '🚨';
  const user = log.username ? `@${log.username}` : `user:${log.userId}`;
  logger.info(`[TG Security] ${status} ${user} ran /${log.command}${log.args ? ' ' + log.args : ''} in chat ${log.chatId} - ${log.allowed ? 'ALLOWED' : 'DENIED: ' + log.reason}`);
  
  // Persist failed attempts to JSON for reporting
  if (!log.allowed) {
    recordFailedAttempt({
      timestamp: log.timestamp,
      userId: log.userId,
      username: log.username,
      chatId: log.chatId,
      command: log.command,
      args: log.args,
    });
  }
}

/**
 * Get recent admin command logs
 */
export function getAdminCommandLogs(limit: number = 50): AdminCommandLog[] {
  return commandLog.slice(-limit);
}

/**
 * Get failed command attempts (for security monitoring)
 */
export function getFailedAttempts(since?: number): AdminCommandLog[] {
  const threshold = since ?? Date.now() - 24 * 60 * 60 * 1000; // Last 24h by default
  return commandLog.filter(log => !log.allowed && log.timestamp >= threshold);
}

// ============================================================================
// Middleware Helper
// ============================================================================

/**
 * Create an admin-only middleware for Telegraf
 * Usage: bot.command('ban', adminOnly, async (ctx) => { ... })
 */
export function createAdminMiddleware() {
  return async (ctx: any, next: () => Promise<void>) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const chatId = ctx.chat?.id;
    const command = ctx.message?.text?.split(' ')[0]?.replace('/', '') || 'unknown';
    const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';
    
    if (!userId) {
      await ctx.reply('⚠️ Could not identify user');
      return;
    }
    
    const allowed = isAdmin(userId);
    
    // Log the attempt
    logAdminCommand({
      timestamp: Date.now(),
      userId,
      username,
      chatId,
      command,
      args,
      allowed,
      reason: allowed ? undefined : 'Not in TELEGRAM_ADMIN_IDS',
    });
    
    if (!allowed) {
      await ctx.reply('⛔ This command is restricted to admins only.');
      return;
    }
    
    // User is admin, continue
    await next();
  };
}

// ============================================================================
// Security Status
// ============================================================================

/**
 * Get overall security status
 */
export function getSecurityStatus(): {
  adminSecurityEnabled: boolean;
  webhookSecurityEnabled: boolean;
  adminCount: number;
  recentFailedAttempts: number;
  recommendations: string[];
} {
  const failedAttempts = getFailedAttempts();
  const recommendations: string[] = [];
  
  if (!isAdminSecurityEnabled()) {
    recommendations.push('Set TELEGRAM_ADMIN_IDS to restrict admin commands');
  }
  
  if (!isWebhookSecurityEnabled()) {
    recommendations.push('Set TG_WEBHOOK_SECRET and update webhook for signature verification');
  }
  
  if (failedAttempts.length > 10) {
    recommendations.push(`High number of failed admin attempts (${failedAttempts.length}) - review logs`);
  }
  
  return {
    adminSecurityEnabled: isAdminSecurityEnabled(),
    webhookSecurityEnabled: isWebhookSecurityEnabled(),
    adminCount: getAdminIds().length,
    recentFailedAttempts: failedAttempts.length,
    recommendations,
  };
}

export default {
  initTelegramSecurity,
  isAdmin,
  isAdminSecurityEnabled,
  getAdminIds,
  addAdminId,
  verifyWebhookSignature,
  isWebhookSecurityEnabled,
  logAdminCommand,
  getAdminCommandLogs,
  getFailedAttempts,
  createAdminMiddleware,
  getSecurityStatus,
};
