import { z } from 'zod';

const numberOrUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((val) => {
    if (val === '' || val === undefined || val === null) return undefined;
    return val;
  }, schema);

const EnvSchema = z.object({
  LAUNCH_ENABLE: z.enum(['true', 'false']).default('false'),
  LAUNCHKIT_ENABLE: z.enum(['true', 'false']).default('false'),
  LAUNCHKIT_PORT: z.coerce.number().default(8787),
  LAUNCHKIT_ADMIN_TOKEN: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  LOCAL_WITHDRAW_ENABLE: z.enum(['true', 'false']).default('false'),
  MAX_SOL_DEV_BUY: z.coerce.number().default(0),
  MAX_PRIORITY_FEE: z.coerce.number().default(0),
  MAX_LAUNCHES_PER_DAY: z.coerce.number().default(0),
  LAUNCH_SLIPPAGE_PERCENT: numberOrUndefined(z.coerce.number().optional()).default(10),
  MAX_SLIPPAGE_PERCENT: numberOrUndefined(z.coerce.number().optional()),
  PGLITE_PATH: z.string().default('.pglite/launchkit'),
  PGLITE_DATA_DIR: z.string().default('.pglite'),
  DATABASE_URL: z.string().optional(),
  
  // ==========================================
  // Railway / Postgres Configuration
  // ==========================================
  // Disable vector embeddings if pgvector not available (auto-detected on Railway)
  SQL_EMBEDDINGS_ENABLE: z.enum(['true', 'false']).default('true'),
  
  PUMP_PORTAL_API_KEY: z.string().optional(),
  PUMP_PORTAL_WALLET_SECRET: z.string().optional(),
  PUMP_PORTAL_WALLET_ADDRESS: z.string().optional(),
  AGENT_FUNDING_WALLET_SECRET: z.string().optional(),
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  TG_ENABLE: z.enum(['true', 'false']).optional(),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  X_ENABLE: z.enum(['true', 'false']).optional(),
  X_API_KEY: z.string().optional(),
  X_API_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_SECRET: z.string().optional(),
  // Also support TWITTER_* naming from ElizaOS conventions
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET_KEY: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_TOKEN_SECRET: z.string().optional(),
  X_MONTHLY_WRITE_LIMIT: z.coerce.number().default(500),  // Free tier: 500 tweets/month
  X_MONTHLY_READ_LIMIT: z.coerce.number().default(100),   // Free tier: 100 reads/month
  AI_LOGO_ENABLE: z.enum(['true', 'false']).default('true'),
  AI_MEME_ENABLE: z.enum(['true', 'false']).default('true'), // Enable AI meme generation for TG posts
  OPENAI_API_KEY: z.string().optional(),
  
  // ==========================================
  // Treasury Wallet Configuration
  // ==========================================
  // Treasury is disabled by default - all behavior unchanged
  TREASURY_ENABLE: z.enum(['true', 'false']).default('false'),
  // Treasury address (public key only - NEVER store private key for treasury)
  TREASURY_ADDRESS: z.string().optional(),
  // Minimum SOL to leave as reserve in pump wallet (default aligns with existing behavior)
  TREASURY_MIN_RESERVE_SOL: z.coerce.number().default(0.3),
  // Log-only mode: compute + log planned transfers without executing (safe by default)
  TREASURY_LOG_ONLY: z.enum(['true', 'false']).default('true'),
  
  // ==========================================
  // Auto-Withdraw / Sweep Configuration
  // ==========================================
  // Disabled by default - deterministic scheduler-driven
  AUTO_WITHDRAW_ENABLE: z.enum(['true', 'false']).default('false'),
  // Only withdraw if SOL balance exceeds this amount
  WITHDRAW_MIN_SOL: z.coerce.number().default(0.25),
  // Keep this amount in the hot wallet as runway
  WITHDRAW_KEEP_SOL: z.coerce.number().default(0.15),
  // Maximum SOL that can be withdrawn per day (safety cap)
  WITHDRAW_MAX_SOL_PER_DAY: z.coerce.number().default(2),
  
  // ==========================================
  // Auto-Sell Policy Configuration
  // ==========================================
  // Disabled by default - no autonomous trading
  AUTO_SELL_ENABLE: z.enum(['true', 'false']).default('false'),
  // Mode: 'off' | 'manual_approve' | 'autonomous' (default off or manual_approve)
  AUTO_SELL_MODE: z.enum(['off', 'manual_approve', 'autonomous']).default('off'),
  // Optional JSON string defining take-profit ladder policy
  AUTO_SELL_POLICY_JSON: z.string().optional(),
  // Cooldown between sells (seconds, with jitter applied)
  AUTO_SELL_COOLDOWN_SECONDS: z.coerce.number().default(300), // 5 minutes
  // Max sell percentage per transaction
  AUTO_SELL_MAX_PERCENT_PER_TX: z.coerce.number().default(20),
  // Max sell transactions per hour (rate limit)
  AUTO_SELL_MAX_TX_PER_HOUR: z.coerce.number().default(10),
});

