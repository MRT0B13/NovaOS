import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { PumpLauncherService } from './pumpLauncher.ts';
import { generateBestIdea, validateIdea, type TokenIdea } from './ideaGenerator.ts';
import { generateMemeLogo } from './logoGenerator.ts';
import { getPumpWalletBalance, getFundingWalletBalance, depositToPumpWallet } from './fundingWallet.ts';
import { announceSystem } from './novaChannel.ts';
import { notifyAutonomous, notifyError } from './adminNotify.ts';
import { startTrendMonitor, stopTrendMonitor, syncTriggeredCount, type TrendSignal } from './trendMonitor.ts';
import { recordLaunchCompleted } from './systemReporter.ts';
import { 
  postIdeaForVoting, 
  postScheduledIdeaForFeedback,
  checkPendingVotes, 
  announceVoteResult, 
  shouldSkipVoting,
  getCommunityPreferences,
  generateIdeaReasoning,
  type PendingVote 
} from './communityVoting.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';
import { initNovaPersonalBrand, startNovaPersonalScheduler, stopNovaPersonalScheduler } from './novaPersonalBrand.ts';

// PostgreSQL support for persistence
let pgRepo: PostgresScheduleRepository | null = null;
let usePostgres = false;

/**
 * Autonomous Mode Service
 * 
 * Orchestrates fully autonomous token launches:
 * 
 * HYBRID APPROACH:
 * 1. SCHEDULED: Daily launch at configured time (e.g., 14:00 UTC)
 * 2. REACTIVE: Trend-triggered launches when viral moments are detected
 * 3. COMMUNITY VOTING: Ideas can be voted on by the community before launch
 * 
 * Features:
 * - Idea generation via AI
 * - Logo generation via DALL-E
 * - Token creation on pump.fun
 * - Marketing via XScheduler & Nova Channel
 * - Community voting on ideas (optional)
 * 
 * Safety features:
 * - Dry run mode (default) - generates ideas but doesn't launch
 * - Treasury balance checks
 * - Daily launch limits (combined scheduled + reactive)
 * - Uses Nova's channel as community (no per-token TG groups)
 * - Community can reject bad ideas
 */

interface AutonomousState {
  enabled: boolean;
  dryRun: boolean;
  launchesToday: number;
  lastLaunchDate: string | null;
  lastCheckTime: number;
  nextScheduledTime: Date | null;
  pendingIdea: TokenIdea | null;
  // Reactive mode state
  reactiveEnabled: boolean;
  reactiveLaunchesToday: number;
  // Community voting
  pendingVoteId: string | null;
}

interface AutonomousDependencies {
  store: LaunchPackStore;
  pumpLauncher: PumpLauncherService;
}

let state: AutonomousState = {
  enabled: false,
  dryRun: true,
  launchesToday: 0,
  lastLaunchDate: null,
  lastCheckTime: 0,
  nextScheduledTime: null,
  pendingIdea: null,
  reactiveEnabled: false,
  reactiveLaunchesToday: 0,
  pendingVoteId: null,
};

let deps: AutonomousDependencies | null = null;
let schedulerInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Parse schedule time (HH:MM) into next occurrence
 */
function getNextScheduledTime(schedule: string): Date {
  const [hours, minutes] = schedule.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  
  next.setUTCHours(hours, minutes, 0, 0);
  
  // If time has passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  
  return next;
}

/**
 * Check if we're within the launch window (±5 minutes of scheduled time)
 */
function isWithinLaunchWindow(scheduledTime: Date): boolean {
  const now = Date.now();
  const scheduled = scheduledTime.getTime();
  const windowMs = 5 * 60 * 1000; // 5 minute window
  
  return now >= scheduled - windowMs && now <= scheduled + windowMs;
}

/**
 * Reset daily counter if it's a new day
 */
async function checkDayReset(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  if (state.lastLaunchDate !== today) {
    logger.info(`[AutonomousMode] New day detected (was: ${state.lastLaunchDate}, now: ${today}), resetting launch counts`);
    state.launchesToday = 0;
    state.reactiveLaunchesToday = 0;
    state.lastLaunchDate = today;
    
    // Persist to PostgreSQL
    if (usePostgres && pgRepo) {
      await pgRepo.resetDailyLaunchCounts(today).catch(err => {
        logger.warn('[AutonomousMode] Failed to reset daily launch counts in PostgreSQL:', err);
      });
    }
  }
}

/**
 * Persist state to PostgreSQL
 */
async function persistState(updates: {
  launchesToday?: number;
  reactiveLaunchesToday?: number;
  lastLaunchDate?: string | null;
  nextScheduledTime?: number | null;
  pendingIdea?: TokenIdea | null;
  pendingVoteId?: string | null;
}): Promise<void> {
  if (usePostgres && pgRepo) {
    await pgRepo.updateAutonomousState({
      ...updates,
      nextScheduledTime: updates.nextScheduledTime ?? (state.nextScheduledTime ? state.nextScheduledTime.getTime() : null),
    }).catch(err => {
      logger.warn('[AutonomousMode] Failed to persist state to PostgreSQL:', err);
    });
  }
}

/**
 * Parse time string (HH:MM) to minutes since midnight
 */
function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + (minutes || 0);
}

/**
 * Check if current time is within a time window (in UTC)
 */
