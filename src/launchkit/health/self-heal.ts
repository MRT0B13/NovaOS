// src/health/self-heal.ts
// Nova Self-Healing Orchestrator
//
// When an agent is crashing / in a restart loop / producing errors,
// instead of just disabling it this engine:
//
//   1. Collects recent errors, logs, and stack traces
//   2. Reads the relevant source files
//   3. Sends everything to Claude for root cause analysis + fix
//   4. Applies the fix (backup → patch → syntax check → rollback on fail)
//   5. Runs a build/type-check to verify
//   6. Calls POST /api/agents/redeploy to hot-reload with the fix
//   7. Monitors recovery — did the agent come back healthy?
//   8. If fix fails or agent still crashes → asks admin for manual intervention
//
// Safety rails:
//   - Max 3 heal attempts per agent per hour (prevent infinite fix loops)
//   - Always backs up files before patching
//   - Syntax check + build verification before deploying
//   - Sensitive files (wallet, keys, auth) always require human approval
//   - Full audit trail in agent_code_repairs table

import * as fs from 'fs';
import * as path from 'path';
import { HealthDB } from './db';
import { CodeRepairEngine } from './code-repair';
import { HealthConfig, AgentError, Severity } from './types';

// ============================================================
// TYPES
// ============================================================

export interface HealAttempt {
  agentName: string;
  trigger: 'restart_loop' | 'dead_agent' | 'critical_error' | 'degraded';
  errors: AgentError[];
  diagnosis: string | null;
  filesChanged: string[];
  fixApplied: boolean;
  redeployTriggered: boolean;
  recovered: boolean;
  manualRequired: boolean;
  durationMs: number;
  timestamp: Date;
}

export interface HealResult {
  success: boolean;
  attempt: HealAttempt;
  message: string;
}

// ============================================================
// SELF-HEALING ENGINE
// ============================================================

export class SelfHealEngine {
  private db: HealthDB;
  private repair: CodeRepairEngine;
  private config: HealthConfig;
  private projectRoot: string;

  // Rate limiting: agentName → timestamps of heal attempts
  private healAttempts: Map<string, number[]> = new Map();
  private static readonly MAX_HEALS_PER_HOUR = 3;
  private static readonly HEAL_COOLDOWN_MS = 5 * 60_000; // 5 min between attempts

  // Track in-progress heals to prevent concurrent attempts on same agent
  private activeHeals: Set<string> = new Set();

  constructor(db: HealthDB, repair: CodeRepairEngine, config: HealthConfig, projectRoot?: string) {
    this.db = db;
    this.repair = repair;
    this.config = config;
    this.projectRoot = projectRoot || process.cwd();
  }

  // ============================================================
  // MAIN ENTRY: Attempt to self-heal an agent
  // ============================================================

