/**
 * Nova Agent Swarm — Barrel Export
 *
 * Architecture:
 *   Nova (Supervisor)
 *     ├── Scout     — KOL scanning, narrative detection, social intel
 *     ├── Guardian  — RugCheck safety, LP monitoring, whale alerts
 *     ├── Analyst   — DeFiLlama data, on-chain metrics, narrative scoring
 *     ├── Launcher  — pump.fun token creation, deploy, graduation tracking
 *     ├── Community — TG management, X engagement, community health
 *     ├── SocialSentinel — Reddit + Google Trends social trending → launch pipeline
 *     ├── YieldScout — Multi-chain DeFi yield monitoring (Krystal EVM + Solana)
 *     ├── WhaleTracker — Solana + EVM whale movement detection
 *     ├── ArbScanner — Cross-DEX arbitrage opportunity scanning (EVM)
 *     ├── PortfolioWatchdog — Multi-chain portfolio health + PnL alerts
 *     ├── TokenChild — Per-token monitoring (DexScreener metrics, auto-deactivation)
 *     └── Health    — Self-healing, auto-repair, swarm monitoring (external)
 *
 * Usage:
 *   import { initSwarm, stopSwarm } from './agents';
 *   const swarm = await initSwarm(pool);
 *   // ... later
 *   await stopSwarm(swarm);
 */

export { BaseAgent, type AgentMessage, type AgentConfig, type AgentType, type MessagePriority, type MessageType } from './types.ts';
export { Supervisor, type SupervisorCallbacks } from './supervisor.ts';
export { ScoutAgent } from './scout.ts';
export { GuardianAgent } from './guardian.ts';
export { AnalystAgent } from './analyst.ts';
export { LauncherAgent } from './launcher.ts';
export { CommunityAgent } from './community-agent.ts';
export { CFOAgent } from './cfo.ts';
export { SocialSentinelAgent } from './social-sentinel.ts';
export { YieldScoutAgent } from './yield-scout.ts';
export { WhaleTrackerAgent } from './whale-tracker.ts';
export { ArbScannerAgent } from './arb-scanner.ts';
export { PortfolioWatchdogAgent } from './portfolio-watchdog.ts';
export { TokenChildAgent, type TokenChildConfig } from './token-child.ts';
export { AgentFactory, type AgentSpec, type CapabilityType, type AgentSpecStatus } from './factory.ts';
export { encryptWalletKey, decryptWalletKey, hasPermission, supportsChain, getPrivateKeyForAction, type WalletConfig } from './wallet-utils.ts';
export { UserAgentRunner, discoverUserAgents, startUserAgents, type UserAgentConfig } from './user-agent-runner.ts';

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { Supervisor, type SupervisorCallbacks } from './supervisor.ts';
import { ScoutAgent } from './scout.ts';
import { GuardianAgent } from './guardian.ts';
import { AnalystAgent } from './analyst.ts';
import { LauncherAgent } from './launcher.ts';
import { CommunityAgent } from './community-agent.ts';
import { CFOAgent } from './cfo.ts';
import { UserAgentRunner, startUserAgents } from './user-agent-runner.ts';

// ============================================================================
// Swarm Bootstrap
// ============================================================================

export interface SwarmHandle {
  supervisor: Supervisor;
  scout: ScoutAgent;
  guardian: GuardianAgent;
  analyst: AnalystAgent;
  launcher: LauncherAgent;
  community: CommunityAgent;
  cfo: CFOAgent;
  /** User-deployed agents discovered from agent_registry */
  userAgents: UserAgentRunner[];
}

/**
 * Initialize the full Nova swarm.
 * Returns handles to all agents for status checks and shutdown.
 *
 * @param pool PostgreSQL connection pool
 * @param callbacks Supervisor callbacks for posting to X/TG/Channel
 */
export async function initSwarm(
  pool: Pool,
  callbacks?: SupervisorCallbacks,
): Promise<SwarmHandle> {
  logger.info('[swarm] Initializing Nova agent swarm...');

  const supervisor = new Supervisor(pool);
  const scout = new ScoutAgent(pool);
  const guardian = new GuardianAgent(pool);
  const analyst = new AnalystAgent(pool);
  const launcher = new LauncherAgent(pool);
  const community = new CommunityAgent(pool);
  const cfo = new CFOAgent(pool);

  if (callbacks) supervisor.setCallbacks(callbacks);

  // Wire quarantine stop callback so AgentWatchdog can actually halt agents
  const agentMap: Record<string, typeof scout> = {
    'nova-scout': scout, 'nova-guardian': guardian, 'nova-analyst': analyst,
    'nova-launcher': launcher, 'nova-community': community, 'nova-cfo': cfo,
  };
  guardian.setStopAgentCallback(async (agentName: string) => {
    const agent = agentMap[agentName];
    if (agent) {
      logger.warn(`[swarm] Quarantine stopping agent ${agentName}`);
      await agent.stop();
    }
  });

  // Start all agents (non-blocking, each registers + starts loops)
  const agents = [supervisor, scout, guardian, analyst, launcher, community, cfo];

  for (const agent of agents) {
    try {
      await agent.start();
    } catch (err) {
      logger.warn(`[swarm] Agent ${(agent as any).agentId} failed to start (non-fatal):`, err);
    }
  }

  logger.info(`[swarm] ✅ ${agents.length} core agents started (Scout, Guardian, Analyst, Launcher, Community, CFO + Supervisor)`);

  // ── Discover & start user-deployed agents ──
  let userAgents: UserAgentRunner[] = [];
  try {
    userAgents = await startUserAgents(pool);
    if (userAgents.length) {
      logger.info(`[swarm] ✅ ${userAgents.length} user agent(s) started from agent_registry`);
    }
  } catch (err) {
    logger.warn('[swarm] User agent discovery failed (non-fatal):', err);
  }

  return { supervisor, scout, guardian, analyst, launcher, community, cfo, userAgents };
}

/**
 * Gracefully stop all agents in the swarm.
 */
export async function stopSwarm(swarm: SwarmHandle): Promise<void> {
  logger.info('[swarm] Stopping agent swarm...');

  const agents = [
    swarm.cfo,        // Stop CFO first (financial ops)
    swarm.community,
    swarm.launcher,
    swarm.analyst,
    swarm.guardian,
    swarm.scout,
    swarm.supervisor, // Stop supervisor last
  ];

  // Stop user agents first
  for (const ua of swarm.userAgents ?? []) {
    try {
      await ua.stop();
    } catch (err) {
      logger.warn(`[swarm] Error stopping user agent:`, err);
    }
  }

  for (const agent of agents) {
    try {
      await agent.stop();
    } catch (err) {
      logger.warn(`[swarm] Error stopping agent:`, err);
    }
  }

  logger.info('[swarm] All agents stopped');
}
