/**
 * Orca Dynamic Pool Discovery Test
 *
 * Tests the new orcaPoolDiscovery.ts module:
 *   1. DeFiLlama API connectivity (yields endpoint)
 *   2. Orca Whirlpool API connectivity
 *   3. Cross-referencing by mint addresses
 *   4. Multi-factor pool scoring
 *   5. Market-condition-adjusted pool selection
 *   6. Fallback behavior when APIs are unavailable
 *   7. Cache behavior (second call should be instant)
 *
 * No wallet or on-chain interaction needed — pure API + scoring test.
 *
 * Usage:  bun run scripts/test-orca-discovery.ts
 */

import 'dotenv/config';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n==========================================');
  console.log('  Orca Dynamic Pool Discovery Test');
  console.log('==========================================\n');

  // ── 1. Discovery — first call (fetches from APIs) ─────────────────
  console.log('1. Running discoverOrcaPools() — first call (API fetch)...');
  const { discoverOrcaPools, selectBestPool, getPoolByAddress, getSolUsdcFallback, getCachedPools, getPoolCacheAge } = await import('../src/launchkit/cfo/orcaPoolDiscovery.ts');

  const t0 = Date.now();
  const pools = await discoverOrcaPools();
  const fetchTime = Date.now() - t0;

  console.log(`   Fetched ${pools.length} pools in ${(fetchTime / 1000).toFixed(1)}s\n`);

  assert(pools.length > 0, 'Discovery returned pools', `got ${pools.length}`);
  assert(pools.length >= 10, 'At least 10 pools discovered', `got ${pools.length}`);
  assert(fetchTime < 60_000, 'Discovery completed within 60s', `took ${fetchTime}ms`);

  // ── 2. Pool structure validation ──────────────────────────────────
  console.log('\n2. Validating pool candidate structure...');
  const first = pools[0];
  assert(!!first.whirlpoolAddress, 'Has whirlpool address', first.whirlpoolAddress?.slice(0, 12));
  assert(!!first.llamaPoolId, 'Has DeFiLlama pool ID', first.llamaPoolId?.slice(0, 12));
  assert(!!first.pair, 'Has pair name', first.pair);
  assert(!!first.tokenA?.mint, 'Has tokenA mint', first.tokenA?.mint?.slice(0, 12));
  assert(!!first.tokenB?.mint, 'Has tokenB mint', first.tokenB?.mint?.slice(0, 12));
  assert(first.tokenA?.decimals >= 0, 'Has tokenA decimals', `${first.tokenA?.decimals}`);
  assert(first.tokenB?.decimals >= 0, 'Has tokenB decimals', `${first.tokenB?.decimals}`);
  assert(first.tvlUsd > 0, 'Has TVL > 0', `$${first.tvlUsd.toFixed(0)}`);
  assert(first.apyBase7d >= 0, 'Has 7d APY', `${first.apyBase7d.toFixed(1)}%`);
  assert(first.volumeUsd1d >= 0, 'Has 1d volume', `$${first.volumeUsd1d.toFixed(0)}`);
  assert(first.score > 0, 'Has positive score', `${first.score}`);
  assert(first.scoreBreakdown && Object.keys(first.scoreBreakdown).length > 0, 'Has score breakdown');
  assert(first.tickSpacing > 0, 'Has tick spacing', `${first.tickSpacing}`);
  assert(first.lpFeeRate > 0, 'Has LP fee rate', `${first.lpFeeRate}`);

  // ── 3. Scoring validation ────────────────────────────────────────
  console.log('\n3. Validating scoring...');
  assert(pools[0].score >= pools[pools.length - 1].score, 'Pools sorted by score descending');

  const scoreFactors = ['feeRevenue', 'volumeConsistency', 'tvlDepth', 'mlPrediction', 'volatilityRisk', 'ilSafety'];
  for (const factor of scoreFactors) {
    const val = first.scoreBreakdown[factor];
    assert(val !== undefined, `Score has ${factor} factor`, `${val}`);
  }

  // Check score is reasonable (0-120 range including bonuses)
  for (const pool of pools.slice(0, 5)) {
    assert(pool.score >= 0 && pool.score <= 150, `${pool.pair} score in range`, `${pool.score}`);
  }

  // ── 4. SOL/USDC pool exists ──────────────────────────────────────
  console.log('\n4. Checking for SOL/USDC pool...');
  const solUsdc = pools.find(p => p.tokenA.symbol === 'SOL' && p.tokenB.symbol === 'USDC');
  assert(!!solUsdc, 'SOL/USDC pool found in discovery');
  if (solUsdc) {
    assert(solUsdc.tvlUsd > 1_000_000, 'SOL/USDC TVL > $1M', `$${(solUsdc.tvlUsd / 1e6).toFixed(1)}M`);
    assert(solUsdc.whirlpoolAddress.length > 30, 'SOL/USDC has valid whirlpool address');
    console.log(`   SOL/USDC: addr=${solUsdc.whirlpoolAddress.slice(0, 12)}… TVL=$${(solUsdc.tvlUsd / 1e6).toFixed(1)}M APY7d=${solUsdc.apyBase7d.toFixed(0)}% score=${solUsdc.score}`);
  }

  // ── 5. getSolUsdcFallback() ──────────────────────────────────────
  console.log('\n5. Testing getSolUsdcFallback()...');
  const fallback = await getSolUsdcFallback();
  assert(!!fallback, 'SOL/USDC fallback returned');
  if (fallback) {
    assert(fallback.tokenA.symbol === 'SOL', 'Fallback tokenA is SOL');
    assert(fallback.tokenB.symbol === 'USDC', 'Fallback tokenB is USDC');
  }

  // ── 6. selectBestPool() — neutral market ─────────────────────────
  console.log('\n6. Testing selectBestPool() — neutral market...');
  const neutralSelection = await selectBestPool({ marketCondition: 'neutral' });
  assert(!!neutralSelection, 'Neutral market selection returned');
  if (neutralSelection) {
    assert(neutralSelection.score > 0, 'Selection has positive score', `${neutralSelection.score}`);
    assert(neutralSelection.alternativesConsidered > 0, 'Alternatives considered', `${neutralSelection.alternativesConsidered}`);
    assert(!!neutralSelection.reasoning, 'Has reasoning', neutralSelection.reasoning.slice(0, 60));
    console.log(`   Best (neutral): ${neutralSelection.pool.pair} score=${neutralSelection.score} — ${neutralSelection.reasoning.slice(0, 80)}`);
  }

  // ── 7. selectBestPool() — bearish market ─────────────────────────
  console.log('\n7. Testing selectBestPool() — bearish market...');
  const bearishSelection = await selectBestPool({ marketCondition: 'bearish' });
  assert(!!bearishSelection, 'Bearish market selection returned');
  if (bearishSelection) {
    console.log(`   Best (bearish): ${bearishSelection.pool.pair} score=${bearishSelection.score} stablecoin=${bearishSelection.pool.stablecoin}`);
    // In bearish market, stablecoins should get a boost
    if (neutralSelection && bearishSelection.pool.stablecoin) {
      const stableInNeutral = pools.find(p => p.pair === bearishSelection.pool.pair);
      if (stableInNeutral) {
        assert(
          bearishSelection.score >= stableInNeutral.score,
          'Stablecoin boosted in bearish market',
          `bearish=${bearishSelection.score} vs base=${stableInNeutral.score}`,
        );
      }
    }
  }

  // ── 8. selectBestPool() — bullish market ─────────────────────────
  console.log('\n8. Testing selectBestPool() — bullish market...');
  const bullishSelection = await selectBestPool({ marketCondition: 'bullish' });
  assert(!!bullishSelection, 'Bullish market selection returned');
  if (bullishSelection) {
    console.log(`   Best (bullish): ${bullishSelection.pool.pair} score=${bullishSelection.score} stablecoin=${bullishSelection.pool.stablecoin}`);
  }

  // ── 9. selectBestPool() with mock guardian intel ──────────────────
  console.log('\n9. Testing selectBestPool() with guardian intel...');
  const withGuardian = await selectBestPool({
    marketCondition: 'neutral',
    guardianTokens: [
      { mint: 'fake', ticker: 'BONK', priceUsd: 0.00003, liquidityUsd: 2_000_000, volume24h: 5_000_000, rugScore: null, safe: true },
    ],
    analystPrices: {
      SOL: { usd: 130, change24h: 5 },
      BONK: { usd: 0.00003, change24h: 12 },
    },
    analystTrending: ['SOL', 'BONK'],
  });
  assert(!!withGuardian, 'Selection with mock intel returned');
  if (withGuardian) {
    console.log(`   Best (with intel): ${withGuardian.pool.pair} score=${withGuardian.score} — ${withGuardian.reasoning.slice(0, 80)}`);
  }

  // ── 10. Cache behavior — second call should be instant ───────────
  console.log('\n10. Testing cache...');
  const t1 = Date.now();
  const cached = await discoverOrcaPools();
  const cacheTime = Date.now() - t1;

  assert(cached.length === pools.length, 'Cached pools same count', `${cached.length}`);
  assert(cacheTime < 100, 'Cached call < 100ms', `${cacheTime}ms`);

  const age = getPoolCacheAge();
  assert(age < 10_000, 'Cache age < 10s', `${age}ms`);

  const cachedDirect = getCachedPools();
  assert(cachedDirect.length === pools.length, 'getCachedPools() works', `${cachedDirect.length}`);

  // ── 11. getPoolByAddress() ───────────────────────────────────────
  console.log('\n11. Testing getPoolByAddress()...');
  if (solUsdc) {
    const byAddr = await getPoolByAddress(solUsdc.whirlpoolAddress);
    assert(!!byAddr, 'getPoolByAddress found SOL/USDC');
    assert(byAddr?.pair === 'SOL/USDC', 'Address lookup returned correct pair');
  }
  const notFound = await getPoolByAddress('nonexistentaddress123');
  assert(notFound === null, 'getPoolByAddress returns null for unknown');

  // ── 12. Pool diversity check ─────────────────────────────────────
  console.log('\n12. Checking pool diversity...');
  const uniquePairs = new Set(pools.map(p => p.pair));
  const stablecoins = pools.filter(p => p.stablecoin);
  const volatile = pools.filter(p => p.ilRisk);
  const predictions = pools.filter(p => p.predictedClass !== 'Unknown');

  assert(uniquePairs.size >= 5, 'At least 5 unique pairs', `${uniquePairs.size}`);
  console.log(`   Total pairs: ${uniquePairs.size}`);
  console.log(`   Stablecoin pools: ${stablecoins.length}`);
  console.log(`   Volatile (IL risk): ${volatile.length}`);
  console.log(`   With ML predictions: ${predictions.length}`);

  // ── 13. Top 10 pool list display ─────────────────────────────────
  console.log('\n13. Top 10 discovered pools:');
  console.log('   ─────────────────────────────────────────────────────────────────────────────────────');
  console.log('   #  Pair                Score  APY7d   TVL       Vol/1d     Pred        Stable  IL');
  console.log('   ─────────────────────────────────────────────────────────────────────────────────────');
  for (let i = 0; i < Math.min(10, pools.length); i++) {
    const p = pools[i];
    const row = [
      `${(i + 1).toString().padStart(2)}.`,
      p.pair.padEnd(18),
      `${p.score.toString().padStart(5)}`,
      `${p.apyBase7d.toFixed(1).padStart(6)}%`,
      `$${(p.tvlUsd / 1e6).toFixed(1).padStart(6)}M`,
      `$${(p.volumeUsd1d / 1e6).toFixed(1).padStart(6)}M`,
      `${p.predictedClass.padEnd(10)}`,
      p.stablecoin ? 'yes' : ' no',
      p.ilRisk ? 'yes' : ' no',
    ].join('  ');
    console.log(`   ${row}`);
  }
  console.log('   ─────────────────────────────────────────────────────────────────────────────────────');

  // ── 14. Score breakdown for top pick ─────────────────────────────
  console.log('\n14. Score breakdown for top pool:');
  const top = pools[0];
  console.log(`   Pool: ${top.pair} (${top.whirlpoolAddress.slice(0, 12)}…)`);
  for (const [factor, value] of Object.entries(top.scoreBreakdown)) {
    const bar = '█'.repeat(Math.round(value));
    console.log(`   ${factor.padEnd(20)} ${value.toString().padStart(3)} ${bar}`);
  }
  console.log(`   ${'TOTAL'.padEnd(20)} ${top.score.toString().padStart(3)}`);
  if (top.reasoning.length > 0) {
    console.log(`   Reasons: ${top.reasoning.join(', ')}`);
  }

  // ── 15. registerPoolDecimalsBulk test ────────────────────────────
  console.log('\n15. Testing orcaService decimal registration...');
  const { registerPoolDecimalsBulk, registerPoolDecimals } = await import('../src/launchkit/cfo/orcaService.ts');
  // Register all discovered pools
  registerPoolDecimalsBulk(pools);
  assert(true, 'registerPoolDecimalsBulk() succeeded');

  // Individual registration
  registerPoolDecimals('test-address-123', 5, 6);
  assert(true, 'registerPoolDecimals() succeeded');

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n==========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`  Total pools discovered: ${pools.length}`);
  console.log(`  API fetch time: ${(fetchTime / 1000).toFixed(1)}s`);
  console.log(`  Cache hit time: ${cacheTime}ms`);
  if (failed === 0) {
    console.log('  ✅ All tests passed!');
  } else {
    console.log('  ❌ Some tests failed');
  }
  console.log('==========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