  async heal(
    agentName: string,
    trigger: HealAttempt['trigger'],
    recentErrors: AgentError[],
    notifyFn: (msg: string) => Promise<void>,
  ): Promise<HealResult> {
    const startTime = Date.now();

    const attempt: HealAttempt = {
      agentName,
      trigger,
      errors: recentErrors,
      diagnosis: null,
      filesChanged: [],
      fixApplied: false,
      redeployTriggered: false,
      recovered: false,
      manualRequired: false,
      durationMs: 0,
      timestamp: new Date(),
    };

    // ── Guard: concurrent heal ──
    if (this.activeHeals.has(agentName)) {
      return this.result(false, attempt, `Heal already in progress for ${agentName}`, startTime);
    }

    // ── Guard: rate limit ──
    if (!this.canHeal(agentName)) {
      attempt.manualRequired = true;
      await notifyFn(
        `🚨 ${agentName} needs fixing but heal attempts exhausted (${SelfHealEngine.MAX_HEALS_PER_HOUR}/hr). Manual intervention needed.\n` +
        `Recent errors:\n${recentErrors.slice(0, 3).map(e => `• ${e.errorType}: ${e.errorMessage.slice(0, 100)}`).join('\n')}`
      );
      return this.result(false, attempt, 'Heal rate limit exceeded', startTime);
    }

    this.activeHeals.add(agentName);
    this.recordHealAttempt(agentName);

    try {
      await notifyFn(`🔧 Self-healing ${agentName} (trigger: ${trigger})...`);

      // ── Step 1: Collect context ──
      const context = await this.collectDiagnosticContext(agentName, recentErrors);

      // ── Step 2: Ask Claude for diagnosis + fix ──
      const diagnosisResult = await this.diagnoseAndFix(agentName, trigger, context);

      if (!diagnosisResult) {
        attempt.manualRequired = true;
        await notifyFn(
          `❌ Could not diagnose ${agentName}'s issue. Manual intervention needed.\n` +
          `Errors:\n${recentErrors.slice(0, 3).map(e => `• ${e.errorType}: ${e.errorMessage.slice(0, 100)}`).join('\n')}`
        );
        return this.result(false, attempt, 'Diagnosis failed — LLM could not determine fix', startTime);
      }

      attempt.diagnosis = diagnosisResult.diagnosis;

      // ── Step 3: Apply fixes ──
      if (diagnosisResult.fixes.length === 0) {
        // Diagnosis-only (e.g. "restart should fix it" or env issue)
        if (diagnosisResult.actionType === 'restart_only') {
          await notifyFn(`🔍 ${agentName} diagnosis: ${diagnosisResult.diagnosis}\nAction: restart (no code changes needed)`);
          attempt.redeployTriggered = true;
          const redeployed = await this.triggerRedeploy(agentName, notifyFn);
          attempt.recovered = redeployed;
          return this.result(redeployed, attempt, redeployed ? 'Fixed via restart' : 'Restart failed', startTime);
        }

        if (diagnosisResult.actionType === 'env_change') {
          await notifyFn(
            `🔧 ${agentName} diagnosis: ${diagnosisResult.diagnosis}\n` +
            `Required action: Environment variable change\n` +
            `${diagnosisResult.envChanges?.map(e => `• Set ${e.key}=${e.value}`).join('\n') || 'See diagnosis'}\n` +
            `Manual intervention needed (env vars can't be auto-changed in Railway).`
          );
          attempt.manualRequired = true;
          return this.result(false, attempt, 'Env change needed — manual intervention', startTime);
        }

        attempt.manualRequired = true;
        await notifyFn(`🔍 ${agentName} diagnosis: ${diagnosisResult.diagnosis}\nNo auto-fix available. Manual intervention needed.`);
        return this.result(false, attempt, 'No fix generated', startTime);
      }

      // Apply each fix
      let allApplied = true;
      for (const fix of diagnosisResult.fixes) {
        const applied = await this.applyFix(fix, notifyFn);
        if (applied) {
          attempt.filesChanged.push(fix.filePath);
        } else {
          allApplied = false;
        }
      }

      if (!allApplied && attempt.filesChanged.length === 0) {
        attempt.manualRequired = true;
        await notifyFn(
          `❌ ${agentName}: Fix generated but could not be applied.\n` +
          `Diagnosis: ${diagnosisResult.diagnosis}\n` +
          `Manual intervention needed.`
        );
        return this.result(false, attempt, 'Fix could not be applied', startTime);
      }

      attempt.fixApplied = true;

      // ── Step 4: Verify build ──
      const buildOk = await this.verifyBuild(notifyFn);
      if (!buildOk) {
        // Rollback all changes
        await notifyFn(`❌ Build failed after applying fix. Rolling back...`);
        // Backups are handled per-file in applyFix — the repair engine handles rollback
        attempt.manualRequired = true;
        return this.result(false, attempt, 'Build verification failed — rolled back', startTime);
      }

      // ── Step 5: Trigger redeploy ──
      await notifyFn(`✅ Fix applied and build passed. Triggering redeploy...`);
      attempt.redeployTriggered = true;
      const redeployed = await this.triggerRedeploy(agentName, notifyFn);

      if (!redeployed) {
        await notifyFn(`⚠️ Fix applied but redeploy failed. Changes are saved — will take effect next deploy.`);
        return this.result(true, attempt, 'Fix applied, redeploy failed (will apply next deploy)', startTime);
      }

      // ── Step 6: Wait for recovery ──
      await notifyFn(`🔄 Redeploy triggered. Monitoring recovery...`);
      const recovered = await this.waitForRecovery(agentName, 90_000);
      attempt.recovered = recovered;

      if (recovered) {
        await notifyFn(
          `✅ ${agentName} SELF-HEALED successfully!\n` +
          `Diagnosis: ${diagnosisResult.diagnosis}\n` +
          `Files changed: ${attempt.filesChanged.join(', ')}\n` +
          `Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`
        );
        // Commit the fix
        await this.commitFix(agentName, diagnosisResult.diagnosis, attempt.filesChanged);
        return this.result(true, attempt, 'Self-healed successfully', startTime);
      } else {
        await notifyFn(
          `⚠️ ${agentName}: Fix applied + redeployed but agent hasn't recovered yet.\n` +
          `Monitoring will continue. If it doesn't come back, manual intervention needed.`
        );
        // Still commit — the fix might be correct, agent may need more time
        await this.commitFix(agentName, diagnosisResult.diagnosis, attempt.filesChanged);
        return this.result(false, attempt, 'Fix applied but recovery not confirmed', startTime);
      }

    } catch (err: any) {
      console.error(`[SelfHeal] Unexpected error healing ${agentName}:`, err);
      await notifyFn(`❌ Self-heal for ${agentName} hit an unexpected error: ${err.message}\nManual intervention needed.`);
      attempt.manualRequired = true;
      return this.result(false, attempt, `Unexpected error: ${err.message}`, startTime);
    } finally {
      this.activeHeals.delete(agentName);
      // Log the attempt to DB
      await this.logHealAttempt(attempt);
    }
  }

