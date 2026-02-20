// src/health/code-repair.ts
// Nova's Self-Healing Code Repair Engine (v2 — Two-Tier)
//
// TIER 1: Rule-based patterns (instant, free, high confidence)
//   → RPC rotation, rate limit adjustment, model swap, import fix, etc.
//
// TIER 2: LLM-powered diagnosis (slower, costs $, for novel errors)
//   → Reads the code, understands the error, generates a patch
//
// Flow: Error → Try Tier 1 patterns → No match? → Tier 2 LLM →
//       Check Approval → Backup file → Apply Fix → Syntax check →
//       Pass? Keep. Fail? Rollback.

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { HealthDB } from './db';
import {
  HealthConfig,
  CodeRepairRequest,
  CodeRepairResult,
  RepairCategory,
  AgentError,
} from './types';
import {
  findMatchingPattern,
  executePattern,
  RepairContext,
  RepairAction,
} from './repair-patterns';

export class CodeRepairEngine {
  private db: HealthDB;
  private config: HealthConfig;
  private projectRoot: string;
  private recentRepairs: Map<string, number> = new Map();
  private repairStats = { tier1: 0, tier2: 0, skipped: 0, failed: 0 };

  // Active LLM provider for Tier 2 repairs (switchable at runtime)
  private llmProvider: 'anthropic' | 'openai' = 'anthropic';

