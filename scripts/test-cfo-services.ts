#!/usr/bin/env bun
/**
 * CFO Service Health Check — Tests every CFO sub-service end-to-end.
 *
 * Usage:
 *   bun run scripts/test-cfo-services.ts                 # read-only checks
 *   bun run scripts/test-cfo-services.ts --live           # include live swap/trade (tiny amounts)
 *   bun run scripts/test-cfo-services.ts --service=pyth   # test single service
 *
 * Flags:
 *   --live        Execute actual on-chain txs (micro amounts: 0.001 SOL swap, HL $10 hedge)
 *   --service=X   Only test named service (pyth, jupiter, jito, kamino, evm, poly, hl, bridge, helius, portfolio)
 */

import 'dotenv/config';

// ============================================================================
// Types & helpers
// ============================================================================

interface TestResult {
  service: string;
  test: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
  ms: number;
}

const results: TestResult[] = [];
const LIVE = process.argv.includes('--live');
const SERVICE_FILTER = process.argv.find(a => a.startsWith('--service='))?.split('=')[1]?.toLowerCase();

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function shouldRun(service: string): boolean {
  return !SERVICE_FILTER || SERVICE_FILTER === service.toLowerCase();
}

async function runTest(service: string, test: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ service, test, status: 'PASS', detail: detail ?? undefined, ms: Date.now() - t0 });
    console.log(`  ${GREEN}✅ ${test}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    results.push({ service, test, status: 'FAIL', detail: msg, ms: Date.now() - t0 });
    console.log(`  ${RED}❌ ${test}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET} — ${msg}`);
  }
}

function skip(service: string, test: string, reason: string) {
  results.push({ service, test, status: 'SKIP', detail: reason, ms: 0 });
  console.log(`  ${YELLOW}⏭️  ${test}${RESET} — ${reason}`);
}

function header(name: string) {
  console.log(`\n${BOLD}${CYAN}━━━ ${name} ━━━${RESET}`);
}

// ============================================================================
// 1. CFO Environment
// ============================================================================

async function testCFOEnv() {
  if (!shouldRun('env')) return;
  header('CFO Environment');

  await runTest('env', 'Load CFO config', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true); // bust cache
    const flags = [
      env.polymarketEnabled && 'Polymarket',
      env.hyperliquidEnabled && 'Hyperliquid',
      env.kaminoEnabled && 'Kamino',
      env.jitoEnabled && 'Jito',
      env.wormholeEnabled && 'Wormhole/LiFi',
      env.heliusEnabled && 'Helius',
      env.pythEnabled && 'Pyth',
      env.x402Enabled && 'x402',
    ].filter(Boolean);
    return `CFO=${env.cfoEnabled ? 'ON' : 'OFF'}, dryRun=${env.dryRun} | enabled: ${flags.join(', ') || 'none'}`;
  });

  await runTest('env', 'Solana wallet loaded', async () => {
    if (!process.env.AGENT_FUNDING_WALLET_SECRET) throw new Error('AGENT_FUNDING_WALLET_SECRET not set');
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET));
    return `pubkey: ${kp.publicKey.toBase58().slice(0, 8)}…`;
  });

  await runTest('env', 'Solana RPC reachable', async () => {
    const { Connection } = await import('@solana/web3.js');
    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const conn = new Connection(rpcUrl, 'confirmed');
    const slot = await conn.getSlot();
    return `slot ${slot} via ${new URL(rpcUrl).hostname}`;
  });
}

// ============================================================================
// 2. Pyth Oracle
// ============================================================================

async function testPyth() {
  if (!shouldRun('pyth')) return;
  header('Pyth Oracle');

  await runTest('pyth', 'SOL/USD price', async () => {
    const { getSolPrice } = await import('../src/launchkit/cfo/pythOracleService.ts');
    const price = await getSolPrice();
    if (isNaN(price) || price <= 0) throw new Error(`Invalid SOL price: ${price}`);
    return `$${price.toFixed(2)}`;
  });

  await runTest('pyth', 'Multi-asset prices (SOL, ETH, BTC)', async () => {
    const { getPrices } = await import('../src/launchkit/cfo/pythOracleService.ts');
    const prices = await getPrices(['SOL/USD', 'ETH/USD', 'BTC/USD']);
    if (prices.size === 0) throw new Error('No prices returned');
    const lines = Array.from(prices.entries()).map(([k, v]) => `${k}=$${v.price.toFixed(0)}`);
    return lines.join(', ');
  });

  await runTest('pyth', 'Swap price validation', async () => {
    const { validateSwapPrice, getSolPrice } = await import('../src/launchkit/cfo/pythOracleService.ts');
    const solPrice = await getSolPrice();
    const result = await validateSwapPrice('SOL/USD', solPrice, 1);
    if (!result) throw new Error('Validation returned null — oracle may be down');
    return `deviation: ${((result as any).deviationPct ?? 0).toFixed(2)}%`;
  });
}

// ============================================================================
// 3. Jupiter (Swap)
// ============================================================================

async function testJupiter() {
  if (!shouldRun('jupiter')) return;
  header('Jupiter Swap');

  await runTest('jupiter', 'Quote SOL→USDC (0.01 SOL)', async () => {
    const { getQuote, MINTS } = await import('../src/launchkit/cfo/jupiterService.ts');
    const quote = await getQuote(MINTS.SOL, MINTS.USDC, 0.01);
    if (!quote) throw new Error('No quote returned — Jupiter API may be down');
    const outAmt = Number(quote.outAmount) / 1e6; // USDC 6 decimals
    return `0.01 SOL → ${outAmt.toFixed(4)} USDC (impact: ${quote.priceImpactPct.toFixed(3)}%)`;
  });

  await runTest('jupiter', 'Quote USDC→SOL (1 USDC)', async () => {
    const { getQuote, MINTS } = await import('../src/launchkit/cfo/jupiterService.ts');
    const quote = await getQuote(MINTS.USDC, MINTS.SOL, 1);
    if (!quote) throw new Error('No quote returned');
    const outAmt = Number(quote.outAmount) / 1e9; // SOL 9 decimals
    return `1 USDC → ${outAmt.toFixed(6)} SOL`;
  });

  await runTest('jupiter', 'Token balance (SOL native)', async () => {
    const { Connection, Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const conn = new Connection(rpcUrl, 'confirmed');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
    const bal = await conn.getBalance(kp.publicKey);
    const solBal = bal / 1e9;
    if (solBal < 0.001) throw new Error(`SOL balance too low: ${solBal}`);
    return `${solBal.toFixed(4)} SOL`;
  });

  if (LIVE) {
    await runTest('jupiter', '🔥 LIVE swap: 0.001 SOL → USDC', async () => {
      const { swapSolToUsdc } = await import('../src/launchkit/cfo/jupiterService.ts');
      const result = await swapSolToUsdc(0.001);
      if (!result.success) throw new Error(result.error ?? 'Swap failed');
      return `tx: ${result.txSignature?.slice(0, 12)}… | got ${result.outputAmount.toFixed(4)} USDC`;
    });
  } else {
    skip('jupiter', 'LIVE swap (0.001 SOL)', 'Use --live flag to execute');
  }
}

// ============================================================================
// 4. Jito Staking
// ============================================================================

async function testJito() {
  if (!shouldRun('jito')) return;
  header('Jito Liquid Staking');

  await runTest('jito', 'Get stake position', async () => {
    const { getStakePosition } = await import('../src/launchkit/cfo/jitoStakingService.ts');
    const { getSolPrice } = await import('../src/launchkit/cfo/pythOracleService.ts');
    const solPrice = await getSolPrice();
    const pos = await getStakePosition(solPrice);
    return `JitoSOL: ${pos.jitoSolBalance.toFixed(4)} (≈$${pos.jitoSolValueUsd.toFixed(0)}) | rate: ${pos.exchangeRate.toFixed(4)} | APY: ~${(pos.apy ?? 0).toFixed(1)}%`;
  });
}

// ============================================================================
// 5. Kamino Lending
// ============================================================================

async function testKamino() {
  if (!shouldRun('kamino')) return;
  header('Kamino Lending');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.kaminoEnabled) {
    skip('kamino', 'All Kamino tests', 'CFO_KAMINO_ENABLE=false');
    return;
  }

  await runTest('kamino', 'Get position', async () => {
    const { getPosition } = await import('../src/launchkit/cfo/kaminoService.ts');
    const pos = await getPosition();
    const depositUsd = pos.deposits.reduce((s, d) => s + d.valueUsd, 0);
    const borrowUsd = pos.borrows.reduce((s, b) => s + b.valueUsd, 0);
    return `deposits: $${depositUsd.toFixed(0)} | borrows: $${borrowUsd.toFixed(0)} | net: $${pos.netValueUsd.toFixed(0)} | health: ${pos.healthFactor.toFixed(2)} | LTV: ${(pos.ltv * 100).toFixed(1)}%`;
  });

  await runTest('kamino', 'Get APYs', async () => {
    const { getApys } = await import('../src/launchkit/cfo/kaminoService.ts');
    const apys = await getApys();
    return `USDC supply: ${(apys.usdcSupplyApy * 100).toFixed(2)}% | SOL supply: ${(apys.solSupplyApy * 100).toFixed(2)}%`;
  });

  await runTest('kamino', 'LTV health check', async () => {
    const { checkLtvHealth } = await import('../src/launchkit/cfo/kaminoService.ts');
    const health = await checkLtvHealth();
    if (!health.safe) throw new Error(health.warning ?? 'LTV unsafe');
    return `safe ✓ | LTV: ${(health.ltv * 100).toFixed(1)}%`;
  });
}

// ============================================================================
// 6. EVM Wallet (Polygon)
// ============================================================================

async function testEVM() {
  if (!shouldRun('evm')) return;
  header('EVM Wallet (Polygon)');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.evmPrivateKey) {
    skip('evm', 'All EVM tests', 'CFO_EVM_PRIVATE_KEY not set');
    return;
  }

  await runTest('evm', 'Polygon RPC health', async () => {
    const { healthCheck } = await import('../src/launchkit/cfo/evmWalletService.ts');
    const hc = await healthCheck();
    if (!hc.ok) throw new Error(hc.error ?? 'RPC unreachable');
    return `block #${hc.blockNumber}`;
  });

  await runTest('evm', 'Wallet balances', async () => {
    const { getWalletStatus } = await import('../src/launchkit/cfo/evmWalletService.ts');
    const status = await getWalletStatus();
    return `${status.address.slice(0, 8)}… | MATIC: ${status.maticBalance.toFixed(4)} | USDC: ${status.usdcBalance.toFixed(2)} (bridged: ${status.usdcBridgedBalance.toFixed(2)}, native: ${status.usdcNativeBalance.toFixed(2)}) | gas: ${status.gasOk ? '✅' : status.gasCritical ? '🚨 CRITICAL' : '⚠️ LOW'}`;
  });

  await runTest('evm', 'Gas reserve check', async () => {
    const { checkGas } = await import('../src/launchkit/cfo/evmWalletService.ts');
    const gas = await checkGas();
    if (gas.warning) return `⚠️ ${gas.matic.toFixed(4)} MATIC — ${gas.warning}`;
    return `${gas.matic.toFixed(4)} MATIC ✅ sufficient`;
  });

  await runTest('evm', 'CTF Exchange allowance', async () => {
    const { getWalletStatus } = await import('../src/launchkit/cfo/evmWalletService.ts');
    const status = await getWalletStatus();
    return `approved: ${status.usdcApproved.toFixed(2)} USDC`;
  });
}

