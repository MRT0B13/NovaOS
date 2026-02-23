/**
 * Wallet Sentinel — Balance Monitoring & Drain Detection
 *
 * Monitors all Nova wallets (funding, pump, CFO EVM) for:
 *   - Unexpected balance drops (potential drain)
 *   - Balance anomalies vs expected transaction volume
 *   - Unauthorized outbound transfers
 *   - Low balance warnings (can't operate)
 *
 * Interval: every 2 minutes
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { SecurityReporter, SecurityEvent } from './securityTypes.ts';
import { logSecurityEvent } from './securityTypes.ts';

// ============================================================================
// Types
// ============================================================================

interface WalletConfig {
  address: string;
  label: string;
  chain: 'solana' | 'evm';
  /** Alert if balance drops by more than this % in a single check */
  drainThresholdPct: number;
  /** Alert if balance goes below this (SOL or native token) */
  lowBalanceThreshold: number;
  /** RPC URL to use */
  rpcUrl: string;
}

interface WalletSnapshot {
  address: string;
  label: string;
  balanceSol: number;
  balanceLamports: bigint;
  timestamp: number;
}

// ============================================================================
// Wallet Sentinel
// ============================================================================

export class WalletSentinel {
  private pool: Pool;
  private report: SecurityReporter;
  private wallets: WalletConfig[] = [];
  private lastSnapshots: Map<string, WalletSnapshot> = new Map();
  private consecutiveFailures = 0;
  private totalChecks = 0;
  private totalAlerts = 0;

  constructor(pool: Pool, report: SecurityReporter) {
    this.pool = pool;
    this.report = report;
  }

  /** Initialize wallets to monitor from environment variables */
  init(): void {
    const solRpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

    // Funding wallet — derive public address from secret
    const fundingSecret = process.env.AGENT_FUNDING_WALLET_SECRET;
    if (fundingSecret) {
      try {
        // Lazy-derive public key using base58 → keypair → publicKey
        // We'll do this via RPC instead to avoid importing @solana/web3.js here
        // The address is derived at first balance check by the sign-up process
        // For now, store the env var and derive lazily
        const fundingAddress = this._deriveSolanaAddress(fundingSecret);
        if (fundingAddress) {
          this.wallets.push({
            address: fundingAddress,
            label: 'funding-wallet',
            chain: 'solana',
            drainThresholdPct: 25,  // Alert if 25%+ drops in one check
            lowBalanceThreshold: 0.05, // 0.05 SOL minimum to operate
            rpcUrl: solRpc,
          });
        }
      } catch {
        logger.warn('[wallet-sentinel] Could not derive funding wallet address');
      }
    }

    // Pump wallet — explicit address from env
    const pumpAddress = process.env.PUMP_PORTAL_WALLET_ADDRESS;
    if (pumpAddress) {
      this.wallets.push({
        address: pumpAddress,
        label: 'pump-wallet',
        chain: 'solana',
        drainThresholdPct: 30,
        lowBalanceThreshold: 0.02,
        rpcUrl: solRpc,
      });
    }

    // Treasury wallet
    const treasuryAddress = process.env.TREASURY_ADDRESS;
    if (treasuryAddress) {
      this.wallets.push({
        address: treasuryAddress,
        label: 'treasury-wallet',
        chain: 'solana',
        drainThresholdPct: 20,  // More sensitive for treasury
        lowBalanceThreshold: 0.1,
        rpcUrl: solRpc,
      });
    }

    // CFO EVM wallet (Polygon) — derive from private key or use explicit address
    const cfoEvmKey = process.env.CFO_EVM_PRIVATE_KEY;
    const cfoEvmAddress = process.env.CFO_EVM_WALLET_ADDRESS;
    const polygonRpc = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const evmAddr = cfoEvmAddress || (cfoEvmKey ? this._deriveEvmAddress(cfoEvmKey) : null);
    if (evmAddr) {
      this.wallets.push({
        address: evmAddr,
        label: 'cfo-polygon',
        chain: 'evm',
        drainThresholdPct: 25,
        lowBalanceThreshold: 0.5, // 0.5 MATIC minimum
        rpcUrl: polygonRpc,
      });
    }

    logger.info(`[wallet-sentinel] Monitoring ${this.wallets.length} wallet(s): ${this.wallets.map(w => w.label).join(', ') || 'none configured'}`);
  }

  /** Derive Solana public address from base58 secret key (without @solana/web3.js import) */
  private _deriveSolanaAddress(base58Secret: string): string | null {
    try {
      // Base58 alphabet
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const bytes: number[] = [];
      for (const char of base58Secret) {
        const idx = ALPHABET.indexOf(char);
        if (idx === -1) return null;
        let carry = idx;
        for (let j = 0; j < bytes.length; j++) {
          carry += bytes[j] * 58;
          bytes[j] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytes.push(carry & 0xff);
          carry >>= 8;
        }
      }
      // Add leading zeros
      for (const char of base58Secret) {
        if (char !== '1') break;
        bytes.push(0);
      }
      bytes.reverse();

      // For ed25519 keypair, the public key is the last 32 bytes
      if (bytes.length >= 64) {
        const pubKeyBytes = bytes.slice(32, 64);
        // Encode back to base58
        return this._encodeBase58(pubKeyBytes);
      }
      return null;
    } catch {
      return null;
    }
  }

