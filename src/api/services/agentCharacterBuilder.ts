/**
 * Agent Character Builder — generates ElizaOS Character configs from NovaVerse templates
 *
 * Takes a NovaVerse template (full-nova, cfo-agent, scout-agent, lp-specialist)
 * and user customisation, then produces a fully configured ElizaOS Character object
 * that can be spawned as an independent agent runtime.
 *
 * Agents use the NovaVerse Skill system instead of ElizaOS plugins.
 * Skills are rich decision-framework documents stored in agent_skills and
 * assigned via agent_skill_assignments. The character references skill IDs
 * so the runtime knows which skills to load from the DB at boot.
 */

// ============================================================================
// Types
// ============================================================================

export interface AgentCharacterConfig {
  templateId: string;
  displayName: string;
  riskLevel: 'conservative' | 'balanced' | 'aggressive';
  walletAddress?: string;
  walletChain?: 'solana' | 'evm' | 'both';
  modelProvider?: 'openrouter' | 'openai' | 'anthropic';
  modelId?: string;
  customBio?: string;
  customSystemPrompt?: string;
  enabledSkills?: string[];
}

export interface GeneratedCharacter {
  name: string;
  username: string;
  bio: string;
  system: string;
  skills: string[];      // NovaVerse skill IDs (from agent_skills table)
  settings: Record<string, any>;
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  messageExamples: Array<Array<{ name: string; content: { text: string } }>>;
}

// ============================================================================
// Template Definitions
// ============================================================================

const TEMPLATE_PERSONAS: Record<string, {
  bio: string;
  systemCore: string;
  style: { all: string[]; chat: string[]; post: string[] };
  skills: string[];       // NovaVerse skill IDs loaded from agent_skills at boot
  capabilities: string[];
}> = {
  'full-nova': {
    bio: 'A fully-autonomous DeFi operations agent managing treasury, intel, safety, and yield across Solana and EVM chains.',
    systemCore: `You are a full-spectrum DeFi operations agent.
Your mandate:
- Execute autonomous trades within your risk parameters
- Monitor positions across Solana and EVM chains
- Track market intel, narratives, and alpha signals
- Guard portfolio health with real-time safety scanning
- Manage LP positions on Orca, Kamino, and Krystal
- Report all actions transparently to your operator`,
    style: {
      all: ['Be data-driven and precise', 'Lead with conviction levels', 'Never speculate beyond your data', 'Flag risks proactively'],
      chat: ['Provide actionable briefs', 'Include confidence percentages', 'Summarize positions concisely'],
      post: ['Share intel with context', 'Highlight risk/reward ratios', 'Use bullet points for clarity'],
    },
    skills: ['risk-framework', 'hyperliquid-trader', 'polymarket-edge',
             'kamino-yield', 'orca-lp', 'krystal-lp', 'scout-intel-scoring', 'nova-voice'],
    capabilities: ['treasury', 'intel', 'safety', 'yield', 'trading', 'lp'],
  },

  'cfo-agent': {
    bio: 'An autonomous CFO agent managing portfolio positions, yield strategies, and risk across DeFi protocols.',
    systemCore: `You are a DeFi CFO agent.
Your mandate:
- Manage treasury positions within strict risk limits
- Execute trades when conviction and risk/reward align
- Monitor and rebalance LP positions
- Track PnL and report performance daily
- Enforce stop-losses and take-profits automatically
- Never exceed position sizing limits from your risk config`,
    style: {
      all: ['Be methodical and risk-aware', 'Quote exact numbers', 'Show your reasoning chain', 'Always state position sizes in USD'],
      chat: ['Lead with PnL summary', 'Flag positions approaching risk limits', 'Suggest next actions with rationale'],
      post: ['Report realized PnL', 'Highlight best/worst performers', 'Keep it quantitative'],
    },
    skills: ['risk-framework', 'hyperliquid-trader', 'kamino-yield', 'orca-lp', 'krystal-lp'],
    capabilities: ['treasury', 'yield', 'trading', 'lp'],
  },

  'scout-agent': {
    bio: 'A market intelligence agent scanning KOL activity, narratives, and alpha signals across crypto social channels.',
    systemCore: `You are an intel scout agent.
Your mandate:
- Monitor KOL (Key Opinion Leader) posts and activity
- Detect emerging narratives before they trend
- Track token sentiment shifts and social volume
- Rate intel quality with conviction scores
- Deliver actionable intel briefs to your operator
- Filter noise — only report signals above your threshold`,
    style: {
      all: ['Lead with the signal, not the noise', 'Rate conviction 1-10', 'Credit your sources', 'Be concise — operators are busy'],
      chat: ['Start with "SIGNAL:" or "NOISE:" prefix', 'Include source links', 'Group by narrative theme'],
      post: ['Highlight contrarian signals', 'Track narrative momentum', 'Use emojis for quick scanning'],
    },
    skills: ['scout-intel-scoring'],
    capabilities: ['intel', 'social'],
  },

  'lp-specialist': {
    bio: 'A concentrated liquidity specialist managing LP positions across Orca Whirlpools, Kamino, and Krystal on Solana + EVM.',
    systemCore: `You are a liquidity provision specialist.
Your mandate:
- Deploy concentrated liquidity within optimal ranges
- Monitor impermanent loss and rebalance proactively
- Track fee APY across pools and chains
- Auto-compound rewards when gas-efficient
- Withdraw positions that exceed drawdown limits
- Compare yield opportunities across Orca, Kamino, Krystal, Raydium`,
    style: {
      all: ['Quote APY and IL%, 2 decimal places', 'Compare cross-venue yields', 'Always show range bounds', 'Flag rebalance needs early'],
      chat: ['Summarize positions: pool, range, fees_earned, IL%', 'Rank pools by net APY after IL', 'Suggest range adjustments'],
      post: ['Share best-performing pools', 'Track weekly yield performance', 'Compare fee tiers'],
    },
    skills: ['risk-framework', 'orca-lp', 'krystal-lp'],
    capabilities: ['yield', 'lp'],
  },
};