// ============================================================================
// 7. Polymarket
// ============================================================================

async function testPolymarket() {
  if (!shouldRun('poly')) return;
  header('Polymarket');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.polymarketEnabled) {
    skip('poly', 'All Polymarket tests', 'CFO_POLYMARKET_ENABLE=false');
    return;
  }

  await runTest('poly', 'CLOB credential derivation', async () => {
    const { getCLOBCredentials } = await import('../src/launchkit/cfo/polymarketService.ts');
    const creds = await getCLOBCredentials();
    if (!creds || !creds.apiKey) throw new Error('Credential derivation failed');
    return `key: ${creds.apiKey.slice(0, 12)}…`;
  });

  await runTest('poly', 'Fetch crypto markets', async () => {
    const { fetchCryptoMarkets } = await import('../src/launchkit/cfo/polymarketService.ts');
    const markets = await fetchCryptoMarkets({ limit: 100 });
    if (!markets || markets.length === 0) throw new Error('No crypto markets found (Gamma API may have no matching active markets)');
    return `${markets.length} markets | first: "${markets[0].question?.slice(0, 50)}…"`;
  });

  await runTest('poly', 'Fetch positions', async () => {
    const { fetchPositions } = await import('../src/launchkit/cfo/polymarketService.ts');
    const positions = await fetchPositions();
    return `${positions.length} open position(s)`;
  });

  await runTest('poly', 'Portfolio summary', async () => {
    const { getPortfolioSummary } = await import('../src/launchkit/cfo/polymarketService.ts');
    const summary = await getPortfolioSummary();
    return `deployed: $${summary.totalDeployedUsd.toFixed(2)} | positions: ${summary.positionCount} | PnL: $${summary.unrealizedPnlUsd.toFixed(2)}`;
  });

  await runTest('poly', 'Health check', async () => {
    const { healthCheck } = await import('../src/launchkit/cfo/polymarketService.ts');
    const hc = await healthCheck();
    if (!hc.ok) throw new Error(hc.error ?? 'Polymarket health check failed');
    return `wallet: ${hc.walletAddress?.slice(0, 10)}… ✅`;
  });

  await runTest('poly', 'Scan opportunities (read-only)', async () => {
    const { scanOpportunities } = await import('../src/launchkit/cfo/polymarketService.ts');
    const opp = await scanOpportunities(50); // $50 headroom
    return `${opp.length} opportunity/ies found`;
  });
}