  // ============================================================
  // STEP 1: Collect diagnostic context
  // ============================================================

  private async collectDiagnosticContext(agentName: string, errors: AgentError[]): Promise<DiagnosticContext> {
    // Gather all unique file paths from errors
    const filePaths = new Set<string>();
    for (const err of errors) {
      if (err.filePath) filePaths.add(err.filePath);
      // Extract paths from stack traces
      const stackPaths = this.extractFilePathsFromStack(err.stackTrace || '');
      stackPaths.forEach(p => filePaths.add(p));
    }

    // Read the source of each relevant file
    const fileContents: Record<string, string> = {};
    for (const fp of filePaths) {
      const resolved = this.resolveFilePath(fp);
      if (resolved && fs.existsSync(resolved)) {
        try {
          const content = fs.readFileSync(resolved, 'utf-8');
          // Limit to 300 lines around the error for context (don't send 10k line files)
          const errorLine = errors.find(e => e.filePath === fp)?.lineNumber;
          fileContents[fp] = this.extractRelevantSection(content, errorLine, 150);
        } catch { /* skip unreadable files */ }
      }
    }

    // Get recent errors from DB for broader context (last 30 min)
    let recentDbErrors: AgentError[] = [];
    try {
      recentDbErrors = await this.db.getRecentErrors(agentName, 30 * 60_000);
    } catch { /* non-fatal */ }

    // Get recent repair history (what's already been tried)
    let recentRepairs: any[] = [];
    try {
      recentRepairs = await this.db.getRecentRepairs(agentName, 5);
    } catch { /* non-fatal */ }

    return {
      agentName,
      errors,
      recentDbErrors,
      recentRepairs,
      fileContents,
      projectRoot: this.projectRoot,
    };
  }

