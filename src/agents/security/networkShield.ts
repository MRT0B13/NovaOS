/**
 * Network Shield — RPC Validation, Rate Limiting & API Key Leak Detection
 *
 * Protects Nova's network layer:
 *   - RPC endpoint validation (detect MITM, stale data, compromised nodes)
 *   - API key leak scanning (detect secrets in outbound content)
 *   - Rate limit monitoring (detect DDoS or abuse patterns)
 *   - Request anomaly detection
 *
 * Interval: every 3 minutes (RPC validation), continuous (rate tracking)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { SecurityReporter, SecurityEvent } from './securityTypes.ts';
import { SECRET_PATTERNS, logSecurityEvent } from './securityTypes.ts';

// ============================================================================
// Types
// ============================================================================

interface RpcEndpoint {
  url: string;
  label: string;
  chain: 'solana' | 'polygon' | 'arbitrum';
  lastSlot?: number;
  lastBlockNumber?: number;
  lastCheckAt?: number;
  consecutiveFailures: number;
  validated: boolean;
}

interface RateLimitBucket {
  service: string;
  windowStart: number;
  requestCount: number;
  maxPerWindow: number;
  windowMs: number;
  blocked: boolean;
}

// ============================================================================
// Network Shield
// ============================================================================

export class NetworkShield {
  private pool: Pool;
  private report: SecurityReporter;
  private endpoints: RpcEndpoint[] = [];
  private rateBuckets: Map<string, RateLimitBucket> = new Map();
  private totalChecks = 0;
  private totalAlerts = 0;

  // Configurable thresholds
  private static readonly STALE_SLOT_THRESHOLD = 50;        // Alert if slot is behind by 50+
  private static readonly RPC_TIMEOUT_MS = 10_000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(pool: Pool, report: SecurityReporter) {
    this.pool = pool;
    this.report = report;
  }

  /** Initialize RPC endpoints from environment */
  init(): void {
    const solRpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.endpoints.push({
      url: solRpc,
      label: 'solana-primary',
      chain: 'solana',
      consecutiveFailures: 0,
      validated: false,
    });

    // Solana backup RPCs
    const backups = ['https://api.mainnet-beta.solana.com', 'https://rpc.helius.xyz'];
    for (const backup of backups) {
      if (backup !== solRpc) {
        this.endpoints.push({
          url: backup,
          label: `solana-backup`,
          chain: 'solana',
          consecutiveFailures: 0,
          validated: false,
        });
      }
    }

    // EVM RPCs
    const polygonRpc = process.env.CFO_POLYGON_RPC_URL;
    if (polygonRpc) {
      this.endpoints.push({
        url: polygonRpc,
        label: 'polygon-primary',
        chain: 'polygon',
        consecutiveFailures: 0,
        validated: false,
      });
    }

    const arbitrumRpc = process.env.CFO_ARBITRUM_RPC_URL;
    if (arbitrumRpc) {
      this.endpoints.push({
        url: arbitrumRpc,
        label: 'arbitrum-primary',
        chain: 'arbitrum',
        consecutiveFailures: 0,
        validated: false,
      });
    }

    // Initialize rate limit buckets for known services
    const services = [
      { name: 'rugcheck', maxPerWindow: 60, windowMs: 60_000 },
      { name: 'dexscreener', maxPerWindow: 30, windowMs: 60_000 },
      { name: 'jupiter', maxPerWindow: 20, windowMs: 60_000 },
      { name: 'telegram-inbound', maxPerWindow: 200, windowMs: 60_000 },
      { name: 'openai', maxPerWindow: 100, windowMs: 60_000 },
      { name: 'anthropic', maxPerWindow: 60, windowMs: 60_000 },
      { name: 'pump-portal', maxPerWindow: 15, windowMs: 60_000 },
    ];
    for (const svc of services) {
      this.rateBuckets.set(svc.name, {
        service: svc.name,
        windowStart: Date.now(),
        requestCount: 0,
        maxPerWindow: svc.maxPerWindow,
        windowMs: svc.windowMs,
        blocked: false,
      });
    }

    logger.info(`[network-shield] Monitoring ${this.endpoints.length} RPC endpoint(s), ${this.rateBuckets.size} rate buckets`);
  }

  // ── RPC Validation ───────────────────────────────────────────────

  /** Validate all RPC endpoints */
  async checkRpcEndpoints(): Promise<void> {
    this.totalChecks++;

    for (const ep of this.endpoints) {
      try {
        if (ep.chain === 'solana') {
          await this.validateSolanaRpc(ep);
        } else {
          await this.validateEvmRpc(ep);
        }
      } catch (err) {
        ep.consecutiveFailures++;
        if (ep.consecutiveFailures >= NetworkShield.MAX_CONSECUTIVE_FAILURES) {
          const event: SecurityEvent = {
            category: 'network',
            severity: 'critical',
            title: `RPC endpoint unreachable: ${ep.label}`,
            details: {
              url: ep.url.replace(/\/\/.*@/, '//***@'), // Mask auth
              chain: ep.chain,
              consecutiveFailures: ep.consecutiveFailures,
              error: String(err),
            },
            autoResponse: 'RPC rotation triggered',
          };
          this.totalAlerts++;
          await this.report(event);
          await logSecurityEvent(this.pool, event);
        }
      }
    }
  }

  /** Validate a Solana RPC endpoint */
  private async validateSolanaRpc(ep: RpcEndpoint): Promise<void> {
    // Check 1: Get slot (health check)
    const slotRes = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
      signal: AbortSignal.timeout(NetworkShield.RPC_TIMEOUT_MS),
    });

    if (!slotRes.ok) {
      ep.consecutiveFailures++;
      return;
    }

    const slotData = await slotRes.json() as any;
    if (slotData.error) {
      ep.consecutiveFailures++;
      return;
    }

    const currentSlot = slotData.result;
    ep.lastCheckAt = Date.now();

    // Check 2: Detect stale data (slot not advancing)
    if (ep.lastSlot && currentSlot <= ep.lastSlot) {
      const event: SecurityEvent = {
        category: 'network',
        severity: 'warning',
        title: `RPC returning stale data: ${ep.label}`,
        details: {
          url: ep.url.replace(/\/\/.*@/, '//***@'),
          previousSlot: ep.lastSlot,
          currentSlot,
          message: 'Slot not advancing — possible MITM or stale cache',
        },
      };
      this.totalAlerts++;
      await this.report(event);
      await logSecurityEvent(this.pool, event);
    }

    // Check 3: Cross-validate with public RPC if using custom endpoint
    if (ep.label === 'solana-primary' && ep.url !== 'https://api.mainnet-beta.solana.com') {
      try {
        const pubRes = await fetch('https://api.mainnet-beta.solana.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getSlot', params: [] }),
          signal: AbortSignal.timeout(NetworkShield.RPC_TIMEOUT_MS),
        });
        const pubData = await pubRes.json() as any;
        const publicSlot = pubData.result;

        if (publicSlot && Math.abs(currentSlot - publicSlot) > NetworkShield.STALE_SLOT_THRESHOLD) {
          const event: SecurityEvent = {
            category: 'network',
            severity: 'critical',
            title: `RPC slot divergence: ${ep.label}`,
            details: {
              primarySlot: currentSlot,
              publicSlot,
              divergence: Math.abs(currentSlot - publicSlot),
              message: 'Primary RPC significantly behind public RPC — possible MITM or fork',
            },
            autoResponse: 'Recommend RPC rotation',
          };
          this.totalAlerts++;
          await this.report(event);
          await logSecurityEvent(this.pool, event);
        }
      } catch {
        // Public RPC check failed — non-fatal
      }
    }

    ep.lastSlot = currentSlot;
    ep.consecutiveFailures = 0;
    ep.validated = true;
  }

  /** Validate an EVM RPC endpoint */
  private async validateEvmRpc(ep: RpcEndpoint): Promise<void> {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(NetworkShield.RPC_TIMEOUT_MS),
    });

    if (!res.ok) {
      ep.consecutiveFailures++;
      return;
    }

    const data = await res.json() as any;
    if (data.error) {
      ep.consecutiveFailures++;
      return;
    }

    const blockNumber = parseInt(data.result, 16);
    ep.lastCheckAt = Date.now();

    // Detect stale blocks
    if (ep.lastBlockNumber && blockNumber <= ep.lastBlockNumber) {
      const event: SecurityEvent = {
        category: 'network',
        severity: 'warning',
        title: `EVM RPC stale: ${ep.label}`,
        details: {
          url: ep.url.replace(/\/\/.*@/, '//***@'),
          previousBlock: ep.lastBlockNumber,
          currentBlock: blockNumber,
        },
      };
      this.totalAlerts++;
      await this.report(event);
    }

    ep.lastBlockNumber = blockNumber;
    ep.consecutiveFailures = 0;
    ep.validated = true;
  }

  // ── API Key Leak Detection ───────────────────────────────────────

  /**
   * Scan text content for leaked API keys or secrets.
   * Call this before publishing any content (X posts, TG messages, etc.)
   * Returns array of detected leak patterns, or empty if clean.
   */
  scanForLeakedSecrets(text: string): string[] {
    const leaks: string[] = [];
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        // Don't include the actual match — just the pattern name
        leaks.push(pattern.source.slice(0, 30));
      }
    }

    // Also check for env var values directly
    const sensitiveEnvVars = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PUMP_PORTAL_API_KEY',
      'TELEGRAM_BOT_TOKEN', 'DISCORD_API_TOKEN', 'TWITTER_API_KEY',
      'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET',
      'AGENT_FUNDING_WALLET_SECRET', 'PUMP_PORTAL_WALLET_SECRET',
      'CFO_EVM_PRIVATE_KEY', 'CFO_HYPERLIQUID_API_WALLET_KEY',
      'CFO_POLYMARKET_API_KEY', 'CFO_POLYMARKET_API_SECRET',
    ];

    for (const envName of sensitiveEnvVars) {
      const val = process.env[envName];
      if (val && val.length > 8 && text.includes(val)) {
        leaks.push(`ENV:${envName}`);
      }
    }

    return leaks;
  }

  /**
   * Scan and report leaked secrets.
   * Returns true if content is clean, false if leaks detected.
   */
  async scanAndReport(text: string, source: string): Promise<boolean> {
    const leaks = this.scanForLeakedSecrets(text);
    if (leaks.length === 0) return true;

    const event: SecurityEvent = {
      category: 'network',
      severity: 'emergency',
      title: `API KEY LEAK DETECTED in ${source}`,
      details: {
        source,
        leakPatterns: leaks,
        contentPreview: text.slice(0, 100) + '...',
        message: 'CRITICAL: Secret was detected in outbound content. Content was blocked.',
      },
      autoResponse: 'Content blocked, admin notified',
    };
    this.totalAlerts++;
    await this.report(event);
    await logSecurityEvent(this.pool, event);
    return false;
  }

  // ── Rate Limiting ───────────────────────────────────────────────

  /**
   * Record a request for a service and check if rate limited.
   * Returns true if the request should proceed, false if blocked.
   */
  recordRequest(serviceName: string): boolean {
    const bucket = this.rateBuckets.get(serviceName);
    if (!bucket) return true; // Unknown service — allow

    const now = Date.now();

    // Reset window if expired
    if (now - bucket.windowStart > bucket.windowMs) {
      bucket.windowStart = now;
      bucket.requestCount = 0;
      bucket.blocked = false;
    }

    bucket.requestCount++;

    if (bucket.requestCount > bucket.maxPerWindow) {
      if (!bucket.blocked) {
        bucket.blocked = true;
        // Fire-and-forget alert (don't await in hot path)
        this.report({
          category: 'network',
          severity: 'warning',
          title: `Rate limit exceeded: ${serviceName}`,
          details: {
            service: serviceName,
            requestCount: bucket.requestCount,
            maxPerWindow: bucket.maxPerWindow,
            windowMs: bucket.windowMs,
          },
          autoResponse: 'Requests throttled',
        }).catch(() => {});
      }
      return false;
    }

    return true;
  }

  /** Check for abnormal rate patterns across all services */
  async checkRateAnomalies(): Promise<void> {
    for (const [name, bucket] of this.rateBuckets) {
      const now = Date.now();
      const elapsed = now - bucket.windowStart;

      // Only check active windows
      if (elapsed > bucket.windowMs) continue;

      // Alert if usage is > 80% of limit
      const usagePct = (bucket.requestCount / bucket.maxPerWindow) * 100;
      if (usagePct > 80 && !bucket.blocked) {
        const event: SecurityEvent = {
          category: 'network',
          severity: 'info',
          title: `High API usage: ${name} (${usagePct.toFixed(0)}%)`,
          details: {
            service: name,
            requestCount: bucket.requestCount,
            maxPerWindow: bucket.maxPerWindow,
            usagePercent: usagePct.toFixed(1),
          },
        };
        await logSecurityEvent(this.pool, event);
      }
    }
  }

  /** Get status summary */
  getStatus() {
    return {
      endpointsMonitored: this.endpoints.length,
      endpoints: this.endpoints.map(ep => ({
        label: ep.label,
        chain: ep.chain,
        validated: ep.validated,
        consecutiveFailures: ep.consecutiveFailures,
        lastSlot: ep.lastSlot,
        lastBlockNumber: ep.lastBlockNumber,
      })),
      rateBuckets: Object.fromEntries(
        Array.from(this.rateBuckets.entries()).map(([k, v]) => [k, {
          requests: v.requestCount,
          max: v.maxPerWindow,
          blocked: v.blocked,
        }]),
      ),
      totalChecks: this.totalChecks,
      totalAlerts: this.totalAlerts,
    };
  }
}
