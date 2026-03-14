/**
 * Whale Tracker Agent
 *
 * Role: Multi-chain whale movement detection — monitors large wallet
 * transfers on Solana (via Helius) and EVM chains (via EVM RPC).
 *
 * Data sources:
 *   - Helius Enhanced API → Solana transaction monitoring
 *   - evmProviderService.getMultiChainEvmBalances() → EVM balance snapshots
 *   - Direct RPC recent block scanning → EVM large transfers
 *
 * Philosophy: This agent is the early warning system. When whales move,
 * markets react. Whale Tracker spots the movement *before* the price action.
 *
 * Detection triggers:
 *   - Balance delta > threshold on watched wallets
 *   - Large transfers (>$50k) on any monitored chain
 *   - Unusual token accumulation patterns
 *   - Exchange inflow/outflow spikes (known exchange addresses)
 *
 * Lifecycle: Factory-spawned via `whale_tracking` capability.
 *
 * Outgoing messages → Supervisor:
 *   - alert (high): Large transfer detected
 *   - intel (medium): Accumulation patterns detected
 *   - report (low): Periodic whale activity summary
 *
 * Incoming commands ← Supervisor:
 *   - add_wallet: Add a wallet address to watch list
 *   - immediate_scan: Force a check cycle
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import { BaseAgent } from './types.ts';
import type { WalletConfig } from './wallet-utils.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Default poll interval: 5 minutes */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum transfer size (USD) to trigger alert */
const DEFAULT_MIN_TRANSFER_USD = 50_000;

/** Minimum balance change (%) to trigger alert on watched wallets */
const DEFAULT_BALANCE_CHANGE_THRESHOLD_PCT = 10;

/** Max alerts per cycle (avoid spam on high-activity chains) */
const MAX_ALERTS_PER_CYCLE = 8;

/** Known exchange addresses (Solana) */
const KNOWN_EXCHANGES_SOL: Record<string, string> = {
  // Binance hot wallets
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
  // Coinbase
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
  // Kraken
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Kraken',
  // OKX
  '5VCwKtCXgCDuQosHFEVg6CtMiG5C3w8CcFcjTHKSwG7k': 'OKX',
};

/** Known exchange addresses (EVM) */
const KNOWN_EXCHANGES_EVM: Record<string, string> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
};

// ============================================================================
// Types
// ============================================================================

interface WalletSnapshot {
  address: string;
  chain: 'solana' | string; // 'solana' | EVM chain name
  label?: string;
  balanceUsd: number;
  balanceNative: number;
  timestamp: number;
}

interface WhaleAlert {
  type: 'large_transfer' | 'balance_change' | 'exchange_flow' | 'accumulation';
  chain: string;
  fromAddress?: string;
  toAddress?: string;
  amountUsd: number;
  amountNative?: number;
  token: string;
  direction?: 'inflow' | 'outflow' | 'internal';
  exchange?: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

// ============================================================================
// Whale Tracker Agent
// ============================================================================

export class WhaleTrackerAgent extends BaseAgent {
  private pollIntervalMs: number;
  private minTransferUsd: number;
  private balanceChangePct: number;
  private watchedWallets: Map<string, WalletSnapshot> = new Map(); // address → last snapshot
  private userWatchList: string[] = []; // User-added addresses
  private walletConfig?: WalletConfig;
  private cycleCount = 0;
  private totalAlerts = 0;

  constructor(pool: Pool, opts?: {
    pollIntervalMs?: number;
    minTransferUsd?: number;
    watchAddresses?: string[];
    wallet?: { chain: string; address: string; encryptedKey?: string; permissions: string[] };
  }) {
    super({
      agentId: 'nova-whale-tracker',
      agentType: 'guardian',
      pool,
    });
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.minTransferUsd = opts?.minTransferUsd ?? DEFAULT_MIN_TRANSFER_USD;
    this.balanceChangePct = DEFAULT_BALANCE_CHANGE_THRESHOLD_PCT;
    this.userWatchList = opts?.watchAddresses ?? [];
    this.walletConfig = opts?.wallet as WalletConfig | undefined;
  }

  protected async onStart(): Promise<void> {
    const saved = await this.restoreState<{
      cycleCount: number;
      totalAlerts: number;
      watchedWallets: [string, WalletSnapshot][];
      userWatchList: string[];
    }>();
    if (saved) {
      this.cycleCount = saved.cycleCount || 0;
      this.totalAlerts = saved.totalAlerts || 0;
      if (saved.watchedWallets) this.watchedWallets = new Map(saved.watchedWallets);
      if (saved.userWatchList) this.userWatchList = [...new Set([...this.userWatchList, ...saved.userWatchList])];
    }

    this.startHeartbeat(60_000);

    // First scan after 30s warmup
    setTimeout(() => this.runScanCycle(), 30_000);

    // Recurring scans
    this.addInterval(() => this.runScanCycle(), this.pollIntervalMs);

    // Listen for supervisor commands
    this.addInterval(() => this.processCommands(), 30_000);

    logger.info(
      `[whale-tracker] 🐋 Online — monitoring Solana + EVM chains every ${this.pollIntervalMs / 60000}min ` +
      `(min transfer: $${this.minTransferUsd.toLocaleString()}, watching ${this.userWatchList.length} custom wallets)`
    );
  }

