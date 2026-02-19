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
export { TokenChildAgent, type TokenChildConfig } from './token-child.ts';
export { AgentFactory, type AgentSpec, type CapabilityType, type AgentSpecStatus } from './factory.ts';

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { Supervisor, type SupervisorCallbacks } from './supervisor.ts';
import { ScoutAgent } from './scout.ts';
import { GuardianAgent } from './guardian.ts';
import { AnalystAgent } from './analyst.ts';
import { LauncherAgent } from './launcher.ts';
import { CommunityAgent } from './community-agent.ts';

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

  if (callbacks) supervisor.setCallbacks(callbacks);

  // Start all agents (non-blocking, each registers + starts loops)
  const agents = [supervisor, scout, guardian, analyst, launcher, community];

  for (const agent of agents) {
    try {
      await agent.start();
    } catch (err) {
      logger.warn(`[swarm] Agent ${(agent as any).agentId} failed to start (non-fatal):`, err);
    }
  }

  logger.info(`[swarm] ✅ ${agents.length} agents started (Scout, Guardian, Analyst, Launcher, Community + Supervisor)`);

  return { supervisor, scout, guardian, analyst, launcher, community };
}

/**
 * Gracefully stop all agents in the swarm.
 */
export async function stopSwarm(swarm: SwarmHandle): Promise<void> {
  logger.info('[swarm] Stopping agent swarm...');

  const agents = [
    swarm.community,
    swarm.launcher,
    swarm.analyst,
    swarm.guardian,
    swarm.scout,
    swarm.supervisor, // Stop supervisor last
  ];

  for (const agent of agents) {
    try {
      await agent.stop();
    } catch (err) {
      logger.warn(`[swarm] Error stopping agent:`, err);
    }
  }

  logger.info('[swarm] All agents stopped');
}