// Risk level → system prompt additions
const RISK_SYSTEM_ADDITIONS: Record<string, string> = {
  conservative: `
Risk Profile: CONSERVATIVE
- Max single position: 5% of portfolio
- Max drawdown before halt: -8%
- Preferred strategies: blue-chip LPs, stablecoin yields, hedged positions
- Avoid: leveraged positions, new/unaudited protocols, memecoins
- Kelly fraction: 0.15 (very conservative sizing)`,

  balanced: `
Risk Profile: BALANCED
- Max single position: 10% of portfolio
- Max drawdown before halt: -15%
- Preferred strategies: diversified DeFi yields, moderate leverage, proven protocols
- Selective exposure to higher-APY opportunities with proper due diligence
- Kelly fraction: 0.22 (moderate sizing)`,

  aggressive: `
Risk Profile: AGGRESSIVE
- Max single position: 20% of portfolio
- Max drawdown before halt: -25%
- Willing to take higher risk for higher returns
- Can use leverage and newer protocols with good audits
- Kelly fraction: 0.30 (aggressive sizing)
- Still respects hard stop-losses — aggressive ≠ reckless`,
};

// ============================================================================
// Character Builder
// ============================================================================

/**
 * Build a complete ElizaOS Character configuration from a NovaVerse template
 * and user customisation options.
 */
