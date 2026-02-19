// src/health/monitor.ts
// Nova Health Agent — Main Monitor Loop
// This is the brain. It runs in its own process and watches everything.

import { Pool } from 'pg';
import { HealthDB } from './db';
import { CodeRepairEngine } from './code-repair';
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

export class HealthMonitor {
  private db: HealthDB;
  private repair: CodeRepairEngine;
  private config: HealthConfig;
  private intervals: NodeJS.Timeout[] = [];
  private running = false;

  // Track restart attempts per agent (for restart loop detection)
  private restartAttempts: Map<string, number[]> = new Map();

  // Track last degradation rule firing to prevent spam (ruleKey → timestamp)
  private degradationCooldowns: Map<string, number> = new Map();
  private static readonly DEGRADATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  constructor(pool: Pool, config?: Partial<HealthConfig>, projectRoot?: string) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.db = new HealthDB(pool);
    this.repair = new CodeRepairEngine(this.db, this.config, projectRoot || process.cwd());
  }

  // ============================================================
  // START / STOP
  // ============================================================

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[HealthAgent] 🏥 Starting Nova Health Agent...');
    console.log(`[HealthAgent] Code repair: ${this.config.repairEnabled ? 'ENABLED' : 'DISABLED'}`);

    // Register self
    this.db.upsertHeartbeat({ agentName: 'health-agent', status: 'alive', currentTask: 'monitoring' });

    // Start monitoring loops
    this.intervals.push(
      setInterval(() => this.checkHeartbeats(), this.config.heartbeatCheckIntervalMs),
      setInterval(() => this.checkApis(), this.config.apiCheckIntervalMs),
      setInterval(() => this.generateReport(), this.config.reportIntervalMs),
      setInterval(() => this.selfHeartbeat(), 60_000),
      setInterval(() => this.db.cleanupExpiredMessages(), 300_000),
    );

    // Run initial checks
    this.checkHeartbeats();
    this.checkApis();

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

  private async checkHeartbeats(): Promise<void> {
    try {
      const heartbeats = await this.db.getAllHeartbeats();
      const now = Date.now();

      for (const hb of heartbeats) {
        if (hb.status === 'disabled') continue;

        const silentMs = now - hb.lastBeat.getTime();

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

          // Memory exceeded? Restart
          if (hb.memoryMb > this.config.memoryThresholdMb) {
            await this.triggerRestart(hb.agentName, `Memory exceeded: ${hb.memoryMb}MB > ${this.config.memoryThresholdMb}MB`);
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

        const response = await fetch(api.endpoint, fetchOptions);
        clearTimeout(timeout);

        const elapsed = Date.now() - start;
        const isUp = response.ok || response.status === 401; // 401 = auth issue but API is reachable

        const status = isUp
          ? (elapsed > this.config.apiSlowThresholdMs ? 'slow' : 'up')
          : 'down';

        await this.db.upsertApiHealth({
          apiName: api.name,
          endpoint: api.endpoint,
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
          endpoint: api.endpoint,
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

    // 4. Try to repair the code
    if (this.config.repairEnabled && error.severity !== 'info') {
      const repairResult = await this.repair.evaluateAndRepair(error, errorId);

      if (repairResult.attempted) {
        if (repairResult.applied) {
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

    // 5. If critical and not repaired, consider restart
    if (isCritical) {
      await this.triggerRestart(error.agentName, `Critical error: ${error.errorType}: ${error.errorMessage.slice(0, 100)}`);
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
      await this.db.sendMessage('health-agent', 'nova', 'command', {
        action: 'deactivate_child',
        agentName: hb.agentName,
        reason: 'No heartbeat — presumed dead',
      }, 'high');
      await this.db.setAgentStatus(hb.agentName, 'disabled');
      await this.notify(`🧹 Token child \`${hb.agentName}\` deactivated (no heartbeat). Supervisor notified.`);
      return;
    }

    await this.triggerRestart(hb.agentName, 'Agent unresponsive (no heartbeat)');
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

    // Send degradation command to affected agents
    await this.db.sendMessage('health-agent', 'broadcast', 'command', {
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
      // Restart loop detected
      console.log(`[HealthAgent] 🚨 RESTART LOOP: ${agentName} restarted ${restartsInHour}x in 1 hour. Disabling.`);
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
    await this.db.sendMessage('health-agent', agentName, 'command', {
      action: 'restart',
      reason: 'Health agent triggered restart',
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
  // HEALTH REPORT GENERATION
  // ============================================================

  async generateReport(): Promise<HealthReport> {
    const agents = await this.db.getAllHeartbeats();
    const apis = await this.db.getAllApiHealth();
    const metrics = await this.db.get24hMetrics();

    const deadCount = agents.filter(a => a.status === 'dead').length;
    const degradedCount = agents.filter(a => a.status === 'degraded').length;

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

    // Build report text
    let text = `🏥 Nova Swarm Health Report\n`;
    text += `${'═'.repeat(35)}\n\n`;

    // Agent statuses
    text += `AGENTS:\n`;
    for (const a of agents) {
      text += `${statusEmoji(a.status)} ${a.agentName} — ${a.status}`;
      if (a.status === 'alive' || a.status === 'degraded') {
        text += ` (uptime: ${uptimeStr(a)}, errors: ${a.errorCountLast5Min})`;
      }
      text += '\n';
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
  // ============================================================

  private async selfHeartbeat(): Promise<void> {
    const memUsage = process.memoryUsage();
    await this.db.upsertHeartbeat({
      agentName: 'health-agent',
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
}
