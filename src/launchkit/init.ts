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
import { startSystemReporter, stopSystemReporter, registerSwarmHandle } from './services/systemReporter.ts';
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
          case 'reduce_frequency': {
            const newMax = params.newMaxRepliesPerHour ?? 2;
            const resumeMs = params.resumeAfterMs ?? 900_000;
            logger.warn(`[Nova] Health Agent: reducing reply frequency to ${newMax}/hr for ${Math.round(resumeMs / 60_000)}min`);
            try {
              // Dynamically update REPLY_RULES (mutable export)
              const { REPLY_RULES } = await import('./reply-rules.ts');
              const originalMax = REPLY_RULES.maxTotalRepliesPerHour;
              REPLY_RULES.maxTotalRepliesPerHour = newMax;
              setTimeout(() => {
                REPLY_RULES.maxTotalRepliesPerHour = originalMax;
                logger.info(`[Nova] Reply frequency restored to ${originalMax}/hr`);
              }, resumeMs);
            } catch {
              logger.warn('[Nova] Could not update reply rules');
            }
            break;
          }
          case 'wait_and_retry':
            // Twitter 503 — nothing to do actally; the reply engine will
            // naturally back off because canPost checks will fail on the
            // X API.  Log for visibility.
            logger.warn(`[Nova] Health Agent: Twitter API 503 — will retry after ${Math.round((params.retryAfterMs || 300_000) / 60_000)}min`);
            break;
          case 'rotate_rpc':
            // Already handled directly in monitor.ts via rotateRpc()
            logger.info(`[Nova] Health Agent: RPC rotation applied`);
            break;
          case 'switch_model':
            // Already handled directly in monitor.ts via switchProvider()
            logger.info(`[Nova] Health Agent: model switch applied → ${params.fallback}`);
            break;
          case 'emergency_reconnect':
            logger.warn(`[Nova] Health Agent: DB reconnection requested`);
            // Pool auto-reconnects on next query; log to surface the issue
            break;
          case 'disable_agent':
            logger.warn(`[Nova] Health Agent: disabling agent — manual intervention needed`);
            break;
          case 'restart_agent':
            logger.warn(`[Nova] Health Agent: agent restart requested`);
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
      pool = new Pool({
        connectionString: databaseUrl,
        // Prevent hung queries from stalling the supervisor poll loop
        statement_timeout: 15_000,        // kill queries after 15s
        connectionTimeoutMillis: 10_000,  // fail fast if no connection in 10s
        max: 10,
      });
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
      if (pool) {
        await initEngagementTracker(pool);
        logger.info('[LaunchKit] 📊 Engagement tracker initialized');
      }
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

  // Retry command registration until the Telegram bot is ready.
  // On cold starts the bot handshake can take 10-20s, so a single 5s
  // setTimeout is a race condition. We poll every 3s for up to 45s.
  (async () => {
    const MAX_ATTEMPTS = 15;
    const RETRY_INTERVAL_MS = 3_000;
    const INITIAL_DELAY_MS = 5_000;

    await new Promise(r => setTimeout(r, INITIAL_DELAY_MS));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Gate: only proceed if bot is actually available
      const tgService = runtime.getService('telegram') as any;
      const bot = tgService?.messageManager?.bot;

      if (!bot) {
        logger.debug(`[LaunchKit] TG bot not ready — attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_INTERVAL_MS / 1000}s`);
        await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
        continue;
      }

      // ── Bot is ready — run all registrations ──

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

      try {
        const healthRegistered = await registerHealthCommands(runtime);
        if (healthRegistered) {
          logger.info('[LaunchKit] 🏥 Health TG commands registered (/health, /errors, /repairs)');
        }
      } catch (healthErr) {
        logger.warn({ error: healthErr }, 'Failed to register health TG commands (non-fatal)');
      }

      if (_swarmHandle) {
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
            try {
              const { canWrite, getDailyWritesRemaining } = await import('./services/xRateLimiter.ts');
              if (!canWrite()) {
                logger.info(`[swarm] Supervisor → X post skipped: daily quota exhausted (${getDailyWritesRemaining()} remaining)`);
                return;
              }
              await xPublisher.tweet(content);
            } catch (err) {
              logger.warn('[swarm] Supervisor → X post failed:', err);
            }
          },
          onPostToTelegram: async (chatId: string, content: string) => {
            try {
              const tgSvc = runtime.getService('telegram') as any;
              const b = tgSvc?.messageManager?.bot;
              if (b) {
                await b.telegram.sendMessage(chatId, content, { parse_mode: 'Markdown' });
              } else {
                logger.warn('[swarm] Supervisor → TG: no bot instance available');
              }
            } catch (err) {
              logger.warn('[swarm] Supervisor → TG post failed:', err);
            }
          },
          onPostToAdmin: async (content: string) => {
            try {
              const { notifyAdminForce } = await import('./services/adminNotify.ts');
              await notifyAdminForce(content);
            } catch (err) {
              logger.warn('[swarm] Supervisor → Admin post failed:', err);
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

        try {
          _swarmHandle.guardian.setSecurityCallbacks({
            onAdminAlert: async (message: string, severity: string) => {
              try {
                const { notifyAdminForce } = await import('./services/adminNotify.ts');
                await notifyAdminForce(`🛡️ SECURITY ${severity.toUpperCase()}\n\n${message}`);
              } catch (err) {
                logger.warn('[swarm] Guardian → Admin security alert failed:', err);
              }
            },
          });
          logger.info('[LaunchKit] 🛡️ Guardian security callbacks wired');
        } catch (secErr) {
          logger.warn('[LaunchKit] Security callbacks failed (non-fatal):', secErr);
        }

        try {
          const scanRegistered = await registerScanCommand(runtime, _swarmHandle.supervisor);
          if (scanRegistered) {
            logger.info('[LaunchKit] 🔍 Scan TG commands registered (/scan, /children)');
          }
        } catch (scanErr) {
          logger.warn({ error: scanErr }, 'Failed to register scan commands (non-fatal)');
        }

        if (pool) {
          try {
            const factoryRegistered = await registerFactoryCommands(runtime, _swarmHandle.supervisor, pool);
            if (factoryRegistered) {
              logger.info('[LaunchKit] 🏭 Factory TG commands registered (/request_agent, /approve_agent, /my_agents, /cfo)');
            }
          } catch (factoryErr) {
            logger.warn({ error: factoryErr }, 'Failed to register factory commands (non-fatal)');
          }
        }
      }

      logger.info(`[LaunchKit] ✅ TG commands registered successfully (attempt ${attempt})`);
      return; // done — stop retrying
    }

    logger.error('[LaunchKit] ❌ TG command registration failed after all attempts — /cfo and other commands will not work until restart');
  })();

  // Start system reporter FIRST (initializes PostgreSQL for metric tracking)
  // Must be before TG/X schedulers so recordTGPostSent()/recordTweetSent() can use PostgreSQL
  await startSystemReporter();

  // Register swarm handle so status reports include agent data
  if (_swarmHandle) {
    registerSwarmHandle(_swarmHandle);
  }

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
