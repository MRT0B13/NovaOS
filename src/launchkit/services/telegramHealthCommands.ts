// src/launchkit/services/telegramHealthCommands.ts
// Telegram commands for Health Agent: /health, /errors, /repairs, /approve, /reject
// Registered on ElizaOS's Telegraf bot (same pattern as telegramBanHandler.ts)

import type { IAgentRuntime } from '@elizaos/core';
import { getHealthDB } from '../health/singleton';
import { getEnv } from '../env.ts';

let isRegistered = false;

/**
 * Register health-related Telegram commands on the ElizaOS bot.
 * Call after the Telegram service has initialized (use setTimeout).
 */
export async function registerHealthCommands(runtime: IAgentRuntime): Promise<boolean> {
  if (isRegistered) return true;

  const db = getHealthDB();
  if (!db) {
    console.log('[HealthCommands] Health DB not initialized, skipping');
    return false;
  }

  try {
    const telegramService = runtime.getService('telegram') as any;
    if (!telegramService) return false;

    // Dynamically import Telegraf types
    const bot = telegramService.messageManager?.bot;
    if (!bot) return false;

    const ownerChatId = process.env.ADMIN_CHAT_ID;
    const adminIds = (getEnv().TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

    // Simple auth check — only owner/admins can use health commands
    const isAuthorized = (chatId: string | number): boolean => {
      const id = String(chatId);
      if (ownerChatId && id === ownerChatId) return true;
      return adminIds.includes(id);
    };

    const statusEmoji = (s: string) => (
      { alive: '🟢', degraded: '🟡', dead: '🔴', disabled: '⚫', up: '🟢', slow: '🟡', down: '🔴' }[s] || '⚪'
    );

    // /health — current swarm status
    bot.command('health', async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) return;
      try {
        const heartbeats = await db.getAllHeartbeats();
        const apis = await db.getAllApiHealth();
        const metrics = await db.get24hMetrics();

        let text = '🏥 Nova Health Status\n\n';

        if (heartbeats.length === 0) {
          text += 'No agents reporting yet.\n';
        } else {
          text += 'AGENTS:\n';
          for (const h of heartbeats) {
            text += `${statusEmoji(h.status)} ${h.agentName} — ${h.status}`;
            if (h.errorCountLast5Min > 0) text += ` (${h.errorCountLast5Min} errs)`;
            if (h.currentTask) text += ` [${h.currentTask}]`;
            text += '\n';
          }
        }

        if (apis.length > 0) {
          text += '\nAPIs:\n';
          for (const a of apis) {
            text += `${statusEmoji(a.status)} ${a.apiName} — ${a.responseTimeMs}ms`;
            if (a.consecutiveFailures > 0) text += ` (${a.consecutiveFailures} fails)`;
            text += '\n';
          }
        }

        text += `\n24h: ${metrics.totalErrors} errors, ${metrics.totalRestarts} restarts, ${metrics.totalRepairs} repairs`;
        if (metrics.pendingRepairs > 0) text += `\n⚠️ ${metrics.pendingRepairs} pending approval`;

        await ctx.reply(text);
      } catch (err: any) {
        await ctx.reply(`❌ Health check failed: ${err.message}`);
      }
    });

    // /errors — recent unresolved errors
    bot.command('errors', async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) return;
      try {
        const errors = await db.getUnresolvedErrors();
        if (errors.length === 0) {
          await ctx.reply('✅ No unresolved errors.');
          return;
        }
        let text = `🚨 ${errors.length} Unresolved Errors:\n\n`;
        for (const e of (errors as any[]).slice(0, 10)) {
          text += `[${e.severity}] ${e.agent_name}: ${e.error_type}\n`;
          text += `${(e.error_message || '').slice(0, 100)}\n\n`;
        }
        await ctx.reply(text);
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // /repairs — list pending repair approvals
    bot.command('repairs', async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) return;
      try {
        const pending = await db.getPendingRepairs();
        if (pending.length === 0) {
          await ctx.reply('✅ No pending repairs.');
          return;
        }
        let text = '🔧 Pending Repairs:\n\n';
        for (const r of pending) {
          text += `#${r.id} — ${r.agent_name}\n`;
          text += `File: ${r.file_path}\n`;
          text += `Category: ${r.repair_category}\n`;
          text += `Diagnosis: ${(r.diagnosis || '').slice(0, 120)}\n`;
          text += `/approve_${r.id} or /reject_${r.id}\n\n`;
        }
        await ctx.reply(text);
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // /approve_<id> — approve a pending repair
    bot.hears(/\/approve_(\d+)/, async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) return;
      try {
        const repairId = parseInt(ctx.match[1]);
        await db.approveRepair(repairId, `tg:${ctx.chat.id}`);
        await ctx.reply(`✅ Repair #${repairId} approved. Health Agent will apply it.`);
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // /reject_<id> — reject a pending repair
    bot.hears(/\/reject_(\d+)/, async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) return;
      try {
        const repairId = parseInt(ctx.match[1]);
        await db.rejectRepair(repairId, `tg:${ctx.chat.id}`);
        await ctx.reply(`❌ Repair #${repairId} rejected.`);
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    isRegistered = true;
    console.log('[HealthCommands] ✅ Registered /health, /errors, /repairs, /approve, /reject');
    return true;
  } catch (err: any) {
    console.warn(`[HealthCommands] Failed to register: ${err.message}`);
    return false;
  }
}
