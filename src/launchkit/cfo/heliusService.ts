/**
 * Helius On-Chain Analytics Service
 *
 * Helius provides enhanced Solana APIs that make raw chain data useful:
 *  - parseTransaction: turns a raw tx signature into structured events
 *    (SPL transfers, swaps, NFT sales, DeFi deposits — not just bytes)
 *  - getTokenHolders: who holds a token and in what concentration
 *  - getAssetsByOwner: all NFTs/tokens a wallet holds (DAS API)
 *  - Webhooks: push notifications when wallet activity occurs
 *
 * CFO use cases:
 *  1. Parse every buy/sell transaction for accurate cost-basis accounting
 *  2. Monitor Nova's treasury wallet for incoming transfers
 *  3. Track whale accumulation of tokens Scout has flagged as interesting
 *  4. Verify Jito staking / Kamino deposit confirmations with rich context
 *
 * API key: CFO_HELIUS_API_KEY (free tier: 1M credits/month)
 * Get key: https://dev.helius.xyz
 *
 * RPC with enhanced APIs: https://mainnet.helius-rpc.com/?api-key=<KEY>
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

function heliusBaseUrl(): string {
  const key = getCFOEnv().heliusApiKey;
  if (!key) throw new Error('[Helius] CFO_HELIUS_API_KEY not set');
  return `https://api.helius.xyz/v0`;
}

function heliusRpcUrl(): string {
  const key = getCFOEnv().heliusApiKey;
  if (!key) throw new Error('[Helius] CFO_HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

// ============================================================================
// Types
// ============================================================================

export interface ParsedTransaction {
  signature: string;
  timestamp: number;
  type: string;           // SWAP, TRANSFER, STAKE, DEPOSIT, WITHDRAW, etc.
  fee: number;            // lamports
  feePayer: string;
  source: string;         // protocol that originated the tx
  tokenTransfers: Array<{
    fromAddress: string;
    toAddress: string;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers: Array<{
    fromAddress: string;
    toAddress: string;
    amount: number;       // lamports
  }>;
  description: string;    // human-readable summary
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
      userAccount: string;
    }>;
  }>;
}

export interface TokenHolder {
  address: string;
  amount: number;
  percentage: number;
}

export interface WalletWebhook {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
}

// ============================================================================
// Transaction parsing
// ============================================================================

/**
 * Parse one or more transaction signatures into rich structured events.
 * Returns null for signatures that can't be parsed.
 */
export async function parseTransactions(signatures: string[]): Promise<ParsedTransaction[]> {
  if (!signatures.length) return [];

  try {
    const env = getCFOEnv();
    const resp = await fetch(
      `${heliusBaseUrl()}/transactions/?api-key=${env.heliusApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: signatures }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      logger.warn(`[Helius] parseTransactions failed (${resp.status}): ${await resp.text()}`);
      return [];
    }

    const data = await resp.json() as any[];
    return data.map<ParsedTransaction>((tx) => ({
      signature: tx.signature,
      timestamp: tx.timestamp * 1000,
      type: tx.type ?? 'UNKNOWN',
      fee: tx.fee ?? 0,
      feePayer: tx.feePayer ?? '',
      source: tx.source ?? 'UNKNOWN',
      tokenTransfers: tx.tokenTransfers ?? [],
      nativeTransfers: tx.nativeTransfers ?? [],
      description: tx.description ?? '',
      accountData: tx.accountData ?? [],
    }));
  } catch (err) {
    logger.error('[Helius] parseTransactions error:', err);
    return [];
  }
}

/**
 * Parse a single transaction — convenience wrapper.
 */
export async function parseTransaction(signature: string): Promise<ParsedTransaction | null> {
  const results = await parseTransactions([signature]);
  return results[0] ?? null;
}

// ============================================================================
// Wallet activity monitoring
// ============================================================================

/**
 * Get recent transactions for a wallet address with rich parsing.
 * Useful for auditing CFO wallet activity.
 */
export async function getWalletTransactions(
  address: string,
  limit = 20,
  type?: string,
): Promise<ParsedTransaction[]> {
  try {
    const env = getCFOEnv();
    const params = new URLSearchParams({
      'api-key': env.heliusApiKey!,
      limit: limit.toString(),
    });
    if (type) params.set('type', type);

    const resp = await fetch(
      `${heliusBaseUrl()}/addresses/${address}/transactions?${params}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!resp.ok) return [];
    const data = await resp.json() as any[];

    return data.map<ParsedTransaction>((tx) => ({
      signature: tx.signature,
      timestamp: tx.timestamp * 1000,
      type: tx.type ?? 'UNKNOWN',
      fee: tx.fee ?? 0,
      feePayer: tx.feePayer ?? '',
      source: tx.source ?? 'UNKNOWN',
      tokenTransfers: tx.tokenTransfers ?? [],
      nativeTransfers: tx.nativeTransfers ?? [],
      description: tx.description ?? '',
      accountData: tx.accountData ?? [],
    }));
  } catch (err) {
    logger.warn(`[Helius] getWalletTransactions(${address}) error:`, err);
    return [];
  }
}

// ============================================================================
// Token analytics
// ============================================================================

/**
 * Get top token holders for a mint address.
 * Useful for assessing concentration risk before Scout-recommended entries.
 */
