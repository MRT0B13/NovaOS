import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { recordMessageSent } from './telegramHealthMonitor.ts';

/**
 * Admin Notification Service
 * 
 * Sends important alerts to the admin chat:
 * - Withdrawal notifications (time to take profit)
 * - System errors
 * - Autonomous mode updates
 * - Critical system status
 */

export type AdminAlertType = 'withdrawal' | 'error' | 'autonomous' | 'system';

interface AdminConfig {
  chatId: string | null;
  botToken: string | null;
  enabledAlerts: Set<AdminAlertType>;
}

let adminConfig: AdminConfig | null = null;

/**
 * Initialize admin notification config
 */
function initAdminConfig(): AdminConfig {
  const env = getEnv();
  
  const enabledAlerts = new Set<AdminAlertType>();
  if (env.ADMIN_ALERTS) {
    const alerts = env.ADMIN_ALERTS.split(',').map(s => s.trim().toLowerCase());
    for (const a of alerts) {
      // Accept both singular and plural forms
      if (a === 'withdrawal' || a === 'withdrawals') {
        enabledAlerts.add('withdrawal');
      } else if (a === 'error' || a === 'errors') {
        enabledAlerts.add('error');
      } else if (a === 'autonomous') {
        enabledAlerts.add('autonomous');
      } else if (a === 'system') {
        enabledAlerts.add('system');
      }
    }
  } else {
    // Default: all alerts enabled
    enabledAlerts.add('withdrawal');
    enabledAlerts.add('error');
    enabledAlerts.add('autonomous');
    enabledAlerts.add('system');
  }
  
  adminConfig = {
    chatId: env.ADMIN_CHAT_ID || null,
    botToken: env.TG_BOT_TOKEN || null,
    enabledAlerts,
  };
  
  if (adminConfig.chatId && adminConfig.botToken) {
    logger.info(`[AdminNotify] ✅ Configured (chatId=${adminConfig.chatId}, alerts=${Array.from(enabledAlerts).join(',')})`);
  } else {
    logger.info('[AdminNotify] Not configured (set ADMIN_CHAT_ID to enable)');
  }
  
  return adminConfig;
}

/**
 * Check if an alert type is enabled
 */
function isAlertEnabled(type: AdminAlertType): boolean {
  if (!adminConfig) initAdminConfig();
  return adminConfig?.chatId != null && adminConfig.enabledAlerts.has(type);
}

/**
 * Send a message to the admin chat
 */
async function sendToAdmin(
  text: string,
  options: { parseMode?: 'HTML' | 'Markdown'; silent?: boolean } = {}
): Promise<boolean> {
  if (!adminConfig) initAdminConfig();
  if (!adminConfig?.chatId || !adminConfig.botToken) {
    return false;
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${adminConfig.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminConfig.chatId,
        text,
        parse_mode: options.parseMode || 'HTML',
        disable_notification: options.silent ?? false,
      }),
    });
    
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      logger.warn(`[AdminNotify] Failed to send: ${json?.description || res.status}`);
      return false;
    }
    
    // Record successful send for health monitoring
    recordMessageSent();
    
    logger.debug(`[AdminNotify] Sent: ${text.substring(0, 50)}...`);
    return true;
  } catch (err) {
    logger.error('[AdminNotify] Error sending message:', err);
    return false;
  }
}

// ============================================================================
// Alert Functions
// ============================================================================

/**
 * Notify admin about withdrawal opportunity
 */
export async function notifyWithdrawal(data: {
  balance: number;
  available: number;
  suggestedAmount?: number;
  walletAddress?: string;
}): Promise<boolean> {
  if (!isAlertEnabled('withdrawal')) return false;
  
  const message = `💰 <b>Withdrawal Alert</b>\n\n` +
    `Wallet balance: <b>${data.balance.toFixed(4)} SOL</b>\n` +
    `Available to withdraw: <b>${data.available.toFixed(4)} SOL</b>\n` +
    (data.suggestedAmount ? `Suggested: ${data.suggestedAmount.toFixed(4)} SOL\n` : '') +
    (data.walletAddress ? `\nWallet: <code>${data.walletAddress}</code>` : '');
  
  return sendToAdmin(message);
}

/**
 * Notify admin about system errors
 */
export async function notifyError(data: {
  source: string;
  error: string;
  context?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}): Promise<boolean> {
  if (!isAlertEnabled('error')) return false;
  
  const severityEmoji = {
    low: 'ℹ️',
    medium: '⚠️',
    high: '🔴',
    critical: '🚨',
  }[data.severity || 'medium'];
  
  const message = `${severityEmoji} <b>Error Alert</b>\n\n` +
    `Source: <code>${data.source}</code>\n` +
    `Error: ${data.error}\n` +
    (data.context ? `\nContext: ${data.context}` : '');
  
  return sendToAdmin(message, { silent: data.severity === 'low' });
}

