#!/usr/bin/env bun
/**
 * Polymarket Token Resolution Test — dry run only, NO trades.
 *
 * Simulates the exact POLY_BET execution path from decisionEngine:
 *   1. scanOpportunities() → get markets + tokenIds
 *   2. fetchMarket(conditionId) → re-fetch each market
 *   3. Token lookup: exact tokenId match → outcome fallback
 *   4. Price validation: reject 0 or invalid prices
 *   5. Order math: compute maker/taker amounts, verify no Infinity/NaN
 *
 * Usage:
 *   bun run scripts/test-poly-token-resolution.ts
 */

import 'dotenv/config';
import {
  fetchCryptoMarkets,
  fetchMarket,
  scanOpportunities,
} from '../src/launchkit/cfo/polymarketService.ts';

// ── Colors ──
const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const ok  = (msg: string) => console.log(`  ${G}✅ ${msg}${X}`);
const fail = (msg: string) => console.log(`  ${R}❌ ${msg}${X}`);
const warn = (msg: string) => console.log(`  ${Y}⚠️  ${msg}${X}`);
const info = (msg: string) => console.log(`  ${D}${msg}${X}`);

let passed = 0;
let failed = 0;
let warnings = 0;

// ── Simulate buildSignedOrder math (no wallet/signing) ──
function simulateOrderMath(
  pricePerShare: number,
  sizeUsdc: number,
  side: 0 | 1,
): { makerAmount: string; takerAmount: string; valid: boolean; error?: string } {
  if (!pricePerShare || pricePerShare <= 0) {
    return { makerAmount: '0', takerAmount: '0', valid: false, error: `pricePerShare=${pricePerShare} (≤ 0)` };
  }
  if (pricePerShare >= 1) {
    return { makerAmount: '0', takerAmount: '0', valid: false, error: `pricePerShare=${pricePerShare} (≥ 1)` };
  }

  const DECIMALS = 6;
  let maker: number;
  let taker: number;

  if (side === 0) {
    maker = Math.floor(sizeUsdc * 10 ** DECIMALS);
    taker = Math.floor((sizeUsdc / pricePerShare) * 10 ** DECIMALS);
  } else {
    const tokenAmt = sizeUsdc / pricePerShare;
    maker = Math.floor(tokenAmt * 10 ** DECIMALS);
    taker = Math.floor(sizeUsdc * 10 ** DECIMALS);
  }

  if (!Number.isFinite(maker) || !Number.isFinite(taker)) {
    return { makerAmount: String(maker), takerAmount: String(taker), valid: false, error: 'Infinity/NaN in amounts' };
  }
  if (maker <= 0 || taker <= 0) {
    return { makerAmount: String(maker), takerAmount: String(taker), valid: false, error: 'Zero/negative amount' };
  }

  // Verify BigInt parse won't fail
  try {
    BigInt(maker.toString());
    BigInt(taker.toString());
  } catch (e) {
    return { makerAmount: String(maker), takerAmount: String(taker), valid: false, error: `BigInt parse: ${e}` };
  }

  return { makerAmount: maker.toString(), takerAmount: taker.toString(), valid: true };
}

