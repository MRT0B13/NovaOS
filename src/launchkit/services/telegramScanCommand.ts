// src/launchkit/services/telegramScanCommand.ts
// Telegram /scan command — routes token safety scans through Supervisor → Guardian
//
// Flow:
//   User: /scan <tokenAddress>
//   → Supervisor.requestScan(address, chatId)
//   → Guardian picks up scan request from agent_messages
//   → Guardian performs RugCheck and writes report to agent_messages
//   → Supervisor polls report and calls onPostToTelegram(chatId, formattedResult)
//
// Requires: swarm handle with supervisor reference

import type { IAgentRuntime } from '@elizaos/core';
import type { Supervisor } from '../../agents/supervisor.ts';
import { getEnv } from '../env.ts';

let isRegistered = false;

/**
 * Register the /scan command on the ElizaOS Telegram bot.
 * Must be called after both the Telegram service and agent swarm are initialized.
 */
export async function registerScanCommand(
  runtime: IAgentRuntime,
  supervisor: Supervisor,
): Promise<boolean> {
  if (isRegistered) return true;

  try {
    const telegramService = runtime.getService('telegram') as any;
    if (!telegramService) return false;

    const bot = telegramService.messageManager?.bot;
    if (!bot) return false;

    const ownerChatId = process.env.ADMIN_CHAT_ID;
    const adminIds = (getEnv().TELEGRAM_ADMIN_IDS || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);

    // Auth: owner + admins + optionally community members (configurable)
    const allowCommunityScans = process.env.SCAN_PUBLIC === 'true';
    const isAuthorized = (chatId: string | number): boolean => {
      if (allowCommunityScans) return true;
      const id = String(chatId);
      if (ownerChatId && id === ownerChatId) return true;
      return adminIds.includes(id);
    };

    // Solana address regex: base58, 32-44 chars
    const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    // Track pending scans to avoid duplicates
    const pendingScans: Map<string, { chatId: string; requestedAt: number }> = new Map();

    // /scan <tokenAddress> — request a safety scan via Supervisor → Guardian
    bot.command('scan', async (ctx: any) => {
      if (!isAuthorized(ctx.chat.id)) {
        await ctx.reply('🔒 Scan access is restricted to admins.');
        return;
      }

      const text = ctx.message?.text || '';
      const parts = text.split(/\s+/);
      const tokenAddress = parts[1];

      if (!tokenAddress) {
        await ctx.reply(
          '🔍 Usage: /scan <token_address>\n\n' +
          'Example: /scan So11111111111111111111111111111111111111112\n\n' +
          'This routes through the Guardian agent for a full RugCheck safety scan.'
        );
        return;
      }

      if (!SOLANA_ADDR.test(tokenAddress)) {
        await ctx.reply('❌ Invalid Solana address. Must be 32-44 base58 characters.');
        return;
      }

      // Check for duplicate pending scan
      const existing = pendingScans.get(tokenAddress);
      if (existing && Date.now() - existing.requestedAt < 60_000) {
        await ctx.reply('⏳ A scan for this token is already in progress. Please wait.');
        return;
      }

      const chatId = String(ctx.chat.id);
      pendingScans.set(tokenAddress, { chatId, requestedAt: Date.now() });

      try {
        // Route through Supervisor → Guardian
        await supervisor.requestScan(tokenAddress, chatId);

        await ctx.reply(
          `🔍 Scanning \`${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-4)}\`\n\n` +
          '🛡️ Guardian agent is performing a full RugCheck analysis.\n' +
          '📬 Results will be posted here when ready (usually 10-30 seconds).',
          { parse_mode: 'Markdown' }
        );

        // Clean up pending scan after 2 minutes (timeout)
        setTimeout(() => {
          pendingScans.delete(tokenAddress);
        }, 120_000);
      } catch (err: any) {
        pendingScans.delete(tokenAddress);
        await ctx.reply(`❌ Scan request failed: ${err.message}`);
      }
    });

    // /children — list active token child agents (admin only)
    bot.command('children', async (ctx: any) => {
      const id = String(ctx.chat.id);
      if (!(ownerChatId && id === ownerChatId) && !adminIds.includes(id)) return;

      const children = supervisor.getActiveChildren();
      if (children.size === 0) {
        await ctx.reply('📭 No active token child agents.');
        return;
      }

      let text = `🤖 Active Token Children (${children.size}):\n\n`;
      for (const [addr, child] of children) {
        text += `• \`${addr.slice(0, 8)}...\` — ${child.getAgentId()}\n`;
      }
      await ctx.reply(text, { parse_mode: 'Markdown' });
    });

    isRegistered = true;
    console.log('[ScanCommand] ✅ Registered /scan, /children commands');
    return true;
  } catch (err: any) {
    console.warn(`[ScanCommand] Failed to register: ${err.message}`);
    return false;
  }
}