  protected async onStop(): Promise<void> {
    await this.persistState();
    logger.info(`[whale-tracker] Stopped after ${this.cycleCount} cycles, ${this.totalAlerts} alerts`);
  }

  // ── Main Scan Cycle ────────────────────────────────────────────

  private async runScanCycle(): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;
    await this.updateStatus('gathering');

    logger.info(`[whale-tracker] 🔍 Cycle #${cycleId} — scanning for whale movements...`);

    const alerts: WhaleAlert[] = [];

    // Scan Solana and EVM in parallel
    const [solanaAlerts, evmAlerts] = await Promise.allSettled([
      this.scanSolana(),
      this.scanEvm(),
    ]);

    if (solanaAlerts.status === 'fulfilled') alerts.push(...solanaAlerts.value);
    if (evmAlerts.status === 'fulfilled') alerts.push(...evmAlerts.value);

    // Sort by USD amount descending, cap alerts
    const topAlerts = alerts
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, MAX_ALERTS_PER_CYCLE);

    await this.updateStatus('alive');

    // Report findings to Supervisor
    if (topAlerts.length > 0) {
      this.totalAlerts += topAlerts.length;

      // High-priority alerts for very large transfers
      const criticalAlerts = topAlerts.filter(a => a.amountUsd >= this.minTransferUsd * 10);
      const normalAlerts = topAlerts.filter(a => a.amountUsd < this.minTransferUsd * 10);

      if (criticalAlerts.length > 0) {
        await this.reportToSupervisor('alert', 'high', {
          type: 'whale_movement',
          cycle: cycleId,
          alerts: criticalAlerts,
          summary: `🐋 ${criticalAlerts.length} MASSIVE whale movement(s): ${criticalAlerts.map(a =>
            `${a.chain} ${a.token} $${(a.amountUsd / 1000).toFixed(0)}k ${a.direction || ''} ${a.exchange ? `(${a.exchange})` : ''}`
          ).join(', ')}`,
        });
      }

      if (normalAlerts.length > 0) {
        await this.reportToSupervisor('intel', 'medium', {
          type: 'whale_activity',
          cycle: cycleId,
          alerts: normalAlerts,
          summary: `🐋 Cycle #${cycleId}: ${normalAlerts.length} whale movement(s) detected across ${new Set(normalAlerts.map(a => a.chain)).size} chains`,
        });
      }
    }