function isWithinTimeWindow(startTime: string, endTime: string): boolean {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  
  // Handle overnight windows (e.g., 22:00 - 06:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Check if reactive launches are allowed at current time
 * Returns { allowed: boolean, reason?: string }
 */
function checkReactiveTimeWindow(): { allowed: boolean; reason?: string } {
  const env = getEnv();
  
  // Check quiet hours first (no reactive launches during this window)
  const quietStart = env.AUTONOMOUS_REACTIVE_QUIET_START || '00:00';
  const quietEnd = env.AUTONOMOUS_REACTIVE_QUIET_END || '10:00';
  
  if (isWithinTimeWindow(quietStart, quietEnd)) {
    const now = new Date();
    const currentTime = `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
    return { 
      allowed: false, 
      reason: `Quiet hours active (${quietStart}-${quietEnd} UTC). Current: ${currentTime} UTC. Reactive launches paused to preserve daily limits.` 
    };
  }
  
  // Check busy hours (reactive launches ONLY during this window)
  const busyStart = env.AUTONOMOUS_REACTIVE_BUSY_START || '12:00';
  const busyEnd = env.AUTONOMOUS_REACTIVE_BUSY_END || '22:00';
  
  if (!isWithinTimeWindow(busyStart, busyEnd)) {
    const now = new Date();
    const currentTime = `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
    return { 
      allowed: false, 
      reason: `Outside busy hours (${busyStart}-${busyEnd} UTC). Current: ${currentTime} UTC. Reactive launches only during peak activity.` 
    };
  }
  
  return { allowed: true };
}

/**
 * Check all guardrails before launching
 * 
 * AUTO-FUNDING: If pump wallet is low but funding wallet has SOL,
 * we auto-deposit to pump wallet. This happens even in dry run mode
 * so the wallet stays funded for when you go live.
 * 
 * @param launchType - 'scheduled' or 'reactive' to apply appropriate limits
 */
async function checkGuardrails(launchType: 'scheduled' | 'reactive' = 'scheduled'): Promise<{ canLaunch: boolean; reason?: string }> {
  const env = getEnv();
  
  await checkDayReset();
  
  // Check limits based on launch type
  if (launchType === 'reactive') {
    // Reactive launches have their own limit
    if (state.reactiveLaunchesToday >= env.AUTONOMOUS_REACTIVE_MAX_PER_DAY) {
      return { canLaunch: false, reason: `Reactive daily limit reached (${state.reactiveLaunchesToday}/${env.AUTONOMOUS_REACTIVE_MAX_PER_DAY})` };
    }
    
    // Also check time windows for reactive launches
    const timeCheck = checkReactiveTimeWindow();
    if (!timeCheck.allowed) {
      return { canLaunch: false, reason: timeCheck.reason };
    }
  } else {
    // Scheduled launches have their own limit (separate from reactive)
    if (state.launchesToday >= env.AUTONOMOUS_MAX_PER_DAY) {
      return { canLaunch: false, reason: `Scheduled daily limit reached (${state.launchesToday}/${env.AUTONOMOUS_MAX_PER_DAY})` };
    }
  }
  
  // Check treasury balance and auto-fund if needed
  try {
    let balance = await getPumpWalletBalance();
    
    if (balance < env.AUTONOMOUS_MIN_SOL) {
      // Calculate how much we need (min SOL + dev buy + buffer)
      const targetBalance = env.AUTONOMOUS_MIN_SOL + env.AUTONOMOUS_DEV_BUY_SOL + 0.1;
      const deficit = targetBalance - balance;
      
      logger.info(`[Autonomous] Pump wallet low (${balance.toFixed(4)} SOL). Attempting auto-fund of ${deficit.toFixed(4)} SOL...`);
      
      // Check if funding wallet has enough
      try {
        const fundingWallet = await getFundingWalletBalance();
        
        if (fundingWallet.balance >= deficit + 0.01) {
          // Auto-fund the pump wallet
          logger.info(`[Autonomous] Funding wallet has ${fundingWallet.balance.toFixed(4)} SOL. Auto-depositing...`);
          
          const depositResult = await depositToPumpWallet(deficit);
          balance = depositResult.balance;
          
          logger.info(`[Autonomous] ✅ Auto-funded pump wallet! New balance: ${balance.toFixed(4)} SOL`);
          
          // Notify admin of auto-funding
          await notifyAutonomous({
            event: 'wallet_funded',
            details: `Auto-deposited ${deficit.toFixed(4)} SOL to pump wallet.\nNew balance: ${balance.toFixed(4)} SOL\nDry run: ${state.dryRun ? 'Yes (no launches)' : 'No (will launch)'}`,
          });
        } else {
          logger.warn(`[Autonomous] Funding wallet only has ${fundingWallet.balance.toFixed(4)} SOL (need ${(deficit + 0.01).toFixed(4)} SOL)`);
          return { 
            canLaunch: false, 
            reason: `Insufficient balance: Pump wallet has ${balance.toFixed(4)} SOL, funding wallet has ${fundingWallet.balance.toFixed(4)} SOL. Need ${deficit.toFixed(4)} SOL to auto-fund.` 
          };
        }
      } catch (fundErr: any) {
        logger.error(`[Autonomous] Auto-fund failed: ${fundErr.message}`);
        return { 
          canLaunch: false, 
          reason: `Insufficient balance: ${balance.toFixed(4)} SOL (need ${env.AUTONOMOUS_MIN_SOL} SOL). Auto-fund failed: ${fundErr.message}` 
        };
      }
    }
  } catch (err) {
    return { canLaunch: false, reason: `Failed to check wallet balance: ${err}` };
  }
  
  return { canLaunch: true };
}

/**
 * Check and process pending community votes
 */
async function checkAndProcessVotes(): Promise<void> {
  const resolvedVotes = await checkPendingVotes();
  
  for (const vote of resolvedVotes) {
    // Announce result to channel
    await announceVoteResult(vote);
    
    // Handle based on outcome
    if (vote.status === 'approved' || vote.status === 'no_votes') {
      logger.info(`[Autonomous] 🎉 Vote passed for $${vote.idea.ticker} - proceeding with launch`);
      
      // Clear pending state
      if (state.pendingVoteId === vote.id) {
        state.pendingVoteId = null;
        state.pendingIdea = null;
      }
      
      // Check if dry run
      if (state.dryRun) {
        logger.info(`[Autonomous] 🧪 DRY RUN - Would launch $${vote.idea.ticker}`);
        await announceSystem('info', 
          `🗳️ *Vote Result*: $${vote.idea.ticker} APPROVED!\n\n` +
          `Would launch now, but dry run is enabled.`
        );
        continue;
      }
      
      // Execute the launch with the approved idea
      // Note: executeAutonomousLaunchWithIdea handles its own state updates on success
      // Determine launch type from vote context (has trendContext = reactive)
      const launchType = vote.trendContext ? 'reactive' : 'scheduled';
      await executeAutonomousLaunchWithIdea(vote.idea, launchType);
      
      // Just update the date and clear pending state (counter is updated inside executeAutonomousLaunchWithIdea)
      state.lastLaunchDate = new Date().toISOString().split('T')[0];
      await persistState({ lastLaunchDate: state.lastLaunchDate, pendingVoteId: null, pendingIdea: null });
      
    } else if (vote.status === 'rejected') {
      logger.info(`[Autonomous] ❌ Vote rejected for $${vote.idea.ticker} - skipping launch`);
      
      // Clear pending state
      if (state.pendingVoteId === vote.id) {
        state.pendingVoteId = null;
        state.pendingIdea = null;
      }
      
      // Notify admin
      await notifyAutonomous({
        event: 'guardrail_blocked',
        ticker: vote.idea.ticker,
        name: vote.idea.name,
        details: `Community rejected this idea.\nVotes: +${vote.votes?.positive || 0} / -${vote.votes?.negative || 0}\nSentiment: ${((vote.votes?.sentiment || 0) * 100).toFixed(0)}%`,
      });
    }
  }
}

/**
 * Get list of tickers already used (to avoid duplicates)
 */
async function getUsedTickers(): Promise<string[]> {
  if (!deps?.store) return [];
  
  try {
    const packs = await deps.store.list();
    return packs
      .filter(p => p.brand?.ticker)
      .map(p => p.brand!.ticker!.toUpperCase());
  } catch {
    return [];
  }
}

/**
 * Execute an autonomous launch
 */
async function executeAutonomousLaunch(): Promise<void> {
  if (!deps) {
    logger.error('[Autonomous] Dependencies not initialized');
    return;
  }
  
  const env = getEnv();
  
  logger.info('[Autonomous] 🚀 Starting autonomous launch sequence...');
  
  // Step 1: Generate idea
  logger.info('[Autonomous] Step 1: Generating token idea...');
  const usedTickers = await getUsedTickers();
  
  const idea = await generateBestIdea({
    agentName: 'Nova',
    agentPersonality: 'Nova is a chaotic, self-aware AI that embraces entropy and finds humor in the absurdity of crypto culture.',
    avoidTickers: usedTickers,
  }, 3);
  
  const validation = validateIdea(idea);
  if (!validation.valid) {
    logger.warn(`[Autonomous] Invalid idea generated: ${validation.issues.join(', ')}`);
    return;
  }
  
  logger.info(`[Autonomous] ✨ Idea: $${idea.ticker} - ${idea.name}`);
  logger.info(`[Autonomous]    Description: ${idea.description}`);
  logger.info(`[Autonomous]    Mascot: ${idea.mascot}`);
  
  // Notify admin about generated idea
  await notifyAutonomous({
    event: 'idea_generated',
    ticker: idea.ticker,
    name: idea.name,
    details: `${idea.description}\n\nMascot: ${idea.mascot || 'N/A'}\nConfidence: ${(idea.confidence * 100).toFixed(0)}%\nDry run: ${state.dryRun ? 'Yes' : 'No'}`,
  });
  
  // Generate reasoning for the channel announcement
  const reasoning = await generateIdeaReasoning(idea);
  
  // ALWAYS post scheduled ideas to the channel for community feedback
  // This is different from voting - just collects reactions, Nova responds later
  logger.info('[Autonomous] 📢 Posting scheduled idea for community feedback...');
  const feedbackPost = await postScheduledIdeaForFeedback(idea, reasoning);
  
  if (feedbackPost) {
    state.pendingIdea = idea;
    state.pendingVoteId = feedbackPost.id;
    logger.info(`[Autonomous] ✅ Posted scheduled idea to channel (feedback tracking enabled)`);
  } else {
    logger.warn(`[Autonomous] Failed to post idea to channel - check NOVA_CHANNEL_ID config`);
  }
  
  // DRY RUN: Stop here and just log
  if (state.dryRun) {
    logger.info('[Autonomous] 🧪 DRY RUN - Would launch this token (set AUTONOMOUS_DRY_RUN=false to enable real launches)');
    return;
  }
  
  // Check if community voting is enabled (in addition to feedback)
  if (env.COMMUNITY_VOTING_ENABLED === 'true') {
    const skipCheck = shouldSkipVoting(idea);
    
    if (skipCheck.skip) {
      logger.info(`[Autonomous] Skipping voting: ${skipCheck.reason}`);
    } else {
      // Post for community voting
      logger.info('[Autonomous] 🗳️ Posting idea for community voting...');
      const vote = await postIdeaForVoting(idea);
      
      if (vote) {
        state.pendingIdea = idea;
        state.pendingVoteId = vote.id;
        await persistState({ pendingIdea: idea, pendingVoteId: vote.id });
        logger.info(`[Autonomous] Idea posted for voting. Will check results in ${env.COMMUNITY_VOTING_WINDOW_MINUTES || '30'} minutes.`);
        // The vote checker will handle launching after voting ends
        return;
      }
      // If posting failed, continue with launch
      logger.warn('[Autonomous] Failed to post for voting, continuing with launch...');
    }
  }
  
  // Step 2: Generate logo
  logger.info('[Autonomous] Step 2: Generating logo...');
  let logoUrl: string;
  try {
    const logoResult = await generateMemeLogo(
      idea.name,
      idea.ticker,
      idea.mascot || idea.description,
      'meme'
    );
    logoUrl = logoResult.url;
    logger.info(`[Autonomous] ✅ Logo generated: ${logoResult.source}`);
  } catch (err) {
    logger.error('[Autonomous] Failed to generate logo:', err);
    return;
  }
  
  // Step 3: Create LaunchPack
  logger.info('[Autonomous] Step 3: Creating LaunchPack...');
  const novaChannelInvite = env.NOVA_CHANNEL_INVITE;
  const novaXHandle = env.NOVA_X_HANDLE;
  
  try {
    const pack = await deps.store.create({
      brand: {
        name: idea.name,
        ticker: idea.ticker,
        description: idea.description,
      },
      assets: {
        logo_url: logoUrl,
      },
      links: {
        // Use Nova's channel as the community link if available
        telegram: novaChannelInvite || undefined,
        // Attach Nova's X account if configured
        x: novaXHandle ? `https://x.com/${novaXHandle}` : undefined,
      },
      ops: {
        checklist: { autonomous: true },
        audit_log: [{
          at: new Date().toISOString(),
          message: `Autonomous launch created: $${idea.ticker} - ${idea.name} (confidence: ${idea.confidence})`,
          actor: 'autonomous_mode',
        }],
      },
      // Skip TG setup for autonomous launches - use Nova's channel
      tg: env.AUTONOMOUS_USE_NOVA_CHANNEL === 'true' && env.NOVA_CHANNEL_ID
        ? {
            telegram_chat_id: env.NOVA_CHANNEL_ID,
            invite_link: env.NOVA_CHANNEL_INVITE || undefined, // For X tweets to include TG link
            verified: true,
            pins: { welcome: '', how_to_buy: '', memekit: '' },
            schedule: [],
          }
        : undefined,
    });
    
    logger.info(`[Autonomous] ✅ Created LaunchPack: ${pack.id}`);
    
    // Step 4: Launch the token
    logger.info('[Autonomous] Step 4: Launching on pump.fun...');
    const launched = await deps.pumpLauncher.launch(pack.id as string, { 
      skipTelegramCheck: true // No separate TG group for autonomous launches
    });
    
    logger.info(`[Autonomous] 🎉 Token launched! Mint: ${launched.launch?.mint}`);
    
    // Update state and persist
    state.launchesToday++;
    state.pendingIdea = null;
    await persistState({ launchesToday: state.launchesToday, pendingIdea: null });
    if (usePostgres && pgRepo) {
      pgRepo.incrementLaunchCount('scheduled').catch(err => logger.warn('[AutonomousMode] Failed to increment launch count:', err));
    }
    
    // Record all-time cumulative launch count
    recordLaunchCompleted();
    
    // NOTE: announceLaunch is already called inside pumpLauncher.launch()
    // so we do NOT call it again here to avoid duplicate notifications
    
    // Notify admin of successful launch
    await notifyAutonomous({
      event: 'launch_success',
      ticker: idea.ticker,
      name: idea.name,
      mint: launched.launch?.mint,
      details: `Launch #${state.launchesToday} today`,
    });
    
  } catch (err: any) {
    logger.error(`[Autonomous] Launch failed: ${err.message}`);
    await announceSystem('error', `❌ Autonomous launch failed: ${err.message}`);
    
    // Notify admin of failure
    await notifyAutonomous({
      event: 'launch_failed',
      ticker: idea.ticker,
      name: idea.name,
      details: err.message,
    });
    await notifyError({
      source: 'autonomousMode',
      error: err.message,
      context: `Failed to launch $${idea.ticker}`,
      severity: 'high',
    });
  }
}

/**
 * Execute an autonomous launch with a pre-generated idea
 * Used when idea is generated before guardrail check
 * @param launchType - 'scheduled' or 'reactive' to track the right counter
 */
async function executeAutonomousLaunchWithIdea(idea: TokenIdea, launchType: 'scheduled' | 'reactive' = 'scheduled'): Promise<void> {
  if (!deps) {
    logger.error('[Autonomous] Dependencies not initialized');
    return;
  }
  
  const env = getEnv();
  
  logger.info('[Autonomous] 🚀 Continuing launch with pre-generated idea...');
  logger.info(`[Autonomous] ✨ Idea: $${idea.ticker} - ${idea.name}`);
  
  // Post to channel for community feedback (before launching)
  try {
    const reasoning = await generateIdeaReasoning(idea);
    logger.info('[Autonomous] 📢 Posting idea for community feedback...');
    const feedbackPost = await postScheduledIdeaForFeedback(idea, reasoning);
    if (feedbackPost) {
      logger.info(`[Autonomous] ✅ Posted idea to channel for feedback`);
    } else {
      logger.warn(`[Autonomous] ⚠️ Failed to post idea to channel`);
    }
  } catch (feedbackErr) {
    logger.warn('[Autonomous] Failed to post feedback (continuing with launch):', feedbackErr);
  }
  
  // DRY RUN: Stop here and just log
  if (state.dryRun) {
    logger.info('[Autonomous] 🧪 DRY RUN - Would launch this token (set AUTONOMOUS_DRY_RUN=false to enable real launches)');
    state.pendingIdea = idea;
    
    // Post for community voting with reactions (scheduled launch type)
    const vote = await postIdeaForVoting(idea, undefined, { launchType: 'scheduled' });
    if (vote) {
      state.pendingVoteId = vote.id;
      logger.info(`[Autonomous] Posted scheduled idea for community voting`);
    } else {
      logger.warn(`[Autonomous] Failed to post for voting - check COMMUNITY_VOTING_ENABLED and channel config`);
    }
    return;
  }
  
  // Step 2: Generate logo
  logger.info('[Autonomous] Step 2: Generating logo...');
  let logoUrl: string;
  try {
    const logoResult = await generateMemeLogo(
      idea.name,
      idea.ticker,
      idea.mascot || idea.description,
      'meme'
    );
    logoUrl = logoResult.url;
    logger.info(`[Autonomous] ✅ Logo generated: ${logoResult.source}`);
  } catch (err) {
    logger.error('[Autonomous] Failed to generate logo:', err);
    return;
  }
  
  // Step 3: Create LaunchPack
  logger.info('[Autonomous] Step 3: Creating LaunchPack...');
  const novaChannelInvite = env.NOVA_CHANNEL_INVITE;
  const novaXHandle = env.NOVA_X_HANDLE;
  
  try {
    const pack = await deps.store.create({
      brand: {
        name: idea.name,
        ticker: idea.ticker,
        description: idea.description,
      },
      assets: {
        logo_url: logoUrl,
      },
      links: {
        // Use Nova's channel as the community link if available
        telegram: novaChannelInvite || undefined,
        // Attach Nova's X account if configured
        x: novaXHandle ? `https://x.com/${novaXHandle}` : undefined,
      },
      ops: {
        checklist: { autonomous: true },
        audit_log: [{
          at: new Date().toISOString(),
          message: `Autonomous launch created: $${idea.ticker} - ${idea.name} (confidence: ${idea.confidence})`,
          actor: 'autonomous_mode',
        }],
      },
      // Skip TG setup for autonomous launches - use Nova's channel
      tg: env.AUTONOMOUS_USE_NOVA_CHANNEL === 'true' && env.NOVA_CHANNEL_ID
        ? {
            telegram_chat_id: env.NOVA_CHANNEL_ID,
            invite_link: env.NOVA_CHANNEL_INVITE || undefined, // For X tweets to include TG link
            verified: true,
            pins: { welcome: '', how_to_buy: '', memekit: '' },
            schedule: [],
          }
        : undefined,
    });
    
    logger.info(`[Autonomous] ✅ Created LaunchPack: ${pack.id}`);
    
    // Step 4: Launch the token
    logger.info('[Autonomous] Step 4: Launching on pump.fun... (type: ' + launchType + ')');
    const launched = await deps.pumpLauncher.launch(pack.id as string, { 
      skipTelegramCheck: true // No separate TG group for autonomous launches
    });
    
    logger.info(`[Autonomous] 🎉 Token launched! Mint: ${launched.launch?.mint}`);
    
    // Update state and persist - use the correct counter based on launch type
    state.pendingIdea = null;
    if (launchType === 'reactive') {
      state.reactiveLaunchesToday++;
      await persistState({ reactiveLaunchesToday: state.reactiveLaunchesToday, pendingIdea: null });
      if (usePostgres && pgRepo) {
        pgRepo.incrementLaunchCount('reactive').catch(err => logger.warn('[AutonomousMode] Failed to increment reactive launch count:', err));
      }
    } else {
      state.launchesToday++;
      await persistState({ launchesToday: state.launchesToday, pendingIdea: null });
      if (usePostgres && pgRepo) {
        pgRepo.incrementLaunchCount('scheduled').catch(err => logger.warn('[AutonomousMode] Failed to increment launch count:', err));
      }
    }
    
    // Record all-time cumulative launch count
    recordLaunchCompleted();
    
    // NOTE: announceLaunch is already called inside pumpLauncher.launch()
    // so we do NOT call it again here to avoid duplicate notifications
    
    // Notify admin of successful launch
    const launchCount = launchType === 'reactive' ? state.reactiveLaunchesToday : state.launchesToday;
    await notifyAutonomous({
      event: 'launch_success',
      ticker: idea.ticker,
      name: idea.name,
      mint: launched.launch?.mint,
      details: `${launchType === 'reactive' ? '🔥 Reactive' : '📅 Scheduled'} Launch #${launchCount} today`,
    });
    
  } catch (err: any) {
    logger.error(`[Autonomous] Launch failed: ${err.message}`);
    await announceSystem('error', `❌ Autonomous launch failed: ${err.message}`);
    
    // Notify admin of failure
    await notifyAutonomous({
      event: 'launch_failed',
      ticker: idea.ticker,
      name: idea.name,
      details: err.message,
    });
    await notifyError({
      source: 'autonomousMode',
      error: err.message,
      context: `Failed to launch $${idea.ticker}`,
      severity: 'high',
    });
  }
}

/**
 * Main scheduler tick - check if it's time to launch
 */
async function schedulerTick(): Promise<void> {
  if (!state.enabled) return;
  
  const env = getEnv();
  
  // Update next scheduled time if needed
  if (!state.nextScheduledTime || state.nextScheduledTime.getTime() < Date.now()) {
    state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
    await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
  }
  
  // Check if we're in the launch window
  if (!isWithinLaunchWindow(state.nextScheduledTime)) {
    return; // Not time yet
  }
  
  // Prevent multiple launches in same window
  const windowKey = state.nextScheduledTime.toISOString();
  if (state.lastCheckTime === state.nextScheduledTime.getTime()) {
    return; // Already processed this window
  }
  
  logger.info('[Autonomous] 🕐 Launch window active!');
  
  // Notify admin that schedule activated
  await notifyAutonomous({
    event: 'schedule_activated',
    details: `Launch window opened at ${state.nextScheduledTime.toISOString()}`,
  });
  
  // Generate idea FIRST so we can show it even if guardrails block
  // (Idea generation is cheap - just an LLM call)
  logger.info('[Autonomous] Step 1: Generating token idea...');
  const usedTickers = await getUsedTickers();
  
  let idea;
  try {
    idea = await generateBestIdea({
      agentName: 'Nova',
      agentPersonality: 'Nova is a chaotic, self-aware AI that embraces entropy and finds humor in the absurdity of crypto culture.',
      avoidTickers: usedTickers,
    }, 3);
    
    const validation = validateIdea(idea);
    if (!validation.valid) {
      logger.warn(`[Autonomous] Invalid idea generated: ${validation.issues.join(', ')}`);
      state.lastCheckTime = state.nextScheduledTime.getTime();
      state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
      await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
      return;
    }
    
    logger.info(`[Autonomous] ✨ Idea: $${idea.ticker} - ${idea.name}`);
    logger.info(`[Autonomous]    Description: ${idea.description}`);
    
    // Notify admin about generated idea
    await notifyAutonomous({
      event: 'idea_generated',
      ticker: idea.ticker,
      name: idea.name,
      details: `${idea.description}\n\nMascot: ${idea.mascot}\nConfidence: ${(idea.confidence * 100).toFixed(0)}%\nDry run: ${state.dryRun ? 'Yes' : 'No'}`,
    });
  } catch (err) {
    logger.error('[Autonomous] Idea generation failed:', err);
    state.lastCheckTime = state.nextScheduledTime.getTime();
    state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
    await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
    return;
  }
  
  // Check guardrails AFTER idea generation (scheduled launch)
  const guardrails = await checkGuardrails('scheduled');
  if (!guardrails.canLaunch) {
    logger.info(`[Autonomous] Skipping launch: ${guardrails.reason}`);
    
    // Notify admin about guardrail block (they already saw the idea!)
    await notifyAutonomous({
      event: 'guardrail_blocked',
      ticker: idea.ticker,
      name: idea.name,
      details: `${guardrails.reason}\n\nIdea was: $${idea.ticker} - ${idea.name}`,
    });
    
    state.lastCheckTime = state.nextScheduledTime.getTime();
    state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
    await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
    return;
  }
  
  // Mark window as processed
  state.lastCheckTime = state.nextScheduledTime.getTime();
  
  // Execute launch (idea already generated, so pass it)
  try {
    await executeAutonomousLaunchWithIdea(idea);
  } catch (err) {
    logger.error('[Autonomous] Launch execution error:', err);
  }
  
  // Schedule next window and persist
  state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
  await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
  logger.info(`[Autonomous] Next launch window: ${state.nextScheduledTime.toISOString()}`);
}

/**
 * Start the autonomous mode scheduler
 */
export async function startAutonomousMode(
  store: LaunchPackStore,
  pumpLauncher: PumpLauncherService
): Promise<void> {
  const env = getEnv();
  
  if (!env.autonomousEnabled) {
    logger.info('[Autonomous] Disabled (set AUTONOMOUS_ENABLE=true to enable)');
    return;
  }
  
  // Initialize PostgreSQL if available
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      usePostgres = true;
      logger.info('[AutonomousMode] PostgreSQL storage initialized');
      
      // Load persisted state from PostgreSQL
      const savedState = await pgRepo.getAutonomousState();
      const today = new Date().toISOString().split('T')[0];
      
      // Check if we need to reset daily counters
      if (savedState.lastLaunchDate === today) {
        state.launchesToday = savedState.launchesToday;
        state.reactiveLaunchesToday = savedState.reactiveLaunchesToday;
        logger.info(`[AutonomousMode] Loaded persisted launch counts: ${state.launchesToday} scheduled, ${state.reactiveLaunchesToday} reactive`);
      } else if (savedState.lastLaunchDate) {
        logger.info(`[AutonomousMode] New day detected (was: ${savedState.lastLaunchDate}, now: ${today}), starting fresh`);
        await pgRepo.resetDailyLaunchCounts(today);
      } else {
        logger.info(`[AutonomousMode] First run - no previous launch data`);
      }
      
      state.lastLaunchDate = today;
      state.pendingIdea = savedState.pendingIdea;
      state.pendingVoteId = savedState.pendingVoteId;
      
      // Load next scheduled time if persisted
      if (savedState.nextScheduledTime && savedState.nextScheduledTime > Date.now()) {
        state.nextScheduledTime = new Date(savedState.nextScheduledTime);
        logger.info(`[AutonomousMode] Loaded persisted next scheduled time: ${state.nextScheduledTime.toISOString()}`);
      }
    } catch (err) {
      logger.warn('[AutonomousMode] PostgreSQL init failed, using in-memory state:', err);
      pgRepo = null;
      usePostgres = false;
    }
  }
  
  deps = { store, pumpLauncher };
  state.enabled = true;
  state.dryRun = env.autonomousDryRun;
  state.reactiveEnabled = env.autonomousReactiveEnabled;
  
  // Only calculate new nextScheduledTime if we didn't load one from PostgreSQL
  if (!state.nextScheduledTime) {
    state.nextScheduledTime = getNextScheduledTime(env.AUTONOMOUS_SCHEDULE);
    // Persist next scheduled time
    await persistState({ nextScheduledTime: state.nextScheduledTime.getTime() });
  }
  
  logger.info('[Autonomous] ============================================');
  logger.info('[Autonomous] 🤖 AUTONOMOUS MODE ACTIVATED');
  logger.info(`[Autonomous]    Dry run: ${state.dryRun ? 'YES (ideas only)' : 'NO (real launches!)'}`);
  logger.info(`[Autonomous]    Schedule: ${env.AUTONOMOUS_SCHEDULE} UTC`);
  logger.info(`[Autonomous]    Max per day: ${env.AUTONOMOUS_MAX_PER_DAY}`);
  logger.info(`[Autonomous]    Min SOL: ${env.AUTONOMOUS_MIN_SOL}`);
  logger.info(`[Autonomous]    Dev buy: ${env.AUTONOMOUS_DEV_BUY_SOL} SOL`);
  logger.info(`[Autonomous]    Next window: ${state.nextScheduledTime.toISOString()}`);
  logger.info(`[Autonomous]    Reactive mode: ${state.reactiveEnabled ? 'ON' : 'OFF'}`);
  logger.info(`[Autonomous]    Launches today: ${state.launchesToday} scheduled, ${state.reactiveLaunchesToday} reactive`);
  logger.info('[Autonomous] ============================================');
  
  // Check every minute
  schedulerInterval = setInterval(() => {
    schedulerTick().catch(err => logger.error('[Autonomous] Tick error:', err));
  }, 60 * 1000);
  
  // Heartbeat every 30 minutes
  heartbeatInterval = setInterval(async () => {
    // Check for day reset even during quiet hours
    await checkDayReset();
    
    const minsUntil = state.nextScheduledTime 
      ? Math.round((state.nextScheduledTime.getTime() - Date.now()) / 60000)
      : 'N/A';
    const totalLaunches = state.launchesToday + state.reactiveLaunchesToday;
    logger.info(`[Autonomous] 💓 Heartbeat: ${totalLaunches} launches today (${state.launchesToday} scheduled, ${state.reactiveLaunchesToday} reactive), next in ${minsUntil} min, dry_run=${state.dryRun}`);
  }, 30 * 60 * 1000);
  
  // Vote checker every 2 minutes (when voting is enabled)
  if (env.COMMUNITY_VOTING_ENABLED === 'true') {
    setInterval(() => {
      checkAndProcessVotes().catch(err => logger.error('[Autonomous] Vote check error:', err));
    }, 2 * 60 * 1000);
    logger.info('[Autonomous] 🗳️ Community voting enabled - checking every 2 minutes');
  }
  
  // Initial tick
  schedulerTick().catch(err => logger.error('[Autonomous] Initial tick error:', err));
  
  // Start trend monitor for reactive launches
  if (state.reactiveEnabled) {
    await startTrendMonitor(handleReactiveTrend);
    // Sync the triggered count from PostgreSQL to prevent inconsistency after restart
    syncTriggeredCount(state.reactiveLaunchesToday);
    logger.info('[Autonomous] 🔥 Reactive trend monitor started');
  }
  
  // Start Nova personal brand scheduler
  try {
    await initNovaPersonalBrand();
    startNovaPersonalScheduler();
    logger.info('[Autonomous] 🌟 Nova personal brand scheduler started');
  } catch (err) {
    logger.warn('[Autonomous] Nova personal brand init failed:', err);
  }
  
  // Announce if system notifications enabled
  announceSystem('startup', 
    `🤖 Autonomous mode activated!\n\n` +
    `Schedule: ${env.AUTONOMOUS_SCHEDULE} UTC\n` +
    `Dry run: ${state.dryRun ? 'Yes' : 'No'}\n` +
    `Reactive: ${state.reactiveEnabled ? 'Yes' : 'No'}\n` +
    `Next launch: ${state.nextScheduledTime.toISOString()}`
  ).catch(() => {});
}

