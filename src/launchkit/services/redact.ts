/**
 * Redaction Service
 * 
 * Ensures sensitive secrets are never exposed in logs, API responses, or audit trails.
 * All wallet secrets, API keys, and private keys must be redacted.
 */

const SENSITIVE_KEYS = new Set([
  // Telegram
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  // X/Twitter
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET_KEY',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  // Wallet secrets - CRITICAL: never expose
  'apiKey',
  'wallet',
  'walletSecret',
  'wallet_secret',
  'PUMP_PORTAL_WALLET_SECRET',
  'PUMP_PORTAL_API_KEY',
  'AGENT_FUNDING_WALLET_SECRET',
  // Generic sensitive keys
  'mint',
  'secret',
  'privateKey',
  'private_key',
  'secretKey',
  'secret_key',
  // OpenAI
  'OPENAI_API_KEY',
  // Admin tokens
  'ADMIN_TOKEN',
  'LAUNCHKIT_ADMIN_TOKEN',
]);

/**
 * Redact sensitive values from an object for safe logging
 * Recursively processes nested objects and arrays
 */
export function redactSensitive(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));

  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactSensitive(val);
    }
  }
  return result;
}

/**
 * Redact a single value if it looks like a secret
 * Used for string values that might contain wallet addresses, keys, etc.
 */
export function redactIfSecret(key: string, value: string): string {
  if (SENSITIVE_KEYS.has(key)) {
    return '[redacted]';
  }
  return value;
}

/**
 * Redact sensitive data from a log message
 * Useful for sanitizing error messages before logging
 */
export function redactLogMessage(message: string): string {
  // Redact base58 private keys (64-byte keys encoded as 87-88 chars)
  // Pattern: starts with valid base58 char, 85-90 chars total
  let sanitized = message.replace(/[1-9A-HJ-NP-Za-km-z]{85,90}/g, '[redacted-key]');
  
  // Redact things that look like API keys (alphanumeric, 32+ chars)
  sanitized = sanitized.replace(/[A-Za-z0-9]{32,}/g, (match) => {
    // Don't redact UUIDs or timestamps
    if (/^[0-9a-f-]{36}$/i.test(match)) return match;
    if (/^\d+$/.test(match)) return match;
    return '[redacted-key]';
  });
  
  return sanitized;
}

/**
 * Create a safe version of env config for logging
 * Only includes non-sensitive configuration values
 */
export function redactEnvForLogging(env: Record<string, any>): Record<string, any> {
  const safe: Record<string, any> = {};
  
  const allowedKeys = new Set([
    'LAUNCH_ENABLE',
    'LAUNCHKIT_ENABLE',
    'LAUNCHKIT_PORT',
    'LOCAL_WITHDRAW_ENABLE',
    'MAX_SOL_DEV_BUY',
    'MAX_PRIORITY_FEE',
    'MAX_LAUNCHES_PER_DAY',
    'LAUNCH_SLIPPAGE_PERCENT',
    'MAX_SLIPPAGE_PERCENT',
    'PGLITE_PATH',
    'PGLITE_DATA_DIR',
    'SOLANA_RPC_URL',
    'TG_ENABLE',
    'X_ENABLE',
    'X_MONTHLY_WRITE_LIMIT',
    'X_MONTHLY_READ_LIMIT',
    'AI_LOGO_ENABLE',
    'AI_MEME_ENABLE',
    // Treasury config (address is public info)
    'TREASURY_ENABLE',
    'TREASURY_ADDRESS',
    'TREASURY_MIN_RESERVE_SOL',
    'TREASURY_LOG_ONLY',
    // Auto-withdraw config
    'AUTO_WITHDRAW_ENABLE',
    'WITHDRAW_MIN_SOL',
    'WITHDRAW_KEEP_SOL',
    'WITHDRAW_MAX_SOL_PER_DAY',
    // Auto-sell config
    'AUTO_SELL_ENABLE',
    'AUTO_SELL_MODE',
    'AUTO_SELL_COOLDOWN_SECONDS',
    'AUTO_SELL_MAX_PERCENT_PER_TX',
    // Computed flags
    'launchEnabled',
    'launchkitEnabled',
    'localWithdrawEnabled',
    'treasuryEnabled',
    'treasuryLogOnly',
    'autoWithdrawEnabled',
    'autoSellEnabled',
  ]);
  
  for (const [key, value] of Object.entries(env)) {
    if (allowedKeys.has(key)) {
      safe[key] = value;
    } else if (SENSITIVE_KEYS.has(key)) {
      safe[key] = value ? '[configured]' : '[not-set]';
    }
    // Skip other keys entirely
  }
  
  return safe;
}
