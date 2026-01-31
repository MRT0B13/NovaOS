import type { Plugin } from '@elizaos/core';
import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import { setMascotAction } from './launchkit/eliza/mascotAction.ts';
import type { LaunchPackStore } from './launchkit/db/launchPackRepository.ts';
import { CopyGeneratorService } from './launchkit/services/copyGenerator.ts';
import { PumpLauncherService } from './launchkit/services/pumpLauncher.ts';
import { TelegramPublisherService } from './launchkit/services/telegramPublisher.ts';
import { TelegramCommunityService } from './launchkit/services/telegramCommunity.ts';
import { XPublisherService } from './launchkit/services/xPublisher.ts';
import { generateLaunchPackCopyAction } from './launchkit/eliza/generateAction.ts';
import { initLaunchKit } from './launchkit/init.ts';
import { recentMessagesProvider } from './launchkit/providers/recentMessages.ts';
import { groupContextProvider } from './launchkit/eliza/groupContextProvider.ts';

import { 
  launchLaunchPackAction,
  publishTelegramAction,
  sendTelegramMessageAction,
  retryTelegramAnnouncementAction,
  publishXAction, 
  listLaunchPacksAction,
  viewLaunchPackAction,
  deleteLaunchPackAction,
  checkXQuotaAction,
  markAsLaunchedAction
} from './launchkit/eliza/publishActions.ts';

import { 
  checkWalletBalancesAction, 
  depositToPumpWalletAction, 
  withdrawFromPumpWalletAction,
  sellTokenAction,
  buyTokenAction,
  reportHoldingsAction,
  withdrawToTreasuryAction,
  checkTreasuryStatusAction
} from './launchkit/eliza/walletActions.ts';

import { 
  linkTelegramGroupAction, 
  checkTelegramGroupAction, 
  greetNewTelegramGroupAction,
  verifyTelegramSetupAction,
  verifyAllTelegramAction,
  updateSocialLinksAction,
  preLaunchChecklistAction,
  communityEngagementAction,
  renameLaunchPackAction,
  kickSpammerAction,
  muteUserAction,
  listTelegramGroupsAction,
  listMascotsAction,
  listScamWarningsAction,
  listLaunchedTokensAction,
  listDraftTokensAction,
  groupHealthCheckAction,
  analyzeSentimentAction,
  pinMessageAction,
  crossPostAction
} from './launchkit/eliza/telegramActions.ts';


import { 
  tweetAboutTokenAction,
  scheduleMarketingAction,
  viewScheduledTweetsAction,
  cancelMarketingAction,
  regenerateScheduledTweetsAction,
  previewTweetAction
} from './launchkit/eliza/xMarketingActions.ts';

import {
  scheduleTGMarketingAction,
  viewTGScheduleAction,
  cancelTGMarketingAction,
  previewTGPostAction,
  sendTGShillAction
} from './launchkit/eliza/telegramMarketingActions.ts';

import { systemReportAction } from './launchkit/eliza/systemReportAction.ts';

import { startHealthMonitor } from './launchkit/services/groupHealthMonitor.ts';
import { validateStartupInvariants } from './launchkit/services/operatorGuardrails.ts';
import { startAutoSellScheduler, stopAutoSellScheduler } from './launchkit/services/autoSellPolicy.ts';
import { startTreasuryScheduler, stopTreasuryScheduler } from './launchkit/services/treasuryScheduler.ts';
import { startTelegramHealthMonitor, stopTelegramHealthMonitor } from './launchkit/services/telegramHealthMonitor.ts';
import { stopSystemReporter } from './launchkit/services/systemReporter.ts';
import { stopTGScheduler } from './launchkit/services/telegramScheduler.ts';
import { redactEnvForLogging } from './launchkit/services/redact.ts';
import { getEnv } from './launchkit/env.ts';
import { initNovaChannel, announceSystem } from './launchkit/services/novaChannel.ts';



class LaunchKitBootstrapService extends Service {
  static serviceType = 'launchkit_bootstrap';
  private server?: { baseUrl: string; close: () => Promise<void> };
  private closeFn?: () => Promise<void>;
  private store?: LaunchPackStore;
  private copyService?: CopyGeneratorService;
  private pumpService?: PumpLauncherService;
  private telegramPublisher?: TelegramPublisherService;
  private telegramCommunity?: TelegramCommunityService;
  private xPublisher?: XPublisherService;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  capabilityDescription = 'LaunchKit bootstrap and HTTP server lifecycle management';

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting LaunchKit bootstrap ***');
    
    // Validate startup invariants for treasury and guardrails
    const invariantCheck = validateStartupInvariants();
    if (!invariantCheck.valid) {
      for (const error of invariantCheck.errors) {
        logger.error(`[LaunchKit] Startup invariant violation: ${error}`);
      }
      throw new Error(`LaunchKit startup failed: ${invariantCheck.errors.join('; ')}`);
    }
    
