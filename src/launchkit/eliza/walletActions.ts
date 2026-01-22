import { Action, ActionResult, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { depositToPumpWallet, getPumpWalletBalance, getFundingWalletBalance, withdrawFromPumpWallet, sellToken, getPumpWalletTokens, buyToken } from '../services/fundingWallet.ts';
import { executeDeposit, executeWithdraw, detectWalletCommand } from './walletInterceptor.ts';

// Helper to detect if message is a deposit request
function isDepositRequest(text: string): boolean {
  return /\bdeposit\s+\d+\.?\d*\s*sol\b/i.test(text);
}

// Helper to detect if message is a withdraw request  
function isWithdrawRequest(text: string): boolean {
  return /\bwithdraw\s+\d+\.?\d*\s*sol\b/i.test(text) || /\bwithdraw\s+(all|everything|profits)\b/i.test(text);
}

export const checkWalletBalancesAction: Action = {
  name: 'CHECK_WALLET_BALANCES',
  similes: ['CHECK_BALANCES', 'WALLET_STATUS', 'CHECK_FUNDS', 'BALANCE_CHECK'],
  description: 'Check agent funding wallet and pump wallet balances',
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Don't validate for deposit/withdraw - let those actions handle it
    if (isDepositRequest(text) || isWithdrawRequest(text)) return false;
    return /\b(balance|wallet|fund|sol|check.*wallet|how much)\b/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[CHECK_WALLET_BALANCES] Removed REPLY from actions');
      }
    }

    try {
      const [fundingWallet, pumpBalance] = await Promise.all([
        getFundingWalletBalance(),
        getPumpWalletBalance(),
      ]);
      
      const balanceText = `💰 **Wallet Status**\n\n` +
        `**Agent Funding Wallet**\n` +
        `Address: \`${fundingWallet.address}\`\n` +
        `Balance: ${fundingWallet.balance.toFixed(4)} SOL\n\n` +
        `**Pump Portal Wallet**\n` +
        `Balance: ${pumpBalance.toFixed(4)} SOL\n\n` +
        (pumpBalance < 0.01
          ? `⚠️ Pump wallet needs funds! Use DEPOSIT_TO_PUMP_WALLET to add SOL.`
          : `✅ Pump wallet is funded and ready for launches.`);
      
      await callback({
        text: balanceText,
        content: {
          success: true,
          fundingWallet: {
            address: fundingWallet.address,
            balance: fundingWallet.balance,
          },
          pumpWallet: {
            balance: pumpBalance,
          },
        },
      });
      
      return { text: balanceText, success: true };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({
        text: `❌ Failed to check wallet balances: ${errMsg}`,
        content: { success: false, error: errMsg },
      });
      return { text: `Failed to check wallet balances: ${errMsg}`, success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'check wallet balances' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Checking wallet balances...',
          action: 'CHECK_WALLET_BALANCES',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'how much SOL do we have?' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Let me check our wallet balances',
          action: 'CHECK_WALLET_BALANCES',
        },
      },
    ],
  ],
};

export const depositToPumpWalletAction: Action = {
  name: 'DEPOSIT_TO_PUMP_WALLET',
  similes: ['FUND_PUMP_WALLET', 'ADD_SOL', 'DEPOSIT_SOL', 'FUND_WALLET'],
  description: 'Deposit SOL from agent funding wallet to pump wallet for token launches. ALWAYS use this action when user says "deposit X sol" - never use REPLY for deposit requests!',
  
  // Force this action to run when "deposit X sol" is in message
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Match "deposit X sol" pattern specifically
    const hasDepositAmount = /deposit\s+\d+\.?\d*\s*sol/i.test(text);
    if (hasDepositAmount) {
      console.log('[DEPOSIT_TO_PUMP_WALLET] Validated: deposit request detected');
      return true;
    }
    return /\b(fund|add.*sol|transfer.*pump)\b/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[DEPOSIT_TO_PUMP_WALLET] Removed REPLY from actions');
      }
    }

    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Extract amount (default to 0.5 SOL for a launch)
    const amountMatch = text.match(/(\d+\.?\d*)\s*sol/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0.5;
    
    if (amount <= 0 || amount > 10) {
      await callback({
        text: `❌ Invalid amount. Please specify between 0.01 and 10 SOL.`,
        content: { success: false, error: 'Invalid amount' },
      });
      return { text: 'Invalid amount', success: false };
    }
    
    // Use the interceptor's executeDeposit which has proper balance checking
    const result = await executeDeposit(amount);
    
    await callback({
      text: result.message,
      content: { success: result.success, ...result.data },
    });
    
    return { text: result.message, success: result.success };
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'deposit 0.5 sol to pump wallet' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Depositing 0.5 SOL to pump wallet...',
          action: 'DEPOSIT_TO_PUMP_WALLET',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'fund the pump wallet with 1 SOL' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Funding pump wallet with 1 SOL',
          action: 'DEPOSIT_TO_PUMP_WALLET',
        },
      },
    ],
  ],
};