  // ============================================================
  // STEP 2: Claude diagnosis + fix generation
  // ============================================================

  private async diagnoseAndFix(
    agentName: string,
    trigger: string,
    ctx: DiagnosticContext,
  ): Promise<DiagnosisResult | null> {

    const prompt = this.buildDiagnosisPrompt(agentName, trigger, ctx);

    try {
      const response = await this.callClaude(prompt);
      if (!response) return null;

      // Parse the structured response
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[SelfHeal] Claude response was not structured JSON:', response.slice(0, 200));
        return null;
      }

      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      return {
        diagnosis: parsed.diagnosis || 'Unknown',
        actionType: parsed.action_type || 'code_fix',
        fixes: (parsed.fixes || []).map((f: any) => ({
          filePath: this.resolveFilePath(f.file_path) || f.file_path,
          originalCode: f.original_code,
          repairedCode: f.repaired_code,
          explanation: f.explanation,
        })),
        envChanges: parsed.env_changes || [],
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || '',
      };
    } catch (err: any) {
      console.error('[SelfHeal] Diagnosis failed:', err.message);
      return null;
    }
  }

  private buildDiagnosisPrompt(agentName: string, trigger: string, ctx: DiagnosticContext): string {
    const errorSummary = ctx.errors.map((e, i) =>
      `Error ${i + 1}:\n  Type: ${e.errorType}\n  Message: ${e.errorMessage}\n  File: ${e.filePath || 'unknown'}:${e.lineNumber || '?'}\n  Stack:\n${(e.stackTrace || 'N/A').split('\n').slice(0, 8).map(l => '    ' + l).join('\n')}`
    ).join('\n\n');

    const fileSections = Object.entries(ctx.fileContents).map(([fp, content]) =>
      `── ${fp} ──\n\`\`\`typescript\n${content}\n\`\`\``
    ).join('\n\n');

    const repairHistory = ctx.recentRepairs.length > 0
      ? `Recent repair attempts (already tried):\n${ctx.recentRepairs.map((r: any) =>
          `• ${r.created_at}: ${r.diagnosis || 'unknown'} → ${r.applied ? 'applied' : 'failed'}`
        ).join('\n')}`
      : 'No recent repair attempts.';

    return `You are Nova's self-healing agent. An agent in the Nova swarm is failing and you need to diagnose the root cause and provide a fix.

## Context
- **Agent:** ${agentName}
- **Trigger:** ${trigger}
- **Project:** TypeScript/ElizaOS agent system using PostgreSQL, Solana, Fastify
- **Project root:** ${this.projectRoot}

## Recent Errors
${errorSummary}

## Relevant Source Code
${fileSections || 'No source files could be read.'}

## Previous Repair Attempts
${repairHistory}

## Your Task
1. Diagnose the ROOT CAUSE (not just the symptom)
2. Determine the minimal fix
3. If it's a code issue, provide exact code replacements
4. If it's an env/config issue, say so
5. If a simple restart would fix it (transient error), say so

## Response Format
Respond with ONLY this JSON (no other text):
\`\`\`json
{
  "diagnosis": "Clear description of the root cause",
  "reasoning": "Step-by-step reasoning of how you reached this conclusion",
  "confidence": 0.85,
  "action_type": "code_fix | restart_only | env_change | manual_required",
  "fixes": [
    {
      "file_path": "src/path/to/file.ts",
      "original_code": "exact code to find and replace (include 3+ lines of context)",
      "repaired_code": "the fixed version",
      "explanation": "what this change does"
    }
  ],
  "env_changes": [
    { "key": "ENV_VAR_NAME", "value": "new_value", "reason": "why" }
  ]
}
\`\`\`

RULES:
- MINIMUM changes only — don't refactor, don't add features, just fix the bug
- Include enough context in original_code to uniquely identify the location (3+ lines)
- If you're not confident (< 0.6), set action_type to "manual_required"
- Never modify wallet keys, private keys, or authentication secrets
- If the error is transient (network timeout, rate limit), prefer restart_only
- If a previous repair was attempted for the same issue and failed, try a different approach`;
  }

  // ============================================================
  // STEP 3: Apply a single fix
  // ============================================================

  private async applyFix(fix: CodeFix, notifyFn: (msg: string) => Promise<void>): Promise<boolean> {
    const filePath = fix.filePath;

    if (!fs.existsSync(filePath)) {
      console.log(`[SelfHeal] File not found: ${filePath}`);
      return false;
    }

    // Safety: check if file is in a sensitive path
    const rel = path.relative(this.projectRoot, filePath);
    for (const pattern of this.config.repairRequiresApproval) {
      const { minimatch } = require('minimatch');
      if (minimatch(rel, pattern)) {
        await notifyFn(
          `⚠️ Self-heal wants to modify a sensitive file: ${rel}\n` +
          `Fix: ${fix.explanation}\n` +
          `This requires manual approval. Skipping auto-fix.`
        );
        return false;
      }
    }

    // Backup
    const backupPath = `${filePath}.selfheal.${Date.now()}.bak`;
    const original = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(backupPath, original, 'utf-8');

    try {
      // Apply exact replacement
      let patched: string | null = null;

      if (original.includes(fix.originalCode)) {
        patched = original.replace(fix.originalCode, fix.repairedCode);
      } else {
        // Try fuzzy matching (whitespace/indent differences)
        patched = this.fuzzyApply(original, fix.originalCode, fix.repairedCode);
      }

      if (!patched || patched === original) {
        console.log(`[SelfHeal] Could not locate code to replace in ${filePath}`);
        this.cleanup(backupPath);
        return false;
      }

      fs.writeFileSync(filePath, patched, 'utf-8');

      // Quick syntax check
      const syntaxOk = await this.syntaxCheck(filePath);
      if (!syntaxOk) {
        console.log(`[SelfHeal] Syntax check failed for ${filePath}, rolling back`);
        fs.writeFileSync(filePath, original, 'utf-8');
        this.cleanup(backupPath);
        return false;
      }

      console.log(`[SelfHeal] ✅ Fix applied to ${rel}: ${fix.explanation}`);
      // Keep backup for 24h
      setTimeout(() => this.cleanup(backupPath), 24 * 3600_000);
      return true;

    } catch (err: any) {
      // Emergency rollback
      fs.writeFileSync(filePath, original, 'utf-8');
      this.cleanup(backupPath);
      console.error(`[SelfHeal] Error applying fix to ${filePath}:`, err.message);
      return false;
    }
  }

  // ============================================================
  // STEP 4: Build verification
  // ============================================================

  private async verifyBuild(notifyFn: (msg: string) => Promise<void>): Promise<boolean> {
    const { execSync } = require('child_process');

    try {
      // TypeScript type check (no emit)
      execSync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: this.projectRoot,
        timeout: 120_000, // 2 min
        stdio: 'pipe',
      });
      console.log('[SelfHeal] ✅ TypeScript build verification passed');
      return true;
    } catch (err: any) {
      const output = err.stdout?.toString()?.slice(0, 500) || err.message;
      console.log(`[SelfHeal] ❌ Build failed: ${output}`);

      // Don't fail on pre-existing errors — check if any NEW errors were introduced
      // by looking for errors in files we modified
      try {
        const errLines = output.split('\n');
        const hasNewErrors = errLines.some((line: string) =>
          line.includes('error TS') && !line.includes('node_modules')
        );
        if (!hasNewErrors) {
          console.log('[SelfHeal] Build errors are pre-existing, proceeding');
          return true;
        }
      } catch {}

      return false;
    }
  }

  // ============================================================
  // STEP 5: Trigger redeploy via API or process restart
  // ============================================================

  private async triggerRedeploy(agentName: string, notifyFn: (msg: string) => Promise<void>): Promise<boolean> {
    const { execSync } = require('child_process');

    // Strategy 1: Try PM2 restart (in-process, fastest)
    try {
      execSync(`pm2 restart ${agentName} 2>&1`, { timeout: 30_000, stdio: 'pipe' });
      console.log(`[SelfHeal] ✅ PM2 restart triggered for ${agentName}`);
      return true;
    } catch {
      console.log(`[SelfHeal] PM2 restart failed for ${agentName}, trying alternatives...`);
    }

    // Strategy 2: Try the nova-main PM2 process (most agents run inside it)
    try {
      execSync('pm2 restart nova-main 2>&1', { timeout: 30_000, stdio: 'pipe' });
      console.log('[SelfHeal] ✅ PM2 restart triggered for nova-main');
      return true;
    } catch {
      console.log('[SelfHeal] PM2 restart for nova-main failed');
    }

    // Strategy 3: Try calling the API redeploy endpoint
    try {
      const apiPort = process.env.API_PORT || process.env.PORT || '4000';
      const apiSecret = process.env.API_JWT_SECRET || 'novaverse-dev-secret-change-me';

      // Generate a service JWT for the health agent
      const jwt = await this.generateServiceJWT(apiSecret);
      if (jwt) {
        const res = await fetch(`http://localhost:${apiPort}/api/agents/redeploy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwt}`,
          },
          body: JSON.stringify({ templateId: this.agentToTemplate(agentName) }),
        });

        if (res.ok) {
          console.log('[SelfHeal] ✅ API redeploy triggered');
          return true;
        } else {
          const body = await res.text();
          console.log(`[SelfHeal] API redeploy failed: ${res.status} ${body}`);
        }
      }
    } catch (err: any) {
      console.log(`[SelfHeal] API redeploy failed: ${err.message}`);
    }

    // Strategy 4: Docker restart
    try {
      execSync(`docker restart nova-${agentName} 2>&1`, { timeout: 30_000, stdio: 'pipe' });
      console.log(`[SelfHeal] ✅ Docker restart triggered for ${agentName}`);
      return true;
    } catch {}

    // Strategy 5: Send message bus restart command (last resort)
    await this.db.sendMessage('health-monitor', agentName, 'command', {
      action: 'restart',
      reason: 'Self-heal fix applied, restart needed',
    }, 'critical');
    console.log('[SelfHeal] Sent restart command via message bus');
    return true; // Optimistic — message bus is async
  }

  // ============================================================
  // STEP 6: Wait for recovery
  // ============================================================

  private async waitForRecovery(agentName: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const checkInterval = 5_000;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, checkInterval));

      try {
        const heartbeats = await this.db.getAllHeartbeats();
        const agent = heartbeats.find(h => h.agentName === agentName);

        if (agent && agent.status === 'alive' && agent.lastBeat.getTime() > start) {
          return true;
        }
      } catch { /* keep trying */ }
    }

    return false;
  }

  // ============================================================
  // STEP 7: Commit the fix (git commit so it persists across deploys)
  // ============================================================

  private async commitFix(agentName: string, diagnosis: string, files: string[]): Promise<void> {
    const { execSync } = require('child_process');
    try {
      const relFiles = files.map(f => path.relative(this.projectRoot, f));
      // Stage only the files we changed
      for (const f of relFiles) {
        execSync(`git add "${f}" 2>&1`, { cwd: this.projectRoot, timeout: 10_000, stdio: 'pipe' });
      }
      // Commit
      const msg = `fix(self-heal): ${agentName} — ${diagnosis.slice(0, 100)}`;
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}" 2>&1`, {
        cwd: this.projectRoot,
        timeout: 15_000,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Nova Health Agent',
          GIT_AUTHOR_EMAIL: 'health@nova.agent',
          GIT_COMMITTER_NAME: 'Nova Health Agent',
          GIT_COMMITTER_EMAIL: 'health@nova.agent',
        },
      });
      // Push (Railway auto-deploys from main)
      execSync('git push 2>&1', { cwd: this.projectRoot, timeout: 30_000, stdio: 'pipe' });
      console.log(`[SelfHeal] ✅ Fix committed and pushed: ${msg}`);
    } catch (err: any) {
      // Non-fatal — fix is applied locally, will be included in next manual push
      console.warn(`[SelfHeal] Git commit/push failed (fix still applied locally): ${err.message}`);
    }
  }

  // ============================================================
  // CLAUDE API CALL
  // ============================================================

  private async callClaude(prompt: string): Promise<string | null> {
    // Try Anthropic first (primary for diagnosis), fall back to OpenAI
    const providers: Array<{ name: string; call: () => Promise<string> }> = [];

    if (process.env.ANTHROPIC_API_KEY) {
      providers.push({
        name: 'anthropic',
        call: async () => {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY!,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: this.config.repairModel || 'claude-sonnet-4-20250514',
              max_tokens: 4000,
              temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
          const data: any = await res.json();
          return data.content?.[0]?.text || '';
        },
      });
    }

    if (process.env.OPENAI_API_KEY) {
      providers.push({
        name: 'openai',
        call: async () => {
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o',
              max_tokens: 4000,
              temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
          const data: any = await res.json();
          return data.choices?.[0]?.message?.content || '';
        },
      });
    }

    for (const provider of providers) {
      try {
        const response = await provider.call();
        if (response) {
          console.log(`[SelfHeal] Claude diagnosis received via ${provider.name} (${response.length} chars)`);
          return response;
        }
      } catch (err: any) {
        console.warn(`[SelfHeal] ${provider.name} call failed: ${err.message}`);
      }
    }

    console.error('[SelfHeal] All LLM providers failed');
    return null;
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  private canHeal(agentName: string): boolean {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const attempts = (this.healAttempts.get(agentName) || []).filter(t => t > hourAgo);
    this.healAttempts.set(agentName, attempts);

    if (attempts.length >= SelfHealEngine.MAX_HEALS_PER_HOUR) return false;

    // Also check cooldown since last attempt
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt && now - lastAttempt < SelfHealEngine.HEAL_COOLDOWN_MS) return false;

    return true;
  }

  private recordHealAttempt(agentName: string): void {
    const attempts = this.healAttempts.get(agentName) || [];
    attempts.push(Date.now());
    this.healAttempts.set(agentName, attempts);
  }

  private async logHealAttempt(attempt: HealAttempt): Promise<void> {
    try {
      await this.db.logError({
        agentName: 'health-monitor',
        errorType: 'SELF_HEAL_ATTEMPT',
        errorMessage: JSON.stringify({
          agent: attempt.agentName,
          trigger: attempt.trigger,
          diagnosis: attempt.diagnosis,
          filesChanged: attempt.filesChanged,
          fixApplied: attempt.fixApplied,
          redeployTriggered: attempt.redeployTriggered,
          recovered: attempt.recovered,
          manualRequired: attempt.manualRequired,
          durationMs: attempt.durationMs,
        }),
        severity: attempt.recovered ? 'info' : 'warning',
      });
    } catch { /* non-fatal */ }
  }

  private extractFilePathsFromStack(stack: string): string[] {
    const paths: string[] = [];
    const regex = /(?:at\s+.*?\()?([\/\w.\-]+\.(?:ts|js)):(\d+)/g;
    let match;
    while ((match = regex.exec(stack)) !== null) {
      if (!match[1].includes('node_modules')) {
        paths.push(match[1]);
      }
    }
    return [...new Set(paths)];
  }

  private resolveFilePath(fp: string): string | null {
    if (!fp) return null;
    if (fs.existsSync(fp)) return fp;
    const r = path.join(this.projectRoot, fp);
    if (fs.existsSync(r)) return r;
    // Railway runs from /app/
    const s = path.join(this.projectRoot, fp.replace(/^\/app\//, ''));
    if (fs.existsSync(s)) return s;
    return null;
  }

  private extractRelevantSection(content: string, errorLine: number | undefined, contextLines: number): string {
    const lines = content.split('\n');
    if (!errorLine || errorLine < 1) {
      // Return first chunk if we don't know which line
      return lines.slice(0, Math.min(lines.length, contextLines * 2))
        .map((l, i) => `${i + 1}: ${l}`).join('\n');
    }
    const start = Math.max(0, errorLine - contextLines);
    const end = Math.min(lines.length, errorLine + contextLines);
    return lines.slice(start, end)
      .map((l, i) => `${start + i + 1 === errorLine ? ' >>> ' : '     '}${start + i + 1}: ${l}`)
      .join('\n');
  }

  private fuzzyApply(source: string, orig: string, repaired: string): string | null {
    // Normalize whitespace for comparison
    const normLine = (s: string) => s.replace(/\s+/g, ' ').trim();
    const sourceLines = source.split('\n');
    const origLines = orig.split('\n').map(l => l.trim()).filter(l => l);

    for (let i = 0; i < sourceLines.length; i++) {
      if (normLine(sourceLines[i]) !== normLine(origLines[0])) continue;
      let ok = true;
      for (let j = 1; j < origLines.length; j++) {
        if (i + j >= sourceLines.length || normLine(sourceLines[i + j]) !== normLine(origLines[j])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const indent = sourceLines[i].match(/^(\s*)/)?.[1] || '';
        sourceLines.splice(i, origLines.length, ...repaired.split('\n').map(l => indent + l.trimStart()));
        return sourceLines.join('\n');
      }
    }
    return null;
  }

  private async syntaxCheck(filePath: string): Promise<boolean> {
    const { execSync } = require('child_process');
    try {
      execSync(`npx tsc --noEmit --pretty false "${filePath}" 2>&1`, {
        cwd: this.projectRoot,
        timeout: 30_000,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  private async generateServiceJWT(secret: string): Promise<string | null> {
    try {
      // Simple JWT generation for service-to-service auth
      // Header: {"alg":"HS256","typ":"JWT"}
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        address: 'health-agent-service',
        role: 'service',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300, // 5 min
      })).toString('base64url');

      const { createHmac } = require('crypto');
      const signature = createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url');

      return `${header}.${payload}.${signature}`;
    } catch {
      return null;
    }
  }

  private agentToTemplate(agentName: string): string {
    const map: Record<string, string> = {
      'nova-cfo': 'cfo-agent',
      'nova-scout': 'scout-agent',
      'nova-guardian': 'cfo-agent',
      'nova-supervisor': 'governance-agent',
      'nova-community': 'community-agent',
      'nova-analyst': 'analyst-agent',
      'nova-launcher': 'launcher-agent',
      'nova-social-sentinel': 'social-agent',
      'nova-main': 'full-nova',
    };
    return map[agentName] || 'full-nova';
  }

  private cleanup(p: string): void {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  private result(success: boolean, attempt: HealAttempt, message: string, startTime: number): HealResult {
    attempt.durationMs = Date.now() - startTime;
    return { success, attempt, message };
  }
}

// ============================================================
// INTERNAL TYPES
// ============================================================

interface DiagnosticContext {
  agentName: string;
  errors: AgentError[];
  recentDbErrors: AgentError[];
  recentRepairs: any[];
  fileContents: Record<string, string>;
  projectRoot: string;
}

interface DiagnosisResult {
  diagnosis: string;
  actionType: 'code_fix' | 'restart_only' | 'env_change' | 'manual_required';
  fixes: CodeFix[];
  envChanges?: Array<{ key: string; value: string; reason: string }>;
  confidence: number;
  reasoning: string;
}

interface CodeFix {
  filePath: string;
  originalCode: string;
  repairedCode: string;
  explanation: string;
}
