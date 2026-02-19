// src/health/heartbeat-client.ts
// Lightweight client that every Nova agent imports
// Sends heartbeats, reports errors, and listens for commands from Health Agent
//
// Usage in any agent:
//   import { HeartbeatClient } from './health/heartbeat-client';
//   const health = new HeartbeatClient(pool, 'scout');
//   health.start();
//
//   // In your error handlers:
//   health.reportError({ errorType: 'API_FAILURE', errorMessage: '...', severity: 'error' });
//
//   // Update current task:
//   health.setTask('scanning KOLs');

import { Pool } from 'pg';
import { Severity } from './types';

interface ErrorReport {
  errorType: string;
  errorMessage: string;
  stackTrace?: string;
  filePath?: string;
  lineNumber?: number;
  severity?: Severity;
  context?: Record<string, any>;
}

type CommandHandler = (action: string, params: Record<string, any>) => Promise<void>;

export class HeartbeatClient {
  private pool: Pool;
  private agentName: string;
  private version: string;
  private currentTask: string | null = null;
  private errorCount5Min = 0;
  private errorTimestamps: number[] = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private commandPollInterval: NodeJS.Timeout | null = null;
  private commandHandler: CommandHandler | null = null;

  constructor(pool: Pool, agentName: string, version?: string) {
    this.pool = pool;
    this.agentName = agentName;
    this.version = version || '1.0.0';
  }

  // ============================================================
  // START / STOP
  // ============================================================

  start(intervalMs: number = 60_000): void {
    // Send initial heartbeat immediately
    this.sendHeartbeat();

    // Then on interval
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);

    // Poll for commands from Health Agent
    this.commandPollInterval = setInterval(() => this.pollCommands(), 30_000);

    console.log(`[${this.agentName}] 💓 Heartbeat client started`);
  }

  stop(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.commandPollInterval) clearInterval(this.commandPollInterval);
    console.log(`[${this.agentName}] 💓 Heartbeat client stopped`);
  }

  // ============================================================
  // HEARTBEAT
  // ============================================================

  private async sendHeartbeat(): Promise<void> {
    try {
      const memUsage = process.memoryUsage();
      const memMb = Math.round(memUsage.heapUsed / 1024 / 1024);

      // Clean up old error timestamps (older than 5 min)
      const fiveMinAgo = Date.now() - 300_000;
      this.errorTimestamps = this.errorTimestamps.filter(t => t > fiveMinAgo);
      this.errorCount5Min = this.errorTimestamps.length;

      await this.pool.query(
        `INSERT INTO agent_heartbeats (agent_name, status, last_beat, memory_mb, error_count_last_5min, current_task, version)
         VALUES ($1, 'alive', NOW(), $2, $3, $4, $5)
         ON CONFLICT (agent_name) DO UPDATE SET
           status = 'alive',
           last_beat = NOW(),
           memory_mb = $2,
           error_count_last_5min = $3,
           current_task = $4,
           version = COALESCE($5, agent_heartbeats.version)`,
        [this.agentName, memMb, this.errorCount5Min, this.currentTask, this.version]
      );
    } catch (err: any) {
      // Don't let heartbeat failures crash the agent
      console.error(`[${this.agentName}] Heartbeat failed:`, err.message);
    }
  }

  // ============================================================
  // ERROR REPORTING
  // ============================================================

  async reportError(error: ErrorReport): Promise<void> {
    this.errorTimestamps.push(Date.now());

    try {
      await this.pool.query(
        `INSERT INTO agent_errors (agent_name, error_type, error_message, stack_trace, file_path, line_number, severity, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          this.agentName,
          error.errorType,
          error.errorMessage,
          error.stackTrace || null,
          error.filePath || null,
          error.lineNumber || null,
          error.severity || 'error',
          JSON.stringify(error.context || {}),
        ]
      );
    } catch (err: any) {
      console.error(`[${this.agentName}] Error reporting failed:`, err.message);
    }
  }

  /**
   * Convenience wrapper: wrap any async function with automatic error reporting
   */
  async withErrorReporting<T>(taskName: string, fn: () => Promise<T>): Promise<T | null> {
    const previousTask = this.currentTask;
    this.currentTask = taskName;

    try {
      const result = await fn();
      this.currentTask = previousTask;
      return result;
    } catch (err: any) {
      await this.reportError({
        errorType: err.name || 'Error',
        errorMessage: err.message,
        stackTrace: err.stack,
        filePath: this.extractFilePath(err.stack),
        severity: 'error',
        context: { task: taskName },
      });
      this.currentTask = previousTask;
      return null;
    }
  }

  // ============================================================
  // COMMAND HANDLING — receive instructions from Health Agent
  // ============================================================

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  private async pollCommands(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, payload FROM agent_messages
         WHERE (to_agent = $1 OR to_agent = 'broadcast')
           AND message_type = 'command'
           AND acknowledged = FALSE
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at ASC
         LIMIT 5`,
        [this.agentName]
      );

      for (const row of rows) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

        // Handle built-in commands
        if (payload.action === 'restart') {
          console.log(`[${this.agentName}] Received restart command from Health Agent`);
          await this.pool.query(`UPDATE agent_messages SET acknowledged = TRUE, acknowledged_at = NOW() WHERE id = $1`, [row.id]);
          process.exit(0); // Let pm2/docker/systemd restart us
          return;
        }

        // Forward to custom handler
        if (this.commandHandler) {
          try {
            await this.commandHandler(payload.action, payload.params || {});
          } catch (err: any) {
            console.error(`[${this.agentName}] Command handler error:`, err.message);
          }
        }

        // Acknowledge
        await this.pool.query(`UPDATE agent_messages SET acknowledged = TRUE, acknowledged_at = NOW() WHERE id = $1`, [row.id]);
      }
    } catch (err: any) {
      // Silent fail — don't let command polling crash the agent
    }
  }

  // ============================================================
  // TASK TRACKING
  // ============================================================

  setTask(task: string | null): void {
    this.currentTask = task;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private extractFilePath(stack?: string): string | null {
    if (!stack) return null;
    const match = stack.match(/(?:at\s+.*?\s+\()(\/[^:)]+\.(?:ts|js)):?(\d+)?/);
    return match ? match[1] : null;
  }
}