async function main() {
  console.log(`\n${B}${C}═══ Polymarket Token Resolution Test (DRY RUN) ═══${X}\n`);

  // ── Step 1: Fetch crypto markets ──
  console.log(`${B}Step 1: Fetch crypto markets${X}`);
  const markets = await fetchCryptoMarkets();
  if (markets.length === 0) {
    fail('No crypto markets returned from Gamma API');
    failed++;
    return printSummary();
  }
  ok(`${markets.length} crypto markets fetched`);
  passed++;

  // Show first 3
  for (const m of markets.slice(0, 3)) {
    const tokens = m.tokens.map(t => `${t.outcome}:${t.price.toFixed(3)}:${t.tokenId.slice(0, 12)}…`).join(', ');
    info(`  "${m.question.slice(0, 65)}…" [${tokens}]`);
  }

  // ── Step 2: Scan opportunities ──
  console.log(`\n${B}Step 2: Scan opportunities (bankroll=$100)${X}`);
  const opps = await scanOpportunities(100);
  if (opps.length === 0) {
    warn('No opportunities found (edge too small or low confidence) — this is normal');
    warnings++;
  } else {
    ok(`${opps.length} opportunities found`);
    passed++;
  }

  // Use either real opportunities or fake one from markets[0] for testing
  const testCases: { conditionId: string; tokenId: string; side: string; price: number; question: string }[] = [];

  for (const opp of opps.slice(0, 3)) {
    testCases.push({
      conditionId: opp.market.conditionId,
      tokenId: opp.targetToken.tokenId,
      side: opp.targetToken.outcome,
      price: opp.marketProb,
      question: opp.market.question.slice(0, 60),
    });
  }

  // Also add first market as a baseline test even if no opportunities
  if (markets.length > 0 && testCases.length < 2) {
    const m = markets[0];
    const t = m.tokens[0];
    if (t) {
      testCases.push({
        conditionId: m.conditionId,
        tokenId: t.tokenId,
        side: t.outcome,
        price: t.price,
        question: m.question.slice(0, 60),
      });
    }
  }

  // ── Step 3: Token resolution (the actual bug path) ──
  console.log(`\n${B}Step 3: Token resolution — simulate POLY_BET execution${X}`);
  for (const tc of testCases) {
    console.log(`\n  ${C}Market: "${tc.question}…"${X}`);
    info(`  conditionId: ${tc.conditionId.slice(0, 20)}…`);
    info(`  scan tokenId: ${tc.tokenId.slice(0, 20)}… (${tc.side})`);
    info(`  scan price: ${tc.price}`);

    // Re-fetch market (same as decisionEngine does)
    const market = await fetchMarket(tc.conditionId);
    if (!market) {
      fail(`fetchMarket returned null for conditionId=${tc.conditionId.slice(0, 20)}`);
      failed++;
      continue;
    }

    // Show available tokens
    for (const t of market.tokens) {
      info(`  fetched token: ${t.outcome} price=${t.price.toFixed(4)} id=${t.tokenId.slice(0, 20)}…`);
    }

    // Primary: exact tokenId match
    let token = market.tokens.find(t => t.tokenId === tc.tokenId);
    let resolution: string;

    if (token) {
      resolution = 'exact tokenId match';
      ok(`Token resolved via exact tokenId match ✓`);
      passed++;
    } else {
      // Fallback: outcome match
      const sideNorm = tc.side.toLowerCase();
      token = market.tokens.find(t => t.outcome.toLowerCase() === (sideNorm === 'yes' ? 'yes' : 'no'));
      if (token) {
        resolution = 'outcome fallback';
        warn(`tokenId MISMATCH — resolved via outcome='${tc.side}'`);
        info(`  stored:   ${tc.tokenId}`);
        info(`  resolved: ${token.tokenId}`);
        warnings++;
      } else {
        resolution = 'FAILED';
        fail(`Token NOT FOUND — no exact match, no outcome match`);
        info(`  stored tokenId: ${tc.tokenId}`);
        info(`  available: ${market.tokens.map(t => `${t.outcome}:${t.tokenId.slice(0, 12)}`).join(', ')}`);
        failed++;
        continue;
      }
    }

    // ── Step 4: Price validation ──
    let effectivePrice = token.price;
    if (!effectivePrice || effectivePrice <= 0) {
      if (tc.price > 0 && tc.price < 1) {
        warn(`Resolved token has price=${token.price}, falling back to scan-time price=${tc.price}`);
        effectivePrice = tc.price;
        warnings++;
      } else {
        fail(`Token price invalid (${token.price}) and no valid scan-time fallback`);
        failed++;
        continue;
      }
    }
    if (effectivePrice >= 1) {
      fail(`Token price >= 1 (${effectivePrice}) — would be rejected by placeBuyOrder`);
      failed++;
      continue;
    }

    // ── Step 5: Order math simulation ──
    const sizeUsd = 3; // use tiny test amount
    const result = simulateOrderMath(effectivePrice, sizeUsd, 0);
    if (result.valid) {
      ok(`Order math OK (${resolution}) — maker=${result.makerAmount} taker=${result.takerAmount}`);
      passed++;
    } else {
      fail(`Order math FAILED: ${result.error}`);
      info(`  pricePerShare=${effectivePrice}, sizeUsdc=${sizeUsd}`);
      failed++;
    }
  }

  // ── Step 4 bonus: test edge case — zero price ──
  console.log(`\n${B}Step 4: Edge case — zero price guard${X}`);
  const zeroResult = simulateOrderMath(0, 3, 0);
  if (!zeroResult.valid) {
    ok(`Zero price correctly rejected: ${zeroResult.error}`);
    passed++;
  } else {
    fail('Zero price was NOT rejected — guard is broken');
    failed++;
  }

  const negResult = simulateOrderMath(-0.5, 3, 0);
  if (!negResult.valid) {
    ok(`Negative price correctly rejected: ${negResult.error}`);
    passed++;
  } else {
    fail('Negative price was NOT rejected');
    failed++;
  }

  const oneResult = simulateOrderMath(1.0, 3, 0);
  if (!oneResult.valid) {
    ok(`Price >= 1 correctly rejected: ${oneResult.error}`);
    passed++;
  } else {
    fail('Price >= 1 was NOT rejected');
    failed++;
  }

  printSummary();
}

function printSummary() {
  console.log(`\n${B}${C}═══ Summary ═══${X}`);
  console.log(`  ${G}Passed:${X}   ${passed}`);
  if (warnings > 0) console.log(`  ${Y}Warnings:${X} ${warnings}`);
  if (failed > 0) console.log(`  ${R}Failed:${X}   ${failed}`);
  console.log(`  ${D}No trades were sent.${X}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}Fatal error:${X}`, err);
  process.exit(1);
});