export const withdrawFromPumpWalletAction: Action = {
  name: 'WITHDRAW_FROM_PUMP_WALLET',
  similes: ['WITHDRAW_PROFITS', 'COLLECT_PROFITS', 'WITHDRAW_SOL', 'TAKE_PROFITS'],
  description: 'Withdraw SOL profits from pump wallet back to funding wallet (Phantom)',
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(withdraw|collect|take.*profit|cash.*out|pull.*out)\b/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[WITHDRAW_FROM_PUMP_WALLET] Removed REPLY from actions');
      }
    }

    try {
      const text = String(message.content?.text ?? '').toLowerCase();
      
      // Extract amount if specified, otherwise withdraw all
      const amountMatch = text.match(/(\d+\.?\d*)\s*sol/);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : undefined;
      
      // Format amount consistently (2 decimal places minimum)
      const formatAmount = (n: number) => n.toFixed(Math.max(2, (n.toString().split('.')[1] || '').length));
      
      // Extract reserve if specified (default 0 SOL - no reserve)
      const reserveMatch = text.match(/leave\s+(\d+\.?\d*)\s*sol|reserve\s+(\d+\.?\d*)\s*sol/);
      const reserve = reserveMatch ? parseFloat(reserveMatch[1] || reserveMatch[2]) : 0;
      
      if (amount !== undefined && (amount <= 0 || amount > 100)) {
        await callback({
          text: `❌ Invalid amount. Please specify between 0.01 and 100 SOL.`,
          content: { success: false, error: 'Invalid amount' },
        });
        return { text: 'Invalid amount', success: false };
      }
      
      const result = await withdrawFromPumpWallet(amount, { leaveReserve: reserve });
      
      await callback({
        text: `✅ **Withdrew ${formatAmount(result.withdrawn)} SOL from pump wallet**\n\n` +
          `Transaction: \`${result.signature}\`\n` +
          `Pump wallet balance: ${result.newPumpBalance.toFixed(4)} SOL\n` +
          `Funding wallet balance: ${result.newFundingBalance.toFixed(4)} SOL\n\n` +
          `💰 Profits safely transferred to your Phantom wallet!`,
        content: {
          success: true,
          signature: result.signature,
          withdrawn: result.withdrawn,
          newPumpBalance: result.newPumpBalance,
          newFundingBalance: result.newFundingBalance,
        },
      });
      
      return { text: 'Withdrawal successful', success: true };
    } catch (error) {
      await callback({
        text: `❌ Failed to withdraw: ${(error as Error).message}`,
        content: { success: false, error: (error as Error).message },
      });
      return { text: 'Withdrawal failed', success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'withdraw profits from pump wallet' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Withdrawing profits to your Phantom wallet...',
          action: 'WITHDRAW_FROM_PUMP_WALLET',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'take 2 sol out and leave 0.5 sol reserve' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Withdrawing 2 SOL, leaving 0.5 SOL for next launch',
          action: 'WITHDRAW_FROM_PUMP_WALLET',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'collect all profits' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Collecting all profits from pump wallet',
          action: 'WITHDRAW_FROM_PUMP_WALLET',
        },
      },
    ],
  ],
};

