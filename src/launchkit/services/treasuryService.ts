/**
 * Treasury Service
 * 
 * Handles treasury operations including:
 * - Withdrawals to treasury wallet
 * - Threshold-based sweeps
 * - Audit logging for all treasury operations
 * 
 * Treasury wallet is address-only (no private key stored).
 * All actual transfers happen via fundingWallet.ts using PUMP_PORTAL_WALLET_SECRET.
 */

import { logger } from '@elizaos/core';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getEnv } from '../env.ts';
import { getRpcUrl } from './solanaRpc.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import {
  checkGuardrails,
  recordWithdrawal,
  isTreasuryMode,
  isTreasuryLogOnly,
  checkWithdrawalReadiness,
  ErrorCodes,
  GuardrailError,
  getWithdrawalDestination,
  computeUpdatedCaps,
  getEffectiveCaps,
  TreasuryCaps,
} from './operatorGuardrails.ts';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { LaunchPack } from '../model/launchPack.ts';

// ==========================================
// Types
// ==========================================

export type TreasuryDestination = 'treasury' | 'funding';

export interface TreasuryOperationStatus {
  status: 'idle' | 'in_progress' | 'success' | 'failed' | 'log_only';
  treasury_destination: TreasuryDestination;
  attempted_at?: string;
  completed_at?: string;
  amount_sol?: number;
  tx_signature?: string;
  error_code?: string;
  error_message?: string;
  readiness_mode?: 'local_signing' | 'pumpportal_withdraw' | 'unsupported';
  log_only?: boolean;
}

export interface WithdrawToTreasuryResult {
  success: boolean;
  logOnly: boolean;
  signature?: string;
  withdrawn: number;
  destination: string;
  destinationType: TreasuryDestination;
  newPumpBalance?: number;
  message: string;
  auditLog?: string[];
  updatedCaps?: TreasuryCaps; // New: caps after this withdrawal for persistence
}

export interface SweepCheckResult {
  shouldSweep: boolean;
  reason: string;
  currentBalance: number;
  withdrawableAmount: number;
  destination?: string;
}

// ==========================================
// Destination Enforcement (Deepest Layer)
// ==========================================

/**
 * Validate and enforce destination at the service layer.
 * This is the lowest level check - even if actions pass guardrails,
 * the service layer double-checks for safety.
 * 
 * @throws GuardrailError if destination is not allowed
 */
export function enforceDestination(destinationAddress: string): void {
  const env = getEnv();
  
  // INVARIANT: Never allow withdrawal to pump wallet address
  if (env.PUMP_PORTAL_WALLET_ADDRESS && destinationAddress === env.PUMP_PORTAL_WALLET_ADDRESS) {
    throw new GuardrailError(
      ErrorCodes.INVARIANT_VIOLATION,
      'Cannot withdraw to the pump wallet itself.',
      { destination: destinationAddress.slice(0, 8) }
    );
  }
  
  // If treasury is enabled, destination MUST be treasury address
  if (env.treasuryEnabled) {
    if (!env.TREASURY_ADDRESS) {
      throw new GuardrailError(
        ErrorCodes.TREASURY_NOT_CONFIGURED,
        'Treasury is enabled but TREASURY_ADDRESS is not configured.',
        {}
      );
    }
    
    if (destinationAddress !== env.TREASURY_ADDRESS) {
      throw new GuardrailError(
        ErrorCodes.DESTINATION_NOT_ALLOWED,
        'When treasury is enabled, all withdrawals must go to TREASURY_ADDRESS.',
        { 
          attempted: destinationAddress.slice(0, 8),
          expected: env.TREASURY_ADDRESS.slice(0, 8),
        }
      );
    }
  }
}

// ==========================================
// Treasury Operations
// ==========================================

/**
 * Withdraw from pump wallet to treasury (or funding wallet if treasury not enabled)
 * 
 * This is the main treasury operation. When treasury is enabled, funds go to
 * TREASURY_ADDRESS. When disabled, funds go back to the funding wallet (default behavior).
 */
