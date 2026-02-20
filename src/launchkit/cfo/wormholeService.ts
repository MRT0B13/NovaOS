/**
 * Wormhole / LI.FI Bridge Service
 *
 * Handles cross-chain asset transfers for the CFO agent.
 *
 * Primary: LI.FI SDK — meta-aggregator that routes through Wormhole, Stargate,
 *   Across, deBridge automatically. Chooses cheapest/fastest route.
 *
 * Use cases:
 *  - Move USDC from Solana → Polygon to fund Polymarket
 *  - Move USDC from Polygon → Arbitrum to fund Hyperliquid
 *  - Repatriate profits: Polygon → Solana
 *  - Auto-refill EVM gas wallets from Solana treasury
 *
 * LI.FI docs: https://docs.li.fi/li.fi-api/li.fi-api
 * No API key needed for standard routes (rate limit: 30 req/min free).
 *
 * Wormhole SDK used as fallback if LI.FI has no route for a pair.
 * Wormhole automatic relayer handles fee payment for supported routes.
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Constants
// ============================================================================

const LIFI_API_BASE = 'https://li.quest/v1';

// Chain IDs
const CHAIN_IDS: Record<string, number> = {
  solana:   1151111081099710,  // LI.FI Solana chain ID
  polygon:  137,
  arbitrum: 42161,
  base:     8453,
  ethereum: 1,
};

// Well-known token addresses per chain (used for routing)
const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  polygon: {
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    MATIC: '0x0000000000000000000000000000000000001010',
  },
  arbitrum: {
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',  // USDC.e
    USDC_NATIVE: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    ETH:  '0x0000000000000000000000000000000000000000',
  },
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    SOL:  'So11111111111111111111111111111111111111112',
  },
};

// ============================================================================
// Types
// ============================================================================

export interface BridgeQuote {
  id: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  fromAmount: number;       // human readable
  toAmount: number;         // expected received (after fees + slippage)
  bridgeFeeUsd: number;
  estimatedTimeSeconds: number;
  bridge: string;           // e.g. "wormhole", "stargate", "across"
  tool: string;             // LI.FI routing tool
  rawRoute: unknown;        // full LI.FI route object for execution
}

export interface BridgeResult {
  success: boolean;
  txHash?: string;
  fromChain: string;
  toChain: string;
  fromAmount: number;
  toAmountExpected: number;
  bridge: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  explorerUrl?: string;
  error?: string;
}

// ============================================================================
// LI.FI quote
// ============================================================================

/**
 * Get best bridge route from LI.FI.
 * Returns null if no route available (caller should try fallback or skip).
 */