export const sellTokenAction: Action = {
  name: 'SELL_TOKEN',
  similes: ['SELL_TOKENS', 'DUMP_TOKEN', 'EXIT_POSITION', 'SELL_LAUNCH_TOKENS', 'GET_TOKEN_BALANCE'],
  description: 'Sell tokens from pump wallet to get SOL back. Can sell launched tokens or any tokens held in pump wallet.',
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(sell.*token|dump.*token|exit.*position|sell.*launch|get.*token.*back|token.*balance|what.*tokens)\b/.test(text);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[SELL_TOKEN] Removed REPLY from actions');
      }
    }

    const text = String(message.content?.text ?? '').toLowerCase();
    
    try {
      // Check if user is asking about token balances
      if (/\b(what.*tokens|token.*balance|list.*tokens|show.*tokens)\b/.test(text)) {
        const tokens = await getPumpWalletTokens();
        
        if (tokens.length === 0) {
          await callback({
            text: `📊 **Pump Wallet Token Balances**\n\nNo tokens found in pump wallet. Launch a token first!`,
            content: { success: true, tokens: [] },
          });
          return { text: 'No tokens found', success: true };
        }
        
        const tokenList = tokens.map((t, i) => 
          `${i + 1}. \`${t.mint}\`\n   Balance: ${t.balance.toLocaleString()} tokens`
        ).join('\n\n');
        
        await callback({
          text: `📊 **Pump Wallet Token Balances**\n\n${tokenList}\n\n💡 To sell a token, say "sell token <mint_address>" or "sell all tokens"`,
          content: { success: true, tokens },
        });
        return { text: 'Listed token balances', success: true };
      }
      
      // Extract mint address from message
      // Look for base58 addresses (32-44 chars of alphanumeric, excluding 0, O, I, l)
      const mintMatch = text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      
      if (!mintMatch) {
        // If no mint specified, list available tokens
        const tokens = await getPumpWalletTokens();
        
        if (tokens.length === 0) {
          await callback({
            text: `❌ No tokens found in pump wallet to sell.`,
            content: { success: false, error: 'No tokens available' },
          });
          return { text: 'No tokens to sell', success: false };
        }
        
        const tokenList = tokens.map((t, i) => 
          `${i + 1}. \`${t.mint}\`\n   Balance: ${t.balance.toLocaleString()} tokens`
        ).join('\n\n');
        
        await callback({
          text: `📊 **Available Tokens to Sell**\n\n${tokenList}\n\n💡 To sell, say:\n- "sell token <mint_address>"\n- "sell all of <mint_address>"\n- "sell 50% of <mint_address>"`,
          content: { success: true, tokens },
        });
        return { text: 'Listed available tokens', success: true };
      }
      
      const mintAddress = mintMatch[1];
      
      // Determine amount to sell
      let sellAmount: number | 'all' = 'all';
      const percentMatch = text.match(/(\d+)\s*%/);
      const amountMatch = text.match(/sell\s+(\d+\.?\d*)\s*(tokens?)?/);
      
      if (percentMatch) {
        // Get current balance and calculate percentage
        const tokens = await getPumpWalletTokens();
        const token = tokens.find(t => t.mint === mintAddress);
        if (!token) {
          await callback({
            text: `❌ Token ${mintAddress} not found in pump wallet.`,
            content: { success: false, error: 'Token not found' },
          });
          return { text: 'Token not found', success: false };
        }
        const percent = parseInt(percentMatch[1]);
        sellAmount = Math.floor(token.balance * (percent / 100));
      } else if (amountMatch && !text.includes('all')) {
        sellAmount = parseFloat(amountMatch[1]);
      }
      
      // Execute sell
      const result = await sellToken(mintAddress, sellAmount);
      
      const soldText = sellAmount === 'all' ? 'all tokens' : `${sellAmount.toLocaleString()} tokens`;
      
      await callback({
        text: `✅ **Successfully Sold ${soldText}**\n\n` +
          `🪙 Token: \`${mintAddress}\`\n` +
          `💰 SOL Received: ~${result.solReceived.toFixed(4)} SOL\n` +
          `📝 Transaction: \`${result.signature}\`\n\n` +
          `🔗 [View on Solscan](https://solscan.io/tx/${result.signature})`,
        content: {
          success: true,
          signature: result.signature,
          solReceived: result.solReceived,
          mint: mintAddress,
        },
      });
      
      return { text: 'Token sold successfully', success: true };
    } catch (error) {
      const errMsg = (error as Error).message;
      await callback({
        text: `❌ Failed to sell token: ${errMsg}`,
        content: { success: false, error: errMsg },
      });
      return { text: `Failed to sell: ${errMsg}`, success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'what tokens do I have?' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Checking pump wallet token balances...',
          action: 'SELL_TOKEN',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'sell all tokens from the last launch' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Selling all tokens to get SOL back...',
          action: 'SELL_TOKEN',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'sell 50% of 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Selling 50% of tokens...',
          action: 'SELL_TOKEN',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'dump the ferb tokens to get my sol back' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Selling tokens to recover SOL...',
          action: 'SELL_TOKEN',
        },
      },
    ],
  ],
};

