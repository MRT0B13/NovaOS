import { logger, type IAgentRuntime } from '@elizaos/core';
import { CopyGeneratorService } from './services/copyGenerator.ts';
import { PumpLauncherService } from './services/pumpLauncher.ts';
import { startLaunchKitServer } from './api/server.ts';
import {
  createLaunchPackStoreFromEnv,
  createSecretsStore,
  type LaunchPackStoreWithClose,
} from './db/storeFactory.ts';
import { getEnv } from './env.ts';
import type { LaunchPackStore } from './db/launchPackRepository.ts';
import { TelegramPublisherService } from './services/telegramPublisher.ts';
import { TelegramCommunityService } from './services/telegramCommunity.ts';
import { XPublisherService } from './services/xPublisher.ts';
import { registerBanCommands } from './services/telegramBanHandler.ts';
import { initializeFromStore as initGroupTracker } from './services/groupTracker.ts';
import { processScheduledTweets, getPendingTweets, recoverMarketingFromStore, syncMarketingToStore, startXScheduler, stopXScheduler } from './services/xScheduler.ts';
import { startAutonomousMode, stopAutonomousMode } from './services/autonomousMode.ts';
import { startTGScheduler, stopTGScheduler } from './services/telegramScheduler.ts';

/**
 * Log Railway-specific environment info at startup
 */
function logRailwayEnvironment(): void {
  const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const port = process.env.PORT;
  const hasDbUrl = Boolean(process.env.DATABASE_URL);
  
  if (isRailway) {
    logger.info(`[LaunchKit] 🚂 Railway environment detected`);
    logger.info(`[LaunchKit]   - PORT: ${port || 'not set'}`);
    logger.info(`[LaunchKit]   - DATABASE_URL: ${hasDbUrl ? 'set' : 'NOT SET (will use pglite)'}`);
    if (publicDomain) {
      logger.info(`[LaunchKit]   - Public URL: https://${publicDomain}`);
    }
  }
}

