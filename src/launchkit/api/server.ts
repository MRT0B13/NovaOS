import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { z } from 'zod';
import { IAgentRuntime } from '@elizaos/core';
import {
  LaunchPack,
  LaunchPackValidation,
  LaunchPackCreateInput,
  LaunchPackUpdateInput,
} from '../model/launchPack.ts';
import { LaunchPackRepository, LaunchPackStore } from '../db/launchPackRepository.ts';
import { CopyGeneratorService } from '../services/copyGenerator.ts';
import { PumpLauncherService } from '../services/pumpLauncher.ts';
import { createSecretsStore } from '../db/storeFactory.ts';
import { TelegramPublisherService } from '../services/telegramPublisher.ts';
import { XPublisherService } from '../services/xPublisher.ts';
import { cacheTelegramUser } from '../services/telegramCommunity.ts';
import { processUpdate as processBanUpdate } from '../services/telegramBanHandler.ts';
import { getEnv } from '../env.ts';
import { checkDatabaseReadiness, logDbReadinessSummary, type DbReadiness } from '../db/railwayReady.ts';

// Cached DB readiness status for /health endpoint
let cachedDbReadiness: DbReadiness | null = null;

export interface LaunchKitServerOptions {
  port?: number;
  adminToken?: string;
  store?: LaunchPackStore;
  runtime?: IAgentRuntime;
  copyService?: CopyGeneratorService;
  pumpService?: PumpLauncherService;
  telegramPublisher?: TelegramPublisherService;
  xPublisher?: XPublisherService;
}

interface JsonError {
  code: string;
  message: string;
  details?: unknown;
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }
  if (!chunks.length) return {} as T;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function isHealth(pathname: string) {
  return pathname === '/health' || pathname === '/healthz';
}

const idSchema = z.string().uuid();
const generateBodySchema = z.object({
  theme: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  tone: z.string().optional(),
});

function buildExportPayload(pack: LaunchPack) {
  const payload = {
    pump: {
      name: pack.brand.name,
      symbol: pack.brand.ticker,
      description: pack.brand.description || pack.brand.tagline || '',
      image: pack.assets?.logo_url,
      socials: pack.links,
    },
    telegram: {
      pins: pack.tg?.pins,
      schedule: pack.tg?.schedule,
    },
    x: {
      main_post: pack.x?.main_post,
      thread: pack.x?.thread,
      reply_bank: pack.x?.reply_bank,
      schedule: pack.x?.schedule,
    },
  } as Record<string, unknown>;

  const lines: string[] = [];
  lines.push(`# Launch Brief: ${pack.brand.name} (${pack.brand.ticker})`);
  if (payload.pump && typeof payload.pump === 'object') {
    const pump = payload.pump as any;
    lines.push(`- Name: ${pump.name}`);
    lines.push(`- Symbol: ${pump.symbol}`);
    if (pump.description) lines.push(`- Description: ${pump.description}`);
    if (pump.image) lines.push(`- Logo: ${pump.image}`);
  }
  const tg = payload.telegram as any;
  const x = payload.x as any;
  lines.push('## Telegram');
  if (tg?.pins) {
    lines.push('- Pins:');
    if (tg.pins.welcome) lines.push(`  - Welcome: ${tg.pins.welcome}`);
    if (tg.pins.how_to_buy) lines.push(`  - How to buy: ${tg.pins.how_to_buy}`);
    if (tg.pins.memekit) lines.push(`  - Memekit: ${tg.pins.memekit}`);
  }
  if (Array.isArray(tg?.schedule)) {
    lines.push(`- Scheduled posts (${tg.schedule.length}):`);
    tg.schedule.forEach((item: any) => {
      lines.push(`  - ${item.when}: ${item.text}`);
    });
  }
  lines.push('## X');
  if (x?.main_post) lines.push(`- Main post: ${x.main_post}`);
  if (Array.isArray(x?.thread) && x.thread.length) {
    lines.push(`- Thread (${x.thread.length}):`);
    x.thread.forEach((post: string, idx: number) => lines.push(`  ${idx + 1}. ${post}`));
  }
  if (Array.isArray(x?.schedule)) {
    lines.push(`- Scheduled posts (${x.schedule.length}):`);
    x.schedule.forEach((item: any) => {
      lines.push(`  - ${item.when}: ${item.text}`);
    });
  }

  const markdown = lines.join('\n');

  const csvRows: string[] = ['channel,when,text'];
  (tg?.schedule || []).forEach((item: any) => {
    csvRows.push(`telegram,${item.when},"${(item.text || '').replace(/"/g, '""')}"`);
  });
  (x?.schedule || []).forEach((item: any) => {
    csvRows.push(`x,${item.when},"${(item.text || '').replace(/"/g, '""')}"`);
  });
  const csv = csvRows.join('\n');

  return { ...payload, markdown, csv };
}

