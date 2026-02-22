/**
 * Guardian Security — Shared Types & Constants
 *
 * Common types, known-bad patterns, and utility functions used across
 * all Guardian security modules.
 */

import { Pool } from 'pg';

// ============================================================================
// Types
// ============================================================================

export type SecuritySeverity = 'info' | 'warning' | 'critical' | 'emergency';
export type SecurityCategory = 'wallet' | 'network' | 'content' | 'agent' | 'incident';

export interface SecurityEvent {
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  details: Record<string, any>;
  autoResponse?: string;
}

/** Callback for modules to report events to the guardian core */
export type SecurityReporter = (event: SecurityEvent) => Promise<void>;

/** Shared config passed to all security modules */
export interface SecurityModuleConfig {
  pool: Pool;
  report: SecurityReporter;
}

// ============================================================================
// Known Phishing / Scam Domains
// ============================================================================

export const KNOWN_PHISHING_DOMAINS: string[] = [
  // Crypto scam patterns
  'solana-airdrop.com', 'solana-claim.com', 'phantom-wallet.net', 'phantom-connect.com',
  'sol-airdrop.xyz', 'solana-free.com', 'phantom-update.com', 'phantom-app.net',
  'solana-rewards.com', 'jupiter-airdrop.com', 'jup-claim.com', 'raydium-claim.com',
  'solscan-verify.com', 'meteora-claim.com', 'orca-rewards.com',
  // Generic crypto phishing
  'dex-trade.io', 'uniswap-rewards.com', 'pancakeswap-claim.com',
  'opensea-verify.com', 'metamask-wallet.net', 'metamask-update.io',
  'trustwallet-update.com', 'coinbase-verify.net', 'binance-airdrop.xyz',
  'etherscan-verify.com', 'free-crypto-airdrop.com', 'claim-crypto.net',
  // Telegram-specific scam patterns
  'telegram-security.com', 'tg-verify.com', 'telegram-update.net',
];

/** Regex patterns that indicate phishing URLs (case-insensitive) */
export const PHISHING_URL_PATTERNS: RegExp[] = [
  // Fake verification/claim sites
  /(?:solana|phantom|jupiter|raydium|orca|drift|jito|bonk|wif)[\-_.]?(?:claim|airdrop|reward|verify|update|connect|auth)/i,
  // Wallet drainer patterns
  /(?:approve|connect|verify)[\-_.]?(?:wallet|token|nft)/i,
  // Fake DEX patterns
  /(?:dex|swap|bridge)[\-_.]?(?:trade|exchange|airdrop)/i,
  // IP-based URLs (never legit for crypto services)
  /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  // Suspicious TLDs commonly used in scams
  /\.(xyz|top|club|work|click|link|online|site|fun|icu|buzz)\//i,
];

// ============================================================================
// Secret / API Key Patterns
// ============================================================================

/** Regex patterns that match leaked secrets or API keys */
export const SECRET_PATTERNS: RegExp[] = [
  // Solana private keys (base58, 64-88 chars)
  /[1-9A-HJ-NP-Za-km-z]{64,88}/,
  // Ethereum/EVM private keys (hex, 64 chars with 0x prefix)
  /0x[0-9a-fA-F]{64}/,
  // Generic API keys
  /sk-[a-zA-Z0-9]{20,}/,     // OpenAI
  /sk-ant-[a-zA-Z0-9]{20,}/, // Anthropic
  /gsk_[a-zA-Z0-9]{20,}/,    // Groq
  /ghp_[a-zA-Z0-9]{36}/,     // GitHub
  /xoxb-[0-9]{10,}/,         // Slack bot
  /AIza[0-9A-Za-z_-]{35}/,   // Google API
  // Telegram bot tokens
  /\d{8,12}:[A-Za-z0-9_-]{35}/,
  // AWS keys
  /AKIA[0-9A-Z]{16}/,
];

// ============================================================================
// Prompt Injection Patterns
// ============================================================================

