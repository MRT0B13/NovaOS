/**
 * Farcaster Publisher Service
 *
 * Posts content to Farcaster (Warpcast) via the Neynar API.
 * Supports channel targeting — different content types go to different channels.
 *
 * Architecture:
 *   - Uses Neynar v2 API (https://api.neynar.com/v2)
 *   - Requires: NEYNAR_API_KEY + FARCASTER_SIGNER_UUID
 *   - Rate limited: max 30 casts/hour, 200/day
 *   - Deduplication: in-memory cache prevents identical casts within 30 min
 *
 * Channel Mapping:
 *   Token launches  → /solana, /defi
 *   Safety alerts   → /defi, /crypto
 *   Narrative intel → /ai-agents, /crypto
 *   Nova updates    → /ai-agents, /elizaos
 *   Weekly reports  → /ai-agents, /solana
 *
 * Environment:
 *   FARCASTER_ENABLE=true
 *   NEYNAR_API_KEY=<your-neynar-api-key>
 *   FARCASTER_SIGNER_UUID=<your-signer-uuid>
 *   FARCASTER_FID=<your-fid>  (optional — auto-detected from signer)
 */

import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export type FarcasterChannel =
  | 'solana'
  | 'defi'
  | 'crypto'
  | 'ai-agents'
  | 'elizaos'
  | 'memes';

export type ContentType =
  | 'launch'
  | 'safety_alert'
  | 'narrative_intel'
  | 'nova_update'
  | 'weekly_report'
  | 'general';

/** Maps content types to their target channels */
const CHANNEL_ROUTING: Record<ContentType, FarcasterChannel[]> = {
  launch:          ['solana', 'defi'],
  safety_alert:    ['defi', 'crypto'],
  narrative_intel: ['ai-agents', 'solana'],
  nova_update:     ['ai-agents', 'elizaos'],
  weekly_report:   ['ai-agents', 'solana'],
  general:         ['ai-agents'],
};

interface NeynarCastResponse {
  success: boolean;
  cast?: {
    hash: string;
    author: { fid: number; username: string };
    text: string;
    timestamp: string;
  };
}

interface FarcasterConfig {
  enabled: boolean;
  neynarApiKey: string;
  signerUuid: string;
  fid?: string;
}

// ============================================================================
// Rate Limiting
// ============================================================================

const MAX_CASTS_PER_HOUR = 30;
const MAX_CASTS_PER_DAY = 200;
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

let castsThisHour = 0;
let castsToday = 0;
let hourResetAt = 0;
let dayResetAt = 0;

function checkRateLimit(): { allowed: boolean; reason?: string } {
  const now = Date.now();
  if (now > hourResetAt) {
    castsThisHour = 0;
    hourResetAt = now + 60 * 60 * 1000;
  }
  if (now > dayResetAt) {
    castsToday = 0;
    dayResetAt = now + 24 * 60 * 60 * 1000;
  }
  if (castsThisHour >= MAX_CASTS_PER_HOUR) {
    return { allowed: false, reason: `Hourly limit reached (${MAX_CASTS_PER_HOUR}/hr)` };
  }
  if (castsToday >= MAX_CASTS_PER_DAY) {
    return { allowed: false, reason: `Daily limit reached (${MAX_CASTS_PER_DAY}/day)` };
  }
  return { allowed: true };
}

function recordCast(): void {
  castsThisHour++;
  castsToday++;
}

// Deduplication cache: hash of content → timestamp
const recentCasts = new Map<string, number>();

function isDuplicate(content: string, channel: string): boolean {
  const key = `${channel}:${content}`;
  const hash = simpleHash(key);
  const lastSent = recentCasts.get(hash);
  if (lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS) {
    return true;
  }
  recentCasts.set(hash, Date.now());
  // Clean old entries
  if (recentCasts.size > 500) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, v] of recentCasts) {
      if (v < cutoff) recentCasts.delete(k);
    }
  }
  return false;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// ============================================================================
// Farcaster Config
// ============================================================================