/**
 * BUY_TOKEN Action - User-initiated token purchases
 * Allows users to buy tokens using SOL from the pump wallet
 * Requires explicit user request - agent never buys autonomously
 */
export const buyTokenAction: Action = {
  name: 'BUY_TOKEN',
  similes: ['BUY_TOKENS', 'PURCHASE_TOKEN', 'ACCUMULATE_TOKEN'],
  description: 'Buy tokens using SOL from the pump wallet. User-initiated only.',
  
  suppressInitialMessage: true,
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Must explicitly request buy with amount and identifier
    return /\bbuy\s+(\d+\.?\d*)\s*sol\s+(of|worth)\s/i.test(text) ||
           /\bbuy\s+(\d+\.?\d*)\s*sol\s+[a-z]/i.test(text);
  },
  
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!callback) return { text: 'No callback', success: false };
    
    try {
      const text = String(message.content?.text ?? '').toLowerCase();
      
      // Extract SOL amount
      const amountMatch = text.match(/buy\s+(\d+\.?\d*)\s*sol/i);
      if (!amountMatch) {
        await callback({
          text: '❌ Please specify amount: "buy 0.1 SOL of $FRB"',
          content: { success: false },
        });
        return { text: 'Invalid format', success: false };
      }
      
      const amountSol = parseFloat(amountMatch[1]);
      
      // Safety check
      if (amountSol > 0.5) {
        await callback({
          text: '❌ Max buy amount is 0.5 SOL for safety. Requested: ' + amountSol + ' SOL',
          content: { success: false },
        });
        return { text: 'Amount too high', success: false };
      }
      
      // Extract mint address from message
      const mintMatch = text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      
      if (!mintMatch) {
        await callback({
          text: '❌ Please specify the token mint address or use "buy 0.1 SOL of $TICKER"',
          content: { success: false },
        });
        return { text: 'No mint specified', success: false };
      }
      
      const mintAddress = mintMatch[1];
      
      const result = await buyToken(mintAddress, amountSol);
      
      await callback({
        text: '✅ **Successfully Bought Tokens**\n\n' +
          '🪙 Token: `' + mintAddress + '`\n' +
          '💰 SOL Spent: ' + amountSol.toFixed(4) + ' SOL\n' +
          '📝 Transaction: `' + result.signature + '`\n\n' +
          '⚠️ This was a USER-INITIATED buy. Holdings are disclosed.',
        content: {
          success: true,
          signature: result.signature,
          amountSol,
          tokensReceived: result.tokensReceived,
        },
      });
      
      return { text: 'Bought tokens', success: true };
      
    } catch (error: any) {
      await callback({
        text: '❌ Failed to buy tokens: ' + error.message,
        content: { success: false, error: error.message },
      });
      return { text: 'Buy failed', success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'buy 0.1 SOL of CHWDAsq6XEeDGxpxNqCrFZEZcZpGuZemNjAxUXQu99ZT' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Buying 0.1 SOL worth of tokens...',
          action: 'BUY_TOKEN',
        },
      },
    ],
  ],
};

/**
 * REPORT_HOLDINGS Action - Transparent reporting of agent token holdings
 * Shows all tokens held by the pump wallet with full disclosure
 */
