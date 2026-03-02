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

// ============================================================================
// Well-Known Chain IDs (all EVM + Solana LI.FI chain ID)
// ============================================================================

export const WELL_KNOWN_CHAIN_IDS: Record<string, number> = {
  ethereum:  1,
  optimism:  10,
  bsc:       56,
  polygon:   137,
  base:      8453,
  arbitrum:  42161,
  avalanche: 43114,
  zksync:    324,
  linea:     59144,
  scroll:    534352,
  mantle:    5000,
  blast:     81457,
  solana:    1151111081099710,  // LI.FI Solana chain ID
};

/** Reverse lookup: numeric → name */
const CHAIN_ID_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(WELL_KNOWN_CHAIN_IDS).map(([name, id]) => [id, name]),
);

export function chainIdToName(numericId: number): string {
  return CHAIN_ID_TO_NAME[numericId] ?? `chain-${numericId}`;
}

export function chainNameToId(name: string): number | undefined {
  return WELL_KNOWN_CHAIN_IDS[name.toLowerCase()];
}

// ============================================================================
// Well-Known USDC addresses per chain
// ============================================================================

export const WELL_KNOWN_USDC: Record<number, string> = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',  // Ethereum
  10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',  // Optimism (native USDC)
  56:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',  // BSC
  137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',  // Polygon (native USDC)
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',  // Arbitrum (native USDC)
  43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',  // Avalanche
  324:   '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',  // zkSync Era
  59144: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',  // Linea (USDC.e)
  534352:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',  // Scroll
  5000:  '0x09Bc4E0D10E52d8DA1060E04bfe1860bCe6f8A37',  // Mantle
};

// ============================================================================
// Dynamic Token Registry
// ============================================================================
// Populated at runtime from pool discovery, bridge operations, etc.
// Key: `${chainId}_${SYMBOL}` → token address

const _tokenRegistry = new Map<string, string>();