// ============================================================================
// 8. Hyperliquid
// ============================================================================

async function testHyperliquid() {
  if (!shouldRun('hl')) return;
  header('Hyperliquid');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.hyperliquidEnabled) {
    skip('hl', 'All Hyperliquid tests', 'CFO_HYPERLIQUID_ENABLE=false');
    return;
  }

  await runTest('hl', `Account summary (${env.hyperliquidTestnet ? 'TESTNET' : 'MAINNET'})`, async () => {
    const { getAccountSummary } = await import('../src/launchkit/cfo/hyperliquidService.ts');
    const summary = await getAccountSummary();
    const posLines = summary.positions.map(p =>
      `${p.coin} ${p.side} $${p.sizeUsd.toFixed(0)} @ ${p.entryPrice.toFixed(2)} (PnL: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)})`
    );
    return `equity: $${summary.equity.toFixed(2)} | margin: $${summary.availableMargin.toFixed(2)} | ${summary.positions.length} pos${posLines.length ? '\n    ' + posLines.join('\n    ') : ''}`;
  });

  await runTest('hl', 'Risk check', async () => {
    const { checkRisk } = await import('../src/launchkit/cfo/hyperliquidService.ts');
    const risk = await checkRisk();
    if (risk.warning) return `⚠️ ${risk.warning}`;
    return `${risk.atRisk.length} positions at risk — all clear ✅`;
  });

  if (LIVE) {
    await runTest('hl', '🔥 LIVE hedge: $11 SHORT SOL-PERP', async () => {
      const { hedgeSolTreasury } = await import('../src/launchkit/cfo/hyperliquidService.ts');
      const result = await hedgeSolTreasury({
        solExposureUsd: 11, // minimum ~$10
        leverage: 2,
        stopLossPct: 8,
        takeProfitPct: 15,
      });
      if (!result.success) throw new Error(result.error ?? 'Hedge failed');
      return `order: ${result.orderId} | avg price: $${result.avgPrice?.toFixed(2) ?? '?'}`;
    });

    // Close it right after
    await runTest('hl', '🔥 LIVE close: close test position', async () => {
      const { getAccountSummary, closePosition } = await import('../src/launchkit/cfo/hyperliquidService.ts');
      const summary = await getAccountSummary();
      const solPos = summary.positions.find(p => p.coin === 'SOL');
      if (!solPos) throw new Error('No SOL position found to close');
      const sizeInSol = solPos.sizeUsd / solPos.markPrice;
      const result = await closePosition('SOL', sizeInSol, solPos.side === 'SHORT'); // buy to close short
      if (!result.success) throw new Error(result.error ?? 'Close failed');
      return `closed ${solPos.side} ${sizeInSol.toFixed(4)} SOL | order: ${result.orderId}`;
    });
  } else {
    skip('hl', 'LIVE hedge + close ($11 SOL-PERP)', 'Use --live flag to execute');
  }
}

