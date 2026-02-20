/**
 * Solana RPC Manager
 *
 * Centralised RPC URL management with automatic rotation when the
 * Health Agent detects failures.  Every service that needs a Solana
 * Connection should call `getRpcUrl()` instead of reading
 * `process.env.SOLANA_RPC_URL` directly.
 */

import { logger } from '@elizaos/core';

// ── Backup RPCs (order matters — first is tried after current fails) ──
const BACKUP_RPCS: string[] = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.helius.xyz',
  'https://mainnet.helius-rpc.com',
];

// ── State ──
let activeRpcUrl: string =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
let rotationIndex = 0;
let lastRotationAt = 0;
const ROTATION_COOLDOWN_MS = 60_000; // Don't rotate more than once per minute

/**
 * Return the currently active Solana RPC URL.
 * All services should call this rather than reading the env var.
 */
export function getRpcUrl(): string {
  return activeRpcUrl;
}

/**
 * Rotate to the next backup RPC endpoint.
 * Called by the Health Agent when the current RPC is unreachable.
 * Returns the new active URL, or null if cooldown prevents rotation.
 */
export function rotateRpc(): string | null {
  const now = Date.now();
  if (now - lastRotationAt < ROTATION_COOLDOWN_MS) {
    logger.debug('[RPC] Rotation on cooldown, skipping');
    return null;
  }

  const previous = activeRpcUrl;

  // Build candidate list: env var first, then backups
  const envRpc = process.env.SOLANA_RPC_URL || '';
  const allRpcs = [envRpc, ...BACKUP_RPCS].filter(Boolean);
  // Deduplicate while preserving order
  const unique = [...new Set(allRpcs)];

  if (unique.length <= 1) {
    logger.warn('[RPC] No backup RPCs available to rotate to');
    return null;
  }

  // Find current position and advance
  const currentIdx = unique.indexOf(activeRpcUrl);
  rotationIndex = (currentIdx + 1) % unique.length;
  activeRpcUrl = unique[rotationIndex];
  lastRotationAt = now;

  logger.info(`[RPC] Rotated: ${previous} → ${activeRpcUrl}`);
  return activeRpcUrl;
}

/**
 * Explicitly set the active RPC URL (e.g. from persisted config).
 */
export function setRpcUrl(url: string): void {
  activeRpcUrl = url;
  logger.info(`[RPC] Active URL set to ${url}`);
}