// Seed the registry with well-known USDC addresses
for (const [chainId, addr] of Object.entries(WELL_KNOWN_USDC)) {
  _tokenRegistry.set(`${chainId}_USDC`, addr);
}
// Seed legacy bridged USDC variants
_tokenRegistry.set('137_USDC.e', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');  // Polygon USDC.e
_tokenRegistry.set('42161_USDC.e', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'); // Arbitrum USDC.e
_tokenRegistry.set('8453_USDbC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA');  // Base USDbC (bridged USDC)
_tokenRegistry.set('10_USDC.e', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607');   // Optimism USDC.e
_tokenRegistry.set('43114_USDC.e', '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664'); // Avalanche USDC.e
// Seed well-known USDT addresses
_tokenRegistry.set('1_USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7');      // Ethereum
_tokenRegistry.set('10_USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58');     // Optimism
_tokenRegistry.set('137_USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F');    // Polygon
_tokenRegistry.set('8453_USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2');   // Base
_tokenRegistry.set('42161_USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9');  // Arbitrum
_tokenRegistry.set('43114_USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7');  // Avalanche
_tokenRegistry.set('56_USDT', '0x55d398326f99059fF775485246999027B3197955');      // BSC

// Seed native token addresses (LI.FI convention: 0xEeee...eE for native gas token on all EVM chains)
const LIFI_NATIVE_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
for (const chainId of [1, 10, 56, 137, 8453, 42161, 43114, 324, 59144, 534352, 5000]) {
  _tokenRegistry.set(`${chainId}_ETH`, LIFI_NATIVE_ADDR);
  _tokenRegistry.set(`${chainId}_NATIVE`, LIFI_NATIVE_ADDR);
}
// Also register WETH addresses for common chains
_tokenRegistry.set('1_WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');      // Ethereum
_tokenRegistry.set('10_WETH', '0x4200000000000000000000000000000000000006');      // Optimism
_tokenRegistry.set('137_WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619');    // Polygon (bridged WETH)
_tokenRegistry.set('8453_WETH', '0x4200000000000000000000000000000000000006');    // Base
_tokenRegistry.set('42161_WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');  // Arbitrum
_tokenRegistry.set('43114_WETH', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB');  // Avalanche (WETH.e)

/**
 * Register a token address for a chain + symbol pair.
 * Called from pool discovery to build up the dynamic registry.
 */
export function registerTokenAddress(chainId: number, symbol: string, address: string): void {
  const key = `${chainId}_${symbol.toUpperCase()}`;
  if (!_tokenRegistry.has(key)) {
    _tokenRegistry.set(key, address);
  }
}

/**
 * Resolve a token address from the dynamic registry.
 * Falls back to WELL_KNOWN_USDC for USDC, returns undefined if not found.
 */
export function resolveTokenAddress(chainId: number, symbol: string): string | undefined {
  return _tokenRegistry.get(`${chainId}_${symbol.toUpperCase()}`);
}

// ============================================================================
// Legacy aliases (backward compat)
// ============================================================================

const CHAIN_IDS = WELL_KNOWN_CHAIN_IDS;

const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  polygon: {
    USDC: WELL_KNOWN_USDC[137]!,
    'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    MATIC: '0x0000000000000000000000000000000000001010',
  },
  arbitrum: {
    USDC: WELL_KNOWN_USDC[42161]!,
    USDC_NATIVE: WELL_KNOWN_USDC[42161]!,
    'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    ETH: '0x0000000000000000000000000000000000000000',
  },
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    SOL: 'So11111111111111111111111111111111111111112',
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

    // Use dynamic provider from krystalService (covers all configured chains)
    const fromChainId = WELL_KNOWN_CHAIN_IDS[quote.fromChain] ?? 137;
    let rpcUrl: string;
    try {
      const { getEvmProvider } = await import('./krystalService.ts');
      const p = await getEvmProvider(fromChainId);
      rpcUrl = (p as any)._getConnection?.()?.url ?? getCFOEnv().polygonRpcUrl;
    } catch {
      // fallback to legacy RPC
      rpcUrl = quote.fromChain === 'polygon'
        ? getCFOEnv().polygonRpcUrl
        : getCFOEnv().arbitrumRpcUrl;
    }
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(fromPrivateKey, provider);

    lifi.createConfig({ integrator: 'nova-cfo' });

    // LI.FI /quote returns a single Step, but executeRoute expects a Route
    // with steps[]. Wrap the raw quote in a route structure if needed.
    const rawRoute = quote.rawRoute as any;
    const route = rawRoute.steps ? rawRoute : { ...rawRoute, steps: [rawRoute] };

    const execution = await lifi.executeRoute(route, {
      updateRouteHook: (updatedRoute: any) => {
        const step = updatedRoute?.steps?.[0];
        logger.debug(`[Bridge] Step status: ${step?.execution?.status}`);
      },
    });

    const lastStep = (execution as any)?.steps?.at(-1);
    const txHash = lastStep?.execution?.process?.at(-1)?.txHash
      ?? (execution as any)?.execution?.process?.at(-1)?.txHash;

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
    const fromChainId = CHAIN_IDS[fromChain] ?? Number(fromChain);
    if (!fromChainId || isNaN(fromChainId)) return 'PENDING';

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

// ============================================================================
// Generic EVM → EVM bridge (LI.FI)
// ============================================================================

/**
 * Bridge a token from one EVM chain to another via LI.FI.
 * Uses the dynamic token registry + WELL_KNOWN_CHAIN_IDS.
 *
 * @param fromChainId  Numeric chain ID (e.g. 137)
 * @param toChainId    Numeric chain ID (e.g. 42161)
 * @param tokenSymbol  Token to bridge (e.g. 'USDC')
 * @param amountHuman  Human-readable amount (e.g. 50.0)
 * @param fromAddress  Sender wallet address
 * @param toAddress    Receiver wallet address (can be same wallet)
 *
 * Skips if bridge fee > 3% of amount.
 */
export async function bridgeEvmToEvm(
  fromChainId: number,
  toChainId: number,
  tokenSymbol: string,
  amountHuman: number,
  fromAddress: string,
  toAddress: string,
  opts?: { fromTokenAddress?: string; toTokenAddress?: string },
): Promise<BridgeResult> {
  const env = getCFOEnv();
  const fromName = chainIdToName(fromChainId);
  const toName = chainIdToName(toChainId);

  const fail = (error: string): BridgeResult => ({
    success: false, fromChain: fromName, toChain: toName,
    fromAmount: amountHuman, toAmountExpected: 0,
    bridge: 'none', status: 'FAILED', error,
  });

  // Enforce max bridge cap
  if (env.maxBridgeUsd > 0 && amountHuman > env.maxBridgeUsd) {
    return fail(`Amount $${amountHuman} exceeds max bridge cap $${env.maxBridgeUsd}`);
  }

  // Resolve token addresses — use explicit overrides if provided, else registry lookup
  const fromTokenAddr = opts?.fromTokenAddress ?? resolveTokenAddress(fromChainId, tokenSymbol);
  const toTokenAddr = opts?.toTokenAddress ?? resolveTokenAddress(toChainId, tokenSymbol);
  if (!fromTokenAddr || !toTokenAddr) {
    logger.debug(`[Bridge] Token resolution failed: from=${fromTokenAddr ?? 'undefined'} to=${toTokenAddr ?? 'undefined'} opts=${JSON.stringify(opts)} symbol=${tokenSymbol}`);
    return fail(`Cannot resolve ${tokenSymbol} address on chain ${fromChainId} or ${toChainId}`);
  }

  // Get quote via LI.FI
  const decimals = tokenSymbol.toUpperCase().includes('USD') ? 6 : 18;
  const fromAmountRaw = Math.floor(amountHuman * 10 ** decimals).toString();

  try {
    const params = new URLSearchParams({
      fromChain: fromChainId.toString(),
      toChain: toChainId.toString(),
      fromToken: fromTokenAddr,
      toToken: toTokenAddr,
      fromAmount: fromAmountRaw,
      fromAddress,
      toAddress,
      slippage: '0.005',
    });

    const resp = await fetch(`${LIFI_API_BASE}/quote?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return fail(`LI.FI quote failed (${resp.status}): ${body.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const toAmount = Number(data.estimate?.toAmount ?? 0) / 10 ** decimals;
    const gasCostUsd = Number(data.estimate?.gasCosts?.[0]?.amountUSD ?? 0);
    const feeCostUsd = Number(data.estimate?.feeCosts?.[0]?.amountUSD ?? 0);
    const totalFee = gasCostUsd + feeCostUsd;

    // Fee gate: skip if fee > 3% of amount (always compare in USD terms)
    // For non-stablecoin bridges, amountHuman is in token units (e.g. 0.01 ETH),
    // so we use LI.FI's fromAmountUSD to get the true USD value for comparison.
    const fromAmountUsd = Number(data.estimate?.fromAmountUSD ?? amountHuman);
    if (fromAmountUsd > 0 && totalFee > fromAmountUsd * 0.03) {
      return fail(`Bridge fee $${totalFee.toFixed(2)} exceeds 3% of $${fromAmountUsd.toFixed(2)}`);
    }

    const quote: BridgeQuote = {
      id: data.id ?? `lifi-${Date.now()}`,
      fromChain: fromName,
      toChain: toName,
      fromToken: tokenSymbol,
      toToken: tokenSymbol,
      fromAmount: amountHuman,
      toAmount,
      bridgeFeeUsd: totalFee,
      estimatedTimeSeconds: Number(data.estimate?.executionDuration ?? 120),
      bridge: data.tool ?? 'unknown',
      tool: data.tool ?? 'unknown',
      rawRoute: data,
    };

    logger.info(
      `[Bridge] EVM→EVM best route: ${quote.bridge} — $${amountHuman} ${tokenSymbol} ` +
      `${fromName}→${toName} (fee: $${totalFee.toFixed(3)}, ~${quote.estimatedTimeSeconds}s)`,
    );

    if (!env.evmPrivateKey) {
      return fail('CFO_EVM_PRIVATE_KEY not configured');
    }

    return executeLifiEvmRoute(quote, env.evmPrivateKey);
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * Poll bridge status until DONE/FAILED, up to maxWaitMs (default 5min).
 * Polls every 15s.
 */
export async function awaitBridgeCompletion(
  txHash: string,
  fromChain: string,
  maxWaitMs = 5 * 60_000,
): Promise<'DONE' | 'FAILED' | 'TIMEOUT'> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await checkBridgeStatus(txHash, fromChain);
    if (status === 'DONE') return 'DONE';
    if (status === 'FAILED') return 'FAILED';
    await new Promise(r => setTimeout(r, 15_000));
  }
  return 'TIMEOUT';
}

// ============================================================================
// Generic EVM balance helpers
// ============================================================================

/**
 * Get ERC-20 token balance for a wallet on any EVM chain.
 * Returns human-readable amount (decimal-adjusted).
 */
export async function getEvmTokenBalance(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
): Promise<number> {
  try {
    const { getEvmProvider } = await import('./krystalService.ts');
    const ethers = await import('ethers' as string);
    const provider = await getEvmProvider(chainId);
    const erc20 = new ethers.Contract(tokenAddress, [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ], provider);
    const [balance, decimals] = await Promise.all([
      erc20.balanceOf(walletAddress),
      erc20.decimals().catch(() => 18),
    ]);
    return Number(ethers.formatUnits(balance, decimals));
  } catch {
    return 0;
  }
}

/**
 * Get native token (ETH/MATIC/AVAX/etc.) balance on any EVM chain.
 * Returns human-readable amount in native units.
 */
export async function getEvmNativeBalance(
  chainId: number,
  walletAddress: string,
): Promise<number> {
  try {
    const { getEvmProvider } = await import('./krystalService.ts');
    const ethers = await import('ethers' as string);
    const provider = await getEvmProvider(chainId);
    const balance = await provider.getBalance(walletAddress);
    return Number(ethers.formatEther(balance));
  } catch {
    return 0;
  }
}
