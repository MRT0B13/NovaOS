// src/health/monitor.ts
// Nova Health Agent — Main Monitor Loop
// This is the brain. It runs in its own process and watches everything.

import { Pool } from 'pg';
import { HealthDB } from './db';
import { CodeRepairEngine } from './code-repair';
import { SelfHealEngine } from './self-heal';
import {
  HealthConfig,
  DEFAULT_HEALTH_CONFIG,
  AgentHeartbeat,
  AgentError,
  ApiHealthEntry,
  HealthReport,
  DEGRADATION_RULES,
  MONITORED_APIS,
  Severity,
} from './types';
import { rotateRpc, getRpcUrl } from '../services/solanaRpc';

export class HealthMonitor {
  private db: HealthDB;
  private repair: CodeRepairEngine;
  private healer: SelfHealEngine;
  private config: HealthConfig;
  private intervals: NodeJS.Timeout[] = [];
  private running = false;

  // Track restart attempts per agent (for restart loop detection)
  private restartAttempts: Map<string, number[]> = new Map();

  // Track last degradation rule firing to prevent spam (ruleKey → timestamp)
  private degradationCooldowns: Map<string, number> = new Map();
  private static readonly DEGRADATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  // Track memory escalation history per agent (agentName → current limit MB)
  private memoryLimits: Map<string, number> = new Map();