export async function initLaunchKit(
  runtime: IAgentRuntime,
  options: { store?: LaunchPackStoreWithClose } = {}
): Promise<{
  store: LaunchPackStore;
  copyService: CopyGeneratorService;
  pumpService: PumpLauncherService;
  telegramPublisher: TelegramPublisherService;
  telegramCommunity: TelegramCommunityService;
  xPublisher: XPublisherService;
  server?: { baseUrl: string; close: () => Promise<void> };
  close?: () => Promise<void>;
}> {
  // Log Railway environment info
  logRailwayEnvironment();
  
  const env = getEnv();
  const storeWithClose = options.store ?? (await createLaunchPackStoreFromEnv());
  const store: LaunchPackStore = storeWithClose;
  const closeStore = storeWithClose.close;
  const secretsStore = await createSecretsStore();

  const copyService = new CopyGeneratorService(store, runtime);
  const pumpService = new PumpLauncherService(store, {
    maxDevBuy: env.MAX_SOL_DEV_BUY,
    maxPriorityFee: env.MAX_PRIORITY_FEE,
    maxLaunchesPerDay: env.MAX_LAUNCHES_PER_DAY,
  }, secretsStore);
  const telegramPublisher = new TelegramPublisherService(store);
  const telegramCommunity = new TelegramCommunityService(store, runtime);
  const xPublisher = new XPublisherService(store);

  // Auto-fix: Correct status for tokens that have mint addresses but wrong status
  // This runs on every restart as a safety net for database sync issues
  try {
    const allPacks = await store.list();
    let fixedCount = 0;
    for (const pack of allPacks) {
      if (pack.launch?.mint && pack.launch?.status !== 'launched') {
        // Silent fix - only log at debug level since this is expected on restart
        await store.update(pack.id, {
          launch: { ...pack.launch, status: 'launched' }
        });
        fixedCount++;
      }
    }
    if (fixedCount > 0) {
      logger.info(`[LaunchKit] ✅ Verified ${fixedCount} launched token(s) status`);
    }
  } catch (err) {
    logger.warn({ error: err }, '[LaunchKit] Failed to verify launch statuses (non-fatal)');
  }

  // Auto-fix: Update migrated Telegram supergroup chat IDs
  // When a group upgrades to supergroup, Telegram creates a new chat ID
  // This maps old IDs to new ones discovered via group context
  const CHAT_ID_MIGRATIONS: Record<string, string> = {
    '-5130266815': '-1003519261621', // Ferb group migration
  };
  try {
    const allPacks = await store.list();
    for (const pack of allPacks) {
      const currentChatId = pack.tg?.telegram_chat_id || pack.tg?.chat_id;
      const newChatId = currentChatId ? CHAT_ID_MIGRATIONS[currentChatId] : undefined;
      if (newChatId) {
        logger.info(`[LaunchKit] 🔄 Migrating ${pack.brand?.name || pack.id} chat_id from ${currentChatId} to ${newChatId}`);
        await store.update(pack.id, {
          tg: {
            ...pack.tg,
            telegram_chat_id: newChatId,
            chat_id: newChatId,
          }
        });
      }
    }
  } catch (err) {
    logger.warn({ error: err }, '[LaunchKit] Failed to migrate chat IDs (non-fatal)');
  }

  if (!env.launchkitEnabled) {
    const close = async () => {
      if (secretsStore.close) await secretsStore.close();
      if (closeStore) await closeStore();
    };
    return { store, copyService, pumpService, telegramPublisher, telegramCommunity, xPublisher, close };
  }

  const adminToken = env.LAUNCHKIT_ADMIN_TOKEN || env.ADMIN_TOKEN;
  if (!adminToken) {
    if (closeStore) await closeStore();
    const err = new Error('LAUNCHKIT_ADMIN_TOKEN is required when LAUNCHKIT_ENABLE=true');
    (err as any).code = 'LAUNCHKIT_ADMIN_TOKEN_REQUIRED';
    throw err;
  }

  const port = env.LAUNCHKIT_PORT ?? 8787;
  let serverHandle: Awaited<ReturnType<typeof startLaunchKitServer>>;
  try {
    serverHandle = await startLaunchKitServer({
      port,
      adminToken,
      store,
      runtime,
      copyService,
      pumpService,
    });
  } catch (err) {
    if (closeStore) await closeStore();
    throw err;
  }

  logger.info({ baseUrl: serverHandle.baseUrl, port: serverHandle.port }, 'LaunchKit server started');

  // Initialize group tracker with existing LaunchPacks
  try {
    await initGroupTracker(store);
    logger.info('[LaunchKit] Group tracker initialized from stored LaunchPacks');
  } catch (err) {
    logger.warn({ error: err }, 'Failed to initialize group tracker (non-fatal)');
  }

  // Recover X marketing schedules from database (in case JSON files were lost)
  if (env.X_ENABLE === 'true') {
    try {
      const recovery = await recoverMarketingFromStore(store);
      if (recovery.recovered > 0 || recovery.rescheduled > 0) {
        logger.info(`[LaunchKit] X marketing recovered: ${recovery.recovered} schedules, ${recovery.rescheduled} rescheduled`);
      }
    } catch (err) {
      logger.warn({ error: err }, 'Failed to recover X marketing schedules (non-fatal)');
    }
  }

  // Register ban commands after Telegram service has time to initialize
  // We use a delay because the Telegram plugin starts after this init runs
  setTimeout(async () => {
    try {
      const registered = await registerBanCommands(runtime);
      if (registered) {
        logger.info('[LaunchKit] Telegram ban commands registered (/ban, /kick, /roseban)');
      } else {
        logger.warn('[LaunchKit] Could not register ban commands - Telegram service may not be available');
      }
    } catch (banErr) {
      logger.warn({ error: banErr }, 'Failed to register ban commands (non-fatal)');
    }
  }, 5000); // Wait 5 seconds for Telegram service to initialize

  // Start TG marketing scheduler
  if (env.TG_ENABLE === 'true') {
    await startTGScheduler(store);
    logger.info('[LaunchKit] Started TG marketing scheduler');
  }

  // Start auto-tweet scheduler with auto-refill
  if (env.X_ENABLE === 'true') {
    await startXScheduler(store, async (text: string) => {
      try {
        const result = await xPublisher.tweet(text);
        return result.id;
      } catch (err: any) {
        // Error already logged in xScheduler with proper formatting
        // Just return null to indicate failure
        return null;
      }
    });
  }

  // Start autonomous mode if enabled
  if (env.autonomousEnabled) {
    await startAutonomousMode(store, pumpService);
  }

  const close = async () => {
    try {
      // Clean up autonomous mode
      stopAutonomousMode();
      // Clean up TG scheduler
      stopTGScheduler();
      // Clean up X scheduler
      stopXScheduler();
      // Ban commands don't need explicit cleanup - they're registered on ElizaOS's bot
      await serverHandle.close();
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error closing LaunchKit server');
    } finally {
      if (secretsStore.close) await secretsStore.close();
      if (closeStore) await closeStore();
    }
  };

  return {
    store,
    copyService,
    pumpService,
    telegramPublisher,
    telegramCommunity,
    xPublisher,
    server: { baseUrl: serverHandle.baseUrl, close },
    close,
  };
}