/** Regex patterns that indicate prompt injection attempts */
export const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // Direct override attempts
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /forget\s+(all\s+)?your\s+(previous\s+)?instructions/i,
  /disregard\s+(all\s+)?prior\s+(?:instructions|rules|guidelines)/i,
  /override\s+(?:your|the)\s+(?:system|base)\s+prompt/i,
  /you\s+are\s+now\s+(?:a|an)\s+(?:different|new|evil)/i,
  // System prompt extraction
  /(?:show|reveal|print|display|repeat|output)\s+(?:your|the)\s+(?:system|base|initial|original)\s+prompt/i,
  /what\s+(?:is|are)\s+your\s+(?:system|base|initial)\s+(?:prompt|instructions|rules)/i,
  // Role hijacking
  /pretend\s+(?:to\s+be|you\s+are|you're)\s+(?:a\s+)?(?:different|evil|hacked|compromised)/i,
  /act\s+as\s+(?:a\s+)?(?:different|new|evil)\s+(?:AI|bot|agent|system)/i,
  // DAN / jailbreak
  /\bDAN\b.*\bmode\b/i,
  /\bjailbreak\b/i,
  /developer\s+mode\s+(?:enabled|on|activated)/i,
  // Code injection in messages
  /```(?:python|javascript|bash|sh|cmd|powershell)\s*\n.*(?:import\s+os|subprocess|exec|eval|system\()/is,
  // Wallet drain via social engineering
  /(?:send|transfer|withdraw)\s+(?:all|everything|max)\s+(?:sol|tokens?|funds?|balance)/i,
  // Admin privilege escalation
  /(?:make|set|grant)\s+(?:me|user)\s+(?:an?\s+)?admin/i,
];

// ============================================================================
// Honeypot / Scam Address Patterns
// ============================================================================

/** Known scam Solana addresses (add as discovered) */
export const KNOWN_SCAM_ADDRESSES: Set<string> = new Set([
  // Add known scam addresses here as they're discovered
]);

// ============================================================================
// Utility Functions
// ============================================================================

/** Log a security event to the database */
export async function logSecurityEvent(
  pool: Pool,
  event: SecurityEvent,
  sourceAgent = 'nova-guardian',
): Promise<number | null> {
  try {
    const result = await pool.query(
      `INSERT INTO security_events (category, severity, title, details, auto_response, source_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [event.category, event.severity, event.title, JSON.stringify(event.details), event.autoResponse || null, sourceAgent],
    );
    return result.rows[0]?.id || null;
  } catch {
    // Table may not exist yet — non-fatal
    return null;
  }
}

/** Ensure security tables exist (idempotent) */
export async function ensureSecurityTables(pool: Pool): Promise<void> {
  const tables = [
    `CREATE TABLE IF NOT EXISTS security_events (
      id SERIAL PRIMARY KEY, category TEXT NOT NULL, severity TEXT NOT NULL,
      title TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', auto_response TEXT,
      source_agent TEXT DEFAULT 'nova-guardian', resolved BOOLEAN DEFAULT FALSE,
      resolved_at TIMESTAMPTZ, resolved_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS wallet_snapshots (
      id SERIAL PRIMARY KEY, wallet_address TEXT NOT NULL, wallet_label TEXT NOT NULL,
      balance_sol NUMERIC(20,9) NOT NULL, balance_lamports BIGINT NOT NULL,
      token_balances JSONB DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_quarantine (
      agent_name TEXT PRIMARY KEY, quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT NOT NULL, quarantined_by TEXT NOT NULL DEFAULT 'nova-guardian',
      severity TEXT NOT NULL DEFAULT 'critical', auto_release_at TIMESTAMPTZ,
      released BOOLEAN DEFAULT FALSE, released_at TIMESTAMPTZ, released_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS content_blocks (
      id SERIAL PRIMARY KEY, block_type TEXT NOT NULL, content_hash TEXT NOT NULL,
      content_preview TEXT, source_user_id TEXT, source_chat_id TEXT,
      action_taken TEXT NOT NULL DEFAULT 'blocked', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limit_log (
      id SERIAL PRIMARY KEY, service_name TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(), window_seconds INTEGER NOT NULL DEFAULT 60,
      blocked BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];

  for (const ddl of tables) {
    try { await pool.query(ddl); } catch { /* already exists */ }
  }
}

/** Extract URLs from text */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return text.match(urlRegex) || [];
}

/** Extract Solana addresses from text (base58, 32-44 chars) */
export function extractSolanaAddresses(text: string): string[] {
  const solRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
  return text.match(solRegex) || [];
}

/** Hash content for dedup in content_blocks */
export function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit int
  }
  return hash.toString(36);
}
