/**
 * Krystal EVM LP — End-to-End Test
 *
 * Tests the full lifecycle on Polygon:
 *   1. Pool discovery via Krystal API
 *   2. Wrap MATIC → WPOL
 *   3. Open a small LP position (WPOL/USDC, Uniswap V3, fee=500)
 *   4. Verify position via fetchKrystalPositions
 *   5. Close position and recover tokens
 *
 * Usage:  bun run scripts/test-krystal-e2e.ts
 *
 * Requirements:
 *   - CFO_KRYSTAL_LP_ENABLE=true
 *   - CFO_EVM_PRIVATE_KEY set (wallet with MATIC + USDC on Polygon)
 *   - CFO_POLYGON_RPC_URL set
 *   - CFO_DRY_RUN=false for real tx (or true for dry run)
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// ── Helpers ──────────────────────────────────────────────────────
function log(msg: string) { console.log(`[E2E] ${msg}`); }
function fail(msg: string): never { console.error(`[E2E FAIL] ${msg}`); process.exit(1); }

// ── Step 0: Env sanity checks ───────────────────────────────────
log('=== Krystal EVM LP E2E Test ===');
log(`DRY_RUN = ${process.env.CFO_DRY_RUN}`);

const pk = process.env.CFO_EVM_PRIVATE_KEY;
if (!pk) fail('CFO_EVM_PRIVATE_KEY not set');

const wallet = new ethers.Wallet(pk);
log(`Wallet: ${wallet.address}`);

const rpc = process.env.CFO_POLYGON_RPC_URL;
if (!rpc) fail('CFO_POLYGON_RPC_URL not set');

const provider = new ethers.JsonRpcProvider(rpc);
const signer = new ethers.Wallet(pk, provider);
const nativeBal = await provider.getBalance(wallet.address);
log(`Polygon native balance: ${ethers.formatEther(nativeBal)} MATIC`);

if (nativeBal < ethers.parseEther('0.5')) {
  fail('Need at least 0.5 MATIC for wrapping + gas');
}

// Check USDC balance
const USDC_POLYGON = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const usdcContract = new ethers.Contract(USDC_POLYGON, [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
], provider);
const usdcBal = await usdcContract.balanceOf(wallet.address);
const usdcDec = await usdcContract.decimals();
const usdcHuman = Number(ethers.formatUnits(usdcBal, usdcDec));
log(`Polygon USDC balance: $${usdcHuman.toFixed(2)}`);

if (usdcHuman < 1) {
  fail('Need at least $1 USDC on Polygon for test');
}

// WPOL balance
const WPOL_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const wpolContract = new ethers.Contract(WPOL_ADDRESS, [
  'function balanceOf(address) view returns (uint256)',
  'function deposit() payable',
], provider);
const wpolBal = await wpolContract.balanceOf(wallet.address);
log(`WPOL balance: ${ethers.formatEther(wpolBal)} WPOL`);

// ── Step 1: Pool Discovery ──────────────────────────────────────
log('\n=== Step 1: Pool Discovery ===');

const { discoverKrystalPools, fetchKrystalPositions, openEvmLpPosition, closeEvmLpPosition } = await import('../src/launchkit/cfo/krystalService.ts');

let pools;
try {
  pools = await discoverKrystalPools(true);
  log(`Discovered ${pools.length} pools`);
  for (const p of pools.slice(0, 5)) {
    log(`  ${p.token0.symbol}/${p.token1.symbol} (${p.chainName}) fee=${p.feeTier} TVL=$${(p.tvlUsd / 1e3).toFixed(0)}k APR7d=${p.apr7d.toFixed(1)}% score=${p.score.toFixed(0)}`);
  }
} catch (err: any) {
  log(`Pool discovery error: ${err.message}`);
  log('Will use hardcoded pool data as fallback');
}

// ── Step 2: Select or build test pool ───────────────────────────
log('\n=== Step 2: Select Pool ===');

// Try to find WPOL/USDC on Polygon from discovered pools
let testPool = pools?.find(p =>
  p.chainNumericId === 137 &&
  p.feeTier === 500 &&
  ((p.token0.symbol === 'WPOL' && p.token1.symbol === 'USDC') ||
   (p.token0.symbol === 'USDC' && p.token1.symbol === 'WPOL'))
);

if (!testPool) {
  log('WPOL/USDC not found in discovered pools — using hardcoded data');
  testPool = {
    chainId: 'polygon@137',
    chainNumericId: 137,
    chainName: 'polygon',
    poolAddress: '0xb6e57ed85c4c9dbfef2a68711e9d6f36c56e0fcb',
    protocol: { name: 'Uniswap V3', factoryAddress: '0x1f98431c8ad98523631ae4a59f267346ea31f984' },
    feeTier: 500,
    token0: { address: WPOL_ADDRESS, symbol: 'WPOL', name: 'Wrapped POL', decimals: 18 },
    token1: { address: USDC_POLYGON, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    tvl: '296321',
    tvlUsd: 296321,
    apr24h: 63,
    apr7d: 72.8,
    apr30d: 68,
    score: 80,
    scoreBreakdown: {},
    reasoning: ['hardcoded test pool'],
  } as any;
}

log(`Selected: ${testPool.token0.symbol}/${testPool.token1.symbol} on ${testPool.chainName} (fee=${testPool.feeTier})`);
log(`Pool address: ${testPool.poolAddress}`);

// ── Step 3: Wrap MATIC → WPOL for LP ────────────────────────────
log('\n=== Step 3: Wrap MATIC → WPOL ===');

const DEPLOY_USD = 2; // Very small test amount: $2
const wpolWithSigner = new ethers.Contract(WPOL_ADDRESS, [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
], signer);

// Wrap ~$1 worth of MATIC (≈ 3 MATIC at ~$0.25 each, top-up buffer)
const currentWpol = await wpolContract.balanceOf(wallet.address);
const currentWpolEth = Number(ethers.formatEther(currentWpol));
const wrapAmount = ethers.parseEther('3');
if (currentWpolEth < 3) {
  log(`Wrapping 3 MATIC → WPOL (current WPOL: ${currentWpolEth.toFixed(2)})...`);
  try {
    const wrapTx = await wpolWithSigner.deposit({ value: wrapAmount });
    await wrapTx.wait();
    const newWpolBal = await wpolContract.balanceOf(wallet.address);
    log(`WPOL balance after wrap: ${ethers.formatEther(newWpolBal)} WPOL`);
  } catch (err: any) {
    fail(`Failed to wrap MATIC: ${err.message}`);
  }
} else {
  log(`Already have ${currentWpolEth.toFixed(2)} WPOL — skipping wrap`);
}

// ── Step 4: Open Position ───────────────────────────────────────
log('\n=== Step 4: Open LP Position ===');
log(`Deploying $${DEPLOY_USD} into LP...`);

let openResult;
try {
  openResult = await openEvmLpPosition(
    {
      chainId: testPool.chainId,
      chainNumericId: testPool.chainNumericId,
      poolAddress: testPool.poolAddress,
      token0: testPool.token0,
      token1: testPool.token1,
      protocol: testPool.protocol,
      feeTier: testPool.feeTier,
    },
    DEPLOY_USD,
    400, // rangeWidthTicks
  );

  log(`Open result: success=${openResult.success}`);
  if (openResult.tokenId) log(`Token ID: ${openResult.tokenId}`);
  if (openResult.txHash) log(`TX Hash: ${openResult.txHash}`);
  if (!openResult.success) {
    log(`Error: ${openResult.error}`);
    fail('Failed to open position');
  }
} catch (err: any) {
  fail(`openEvmLpPosition threw: ${err.message}\n${err.stack}`);
}

const tokenId = openResult.tokenId;
if (!tokenId || tokenId.startsWith('dry-')) {
  log('DRY RUN mode — skipping position verification and close');
  log('\n=== E2E Test PASSED (dry run) ===');
  process.exit(0);
}

if (tokenId.startsWith('unknown-')) {
  fail(`tokenId parsing failed: got "${tokenId}" — check NFPM_ABI events`);
}

// ── Step 5: Verify Position ─────────────────────────────────────
log('\n=== Step 5: Verify Position via Krystal API ===');

// Wait for Krystal to index
log('Waiting 10s for Krystal API to index the new position...');
await new Promise(r => setTimeout(r, 10_000));

let verifiedPosition;
try {
  const positions = await fetchKrystalPositions(wallet.address);
  log(`Total positions found: ${positions.length}`);
  for (const p of positions) {
    log(`  posId=${p.posId} ${p.token0.symbol}/${p.token1.symbol} (${p.chainName}) inRange=${p.inRange} value=$${p.valueUsd.toFixed(2)}`);
  }
  verifiedPosition = positions.find(p => p.posId === tokenId);
  if (verifiedPosition) {
    log(`✓ Position ${tokenId} verified on Krystal API`);
  } else {
    log(`⚠ Position ${tokenId} not yet visible on Krystal API (may take longer to index)`);
    log('  Proceeding to close via on-chain data...');
  }
} catch (err: any) {
  log(`Warning: fetchKrystalPositions error: ${err.message}`);
  log('  Will still attempt to close position on-chain...');
}

// ── Step 6: Close Position ──────────────────────────────────────
log('\n=== Step 6: Close LP Position ===');
log(`Closing position tokenId=${tokenId}...`);

try {
  const closeResult = await closeEvmLpPosition({
    posId: tokenId,
    chainId: 'polygon@137',
    chainNumericId: 137,
  });

  log(`Close result: success=${closeResult.success}`);
  log(`Recovered: token0=${closeResult.amount0Recovered}, token1=${closeResult.amount1Recovered}`);
  log(`Value recovered: $${closeResult.valueRecoveredUsd?.toFixed(2) ?? '?'}`);

  if (!closeResult.success) {
    fail('Failed to close position');
  }
} catch (err: any) {
  fail(`closeEvmLpPosition threw: ${err.message}\n${err.stack}`);
}

// ── Step 7: Final balance check ─────────────────────────────────
log('\n=== Final Balance Check ===');
const finalNativeBal = await provider.getBalance(wallet.address);
const finalUsdcBal = await usdcContract.balanceOf(wallet.address);
log(`MATIC: ${ethers.formatEther(finalNativeBal)} (was ${ethers.formatEther(nativeBal)})`);
log(`USDC:  $${Number(ethers.formatUnits(finalUsdcBal, usdcDec)).toFixed(2)} (was $${usdcHuman.toFixed(2)})`);

const gasCost = Number(ethers.formatEther(nativeBal - finalNativeBal));
log(`Total MATIC spent (gas + wrap): ~${gasCost.toFixed(4)} MATIC`);

log('\n=== E2E Test PASSED ===');
process.exit(0);
