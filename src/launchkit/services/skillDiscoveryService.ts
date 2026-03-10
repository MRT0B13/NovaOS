/**
 * SkillDiscoveryService — Nova's autonomous skill scouting engine
 *
 * Periodically searches GitHub repos / topics for agent skill modules,
 * evaluates relevance via Claude Haiku, and queues proposals for admin review.
 *
 * Runs once per day, triggered from the Supervisor's briefing cycle.
 */

import type { Pool } from 'pg';
import { logger } from '@elizaos/core';

// ============================================================================
// Constants
// ============================================================================

const AGENT_PROFILES: Record<string, string> = {
  'nova-cfo': `Financial operator managing a live DeFi portfolio. Responsibilities:
    - Hyperliquid perpetuals trading (long/short, stop-loss, hedging, leverage up to 3x)
    - Polymarket prediction markets (Kelly criterion sizing, probability estimation, edge detection)
    - Kamino Finance: lending/borrowing, USDC deposits, JitoSOL loop strategies, LTV management
    - Jito liquid staking (SOL → JitoSOL, MEV rewards, compounding)
    - Orca LP on Solana (concentrated liquidity, range management, fee collection, rebalancing)
    - Krystal LP on EVM chains (Uniswap V3, PancakeSwap V3, Aerodrome CL, multi-chain)
    - Wormhole cross-chain bridging
    - x402 micropayment monetization
    - Risk management: position limits, exposure caps, approval tiers, emergency exits`,

  'nova-scout': `Intelligence gathering agent. Responsibilities:
    - Scanning KOL (Key Opinion Leader) Twitter/X accounts for crypto signals
    - Detecting emerging narratives and trend shifts in crypto/DeFi
    - Cross-referencing signals across multiple sources
    - Scoring and filtering intel for relevance and signal quality
    - Forwarding actionable intel to CFO and Supervisor`,

  'nova-analyst': `Token analysis agent. Responsibilities:
    - RugCheck safety scoring for Solana tokens
    - Evaluating pump.fun token launches for quality
    - On-chain analysis: liquidity, holder distribution, contract safety
    - Scoring new tokens for the community voting system`,

  'nova-launcher': `Token launch agent on pump.fun (Solana). Responsibilities:
    - Generating meme token ideas from trending narratives
    - Managing launch parameters (slippage, priority fees)
    - Monitoring token graduations to PumpSwap
    - Community voting integration before launches`,

  'nova-community': `Community management agent for Telegram. Responsibilities:
    - Responding to community questions about Nova's activities
    - Managing the token voting system
    - Posting relevant updates to the community group
    - Engagement and retention`,

  'nova-guardian': `Security monitoring agent. Responsibilities:
    - Monitoring wallet balances for drains
    - DexScreener liquidity monitoring for watched tokens
    - Content filtering for outgoing posts
    - Network threat detection
    - Agent behaviour anomaly detection`,

  'nova-supervisor': `Swarm orchestrator. Responsibilities:
    - Routing messages between all agents
    - Intel pipeline from Scout/Guardian → CFO
    - Social posting coordination
    - Daily briefings (admin + community)
    - Approval routing for CFO decisions`,
};

/** GitHub repos to scan for skills */
const SKILL_SOURCES: Array<
  | { type: 'repo'; owner: string; repo: string; path?: string }
  | { type: 'topic'; query: string }
