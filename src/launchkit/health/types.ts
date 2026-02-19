// src/health/types.ts
// Health Agent type definitions and configuration

// ============================================================
// CONFIGURATION
// ============================================================

export interface HealthConfig {
  // Heartbeat monitoring
  heartbeatCheckIntervalMs: number;   // How often Health Agent polls heartbeats
  heartbeatDeadThresholdMs: number;   // No beat in this long = dead
  heartbeatWarnThresholdMs: number;   // No beat in this long = warning

  // Auto-restart
  maxRestartsPerHour: number;
  restartCooldownMs: number;
  escalateAfterFailures: number;

  // Error tracking
  errorWindowMs: number;              // Rolling window for error rate
  errorRateThreshold: number;         // >this = unhealthy (0-1)
  criticalErrorPatterns: string[];    // Patterns that trigger immediate action

  // Resource limits
  memoryThresholdMb: number;
  cpuThresholdPercent: number;

  // API health checks
  apiCheckIntervalMs: number;
  apiSlowThresholdMs: number;
  apiDownAfterFailures: number;

  // Reporting
  reportIntervalMs: number;           // How often to post health reports
  reportToTelegram: boolean;

  // Code repair
  repairEnabled: boolean;
  repairModel: string;                // LLM model for code analysis
  repairRequiresApproval: string[];   // File patterns requiring human approval
  repairAutoApprove: string[];        // File patterns safe to auto-fix

  // Notification
  adminChatId?: string;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  heartbeatCheckIntervalMs: 30_000,     // 30 seconds
  heartbeatDeadThresholdMs: 180_000,    // 3 minutes
  heartbeatWarnThresholdMs: 120_000,    // 2 minutes

  maxRestartsPerHour: 3,
  restartCooldownMs: 60_000,            // 1 minute
  escalateAfterFailures: 3,

  errorWindowMs: 300_000,               // 5 minute window
  errorRateThreshold: 0.3,
  criticalErrorPatterns: [
    'ECONNREFUSED',
    'ENOTFOUND',
    'Twitter API 429',
    'Twitter API 503',
    'OpenAI timeout',
    'Solana RPC error',
    'FATAL',
    'out of memory',
    'Cannot find module',
    'SyntaxError',
    'TypeError',
  ],

  memoryThresholdMb: 512,
  cpuThresholdPercent: 80,

  apiCheckIntervalMs: 60_000,
  apiSlowThresholdMs: 3_000,
  apiDownAfterFailures: 3,

  reportIntervalMs: 6 * 60 * 60 * 1000,  // 6 hours
  reportToTelegram: true,

  repairEnabled: true,
  repairModel: 'claude-sonnet-4-20250514',
  repairRequiresApproval: [
    '**/wallet/**',
    '**/launcher/**',
    '**/token/**',
    '**/transaction/**',
    '**/deploy/**',
    '**/auth/**',
    '**/keys/**',
  ],
  repairAutoApprove: [
    '**/config/**',
    '**/constants.ts',
    '**/endpoints.ts',
    '**/rpc.ts',
    '**/*.env*',
    '**/rate-limit*',
    '**/timeout*',
  ],
};

// ============================================================
// TYPES
// ============================================================

export type AgentStatus = 'alive' | 'degraded' | 'dead' | 'disabled';
export type Severity = 'info' | 'warning' | 'error' | 'critical';
export type RestartType = 'full' | 'soft' | 'feature_disable' | 'rpc_rotate' | 'model_switch';
export type ApiStatus = 'up' | 'slow' | 'down' | 'unknown';
export type RepairCategory =
  | 'config_fix'
  | 'api_endpoint'
  | 'rpc_rotation'
  | 'model_fallback'
  | 'rate_limit_adjust'
  | 'import_fix'
  | 'query_fix'
  | 'type_fix'
  | 'retry_logic'
  | 'other';

export interface AgentHeartbeat {
  agentName: string;
  status: AgentStatus;
  lastBeat: Date;
  uptimeStarted: Date;
  memoryMb: number;
  cpuPercent: number;
  errorCountLast5Min: number;
  currentTask: string | null;
  version: string | null;
}

