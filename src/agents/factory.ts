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
import type { PoolSkillEntry } from '../launchkit/services/skillsService.ts';

// ============================================================================
// Types
// ============================================================================

export type CapabilityType =
  | 'whale_tracking'
  | 'token_monitoring'
  | 'kol_scanning'
  | 'safety_scanning'
  | 'narrative_tracking'
  | 'social_trending'
  | 'yield_monitoring'
  | 'arb_scanning'
  | 'portfolio_monitoring';

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
  /** Pool skills suggested for this agent's capabilities */
  suggestedSkills?: PoolSkillEntry[];
  /** User-provided wallet config for on-chain agent trading */
  wallet?: {
    chain: 'solana' | 'evm' | 'both';
    address: string;                    // Public address (always stored)
    encryptedKey?: string;              // Encrypted private key (optional — enables trading)
    permissions: ('read' | 'trade' | 'lp')[];
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
    keywords: ['token', 'price', 'volume', 'holders'],
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
    keywords: ['narrative', 'sentiment', 'meta', 'alpha', 'what\'s hot'],
    defaultSchedule: 'every 15 minutes',
    requiresConfig: [],
    optionalConfig: ['focusTopics', 'excludeTopics'],
  },
  social_trending: {
    description: 'Monitor Reddit and Google Trends for viral meme-worthy topics that can fuel token launches',
    keywords: ['social', 'trending', 'memes', 'viral', 'reddit', 'buzz', 'google trends', 'mainstream', 'pop culture'],
    defaultSchedule: 'every 20 minutes',
    requiresConfig: [],
    optionalConfig: ['subreddits', 'minScore'],
  },
  yield_monitoring: {
    description: 'Monitor DeFi yields across Krystal (EVM multi-chain), Orca, Kamino, and Jito (Solana)',
    keywords: ['yield', 'apy', 'apr', 'farming', 'defi yields', 'staking', 'liquidity', 'lp rewards', 'krystal', 'orca', 'kamino', 'jito'],
    defaultSchedule: 'every 15 minutes',
    requiresConfig: [],
    optionalConfig: ['minApy', 'minTvl', 'chains'],
  },
  arb_scanning: {
    description: 'Scan cross-DEX arbitrage opportunities on EVM (Uniswap, Camelot, PancakeSwap, Balancer)',
    keywords: ['arb', 'arbitrage', 'flash loan', 'cross-dex', 'price gap', 'spread', 'mev'],
    defaultSchedule: 'every 2 minutes',
    requiresConfig: [],
    optionalConfig: ['minProfitUsd'],
  },
  portfolio_monitoring: {
    description: 'Monitor portfolio health across Solana + EVM — PnL alerts, drawdown warnings, rebalance signals',
    keywords: ['portfolio', 'pnl', 'drawdown', 'positions', 'balance', 'rebalance', 'exposure', 'risk'],
    defaultSchedule: 'every 10 minutes',
    requiresConfig: [],
    optionalConfig: ['drawdownThreshold', 'positionLossThreshold'],
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

  /**
   * Restore previously persisted specs from agent_registry.
   * Call once after construction to survive restarts.
   */
  async restoreSpecs(): Promise<number> {
    try {
      const res = await this.pool.query(
        `SELECT agent_name, config, enabled, start_command FROM agent_registry
         WHERE agent_type = 'factory-spawned' AND start_command LIKE 'factory:%'`,
      );
      let restored = 0;
      for (const row of res.rows) {
        try {
          const data = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          if (!data?.specId) continue;

          const spec: AgentSpec = {
            id: data.specId,
            name: row.agent_name,
            description: data.description || '',
            capabilities: data.capabilities || [],
            schedule: data.schedule || 'unknown',
            outputChannel: data.outputChannel || 'telegram',
            createdBy: data.createdBy || 'unknown',
            createdAt: new Date(data.createdAt || Date.now()),
            status: row.enabled ? 'approved' : 'stopped',
            approvedBy: data.approvedBy,
            config: data.config || {},
            resourceLimit: data.resourceLimit || { ...DEFAULT_RESOURCE_LIMIT },
            wallet: data.wallet,
          };
          this.specs.set(spec.id, spec);
          restored++;
        } catch { /* skip malformed row */ }
      }
      if (restored > 0) {
        logger.info(`[factory] Restored ${restored} specs from agent_registry`);
      }
      return restored;
    } catch (err) {
      logger.debug('[factory] Could not restore specs (table may not exist yet):', err);
      return 0;
    }
  }

  // ── Parse natural language request into AgentSpec ──────────────

  /**
   * Parse a user's free-text request into a structured AgentSpec.
   * MVP: rule-based keyword matching (LLM integration later).
   */
  parseRequest(userMessage: string, userId: string): AgentSpec | null {
    const lower = userMessage.toLowerCase();

    // Detect capabilities by keyword matching (word-boundary aware)
    const matched: CapabilityType[] = [];
    for (const [capType, template] of Object.entries(CAPABILITY_TEMPLATES)) {
      const hit = template.keywords.some(kw => {
        // Multi-word keywords (e.g. 'google trends') use simple includes
        if (kw.includes(' ')) return lower.includes(kw);
        // Single-word keywords use word-boundary match to avoid partial hits
        // e.g. 'trend' should NOT match 'trending' (that's social_trending's keyword)
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`);
        return re.test(lower);
      });
      if (hit) matched.push(capType as CapabilityType);
    }

    // If social_trending matched, make it the primary (first) capability
    // so the agent name reflects the user's intent
    const socialIdx = matched.indexOf('social_trending');
    if (socialIdx > 0) {
      matched.splice(socialIdx, 1);
      matched.unshift('social_trending');
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

  /**
   * Load skill suggestions from the skill pool for a spec's capabilities.
   * Matches by capability overlap, then re-ranks by description relevance.
   * Call after parseRequest() and await before displaying to user/admin.
   */
  async loadSkillSuggestions(spec: AgentSpec): Promise<PoolSkillEntry[]> {
    try {
      const { getSkillsService } = await import('../launchkit/services/skillsService.ts');
      const svc = getSkillsService();
      if (!svc) return [];

      const poolSkills = await svc.getPoolSkillsForCapabilities(spec.capabilities, 15);
      if (poolSkills.length === 0) return [];

      // Re-rank by description relevance: score each pool skill against spec description
      const descWords = spec.description.toLowerCase().split(/\W+/).filter(w => w.length > 2);
      const ranked = poolSkills.map(skill => {
        const skillText = `${skill.name} ${skill.description}`.toLowerCase();
        // Count how many description words appear in the skill text
        const matchCount = descWords.filter(w => skillText.includes(w)).length;
        const descRelevance = descWords.length > 0 ? matchCount / descWords.length : 0;
        // Composite: 60% capability relevance (maxRelevance), 40% description match
        const compositeScore = (skill.maxRelevance * 0.6) + (descRelevance * 0.4);
        return { skill, compositeScore };
      });

      ranked.sort((a, b) => b.compositeScore - a.compositeScore);
      const topSkills = ranked.slice(0, 5).map(r => r.skill);

      spec.suggestedSkills = topSkills;
      this.specs.set(spec.id, spec);

      // Track suggestion metrics
      await svc.markPoolSkillsSuggested(topSkills.map(s => s.id));
      logger.info(`[factory] Suggested ${topSkills.length} pool skills for "${spec.name}" (from ${poolSkills.length} candidates)`);
      return topSkills;
    } catch (err) {
      logger.debug(`[factory] Skill suggestion lookup failed (non-fatal):`, err);
      return [];
    }
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

      if (spec.capabilities.includes('social_trending')) {
        // Spawn a SocialSentinel agent — polls Reddit + Google Trends
        const { SocialSentinelAgent } = await import('./social-sentinel.ts');
        const sentinel = new SocialSentinelAgent(this.pool, {
          subreddits: spec.config.subreddits,
        });
        await sentinel.start();
        spec.status = 'running';
        spec.config._agentInstance = sentinel;
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned social_trending agent: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('whale_tracking')) {
        // Spawn a Whale Tracker — monitors Solana + EVM wallet movements
        const { WhaleTrackerAgent } = await import('./whale-tracker.ts');
        const tracker = new WhaleTrackerAgent(this.pool, {
          minTransferUsd: spec.config.minTransferSol ? spec.config.minTransferSol * 150 : undefined,
          watchAddresses: spec.config.watchAddresses,
          wallet: spec.wallet,
        });
        await tracker.start();
        spec.status = 'running';
        spec.config._agentInstance = tracker;
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned whale_tracking agent: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('yield_monitoring')) {
        // Spawn a Yield Scout — multi-chain DeFi yield radar
        const { YieldScoutAgent } = await import('./yield-scout.ts');
        const scout = new YieldScoutAgent(this.pool, {
          minApy: spec.config.minApy,
          minTvl: spec.config.minTvl,
          chains: spec.config.chains,
          wallet: spec.wallet,
        });
        await scout.start();
        spec.status = 'running';
        spec.config._agentInstance = scout;
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned yield_monitoring agent: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('arb_scanning')) {
        // Spawn an Arb Scanner — cross-DEX opportunity detection on EVM
        const { ArbScannerAgent } = await import('./arb-scanner.ts');
        const scanner = new ArbScannerAgent(this.pool, {
          minProfitUsd: spec.config.minProfitUsd,
          wallet: spec.wallet,
        });
        await scanner.start();
        spec.status = 'running';
        spec.config._agentInstance = scanner;
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned arb_scanning agent: ${spec.name}`);
        return true;
      }

      if (spec.capabilities.includes('portfolio_monitoring')) {
        // Spawn a Portfolio Watchdog — multi-chain portfolio health monitoring
        const { PortfolioWatchdogAgent } = await import('./portfolio-watchdog.ts');
        const watchdog = new PortfolioWatchdogAgent(this.pool, {
          drawdownThreshold: spec.config.drawdownThreshold,
          positionLossThreshold: spec.config.positionLossThreshold,
          wallet: spec.wallet,
        });
        await watchdog.start();
        spec.status = 'running';
        spec.config._agentInstance = watchdog;
        this.specs.set(specId, spec);
        logger.info(`[factory] Spawned portfolio_monitoring agent: ${spec.name}`);
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

    // Stop standalone agent instances
    if (spec.config._agentInstance && typeof spec.config._agentInstance.stop === 'function') {
      try {
        await spec.config._agentInstance.stop();
        logger.info(`[factory] Stopped agent instance for ${spec.name}`);
      } catch (err: any) {
        logger.warn(`[factory] Failed to stop agent instance: ${err.message}`);
      }
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

    const capNames = spec.capabilities.map(c => c.replace(/_/g, ' ')).join(', ');

    const lines = [
      `${statusEmoji[spec.status]} <b>${spec.name}</b>`,
      ``,
      `📌 <b>Type:</b> ${capNames}`,
      `⏱ <b>Schedule:</b> ${spec.schedule}`,
      `📊 <b>Status:</b> ${spec.status}`,
      `🆔 <code>${spec.id}</code>`,
    ];

    if (spec.config.tokenAddress) {
      lines.push(`💰 <b>Token:</b> <code>${spec.config.tokenAddress.slice(0, 8)}...</code>`);
    }
    if (spec.config.tokenSymbol) {
      lines.push(`🏷 <b>Symbol:</b> $${spec.config.tokenSymbol}`);
    }
    if (spec.wallet) {
      lines.push(`💼 <b>Wallet:</b> ${spec.wallet.chain} | <code>${spec.wallet.address.slice(0, 6)}...${spec.wallet.address.slice(-4)}</code>`);
      lines.push(`🔑 <b>Permissions:</b> ${spec.wallet.permissions.join(', ')}${spec.wallet.encryptedKey ? ' 🔐' : ' (read-only)'}`);
    }
    if (spec.suggestedSkills && spec.suggestedSkills.length > 0) {
      lines.push(`📦 <b>Skills:</b> ${spec.suggestedSkills.length} suggested`);
    }

    return lines.join('\n');
  }

  // Format a pending spec as an approval request
  formatApprovalRequest(spec: AgentSpec): string {
    const capNames = spec.capabilities.map(c => c.replace(/_/g, ' ')).join(', ');

    const userConfig = { ...spec.config };
    delete userConfig._agentInstance;
    const hasConfig = Object.keys(userConfig).length > 0;

    const lines = [
      `🏭 <b>New Agent Request</b>`,
      ``,
      `👤 <b>From:</b> ${spec.createdBy}`,
      `💬 <b>Request:</b> "${spec.description.slice(0, 200)}"`,
      ``,
      `📌 <b>Capabilities:</b> ${capNames}`,
      `⏱ <b>Schedule:</b> ${spec.schedule}`,
    ];

    if (hasConfig) {
      lines.push(`⚙️ <b>Config:</b> ${JSON.stringify(userConfig)}`);
    }

    if (spec.wallet) {
      lines.push(`💼 <b>Wallet:</b> ${spec.wallet.chain} | ${spec.wallet.address.slice(0, 8)}...${spec.wallet.address.slice(-4)}`);
      lines.push(`🔑 <b>Permissions:</b> ${spec.wallet.permissions.join(', ')}`);
      if (spec.wallet.encryptedKey) {
        lines.push(`⚠️ <b>Private key provided</b> — trading enabled`);
      }
    }

    if (spec.suggestedSkills && spec.suggestedSkills.length > 0) {
      lines.push(``, `📦 <b>Suggested Skills from Pool:</b>`);
      for (const skill of spec.suggestedSkills) {
        const relevance = Math.round(skill.maxRelevance * 100);
        lines.push(`  • ${skill.name} (${relevance}%) — <code>/attach_skill ${spec.id} ${skill.id}</code>`);
      }
    }

    lines.push(
      ``,
      `✅ Approve:`,
      `<code>/approve_agent ${spec.id}</code>`,
      ``,
      `❌ Reject:`,
      `<code>/reject_agent ${spec.id}</code>`,
    );

    return lines.join('\n');
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private static readonly ADJECTIVES = [
    'swift', 'bold', 'calm', 'dark', 'fast', 'gold', 'keen', 'loud',
    'neon', 'pure', 'rare', 'slim', 'warm', 'wild', 'cool', 'deep',
    'fair', 'glad', 'half', 'iron', 'jade', 'kind', 'lazy', 'mint',
    'pale', 'rich', 'safe', 'tall', 'vast', 'wise', 'blue', 'gray',
  ];

  private static readonly ANIMALS = [
    'fox', 'owl', 'bee', 'cat', 'dog', 'elk', 'emu', 'ant',
    'bat', 'cod', 'cow', 'fly', 'hen', 'jay', 'ram', 'yak',
    'ape', 'bug', 'cub', 'doe', 'eel', 'gnu', 'hog', 'koi',
    'pug', 'rat', 'ray', 'roc', 'tit', 'wren', 'lynx', 'wolf',
  ];

  private generateId(): string {
    const adj = AgentFactory.ADJECTIVES[Math.floor(Math.random() * AgentFactory.ADJECTIVES.length)];
    const animal = AgentFactory.ANIMALS[Math.floor(Math.random() * AgentFactory.ANIMALS.length)];
    return `${adj}-${animal}`;
  }

  private deriveAgentName(capabilities: CapabilityType[], tokenSymbol?: string): string {
    const capLabel = capabilities[0].replace(/_/g, '-');
    const suffix = tokenSymbol ? `-${tokenSymbol.toUpperCase()}` : '';
    return `nova-${capLabel}${suffix}`;
  }

  private async persistSpec(spec: AgentSpec): Promise<void> {
    try {
      // Sanitize config — strip runtime-only fields
      const persistConfig = { ...spec.config };
      delete persistConfig._agentInstance;

      await this.pool.query(
        `INSERT INTO agent_registry (agent_name, agent_type, enabled, auto_restart, max_memory_mb, start_command, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_name) DO UPDATE SET
           enabled = $3, config = $7, updated_at = NOW()`,
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
            createdAt: spec.createdAt,
            approvedBy: spec.approvedBy,
            description: spec.description,
            schedule: spec.schedule,
            outputChannel: spec.outputChannel,
            resourceLimit: spec.resourceLimit,
            config: persistConfig,
            wallet: spec.wallet ? {
              chain: spec.wallet.chain,
              address: spec.wallet.address,
              encryptedKey: spec.wallet.encryptedKey,
              permissions: spec.wallet.permissions,
            } : undefined,
          }),
        ]
      );
    } catch (err: any) {
      logger.warn(`[factory] Failed to persist spec: ${err.message}`);
    }
  }
}
