/**
 * Wallet Utilities — encryption/decryption for user-provided wallet keys
 *
 * Used by factory-spawned agents that need to sign transactions on behalf of users.
 * Keys are encrypted with AES-256-CBC using a server-side encryption key.
 *
 * Security model:
 * - Encryption key comes from WALLET_ENCRYPTION_KEY env var
 * - Keys are encrypted immediately on receipt (in TG /wallet_key handler)
 * - Decrypted only in-memory when an agent needs to sign a tx
 * - IV is stored alongside the ciphertext (iv:ciphertext hex format)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export interface WalletConfig {
  chain: 'solana' | 'evm' | 'both';
  address: string;
  encryptedKey?: string;
  permissions: ('read' | 'trade' | 'lp')[];
}

// ============================================================================
// Encryption helpers
// ============================================================================

function getEncryptionKey(): Buffer {
  const raw = process.env.WALLET_ENCRYPTION_KEY || 'nova-default-encryption-key-32b!';
  return Buffer.from(raw.padEnd(32, '0').slice(0, 32));
}

/**
 * Encrypt a raw private key for storage.
 * Returns `iv_hex:ciphertext_hex` format.
 */
export function encryptWalletKey(privateKey: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted private key.
 * Input format: `iv_hex:ciphertext_hex`
 */
export function decryptWalletKey(encryptedKey: string): string | null {
  try {
    const [ivHex, cipherHex] = encryptedKey.split(':');
    if (!ivHex || !cipherHex) {
      logger.warn('[wallet-utils] Invalid encrypted key format (expected iv:ciphertext)');
      return null;
    }
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error('[wallet-utils] Failed to decrypt wallet key:', err);
    return null;
  }
}

// ============================================================================
// Permission guards
// ============================================================================

/**
 * Check if a wallet config has the required permission.
 * Returns true if the wallet has the permission AND a private key is available
 * (for trade/lp permissions — read doesn't need a key).
 */
export function hasPermission(
  wallet: WalletConfig | undefined,
  permission: 'read' | 'trade' | 'lp',
): boolean {
  if (!wallet) return false;
  if (!wallet.permissions.includes(permission)) return false;
  // Read permission doesn't require a private key
  if (permission === 'read') return true;
  // Trade/LP require an encrypted private key
  return !!wallet.encryptedKey;
}

/**
 * Check if a wallet is configured for a specific chain.
 */
export function supportsChain(
  wallet: WalletConfig | undefined,
  chain: 'solana' | 'evm',
): boolean {
  if (!wallet) return false;
  return wallet.chain === chain || wallet.chain === 'both';
}

/**
 * Get decrypted private key if wallet has the required permission.
 * Returns null if permission check fails or decryption fails.
 */
export function getPrivateKeyForAction(
  wallet: WalletConfig | undefined,
  action: 'trade' | 'lp',
  chain: 'solana' | 'evm',
): string | null {
  if (!wallet) return null;
  if (!hasPermission(wallet, action)) return null;
  if (!supportsChain(wallet, chain)) return null;
  if (!wallet.encryptedKey) return null;
  return decryptWalletKey(wallet.encryptedKey);
}
