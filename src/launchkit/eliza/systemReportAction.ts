import { Action, Content, Memory, IAgentRuntime, HandlerCallback, State, logger } from '@elizaos/core';
import { triggerStatusReport, getMetrics } from '../services/systemReporter.ts';
import { getTelegramHealthStatus } from '../services/telegramHealthMonitor.ts';
import { getAutonomousStatus } from '../services/autonomousMode.ts';
import { getTrendMonitorStatus, getActiveTrends } from '../services/trendMonitor.ts';
import { getQuota as getXQuota } from '../services/xRateLimiter.ts';

/**
 * System Status Action
 * 
 * Allows the admin to request a full system status report via chat.
 * Responds in chat AND sends to admin notifications.
 */

export const systemReportAction: Action = {
  name: 'SYSTEM_REPORT',
  description: 'Generate a comprehensive system status report including bot health, autonomous mode, marketing stats, and trends',
  similes: [
    'system report',
    'status report', 
    'system status',
    'health check',
    'show status',
    'how are you doing',
    'nova status',
    'give me a report',
    'what is your status',
    'are you working',
    'check systems',
    'diagnostic',
    'system check'
  ],
  examples: [],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text || '').toLowerCase();
    const keywords = ['status', 'report', 'health', 'diagnostic', 'check', 'systems', 'how are you'];
    return keywords.some(kw => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown>,
    callback: HandlerCallback
  ) => {
    try {
      logger.info('[SystemReport] Generating status report...');
      
      // Collect all status info
      const tgHealth = getTelegramHealthStatus();
      const metrics = getMetrics();
      
      // Try to get optional status (might not be initialized)
      let autonomousStatus: ReturnType<typeof getAutonomousStatus> | null = null;
      let trendStatus: ReturnType<typeof getTrendMonitorStatus> | null = null;
      let activeTrends: ReturnType<typeof getActiveTrends> = [];
      let xQuota: ReturnType<typeof getXQuota> | null = null;
      
      try { autonomousStatus = getAutonomousStatus(); } catch { /* not initialized */ }
      try { trendStatus = getTrendMonitorStatus(); } catch { /* not initialized */ }
      try { activeTrends = getActiveTrends(); } catch { /* not initialized */ }
      try { xQuota = getXQuota(); } catch { /* not initialized */ }
      
      // Format uptime
      const uptimeMs = metrics.uptimeMs;
      const uptimeHours = (uptimeMs / (60 * 60 * 1000)).toFixed(1);
      const uptimeStr = parseFloat(uptimeHours) >= 24 
        ? `${Math.floor(parseFloat(uptimeHours) / 24)}d ${Math.round(parseFloat(uptimeHours) % 24)}h`
        : `${uptimeHours}h`;
      
      // Telegram status
      const tgStatus = tgHealth.isHealthy 
        ? `🟢 Online (${tgHealth.messageCount} msgs)`
        : `🔴 Stale (${tgHealth.minutesSinceLastMessage ?? '?'}min ago)`;
      
      // Autonomous status
      let autoStatus = '⏸️ Disabled';
      if (autonomousStatus?.enabled) {
        autoStatus = autonomousStatus.dryRun ? '🧪 Dry Run' : '🟢 Active';
      }
      
      // Build report
      let report = `📊 **Nova System Report**\n\n`;
      report += `🤖 **Telegram:** ${tgStatus}\n`;
      report += `🚀 **Autonomous:** ${autoStatus}\n`;
      
      if (autonomousStatus?.enabled) {
        const totalLaunches = (autonomousStatus.launchesToday || 0) + (autonomousStatus.reactiveLaunchesToday || 0);
        report += `   • Launches today: ${totalLaunches} total (${autonomousStatus.launchesToday || 0} scheduled, ${autonomousStatus.reactiveLaunchesToday || 0} reactive)\n`;
        if (autonomousStatus.nextScheduledTime) {
          const next = new Date(autonomousStatus.nextScheduledTime);
          report += `   • Next launch: ${next.toLocaleTimeString()} UTC\n`;
        }
      }
      
      report += `\n📢 **Marketing Today:**\n`;
      report += `   • Tweets: ${metrics.tweetsSentToday}\n`;
      report += `   • TG Posts: ${metrics.tgPostsSentToday}\n`;
      
      if (xQuota) {
        report += `   • X Quota: ${xQuota.writes.remaining}/${xQuota.writes.limit} remaining\n`;
      }
      
      report += `\n📈 **Trends:**\n`;
      if (trendStatus?.enabled) {
        report += `   • Monitor: 🟢 Running\n`;
        report += `   • Detected today: ${metrics.trendsDetectedToday}\n`;
        if (activeTrends.length > 0) {
          report += `   • Active:\n`;
          for (const trend of activeTrends.slice(0, 3)) {
            report += `     - ${trend.topic.slice(0, 40)}... (${trend.source})\n`;
          }
        }
      } else {
        report += `   • Monitor: ⏸️ Stopped\n`;
      }
      
      report += `\n⚙️ **System:**\n`;
      report += `   • Uptime: ${uptimeStr}\n`;
      report += `   • Errors (24h): ${metrics.errors24h}\n`;
      report += `   • Warnings (24h): ${metrics.warnings24h}\n`;
      
      // Health assessment
      report += '\n';
      if (!tgHealth.isHealthy) {
        report += `⚠️ **Alert:** Telegram connection may be stale\n`;
      } else if (metrics.errors24h > 5) {
        report += `⚠️ **Alert:** High error count, check logs\n`;
      } else {
        report += `✅ All systems nominal!\n`;
      }
      
      await callback({ text: report });
      
      // Also trigger admin notification
      try {
        await triggerStatusReport();
      } catch {
        // Non-fatal if admin notify fails
      }
    } catch (error) {
      logger.error('[SystemReport] Error:', error);
      await callback({ 
        text: `❌ Error generating report: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }
};

export default systemReportAction;
