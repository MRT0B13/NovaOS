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
import { getSkillsService } from './skillsService.ts';

// ============================================================================
// Constants
// ============================================================================

const AGENT_ROLES = [
  'nova-cfo',
  'nova-scout',
  'nova-analyst',
  'nova-launcher',
  'nova-community',
  'nova-guardian',
  'nova-supervisor',
] as const;

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
const SKILL_SOURCES = [
  { type: 'repo' as const, owner: 'anthropics', repo: 'skills' },
  { type: 'repo' as const, owner: 'elizaos', repo: 'skills' },
  { type: 'topic' as const, query: 'agent-skills defi' },
  { type: 'topic' as const, query: 'agent-skills elizaos' },
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
  }

  /** Should be called from the supervisor's briefing cadence. Self-throttles. */
  async maybeRun(): Promise<string | null> {
    const now = Date.now();
    if (now - this.lastRunAt < RUN_INTERVAL_MS) return null;
    if (this.running) return null;
    if (!this.anthropicApiKey) {
      logger.warn('[SkillDiscovery] No ANTHROPIC_API_KEY set — skipping discovery');
      return null;
    }

    this.running = true;
    this.lastRunAt = now;

    try {
      return await this.runDiscoveryCycle();
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
    for (const candidate of novel.slice(0, 20)) { // cap at 20 per run
      const result = await this.evaluateCandidate(candidate);
      if (result) evaluated.push(result);
      await new Promise(r => setTimeout(r, 500)); // rate limit between evaluations
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

    // 5. Build admin report
    const report = this.buildReport(evaluated, candidates.length);
    logger.info(`[SkillDiscovery] Queued ${queued} proposals`);

    return report;
  }

  // ── Source fetching ─────────────────────────────────────────

  private async fetchCandidates(): Promise<SkillCandidate[]> {
    const all: SkillCandidate[] = [];

    for (const source of SKILL_SOURCES) {
      try {
        if (source.type === 'repo') {
          const items = await this.fetchFromRepo(source.owner, source.repo);
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

  private async fetchFromRepo(owner: string, repo: string): Promise<SkillCandidate[]> {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, {
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
         SELECT source_url FROM agent_skills WHERE source_url IS NOT NULL`,
      );
      const knownUrls = new Set(res.rows.map(r => r.source_url).filter(Boolean));
      return candidates.filter(c => !knownUrls.has(c.sourceUrl));
    } catch {
      return candidates; // if query fails, don't filter
    }
  }

  // ── Claude evaluation ───────────────────────────────────────

  private async evaluateCandidate(candidate: SkillCandidate): Promise<EvaluatedSkill | null> {
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
        logger.warn(`[SkillDiscovery] Claude API error: ${res.status}`);
        return null;
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

      if (maxRelevance < 0.70 || relevantRoles.length === 0) return null;

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
      return null;
    }
  }

  // ── Proposal queuing ────────────────────────────────────────

  private async queueProposal(ev: EvaluatedSkill): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO skill_discovery_queue
           (skill_id, name, description, content, source_url, proposed_agent_roles, relevance_reasoning, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (skill_id) DO NOTHING`,
        [
          ev.skillId, ev.name, ev.description, ev.content,
          ev.sourceUrl, ev.matchedRoles, ev.reasoning,
        ],
      );
    } catch (err) {
      logger.warn(`[SkillDiscovery] Failed to queue proposal ${ev.skillId}:`, err);
    }
  }

  // ── Reporting ───────────────────────────────────────────────

  private buildReport(evaluated: EvaluatedSkill[], totalCandidates: number): string {
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
      lines.push(`   <code>/skill approve ${ev.skillId}</code>`);
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
  return discoveryService;
}

export function getSkillDiscoveryService(): SkillDiscoveryService | null {
  return discoveryService;
}
