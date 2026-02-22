/**
 * Content Filter — Phishing Detection, Prompt Injection Defense & LLM Output Scanning
 *
 * Scans all content flowing through Nova:
 *   - Inbound TG messages: phishing links, scam addresses, prompt injection
 *   - LLM output: hallucinated URLs, leaked secrets, suspicious wallet addresses
 *   - X posts: pre-publish content validation
 *
 * Can be used both as:
 *   - Scheduled scanner (checks agent_messages for flagged content)
 *   - Real-time filter (call scanInboundMessage() / scanOutboundContent())
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { SecurityReporter, SecurityEvent } from './securityTypes.ts';
import {
  KNOWN_PHISHING_DOMAINS,
  PHISHING_URL_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
  KNOWN_SCAM_ADDRESSES,
  SECRET_PATTERNS,
  logSecurityEvent,
  extractUrls,
  extractSolanaAddresses,
  hashContent,
} from './securityTypes.ts';

// ============================================================================
// Types
// ============================================================================

export interface ContentScanResult {
  clean: boolean;
  threats: ContentThreat[];
}

export interface ContentThreat {
  type: 'phishing_link' | 'scam_address' | 'prompt_injection' | 'leaked_secret' | 'suspicious_content';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  match?: string;
}

// ============================================================================
// Content Filter
// ============================================================================

export class ContentFilter {
  private pool: Pool;
  private report: SecurityReporter;
  private totalScans = 0;
  private totalBlocked = 0;
  private blockedHashes: Set<string> = new Set(); // In-memory dedup

  constructor(pool: Pool, report: SecurityReporter) {
    this.pool = pool;
    this.report = report;
  }

  init(): void {
    // Load previously blocked content hashes
    this.loadBlockedHashes().catch(() => {});
    logger.info('[content-filter] Initialized with ' +
      `${KNOWN_PHISHING_DOMAINS.length} known phishing domains, ` +
      `${PHISHING_URL_PATTERNS.length} URL patterns, ` +
      `${PROMPT_INJECTION_PATTERNS.length} injection patterns`);
  }

  /** Load recent blocked content hashes from DB */
  private async loadBlockedHashes(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT content_hash FROM content_blocks
         WHERE created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC LIMIT 500`,
      );
      for (const row of rows) {
        this.blockedHashes.add(row.content_hash);
      }
    } catch { /* table might not exist yet */ }
  }

  // ── Core Scanning ────────────────────────────────────────────────

  /**
   * Scan inbound content (TG messages, user input).
   * Returns scan result with all detected threats.
   */
  scanInbound(text: string, userId?: string, chatId?: string): ContentScanResult {
    this.totalScans++;
    const threats: ContentThreat[] = [];

    // 1. Check for phishing links
    const urls = extractUrls(text);
    for (const url of urls) {
      const phishResult = this.checkPhishingUrl(url);
      if (phishResult) threats.push(phishResult);
    }

    // 2. Check for scam Solana addresses
    const addresses = extractSolanaAddresses(text);
    for (const addr of addresses) {
      if (KNOWN_SCAM_ADDRESSES.has(addr)) {
        threats.push({
          type: 'scam_address',
          severity: 'critical',
          description: `Known scam address detected: ${addr.slice(0, 8)}...`,
          match: addr,
        });
      }
    }

    // 3. Check for prompt injection
    const injectionResult = this.checkPromptInjection(text);
    if (injectionResult) threats.push(injectionResult);

    // 4. Check for leaked secrets / private keys
    const secretResult = this.checkLeakedSecrets(text);
    if (secretResult) threats.push(secretResult);

    // Log and report if threats found
    if (threats.length > 0) {
      this.totalBlocked++;
      const hash = hashContent(text);
      if (!this.blockedHashes.has(hash)) {
        this.blockedHashes.add(hash);
        // Fire-and-forget DB logging and reporting
        this.logAndReport(text, threats, userId, chatId, 'inbound').catch(() => {});
      }
    }

    return { clean: threats.length === 0, threats };
  }

  /**
   * Scan outbound content (LLM output, X posts, TG announcements).
   * Checks for hallucinated URLs, leaked secrets, suspicious addresses.
   */
  scanOutbound(text: string, destination: string): ContentScanResult {
    this.totalScans++;
    const threats: ContentThreat[] = [];

    // 1. Check for leaked secrets in output
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        threats.push({
          type: 'leaked_secret',
          severity: 'critical',
          description: 'API key or secret detected in outbound content',
        });
        break; // One is enough to block
      }
    }

    // 2. Check for env var values leaking
    const sensitiveVars = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PUMP_PORTAL_API_KEY',
      'TELEGRAM_BOT_TOKEN', 'AGENT_FUNDING_WALLET_SECRET',
      'PUMP_PORTAL_WALLET_SECRET', 'CFO_EVM_PRIVATE_KEY',
      'CFO_POLYMARKET_API_SECRET', 'CFO_HYPERLIQUID_API_WALLET_KEY',
    ];
    for (const envName of sensitiveVars) {
      const val = process.env[envName];
      if (val && val.length > 8 && text.includes(val)) {
        threats.push({
          type: 'leaked_secret',
          severity: 'critical',
          description: `Environment variable ${envName} leaked in outbound content`,
        });
      }
    }

    // 3. Check for suspicious URLs in LLM output (hallucinated links)
    const urls = extractUrls(text);
    for (const url of urls) {
      const phishResult = this.checkPhishingUrl(url);
      if (phishResult) {
        threats.push({
          ...phishResult,
          description: `LLM hallucinated suspicious URL: ${url.slice(0, 60)}`,
        });
      }
    }

    // 4. Check for Solana private key patterns in output
    const privKeyPattern = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
    if (privKeyPattern.test(text)) {
      threats.push({
        type: 'leaked_secret',
        severity: 'critical',
        description: 'Possible Solana private key in outbound content',
      });
    }

    if (threats.length > 0) {
      this.totalBlocked++;
      this.logAndReport(text, threats, undefined, undefined, `outbound:${destination}`).catch(() => {});
    }

    return { clean: threats.length === 0, threats };
  }

  // ── URL Analysis ────────────────────────────────────────────────

  /** Check a single URL against phishing patterns */
  private checkPhishingUrl(url: string): ContentThreat | null {
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return null; // Invalid URL
    }

    // Check against known phishing domains
    for (const domain of KNOWN_PHISHING_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return {
          type: 'phishing_link',
          severity: 'critical',
          description: `Known phishing domain: ${hostname}`,
          match: url,
        };
      }
    }

    // Check against URL patterns
    for (const pattern of PHISHING_URL_PATTERNS) {
      if (pattern.test(url)) {
        return {
          type: 'phishing_link',
          severity: 'high',
          description: `Suspicious URL pattern: ${url.slice(0, 60)}`,
          match: url,
        };
      }
    }

    // Check for URL shorteners (often used to hide phishing)
    const shorteners = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly'];
    if (shorteners.some(s => hostname === s)) {
      return {
        type: 'suspicious_content',
        severity: 'medium',
        description: `URL shortener detected: ${hostname} (could hide phishing)`,
        match: url,
      };
    }

    return null;
  }

  // ── Prompt Injection Detection ──────────────────────────────────

  /** Check text for prompt injection attempts */
  private checkPromptInjection(text: string): ContentThreat | null {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        return {
          type: 'prompt_injection',
          severity: 'high',
          description: `Prompt injection detected: "${match[0].slice(0, 50)}"`,
          match: match[0],
        };
      }
    }

    // Additional heuristics
    // Very long messages with lots of instruction-like text
    if (text.length > 2000 && (text.match(/\b(?:you must|you should|you will|you are|your task|your role)\b/gi) || []).length > 5) {
      return {
        type: 'prompt_injection',
        severity: 'medium',
        description: 'Suspicious: long message with multiple instruction-like patterns',
      };
    }

    // Base64 encoded payloads
    const base64Pattern = /[A-Za-z0-9+/]{100,}={0,2}/;
    if (base64Pattern.test(text) && text.length > 200) {
      return {
        type: 'suspicious_content',
        severity: 'medium',
        description: 'Large base64-encoded content detected (possible encoded payload)',
      };
    }

    return null;
  }

  // ── Secret Leak Detection ───────────────────────────────────────

  /** Check text for leaked private keys or secrets */
  private checkLeakedSecrets(text: string): ContentThreat | null {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        return {
          type: 'leaked_secret',
          severity: 'critical',
          description: 'Possible API key or private key detected in message',
        };
      }
    }
    return null;
  }

  // ── Periodic Scan (agent_messages) ──────────────────────────────

  /**
   * Scan recent agent messages for suspicious content.
   * Catches threats that bypassed real-time scanning.
   */
  async scanRecentMessages(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, from_agent, payload, created_at FROM agent_messages
         WHERE created_at > NOW() - INTERVAL '10 minutes'
         ORDER BY created_at DESC LIMIT 50`,
      );

      for (const row of rows) {
        const text = typeof row.payload === 'string'
          ? row.payload
          : JSON.stringify(row.payload);

        // Quick scan for secrets only (most critical)
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(text)) {
            const event: SecurityEvent = {
              category: 'content',
              severity: 'emergency',
              title: `SECRET LEAK in agent message from ${row.from_agent}`,
              details: {
                messageId: row.id,
                fromAgent: row.from_agent,
                pattern: pattern.source.slice(0, 30),
                createdAt: row.created_at,
              },
              autoResponse: 'Alert sent to admin',
            };
            await this.report(event);
            await logSecurityEvent(this.pool, event);
            break;
          }
        }
      }
    } catch { /* table might not exist */ }
  }

  // ── Logging ─────────────────────────────────────────────────────

  private async logAndReport(
    text: string,
    threats: ContentThreat[],
    userId?: string,
    chatId?: string,
    direction = 'inbound',
  ): Promise<void> {
    const severity = threats.some(t => t.severity === 'critical') ? 'critical'
      : threats.some(t => t.severity === 'high') ? 'warning' : 'info';

    const event: SecurityEvent = {
      category: 'content',
      severity: severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info',
      title: `Content threat (${direction}): ${threats.map(t => t.type).join(', ')}`,
      details: {
        direction,
        threatCount: threats.length,
        threats: threats.map(t => ({ type: t.type, severity: t.severity, description: t.description })),
        contentPreview: text.slice(0, 200),
        userId,
        chatId,
      },
      autoResponse: severity === 'critical' ? 'Content blocked' : 'Logged for review',
    };

    await this.report(event);
    await logSecurityEvent(this.pool, event);

    // Also persist to content_blocks for the worst threats
    for (const threat of threats.filter(t => t.severity === 'critical' || t.severity === 'high')) {
      try {
        await this.pool.query(
          `INSERT INTO content_blocks (block_type, content_hash, content_preview, source_user_id, source_chat_id, action_taken)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [threat.type, hashContent(text), text.slice(0, 500), userId || null, chatId || null, 'blocked'],
        );
      } catch { /* non-fatal */ }
    }
  }

  /** Get status summary */
  getStatus() {
    return {
      totalScans: this.totalScans,
      totalBlocked: this.totalBlocked,
      knownPhishingDomains: KNOWN_PHISHING_DOMAINS.length,
      urlPatterns: PHISHING_URL_PATTERNS.length,
      injectionPatterns: PROMPT_INJECTION_PATTERNS.length,
      blockedHashesInMemory: this.blockedHashes.size,
    };
  }
}