  constructor(db: HealthDB, config: HealthConfig, projectRoot: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /** Load persisted LLM provider preference from DB (call once after construction) */
  async loadPersistedProvider(): Promise<void> {
    try {
      const saved = await this.db.getSetting('llm_provider');
      if (saved === 'anthropic' || saved === 'openai') {
        this.llmProvider = saved;
        console.log(`[Repair] Loaded persisted LLM provider: ${saved}`);
      }
    } catch {
      // First run or DB not ready — keep default
    }
  }

  /** Switch the LLM provider used for Tier 2 code repairs */
  switchProvider(provider: 'anthropic' | 'openai'): void {
    const prev = this.llmProvider;
    if (prev === provider) {
      console.log(`[Repair] LLM provider already set to ${provider}, skipping switch`);
      return;
    }
    this.llmProvider = provider;
    console.log(`[Repair] LLM provider switched: ${prev} → ${provider}`);
    // Persist to DB so it survives restarts
    this.db.setSetting('llm_provider', provider).catch(() => {});
  }

  /** Get the currently active LLM provider */
  getProvider(): string { return this.llmProvider; }

  // ============================================================
  // MAIN ENTRY POINT
  // ============================================================

  async evaluateAndRepair(error: AgentError, errorId: number): Promise<{
    attempted: boolean;
    tier?: 1 | 2;
    repairId?: number;
    needsApproval?: boolean;
    applied?: boolean;
    diagnosis?: string;
  }> {
    if (!this.config.repairEnabled) return { attempted: false };

    // Dedup: same file+error within 30 min
    const dedupKey = `${error.filePath || 'unknown'}:${error.errorType}:${error.errorMessage.slice(0, 50)}`;
    const lastAttempt = this.recentRepairs.get(dedupKey);
    if (lastAttempt && Date.now() - lastAttempt < 30 * 60 * 1000) {
      this.repairStats.skipped++;
      return { attempted: false };
    }

    // ── TIER 1: Rule-based patterns (instant, free) ──
    const t1 = await this.tryTier1(error, errorId);
    if (t1) { this.recentRepairs.set(dedupKey, Date.now()); return t1; }

    // ── TIER 2: LLM-powered repair (slower, costs $) ──
    const t2 = await this.tryTier2(error, errorId);
    if (t2) { this.recentRepairs.set(dedupKey, Date.now()); return t2; }

    this.repairStats.skipped++;
    return { attempted: false };
  }

  // ============================================================
  // TIER 1: PATTERN-BASED REPAIR
  // ============================================================

  private async tryTier1(error: AgentError, errorId: number) {
    const pattern = findMatchingPattern(
      error.errorType, error.errorMessage, error.stackTrace, error.filePath || undefined
    );
    if (!pattern) return null;

    console.log(`[Repair/T1] Pattern: '${pattern.name}' for ${error.errorType}`);

    const ctx: RepairContext = {
      errorType: error.errorType,
      errorMessage: error.errorMessage,
      stackTrace: error.stackTrace,
      filePath: error.filePath || undefined,
      lineNumber: error.lineNumber || undefined,
      projectRoot: this.projectRoot,
    };

    const action = await executePattern(pattern, ctx);
    if (!action || (!action.originalCode && !action.repairedCode)) {
      if (action?.diagnosis) console.log(`[Repair/T1] Diagnosis only: ${action.diagnosis}`);
      return null;
    }

    const result: CodeRepairResult = {
      diagnosis: action.diagnosis,
      repairCategory: pattern.category,
      originalCode: action.originalCode,
      repairedCode: action.repairedCode,
      requiresApproval: pattern.requiresApproval || this.needsApproval(action.filePath),
      confidence: pattern.confidence,
    };

    const repairId = await this.db.logRepairAttempt(
      { errorId, agentName: error.agentName, filePath: action.filePath, errorType: error.errorType, errorMessage: error.errorMessage, stackTrace: error.stackTrace },
      result, `tier1:${pattern.id}`, `Pattern: ${pattern.name}`, JSON.stringify(action)
    );

    if (result.requiresApproval) {
      await this.notifyApprovalNeeded(repairId, 1, pattern.name, action.filePath, result);
      return { attempted: true, tier: 1 as const, repairId, needsApproval: true, applied: false, diagnosis: result.diagnosis };
    }

    await this.db.approveRepair(repairId, 'tier1-auto');
    const applied = await this.applyRepair(repairId, action.filePath, result);
    this.repairStats.tier1++;
    return { attempted: true, tier: 1 as const, repairId, needsApproval: false, applied, diagnosis: result.diagnosis };
  }

  // ============================================================
  // TIER 2: LLM-POWERED REPAIR
  // ============================================================

  private async tryTier2(error: AgentError, errorId: number) {
    const filePath = error.filePath || this.extractFilePath(error.stackTrace || error.errorMessage);
    if (!filePath) return null;

    const category = this.classifyError(error);
    if (!category) return null;

    const fullPath = this.resolveFilePath(filePath);
    if (!fullPath || !fs.existsSync(fullPath)) return null;

    const source = fs.readFileSync(fullPath, 'utf-8');
    const relevantLines = this.extractRelevantLines(source, error.lineNumber || undefined, 40);

    console.log(`[Repair/T2] LLM analysis: ${error.errorType} in ${filePath}`);

    const request: CodeRepairRequest = {
      errorId, agentName: error.agentName, filePath: fullPath,
      errorType: error.errorType, errorMessage: error.errorMessage,
      stackTrace: error.stackTrace, relevantCode: relevantLines,
    };

    const { result, prompt, response } = await this.generateRepair(request, category);
    if (!result) { this.repairStats.failed++; return { attempted: true, tier: 2 as const }; }

    result.requiresApproval = this.needsApproval(fullPath);
    const repairId = await this.db.logRepairAttempt(request, result, this.config.repairModel, prompt, response);

    if (result.requiresApproval) {
      await this.notifyApprovalNeeded(repairId, 2, 'LLM', fullPath, result);
      return { attempted: true, tier: 2 as const, repairId, needsApproval: true, applied: false, diagnosis: result.diagnosis };
    }

    await this.db.approveRepair(repairId, 'tier2-auto');
    const applied = await this.applyRepair(repairId, fullPath, result);
    this.repairStats.tier2++;
    return { attempted: true, tier: 2 as const, repairId, needsApproval: false, applied, diagnosis: result.diagnosis };
  }

  // ============================================================
  // APPLY REPAIR — backup → apply → syntax check → rollback on fail
  // ============================================================

  async applyRepair(repairId: number, filePath: string, result: CodeRepairResult): Promise<boolean> {
    if (!fs.existsSync(filePath)) {
      await this.db.markRepairApplied(repairId, false, 'File not found');
      return false;
    }

    const backupPath = `${filePath}.backup.${Date.now()}`;
    const original = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(backupPath, original, 'utf-8');

    try {
      // Apply fix (exact match first, then fuzzy)
      let patched = original.includes(result.originalCode)
        ? original.replace(result.originalCode, result.repairedCode)
        : this.fuzzyApply(original, result.originalCode, result.repairedCode);

      if (!patched || patched === original) {
        await this.db.markRepairApplied(repairId, false, 'Could not locate code to replace');
        this.cleanup(backupPath);
        return false;
      }

      fs.writeFileSync(filePath, patched, 'utf-8');

      // Syntax check
      const test = await this.runSyntaxCheck(filePath);
      if (!test.passed) {
        fs.writeFileSync(filePath, original, 'utf-8'); // ROLLBACK
        await this.db.markRepairApplied(repairId, false, test.output);
        await this.db.markRepairRolledBack(repairId, `Syntax failed: ${test.output.slice(0, 200)}`);
        this.cleanup(backupPath);
        this.repairStats.failed++;
        return false;
      }

      // SUCCESS
      await this.db.markRepairApplied(repairId, true, test.output);
      setTimeout(() => this.cleanup(backupPath), 24 * 60 * 60 * 1000); // Keep backup 24h
      return true;
    } catch (err: any) {
      fs.writeFileSync(filePath, original, 'utf-8'); // EMERGENCY ROLLBACK
      await this.db.markRepairRolledBack(repairId, err.message);
      this.cleanup(backupPath);
      this.repairStats.failed++;
      return false;
    }
  }

  // ============================================================
  // LLM CALL (Tier 2)
  // ============================================================

  private async generateRepair(request: CodeRepairRequest, category: RepairCategory) {
    const prompt = `You are a code repair assistant for Nova (ElizaOS, TypeScript, PostgreSQL, Solana).

## Error
- **Type:** ${request.errorType}
- **Message:** ${request.errorMessage}
- **File:** ${request.filePath}
- **Category:** ${category}

## Stack Trace
\`\`\`
${(request.stackTrace || 'N/A').slice(0, 1000)}
\`\`\`

## Code
\`\`\`typescript
${(request.relevantCode || 'N/A').slice(0, 2000)}
\`\`\`

MINIMUM change only. Respond with JSON only:
\`\`\`json
{"diagnosis":"...","confidence":0.85,"original_code":"exact code to replace","repaired_code":"fixed version"}
\`\`\``;

    try {
      const { response: llmResponse, text: responseText } = await this.callLLM(prompt);
      const response = responseText;

      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { result: null, prompt, response };

      const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      if ((json.confidence || 0) < 0.5) return { result: null, prompt, response };

      const result: CodeRepairResult = {
        diagnosis: json.diagnosis || 'Unknown',
        repairCategory: category,
        originalCode: json.original_code,
        repairedCode: json.repaired_code,
        requiresApproval: false,
        confidence: json.confidence,
      };
      return { result, prompt, response };
    } catch (err: any) {
      return { result: null, prompt, response: err.message };
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  /**
   * Call the active LLM provider (Anthropic or OpenAI).
   * Automatically falls back to the other provider on failure.
   */
  private async callLLM(prompt: string): Promise<{ response: any; text: string }> {
    const providers: Array<'anthropic' | 'openai'> = this.llmProvider === 'anthropic'
      ? ['anthropic', 'openai']
      : ['openai', 'anthropic'];

    for (const provider of providers) {
      try {
        if (provider === 'anthropic') {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) continue;
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: this.config.repairModel,
              max_tokens: 2000,
              temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`Anthropic ${res.status}`);
          const data: any = await res.json();
          const text = data.content?.[0]?.text || '';
          return { response: data, text };
        } else {
          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) continue;
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'gpt-5.2',
              max_tokens: 2000,
              temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`OpenAI ${res.status}`);
          const data: any = await res.json();
          const text = data.choices?.[0]?.message?.content || '';
          if (provider !== this.llmProvider) {
            console.log(`[Repair] ⚠️ Primary ${this.llmProvider} failed, used ${provider} fallback`);
          }
          return { response: data, text };
        }
      } catch (err: any) {
        console.log(`[Repair] ${provider} call failed: ${err.message}`);
        continue;
      }
    }
    throw new Error('All LLM providers failed');
  }

  classifyError(error: AgentError): RepairCategory | null {
    const m = `${error.errorType} ${error.errorMessage} ${error.stackTrace || ''}`.toLowerCase();
    if (m.includes('env') || (m.includes('undefined') && m.includes('process.env'))) return 'config_fix';
    if (m.includes('404') || m.includes('enotfound')) return 'api_endpoint';
    if (m.includes('solana') || m.includes('rpc') || m.includes('blockhash')) return 'rpc_rotation';
    if (m.includes('openai') || m.includes('model') && m.includes('not found')) return 'model_fallback';
    if (m.includes('429') || m.includes('rate limit')) return 'rate_limit_adjust';
    if (m.includes('cannot find module')) return 'import_fix';
    if (m.includes('column') || m.includes('relation')) return 'query_fix';
    if (m.includes('typeerror') || m.includes('is not a function')) return 'type_fix';
    if (m.includes('timeout') || m.includes('etimedout')) return 'retry_logic';
    return null;
  }

  private needsApproval(filePath: string): boolean {
    const rel = path.relative(this.projectRoot, filePath);
    for (const p of this.config.repairAutoApprove) if (minimatch(rel, p)) return false;
    for (const p of this.config.repairRequiresApproval) if (minimatch(rel, p)) return true;
    return true;
  }

  private extractFilePath(text: string): string | null {
    const m = text.match(/(?:at\s+.*?\()(\/[^:)]+\.(?:ts|js)):?/) || text.match(/(\/[^\s:]+\.(?:ts|js)):(\d+)/);
    return m ? m[1] : null;
  }

  private resolveFilePath(fp: string): string | null {
    if (fs.existsSync(fp)) return fp;
    const r = path.join(this.projectRoot, fp);
    if (fs.existsSync(r)) return r;
    const s = path.join(this.projectRoot, fp.replace(/^\/app\//, ''));
    if (fs.existsSync(s)) return s;
    return null;
  }

  private extractRelevantLines(source: string, line: number | undefined, ctx: number = 40): string {
    const lines = source.split('\n');
    if (!line) return lines.slice(0, 80).map((l, i) => `${i + 1}: ${l}`).join('\n');
    const s = Math.max(0, line - ctx), e = Math.min(lines.length, line + ctx);
    return lines.slice(s, e).map((l, i) => `${s + i + 1 === line ? ' >>>' : '    '} ${s + i + 1}: ${l}`).join('\n');
  }

  private fuzzyApply(source: string, orig: string, repaired: string): string | null {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (!norm(source).includes(norm(orig))) return null;

    const lines = source.split('\n');
    const origLines = orig.split('\n').map(l => l.trim()).filter(l => l);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== origLines[0]) continue;
      let ok = true;
      for (let j = 1; j < origLines.length; j++) {
        if (i + j >= lines.length || lines[i + j].trim() !== origLines[j]) { ok = false; break; }
      }
      if (ok) {
        const indent = lines[i].match(/^(\s*)/)?.[1] || '';
        lines.splice(i, origLines.length, ...repaired.split('\n').map(l => indent + l.trim()));
        return lines.join('\n');
      }
    }
    return null;
  }

  private async runSyntaxCheck(fp: string): Promise<{ passed: boolean; output: string }> {
    const { execSync } = require('child_process');
    try {
      if (fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'))) {
        execSync(`npx tsc --noEmit --pretty false "${fp}" 2>&1`, { cwd: this.projectRoot, timeout: 30_000 });
      }
      return { passed: true, output: 'OK' };
    } catch (e: any) {
      return { passed: false, output: e.stdout?.toString()?.slice(0, 500) || e.message };
    }
  }

  private async notifyApprovalNeeded(repairId: number, tier: number, source: string, filePath: string, result: CodeRepairResult) {
    await this.db.sendMessage('health-agent', 'supervisor', 'repair_request', {
      repairId, tier, source, filePath, diagnosis: result.diagnosis,
      category: result.repairCategory, confidence: result.confidence,
    }, 'high');
  }

  private cleanup(p: string) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
  getStats() { return { ...this.repairStats }; }
}
