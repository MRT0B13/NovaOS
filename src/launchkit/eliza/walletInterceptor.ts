import { IAgentRuntime, Memory, HandlerCallback, logger } from '@elizaos/core';
import { depositToPumpWallet, getPumpWalletBalance, getFundingWalletBalance, withdrawFromPumpWallet } from '../services/fundingWallet.ts';

/**
 * Wallet Command Interceptor
 * 
 * This provider intercepts wallet-related commands and executes them BEFORE
 * the LLM has a chance to respond with incorrect information.
 * 
 * The problem: The LLM sometimes chooses REPLY instead of running wallet actions,
 * then makes up incorrect balance information.
 * 
 * The solution: Detect wallet commands in the provider phase and inject
 * the action into the response.
 */

// Patterns for wallet commands
const DEPOSIT_PATTERN = /\bdeposit\s+(\d+\.?\d*)\s*sol\b/i;
const WITHDRAW_PATTERN = /\bwithdraw\s+(\d+\.?\d*)\s*sol\b/i;
const WITHDRAW_ALL_PATTERN = /\bwithdraw\s+(all|everything|profits)\b/i;

export interface WalletCommandResult {
  type: 'deposit' | 'withdraw' | 'none';
  amount?: number;
  withdrawAll?: boolean;
}

/**
 * Detects wallet commands in user message
 */
export function detectWalletCommand(text: string): WalletCommandResult {
  const lowerText = text.toLowerCase();
  
  // Check for deposit
  const depositMatch = lowerText.match(DEPOSIT_PATTERN);
  if (depositMatch) {
    return { type: 'deposit', amount: parseFloat(depositMatch[1]) };
  }
  
  // Check for withdraw with amount
  const withdrawMatch = lowerText.match(WITHDRAW_PATTERN);
  if (withdrawMatch) {
    return { type: 'withdraw', amount: parseFloat(withdrawMatch[1]) };
  }
  
  // Check for withdraw all
  if (WITHDRAW_ALL_PATTERN.test(lowerText)) {
    return { type: 'withdraw', withdrawAll: true };
  }
  
  return { type: 'none' };
}

/**
 * Execute deposit command directly
 */
export async function executeDeposit(amount: number): Promise<{
  success: boolean;
  message: string;
  data?: any;
}> {
  const formatAmount = (n: number) => n.toFixed(Math.max(2, (n.toString().split('.')[1] || '').length));
  const displayAmount = formatAmount(amount);
  
  try {
    // Pre-check balance
    const fundingWallet = await getFundingWalletBalance();
    const requiredAmount = amount + 0.01; // amount + tx fee
    
    logger.info(`[WalletInterceptor] Deposit request: ${displayAmount} SOL`);
    logger.info(`[WalletInterceptor] Funding wallet: ${fundingWallet.balance.toFixed(4)} SOL, Required: ${requiredAmount.toFixed(4)} SOL`);
    
    if (fundingWallet.balance < requiredAmount) {
      return {
        success: false,
        message: `❌ **Insufficient funds for deposit**\n\n` +
          `You want to deposit ${displayAmount} SOL but your funding wallet only has ${fundingWallet.balance.toFixed(4)} SOL.\n` +
          `You need at least ${requiredAmount.toFixed(4)} SOL (${displayAmount} + 0.01 tx fee).\n\n` +
          `Please fund your wallet:\n\`${fundingWallet.address}\``,
      };
    }
    
    // Execute deposit
    const result = await depositToPumpWallet(amount);
    
    return {
      success: true,
      message: `✅ **Deposited ${displayAmount} SOL to pump wallet**\n\n` +
        `Transaction: \`${result.signature}\`\n` +
        `Pump wallet balance: ${result.balance.toFixed(4)} SOL\n\n` +
        `Ready for token launches! 🚀`,
      data: {
        signature: result.signature,
        amount,
        newBalance: result.balance,
      },
    };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error(`[WalletInterceptor] Deposit failed: ${errMsg}`);
    return {
      success: false,
      message: `❌ Failed to deposit: ${errMsg}`,
    };
  }
}

/**
 * Execute withdraw command directly  
 */
export async function executeWithdraw(amount?: number, withdrawAll = false): Promise<{
  success: boolean;
  message: string;
  data?: any;
}> {
  const formatAmount = (n: number) => n.toFixed(Math.max(2, (n.toString().split('.')[1] || '').length));
  
  try {
    // No reserve - withdraw everything available
    const result = await withdrawFromPumpWallet(amount, { leaveReserve: 0 });
    
    return {
      success: true,
      message: `✅ **Withdrew ${formatAmount(result.withdrawn)} SOL from pump wallet**\n\n` +
        `Transaction: \`${result.signature}\`\n` +
        `Pump wallet balance: ${result.newPumpBalance.toFixed(4)} SOL\n` +
        `Funding wallet balance: ${result.newFundingBalance.toFixed(4)} SOL\n\n` +
        `💰 Profits safely transferred to your Phantom wallet!`,
      data: {
        signature: result.signature,
        withdrawn: result.withdrawn,
        newPumpBalance: result.newPumpBalance,
        newFundingBalance: result.newFundingBalance,
      },
    };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error(`[WalletInterceptor] Withdraw failed: ${errMsg}`);
    return {
      success: false,
      message: `❌ Failed to withdraw: ${errMsg}`,
    };
  }
}