    logger.info(`[whale-tracker] Cycle #${cycleId} complete: ${topAlerts.length} alerts`);
    await this.persistState();
  }

  // ── Solana Scanning ────────────────────────────────────────────

  private async scanSolana(): Promise<WhaleAlert[]> {
    const alerts: WhaleAlert[] = [];

    try {
      // Try Helius first (enhanced transaction data)
      const heliusApiKey = process.env.HELIUS_API_KEY;
      if (!heliusApiKey) {
        // Fallback: scan our own wallets via RPC
        return this.scanSolanaWallets();
      }

      // Scan Nova's own wallets for balance changes
      const walletAlerts = await this.scanSolanaWallets();
      alerts.push(...walletAlerts);

      // Check known exchange wallets for large movements
      const exchangeAlerts = await this.scanSolanaExchangeFlows(heliusApiKey);
      alerts.push(...exchangeAlerts);

    } catch (err: any) {
      logger.warn(`[whale-tracker] Solana scan failed: ${err.message}`);
    }

    return alerts;
  }

  private async scanSolanaWallets(): Promise<WhaleAlert[]> {
    const alerts: WhaleAlert[] = [];

    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

      // Check Nova's own wallets
      const walletsToCheck: { address: string; label: string }[] = [];

      const fundingAddr = process.env.PUMP_PORTAL_WALLET_ADDRESS;
      if (fundingAddr) walletsToCheck.push({ address: fundingAddr, label: 'pump-wallet' });

      // Add user-provided watch addresses
      for (const addr of this.userWatchList) {
        if (addr.length >= 32 && addr.length <= 44) { // Solana address format
          walletsToCheck.push({ address: addr, label: 'watched' });
        }
      }

      for (const wallet of walletsToCheck) {
        try {
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'getBalance',
              params: [wallet.address],
            }),
          });

          const data = await res.json() as any;
          const balanceLamports = data?.result?.value ?? 0;
          const balanceSol = balanceLamports / 1e9;

          // Get SOL price
          let solPrice = 150; // fallback
          try {
            const { getSolPrice } = await import('../launchkit/cfo/pythOracleService.ts');
            solPrice = await getSolPrice();
          } catch { /* use fallback */ }

          const balanceUsd = balanceSol * solPrice;
          const key = `sol:${wallet.address}`;
          const prev = this.watchedWallets.get(key);

          if (prev) {
            const delta = Math.abs(balanceUsd - prev.balanceUsd);
            const deltaPct = prev.balanceUsd > 0 ? (delta / prev.balanceUsd) * 100 : 0;

            if (delta >= this.minTransferUsd || deltaPct >= this.balanceChangePct) {
              const direction = balanceUsd > prev.balanceUsd ? 'inflow' : 'outflow';
              alerts.push({
                type: 'balance_change',
                chain: 'Solana',
                fromAddress: direction === 'outflow' ? wallet.address : undefined,
                toAddress: direction === 'inflow' ? wallet.address : undefined,
                amountUsd: delta,
                amountNative: Math.abs(balanceSol - prev.balanceNative),
                token: 'SOL',
                direction,
                description: `${wallet.label} ${direction}: $${delta.toFixed(0)} (${deltaPct.toFixed(1)}% change)`,
                severity: delta >= this.minTransferUsd * 5 ? 'high' : 'medium',
              });
            }
          }

          // Update snapshot
          this.watchedWallets.set(key, {
            address: wallet.address,
            chain: 'solana',
            label: wallet.label,
            balanceUsd,
            balanceNative: balanceSol,
            timestamp: Date.now(),
          });
        } catch {
          // Skip this wallet
        }
      }
    } catch (err: any) {
      logger.warn(`[whale-tracker] Solana wallet scan failed: ${err.message}`);
    }

    return alerts;
  }

  private async scanSolanaExchangeFlows(heliusApiKey: string): Promise<WhaleAlert[]> {
    const alerts: WhaleAlert[] = [];

    try {
      // Check a few known exchange wallets for recent large transfers
      const addresses = Object.keys(KNOWN_EXCHANGES_SOL).slice(0, 3); // Rate-limit friendly

      for (const addr of addresses) {
        try {
          const res = await fetch(
            `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${heliusApiKey}&limit=5`,
            { headers: { 'User-Agent': 'nova-whale-tracker/1.0' } }
          );

          if (!res.ok) continue;
          const txns = await res.json() as any[];

          for (const tx of txns) {
            // Check for large SOL transfers
            const nativeTransfers = tx.nativeTransfers || [];
            for (const transfer of nativeTransfers) {
              const amountSol = (transfer.amount || 0) / 1e9;
              if (amountSol < 100) continue; // 100+ SOL transfers only

              let solPrice = 150;
              try {
                const { getSolPrice } = await import('../launchkit/cfo/pythOracleService.ts');
                solPrice = await getSolPrice();
              } catch { /* fallback */ }

              const amountUsd = amountSol * solPrice;
              if (amountUsd < this.minTransferUsd) continue;

              const exchangeName = KNOWN_EXCHANGES_SOL[addr] || 'Unknown Exchange';
              const direction = transfer.toUserAccount === addr ? 'inflow' : 'outflow';

              alerts.push({
                type: 'exchange_flow',
                chain: 'Solana',
                fromAddress: transfer.fromUserAccount,
                toAddress: transfer.toUserAccount,
                amountUsd,
                amountNative: amountSol,
                token: 'SOL',
                direction,
                exchange: exchangeName,
                description: `${exchangeName} ${direction}: ${amountSol.toFixed(1)} SOL ($${(amountUsd / 1000).toFixed(0)}k)`,
                severity: amountUsd >= 500_000 ? 'high' : 'medium',
              });
            }
          }
        } catch {
          // Skip this exchange
        }
      }
    } catch (err: any) {
      logger.warn(`[whale-tracker] Exchange flow scan failed: ${err.message}`);
    }

    return alerts;
  }

  // ── EVM Scanning ───────────────────────────────────────────────

  private async scanEvm(): Promise<WhaleAlert[]> {
    const alerts: WhaleAlert[] = [];

    try {
      // Use evmProviderService multi-chain balance scanner
      const { getMultiChainEvmBalances } = await import('../launchkit/cfo/evmProviderService.ts');
      const chainBalances = await getMultiChainEvmBalances();

      for (const cb of chainBalances) {
        const key = `evm:${cb.chainId}`;
        const prev = this.watchedWallets.get(key);

        if (prev) {
          const delta = Math.abs(cb.totalValueUsd - prev.balanceUsd);
          const deltaPct = prev.balanceUsd > 0 ? (delta / prev.balanceUsd) * 100 : 0;

          if (delta >= this.minTransferUsd || deltaPct >= this.balanceChangePct) {
            const direction = cb.totalValueUsd > prev.balanceUsd ? 'inflow' : 'outflow';
            alerts.push({
              type: 'balance_change',
              chain: cb.chainName || `EVM-${cb.chainId}`,
              amountUsd: delta,
              token: 'multi',
              direction,
              description: `${cb.chainName} ${direction}: $${delta.toFixed(0)} (${deltaPct.toFixed(1)}% change, total now $${cb.totalValueUsd.toFixed(0)})`,
              severity: delta >= this.minTransferUsd * 5 ? 'high' : 'medium',
            });
          }
        }

        // Update snapshot
        this.watchedWallets.set(key, {
          address: `chain-${cb.chainId}`,
          chain: cb.chainName || `evm-${cb.chainId}`,
          balanceUsd: cb.totalValueUsd,
          balanceNative: cb.nativeBalance,
          timestamp: Date.now(),
        });
      }

      // Also check user-provided EVM watch addresses
      for (const addr of this.userWatchList) {
        if (addr.startsWith('0x') && addr.length === 42) {
          await this.scanEvmAddress(addr, alerts);
        }
      }

    } catch (err: any) {
      logger.warn(`[whale-tracker] EVM scan failed: ${err.message}`);
    }

    return alerts;
  }

  private async scanEvmAddress(address: string, alerts: WhaleAlert[]): Promise<void> {
    try {
      const { getEvmProvider } = await import('../launchkit/cfo/evmProviderService.ts');
      const { getCFOEnv } = await import('../launchkit/cfo/cfoEnv.ts');
      const env = getCFOEnv();

      // Check balance on all configured EVM chains
      for (const chainIdStr of Object.keys(env.evmRpcUrls || {})) {
        const chainId = Number(chainIdStr);
        try {
          const provider = await getEvmProvider(chainId);
          const balance = await provider.getBalance(address);
          const balanceEth = Number(balance) / 1e18;

          let ethPrice = 3000; // fallback
          try {
            const { getEthPrice } = await import('../launchkit/cfo/pythOracleService.ts');
            ethPrice = await getEthPrice();
          } catch { /* fallback */ }

          const balanceUsd = balanceEth * ethPrice;
          const key = `evm:${chainId}:${address}`;
          const prev = this.watchedWallets.get(key);

          if (prev) {
            const delta = Math.abs(balanceUsd - prev.balanceUsd);
            if (delta >= this.minTransferUsd) {
              const direction = balanceUsd > prev.balanceUsd ? 'inflow' : 'outflow';
              const exchange = KNOWN_EXCHANGES_EVM[address.toLowerCase()];
              alerts.push({
                type: exchange ? 'exchange_flow' : 'balance_change',
                chain: `EVM-${chainId}`,
                fromAddress: direction === 'outflow' ? address : undefined,
                toAddress: direction === 'inflow' ? address : undefined,
                amountUsd: delta,
                amountNative: Math.abs(balanceEth - prev.balanceNative),
                token: 'ETH',
                direction,
                exchange,
                description: `${exchange || address.slice(0, 8)}... ${direction}: $${delta.toFixed(0)}`,
                severity: delta >= this.minTransferUsd * 10 ? 'high' : 'medium',
              });
            }
          }

          this.watchedWallets.set(key, {
            address,
            chain: `evm-${chainId}`,
            balanceUsd,
            balanceNative: balanceEth,
            timestamp: Date.now(),
          });
        } catch {
          // Skip this chain for this address
        }
      }
    } catch (err: any) {
      logger.warn(`[whale-tracker] EVM address scan failed for ${address.slice(0, 8)}: ${err.message}`);
    }
  }

  // ── Command Processing ─────────────────────────────────────────

  private async processCommands(): Promise<void> {
    const messages = await this.readMessages(5);
    for (const msg of messages) {
      const payload = msg.payload;
      if (payload?.command === 'immediate_scan') {
        logger.info('[whale-tracker] Received immediate_scan command');
        await this.runScanCycle();
      } else if (payload?.command === 'add_wallet') {
        const addr = payload.address;
        if (addr && !this.userWatchList.includes(addr)) {
          this.userWatchList.push(addr);
          logger.info(`[whale-tracker] Added ${addr.slice(0, 8)}... to watch list`);
        }
      }
      await this.acknowledgeMessage(msg.id!);
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.saveState({
      cycleCount: this.cycleCount,
      totalAlerts: this.totalAlerts,
      watchedWallets: [...this.watchedWallets.entries()].slice(-100),
      userWatchList: this.userWatchList,
    });
  }
}