export function buildCharacter(config: AgentCharacterConfig): GeneratedCharacter {
  const template = TEMPLATE_PERSONAS[config.templateId];
  if (!template) {
    throw new Error(`Unknown template: ${config.templateId}`);
  }

  const username = config.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);

  // Build system prompt
  let system = template.systemCore;
  system += '\n' + RISK_SYSTEM_ADDITIONS[config.riskLevel];

  if (config.walletAddress) {
    system += `\n\nWallet Configuration:
- Chain: ${config.walletChain || 'solana'}
- Address: ${config.walletAddress}
- All on-chain actions must use this wallet`;
  }

  if (config.customSystemPrompt) {
    system += `\n\nOperator Custom Instructions:\n${config.customSystemPrompt}`;
  }

  // Skills — loaded from agent_skills table at runtime
  const skills = [...template.skills];

  // If user specified additional skills, merge them
  if (config.enabledSkills?.length) {
    for (const s of config.enabledSkills) {
      if (!skills.includes(s)) skills.push(s);
    }
  }

  // Model provider config
  const settings: Record<string, any> = {
    model: config.modelId || 'anthropic/claude-3.5-sonnet',
    riskLevel: config.riskLevel,
    capabilities: template.capabilities,
    templateId: config.templateId,
  };

  if (config.walletAddress) {
    settings.wallet = {
      chain: config.walletChain || 'solana',
      address: config.walletAddress,
    };
  }

  // Message examples based on capabilities
  const messageExamples = buildExamplesForCapabilities(template.capabilities, config.displayName);

  return {
    name: config.displayName,
    username,
    bio: config.customBio || template.bio,
    system,
    skills,
    settings,
    style: template.style,
    messageExamples,
  };
}

/**
 * Serialize a GeneratedCharacter into JSON suitable for:
 * - Saving to kv_store as the agent's character config
 * - Passing to ElizaOS runtime
 * - Exporting as a character.json file
 */
export function serializeCharacter(character: GeneratedCharacter): string {
  return JSON.stringify(character, null, 2);
}

// ============================================================================
// Example Messages per Capability
// ============================================================================

function buildExamplesForCapabilities(capabilities: string[], agentName: string) {
  const examples: Array<Array<{ name: string; content: { text: string } }>> = [];

  if (capabilities.includes('trading')) {
    examples.push([
      { name: 'user', content: { text: 'What trades are you considering?' } },
      { name: agentName, content: { text: 'Currently evaluating 2 setups:\n\n1. SOL/USDC — Bullish reversal forming on 4H. Conviction: 7/10. Would enter $40 position with SL at -5%.\n2. ETH momentum play on Hyperliquid — waiting for funding rate to flip positive. Conviction: 6/10.\n\nBoth within your risk parameters. Shall I execute?' } },
    ]);
  }

  if (capabilities.includes('intel')) {
    examples.push([
      { name: 'user', content: { text: 'Any alpha signals today?' } },
      { name: agentName, content: { text: 'SIGNAL: 3 top KOLs rotating into AI narrative\n- @cobie mentioned $RENDER accumulation (8/10 conviction)\n- Unusual volume spike on $TAO — +340% vs 7d avg\n- Google Trends "AI crypto" up 85% this week\n\nNarrative strength: STRONG. Consider small scout position in top AI tokens.' } },
    ]);
  }

  if (capabilities.includes('lp')) {
    examples.push([
      { name: 'user', content: { text: 'How are my LP positions doing?' } },
      { name: agentName, content: { text: 'LP Summary:\n\n1. SOL/USDC (Orca) — Range: $145-$165, Fees: $12.40/24h, IL: -0.8%, Net APY: 34.2% ✅\n2. ETH/USDC (Krystal, Arb) — Range: $3200-$3600, Fees: $8.20/24h, IL: -2.1%, Net APY: 22.8% ✅\n\nBoth in range. SOL position outperforming. No rebalance needed yet.' } },
    ]);
  }

  if (capabilities.includes('safety')) {
    examples.push([
      { name: 'user', content: { text: 'Any security alerts?' } },
      { name: agentName, content: { text: 'All clear on active positions. Latest scans:\n\n- SOL: RugCheck SAFE ✅ (97/100)\n- Kamino vaults: No unusual withdrawals ✅\n- LP pools: Normal trading volume, no manipulation detected ✅\n\nNext full scan in 4 minutes.' } },
    ]);
  }

  // Always include a general greeting
  examples.push([
    { name: 'user', content: { text: 'Status?' } },
    { name: agentName, content: { text: 'Agent operational. All systems nominal.\n\nI\'m monitoring your positions and will alert you on any significant changes. What would you like to review?' } },
  ]);

  return examples;
}
