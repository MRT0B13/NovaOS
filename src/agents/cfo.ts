/**
 * CFO Agent — Nova's Autonomous Financial Operator
 *
 * The CFO is a fully autonomous financial agent. It doesn't wait for orders —
 * it reads the portfolio, assesses risk, makes decisions, executes trades,
 * and reports results back to Nova.
 *
 * All 8 services integrated:
 *  polymarket, hyperliquid, kamino, jito, wormhole/lifi, x402, pyth, helius
 *
 * Autonomous decision engine (decisionEngine.ts):
 *  - Runs on a configurable interval (default: 30 min)
 *  - Gathers portfolio state across all chains
 *  - Applies rule-based risk assessment
 *  - Executes hedge/stake/close decisions within caps
 *  - Reports all actions to supervisor + admin Telegram
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import { getCFOEnv } from '../launchkit/cfo/cfoEnv.ts';
import { PostgresCFORepository } from '../launchkit/cfo/postgresCFORepository.ts';
import { PositionManager } from '../launchkit/cfo/positionManager.ts';
import { getDecisionConfig, runDecisionCycle, classifyTier } from '../launchkit/cfo/decisionEngine.ts';
import type { PlacedOrder, MarketOpportunity } from '../launchkit/cfo/polymarketService.ts';

// Lazy service loaders
let _poly:    any = null; const poly    = async () => _poly    ??= await import('../launchkit/cfo/polymarketService.ts');
let _jupiter: any = null; const jupiter = async () => _jupiter ??= await import('../launchkit/cfo/jupiterService.ts');
let _evm:     any = null; const evm     = async () => _evm     ??= await import('../launchkit/cfo/evmWalletService.ts');
let _hl:      any = null; const hl      = async () => _hl      ??= await import('../launchkit/cfo/hyperliquidService.ts');
let _kamino:  any = null; const kamino  = async () => _kamino  ??= await import('../launchkit/cfo/kaminoService.ts');
let _jito:    any = null; const jito    = async () => _jito    ??= await import('../launchkit/cfo/jitoStakingService.ts');
let _bridge:  any = null; const bridge  = async () => _bridge  ??= await import('../launchkit/cfo/wormholeService.ts');
let _x402:    any = null; const x402    = async () => _x402    ??= await import('../launchkit/cfo/x402Service.ts');
let _pyth:    any = null; const pyth    = async () => _pyth    ??= await import('../launchkit/cfo/pythOracleService.ts');
let _helius:  any = null; const helius  = async () => _helius  ??= await import('../launchkit/cfo/heliusService.ts');

interface ScoutIntel { cryptoBullish?: boolean; btcEstimate?: number; narratives?: string[]; receivedAt: number; }
interface PendingApproval { id: string; description: string; amountUsd: number; action: () => Promise<void>; expiresAt: number; }

export class CFOAgent extends BaseAgent {
  private repo: PostgresCFORepository | null = null;
  private positionManager: PositionManager | null = null;
  private paused = false;
  private scoutIntel: ScoutIntel | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private lastOpportunityScanAt = 0;
  private cycleCount = 0;
  private startedAt = Date.now();

  constructor(pool: Pool) {
    super({ agentId: 'nova-cfo', agentType: 'cfo' as any, pool });
  }

  protected async onStart(): Promise<void> {
    const env = getCFOEnv();

    if (!env.cfoEnabled) {
      logger.info('[CFO] CFO_ENABLE=false — idle');
      this.startHeartbeat(120_000);
      return;
    }

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        this.repo = await PostgresCFORepository.create(dbUrl);
        this.positionManager = new PositionManager(this.repo);
        logger.info('[CFO] Database ready');
      } catch (err) { logger.warn('[CFO] DB init failed:', err); }
    }

    await this.initServices(env);

    this.startHeartbeat(60_000);
    this.addInterval(() => this.runOpportunityScan(),    60 * 60_000);   // 1h
    this.addInterval(() => this.monitorPositions(),      10 * 60_000);   // 10m
    this.addInterval(() => this.monitorYield(),          30 * 60_000);   // 30m
    this.addInterval(() => this.monitorHyperliquid(),    15 * 60_000);   // 15m
    this.addInterval(() => this.checkGasReserves(),      15 * 60_000);   // 15m
    this.addInterval(() => this.processCommands(),       10_000);
    this.addInterval(() => this.checkDailyDigest(),       5 * 60_000);
    this.addInterval(() => this.expirePendingApprovals(), 2 * 60_000);
    this.addInterval(() => this.logLifeSign(),            5 * 60_000);   // visible heartbeat every 5m
    setTimeout(() => this.runOpportunityScan(), 90_000);

    // ── Autonomous Decision Engine ───────────────────────────────
    const dConfig = getDecisionConfig();
    if (dConfig.enabled) {
      const intervalMs = dConfig.intervalMinutes * 60_000;
      this.addInterval(() => this.runAutonomousDecisionCycle(), intervalMs);
      // First decision cycle after 2 minutes (let services warm up)
      setTimeout(() => this.runAutonomousDecisionCycle(), 2 * 60_000);
      logger.info(
        `[CFO] 🧠 Decision engine ON — interval: ${dConfig.intervalMinutes}m | ` +
        `hedge: ${dConfig.autoHedge} (target ${(dConfig.hedgeTargetRatio * 100).toFixed(0)}%) | ` +
        `stake: ${dConfig.autoStake} | dryRun: ${env.dryRun}`,
      );
    } else {
      logger.info('[CFO] Decision engine OFF — set CFO_AUTO_DECISIONS=true to enable autonomous trading');
    }

    logger.info(
      `[CFO] Started — poly:${env.polymarketEnabled} hl:${env.hyperliquidEnabled} ` +
      `kamino:${env.kaminoEnabled} jito:${env.jitoEnabled} ` +
      `x402:${env.x402Enabled} helius:${env.heliusEnabled} dryRun:${env.dryRun}`,
    );
  }

  private async initServices(env: ReturnType<typeof getCFOEnv>): Promise<void> {
    const issues: string[] = [];

    if (env.polymarketEnabled) {
      try {
        const evmMod = await evm();
        const status = await evmMod.getWalletStatus();
        if (status.gasCritical) {
          issues.push(`Polymarket: Polygon gas critical (${status.maticBalance.toFixed(3)} MATIC)`);
        } else {
          if (status.usdcApproved < 100) await evmMod.ensureCTFApproval();
          const health = await (await poly()).healthCheck();
          if (!health.ok) issues.push(`Polymarket CLOB auth: ${health.error}`);
          else logger.info(`[CFO] Polymarket ready — ${status.address} USDC:$${status.usdcBalance.toFixed(2)}`);
        }
      } catch (err) { issues.push(`Polymarket: ${(err as Error).message}`); }
    }

    if (env.hyperliquidEnabled) {
      try {
        const s = await (await hl()).getAccountSummary();
        logger.info(`[CFO] Hyperliquid ready — equity:$${s.equity.toFixed(2)}`);
      } catch (err) { issues.push(`Hyperliquid: ${(err as Error).message}`); }
    }

    if (env.kaminoEnabled) {
      try {
        const apys = await (await kamino()).getApys();
        logger.info(`[CFO] Kamino ready — USDC APY:${(apys.USDC.supplyApy * 100).toFixed(1)}%`);
      } catch (err) { issues.push(`Kamino: ${(err as Error).message}`); }
    }

    try {
      const solPrice = await (await pyth()).getSolPrice();
      logger.info(`[CFO] Pyth ready — SOL:$${solPrice.toFixed(2)}`);
    } catch (err) { issues.push(`Pyth: ${(err as Error).message}`); }

    if (env.jitoEnabled) logger.info('[CFO] Jito staking service ready');
    if (env.heliusEnabled) logger.info('[CFO] Helius analytics ready');

    if (issues.length) {
      logger.warn(`[CFO] Init warnings:\n${issues.map((i) => `  • ${i}`).join('\n')}`);
      await this.reportToSupervisor('alert', 'high', { event: 'cfo_init_warnings', issues });
    }
  }

  // ── Polymarket scan + execution ───────────────────────────────────
  // Polymarket bets now go through the decision engine (tier-gated).
  // This scan just triggers a decision cycle which includes Polymarket scanning.

  private async runOpportunityScan(): Promise<void> {
    if (!this.running || this.paused) return;
    const env = getCFOEnv();
    if (!env.polymarketEnabled) return;

    this.cycleCount++;
    this.lastOpportunityScanAt = Date.now();

    // Decision engine handles Polymarket bets now (with tier gating + scout intel)
    const config = getDecisionConfig();
    if (config.enabled) {
      logger.info('[CFO] Polymarket scan → routing through decision engine (tier-gated)');
      await this.runAutonomousDecisionCycle();
      return;
    }

    // Fallback: legacy direct scan if decision engine is off
    try {
      await this.updateStatus('scanning');
      const evmMod = await evm();
      const polyMod = await poly();

      const gas = await evmMod.checkGas();
      if (!gas.ok) { logger.warn(`[CFO] Gas check failed: ${gas.warning}`); return; }

      const usdcBalance = await evmMod.getUSDCBalance();
      const deployed = await polyMod.getTotalDeployed();
      const headroom = Math.min(usdcBalance, env.maxPolymarketUsd - deployed);
      if (headroom < 2) { logger.info('[CFO] Polymarket at capacity'); await this.updateStatus('idle'); return; }

      const opps = await polyMod.scanOpportunities(headroom, this.buildScoutContext());
      let newPositions = 0;
      for (const opp of opps.slice(0, 3)) {
        if (!this.running || this.paused) break;
        const order = await this.executeBet(opp);
        if (order?.status === 'LIVE' || order?.status === 'MATCHED') { newPositions++; await this.sleep(2000); }
      }

      if (newPositions > 0) {
        await this.reportToSupervisor('report', 'medium', { event: 'cfo_positions_opened', count: newPositions, strategy: 'polymarket' });
      }

      await this.updateStatus('idle');
    } catch (err) {
      logger.error('[CFO] runOpportunityScan error:', err);
      await this.updateStatus('degraded');
    }
  }

  private async executeBet(opp: MarketOpportunity): Promise<PlacedOrder | null> {
    try {
      const polyMod = await poly();
      if (this.positionManager) {
        const bal = await (await evm()).getUSDCBalance();
        const check = await this.positionManager.checkExposure('polymarket', opp.recommendedUsd, bal);
        if (!check.allowed) { logger.info(`[CFO] Bet blocked: ${check.reason}`); return null; }
      }

      if (opp.recommendedUsd > 50) {
        await this.queueForApproval(
          `BUY ${opp.targetToken.outcome} on "${opp.market.question.slice(0, 50)}" $${opp.recommendedUsd.toFixed(2)}`,
          opp.recommendedUsd,
          async () => {
            const o = await polyMod.placeBuyOrder(opp.market, opp.targetToken, opp.recommendedUsd);
            await this.persistPolyOrder(opp, o);
          },
        );
        return null;
      }

      const order = await polyMod.placeBuyOrder(opp.market, opp.targetToken, opp.recommendedUsd);
      await this.persistPolyOrder(opp, order);

      if (opp.recommendedUsd >= 10) {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        await notifyAdminForce(
          `🏦 CFO BET: ${opp.targetToken.outcome} "${opp.market.question.slice(0, 50)}"\n` +
          `$${opp.recommendedUsd.toFixed(2)} @ ${(opp.targetToken.price * 100).toFixed(1)}¢ edge:${(opp.edge * 100).toFixed(1)}%`,
        );
      }
      return order;
    } catch (err) { logger.error('[CFO] executeBet error:', err); return null; }
  }

  private async persistPolyOrder(opp: MarketOpportunity, order: PlacedOrder): Promise<void> {
    if ((order.status !== 'LIVE' && order.status !== 'MATCHED') || !this.positionManager || !this.repo) return;
    const pos = await this.positionManager.openPolymarketPosition({
      conditionId: opp.market.conditionId, question: opp.market.question,
      tokenId: opp.targetToken.tokenId, outcome: opp.targetToken.outcome,
      orderId: order.orderId, sizeUsd: opp.recommendedUsd,
      entryPrice: opp.targetToken.price, txHash: order.transactionHash,
    });
    await this.repo.insertTransaction({
      id: `tx-poly-${order.orderId}`, timestamp: new Date().toISOString(),
      chain: 'polygon', strategyTag: 'polymarket', txType: 'prediction_buy',
      tokenIn: 'USDC', amountIn: opp.recommendedUsd,
      tokenOut: opp.targetToken.tokenId, amountOut: opp.recommendedUsd / opp.targetToken.price,
      feeUsd: 0, txHash: order.transactionHash, walletAddress: '', positionId: pos.id,
      status: 'confirmed',
      metadata: { conditionId: opp.market.conditionId, outcome: opp.targetToken.outcome, rationale: opp.rationale },
    });
  }

  // ── Position monitor ──────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    if (!this.running || this.paused || !this.positionManager) return;
    const env = getCFOEnv();
    if (!env.polymarketEnabled) return;

    try {
      const polyMod = await poly();
      const freshPositions = await polyMod.fetchPositions();
      const actions = await this.positionManager.updatePolymarketPrices(freshPositions);

      for (const action of actions) {
        if (action.action !== 'STOP_LOSS' && action.action !== 'EXPIRE') continue;
        const dbPos = await this.repo?.getPosition(action.positionId);
        if (!dbPos) continue;
        const meta = dbPos.metadata as { tokenId?: string };
        const freshPos = freshPositions.find((p: any) => p.tokenId === meta.tokenId);
        if (!freshPos || freshPos.currentPrice <= 0.01) continue;

        const exitOrder = await polyMod.exitPosition(freshPos, 1.0);
        if (exitOrder.status === 'LIVE' || exitOrder.status === 'MATCHED') {
          const pnl = freshPos.currentValueUsd - dbPos.costBasisUsd;
          await this.positionManager.closePosition(
            action.positionId, freshPos.currentPrice,
            exitOrder.transactionHash ?? exitOrder.orderId, freshPos.currentValueUsd,
          );
          if (Math.abs(pnl) > 5) {
            const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
            await notifyAdminForce(`🏦 CFO ${action.action}: ${dbPos.description.slice(0, 60)}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
          }
          await this.reportToSupervisor('alert', action.urgency as any, { event: 'cfo_position_closed', action: action.action, pnlUsd: pnl, reason: action.reason });
        }
      }
    } catch (err) { logger.error('[CFO] monitorPositions error:', err); }
  }

  // ── Yield management ──────────────────────────────────────────────

  private async monitorYield(): Promise<void> {
    if (!this.running || this.paused) return;
    const env = getCFOEnv();

    if (env.kaminoEnabled) {
      try {
        const h = await (await kamino()).checkLtvHealth();
        if (!h.safe) {
          await this.reportToSupervisor('alert', 'critical', { event: 'cfo_kamino_ltv_unsafe', ltv: h.ltv, warning: h.warning });
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(`⚠️ CFO KAMINO: ${h.warning}`);
        }
      } catch (err) { logger.warn('[CFO] Kamino health check error:', err); }
    }

    if (env.jitoEnabled) {
      try {
        const jupMod = await jupiter();
        const solBalance = await jupMod.getTokenBalance(jupMod.MINTS.SOL);
        if (solBalance > env.maxJitoSol * 2) {
          const toStake = solBalance - env.maxJitoSol;
          if (toStake >= 0.1) {
            logger.info(`[CFO] Auto-staking ${toStake.toFixed(2)} SOL`);
            const jitoMod = await jito();
            const result = await jitoMod.stakeSol(toStake);
            if (result.success && this.repo) {
              await this.repo.insertTransaction({
                id: `tx-jito-${Date.now()}`, timestamp: new Date().toISOString(),
                chain: 'solana', strategyTag: 'jito', txType: 'stake',
                tokenIn: 'SOL', amountIn: toStake, tokenOut: 'JitoSOL', amountOut: result.jitoSolReceived,
                feeUsd: 0, txHash: result.txSignature, walletAddress: '', status: 'confirmed', metadata: {},
              });
            }
          }
        }
      } catch (err) { logger.warn('[CFO] Jito auto-stake error:', err); }
    }
  }

  // ── Autonomous Decision Engine ────────────────────────────────────

  private async runAutonomousDecisionCycle(): Promise<void> {
    if (!this.running || this.paused) return;

    const config = getDecisionConfig();
    if (!config.enabled) return;

    try {
      await this.updateStatus('deciding');
      const { state, decisions, results, report, intel } = await runDecisionCycle(this.pool);

      // ── Handle APPROVAL-tier decisions → queue for admin approval ─
      for (const r of results) {
        if (r.pendingApproval && r.decision.tier === 'APPROVAL') {
          const d = r.decision;
          // Create an execution closure that re-runs just this decision
          const action = async () => {
            const { executeDecision } = await import('../launchkit/cfo/decisionEngine.ts');
            // Force AUTO tier so it actually executes this time
            const overridden = { ...d, tier: 'AUTO' as const };
            const env = getCFOEnv();
            const execResult = await executeDecision(overridden, env);
            if (execResult.success && execResult.executed) {
              logger.info(`[CFO] Approved decision ${d.type} executed successfully (tx: ${execResult.txId ?? 'n/a'})`);
              const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
              await notifyAdminForce(`✅ Approved ${d.type} executed.\n${d.reasoning}\ntx: ${execResult.txId ?? 'dry-run'}`);
            } else {
              logger.error(`[CFO] Approved decision ${d.type} failed: ${execResult.error}`);
            }
          };
          await this.queueForApproval(
            `${d.type}: ${d.reasoning}`,
            Math.abs(d.estimatedImpactUsd),
            action,
          );
        }
      }

      // ── NOTIFY-tier: report to admin (already executed) ───────
      const notifyResults = results.filter(
        (r) => r.decision.tier === 'NOTIFY' && !r.pendingApproval,
      );
      if (notifyResults.length > 0) {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        const notifyLines = notifyResults.map(
          (r) => `🟡 ${r.decision.type}: $${Math.abs(r.decision.estimatedImpactUsd).toFixed(0)} — ${r.executed ? (r.success ? '✅' : '❌') : '📋'}`,
        );
        await notifyAdminForce(
          `🟡 *CFO NOTIFY* — ${notifyResults.length} decision(s) auto-executed:\n${notifyLines.join('\n')}`,
        );
      }

      // ── Report full cycle to admin if any decisions were made ──
      if (decisions.length > 0) {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        await notifyAdminForce(report);
      }

      // ── Report to Nova supervisor ─────────────────────────────
      const executedCount = results.filter((r) => r.executed && r.success).length;
      const failedCount = results.filter((r) => r.executed && !r.success).length;
      const pendingCount = results.filter((r) => r.pendingApproval).length;

      if (decisions.length > 0) {
        await this.reportToSupervisor(
          'report',
          results.some((r) => r.decision.urgency === 'critical') ? 'high' : 'medium',
          {
            event: 'cfo_autonomous_decision',
            decisions: decisions.map((d) => ({
              type: d.type,
              urgency: d.urgency,
              tier: d.tier,
              reasoning: d.reasoning,
              impactUsd: d.estimatedImpactUsd,
              intelUsed: d.intelUsed,
            })),
            executed: executedCount,
            failed: failedCount,
            pendingApproval: pendingCount,
            dryRun: getCFOEnv().dryRun,
            swarmIntel: {
              marketCondition: intel.marketCondition,
              riskMultiplier: intel.riskMultiplier,
            },
            portfolio: {
              totalUsd: state.totalPortfolioUsd,
              solBalance: state.solBalance,
              solPriceUsd: state.solPriceUsd,
              hedgeRatio: state.hedgeRatio,
              hlEquity: state.hlEquity,
              hlPnl: state.hlTotalPnl,
            },
          },
        );
      }

      // Persist decision cycle to DB for audit trail
      if (this.repo && decisions.length > 0) {
        try {
          await this.pool.query(
            `INSERT INTO kv_store (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = $2`,
            [
              `cfo_decision_${Date.now()}`,
              JSON.stringify({
                timestamp: new Date().toISOString(),
                state: {
                  solBalance: state.solBalance,
                  solPriceUsd: state.solPriceUsd,
                  hedgeRatio: state.hedgeRatio,
                  totalPortfolioUsd: state.totalPortfolioUsd,
                },
                swarmIntel: {
                  marketCondition: intel.marketCondition,
                  riskMultiplier: intel.riskMultiplier,
                },
                decisions: decisions.map((d) => ({ type: d.type, urgency: d.urgency, tier: d.tier, impactUsd: d.estimatedImpactUsd, intelUsed: d.intelUsed })),
                results: results.map((r) => ({ type: r.decision.type, tier: r.decision.tier, executed: r.executed, success: r.success, pendingApproval: r.pendingApproval, error: r.error })),
                dryRun: getCFOEnv().dryRun,
              }),
            ],
          );
        } catch { /* non-fatal */ }
      }

      await this.updateStatus('idle');
    } catch (err) {
      logger.error('[CFO] Decision cycle error:', err);
      await this.updateStatus('degraded');
    }
  }

  // ── Hyperliquid monitor ───────────────────────────────────────────

  private async monitorHyperliquid(): Promise<void> {
    if (!this.running || this.paused) return;
    if (!getCFOEnv().hyperliquidEnabled) return;

    try {
      const risk = await (await hl()).checkRisk();
      if (risk.atRisk.length > 0) {
        await this.reportToSupervisor('alert', 'high', { event: 'cfo_hl_liquidation_risk', warning: risk.warning });
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        await notifyAdminForce(`⚠️ CFO HYPERLIQUID: ${risk.warning}`);
      }
    } catch { /* non-fatal if HL not funded */ }
  }

  // ── Gas check ─────────────────────────────────────────────────────

  private async checkGasReserves(): Promise<void> {
    if (!this.running || !getCFOEnv().polymarketEnabled) return;
    try {
      const gas = await (await evm()).checkGas();
      if (!gas.ok || gas.warning) {
        await this.reportToSupervisor('alert', (!gas.ok ? 'critical' : 'high') as any, { event: 'cfo_gas', message: gas.warning, matic: gas.matic });
        if (!gas.ok) {
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(`⛽ CFO: ${gas.warning}`);
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Approval system ───────────────────────────────────────────────

  private async queueForApproval(description: string, amountUsd: number, action: () => Promise<void>): Promise<void> {
    const id = `approval-${Date.now()}`;
    this.pendingApprovals.set(id, { id, description, amountUsd, action, expiresAt: Date.now() + 15 * 60_000 });
    const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
    await notifyAdminForce(`🔐 CFO requires approval:\n${description}\n$${amountUsd.toFixed(2)}\nReply: /cfo approve ${id}\nExpires in 15 min.`);
  }

  private expirePendingApprovals(): void {
    const now = Date.now();
    for (const [id, a] of this.pendingApprovals) {
      if (now > a.expiresAt) { this.pendingApprovals.delete(id); logger.info(`[CFO] Approval expired: ${id}`); }
    }
  }

  // ── Visible life-sign (so logs show CFO is alive) ────────────────

  private async logLifeSign(): Promise<void> {
    if (!this.running) return;
    const env = getCFOEnv();
    const uptime = Math.floor((Date.now() - this.startedAt) / 60_000);
    const services: string[] = [];
    if (env.polymarketEnabled) services.push('poly');
    if (env.hyperliquidEnabled) services.push('hl');
    if (env.kaminoEnabled) services.push('kamino');
    if (env.jitoEnabled) services.push('jito');
    if (env.heliusEnabled) services.push('helius');
    if (env.x402Enabled) services.push('x402');

    const pending = this.pendingApprovals.size;
    const intel = this.scoutIntel
      ? `scout:${this.scoutIntel.cryptoBullish ? '🟢' : '🔴'}(${Math.floor((Date.now() - this.scoutIntel.receivedAt) / 60_000)}m ago)`
      : 'scout:⚪';

    logger.info(
      `[CFO] 💓 alive | uptime: ${uptime}m | cycles: ${this.cycleCount} | ` +
      `paused: ${this.paused} | dryRun: ${env.dryRun} | ` +
      `services: [${services.join(',')}] | ${intel}` +
      (pending > 0 ? ` | ⏳ ${pending} pending approval(s)` : ''),
    );
  }

  // ── Daily digest ──────────────────────────────────────────────────

  private async checkDailyDigest(): Promise<void> {
    const env = getCFOEnv();
    const now = new Date();
    if (now.getUTCHours() !== env.dailyReportHour) return;
    const todayStr = now.toISOString().slice(0, 10);
    try {
      const r = await this.pool.query(`SELECT 1 FROM kv_store WHERE key = $1 LIMIT 1`, [`cfo_digest_${todayStr}`]);
      if (r.rows.length) return;
    } catch { /* ok */ }
    await this.sendDailyDigest(todayStr);
  }

  private async sendDailyDigest(date: string): Promise<void> {
    const env = getCFOEnv();
    const lines: string[] = [`📊 *CFO Daily Digest — ${date}*\n`];

    try {
      const pythMod = await pyth();
      const prices = await pythMod.getPrices(['SOL/USD', 'ETH/USD', 'BTC/USD']);
      const solUsd = prices.get('SOL/USD')?.price ?? 0;
      lines.push(`SOL $${solUsd.toFixed(2)} | ETH $${(prices.get('ETH/USD')?.price ?? 0).toFixed(0)} | BTC $${(prices.get('BTC/USD')?.price ?? 0).toFixed(0)}\n`);

      if (this.positionManager) {
        const m = await this.positionManager.getPortfolioMetrics();
        lines.push(`*Positions:* ${m.totalOpenPositions} open`);
        lines.push(`*Unrealized P&L:* ${m.totalUnrealizedPnlUsd >= 0 ? '+' : ''}$${m.totalUnrealizedPnlUsd.toFixed(2)}`);
        lines.push(`*Realized P&L:* ${m.totalRealizedPnlUsd >= 0 ? '+' : ''}$${m.totalRealizedPnlUsd.toFixed(2)}\n`);
      }

      if (env.polymarketEnabled) {
        try {
          const [ps, ws] = await Promise.all([(await poly()).getPortfolioSummary(), (await evm()).getWalletStatus()]);
          lines.push(`*Polymarket:* ${ps.openPositions} pos | $${ps.totalDeployedUsd.toFixed(2)} deployed | PnL ${ps.unrealizedPnlUsd >= 0 ? '+' : ''}$${ps.unrealizedPnlUsd.toFixed(2)}`);
          lines.push(`*EVM:* $${ws.usdcBalance.toFixed(2)} USDC | ${ws.maticBalance.toFixed(3)} MATIC`);
        } catch { /* non-fatal */ }
      }

      if (env.jitoEnabled) {
        try {
          const sp = await (await jito()).getStakePosition(solUsd);
          if (sp.jitoSolBalance > 0) lines.push(`*Jito:* ${sp.jitoSolBalance.toFixed(4)} JitoSOL ≈ $${sp.jitoSolValueUsd.toFixed(2)} (${sp.apy.toFixed(1)}% APY)`);
        } catch { /* non-fatal */ }
      }

      if (env.kaminoEnabled) {
        try {
          const pos = await (await kamino()).getPosition();
          if (pos.deposits.length) lines.push(`*Kamino:* $${pos.deposits.reduce((s: number, d: any) => s + d.valueUsd, 0).toFixed(2)} deposited | health ${pos.healthFactor.toFixed(2)}`);
        } catch { /* non-fatal */ }
      }

      if (env.hyperliquidEnabled) {
        try {
          const hs = await (await hl()).getAccountSummary();
          lines.push(`*Hyperliquid:* $${hs.equity.toFixed(2)} equity | ${hs.positions.length} pos | PnL ${hs.totalPnl >= 0 ? '+' : ''}$${hs.totalPnl.toFixed(2)}`);
        } catch { /* non-fatal */ }
      }

      if (env.x402Enabled) {
        try {
          const rev = (await x402()).getRevenue();
          if (rev.totalCalls > 0) lines.push(`\n*x402:* $${rev.totalEarned.toFixed(4)} earned | $${rev.last24h.toFixed(4)} today | ${rev.totalCalls} calls`);
        } catch { /* non-fatal */ }
      }

      lines.push(`\n_Cycles: ${this.cycleCount} | Paused: ${this.paused}_`);
    } catch (err) {
      lines.push(`\n_Error: ${(err as Error).message}_`);
    }

    const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
    await notifyAdminForce(lines.join('\n'));

    if (this.repo && this.positionManager) {
      try {
        const m = await this.positionManager.getPortfolioMetrics();
        const solPrice = (await (await pyth()).getPrice('SOL/USD'))?.price ?? 0;
        await this.repo.upsertDailySnapshot({
          date, totalPortfolioUsd: m.totalValueUsd, solPriceUsd: solPrice,
          byStrategy: Object.fromEntries(Object.entries(m.byStrategy).map(([k, v]: any) => [k, { valueUsd: v.totalValueUsd, pnl24h: v.unrealizedPnlUsd }])),
          realizedPnl24h: 0, unrealizedPnl: m.totalUnrealizedPnlUsd,
          yieldEarned24h: 0, x402Revenue24h: 0,
          polymarketPnl24h: (m.byStrategy as any)['polymarket']?.unrealizedPnlUsd ?? 0,
          openPositions: m.totalOpenPositions,
        });
      } catch { /* non-fatal */ }
    }

    try {
      await this.pool.query(
        `INSERT INTO kv_store (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [`cfo_digest_${date}`, JSON.stringify({ sentAt: new Date().toISOString() })],
      );
    } catch { /* ok */ }

    logger.info('[CFO] Daily digest sent');
  }

  // ── Scout intel ───────────────────────────────────────────────────

  private buildScoutContext() {
    if (!this.scoutIntel || Date.now() - this.scoutIntel.receivedAt > 8 * 3600_000) return undefined;
    return { cryptoBullish: this.scoutIntel.cryptoBullish, btcAbove: this.scoutIntel.btcEstimate, relevantNarratives: this.scoutIntel.narratives ?? [] };
  }

  // ── Command processing ────────────────────────────────────────────

  private async processCommands(): Promise<void> {
    if (!this.running) return;
    try {
      const messages = await this.readMessages(20);
      for (const msg of messages) {
        await this.acknowledgeMessage(msg.id!);
        await this.handleMessage(msg).catch((err) => logger.error('[CFO] handleMessage error:', err));
      }
    } catch { /* non-fatal */ }
  }

  private async handleMessage(msg: any): Promise<void> {
    const payload = msg.payload as Record<string, any>;
    const cmd = payload.command ?? payload.event;
    const notify = async (text: string) => {
      const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
      await notifyAdminForce(text);
    };

    switch (cmd) {
      case 'cfo_stop': this.paused = true; logger.info('[CFO] PAUSED'); break;
      case 'cfo_start': this.paused = false; logger.info('[CFO] RESUMED'); break;

      case 'cfo_close_poly': {
        logger.warn('[CFO] Emergency: closing all Polymarket positions');
        const polyMod = await poly();
        await polyMod.cancelAllOrders();
        for (const p of await polyMod.fetchPositions()) await polyMod.exitPosition(p, 1.0);
        break;
      }

      case 'cfo_close_hl': {
        logger.warn('[CFO] Emergency: closing all Hyperliquid positions');
        await (await hl()).closeAllPositions();
        break;
      }

      case 'cfo_close_all': {
        logger.error('[CFO] EMERGENCY: closing ALL positions');
        this.paused = true;
        const polyMod = await poly();
        const hlMod = await hl();
        await Promise.allSettled([polyMod.cancelAllOrders(), hlMod.closeAllPositions()]);
        for (const p of await polyMod.fetchPositions()) await polyMod.exitPosition(p, 1.0);
        break;
      }

      case 'cfo_status': await this.sendStatusReport(); break;
      case 'cfo_scan': setTimeout(() => this.runOpportunityScan(), 100); break;
      case 'cfo_decide': setTimeout(() => this.runAutonomousDecisionCycle(), 100); break;

      case 'cfo_approve': {
        const a = this.pendingApprovals.get(payload.approvalId);
        if (a) {
          this.pendingApprovals.delete(payload.approvalId);
          await a.action();
          await notify(`✅ CFO: Executed: ${a.description}`);
        }
        break;
      }

      case 'cfo_stake': {
        const amount = Number(payload.amount);
        if (amount > 0) {
          const result = await (await jito()).stakeSol(amount);
          await notify(result.success ? `✅ Staked ${amount} SOL → ${result.jitoSolReceived.toFixed(4)} JitoSOL` : `❌ Stake failed: ${result.error}`);
        }
        break;
      }

      case 'cfo_deposit': {
        const { asset, amount } = payload;
        if ((asset === 'USDC' || asset === 'SOL') && amount > 0) {
          const result = await (await kamino()).deposit(asset, amount);
          await notify(result.success ? `✅ Deposited ${amount} ${asset} into Kamino` : `❌ Deposit failed: ${result.error}`);
        }
        break;
      }

      case 'cfo_hedge': {
        const { solExposureUsd, leverage } = payload;
        if (solExposureUsd > 0) {
          const result = await (await hl()).hedgeSolTreasury({ solExposureUsd, leverage });
          await notify(result.success ? `✅ Hedge opened: SHORT $${solExposureUsd} SOL @ ${leverage}x` : `❌ Hedge failed: ${result.error}`);
        }
        break;
      }

      case 'scout_intel':
      case 'narrative_update':
        this.scoutIntel = { cryptoBullish: payload.cryptoBullish, btcEstimate: payload.btcPriceEstimate, narratives: payload.topNarratives ?? [], receivedAt: Date.now() };
        break;

      case 'market_crash':
      case 'emergency_exit': {
        logger.error(`[CFO] Emergency from ${msg.from_agent}: ${payload.message}`);
        this.paused = true;
        // Only attempt to close positions on services that are actually enabled
        const cfoEnv = getCFOEnv();
        const closeOps: Promise<any>[] = [];
        if (cfoEnv.polymarketEnabled) {
          closeOps.push((await poly()).cancelAllOrders().catch((e: any) => logger.error('[CFO] Emergency poly cancel failed:', e)));
        }
        if (cfoEnv.hyperliquidEnabled) {
          closeOps.push((await hl()).closeAllPositions().catch((e: any) => logger.error('[CFO] Emergency HL close failed:', e)));
        }
        if (closeOps.length > 0) {
          await Promise.allSettled(closeOps);
        }
        await notify(`🚨 CFO PAUSED — emergency from ${msg.from_agent}: ${payload.message}`);
        break;
      }
    }
  }

  // ── Status report ─────────────────────────────────────────────────

  private async sendStatusReport(): Promise<void> {
    const env = getCFOEnv();
    const lines = [`🏦 *CFO Status*\n`, `Paused: ${this.paused ? 'YES ⚠️' : 'No ✅'}`, `Dry Run: ${env.dryRun}`, `Cycles: ${this.cycleCount}`];

    if (this.positionManager) {
      const m = await this.positionManager.getPortfolioMetrics();
      lines.push(`\nPositions: ${m.totalOpenPositions} | PnL: ${m.totalUnrealizedPnlUsd >= 0 ? '+' : ''}$${m.totalUnrealizedPnlUsd.toFixed(2)} unrealized | ${m.totalRealizedPnlUsd >= 0 ? '+' : ''}$${m.totalRealizedPnlUsd.toFixed(2)} realized`);
    }

    if (env.polymarketEnabled) {
      try {
        const s = await (await evm()).getWalletStatus();
        lines.push(`\nPolygon: $${s.usdcBalance.toFixed(2)} USDC | ${s.maticBalance.toFixed(3)} MATIC ${s.gasOk ? '✅' : '⚠️'}`);
      } catch { /* non-fatal */ }
    }

    if (this.pendingApprovals.size > 0) {
      lines.push(`\n⏳ ${this.pendingApprovals.size} pending approval(s):`);
      for (const [id, a] of this.pendingApprovals) lines.push(`  /cfo approve ${id} — ${a.description}`);
    }

    const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
    await notifyAdminForce(lines.join('\n'));
  }

  // ── Public API ────────────────────────────────────────────────────

  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
  isPaused() { return this.paused; }
  getCycleCount() { return this.cycleCount; }
  setScoutIntel(intel: Omit<ScoutIntel, 'receivedAt'>) { this.scoutIntel = { ...intel, receivedAt: Date.now() }; }

  getStatus() {
    return {
      agentId: this.agentId,
      running: this.running,
      cycleCount: this.cycleCount,
      paused: this.paused,
      pendingApprovals: this.pendingApprovals.size,
      hasPositionManager: this.positionManager !== null,
      hasRepo: this.repo !== null,
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}
