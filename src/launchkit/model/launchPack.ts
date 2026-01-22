import { z } from 'zod';

// Accept Z-suffix format (what toISOString() produces)
const isoDateTime = z.string().datetime();

export const memeSchema = z
  .object({
    url: z.string().url('memes.url must be a valid URL'),
    caption: z.string().trim().optional().default(''),
  })
  .strict();

export const scheduleItemSchema = z
  .object({
    when: isoDateTime,
    text: z.string().trim().min(1, 'schedule.text is required'),
    media_url: z.string().url().optional(),
  })
  .strict();

export const brandSchema = z
  .object({
    name: z.string().trim().min(1, 'brand.name is required'),
    ticker: z
      .string()
      .trim()
      .min(1, 'brand.ticker is required')
      .max(12, 'brand.ticker must be <= 12 chars')
      .transform((val: string) => val.toUpperCase()),
    tagline: z.string().trim().optional().default(''),
    description: z.string().trim().optional().default(''),
    lore: z.string().trim().optional().default(''),
  })
  .strict();

export const linksSchema = z
  .object({
    telegram: z.string().url().optional(),
    x: z.string().url().optional(),
    website: z.string().url().optional(),
  })
  .strict();

export const assetsSchema = z
  .object({
    logo_url: z.string().url().optional(),
    banner_url: z.string().url().optional(),
    memes: z.array(memeSchema).optional().default([]),
  })
  .strict();

export const tgPinsSchema = z
  .object({
    welcome: z.string().trim().optional().default(''),
    how_to_buy: z.string().trim().optional().default(''),
    memekit: z.string().trim().optional().default(''),
  })
  .strict();

export const tgSchema = z
  .object({
    chat_id: z.string().trim().optional(), // ElizaOS roomId (UUID)
    telegram_chat_id: z.string().trim().optional(), // Real Telegram chat_id (numeric)
    invite_link: z.string().url().optional(), // Telegram group invite link (t.me/xxx)
    pins: tgPinsSchema.optional().default(() => ({ welcome: '', how_to_buy: '', memekit: '' })),
    schedule: z.array(scheduleItemSchema).optional().default(() => []),
    verified: z.boolean().optional(),
    verified_at: isoDateTime.optional(),
    chat_title: z.string().trim().optional(),
    pending_verification: z.boolean().optional(),
    is_admin: z.boolean().optional(), // Bot has admin privileges
    can_post: z.boolean().optional(), // Bot can post messages
    can_pin: z.boolean().optional(), // Bot can pin messages
  })
  .strict();

export const xSchema = z
  .object({
    handle: z.string().trim().optional(), // Twitter/X handle for the token (e.g. @DumpToken)
    main_post: z.string().trim().optional().default(''),
    thread: z.array(z.string().trim()).optional().default(() => []),
    reply_bank: z.array(z.string().trim()).optional().default(() => []),
    schedule: z.array(scheduleItemSchema).optional().default(() => []),
  })
  .strict();

export const launchStatusSchema = z.enum(['draft', 'ready', 'launched', 'failed']);

// Dev buy configuration - transparent allocation at launch
export const devBuySchema = z
  .object({
    enabled: z.boolean().default(false),
    amount_sol: z.number().min(0.001).max(1).default(0.05), // 0.001 - 1 SOL max
    tokens_received: z.number().optional(), // Filled after launch
    locked_until: z.string().datetime().optional(), // Vesting date
    disclosed: z.boolean().default(true), // Always disclosed for transparency
  })
  .strict();

export const launchSchema = z
  .object({
    status: launchStatusSchema.default('draft'),
    mint: z.string().trim().optional(),
    tx_signature: z.string().trim().optional(),
    pump_url: z.string().url().optional(),

    // Dev buy configuration
    dev_buy: devBuySchema.optional(),

    requested_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().optional(),
    launched_at: z.string().datetime().optional(),
    failed_at: z.string().datetime().optional(),

    error_code: z.string().trim().optional(),
    error_message: z.string().trim().optional(),
  })
  .strict();

