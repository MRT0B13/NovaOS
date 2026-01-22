import { Evaluator, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import { executeDeposit, executeWithdraw, detectWalletCommand } from './walletInterceptor.ts';

/**
 * Wallet Command Evaluator
 * 
 * This evaluator runs AFTER the LLM responds and checks if the user
 * requested a wallet operation. If so, it executes the operation
 * regardless of what the LLM decided to do.
 * 
 * This fixes the issue where the LLM chooses REPLY instead of
 * running the wallet action, then makes up incorrect balance info.
 */
export const walletCommandEvaluator: Evaluator = {
  name: 'WALLET_COMMAND_EVALUATOR',
  description: 'Intercepts wallet commands and ensures they execute correctly',
  similes: ['WALLET_INTERCEPTOR', 'DEPOSIT_EVALUATOR', 'WITHDRAW_EVALUATOR'],
  alwaysRun: true,
  
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const command = detectWalletCommand(text);
    
    // Only run for deposit/withdraw commands
    if (command.type !== 'none') {
      logger.info(`[WalletEvaluator] Detected ${command.type} command in message`);
      return true;
    }
    return false;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: any
  ): Promise<any> => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const command = detectWalletCommand(text);
    
    logger.info(`[WalletEvaluator] Processing ${command.type} command`);
    
    if (command.type === 'deposit' && command.amount) {
      const result = await executeDeposit(command.amount);
      logger.info(`[WalletEvaluator] Deposit result: ${result.success ? 'success' : 'failed'}`);
      
      // If callback available, send the result
      if (callback) {
        await callback({
          text: result.message,
          content: { success: result.success, ...result.data },
        });
      }
      
      return {
        text: result.message,
        success: result.success,
        action: 'DEPOSIT_TO_PUMP_WALLET',
        walletCommandExecuted: true,
      };
    }
    
    if (command.type === 'withdraw') {
      const result = await executeWithdraw(command.amount, command.withdrawAll);
      logger.info(`[WalletEvaluator] Withdraw result: ${result.success ? 'success' : 'failed'}`);
      
      if (callback) {
        await callback({
          text: result.message,
          content: { success: result.success, ...result.data },
        });
      }
      
      return {
        text: result.message,
        success: result.success,
        action: 'WITHDRAW_FROM_PUMP_WALLET',
        walletCommandExecuted: true,
      };
    }
    
    return null;
  },
  
  examples: [],
};
