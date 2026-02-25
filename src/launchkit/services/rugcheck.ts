import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';

/**
 * RugCheck API Service
 * 
 * Integrates with https://api.rugcheck.xyz/v1 to scan tokens
 * and generate safety reports for post-launch transparency.
 * 
 * Rate limiting: In-memory cache prevents duplicate scans. Max 20 scans/hour.
 * Auth: GET /tokens/{id}/report and /report/summary are PUBLIC (no auth needed).
 *       Bulk, verify, vote, and vault endpoints require JWT auth.
 *       JWT is obtained by signing a message with a Solana wallet via POST /v1/auth/login/solana.
 *       We only use the public GET endpoints, so no auth is required.
 */

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

// In-memory cache: mint → { report, cachedAt }
// Prevents re-scanning the same token within the cache window
const reportCache = new Map<string, { report: RugCheckReport; cachedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 100;

// Negative cache: mints that RugCheck can't process (returns 400 "unable to generate report")
// Many established protocol tokens (RAY, Orca, Drift, JUP, etc.) consistently return 400.
// Cache these for 6 hours to avoid log spam and wasted API calls.
const negativeCache = new Set<string>();
const negativeCacheExpiry = new Map<string, number>();
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Rate limiting: max scans per hour
let scansThisHour = 0;
let hourResetAt = 0;
const MAX_SCANS_PER_HOUR = 20;

export interface RugCheckReport {
  mint: string;
  score: number;              // 0 = safest, higher = riskier
  riskLevel: 'Good' | 'Warning' | 'Danger' | 'Unknown';
  mintAuthority: boolean;     // true = still active (bad)
  freezeAuthority: boolean;   // true = still active (bad)
  topHolderPct: number;       // % held by top holder
  top10HolderPct: number;     // % held by top 10
  lpLocked: boolean;
  lpLockedPct: number;
  isRugged: boolean;
  risks: RugCheckRisk[];
  scannedAt: string;          // ISO timestamp
  rawData?: any;              // Full API response for storage
}

export interface RugCheckRisk {
  name: string;
  description: string;
  level: 'info' | 'warn' | 'danger';
  score: number;
}

/**
 * Build headers for RugCheck API requests.
 * Includes API key as Bearer token if RUGCHECK_API_KEY is set.
 */
function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  try {
    const env = getEnv();
    const apiKey = (env as any).RUGCHECK_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  } catch { /* env may not be ready */ }
  return headers;
}

/**
 * Check rate limit — returns true if we can make another scan
 */
function checkRateLimit(): boolean {
  const now = Date.now();
  if (now > hourResetAt) {
    scansThisHour = 0;
    hourResetAt = now + 60 * 60 * 1000;
  }
  if (scansThisHour >= MAX_SCANS_PER_HOUR) {
    logger.debug(`[RugCheck] Rate limit: ${scansThisHour}/${MAX_SCANS_PER_HOUR} scans this hour`);
    return false;
  }
  return true;
}

/**
 * Scan a token mint address via RugCheck API (summary endpoint — lightweight)
 * Results are cached for 30 minutes to avoid duplicate calls.
 */