export async function getBridgeQuote(
  fromChain: string,
  toChain: string,
  fromToken: string,
  toToken: string,
  fromAmountHuman: number,
  fromAddress: string,
  toAddress: string,
): Promise<BridgeQuote | null> {
  try {
    const fromChainId = CHAIN_IDS[fromChain];
    const toChainId = CHAIN_IDS[toChain];
    const fromTokenAddr = TOKEN_ADDRESSES[fromChain]?.[fromToken];
    const toTokenAddr = TOKEN_ADDRESSES[toChain]?.[toToken];

    if (!fromChainId || !toChainId || !fromTokenAddr || !toTokenAddr) {
      logger.warn(`[Bridge] Unknown chain/token: ${fromChain}/${fromToken} → ${toChain}/${toToken}`);
      return null;
    }

    // Determine raw amount (USDC is 6 decimals, SOL/ETH is 18 on EVM)
    const decimals = fromToken === 'USDC' ? 6 : (fromChain === 'solana' ? 9 : 18);
    const fromAmountRaw = Math.floor(fromAmountHuman * 10 ** decimals).toString();

    const params = new URLSearchParams({
      fromChain: fromChainId.toString(),
      toChain: toChainId.toString(),
      fromToken: fromTokenAddr,
      toToken: toTokenAddr,
      fromAmount: fromAmountRaw,
      fromAddress,
      toAddress,
      slippage: '0.005', // 0.5%
    });

    const resp = await fetch(`${LIFI_API_BASE}/quote?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(`[Bridge] LI.FI quote failed (${resp.status}): ${body}`);
      return null;
    }

    const data = await resp.json() as any;
    const toDecimals = toToken === 'USDC' ? 6 : (toChain === 'solana' ? 9 : 18);
    const toAmount = Number(data.estimate?.toAmount ?? 0) / 10 ** toDecimals;
    const gasCostUsd = Number(data.estimate?.gasCosts?.[0]?.amountUSD ?? 0);
    const feeCostUsd = Number(data.estimate?.feeCosts?.[0]?.amountUSD ?? 0);

    return {
      id: data.id ?? `lifi-${Date.now()}`,
      fromChain,
      toChain,
      fromToken,
      toToken,
      fromAmount: fromAmountHuman,
      toAmount,
      bridgeFeeUsd: gasCostUsd + feeCostUsd,
      estimatedTimeSeconds: Number(data.estimate?.executionDuration ?? 120),
      bridge: data.tool ?? 'unknown',
      tool: data.tool ?? 'unknown',
      rawRoute: data,
    };
  } catch (err) {
    logger.error('[Bridge] getBridgeQuote error:', err);
    return null;
  }
}

// ============================================================================
// EVM → EVM bridge execution (via LI.FI SDK)
// ============================================================================

/**
 * Execute an EVM→EVM bridge using the LI.FI SDK.
 * The SDK handles signing, approval, and transaction submission.
 */
async function executeLifiEvmRoute(quote: BridgeQuote, fromPrivateKey: string): Promise<BridgeResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(
      `[Bridge] DRY RUN — would bridge ${quote.fromAmount} ${quote.fromToken} ` +
      `${quote.fromChain} → ${quote.toChain} via ${quote.bridge} ` +
      `(fee: $${quote.bridgeFeeUsd.toFixed(3)}, ~${quote.estimatedTimeSeconds}s)`,
    );
    return {
      success: true,
      txHash: `dry-${Date.now()}`,
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      fromAmount: quote.fromAmount,
      toAmountExpected: quote.toAmount,
      bridge: quote.bridge,
      status: 'DONE',
    };
  }

  try {
    const lifi = await import('@lifi/sdk');
    const ethers = await import('ethers');

    const provider = new ethers.JsonRpcProvider(
      quote.fromChain === 'polygon'
        ? getCFOEnv().polygonRpcUrl
        : getCFOEnv().arbitrumRpcUrl,
    );
    const signer = new ethers.Wallet(fromPrivateKey, provider);

    lifi.createConfig({ integrator: 'nova-cfo' });

    const execution = await lifi.executeRoute(quote.rawRoute as any, {
      updateRouteHook: (updatedRoute: any) => {
        const step = updatedRoute.steps?.[0];
        logger.debug(`[Bridge] Step status: ${step?.execution?.status}`);
      },
    });

    const lastStep = (execution as any).steps?.at(-1);
    const txHash = lastStep?.execution?.process?.at(-1)?.txHash;

    logger.info(`[Bridge] Bridge tx submitted: ${txHash}`);

    return {
      success: true,
      txHash,
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      fromAmount: quote.fromAmount,
      toAmountExpected: quote.toAmount,
      bridge: quote.bridge,
      status: 'PENDING',
      explorerUrl: txHash ? `https://li.fi/explorer/${txHash}` : undefined,
    };
  } catch (err) {
    return {
      success: false,
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      fromAmount: quote.fromAmount,
      toAmountExpected: quote.toAmount,
      bridge: quote.bridge,
      status: 'FAILED',
      error: (err as Error).message,
    };
  }
}

// ============================================================================
// Public bridge interface
// ============================================================================

/**
 * Bridge USDC from Solana → Polygon (to fund Polymarket).
 * Uses Wormhole Circle CCTP route (cheapest, fastest, ~30s).
 */