export const auditEntrySchema = z
  .object({
    at: z.string().datetime().optional(),
    message: z.string().trim().min(1, 'audit message is required'),
    actor: z.string().trim().optional(),
  })
  .strict();

/**
 * Treasury Operation Status Schema
 * Tracks the state of treasury withdrawals/sweeps for this LaunchPack
 */
export const treasuryStatusSchema = z
  .object({
    // Current status of treasury operations
    status: z.enum(['idle', 'in_progress', 'success', 'failed', 'log_only']).optional().default('idle'),
    // Destination type
    treasury_destination: z.enum(['treasury', 'funding']).optional(),
    // Last attempt timestamp
    attempted_at: isoDateTime.optional(),
    // Completion timestamp  
    completed_at: isoDateTime.optional(),
    // Amount withdrawn
    amount_sol: z.number().optional(),
    // Transaction signature
    tx_signature: z.string().trim().optional(),
    // Error information
    error_code: z.string().trim().optional(),
    error_message: z.string().trim().optional(),
    // Withdrawal mode capability
    readiness_mode: z.enum(['local_signing', 'pumpportal_withdraw', 'unsupported']).optional(),
  })
  .strict();

/**
 * Auto-Sell Policy Schema
 * Defines the take-profit ladder and stop-loss rules
 */
export const sellPolicySchema = z
  .object({
    // Whether policy is active for this token
    enabled: z.boolean().optional().default(false),
    // Take-profit levels (ordered by threshold)
    take_profit_levels: z.array(z.object({
      threshold_x: z.number().min(1), // e.g., 2 = 2x, 4 = 4x
      sell_percent: z.number().min(1).max(100),
      executed: z.boolean().optional(),
      executed_at: isoDateTime.optional(),
      tx_signature: z.string().trim().optional(),
    })).optional().default(() => []),
    // Trailing stop configuration
    trailing_stop: z.object({
      enabled: z.boolean().optional().default(false),
      activate_at_x: z.number().optional(), // Activate after this gain (e.g., 2 = 2x)
      drop_percent: z.number().optional(), // Trigger if drops this % from peak
      sell_percent: z.number().optional(), // How much to sell when triggered
    }).optional(),
    // Time-based exit
    time_stop: z.object({
      enabled: z.boolean().optional().default(false),
      hours_inactive: z.number().optional(), // Trigger after this many hours of low activity
      sell_percent: z.number().optional(),
    }).optional(),
    // Moonbag configuration (tokens to hold indefinitely)
    moonbag_percent: z.number().min(0).max(100).optional(),
    // Validation errors (if policy JSON was invalid)
    validation_error: z.string().trim().optional(),
  })
  .strict();

/**
 * Auto-Sell State Schema
 * Tracks execution state for auto-selling
 */
export const sellStateSchema = z
  .object({
    // Last time policy was evaluated
    last_check_at: isoDateTime.optional(),
    // Next scheduled check time
    next_check_at: isoDateTime.optional(),
    // Peak price seen (for trailing stop)
    peak_price_sol: z.number().optional(),
    peak_seen_at: isoDateTime.optional(),
    // Entry price (for calculating gains)
    entry_price_sol: z.number().optional(),
    // Current price (last known)
    current_price_sol: z.number().optional(),
    current_price_at: isoDateTime.optional(),
    // Executed sells log
    executed_sells: z.array(z.object({
      at: isoDateTime,
      trigger: z.string().trim(), // 'TP1', 'TP2', 'trailing_stop', 'time_stop', 'manual'
      percent_sold: z.number(),
      amount_tokens: z.number().optional(),
      amount_sol_received: z.number().optional(),
      tx_signature: z.string().trim().optional(),
      status: z.enum(['success', 'failed', 'pending']),
      error: z.string().trim().optional(),
    })).optional().default(() => []),
    // Pending intent (for manual_approve mode)
    pending_intent: z.object({
      trigger: z.string().trim(),
      percent_to_sell: z.number(),
      reason: z.string().trim(),
      created_at: isoDateTime,
      notified: z.boolean().optional(),
    }).optional(),
    // Total tokens held (for tracking)
    tokens_held: z.number().optional(),
    // Total tokens sold across all sells
    tokens_sold: z.number().optional(),
    // Total SOL received from sells
    total_sol_received: z.number().optional(),
  })
  .strict();