// ============================================================================
// 9. Wormhole / LI.FI Bridge
// ============================================================================

async function testBridge() {
  if (!shouldRun('bridge')) return;
  header('Bridge (LI.FI)');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.lifiEnabled && !env.wormholeEnabled) {
    skip('bridge', 'All bridge tests', 'CFO_WORMHOLE_ENABLE=false and CFO_LIFI_ENABLE=false');
    return;
  }

  await runTest('bridge', 'Quote: Solana→Polygon 1 USDC', async () => {
    const { getBridgeQuote } = await import('../src/launchkit/cfo/wormholeService.ts');
    // Use a dummy Solana address and derived EVM address for quoting
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
    const fromAddr = kp.publicKey.toBase58();

    let toAddr = '0x0000000000000000000000000000000000000001'; // placeholder
    if (env.evmPrivateKey) {
      const { ethers } = await import('ethers');
      toAddr = new ethers.Wallet(env.evmPrivateKey).address;
    }

    const quote = await getBridgeQuote('solana', 'polygon', 'USDC', 'USDC', 1, fromAddr, toAddr);
    if (!quote) throw new Error('No bridge route found');
    return `via ${quote.bridge} | receive: ${quote.toAmount.toFixed(4)} USDC | fee: $${quote.bridgeFeeUsd.toFixed(3)} | ETA: ${quote.estimatedTimeSeconds}s`;
  });

  await runTest('bridge', 'Quote: Polygon→Solana 1 USDC', async () => {
    const { getBridgeQuote } = await import('../src/launchkit/cfo/wormholeService.ts');
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
    const toAddr = kp.publicKey.toBase58();

    let fromAddr = '0x0000000000000000000000000000000000000001';
    if (env.evmPrivateKey) {
      const { ethers } = await import('ethers');
      fromAddr = new ethers.Wallet(env.evmPrivateKey).address;
    }

    const quote = await getBridgeQuote('polygon', 'solana', 'USDC', 'USDC', 1, fromAddr, toAddr);
    if (!quote) throw new Error('No bridge route found');
    return `via ${quote.bridge} | receive: ${quote.toAmount.toFixed(4)} USDC | fee: $${quote.bridgeFeeUsd.toFixed(3)}`;
  });
}