export const reportHoldingsAction: Action = {
  name: 'REPORT_HOLDINGS',
  similes: ['SHOW_HOLDINGS', 'TOKEN_HOLDINGS', 'WHAT_TOKENS', 'PORTFOLIO', 'POSITIONS'],
  description: 'Report all token holdings in the pump wallet - full transparency',
  
  suppressInitialMessage: true,
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(holdings?|positions?|portfolio|what\s+tokens?|show\s+tokens?|token\s+balance)\b/i.test(text);
  },
  
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!callback) return { text: 'No callback', success: false };
    
    try {
      const tokens = await getPumpWalletTokens();
      const solBalance = await getPumpWalletBalance();
      
      if (tokens.length === 0) {
        await callback({
          text: '📊 **Agent Holdings Report**\n\n' +
            '💰 SOL Balance: ' + solBalance.toFixed(4) + ' SOL\n' +
            '🪙 Token Holdings: None\n\n' +
            '✅ No token positions held.',
          content: { success: true, tokens: [], solBalance },
        });
        return { text: 'No holdings', success: true };
      }
      
      let holdingsText = '📊 **Agent Holdings Report**\n\n';
      holdingsText += '💰 SOL Balance: ' + solBalance.toFixed(4) + ' SOL\n\n';
      holdingsText += '🪙 **Token Holdings:**\n';
      
      for (const token of tokens) {
        holdingsText += '• `' + token.mint + '`\n';
        holdingsText += '  Balance: ' + token.balance.toLocaleString() + ' tokens\n';
      }
      
      holdingsText += '\n⚠️ All holdings are fully disclosed for transparency.';
      
      await callback({
        text: holdingsText,
        content: { success: true, tokens, solBalance },
      });
      
      return { text: 'Reported holdings', success: true };
      
    } catch (error: any) {
      await callback({
        text: '❌ Failed to get holdings: ' + error.message,
        content: { success: false, error: error.message },
      });
      return { text: 'Report failed', success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'what tokens do you hold?' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Here are my current holdings...',
          action: 'REPORT_HOLDINGS',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'show me your portfolio' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Reporting holdings...',
          action: 'REPORT_HOLDINGS',
        },
      },
    ],
  ],
};

/**
 * WITHDRAW_TO_TREASURY Action
 * 
 * Explicitly withdraw profits to treasury wallet (or funding wallet if treasury not enabled).
 * This is a SAFE, EXPLICIT action that:
 * - Only triggers from specific phrases ("withdraw to treasury", "send profits to treasury")
 * - Respects treasury configuration and log-only mode
 * - REJECTS any custom destination overrides (DESTINATION_NOT_ALLOWED)
 * - Always leaves configured reserve in pump wallet
 */
import { withdrawToTreasury, checkSweepTrigger } from '../services/treasuryService.ts';
import { getEnv } from '../env.ts';
import { 
  isTreasuryMode, 
  isTreasuryLogOnly, 
  getWithdrawalDestination,
  checkWithdrawalReadiness,
  getWithdrawalReadinessReport,
  ErrorCodes,
  GuardrailError 
} from '../services/operatorGuardrails.ts';

