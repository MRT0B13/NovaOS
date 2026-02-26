import 'dotenv/config';
import { refreshCandidatePools } from '../src/launchkit/cfo/evmArbService.ts';

const pools = await refreshCandidatePools();
console.log(`Total pools: ${pools.length}`);

const byDex = new Map<string, number>();
for (const p of pools) byDex.set(p.dex, (byDex.get(p.dex) ?? 0) + 1);
console.log('By venue:', Object.fromEntries(byDex));

// Cross-venue pairs
const pairVenues = new Map<string, Set<string>>();
for (const p of pools) {
  if (!pairVenues.has(p.pairKey)) pairVenues.set(p.pairKey, new Set());
  pairVenues.get(p.pairKey)!.add(p.dex);
}
const crossVenue = [...pairVenues.entries()].filter(([, v]) => v.size >= 2);
console.log(`\nCross-venue pairs: ${crossVenue.length}`);
for (const [key, venues] of crossVenue.slice(0, 15)) {
  const sample = pools.find(p => p.pairKey === key)!;
  console.log(`  ${sample.token0.symbol}/${sample.token1.symbol} → ${[...venues].join(', ')}`);
}

const balCross = crossVenue.filter(([, v]) => v.has('balancer'));
console.log(`\nBalancer cross-venue pairs: ${balCross.length}`);
for (const [key, venues] of balCross) {
  const sample = pools.find(p => p.pairKey === key)!;
  console.log(`  ${sample.token0.symbol}/${sample.token1.symbol} → ${[...venues].join(', ')}`);
}

// Show sample pairKeys to debug
console.log('\nSample WETH/WBTC pairKeys:');
for (const p of pools.filter(pp => pp.token0.symbol === 'WBTC' || pp.token1.symbol === 'WBTC')) {
  console.log(`  ${p.dex}: ${p.token0.symbol}/${p.token1.symbol} key=${p.pairKey.slice(0,25)}...`);
}