export async function scanToken(mint: string): Promise<RugCheckReport | null> {
  // Check cache first
  const cached = reportCache.get(mint);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    logger.debug(`[RugCheck] Cache hit for ${mint.slice(0, 8)}...`);
    return cached.report;
  }

  // Check negative cache (tokens RugCheck can't process)
  const negExpiry = negativeCacheExpiry.get(mint);
  if (negExpiry && Date.now() < negExpiry) {
    return null; // Silently skip — already logged on first failure
  }
  
  // Check rate limit
  if (!checkRateLimit()) return null;
  
  try {
    scansThisHour++;
    const res = await fetch(`${RUGCHECK_API}/tokens/${mint}/report/summary`, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (res.status === 429) {
      logger.warn('[RugCheck] API rate limited (429) — backing off');
      scansThisHour = MAX_SCANS_PER_HOUR; // Stop scanning this hour
      return null;
    }

    if (res.status === 400) {
      // RugCheck returns 400 "unable to generate report" for many established
      // protocol tokens (RAY, Orca, Drift, JUP, etc). Cache to avoid retrying.
      negativeCache.add(mint);
      negativeCacheExpiry.set(mint, Date.now() + NEGATIVE_CACHE_TTL_MS);
      logger.debug(`[RugCheck] API returned 400 for ${mint.slice(0, 8)} — cached for 6h`);
      return null;
    }

    if (!res.ok) {
      logger.warn(`[RugCheck] API returned ${res.status} for ${mint}`);
      return null;
    }

    const data = await res.json();
    const report = parseReport(mint, data);
    
    // Cache the result
    if (reportCache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const oldest = [...reportCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) reportCache.delete(oldest[0]);
    }
    reportCache.set(mint, { report, cachedAt: Date.now() });
    
    return report;
  } catch (err) {
    logger.error(`[RugCheck] Failed to scan ${mint}:`, err);
    return null;
  }
}

/**
 * Get full detailed report (more data, slower — use sparingly)
 * Only called on-demand, never in automated loops.
 * Results are cached for 30 minutes.
 */
export async function getDetailedReport(mint: string): Promise<RugCheckReport | null> {
  // Check cache first (summary cache works for detailed too)
  const cached = reportCache.get(mint);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.report;
  }

  // Check negative cache
  const negExpiry = negativeCacheExpiry.get(mint);
  if (negExpiry && Date.now() < negExpiry) {
    return null;
  }
  
  if (!checkRateLimit()) return null;
  
  try {
    scansThisHour++;
    const res = await fetch(`${RUGCHECK_API}/tokens/${mint}/report`, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (res.status === 429) {
      logger.warn('[RugCheck] API rate limited (429) — backing off');
      scansThisHour = MAX_SCANS_PER_HOUR;
      return null;
    }

    if (res.status === 400) {
      negativeCache.add(mint);
      negativeCacheExpiry.set(mint, Date.now() + NEGATIVE_CACHE_TTL_MS);
      logger.debug(`[RugCheck] Detailed API returned 400 for ${mint.slice(0, 8)} — cached for 6h`);
      return null;
    }

    if (!res.ok) {
      logger.warn(`[RugCheck] Detailed API returned ${res.status} for ${mint}`);
      return null;
    }

    const data = await res.json();
    const report = parseReport(mint, data);
    reportCache.set(mint, { report, cachedAt: Date.now() });
    return report;
  } catch (err) {
    logger.error(`[RugCheck] Failed to get detailed report for ${mint}:`, err);
    return null;
  }
}

/**
 * Parse RugCheck API response into our report format
 */
function parseReport(mint: string, data: any): RugCheckReport {
  const risks: RugCheckRisk[] = [];

  // Parse risks from API response  
  if (data.risks && Array.isArray(data.risks)) {
    for (const r of data.risks) {
      risks.push({
        name: r.name || 'Unknown',
        description: r.description || '',
        level: r.level === 'danger' ? 'danger' : r.level === 'warn' ? 'warn' : 'info',
        score: r.score || 0,
      });
    }
  }

  // Determine risk level from score
  const score = data.score ?? data.riskScore ?? 0;
  let riskLevel: RugCheckReport['riskLevel'] = 'Unknown';
  if (score <= 300) riskLevel = 'Good';
  else if (score <= 700) riskLevel = 'Warning';
  else riskLevel = 'Danger';

  // Parse token authorities
  const mintAuthority = data.tokenMeta?.mintAuthority != null && data.tokenMeta?.mintAuthority !== '';
  const freezeAuthority = data.tokenMeta?.freezeAuthority != null && data.tokenMeta?.freezeAuthority !== '';

  // Parse holder concentration
  let topHolderPct = 0;
  let top10HolderPct = 0;
  if (data.topHolders && Array.isArray(data.topHolders)) {
    if (data.topHolders.length > 0) {
      topHolderPct = (data.topHolders[0].pct || 0) * 100;
    }
    top10HolderPct = data.topHolders
      .slice(0, 10)
      .reduce((sum: number, h: any) => sum + (h.pct || 0), 0) * 100;
  }

  // LP info
  const lpLocked = data.markets?.[0]?.lp?.lpLocked === true;
  const lpLockedPct = data.markets?.[0]?.lp?.lpLockedPct || 0;

  return {
    mint,
    score,
    riskLevel,
    mintAuthority,
    freezeAuthority,
    topHolderPct,
    top10HolderPct,
    lpLocked,
    lpLockedPct,
    isRugged: riskLevel === 'Danger',
    risks,
    scannedAt: new Date().toISOString(),
    rawData: data,
  };
}