> = [
  // ── Curated skill registries ────────────────────────────────
  { type: 'repo', owner: 'anthropics', repo: 'skills', path: 'skills' },
  { type: 'repo', owner: 'elizaos', repo: 'skills' },

  // ── DeFi protocol SDKs & examples ──────────────────────────
  { type: 'repo', owner: 'orca-so', repo: 'whirlpools' },            // Orca concentrated-liquidity SDK
  { type: 'repo', owner: 'hubbleprotocol', repo: 'kamino-sdk' },     // Kamino lending/vault SDK
  { type: 'repo', owner: 'jito-foundation', repo: 'jito-solana' },   // Jito MEV/tips integration
  { type: 'repo', owner: 'drift-labs', repo: 'protocol-v2' },        // Drift perpetuals protocol
  { type: 'repo', owner: 'marinade-finance', repo: 'liquid-staking-program' }, // Marinade staking
  { type: 'repo', owner: 'raydium-io', repo: 'raydium-sdk-V2' },     // Raydium AMM SDK
  { type: 'repo', owner: 'Jupiter-Aggregator', repo: 'jupiter-quote-api-node' }, // Jupiter aggregator
  { type: 'repo', owner: 'hyperliquid-dex', repo: 'hyperliquid-python-sdk' },   // Hyperliquid perps

  // ── Security & audit tools ─────────────────────────────────
  { type: 'repo', owner: 'crytic', repo: 'slither' },                // Smart contract analysis
  { type: 'repo', owner: 'AuditWizard', repo: 'audit-templates' },   // Audit checklists
  { type: 'repo', owner: 'AuditWizard', repo: 'resources' },         // Security resources
  { type: 'repo', owner: 'nicholasgasior', repo: 'solana-security-txt' }, // Solana security.txt

  // ── AI agent & MCP frameworks ──────────────────────────────
  { type: 'repo', owner: 'modelcontextprotocol', repo: 'servers' },   // MCP tool servers
  { type: 'repo', owner: 'langchain-ai', repo: 'langchain' },         // LangChain tools & chains
  { type: 'repo', owner: 'langchain-ai', repo: 'langgraph' },         // LangGraph agent patterns
  { type: 'repo', owner: 'BerriAI', repo: 'litellm' },               // LiteLLM multi-provider routing

  // ── Solana ecosystem tooling ───────────────────────────────
  { type: 'repo', owner: 'solana-developers', repo: 'program-examples' }, // Solana program patterns
  { type: 'repo', owner: 'coral-xyz', repo: 'anchor', path: 'examples' }, // Anchor framework examples
  { type: 'repo', owner: 'helius-labs', repo: 'helius-sdk' },         // Helius RPC/webhooks SDK
  { type: 'repo', owner: 'metaplex-foundation', repo: 'mpl-token-metadata' }, // Token metadata standard

  // ── Trading & market data ──────────────────────────────────
  { type: 'repo', owner: 'ccxt', repo: 'ccxt' },                     // Unified exchange API
  { type: 'repo', owner: 'birdeye-so', repo: 'birdeye-api-docs' },   // Birdeye analytics
  { type: 'repo', owner: 'dexscreener', repo: 'examples' },          // DexScreener API examples

  // ── On-chain analytics & indexing ──────────────────────────
  { type: 'repo', owner: 'streamflow-finance', repo: 'js-sdk' },     // Vesting/payroll SDK
  { type: 'repo', owner: 'switchboard-xyz', repo: 'switchboard-v2' }, // Oracle feeds
  { type: 'repo', owner: 'pyth-network', repo: 'pyth-sdk-solidity' }, // Pyth price feeds

  // ── Topic-based discovery ──────────────────────────────────
  { type: 'topic', query: 'topic:agent-skills+topic:defi' },
  { type: 'topic', query: 'topic:agent-skills+topic:elizaos' },
  { type: 'topic', query: 'topic:solana+topic:defi+topic:sdk' },
  { type: 'topic', query: 'topic:mev+topic:solana' },
  { type: 'topic', query: 'topic:crypto-trading+topic:bot' },
  { type: 'topic', query: 'topic:smart-contract-security+topic:solana' },
  { type: 'topic', query: 'topic:sentiment-analysis+topic:crypto' },
  { type: 'topic', query: 'topic:pump-fun+topic:solana' },
  { type: 'topic', query: 'topic:mcp+topic:tools' },
  { type: 'topic', query: 'topic:llm-agents+topic:trading' },
];

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Service
// ============================================================================

