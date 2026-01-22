import { LaunchPackStore } from '../db/launchPackRepository.ts';
import { getEnv } from '../env.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import type { LaunchPack } from '../model/launchPack.ts';

interface PublishOptions {
  force?: boolean;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

/**
 * Replace placeholder tokens with actual URLs before posting
 * Handles: [MINT_ADDRESS], [MINT], [TG_LINK], [TG], [WEBSITE], pump.fun/[MINT_ADDRESS], etc.
 */
function resolvePlaceholders(text: string, mint?: string, telegramUrl?: string, websiteUrl?: string): string {
  let result = text;
  
  // Build the actual pump.fun URL
  const pumpUrl = mint ? `https://pump.fun/coin/${mint}` : '';
  
  // Replace various placeholder patterns
  // Full URLs first
  result = result.replace(/pump\.fun\/\[MINT_ADDRESS\]/g, pumpUrl ? pumpUrl.replace('https://', '') : '');
  result = result.replace(/pump\.fun\/\[MINT\]/g, pumpUrl ? pumpUrl.replace('https://', '') : '');
  
  // Standalone placeholders
  result = result.replace(/\[MINT_ADDRESS\]/g, mint || '');
  result = result.replace(/\[MINT\]/g, mint || '');
  result = result.replace(/\[TG_LINK\]/g, telegramUrl || '');
  result = result.replace(/\[TG\]/g, telegramUrl || '');
  result = result.replace(/\[WEBSITE\]/g, websiteUrl || '');
  
  // Clean up empty lines (when placeholder is replaced with empty string)
  result = result.replace(/\nChart: $/gm, '');
  result = result.replace(/\nTelegram: $/gm, '');
  result = result.replace(/\nWebsite: $/gm, '');
  result = result.replace(/\n\n+/g, '\n\n');
  
  return result.trim();
}

async function tgApi(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || !json?.ok) {
    throw errorWithCode('TG_PUBLISH_FAILED', `Telegram ${method} failed`);
  }
  return json.result;
}

export class TelegramPublisherService {
  constructor(private store: LaunchPackStore) {}

  async publish(id: string, options: PublishOptions = {}): Promise<LaunchPack> {
    const env = getEnv();
    if (env.TG_ENABLE !== 'true') {
      throw errorWithCode('TG_DISABLED', 'Telegram publishing disabled');
    }
    if (!env.TG_BOT_TOKEN) {
      throw errorWithCode('TG_CONFIG_MISSING', 'TG_BOT_TOKEN not configured');
    }

    const pack = await this.store.get(id);
    if (!pack) throw errorWithCode('NOT_FOUND', 'LaunchPack not found');
    
    // Get the actual Telegram chat_id (telegram_chat_id is the real one, chat_id is ElizaOS roomId)
    const chatId = pack.tg?.telegram_chat_id || pack.tg?.chat_id || env.TG_CHAT_ID;
    if (!chatId) {
      throw errorWithCode('TG_CHAT_ID_MISSING', 'No chat_id configured for this LaunchPack. Link a Telegram group first.');
    }
    
    if (!pack.ops?.checklist?.tg_ready) {
      throw errorWithCode('TG_NOT_READY', 'Telegram checklist not ready');
    }
    if (pack.ops?.tg_published_at && pack.ops.tg_publish_status === 'published' && !options.force) {
      return pack;
    }

    const claim = await this.store.claimTelegramPublish(id, {
      requested_at: nowIso(),
      force: options.force,
    });
    if (!claim) {
      throw errorWithCode('TG_PUBLISH_IN_PROGRESS', 'Telegram publish already in progress');
    }

    // Get the actual mint and telegram URL for resolving placeholders
    const mint = claim.launch?.mint;
    const telegramUrl = claim.tg?.invite_link;
    const websiteUrl = claim.links?.website;

    const rawPins = claim.tg?.pins ?? {};
    // Resolve placeholders in pins
    const pins = {
      welcome: rawPins.welcome ? resolvePlaceholders(rawPins.welcome, mint, telegramUrl, websiteUrl) : undefined,
      how_to_buy: rawPins.how_to_buy ? resolvePlaceholders(rawPins.how_to_buy, mint, telegramUrl, websiteUrl) : undefined,
      memekit: rawPins.memekit ? resolvePlaceholders(rawPins.memekit, mint, telegramUrl, websiteUrl) : undefined,
    };
    const schedule = claim.tg?.schedule ?? [];
    const messageIds: string[] = [];

    const maybeSendAndPin = async (text: string | undefined) => {
      if (!text) return null;
      const message = await tgApi(env.TG_BOT_TOKEN!, 'sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: false, // Enable link previews for pump.fun URLs
      });
      const messageId = message?.message_id;
      if (messageId === undefined || messageId === null) {
        throw errorWithCode('TG_PUBLISH_FAILED', 'Telegram sendMessage missing message_id');
      }
      await tgApi(env.TG_BOT_TOKEN!, 'pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
      });
      return messageId as number;
    };

    try {
      const welcomeId = await maybeSendAndPin(pins.welcome);
      if (welcomeId !== null && welcomeId !== undefined) messageIds.push(String(welcomeId));
      const howToBuyId = await maybeSendAndPin(pins.how_to_buy);
      if (howToBuyId !== null && howToBuyId !== undefined) messageIds.push(String(howToBuyId));
      const memekitId = await maybeSendAndPin(pins.memekit);
      if (memekitId !== null && memekitId !== undefined) messageIds.push(String(memekitId));

      const scheduleIntent = schedule.map((item) => ({ ...item, when: new Date(item.when).toISOString() }));

      // Ensure clean serializable objects to avoid PostgreSQL type issues
      const cleanOps = {
        checklist: { ...(claim.ops?.checklist || {}), tg_published: true },
        tg_publish_status: 'published' as const,
        tg_published_at: nowIso(),
        tg_message_ids: messageIds.length > 0 ? messageIds : [],
        tg_schedule_intent: scheduleIntent.length > 0 ? scheduleIntent : [],
        tg_publish_error_code: null,
        tg_publish_error_message: null,
        audit_log: appendAudit(claim.ops?.audit_log, 'Telegram publish complete', 'eliza'),
      };

      const updated = await this.store.update(id, {
        ops: cleanOps,
      });
      return updated;
    } catch (error) {
      const err = error as Error & { code?: string };
      // Clean error update to avoid serialization issues
      const errorOps = {
        checklist: claim.ops?.checklist || {},
        tg_publish_status: 'failed' as const,
        tg_publish_failed_at: nowIso(),
        tg_publish_error_code: String(err.code || 'TG_PUBLISH_FAILED'),
        tg_publish_error_message: String(err.message || 'Unknown error'),
      };
      await this.store.update(id, {
        ops: errorOps,
      });
      throw err;
    }
  }
}
