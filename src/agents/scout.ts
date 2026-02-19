/**
 * Scout Agent
 *
 * Role: Intelligence gathering — KOL scanning, narrative detection, social intel.
 * Wraps novaResearch.ts functions and feeds intel to the Supervisor via agent_messages.
 *
 * Runs on a schedule:
 *   - Full research cycle: every 8 hours (calls runResearchCycle)
 *   - Quick social scan: every 30 minutes (KOL mention patterns)
 *
 * Outgoing messages → Supervisor:
 *   - intel (high): Narrative shifts detected
 *   - intel (medium): New research cycle completed
 *   - report (low): Periodic intel summary
 *
 * Incoming commands ← Supervisor:
 *   - immediate_scan: Run a quick scan NOW (used when Supervisor needs fresh data)
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';

// Lazy imports — novaResearch has heavy deps; only import when actually used
let _runResearchCycle: (() => Promise<void>) | null = null;
let _quickSearch: ((query: string) => Promise<string | null>) | null = null;
let _getReplyIntel: ((text: string) => Promise<string | null>) | null = null;

async function loadResearch() {
  if (!_runResearchCycle) {
    const mod = await import('../launchkit/services/novaResearch.ts');
    _runResearchCycle = mod.runResearchCycle;
    _quickSearch = mod.quickSearch;
    _getReplyIntel = mod.getReplyIntel;
  }
}

// ============================================================================
// Scout Agent
// ============================================================================

export class ScoutAgent extends BaseAgent {
  private researchIntervalMs: number;
  private quickScanIntervalMs: number;
  private lastResearchAt = 0;
  private lastQuickScanAt = 0;
  private cycleCount = 0;

  constructor(pool: Pool, opts?: { researchIntervalMs?: number; quickScanIntervalMs?: number }) {
    super({
      agentId: 'nova-scout',
      agentType: 'scout',
      pool,
    });
    this.researchIntervalMs = opts?.researchIntervalMs ?? 8 * 60 * 60 * 1000; // 8 hours
    this.quickScanIntervalMs = opts?.quickScanIntervalMs ?? 5 * 60 * 1000;    // 5 minutes
  }

  protected async onStart(): Promise<void> {
    this.startHeartbeat(60_000);

    // Full research cycle
    this.addInterval(() => this.runFullResearch(), this.researchIntervalMs);

    // Quick scan cycle
    this.addInterval(() => this.runQuickScan(), this.quickScanIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 10_000);

    // Run first quick scan shortly after start (give other systems time to boot)
    setTimeout(() => this.runQuickScan(), 15_000);

    logger.info(`[scout] Research every ${this.researchIntervalMs / 3600000}h, quick scan every ${this.quickScanIntervalMs / 60000}m`);
  }

  // ── Research Cycle ───────────────────────────────────────────────

  private async runFullResearch(): Promise<void> {
    if (!this.running) return;
    try {
      await this.updateStatus('researching');
      await loadResearch();
      await _runResearchCycle!();
      this.lastResearchAt = Date.now();
      this.cycleCount++;

      // Report completion to supervisor
      await this.reportToSupervisor('intel', 'medium', {
        source: 'research_cycle',
        cycleNumber: this.cycleCount,
        completedAt: new Date().toISOString(),
      });

      await this.updateStatus('alive');
      logger.info(`[scout] Research cycle #${this.cycleCount} complete`);
    } catch (err) {
      logger.error('[scout] Research cycle failed:', err);
      await this.updateStatus('error');
    }
  }

  // ── Quick Scan ───────────────────────────────────────────────────

  private async runQuickScan(): Promise<void> {
    if (!this.running) return;
    try {
      await loadResearch();

      // Search for narrative shifts in key topics
      const topics = [
        'AI agents crypto narrative shift',
        'Solana meme coin trending',
        'pump.fun latest launches volume',
      ];

      const results: string[] = [];
      for (const topic of topics) {
        const result = await _quickSearch!(topic);
        if (result) results.push(result);
      }

      this.lastQuickScanAt = Date.now();

      // If we found significant intel, report it
      if (results.length > 0) {
        const isSignificant = results.some(
          r => r.includes('narrative') || r.includes('surge') || r.includes('breaking') || r.includes('viral')
        );

        await this.reportToSupervisor('intel', isSignificant ? 'high' : 'low', {
          source: isSignificant ? 'narrative_shift' : 'quick_scan',
          summary: results.slice(0, 3).join(' | '),
          resultsCount: results.length,
        });
      }

      await this.updateStatus('alive');
    } catch (err) {
      logger.error('[scout] Quick scan failed:', err);
    }
  }

  // ── Command Processing ───────────────────────────────────────────

  private async processCommands(): Promise<void> {
    try {
      const messages = await this.readMessages(5);
      for (const msg of messages) {
        if (msg.message_type === 'command' && msg.payload?.action === 'immediate_scan') {
          logger.info('[scout] Immediate scan requested by supervisor');
          await this.runQuickScan();
        }
        if (msg.id) await this.acknowledgeMessage(msg.id);
      }
    } catch {
      // Silent
    }
  }

  // ── Public API (for direct use if needed) ────────────────────────

  async getIntelForReply(tweetText: string): Promise<string | null> {
    await loadResearch();
    return _getReplyIntel!(tweetText);
  }

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      lastResearchAt: this.lastResearchAt ? new Date(this.lastResearchAt).toISOString() : null,
      lastQuickScanAt: this.lastQuickScanAt ? new Date(this.lastQuickScanAt).toISOString() : null,
      cycleCount: this.cycleCount,
    };
  }
}