// ============================================================================
// 10. Helius
// ============================================================================

async function testHelius() {
  if (!shouldRun('helius')) return;
  header('Helius Analytics');

  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();
  if (!env.heliusApiKey) {
    skip('helius', 'All Helius tests', 'CFO_HELIUS_API_KEY not set');
    return;
  }

  await runTest('helius', 'Wallet transactions', async () => {
    const { getWalletTransactions } = await import('../src/launchkit/cfo/heliusService.ts');
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
    const txs = await getWalletTransactions(kp.publicKey.toBase58(), { limit: 3 });
    return `${txs.length} recent tx(s)`;
  });

  await runTest('helius', 'Enriched balance', async () => {
    const { getEnrichedBalance } = await import('../src/launchkit/cfo/heliusService.ts');
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
    const balance = await getEnrichedBalance(kp.publicKey.toBase58());
    return `${(balance as any)?.items?.length ?? 0} asset(s)`;
  });
}

// ============================================================================
// 11. Portfolio (aggregated)
// ============================================================================

async function testPortfolio() {
  if (!shouldRun('portfolio')) return;
  header('Portfolio Snapshot');

  await runTest('portfolio', 'Full portfolio snapshot', async () => {
    const { getPortfolioSnapshot } = await import('../src/launchkit/cfo/portfolioService.ts');
    const snap = await getPortfolioSnapshot();
    const solChain = snap.chains.find((c: any) => c.chain === 'solana');
    const polyChain = snap.chains.find((c: any) => c.chain === 'polygon');
    const parts: string[] = [
      `total: $${snap.totalPortfolioUsd.toFixed(0)}`,
      `wallet: $${snap.totalWalletUsd.toFixed(0)}`,
      `deployed: $${snap.totalDeployedUsd.toFixed(0)}`,
    ];
    if (solChain) parts.push(`SOL: ${solChain.native.toFixed(2)} ($${solChain.nativeUsd.toFixed(0)})`);
    if (polyChain && polyChain.totalUsd > 0) parts.push(`Polygon: $${polyChain.totalUsd.toFixed(2)} (MATIC: ${polyChain.native.toFixed(2)}, USDC: ${polyChain.usdc.toFixed(2)})`);
    parts.push(`cash: ${snap.cashReservePct.toFixed(0)}%`);
    if (snap.errors.length > 0) parts.push(`⚠️ ${snap.errors.length} error(s)`);
    return parts.join(' | ');
  });
}

