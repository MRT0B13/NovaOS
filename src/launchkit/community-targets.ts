/**
 * Nova Community Reply Targets
 *
 * Three tiers of X accounts Nova monitors and replies to.
 * Nova ONLY replies when it has genuine intel to add — never generic engagement.
 *
 * Each account has:
 * - maxRepliesPerDay: hard cap on replies to this account
 * - replyWhen: pipe-separated trigger keywords that justify a reply
 */

export interface CommunityTarget {
  handle: string;
  maxRepliesPerDay: number;
  replyWhen: string; // pipe-separated trigger keywords
}

export interface CommunityTargetTier {
  accounts: CommunityTarget[];
  replyStyle: 'peer' | 'analyst' | 'collaborator';
}

export const COMMUNITY_TARGETS: Record<string, CommunityTargetTier> = {
  // ── Tier 1: AI Agent Ecosystem (daily engagement) ─────────────────
  // These are the accounts that define the AI agent space.
  // Nova talks to them as a PEER — a fellow autonomous agent, not a fan.
  tier1_ai_agents: {
    accounts: [
      { handle: 'aixbt_agent', maxRepliesPerDay: 2, replyWhen: 'market_analysis|token_mention|narrative' },
      { handle: 'virtuals_io', maxRepliesPerDay: 1, replyWhen: 'new_agent_launch|ecosystem_update|solana' },
      { handle: 'elizaos', maxRepliesPerDay: 2, replyWhen: 'framework_update|showcase|dev_question' },
      { handle: 'shawmakesmagic', maxRepliesPerDay: 1, replyWhen: 'elizaos_update|agent_discussion|technical' },
      { handle: 'KaitoAI', maxRepliesPerDay: 1, replyWhen: 'mindshare_data|agent_ranking' },
      { handle: 'truth_terminal', maxRepliesPerDay: 1, replyWhen: 'meme_token|ai_agent_discussion' },
      { handle: 'cookiedotfun', maxRepliesPerDay: 1, replyWhen: 'agent_data|indexing|analytics' },
      { handle: '0xzerebro', maxRepliesPerDay: 1, replyWhen: 'solana_agent|cross_chain|framework' },
      { handle: 'paboracle', maxRepliesPerDay: 1, replyWhen: 'solana_agent|skill_update|meme' },
    ],
    replyStyle: 'peer',
  },

  // ── Tier 2: Crypto Intelligence Accounts ──────────────────────────
  // Nova replies with DATA — stats, RugCheck results, DeFiLlama metrics.
  // Position Nova as the agent that provides actionable intelligence.
  tier2_crypto_intel: {
    accounts: [
      { handle: 'BanklessHQ', maxRepliesPerDay: 1, replyWhen: 'ai_agent_coverage|defi_analysis' },
      { handle: 'DefiLlama', maxRepliesPerDay: 1, replyWhen: 'tvl_update|protocol_data|solana' },
      { handle: 'RugCheckxyz', maxRepliesPerDay: 2, replyWhen: 'rug_alert|safety_update|scan_result' },
      { handle: 'solana', maxRepliesPerDay: 1, replyWhen: 'ecosystem_update|technical_upgrade' },
      { handle: 'MessariCrypto', maxRepliesPerDay: 1, replyWhen: 'ai_agent_research|market_report' },
      { handle: 'TheBlock__', maxRepliesPerDay: 1, replyWhen: 'ai_agent_news|solana_news' },
    ],
    replyStyle: 'analyst',
  },

  // ── Tier 3: Agent Peers (relationship building) ───────────────────
  // Engage as a collaborator, not a competitor. Build bridges for
  // future integrations, cross-promotion, multi-agent partnerships.
  tier3_agent_peers: {
    accounts: [
      { handle: 'HeyAnonai', maxRepliesPerDay: 1, replyWhen: 'defi_agent|natural_language' },
      { handle: 'autonaborolas', maxRepliesPerDay: 1, replyWhen: 'multi_agent|framework' },
      { handle: 'ai16zdao', maxRepliesPerDay: 1, replyWhen: 'dao_update|elizaos' },
      { handle: 'getgrass_io', maxRepliesPerDay: 1, replyWhen: 'data_infra|ai_training' },
    ],
    replyStyle: 'collaborator',
  },
};

/**
 * Flatten all targets into a single array for the reply engine.
 * Merge these into search queries or monitoring lists.
 */
export function getAllTargetHandles(): string[] {
  return Object.values(COMMUNITY_TARGETS).flatMap(tier =>
    tier.accounts.map(a => a.handle),
  );
}

/**
 * Get the target config + tier style for a given handle.
 */
export function getTargetConfig(handle: string): { target: CommunityTarget; style: 'peer' | 'analyst' | 'collaborator' } | null {
  for (const tier of Object.values(COMMUNITY_TARGETS)) {
    const target = tier.accounts.find(
      a => a.handle.toLowerCase() === handle.toLowerCase(),
    );
    if (target) return { target, style: tier.replyStyle };
  }
  return null;
}

/**
 * Get the total number of community targets across all tiers.
 */
export function getTargetCount(): number {
  return Object.values(COMMUNITY_TARGETS).reduce((sum, tier) => sum + tier.accounts.length, 0);
}

/**
 * Reply Style Guide — injected into the LLM system prompt per tier.
 */
export const REPLY_STYLE_GUIDES: Record<string, string> = {
  peer: `Reply as a fellow AI agent. Share your own data/analysis. Never fanboy. Example: "We're seeing similar patterns in our intelligence engine. 3 of 5 top narratives this week overlap with your calls."`,
  analyst: `Lead with data. Provide stats, RugCheck results, DeFiLlama metrics. Example: "Just ran a RugCheck on that token — LP is locked but top wallet holds 38% of supply. Creator has 2 prior rugs."`,
  collaborator: `Position as a potential partner. Show what Nova can offer. Example: "Interesting approach to multi-agent coordination. We're solving a similar problem on Solana — our scout-guardian-supervisor pattern might have overlap."`,
};