/**
 * Treasury Daily Caps Schema
 * Persisted daily caps for treasury withdrawals (replaces in-memory state)
 */
export const treasuryCapsSchema = z
  .object({
    // Date key (YYYY-MM-DD) - caps reset automatically when date changes
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Total SOL withdrawn today
    withdrawn_sol: z.number().default(0),
    // Last withdrawal timestamp
    last_withdraw_at: isoDateTime.optional(),
    // Number of withdrawals today
    withdraw_count: z.number().default(0),
  })
  .strict();

/**
 * Sell Rate Limits Schema
 * Persisted hourly rate limits for sell operations (replaces in-memory state)
 */
export const sellRateLimitsSchema = z
  .object({
    // Hour key (YYYY-MM-DDTHH) - limits reset automatically when hour changes
    hour_key: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/),
    // Number of sell transactions this hour
    tx_count: z.number().default(0),
    // Last transaction timestamp
    last_tx_at: isoDateTime.optional(),
  })
  .strict();

export const opsSchema = z
  .object({
    checklist: z.record(z.string(), z.boolean()).optional().default(() => ({})),
    audit_log: z.array(auditEntrySchema).optional().default(() => []),
    tg_publish_status: z.enum(['idle', 'in_progress', 'published', 'failed']).optional(),
    tg_publish_attempted_at: isoDateTime.optional(),
    tg_publish_failed_at: isoDateTime.optional(),
    tg_publish_error_code: z.string().trim().nullable().optional(),
    tg_publish_error_message: z.string().trim().nullable().optional(),
    tg_published_at: isoDateTime.optional(),
    tg_message_ids: z.array(z.string().trim()).optional(),
    tg_schedule_intent: z.array(scheduleItemSchema).optional(),
    tg_announcement_sent_at: isoDateTime.optional(),
    tg_announcement_message_id: z.number().optional(),
    tg_welcome_pinned: z.boolean().optional(),
    x_publish_status: z.enum(['idle', 'in_progress', 'published', 'failed']).optional(),
    x_publish_attempted_at: isoDateTime.optional(),
    x_publish_failed_at: isoDateTime.optional(),
    x_publish_error_code: z.string().trim().nullable().optional(),
    x_publish_error_message: z.string().trim().nullable().optional(),
    x_published_at: isoDateTime.optional(),
    x_post_ids: z.array(z.string().trim()).optional(),
    x_tweet_ids: z.array(z.string().trim()).optional(),
    x_schedule_intent: z.array(scheduleItemSchema).optional(),
    // X Marketing tracking - persisted in DB for recovery
    x_marketing_enabled: z.boolean().optional(),
    x_marketing_tweets_per_week: z.number().optional(),
    x_marketing_total_tweeted: z.number().optional(),
    x_marketing_last_tweet_at: isoDateTime.optional(),
    x_marketing_scheduled_count: z.number().optional(),
    x_marketing_created_at: isoDateTime.optional(),
    // Treasury operations tracking
    treasury: treasuryStatusSchema.optional(),
    // Persisted daily caps for treasury withdrawals
    treasury_caps: treasuryCapsSchema.optional(),
    // Auto-sell policy (parsed/normalized)
    sell_policy: sellPolicySchema.optional(),
    // Auto-sell execution state
    sell_state: sellStateSchema.optional(),
    // Persisted hourly rate limits for sells
    sell_rate_limits: sellRateLimitsSchema.optional(),
  })
  .strict();

/**
 * Mascot Schema - Defines the character/personality for community groups
 * 
 * This allows each token community to have a unique mascot personality
 * that the agent adopts when interacting in that specific Telegram group.
 */
