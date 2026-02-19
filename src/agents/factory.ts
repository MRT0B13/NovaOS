/**
 * Agent Factory — MVP
 *
 * Generates agent configurations from natural language descriptions.
 * Uses an LLM to parse user requests into structured agent specs.
 *
 * MVP scope:
 * - Single capability agents only (monitoring, alerting, scanning)
 * - Telegram-only output
 * - Pre-defined plugin/capability combinations
 * - Manual approval required before spawning
 * - Persists specs in agent_registry + local store
 *
 * Future:
 * - NOVA token gating (burn-to-spawn)
 * - Multi-platform output
 * - Custom model selection
 * - Resource budgets per user
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { Supervisor } from './supervisor.ts';

// ============================================================================
// Types
// ============================================================================

export type CapabilityType =
  | 'whale_tracking'
  | 'token_monitoring'
  | 'kol_scanning'
  | 'safety_scanning'
  | 'narrative_tracking';

export type AgentSpecStatus = 'pending' | 'approved' | 'running' | 'stopped' | 'rejected';

export interface AgentSpec {
  id: string;                           // UUID
  name: string;                         // Human-readable name
  description: string;                  // What this agent does
  capabilities: CapabilityType[];       // Resolved capabilities
  schedule: string;                     // Cron-like or interval description
  outputChannel: 'telegram' | 'x' | 'both';
  createdBy: string;                    // Requesting user's TG ID
  createdAt: Date;
  status: AgentSpecStatus;
  approvedBy?: string;                  // Admin who approved
  approvedAt?: Date;
  config: Record<string, any>;          // Capability-specific configuration
  resourceLimit: {                      // MVP resource caps
    maxMemoryMb: number;
    maxCpuPercent: number;
    maxApiCallsPerHour: number;
  };
}

export interface CapabilityTemplate {
  description: string;
  keywords: string[];                   // LLM matching hints
  defaultSchedule: string;
  requiresConfig: string[];             // Config keys the user must provide
  optionalConfig: string[];
}

// ============================================================================
// Capability Templates
// ============================================================================

export const CAPABILITY_TEMPLATES: Record<CapabilityType, CapabilityTemplate> = {
  whale_tracking: {
    description: 'Monitor large wallet movements on Solana',
    keywords: ['whale', 'wallet', 'large transfer', 'big buy', 'big sell', 'movement'],
    defaultSchedule: 'every 5 minutes',
    requiresConfig: [],
    optionalConfig: ['minTransferSol', 'watchAddresses'],
  },
  token_monitoring: {
    description: 'Track a specific token price, volume, and holder changes via DexScreener',
    keywords: ['token', 'price', 'volume', 'holders', 'monitor', 'track', 'watch'],
    defaultSchedule: 'every 10 minutes',
    requiresConfig: ['tokenAddress'],
    optionalConfig: ['tokenSymbol', 'alertOnPriceChange', 'alertOnVolumeSpike'],
  },
  kol_scanning: {
    description: 'Monitor specific X/Twitter accounts and alert on relevant posts',
    keywords: ['kol', 'twitter', 'x account', 'influencer', 'monitor posts', 'follow'],
    defaultSchedule: 'every 5 minutes',
    requiresConfig: [],
    optionalConfig: ['targetAccounts', 'keywords'],
  },
  safety_scanning: {
    description: 'Run continuous RugCheck safety scans on specified tokens',
    keywords: ['rug', 'safety', 'scan', 'rugcheck', 'audit', 'safe', 'scam'],
    defaultSchedule: 'every 1 minute',
    requiresConfig: ['tokenAddress'],
    optionalConfig: ['alertThreshold'],
  },
  narrative_tracking: {
    description: 'Track narrative/sentiment shifts across KOL posts and social media',
    keywords: ['narrative', 'sentiment', 'trend', 'meta', 'alpha', 'what\'s hot'],
    defaultSchedule: 'every 15 minutes',
    requiresConfig: [],
    optionalConfig: ['focusTopics', 'excludeTopics'],
  },
};

// ============================================================================
// Default resource limits
// ============================================================================

const DEFAULT_RESOURCE_LIMIT = {
  maxMemoryMb: 128,
  maxCpuPercent: 10,
  maxApiCallsPerHour: 60,
};

const MAX_AGENTS_PER_USER = 3;       // MVP cap

// ============================================================================
// Agent Factory
// ============================================================================

export class AgentFactory {
  private pool: Pool;
  private specs: Map<string, AgentSpec> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ── Parse natural language request into AgentSpec ──────────────

  /**
   * Parse a user's free-text request into a structured AgentSpec.
   * MVP: rule-based keyword matching (LLM integration later).
   */
  parseRequest(userMessage: string, userId: string): AgentSpec | null {
    const lower = userMessage.toLowerCase();

    // Detect capabilities by keyword matching
    const matched: CapabilityType[] = [];
    for (const [capType, template] of Object.entries(CAPABILITY_TEMPLATES)) {
      if (template.keywords.some(kw => lower.includes(kw))) {
        matched.push(capType as CapabilityType);
      }
    }

    if (matched.length === 0) {
      logger.debug(`[factory] No capabilities matched for: "${userMessage}"`);
      return null;
    }

    // Extract token address if present (Solana base58 ~32-44 chars)
    const addressMatch = lower.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
    const tokenAddress = addressMatch?.[1];

    // Extract token symbol if present ($SYMBOL)
    const symbolMatch = userMessage.match(/\$([A-Z]{2,10})/i);
    const tokenSymbol = symbolMatch?.[1];

    // Derive the schedule from the first matched capability
    const primaryCapability = matched[0];
    const schedule = CAPABILITY_TEMPLATES[primaryCapability].defaultSchedule;

    // Build config from extracted data
    const config: Record<string, any> = {};
    if (tokenAddress) config.tokenAddress = tokenAddress;
    if (tokenSymbol) config.tokenSymbol = tokenSymbol;

    const id = this.generateId();
    const name = this.deriveAgentName(matched, tokenSymbol);

    const spec: AgentSpec = {
      id,
      name,
      description: userMessage.slice(0, 500),
      capabilities: matched,
      schedule,
      outputChannel: 'telegram',
      createdBy: userId,
      createdAt: new Date(),
      status: 'pending',
      config,
      resourceLimit: { ...DEFAULT_RESOURCE_LIMIT },
    };

    this.specs.set(id, spec);
    logger.info(`[factory] Created spec "${name}" (${matched.join(', ')}) for user ${userId}`);
    return spec;
  }

  // ── Approval Flow ─────────────────────────────────────────────

  /**
   * Approve a pending agent spec (admin-only in MVP).
   */
  async approve(specId: string, adminId: string): Promise<AgentSpec | null> {
    const spec = this.specs.get(specId);
    if (!spec) return null;
    if (spec.status !== 'pending') {
      logger.warn(`[factory] Cannot approve spec ${specId} — status is ${spec.status}`);
      return null;
    }

    spec.status = 'approved';
    spec.approvedBy = adminId;
    spec.approvedAt = new Date();
    this.specs.set(specId, spec);

    // Persist in agent_registry
    await this.persistSpec(spec);

    logger.info(`[factory] Spec "${spec.name}" approved by ${adminId}`);
    return spec;
  }

  /**
   * Reject a pending agent spec.
   */
  reject(specId: string, reason?: string): boolean {
    const spec = this.specs.get(specId);
    if (!spec || spec.status !== 'pending') return false;
    spec.status = 'rejected';
    this.specs.set(specId, spec);
    logger.info(`[factory] Spec "${spec.name}" rejected${reason ? `: ${reason}` : ''}`);
    return true;
  }

  // ── Spawn Agent ───────────────────────────────────────────────

  /**
   * Spawn an approved agent using the Supervisor.
   * MVP: only supports token_monitoring (spawns TokenChildAgent).
   * Other capabilities log a placeholder.
   */
  async spawn(specId: string, supervisor: Supervisor): Promise<boolean> {
    const spec = this.specs.get(specId);
    if (!spec || spec.status !== 'approved') {
      logger.warn(`[factory] Cannot spawn — spec ${specId} not approved`);
      return false;
    }

    // Check user's active agent count
    const userAgents = Array.from(this.specs.values()).filter(
      s => s.createdBy === spec.createdBy && s.status === 'running'
    );
    if (userAgents.length >= MAX_AGENTS_PER_USER) {
      logger.warn(`[factory] User ${spec.createdBy} has ${userAgents.length} active agents (max ${MAX_AGENTS_PER_USER})`);
      return false;
    }

    try {
      if (spec.capabilities.includes('token_monitoring') && spec.config.tokenAddress) {
        // Use Supervisor's child agent infrastructure
        await supervisor.spawnChild({
          tokenAddress: spec.config.tokenAddress,
          tokenName: spec.config.tokenName || spec.name,
          tokenSymbol: spec.config.tokenSymbol || '???',
          chatId: spec.config.chatId,
          autoDeactivateAfterHours: 168, // User-created agents last 7 days by default
        });
        spec.status = 'running';
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned token_monitoring agent: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('safety_scanning') && spec.config.tokenAddress) {
        // Request Guardian to add token to its watch list
        await supervisor.requestScan(spec.config.tokenAddress, spec.createdBy);
        spec.status = 'running';
        this.specs.set(specId, spec);
        logger.info(`[factory] Activated safety_scanning via Guardian: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('kol_scanning') || spec.capabilities.includes('narrative_tracking')) {
        // Request Scout for immediate intel scan
        await supervisor.requestIntelScan();
        spec.status = 'running';
        this.specs.set(specId, spec);
        logger.info(`[factory] Activated ${spec.capabilities[0]} via Scout: ${spec.name}`);
        return true;
      }

      // Fallback: capability not yet fully implemented
      logger.info(`[factory] Capabilities [${spec.capabilities.join(', ')}] not yet spawnable — marking as pending`);
      return false;
    } catch (err: any) {
      logger.error(`[factory] Failed to spawn "${spec.name}": ${err.message}`);
      return false;
    }
  }

  /**
   * Stop a running agent.
   */
  async stop(specId: string, supervisor: Supervisor): Promise<boolean> {
    const spec = this.specs.get(specId);
    if (!spec || spec.status !== 'running') return false;

    if (spec.capabilities.includes('token_monitoring') && spec.config.tokenAddress) {
      await supervisor.deactivateChild(spec.config.tokenAddress);
    }

    spec.status = 'stopped';
    this.specs.set(specId, spec);
    logger.info(`[factory] Stopped agent: ${spec.name}`);
    return true;
  }

  // ── Query ─────────────────────────────────────────────────────

  getSpec(specId: string): AgentSpec | undefined {
    return this.specs.get(specId);
  }

  listSpecs(userId?: string): AgentSpec[] {
    const all = Array.from(this.specs.values());
    return userId ? all.filter(s => s.createdBy === userId) : all;
  }

  getPendingSpecs(): AgentSpec[] {
    return Array.from(this.specs.values()).filter(s => s.status === 'pending');
  }

  getRunningCount(userId?: string): number {
    return Array.from(this.specs.values()).filter(
      s => s.status === 'running' && (!userId || s.createdBy === userId)
    ).length;
  }

  // ── Format for Telegram ───────────────────────────────────────

  formatSpecForTelegram(spec: AgentSpec): string {
    const statusEmoji: Record<AgentSpecStatus, string> = {
      pending: '⏳',
      approved: '✅',
      running: '🟢',
      stopped: '⛔',
      rejected: '❌',
    };

    const lines = [
      `${statusEmoji[spec.status]} **${spec.name}**`,
      `ID: \`${spec.id}\``,
      `Capabilities: ${spec.capabilities.join(', ')}`,
      `Schedule: ${spec.schedule}`,
      `Status: ${spec.status}`,
    ];

    if (spec.config.tokenAddress) {
      lines.push(`Token: \`${spec.config.tokenAddress.slice(0, 8)}...\``);
    }
    if (spec.config.tokenSymbol) {
      lines.push(`Symbol: $${spec.config.tokenSymbol}`);
    }

    return lines.join('\n');
  }

  // Format a pending spec as an approval request
  formatApprovalRequest(spec: AgentSpec): string {
    return [
      `🏭 **New Agent Request**`,
      ``,
      `From user: ${spec.createdBy}`,
      `Request: "${spec.description.slice(0, 200)}"`,
      ``,
      `Resolved capabilities: ${spec.capabilities.join(', ')}`,
      `Schedule: ${spec.schedule}`,
      `Config: ${JSON.stringify(spec.config)}`,
      ``,
      `To approve: /approve_agent ${spec.id}`,
      `To reject: /reject_agent ${spec.id}`,
    ].join('\n');
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private generateId(): string {
    return `af-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private deriveAgentName(capabilities: CapabilityType[], tokenSymbol?: string): string {
    const capLabel = capabilities[0].replace(/_/g, '-');
    const suffix = tokenSymbol ? `-${tokenSymbol.toUpperCase()}` : '';
    return `nova-${capLabel}${suffix}`;
  }

  private async persistSpec(spec: AgentSpec): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO agent_registry (agent_name, agent_type, enabled, auto_restart, max_memory_mb, start_command, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_name) DO UPDATE SET
           enabled = $3, config = $7`,
        [
          spec.name,
          'factory-spawned',
          spec.status === 'approved' || spec.status === 'running',
          false,
          spec.resourceLimit.maxMemoryMb,
          `factory:${spec.id}`,
          JSON.stringify({
            specId: spec.id,
            capabilities: spec.capabilities,
            createdBy: spec.createdBy,
            config: spec.config,
          }),
        ]
      );
    } catch (err: any) {
      logger.warn(`[factory] Failed to persist spec: ${err.message}`);
    }
  }
}