export async function getTopHolders(mint: string, limit = 20): Promise<TokenHolder[]> {
  try {
    const env = getCFOEnv();
    const resp = await fetch(
      `${heliusBaseUrl()}/token-metadata?api-key=${env.heliusApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [mint], includeOffChain: false }),
        signal: AbortSignal.timeout(8000),
      },
    );

    // Helius doesn't expose holders via token-metadata — use RPC large accounts
    const rpcResp = await fetch(heliusRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint, { commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!rpcResp.ok) return [];
    const rpcData = await rpcResp.json() as any;
    const accounts = (rpcData.result?.value ?? []) as any[];

    const totalSupply = accounts.reduce((s: number, a: any) => s + Number(a.uiAmount ?? 0), 0) || 1;

    return accounts.slice(0, limit).map((acc) => ({
      address: acc.address,
      amount: Number(acc.uiAmount ?? 0),
      percentage: (Number(acc.uiAmount ?? 0) / totalSupply) * 100,
    }));
  } catch (err) {
    logger.warn(`[Helius] getTopHolders(${mint}) error:`, err);
    return [];
  }
}

/**
 * Check if a token has dangerous holder concentration (>30% in top wallet).
 * Used by Guardian/CFO before entering a meme token position.
 */
export async function checkConcentrationRisk(mint: string): Promise<{
  risky: boolean;
  topHolderPct: number;
  top5HolderPct: number;
  warning?: string;
}> {
  const holders = await getTopHolders(mint, 10);
  if (!holders.length) return { risky: false, topHolderPct: 0, top5HolderPct: 0 };

  const topHolderPct = holders[0]?.percentage ?? 0;
  const top5HolderPct = holders.slice(0, 5).reduce((s, h) => s + h.percentage, 0);

  const risky = topHolderPct > 30 || top5HolderPct > 60;
  const warning = risky
    ? `High concentration: top holder ${topHolderPct.toFixed(1)}%, top 5: ${top5HolderPct.toFixed(1)}%`
    : undefined;

  return { risky, topHolderPct, top5HolderPct, warning };
}

// ============================================================================
// Webhooks (optional — needs public URL)
// ============================================================================

/**
 * Register a Helius webhook to receive push notifications when the
 * given wallet addresses have activity.
 *
 * Requires CFO_X402_BASE_URL to be publicly accessible (Railway URL works).
 * Webhook will POST to: {baseUrl}/helius/webhook
 */
export async function registerWebhook(
  walletAddresses: string[],
  webhookPath = '/helius/webhook',
): Promise<string | null> {
  try {
    const env = getCFOEnv();
    if (!env.heliusApiKey) return null;

    const webhookUrl = `${env.x402BaseUrl}${webhookPath}`;

    const resp = await fetch(
      `${heliusBaseUrl()}/webhooks?api-key=${env.heliusApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ['TRANSFER', 'SWAP', 'STAKE'],
          accountAddresses: walletAddresses,
          webhookType: 'enhanced',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      logger.warn(`[Helius] registerWebhook failed (${resp.status})`);
      return null;
    }

    const data = await resp.json() as { webhookID: string };
    logger.info(`[Helius] Webhook registered: ${data.webhookID} → ${webhookUrl}`);
    return data.webhookID;
  } catch (err) {
    logger.warn('[Helius] registerWebhook error:', err);
    return null;
  }
}

/**
 * Express route handler for incoming Helius webhook notifications.
 * Register at POST /helius/webhook in launchkit server.
 */
export function createWebhookHandler(
  onTransaction: (tx: ParsedTransaction) => Promise<void>,
) {
  return async (req: any, res: any): Promise<void> => {
    try {
      const txArray = Array.isArray(req.body) ? req.body : [req.body];

      for (const raw of txArray) {
        const tx: ParsedTransaction = {
          signature: raw.signature,
          timestamp: (raw.timestamp ?? 0) * 1000,
          type: raw.type ?? 'UNKNOWN',
          fee: raw.fee ?? 0,
          feePayer: raw.feePayer ?? '',
          source: raw.source ?? 'UNKNOWN',
          tokenTransfers: raw.tokenTransfers ?? [],
          nativeTransfers: raw.nativeTransfers ?? [],
          description: raw.description ?? '',
          accountData: raw.accountData ?? [],
        };

        await onTransaction(tx).catch((err) =>
          logger.error('[Helius] webhook handler error:', err),
        );
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error('[Helius] webhook route error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  };
}

// ============================================================================
// Enriched balance fetch (uses Helius RPC for faster, richer responses)
// ============================================================================

export async function getEnrichedBalance(walletAddress: string): Promise<{
  solBalance: number;
  tokens: Array<{ mint: string; amount: number; symbol?: string; logoURI?: string }>;
}> {
  try {
    const resp = await fetch(heliusRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          page: 1, limit: 100,
          displayOptions: { showFungible: true },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return { solBalance: 0, tokens: [] };

    const data = await resp.json() as any;
    const items = data.result?.items ?? [];

    const tokens = items
      .filter((item: any) => item.interface === 'FungibleToken')
      .map((item: any) => ({
        mint: item.id,
        amount: Number(item.token_info?.balance ?? 0) / Math.pow(10, item.token_info?.decimals ?? 6),
        symbol: item.content?.metadata?.symbol,
        logoURI: item.content?.links?.image,
      }))
      .filter((t: any) => t.amount > 0);

    // Get SOL balance separately
    const solResp = await fetch(heliusRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getBalance',
        params: [walletAddress, { commitment: 'confirmed' }],
      }),
    });
    const solData = await solResp.json() as any;
    const solBalance = (solData.result?.value ?? 0) / 1e9;

    return { solBalance, tokens };
  } catch (err) {
    logger.warn(`[Helius] getEnrichedBalance(${walletAddress}) error:`, err);
    return { solBalance: 0, tokens: [] };
  }
}

export { heliusRpcUrl };