export async function bridgeSolanaToPolygon(
  usdcAmount: number,
  fromSolanaAddress: string,
  toPolygonAddress: string,
): Promise<BridgeResult> {
  const env = getCFOEnv();

  // Enforce maxBridgeUsd cap
  if (env.maxBridgeUsd > 0 && usdcAmount > env.maxBridgeUsd) {
    return {
      success: false, fromChain: 'solana', toChain: 'polygon',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'none', status: 'FAILED',
      error: `Amount $${usdcAmount} exceeds max bridge cap $${env.maxBridgeUsd}`,
    };
  }

  if (env.dryRun) {
    logger.info(`[Bridge] DRY RUN — would bridge ${usdcAmount} USDC Solana → Polygon`);
    return {
      success: true, txHash: `dry-${Date.now()}`, fromChain: 'solana', toChain: 'polygon',
      fromAmount: usdcAmount, toAmountExpected: usdcAmount * 0.998, bridge: 'wormhole', status: 'DONE',
    };
  }

  // For Solana→EVM we use the Wormhole SDK directly (LI.FI Solana support is limited)
  try {
    const wormhole = await import('@wormhole-foundation/sdk');
    const solanaWH = await import('@wormhole-foundation/sdk/solana');
    const evmWH = await import('@wormhole-foundation/sdk/evm');
    const { getEnv } = await import('../env.ts');
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = await import('bs58');

    const walletEnv = getEnv();
    const solKeypair = Keypair.fromSecretKey(bs58.default ? (bs58.default as any).decode(walletEnv.AGENT_FUNDING_WALLET_SECRET!) : (bs58 as any).decode(walletEnv.AGENT_FUNDING_WALLET_SECRET!));

    const wh = await wormhole.wormhole('Mainnet', [(solanaWH as any).default?.solana ?? (solanaWH as any).solana, (evmWH as any).default?.evm ?? (evmWH as any).evm]);
    const srcChain = wh.getChain('Solana');
    const dstChain = wh.getChain('Polygon');

    const src = await srcChain.getTokenBridge();
    const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const rawAmount = BigInt(Math.floor(usdcAmount * 1e6));

    const signer = await (solanaWH as any).getSolanaSignAndSendSigner(
      await srcChain.getRpc(),
      solKeypair,
    );

    const transfer = src.transfer(
      { chain: 'Solana', address: wormhole.toNative('Solana', fromSolanaAddress) } as any,
      { chain: 'Polygon', address: wormhole.toNative('Polygon', toPolygonAddress) } as any,
      { chain: 'Solana', address: wormhole.toNative('Solana', USDC_SOLANA) } as any,
      rawAmount,
    );

    const txids = await wormhole.signSendWait(srcChain, transfer as any, signer as any);
    const txHash = txids[0]?.txid;

    logger.info(`[Bridge] Wormhole Solana→Polygon ${usdcAmount} USDC: ${txHash}`);

    return {
      success: true, txHash, fromChain: 'solana', toChain: 'polygon',
      fromAmount: usdcAmount, toAmountExpected: usdcAmount,
      bridge: 'wormhole', status: 'PENDING',
      explorerUrl: txHash ? `https://wormholescan.io/#/tx/${txHash}` : undefined,
    };
  } catch (err) {
    logger.error('[Bridge] Wormhole Solana→Polygon error:', err);
    return {
      success: false, fromChain: 'solana', toChain: 'polygon',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'wormhole', status: 'FAILED', error: (err as Error).message,
    };
  }
}

/**
 * Bridge USDC from Polygon → Arbitrum (to fund Hyperliquid vault).
 * Uses LI.FI (routes via Stargate or Across for sub-minute transfers).
 */
export async function bridgePolygonToArbitrum(
  usdcAmount: number,
  fromAddress: string,
  toAddress: string,
): Promise<BridgeResult> {
  const env = getCFOEnv();

  // Enforce maxBridgeUsd cap
  if (env.maxBridgeUsd > 0 && usdcAmount > env.maxBridgeUsd) {
    return {
      success: false, fromChain: 'polygon', toChain: 'arbitrum',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'none', status: 'FAILED',
      error: `Amount $${usdcAmount} exceeds max bridge cap $${env.maxBridgeUsd}`,
    };
  }

  const quote = await getBridgeQuote('polygon', 'arbitrum', 'USDC', 'USDC', usdcAmount, fromAddress, toAddress);
  if (!quote) {
    return {
      success: false, fromChain: 'polygon', toChain: 'arbitrum',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'none', status: 'FAILED', error: 'No bridge route available',
    };
  }

  logger.info(`[Bridge] Best route: ${quote.bridge} — ${quote.fromAmount} USDC → ${quote.toAmount.toFixed(2)} USDC in ~${quote.estimatedTimeSeconds}s (fee: $${quote.bridgeFeeUsd.toFixed(3)})`);

  if (!env.evmPrivateKey) {
    return { ...quote, success: false, status: 'FAILED' as const, error: 'CFO_EVM_PRIVATE_KEY not configured', toAmountExpected: quote.toAmount };
  }

  return executeLifiEvmRoute(quote, env.evmPrivateKey);
}