export class SkillDiscoveryService {
  private pool: Pool;
  private lastRunAt = 0;
  private running = false;
  private anthropicApiKey: string | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
    // Restore last run timestamp from DB so we don't re-run on every restart
    this.restoreLastRunAt();
  }

  private async restoreLastRunAt(): Promise<void> {
    try {
      const res = await this.pool.query(
        `SELECT data FROM kv_store WHERE key = 'skill_discovery_last_run' LIMIT 1`,
      );
      if (res.rows.length > 0) {
        this.lastRunAt = Number(res.rows[0].data?.ts) || 0;
        const agoH = ((Date.now() - this.lastRunAt) / 3_600_000).toFixed(1);
        logger.info(`[SkillDiscovery] Restored lastRunAt from DB (${agoH}h ago)`);
      }
    } catch { /* table may not exist yet */ }
  }

  private async persistLastRunAt(): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO kv_store (key, data) VALUES ('skill_discovery_last_run', $1)
         ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = NOW()`,
        [JSON.stringify({ ts: this.lastRunAt })],
      );
    } catch { /* non-fatal */ }
  }

  /** Should be called from the supervisor's briefing cadence. Self-throttles. */
  async maybeRun(): Promise<string | null> {
    const now = Date.now();
    const sinceLast = now - this.lastRunAt;
    if (sinceLast < RUN_INTERVAL_MS) {
      const nextInH = ((RUN_INTERVAL_MS - sinceLast) / 3_600_000).toFixed(1);
      logger.info(`[SkillDiscovery] Throttled — next run in ${nextInH}h`);
      return null;
    }
    if (this.running) {
      logger.info('[SkillDiscovery] Skipped — previous cycle still running');
      return null;
    }
    if (!this.anthropicApiKey) {
      logger.warn('[SkillDiscovery] No ANTHROPIC_API_KEY set — skipping discovery');
      return null;
    }

    this.running = true;
    this.lastRunAt = now;
    await this.persistLastRunAt();

    try {
      const t0 = Date.now();
      const result = await this.runDiscoveryCycle();
      logger.info(`[SkillDiscovery] ✅ Discovery cycle completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      logger.error('[SkillDiscovery] Discovery cycle failed:', err);
      return null;
    } finally {
      this.running = false;
    }
  }

  // ── Core discovery loop ─────────────────────────────────────

  private async runDiscoveryCycle(): Promise<string> {
    logger.info('[SkillDiscovery] Starting discovery cycle');

    // 1. Fetch candidates from all sources
    const candidates = await this.fetchCandidates();
    if (candidates.length === 0) {
      return '🔍 No new skill candidates found';
    }
    logger.info(`[SkillDiscovery] Found ${candidates.length} candidates`);

    // 2. Filter out already known skills
    const novel = await this.filterKnown(candidates);
    if (novel.length === 0) {
      return `🔍 Found ${candidates.length} candidates but all already known`;
    }
    logger.info(`[SkillDiscovery] ${novel.length} novel candidates after filtering`);

    // 3. Evaluate each with Claude
    const evaluated: EvaluatedSkill[] = [];
    let consecutiveApiErrors = 0;
    let lowRelevanceCount = 0;
    let pooledCount = 0;
    for (const candidate of novel.slice(0, 20)) { // cap at 20 per run
      const result = await this.evaluateCandidate(candidate);
      if (result === 'api-error') {
        consecutiveApiErrors++;
        if (consecutiveApiErrors >= 3) {
          logger.warn(`[SkillDiscovery] 3 consecutive API errors — stopping early`);
          break;
        }
      } else if (result === null) {
        // Low relevance — not an error
        lowRelevanceCount++;
        consecutiveApiErrors = 0;
      } else if (result === 'pooled') {
        // Below threshold but stored in skill pool for factory suggestions
        pooledCount++;
        consecutiveApiErrors = 0;
      } else {
        evaluated.push(result);
        consecutiveApiErrors = 0;
      }
      await new Promise(r => setTimeout(r, 500)); // rate limit between evaluations
    }
    if (lowRelevanceCount > 0) {
      logger.info(`[SkillDiscovery] ${lowRelevanceCount} candidates scored below relevance threshold (0.70)`);
    }
    if (pooledCount > 0) {
      logger.info(`[SkillDiscovery] ${pooledCount} candidates added to skill pool (below agent threshold, available for factory)`);
    }

    if (evaluated.length === 0) {
      return `🔍 Evaluated ${novel.length} candidates — none relevant`;
    }

    // 4. Queue approved proposals
    let queued = 0;
    for (const ev of evaluated) {
      await this.queueProposal(ev);
      queued++;
    }

    // 5. Build admin report (with queue IDs for approve/reject commands)
    const report = await this.buildReport(evaluated, candidates.length);
    logger.info(`[SkillDiscovery] Queued ${queued} proposals`);

    return report;
  }

  // ── Source fetching ─────────────────────────────────────────

  private async fetchCandidates(): Promise<SkillCandidate[]> {
    const all: SkillCandidate[] = [];

    for (const source of SKILL_SOURCES) {
      try {
        if (source.type === 'repo') {
          const items = await this.fetchFromRepo(source.owner, source.repo, source.path);
          all.push(...items);
        } else {
          const items = await this.fetchFromTopic(source.query);
          all.push(...items);
        }
      } catch (err) {
        logger.warn(`[SkillDiscovery] Failed to fetch source ${JSON.stringify(source)}:`, err);
      }
    }

    return all;
  }

  private async fetchFromRepo(owner: string, repo: string, path?: string): Promise<SkillCandidate[]> {
    try {
      const contentsPath = path ? `contents/${path}` : 'contents';
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/${contentsPath}`, {
        headers: this.githubHeaders(),
      });
      if (!res.ok) return [];

      const items: Array<{ name: string; path: string; download_url: string; type: string }> = await res.json();
      const candidates: SkillCandidate[] = [];

      for (const item of items) {
        if (item.type !== 'dir') continue;

        // Try to read a SKILL.md or README.md
        let content = '';
        let description = item.name;

        // Prefer SKILL.md (Anthropic convention)
        try {
          const skillMdRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${item.path}/SKILL.md`, {
            headers: this.githubHeaders(),
          });
          if (skillMdRes.ok) {
            content = await skillMdRes.text();
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            description = nameMatch?.[1]?.trim() || descMatch?.[1]?.trim() || item.name;
          }
        } catch { /* fall through to README */ }

        // Fallback to README.md
        if (!content) {
          try {
            const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${item.path}/README.md`, {
              headers: this.githubHeaders(),
            });
            if (readmeRes.ok) {
              const readmeData: { content: string; encoding: string } = await readmeRes.json();
              content = Buffer.from(readmeData.content, 'base64').toString('utf-8');
              description = content.split('\n')[0]?.replace(/^#+\s*/, '') || item.name;
            }
          } catch { /* no readme either */ }
        }

        if (item.name === 'template-skill') continue;

        candidates.push({
          skillId: `gh-${owner}-${item.name}`.toLowerCase(),
          name: item.name,
          description,
          content,
          sourceUrl: `https://github.com/${owner}/${repo}/tree/main/${item.path}`,
        });

        await new Promise(r => setTimeout(r, 300)); // rate limit
      }

      return candidates;
    } catch {
      return [];
    }
  }

  private async fetchFromTopic(query: string): Promise<SkillCandidate[]> {
    try {
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`, {
        headers: this.githubHeaders(),
      });
      if (!res.ok) return [];

      const data: { items: Array<{ full_name: string; name: string; description: string; html_url: string }> } = await res.json();

      // Try to find SKILL.md files inside discovered repos (deeper scan)
      const deepCandidates = await this.fetchGitHubTopicSkillFiles(data.items);
      if (deepCandidates.length > 0) return deepCandidates;

      // Fallback: return repo-level candidates
      return data.items.map(repo => ({
        skillId: `gh-${repo.full_name.replace('/', '-')}`.toLowerCase(),
        name: repo.name,
        description: repo.description || repo.name,
        content: repo.description || '',
        sourceUrl: repo.html_url,
      }));
    } catch {
      return [];
    }
  }

  private async fetchGitHubTopicSkillFiles(repos: Array<{ full_name: string; html_url: string; description: string }>): Promise<SkillCandidate[]> {
    const candidates: SkillCandidate[] = [];

    for (const repo of repos.slice(0, 5)) {
      try {
        const treeRes = await fetch(
          `https://api.github.com/repos/${repo.full_name}/git/trees/HEAD?recursive=1`,
          { headers: this.githubHeaders() },
        );
        if (!treeRes.ok) continue;

        const tree: { tree: Array<{ path: string }> } = await treeRes.json();
        const skillFiles = tree.tree
          .filter(f => f.path.endsWith('SKILL.md'))
          .slice(0, 3); // max 3 per repo

        for (const file of skillFiles) {
          const rawRes = await fetch(
            `https://raw.githubusercontent.com/${repo.full_name}/HEAD/${file.path}`,
            { headers: this.githubHeaders() },
          );
          if (!rawRes.ok) continue;
          const content = await rawRes.text();

          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          const skillName = nameMatch?.[1]?.trim() || file.path.split('/').slice(-2, -1)[0];

          candidates.push({
            skillId: `community-${repo.full_name.replace('/', '-')}-${skillName}`.toLowerCase().slice(0, 80),
            name: skillName,
            description: descMatch?.[1]?.trim() || repo.description || `Community skill from ${repo.full_name}`,
            content,
            sourceUrl: `${repo.html_url}/blob/HEAD/${file.path}`,
          });

          await new Promise(r => setTimeout(r, 300)); // rate limit
        }
      } catch { /* skip this repo */ }
    }

    return candidates;
  }

  private githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'NovaOS-SkillDiscovery',
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    return headers;
  }

  // ── Filtering ───────────────────────────────────────────────

  private async filterKnown(candidates: SkillCandidate[]): Promise<SkillCandidate[]> {
    try {
      const res = await this.pool.query(
        `SELECT source_url FROM skill_discovery_queue
         UNION
         SELECT source_url FROM agent_skills WHERE source_url IS NOT NULL
         UNION
         SELECT source_url FROM skill_pool`,
      );
      const knownUrls = new Set(res.rows.map(r => r.source_url).filter(Boolean));
      return candidates.filter(c => !knownUrls.has(c.sourceUrl));
    } catch {
      return candidates; // if query fails, don't filter
    }
  }

  // ── Claude evaluation ───────────────────────────────────────

  private async evaluateCandidate(candidate: SkillCandidate): Promise<EvaluatedSkill | null | 'api-error' | 'pooled'> {
    try {
      const profileList = Object.entries(AGENT_PROFILES).map(([role, profile]) =>
        `${role}:\n${profile}`,
      ).join('\n\n');

      const prompt = `You are evaluating whether an AI agent skill is relevant and useful for a specific set of autonomous agents running in a DeFi/crypto system called NovaOS.

SKILL TO EVALUATE:
Name: ${candidate.name}
Description: ${candidate.description}
Source: ${candidate.sourceUrl}
Content (first 2000 chars):
${candidate.content.slice(0, 2000)}

AGENT PROFILES:
${profileList}

For each agent role, score the skill's relevance from 0.0 to 1.0:
- 0.0 = completely irrelevant
- 0.5 = possibly useful but not specific
- 0.7 = clearly useful and relevant to this agent's work
- 0.9 = highly relevant, directly improves a key capability
- 1.0 = perfect fit, Nova should have this immediately

Also write a brief (2-3 sentence) explanation of why this skill is or isn't useful.

Respond ONLY with JSON in this exact format:
{
  "scores": {
    "nova-cfo": 0.0,
    "nova-scout": 0.0,
    "nova-analyst": 0.0,
    "nova-launcher": 0.0,
    "nova-community": 0.0,
    "nova-guardian": 0.0,
    "nova-supervisor": 0.0
  },
  "reasoning": "Brief explanation of overall relevance and most useful agent matches"
}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.warn(`[SkillDiscovery] Claude API error: ${res.status} — ${errBody.slice(0, 200)}`);
        return 'api-error' as const;
      }

      const data: { content: Array<{ text: string }> } = await res.json();
      const text = data.content[0]?.text || '';

      // Parse JSON response (handle potential markdown fencing)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const scores: Record<string, number> = parsed.scores || {};
      const maxRelevance = Math.max(...Object.values(scores).map(s => Number(s) || 0));
      const relevantRoles = Object.entries(scores)
        .filter(([, score]) => Number(score) >= 0.70)
        .map(([role]) => role);

      if (maxRelevance < 0.70 || relevantRoles.length === 0) {
        // Below threshold for existing agents — store in skill pool for factory suggestions
        if (maxRelevance >= 0.20) {
          await this.addToSkillPool(candidate, scores, maxRelevance, parsed.reasoning || '');
          return 'pooled' as const;
        }
        return null; // truly irrelevant (< 0.20) — discard
      }

      return {
        skillId: candidate.skillId,
        name: candidate.name,
        description: candidate.description,
        content: candidate.content,
        sourceUrl: candidate.sourceUrl,
        matchedRoles: relevantRoles,
        reasoning: parsed.reasoning || '',
        maxRelevance,
      };
    } catch (err) {
      logger.warn(`[SkillDiscovery] Evaluation failed for ${candidate.name}:`, err);
      return 'api-error' as const;
    }
  }

  // ── Proposal queuing ────────────────────────────────────────

  private async queueProposal(ev: EvaluatedSkill): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO skill_discovery_queue
           (skill_id, name, description, content, source_url, proposed_agent_roles, relevance_reasoning, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [
          ev.skillId, ev.name, ev.description, ev.content,
          ev.sourceUrl, ev.matchedRoles, ev.reasoning,
        ],
      );
    } catch (err) {
      logger.warn(`[SkillDiscovery] Failed to queue proposal ${ev.skillId}:`, err);
    }
  }

  // ── Skill Pool (low-relevance skills for factory agents) ──────

  /**
   * Map relevance scores to factory capability types.
   * Uses keyword analysis of the skill name/description to suggest which
   * factory capabilities this skill could enhance.
   */
  private inferCapabilities(candidate: SkillCandidate, scores: Record<string, number>): string[] {
    const text = `${candidate.name} ${candidate.description}`.toLowerCase();
    const caps: string[] = [];

    const capKeywords: Record<string, string[]> = {
      whale_tracking: ['whale', 'wallet', 'transfer', 'flow', 'exchange'],
      token_monitoring: ['token', 'price', 'volume', 'dex', 'chart', 'holder'],
      kol_scanning: ['kol', 'twitter', 'influencer', 'social', 'x.com'],
      safety_scanning: ['rug', 'safety', 'audit', 'scam', 'honeypot', 'security'],
      narrative_tracking: ['narrative', 'sentiment', 'trend', 'alpha', 'meta'],
      social_trending: ['reddit', 'meme', 'viral', 'trend', 'buzz', 'pop culture'],
      yield_monitoring: ['yield', 'apy', 'apr', 'farming', 'staking', 'liquidity', 'lp', 'defi'],
      arb_scanning: ['arb', 'arbitrage', 'flash', 'mev', 'spread', 'cross-dex'],
      portfolio_monitoring: ['portfolio', 'pnl', 'drawdown', 'risk', 'position', 'balance'],
    };

    for (const [cap, keywords] of Object.entries(capKeywords)) {
      if (keywords.some(kw => text.includes(kw))) {
        caps.push(cap);
      }
    }

    // Also map from high agent role scores
    const roleCapMap: Record<string, string[]> = {
      'nova-cfo': ['yield_monitoring', 'portfolio_monitoring', 'arb_scanning'],
      'nova-scout': ['kol_scanning', 'narrative_tracking', 'social_trending'],
      'nova-analyst': ['token_monitoring', 'narrative_tracking', 'portfolio_monitoring'],
      'nova-guardian': ['safety_scanning', 'whale_tracking'],
      'nova-launcher': ['token_monitoring', 'social_trending'],
      'nova-community': ['social_trending', 'narrative_tracking'],
      'nova-supervisor': [],
    };

    for (const [role, score] of Object.entries(scores)) {
      if (Number(score) >= 0.40) {
        const roleCaps = roleCapMap[role] || [];
        for (const c of roleCaps) {
          if (!caps.includes(c)) caps.push(c);
        }
      }
    }

    return caps.length > 0 ? caps : ['token_monitoring']; // fallback
  }

  private async addToSkillPool(
    candidate: SkillCandidate,
    scores: Record<string, number>,
    maxRelevance: number,
    reasoning: string,
  ): Promise<void> {
    try {
      const capabilities = this.inferCapabilities(candidate, scores);
      await this.pool.query(
        `INSERT INTO skill_pool
           (skill_id, name, description, content, source_url, relevance_scores, max_relevance, suggested_capabilities, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (skill_id) DO UPDATE SET
           relevance_scores = $6,
           max_relevance = $7,
           suggested_capabilities = $8,
           reasoning = $9`,
        [
          candidate.skillId, candidate.name, candidate.description,
          candidate.content, candidate.sourceUrl,
          JSON.stringify(scores), maxRelevance,
          capabilities, reasoning,
        ],
      );
      logger.debug(`[SkillDiscovery] Added to skill pool: ${candidate.name} (relevance: ${(maxRelevance * 100).toFixed(0)}%, caps: ${capabilities.join(', ')})`);
    } catch (err) {
      logger.warn(`[SkillDiscovery] Failed to add to skill pool: ${candidate.name}`, err);
    }
  }

  // ── Reporting ───────────────────────────────────────────────

  private async buildReport(evaluated: EvaluatedSkill[], totalCandidates: number): Promise<string> {
    const lines = [
      `🔍 <b>Skill Discovery Report</b>`,
      ``,
      `Scanned: ${totalCandidates} candidates`,
      `Relevant: ${evaluated.length}`,
      ``,
    ];

    for (const ev of evaluated) {
      lines.push(`📦 <b>${ev.name}</b>`);
      lines.push(`   Roles: ${ev.matchedRoles.join(', ')}`);
      lines.push(`   Score: ${Math.round(ev.maxRelevance * 100)}%`);
      lines.push(`   ${ev.reasoning}`);

      // Look up queue ID for approve/reject commands
      try {
        const qRes = await this.pool.query(
          'SELECT id FROM skill_discovery_queue WHERE skill_id = $1 ORDER BY created_at DESC LIMIT 1',
          [ev.skillId],
        );
        const queueId = qRes.rows[0]?.id;
        if (queueId) {
          lines.push(`   <code>/skill approve ${queueId}</code> | <code>/skill reject ${queueId}</code>`);
        }
      } catch { /* skip command if query fails */ }
      lines.push('');
    }

    lines.push('Use /skill pending to see all pending skills');
    return lines.join('\n');
  }
}

// ============================================================================
// Types
// ============================================================================

interface SkillCandidate {
  skillId: string;
  name: string;
  description: string;
  content: string;
  sourceUrl: string;
}

interface EvaluatedSkill {
  skillId: string;
  name: string;
  description: string;
  content: string;
  sourceUrl: string;
  matchedRoles: string[];
  reasoning: string;
  maxRelevance: number;
}

// ============================================================================
// Singleton
// ============================================================================

let discoveryService: SkillDiscoveryService | null = null;

export function initSkillDiscoveryService(pool: Pool): SkillDiscoveryService {
  discoveryService = new SkillDiscoveryService(pool);
  logger.info('[SkillDiscovery] Service created — runs every 24h, triggered by supervisor briefing cycle');
  return discoveryService;
}

export function getSkillDiscoveryService(): SkillDiscoveryService | null {
  return discoveryService;
}