/**
 * Notify admin about autonomous mode events
 */
export async function notifyAutonomous(data: {
  event: 'idea_generated' | 'launch_success' | 'launch_failed' | 'guardrail_blocked' | 'schedule_activated' | 'trend_detected' | 'trend_triggered' | 'wallet_funded';
  ticker?: string;
  name?: string;
  details?: string;
  mint?: string;
}): Promise<boolean> {
  if (!isAlertEnabled('autonomous')) return false;
  
  const eventInfo = {
    idea_generated: { emoji: '💡', title: 'Idea Generated' },
    launch_success: { emoji: '🚀', title: 'Launch Successful' },
    launch_failed: { emoji: '❌', title: 'Launch Failed' },
    guardrail_blocked: { emoji: '🛑', title: 'Guardrail Blocked' },
    schedule_activated: { emoji: '⏰', title: 'Schedule Activated' },
    trend_detected: { emoji: '📈', title: 'Trend Detected' },
    trend_triggered: { emoji: '🔥', title: 'Reactive Launch Triggered' },
    wallet_funded: { emoji: '💰', title: 'Wallet Auto-Funded' },
  }[data.event];
  
  let message = `${eventInfo.emoji} <b>Autonomous: ${eventInfo.title}</b>\n\n`;
  
  if (data.ticker) {
    message += `Token: <b>$${data.ticker}</b>`;
    if (data.name) message += ` (${data.name})`;
    message += '\n';
  }
  
  if (data.mint) {
    message += `Mint: <code>${data.mint}</code>\n`;
    message += `<a href="https://pump.fun/coin/${data.mint}">View on Pump.fun</a>\n`;
  }
  
  if (data.details) {
    message += `\n${data.details}`;
  }
  
  return sendToAdmin(message);
}

/**
 * Notify admin about system status
 */
export async function notifySystem(data: {
  event: 'startup' | 'shutdown' | 'health_check' | 'config_change' | 'daily_summary';
  message: string;
  stats?: Record<string, any>;
}): Promise<boolean> {
  if (!isAlertEnabled('system')) return false;
  
  const eventEmoji = {
    startup: '🟢',
    shutdown: '🔴',
    health_check: '💓',
    config_change: '⚙️',
    daily_summary: '📊',
  }[data.event];
  
  let message = `${eventEmoji} <b>System: ${data.event.replace('_', ' ').toUpperCase()}</b>\n\n`;
  message += data.message;
  
  if (data.stats) {
    message += '\n\n<b>Stats:</b>\n';
    for (const [key, value] of Object.entries(data.stats)) {
      message += `• ${key}: ${value}\n`;
    }
  }
  
  return sendToAdmin(message, { silent: data.event === 'health_check' });
}

/**
 * Send a custom admin message
 */
export async function notifyAdmin(
  message: string,
  type: AdminAlertType = 'system'
): Promise<boolean> {
  if (!isAlertEnabled(type)) return false;
  return sendToAdmin(message);
}

/**
 * Force send a message (bypasses alert type check)
 * Use sparingly for critical alerts only
 */
export async function notifyAdminForce(message: string): Promise<boolean> {
  if (!adminConfig) initAdminConfig();
  if (!adminConfig?.chatId) return false;
  return sendToAdmin(message);
}

/**
 * Test admin notification - sends a test message
 */
export async function testAdminNotify(): Promise<{ success: boolean; message: string }> {
  if (!adminConfig) initAdminConfig();
  
  if (!adminConfig?.chatId) {
    return { success: false, message: 'ADMIN_CHAT_ID not configured' };
  }
  if (!adminConfig?.botToken) {
    return { success: false, message: 'TG_BOT_TOKEN not configured' };
  }
  
  const testMessage = `🧪 **Admin Notification Test**

✅ Configuration verified!
📍 Chat ID: \`${adminConfig.chatId}\`
🔔 Enabled alerts: ${Array.from(adminConfig.enabledAlerts).join(', ') || 'all'}

Nova's admin notification system is working correctly.`;

  const sent = await sendToAdmin(testMessage, { parseMode: 'Markdown' });
  
  if (sent) {
    return { success: true, message: 'Test notification sent successfully!' };
  } else {
    return { success: false, message: 'Failed to send test notification' };
  }
}

export default {
  notifyWithdrawal,
  notifyError,
  notifyAutonomous,
  notifySystem,
  notifyAdmin,
  notifyAdminForce,
  testAdminNotify,
};