/**
 * Handle a reactive trend trigger
 */
async function handleReactiveTrend(trend: TrendSignal): Promise<void> {
  if (!deps) {
    logger.error('[Autonomous] Dependencies not initialized for reactive launch');
    return;
  }
  
  const env = getEnv();
  
  logger.info(`[Autonomous] 🔥 REACTIVE LAUNCH triggered by trend: "${trend.topic}"`);
  
  // Check guardrails (balance, daily limits, time windows for reactive)
  const guardrails = await checkGuardrails('reactive');
  if (!guardrails.canLaunch) {
    logger.info(`[Autonomous] Reactive launch blocked: ${guardrails.reason}`);
    await notifyAutonomous({
      event: 'guardrail_blocked',
      details: `Reactive launch blocked\nTrend: ${trend.topic}\nReason: ${guardrails.reason}`,
    });
    return;
  }
  
  // Execute launch with trend context (counter incremented only on success)
  await executeReactiveLaunch(trend);
}

/**
 * Execute a reactive launch based on a trend
 */
async function executeReactiveLaunch(trend: TrendSignal): Promise<void> {
  if (!deps) return;
  
  const env = getEnv();
  
  logger.info(`[Autonomous] 🚀 Starting REACTIVE launch for: "${trend.topic}"`);
  
  // Generate idea with trend context
  const usedTickers = await getUsedTickers();
  
  const idea = await generateBestIdea({
    agentName: 'Nova',
    agentPersonality: 'Nova is a chaotic, self-aware AI that embraces entropy and finds humor in the absurdity of crypto culture.',
    avoidTickers: usedTickers,
    trendContext: trend.topic, // Pass trend as context for idea generation
  }, 3);
  
  const validation = validateIdea(idea);
  if (!validation.valid) {
    logger.warn(`[Autonomous] Invalid reactive idea: ${validation.issues.join(', ')}`);
    return;
  }
  
  logger.info(`[Autonomous] ✨ Reactive idea: $${idea.ticker} - ${idea.name}`);
  logger.info(`[Autonomous]    Based on trend: ${trend.topic}`);
  
  // Notify admin
  await notifyAutonomous({
    event: 'idea_generated',
    ticker: idea.ticker,
    name: idea.name,
    details: `🔥 REACTIVE LAUNCH\nTrend: ${trend.topic}\n\n${idea.description}\n\nDry run: ${state.dryRun ? 'Yes' : 'No'}`,
  });
  
  // If dry run, stop here
  if (state.dryRun) {
    logger.info('[Autonomous] 🧪 DRY RUN: Skipping actual reactive launch');
    
    // Post for voting with reactive type
    const vote = await postIdeaForVoting(idea, trend.topic, { launchType: 'reactive' });
    if (vote) {
      state.pendingVoteId = vote.id;
      state.pendingIdea = idea;
      logger.info(`[Autonomous] Posted reactive idea for community voting`);
    }
    return;
  }
  
  // Check if community voting is enabled for reactive launches
  if (env.COMMUNITY_VOTING_ENABLED === 'true') {
    const skipCheck = shouldSkipVoting(idea);
    
    if (skipCheck.skip) {
      logger.info(`[Autonomous] Skipping voting for reactive: ${skipCheck.reason}`);
    } else {
      // Post for community voting (with trend context)
      logger.info('[Autonomous] 🗳️ Posting reactive idea for community voting...');
      const vote = await postIdeaForVoting(idea, trend.topic, { launchType: 'reactive' });
      
      if (vote) {
        state.pendingIdea = idea;
        state.pendingVoteId = vote.id;
        logger.info(`[Autonomous] Reactive idea posted for voting. Results in ${env.COMMUNITY_VOTING_WINDOW_MINUTES || '30'} minutes.`);
        return;
      }
      logger.warn('[Autonomous] Failed to post for voting, continuing with reactive launch...');
    }
  }
  
  // Continue with actual launch (same as scheduled)
  try {
    // Generate logo
    const logoResult = await generateMemeLogo(idea.ticker, idea.name, idea.description);
    const logoUrl = logoResult.url;
    
    // Create LaunchPack
    const pack = await deps.store.create({
      brand: {
        name: idea.name,
        ticker: idea.ticker,
        description: idea.description,
      },
      assets: {
        logo_url: logoUrl,
      },
      ops: {
        checklist: { autonomous: true, reactive: true },
        audit_log: [{
          at: new Date().toISOString(),
          message: `Reactive launch created: $${idea.ticker} - ${idea.name} (trend: ${trend.topic})`,
          actor: 'autonomous_mode',
        }],
      },
      tg: env.AUTONOMOUS_USE_NOVA_CHANNEL === 'true' && env.NOVA_CHANNEL_ID
        ? {
            telegram_chat_id: env.NOVA_CHANNEL_ID,
            invite_link: env.NOVA_CHANNEL_INVITE || undefined, // For X tweets to include TG link
            verified: true,
            pins: { welcome: '', how_to_buy: '', memekit: '' },
            schedule: [],
          }
        : undefined,
    });
    
    // Execute launch
    const launched = await deps.pumpLauncher.launch(pack.id as string, {
      skipTelegramCheck: true, // No separate TG group for autonomous launches
    });
    
    // Update state and persist - increment REACTIVE counter (not scheduled)
    state.reactiveLaunchesToday++;
    await persistState({ reactiveLaunchesToday: state.reactiveLaunchesToday });
    if (usePostgres && pgRepo) {
      pgRepo.incrementLaunchCount('reactive').catch(err => logger.warn('[AutonomousMode] Failed to increment reactive launch count:', err));
    }
    
    // Record all-time cumulative launch count
    recordLaunchCompleted();
    
    logger.info(`[Autonomous] 🎉 REACTIVE LAUNCH SUCCESS: ${launched.launch?.mint}`);
    
    await notifyAutonomous({
      event: 'launch_success',
      ticker: idea.ticker,
      name: idea.name,
      mint: launched.launch?.mint,
      details: `🔥 Reactive launch successful!\nTrend: ${trend.topic}`,
    });
    
    // NOTE: announceLaunch is already called inside pumpLauncher.launch()
    // so we do NOT call it again here to avoid duplicate notifications
    
  } catch (err: any) {
    logger.error(`[Autonomous] Reactive launch failed: ${err.message}`);
    await notifyError({
      source: 'autonomousMode',
      error: err.message || 'Reactive launch threw exception',
      context: `Trend: ${trend.topic}`,
      severity: 'high',
    });
  }
}