let _config: FarcasterConfig | null = null;

function getConfig(): FarcasterConfig {
  if (!_config) {
    _config = {
      enabled: process.env.FARCASTER_ENABLE === 'true',
      neynarApiKey: process.env.NEYNAR_API_KEY || '',
      signerUuid: process.env.FARCASTER_SIGNER_UUID || '',
      fid: process.env.FARCASTER_FID,
    };
  }
  return _config;
}

export function isFarcasterEnabled(): boolean {
  const cfg = getConfig();
  return cfg.enabled && !!cfg.neynarApiKey && !!cfg.signerUuid;
}

// ============================================================================
// Core API
// ============================================================================

const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';

/**
 * Post a cast to Farcaster via Neynar API.
 *
 * @param text Cast content (max 320 chars for Farcaster)
 * @param channel Optional channel ID (e.g., 'solana', 'defi')
 * @param parentHash Optional parent cast hash for replies/threads
 */
export async function postCast(
  text: string,
  channel?: FarcasterChannel,
  parentHash?: string,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const cfg = getConfig();

  if (!cfg.enabled) {
    return { success: false, error: 'Farcaster disabled' };
  }
  if (!cfg.neynarApiKey || !cfg.signerUuid) {
    return { success: false, error: 'Missing NEYNAR_API_KEY or FARCASTER_SIGNER_UUID' };
  }

  // Rate limit check
  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    logger.warn(`[farcaster] Rate limited: ${rateCheck.reason}`);
    return { success: false, error: rateCheck.reason };
  }

  // Dedup check
  if (channel && isDuplicate(text, channel)) {
    logger.debug(`[farcaster] Duplicate cast skipped for /${channel}`);
    return { success: false, error: 'Duplicate content within 30min window' };
  }

  // Truncate to Farcaster's 320 char limit
  const truncated = text.length > 320 ? text.slice(0, 317) + '...' : text;

  try {
    const body: Record<string, any> = {
      signer_uuid: cfg.signerUuid,
      text: truncated,
    };

    // Add channel targeting
    if (channel) {
      body.channel_id = channel;
    }

    // Thread support
    if (parentHash) {
      body.parent = parentHash;
    }

    const res = await fetch(`${NEYNAR_BASE}/cast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': cfg.neynarApiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(`[farcaster] Neynar API error ${res.status}: ${errText}`);
      return { success: false, error: `API ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = (await res.json()) as NeynarCastResponse;
    recordCast();

    logger.info(`[farcaster] ✅ Cast posted${channel ? ` to /${channel}` : ''} (${truncated.length} chars)`);

    return {
      success: true,
      hash: data.cast?.hash,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[farcaster] Cast failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ============================================================================
// High-Level Publishing (Content-Type → Channel Routing)
// ============================================================================

/**
 * Publish content to the appropriate Farcaster channels based on content type.
 * Automatically routes to the right channels and deduplicates.
 *
 * @returns Array of results (one per channel targeted)
 */
export async function publishToFarcaster(
  text: string,
  contentType: ContentType,
): Promise<Array<{ channel: FarcasterChannel; success: boolean; hash?: string; error?: string }>> {
  if (!isFarcasterEnabled()) {
    return [{ channel: 'ai-agents', success: false, error: 'Farcaster not enabled' }];
  }

  const channels = CHANNEL_ROUTING[contentType] || CHANNEL_ROUTING.general;
  const results: Array<{ channel: FarcasterChannel; success: boolean; hash?: string; error?: string }> = [];

  for (const channel of channels) {
    const result = await postCast(text, channel);
    results.push({ channel, ...result });

    // Small delay between multi-channel posts
    if (channels.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  return results;
}

// ============================================================================
// Stats
// ============================================================================

export function getFarcasterStats() {
  return {
    enabled: isFarcasterEnabled(),
    castsThisHour,
    castsToday,
    maxPerHour: MAX_CASTS_PER_HOUR,
    maxPerDay: MAX_CASTS_PER_DAY,
    recentCacheSize: recentCasts.size,
  };
}