// ============================================================================
// 12. Decision Engine (dry run)
// ============================================================================

async function testDecisionEngine() {
  if (!shouldRun('decision')) return;
  header('Decision Engine');

  await runTest('decision', 'Gather portfolio state', async () => {
    const { gatherPortfolioState } = await import('../src/launchkit/cfo/decisionEngine.ts');
    const state = await gatherPortfolioState();
    return `portfolio: $${state.totalPortfolioUsd.toFixed(0)} | SOL: ${state.solBalance.toFixed(2)} | hedge: ${(state.hedgeRatio * 100).toFixed(0)}%`;
  });

  await runTest('decision', 'Generate decisions (no-execute)', async () => {
    const { gatherPortfolioState, generateDecisions, getDecisionConfig } = await import('../src/launchkit/cfo/decisionEngine.ts');
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const state = await gatherPortfolioState();
    const config = getDecisionConfig();
    const env = getCFOEnv();
    const decisions = await generateDecisions(state, config, env);
    if (!decisions || decisions.length === 0) return 'No decisions generated (portfolio in target range)';
    const lines = decisions.map((d: any) => `${d.tier} ${d.type}: $${Math.abs(d.estimatedImpactUsd).toFixed(0)} — ${d.reasoning.slice(0, 60)}`);
    return `${decisions.length} decision(s):\n    ${lines.join('\n    ')}`;
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`\n${BOLD}🏦 CFO Service Health Check${RESET}`);
  console.log(`${DIM}Mode: ${LIVE ? '🔥 LIVE (real txs)' : '📖 READ-ONLY'}${SERVICE_FILTER ? ` | Filter: ${SERVICE_FILTER}` : ''}${RESET}`);
  console.log(`${DIM}Time: ${new Date().toISOString()}${RESET}\n`);

  // Run all tests sequentially (some share state/caches)
  await testCFOEnv();
  await testPyth();
  await testJupiter();
  await testJito();
  await testKamino();
  await testEVM();
  await testPolymarket();
  await testHyperliquid();
  await testBridge();
  await testHelius();
  await testPortfolio();
  await testDecisionEngine();

  // ── Summary ──
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`\n${BOLD}━━━ Summary ━━━${RESET}`);
  console.log(`${GREEN}✅ ${pass} passed${RESET}  ${fail > 0 ? `${RED}❌ ${fail} failed${RESET}  ` : ''}${YELLOW}⏭️  ${skipped} skipped${RESET}`);

  if (fail > 0) {
    console.log(`\n${RED}${BOLD}Failed tests:${RESET}`);
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ${RED}❌ [${r.service}] ${r.test}: ${r.detail}${RESET}`);
    }
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}All services healthy! 🚀${RESET}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