/**
 * Stop the autonomous mode scheduler
 */
export function stopAutonomousMode(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Stop trend monitor
  stopTrendMonitor();
  
  // Stop Nova personal brand scheduler
  stopNovaPersonalScheduler();
  
  state.enabled = false;
  state.reactiveEnabled = false;
  logger.info('[Autonomous] Stopped');
}

/**
 * Get current autonomous mode status
 */
export function getAutonomousStatus(): AutonomousState & { config: any } {
  const env = getEnv();
  return {
    ...state,
    config: {
      schedule: env.AUTONOMOUS_SCHEDULE,
      maxPerDay: env.AUTONOMOUS_MAX_PER_DAY,
      minSol: env.AUTONOMOUS_MIN_SOL,
      devBuySol: env.AUTONOMOUS_DEV_BUY_SOL,
      useNovaChannel: env.AUTONOMOUS_USE_NOVA_CHANNEL,
    },
  };
}

/**
 * Manually trigger an autonomous launch (for testing)
 */
export async function triggerAutonomousLaunch(): Promise<{ success: boolean; error?: string }> {
  if (!deps) {
    return { success: false, error: 'Autonomous mode not initialized' };
  }
  
  const guardrails = await checkGuardrails('scheduled');
  if (!guardrails.canLaunch) {
    return { success: false, error: guardrails.reason };
  }
  
  try {
    await executeAutonomousLaunch();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export default {
  startAutonomousMode,
  stopAutonomousMode,
  getAutonomousStatus,
  triggerAutonomousLaunch,
};