/**
 * Bridge USDC from Polygon → Solana (repatriate profits).
 */
export async function bridgePolygonToSolana(
  usdcAmount: number,
  fromPolygonAddress: string,
  toSolanaAddress: string,
): Promise<BridgeResult> {
  const env = getCFOEnv();

  // Enforce maxBridgeUsd cap
  if (env.maxBridgeUsd > 0 && usdcAmount > env.maxBridgeUsd) {
    return {
      success: false, fromChain: 'polygon', toChain: 'solana',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'none', status: 'FAILED',
      error: `Amount $${usdcAmount} exceeds max bridge cap $${env.maxBridgeUsd}`,
    };
  }

  if (env.dryRun) {
    logger.info(`[Bridge] DRY RUN — would bridge ${usdcAmount} USDC Polygon → Solana`);
    return {
      success: true, txHash: `dry-${Date.now()}`, fromChain: 'polygon', toChain: 'solana',
      fromAmount: usdcAmount, toAmountExpected: usdcAmount * 0.998, bridge: 'wormhole', status: 'DONE',
    };
  }

  // Use Wormhole SDK for EVM → Solana
  try {
    const wormhole = await import('@wormhole-foundation/sdk');
    const solanaWH = await import('@wormhole-foundation/sdk/solana');
    const evmWH = await import('@wormhole-foundation/sdk/evm');
    const ethers = await import('ethers');

    if (!env.evmPrivateKey) throw new Error('CFO_EVM_PRIVATE_KEY not set');

    const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
    const evmWallet = new ethers.Wallet(env.evmPrivateKey, provider);

    const wh = await wormhole.wormhole('Mainnet', [(solanaWH as any).default?.solana ?? (solanaWH as any).solana, (evmWH as any).default?.evm ?? (evmWH as any).evm]);
    const srcChain = wh.getChain('Polygon');
    const dstChain = wh.getChain('Solana');
    const src = await srcChain.getTokenBridge();

    const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const rawAmount = BigInt(Math.floor(usdcAmount * 1e6));

    const signer = await (evmWH as any).getEvmSignerForKey(evmWallet as any, srcChain);

    const transfer = src.transfer(
      { chain: 'Polygon', address: wormhole.toNative('Polygon', fromPolygonAddress) } as any,
      { chain: 'Solana', address: wormhole.toNative('Solana', toSolanaAddress) } as any,
      { chain: 'Polygon', address: wormhole.toNative('Polygon', USDC_POLYGON) } as any,
      rawAmount,
    );

    const txids = await wormhole.signSendWait(srcChain, transfer as any, signer as any);
    const txHash = txids[0]?.txid;

    logger.info(`[Bridge] Wormhole Polygon→Solana ${usdcAmount} USDC: ${txHash}`);
    return {
      success: true, txHash, fromChain: 'polygon', toChain: 'solana',
      fromAmount: usdcAmount, toAmountExpected: usdcAmount,
      bridge: 'wormhole', status: 'PENDING',
    };
  } catch (err) {
    return {
      success: false, fromChain: 'polygon', toChain: 'solana',
      fromAmount: usdcAmount, toAmountExpected: 0,
      bridge: 'wormhole', status: 'FAILED', error: (err as Error).message,
    };
  }
}

/**
 * Check if a bridge transaction has completed.
 * Polls the LI.FI status endpoint.
 */
export async function checkBridgeStatus(txHash: string, fromChain: string): Promise<'PENDING' | 'DONE' | 'FAILED'> {
  try {
    const fromChainId = CHAIN_IDS[fromChain];
    if (!fromChainId) return 'PENDING';

    const resp = await fetch(
      `${LIFI_API_BASE}/status?txHash=${txHash}&fromChain=${fromChainId}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return 'PENDING';

    const data = await resp.json() as any;
    const status = data.status as string;

    if (status === 'DONE') return 'DONE';
    if (status === 'FAILED') return 'FAILED';
    return 'PENDING';
  } catch {
    return 'PENDING';
  }
}