export type LaunchkitEnv = z.infer<typeof EnvSchema> & {
  launchEnabled: boolean;
  launchkitEnabled: boolean;
  localWithdrawEnabled: boolean;
  treasuryEnabled: boolean;
  treasuryLogOnly: boolean;
  autoWithdrawEnabled: boolean;
  autoSellEnabled: boolean;
};

/**
 * Validate treasury configuration
 * Returns error message if invalid, null if valid
 */
function validateTreasuryConfig(parsed: z.infer<typeof EnvSchema>): string | null {
  if (parsed.TREASURY_ENABLE !== 'true') {
    return null; // Treasury disabled, no validation needed
  }
  
  // Treasury enabled - TREASURY_ADDRESS must be present and valid
  if (!parsed.TREASURY_ADDRESS) {
    return 'TREASURY_ADDRESS is required when TREASURY_ENABLE=true';
  }
  
  // Basic base58 public key validation (32-44 chars of valid base58)
  const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!base58Pattern.test(parsed.TREASURY_ADDRESS)) {
    return 'TREASURY_ADDRESS must be a valid Solana public key (base58 encoded, 32-44 characters)';
  }
  
  // Treasury address must not be same as pump wallet address (prevent circular transfers)
  if (parsed.PUMP_PORTAL_WALLET_ADDRESS && 
      parsed.TREASURY_ADDRESS === parsed.PUMP_PORTAL_WALLET_ADDRESS) {
    return 'TREASURY_ADDRESS cannot be the same as PUMP_PORTAL_WALLET_ADDRESS';
  }
  
  return null;
}

function parseEnv(source: Record<string, unknown>): LaunchkitEnv {
  const parsed = EnvSchema.parse(source);
  
  // Existing wallet secret validation
  if (
    parsed.LAUNCH_ENABLE === 'true' &&
    parsed.LOCAL_WITHDRAW_ENABLE === 'true' &&
    !parsed.PUMP_PORTAL_WALLET_SECRET
  ) {
    const err = new Error('PUMP_PORTAL_WALLET_SECRET is required when LAUNCH_ENABLE=true and LOCAL_WITHDRAW_ENABLE=true');
    (err as any).code = 'WALLET_SECRET_REQUIRED';
    throw err;
  }
  
  // Treasury configuration validation
  const treasuryError = validateTreasuryConfig(parsed);
  if (treasuryError) {
    const err = new Error(treasuryError);
    (err as any).code = 'TREASURY_CONFIG_INVALID';
    throw err;
  }
  
  return {
    ...parsed,
    launchEnabled: parsed.LAUNCH_ENABLE === 'true',
    launchkitEnabled: parsed.LAUNCHKIT_ENABLE === 'true',
    localWithdrawEnabled: parsed.LOCAL_WITHDRAW_ENABLE === 'true',
    treasuryEnabled: parsed.TREASURY_ENABLE === 'true',
    treasuryLogOnly: parsed.TREASURY_LOG_ONLY === 'true',
    autoWithdrawEnabled: parsed.AUTO_WITHDRAW_ENABLE === 'true',
    autoSellEnabled: parsed.AUTO_SELL_ENABLE === 'true',
  } as LaunchkitEnv;
}

export function getEnv(overrides?: Record<string, string | undefined>): LaunchkitEnv {
  const merged = { ...process.env, ...overrides } as Record<string, unknown>;
  return parseEnv(merged);
}