export interface AgentError {
  id?: number;
  agentName: string;
  errorType: string;
  errorMessage: string;
  stackTrace?: string;
  filePath?: string;
  lineNumber?: number;
  severity: Severity;
  context?: Record<string, any>;
}

export interface ApiHealthEntry {
  apiName: string;
  endpoint: string;
  status: ApiStatus;
  responseTimeMs: number;
  consecutiveFailures: number;
  lastFailureReason?: string;
}

export interface CodeRepairRequest {
  errorId: number;
  agentName: string;
  filePath: string;
  errorType: string;
  errorMessage: string;
  stackTrace?: string;
  relevantCode?: string;
}

export interface CodeRepairResult {
  diagnosis: string;
  repairCategory: RepairCategory;
  originalCode: string;
  repairedCode: string;
  requiresApproval: boolean;
  confidence: number;         // 0-1 how confident the LLM is in the fix
}

export interface DegradationRule {
  action: string;
  params?: Record<string, any>;
  notify: boolean;
  message?: string;
}

export interface HealthReport {
  agents: AgentHeartbeat[];
  apis: ApiHealthEntry[];
  metrics: {
    totalErrors24h: number;
    totalRestarts24h: number;
    totalRepairs24h: number;
    pendingRepairs: number;
    overallStatus: 'healthy' | 'degraded' | 'critical';
  };
  text: string;
}

// ============================================================
// DEGRADATION RULES
// ============================================================

export const DEGRADATION_RULES: Record<string, DegradationRule> = {
  openai_down: {
    action: 'switch_model',
    params: { fallback: 'anthropic' },
    notify: true,
    message: '⚠️ OpenAI down. Switched to Anthropic fallback.',
  },
  anthropic_down: {
    action: 'switch_model',
    params: { fallback: 'openai' },
    notify: true,
    message: '⚠️ Anthropic down. Code repair degraded. Switched to OpenAI fallback.',
  },
  twitter_429: {
    action: 'reduce_frequency',
    params: { newMaxRepliesPerHour: 2, resumeAfterMs: 900_000 },
    notify: false,
  },
  twitter_503: {
    action: 'wait_and_retry',
    params: { retryAfterMs: 300_000 },
    notify: false,
  },
  solana_rpc_error: {
    action: 'rotate_rpc',
    params: {
      backupRPCs: [
        'https://api.mainnet-beta.solana.com',
        'https://rpc.helius.xyz',
        'https://mainnet.helius-rpc.com',
      ],
    },
    notify: true,
    message: '⚠️ Solana RPC failed. Rotated to backup.',
  },
  db_connection_lost: {
    action: 'emergency_reconnect',
    params: { retryIntervalMs: 5_000, maxRetries: 10 },
    notify: true,
    message: '🚨 Database connection lost. Attempting reconnection.',
  },
  restart_loop: {
    action: 'disable_agent',
    notify: true,
    message: '🚨 {agentName} failed to restart {count} times. Disabled. Manual intervention needed.',
  },
  memory_exceeded: {
    action: 'restart_agent',
    notify: true,
    message: '⚠️ {agentName} exceeded memory limit ({memoryMb}MB). Restarting.',
  },
};

// ============================================================
// API ENDPOINTS TO MONITOR
// ============================================================

export const MONITORED_APIS: Array<{ name: string; endpoint: string; method: string; timeoutMs: number }> = [
  { name: 'Twitter API',   endpoint: 'https://api.twitter.com/2/tweets/search/recent?query=test&max_results=10', method: 'HEAD', timeoutMs: 10_000 },
  { name: 'OpenAI',        endpoint: 'https://api.openai.com/v1/models',                                         method: 'GET',  timeoutMs: 10_000 },
  { name: 'Anthropic',     endpoint: 'https://api.anthropic.com/v1/messages',                                     method: 'POST', timeoutMs: 10_000 },
  { name: 'Solana RPC',    endpoint: 'https://api.mainnet-beta.solana.com',                                       method: 'POST', timeoutMs: 5_000  },
  { name: 'DeFiLlama',     endpoint: 'https://api.llama.fi/protocols',                                            method: 'GET',  timeoutMs: 10_000 },
  { name: 'RugCheck',      endpoint: 'https://api.rugcheck.xyz/v1/stats',                                         method: 'GET',  timeoutMs: 10_000 },
];
