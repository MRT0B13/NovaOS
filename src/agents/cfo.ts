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
import { getDecisionConfig, runDecisionCycle, classifyTier, getCooldownState, restoreCooldownState } from '../launchkit/cfo/decisionEngine.ts';
import type { DecisionResult } from '../launchkit/cfo/decisionEngine.ts';
import type { PlacedOrder, MarketOpportunity } from '../launchkit/cfo/polymarketService.ts';
import type { TransactionType, PositionStrategy, CFOPosition } from '../launchkit/cfo/postgresCFORepository.ts';

/** Map EVM chain name strings to the CFOPosition chain union type */
function mapEvmChain(name: string): CFOPosition['chain'] {
  const m: Record<string, CFOPosition['chain']> = { base: 'base', polygon: 'polygon', arbitrum: 'arbitrum', ethereum: 'ethereum', optimism: 'optimism', avalanche: 'avalanche' };
  return m[name] ?? 'evm';
}

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
let _krystal: any = null; const krystalSvc = async () => _krystal ??= await import('../launchkit/cfo/krystalService.ts');

interface ScoutIntel { cryptoBullish?: boolean; btcEstimate?: number; narratives?: string[]; receivedAt: number; }

/**
 * Symbol → Solana mint address for tokens the CFO can hold via DeFi strategies.
 * Used to register/deregister CFO exposure with Guardian when positions open/close.
 * Update when new Orca whirlpool pairs or Kamino collateral types are added.
 */
const SOLANA_TOKEN_MINTS: Record<string, string> = {
  // Core
  'SOL':     'So11111111111111111111111111111111111111112',
  'WSOL':    'So11111111111111111111111111111111111111112',
  'USDC':    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT':    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // LSTs
  'JitoSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSOL':    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'bSOL':    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jupSOL':  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',
  'stkeSOL': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  // DEX tokens
  'BONK':    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF':     'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'JUP':     'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  // Dynamically enriched from Kamino reserve registry at startup
};

/** Lazily enrich SOLANA_TOKEN_MINTS from the Kamino reserve registry. */
let _mintsEnriched = false;
async function enrichTokenMints(): Promise<void> {
  if (_mintsEnriched) return;
  try {
    const kamino = await import('../launchkit/cfo/kaminoService.ts');
    const registry = await kamino.getReserveRegistry();
    for (const info of Object.values(registry)) {
      if (info.mint && info.symbol && !(info.symbol in SOLANA_TOKEN_MINTS)) {
        SOLANA_TOKEN_MINTS[info.symbol] = info.mint;
      }
    }
    _mintsEnriched = true;
  } catch (_e) { /* registry unavailable — use seeds */ }
}

/** Derive the set of Solana token mints involved in a given Orca pair string (e.g. "SOL/USDC"). */
function orcaPairMints(pair: string): string[] {
  return pair.split('/').map(sym => SOLANA_TOKEN_MINTS[sym]).filter(Boolean);
}

/** Serializable approval metadata — persisted to DB so approvals survive restarts */
interface SerializableApproval {
  id: string;
  description: string;
  amountUsd: number;
  decisionJson: Record<string, any>;   // Decision object (JSON-safe)
  source: 'decision_engine' | 'legacy_bet';  // which code path queued it
  createdAt: number;
  expiresAt: number;
  remindedAt?: number;                 // last reminder timestamp
}

interface PendingApproval extends SerializableApproval {
  action: () => Promise<void>;         // rebuilt from decisionJson on restore
}

export class CFOAgent extends BaseAgent {
  private repo: PostgresCFORepository | null = null;
  private positionManager: PositionManager | null = null;
  private paused = false;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private emergencyPausedUntil: number | null = null;
  private scoutIntel: ScoutIntel | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalCounter = 0;
  private lastOpportunityScanAt = 0;
  private cycleCount = 0;
  private startedAt = Date.now();

  /** Pending sell orders that were placed but not yet filled (LIVE on the book) */
  private pendingSellOrders = new Map<string, {
    orderId: string;
    positionId: string;
    costBasisUsd: number;
    description: string;
    placedAt: number;
  }>();

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

    // Restore persisted counters from DB (survive restarts)
    await this.restorePersistedState();

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        this.repo = await PostgresCFORepository.create(dbUrl);
        this.positionManager = new PositionManager(this.repo);
        logger.info('[CFO] Database ready');

        // Reconcile CFO exposure with Guardian based on currently open positions
        // This ensures correct state after restarts (positions opened before this feature)
        setTimeout(() => this.reconcileCFOExposure(), 15_000); // slight delay for guardian to be ready

        // Reconcile Polymarket ghost positions — reopen DB entries where shares still exist on-chain
        setTimeout(() => this.reconcilePolymarketGhosts(), 20_000);

        // Reload pending sell orders from DB metadata (survive restarts)
        setTimeout(() => this.reloadPendingSellOrders(), 5_000);