function unauthorized(res: http.ServerResponse) {
  sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } });
}

function notFound(res: http.ServerResponse) {
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Resource not found' } });
}

function methodNotAllowed(res: http.ServerResponse) {
  sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
}

function badRequest(res: http.ServerResponse, error: JsonError) {
  sendJson(res, 400, { error });
}

function forbidden(res: http.ServerResponse, error: JsonError) {
  sendJson(res, 403, { error });
}

function conflict(res: http.ServerResponse, error: JsonError) {
  sendJson(res, 409, { error });
}

export async function startLaunchKitServer(options: LaunchKitServerOptions = {}) {
  const env = getEnv();
  const port = options.port ?? Number(process.env.PORT ?? process.env.LAUNCHKIT_PORT ?? env.LAUNCHKIT_PORT ?? 8787);
  const adminToken = (options.adminToken || env.ADMIN_TOKEN || '').trim();
  console.log(`[LaunchKit] Admin token configured: ${adminToken ? adminToken.substring(0, 10) + '...' : 'NONE'}`);
  console.log(`[LaunchKit] env.ADMIN_TOKEN: ${env.ADMIN_TOKEN?.substring(0, 10) || 'undefined'}`);
  console.log(`[LaunchKit] process.env.ADMIN_TOKEN: ${process.env.ADMIN_TOKEN?.substring(0, 10) || 'undefined'}`);
  const store =
    options.store ||
    ((await LaunchPackRepository.create()) as LaunchPackStore);

  const runtime = options.runtime;
  const copyService = options.copyService || new CopyGeneratorService(store, runtime);
  const secretsStore = options.pumpService ? undefined : await createSecretsStore();
  const pumpService =
    options.pumpService ||
    new PumpLauncherService(
      store,
      {
        maxDevBuy: env.MAX_SOL_DEV_BUY,
        maxPriorityFee: env.MAX_PRIORITY_FEE,
        maxLaunchesPerDay: env.MAX_LAUNCHES_PER_DAY,
      },
      secretsStore!
    );
  const telegramPublisher = options.telegramPublisher || new TelegramPublisherService(store);
  const xPublisher = options.xPublisher || new XPublisherService(store);

  // Check DB readiness on startup
  if (!cachedDbReadiness) {
    cachedDbReadiness = await checkDatabaseReadiness(env.DATABASE_URL);
    logDbReadinessSummary(cachedDbReadiness);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (isHealth(pathname)) {
      // Return structured health response with DB readiness
      const health = {
        ok: true,
        uptime: process.uptime(),
        launchkit: true,
        db: cachedDbReadiness ? {
          mode: cachedDbReadiness.mode,
          ready: cachedDbReadiness.ready,
          vectorEnabled: cachedDbReadiness.vectorEnabled,
          centralDbReady: cachedDbReadiness.centralDbReady,
          launchPacksReady: cachedDbReadiness.launchPacksReady,
        } : { mode: 'unknown', ready: false },
        env: {
          LAUNCHKIT_ENABLE: env.launchkitEnabled,
          TREASURY_ENABLE: env.treasuryEnabled,
          AUTO_WITHDRAW_ENABLE: env.autoWithdrawEnabled,
          AUTO_SELL_ENABLE: env.autoSellEnabled,
        },
      };
      sendJson(res, 200, health);
      return;
    }

    // Telegram webhook interceptor - caches user IDs before ElizaOS processes messages
    // This endpoint receives Telegram updates and extracts user_id for kick functionality
    if (pathname === '/telegram-webhook' || pathname.startsWith('/telegram-webhook/')) {
      try {
        const update = await readJson<any>(req);
        
        // Extract user info from various update types
        const message = update.message || update.edited_message || update.channel_post;
        const callbackQuery = update.callback_query;
        
        let from: any = null;
        let chatId: string | null = null;
        let messageId: number | undefined;
        
        if (message?.from) {
          from = message.from;
          chatId = String(message.chat?.id);
          messageId = message.message_id;
        } else if (callbackQuery?.from) {
          from = callbackQuery.from;
          chatId = String(callbackQuery.message?.chat?.id);
          messageId = callbackQuery.message?.message_id;
        }
        
        if (from && chatId) {
          cacheTelegramUser(chatId, {
            id: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
          }, messageId);
          
          console.log(`[TG_WEBHOOK] Cached user ${from.id} (@${from.username || from.first_name}) for chat ${chatId}`);
        }
        
        // Process /ban and /kick commands through our handler
        // This gives us access to reply_to_message.from.id for banning
        try {
          await processBanUpdate(update);
        } catch (banErr) {
          console.error('[TG_WEBHOOK] Ban handler error:', banErr);
        }
        
        // Forward to ElizaOS webhook if configured
        const elizaWebhookUrl = process.env.ELIZA_TELEGRAM_WEBHOOK_URL;
        if (elizaWebhookUrl) {
          try {
            await fetch(elizaWebhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(update),
            });
          } catch (fwdErr) {
            console.error('[TG_WEBHOOK] Failed to forward to ElizaOS:', fwdErr);
          }
        }
        
        // Return OK to Telegram
        sendJson(res, 200, { ok: true });
        return;
      } catch (err) {
        console.error('[TG_WEBHOOK] Error processing update:', err);
        sendJson(res, 200, { ok: true }); // Always return 200 to Telegram
        return;
      }
    }

    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      unauthorized(res);
      return;
    }

    // POST /v1/launchpacks/:id/generate
    const genMatch = pathname.match(/^\/v1\/launchpacks\/([^/]+)\/generate$/);
    if (genMatch) {
      const idParam = genMatch[1];
      try {
        idSchema.parse(idParam);
      } catch {
        badRequest(res, { code: 'INVALID_ID', message: 'Invalid launchPack id' });
        return;
      }
      if (req.method !== 'POST') {
        methodNotAllowed(res);
        return;
      }
      try {
        const body = generateBodySchema.parse(await readJson(req));
        const updated = await copyService.generateForLaunchPack(idParam, {
          theme: body.theme,
          keywords: body.keywords,
          tone: body.tone,
        });
        sendJson(res, 200, { data: updated });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Generation failed';
        badRequest(res, { code: 'GENERATION_FAILED', message: msg });
      }
      return;
    }

    // POST /v1/launchpacks/:id/launch
    const launchMatch = pathname.match(/^\/v1\/launchpacks\/([^/]+)\/launch$/);
    if (launchMatch) {
      const idParam = launchMatch[1];
      try {
        idSchema.parse(idParam);
      } catch {
        badRequest(res, { code: 'INVALID_ID', message: 'Invalid launchPack id' });
        return;
      }
      if (req.method !== 'POST') {
        methodNotAllowed(res);
        return;
      }
      try {
        const body = await readJson<{ force?: boolean; skipTelegramCheck?: boolean }>(req);
        const updated = await pumpService.launch(idParam, { 
          force: Boolean(body?.force),
          skipTelegramCheck: Boolean(body?.skipTelegramCheck)
        });
        sendJson(res, 200, { data: updated });
      } catch (error) {
        const err = error as Error & { code?: string };
        const code = err.code || 'LAUNCH_FAILED';
        const details = (err as any).details;
        if (code === 'LAUNCH_DISABLED') {
          forbidden(res, { code, message: err.message });
          return;
        }
        if (
          code === 'LAUNCH_IN_PROGRESS' ||
          code === 'ALREADY_LAUNCHED' ||
          code === 'LAUNCH_FAILED_RETRY_BLOCKED'
        ) {
          conflict(res, { code, message: err.message });
          return;
        }
        if (code === 'CAP_EXCEEDED' || code === 'LAUNCH_REQUIREMENTS_MISSING') {
          badRequest(res, { code, message: err.message, details });
          return;
        }
        if (code === 'LOGO_REQUIRED') {
          badRequest(res, { code, message: err.message });
          return;
        }
        if (code === 'LOGO_FETCH_FAILED' || code === 'SLIPPAGE_INVALID' || code === 'MINT_MISMATCH') {
          badRequest(
            res,
            details !== undefined ? { code, message: err.message, details } : { code, message: err.message }
          );
          return;
        }
        badRequest(res, { code, message: err.message });
      }
      return;
    }

    const publishTgMatch = pathname.match(/^\/v1\/launchpacks\/([^/]+)\/publish\/telegram$/);
    if (publishTgMatch) {
      const idParam = publishTgMatch[1];
      try {
        idSchema.parse(idParam);
      } catch {
        badRequest(res, { code: 'INVALID_ID', message: 'Invalid launchPack id' });
        return;
      }
      if (req.method !== 'POST') {
        methodNotAllowed(res);
        return;
      }
      try {
        const body = await readJson<{ force?: boolean }>(req);
        const updated = await telegramPublisher.publish(idParam, { force: Boolean(body?.force) });
        sendJson(res, 200, { data: updated });
      } catch (error) {
        const err = error as Error & { code?: string };
        const code = err.code || 'TG_PUBLISH_FAILED';
        if (code === 'TG_DISABLED') {
          forbidden(res, { code, message: err.message });
          return;
        }
        if (code === 'TG_PUBLISH_IN_PROGRESS' || code === 'TG_ALREADY_PUBLISHED' || code === 'TG_RETRY_BLOCKED') {
          conflict(res, { code, message: err.message });
          return;
        }
        if (code === 'TG_CONFIG_MISSING' || code === 'TG_NOT_READY') {
          const details = (err as any).details;
          badRequest(res, details ? { code, message: err.message, details } : { code, message: err.message });
          return;
        }
        badRequest(res, { code, message: err.message });
      }
      return;
    }

    const publishXMatch = pathname.match(/^\/v1\/launchpacks\/([^/]+)\/publish\/x$/);
    if (publishXMatch) {
      const idParam = publishXMatch[1];
      try {
        idSchema.parse(idParam);
      } catch {
        badRequest(res, { code: 'INVALID_ID', message: 'Invalid launchPack id' });
        return;
      }
      if (req.method !== 'POST') {
        methodNotAllowed(res);
        return;
      }
      try {
        const body = await readJson<{ force?: boolean }>(req);
        const updated = await xPublisher.publish(idParam, { force: Boolean(body?.force) });
        sendJson(res, 200, { data: updated });
      } catch (error) {
        const err = error as Error & { code?: string };
        const code = err.code || 'X_PUBLISH_FAILED';
        if (code === 'X_DISABLED') {
          forbidden(res, { code, message: err.message });
          return;
        }
        if (code === 'X_PUBLISH_IN_PROGRESS' || code === 'X_ALREADY_PUBLISHED' || code === 'X_RETRY_BLOCKED') {
          conflict(res, { code, message: err.message });
          return;
        }
        if (code === 'X_CONFIG_MISSING' || code === 'X_NOT_READY') {
          const details = (err as any).details;
          badRequest(res, details ? { code, message: err.message, details } : { code, message: err.message });
          return;
        }
        badRequest(res, { code, message: err.message });
      }
      return;
    }

    const exportMatch = pathname.match(/^\/v1\/launchpacks\/([^/]+)\/export$/);
    if (exportMatch) {
      const idParam = exportMatch[1];
      try {
        idSchema.parse(idParam);
      } catch {
        badRequest(res, { code: 'INVALID_ID', message: 'Invalid launchPack id' });
        return;
      }
      if (req.method !== 'GET') {
        methodNotAllowed(res);
        return;
      }
      const pack = await store.get(idParam);
      if (!pack) {
        notFound(res);
        return;
      }
      const payload = buildExportPayload(pack);
      const accept = String(req.headers['accept'] || '').toLowerCase();
      if (accept.includes('text/markdown')) {
        const body = payload.markdown as string;
        const buf = Buffer.from(body, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/markdown',
          'Content-Length': buf.byteLength,
        });
        res.end(buf);
        return;
      }
      sendJson(res, 200, { data: payload });
      return;
    }

    // POST /v1/tweet - Send a direct tweet (for testing)
    if (pathname === '/v1/tweet' && req.method === 'POST') {
      try {
        const body = await readJson<{ text: string }>(req);
        if (!body?.text) {
          badRequest(res, { code: 'INVALID_BODY', message: 'text is required' });
          return;
        }
        const result = await xPublisher.tweet(body.text);
        sendJson(res, 200, { data: result });
      } catch (error) {
        const err = error as Error & { code?: string };
        badRequest(res, { code: err.code || 'TWEET_FAILED', message: err.message });
      }
      return;
    }

    if (pathname === '/v1/launchpacks' && req.method === 'POST') {
      try {
        const payload = await readJson<LaunchPackCreateInput>(req);
        const body = LaunchPackValidation.create(payload);
        if (!body.id) body.id = randomUUID();
        const created = await store.create(body);
        sendJson(res, 201, { data: created });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid payload';
        badRequest(res, { code: 'INVALID_INPUT', message });
      }
      return;
    }

    if (pathname === '/v1/launchpacks' && req.method === 'GET') {
      try {
        const packs = await store.list();
        sendJson(res, 200, { data: packs });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list LaunchPacks';
        sendJson(res, 500, { error: { code: 'LIST_FAILED', message } });
      }
      return;
    }

    const match = pathname.match(/^\/v1\/launchpacks\/([^/]+)$/);
    if (match) {
      const id = match[1];
      if (req.method === 'GET') {
        const found = await store.get(id);
        if (!found) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { data: found });
        return;
      }

      if (req.method === 'DELETE') {
        // Handle "all" to delete all unlaunched
        if (id === 'all') {
          try {
            const packs = await store.list();
            const notLaunched = packs.filter((p: any) => p.launch?.status !== 'launched');
            let deleted = 0;
            for (const pack of notLaunched) {
              await store.delete(pack.id);
              deleted++;
            }
            sendJson(res, 200, { 
              data: { deleted, preserved: packs.length - notLaunched.length },
              message: `Deleted ${deleted} unlaunched LaunchPacks`
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Delete failed';
            badRequest(res, { code: 'DELETE_FAILED', message });
          }
          return;
        }
        
        // Delete single pack
        try {
          const found = await store.get(id);
          if (!found) {
            notFound(res);
            return;
          }
          if (found.launch?.status === 'launched') {
            forbidden(res, { code: 'CANNOT_DELETE_LAUNCHED', message: 'Cannot delete launched tokens' });
            return;
          }
          await store.delete(id);
          sendJson(res, 200, { data: { deleted: true, id } });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Delete failed';
          badRequest(res, { code: 'DELETE_FAILED', message });
        }
        return;
      }

      if (req.method === 'PATCH') {
        try {
          const payload = await readJson<LaunchPackUpdateInput>(req);
          const updated = await store.update(id, payload);
          sendJson(res, 200, { data: updated });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Update failed';
          badRequest(res, { code: 'INVALID_INPUT', message });
        }
        return;
      }

      methodNotAllowed(res);
      return;
    }

    notFound(res);
  });

  // Bind to 0.0.0.0 for Railway compatibility (not just localhost)
  const host = process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '0.0.0.0';
  
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  
  // Use Railway public URL if available, otherwise localhost
  const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${actualPort}`;
  const baseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
  
  console.log(`[LaunchKit] Server listening on ${host}:${actualPort}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    console.log(`[LaunchKit] Public URL: ${publicUrl}`);
  }

  return {
    server,
    port: actualPort,
    baseUrl,
    publicUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(async (err) => {
          try {
            if (secretsStore?.close) await secretsStore.close();
          } finally {
            if (err) reject(err);
            else resolve();
          }
        })
      ),
  };
}
