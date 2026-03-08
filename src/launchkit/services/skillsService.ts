/**
 * SkillsService — loads, caches, and injects agent skills
 *
 * Each agent calls loadSkillsForAgent(agentRole) at the start of its decision cycle.
 * Returns compiled skill context string ready to prepend to agent system context.
 *
 * Skills are versioned, tagged by agent role, and can be pushed/updated without
 * code deploys. A 5-minute in-memory cache avoids unnecessary DB roundtrips.
 */

import type { Pool } from 'pg';
import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export interface AgentSkill {
  skillId: string;
  name: string;
  description: string;
  content: string;
  version: string;
  category: string;
}

export interface SkillListEntry {
  skillId: string;
  name: string;
  version: string;
  category: string;
  status: string;
  assignedTo: string[];
}

// ============================================================================
// In-memory cache
// ============================================================================

/** agentRole → { skills, loadedAt, versionHash } */
const skillCache = new Map<string, {
  skills: AgentSkill[];
  loadedAt: number;
  versionHash: string;
}>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Service
// ============================================================================

export class SkillsService {
  constructor(private pool: Pool) {}

  /**
   * Load skills for an agent role. Returns compiled context string.
   * Checks for version changes every 5 minutes.
   */
  async loadSkillsForAgent(agentRole: string): Promise<string> {
    const cached = skillCache.get(agentRole);
    const now = Date.now();

    if (cached && (now - cached.loadedAt) < CACHE_TTL_MS) {
      // Quick version-hash check against DB
      const changed = await this.hasSkillVersionChanged(agentRole, cached.versionHash);
      if (!changed) {
        return this.compileSkillContext(cached.skills);
      }
    }

    // Load fresh from DB
    const skills = await this.fetchSkillsFromDB(agentRole);
    if (skills.length === 0) return '';

    const versionHash = skills.map(s => `${s.skillId}@${s.version}`).join('|');
    skillCache.set(agentRole, { skills, loadedAt: now, versionHash });

    // Record what we loaded
    await this.recordSkillLoads(agentRole, skills);

    logger.info(`[SkillsService] Loaded ${skills.length} skills for ${agentRole}: ${skills.map(s => s.skillId).join(', ')}`);
    return this.compileSkillContext(skills);
  }

  // ── DB access ──────────────────────────────────────────────────

  private async fetchSkillsFromDB(agentRole: string): Promise<AgentSkill[]> {
    try {
      const res = await this.pool.query<AgentSkill>(
        `SELECT
           s.skill_id  AS "skillId",
           s.name,
           s.description,
           s.content,
           s.version,
           s.category
         FROM agent_skills s
         JOIN agent_skill_assignments a ON a.skill_id = s.skill_id
         WHERE a.agent_role = $1
           AND s.status = 'active'
         ORDER BY a.priority ASC`,
        [agentRole],
      );
      return res.rows;
    } catch (err) {
      logger.error(`[SkillsService] Failed to load skills for ${agentRole}:`, err);
      return [];
    }
  }

