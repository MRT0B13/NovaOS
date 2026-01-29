import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';

/**
 * Funding Wallet Service
 * 
 * This module handles SOL transfers from the agent's funding wallet to the pump wallet.
 * 
 * IMPORTANT: Phantom Wallet Integration
 * =====================================
 * 
 * We DO NOT use the Phantom Connect SDK here because:
 * - Phantom SDK is for user-facing apps that require manual transaction approval
 * - LaunchKit is an autonomous agent that needs to sign transactions automatically
 * 
 * Instead, we use the wallet's private key directly with @solana/web3.js:
 * - User exports their Phantom wallet's private key
 * - Agent uses that keypair programmatically to sign transactions
 * - No user interaction required - fully autonomous operation
 * 
 * This is the correct approach for autonomous agents/bots that need to:
 * - Execute transactions while user is offline
 * - Respond immediately without waiting for user approval
 * - Perform automated trading, launches, or other operations
 * 
 * The user's Phantom wallet becomes the agent's funding source.
 * See PHANTOM_INTEGRATION.md for complete explanation.
 */

/**
 * Transfers SOL from agent's funding wallet to pump wallet
 */
export async function depositToPumpWallet(amountSol: number): Promise<{ signature: string; balance: number }> {
  const env = getEnv();
  
  if (!env.AGENT_FUNDING_WALLET_SECRET) {
    throw new Error('AGENT_FUNDING_WALLET_SECRET not configured - agent needs a wallet to fund pump wallet');
  }
  
  if (!env.PUMP_PORTAL_WALLET_ADDRESS) {
    throw new Error('PUMP_PORTAL_WALLET_ADDRESS not configured');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load funding wallet keypair
  const fundingKeypair = Keypair.fromSecretKey(bs58.decode(env.AGENT_FUNDING_WALLET_SECRET));
  const pumpWalletPubkey = new PublicKey(env.PUMP_PORTAL_WALLET_ADDRESS);
  
  logger.info(`[FundingWallet] Agent wallet: ${fundingKeypair.publicKey.toBase58()}`);
  logger.info(`[FundingWallet] Pump wallet: ${pumpWalletPubkey.toBase58()}`);
  logger.info(`[FundingWallet] Depositing ${amountSol} SOL...`);
  
  // Check funding wallet balance
  const fundingBalance = await connection.getBalance(fundingKeypair.publicKey);
  const fundingBalanceSol = fundingBalance / LAMPORTS_PER_SOL;
  
  if (fundingBalanceSol < amountSol + 0.01) { // +0.01 for tx fees
    throw new Error(
      `Insufficient balance in funding wallet. ` +
      `Has ${fundingBalanceSol.toFixed(4)} SOL, needs ${(amountSol + 0.01).toFixed(4)} SOL`
    );
  }
  
  // Create transfer transaction
  // Use Math.floor to ensure lamports is an integer (JS floating point can cause issues)
  const lamportsToSend = Math.floor(amountSol * LAMPORTS_PER_SOL);
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fundingKeypair.publicKey,
      toPubkey: pumpWalletPubkey,
      lamports: lamportsToSend,
    })
  );
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fundingKeypair.publicKey;
  
  // Sign transaction
  transaction.sign(fundingKeypair);
  
  // Send transaction (without confirmation - we'll poll instead)
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  logger.info(`[FundingWallet] Transaction sent: ${signature}`);
  
  // Poll for confirmation using getSignatureStatuses (avoids WebSocket issues)
  // Per Solana docs: "Use getSignatureStatuses to ensure a transaction is processed and confirmed"
  const maxRetries = 30;
  let confirmed = false;
  
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between polls
    
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        confirmed = true;
        logger.info(`[FundingWallet] Transaction confirmed (status: ${status.confirmationStatus})`);
        break;
      }
    }
    
    // Check if blockhash has expired
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired - blockhash no longer valid');
    }
    
    logger.info(`[FundingWallet] Waiting for confirmation... (attempt ${i + 1}/${maxRetries})`);
  }
  
  if (!confirmed) {
    throw new Error('Transaction confirmation timeout - please check the transaction on explorer');
  }
  
  // Get new pump wallet balance
  const pumpBalance = await connection.getBalance(pumpWalletPubkey);
  const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;
  
  logger.info(`[FundingWallet] ✅ Deposited ${amountSol} SOL`);
  logger.info(`[FundingWallet] Signature: ${signature}`);
  logger.info(`[FundingWallet] Pump wallet balance: ${pumpBalanceSol.toFixed(4)} SOL`);
  
  return {
    signature,
    balance: pumpBalanceSol,
  };
}