export async function withdrawToTreasury(
  amountSol?: number,
  options?: { 
    leaveReserve?: number;
    force?: boolean;
    launchPackId?: string;
  }
): Promise<WithdrawToTreasuryResult> {
  const env = getEnv();
  const auditLog: string[] = [];
  
  const addAudit = (msg: string) => {
    const entry = `[${nowIso()}] ${msg}`;
    auditLog.push(entry);
    logger.info(`[Treasury] ${msg}`);
  };
  
  addAudit(`Withdraw initiated${options?.launchPackId ? ` for pack ${options.launchPackId.slice(0, 8)}` : ''}`);
  
  // Determine destination
  const { address: destinationAddress, type: destinationType } = getWithdrawalDestination();
  
  // For treasury mode, we have the actual address
  // For funding mode, we need to derive it from the secret
  let actualDestination: string;
  if (destinationType === 'treasury') {
    actualDestination = env.TREASURY_ADDRESS!;
    addAudit(`Destination: Treasury wallet ${actualDestination.slice(0, 8)}...`);
  } else {
    if (!env.AGENT_FUNDING_WALLET_SECRET) {
      throw new GuardrailError(
        ErrorCodes.WALLET_SECRET_MISSING,
        'AGENT_FUNDING_WALLET_SECRET not configured - cannot determine funding wallet address'
      );
    }
    const fundingKeypair = Keypair.fromSecretKey(bs58.decode(env.AGENT_FUNDING_WALLET_SECRET));
    actualDestination = fundingKeypair.publicKey.toBase58();
    addAudit(`Destination: Funding wallet ${actualDestination.slice(0, 8)}...`);
  }
  
  // CRITICAL: Enforce destination at service layer (deepest check)
  enforceDestination(actualDestination);
  
  // Check guardrails
  const guardrailResult = await checkGuardrails({
    operation: 'withdraw',
    destinationAddress: actualDestination,
    amountSol,
    launchPackId: options?.launchPackId,
  });
  
  if (!guardrailResult.allowed) {
    addAudit(`Guardrail blocked: ${guardrailResult.code} - ${guardrailResult.reason}`);
    throw new GuardrailError(
      guardrailResult.code!,
      guardrailResult.reason!,
      { auditLog }
    );
  }
  
  // Check withdrawal readiness
  const readiness = checkWithdrawalReadiness();
  if (!readiness.ready) {
    addAudit(`Withdrawal not supported: ${readiness.reason}`);
    throw new GuardrailError(
      ErrorCodes.WITHDRAW_NOT_SUPPORTED,
      readiness.reason!,
      { mode: readiness.mode, auditLog }
    );
  }
  
  // Check if log-only mode
  if (isTreasuryLogOnly() && !options?.force) {
    // Calculate what we would withdraw
    const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET!));
    
    const pumpBalance = await connection.getBalance(pumpKeypair.publicKey);
    const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;
    
    const reserve = options?.leaveReserve ?? env.TREASURY_MIN_RESERVE_SOL;
    const txFee = 0.001;
    
    let withdrawAmount: number;
    if (amountSol !== undefined) {
      withdrawAmount = Math.min(amountSol, pumpBalanceSol - txFee);
    } else {
      withdrawAmount = Math.max(0, pumpBalanceSol - reserve - txFee);
    }
    
    addAudit(`LOG_ONLY mode - would withdraw ${withdrawAmount.toFixed(4)} SOL to ${destinationType}`);
    addAudit(`Current pump balance: ${pumpBalanceSol.toFixed(4)} SOL`);
    addAudit(`Reserve: ${reserve} SOL, TX fee: ${txFee} SOL`);
    
    return {
      success: true,
      logOnly: true,
      withdrawn: withdrawAmount,
      destination: actualDestination,
      destinationType,
      message: `[LOG_ONLY] Would withdraw ${withdrawAmount.toFixed(4)} SOL to ${destinationType} wallet (${actualDestination.slice(0, 8)}...). Set TREASURY_LOG_ONLY=false to execute.`,
      auditLog,
    };
  }
  
  // Execute the actual withdrawal
  addAudit(`Executing withdrawal via mode: ${readiness.mode}`);
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load pump wallet keypair (we verified secret exists in readiness check)
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET!));
  const destinationPubkey = new PublicKey(actualDestination);
  
  // Check pump wallet balance
  const pumpBalance = await connection.getBalance(pumpKeypair.publicKey);
  const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;
  
  addAudit(`Pump wallet balance: ${pumpBalanceSol.toFixed(4)} SOL`);
  
  // Calculate withdrawal amount
  const reserve = options?.leaveReserve ?? env.TREASURY_MIN_RESERVE_SOL;
  const txFee = 0.001;
  
  let withdrawAmount: number;
  if (amountSol !== undefined) {
    const maxAvailable = pumpBalanceSol - txFee;
    if (amountSol > maxAvailable) {
      throw new GuardrailError(
        ErrorCodes.INSUFFICIENT_BALANCE,
        `Cannot withdraw ${amountSol} SOL. Available: ${maxAvailable.toFixed(4)} SOL`,
        { available: maxAvailable, requested: amountSol, auditLog }
      );
    }
    withdrawAmount = amountSol;
  } else {
    withdrawAmount = Math.max(0, pumpBalanceSol - reserve - txFee);
  }
  
  if (withdrawAmount <= 0) {
    addAudit(`Nothing to withdraw (balance: ${pumpBalanceSol.toFixed(4)}, reserve: ${reserve})`);
    return {
      success: true,
      logOnly: false,
      withdrawn: 0,
      destination: actualDestination,
      destinationType,
      newPumpBalance: pumpBalanceSol,
      message: `Nothing to withdraw. Current balance: ${pumpBalanceSol.toFixed(4)} SOL, Reserve: ${reserve} SOL`,
      auditLog,
    };
  }
  
  addAudit(`Withdrawing ${withdrawAmount.toFixed(4)} SOL (leaving ${reserve} SOL reserve)`);
  
  // Create transfer transaction
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: pumpKeypair.publicKey,
      toPubkey: destinationPubkey,
      lamports: Math.floor(withdrawAmount * LAMPORTS_PER_SOL),
    })
  );
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = pumpKeypair.publicKey;
  
  // Sign transaction
  transaction.sign(pumpKeypair);
  
  // Send transaction
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  addAudit(`Transaction sent: ${signature}`);
  
  // Poll for confirmation
  const maxRetries = 30;
  let confirmed = false;
  
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    
    if (status) {
      if (status.err) {
        addAudit(`Transaction failed: ${JSON.stringify(status.err)}`);
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        confirmed = true;
        addAudit(`Transaction confirmed (status: ${status.confirmationStatus})`);
        break;
      }
    }
    
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired - blockhash no longer valid');
    }
  }
  
  if (!confirmed) {
    throw new Error('Transaction confirmation timeout');
  }
  
  // Get new pump wallet balance
  const newPumpBalance = (await connection.getBalance(pumpKeypair.publicKey)) / LAMPORTS_PER_SOL;
  
  // Record in daily state (legacy in-memory)
  recordWithdrawal(withdrawAmount);
  
  // Compute updated caps for persistence (caller should persist to ops.treasury_caps)
  const updatedCaps = computeUpdatedCaps(undefined, withdrawAmount);
  
  addAudit(`✅ Successfully withdrew ${withdrawAmount.toFixed(4)} SOL to ${destinationType}`);
  addAudit(`New pump wallet balance: ${newPumpBalance.toFixed(4)} SOL`);
  
  return {
    success: true,
    logOnly: false,
    signature,
    withdrawn: withdrawAmount,
    destination: actualDestination,
    destinationType,
    newPumpBalance,
    message: `✅ Withdrew ${withdrawAmount.toFixed(4)} SOL to ${destinationType} wallet`,
    auditLog,
    updatedCaps,
  };
}

