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

/** Returns true once all factory commands (including /cfo) are registered on the bot */
export function areFactoryCommandsReady(): boolean {
  return isRegistered;
}

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

    // Normalize Telegram chat IDs before comparing.
    // Supergroups have two formats: "-1001728082579" (stored in env) vs
    // "1728082579" (returned by ctx.chat.id at runtime). Strip the -100 prefix
    // so both forms compare equal. Same logic as groupContextProvider.ts.
    const normalizeTgId = (id: string): string => {
      if (id.startsWith('-100')) return id.slice(4);
      if (id.startsWith('-'))   return id.slice(1);
      return id;
    };

    const isAdmin = (chatId: string | number): boolean => {
      const id = normalizeTgId(String(chatId));
      if (ownerChatId && id === normalizeTgId(ownerChatId)) return true;
      return adminIds.map(normalizeTgId).includes(id);
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
      if (!isAdmin(ctx.chat.id)) {
        logger.warn(`[TG:factory] Unauthorized command from chat ${ctx.chat.id}`);
        await ctx.reply(`⛔ Unauthorized. (chat id: ${ctx.chat.id})`).catch(() => {});
        return;
      }

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
      if (!isAdmin(ctx.chat.id)) {
        logger.warn(`[TG:factory] Unauthorized command from chat ${ctx.chat.id}`);
        await ctx.reply(`⛔ Unauthorized. (chat id: ${ctx.chat.id})`).catch(() => {});
        return;
      }

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
        logger.info(`[TG:factory] /cfo command handler fired — chat=${ctx.chat?.id}, from=${ctx.from?.id}`);
        if (!isAdmin(ctx.chat.id)) {
          logger.warn(`[TG:factory] Unauthorized /cfo from chat ${ctx.chat.id} (admin check failed)`);
          await ctx.reply(`⛔ Unauthorized. (chat id: ${ctx.chat.id})`).catch(() => {});
          return;
        }
        const text = (ctx.message?.text || '').trim();
        const parts = text.split(/\s+/).slice(1);  // remove "/cfo"
        const sub = (parts[0] || 'status').toLowerCase();

        const sendToCFO = async (command: string, extra: Record<string, any> = {}) => {
          try {
            await pool.query(
              `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload) VALUES ($1, $2, $3, $4, $5)`,
              ['admin-tg', 'nova-cfo', 'command', 'high', JSON.stringify({ command, ...extra })]
            );
          } catch (err) {
            console.error('[TG-CMD] sendToCFO INSERT failed:', (err as Error).message);
            throw err;   // propagate so ctx.reply confirmation doesn't fire
          }
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
          case 'borrow': {
            const borrowAmt = parseFloat(parts[1]);
            if (!borrowAmt || borrowAmt <= 0) { await ctx.reply('Usage: /cfo borrow <USD amount>'); break; }
            await sendToCFO('cfo_kamino_borrow', { amount: borrowAmt });
            await ctx.reply(`⏳ CFO: Requesting Kamino borrow of $${borrowAmt} USDC...`);
            break;
          }
          case 'repay': {
            const repayAll = parts[1] === 'all';
            const repayAmt = repayAll ? Infinity : parseFloat(parts[1]);
            if (!repayAll && (!repayAmt || repayAmt <= 0)) { await ctx.reply('Usage: /cfo repay <USD amount|all>'); break; }
            await sendToCFO('cfo_kamino_repay', { amount: repayAll ? 'all' : repayAmt });
            await ctx.reply(`⏳ CFO: Repaying ${repayAll ? 'all' : `$${repayAmt}`} USDC borrow...`);
            break;
          }
          case 'lp': {
            const lpSub = (parts[1] || '').toLowerCase();
            if (lpSub === 'open') {
              const lpUsd = parseFloat(parts[2]);
              if (!lpUsd || lpUsd <= 0) { await ctx.reply('Usage: /cfo lp open <USD amount>'); break; }
              await sendToCFO('cfo_orca_open', { usdAmount: lpUsd });
              await ctx.reply(`⏳ CFO: Opening Orca LP with $${lpUsd}...`);
            } else if (lpSub === 'close') {
              const pmint = parts[2];
              if (!pmint) { await ctx.reply('Usage: /cfo lp close <positionMint>'); break; }
              await sendToCFO('cfo_orca_close', { positionMint: pmint });
              await ctx.reply('⏳ CFO: Closing Orca LP position...');
            } else if (lpSub === 'status') {
              await sendToCFO('cfo_orca_status', {});
              await ctx.reply('⏳ Fetching Orca LP status...');
            } else {
              await ctx.reply('Usage: /cfo lp <open|close|status> [args]');
            }
            break;
          }
          case 'loop': {
            const loopSub = (parts[1] || '').toLowerCase();
            if (loopSub === 'start') {
              const targetLtv = parseFloat(parts[2]) || 65;
              const maxLoops = parseInt(parts[3]) || 3;
              await sendToCFO('cfo_kamino_jito_loop', { targetLtv, maxLoops });
              await ctx.reply(`⏳ CFO: Starting JitoSOL multiply loop (target LTV: ${targetLtv}%, max loops: ${maxLoops})...`);
            } else if (loopSub === 'stop' || loopSub === 'unwind') {
              await sendToCFO('cfo_kamino_jito_unwind', {});
              await ctx.reply('⏳ CFO: Unwinding JitoSOL/SOL multiply loop...');
            } else if (loopSub === 'status') {
              await sendToCFO('cfo_kamino_loop_status', {});
              await ctx.reply('⏳ Fetching JitoSOL loop status...');
            } else {
              await ctx.reply('Usage: /cfo loop <start|stop|status> [targetLtv] [maxLoops]');
            }
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
              `/cfo approve <id> — Approve pending trade\n` +
              `/cfo borrow <USD> — Borrow USDC from Kamino\n` +
              `/cfo repay <USD|all> — Repay Kamino borrow\n` +
              `/cfo lp open|close|status — Orca LP\n` +
              `/cfo loop start|stop|status — JitoSOL loop`,
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