/**
 * Checks pump wallet balance
 */
export async function getPumpWalletBalance(): Promise<number> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_ADDRESS) {
    throw new Error('PUMP_PORTAL_WALLET_ADDRESS not configured');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const pumpWalletPubkey = new PublicKey(env.PUMP_PORTAL_WALLET_ADDRESS);
  
  const balance = await connection.getBalance(pumpWalletPubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Checks agent's funding wallet balance
 */
export async function getFundingWalletBalance(): Promise<{ address: string; balance: number }> {
  const env = getEnv();
  
  if (!env.AGENT_FUNDING_WALLET_SECRET) {
    throw new Error('AGENT_FUNDING_WALLET_SECRET not configured');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const fundingKeypair = Keypair.fromSecretKey(bs58.decode(env.AGENT_FUNDING_WALLET_SECRET));
  
  const balance = await connection.getBalance(fundingKeypair.publicKey);
  
  return {
    address: fundingKeypair.publicKey.toBase58(),
    balance: balance / LAMPORTS_PER_SOL,
  };
}

/**
 * Withdraws SOL profits from pump wallet back to funding wallet (Phantom)
 * Leaves a small amount (reserve) in pump wallet for future launches
 */
export async function withdrawFromPumpWallet(
  amountSol?: number,
  options?: { leaveReserve?: number }
): Promise<{ signature: string; withdrawn: number; newPumpBalance: number; newFundingBalance: number }> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    throw new Error('PUMP_PORTAL_WALLET_SECRET not configured - cannot withdraw from pump wallet');
  }
  
  if (!env.AGENT_FUNDING_WALLET_SECRET) {
    throw new Error('AGENT_FUNDING_WALLET_SECRET not configured - no destination for withdrawal');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load both keypairs
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  const fundingKeypair = Keypair.fromSecretKey(bs58.decode(env.AGENT_FUNDING_WALLET_SECRET));
  
  logger.info(`[Withdrawal] Pump wallet: ${pumpKeypair.publicKey.toBase58()}`);
  logger.info(`[Withdrawal] Funding wallet: ${fundingKeypair.publicKey.toBase58()}`);
  
  // Check pump wallet balance
  const pumpBalance = await connection.getBalance(pumpKeypair.publicKey);
  const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;
  
  logger.info(`[Withdrawal] Current pump wallet balance: ${pumpBalanceSol.toFixed(4)} SOL`);
  
  // Determine how much to withdraw
  const txFee = 0.001; // SOL needed for transaction fee
  const leaveReserve = options?.leaveReserve ?? 0; // Default: no reserve, withdraw everything
  
  let withdrawAmount: number;
  if (amountSol !== undefined) {
    // Specific amount requested - only check they have enough for amount + tx fee
    const maxAvailable = pumpBalanceSol - txFee;
    if (amountSol > maxAvailable) {
      throw new Error(
        `Cannot withdraw ${amountSol} SOL. ` +
        `Available: ${maxAvailable.toFixed(4)} SOL ` +
        `(balance: ${pumpBalanceSol.toFixed(4)} SOL - ${txFee} SOL tx fee)`
      );
    }
    withdrawAmount = amountSol;
  } else {
    // Withdraw all except reserve (applies only when no specific amount given)
    const maxWithdrawable = Math.max(0, pumpBalanceSol - leaveReserve - txFee);
    if (maxWithdrawable <= 0) {
      throw new Error(
        `Nothing to withdraw. Current balance: ${pumpBalanceSol.toFixed(4)} SOL, ` +
        `Reserve: ${leaveReserve} SOL, Fees: ${txFee} SOL`
      );
    }
    withdrawAmount = maxWithdrawable;
  }
  
  if (withdrawAmount <= 0) {
    throw new Error(`Invalid withdraw amount: ${withdrawAmount}`);
  }
  
  logger.info(`[Withdrawal] Withdrawing ${withdrawAmount.toFixed(4)} SOL (leaving ${leaveReserve} SOL reserve)`);
  
  // Create transfer transaction from pump wallet → funding wallet
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: pumpKeypair.publicKey,
      toPubkey: fundingKeypair.publicKey,
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
  
  logger.info(`[Withdrawal] Transaction sent: ${signature}`);
  
  // Poll for confirmation using getSignatureStatuses (avoids WebSocket issues)
  const maxRetries = 30;
  let confirmed = false;
  
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        confirmed = true;
        logger.info(`[Withdrawal] Transaction confirmed (status: ${status.confirmationStatus})`);
        break;
      }
    }
    
    // Check if blockhash has expired
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired - blockhash no longer valid');
    }
    
    logger.info(`[Withdrawal] Waiting for confirmation... (attempt ${i + 1}/${maxRetries})`);
  }
  
  if (!confirmed) {
    throw new Error('Transaction confirmation timeout - please check the transaction on explorer');
  }
  
  // Get new balances
  const newPumpBalance = (await connection.getBalance(pumpKeypair.publicKey)) / LAMPORTS_PER_SOL;
  const newFundingBalance = (await connection.getBalance(fundingKeypair.publicKey)) / LAMPORTS_PER_SOL;
  
  logger.info(`[Withdrawal] ✅ Withdrew ${withdrawAmount.toFixed(4)} SOL`);
  logger.info(`[Withdrawal] Signature: ${signature}`);
  logger.info(`[Withdrawal] New pump wallet balance: ${newPumpBalance.toFixed(4)} SOL`);
  logger.info(`[Withdrawal] New funding wallet balance: ${newFundingBalance.toFixed(4)} SOL`);
  
  return {
    signature,
    withdrawn: withdrawAmount,
    newPumpBalance,
    newFundingBalance,
  };
}
/**
 * Sells tokens from the pump wallet using PumpPortal API
 * This allows the agent to sell tokens it has launched or bought
 * 
 * @param mintAddress - The token's mint address (contract address)
 * @param amountTokens - Amount of tokens to sell (or 'all' to sell entire balance)
 * @param options - Optional slippage and priority fee settings
 */