export const withdrawToTreasuryAction: Action = {
  name: 'WITHDRAW_TO_TREASURY',
  similes: ['TREASURY_WITHDRAW', 'SEND_TO_TREASURY', 'TREASURY_SWEEP'],
  description: 'Withdraw profits from pump wallet to treasury (if enabled) or funding wallet. Respects reserve settings and treasury configuration.',
  
  suppressInitialMessage: true,
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Only trigger on explicit treasury-related phrases
    // Avoid triggering on general "withdraw" which is handled by WITHDRAW_FROM_PUMP_WALLET
    return /\b(withdraw.*treasury|send.*treasury|treasury.*withdraw|profits.*treasury|sweep.*treasury)\b/.test(text);
  },
  
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
      }
    }

    if (!callback) {
      return { text: 'No callback provided', success: false };
    }

    try {
      const env = getEnv();
      const text = String(message.content?.text ?? '').toLowerCase();
      
      // Check for custom destination attempts - REJECT
      const customDestMatch = text.match(/to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (customDestMatch) {
        await callback({
          text: `❌ **Custom destinations not allowed**\n\n` +
            `Treasury withdrawals can only go to the configured treasury wallet.\n` +
            `Error code: DESTINATION_NOT_ALLOWED`,
          content: { 
            success: false, 
            error_code: ErrorCodes.DESTINATION_NOT_ALLOWED,
            error: 'Custom destination addresses are not permitted for treasury operations',
          },
        });
        return { text: 'Destination not allowed', success: false };
      }
      
      // Check withdrawal readiness with full details
      const readiness = checkWithdrawalReadiness();
      if (!readiness.ready) {
        const missingKeysStr = readiness.missingKeys.length > 0 
          ? `\nMissing: ${readiness.missingKeys.join(', ')}`
          : '';
        await callback({
          text: `❌ **Withdrawal not supported**\n\n` +
            `${readiness.reason}${missingKeysStr}\n\n` +
            `Mode: ${readiness.mode}\n` +
            `Error code: WITHDRAW_NOT_SUPPORTED`,
          content: {
            success: false,
            error_code: ErrorCodes.WITHDRAW_NOT_SUPPORTED,
            error: readiness.reason,
            mode: readiness.mode,
            missingKeys: readiness.missingKeys,
          },
        });
        return { text: 'Withdrawal not supported', success: false };
      }
      
      // Extract optional amount
      const amountMatch = text.match(/(\d+\.?\d*)\s*sol/);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : undefined;
      
      // Determine destination info for display
      const { type: destinationType } = getWithdrawalDestination();
      const destinationLabel = destinationType === 'treasury' 
        ? `Treasury (${env.TREASURY_ADDRESS?.slice(0, 8)}...)`
        : 'Funding Wallet';
      
      // Check what's available first
      const sweepCheck = await checkSweepTrigger();
      
      if (sweepCheck.withdrawableAmount <= 0 && !amount) {
        await callback({
          text: `💰 **Nothing to withdraw**\n\n` +
            `Current pump wallet balance: ${sweepCheck.currentBalance.toFixed(4)} SOL\n` +
            `Reserve: ${env.TREASURY_MIN_RESERVE_SOL} SOL\n\n` +
            `No withdrawable amount after reserve.`,
          content: { 
            success: true, 
            withdrawn: 0,
            currentBalance: sweepCheck.currentBalance,
          },
        });
        return { text: 'Nothing to withdraw', success: true };
      }
      
      // Execute withdrawal
      const result = await withdrawToTreasury(amount, {
        leaveReserve: env.TREASURY_MIN_RESERVE_SOL,
      });
      
      if (result.logOnly) {
        await callback({
          text: `📝 **[LOG ONLY] Treasury Withdrawal Preview**\n\n` +
            `Would withdraw: **${result.withdrawn.toFixed(4)} SOL**\n` +
            `Destination: ${destinationLabel}\n` +
            `Reserve: ${env.TREASURY_MIN_RESERVE_SOL} SOL\n\n` +
            `⚠️ TREASURY_LOG_ONLY=true - no transaction executed.\n` +
            `Set TREASURY_LOG_ONLY=false to enable actual transfers.`,
          content: {
            success: true,
            log_only: true,
            would_withdraw: result.withdrawn,
            destination: result.destination,
            destination_type: result.destinationType,
          },
        });
        return { text: 'Log only preview', success: true };
      }
      
      await callback({
        text: `✅ **Withdrew ${result.withdrawn.toFixed(4)} SOL to ${destinationLabel}**\n\n` +
          `Transaction: \`${result.signature}\`\n` +
          `New pump wallet balance: ${result.newPumpBalance?.toFixed(4)} SOL\n\n` +
          `💰 Profits sent to ${destinationType}!`,
        content: {
          success: true,
          signature: result.signature,
          withdrawn: result.withdrawn,
          destination: result.destination,
          destination_type: result.destinationType,
          new_pump_balance: result.newPumpBalance,
        },
      });
      
      return { text: 'Treasury withdrawal successful', success: true };
      
    } catch (error) {
      const err = error as Error;
      const isGuardrailError = err instanceof GuardrailError;
      
      await callback({
        text: `❌ **Treasury withdrawal failed**\n\n` +
          `${err.message}\n` +
          (isGuardrailError ? `\nError code: ${(error as GuardrailError).code}` : ''),
        content: {
          success: false,
          error: err.message,
          error_code: isGuardrailError ? (error as GuardrailError).code : 'UNKNOWN_ERROR',
        },
      });
      
      return { text: 'Treasury withdrawal failed', success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'withdraw to treasury' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Withdrawing profits to treasury...',
          action: 'WITHDRAW_TO_TREASURY',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'send profits to treasury' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Sending profits to treasury wallet...',
          action: 'WITHDRAW_TO_TREASURY',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'sweep 0.5 sol to treasury' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Sweeping 0.5 SOL to treasury...',
          action: 'WITHDRAW_TO_TREASURY',
        },
      },
    ],
  ],
};