/**
 * Check if a sweep should be triggered based on thresholds
 */
export async function checkSweepTrigger(): Promise<SweepCheckResult> {
  const env = getEnv();
  
  // Must have treasury or auto-withdraw enabled
  if (!env.treasuryEnabled && !env.autoWithdrawEnabled) {
    return {
      shouldSweep: false,
      reason: 'Neither treasury nor auto-withdraw is enabled',
      currentBalance: 0,
      withdrawableAmount: 0,
    };
  }
  
  // Check withdrawal readiness
  const readiness = checkWithdrawalReadiness();
  if (!readiness.ready) {
    return {
      shouldSweep: false,
      reason: `Withdrawal not supported: ${readiness.reason}`,
      currentBalance: 0,
      withdrawableAmount: 0,
    };
  }
  
  // Get current balance
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    return {
      shouldSweep: false,
      reason: 'PUMP_PORTAL_WALLET_SECRET not configured',
      currentBalance: 0,
      withdrawableAmount: 0,
    };
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  
  const balance = await connection.getBalance(pumpKeypair.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  
  // Check against threshold
  const minBalance = env.WITHDRAW_MIN_SOL;
  const keepBalance = env.WITHDRAW_KEEP_SOL;
  const txFee = 0.001;
  
  if (balanceSol <= minBalance) {
    return {
      shouldSweep: false,
      reason: `Balance ${balanceSol.toFixed(4)} SOL <= threshold ${minBalance} SOL`,
      currentBalance: balanceSol,
      withdrawableAmount: 0,
    };
  }
  
  const withdrawableAmount = Math.max(0, balanceSol - keepBalance - txFee);
  
  if (withdrawableAmount <= 0) {
    return {
      shouldSweep: false,
      reason: `No withdrawable amount after keeping ${keepBalance} SOL runway`,
      currentBalance: balanceSol,
      withdrawableAmount: 0,
    };
  }
  
  const { address, type } = getWithdrawalDestination();
  
  return {
    shouldSweep: true,
    reason: `Balance ${balanceSol.toFixed(4)} SOL > threshold ${minBalance} SOL`,
    currentBalance: balanceSol,
    withdrawableAmount,
    destination: type === 'treasury' ? env.TREASURY_ADDRESS : address,
  };
}

/**
 * Execute a sweep if conditions are met
 * This is called by the scheduler
 */
export async function executeSweepIfNeeded(options?: {
  launchPackId?: string;
  force?: boolean;
}): Promise<{
  executed: boolean;
  result?: WithdrawToTreasuryResult;
  checkResult: SweepCheckResult;
}> {
  const check = await checkSweepTrigger();
  
  if (!check.shouldSweep && !options?.force) {
    logger.debug(`[Treasury] Sweep check: ${check.reason}`);
    return {
      executed: false,
      checkResult: check,
    };
  }
  
  logger.info(`[Treasury] Sweep triggered: ${check.reason}`);
  
  try {
    const result = await withdrawToTreasury(undefined, {
      leaveReserve: getEnv().WITHDRAW_KEEP_SOL,
      launchPackId: options?.launchPackId,
    });
    
    return {
      executed: !result.logOnly,
      result,
      checkResult: check,
    };
  } catch (error) {
    logger.error('[Treasury] Sweep failed:', error);
    return {
      executed: false,
      checkResult: {
        ...check,
        shouldSweep: false,
        reason: `Sweep failed: ${(error as Error).message}`,
      },
    };
  }
}

/**
 * Get treasury operation status for a LaunchPack
 * Returns the ops.treasury object structure
 */
export function createTreasuryStatus(
  status: TreasuryOperationStatus['status'],
  destination: TreasuryDestination,
  details?: Partial<TreasuryOperationStatus>
): TreasuryOperationStatus {
  const readiness = checkWithdrawalReadiness();
  
  return {
    status,
    treasury_destination: destination,
    readiness_mode: readiness.mode,
    ...details,
  };
}

// ==========================================
// Claim-First Withdrawal Pattern
// ==========================================

export interface ClaimFirstWithdrawResult {
  claimed: boolean;
  claimErrorCode?: string;
  claimErrorReason?: string;
  result?: WithdrawToTreasuryResult;
  updatedPack?: LaunchPack;
}

/**
 * Execute a treasury withdrawal using claim-first pattern.
 * This prevents double-execution from scheduler + manual action overlap.
 * 
 * Flow:
 * 1. Claim the treasury operation (set status=in_progress)
 * 2. If claim fails, return TREASURY_IN_PROGRESS error
 * 3. Execute withdrawal (or log-only)
 * 4. Update pack with result (success/failed/log_only) and persist caps
 * 
 * @param store - LaunchPack store for persistence
 * @param packId - LaunchPack ID to operate on
 * @param options - Withdrawal options
 */
export async function claimFirstWithdraw(
  store: LaunchPackStore,
  packId: string,
  options?: {
    amountSol?: number;
    leaveReserve?: number;
    force?: boolean;
  }
): Promise<ClaimFirstWithdrawResult> {
  const env = getEnv();
  const timestamp = nowIso();
  
  // Step 1: Claim the treasury operation
  const claimed = await store.claimTreasuryWithdraw(packId, {
    requested_at: timestamp,
    force: options?.force,
  });
  
  if (!claimed) {
    logger.info(`[Treasury] Claim failed for pack ${packId.slice(0, 8)} - already in progress or recently completed`);
    return {
      claimed: false,
      claimErrorCode: ErrorCodes.TREASURY_IN_PROGRESS,
      claimErrorReason: 'Treasury operation already in progress or recently completed. Wait for cooldown or use force flag.',
    };
  }
  
  logger.info(`[Treasury] Claimed treasury operation for pack ${packId.slice(0, 8)}`);
  
  // Step 2: Execute withdrawal
  const { type: destinationType } = getWithdrawalDestination();
  
  try {
    const result = await withdrawToTreasury(options?.amountSol, {
      leaveReserve: options?.leaveReserve ?? env.TREASURY_MIN_RESERVE_SOL,
      force: options?.force,
      launchPackId: packId,
    });
    
    // Step 3: Update pack with success result
    const existingPack = await store.get(packId);
    const existingCaps = existingPack?.ops?.treasury_caps as TreasuryCaps | undefined;
    
    // Compute final caps with the previous persistent state
    const finalCaps = result.updatedCaps 
      ? computeUpdatedCaps(existingCaps, result.withdrawn)
      : undefined;
    
    const updatedPack = await store.update(packId, {
      ops: {
        treasury: createTreasuryStatus(
          result.logOnly ? 'log_only' : 'success',
          destinationType,
          {
            completed_at: nowIso(),
            amount_sol: result.withdrawn,
            tx_signature: result.signature,
            log_only: result.logOnly,
          }
        ),
        treasury_caps: finalCaps,
      },
    });
    
    return {
      claimed: true,
      result,
      updatedPack,
    };
    
  } catch (error) {
    // Step 3 (failure): Update pack with failed status
    const err = error as Error;
    const isGuardrailError = err instanceof GuardrailError;
    
    logger.error(`[Treasury] Withdrawal failed for pack ${packId.slice(0, 8)}:`, err.message);
    
    await store.update(packId, {
      ops: {
        treasury: createTreasuryStatus(
          'failed',
          destinationType,
          {
            completed_at: nowIso(),
            error_code: isGuardrailError ? (error as GuardrailError).code : 'UNKNOWN_ERROR',
            error_message: err.message,
          }
        ),
      },
    });
    
    throw error;
  }
}