export async function sellToken(
  mintAddress: string,
  amountTokens: number | 'all',
  options?: { slippage?: number; priorityFee?: number }
): Promise<{ signature: string; solReceived: number }> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    throw new Error('PUMP_PORTAL_WALLET_SECRET not configured - cannot sell tokens');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load pump wallet keypair
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  
  logger.info(`[SellToken] Pump wallet: ${pumpKeypair.publicKey.toBase58()}`);
  logger.info(`[SellToken] Token mint: ${mintAddress}`);
  
  // Get token balance if selling all
  let sellAmount: number;
  if (amountTokens === 'all') {
    // Fetch token account balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pumpKeypair.publicKey,
      { mint: new PublicKey(mintAddress) }
    );
    
    if (!tokenAccounts.value.length) {
      throw new Error(`No token balance found for mint ${mintAddress}`);
    }
    
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    sellAmount = parseFloat(balance.uiAmount || '0');
    
    if (sellAmount <= 0) {
      throw new Error(`Token balance is 0 for mint ${mintAddress}`);
    }
    
    logger.info(`[SellToken] Selling entire balance: ${sellAmount} tokens`);
  } else {
    sellAmount = amountTokens;
  }
  
  const slippage = options?.slippage ?? 10; // Default 10% slippage
  const priorityFee = options?.priorityFee ?? 100000; // Default priority fee
  
  // Get PumpPortal API key from secrets store or env
  // Note: This requires the pumpLauncher to have created a wallet
  const apiKey = env.PUMP_PORTAL_API_KEY;
  if (!apiKey) {
    throw new Error('PUMP_PORTAL_API_KEY not configured - cannot sell tokens. Make sure you have launched at least one token first.');
  }
  
  // Call PumpPortal sell API
  const sellBody = {
    action: 'sell',
    mint: mintAddress,
    amount: sellAmount,
    denominatedInSol: 'false', // Amount is in tokens, not SOL
    slippage,
    priorityFee,
    pool: 'pump',
  };
  
  logger.info(`[SellToken] Calling PumpPortal sell API...`);
  
  const res = await fetch(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sellBody),
  });
  
  let resJson: any;
  try {
    resJson = await res.json();
  } catch {
    resJson = null;
  }
  
  logger.info(`[SellToken] PumpPortal response: ${JSON.stringify(resJson)}`);
  
  if (!res.ok) {
    throw new Error(`Sell failed: ${resJson?.error || resJson?.message || `HTTP ${res.status}`}`);
  }
  
  const signature = resJson?.signature || resJson?.tx || resJson?.txSignature;
  if (!signature) {
    throw new Error('No transaction signature returned from PumpPortal');
  }
  
  // Get SOL received (approximate from response or calculate)
  const solReceived = resJson?.solReceived || resJson?.sol || 0;
  
  logger.info(`[SellToken] ✅ Successfully sold ${sellAmount} tokens`);
  logger.info(`[SellToken] Transaction: ${signature}`);
  logger.info(`[SellToken] SOL received: ~${solReceived} SOL`);
  
  return {
    signature,
    solReceived,
  };
}

/**
 * Get token balances for the pump wallet
 * Returns all SPL tokens held by the pump wallet
 */