export const mascotSchema = z
  .object({
    // The mascot's name (e.g., "Ruggy", "MoonDog", "Captain $TICKER")
    name: z.string().trim().optional(),
    
    // Core personality traits (e.g., "chaotic, meme-loving, always bullish")
    personality: z.string().trim().optional(),
    
    // How the mascot speaks (e.g., "uses lots of emojis, says 'wagmi' often")
    speaking_style: z.string().trim().optional(),
    
    // Background/lore for the mascot character
    backstory: z.string().trim().optional(),
    
    // Signature phrases the mascot uses (e.g., ["LFG!", "Rug or be rugged!"])
    catchphrases: z.array(z.string().trim()).optional().default(() => []),
    
    // Custom rules/guidelines for this community (in addition to defaults)
    rules: z.array(z.string().trim()).optional().default(() => []),
    
    // Topics to avoid in this community
    forbidden_topics: z.array(z.string().trim()).optional().default(() => []),
    
    // Competitor tokens to never mention
    competitors: z.array(z.string().trim()).optional().default(() => []),
  })
  .strict();

export const launchPackSchema = z
  .object({
    id: z.string().uuid().optional(),
    idempotency_key: z.string().trim().min(8).optional(),
    version: z.number().int().min(1).optional().default(1),
    brand: brandSchema,
    links: linksSchema.optional().default(() => ({})),
    assets: assetsSchema.optional().default(() => ({ memes: [] })),
    tg: tgSchema.optional().default(() => ({ pins: { welcome: '', how_to_buy: '', memekit: '' }, schedule: [] })),
    x: xSchema.optional().default(() => ({ main_post: '', thread: [], reply_bank: [], schedule: [] })),
    launch: launchSchema.optional().default(() => ({ status: 'draft' as const })),
    ops: opsSchema.optional().default(() => ({ checklist: {}, audit_log: [] })),
    mascot: mascotSchema.optional().default(() => ({ catchphrases: [], rules: [], forbidden_topics: [], competitors: [] })),
    created_at: isoDateTime.optional(),
    updated_at: isoDateTime.optional(),
  })
  .strict();

export const createLaunchPackSchema = launchPackSchema
  .omit({ created_at: true, updated_at: true })
  .extend({ id: z.string().uuid().optional() })
  .strict();

// Update schema WITHOUT defaults - only includes explicitly provided fields
// This prevents Zod from injecting empty defaults that would overwrite existing data
export const updateLaunchPackSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    brand: brandSchema.partial().optional(),
    links: linksSchema.partial().optional(),
    assets: z.object({
      logo_url: z.string().url().optional(),
      banner_url: z.string().url().optional(),
      memes: z.array(memeSchema).optional(),
    }).partial().optional(),
    tg: z.object({
      chat_id: z.string().trim().optional(),
      telegram_chat_id: z.string().trim().optional(),
      invite_link: z.string().url().optional(),
      pins: z.object({
        welcome: z.string().trim().optional(),
        how_to_buy: z.string().trim().optional(),
        memekit: z.string().trim().optional(),
      }).partial().optional(),
      schedule: z.array(scheduleItemSchema).optional(),
      verified: z.boolean().optional(),
      verified_at: isoDateTime.optional(),
      chat_title: z.string().trim().optional(),
      pending_verification: z.boolean().optional(),
      is_admin: z.boolean().optional(),
      can_post: z.boolean().optional(),
      can_pin: z.boolean().optional(),
    }).partial().optional(),
    x: z.object({
      main_post: z.string().trim().optional(),
      thread: z.array(z.string().trim()).optional(),
      reply_bank: z.array(z.string().trim()).optional(),
      schedule: z.array(scheduleItemSchema).optional(),
      handle: z.string().trim().optional(), // X/Twitter handle (without @)
    }).partial().optional(),
    launch: launchSchema.partial().optional(),
    ops: opsSchema.partial().optional(),
    mascot: mascotSchema.partial().optional(),
  })
  .partial()
  .passthrough(); // Allow additional fields to pass through for flexibility

export type LaunchPack = z.infer<typeof launchPackSchema> & { id: string };
export type LaunchPackCreateInput = z.input<typeof createLaunchPackSchema>;
export type LaunchPackUpdateInput = z.input<typeof updateLaunchPackSchema>;

export const LaunchPackValidation = {
  create(input: unknown) {
    return createLaunchPackSchema.parse(input);
  },
  update(input: unknown) {
    return updateLaunchPackSchema.parse(input);
  },
};