/**
 * CHECK_TREASURY_STATUS Action
 * 
 * Check treasury configuration and withdrawal readiness status
 */
export const checkTreasuryStatusAction: Action = {
  name: 'CHECK_TREASURY_STATUS',
  similes: ['TREASURY_STATUS', 'TREASURY_CONFIG', 'TREASURY_INFO'],
  description: 'Check treasury wallet configuration, enabled status, and withdrawal readiness',
  
  suppressInitialMessage: true,
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /\b(treasury\s*status|treasury\s*config|check\s*treasury|treasury\s*info)\b/.test(text);
  },
  
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!callback) {
      return { text: 'No callback', success: false };
    }
    
    try {
      const env = getEnv();
      const readiness = checkWithdrawalReadiness();
      const sweepCheck = await checkSweepTrigger();
      
      let statusText = `🏦 **Treasury Status**\n\n`;
      
      // Treasury configuration
      statusText += `**Configuration:**\n`;
      statusText += `• Treasury Enabled: ${env.treasuryEnabled ? '✅ Yes' : '❌ No'}\n`;
      statusText += `• Log Only Mode: ${env.treasuryLogOnly ? '⚠️ Yes (preview only)' : '✅ No (live transfers)'}\n`;
      
      if (env.treasuryEnabled && env.TREASURY_ADDRESS) {
        statusText += `• Treasury Address: \`${env.TREASURY_ADDRESS.slice(0, 8)}...${env.TREASURY_ADDRESS.slice(-4)}\`\n`;
      }
      
      statusText += `• Min Reserve: ${env.TREASURY_MIN_RESERVE_SOL} SOL\n`;
      statusText += `\n`;
      
      // Withdrawal readiness
      statusText += `**Withdrawal Readiness:**\n`;
      statusText += `• Ready: ${readiness.ready ? '✅ Yes' : '❌ No'}\n`;
      statusText += `• Mode: ${readiness.mode}\n`;
      if (!readiness.ready && readiness.reason) {
        statusText += `• Reason: ${readiness.reason}\n`;
      }
      if (readiness.missingKeys && readiness.missingKeys.length > 0) {
        statusText += `• Missing Keys: ${readiness.missingKeys.join(', ')}\n`;
      }
      statusText += `\n`;
      
      // Current balances
      statusText += `**Current State:**\n`;
      statusText += `• Pump Wallet Balance: ${sweepCheck.currentBalance.toFixed(4)} SOL\n`;
      statusText += `• Withdrawable Amount: ${sweepCheck.withdrawableAmount.toFixed(4)} SOL\n`;
      statusText += `• Sweep Threshold Met: ${sweepCheck.shouldSweep ? '✅ Yes' : '❌ No'}\n`;
      
      // Auto-withdraw config
      if (env.autoWithdrawEnabled) {
        statusText += `\n**Auto-Withdraw:**\n`;
        statusText += `• Enabled: ✅ Yes\n`;
        statusText += `• Min Balance Threshold: ${env.WITHDRAW_MIN_SOL} SOL\n`;
        statusText += `• Keep in Wallet: ${env.WITHDRAW_KEEP_SOL} SOL\n`;
        statusText += `• Daily Cap: ${env.WITHDRAW_MAX_SOL_PER_DAY} SOL\n`;
      }
      
      await callback({
        text: statusText,
        content: {
          success: true,
          treasury: {
            enabled: env.treasuryEnabled,
            log_only: env.treasuryLogOnly,
            address: env.TREASURY_ADDRESS,
            min_reserve: env.TREASURY_MIN_RESERVE_SOL,
          },
          readiness: {
            ready: readiness.ready,
            mode: readiness.mode,
            reason: readiness.reason,
            missingKeys: readiness.missingKeys,
          },
          current_state: {
            pump_balance: sweepCheck.currentBalance,
            withdrawable: sweepCheck.withdrawableAmount,
            should_sweep: sweepCheck.shouldSweep,
          },
        },
      });
      
      return { text: 'Treasury status checked', success: true };
      
    } catch (error: any) {
      await callback({
        text: `❌ Failed to check treasury status: ${error.message}`,
        content: { success: false, error: error.message },
      });
      return { text: 'Status check failed', success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'check treasury status' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Checking treasury configuration...',
          action: 'CHECK_TREASURY_STATUS',
        },
      },
    ],
  ],
};