export async function getPumpWalletTokens(): Promise<Array<{
  mint: string;
  balance: number;
  symbol?: string;
  name?: string;
}>> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    throw new Error('PUMP_PORTAL_WALLET_SECRET not configured');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  
  logger.info(`[GetTokens] Fetching tokens for: ${pumpKeypair.publicKey.toBase58()}`);
  
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    pumpKeypair.publicKey,
    { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
  );
  
  const tokens = tokenAccounts.value
    .map(account => {
      const info = account.account.data.parsed.info;
      const balance = parseFloat(info.tokenAmount?.uiAmount || '0');
      return {
        mint: info.mint,
        balance,
      };
    })
    .filter(t => t.balance > 0);
  
  logger.info(`[GetTokens] Found ${tokens.length} tokens with balance > 0`);
  
  return tokens;
}

/**
 * Buys tokens using SOL from the pump wallet via PumpPortal API
 * This is for USER-INITIATED buys only - transparent and disclosed
 * 
 * @param mintAddress - The token's mint address to buy
 * @param amountSol - Amount of SOL to spend on the purchase
 * @param options - Optional slippage and priority fee settings
 */
export async function buyToken(
  mintAddress: string,
  amountSol: number,
  options?: { slippage?: number; priorityFee?: number }
): Promise<{ signature: string; tokensReceived: number }> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    throw new Error('PUMP_PORTAL_WALLET_SECRET not configured - cannot buy tokens');
  }
  
  if (!env.PUMP_PORTAL_API_KEY) {
    throw new Error('PUMP_PORTAL_API_KEY not configured - cannot buy tokens');
  }
  
  // Safety limits
  const MAX_BUY_SOL = 0.5; // Max 0.5 SOL per buy for safety
  if (amountSol > MAX_BUY_SOL) {
    throw new Error(`Buy amount exceeds safety limit. Max: ${MAX_BUY_SOL} SOL, Requested: ${amountSol} SOL`);
  }
  
  if (amountSol < 0.001) {
    throw new Error('Buy amount too small. Minimum: 0.001 SOL');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load pump wallet keypair
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  
  logger.info('[BuyToken] Pump wallet: ' + pumpKeypair.publicKey.toBase58());
  logger.info('[BuyToken] Token mint: ' + mintAddress);
  logger.info('[BuyToken] Amount: ' + amountSol + ' SOL');
  
  // Check wallet balance
  const balance = await connection.getBalance(pumpKeypair.publicKey);
  const balanceSol = balance / 1_000_000_000;
  
  if (balanceSol < amountSol + 0.001) { // +0.001 for fees
    throw new Error('Insufficient SOL balance for buy. Balance: ' + balanceSol.toFixed(4) + ' SOL, Required: ' + (amountSol + 0.001).toFixed(4) + ' SOL');
  }
  
  // Call PumpPortal buy API
  const slippage = options?.slippage ?? 10;
  const priorityFee = options?.priorityFee ?? 0.0001;
  
  logger.info('[BuyToken] Calling PumpPortal buy API...');
  
  const response = await fetch('https://pumpportal.fun/api/trade?api-key=' + env.PUMP_PORTAL_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'buy',
      mint: mintAddress,
      amount: amountSol,
      denominatedInSol: 'true',
      slippage: slippage,
      priorityFee: priorityFee,
      pool: 'pump',
    }),
  });
  
  const resJson = await response.json().catch(() => null);
  logger.info('[BuyToken] PumpPortal response: ' + JSON.stringify(resJson));
  
  if (!response.ok) {
    throw new Error('PumpPortal buy failed: ' + (resJson?.error || resJson?.message || response.status));
  }
  
  const signature = resJson?.signature || resJson?.tx || resJson?.txSignature;
  if (!signature) {
    throw new Error('No transaction signature returned from PumpPortal');
  }
  
  // Estimate tokens received (will be approximate)
  const tokensReceived = resJson?.tokensReceived || resJson?.amount || 0;
  
  logger.info('[BuyToken] ✅ Successfully bought tokens');
  logger.info('[BuyToken] Transaction: ' + signature);
  logger.info('[BuyToken] SOL spent: ' + amountSol);
  
  return {
    signature,
    tokensReceived,
  };
}

/**
 * Withdraw SOL from pump wallet to a specific destination address
 * This is a lower-level function used by treasury operations.
 * 
 * IMPORTANT: This function does NOT enforce treasury rules.
 * Use treasuryService.withdrawToTreasury() for treasury-aware withdrawals.
 * 
 * @param destinationAddress - The Solana address to send funds to
 * @param amountSol - Amount to withdraw (undefined = withdraw max available)
 * @param options - Reserve and other settings
 */