        // Hydrate EVM LP positions from DB and share via globalThis for decisionEngine
        this.hydrateEvmLpPositionsFromDb().then(records => {
          (globalThis as any).__cfo_evm_lp_records = records;
          if (records.length > 0) logger.info(`[CFO] Hydrated ${records.length} EVM LP position(s) from DB`);
        }).catch(() => { /* non-fatal */ });
      } catch (err) { logger.warn('[CFO] DB init failed:', err); }
    }

    await this.initServices(env);

    this.startHeartbeat(60_000);
    this.addInterval(() => this.runOpportunityScan(),    60 * 60_000);   // 1h (no-ops when decision engine is on)
    this.addInterval(() => this.monitorPositions(),      10 * 60_000);   // 10m
    this.addInterval(() => this.monitorYield(),          30 * 60_000);   // 30m
    this.addInterval(() => this.monitorHyperliquid(),    15 * 60_000);   // 15m
    this.addInterval(() => this.checkGasReserves(),      15 * 60_000);   // 15m
    this.addInterval(() => this.processCommands(),       10_000);
    this.addInterval(() => this.checkDailyDigest(),       5 * 60_000);
    this.addInterval(() => this.expirePendingApprovals(), 2 * 60_000);
    this.addInterval(() => this.logLifeSign(),            5 * 60_000);   // visible heartbeat every 5m

    // ── Autonomous Decision Engine ───────────────────────────────
    const dConfig = getDecisionConfig();
    if (dConfig.enabled) {
      const intervalMs = dConfig.intervalMinutes * 60_000;
      this.addInterval(() => this.runAutonomousDecisionCycle(), intervalMs);
      // Single first-cycle trigger (2 min warmup) — replaces both the legacy
      // 90s runOpportunityScan kickoff AND the old 120s direct call that
      // caused duplicate CFO reports on startup.
      setTimeout(() => this.runAutonomousDecisionCycle(), 2 * 60_000);
      logger.info(
        `[CFO] 🧠 Decision engine ON — interval: ${dConfig.intervalMinutes}m | ` +
        `hedge: ${dConfig.autoHedge} (target ${(dConfig.hedgeTargetRatio * 100).toFixed(0)}%) | ` +
        `stake: ${dConfig.autoStake} | dryRun: ${env.dryRun}`,
      );
    } else {
      // Legacy Polymarket-only scan — only when decision engine is OFF
      setTimeout(() => this.runOpportunityScan(), 90_000);
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
  // This method is the LEGACY fallback — only runs when decision engine is OFF.
  // When decision engine is ON, runAutonomousDecisionCycle handles everything
  // on its own interval, so this 1h call gracefully no-ops.

  private async runOpportunityScan(): Promise<void> {
    if (!this.running || this.paused) return;
    const env = getCFOEnv();
    if (!env.polymarketEnabled) return;

    // Decision engine already runs on its own interval — skip to avoid duplicates
    const config = getDecisionConfig();
    if (config.enabled) {
      logger.debug('[CFO] runOpportunityScan skipped — decision engine handles this');
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

      this.cycleCount++;
      this.lastOpportunityScanAt = Date.now();
      await this.persistState();
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
          // Legacy bet — pass enough data to identify but mark as legacy
          { type: 'POLY_BET', conditionId: opp.market.conditionId, question: opp.market.question, outcome: opp.targetToken.outcome, sizeUsd: opp.recommendedUsd },
          'legacy_bet',
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

  // ── Persist ALL decision engine results ───────────────────────────
  //
  // Every executed decision (POLY_BET, OPEN_HEDGE, CLOSE_HEDGE, AUTO_STAKE,
  // UNSTAKE_JITO, CLOSE_LOSING, POLY_EXIT) gets a position record + transaction
  // record in the DB so the CFO has a full audit trail and accurate P&L.

  private async persistDecisionResults(results: DecisionResult[]): Promise<void> {
    if (!this.positionManager || !this.repo) return;

    for (const r of results) {
      if (!r.executed || !r.success) continue;
      const d = r.decision;
      const p = d.params;
      const now = new Date().toISOString();

      try {
        switch (d.type) {
          // ── Polymarket BUY ─────────────────────────────────────
          case 'POLY_BET': {
            const pos = await this.positionManager.openPolymarketPosition({
              conditionId: p.conditionId,
              question: p.marketQuestion ?? p.conditionId,
              tokenId: p.tokenId,
              outcome: (p.side ?? 'Yes') as 'Yes' | 'No',
              orderId: r.txId ?? `de-${Date.now()}`,
              sizeUsd: p.sizeUsd,
              entryPrice: p.pricePerShare,
              txHash: r.txId,
            });
            await this.repo.insertTransaction({
              id: `tx-poly-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'polygon', strategyTag: 'polymarket', txType: 'prediction_buy',
              tokenIn: 'USDC', amountIn: p.sizeUsd,
              tokenOut: p.tokenId, amountOut: p.sizeUsd / (p.pricePerShare || 0.01),
              feeUsd: 0, txHash: r.txId, walletAddress: '', positionId: pos.id,
              status: 'confirmed',
              metadata: { conditionId: p.conditionId, outcome: p.side, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted POLY_BET: ${pos.id} — ${p.side} "${(p.marketQuestion ?? '').slice(0, 50)}" $${p.sizeUsd}`);
            break;
          }

          // ── Polymarket EXIT ────────────────────────────────────
          case 'POLY_EXIT': {
            // Try to find the DB position by tokenId and close it
            const dbPos = p.tokenId
              ? await this.repo.getPositionByExternalId(p.tokenId)
              : null;
            const receivedUsd = r.receivedUsd ?? p.sizeUsd ?? 0;
            if (dbPos) {
              await this.positionManager.closePosition(
                dbPos.id, 0, r.txId ?? '', receivedUsd,
              );
              logger.info(`[CFO] Persisted POLY_EXIT: closed ${dbPos.id}`);
            }
            await this.repo.insertTransaction({
              id: `tx-poly-exit-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'polygon', strategyTag: 'polymarket', txType: 'prediction_sell',
              tokenIn: p.tokenId, amountIn: p.sizeUsd ?? 0,
              tokenOut: 'USDC', amountOut: receivedUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '',
              positionId: dbPos?.id, status: 'confirmed',
              metadata: { reasoning: d.reasoning },
            });
            break;
          }

          // ── Hyperliquid OPEN hedge ─────────────────────────────
          case 'OPEN_HEDGE': {
            const coin = p.coin ?? 'SOL';
            const sizeUsd = p.exposureUsd ?? p.solExposureUsd ?? d.estimatedImpactUsd;
            const leverage = p.leverage ?? 1;
            // Fetch current price for entry
            let entryPrice = 0;
            try {
              if (coin === 'SOL') {
                const pythMod = await import('../launchkit/cfo/pythOracleService.ts');
                entryPrice = await pythMod.getSolPrice();
              } else {
                // For non-SOL coins, use HL mid price as entry estimate
                const hlMod = await import('../launchkit/cfo/hyperliquidService.ts');
                const summary = await hlMod.getAccountSummary();
                const pos = summary.positions.find((pp: any) => pp.coin === coin);
                if (pos) entryPrice = pos.markPrice;
              }
            } catch { /* non-fatal */ }
            await this.positionManager.openHyperliquidPosition({
              coin, side: 'SHORT', sizeUsd, entryPrice, leverage,
              orderId: r.txId ? Number(r.txId) : undefined, txHash: r.txId,
            });
            await this.repo.insertTransaction({
              id: `tx-hl-hedge-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'arbitrum', strategyTag: 'hyperliquid', txType: 'swap',
              tokenIn: 'USDC', amountIn: sizeUsd / leverage,
              tokenOut: `${coin}-PERP-SHORT`, amountOut: sizeUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { coin, leverage, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted OPEN_HEDGE: SHORT ${coin} $${sizeUsd} @ ${leverage}x`);
            break;
          }

          // ── Hyperliquid CLOSE hedge ────────────────────────────
          case 'CLOSE_HEDGE': {
            const coin = p.coin ?? 'SOL';
            const reduceUsd = r.receivedUsd ?? p.reduceUsd ?? d.estimatedImpactUsd;
            // Find matching open HL position and close it
            const openHL = await this.repo.getOpenPositions('hyperliquid' as PositionStrategy);
            const coinShort = openHL.find(pos =>
              (pos.metadata as any)?.coin === coin && (pos.metadata as any)?.side === 'SHORT',
            );
            if (coinShort) {
              const pnl = reduceUsd - coinShort.costBasisUsd;
              await this.positionManager.closePosition(coinShort.id, 0, r.txId ?? '', reduceUsd);
              logger.info(`[CFO] Persisted CLOSE_HEDGE: closed ${coinShort.id} (${coin}) PnL $${pnl.toFixed(2)}`);
            }
            await this.repo.insertTransaction({
              id: `tx-hl-close-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'arbitrum', strategyTag: 'hyperliquid', txType: 'swap',
              tokenIn: `${coin}-PERP-SHORT`, amountIn: reduceUsd,
              tokenOut: 'USDC', amountOut: reduceUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '',
              positionId: coinShort?.id, status: 'confirmed',
              metadata: { coin, reasoning: d.reasoning },
            });
            break;
          }

          // ── Hyperliquid CLOSE losing position ──────────────────
          case 'CLOSE_LOSING': {
            const openHL = await this.repo.getOpenPositions('hyperliquid' as PositionStrategy);
            const match = openHL.find(pos =>
              (pos.metadata as any)?.coin === p.coin && (pos.metadata as any)?.side === p.side,
            );
            // Use actual receivedUsd from executor (includes unrealized PnL),
            // not 0 which would record a 100% loss
            const lossReceivedUsd = r.receivedUsd ?? 0;
            if (match) {
              await this.positionManager.closePosition(match.id, 0, r.txId ?? '', lossReceivedUsd);
              const lossPnl = lossReceivedUsd - match.costBasisUsd;
              logger.info(`[CFO] Persisted CLOSE_LOSING: closed ${match.id} (${p.coin} ${p.side}) PnL $${lossPnl.toFixed(2)}`);
            }
            await this.repo.insertTransaction({
              id: `tx-hl-stop-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'arbitrum', strategyTag: 'hyperliquid', txType: 'swap',
              tokenIn: `${p.coin}-PERP-${p.side}`, amountIn: d.estimatedImpactUsd,
              tokenOut: 'USDC', amountOut: lossReceivedUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '',
              positionId: match?.id, status: 'confirmed',
              metadata: { reason: 'stop_loss', reasoning: d.reasoning },
            });
            break;
          }

          // ── Jito STAKE ─────────────────────────────────────────
          case 'AUTO_STAKE': {
            const stakeAmount = p.amount ?? d.estimatedImpactUsd;
            await this.repo.insertTransaction({
              id: `tx-jito-stake-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'jito', txType: 'stake',
              tokenIn: 'SOL', amountIn: stakeAmount,
              tokenOut: 'JitoSOL', amountOut: stakeAmount,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted AUTO_STAKE: ${stakeAmount} SOL → JitoSOL`);
            break;
          }

          // ── Jito UNSTAKE ───────────────────────────────────────
          case 'UNSTAKE_JITO': {
            const unstakeAmount = p.amount ?? d.estimatedImpactUsd;
            await this.repo.insertTransaction({
              id: `tx-jito-unstake-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'jito', txType: 'unstake',
              tokenIn: 'JitoSOL', amountIn: unstakeAmount,
              tokenOut: 'SOL', amountOut: unstakeAmount,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted UNSTAKE_JITO: ${unstakeAmount} JitoSOL → SOL`);
            break;
          }

          // ── Kamino Borrow + Deploy ─────────────────────────────
          case 'KAMINO_BORROW_DEPLOY': {
            const borrowUsd  = p.borrowUsd ?? d.estimatedImpactUsd;
            const target     = p.deployTarget ?? 'unknown';
            const borrowApy  = p.borrowApy ?? 0;
            const deployApy  = p.deployApy ?? 0;
            const spreadPct  = ((deployApy - borrowApy) * 100).toFixed(1);
            await this.repo.insertTransaction({
              id: `tx-kamino-borrow-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_loop', txType: 'borrow',
              tokenIn: 'collateral', amountIn: 0,
              tokenOut: 'USDC', amountOut: borrowUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { deployTarget: target, borrowApy, deployApy, spreadPct, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_BORROW_DEPLOY: $${borrowUsd} USDC → ${target} (spread ${spreadPct}%)`);
            break;
          }

          // ── Kamino Repay ───────────────────────────────────────
          case 'KAMINO_REPAY': {
            const repayUsd = p.repayUsd ?? d.estimatedImpactUsd;
            await this.repo.insertTransaction({
              id: `tx-kamino-repay-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_loop', txType: 'repay',
              tokenIn: 'USDC', amountIn: repayUsd,
              tokenOut: 'collateral', amountOut: 0,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_REPAY: $${repayUsd} USDC repaid`);
            break;
          }

          // ── JitoSOL Loop OPEN ──────────────────────────────────
          case 'KAMINO_JITO_LOOP': {
            const jitoSol    = p.jitoSolToDeposit ?? 0;
            const targetLtv  = p.targetLtv ?? 0.65;
            const estApy     = p.estimatedApy ?? 0;
            await this.repo.insertTransaction({
              id: `tx-kamino-loop-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_jito_loop', txType: 'stake',
              tokenIn: 'JitoSOL', amountIn: jitoSol,
              tokenOut: 'JitoSOL-leveraged', amountOut: jitoSol / (1 - targetLtv),
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { targetLtv, estimatedApy: estApy, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_JITO_LOOP: ${jitoSol} JitoSOL → ${(targetLtv * 100).toFixed(0)}% LTV, est. APY ${(estApy * 100).toFixed(1)}%`);
            await this.registerCFOExposure([
              { mint: SOLANA_TOKEN_MINTS['JitoSOL'], ticker: 'JitoSOL' },
            ]);
            break;
          }

          // ── JitoSOL Loop UNWIND ────────────────────────────────
          case 'KAMINO_JITO_UNWIND': {
            await this.repo.insertTransaction({
              id: `tx-kamino-unwind-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_jito_loop', txType: 'unstake',
              tokenIn: 'JitoSOL-leveraged', amountIn: 0,
              tokenOut: 'JitoSOL', amountOut: 0,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_JITO_UNWIND`);
            await this.deregisterCFOExposure([
              { mint: SOLANA_TOKEN_MINTS['JitoSOL'], ticker: 'JitoSOL' },
            ]);
            break;
          }

          // ── Multi-LST Loop OPEN (mSOL / bSOL / JitoSOL) ───────
          case 'KAMINO_LST_LOOP': {
            const lst       = p.lst ?? 'JitoSOL';
            const lstAmount = p.lstAmount ?? 0;
            const targetLtv = p.targetLtv ?? 0.65;
            const estApy    = p.estimatedApy ?? 0;
            await this.repo.insertTransaction({
              id: `tx-kamino-lst-loop-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: `kamino_${lst.toLowerCase()}_loop` as PositionStrategy, txType: 'stake',
              tokenIn: lst, amountIn: lstAmount,
              tokenOut: `${lst}-leveraged`, amountOut: lstAmount / (1 - targetLtv),
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { lst, targetLtv, estimatedApy: estApy, needsSwap: p.needsSwap, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_LST_LOOP: ${lstAmount} ${lst} → ${(targetLtv * 100).toFixed(0)}% LTV, est. APY ${(estApy * 100).toFixed(1)}%`);
            // Register LST exposure with Guardian
            const lstMint = SOLANA_TOKEN_MINTS[lst];
            if (lstMint) {
              await this.registerCFOExposure([{ mint: lstMint, ticker: lst }]);
            }
            break;
          }

          // ── Multi-LST Loop UNWIND ──────────────────────────────
          case 'KAMINO_LST_UNWIND': {
            const lst = p.lst ?? 'JitoSOL';
            await this.repo.insertTransaction({
              id: `tx-kamino-lst-unwind-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: `kamino_${lst.toLowerCase()}_loop` as PositionStrategy, txType: 'unstake',
              tokenIn: `${lst}-leveraged`, amountIn: 0,
              tokenOut: lst, amountOut: 0,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { lst, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KAMINO_LST_UNWIND: ${lst}`);
            const lstMint = SOLANA_TOKEN_MINTS[lst];
            if (lstMint) {
              await this.deregisterCFOExposure([{ mint: lstMint, ticker: lst }]);
            }
            break;
          }

          // ── Kamino Multiply Vault deposit ──────────────────────
          case 'KAMINO_MULTIPLY_VAULT': {
            const vaultName = p.vaultName ?? 'Unknown';
            const depositAmt = p.depositAmount ?? 0;
            const collateral = p.collateralToken ?? 'LST';
            await this.repo.insertTransaction({
              id: `tx-kamino-vault-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_multiply_vault' as PositionStrategy, txType: 'stake',
              tokenIn: collateral, amountIn: depositAmt,
              tokenOut: `kamino-vault-${vaultName}`, amountOut: depositAmt,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                vaultAddress: p.vaultAddress, vaultName, collateral,
                estimatedApy: p.estimatedApy, leverage: p.leverage, tvl: p.tvl,
                reasoning: d.reasoning,
              },
            });
            logger.info(`[CFO] Persisted KAMINO_MULTIPLY_VAULT: ${depositAmt} ${collateral} → "${vaultName}"`);
            break;
          }

          // ── Orca LP OPEN ───────────────────────────────────────
          case 'ORCA_LP_OPEN': {
            const resultAnyOpen = r as any;
            const deployUsd = (p.usdcAmount ?? 0) * 2;
            const pair = p.pair ?? 'SOL/USDC';
            const orcaRiskTier = p.riskTier ?? 'medium';
            const tokenA = p.tokenA ?? pair.split('/')[0] ?? 'SOL';
            const tokenB = p.tokenB ?? pair.split('/')[1] ?? 'USDC';
            // positionMint is the NFT mint that identifies the on-chain position
            const positionMint = resultAnyOpen.positionMint ?? r.txId;
            await this.repo.insertTransaction({
              id: `tx-orca-lp-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'orca_lp', txType: 'liquidity_add',
              tokenIn: 'USDC+tokenA', amountIn: deployUsd,
              tokenOut: `orca-lp-${pair}`, amountOut: deployUsd,
              feeUsd: 0, txHash: resultAnyOpen.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                pair, whirlpoolAddress: p.whirlpoolAddress, rangeWidthPct: p.rangeWidthPct,
                usdcAmount: p.usdcAmount, tokenAAmount: p.tokenAAmount,
                riskTier: orcaRiskTier, positionMint,
                reasoning: d.reasoning,
              },
            });
            logger.info(`[CFO] Persisted ORCA_LP_OPEN [${orcaRiskTier}]: $${deployUsd.toFixed(0)} ${pair} LP (mint: ${positionMint?.slice(0, 8)})`);
            // Track in cfo_positions for learning engine
            // externalId = positionMint (NFT) so getPositionByExternalId works during rebalance
            const orcaPosId = `orca-lp-${positionMint ?? Date.now()}`;
            await this.repo.upsertPosition({
              id: orcaPosId,
              strategy: 'orca_lp',
              asset: pair,
              description: `Orca LP [${orcaRiskTier}]: ${pair}`,
              chain: 'solana',
              status: 'OPEN',
              entryPrice: 1,
              currentPrice: 1,
              sizeUnits: deployUsd,
              costBasisUsd: deployUsd,
              currentValueUsd: deployUsd,
              realizedPnlUsd: 0,
              unrealizedPnlUsd: 0,
              entryTxHash: resultAnyOpen.txHash ?? r.txId,
              externalId: positionMint,
              metadata: { pair, whirlpoolAddress: p.whirlpoolAddress, rangeWidthPct: p.rangeWidthPct, riskTier: orcaRiskTier, tokenA, tokenB, positionMint },
              openedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            // Register the LP pair tokens with Guardian for targeted alert forwarding
            const lpMints = orcaPairMints(pair).map(mint => ({
              mint,
              ticker: pair.split('/').find((sym: string) => SOLANA_TOKEN_MINTS[sym] === mint) ?? mint.slice(0, 8),
            }));
            await this.registerCFOExposure(lpMints);
            break;
          }

          // ── Orca LP REBALANCE ──────────────────────────────────
          case 'ORCA_LP_REBALANCE': {
            const resultAny = r as any;
            const recoveredUsd = resultAny.valueRecoveredUsd ?? 0;
            const newPosMint = resultAny.newPositionMint;
            const rebalTier = p.riskTier ?? 'medium';
            const rebalPair = p.pair ?? (p.tokenA && p.tokenB ? `${p.tokenA}/${p.tokenB}` : 'SOL/USDC');
            const rebalTokenA = p.tokenA ?? rebalPair.split('/')[0] ?? 'SOL';
            const rebalTokenB = p.tokenB ?? rebalPair.split('/')[1] ?? 'USDC';

            await this.repo.insertTransaction({
              id: `tx-orca-rebalance-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'orca_lp', txType: 'liquidity_rebalance',
              tokenIn: 'orca-lp', amountIn: recoveredUsd,
              tokenOut: 'orca-lp', amountOut: recoveredUsd,
              feeUsd: 0, txHash: resultAny.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                positionMint: p.positionMint, newPositionMint: newPosMint,
                rangeWidthPct: p.rangeWidthPct, riskTier: rebalTier,
                valueRecoveredUsd: recoveredUsd, reasoning: d.reasoning,
              },
            });
            logger.info(`[CFO] Persisted ORCA_LP_REBALANCE [${rebalTier}]: ${(p.positionMint as string)?.slice(0, 8)} → ${newPosMint?.slice(0, 8)} ($${recoveredUsd.toFixed(2)} recovered)`);

            // Close the old position in cfo_positions — calculate realized PnL
            try {
              const oldPos = await this.repo.getPositionByExternalId(p.positionMint as string);
              if (oldPos) {
                const realizedPnl = recoveredUsd > 0 ? recoveredUsd - oldPos.costBasisUsd : 0;
                await this.repo.upsertPosition({
                  ...oldPos,
                  status: 'CLOSED',
                  realizedPnlUsd: realizedPnl,
                  currentValueUsd: recoveredUsd,
                  closedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  exitTxHash: resultAny.txHash ?? r.txId,
                  metadata: { ...oldPos.metadata, rebalanced: true, rebalancedTo: newPosMint },
                });
              }
            } catch { /* best effort */ }

            // Create NEW position record for the reopened position
            if (newPosMint) {
              try {
                const newDeployUsd = recoveredUsd > 0 ? recoveredUsd : (resultAny.usdcReceived ?? 0) * 2;
                await this.repo.upsertPosition({
                  id: `orca-lp-${newPosMint}`,
                  strategy: 'orca_lp',
                  asset: rebalPair,
                  description: `Orca LP [${rebalTier}]: ${rebalPair} (rebalanced)`,
                  chain: 'solana',
                  status: 'OPEN',
                  entryPrice: 1, currentPrice: 1,
                  sizeUnits: newDeployUsd,
                  costBasisUsd: newDeployUsd,
                  currentValueUsd: newDeployUsd,
                  realizedPnlUsd: 0, unrealizedPnlUsd: 0,
                  entryTxHash: resultAny.txHash ?? r.txId,
                  externalId: newPosMint,
                  metadata: {
                    pair: rebalPair, whirlpoolAddress: p.whirlpoolAddress,
                    rangeWidthPct: p.rangeWidthPct, riskTier: rebalTier,
                    tokenA: rebalTokenA, tokenB: rebalTokenB,
                    rebalanceOf: p.positionMint,
                  },
                  openedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              } catch { /* best effort */ }
            }
            break;
          }

          // ── Orca LP CLOSE (standalone) ─────────────────────────
          case 'ORCA_LP_CLOSE': {
            const closeResultAny = r as any;
            const closeRecoveredUsd = closeResultAny.valueRecoveredUsd ?? 0;
            const closeTier = p.riskTier ?? 'medium';
            const closePair = p.pair ?? 'SOL/USDC';

            await this.repo.insertTransaction({
              id: `tx-orca-close-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'orca_lp', txType: 'liquidity_rebalance' as TransactionType,
              tokenIn: 'orca-lp', amountIn: closeRecoveredUsd,
              tokenOut: 'USDC+SOL', amountOut: closeRecoveredUsd,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { positionMint: p.positionMint, riskTier: closeTier, valueRecoveredUsd: closeRecoveredUsd, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted ORCA_LP_CLOSE [${closeTier}]: ${(p.positionMint as string)?.slice(0, 8)} ($${closeRecoveredUsd.toFixed(2)} recovered)`);

            try {
              const closeOldPos = await this.repo.getPositionByExternalId(p.positionMint as string);
              if (closeOldPos) {
                const closePnl = closeRecoveredUsd > 0 ? closeRecoveredUsd - closeOldPos.costBasisUsd : 0;
                await this.repo.upsertPosition({
                  ...closeOldPos,
                  status: 'CLOSED',
                  realizedPnlUsd: closePnl,
                  currentValueUsd: closeRecoveredUsd,
                  closedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  exitTxHash: r.txId,
                });
              }
            } catch { /* best effort */ }
            break;
          }

          // ── Kamino Borrow → Orca LP ────────────────────────────
          case 'KAMINO_BORROW_LP': {
            const borrowResultAny = r as any;
            const borrowUsd = p.borrowUsd ?? 0;
            const borrowLpTier = p.riskTier ?? 'medium';
            const borrowLpPair = p.pair ?? 'SOL/USDC';
            const borrowLpTokenA = p.tokenA ?? borrowLpPair.split('/')[0] ?? 'SOL';
            const borrowLpTokenB = p.tokenB ?? borrowLpPair.split('/')[1] ?? 'USDC';
            // positionMint is the on-chain NFT mint that identifies the LP position
            const borrowLpPosMint = borrowResultAny.positionMint ?? r.txId;
            // Record the borrow transaction
            await this.repo.insertTransaction({
              id: `tx-kamino-borrow-lp-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'kamino_loop', txType: 'borrow',
              tokenIn: 'collateral', amountIn: 0,
              tokenOut: 'USDC', amountOut: borrowUsd,
              feeUsd: 0, txHash: borrowResultAny.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: { deployTarget: 'orca_lp', borrowApy: p.borrowApy, spreadPct: p.spreadPct, riskTier: borrowLpTier, reasoning: d.reasoning },
            });
            // Record the LP deployment
            await this.repo.insertTransaction({
              id: `tx-orca-lp-borrowed-${r.txId ?? Date.now()}`, timestamp: now,
              chain: 'solana', strategyTag: 'orca_lp', txType: 'liquidity_add',
              tokenIn: 'USDC(borrowed)', amountIn: borrowUsd,
              tokenOut: `orca-lp-${borrowLpPair}`, amountOut: borrowUsd,
              feeUsd: 0, txHash: borrowResultAny.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                pair: borrowLpPair, fundingSource: 'kamino_borrow', riskTier: borrowLpTier,
                tokenA: borrowLpTokenA, tokenB: borrowLpTokenB, positionMint: borrowLpPosMint,
                borrowUsd, estimatedLpApy: p.estimatedLpApy, borrowApy: p.borrowApy,
                rangeWidthPct: p.rangeWidthPct, reasoning: d.reasoning,
              },
            });
            // Also track as cfo_position for learning engine
            // externalId = positionMint so getPositionByExternalId works during rebalance
            const borrowLpPosId = `orca-lp-${borrowLpPosMint ?? Date.now()}`;
            await this.repo.upsertPosition({
              id: borrowLpPosId,
              strategy: 'orca_lp',
              asset: borrowLpPair,
              description: `Orca LP [${borrowLpTier}]: ${borrowLpPair} (borrowed)`,
              chain: 'solana',
              status: 'OPEN',
              entryPrice: 1,
              currentPrice: 1,
              sizeUnits: borrowUsd,
              costBasisUsd: borrowUsd,
              currentValueUsd: borrowUsd,
              realizedPnlUsd: 0,
              unrealizedPnlUsd: 0,
              entryTxHash: borrowResultAny.txHash ?? r.txId,
              externalId: borrowLpPosMint,
              metadata: {
                pair: borrowLpPair, whirlpoolAddress: p.whirlpoolAddress,
                rangeWidthPct: p.rangeWidthPct, riskTier: borrowLpTier,
                tokenA: borrowLpTokenA, tokenB: borrowLpTokenB,
                fundingSource: 'kamino_borrow', positionMint: borrowLpPosMint,
              },
              openedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            logger.info(`[CFO] Persisted KAMINO_BORROW_LP [${borrowLpTier}]: borrowed $${borrowUsd.toFixed(0)} → ${borrowLpPair} LP`);
            // Register LP pair tokens with Guardian
            const lpMintsBorrow = orcaPairMints(borrowLpPair).map(mint => ({
              mint,
              ticker: borrowLpPair.split('/').find((sym: string) => SOLANA_TOKEN_MINTS[sym] === mint) ?? mint.slice(0, 8),
            }));
            await this.registerCFOExposure(lpMintsBorrow);
            break;
          }

          // ── EVM Flash Arb (Arbitrum) ─────────────────────────
          case 'EVM_FLASH_ARB': {
            const arbResult = r as any;
            await this.repo.insertTransaction({
              id: `tx-arb-flash-${arbResult.txHash ?? Date.now()}`, timestamp: now,
              chain: 'arbitrum', strategyTag: 'evm_flash_arb', txType: 'swap',
              tokenIn: p.flashLoanSymbol ?? 'USDC', amountIn: p.flashAmountUsd ?? 0,
              tokenOut: p.flashLoanSymbol ?? 'USDC', amountOut: (p.flashAmountUsd ?? 0) + (arbResult.profitUsd ?? 0),
              feeUsd: p.aaveFeeUsd ?? 0, txHash: arbResult.txHash, walletAddress: '', status: arbResult.success ? 'confirmed' : 'failed',
              metadata: { pair: p.displayPair, buyDex: p.buyPool?.dex, sellDex: p.sellPool?.dex, netProfitUsd: arbResult.profitUsd, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted EVM_FLASH_ARB: ${p.displayPair} profit=$${(arbResult.profitUsd ?? 0).toFixed(3)} tx=${arbResult.txHash?.slice(0, 10)}`);
            break;
          }

          // ── Krystal EVM LP Open ──────────────────────────────
          case 'KRYSTAL_LP_OPEN': {
            const pool = p.pool ?? {};
            const resultAny = r as any;
            // Use actual deployed USD from the mint result if available, fall back to target
            const actualUsd = resultAny.actualDeployUsd ?? p.deployUsd ?? 0;
            await this.repo.insertTransaction({
              id: `tx-krystal-lp-open-${r.txId ?? Date.now()}`, timestamp: now,
              chain: p.chainName ?? 'evm', strategyTag: 'krystal_lp', txType: 'liquidity_add' as TransactionType,
              tokenIn: pool.token0?.symbol ?? '?', amountIn: actualUsd,
              tokenOut: `${pool.token0?.symbol ?? '?'}/${pool.token1?.symbol ?? '?'}-LP`, amountOut: actualUsd,
              feeUsd: 0, txHash: resultAny.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                pair: p.pair, chainName: p.chainName, chainNumericId: pool.chainNumericId,
                poolAddress: pool.poolAddress, feeTier: pool.feeTier,
                rangeWidthTicks: p.rangeWidthTicks, riskTier: p.riskTier, reasoning: d.reasoning,
                targetDeployUsd: p.deployUsd,
              },
            });
            // Persist EVM LP record to kv_store
            await this.persistEvmLpPosition({
              posId: r.txId ?? `unknown-${Date.now()}`,
              chainId: pool.chainId ?? '',
              chainNumericId: pool.chainNumericId ?? 0,
              chainName: p.chainName ?? 'evm',
              protocol: typeof pool.protocol === 'string' ? pool.protocol : pool.protocol?.name ?? 'uniswapv3',
              poolAddress: pool.poolAddress ?? '',
              token0Symbol: pool.token0?.symbol ?? '?',
              token1Symbol: pool.token1?.symbol ?? '?',
              entryUsd: actualUsd,
              openedAt: Date.now(),
            });
            logger.info(`[CFO] Persisted KRYSTAL_LP_OPEN: ${p.pair} on ${p.chainName} $${actualUsd.toFixed(2)} (target $${(p.deployUsd ?? 0).toFixed(0)})`);
            // Track in cfo_positions for learning engine
            const krystalPosId = `krystal-lp-${r.txId ?? Date.now()}`;
            const krystalChain = mapEvmChain(p.chainName ?? '');
            await this.repo.upsertPosition({
              id: krystalPosId,
              strategy: 'krystal_lp',
              asset: p.pair ?? `${pool.token0?.symbol ?? '?'}/${pool.token1?.symbol ?? '?'}`,
              description: `Krystal LP: ${p.pair} on ${p.chainName}`,
              chain: krystalChain,
              status: 'OPEN',
              entryPrice: 1,
              currentPrice: 1,
              sizeUnits: actualUsd,
              costBasisUsd: actualUsd,
              currentValueUsd: actualUsd,
              realizedPnlUsd: 0,
              unrealizedPnlUsd: 0,
              entryTxHash: resultAny.txHash ?? r.txId,
              externalId: r.txId, // NFPM tokenId
              metadata: { pair: p.pair, chainName: p.chainName, chainNumericId: pool.chainNumericId, poolAddress: pool.poolAddress, nfpmTokenId: r.txId, riskTier: p.riskTier },
              openedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            break;
          }

          // ── Krystal EVM LP Rebalance ─────────────────────────
          case 'KRYSTAL_LP_REBALANCE': {
            const resultAny = r as any;
            await this.repo.insertTransaction({
              id: `tx-krystal-lp-rebalance-${r.txId ?? Date.now()}`, timestamp: now,
              chain: p.chainName ?? 'evm', strategyTag: 'krystal_lp', txType: 'liquidity_rebalance' as TransactionType,
              tokenIn: `${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'}-LP`, amountIn: 0,
              tokenOut: `${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'}-LP`, amountOut: 0,
              feeUsd: 0, txHash: resultAny.txHash ?? r.txId, walletAddress: '', status: 'confirmed',
              metadata: {
                posId: p.posId, chainName: p.chainName, closeOnly: p.closeOnly,
                rangeWidthTicks: p.rangeWidthTicks, reasoning: d.reasoning,
              },
            });
            // Always remove old position record
            await this.removeEvmLpPosition(p.posId);
            // If not closeOnly, the executor reopened a new position — persist it
            if (!p.closeOnly && r.txId) {
              const pool = p.pool ?? {};
              await this.persistEvmLpPosition({
                posId: r.txId,
                chainId: pool.chainId ?? `${p.chainName}@${p.chainNumericId}`,
                chainNumericId: p.chainNumericId ?? 0,
                chainName: p.chainName ?? 'evm',
                protocol: typeof pool.protocol === 'string' ? pool.protocol : pool.protocol?.name ?? 'uniswapv3',
                poolAddress: pool.poolAddress ?? '',
                token0Symbol: p.token0Symbol ?? '?',
                token1Symbol: p.token1Symbol ?? '?',
                entryUsd: p.deployUsd ?? 0,
                openedAt: Date.now(),
              });
            }
            logger.info(`[CFO] Persisted KRYSTAL_LP_REBALANCE: posId=${p.posId} closeOnly=${p.closeOnly}`);
            // Close old position in cfo_positions for learning engine
            try {
              const oldKPos = await this.repo.getPositionByExternalId(String(p.posId));
              if (oldKPos) {
                const closeResult = r as any;
                const recoveredUsd = closeResult.valueRecoveredUsd ?? oldKPos.currentValueUsd;
                await this.repo.upsertPosition({
                  ...oldKPos,
                  status: 'CLOSED',
                  realizedPnlUsd: recoveredUsd - oldKPos.costBasisUsd,
                  currentValueUsd: recoveredUsd,
                  closedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  exitTxHash: closeResult.txHash ?? r.txId,
                });
              }
            } catch { /* best effort */ }
            // If reopened, track new position
            if (!p.closeOnly && r.txId) {
              const rebalChain = mapEvmChain(p.chainName ?? '');
              await this.repo.upsertPosition({
                id: `krystal-lp-${r.txId}`,
                strategy: 'krystal_lp',
                asset: `${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'}`,
                description: `Krystal LP: ${p.token0Symbol}/${p.token1Symbol} on ${p.chainName}`,
                chain: rebalChain,
                status: 'OPEN',
                entryPrice: 1, currentPrice: 1,
                sizeUnits: p.deployUsd ?? 0,
                costBasisUsd: p.deployUsd ?? 0,
                currentValueUsd: p.deployUsd ?? 0,
                realizedPnlUsd: 0, unrealizedPnlUsd: 0,
                entryTxHash: r.txId, externalId: r.txId,
                metadata: { chainName: p.chainName, chainNumericId: p.chainNumericId, nfpmTokenId: r.txId },
                openedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
            break;
          }

          // ── Krystal EVM LP Fee Claim ─────────────────────────
          case 'KRYSTAL_LP_CLAIM_FEES': {
            await this.repo.insertTransaction({
              id: `tx-krystal-lp-claim-${r.txId ?? Date.now()}`, timestamp: now,
              chain: p.chainName ?? 'evm', strategyTag: 'krystal_lp', txType: 'fee_claim' as TransactionType,
              tokenIn: 'fees', amountIn: 0,
              tokenOut: `${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'}-fees`, amountOut: p.feesOwedUsd ?? 0,
              feeUsd: 0, txHash: r.txId, walletAddress: '', status: 'confirmed',
              metadata: { posId: p.posId, chainName: p.chainName, feesOwedUsd: p.feesOwedUsd, reasoning: d.reasoning },
            });
            logger.info(`[CFO] Persisted KRYSTAL_LP_CLAIM_FEES: posId=${p.posId} fees=$${(p.feesOwedUsd ?? 0).toFixed(2)}`);
            // Update cfo_positions with realized fee income
            try {
              const feePos = await this.repo.getPositionByExternalId(String(p.posId));
              if (feePos) {
                await this.repo.upsertPosition({
                  ...feePos,
                  realizedPnlUsd: feePos.realizedPnlUsd + (p.feesOwedUsd ?? 0),
                  updatedAt: new Date().toISOString(),
                });
              }
            } catch { /* best effort */ }
            break;
          }

          // SKIP / REBALANCE_HEDGE — nothing to persist
          default:
            break;
        }
      } catch (err) {
        logger.warn(`[CFO] Failed to persist ${d.type} (non-fatal):`, err);
      }
    }
  }

  // ── Position monitor ──────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    if (!this.running || this.paused || !this.positionManager) return;
    const env = getCFOEnv();

    // ── Refresh Hyperliquid position prices ──
    try {
      const hl = await import('../launchkit/cfo/hyperliquidService.ts');
      const summary = await hl.getAccountSummary();
      if (summary.positions.length > 0) {
        const actions = await this.positionManager.updateHyperliquidPrices(summary.positions);
        for (const action of actions) {
          if (action.urgency === 'critical') {
            const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
            await notifyAdminForce(`⚠️ CFO HL: ${action.reason}`);
          }
        }
      }
    } catch (err) { logger.debug('[CFO] HL price refresh error:', err); }

    // ── Refresh Polymarket position prices ──
    if (!env.polymarketEnabled) return;

    try {
      const polyMod = await poly();
      const freshPositions = await polyMod.fetchPositions();

      // ── Check pending sell orders from previous cycles ──
      if (this.pendingSellOrders.size > 0) {
        for (const [orderId, pending] of this.pendingSellOrders) {
          try {
            const orderStatus = await polyMod.getOrderStatus(orderId);
            if (!orderStatus) {
              // Order not found — maybe expired or API error. Cancel after 30 min.
              if (Date.now() - pending.placedAt > 30 * 60_000) {
                logger.warn(`[CFO] Pending sell ${orderId} not found after 30min — removing tracker`);
                this.pendingSellOrders.delete(orderId);
                await this.repo?.updatePositionMetadata(pending.positionId, { pendingSellOrderId: null, pendingSellPlacedAt: null });
              }
              continue;
            }

            if (orderStatus.status === 'MATCHED') {
              // Order filled! Use actual fill price from CLOB, not stale mark-to-market
              const dbPos = await this.repo?.getPosition(pending.positionId);
              const receivedUsd = orderStatus.receivedUsd
                ?? (dbPos ? (dbPos.currentValueUsd ?? 0) : 0);
              const pnl = receivedUsd - pending.costBasisUsd;
              await this.positionManager?.closePosition(
                pending.positionId, 0,
                orderStatus.transactionHashes?.[0] ?? orderId, receivedUsd,
              );
              const onChainHash = orderStatus.transactionHashes?.[0];
              const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
              const txLine = onChainHash
                ? `Tx: https://polygonscan.com/tx/${onChainHash}`
                : `CLOB Order: ${orderId.slice(0, 16)}…`;
              await notifyAdminForce(
                `🏦 CFO Sell filled: ${pending.description.slice(0, 60)}\n` +
                `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
                txLine,
              );
              logger.info(`[CFO] Pending sell ${orderId} MATCHED — position ${pending.positionId} closed`);
              this.pendingSellOrders.delete(orderId);
              // metadata cleared by closePosition
            } else if (orderStatus.status === 'CANCELLED' || orderStatus.status === 'EXPIRED') {
              logger.warn(`[CFO] Pending sell ${orderId} ${orderStatus.status} — will retry next cycle`);
              this.pendingSellOrders.delete(orderId);
              await this.repo?.updatePositionMetadata(pending.positionId, { pendingSellOrderId: null, pendingSellPlacedAt: null });
            }
            // LIVE — still on the book, check again next cycle
          } catch (err) {
            logger.debug(`[CFO] Error checking pending sell ${orderId}:`, err);
          }
        }
      }

      const actions = await this.positionManager.updatePolymarketPrices(freshPositions);

      for (const action of actions) {
        if (action.action !== 'STOP_LOSS' && action.action !== 'EXPIRE') continue;
        // Skip if there's already a pending sell order for this position
        const hasPending = [...this.pendingSellOrders.values()].some(p => p.positionId === action.positionId);
        if (hasPending) {
          logger.debug(`[CFO] Skipping ${action.action} for ${action.positionId} — sell order already pending`);
          continue;
        }
        const dbPos = await this.repo?.getPosition(action.positionId);
        if (!dbPos) continue;
        const meta = dbPos.metadata as { tokenId?: string; awaitingRedemption?: boolean };
        // Skip positions already marked as awaiting redemption (CLOB sell failed previously)
        if (meta.awaitingRedemption) {
          logger.debug(`[CFO] Skipping ${action.action} for ${action.positionId} — awaiting market resolution/redemption`);
          continue;
        }
        const freshPos = freshPositions.find((p: any) => p.tokenId === meta.tokenId);

        // ── Position vanished from API — likely market resolved & tokens redeemed ──
        // Query the Gamma API for market resolution to compute correct PnL
        // instead of defaulting to $0 received (which made all bets look like total losses).
        if (!freshPos) {
          const condId = (meta as any).conditionId;
          const ourOutcome = dbPos.description.split(' | ')[0]?.trim(); // "Yes" or "No"
          let receivedUsd = 0;
          let resolutionNote = 'not-found';

          if (condId) {
            try {
              const resolution = await polyMod.queryMarketResolution(condId);
              if (resolution.resolved && resolution.winningOutcome) {
                const ourSideWon = resolution.winningOutcome.toLowerCase() === (ourOutcome ?? '').toLowerCase();
                // Winning: each token redeems for $1 USDC → receivedUsd = sizeUnits
                receivedUsd = ourSideWon ? dbPos.sizeUnits : 0;
                resolutionNote = ourSideWon
                  ? `resolved=${resolution.winningOutcome} ✓ WON`
                  : `resolved=${resolution.winningOutcome} ✗ LOST`;
                logger.info(
                  `[CFO] Market resolution for "${dbPos.description.slice(0, 50)}": ${resolutionNote} ` +
                  `(${dbPos.sizeUnits.toFixed(1)} shares → $${receivedUsd.toFixed(2)})`,
                );
              } else if (resolution.resolved) {
                resolutionNote = 'resolved-unknown-winner';
              } else {
                // Market not resolved — don't close yet, wait for resolution
                logger.info(
                  `[CFO] Position disappeared but market not resolved: "${dbPos.description.slice(0, 50)}" — skipping close`,
                );
                continue;
              }
            } catch (err) {
              logger.debug(`[CFO] Resolution query failed: ${(err as Error).message}`);
            }
          }

          const pnl = receivedUsd - dbPos.costBasisUsd;

          if (!env.dryRun) {
            await this.positionManager.closePosition(
              action.positionId, receivedUsd > 0 ? 1 : 0, `market-${resolutionNote}`, receivedUsd,
            );
          }
          logger.info(
            `[CFO] Closed resolved position: "${dbPos.description.slice(0, 60)}" ` +
            `(${resolutionNote}, received: $${receivedUsd.toFixed(2)}, PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
          );
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `📊 Polymarket ${resolutionNote}: ${dbPos.description.slice(0, 60)}\n` +
            `Received: $${receivedUsd.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
          );
          continue;
        }

        // ── Dust cleanup: position worth < $1 and still on-chain ──
        // For redeemable (resolved) markets: redeem on-chain instead of trying to sell
        // For live markets: attempt sell on CLOB; if sell fails, mark for redemption
        if (freshPos.currentValueUsd < 1.00) {
          const dustValue = freshPos.currentValueUsd;
          const dustPnl = dustValue - dbPos.costBasisUsd;

          let redeemTxHash: string | undefined;
          let dustSellSucceeded = false;
          if (freshPos.size > 0 && !env.dryRun) {
            if (freshPos.redeemable) {
              // Resolved market: redeem on-chain (burns tokens, returns USDC if winning)
              try {
                const result = await polyMod.redeemPosition(freshPos);
                if (result.success) {
                  redeemTxHash = result.txHash;
                  dustSellSucceeded = true;
                  logger.info(`[CFO] Redeemed resolved position: "${dbPos.description.slice(0, 60)}" tx: ${result.txHash}`);
                } else {
                  logger.warn(`[CFO] Redeem failed: "${dbPos.description.slice(0, 60)}" — ${result.error}`);
                }
              } catch (err) {
                logger.debug(`[CFO] Redeem error: ${(err as Error).message}`);
              }
            } else {
              // Live market with near-zero value: attempt sell on CLOB
              try {
                const sellResult = await polyMod.exitPosition(freshPos, 1.0);
                if (sellResult.status !== 'ERROR') {
                  dustSellSucceeded = true;
                  logger.info(`[CFO] Dust sell attempted: "${dbPos.description.slice(0, 60)}" ($${dustValue.toFixed(2)})`);
                }
              } catch (err) {
                logger.debug(`[CFO] Dust sell failed (expected for small positions): ${(err as Error).message}`);
              }
            }
          } else if (env.dryRun) {
            dustSellSucceeded = true;
          }

          if (dustSellSucceeded) {
            // Tokens cleared on-chain — safe to close in DB
            await this.positionManager.closePosition(
              action.positionId, freshPos.currentPrice, 'dust-cleanup', dustValue,
            );
            logger.info(
              `[CFO] Dust cleanup: closed "${dbPos.description.slice(0, 60)}" ` +
              `(value: $${dustValue.toFixed(2)}, PnL: $${dustPnl.toFixed(2)})`,
            );
            const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
            const txLine = redeemTxHash ? `\nTX: https://polygonscan.com/tx/${redeemTxHash}` : '';
            await notifyAdminForce(
              `🧹 ${freshPos.redeemable ? 'Redeemed' : 'Dust cleanup'}: ${dbPos.description.slice(0, 60)}\n` +
              `Value: $${dustValue.toFixed(2)} | PnL: $${dustPnl.toFixed(2)}${txLine}`,
            );
          } else {
            // CLOB sell failed — tokens still on-chain, don't close in DB
            // Mark as awaiting redemption so we stop retrying
            await this.repo?.updatePositionMetadata(action.positionId, {
              sellFailedAt: Date.now(),
              sellFailedError: 'CLOB sell failed for dust position',
              awaitingRedemption: true,
            });
            logger.info(
              `[CFO] Dust sell failed — marked for redemption: "${dbPos.description.slice(0, 60)}" ` +
              `($${dustValue.toFixed(2)})`,
            );
            const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
            await notifyAdminForce(
              `⏳ Dust sell failed — awaiting resolution: ${dbPos.description.slice(0, 60)}\n` +
              `Value: $${dustValue.toFixed(2)} | Will auto-redeem when market resolves.`,
            );
          }
          continue;
        }

        const pnl = freshPos.currentValueUsd - dbPos.costBasisUsd;

        // In dry-run, log what would happen but do NOT close the DB position
        if (env.dryRun) {
          await polyMod.exitPosition(freshPos, 1.0); // logs the dry-run message
          logger.info(`[CFO] DRY RUN — would ${action.action} ${dbPos.description.slice(0, 60)} | PnL: $${pnl.toFixed(2)}`);
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `🏦 CFO ${action.action} (dry run): ${dbPos.description.slice(0, 60)}\n` +
            `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Value: $${freshPos.currentValueUsd.toFixed(2)}`,
          );
          continue;
        }

        const exitOrder = await polyMod.exitPosition(freshPos, 1.0);
        if (exitOrder.status === 'MATCHED') {
          // Order was immediately filled — use actual sell price, not mark-to-market estimate
          const fillReceivedUsd = exitOrder.sizeUsd ?? freshPos.currentValueUsd;
          const fillPnl = fillReceivedUsd - dbPos.costBasisUsd;
          await this.positionManager.closePosition(
            action.positionId, freshPos.currentPrice,
            exitOrder.transactionHash ?? exitOrder.orderId, fillReceivedUsd,
          );
          const onChainHash = exitOrder.transactionHash;
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          const txLine = onChainHash
            ? `Tx: https://polygonscan.com/tx/${onChainHash}`
            : `CLOB Order: ${exitOrder.orderId.slice(0, 16)}…`;
          await notifyAdminForce(
            `🏦 CFO ${action.action}: ${dbPos.description.slice(0, 60)}\n` +
            `P&L: ${fillPnl >= 0 ? '+' : ''}$${fillPnl.toFixed(2)} | Received: $${fillReceivedUsd.toFixed(2)}\n` +
            txLine,
          );
          await this.reportToSupervisor('alert', action.urgency as any, {
            event: 'cfo_position_closed', action: action.action,
            pnlUsd: fillPnl, reason: action.reason,
            message: `${action.action}: ${dbPos.description.slice(0, 60)} — PnL $${fillPnl.toFixed(2)}`,
          });
        } else if (exitOrder.status === 'LIVE') {
          // Order is on the book but not yet filled — track it for later confirmation
          const placedAt = Date.now();
          this.pendingSellOrders.set(exitOrder.orderId, {
            orderId: exitOrder.orderId,
            positionId: action.positionId,
            costBasisUsd: dbPos.costBasisUsd,
            description: dbPos.description,
            placedAt,
          });
          // Persist to DB metadata so it survives restarts
          await this.repo?.updatePositionMetadata(action.positionId, {
            pendingSellOrderId: exitOrder.orderId,
            pendingSellPlacedAt: placedAt,
          });
          logger.info(
            `[CFO] Sell order LIVE (not yet filled): ${exitOrder.orderId} — ` +
            `"${dbPos.description.slice(0, 60)}" — will check next cycle`,
          );
        } else if (exitOrder.status === 'ERROR' && freshPos.currentValueUsd < 5) {
          // CLOB sell failed for a small position — DON'T close in DB because the
          // tokens are still in the wallet on-chain. Closing in DB would cause
          // reconcilePolymarketGhosts() to reopen it, creating an infinite loop.
          // Instead, mark it so we don't retry sell every cycle — let it sit until
          // the market resolves, then startup redemption will handle it.
          await this.repo?.updatePositionMetadata(action.positionId, {
            sellFailedAt: Date.now(),
            sellFailedError: exitOrder.errorMessage ?? 'unknown',
            awaitingRedemption: true,
          });
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `⏳ Sell failed — awaiting market resolution: ${dbPos.description.slice(0, 60)}\n` +
            `Value: $${freshPos.currentValueUsd.toFixed(2)} | PnL: $${pnl.toFixed(2)}\n` +
            `Error: ${exitOrder.errorMessage ?? 'unknown'}\n` +
            `Will auto-redeem when market resolves.`,
          );
          logger.info(
            `[CFO] CLOB sell failed for small position — marked for redemption: "${dbPos.description.slice(0, 60)}" ` +
            `($${freshPos.currentValueUsd.toFixed(2)})`,
          );
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
    if (!this.running || this.paused) {
      logger.debug(`[CFO] Decision cycle skipped: running=${this.running} paused=${this.paused}`);
      return;
    }

    const config = getDecisionConfig();
    if (!config.enabled) {
      logger.debug('[CFO] Decision cycle skipped: config.enabled=false');
      return;
    }

    logger.info(`[CFO] Decision cycle #${this.cycleCount + 1} starting...`);
    const cycleStart = Date.now();

    // Lazily enrich SOLANA_TOKEN_MINTS from Kamino registry (first cycle only)
    await enrichTokenMints();

    try {
      await this.updateStatus('deciding');
      const { state, decisions, results, report, intel, traceId } = await runDecisionCycle(this.pool);

      // Cycle was skipped (concurrent lock) — nothing to do
      if (traceId === 'skipped') {
        logger.info(`[CFO] Decision cycle #${this.cycleCount + 1} skipped (concurrent lock) after ${((Date.now() - cycleStart) / 1000).toFixed(1)}s`);
        await this.updateStatus('idle');
        return;
      }

      // Cycle timed out or errored — log and recover for next attempt
      if (traceId === 'error') {
        logger.warn(`[CFO] Decision cycle #${this.cycleCount + 1} failed after ${((Date.now() - cycleStart) / 1000).toFixed(1)}s: ${report}`);
        this.cycleCount++;
        await this.updateStatus('degraded');
        return;
      }

      // ── Hydrate scoutIntel from swarm intel (covers restarts + missed messages) ──
      if (intel.scoutReceivedAt && intel.scoutBullish !== undefined) {
        const existing = this.scoutIntel;
        if (!existing || intel.scoutReceivedAt > existing.receivedAt) {
          this.scoutIntel = {
            cryptoBullish: intel.scoutBullish,
            narratives: intel.scoutNarratives ?? [],
            receivedAt: intel.scoutReceivedAt,
          };
        }
      }

      // ── Handle APPROVAL-tier decisions → queue for admin approval ─
      const approvalIds: Map<string, string> = new Map(); // decision.type → approval id
      for (const r of results) {
        if (r.pendingApproval && r.decision.tier === 'APPROVAL') {
          const d = r.decision;

          // Dedup: skip if we already have a pending approval for this decision type
          const alreadyPending = [...this.pendingApprovals.values()].find(
            (a) => a.decisionJson?.type === d.type
          );
          if (alreadyPending) {
            logger.debug(`[CFO] Skipping duplicate approval for ${d.type} — ${alreadyPending.id} already pending`);
            approvalIds.set(`${d.type}-${r.decision.urgency}`, alreadyPending.id);
            continue;
          }

          const action = async () => {
            const { executeDecision } = await import('../launchkit/cfo/decisionEngine.ts');
            let overridden = { ...d, tier: 'AUTO' as const };

            // ── Fix: refresh SOL price for LP approvals (may be minutes old) ──────
            if (d.type === 'ORCA_LP_OPEN' && d.params) {
              try {
                const pythMod = await import('../launchkit/cfo/pythOracleService.ts');
                const freshSolPrice = await pythMod.getSolPrice();
                const p = { ...d.params };
                const oldSolPrice = p.solToSwapForUsdc && p.usdcAmount
                  ? (p.usdcAmount as number) / (p.solToSwapForUsdc as number || 1)
                  : freshSolPrice;
                const ratio = freshSolPrice / oldSolPrice;

                // Recalculate SOL amounts at fresh price (USD targets stay the same)
                if (p.solAmount) p.solAmount = (p.solAmount as number) / ratio;
                if (p.tokenAAmount && p.tokenA === 'SOL') p.tokenAAmount = (p.tokenAAmount as number) / ratio;
                if (p.solToSwapForUsdc) p.solToSwapForUsdc = (p.solToSwapForUsdc as number) / ratio;
                if (p.solToSwapForTokenA) p.solToSwapForTokenA = (p.solToSwapForTokenA as number) / ratio;
                if (p.totalSolToSwap) p.totalSolToSwap = (p.solToSwapForUsdc as number) + (p.solToSwapForTokenA as number);

                overridden = { ...overridden, params: p };
                logger.info(`[CFO] LP approval: refreshed SOL price $${oldSolPrice.toFixed(0)}→$${freshSolPrice.toFixed(0)} (ratio ${ratio.toFixed(3)})`);
              } catch (err) {
                logger.warn('[CFO] LP approval: Pyth price refresh failed (using original amounts):', err);
              }
            }

            const env = getCFOEnv();
            const execResult = await executeDecision(overridden, env);
            if (execResult.success && execResult.executed) {
              logger.info(`[CFO] Approved decision ${d.type} executed successfully (tx: ${execResult.txId ?? 'n/a'})`);
              // Persist the approved+executed decision
              await this.persistDecisionResults([execResult]);

              const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
              await notifyAdminForce(`✅ ${d.type} executed.\ntx: ${execResult.txId ?? 'dry-run'}`);
            } else {
              logger.error(`[CFO] Approved decision ${d.type} failed: ${execResult.error}`);
              const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
              await notifyAdminForce(`❌ ${d.type} failed: ${execResult.error}`);
            }
          };
          const approvalId = await this.queueForApproval(
            `${d.type}: ${d.reasoning}`,
            Math.abs(d.estimatedImpactUsd),
            action,
            d,                      // full Decision object (JSON-safe)
            'decision_engine',
          );
          approvalIds.set(`${d.type}-${r.decision.urgency}`, approvalId);
        }
      }

      // ── Single combined message to admin ──────────────────────
      if (decisions.length > 0) {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        // Append approval buttons to the report
        let msg = report;
        if (approvalIds.size > 0) {
          msg += '\n\n🔐 <b>Approve:</b>';
          for (const [id, a] of this.pendingApprovals) {
            const shortDesc = a.description.split(':')[0]; // e.g. "OPEN_HEDGE"
            msg += `\n  /cfo approve ${id}  ← ${shortDesc} ($${a.amountUsd.toFixed(0)})`;
          }
          msg += '\n⏰ Expires in 15 min.';
        }
        await notifyAdminForce(msg);
      }

      // ── Persist ALL successful decisions to DB ────────────────────
      await this.persistDecisionResults(results);

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

      // Persist cooldown state so hedge/stake timers survive restarts
      await this.persistState();

      this.cycleCount++;
      logger.info(`[CFO] Decision cycle #${this.cycleCount} completed in ${((Date.now() - cycleStart) / 1000).toFixed(1)}s — ${decisions.length} decision(s), ${results.filter(r => r.executed).length} executed`);
      await this.updateStatus('idle');
    } catch (err) {
      logger.error(`[CFO] Decision cycle error after ${((Date.now() - cycleStart) / 1000).toFixed(1)}s:`, err);
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

  // ── Approval system (DB-persisted, survives restarts) ─────────────

  /** Get approval expiry from config (defaults to 30 min) */
  private getApprovalExpiryMs(): number {
    return (getDecisionConfig().approvalExpiryMinutes ?? 30) * 60_000;
  }

  private async queueForApproval(
    description: string,
    amountUsd: number,
    action: () => Promise<void>,
    decision?: Record<string, any>,
    source: 'decision_engine' | 'legacy_bet' = 'decision_engine',
  ): Promise<string> {
    this.approvalCounter++;
    const id = `a-${this.approvalCounter}`;
    const now = Date.now();
    const expiresAt = now + this.getApprovalExpiryMs();
    this.pendingApprovals.set(id, {
      id, description, amountUsd, action,
      decisionJson: decision ?? {},
      source,
      createdAt: now,
      expiresAt,
    });
    // Persist to DB immediately so approval survives a restart
    await this.persistState();
    return id;
  }

  /** Rebuild the executable action closure from a serialized Decision */
  private rebuildApprovalAction(sa: SerializableApproval): () => Promise<void> {
    if (sa.source === 'decision_engine' && sa.decisionJson?.type) {
      return async () => {
        const { executeDecision } = await import('../launchkit/cfo/decisionEngine.ts');
        const decision = { ...sa.decisionJson, tier: 'AUTO' } as any;
        const env = getCFOEnv();
        const execResult = await executeDecision(decision, env);
        if (execResult.success && execResult.executed) {
          logger.info(`[CFO] Approved decision ${decision.type} executed (tx: ${execResult.txId ?? 'n/a'})`);
          await this.persistDecisionResults([execResult]);
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(`✅ ${decision.type} executed.\ntx: ${execResult.txId ?? 'dry-run'}`);
        } else {
          logger.error(`[CFO] Approved decision ${decision.type} failed: ${execResult.error}`);
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(`❌ ${decision.type} failed: ${execResult.error}`);
        }
      };
    }
    // Legacy bet approvals can't be rebuilt (market conditions changed) — expire them
    return async () => {
      logger.warn(`[CFO] Cannot re-execute legacy approval ${sa.id} after restart — market may have moved`);
      const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
      await notifyAdminForce(`⚠️ Approval ${sa.id} expired — market conditions may have changed since restart.`);
    };
  }

  private async expirePendingApprovals(): Promise<void> {
    const now = Date.now();
    let changed = false;

    for (const [id, a] of this.pendingApprovals) {
      // ── Expire ────────────────────────────────────────────────
      if (now > a.expiresAt) {
        this.pendingApprovals.delete(id);
        changed = true;
        logger.info(`[CFO] Approval expired: ${id} — ${a.description}`);
        try {
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `⏰ Approval *${id}* expired — ${a.description.slice(0, 60)}\n` +
            `$${a.amountUsd.toFixed(0)} | was pending ${Math.round((now - a.createdAt) / 60_000)} min`,
          );
        } catch { /* non-fatal */ }
        continue;
      }

      // ── Reminder at ~50% of remaining time ────────────────────
      const halfLife = a.createdAt + (a.expiresAt - a.createdAt) / 2;
      if (now >= halfLife && !a.remindedAt) {
        a.remindedAt = now;
        changed = true;
        const minsLeft = Math.round((a.expiresAt - now) / 60_000);
        try {
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `🔔 *Reminder:* Pending approval *${id}*\n` +
            `${a.description.slice(0, 80)}\n` +
            `$${a.amountUsd.toFixed(0)} | ⏳ ${minsLeft} min left\n` +
            `/cfo approve ${id}`,
          );
        } catch { /* non-fatal */ }
      }
    }

    if (changed) await this.persistState();
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
    if (env.orcaLpEnabled) services.push('orca-lp');
    if (env.krystalLpEnabled) services.push('krystal-lp');
    if (env.wormholeEnabled) services.push('wormhole');
    if (env.lifiEnabled) services.push('lifi');
    if (env.evmArbEnabled) services.push('evm-arb');

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

    // Purge old decision audit rows (>30 days) to prevent unbounded kv_store growth
    try {
      const cutoffMs = Date.now() - 30 * 24 * 3600_000;
      const res = await this.pool.query(
        `DELETE FROM kv_store WHERE key LIKE 'cfo_decision_%' AND key < $1`,
        [`cfo_decision_${cutoffMs}`],
      );
      if (res.rowCount && res.rowCount > 0) {
        logger.info(`[CFO] Purged ${res.rowCount} decision audit row(s) older than 30 days`);
      }
    } catch { /* non-fatal cleanup */ }
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
      case 'cfo_start': {
        this.paused = false;
        this.emergencyPausedUntil = null;
        if (this.autoResumeTimer) { clearTimeout(this.autoResumeTimer); this.autoResumeTimer = null; }
        logger.info('[CFO] RESUMED (manual)');
        break;
      }

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
          await this.persistState();
          await a.action();
          await notify(`✅ CFO: Executed: ${a.description}`);
        } else {
          await notify(`⚠️ Approval ${payload.approvalId} not found — may have expired or already been executed.`);
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

      case 'cfo_kamino_borrow': {
        const { amount } = payload;
        if (amount > 0) {
          const result = await (await kamino()).borrow('USDC', amount);
          await notify(result.success
            ? `✅ Borrowed $${amount} USDC from Kamino (tx: ${result.txSignature?.slice(0, 12)}…)`
            : `❌ Borrow failed: ${result.error}`);
        } else {
          await notify('Usage: /cfo borrow <USD amount>');
        }
        break;
      }

      case 'cfo_kamino_repay': {
        const { amount } = payload;
        const repayAmount = amount === Infinity || amount === 'all' ? Infinity : Number(amount);
        const result = await (await kamino()).repay('USDC', repayAmount);
        await notify(result.success
          ? `✅ Repaid ${isFinite(repayAmount) ? `$${repayAmount}` : 'all'} USDC to Kamino (tx: ${result.txSignature?.slice(0, 12)}…)`
          : `❌ Repay failed: ${result.error}`);
        break;
      }

      case 'cfo_orca_open': {
        const { usdAmount } = payload;
        if (usdAmount > 0) {
          const orca = await import('../launchkit/cfo/orcaService.ts');
          // Split 50/50 between USDC and SOL side
          const pyth = await import('../launchkit/cfo/pythOracleService.ts');
          const solPrice = await pyth.getSolPrice().catch(() => 85);
          const usdcSide = usdAmount / 2;
          const solSide = usdAmount / 2 / solPrice;
          const result = await orca.openPosition(usdcSide, solSide);
          await notify(result.success
            ? `✅ Opened Orca LP: $${usdAmount} (${result.positionMint?.slice(0, 8)}…) range $${result.lowerPrice?.toFixed(2)}-$${result.upperPrice?.toFixed(2)}`
            : `❌ Orca LP open failed: ${result.error}`);
        }
        break;
      }

      case 'cfo_orca_close': {
        const { positionMint } = payload;
        if (positionMint) {
          const orca = await import('../launchkit/cfo/orcaService.ts');
          const result = await orca.closePosition(positionMint);
          await notify(result.success
            ? `✅ Closed Orca LP position ${positionMint.slice(0, 8)}…`
            : `❌ Orca LP close failed: ${result.error}`);
        } else {
          await notify('Usage: /cfo lp close <positionMint>');
        }
        break;
      }

      case 'cfo_orca_status': {
        const orca = await import('../launchkit/cfo/orcaService.ts');
        const positions = await orca.getPositions();
        if (positions.length === 0) {
          await notify('📊 No active Orca LP positions.');
        } else {
          const lines = positions.map(p =>
            `• ${p.positionMint.slice(0, 8)}… | $${p.lowerPrice.toFixed(2)}-$${p.upperPrice.toFixed(2)} | ` +
            `${p.inRange ? '✅ in-range' : '⚠️ out-of-range'} | util: ${p.rangeUtilisationPct.toFixed(0)}%`
          );
          await notify(`📊 *Orca LP Positions:*\n${lines.join('\n')}`);
        }
        break;
      }

      case 'cfo_kamino_jito_loop': {
        const kaminoMod = await kamino();
        const { targetLtv = 65, maxLoops = 3 } = payload;
        const pyth = await import('../launchkit/cfo/pythOracleService.ts');
        const solPrice = await pyth.getSolPrice().catch(() => 80);
        await notify(`⏳ Starting JitoSOL/SOL multiply loop (target LTV: ${targetLtv}%, max loops: ${maxLoops})...`);
        const result = await kaminoMod.loopJitoSol(targetLtv / 100, maxLoops, solPrice);
        await notify(result.success
          ? `✅ JitoSOL loop complete — ${result.loopsCompleted} loop(s), final LTV: ${(result.effectiveLtv * 100).toFixed(1)}%, est. APY: ${(result.estimatedApy * 100).toFixed(1)}%`
          : `❌ JitoSOL loop failed: ${result.error}`);
        break;
      }

      case 'cfo_kamino_jito_unwind': {
        const kaminoMod = await kamino();
        await notify('⏳ Unwinding JitoSOL/SOL multiply loop...');
        const result = await kaminoMod.unwindJitoSolLoop();
        await notify(result.success
          ? `✅ JitoSOL loop unwound — ${result.txSignatures.length} transaction(s) completed`
          : `❌ JitoSOL unwind failed: ${result.error}`);
        break;
      }

      case 'cfo_arb_status': {
        const arbMod = await import('../launchkit/cfo/evmArbService.ts');
        const env = getCFOEnv();
        const [profit24h, poolCount, arbUsdc] = [
          arbMod.getProfit24h(),
          arbMod.getCandidatePoolCount(),
          await arbMod.getArbUsdcBalance(),
        ];
        const poolsAge = arbMod.getPoolsRefreshedAt()
          ? `${Math.round((Date.now() - arbMod.getPoolsRefreshedAt()) / 60_000)}m ago`
          : 'not yet';
        await notify(
          `⚡ *Flash Arb — Arbitrum*\n` +
          `Enabled: ${env.evmArbEnabled ? '✅' : '❌'}\n` +
          `Receiver: ${env.evmArbReceiverAddress?.slice(0,10) ?? 'not deployed'}...\n` +
          `USDC on Arbitrum: $${arbUsdc.toFixed(2)}\n` +
          `Candidate pools: ${poolCount} (refreshed ${poolsAge})\n` +
          `Profit 24h: $${profit24h.toFixed(3)}\n` +
          `Min profit: $${env.evmArbMinProfitUsdc} | Max flash: $${env.evmArbMaxFlashUsd.toLocaleString()}`
        );
        break;
      }

      case 'cfo_kamino_loop_status': {
        const kaminoMod = await kamino();
        const pos = await kaminoMod.getPosition();
        const jitoDeposit = pos.deposits.find((d: any) => d.asset === 'JitoSOL');
        const solBorrow   = pos.borrows.find((b: any) => b.asset === 'SOL');
        const hasLoop     = (jitoDeposit?.amount ?? 0) > 0 && (solBorrow?.amount ?? 0) > 0;

        if (hasLoop) {
          const leverage = pos.ltv > 0 ? (1 / (1 - pos.ltv)) : 1;
          const jitoDepositUsd = pos.deposits
            .filter((d: any) => d.asset === 'JitoSOL')
            .reduce((s: number, d: any) => s + d.valueUsd, 0);
          const solBorrowUsd = pos.borrows
            .filter((b: any) => b.asset === 'SOL')
            .reduce((s: number, b: any) => s + b.valueUsd, 0);
          await notify(
            `🔄 *JitoSOL Loop Status:*\n` +
            `JitoSOL deposited: ${jitoDeposit!.amount.toFixed(4)} ($${jitoDepositUsd.toFixed(2)})\n` +
            `SOL borrowed: ${solBorrow!.amount.toFixed(4)} ($${solBorrowUsd.toFixed(2)})\n` +
            `LTV: ${(pos.ltv * 100).toFixed(1)}% | Health: ${pos.healthFactor.toFixed(2)}\n` +
            `Effective leverage: ~${leverage.toFixed(1)}x | Net equity: $${pos.netValueUsd.toFixed(2)}`
          );
        } else {
          const totalDeposits = pos.deposits.reduce((s: number, d: any) => s + d.valueUsd, 0);
          if (totalDeposits > 0) {
            await notify(
              `📊 No active JitoSOL/SOL loop. Kamino deposits: $${totalDeposits.toFixed(2)}\n` +
              `LTV: ${(pos.ltv * 100).toFixed(1)}% | Health: ${pos.healthFactor.toFixed(2)}`
            );
          } else {
            await notify('📊 No active JitoSOL/SOL multiply loop and no Kamino deposits found.');
          }
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
      case 'narrative_update': {
        // Accept structured CFO format, raw Scout format, AND batched intel_digest
        const isDigest = payload.intel_type === 'intel_digest';
        const narratives: string[] = payload.topNarratives
          ?? (payload.summary ? payload.summary.split(' | ') : [])
          ?? [];
        // If cryptoBullish is explicitly set, use it; otherwise infer from summary text
        let bullish = payload.cryptoBullish;
        if (bullish === undefined && payload.summary) {
          const lower = (payload.summary as string).toLowerCase();
          const bullWords = ['surge', 'bullish', 'rally', 'breakout', 'pump', 'trending', 'viral', 'moon', 'ath'];
          const bearWords = ['crash', 'bearish', 'dump', 'fear', 'sell-off', 'capitulation', 'plunge'];
          const bullHits = bullWords.filter(w => lower.includes(w)).length;
          const bearHits = bearWords.filter(w => lower.includes(w)).length;
          bullish = bullHits >= bearHits; // default to neutral-bullish if no signal
        }
        // For digests with cross-confirmed items, weight bullish signal higher
        if (isDigest && (payload.crossConfirmedCount ?? 0) > 0) {
          logger.info(`[CFO] 📋 Digest has ${payload.crossConfirmedCount} cross-confirmed signals — higher confidence`);
        }
        this.scoutIntel = {
          cryptoBullish: bullish ?? true,
          btcEstimate: payload.btcPriceEstimate,
          narratives,
          receivedAt: Date.now(),
        };
        const sourceLabel = isDigest
          ? `digest (${payload.totalIntelItems ?? '?'} items, ${payload.crossConfirmedCount ?? 0} confirmed)`
          : (payload.source ?? payload.intel_type ?? 'unknown');
        logger.info(`[CFO] 📡 Scout intel received: ${bullish ? '🟢 bullish' : '🔴 bearish'} | narratives: ${narratives.length} | source: ${sourceLabel}`);
        break;
      }

      case 'market_crash':
      case 'emergency_exit': {
        logger.error(`[CFO] Emergency from ${msg.from_agent}: ${payload.message}`);
        this.paused = true;

        // Only attempt to close positions on services that are actually enabled
        const cfoEnv = getCFOEnv();
        const closeResults: string[] = [];
        if (cfoEnv.polymarketEnabled) {
          try {
            const cancelled = await (await poly()).cancelAllOrders();
            closeResults.push(`Poly: cancelled ${cancelled} orders`);
          } catch (e: any) { closeResults.push(`Poly cancel failed: ${e.message ?? e}`); }
          try {
            const positions = await (await poly()).fetchPositions();
            for (const p of positions) await (await poly()).exitPosition(p, 1.0);
            closeResults.push(`Poly: exited ${positions.length} positions`);
          } catch (e: any) { closeResults.push(`Poly exit failed: ${e.message ?? e}`); }
        }
        if (cfoEnv.hyperliquidEnabled) {
          try {
            await (await hl()).closeAllPositions();
            closeResults.push('HL: closed all positions');
          } catch (e: any) { closeResults.push(`HL close failed: ${e.message ?? e}`); }
        }

        // Auto-resume timer
        const cooldownMs = (cfoEnv.emergencyCooldownMinutes ?? 240) * 60_000;
        this.emergencyPausedUntil = Date.now() + cooldownMs;
        if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer);
        this.autoResumeTimer = setTimeout(() => {
          this.paused = false;
          this.emergencyPausedUntil = null;
          this.autoResumeTimer = null;
          logger.info('[CFO] Auto-resumed after emergency cooldown');
          notify('✅ CFO auto-resumed after emergency cooldown').catch(() => {});
        }, cooldownMs);

        // Persist state so restorePersistedState can re-arm the timer on restart
        this.persistState().catch(() => {});

        const resumeAt = new Date(this.emergencyPausedUntil).toISOString();
        await notify(
          `🚨 CFO PAUSED — emergency from ${msg.from_agent}\n` +
          `${payload.message}\n\n` +
          `Close results:\n${closeResults.map(r => `  • ${r}`).join('\n')}\n\n` +
          `Auto-resume at: ${resumeAt}`,
        );
        break;
      }

      default:
        if (cmd) logger.debug(`[CFO] Unhandled message command: ${cmd} from ${msg.from_agent}`);
        break;
    }
  }

  // ── Status report ─────────────────────────────────────────────────

  private async sendStatusReport(): Promise<void> {
    const env = getCFOEnv();
    const lines: string[] = [];

    lines.push(`🏦 *CFO Status*`);
    lines.push(``);

    // ── Mode ──
    lines.push(`*Mode:* ${this.paused ? '⚠️ PAUSED' : '✅ Active'}${env.dryRun ? ' · Dry Run' : ''}`);
    lines.push(`*Cycles:* ${this.cycleCount}`);

    // ── Live Portfolio Snapshot (fetch everything in parallel) ──
    try {
      const { getPortfolioSnapshot } = await import('../launchkit/cfo/portfolioService.ts');
      const snap = await getPortfolioSnapshot(this.repo);

      // Prices
      if (snap.prices.SOL > 0) {
        lines.push(``);
        lines.push(`📈 *Prices*`);
        lines.push(`    SOL $${snap.prices.SOL.toFixed(2)} · ETH $${snap.prices.ETH.toFixed(0)} · BTC $${snap.prices.BTC.toFixed(0)}`);
      }

      // Wallets
      lines.push(``);
      lines.push(`💰 *Wallets — $${snap.totalWalletUsd.toFixed(0)}*`);
      for (const c of snap.chains) {
        if (c.totalUsd < 0.01) continue;
        const parts: string[] = [];
        if (c.native > 0.001) parts.push(`${c.native.toFixed(c.nativeSymbol === 'SOL' ? 2 : 3)} ${c.nativeSymbol}`);
        if (c.usdc > 0.01) parts.push(`$${c.usdc.toFixed(2)} USDC`);
        for (const other of c.other) parts.push(`${other.amount.toFixed(2)} ${other.symbol}`);
        const chainName = c.chain.charAt(0).toUpperCase() + c.chain.slice(1);
        lines.push(`    ${chainName}: ${parts.join(' · ')}  ($${c.totalUsd.toFixed(0)})`);
      }

      // Strategies
      if (snap.strategies.length > 0) {
        lines.push(``);
        lines.push(`📊 *Strategies — $${snap.totalDeployedUsd.toFixed(0)} deployed*`);
        for (const s of snap.strategies.sort((a, b) => b.valueUsd - a.valueUsd)) {
          const pnl = s.unrealizedPnlUsd !== 0
            ? ` · P&L ${s.unrealizedPnlUsd >= 0 ? '+' : ''}$${s.unrealizedPnlUsd.toFixed(2)}`
            : '';
          const alloc = snap.totalPortfolioUsd > 0 ? ` (${s.allocationPct.toFixed(0)}%)` : '';
          const statusIcon = s.status === 'active' ? '🟢' : s.status === 'idle' ? '⚪' : '🔴';
          lines.push(`    ${statusIcon} ${s.name}: $${s.valueUsd.toFixed(0)}${alloc}${pnl}`);
          if (s.details) lines.push(`        _${s.details}_`);
        }
      }

      // Orca LP (not in portfolioService yet, fetch separately)
      if (env.orcaLpEnabled) {
        try {
          const orcaMod = await import('../launchkit/cfo/orcaService.ts');
          const positions = await orcaMod.getPositions();
          if (positions.length > 0) {
            const totalLp = positions.reduce((s: number, p: any) => s + p.liquidityUsd, 0);
            const inRange = positions.filter((p: any) => p.inRange).length;
            lines.push(`    🟢 Orca LP: ${positions.length} position(s) · ${inRange}/${positions.length} in range`);
            if (totalLp > 0) lines.push(`        _$${totalLp.toFixed(0)} liquidity_`);
          }
        } catch { /* non-fatal */ }
      }

      // Totals
      lines.push(``);
      lines.push(`💎 *Total Portfolio: $${snap.totalPortfolioUsd.toFixed(0)}*`);
      if (snap.totalUnrealizedPnlUsd !== 0) {
        lines.push(`    Unrealized: ${snap.totalUnrealizedPnlUsd >= 0 ? '+' : ''}$${snap.totalUnrealizedPnlUsd.toFixed(2)}`);
      }
      if (snap.totalRealizedPnlUsd !== 0) {
        lines.push(`    Realized: ${snap.totalRealizedPnlUsd >= 0 ? '+' : ''}$${snap.totalRealizedPnlUsd.toFixed(2)}`);
      }

      // Risk
      if (snap.cashReservePct < 10) {
        lines.push(`    ⚠️ Cash reserve low: ${snap.cashReservePct.toFixed(0)}%`);
      }

      // Errors
      if (snap.errors.length > 0) {
        lines.push(``);
        lines.push(`⚠️ _${snap.errors.length} data error(s)_`);
      }
    } catch (err) {
      lines.push(``);
      lines.push(`⚠️ _Snapshot error: ${(err as Error).message}_`);
    }

    // ── Pending approvals ──
    if (this.pendingApprovals.size > 0) {
      lines.push(``);
      lines.push(`⏳ *${this.pendingApprovals.size} Pending Approval(s)*`);
      for (const [id, a] of this.pendingApprovals) {
        lines.push(`    /cfo approve ${id} — ${a.description.split(':')[0]}`);
      }
    }

    const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
    await notifyAdminForce(lines.join('\n'));
  }

  // ── Public API ────────────────────────────────────────────────────

  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
  isPaused() { return this.paused; }
  getCycleCount() { return this.cycleCount; }
  setScoutIntel(intel: Omit<ScoutIntel, 'receivedAt'>) { this.scoutIntel = { ...intel, receivedAt: Date.now() }; }

  // ── State Persistence (survive restarts) ─────────────────────────

  /**
   * Register token mints the CFO is actively holding with Guardian.
   * Guardian will tag these as 'cfo' source and include isCfoExposure=true
   * in alerts for these tokens, enabling targeted market_crash forwarding.
   */
  private async registerCFOExposure(mints: Array<{ mint: string; ticker: string }>): Promise<void> {
    for (const { mint, ticker } of mints) {
      if (!mint) continue;
      await this.sendMessage('nova-guardian', 'command', 'low', {
        action: 'watch_token',
        tokenAddress: mint,
        ticker,
        source: 'cfo',
      }).catch(err => logger.debug(`[CFO] Failed to register exposure ${ticker}: ${err}`));
    }
    if (mints.length > 0) {
      logger.info(`[CFO] Registered exposure with Guardian: ${mints.map(m => m.ticker).join(', ')}`);
    }
  }

  /**
   * Deregister a token mint from Guardian's CFO exposure set when the CFO exits a position.
   * Only removes if source='cfo' — does not remove core/scout watched tokens.
   */
  private async deregisterCFOExposure(mints: Array<{ mint: string; ticker: string }>): Promise<void> {
    for (const { mint, ticker } of mints) {
      if (!mint) continue;
      await this.sendMessage('nova-guardian', 'command', 'low', {
        action: 'unwatch_cfo_token',
        tokenAddress: mint,
        ticker,
      }).catch(err => logger.debug(`[CFO] Failed to deregister exposure ${ticker}: ${err}`));
    }
    if (mints.length > 0) {
      logger.info(`[CFO] Deregistered exposure with Guardian: ${mints.map(m => m.ticker).join(', ')}`);
    }
  }

  /**
   * On startup, check for Polymarket positions marked CLOSED in DB but still
   * holding shares on-chain. Reopens them so the position monitor can properly
   * handle stop-loss, dust cleanup, and expiry.
   *
   * Also redeems any resolved (redeemable) positions on-chain to clear ghost
   * shares that would otherwise cycle: reopen → dust sell (fails) → close → reopen.
   */
  private async reconcilePolymarketGhosts(): Promise<void> {
    if (!this.positionManager) return;
    const env = getCFOEnv();
    if (!env.polymarketEnabled) return;

    try {
      const polyMod = await poly();
      const freshPositions = await polyMod.fetchPositions();

      // First, redeem any resolved positions on-chain to clear ghost shares
      // AND close the DB position with proper PnL (before, redemption didn't update DB → next
      // cycle would EXPIRE the position with $0 received, making every bet look like a total loss).
      const redeemable = freshPositions.filter((p: any) => p.redeemable && p.size > 0);
      if (redeemable.length > 0) {
        logger.info(`[CFO] Found ${redeemable.length} redeemable position(s) on startup — redeeming on-chain`);
        let redeemed = 0;
        let skippedAlready = 0;
        const redeemDetails: string[] = [];
        for (const pos of redeemable) {
          try {
            const result = await polyMod.redeemPosition(pos);
            if (result.success) {
              const label = (pos as any).question?.slice(0, 50) ?? 'unknown';
              if (result.txHash === 'already-redeemed') {
                skippedAlready++;
                logger.info(`[CFO] Already redeemed on-chain, skipping: "${label}"`);
              } else {
                redeemed++;
                logger.info(`[CFO] Startup redeem: "${label}" tx: ${result.txHash}`);
                redeemDetails.push(
                  `  • ${label}\n    TX: https://polygonscan.com/tx/${result.txHash}`,
                );
              }

              // ── Close the DB position with correct PnL ───────────
              // Resolved markets: winning token = $1 per share, losing = $0.
              // Use the API-reported currentValueUsd (reflects resolution).
              if (this.repo && this.positionManager) {
                const openPositions = await this.repo.getOpenPositions('polymarket');
                const dbPos = openPositions.find((p: any) => {
                  const meta = p.metadata as { tokenId?: string };
                  return meta.tokenId === (pos as any).tokenId;
                });
                if (dbPos) {
                  const receivedUsd = (pos as any).currentValueUsd ?? 0;
                  await this.positionManager.closePosition(
                    dbPos.id, (pos as any).currentPrice ?? 0,
                    result.txHash ?? 'redeemed', receivedUsd,
                  );
                  const pnl = receivedUsd - dbPos.costBasisUsd;
                  logger.info(
                    `[CFO] Closed redeemed position in DB: "${label}" — ` +
                    `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (received $${receivedUsd.toFixed(2)})`,
                  );
                }
              }
            }
          } catch (err) {
            logger.debug(`[CFO] Startup redeem failed: ${(err as Error).message}`);
          }
        }
        if (skippedAlready > 0) {
          logger.info(`[CFO] Skipped ${skippedAlready} position(s) already redeemed on-chain`);
        }
        if (redeemed > 0) {
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce(
            `♻️ Redeemed ${redeemed}/${redeemable.length} resolved Polymarket position(s) on startup\n${redeemDetails.join('\n')}`,
          );
        }
      }

      // Then reconcile non-redeemable ghost positions (reopen in DB for proper monitoring)
      const nonRedeemable = freshPositions.filter((p: any) => !p.redeemable);
      const reopened = await this.positionManager.reconcilePolymarketPositions(nonRedeemable);
      if (reopened > 0) {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        await notifyAdminForce(`🔄 Reconciled ${reopened} ghost Polymarket position(s) — reopened in DB for proper cleanup`);
      }
    } catch (err) {
      logger.warn('[CFO] Polymarket reconciliation error:', err);
    }
  }

  /**
   * Reload pending sell orders from position metadata on startup.
   * This survives Railway restarts — the in-memory Map is repopulated from DB.
   */
  private async reloadPendingSellOrders(): Promise<void> {
    if (!this.repo) return;
    try {
      const positions = await this.repo.getPositionsWithPendingSellOrders();
      for (const pos of positions) {
        const meta = pos.metadata as { pendingSellOrderId?: string; pendingSellPlacedAt?: number };
        if (meta.pendingSellOrderId) {
          this.pendingSellOrders.set(meta.pendingSellOrderId, {
            orderId: meta.pendingSellOrderId,
            positionId: pos.id,
            costBasisUsd: pos.costBasisUsd,
            description: pos.description,
            placedAt: meta.pendingSellPlacedAt ?? Date.now(),
          });
        }
      }
      if (positions.length > 0) {
        logger.info(`[CFO] Reloaded ${positions.length} pending sell order(s) from DB`);
      }
    } catch (err) {
      logger.warn('[CFO] Error reloading pending sell orders:', err);
    }
  }

  /**
   * On startup, read all open DeFi positions from DB and re-register their
   * token mints with Guardian. This handles restarts and ensures the exposure
   * registry is always accurate regardless of when this feature was deployed.
   */
  private async reconcileCFOExposure(): Promise<void> {
    if (!this.repo) return;
    try {
      const openPositions = await this.repo.getOpenPositions();
      const mintsToRegister: Array<{ mint: string; ticker: string }> = [];

      for (const pos of openPositions) {
        // Orca LP positions: asset = "orca-lp-SOL/USDC" etc.
        if (pos.strategy === 'orca_lp' && pos.asset?.includes('/')) {
          const pair = pos.asset.replace(/^orca-lp-/, '');
          orcaPairMints(pair).forEach(mint => {
            const ticker = pair.split('/').find(sym => SOLANA_TOKEN_MINTS[sym] === mint) ?? mint.slice(0, 8);
            mintsToRegister.push({ mint, ticker });
          });
        }

        // Kamino JitoSOL loop: tokenIn is 'JitoSOL'
        if ((pos.strategy === 'kamino_jito_loop' || pos.strategy === 'kamino_loop') && pos.status === 'OPEN') {
          mintsToRegister.push({ mint: SOLANA_TOKEN_MINTS['JitoSOL'], ticker: 'JitoSOL' });
        }
      }

      // Deduplicate
      const seen = new Set<string>();
      const unique = mintsToRegister.filter(m => {
        if (!m.mint || seen.has(m.mint)) return false;
        seen.add(m.mint);
        return true;
      });

      if (unique.length > 0) {
        await this.registerCFOExposure(unique);
        logger.info(`[CFO] Startup reconciliation: registered ${unique.length} exposure mints with Guardian`);
      } else {
        logger.debug('[CFO] Startup reconciliation: no open DeFi positions to register');
      }
    } catch (err) {
      logger.debug('[CFO] Exposure reconciliation failed (non-fatal):', err);
    }
  }

  private async persistState(): Promise<void> {
    // Serialize pending approvals (strip non-serializable `action` closure)
    const serializedApprovals: SerializableApproval[] = [];
    for (const [, a] of this.pendingApprovals) {
      serializedApprovals.push({
        id: a.id,
        description: a.description,
        amountUsd: a.amountUsd,
        decisionJson: a.decisionJson,
        source: a.source,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        remindedAt: a.remindedAt,
      });
    }
    await this.saveState({
      cycleCount: this.cycleCount,
      startedAt: this.startedAt,
      approvalCounter: this.approvalCounter,
      pendingApprovals: serializedApprovals,
      cooldowns: getCooldownState(),
      emergencyPausedUntil: this.emergencyPausedUntil,
      scoutIntel: this.scoutIntel,
    });
  }

  private async restorePersistedState(): Promise<void> {
    const s = await this.restoreState<{
      cycleCount?: number;
      startedAt?: number;
      approvalCounter?: number;
      pendingApprovals?: SerializableApproval[];
      cooldowns?: Record<string, number>;
      emergencyPausedUntil?: number | null;
      scoutIntel?: ScoutIntel | null;
    }>();
    if (!s) return;
    if (s.cycleCount) this.cycleCount = s.cycleCount;
    if (s.approvalCounter) this.approvalCounter = s.approvalCounter;
    // Keep startedAt from the previous session to show total uptime across restarts
    if (s.startedAt)  this.startedAt = s.startedAt;

    // Restore scout intel (if still fresh — within 8h)
    if (s.scoutIntel && s.scoutIntel.receivedAt && (Date.now() - s.scoutIntel.receivedAt) < 8 * 3600_000) {
      this.scoutIntel = s.scoutIntel;
      logger.info(`[CFO] Scout intel restored: ${s.scoutIntel.cryptoBullish ? '🟢' : '🔴'} (${Math.floor((Date.now() - s.scoutIntel.receivedAt) / 60_000)}m old)`);
    }

    // Restore emergency pause — re-arm timer for remaining cooldown
    if (s.emergencyPausedUntil && s.emergencyPausedUntil > Date.now()) {
      this.paused = true;
      this.emergencyPausedUntil = s.emergencyPausedUntil;
      const remainingMs = s.emergencyPausedUntil - Date.now();
      if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = setTimeout(async () => {
        this.paused = false;
        this.emergencyPausedUntil = null;
        this.autoResumeTimer = null;
        logger.info('[CFO] Auto-resumed after emergency cooldown (restored timer)');
        try {
          const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
          await notifyAdminForce('▶️ CFO auto-resumed after emergency cooldown');
        } catch { /* best-effort */ }
      }, remainingMs);
      logger.info(`[CFO] Emergency pause restored — auto-resume in ${Math.round(remainingMs / 60_000)}m`);
    }

    // Restore decision engine cooldowns so hedge/stake timers survive restarts
    if (s.cooldowns) {
      restoreCooldownState(s.cooldowns);
      const restored = Object.keys(s.cooldowns).length;
      if (restored > 0) logger.info(`[CFO] Restored ${restored} decision cooldown(s)`);
    }

    // Restore pending approvals — rebuild action closures, skip already-expired
    const now = Date.now();
    let restoredCount = 0;
    if (s.pendingApprovals?.length) {
      for (const sa of s.pendingApprovals) {
        if (now > sa.expiresAt) {
          logger.info(`[CFO] Skipping expired approval ${sa.id} from previous session`);
          continue;
        }
        const action = this.rebuildApprovalAction(sa);
        this.pendingApprovals.set(sa.id, { ...sa, action });
        restoredCount++;
      }
    }

    logger.info(
      `[cfo] Restored: ${this.cycleCount} cycles, ` +
      `started=${new Date(this.startedAt).toISOString()}, ` +
      `${restoredCount} pending approvals`,
    );

    // Notify admin about restored approvals
    if (restoredCount > 0) {
      try {
        const { notifyAdminForce } = await import('../launchkit/services/adminNotify.ts');
        const lines = [...this.pendingApprovals.values()].map(a => {
          const minsLeft = Math.round((a.expiresAt - now) / 60_000);
          return `  /cfo approve ${a.id}  ← ${a.description.slice(0, 50)} (${minsLeft}m left)`;
        });
        await notifyAdminForce(
          `🔄 *CFO restarted* — ${restoredCount} pending approval(s) restored:\n${lines.join('\n')}`,
        );
      } catch { /* non-fatal */ }
    }
  }

  // ── EVM LP Position Persistence (Krystal) ──────────────────────

  /**
   * Persist an EVM LP position record to kv_store for cross-restart tracking.
   * Key: `cfo_evm_lp_<posId>_<chainNumericId>`
   */
  private async persistEvmLpPosition(record: import('../launchkit/cfo/krystalService.ts').EvmLpRecord): Promise<void> {
    try {
      const key = `cfo_evm_lp_${record.posId}_${record.chainNumericId}`;
      await this.pool.query(
        `INSERT INTO kv_store (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = $2`,
        [key, JSON.stringify(record)],
      );
      // Keep in-memory globalThis cache in sync
      const existing = ((globalThis as any).__cfo_evm_lp_records ?? []) as import('../launchkit/cfo/krystalService.ts').EvmLpRecord[];
      existing.push(record);
      (globalThis as any).__cfo_evm_lp_records = existing;
      logger.debug(`[CFO] Persisted EVM LP position: ${key}`);
    } catch (err) {
      logger.warn('[CFO] persistEvmLpPosition failed:', err);
    }
  }

  /**
   * Remove an EVM LP position record from kv_store (after close).
   */
  private async removeEvmLpPosition(posId: string): Promise<void> {
    try {
      await this.pool.query(
        `DELETE FROM kv_store WHERE key LIKE $1`,
        [`cfo_evm_lp_${posId}_%`],
      );
      // Keep in-memory globalThis cache in sync
      const existing = ((globalThis as any).__cfo_evm_lp_records ?? []) as import('../launchkit/cfo/krystalService.ts').EvmLpRecord[];
      (globalThis as any).__cfo_evm_lp_records = existing.filter(r => r.posId !== posId);
      logger.debug(`[CFO] Removed EVM LP position: ${posId}`);
    } catch (err) {
      logger.warn('[CFO] removeEvmLpPosition failed:', err);
    }
  }

  /**
   * Hydrate all saved EVM LP positions from kv_store.
   * Used by krystalService.fetchKrystalPositions() for openedAt timestamps.
   */
  private async hydrateEvmLpPositionsFromDb(): Promise<import('../launchkit/cfo/krystalService.ts').EvmLpRecord[]> {
    try {
      const result = await this.pool.query(
        `SELECT data FROM kv_store WHERE key LIKE 'cfo_evm_lp_%'`,
      );
      return result.rows.map((r: any) => {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        return data as import('../launchkit/cfo/krystalService.ts').EvmLpRecord;
      });
    } catch {
      return [];
    }
  }

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
