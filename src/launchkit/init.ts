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
import { startSystemReporter, stopSystemReporter } from './services/systemReporter.ts';
import { initCommunityVoting } from './services/communityVoting.ts';
import { initHealthSystem, stopHealthSystem, getHealthbeat } from './health/singleton';
import { registerHealthCommands } from './services/telegramHealthCommands.ts';
import { registerScanCommand } from './services/telegramScanCommand.ts';
import { registerFactoryCommands } from './services/telegramFactoryCommands.ts';
import { initSwarm, stopSwarm, type SwarmHandle } from '../agents/index.ts';
import { Pool } from 'pg';

// Module-level swarm handle for shutdown
let _swarmHandle: SwarmHandle | null = null;

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

  // Initialize Health Agent system (heartbeat + monitor)
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  let pool: InstanceType<typeof Pool> | null = null;
  if (databaseUrl) {
    try {
      const { heartbeat, monitor } = initHealthSystem(databaseUrl);
      heartbeat.start();
      monitor.start();

      // Handle degradation commands from Health Agent
      heartbeat.onCommand(async (action, params) => {
        switch (action) {
          case 'reduce_frequency':
            logger.warn(`[Nova] Health Agent: reducing reply frequency to ${params.newMaxRepliesPerHour}/hr`);
            setTimeout(() => {
              logger.info('[Nova] Reply frequency cooldown expired');
            }, params.resumeAfterMs || 900_000);
            break;
          case 'rotate_rpc':
            logger.warn(`[Nova] Health Agent: RPC rotation requested → ${params.backupRPCs?.[0]}`);
            break;
          case 'switch_model':
            logger.warn(`[Nova] Health Agent: model switch applied → repair engine now using ${params.fallback}`);
            break;
          default:
            logger.info(`[Nova] Health Agent command: ${action}`);
        }
      });

      logger.info('[LaunchKit] 🏥 Health Agent system initialized (heartbeat + monitor)');
    } catch (healthErr) {
      logger.warn({ error: healthErr }, '[LaunchKit] Health Agent init failed (non-fatal)');
    }

    // Initialize Nova Agent Swarm (5 agents + Supervisor)
    try {
      pool = new Pool({ connectionString: databaseUrl });
      _swarmHandle = await initSwarm(pool, {
        // Callbacks are wired later when xPublisher/novaChannel are available
        // See the setTimeout block below that wires post-init callbacks
      });
      logger.info('[LaunchKit] 🐝 Nova agent swarm initialized (6 agents)');
    } catch (swarmErr) {
      logger.warn({ error: swarmErr }, '[LaunchKit] Agent swarm init failed (non-fatal)');
    }

    // Initialize engagement tracker (creates engagement_log table)
    try {
      const { initEngagementTracker } = await import('./engagement-tracker');
      await initEngagementTracker(pool);
      logger.info('[LaunchKit] 📊 Engagement tracker initialized');
    } catch (engErr) {
      logger.warn({ error: engErr }, '[LaunchKit] Engagement tracker init failed (non-fatal)');
    }
  }

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
      pool,
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

  // Initialize community voting (loads pending votes from PostgreSQL)
  try {
    await initCommunityVoting();
    logger.info('[LaunchKit] Community voting initialized');
  } catch (err) {
    logger.warn({ error: err }, 'Failed to initialize community voting (non-fatal)');
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

    // Also register health commands (/health, /errors, /repairs, /approve, /reject)
    try {
      const healthRegistered = await registerHealthCommands(runtime);
      if (healthRegistered) {
        logger.info('[LaunchKit] 🏥 Health TG commands registered (/health, /errors, /repairs)');
      }
    } catch (healthErr) {
      logger.warn({ error: healthErr }, 'Failed to register health TG commands (non-fatal)');
    }

    // Wire Supervisor callbacks now that X/TG services are ready
    if (_swarmHandle) {
      // Lazy-load Farcaster publisher (only imported if enabled)
      let farcasterPost: ((content: string, channel: string) => Promise<void>) | undefined;
      try {
        const fc = await import('./services/farcasterPublisher.ts');
        if (fc.isFarcasterEnabled()) {
          farcasterPost = async (content: string, channel: string) => {
            await fc.postCast(content, channel as any);
          };
          logger.info('[LaunchKit] 📣 Farcaster publisher enabled');
        }
      } catch { /* Farcaster not configured — skip */ }

      _swarmHandle.supervisor.setCallbacks({
        onPostToX: async (content: string) => {
          try { await xPublisher.tweet(content); } catch (err) {
            logger.warn('[swarm] Supervisor → X post failed:', err);
          }
        },
        onPostToTelegram: async (chatId: string, content: string) => {
          try {
            const tgService = runtime.getService('telegram') as any;
            const bot = tgService?.messageManager?.bot;
            if (bot) {
              await bot.telegram.sendMessage(chatId, content, { parse_mode: 'Markdown' });
            } else {
              logger.warn('[swarm] Supervisor → TG: no bot instance available');
            }
          } catch (err) {
            logger.warn('[swarm] Supervisor → TG post failed:', err);
          }
        },
        onPostToChannel: async (content: string) => {
          try {
            const { sendToCommunity } = await import('./services/novaChannel.ts');
            const result = await sendToCommunity(content);
            if (result.success) {
              logger.info(`[swarm] Supervisor → Community: ${content.slice(0, 80)}...`);
            } else {
              logger.debug(`[swarm] Supervisor → Community skipped (novaChannel disabled or no group configured)`);
            }
          } catch (err) {
            logger.warn('[swarm] Supervisor → Community post failed:', err);
          }
        },
        onPostToFarcaster: farcasterPost,
      });
      logger.info('[LaunchKit] 🐝 Supervisor callbacks wired (X + TG + Channel + Farcaster)');

      // Register /scan and /children TG commands
      try {
        const scanRegistered = await registerScanCommand(runtime, _swarmHandle.supervisor);
        if (scanRegistered) {
          logger.info('[LaunchKit] 🔍 Scan TG commands registered (/scan, /children)');
        }
      } catch (scanErr) {
        logger.warn({ error: scanErr }, 'Failed to register scan commands (non-fatal)');
      }

      // Register /request_agent, /approve_agent, /reject_agent, /my_agents, /stop_agent
      if (pool) {
        try {
          const factoryRegistered = await registerFactoryCommands(runtime, _swarmHandle.supervisor, pool);
          if (factoryRegistered) {
            logger.info('[LaunchKit] 🏭 Factory TG commands registered (/request_agent, /approve_agent, /my_agents)');
          }
        } catch (factoryErr) {
          logger.warn({ error: factoryErr }, 'Failed to register factory commands (non-fatal)');
        }
      }
    }
  }, 5000); // Wait 5 seconds for Telegram service to initialize

  // Start system reporter FIRST (initializes PostgreSQL for metric tracking)
  // Must be before TG/X schedulers so recordTGPostSent()/recordTweetSent() can use PostgreSQL
  await startSystemReporter();

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
      // Clean up agent swarm
      if (_swarmHandle) {
        await stopSwarm(_swarmHandle);
        _swarmHandle = null;
      }
      // Clean up health system
      await stopHealthSystem();
      // Clean up autonomous mode
      stopAutonomousMode();
      // Clean up TG scheduler
      stopTGScheduler();
      // Clean up X scheduler
      stopXScheduler();
      // Clean up system reporter
      stopSystemReporter();
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
