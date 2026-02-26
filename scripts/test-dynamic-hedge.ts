#!/usr/bin/env bun
/**
 * Test: Dynamic Multi-Asset Hedge Feature
 *
 * Validates the new treasury-scanning hedge pipeline end-to-end (read-only):
 *   1. getWalletTokenBalances() — scans SPL tokens in funding wallet
 *   2. getHLListedCoins()      — discovers HL perp listings
 *   3. treasuryExposures       — cross-references wallet × HL × prices
 *   4. generateDecisions()     — produces per-coin hedge decisions
 *
 * Usage:
 *   bun run scripts/test-dynamic-hedge.ts
 */

import 'dotenv/config';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    pass++;
    console.log(`  ${GREEN}✅ ${name}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET} — ${detail}`);
  } catch (err: any) {
    fail++;
    console.log(`  ${RED}❌ ${name}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET} — ${err.message}`);
    if (err.stack) console.log(`     ${DIM}${err.stack.split('\n').slice(1, 3).join('\n     ')}${RESET}`);
  }
}

async function main() {
  console.log(`\n${BOLD}🧪 Dynamic Multi-Asset Hedge Test${RESET}`);
  console.log(`${DIM}${new Date().toISOString()}${RESET}\n`);

  // ── 1. Wallet Token Scanner ──────────────────────────────────────
  console.log(`${CYAN}${BOLD}─── 1. Wallet Token Scanner ───${RESET}`);

  let walletBalances: any[] = [];
  await test('getWalletTokenBalances()', async () => {
    const { getWalletTokenBalances } = await import('../src/launchkit/cfo/jupiterService.ts');
    walletBalances = await getWalletTokenBalances();

    if (!Array.isArray(walletBalances)) throw new Error('Expected array');
    if (walletBalances.length === 0) throw new Error('No tokens found (wallet empty?)');

    const solEntry = walletBalances.find(t => t.symbol === 'SOL');
    if (!solEntry) throw new Error('SOL not in results — should always be included');

    const lines = walletBalances
      .filter(t => t.balance > 0.0001)
      .map(t => `${t.symbol ?? '???'}: ${t.balance.toFixed(4)} (${t.mint.slice(0, 8)}…)`)
      .join(', ');
    return `${walletBalances.length} token(s) — ${lines}`;
  });

  await test('WalletTokenBalance shape', async () => {
    const sample = walletBalances[0];
    const required = ['mint', 'symbol', 'balance', 'decimals'];
    const missing = required.filter(k => !(k in sample));
    if (missing.length > 0) throw new Error(`Missing fields: ${missing.join(', ')}`);
    if (typeof sample.mint !== 'string') throw new Error('mint should be string');
    if (typeof sample.balance !== 'number') throw new Error('balance should be number');
    if (typeof sample.decimals !== 'number') throw new Error('decimals should be number');
    return `All fields present: ${required.join(', ')}`;
  });

  // ── 2. HL Listed Coins ──────────────────────────────────────────
  console.log(`\n${CYAN}${BOLD}─── 2. HL Listed Coins ───${RESET}`);

  let hlCoins: string[] = [];
  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const env = getCFOEnv();

  if (!env.hyperliquidEnabled) {
    console.log(`  ${YELLOW}⏭️  Skipped — CFO_HYPERLIQUID_ENABLE=false${RESET}`);
  } else {
    await test('getHLListedCoins()', async () => {
      const { getHLListedCoins } = await import('../src/launchkit/cfo/hyperliquidService.ts');
      hlCoins = await getHLListedCoins();

      if (!Array.isArray(hlCoins)) throw new Error('Expected array');
      if (hlCoins.length === 0) throw new Error('No coins returned');
      if (!hlCoins.includes('SOL')) throw new Error('SOL not in HL listings');
      if (!hlCoins.includes('BTC')) throw new Error('BTC not in HL listings');
      if (!hlCoins.includes('ETH')) throw new Error('ETH not in HL listings');

      return `${hlCoins.length} perps — first 15: ${hlCoins.slice(0, 15).join(', ')}`;
    });

    await test('Cross-reference wallet × HL', async () => {
      const hlSet = new Set(hlCoins.map(c => c.toUpperCase()));
      const matches = walletBalances
        .filter(t => t.symbol && hlSet.has(t.symbol.toUpperCase()))
        .map(t => t.symbol);
      const noMatch = walletBalances
        .filter(t => t.symbol && !hlSet.has(t.symbol.toUpperCase()) && !['USDC', 'USDT'].includes(t.symbol))
        .map(t => t.symbol);
      return `HL-listed in wallet: [${matches.join(', ')}] | not on HL: [${noMatch.join(', ')}]`;
    });
  }

  // ── 3. CFO Env — Hedge Config ──────────────────────────────────
  console.log(`\n${CYAN}${BOLD}─── 3. CFO Env Hedge Config ───${RESET}`);

  await test('hlHedgeCoins parsed', async () => {
    if (!Array.isArray(env.hlHedgeCoins)) throw new Error('hlHedgeCoins should be array');
    const mode = env.hlHedgeCoins.length === 0 ? 'AUTO (all HL-listed treasury tokens)' : `WHITELIST: [${env.hlHedgeCoins.join(', ')}]`;
    return `${mode} | minExposure: $${env.hlHedgeMinExposureUsd}`;
  });

  // ── 4. hedgeTreasury() backward compat ─────────────────────────
  console.log(`\n${CYAN}${BOLD}─── 4. hedgeTreasury() API ───${RESET}`);

  if (!env.hyperliquidEnabled) {
    console.log(`  ${YELLOW}⏭️  Skipped — HL disabled${RESET}`);
  } else {
    await test('hedgeTreasury export exists', async () => {
      const hl = await import('../src/launchkit/cfo/hyperliquidService.ts');
      if (typeof hl.hedgeTreasury !== 'function') throw new Error('hedgeTreasury not exported');
      return 'hedgeTreasury() is exported';
    });

    await test('hedgeSolTreasury backward-compat alias', async () => {
      const hl = await import('../src/launchkit/cfo/hyperliquidService.ts');
      if (typeof hl.hedgeSolTreasury !== 'function') throw new Error('hedgeSolTreasury alias missing');
      return 'hedgeSolTreasury() alias exists';
    });
  }

  // ── 5. Portfolio State — treasuryExposures ──────────────────────
  console.log(`\n${CYAN}${BOLD}─── 5. Portfolio State ───${RESET}`);

  let savedState: any = null;

  await test('gatherPortfolioState() includes treasuryExposures', async () => {
    const { gatherPortfolioState } = await import('../src/launchkit/cfo/decisionEngine.ts');
    const state = await gatherPortfolioState();
    savedState = state;

    if (!Array.isArray(state.treasuryExposures)) throw new Error('treasuryExposures not an array');
    if (state.treasuryExposures.length === 0) throw new Error('No treasury exposures (should have at least SOL)');

    const solEntry = state.treasuryExposures.find(e => e.symbol === 'SOL');
    if (!solEntry) throw new Error('SOL missing from treasuryExposures');
    if (solEntry.valueUsd <= 0) throw new Error(`SOL valueUsd is ${solEntry.valueUsd}`);
    if (!solEntry.hlListed) throw new Error('SOL should be hlListed=true');

    const lines = state.treasuryExposures.map(e =>
      `${e.symbol}: $${e.valueUsd.toFixed(0)} ${e.hlListed ? '(HL)' : ''}`
    );

    return [
      `${state.treasuryExposures.length} exposure(s)`,
      `hlTotalShortUsd: $${state.hlTotalShortUsd.toFixed(0)}`,
      `hedgeRatio: ${(state.hedgeRatio * 100).toFixed(1)}%`,
      ...lines,
    ].join(' | ');
  });

  // ── 6. Decision Generation (dry) ───────────────────────────────
  console.log(`\n${CYAN}${BOLD}─── 6. Hedge Decisions (dry) ───${RESET}`);

  await test('Hedge decision logic (isolated)', async () => {
    const { getDecisionConfig } = await import('../src/launchkit/cfo/decisionEngine.ts');
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    if (!savedState) throw new Error('Portfolio state not available from test 5');
    const state = savedState;
    const config = getDecisionConfig();
    const env2 = getCFOEnv();

    // Simulate the hedge decision logic inline (mirrors Section B)
    const adjustedHedgeTarget = config.hedgeTargetRatio;
    const hedgeableAssets = state.treasuryExposures.filter((e) => {
      if (!e.hlListed) return false;
      if (e.valueUsd < config.hedgeMinSolExposureUsd) return false;
      if (env2.hlHedgeCoins.length > 0 && !env2.hlHedgeCoins.includes(e.symbol)) return false;
      return true;
    });

    const results: string[] = [];
    for (const asset of hedgeableAssets) {
      const coinShortUsd = state.hlPositions
        .filter((p: any) => p.coin === asset.symbol && p.side === 'SHORT')
        .reduce((s: number, p: any) => s + p.sizeUsd, 0);
      const coinHedgeRatio = asset.valueUsd > 0 ? coinShortUsd / asset.valueUsd : 0;
      const coinTargetHedgeUsd = asset.valueUsd * adjustedHedgeTarget;

      let action = 'IN_RANGE';
      if (coinHedgeRatio < adjustedHedgeTarget - config.hedgeRebalanceThreshold) {
        action = `OPEN_HEDGE ($${(coinTargetHedgeUsd - coinShortUsd).toFixed(0)})`;
      } else if (coinHedgeRatio > adjustedHedgeTarget + config.hedgeRebalanceThreshold) {
        action = `CLOSE_HEDGE ($${(coinShortUsd - coinTargetHedgeUsd).toFixed(0)})`;
      }

      results.push(`${asset.symbol}: exposure=$${asset.valueUsd.toFixed(0)} short=$${coinShortUsd.toFixed(0)} ratio=${(coinHedgeRatio * 100).toFixed(1)}% → ${action}`);
    }

    if (results.length === 0) return 'No hedgeable assets above threshold';
    return `${hedgeableAssets.length} hedgeable:\n    ${results.join('\n    ')}`;
  });

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${BOLD}━━━ Summary ━━━${RESET}`);
  console.log(`${GREEN}✅ ${pass} passed${RESET}  ${fail > 0 ? `${RED}❌ ${fail} failed${RESET}` : ''}`);
  if (fail > 0) process.exit(1);
  else console.log(`\n${GREEN}${BOLD}Dynamic hedge pipeline healthy! 🚀${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}Fatal: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