  constructor(pool: Pool, config?: Partial<HealthConfig>, projectRoot?: string) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.db = new HealthDB(pool);
    this.repair = new CodeRepairEngine(this.db, this.config, projectRoot || process.cwd());
    this.healer = new SelfHealEngine(this.db, this.repair, this.config, projectRoot || process.cwd());
  }

  // ============================================================
  // START / STOP
  // ============================================================

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[HealthAgent] 🏥 Starting Nova Health Agent...');
    console.log(`[HealthAgent] Code repair: ${this.config.repairEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`[HealthAgent] Self-healing: ${this.config.repairEnabled ? 'ENABLED (diagnose → fix → verify → redeploy)' : 'DISABLED'}`);

    // Load persisted LLM provider preference before anything else
    this.repair.loadPersistedProvider().catch(() => {});

    // Register self (uses 'health-monitor' to disambiguate from standalone pm2 health-agent)
    this.db.upsertHeartbeat({ agentName: 'health-monitor', status: 'alive', currentTask: 'monitoring' });

    // Start monitoring loops
    this.intervals.push(
      setInterval(() => this.checkHeartbeats(), this.config.heartbeatCheckIntervalMs),
      setInterval(() => this.checkApis(), this.config.apiCheckIntervalMs),
      setInterval(() => this.generateReport(), this.config.reportIntervalMs),
      setInterval(() => this.selfHeartbeat(), 60_000),
      setInterval(() => this.db.cleanupExpiredMessages(), 300_000),
    );

    // Run initial checks (heartbeats only — skip initial API check to avoid
    // degradation rule spam on startup before services are fully warmed up)
    this.checkHeartbeats();

    console.log('[HealthAgent] ✅ All monitoring loops active');
  }

  stop(): void {
    this.running = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    console.log('[HealthAgent] 🛑 Stopped');
  }

  // ============================================================
  // HEARTBEAT MONITORING
  // ============================================================

  // Names that belong to this monitor process — never attempt self-restart
  private static readonly SELF_NAMES = new Set(['health-monitor', 'health-agent']);

  private async checkHeartbeats(): Promise<void> {
    try {
      const heartbeats = await this.db.getAllHeartbeats();
      const now = Date.now();
      const ghostThreshold = 24 * 3600_000;      // 24h — remove truly dead ecosystem ghosts
      const userGhostThreshold = 2 * 3600_000;   // 2h  — remove dead/disabled user agents faster
      const disabledThreshold = 4 * 3600_000;    // 4h  — clean disabled ecosystem agents

      for (const hb of heartbeats) {
        // Never try to restart ourselves — that's a restart loop by definition
        if (HealthMonitor.SELF_NAMES.has(hb.agentName)) continue;

        const silentMs = now - hb.lastBeat.getTime();
        const isUserAgent = hb.agentCategory === 'user' || hb.agentName.startsWith('user-agent-');

        // CLEANUP: disabled agents — remove after threshold
        if (hb.status === 'disabled') {
          const threshold = isUserAgent ? userGhostThreshold : disabledThreshold;
          if (silentMs > threshold) {
            console.log(`[HealthAgent] 🗑️ Removing disabled agent: ${hb.displayName || hb.agentName} (silent ${Math.round(silentMs / 60_000)}m, category: ${hb.agentCategory})`);
            try {
              await this.db.getPool().query(`DELETE FROM agent_heartbeats WHERE agent_name = $1`, [hb.agentName]);
            } catch { /* non-fatal */ }
          }
          continue;
        }

        // GHOST: dead for >threshold — remove stale row entirely (old runs, examples, etc.)
        const deadThreshold = isUserAgent ? userGhostThreshold : ghostThreshold;
        if (silentMs > deadThreshold && hb.status === 'dead') {
          console.log(`[HealthAgent] 🗑️ Removing ghost agent: ${hb.displayName || hb.agentName} (silent ${Math.round(silentMs / 3600_000)}h, category: ${hb.agentCategory})`);
          try {
            await this.db.getPool().query(`DELETE FROM agent_heartbeats WHERE agent_name = $1`, [hb.agentName]);
          } catch { /* non-fatal */ }
          continue;
        }

        // DEAD: no heartbeat beyond threshold
        if (silentMs > this.config.heartbeatDeadThresholdMs) {
          if (hb.status !== 'dead') {
            console.log(`[HealthAgent] 💀 ${hb.agentName} is DEAD (silent ${Math.round(silentMs / 1000)}s)`);
            await this.db.setAgentStatus(hb.agentName, 'dead');
            await this.handleDeadAgent(hb);
          }
          continue;
        }

        // DEGRADED: high error rate or resource usage
        if (hb.errorCountLast5Min > 10 || hb.memoryMb > this.config.memoryThresholdMb) {
          if (hb.status !== 'degraded') {
            console.log(`[HealthAgent] ⚠️ ${hb.agentName} is DEGRADED (errors: ${hb.errorCountLast5Min}, mem: ${hb.memoryMb}MB)`);
            await this.db.setAgentStatus(hb.agentName, 'degraded');
          }

          // Memory exceeded? Try scaling first, then restart
          if (hb.memoryMb > this.config.memoryThresholdMb) {
            const scaled = await this.tryScaleMemory(hb.agentName, hb.memoryMb);
            if (!scaled) {
              // At ceiling — fall back to restart
              await this.triggerRestart(hb.agentName, `Memory exceeded: ${hb.memoryMb}MB > ${this.config.memoryThresholdMb}MB (at memory ceiling)`);
            }
          }
          continue;
        }

        // WARNING: approaching stale
        if (silentMs > this.config.heartbeatWarnThresholdMs && hb.status === 'alive') {
          console.log(`[HealthAgent] 🟡 ${hb.agentName} heartbeat delayed (${Math.round(silentMs / 1000)}s)`);
        }
      }
    } catch (err: any) {
      console.error('[HealthAgent] Heartbeat check failed:', err.message);
    }
  }

  // ============================================================
  // API HEALTH CHECKS
  // ============================================================

  private async checkApis(): Promise<void> {
    for (const api of MONITORED_APIS) {
      // Skip API checks for services without configured credentials
      if (api.name === 'Anthropic' && !process.env.ANTHROPIC_API_KEY) continue;
      if (api.name === 'OpenAI' && !process.env.OPENAI_API_KEY) continue;
      if (api.name === 'Twitter API' && !process.env.TWITTER_BEARER_TOKEN && !process.env.TWITTER_API_KEY) continue;

      // Use the active RPC URL for Solana health checks (not the static one in MONITORED_APIS)
      const endpoint = api.name === 'Solana RPC' ? getRpcUrl() : api.endpoint;

      try {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), api.timeoutMs);

        const fetchOptions: RequestInit = {
          method: api.method,
          signal: controller.signal,
          headers: {} as Record<string, string>,
        };

        // Add auth headers where needed
        if (api.name === 'Twitter API' && process.env.TWITTER_BEARER_TOKEN) {
          (fetchOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${process.env.TWITTER_BEARER_TOKEN}`;
        }
        if (api.name === 'OpenAI' && process.env.OPENAI_API_KEY) {
          (fetchOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
        }
        if (api.name === 'Anthropic' && process.env.ANTHROPIC_API_KEY) {
          (fetchOptions.headers as Record<string, string>)['x-api-key'] = process.env.ANTHROPIC_API_KEY;
          (fetchOptions.headers as Record<string, string>)['anthropic-version'] = '2023-06-01';
          fetchOptions.body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
          (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
        if (api.name === 'Solana RPC') {
          fetchOptions.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' });
          (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }

        const response = await fetch(endpoint, fetchOptions);
        clearTimeout(timeout);

        const elapsed = Date.now() - start;
        const isUp = response.ok || response.status === 401; // 401 = auth issue but API is reachable

        const status = isUp
          ? (elapsed > this.config.apiSlowThresholdMs ? 'slow' : 'up')
          : 'down';

        await this.db.upsertApiHealth({
          apiName: api.name,
          endpoint: endpoint,
          status: status as any,
          responseTimeMs: elapsed,
          consecutiveFailures: status === 'down' ? 1 : 0, // Will be incremented in DB on conflict
        });

        if (status === 'down') {
          await this.handleApiDown(api.name, `HTTP ${response.status}`);
        }
      } catch (err: any) {
        await this.db.upsertApiHealth({
          apiName: api.name,
          endpoint: endpoint,
          status: 'down',
          responseTimeMs: api.timeoutMs,
          consecutiveFailures: 1,
          lastFailureReason: err.message,
        });
        await this.handleApiDown(api.name, err.message);
      }
    }
  }

  // ============================================================
  // ERROR HANDLER — called by agents when they catch errors
  // This is the main integration point with the repair engine
  // ============================================================

  async handleError(error: AgentError): Promise<void> {
    // 1. Log the error
    const errorId = await this.db.logError(error);

    // 2. Check if it's critical
    const isCritical = this.config.criticalErrorPatterns.some(
      pattern => error.errorMessage.includes(pattern) || error.errorType.includes(pattern)
    );

    if (isCritical) {
      console.log(`[HealthAgent] 🚨 CRITICAL error from ${error.agentName}: ${error.errorType}`);
    }

    // 3. Check error rate for this agent
    const errorRate = await this.db.getErrorRate(error.agentName, this.config.errorWindowMs);
    if (errorRate > this.config.errorRateThreshold) {
      console.log(`[HealthAgent] ⚠️ ${error.agentName} error rate: ${(errorRate * 100).toFixed(1)}% — triggering intervention`);
    }

    // 4. Try to repair the code (Tier 1/2 quick fixes)
    let repairApplied = false;
    if (this.config.repairEnabled && error.severity !== 'info') {
      const repairResult = await this.repair.evaluateAndRepair(error, errorId);

      if (repairResult.attempted) {
        if (repairResult.applied) {
          repairApplied = true;
          console.log(`[HealthAgent] ✅ Auto-repaired ${error.filePath}: ${repairResult.diagnosis}`);
          await this.notify(`✅ Auto-repaired error in ${error.agentName}:\n${repairResult.diagnosis}`);
        } else if (repairResult.needsApproval) {
          console.log(`[HealthAgent] 🔧 Repair needs approval (#${repairResult.repairId}): ${repairResult.diagnosis}`);
          await this.notify(
            `🔧 Repair needs your approval (#${repairResult.repairId}):\n` +
            `Agent: ${error.agentName}\n` +
            `Error: ${error.errorType}\n` +
            `Diagnosis: ${repairResult.diagnosis}\n` +
            `Reply /approve ${repairResult.repairId} or /reject ${repairResult.repairId}`
          );
        }
      }
    }

    // 5. If critical and not repaired by quick fix, escalate to full self-heal
    if (isCritical && !repairApplied) {
      const recentErrors = await this.db.getRecentErrors(error.agentName, 300_000);
      const healResult = await this.healer.heal(
        error.agentName,
        'critical_error',
        recentErrors.length > 0 ? recentErrors : [error],
        (msg) => this.notify(msg),
      );

      if (!healResult.success) {
        // Self-heal failed — fall back to restart
        await this.triggerRestart(error.agentName, `Critical error: ${error.errorType}: ${error.errorMessage.slice(0, 100)}`);
      }
    }
  }

  // ============================================================
  // DEAD AGENT HANDLER
  // ============================================================

  private async handleDeadAgent(hb: AgentHeartbeat): Promise<void> {
    const errorId = await this.db.logError({
      agentName: hb.agentName,
      errorType: 'AGENT_DEAD',
      errorMessage: `No heartbeat for ${Math.round((Date.now() - hb.lastBeat.getTime()) / 1000)} seconds`,
      severity: 'critical',
    });

    // Check if this is a token-child agent (runs in-process, can't be pm2-restarted)
    const isChildAgent = await this.isTokenChildAgent(hb.agentName);
    if (isChildAgent) {
      console.log(`[HealthAgent] 🧹 Token child ${hb.agentName} is dead — requesting Supervisor deactivation`);
      await this.db.sendMessage('health-monitor', 'nova', 'command', {
        action: 'deactivate_child',
        agentName: hb.agentName,
        reason: 'No heartbeat — presumed dead',
      }, 'high');
      await this.db.setAgentStatus(hb.agentName, 'disabled');
      await this.notify(`🧹 Token child \`${hb.agentName}\` deactivated (no heartbeat). Supervisor notified.`);
      return;
    }

    // First, try a simple restart
    const restartsInHour = await this.db.getRestartsInWindow(hb.agentName, 3600_000);
    if (restartsInHour < this.config.escalateAfterFailures) {
      // Not enough failures yet — try simple restart first
      await this.triggerRestart(hb.agentName, 'Agent unresponsive (no heartbeat)');
      return;
    }

    // Multiple failures — try self-healing before restart
    console.log(`[HealthAgent] 🔧 ${hb.agentName} died ${restartsInHour}x — attempting self-heal...`);
    const recentErrors = await this.db.getRecentErrors(hb.agentName, 3600_000);
    const healResult = await this.healer.heal(
      hb.agentName,
      'dead_agent',
      recentErrors,
      (msg) => this.notify(msg),
    );

    if (!healResult.success) {
      // Self-heal failed — fall back to basic restart (which may trigger restart-loop handler)
      await this.triggerRestart(hb.agentName, 'Agent unresponsive (no heartbeat) — self-heal failed');
    }
  }

  /**
   * Check agent_registry to determine if an agent is a token-child type.
   * Token children run in-process and should be deactivated, not restarted via pm2.
   */
  private async isTokenChildAgent(agentName: string): Promise<boolean> {
    try {
      const { rows } = await this.db.getPool().query(
        `SELECT agent_type FROM agent_registry WHERE agent_name = $1`,
        [agentName]
      );
      return rows.length > 0 && rows[0].agent_type === 'token-child';
    } catch {
      // If agent_registry lookup fails, fall back to name-based detection
      return agentName.startsWith('child-');
    }
  }

  // ============================================================
  // API DOWN HANDLER — triggers degradation rules
  // ============================================================

  private async handleApiDown(apiName: string, reason: string): Promise<void> {
    // Map API names to degradation rule keys
    const ruleMap: Record<string, string> = {
      'Twitter API': reason.includes('429') ? 'twitter_429' : 'twitter_503',
      'OpenAI': 'openai_down',
      'Anthropic': 'anthropic_down',
      'Solana RPC': 'solana_rpc_error',
    };

    const ruleKey = ruleMap[apiName];
    if (!ruleKey) return;

    const rule = DEGRADATION_RULES[ruleKey];
    if (!rule) return;

    // Cooldown: don't fire the same degradation rule more than once per 30 min
    const lastFired = this.degradationCooldowns.get(ruleKey) || 0;
    if (Date.now() - lastFired < HealthMonitor.DEGRADATION_COOLDOWN_MS) return;
    this.degradationCooldowns.set(ruleKey, Date.now());

    console.log(`[HealthAgent] 🔄 Applying degradation rule: ${ruleKey} → ${rule.action}`);

    // Apply switch_model directly to the repair engine (no message bus roundtrip needed)
    if (rule.action === 'switch_model' && rule.params?.fallback) {
      const fallback = rule.params.fallback as 'anthropic' | 'openai';
      // Skip entirely if already on the target provider — no notification, no broadcast
      if (this.repair.getProvider() === fallback) {
        console.log(`[HealthAgent] Repair engine already on ${fallback}, skipping`);
        return;
      }
      this.repair.switchProvider(fallback);
      console.log(`[HealthAgent] ✅ Repair engine switched to ${fallback}`);
    }

    // Apply rotate_rpc — cycle to the next backup Solana RPC
    if (rule.action === 'rotate_rpc') {
      const newRpc = rotateRpc();
      if (newRpc) {
        console.log(`[HealthAgent] ✅ Solana RPC rotated to ${newRpc}`);
      } else {
        console.log(`[HealthAgent] ⚠️ RPC rotation skipped (cooldown or no backups)`);
      }
    }

    // Send degradation command to affected agents
    await this.db.sendMessage('health-monitor', 'broadcast', 'command', {
      action: rule.action,
      params: rule.params,
      reason: `${apiName}: ${reason}`,
    }, 'high', 3600_000);

    if (rule.notify && rule.message) {
      await this.notify(rule.message);
    }
  }

  // ============================================================
  // RESTART LOGIC
  // ============================================================

  private async triggerRestart(agentName: string, reason: string): Promise<void> {
    // Check restart rate
    const restartsInHour = await this.db.getRestartsInWindow(agentName, 3600_000);

    if (restartsInHour >= this.config.maxRestartsPerHour) {
      // Restart loop detected — try scaling memory before giving up
      const scaled = await this.tryScaleMemory(agentName, 0, reason);
      if (scaled) {
        console.log(`[HealthAgent] 📈 Restart loop for ${agentName} — scaled memory instead of disabling`);
        // Reset restart count by clearing the window, then do one more restart with new limit
        await this.executeRestart(agentName);
        return;
      }

      // At ceiling and still looping — try self-healing before disabling
      console.log(`[HealthAgent] 🔧 Restart loop for ${agentName} — attempting self-heal before disabling...`);
      const recentErrors = await this.db.getRecentErrors(agentName, 3600_000);
      const healResult = await this.healer.heal(
        agentName,
        'restart_loop',
        recentErrors,
        (msg) => this.notify(msg),
      );

      if (healResult.success) {
        console.log(`[HealthAgent] ✅ Self-heal resolved restart loop for ${agentName}`);
        return; // Healer handles redeploy + recovery monitoring
      }

      // Self-heal failed — disable as last resort
      console.log(`[HealthAgent] 🚨 RESTART LOOP: ${agentName} restarted ${restartsInHour}x in 1 hour. Self-heal failed. Disabling.`);
      await this.db.setAgentStatus(agentName, 'disabled');
      await this.notify(
        DEGRADATION_RULES.restart_loop.message!
          .replace('{agentName}', agentName)
          .replace('{count}', String(restartsInHour))
      );
      return;
    }

    console.log(`[HealthAgent] 🔄 Restarting ${agentName}: ${reason}`);
    const restartId = await this.db.logRestart(agentName, reason);
    const startTime = Date.now();

    try {
      // Execute restart via process manager
      await this.executeRestart(agentName);

      // Wait for the agent to come back alive (check heartbeat)
      const recovered = await this.waitForRecovery(agentName, 60_000);
      const recoveryTime = Date.now() - startTime;

      await this.db.updateRestartResult(restartId, recovered, recoveryTime);

      if (recovered) {
        console.log(`[HealthAgent] ✅ ${agentName} recovered in ${recoveryTime}ms`);
        await this.db.setAgentStatus(agentName, 'alive');
      } else {
        console.log(`[HealthAgent] ❌ ${agentName} failed to recover`);
        await this.notify(`❌ ${agentName} failed to recover after restart. Reason: ${reason}`);
      }
    } catch (err: any) {
      await this.db.updateRestartResult(restartId, false, Date.now() - startTime);
      console.error(`[HealthAgent] Restart of ${agentName} failed:`, err.message);
    }
  }

  private async executeRestart(agentName: string): Promise<void> {
    const { execSync } = require('child_process');

    // Try pm2 first (most likely in production)
    try {
      execSync(`pm2 restart ${agentName} 2>&1`, { timeout: 30_000 });
      return;
    } catch {}

    // Try docker
    try {
      execSync(`docker restart nova-${agentName} 2>&1`, { timeout: 30_000 });
      return;
    } catch {}

    // Try systemctl
    try {
      execSync(`systemctl restart nova-${agentName} 2>&1`, { timeout: 30_000 });
      return;
    } catch {}

    // Fallback: send restart command via message bus
    await this.db.sendMessage('health-monitor', agentName, 'command', {
      action: 'restart',
      reason: 'Health monitor triggered restart',
    }, 'critical');
  }

  private async waitForRecovery(agentName: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const checkInterval = 5_000;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, checkInterval));

      const heartbeats = await this.db.getAllHeartbeats();
      const agent = heartbeats.find(h => h.agentName === agentName);

      if (agent && agent.status === 'alive' && agent.lastBeat.getTime() > start) {
        return true;
      }
    }

    return false;
  }

  // ============================================================
  // DYNAMIC MEMORY SCALING
  // ============================================================

  /**
   * Try to increase an agent's PM2 memory limit when it's under pressure.
   * Returns true if memory was scaled, false if at ceiling or scaling disabled.
   *
   * How it works:
   * 1. Check current PM2 max_memory_restart for the process
   * 2. If below ceiling, bump by memoryScaleStepMb
   * 3. Update PM2 config at runtime via `pm2 set` and restart
   * 4. Also update the ecosystem.config.cjs for persistence
   * 5. Notify admin of the escalation
   */
  private async tryScaleMemory(agentName: string, currentUsageMb: number, reason?: string): Promise<boolean> {
    if (!this.config.memoryScaleEnabled) return false;

    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    // Get current PM2 memory limit for this process
    let currentLimitMb = this.memoryLimits.get(agentName) || 0;

    if (!currentLimitMb) {
      // Read from PM2 runtime
      try {
        const pm2Info = execSync(`pm2 jlist 2>/dev/null`, { timeout: 10_000 }).toString();
        const processes = JSON.parse(pm2Info);
        const proc = processes.find((p: any) => p.name === agentName);
        if (proc?.pm2_env?.max_memory_restart) {
          // PM2 stores as bytes
          currentLimitMb = Math.round(proc.pm2_env.max_memory_restart / (1024 * 1024));
        }
      } catch {
        // Can't read PM2 — try ecosystem config
        currentLimitMb = this.readEcosystemMemoryLimit(agentName);
      }

      if (!currentLimitMb) {
        // Default fallback
        currentLimitMb = this.config.memoryThresholdMb;
      }

      this.memoryLimits.set(agentName, currentLimitMb);
    }

    // Check if already at ceiling
    if (currentLimitMb >= this.config.memoryScaleCeilingMb) {
      console.log(`[HealthAgent] 📊 ${agentName} already at memory ceiling (${currentLimitMb}MB / ${this.config.memoryScaleCeilingMb}MB)`);
      return false;
    }

    // Check system free memory before scaling
    const freeSystemMb = this.getSystemFreeMemoryMb();
    if (freeSystemMb < this.config.memoryScaleMinFreeSystemMb) {
      console.log(`[HealthAgent] ⚠️ Cannot scale ${agentName} memory — system free RAM too low (${freeSystemMb}MB free, need ${this.config.memoryScaleMinFreeSystemMb}MB)`);
      await this.notify(`⚠️ ${agentName} needs more memory but system RAM is low (${freeSystemMb}MB free). Manual intervention needed.`);
      return false;
    }

    // Calculate new limit
    const newLimitMb = Math.min(
      currentLimitMb + this.config.memoryScaleStepMb,
      this.config.memoryScaleCeilingMb
    );

    console.log(`[HealthAgent] 📈 Scaling ${agentName} memory: ${currentLimitMb}MB → ${newLimitMb}MB`);

    // 1. Update PM2 at runtime
    try {
      const newLimitBytes = newLimitMb * 1024 * 1024;
      execSync(`pm2 set ${agentName}:max_memory_restart ${newLimitBytes} 2>&1`, { timeout: 10_000 });
    } catch {
      // pm2 set might not work for all versions — fall through to ecosystem update
    }

    // 2. Update ecosystem.config.cjs for persistence across deploys
    try {
      this.updateEcosystemMemoryLimit(agentName, newLimitMb);
    } catch (err: any) {
      console.warn(`[HealthAgent] Could not update ecosystem.config.cjs: ${err.message}`);
    }

    // 3. Also update our internal threshold so the degradation check uses the new value
    if (agentName === 'nova-main' || agentName === 'nova') {
      this.config.memoryThresholdMb = newLimitMb;
    }

    // 4. Track the new limit
    this.memoryLimits.set(agentName, newLimitMb);

    // 5. Log to DB
    await this.db.logError({
      agentName: 'health-monitor',
      errorType: 'MEMORY_SCALED',
      errorMessage: `Scaled ${agentName} memory: ${currentLimitMb}MB → ${newLimitMb}MB. ` +
        `Reason: ${reason || `usage ${currentUsageMb}MB exceeded ${currentLimitMb}MB`}. ` +
        `System free: ${freeSystemMb}MB. Ceiling: ${this.config.memoryScaleCeilingMb}MB.`,
      severity: 'warning',
    });

    // 6. Notify admin
    const msg = DEGRADATION_RULES.memory_scaled?.message
      ?.replace('{agentName}', agentName)
      .replace('{oldLimit}', String(currentLimitMb))
      .replace('{newLimit}', String(newLimitMb))
      .replace('{memoryMb}', String(currentUsageMb || 'N/A'))
      || `📈 ${agentName} memory scaled: ${currentLimitMb}MB → ${newLimitMb}MB`;
    await this.notify(msg);

    return true;
  }

  /**
   * Read memory limit for an agent from ecosystem.config.cjs
   */
  private readEcosystemMemoryLimit(agentName: string): number {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.resolve(process.cwd(), 'ecosystem.config.cjs');
      const content = fs.readFileSync(configPath, 'utf-8');

      // Parse max_memory_restart for the matching app name
      // Matches patterns like: max_memory_restart: '1G' or '512M' or '2048M'
      const appRegex = new RegExp(
        `name:\\s*['"]${agentName.replace('-', '[-_]')}['"][\\s\\S]*?max_memory_restart:\\s*['"]([^'"]+)['"]`
      );
      const match = content.match(appRegex);
      if (match) {
        const val = match[1];
        if (val.endsWith('G')) return parseInt(val) * 1024;
        if (val.endsWith('M')) return parseInt(val);
        return parseInt(val) / (1024 * 1024); // Assume bytes
      }
    } catch {}
    return 0;
  }

  /**
   * Update ecosystem.config.cjs with a new memory limit for an agent.
   * This ensures the change persists across redeploys.
   */
  private updateEcosystemMemoryLimit(agentName: string, newLimitMb: number): void {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.resolve(process.cwd(), 'ecosystem.config.cjs');

    let content = fs.readFileSync(configPath, 'utf-8');

    // Find the app block for this agent and update max_memory_restart
    // Convert to human-readable: use 'G' for GB values, 'M' for MB
    const newVal = newLimitMb >= 1024
      ? `'${(newLimitMb / 1024).toFixed(0)}G'`
      : `'${newLimitMb}M'`;

    // Match the specific app's max_memory_restart line
    // We need to find the right app block first
    const namePattern = agentName.replace('-', '[-_]');
    const blockRegex = new RegExp(
      `(name:\\s*['"]${namePattern}['"][\\s\\S]*?max_memory_restart:\\s*)['"][^'"]+['"]`
    );

    if (blockRegex.test(content)) {
      content = content.replace(blockRegex, `$1${newVal}`);
      fs.writeFileSync(configPath, content, 'utf-8');
      console.log(`[HealthAgent] ✅ Updated ecosystem.config.cjs: ${agentName} max_memory_restart → ${newVal}`);
    } else {
      console.warn(`[HealthAgent] Could not find max_memory_restart for ${agentName} in ecosystem.config.cjs`);
    }
  }

  /**
   * Get available system free memory in MB.
   * Works on Linux (reads /proc/meminfo) with fallback to Node's os.freemem().
   */
  private getSystemFreeMemoryMb(): number {
    try {
      const fs = require('fs');
      // Linux: /proc/meminfo has MemAvailable which accounts for cached/buffer memory
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
      const available = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (available) {
        return Math.round(parseInt(available[1]) / 1024);
      }
    } catch {}

    // Fallback: Node os module
    const os = require('os');
    return Math.round(os.freemem() / (1024 * 1024));
  }

  // ============================================================
  // HEALTH REPORT GENERATION
  // ============================================================

  async generateReport(): Promise<HealthReport> {
    const allAgents = await this.db.getAllHeartbeats();
    // Filter out ghost agents (dead for >24h — stale rows from old runs)
    const ghostThreshold = Date.now() - 24 * 3600_000;
    const userGhostThreshold = Date.now() - 2 * 3600_000;
    const agents = allAgents.filter(a => {
      const isUser = a.agentCategory === 'user' || a.agentName.startsWith('user-agent-');
      const threshold = isUser ? userGhostThreshold : ghostThreshold;
      if (a.status === 'dead' && a.lastBeat.getTime() < threshold) {
        return false; // Exclude ghosts
      }
      return true;
    });

    // Separate ecosystem vs user agents
    const ecosystemAgents = agents.filter(a => a.agentCategory !== 'user' && !a.agentName.startsWith('user-agent-'));
    const userAgents = agents.filter(a => a.agentCategory === 'user' || a.agentName.startsWith('user-agent-'));

    const apis = await this.db.getAllApiHealth();
    const metrics = await this.db.get24hMetrics();

    const deadCount = ecosystemAgents.filter(a => a.status === 'dead').length;
    const degradedCount = ecosystemAgents.filter(a => a.status === 'degraded').length;

    const overallStatus = deadCount > 0 ? 'critical' : degradedCount > 0 ? 'degraded' : 'healthy';

    const statusEmoji = (s: string) => {
      switch (s) {
        case 'alive': case 'up': return '🟢';
        case 'degraded': case 'slow': return '🟡';
        case 'dead': case 'down': return '🔴';
        case 'disabled': return '⚫';
        default: return '⚪';
      }
    };

    const uptimeStr = (hb: AgentHeartbeat) => {
      const ms = Date.now() - hb.uptimeStarted.getTime();
      const hours = Math.floor(ms / 3600_000);
      return `${hours}h`;
    };

    const agentLine = (a: AgentHeartbeat) => {
      const name = a.displayName || a.agentName;
      let line = `${statusEmoji(a.status)} ${name} — ${a.status}`;
      if (a.status === 'alive' || a.status === 'degraded') {
        line += ` (uptime: ${uptimeStr(a)}, errors: ${a.errorCountLast5Min})`;
      }
      return line;
    };

    // Build report text
    let text = `🏥 Nova Swarm Health Report\n`;
    text += `${'═'.repeat(35)}\n\n`;

    // Ecosystem agent statuses
    text += `ECOSYSTEM AGENTS (${ecosystemAgents.length}):\n`;
    for (const a of ecosystemAgents) {
      text += agentLine(a) + '\n';
    }

    // User agent statuses (if any)
    if (userAgents.length > 0) {
      text += `\nUSER AGENTS (${userAgents.length}):\n`;
      for (const a of userAgents) {
        text += agentLine(a) + '\n';
      }
    }

    // API statuses
    text += `\nEXTERNAL APIS:\n`;
    for (const api of apis) {
      text += `${statusEmoji(api.status)} ${api.apiName} — ${api.responseTimeMs}ms`;
      if (api.consecutiveFailures > 0) text += ` (${api.consecutiveFailures} failures)`;
      text += '\n';
    }

    // 24h summary
    text += `\nLAST 24H:\n`;
    text += `Errors: ${metrics.totalErrors} | Restarts: ${metrics.totalRestarts} | Repairs: ${metrics.totalRepairs}\n`;
    if (metrics.pendingRepairs > 0) {
      text += `⚠️ ${metrics.pendingRepairs} repair(s) awaiting approval\n`;
    }

    // Memory
    const totalMem = agents.reduce((sum, a) => sum + a.memoryMb, 0);
    text += `\nMemory: ${totalMem.toFixed(0)}MB total across ${agents.length} agents`;

    // Memory scaling status
    if (this.memoryLimits.size > 0) {
      text += `\n\nMEMORY LIMITS:`;
      for (const [name, limitMb] of this.memoryLimits) {
        const agent = agents.find(a => a.agentName === name);
        const usage = agent ? `${agent.memoryMb}MB used` : 'offline';
        const pct = agent ? `(${Math.round((agent.memoryMb / limitMb) * 100)}%)` : '';
        text += `\n  ${name}: ${limitMb}MB limit — ${usage} ${pct}`;
      }
      text += `\n  Ceiling: ${this.config.memoryScaleCeilingMb}MB | Auto-scale: ${this.config.memoryScaleEnabled ? 'ON' : 'OFF'}`;
    }

    const report: HealthReport = {
      agents,
      apis,
      metrics: {
        totalErrors24h: metrics.totalErrors,
        totalRestarts24h: metrics.totalRestarts,
        totalRepairs24h: metrics.totalRepairs,
        pendingRepairs: metrics.pendingRepairs,
        overallStatus,
      },
      text,
    };

    // Save and send
    const postedTo: string[] = ['log'];
    console.log(`\n${report.text}\n`);

    if (this.config.reportToTelegram) {
      await this.notify(report.text);
      postedTo.push('telegram');
    }

    await this.db.saveReport(report, postedTo);

    return report;
  }

  // ============================================================
  // SELF HEARTBEAT — Health Agent monitors itself too
  // Uses 'health-monitor' name (not 'health-agent') to disambiguate the in-process
  // health monitor from the optional standalone pm2 health-agent process.

  private async selfHeartbeat(): Promise<void> {
    const memUsage = process.memoryUsage();
    await this.db.upsertHeartbeat({
      agentName: 'health-monitor',
      status: 'alive',
      memoryMb: Math.round(memUsage.heapUsed / 1024 / 1024),
      currentTask: 'monitoring',
    });
  }

  // ============================================================
  // NOTIFICATION — sends to Telegram
  // ============================================================

  private async notify(message: string): Promise<void> {
    // Integration point: send to your Telegram bot
    // Uses the same TG bot token as Nova's community module
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.config.adminChatId || process.env.ADMIN_CHAT_ID;

    if (!botToken || !chatId) {
      console.log('[HealthAgent] TG notification (no bot configured):', message.slice(0, 100));
      return;
    }

    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      });
    } catch (err: any) {
      console.error('[HealthAgent] TG notification failed:', err.message);
    }
  }

  // ============================================================
  // PUBLIC API — for other agents to use
  // ============================================================

  getDB(): HealthDB { return this.db; }
  getRepairEngine(): CodeRepairEngine { return this.repair; }
  getSelfHealer(): SelfHealEngine { return this.healer; }
}