/**
 * Format a RugCheck report for posting to X/Twitter
 */
export function formatReportForTweet(report: RugCheckReport, ticker?: string): string {
  const symbol = ticker ? `$${ticker}` : report.mint.slice(0, 8);
  const emoji = report.riskLevel === 'Good' ? '✅' : report.riskLevel === 'Warning' ? '⚠️' : '❌';
  
  let text = `${emoji} RugCheck: ${symbol}\n\n`;
  text += `Score: ${report.score} (${report.riskLevel})\n`;
  text += `Mint authority: ${report.mintAuthority ? '⚠️ Active' : '✅ Revoked'}\n`;
  text += `Freeze authority: ${report.freezeAuthority ? '⚠️ Active' : '✅ Revoked'}\n`;
  text += `Top holder: ${report.topHolderPct.toFixed(1)}%\n`;
  
  if (report.risks.length > 0) {
    const topRisks = report.risks.filter(r => r.level !== 'info').slice(0, 2);
    if (topRisks.length > 0) {
      text += `\nFlags: ${topRisks.map(r => r.name).join(', ')}`;
    }
  }
  
  text += `\n\nhttps://rugcheck.xyz/tokens/${report.mint}`;
  
  return text;
}

/**
 * Format a RugCheck report for Telegram (HTML)
 */
export function formatReportForTelegram(report: RugCheckReport, ticker?: string): string {
  const symbol = ticker ? `$${ticker}` : report.mint.slice(0, 8);
  const emoji = report.riskLevel === 'Good' ? '✅' : report.riskLevel === 'Warning' ? '⚠️' : '❌';
  
  let text = `${emoji} <b>Safety Report: ${symbol}</b>\n\n`;
  text += `Score: ${report.score} (${report.riskLevel})\n`;
  text += `Mint authority: ${report.mintAuthority ? '⚠️ Active' : '✅ Revoked'}\n`;
  text += `Freeze authority: ${report.freezeAuthority ? '⚠️ Active' : '✅ Revoked'}\n`;
  text += `Top holder: ${report.topHolderPct.toFixed(1)}%\n`;
  text += `Top 10 holders: ${report.top10HolderPct.toFixed(1)}%\n`;
  
  if (report.risks.length > 0) {
    const dangerRisks = report.risks.filter(r => r.level === 'danger');
    const warnRisks = report.risks.filter(r => r.level === 'warn');
    
    if (dangerRisks.length > 0) {
      text += `\n❌ <b>Dangers:</b> ${dangerRisks.map(r => r.name).join(', ')}`;
    }
    if (warnRisks.length > 0) {
      text += `\n⚠️ <b>Warnings:</b> ${warnRisks.map(r => r.name).join(', ')}`;
    }
  }
  
  text += `\n\n<a href="https://rugcheck.xyz/tokens/${report.mint}">Full report on RugCheck</a>`;
  
  return text;
}

/**
 * Quick safety check - returns true if token passes basic safety
 */
export function isSafe(report: RugCheckReport): boolean {
  return !report.mintAuthority && !report.freezeAuthority && report.riskLevel !== 'Danger';
}

export default {
  scanToken,
  getDetailedReport,
  formatReportForTweet,
  formatReportForTelegram,
  isSafe,
};
