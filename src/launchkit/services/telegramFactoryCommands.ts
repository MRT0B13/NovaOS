// src/launchkit/services/telegramFactoryCommands.ts
// Telegram commands for Agent Factory: /request_agent, /approve_agent, /reject_agent, /my_agents
// Registered on ElizaOS's Telegraf bot (same pattern as telegramHealthCommands.ts)

import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { AgentFactory } from '../../agents/factory.ts';
import type { Supervisor } from '../../agents/supervisor.ts';
import { getEnv } from '../env.ts';

let isRegistered = false;
let _factory: AgentFactory | null = null;

/** Get the singleton Factory instance */
export function getFactory(): AgentFactory | null {
  return _factory;
}

/**
 * Register agent factory Telegram commands on the ElizaOS bot.
 * Call after the Telegram service and Supervisor have initialized.
 */
export async function registerFactoryCommands(
  runtime: IAgentRuntime,
  supervisor: Supervisor,
  pool: import('pg').Pool,
): Promise<boolean> {
  if (isRegistered) return true;

  try {
    const telegramService = runtime.getService('telegram') as any;
    if (!telegramService) return false;

    const bot = telegramService.messageManager?.bot;
    if (!bot) return false;

    // Initialize the factory
    _factory = new AgentFactory(pool);

    const ownerChatId = process.env.ADMIN_CHAT_ID;
    const adminIds = (getEnv().TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

    const isAdmin = (chatId: string | number): boolean => {
      const id = String(chatId);
      if (ownerChatId && id === ownerChatId) return true;
      return adminIds.includes(id);
    };

    // ── /request_agent <description> — request a new agent ─────────
    bot.command('request_agent', async (ctx: any) => {
      try {
        const userId = String(ctx.from?.id || ctx.chat.id);
        const text = ctx.message?.text?.replace(/^\/request_agent\s*/i, '').trim();

        if (!text) {
          await ctx.reply(
            '🏭 *Agent Factory*\n\n' +
            'Describe the agent you want:\n' +
            '`/request_agent track whale wallets on solana`\n' +
            '`/request_agent monitor $TOKEN price and volume`\n' +
            '`/request_agent scan tokens for rugs`\n\n' +
            'Capabilities: whale tracking, token monitoring, KOL scanning, safety scanning, narrative tracking',
            { parse_mode: 'Markdown' },
          );
          return;
        }

        // Check user agent count limit
        const running = _factory!.getRunningCount(userId);
        if (running >= 3) {
          await ctx.reply('❌ You have reached the maximum of 3 active agents. Stop one first.');
          return;
        }

        const spec = _factory!.parseRequest(text, userId);
        if (!spec) {
          await ctx.reply(
            '❌ Could not understand your request. Try to include keywords like:\n' +
            '• whale, wallet, track\n• token, price, volume, monitor\n' +
            '• rug, safety, scan\n• KOL, twitter, influencer\n• narrative, sentiment, trend',
          );
          return;
        }

        // Reply to user
        await ctx.reply(
          `✅ *Agent Request Created*\n\n${_factory!.formatSpecForTelegram(spec)}\n\nAn admin will review your request.`,
          { parse_mode: 'Markdown' },
        );

        // Notify admins
        if (ownerChatId) {
          try {
            await bot.telegram.sendMessage(
              ownerChatId,
              _factory!.formatApprovalRequest(spec),
              { parse_mode: 'Markdown' },
            );
          } catch {
            // Silent — admin notification is best-effort
          }
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /request_agent error:', err.message);
        await ctx.reply('❌ Error processing request. Try again.').catch(() => {});
      }
    });

    // ── /approve_agent <id> — admin approves + spawns ──────────────
    bot.command('approve_agent', async (ctx: any) => {
      if (!isAdmin(ctx.chat.id)) return;

      try {
        const specId = ctx.message?.text?.replace(/^\/approve_agent\s*/i, '').trim();
        if (!specId) {
          // Show pending specs
          const pending = _factory!.getPendingSpecs();
          if (pending.length === 0) {
            await ctx.reply('No pending agent requests.');
            return;
          }
          const list = pending.map(s => _factory!.formatSpecForTelegram(s)).join('\n\n');
          await ctx.reply(`⏳ *Pending Requests*\n\n${list}`, { parse_mode: 'Markdown' });
          return;
        }

        const approved = await _factory!.approve(specId, String(ctx.from?.id || 'admin'));
        if (!approved) {
          await ctx.reply(`❌ Could not approve \`${specId}\` — not found or not pending.`, { parse_mode: 'Markdown' });
          return;
        }

        // Spawn the agent
        const spawned = await _factory!.spawn(specId, supervisor);
        if (spawned) {
          await ctx.reply(`✅ Agent *${approved.name}* approved and spawned!`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`✅ Agent *${approved.name}* approved but could not be spawned yet (capability not fully supported in MVP).`, { parse_mode: 'Markdown' });
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /approve_agent error:', err.message);
        await ctx.reply('❌ Error approving agent.').catch(() => {});
      }
    });

    // ── /reject_agent <id> [reason] — admin rejects ────────────────
    bot.command('reject_agent', async (ctx: any) => {
      if (!isAdmin(ctx.chat.id)) return;

      try {
        const text = ctx.message?.text?.replace(/^\/reject_agent\s*/i, '').trim();
        const parts = text?.split(/\s+/) || [];
        const specId = parts[0];
        const reason = parts.slice(1).join(' ') || undefined;

        if (!specId) {
          await ctx.reply('Usage: `/reject_agent <id> [reason]`', { parse_mode: 'Markdown' });
          return;
        }

        const rejected = _factory!.reject(specId, reason);
        if (rejected) {
          await ctx.reply(`❌ Agent request \`${specId}\` rejected.${reason ? ` Reason: ${reason}` : ''}`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`Could not reject \`${specId}\` — not found or not pending.`, { parse_mode: 'Markdown' });
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /reject_agent error:', err.message);
        await ctx.reply('❌ Error rejecting agent.').catch(() => {});
      }
    });

    // ── /my_agents — list user's agents ────────────────────────────
    bot.command('my_agents', async (ctx: any) => {
      try {
        const userId = String(ctx.from?.id || ctx.chat.id);
        const specs = _factory!.listSpecs(userId);

        if (specs.length === 0) {
          await ctx.reply('You have no agent requests. Use `/request_agent` to create one.', { parse_mode: 'Markdown' });
          return;
        }

        const list = specs.map(s => _factory!.formatSpecForTelegram(s)).join('\n\n');
        await ctx.reply(`🤖 *Your Agents*\n\n${list}`, { parse_mode: 'Markdown' });
      } catch (err: any) {
        logger.warn('[factory-tg] /my_agents error:', err.message);
        await ctx.reply('❌ Error listing agents.').catch(() => {});
      }
    });

    // ── /stop_agent <id> — stop a running agent ─────────────────────
    bot.command('stop_agent', async (ctx: any) => {
      try {
        const specId = ctx.message?.text?.replace(/^\/stop_agent\s*/i, '').trim();
        if (!specId) {
          await ctx.reply('Usage: `/stop_agent <id>`', { parse_mode: 'Markdown' });
          return;
        }

        const userId = String(ctx.from?.id || ctx.chat.id);
        const spec = _factory!.getSpec(specId);

        // Allow admin or the creator to stop
        if (!spec || (spec.createdBy !== userId && !isAdmin(ctx.chat.id))) {
          await ctx.reply('❌ Agent not found or you don\'t have permission.');
          return;
        }

        const stopped = await _factory!.stop(specId, supervisor);
        if (stopped) {
          await ctx.reply(`⛔ Agent \`${specId}\` stopped.`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`Could not stop \`${specId}\` — not running.`, { parse_mode: 'Markdown' });
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /stop_agent error:', err.message);
        await ctx.reply('❌ Error stopping agent.').catch(() => {});
      }
    });

    // ── /cfo <subcommand> — CFO Agent controls (admin only) ────────
    bot.command('cfo', async (ctx: any) => {
      try {
        if (!isAdmin(ctx.chat.id)) return;
        const text = (ctx.message?.text || '').trim();
        const parts = text.split(/\s+/).slice(1);  // remove "/cfo"
        const sub = (parts[0] || 'status').toLowerCase();

        const sendToCFO = async (command: string, extra: Record<string, any> = {}) => {
          await pool.query(
            `INSERT INTO agent_messages (sender, recipient, type, priority, payload) VALUES ($1, $2, $3, $4, $5)`,
            ['admin-tg', 'nova-cfo', 'command', 'high', JSON.stringify({ command, ...extra })]
          );
        };

        switch (sub) {
          case 'status':
            await sendToCFO('cfo_status');
            await ctx.reply('📊 CFO status request sent — check admin chat for report.');
            break;
          case 'scan':
            await sendToCFO('cfo_scan');
            await ctx.reply('🔍 CFO opportunity scan triggered.');
            break;
          case 'stop':
            await sendToCFO('cfo_stop');
            await ctx.reply('⛔ CFO paused — no new trades.');
            break;
          case 'start':
            await sendToCFO('cfo_start');
            await ctx.reply('▶️ CFO resumed.');
            break;
          case 'close': {
            const target = (parts[1] || '').toLowerCase();
            if (target === 'poly' || target === 'polymarket') {
              await sendToCFO('cfo_close_poly');
              await ctx.reply('🚨 Closing all Polymarket positions.');
            } else if (target === 'hl' || target === 'hyperliquid') {
              await sendToCFO('cfo_close_hl');
              await ctx.reply('🚨 Closing all Hyperliquid positions.');
            } else if (target === 'all') {
              await sendToCFO('cfo_close_all');
              await ctx.reply('🚨 EMERGENCY: Closing ALL positions + pausing CFO.');
            } else {
              await ctx.reply('Usage: /cfo close <poly|hl|all>');
            }
            break;
          }
          case 'stake': {
            const amount = Number(parts[1]);
            if (!amount || amount <= 0) { await ctx.reply('Usage: /cfo stake <SOL amount>'); break; }
            await sendToCFO('cfo_stake', { amount });
            await ctx.reply(`⏳ Staking ${amount} SOL via Jito...`);
            break;
          }
          case 'hedge': {
            const usd = Number(parts[1]);
            const leverage = Number(parts[2]) || 3;
            if (!usd || usd <= 0) { await ctx.reply('Usage: /cfo hedge <USD> [leverage]'); break; }
            await sendToCFO('cfo_hedge', { solExposureUsd: usd, leverage });
            await ctx.reply(`⏳ Opening SOL hedge: SHORT $${usd} @ ${leverage}x...`);
            break;
          }
          case 'approve': {
            const approvalId = parts[1];
            if (!approvalId) { await ctx.reply('Usage: /cfo approve <approvalId>'); break; }
            await sendToCFO('cfo_approve', { approvalId });
            await ctx.reply(`✅ Approval sent for ${approvalId}.`);
            break;
          }
          default:
            await ctx.reply(
              `🏦 *CFO Commands:*\n` +
              `/cfo status — Portfolio report\n` +
              `/cfo scan — Trigger opportunity scan\n` +
              `/cfo stop — Pause all trading\n` +
              `/cfo start — Resume trading\n` +
              `/cfo close poly|hl|all — Emergency close\n` +
              `/cfo stake <SOL> — Stake via Jito\n` +
              `/cfo hedge <USD> [leverage] — SOL hedge\n` +
              `/cfo approve <id> — Approve pending trade`,
              { parse_mode: 'Markdown' }
            );
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /cfo error:', err.message);
        await ctx.reply('❌ Error processing CFO command.').catch(() => {});
      }
    });

    isRegistered = true;
    return true;
  } catch (err: any) {
    logger.warn('[factory-tg] Failed to register commands:', err.message);
    return false;
  }
}