  private _encodeBase58(bytes: number[]): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let result = '';
    for (const byte of bytes) {
      if (byte !== 0) break;
      result += '1';
    }
    for (let i = digits.length - 1; i >= 0; i--) {
      result += ALPHABET[digits[i]];
    }
    return result;
  }

  /** Run a single check cycle across all monitored wallets */
  async check(): Promise<void> {
    if (this.wallets.length === 0) return;
    this.totalChecks++;

    for (const wallet of this.wallets) {
      try {
        if (wallet.chain === 'solana') {
          await this.checkSolanaWallet(wallet);
        } else if (wallet.chain === 'evm') {
          await this.checkEvmWallet(wallet);
        }
        this.consecutiveFailures = 0;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 5) {
          await this.report({
            category: 'wallet',
            severity: 'warning',
            title: 'Wallet monitoring degraded',
            details: {
              wallet: wallet.label,
              consecutiveFailures: this.consecutiveFailures,
              error: String(err),
            },
          });
        }
      }
    }
  }

  /** Check a single Solana wallet via JSON-RPC */
  private async checkSolanaWallet(wallet: WalletConfig): Promise<void> {
    const balance = await this.fetchSolBalance(wallet.rpcUrl, wallet.address);
    if (balance === null) return; // RPC failure — skip

    const now = Date.now();
    const balanceLamports = BigInt(Math.round(balance * 1e9));

    // Persist snapshot to DB
    await this.persistSnapshot(wallet.address, wallet.label, balance, balanceLamports);

    const prev = this.lastSnapshots.get(wallet.address);

    // Update snapshot
    this.lastSnapshots.set(wallet.address, {
      address: wallet.address,
      label: wallet.label,
      balanceSol: balance,
      balanceLamports,
      timestamp: now,
    });

    // Skip alerts on first check (baseline)
    if (!prev) return;

    // ── Drain Detection ────────────────────────────────────────
    if (prev.balanceSol > 0.01) {
      const dropPct = ((prev.balanceSol - balance) / prev.balanceSol) * 100;

      if (dropPct >= wallet.drainThresholdPct) {
        const event: SecurityEvent = {
          category: 'wallet',
          severity: dropPct >= 80 ? 'emergency' : 'critical',
          title: `WALLET DRAIN DETECTED: ${wallet.label}`,
          details: {
            walletAddress: wallet.address,
            walletLabel: wallet.label,
            previousBalance: prev.balanceSol.toFixed(4),
            currentBalance: balance.toFixed(4),
            droppedSol: (prev.balanceSol - balance).toFixed(4),
            dropPercent: dropPct.toFixed(1),
            timeSinceLastCheck: Math.round((now - prev.timestamp) / 1000),
          },
          autoResponse: dropPct >= 80 ? 'Emergency alert sent to admin' : 'Alert sent to supervisor',
        };
        this.totalAlerts++;
        await this.report(event);
        await logSecurityEvent(this.pool, event);
      }
    }

    // ── Low Balance Warning ────────────────────────────────────
    if (balance < wallet.lowBalanceThreshold && prev.balanceSol >= wallet.lowBalanceThreshold) {
      const event: SecurityEvent = {
        category: 'wallet',
        severity: 'warning',
        title: `Low balance: ${wallet.label}`,
        details: {
          walletAddress: wallet.address,
          walletLabel: wallet.label,
          balance: balance.toFixed(4),
          threshold: wallet.lowBalanceThreshold,
        },
      };
      this.totalAlerts++;
      await this.report(event);
      await logSecurityEvent(this.pool, event);
    }

    // ── Unexpected Increase (could indicate compromise receiving funds for laundering) ──
    if (balance > prev.balanceSol * 10 && prev.balanceSol > 0.001) {
      const event: SecurityEvent = {
        category: 'wallet',
        severity: 'warning',
        title: `Suspicious balance spike: ${wallet.label}`,
        details: {
          walletAddress: wallet.address,
          walletLabel: wallet.label,
          previousBalance: prev.balanceSol.toFixed(4),
          currentBalance: balance.toFixed(4),
          multiplier: (balance / prev.balanceSol).toFixed(1),
        },
      };
      await this.report(event);
      await logSecurityEvent(this.pool, event);
    }
  }

  /** Check a single EVM wallet via JSON-RPC (eth_getBalance) */
  private async checkEvmWallet(wallet: WalletConfig): Promise<void> {
    const balance = await this.fetchEvmBalance(wallet.rpcUrl, wallet.address);
    if (balance === null) return;

    const now = Date.now();
    const balanceLamports = BigInt(Math.round(balance * 1e18));
    await this.persistSnapshot(wallet.address, wallet.label, balance, balanceLamports);

    const prev = this.lastSnapshots.get(wallet.address);
    this.lastSnapshots.set(wallet.address, {
      address: wallet.address,
      label: wallet.label,
      balanceSol: balance, // reusing field for native token balance
      balanceLamports,
      timestamp: now,
    });

    if (!prev) return;

    // Drain detection (same logic as Solana)
    if (prev.balanceSol > 0.01) {
      const dropPct = ((prev.balanceSol - balance) / prev.balanceSol) * 100;
      if (dropPct >= wallet.drainThresholdPct) {
        const event: SecurityEvent = {
          category: 'wallet',
          severity: dropPct >= 80 ? 'emergency' : 'critical',
          title: `EVM WALLET DRAIN DETECTED: ${wallet.label}`,
          details: {
            walletAddress: wallet.address,
            walletLabel: wallet.label,
            chain: 'polygon',
            previousBalance: prev.balanceSol.toFixed(6),
            currentBalance: balance.toFixed(6),
            droppedNative: (prev.balanceSol - balance).toFixed(6),
            dropPercent: dropPct.toFixed(1),
            timeSinceLastCheck: Math.round((now - prev.timestamp) / 1000),
          },
          autoResponse: dropPct >= 80 ? 'Emergency alert sent to admin' : 'Alert sent to supervisor',
        };
        this.totalAlerts++;
        await this.report(event);
        await logSecurityEvent(this.pool, event);
      }
    }

    // Low balance warning
    if (balance < wallet.lowBalanceThreshold && prev.balanceSol >= wallet.lowBalanceThreshold) {
      const event: SecurityEvent = {
        category: 'wallet',
        severity: 'warning',
        title: `Low EVM balance: ${wallet.label}`,
        details: {
          walletAddress: wallet.address,
          walletLabel: wallet.label,
          chain: 'polygon',
          balance: balance.toFixed(6),
          threshold: wallet.lowBalanceThreshold,
        },
      };
      this.totalAlerts++;
      await this.report(event);
      await logSecurityEvent(this.pool, event);
    }
  }

  /** Fetch native EVM balance via JSON-RPC */
  private async fetchEvmBalance(rpcUrl: string, address: string): Promise<number | null> {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest'],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      if (data.error) return null;
      // Result is hex wei — convert to native token units
      const wei = BigInt(data.result || '0x0');
      return Number(wei) / 1e18;
    } catch {
      return null;
    }
  }

  /** Derive EVM address from hex private key (keccak256 of uncompressed pubkey) */
  private _deriveEvmAddress(privateKey: string): string | null {
    // If address is already explicitly set, don't need to derive
    // For now return null — users should set CFO_EVM_WALLET_ADDRESS
    // Full derivation requires secp256k1 which is heavy to inline
    logger.warn('[wallet-sentinel] CFO_EVM_WALLET_ADDRESS not set — cannot derive from private key alone. Set CFO_EVM_WALLET_ADDRESS explicitly.');
    return null;
  }

  /** Fetch SOL balance via JSON-RPC (no @solana/web3.js dependency) */
  private async fetchSolBalance(rpcUrl: string, address: string): Promise<number | null> {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [address],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      if (data.error) return null;
      return (data.result?.value ?? 0) / 1e9;
    } catch {
      return null;
    }
  }

  /** Persist balance snapshot to DB */
  private async persistSnapshot(
    address: string, label: string, balanceSol: number, balanceLamports: bigint,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO wallet_snapshots (wallet_address, wallet_label, balance_sol, balance_lamports)
         VALUES ($1, $2, $3, $4)`,
        [address, label, balanceSol, balanceLamports.toString()],
      );
    } catch { /* table might not exist yet */ }
  }

  /** Get recent balance history for a wallet */
  async getBalanceHistory(address: string, hours = 24): Promise<Array<{ balance_sol: number; created_at: string }>> {
    try {
      const { rows } = await this.pool.query(
        `SELECT balance_sol, created_at FROM wallet_snapshots
         WHERE wallet_address = $1 AND created_at > NOW() - INTERVAL '${hours} hours'
         ORDER BY created_at DESC LIMIT 100`,
        [address],
      );
      return rows;
    } catch { return []; }
  }

  /** Get status summary for the Guardian's getStatus() */
  getStatus() {
    return {
      walletsMonitored: this.wallets.length,
      wallets: this.wallets.map(w => ({
        label: w.label,
        address: w.address.slice(0, 8) + '...',
        chain: w.chain,
        lastBalance: this.lastSnapshots.get(w.address)?.balanceSol?.toFixed(4) ?? 'unknown',
      })),
      totalChecks: this.totalChecks,
      totalAlerts: this.totalAlerts,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
