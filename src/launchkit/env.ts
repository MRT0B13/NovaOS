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
  
  // ==========================================
  // Admin Notifications
  // ==========================================
  // Private chat/group for admin alerts (withdrawals, errors, system status)
  ADMIN_CHAT_ID: z.string().optional(),
  // Types of admin alerts: withdrawals, errors, autonomous, system (comma-separated)
  ADMIN_ALERTS: z.string().default('withdrawals,errors,autonomous,system'),
  
  // ==========================================
  // Telegram Security
  // ==========================================
  // Comma-separated list of Telegram user IDs allowed to run admin commands
  // Get your ID from @userinfobot on Telegram
  TELEGRAM_ADMIN_IDS: z.string().optional(),
  // Secret token for webhook verification (set when configuring webhook)
  // Must match the secret_token passed to setWebhook API
  TG_WEBHOOK_SECRET: z.string().optional(),
  
  // ==========================================
  // Nova Channel Configuration (Agent's own TG channel)
  // ==========================================
  // Enable Nova's personal channel for announcements and community engagement
  NOVA_CHANNEL_ENABLE: z.enum(['true', 'false']).default('false'),
  // The Telegram channel/group ID where Nova posts announcements
  NOVA_CHANNEL_ID: z.string().optional(),
  // Public invite link for Nova's channel (for marketing tweets)
  NOVA_CHANNEL_INVITE: z.string().optional(),
  // Types of updates to post: launches, wallet, health, marketing (comma-separated)
  NOVA_CHANNEL_UPDATES: z.string().default('launches,wallet,health'),
  // Nova's X/Twitter handle (e.g., 'NovaAgent' without @) - used for autonomous launches
  NOVA_X_HANDLE: z.string().optional(),
  
  // ==========================================
  // Community Voting Configuration
  // ==========================================
  // Enable community voting on autonomous ideas before launch
  COMMUNITY_VOTING_ENABLED: z.enum(['true', 'false']).default('false'),
  // Voting window in minutes (default: 30)
  COMMUNITY_VOTING_WINDOW_MINUTES: z.string().default('30'),
  // Minimum votes required to count (default: 3, less = auto-approve)
  COMMUNITY_VOTING_MIN_VOTES: z.string().default('3'),
  // Sentiment threshold for approval (-1 to 1, default: 0.4 = 40% positive)
  COMMUNITY_VOTING_APPROVAL_THRESHOLD: z.string().default('0.4'),
  // Confidence level to skip voting (default: 0.95 = 95%)
  COMMUNITY_VOTING_CONFIDENCE_SKIP: z.string().default('0.95'),
  
  // ==========================================
  // System Reporter Configuration
  // ==========================================
  // Enable periodic system status reports to admin (every 4h + daily summary)
  SYSTEM_REPORTS_ENABLE: z.enum(['true', 'false']).default('false'),
  // Disable auto-restart of Telegram polling (set to true if using webhooks)
  TG_DISABLE_AUTO_RESTART: z.enum(['true', 'false']).default('false'),
  // Auto-register webhook URL on startup (to counter ElizaOS deleteWebhook)
  TG_WEBHOOK_URL: z.string().optional(),

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
  
  // X Scheduler Configuration
  X_AUTO_TWEETS_PER_DAY: z.coerce.number().default(2),       // Tweets per day per token
  X_MIN_PENDING_TWEETS: z.coerce.number().default(5),        // Auto-refill when below this
  X_REFILL_DAYS: z.coerce.number().default(3),               // Days to schedule ahead
  X_CHANNEL_PROMO_INTERVAL_DAYS: z.coerce.number().default(1), // Channel promo frequency (days)
  X_MIN_PENDING_CHANNEL_PROMOS: z.coerce.number().default(7),  // Keep this many channel promos scheduled
  
  // ==========================================
  // Token Marketing (Per-Token X/TG Posts)
  // ==========================================
  // Enable per-token X marketing (scheduled tweets about individual tokens)
  TOKEN_X_MARKETING_ENABLE: z.enum(['true', 'false']).default('true'),
  // Enable per-token TG marketing (scheduled posts to token TG groups)
  TOKEN_TG_MARKETING_ENABLE: z.enum(['true', 'false']).default('true'),
  
  // ==========================================
  // Nova Personal Brand (Agent's Own Content)
  // ==========================================
  // Enable Nova's personal X posts (gm, recaps, teasers, NOT token shills)
  NOVA_PERSONAL_X_ENABLE: z.enum(['true', 'false']).default('false'),
  // Enable Nova's personal TG channel posts (ideas, polls, updates)
  NOVA_PERSONAL_TG_ENABLE: z.enum(['true', 'false']).default('false'),
  // Scheduled idea feedback window in minutes (how long to collect reactions)
  SCHEDULED_IDEA_FEEDBACK_MINUTES: z.string().default('60'),
  // GM post time (24h format, UTC) - e.g., "08:00"
  NOVA_GM_POST_TIME: z.string().default('08:00'),
  // Daily recap post time (24h format, UTC) - e.g., "22:00"
  NOVA_RECAP_POST_TIME: z.string().default('22:00'),
  // Weekly summary day (0=Sunday, 1=Monday, etc)
  NOVA_WEEKLY_SUMMARY_DAY: z.coerce.number().default(0),
  
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
  
  // ==========================================
  // Autonomous Mode Configuration
  // ==========================================
  // Enable autonomous token launching (Nova generates & launches on its own)
  AUTONOMOUS_ENABLE: z.enum(['true', 'false']).default('false'),
  // Schedule for daily launch slot (HH:MM in UTC, e.g., "14:00")
  AUTONOMOUS_SCHEDULE: z.string().default('14:00'),
  // Maximum launches per day (scheduled + reactive combined)
  AUTONOMOUS_MAX_PER_DAY: z.coerce.number().default(1),
  // Minimum SOL balance required to launch
  AUTONOMOUS_MIN_SOL: z.coerce.number().default(0.3),
  // Dev buy amount for autonomous launches (SOL)
  AUTONOMOUS_DEV_BUY_SOL: z.coerce.number().default(0.01),
  // Use Nova's channel as community (no separate TG group)
  AUTONOMOUS_USE_NOVA_CHANNEL: z.enum(['true', 'false']).default('true'),
  // Dry run mode - generate ideas but don't actually launch
  AUTONOMOUS_DRY_RUN: z.enum(['true', 'false']).default('true'),
  
  // ==========================================
  // Reactive/Event-Driven Mode (supplements scheduled)
  // ==========================================
  // Enable trend-reactive launches (monitors for viral moments)
  AUTONOMOUS_REACTIVE_ENABLE: z.enum(['true', 'false']).default('false'),
  // Max reactive launches per day (in addition to scheduled)
  AUTONOMOUS_REACTIVE_MAX_PER_DAY: z.coerce.number().default(3),
  // Minimum trend score to trigger (0-100)
  AUTONOMOUS_REACTIVE_MIN_SCORE: z.coerce.number().default(70),
  // Minimum hours between reactive launches (spread them out)
  AUTONOMOUS_REACTIVE_COOLDOWN_HOURS: z.coerce.number().default(2),
  // Buffer around scheduled launch time (don't reactive launch within X hours)
  AUTONOMOUS_SCHEDULED_BUFFER_HOURS: z.coerce.number().default(1),
  
  // Reactive Launch Time Windows (HH:MM in UTC)
  // Quiet hours - NO reactive launches allowed (e.g., after midnight reset)
  AUTONOMOUS_REACTIVE_QUIET_START: z.string().default('00:00'),
  AUTONOMOUS_REACTIVE_QUIET_END: z.string().default('10:00'),
  // Busy hours - reactive launches ONLY allowed during these hours
  AUTONOMOUS_REACTIVE_BUSY_START: z.string().default('12:00'),
  AUTONOMOUS_REACTIVE_BUSY_END: z.string().default('22:00'),
  
  // Trend Monitor Configuration
  // ==========================================
  // Poll interval during busy hours (default: 30 min)
  TREND_POLL_INTERVAL_MINUTES: z.coerce.number().default(30),
  // Poll interval during quiet hours (default: 45 min - more conservative)
  TREND_POLL_INTERVAL_QUIET_MINUTES: z.coerce.number().default(45),
  // Min times trend must be seen before triggering (default: 2)
  TREND_MIN_PERSISTENCE: z.coerce.number().default(2),
  
  // Trend Pool Configuration (persistent trend storage)
  // ==========================================
  // Max trends to keep in pool (default: 30)
  TREND_POOL_MAX_SIZE: z.coerce.number().default(30),
  // Score decay per hour when trend not seen (default: 5)
  TREND_POOL_DECAY_PER_HOUR: z.coerce.number().default(5),
  // Remove trends below this score (default: 40)
  TREND_POOL_MIN_SCORE: z.coerce.number().default(40),
  // Consider trend stale after this many hours (default: 6)
  TREND_POOL_STALE_HOURS: z.coerce.number().default(6),
  
  // Trend Source APIs
  // ==========================================
  // CryptoPanic API key for trending news (free developer tier)
  // Get from: https://cryptopanic.com/developers/api/
  CRYPTOPANIC_API_KEY: z.string().optional(),
  
  // CryptoNews API key for trending headlines & top mentions
  // Get from: https://cryptonews-api.com/register
  CRYPTONEWS_API_KEY: z.string().optional(),
});

export type LaunchkitEnv = z.infer<typeof EnvSchema> & {
  launchEnabled: boolean;
  launchkitEnabled: boolean;
  localWithdrawEnabled: boolean;
  treasuryEnabled: boolean;
  treasuryLogOnly: boolean;
  autoWithdrawEnabled: boolean;
  autoSellEnabled: boolean;
  autonomousEnabled: boolean;
  autonomousDryRun: boolean;
  autonomousReactiveEnabled: boolean;
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
    autonomousEnabled: parsed.AUTONOMOUS_ENABLE === 'true',
    autonomousDryRun: parsed.AUTONOMOUS_DRY_RUN === 'true',
    autonomousReactiveEnabled: parsed.AUTONOMOUS_REACTIVE_ENABLE === 'true',
  } as LaunchkitEnv;
}

export function getEnv(overrides?: Record<string, string | undefined>): LaunchkitEnv {
  const merged = { ...process.env, ...overrides } as Record<string, unknown>;
  return parseEnv(merged);
}