  private async hasSkillVersionChanged(agentRole: string, currentHash: string): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `SELECT string_agg(s.skill_id || '@' || s.version, '|' ORDER BY a.priority) AS hash
         FROM agent_skills s
         JOIN agent_skill_assignments a ON a.skill_id = s.skill_id
         WHERE a.agent_role = $1 AND s.status = 'active'`,
        [agentRole],
      );
      const dbHash = res.rows[0]?.hash || '';
      return dbHash !== currentHash;
    } catch {
      return false; // assume unchanged if query fails
    }
  }

  private async recordSkillLoads(agentRole: string, skills: AgentSkill[]): Promise<void> {
    try {
      for (const skill of skills) {
        await this.pool.query(
          `INSERT INTO agent_skill_loads (agent_role, skill_id, loaded_version, loaded_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (agent_role, skill_id) DO UPDATE
             SET loaded_version = $3, loaded_at = NOW()`,
          [agentRole, skill.skillId, skill.version],
        );
      }
    } catch { /* non-fatal */ }
  }

  // ── Context compilation ────────────────────────────────────────

  /**
   * Compile skill content into a context string for injection into agent prompts.
   */
  private compileSkillContext(skills: AgentSkill[]): string {
    if (skills.length === 0) return '';

    const parts = skills.map(skill =>
      `## Skill: ${skill.name}\n${skill.content}`,
    );

    return [
      '---',
      '# AGENT SKILLS — Domain expertise loaded for this session',
      '',
      ...parts,
      '',
      '---',
    ].join('\n\n');
  }

  // ── Admin operations ───────────────────────────────────────────

  /** Add or update a skill in the registry. */
  async upsertSkill(skill: Omit<AgentSkill, 'version'> & {
    version?: string;
    sourceUrl?: string;
    source?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_skills
         (skill_id, name, description, content, version, category, source, source_url, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW())
       ON CONFLICT (skill_id) DO UPDATE SET
         name = $2,
         description = $3,
         content = $4,
         version = $5,
         category = $6,
         source_url = $8,
         updated_at = NOW()`,
      [
        skill.skillId, skill.name, skill.description, skill.content,
        skill.version || '1.0.0', skill.category,
        skill.source || 'manual', skill.sourceUrl || null,
      ],
    );
    skillCache.clear(); // invalidate all cache
    logger.info(`[SkillsService] Upserted skill: ${skill.skillId}`);
  }

  /** Assign a skill to an agent role. */
  async assignSkill(agentRole: string, skillId: string, priority = 50): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_skill_assignments (agent_role, skill_id, priority)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_role, skill_id) DO UPDATE SET priority = $3`,
      [agentRole, skillId, priority],
    );
    skillCache.delete(agentRole);
    logger.info(`[SkillsService] Assigned skill ${skillId} to ${agentRole}`);
  }

  /** Unassign a skill from an agent role. */
  async unassignSkill(agentRole: string, skillId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM agent_skill_assignments WHERE agent_role = $1 AND skill_id = $2`,
      [agentRole, skillId],
    );
    skillCache.delete(agentRole);
    logger.info(`[SkillsService] Unassigned skill ${skillId} from ${agentRole}`);
  }

  /** Disable a skill (keeps it in DB but stops it from being loaded). */
  async disableSkill(skillId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_skills SET status = 'disabled', updated_at = NOW() WHERE skill_id = $1`,
      [skillId],
    );
    skillCache.clear();
    logger.info(`[SkillsService] Disabled skill: ${skillId}`);
  }

  /** Enable a previously disabled skill. */
  async enableSkill(skillId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_skills SET status = 'active', updated_at = NOW() WHERE skill_id = $1`,
      [skillId],
    );
    skillCache.clear();
    logger.info(`[SkillsService] Enabled skill: ${skillId}`);
  }

  /** List all skills and their assignments. */
  async listSkills(): Promise<SkillListEntry[]> {
    const res = await this.pool.query(
      `SELECT
         s.skill_id AS "skillId",
         s.name,
         s.version,
         s.category,
         s.status,
         COALESCE(
           array_agg(a.agent_role) FILTER (WHERE a.agent_role IS NOT NULL),
           '{}'
         ) AS "assignedTo"
       FROM agent_skills s
       LEFT JOIN agent_skill_assignments a ON a.skill_id = s.skill_id
       GROUP BY s.skill_id, s.name, s.version, s.category, s.status
       ORDER BY s.category, s.skill_id`,
    );
    return res.rows;
  }

  /** Get a single skill's full content. */
  async getSkill(skillId: string): Promise<AgentSkill | null> {
    const res = await this.pool.query<AgentSkill>(
      `SELECT
         skill_id AS "skillId", name, description, content, version, category
       FROM agent_skills WHERE skill_id = $1`,
      [skillId],
    );
    return res.rows[0] || null;
  }

  /** Approve a pending skill from the discovery queue. */
  async approveDiscoveredSkill(queueId: number, approverId: string): Promise<string> {
    const res = await this.pool.query(
      'SELECT * FROM skill_discovery_queue WHERE id = $1 AND status = $2',
      [queueId, 'pending'],
    );
    if (res.rows.length === 0) throw new Error(`No pending skill with queue id ${queueId}`);

    const queued = res.rows[0];

    // Insert into registry
    await this.upsertSkill({
      skillId: queued.skill_id,
      name: queued.name,
      description: queued.description,
      content: queued.content,
      category: 'discovered',
      source: 'nova-discovered',
      sourceUrl: queued.source_url,
    });

    // Assign to proposed roles
    for (const role of queued.proposed_agent_roles) {
      await this.assignSkill(role, queued.skill_id);
    }

    // Mark approved
    await this.pool.query(
      'UPDATE skill_discovery_queue SET status = $1 WHERE id = $2',
      ['approved', queueId],
    );

    // Update main registry with approval info
    await this.pool.query(
      `UPDATE agent_skills SET
         status = 'active',
         proposed_by = 'nova-discovery',
         approved_by = $1,
         approved_at = NOW()
       WHERE skill_id = $2`,
      [approverId, queued.skill_id],
    );

    logger.info(`[SkillsService] Approved skill ${queued.skill_id} for roles: ${queued.proposed_agent_roles.join(', ')}`);
    return queued.skill_id;
  }

  /** Reject a pending skill from the discovery queue. */
  async rejectDiscoveredSkill(queueId: number): Promise<void> {
    await this.pool.query(
      'UPDATE skill_discovery_queue SET status = $1 WHERE id = $2',
      ['rejected', queueId],
    );
    logger.info(`[SkillsService] Rejected skill queue id ${queueId}`);
  }

  /** List pending discoveries awaiting admin review. */
  async listPendingDiscoveries(): Promise<Array<{
    id: number;
    skillId: string;
    name: string;
    proposedAgentRoles: string[];
    relevanceReasoning: string;
    sourceUrl: string;
  }>> {
    const res = await this.pool.query(
      `SELECT id, skill_id AS "skillId", name,
              proposed_agent_roles AS "proposedAgentRoles",
              relevance_reasoning AS "relevanceReasoning",
              source_url AS "sourceUrl"
       FROM skill_discovery_queue
       WHERE status = 'pending'
       ORDER BY created_at DESC`,
    );
    return res.rows;
  }
}

// ============================================================================
// Singleton
// ============================================================================

export let skillsService: SkillsService | null = null;

export function initSkillsService(pool: Pool): SkillsService {
  skillsService = new SkillsService(pool);
  return skillsService;
}

export function getSkillsService(): SkillsService | null {
  return skillsService;
}
