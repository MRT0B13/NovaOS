/**
 * Guardian Agent
 *
 * Role: Comprehensive security agent — token safety, wallet protection,
 * network defense, content filtering, agent behavior monitoring, and
 * automated incident response.
 *
 * === Token Safety (Original) ===
 *   - Watched token re-scan: every 15 minutes (RugCheck safety scores)
 *   - Liquidity monitor: every 30 minutes (DexScreener LP + volume)
 *   - Scout token ingestion: every 5 minutes
 *
 * === Security Modules (New) ===
 *   - Wallet Sentinel: every 2 minutes (balance monitoring, drain detection)
 *   - Network Shield: every 3 minutes (RPC validation, API key leak detection)
 *   - Content Filter: every 5 minutes (phishing, prompt injection, secret leaks)
 *   - Agent Watchdog: every 1 minute (behavioral anomaly detection, quarantine)
 *   - Incident Response: continuous (event aggregation, escalation, alerting)
 *
 * Outgoing messages → Supervisor:
 *   - alert (critical): Rug detected, wallet drain, agent quarantined, API key leak
 *   - alert (high): Score degradation, LP drain, phishing detected, RPC issues
 *   - report (medium): Periodic safety summary, security digest
 *
 * Incoming commands ← Supervisor:
 *   - scan_token: Scan a specific token address and report back
 *   - watch_token: Add a token to the active watch list
 *   - security_status: Return full security posture report
 *   - release_agent: Release a quarantined agent
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Security modules
import {
  WalletSentinel,
  NetworkShield,
  ContentFilter,
  AgentWatchdog,
  IncidentResponse,
  ensureSecurityTables,
  type SecurityEvent,
  type IncidentCallbacks,
} from './security/index.ts';

// Ban system integration — Guardian reads (and triggers) bans
import { getBannedUsers, getBannedUsersCount, isUserBanned } from '../launchkit/services/systemReporter.ts';

// Lazy imports
let _scanToken: ((mint: string) => Promise<any>) | null = null;
let _isSafe: ((report: any) => boolean) | null = null;
let _formatReportForTelegram: ((report: any, ticker?: string) => string) | null = null;

async function loadRugcheck() {
  if (!_scanToken) {
    const mod = await import('../launchkit/services/rugcheck.ts');
    _scanToken = mod.scanToken;
    _isSafe = mod.isSafe;
    _formatReportForTelegram = mod.formatReportForTelegram;
  }
}

// ── DexScreener: Liquidity & volume data (public, no auth) ──────

interface LiquiditySnapshot {
  mint: string;
  liquidityUsd: number;
  volume24h: number;
  priceUsd: number;
  priceChange24h: number;
  fdv: number;
  pairAddress: string;
}

async function fetchDexScreenerLiquidity(mints: string[]): Promise<Map<string, LiquiditySnapshot>> {
  const result = new Map<string, LiquiditySnapshot>();
  if (mints.length === 0) return result;

  // DexScreener API accepts max 30 tokens per request — paginate in chunks
  const CHUNK_SIZE = 30;
  for (let i = 0; i < mints.length; i += CHUNK_SIZE) {
    const chunk = mints.slice(i, i + CHUNK_SIZE);
    try {
      const batch = chunk.join(',');
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`);
      if (!res.ok) continue;
      const data = await res.json() as any;
      const seen = new Set<string>();
      for (const pair of (data.pairs || [])) {
        const addr = pair.baseToken?.address;
        if (addr && !seen.has(addr) && !result.has(addr)) {
          seen.add(addr);
          result.set(addr, {
            mint: addr,
            liquidityUsd: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            priceChange24h: pair.priceChange?.h24 || 0,
            fdv: pair.fdv || 0,
            pairAddress: pair.pairAddress || '',
          });
        }
      }
      // Rate limit courtesy: small delay between chunks
      if (i + CHUNK_SIZE < mints.length) await new Promise(r => setTimeout(r, 300));
    } catch {
      // DexScreener rate limit or down — non-fatal, continue with next chunk
    }
  }
  return result;
}

// ============================================================================
// Core Solana tokens — always watched as a baseline
// ============================================================================

const CORE_WATCH_TOKENS: Array<{ mint: string; ticker: string }> = [
  { mint: 'So11111111111111111111111111111111111111112',  ticker: 'WSOL' },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', ticker: 'JitoSOL' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', ticker: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', ticker: 'WIF' },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  ticker: 'JUP' },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', ticker: 'PYTH' },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  ticker: 'JTO' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', ticker: 'RAY' },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  ticker: 'ORCA' },
  { mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', ticker: 'DRIFT' },
  { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', ticker: 'W' },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', ticker: 'POPCAT' },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  ticker: 'RENDER' },
];

// ============================================================================
// Guardian Agent
// ============================================================================

interface WatchedToken {
  mint: string;
  ticker?: string;
  lastScore: number;
  lastCheckedAt: number;
  addedAt: number;
  source: 'core' | 'launched' | 'scout' | 'manual';
  // Liquidity tracking
  lastLiquidityUsd?: number;
  lastVolume24h?: number;
  lastPriceUsd?: number;
  lastLiquidityCheckAt?: number;
}

export class GuardianAgent extends BaseAgent {
  private watchList: Map<string, WatchedToken> = new Map();
  private rescanIntervalMs: number;
  private liquidityCheckIntervalMs: number;
  private scanCount = 0;
  private liquidityAlertCount = 0;

  // ── Security Modules ──────────────────────────────────────────
  private walletSentinel: WalletSentinel;
  private networkShield: NetworkShield;
  private contentFilter: ContentFilter;
  private agentWatchdog: AgentWatchdog;
  private incidentResponse: IncidentResponse;
  private securityInitialized = false;

  constructor(pool: Pool, opts?: { rescanIntervalMs?: number; liquidityCheckIntervalMs?: number }) {
    super({
      agentId: 'nova-guardian',
      agentType: 'guardian',
      pool,
    });
    this.rescanIntervalMs = opts?.rescanIntervalMs ?? 15 * 60 * 1000; // 15 min
    this.liquidityCheckIntervalMs = opts?.liquidityCheckIntervalMs ?? 30 * 60 * 1000; // 30 min

    // Initialize security modules with shared incident response pipeline
    this.incidentResponse = new IncidentResponse(pool);
    const reporter = (event: SecurityEvent) => this.handleSecurityEvent(event);
    this.walletSentinel = new WalletSentinel(pool, reporter);
    this.networkShield = new NetworkShield(pool, reporter);
    this.contentFilter = new ContentFilter(pool, reporter);
    this.agentWatchdog = new AgentWatchdog(pool, reporter);
  }

  /** Set external notification callbacks for incident response */
  setSecurityCallbacks(callbacks: IncidentCallbacks): void {
    this.incidentResponse.setCallbacks(callbacks);
  }

  /** Wire the agent stop callback so quarantine can actually halt a running agent */
  setStopAgentCallback(cb: (agentName: string) => Promise<void>): void {
    this.agentWatchdog.setStopAgentCallback(cb);
  }

  /** Central security event handler — routes all events through incident response */
  private async handleSecurityEvent(event: SecurityEvent): Promise<void> {
    // Route through incident response for aggregation & escalation
    await this.incidentResponse.handleEvent(event);

    // Also report critical/emergency events to supervisor
    if (event.severity === 'critical' || event.severity === 'emergency') {
      await this.reportToSupervisor('alert', event.severity === 'emergency' ? 'critical' : 'high', {
        securityEvent: true,
        category: event.category,
        severity: event.severity,
        title: event.title,
        details: event.details,
        autoResponse: event.autoResponse,
      });
    }
  }

  protected async onStart(): Promise<void> {
    // Restore persisted counters from DB (survive restarts)
    await this.restorePersistedState();

    this.startHeartbeat(60_000);

    // ── Token Safety (Original) ────────────────────────────────

    // Periodic re-scan of watched tokens (RugCheck safety)
    this.addInterval(() => this.rescanWatchList(), this.rescanIntervalMs);

    // Liquidity monitoring (DexScreener — LP + volume)
    this.addInterval(() => this.monitorLiquidity(), this.liquidityCheckIntervalMs);

    // Listen for supervisor commands (scan requests)
    this.addInterval(() => this.processCommands(), 10_000);

    // Ingest scout intel for new tokens every 5 minutes
    this.addInterval(() => this.ingestScoutTokens(), 5 * 60 * 1000);

    // ── Security Modules ───────────────────────────────────────

    try {
      // Ensure security DB tables exist
      await ensureSecurityTables(this.pool);

      // Initialize all security modules
      this.walletSentinel.init();
      this.networkShield.init();
      this.contentFilter.init();
      this.agentWatchdog.init();

      // Wallet Sentinel: check every 2 minutes
      this.addInterval(() => this.walletSentinel.check(), 2 * 60 * 1000);

      // Network Shield: validate RPCs every 3 minutes
      this.addInterval(() => this.networkShield.checkRpcEndpoints(), 3 * 60 * 1000);

      // Network Shield: check rate anomalies every 1 minute
      this.addInterval(() => this.networkShield.checkRateAnomalies(), 60 * 1000);

      // Content Filter: scan agent messages every 5 minutes
      this.addInterval(() => this.contentFilter.scanRecentMessages(), 5 * 60 * 1000);

      // Agent Watchdog: behavioral analysis every 1 minute
      this.addInterval(() => this.agentWatchdog.check(), 60 * 1000);

      // Incident Response: cleanup stale incidents every 15 minutes
      this.addInterval(() => this.incidentResponse.cleanup(), 15 * 60 * 1000);

      // Security status persistence every 5 minutes
      this.addInterval(() => this.persistState(), 5 * 60 * 1000);

      this.securityInitialized = true;
      logger.info('[guardian] 🛡️ Security modules initialized: WalletSentinel, NetworkShield, ContentFilter, AgentWatchdog, IncidentResponse');
    } catch (err) {
      logger.warn('[guardian] Security modules failed to initialize (non-fatal, token safety still active):', err);
    }

    // ── Token Loading ──────────────────────────────────────────

    // 1. Load core ecosystem tokens — always-on baseline
    for (const t of CORE_WATCH_TOKENS) {
      this.addToWatchList(t.mint, t.ticker, 'core');
    }

    // 2. Load launched tokens from DB (launchpacks)
    await this.loadWatchListFromDB();

    // 3. Ingest any tokens from scout intel
    await this.ingestScoutTokens();

    // 4. First liquidity snapshot (baseline, no alerts)
    await this.monitorLiquidity(true);

    // 5. First wallet snapshot (baseline)
    if (this.securityInitialized) {
      await this.walletSentinel.check();
      await this.networkShield.checkRpcEndpoints();
    }

    logger.info(`[guardian] Monitoring ${this.watchList.size} tokens (${CORE_WATCH_TOKENS.length} core + DB + scout), re-scan every ${this.rescanIntervalMs / 60000}m, liquidity every ${this.liquidityCheckIntervalMs / 60000}m`);
  }

  // ── Watch List Management ────────────────────────────────────────

  /** Add a token to the watch list */
  addToWatchList(mint: string, ticker?: string, source: WatchedToken['source'] = 'manual'): void {
    if (!this.watchList.has(mint)) {
      this.watchList.set(mint, {
        mint,
        ticker,
        lastScore: -1,
        lastCheckedAt: 0,
        addedAt: Date.now(),
        source,
      });
      logger.info(`[guardian] Added ${ticker || mint.slice(0, 8)} to watch list (${source})`);
    }
  }

  /** Remove a token from the watch list */
  removeFromWatchList(mint: string): void {
    this.watchList.delete(mint);
  }

  /** Load launched tokens from launchpack DB to auto-watch */
  private async loadWatchListFromDB(): Promise<void> {
    try {
      // Check if kv_store table exists before querying to avoid PG error log noise
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'kv_store' LIMIT 1`
      );
      if (tableCheck.rows.length === 0) {
        logger.debug('[guardian] No existing tokens to watch (kv_store not available)');
        return;
      }
      const result = await this.pool.query(
        `SELECT data FROM kv_store WHERE key LIKE 'launchpack:%'`,
      );
      for (const row of result.rows) {
        try {
          const pack = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          // Watch any token with a mint address (launched, graduated, or in-progress)
          if (pack?.launch?.mint) {
            this.addToWatchList(pack.launch.mint, pack.brand?.ticker || pack.brand?.name, 'launched');
          }
        } catch { /* skip malformed */ }
      }
    } catch {
      // kv_store may not exist yet — that's fine
      logger.debug('[guardian] No existing tokens to watch (kv_store not available)');
    }
  }

  // ── Scanning ─────────────────────────────────────────────────────

  /** Scan a single token and assess safety */
  async scanAndAssess(mint: string, requestedBy?: string): Promise<any> {
    await loadRugcheck();
    const report = await _scanToken!(mint);
    if (!report) return null;

    this.scanCount++;
    const safe = _isSafe!(report);

    // Persist counters after each scan (survive restarts)
    this.persistState();
    // Update watch list if we're tracking this token
    const watched = this.watchList.get(mint);
    if (watched) {
      const previousScore = watched.lastScore;
      watched.lastScore = report.score;
      watched.lastCheckedAt = Date.now();

      // Detect score degradation (higher score = riskier)
      if (previousScore >= 0 && report.score - previousScore > 20) {
        await this.reportToSupervisor('alert', 'high', {
          tokenAddress: mint,
          tokenName: watched.ticker,
          score: report.score,
          previousScore,
          alerts: [`Score degraded from ${previousScore} to ${report.score}`],
          degradation: report.score - previousScore,
        });
      }
    }

    // Critical alerts for dangerous findings
    // SKIP for core tokens — established protocol tokens (JitoSOL, PYTH, JTO, etc.)
    // naturally have high RugCheck scores due to mint/freeze authorities.
    // For core tokens we only track score degradation (handled above).
    const isCore = watched?.source === 'core';

    if (!isCore && (report.isRugged || report.mintAuthority || report.freezeAuthority)) {
      const alerts: string[] = [];
      if (report.isRugged) alerts.push('TOKEN IS RUGGED');
      if (report.mintAuthority) alerts.push('Mint authority still active');
      if (report.freezeAuthority) alerts.push('Freeze authority still active');

      await this.reportToSupervisor('alert', 'critical', {
        tokenAddress: mint,
        tokenName: watched?.ticker,
        score: report.score,
        riskLevel: report.riskLevel,
        alerts,
        isRugged: report.isRugged,
      });
    } else if (!isCore && !safe) {
      // Non-critical but unsafe (skip core tokens — they always score high)
      const alerts = report.risks?.map((r: any) => `${r.level}: ${r.name}`) || [];
      await this.reportToSupervisor('alert', 'high', {
        tokenAddress: mint,
        tokenName: watched?.ticker,
        score: report.score,
        riskLevel: report.riskLevel,
        alerts,
      });
    }

    // If scan was requested, send formatted report back
    if (requestedBy) {
      const formatted = _formatReportForTelegram!(report, watched?.ticker);
      await this.reportToSupervisor('report', 'medium', {
        requestedBy,
        report: {
          tokenName: watched?.ticker || mint.slice(0, 8),
          score: report.score,
          summary: formatted,
        },
      });
    }

    return report;
  }

  // ── Periodic Re-scan ─────────────────────────────────────────────

  private async rescanWatchList(): Promise<void> {
    if (!this.running) return;

    // Re-discover newly launched tokens from DB every cycle
    // (tokens launched after Guardian started would otherwise be missed)
    await this.loadWatchListFromDB();

    // Always log status even when no tokens to watch
    if (this.watchList.size === 0) {
      logger.info(`[guardian] Watch list: 0 tokens, ${this.scanCount} total scans — waiting for tokens from scout/launches`);
      return;
    }

    await this.updateStatus('scanning');
    let scanned = 0;
    let alerts = 0;

    for (const [mint, token] of this.watchList) {
      // Skip recently scanned tokens (at most once per rescan interval)
      if (Date.now() - token.lastCheckedAt < this.rescanIntervalMs * 0.8) continue;

      try {
        const report = await this.scanAndAssess(mint);
        if (report) {
          scanned++;
          if (report.score > 500 || report.isRugged) alerts++;
        }

        // Rate limit: small delay between scans
        await new Promise(resolve => setTimeout(resolve, 2_000));
      } catch (err) {
        logger.warn(`[guardian] Failed to re-scan ${token.ticker || mint.slice(0, 8)}:`, err);
      }
    }

    if (scanned > 0) {
      logger.info(`[guardian] Re-scanned ${scanned}/${this.watchList.size} tokens, ${alerts} alerts`);
    }
    await this.updateStatus('alive');
  }

  // ── Liquidity Monitoring ────────────────────────────────────────

  /**
   * Check DexScreener for liquidity changes across all watched tokens.
   * Alerts on: LP drain > 40%, volume spike > 5x, massive price crash > 30%.
   * @param baseline If true, just snapshot current values without alerting.
   */
  private async monitorLiquidity(baseline = false): Promise<void> {
    if (!this.running) return;

    // Only check non-core tokens that have actual DEX pairs (skip WSOL, etc.)
    const mintsToCheck = Array.from(this.watchList.entries())
      .filter(([, t]) => t.source !== 'core' || t.lastLiquidityUsd !== undefined)
      .map(([mint]) => mint);

    // Also include core tokens if we want to detect market-wide LP events
    const coreMints = CORE_WATCH_TOKENS
      .filter(t => !['WSOL'].includes(t.ticker))
      .map(t => t.mint);

    const allMints = [...new Set([...mintsToCheck, ...coreMints])];
    if (allMints.length === 0) return;

    try {
      const snapshots = await fetchDexScreenerLiquidity(allMints);
      let lpAlerts = 0;

      for (const [mint, snapshot] of snapshots) {
        const token = this.watchList.get(mint);
        if (!token) continue;

        const prevLiq = token.lastLiquidityUsd;
        const prevVol = token.lastVolume24h;
        const prevPrice = token.lastPriceUsd;

        // Update snapshot
        token.lastLiquidityUsd = snapshot.liquidityUsd;
        token.lastVolume24h = snapshot.volume24h;
        token.lastPriceUsd = snapshot.priceUsd;
        token.lastLiquidityCheckAt = Date.now();

        // Skip alerts during baseline capture
        if (baseline || prevLiq === undefined) continue;

        const name = token.ticker || mint.slice(0, 8);

        // LP DRAIN: liquidity dropped > 40%
        if (prevLiq > 1000 && snapshot.liquidityUsd < prevLiq * 0.6) {
          const dropPct = Math.round((1 - snapshot.liquidityUsd / prevLiq) * 100);
          await this.reportToSupervisor('alert', dropPct > 80 ? 'critical' : 'high', {
            tokenAddress: mint,
            tokenName: name,
            alerts: [`LP drained ${dropPct}%: $${this.formatUSD(prevLiq)} → $${this.formatUSD(snapshot.liquidityUsd)}`],
            liquidityUsd: snapshot.liquidityUsd,
            previousLiquidityUsd: prevLiq,
            type: 'lp_drain',
          });
          lpAlerts++;
        }

        // VOLUME SPIKE: 5x the previous volume (potential pump or dump)
        if (prevVol && prevVol > 100 && snapshot.volume24h > prevVol * 5) {
          await this.reportToSupervisor('alert', 'high', {
            tokenAddress: mint,
            tokenName: name,
            alerts: [`Volume surged ${Math.round(snapshot.volume24h / prevVol)}x: $${this.formatUSD(snapshot.volume24h)}`],
            volume24h: snapshot.volume24h,
            previousVolume24h: prevVol,
            type: 'volume_spike',
          });
          lpAlerts++;
        }

        // PRICE CRASH: > 30% drop since last check
        if (prevPrice && prevPrice > 0 && snapshot.priceUsd < prevPrice * 0.7) {
          const crashPct = Math.round((1 - snapshot.priceUsd / prevPrice) * 100);
          await this.reportToSupervisor('alert', crashPct > 50 ? 'critical' : 'high', {
            tokenAddress: mint,
            tokenName: name,
            alerts: [`Price crashed ${crashPct}%: $${prevPrice.toFixed(6)} → $${snapshot.priceUsd.toFixed(6)}`],
            priceUsd: snapshot.priceUsd,
            previousPriceUsd: prevPrice,
            type: 'price_crash',
          });
          lpAlerts++;
        }
      }

      this.liquidityAlertCount += lpAlerts;
      const checkedCount = snapshots.size;
      if (checkedCount > 0 && !baseline) {
        logger.info(`[guardian] Liquidity check: ${checkedCount} tokens, ${lpAlerts} alerts (${this.liquidityAlertCount} total)`);
      }
    } catch (err) {
      logger.debug('[guardian] Liquidity monitoring failed:', err);
    }
  }

  private formatUSD(value: number): string {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
    return value.toFixed(0);
  }

  // ── Scout Intel Ingestion ──────────────────────────────────────

  /** Read scout intel messages for token addresses to watch */
  private async ingestScoutTokens(): Promise<void> {
    try {
      // Read recent scout reports forwarded through supervisor
      const result = await this.pool.query(
        `SELECT payload FROM agent_messages
         WHERE to_agent = 'nova-guardian'
           AND message_type = 'intel'
           AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC
         LIMIT 20`,
      );

      let added = 0;
      for (const row of result.rows) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        // Scout sends token addresses in various formats
        const mint = payload?.tokenAddress || payload?.mint || payload?.contract;
        const ticker = payload?.ticker || payload?.symbol || payload?.tokenName;
        if (mint && typeof mint === 'string' && mint.length >= 32 && mint.length <= 44) {
          if (!this.watchList.has(mint)) {
            this.addToWatchList(mint, ticker, 'scout');
            added++;
          }
        }
      }

      // Also check for tokens sent via broadcast from supervisor
      const broadcasts = await this.pool.query(
        `SELECT payload FROM agent_messages
         WHERE to_agent = 'nova-guardian'
           AND message_type = 'command'
           AND payload::text LIKE '%watch_token%'
           AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC
         LIMIT 10`,
      );
      for (const row of broadcasts.rows) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (payload?.action === 'watch_token' && payload?.tokenAddress) {
          if (!this.watchList.has(payload.tokenAddress)) {
            this.addToWatchList(payload.tokenAddress, payload.ticker, 'scout');
            added++;
          }
        }
      }

      if (added > 0) {
        logger.info(`[guardian] Ingested ${added} new tokens from scout/swarm intel (total: ${this.watchList.size})`);
      }
    } catch {
      // Silently continue — table may not exist yet
    }
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'request' && msg.payload?.action === 'scan_token') {
          const { tokenAddress, requestedBy } = msg.payload;
          logger.info(`[guardian] Scan requested for ${tokenAddress}`);
          await this.scanAndAssess(tokenAddress, requestedBy);
        }
        // Accept watch_token commands from any agent
        if (msg.message_type === 'command' && msg.payload?.action === 'watch_token') {
          const { tokenAddress, ticker } = msg.payload;
          if (tokenAddress) {
            this.addToWatchList(tokenAddress, ticker, 'scout');
          }
        }
        // Security: return full security posture
        if (msg.message_type === 'command' && msg.payload?.action === 'security_status') {
          await this.reportToSupervisor('report', 'medium', {
            requestedBy: msg.payload?.requestedBy,
            securityStatus: this.getSecurityStatus(),
            incidentReport: this.incidentResponse.generateReport(),
          });
        }
        // Security: release a quarantined agent
        if (msg.message_type === 'command' && msg.payload?.action === 'release_agent') {
          const { agentName, releasedBy } = msg.payload;
          if (agentName) {
            await this.agentWatchdog.releaseAgent(agentName, releasedBy || 'supervisor');
          }
        }
        // Security: scan content on demand
        if (msg.message_type === 'command' && msg.payload?.action === 'scan_content') {
          const { content, source } = msg.payload;
          if (content && this.securityInitialized) {
            const result = this.contentFilter.scanInbound(content, undefined, source);
            await this.reportToSupervisor('report', result.clean ? 'low' : 'high', {
              requestedBy: msg.payload?.requestedBy,
              scanResult: result,
            });
          }
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── State Persistence (survive restarts) ─────────────────────────

  private async persistState(): Promise<void> {
    // Persist scout-added watchList tokens so they survive restarts
    const scoutTokens: Array<{ mint: string; ticker?: string; source: string; addedAt: number }> = [];
    for (const [mint, t] of this.watchList) {
      if (t.source === 'scout' || t.source === 'manual') {
        scoutTokens.push({ mint, ticker: t.ticker, source: t.source, addedAt: t.addedAt });
      }
    }
    await this.saveState({
      scanCount: this.scanCount,
      liquidityAlertCount: this.liquidityAlertCount,
      securityInitialized: this.securityInitialized,
      scoutTokens,
    });
  }

  private async restorePersistedState(): Promise<void> {
    const s = await this.restoreState<{
      scanCount?: number;
      liquidityAlertCount?: number;
      scoutTokens?: Array<{ mint: string; ticker?: string; source: string; addedAt: number }>;
    }>();
    if (!s) return;
    if (s.scanCount)           this.scanCount = s.scanCount;
    if (s.liquidityAlertCount) this.liquidityAlertCount = s.liquidityAlertCount;
    // Re-add persisted scout/manual tokens to watchList
    if (s.scoutTokens) {
      for (const t of s.scoutTokens) {
        if (!this.watchList.has(t.mint)) {
          this.addToWatchList(t.mint, t.ticker, (t.source as WatchedToken['source']) || 'scout');
        }
      }
    }
    logger.info(`[guardian] Restored: ${this.scanCount} scans, ${this.liquidityAlertCount} LP alerts, ${s.scoutTokens?.length || 0} persisted tokens`);
  }

  // ── Public API ───────────────────────────────────────────────────

  /** Get full security status including all modules */
  getSecurityStatus() {
    // Pull in ban cache stats
    const bannedCount = getBannedUsersCount();
    const recentBans = getBannedUsers()
      .filter(b => Date.now() - b.bannedAt < 24 * 60 * 60 * 1000); // last 24h
    const guardianBans = getBannedUsers()
      .filter(b => b.bannedBy === 0 || b.bannedByUsername === 'guardian');

    return {
      securityInitialized: this.securityInitialized,
      walletSentinel: this.securityInitialized ? this.walletSentinel.getStatus() : null,
      networkShield: this.securityInitialized ? this.networkShield.getStatus() : null,
      contentFilter: this.securityInitialized ? this.contentFilter.getStatus() : null,
      agentWatchdog: this.securityInitialized ? this.agentWatchdog.getStatus() : null,
      incidentResponse: this.securityInitialized ? this.incidentResponse.getStatus() : null,
      banCache: {
        totalBanned: bannedCount,
        bansLast24h: recentBans.length,
        guardianAutoBans: guardianBans.length,
        recentBans: recentBans.slice(-5).map(b => ({
          userId: b.id,
          username: b.username,
          reason: b.reason,
          bannedAt: new Date(b.bannedAt).toISOString(),
          bannedBy: b.bannedByUsername || String(b.bannedBy),
        })),
      },
    };
  }

  /** Expose content filter for external use (e.g., TG message handler) */
  getContentFilter(): ContentFilter | null {
    return this.securityInitialized ? this.contentFilter : null;
  }

  /** Expose network shield for external use (e.g., pre-publish scanning) */
  getNetworkShield(): NetworkShield | null {
    return this.securityInitialized ? this.networkShield : null;
  }

  getStatus() {
    // Count by source
    const bySource: Record<string, number> = {};
    for (const t of this.watchList.values()) {
      bySource[t.source] = (bySource[t.source] || 0) + 1;
    }
    return {
      agentId: this.agentId,
      running: this.running,
      watchListSize: this.watchList.size,
      watchListSources: bySource,
      totalScans: this.scanCount,
      totalLiquidityAlerts: this.liquidityAlertCount,
      security: this.getSecurityStatus(),
      watchedTokens: Array.from(this.watchList.values()).map(t => ({
        mint: t.mint.slice(0, 8) + '...',
        ticker: t.ticker,
        score: t.lastScore,
        source: t.source,
        liquidityUsd: t.lastLiquidityUsd,
        volume24h: t.lastVolume24h,
        lastChecked: t.lastCheckedAt ? new Date(t.lastCheckedAt).toISOString() : null,
      })),
    };
  }
}