    // Log safe environment config
    try {
      const env = getEnv();
      const safeEnv = redactEnvForLogging(env);
      logger.info('[LaunchKit] Environment configuration:', safeEnv);
    } catch (envError) {
      logger.error('[LaunchKit] Environment validation failed:', envError);
      throw envError;
    }
    
    const service = new LaunchKitBootstrapService(runtime);
    const { server, close, store, copyService, pumpService, telegramPublisher, telegramCommunity, xPublisher } = await initLaunchKit(runtime);
    service.server = server;
    service.closeFn = close ?? server?.close;
    service.store = store;
    service.copyService = copyService;
    service.pumpService = pumpService;
    service.telegramPublisher = telegramPublisher;
    service.telegramCommunity = telegramCommunity;
    service.xPublisher = xPublisher;
    
    // NOTE: startSystemReporter() and startTGScheduler() are now called in init.ts
    // to ensure proper initialization order (systemReporter must be first for PostgreSQL)
    
    // Start group health monitor (if store available)
    if (store) {
      startHealthMonitor(store);
      logger.info('[HealthMonitor] Started group health monitoring');
    }
    
    // Initialize Nova channel (agent's own TG channel for announcements)
    const novaChannelConfig = initNovaChannel();
    if (novaChannelConfig.enabled) {
      // Announce startup
      await announceSystem('startup', `Nova is online! 🚀\n\nMonitoring ${store ? 'LaunchKit' : 'services'}...`);
    }
    
    // Start auto-sell scheduler (disabled by default via env flags)
    startAutoSellScheduler();
    
    // Start treasury sweep scheduler (disabled by default via env flags)
    startTreasuryScheduler();
    
    // Start Telegram health monitor (alerts if bot stops receiving messages)
    startTelegramHealthMonitor(runtime);
    
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(LaunchKitBootstrapService.serviceType) as LaunchKitBootstrapService | undefined;
    if (service) await service.stop();
  }

  async stop() {
    // Stop TG marketing scheduler
    stopTGScheduler();
    
    // Stop auto-sell scheduler
    stopAutoSellScheduler();
    
    // Stop treasury scheduler
    stopTreasuryScheduler();
    
    // Stop Telegram health monitor
    stopTelegramHealthMonitor();
    
    // Stop system reporter
    stopSystemReporter();
    
    if (this.closeFn) {
      await this.closeFn();
    } else if (this.server) {
      await this.server.close();
    }
    this.server = undefined;
    this.closeFn = undefined;
    this.store = undefined;
    this.copyService = undefined;
    this.pumpService = undefined;
    this.telegramPublisher = undefined;
    this.telegramCommunity = undefined;
    this.xPublisher = undefined;
  }

  getLaunchKit() {
    return {
      store: this.store,
      copyService: this.copyService,
      pumpService: this.pumpService,
      telegramPublisher: this.telegramPublisher,
      telegramCommunity: this.telegramCommunity,
      xPublisher: this.xPublisher,
    };
  }
}

const plugin: Plugin = {
  name: 'launchkit',
  description: 'LaunchKit actions and HTTP server bootstrap',
  priority: 0,
  services: [LaunchKitBootstrapService],
  actions: [
    checkWalletBalancesAction,
    depositToPumpWalletAction,
    withdrawFromPumpWalletAction,
    withdrawToTreasuryAction,
    checkTreasuryStatusAction,
    sellTokenAction,
    buyTokenAction,
    reportHoldingsAction,
    generateLaunchPackCopyAction,
    launchLaunchPackAction,
    publishTelegramAction,
    sendTelegramMessageAction,
    retryTelegramAnnouncementAction,
    publishXAction,
    checkXQuotaAction,
    tweetAboutTokenAction,
    scheduleMarketingAction,
    viewScheduledTweetsAction,
    cancelMarketingAction,
    regenerateScheduledTweetsAction,
    previewTweetAction,
    listLaunchPacksAction,
    viewLaunchPackAction,
    deleteLaunchPackAction,
    markAsLaunchedAction,
    linkTelegramGroupAction,
    checkTelegramGroupAction,
    greetNewTelegramGroupAction,
    verifyTelegramSetupAction,
    verifyAllTelegramAction,
    updateSocialLinksAction,
    preLaunchChecklistAction,
    communityEngagementAction,
    renameLaunchPackAction,
    setMascotAction,
    kickSpammerAction,
    muteUserAction,
    listTelegramGroupsAction,
    listMascotsAction,
    listScamWarningsAction,
    listLaunchedTokensAction,
    listDraftTokensAction,
    // TG Marketing
    scheduleTGMarketingAction,
    viewTGScheduleAction,
    cancelTGMarketingAction,
    previewTGPostAction,
    sendTGShillAction,
    // Group Health & Cross-Platform
    groupHealthCheckAction,
    analyzeSentimentAction,
    pinMessageAction,
    crossPostAction,
    // System
    systemReportAction
  ],
  providers: [groupContextProvider, recentMessagesProvider],
};

export { LaunchKitBootstrapService };
export default plugin;