export async function withdrawToDestination(
  destinationAddress: string,
  amountSol?: number,
  options?: { leaveReserve?: number }
): Promise<{ 
  signature: string; 
  withdrawn: number; 
  newPumpBalance: number;
  destinationAddress: string;
}> {
  const env = getEnv();
  
  if (!env.PUMP_PORTAL_WALLET_SECRET) {
    throw new Error('PUMP_PORTAL_WALLET_SECRET not configured - cannot withdraw from pump wallet');
  }
  
  // Validate destination address
  const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!base58Pattern.test(destinationAddress)) {
    throw new Error('Invalid destination address - must be a valid Solana public key');
  }
  
  // INVARIANT: Never withdraw to the pump wallet itself
  if (env.PUMP_PORTAL_WALLET_ADDRESS && destinationAddress === env.PUMP_PORTAL_WALLET_ADDRESS) {
    throw new Error('Cannot withdraw to the pump wallet itself');
  }
  
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load pump keypair
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(env.PUMP_PORTAL_WALLET_SECRET));
  const destinationPubkey = new PublicKey(destinationAddress);
  
  logger.info(`[WithdrawToDestination] Pump wallet: ${pumpKeypair.publicKey.toBase58()}`);
  logger.info(`[WithdrawToDestination] Destination: ${destinationAddress}`);
  
  // Check pump wallet balance
  const pumpBalance = await connection.getBalance(pumpKeypair.publicKey);
  const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;
  
  logger.info(`[WithdrawToDestination] Current pump wallet balance: ${pumpBalanceSol.toFixed(4)} SOL`);
  
  // Determine how much to withdraw
  const txFee = 0.001;
  const leaveReserve = options?.leaveReserve ?? 0;
  
  let withdrawAmount: number;
  if (amountSol !== undefined) {
    const maxAvailable = pumpBalanceSol - txFee;
    if (amountSol > maxAvailable) {
      throw new Error(
        `Cannot withdraw ${amountSol} SOL. ` +
        `Available: ${maxAvailable.toFixed(4)} SOL ` +
        `(balance: ${pumpBalanceSol.toFixed(4)} SOL - ${txFee} SOL tx fee)`
      );
    }
    withdrawAmount = amountSol;
  } else {
    const maxWithdrawable = Math.max(0, pumpBalanceSol - leaveReserve - txFee);
    if (maxWithdrawable <= 0) {
      throw new Error(
        `Nothing to withdraw. Current balance: ${pumpBalanceSol.toFixed(4)} SOL, ` +
        `Reserve: ${leaveReserve} SOL, Fees: ${txFee} SOL`
      );
    }
    withdrawAmount = maxWithdrawable;
  }
  
  if (withdrawAmount <= 0) {
    throw new Error(`Invalid withdraw amount: ${withdrawAmount}`);
  }
  
  logger.info(`[WithdrawToDestination] Withdrawing ${withdrawAmount.toFixed(4)} SOL`);
  
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
  
  logger.info(`[WithdrawToDestination] Transaction sent: ${signature}`);
  
  // Poll for confirmation
  const maxRetries = 30;
  let confirmed = false;
  
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        confirmed = true;
        logger.info(`[WithdrawToDestination] Transaction confirmed (status: ${status.confirmationStatus})`);
        break;
      }
    }
    
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired - blockhash no longer valid');
    }
    
    logger.info(`[WithdrawToDestination] Waiting for confirmation... (attempt ${i + 1}/${maxRetries})`);
  }
  
  if (!confirmed) {
    throw new Error('Transaction confirmation timeout - please check the transaction on explorer');
  }
  
  // Get new pump wallet balance
  const newPumpBalance = (await connection.getBalance(pumpKeypair.publicKey)) / LAMPORTS_PER_SOL;
  
  logger.info(`[WithdrawToDestination] ✅ Withdrew ${withdrawAmount.toFixed(4)} SOL`);
  logger.info(`[WithdrawToDestination] Signature: ${signature}`);
  logger.info(`[WithdrawToDestination] New pump wallet balance: ${newPumpBalance.toFixed(4)} SOL`);
  
  return {
    signature,
    withdrawn: withdrawAmount,
    newPumpBalance,
    destinationAddress,
  };
}

/**
 * Get the treasury address if configured and enabled
 * Returns null if treasury is not enabled
 */
export function getTreasuryAddress(): string | null {
  const env = getEnv();
  if (env.treasuryEnabled && env.TREASURY_ADDRESS) {
    return env.TREASURY_ADDRESS;
  }
  return null;
}