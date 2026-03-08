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

const ROLE_DESCRIPTIONS: Record<string, string> = {
  'nova-cfo': 'Manages DeFi portfolio — LP positions, swaps, hedging, yield farming across Solana, EVM, Hyperliquid, Polymarket',
  'nova-scout': 'KOL monitoring, trend detection, alpha discovery from social feeds (Twitter/X, Telegram)',
  'nova-analyst': 'Deep market research, sentiment analysis, on-chain data interpretation',
  'nova-launcher': 'Token launches, bonding curves, graduation strategies',
  'nova-community': 'Telegram community engagement, Q&A, moderation, sticker responses',
  'nova-guardian': 'Security monitoring, rug detection, wallet safety, contract auditing',
  'nova-supervisor': 'Swarm orchestration, briefings, narrative generation, cross-agent coordination',
};

/** GitHub repos to scan for skills */
const SKILL_SOURCES = [
  { type: 'repo' as const, owner: 'elizaos', repo: 'skills' },
  { type: 'topic' as const, query: 'agent-skills elizaos' },
  { type: 'topic' as const, query: 'eliza-plugin defi' },
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
    for (const candidate of novel.slice(0, 10)) { // cap at 10 per run
      const result = await this.evaluateCandidate(candidate);
      if (result) evaluated.push(result);
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

        // Try to read a skill manifest or README
        const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${item.path}/README.md`, {
          headers: this.githubHeaders(),
        });

        let content = '';
        let description = item.name;
        if (readmeRes.ok) {
          const readmeData: { content: string; encoding: string } = await readmeRes.json();
          content = Buffer.from(readmeData.content, 'base64').toString('utf-8');
          description = content.split('\n')[0]?.replace(/^#+\s*/, '') || item.name;
        }

        candidates.push({
          skillId: `gh-${owner}-${item.name}`.toLowerCase(),
          name: item.name,
          description,
          content,
          sourceUrl: `https://github.com/${owner}/${repo}/tree/main/${item.path}`,
        });
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
        `SELECT skill_id FROM agent_skills
         UNION
         SELECT skill_id FROM skill_discovery_queue`,
      );
      const known = new Set(res.rows.map(r => r.skill_id));
      return candidates.filter(c => !known.has(c.skillId));
    } catch {
      return candidates; // if query fails, don't filter
    }
  }

  // ── Claude evaluation ───────────────────────────────────────

  private async evaluateCandidate(candidate: SkillCandidate): Promise<EvaluatedSkill | null> {
    try {
      const roleList = AGENT_ROLES.map(r =>
        `- ${r}: ${ROLE_DESCRIPTIONS[r]}`,
      ).join('\n');

      const prompt = `You are evaluating a potential skill/plugin for a multi-agent AI system (NovaOS).

Candidate skill:
- Name: ${candidate.name}
- Description: ${candidate.description}
- Source: ${candidate.sourceUrl}
- Content preview: ${candidate.content.slice(0, 2000)}

Available agent roles:
${roleList}

Evaluate whether this skill would be useful for any of these agents.
Respond ONLY with valid JSON (no markdown, no code fences):
{
  "relevant": true/false,
  "matchedRoles": ["role1", "role2"],
  "reasoning": "brief explanation",
  "suggestedSkillContent": "a 2-3 paragraph skill instruction that the matched agent(s) should follow when this domain comes up"
}

Be selective — only mark as relevant if it genuinely adds domain expertise an agent lacks. Reject generic/vague skills.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        logger.warn(`[SkillDiscovery] Claude API error: ${res.status}`);
        return null;
      }

      const data: { content: Array<{ text: string }> } = await res.json();
      const text = data.content[0]?.text || '';

      // Parse JSON response
      const parsed = JSON.parse(text);
      if (!parsed.relevant || !parsed.matchedRoles?.length) return null;

      return {
        skillId: candidate.skillId,
        name: candidate.name,
        description: candidate.description,
        content: parsed.suggestedSkillContent || candidate.content,
        sourceUrl: candidate.sourceUrl,
        matchedRoles: parsed.matchedRoles,
        reasoning: parsed.reasoning,
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
