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
    await _factory.restoreSpecs();

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

    // ── /agent_guide — comprehensive setup guide for all agent types ──
    bot.command('agent_guide', async (ctx: any) => {
      const guide = [
        `🏭 <b>Nova Agent Factory — Setup Guide</b>`,
        ``,
        `Create custom AI agents that monitor, alert, and trade on your behalf.`,
        ``,
        `<b>━━━ Available Agent Types ━━━</b>`,
        ``,
        `🐋 <b>Whale Tracking</b>`,
        `Monitor large wallet movements on Solana + EVM.`,
        `<code>/request_agent track whale wallets on solana</code>`,
        `Optional: <i>watchAddresses, minTransferSol</i>`,
        ``,
        `📊 <b>Token Monitoring</b>`,
        `Track token price, volume, and holder changes (DexScreener).`,
        `<code>/request_agent monitor $SOL price and volume</code>`,
        `Required: <i>token address or $SYMBOL</i>`,
        ``,
        `🔍 <b>KOL Scanning</b>`,
        `Monitor X/Twitter influencers and alert on relevant posts.`,
        `<code>/request_agent watch KOL posts about AI tokens</code>`,
        `Optional: <i>targetAccounts, keywords</i>`,
        ``,
        `🛡 <b>Safety Scanning</b>`,
        `Continuous RugCheck scans on specified tokens.`,
        `<code>/request_agent scan 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU for rugs</code>`,
        `Required: <i>token address</i>`,
        ``,
        `📈 <b>Narrative Tracking</b>`,
        `Track sentiment shifts across social media and KOLs.`,
        `<code>/request_agent track AI narrative sentiment</code>`,
        `Optional: <i>focusTopics, excludeTopics</i>`,
        ``,
        `🔥 <b>Social Trending</b>`,
        `Monitor Reddit + Google Trends for viral memeable topics.`,
        `<code>/request_agent scan reddit for trending memes</code>`,
        `Optional: <i>subreddits, minScore</i>`,
        ``,
        `💰 <b>Yield Monitoring</b>`,
        `DeFi yields across Krystal (EVM), Orca, Kamino, Jito (Solana).`,
        `<code>/request_agent monitor defi yields above 20% apy</code>`,
        `Optional: <i>minApy, minTvl, chains</i>`,
        ``,
        `⚡ <b>Arb Scanning</b>`,
        `Cross-DEX arbitrage opportunities on EVM chains.`,
        `<code>/request_agent scan cross-dex arbitrage on ethereum</code>`,
        `Optional: <i>minProfitUsd</i>`,
        ``,
        `📋 <b>Portfolio Monitoring</b>`,
        `Multi-chain portfolio health, PnL alerts, drawdown warnings.`,
        `<code>/request_agent monitor my portfolio for drawdowns</code>`,
        `Optional: <i>drawdownThreshold, positionLossThreshold</i>`,
        ``,
        `<b>━━━ Setup Flow ━━━</b>`,
        ``,
        `1️⃣ <code>/request_agent &lt;description&gt;</code> — describe what you need`,
        `2️⃣ Admin reviews and approves your request`,
        `3️⃣ (Optional) <code>/configure_wallet &lt;agent_id&gt; &lt;chain&gt; &lt;address&gt;</code>`,
        `4️⃣ (Optional) <code>/wallet_key &lt;agent_id&gt; &lt;private_key&gt;</code> — for trading`,
        `5️⃣ Agent starts running on its schedule`,
        ``,
        `<b>━━━ Management Commands ━━━</b>`,
        ``,
        `<code>/my_agents</code> — list your agents + status`,
        `<code>/stop_agent &lt;id&gt;</code> — stop a running agent`,
        `<code>/remove_wallet &lt;id&gt;</code> — remove wallet from agent`,
        `<code>/skill pool</code> — browse available skills`,
        `<code>/attach_skill &lt;agent_id&gt; &lt;skill_id&gt;</code> — add a skill`,
        ``,
        `<b>━━━ Wallet Permissions ━━━</b>`,
        ``,
        `• <b>read</b> — monitor balances (no key needed)`,
        `• <b>trade</b> — execute swaps (requires private key)`,
        `• <b>lp</b> — manage LP positions (requires private key)`,
        ``,
        `🔐 Keys are encrypted with AES-256-CBC. Use DMs for <code>/wallet_key</code>`,
        ``,
        `<i>Max 3 agents per user. Agents last 7 days by default.</i>`,
      ];
      await ctx.reply(guide.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
    });

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
            'Capabilities: whale tracking, token monitoring, KOL scanning, safety scanning, narrative tracking, yield monitoring, arb scanning, portfolio monitoring\n\n' +
            'After creating, use `/configure_wallet` to attach your wallet for on-chain trading.',
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
            '• whale, wallet — whale tracking (Solana + EVM)\n• token, price, volume — token monitoring\n' +
            '• rug, safety, scan — safety scanning\n• KOL, twitter, influencer — KOL scanning\n' +
            '• narrative, sentiment — narrative tracking\n• social, trending, memes, viral, reddit — social trending\n' +
            '• yield, apy, farming, krystal, orca, kamino — yield monitoring\n' +
            '• arb, arbitrage, flash loan, cross-dex — arb scanning\n' +
            '• portfolio, pnl, drawdown, positions — portfolio monitoring',
          );
          return;
        }

        // Load relevant skill suggestions (await so they appear in approval msg)
        await _factory!.loadSkillSuggestions(spec);

        // Reply to user
        const userMsg = [`✅ <b>Agent Request Created</b>`, ``, _factory!.formatSpecForTelegram(spec)];
        if (spec.suggestedSkills && spec.suggestedSkills.length > 0) {
          userMsg.push(``, `💡 <b>${spec.suggestedSkills.length} relevant skill(s)</b> found — admin can attach them during approval.`);
        }
        userMsg.push(``, `🔍 An admin will review your request shortly.`);
        await ctx.reply(userMsg.join('\n'), { parse_mode: 'HTML' });

        // Notify admins
        if (ownerChatId) {
          try {
            await bot.telegram.sendMessage(
              ownerChatId,
              _factory!.formatApprovalRequest(spec),
              { parse_mode: 'HTML' },
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
          await ctx.reply(`⏳ <b>Pending Requests</b>\n\n${list}`, { parse_mode: 'HTML' });
          return;
        }

        const approved = await _factory!.approve(specId, String(ctx.from?.id || 'admin'));
        if (!approved) {
          await ctx.reply(`❌ Could not approve <code>${specId}</code> — not found or not pending.`, { parse_mode: 'HTML' });
          return;
        }

        // Spawn the agent
        const spawned = await _factory!.spawn(specId, supervisor);
        if (spawned) {
          await ctx.reply(`✅ Agent <b>${approved.name}</b> approved and spawned!`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`✅ Agent <b>${approved.name}</b> approved but could not be spawned yet (capability not fully supported in MVP).`, { parse_mode: 'HTML' });
        }

        // Notify the requesting user
        try {
          await bot.telegram.sendMessage(
            approved.createdBy,
            `🎉 <b>Agent Approved!</b>\n\nYour agent <b>${approved.name}</b> has been approved${spawned ? ' and is now running' : ''}.\n\nUse /my_agents to see your agents.`,
            { parse_mode: 'HTML' },
          );
        } catch { /* user may have blocked bot or be in group context */ }
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
          await ctx.reply('Usage: /reject_agent &lt;id&gt; [reason]', { parse_mode: 'HTML' });
          return;
        }

        const rejected = _factory!.reject(specId, reason);
        if (rejected) {
          await ctx.reply(`❌ Agent request <code>${specId}</code> rejected.${reason ? ` Reason: ${reason}` : ''}`, { parse_mode: 'HTML' });

          // Notify the requesting user
          const spec = _factory!.getSpec(specId);
          if (spec) {
            try {
              await bot.telegram.sendMessage(
                spec.createdBy,
                `❌ <b>Agent Request Rejected</b>\n\nYour agent request <code>${specId}</code> was not approved.${reason ? `\nReason: ${reason}` : ''}\n\nFeel free to submit a new request with /request_agent.`,
                { parse_mode: 'HTML' },
              );
            } catch { /* silent */ }
          }
        } else {
          await ctx.reply(`Could not reject <code>${specId}</code> — not found or not pending.`, { parse_mode: 'HTML' });
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
          await ctx.reply('You have no agent requests. Use /request_agent to create one.');
          return;
        }

        const list = specs.map(s => _factory!.formatSpecForTelegram(s)).join('\n\n');
        await ctx.reply(`🤖 <b>Your Agents</b>\n\n${list}`, { parse_mode: 'HTML' });
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
          await ctx.reply('Usage: /stop_agent &lt;id&gt;', { parse_mode: 'HTML' });
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
          await ctx.reply(`⛔ Agent <code>${specId}</code> stopped.`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`Could not stop <code>${specId}</code> — not running.`, { parse_mode: 'HTML' });
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
          case 'report': {
            const reportType = (parts[1] || 'weekly').toLowerCase();
            if (reportType !== 'weekly' && reportType !== 'monthly') {
              await ctx.reply('Usage: /cfo report <weekly|monthly>');
              break;
            }
            await sendToCFO('cfo_report', { type: reportType });
            await ctx.reply(`📊 Generating ${reportType} financial report...`);
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
              `/cfo loop start|stop|status — JitoSOL loop\n` +
              `/cfo report weekly|monthly — Financial report`,
              { parse_mode: 'Markdown' }
            );
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /cfo error:', err.message);
        await ctx.reply('❌ Error processing CFO command.').catch(() => {});
      }
    });

    // ── /skill — Agent skills management ──────────────────────────
    bot.command('skill', async (ctx: any) => {
      try {
        if (!isAdmin(ctx.chat.id)) {
          await ctx.reply('🔒 Admin only.').catch(() => {});
          return;
        }

        const text = (ctx.message?.text || '').replace(/^\/skills?\s*/i, '').trim();
        const parts = text.split(/\s+/);
        const sub = (parts[0] || 'help').toLowerCase();

        const { getSkillsService } = await import('./skillsService.ts');
        const svc = getSkillsService();
        if (!svc) {
          await ctx.reply('⚠️ Skills service not initialized.').catch(() => {});
          return;
        }

        switch (sub) {
          case 'list': {
            const skills = await svc.listSkills();
            if (skills.length === 0) {
              await ctx.reply('📦 No skills registered yet.');
              return;
            }
            const lines = skills.map(s =>
              `${s.status === 'active' ? '✅' : '❌'} <b>${s.name}</b> (${s.skillId} v${s.version})\n   📂 ${s.category} | 👥 ${s.assignedTo.length > 0 ? s.assignedTo.join(', ') : 'unassigned'}`
            );
            await ctx.reply(`📦 <b>Agent Skills</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
            break;
          }

          case 'assign': {
            const role = parts[1];
            const skillId = parts[2];
            const priority = parseInt(parts[3]) || 50;
            if (!role || !skillId) {
              await ctx.reply('Usage: /skill assign <role> <skill_id> [priority]');
              return;
            }
            await svc.assignSkill(role, skillId, priority);
            await ctx.reply(`✅ Assigned <code>${skillId}</code> to ${role} (priority ${priority})`, { parse_mode: 'HTML' });
            break;
          }

          case 'unassign': {
            const role = parts[1];
            const skillId = parts[2];
            if (!role || !skillId) {
              await ctx.reply('Usage: /skill unassign <role> <skill_id>');
              return;
            }
            await svc.unassignSkill(role, skillId);
            await ctx.reply(`✅ Unassigned <code>${skillId}</code> from ${role}`, { parse_mode: 'HTML' });
            break;
          }

          case 'enable': {
            const skillId = parts[1];
            if (!skillId) { await ctx.reply('Usage: /skill enable <skill_id>'); return; }
            await svc.enableSkill(skillId);
            await ctx.reply(`✅ Enabled skill <code>${skillId}</code>`, { parse_mode: 'HTML' });
            break;
          }

          case 'disable': {
            const skillId = parts[1];
            if (!skillId) { await ctx.reply('Usage: /skill disable <skill_id>'); return; }
            await svc.disableSkill(skillId);
            await ctx.reply(`❌ Disabled skill <code>${skillId}</code>`, { parse_mode: 'HTML' });
            break;
          }

          case 'pending': {
            const pending = await svc.listPendingDiscoveries();
            if (pending.length === 0) {
              await ctx.reply('🔍 No pending skill discoveries.');
              return;
            }
            const lines = pending.map(p =>
              `📦 <b>${p.name}</b> (id: ${p.id})\n   Roles: ${p.proposedAgentRoles.join(', ')}\n   ${p.relevanceReasoning}\n   <code>/skill approve ${p.id}</code> | <code>/skill reject ${p.id}</code>`
            );
            await ctx.reply(`🔍 <b>Pending Discoveries</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
            break;
          }

          case 'pool': {
            const poolSkills = await svc.listPoolSkills(15);
            if (poolSkills.length === 0) {
              await ctx.reply('🏊 <b>Skill Pool is empty.</b>\n\nThe discovery service will populate it every 24h with skills that scored below the 70% agent threshold but above 20%.', { parse_mode: 'HTML' });
              return;
            }
            const poolLines = poolSkills.map(ps =>
              `📦 <b>${ps.name}</b> (pool #${ps.id})\n` +
              `   Score: ${Math.round(ps.maxRelevance * 100)}% | Caps: ${ps.suggestedCapabilities.join(', ')}\n` +
              `   Used: ${ps.timesAttached}x attached, ${ps.timesSuggested}x suggested\n` +
              `   <code>/attach_skill &lt;agent_id&gt; ${ps.id}</code>`
            );
            await ctx.reply(`🏊 <b>Skill Pool</b> (${poolSkills.length} available)\n\nThese skills were discovered but scored below the 70% threshold for core agents. Use <code>/attach_skill</code> to add them to factory-created agents.\n\n${poolLines.join('\n\n')}`, { parse_mode: 'HTML' });
            break;
          }

          case 'approve': {
            const queueId = parseInt(parts[1]);
            if (!queueId) { await ctx.reply('Usage: /skill approve <queue_id>'); return; }
            const approvedId = await svc.approveDiscoveredSkill(queueId, String(ctx.from?.id || 'admin'));
            await ctx.reply(`✅ Approved skill <code>${approvedId}</code> — it will load on next agent cycle`, { parse_mode: 'HTML' });
            break;
          }

          case 'reject': {
            const queueId = parseInt(parts[1]);
            if (!queueId) { await ctx.reply('Usage: /skill reject <queue_id>'); return; }
            await svc.rejectDiscoveredSkill(queueId);
            await ctx.reply('✅ Rejected.');
            break;
          }

          case 'view': {
            const skillId = parts[1];
            if (!skillId) { await ctx.reply('Usage: /skill view <skill_id>'); return; }
            const skill = await svc.getSkill(skillId);
            if (!skill) { await ctx.reply('❌ Skill not found.'); return; }
            const preview = skill.content.length > 1000 ? skill.content.slice(0, 1000) + '...' : skill.content;
            await ctx.reply(
              `📦 <b>${skill.name}</b> (${skill.skillId} v${skill.version})\n` +
              `📂 ${skill.category}\n\n` +
              `${skill.description}\n\n` +
              `<pre>${preview}</pre>`,
              { parse_mode: 'HTML' }
            );
            break;
          }

          default:
            await ctx.reply(
              '📦 <b>Skill Commands</b>\n\n' +
              '<code>/skill list</code> — List all skills\n' +
              '<code>/skill view &lt;id&gt;</code> — View skill details\n' +
              '<code>/skill assign &lt;role&gt; &lt;id&gt; [priority]</code> — Assign skill\n' +
              '<code>/skill unassign &lt;role&gt; &lt;id&gt;</code> — Remove assignment\n' +
              '<code>/skill enable &lt;id&gt;</code> — Enable skill\n' +
              '<code>/skill disable &lt;id&gt;</code> — Disable skill\n' +
              '<code>/skill pending</code> — View pending discoveries\n' +
              '<code>/skill pool</code> — Browse skill pool (factory suggestions)\n' +
              '<code>/skill approve &lt;queue_id&gt;</code> — Approve discovery\n' +
              '<code>/skill reject &lt;queue_id&gt;</code> — Reject discovery\n' +
              '<code>/attach_skill &lt;agent_id&gt; &lt;pool_id&gt;</code> — Attach pool skill to agent',
              { parse_mode: 'HTML' }
            );
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /skill error:', err.message);
        await ctx.reply('❌ Error processing skill command.').catch(() => {});
      }
    });

    // Alias: /skills → run /skill handler with 'list' subcommand
    bot.command('skills', async (ctx: any) => {
      try {
        if (!isAdmin(ctx.chat.id)) {
          await ctx.reply('🔒 Admin only.').catch(() => {});
          return;
        }
        const { getSkillsService } = await import('./skillsService.ts');
        const svc = getSkillsService();
        if (!svc) {
          await ctx.reply('⚠️ Skills service not initialized.').catch(() => {});
          return;
        }
        const skills = await svc.listSkills();
        if (skills.length === 0) {
          await ctx.reply('📦 No skills registered yet.');
          return;
        }
        const lines = skills.map((s: any) =>
          `${s.status === 'active' ? '✅' : '❌'} <b>${s.name}</b> (${s.skillId} v${s.version})\n   📂 ${s.category} | 👥 ${s.assignedTo.length > 0 ? s.assignedTo.join(', ') : 'unassigned'}`
        );
        await ctx.reply(`📦 <b>Agent Skills</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
      } catch (err: any) {
        logger.warn('[factory-tg] /skills error:', err.message);
        await ctx.reply('❌ Error processing skill command.').catch(() => {});
      }
    });

    // ── /attach_skill <agent_id> <pool_skill_id> — attach pool skill to factory agent ──
    bot.command('attach_skill', async (ctx: any) => {
      try {
        if (!isAdmin(ctx.chat.id)) {
          await ctx.reply('🔒 Admin only.').catch(() => {});
          return;
        }

        const text = (ctx.message?.text || '').replace(/^\/attach_skill\s*/i, '').trim();
        const parts = text.split(/\s+/);
        const agentId = parts[0];
        const poolId = parseInt(parts[1]);

        if (!agentId || !poolId) {
          await ctx.reply('Usage: <code>/attach_skill &lt;agent_id&gt; &lt;pool_skill_id&gt;</code>\n\nUse <code>/skill pool</code> to browse available pool skills.', { parse_mode: 'HTML' });
          return;
        }

        // Verify agent exists in factory
        const spec = _factory?.getSpec(agentId);
        if (!spec) {
          await ctx.reply(`❌ Agent <code>${agentId}</code> not found.`, { parse_mode: 'HTML' });
          return;
        }

        const { getSkillsService } = await import('./skillsService.ts');
        const svc = getSkillsService();
        if (!svc) {
          await ctx.reply('⚠️ Skills service not initialized.').catch(() => {});
          return;
        }

        const skillId = await svc.attachPoolSkill(poolId, spec.name);
        await ctx.reply(`✅ Pool skill <code>${skillId}</code> attached to <b>${spec.name}</b>.\nIt will load on next agent cycle.`, { parse_mode: 'HTML' });
      } catch (err: any) {
        logger.warn('[factory-tg] /attach_skill error:', err.message);
        await ctx.reply(`❌ Error: ${err.message}`).catch(() => {});
      }
    });

    // ── /configure_wallet <agent_id> — set user wallet for agent trading ──
    bot.command('configure_wallet', async (ctx: any) => {
      try {
        const text = (ctx.message?.text || '').replace(/^\/configure_wallet\s*/i, '').trim();
        const parts = text.split(/\s+/);
        const agentId = parts[0];
        const chain = (parts[1] || '').toLowerCase() as 'solana' | 'evm' | 'both';
        const address = parts[2];
        const permStr = parts[3] || 'read';

        if (!agentId || !chain || !address || !['solana', 'evm', 'both'].includes(chain)) {
          await ctx.reply(
            '💼 <b>Configure Wallet for Agent</b>\n\n' +
            'Usage:\n' +
            '<code>/configure_wallet &lt;agent_id&gt; &lt;solana|evm|both&gt; &lt;address&gt; [permissions]</code>\n\n' +
            'Permissions (comma-separated):\n' +
            '  • <b>read</b> — monitor only (default)\n' +
            '  • <b>trade</b> — can execute swaps\n' +
            '  • <b>lp</b> — can open/close LP positions\n\n' +
            'Example:\n' +
            '<code>/configure_wallet swift-fox solana 7xKX...3nPq read,trade</code>\n\n' +
            '⚠️ For trade/LP permissions, DM the bot with your private key (never share in groups). The key is encrypted at rest.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        const userId = String(ctx.from?.id || ctx.chat.id);

        // Verify agent exists and user owns it (or is admin)
        const spec = _factory?.getSpec(agentId);
        if (!spec) {
          await ctx.reply(`❌ Agent <code>${agentId}</code> not found.`, { parse_mode: 'HTML' });
          return;
        }
        if (spec.createdBy !== userId && !isAdmin(ctx.chat.id)) {
          await ctx.reply('❌ You can only configure wallets for your own agents.');
          return;
        }

        // Parse permissions
        const validPerms = ['read', 'trade', 'lp'] as const;
        const permissions = permStr.split(',')
          .map((p: string) => p.trim().toLowerCase())
          .filter((p: string) => (validPerms as readonly string[]).includes(p)) as ('read' | 'trade' | 'lp')[];
        if (permissions.length === 0) permissions.push('read');

        // Validate address format
        const isSolana = chain === 'solana' || chain === 'both';
        const isEvm = chain === 'evm' || chain === 'both';
        if (isSolana && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          await ctx.reply('❌ Invalid Solana address format.');
          return;
        }
        if (isEvm && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
          await ctx.reply('❌ Invalid EVM address format (expected 0x...).');
          return;
        }

        // Set wallet on spec
        spec.wallet = {
          chain,
          address,
          permissions,
        };
        // The spec is already in the factory's Map via reference

        const permDisplay = permissions.join(', ');
        const needsKey = permissions.includes('trade') || permissions.includes('lp');

        let msg = `✅ Wallet configured for <b>${spec.name}</b>\n\n` +
          `🔗 Chain: ${chain}\n` +
          `📬 Address: <code>${address.slice(0, 8)}...${address.slice(-4)}</code>\n` +
          `🔑 Permissions: ${permDisplay}`;

        if (needsKey) {
          msg += `\n\n⚠️ Trade/LP permissions require a private key.\nDM me with:\n<code>/wallet_key ${agentId} &lt;private_key&gt;</code>\n\n🔒 Keys are encrypted at rest and never logged.`;
        }

        await ctx.reply(msg, { parse_mode: 'HTML' });

        // Notify admin if wallet has trade permissions
        if (needsKey && ownerChatId) {
          try {
            await bot.telegram.sendMessage(
              ownerChatId,
              `⚠️ <b>Wallet Config Alert</b>\n\nUser ${userId} configured trade/LP wallet for agent <b>${spec.name}</b>\nChain: ${chain}\nAddress: <code>${address}</code>\nPermissions: ${permDisplay}\n\nAdmin approval recommended before spawning.`,
              { parse_mode: 'HTML' },
            );
          } catch { /* silent */ }
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /configure_wallet error:', err.message);
        await ctx.reply('❌ Error configuring wallet.').catch(() => {});
      }
    });

    // ── /wallet_key <agent_id> <key> — securely provide private key (DM only) ──
    bot.command('wallet_key', async (ctx: any) => {
      try {
        // Only allow in private chat (DM)
        if (ctx.chat.type !== 'private') {
          // Delete the message immediately to prevent key exposure
          try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }
          await ctx.reply('🚫 <b>SECURITY:</b> Never share private keys in group chats!\nPlease DM me directly with this command.', { parse_mode: 'HTML' });
          return;
        }

        const text = (ctx.message?.text || '').replace(/^\/wallet_key\s*/i, '').trim();
        const parts = text.split(/\s+/);
        const agentId = parts[0];
        const privateKey = parts[1];

        if (!agentId || !privateKey) {
          await ctx.reply('Usage: <code>/wallet_key &lt;agent_id&gt; &lt;private_key&gt;</code>\n\n🔒 Only use in DM. Keys are encrypted at rest.', { parse_mode: 'HTML' });
          return;
        }

        const userId = String(ctx.from?.id || ctx.chat.id);
        const spec = _factory?.getSpec(agentId);
        if (!spec || spec.createdBy !== userId) {
          await ctx.reply('❌ Agent not found or not yours.');
          return;
        }
        if (!spec.wallet) {
          await ctx.reply('❌ Configure wallet first with <code>/configure_wallet</code>.', { parse_mode: 'HTML' });
          return;
        }

        // Encrypt the key before storing (using a simple reversible encryption)
        // In production, use proper KMS / hardware security module
        const { createCipheriv, randomBytes } = await import('crypto');
        const encKey = process.env.WALLET_ENCRYPTION_KEY || 'nova-default-encryption-key-32b!';
        const iv = randomBytes(16);
        const cipher = createCipheriv('aes-256-cbc', Buffer.from(encKey.padEnd(32, '0').slice(0, 32)), iv);
        let encrypted = cipher.update(privateKey, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        spec.wallet.encryptedKey = iv.toString('hex') + ':' + encrypted;

        await ctx.reply('✅ Private key encrypted and stored.\n🔒 The agent can now execute trades on your behalf when approved.');

        // Notify admin
        if (ownerChatId) {
          try {
            await bot.telegram.sendMessage(
              ownerChatId,
              `🔐 <b>Wallet Key Provided</b>\n\nUser ${userId} provided encrypted private key for agent <b>${spec.name}</b>.\nChain: ${spec.wallet.chain}\nPermissions: ${spec.wallet.permissions.join(', ')}\n\n⚠️ Review carefully before approving this agent.`,
              { parse_mode: 'HTML' },
            );
          } catch { /* silent */ }
        }
      } catch (err: any) {
        logger.warn('[factory-tg] /wallet_key error:', err.message);
        await ctx.reply('❌ Error storing key.').catch(() => {});
      }
    });

    // ── /remove_wallet <agent_id> — remove wallet config from an agent ──
    bot.command('remove_wallet', async (ctx: any) => {
      try {
        const agentId = (ctx.message?.text || '').replace(/^\/remove_wallet\s*/i, '').trim();
        if (!agentId) {
          await ctx.reply('Usage: <code>/remove_wallet &lt;agent_id&gt;</code>', { parse_mode: 'HTML' });
          return;
        }

        const userId = String(ctx.from?.id || ctx.chat.id);
        const spec = _factory?.getSpec(agentId);
        if (!spec) {
          await ctx.reply(`❌ Agent <code>${agentId}</code> not found.`, { parse_mode: 'HTML' });
          return;
        }
        if (spec.createdBy !== userId && !isAdmin(ctx.chat.id)) {
          await ctx.reply('❌ You can only remove wallets from your own agents.');
          return;
        }
        if (!spec.wallet) {
          await ctx.reply('ℹ️ No wallet configured for this agent.');
          return;
        }

        const oldChain = spec.wallet.chain;
        spec.wallet = undefined;

        await ctx.reply(`✅ Wallet removed from <b>${spec.name}</b> (was: ${oldChain})`, { parse_mode: 'HTML' });
        logger.info(`[factory-tg] User ${userId} removed wallet from agent ${spec.name}`);
      } catch (err: any) {
        logger.warn('[factory-tg] /remove_wallet error:', err.message);
        await ctx.reply('❌ Error removing wallet.').catch(() => {});
      }
    });

    isRegistered = true;
    return true;
  } catch (err: any) {
    logger.warn('[factory-tg] Failed to register commands:', err.message);
    return false;
  }
}
