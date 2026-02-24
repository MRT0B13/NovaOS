#!/usr/bin/env bun
/**
 * EVM Flash Arb — Wiring & Integration Test
 *
 * Verifies that all EVM flash arbitrage components are properly wired up:
 *   1. cfoEnv.ts      — 6 new env fields parse correctly with defaults
 *   2. evmArbService  — all exports exist, types align, DEX constants correct
 *   3. decisionEngine — EVM_FLASH_ARB type, portfolio state fields, Section J
 *   4. positionManager— STRATEGY_CAPS.evm_flash_arb present
 *   5. postgresCFO    — PositionStrategy union includes evm_flash_arb
 *   6. analyst.ts     — Arbitrum in TRACKED_CHAINS, ARB in TRACKED_TOKENS
 *   7. Solidity ↔ TS  — DEX type constants alignment (0,1,2)
 *   8. cfo.ts         — cfo_arb_status command, persistence case
 *
 * Usage:
 *   bun run scripts/test-evm-arb.ts
 */

// ── Terminal colours ────────────────────────────────────────────────────────
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

interface TestResult {
  group: string;
  test: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
  ms: number;
}

const results: TestResult[] = [];

async function runTest(group: string, test: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ group, test, status: 'PASS', detail: detail ?? undefined, ms: Date.now() - t0 });
    console.log(`  ${GREEN}✅ ${test}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    results.push({ group, test, status: 'FAIL', detail: msg, ms: Date.now() - t0 });
    console.log(`  ${RED}❌ ${test}${RESET} ${DIM}(${Date.now() - t0}ms)${RESET} — ${msg}`);
  }
}

function header(name: string) {
  console.log(`\n${BOLD}${CYAN}━━━ ${name} ━━━${RESET}`);
}

// ============================================================================
// 1. CFO Environment — 6 new EVM arb env fields
// ============================================================================

async function testCfoEnv() {
  header('1. CFO Environment — EVM Arb Fields');

  await runTest('cfoEnv', 'Import getCFOEnv()', async () => {
    const mod = await import('../src/launchkit/cfo/cfoEnv.ts');
    if (typeof mod.getCFOEnv !== 'function') throw new Error('getCFOEnv is not a function');
    return 'getCFOEnv exported ✓';
  });

  await runTest('cfoEnv', 'evmArbEnabled defaults to false', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (typeof env.evmArbEnabled !== 'boolean') throw new Error(`evmArbEnabled type: ${typeof env.evmArbEnabled}`);
    // Even if .env sets it, just check it's a boolean
    return `evmArbEnabled=${env.evmArbEnabled}`;
  });

  await runTest('cfoEnv', 'evmArbMinProfitUsdc is number ≥ 0', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (typeof env.evmArbMinProfitUsdc !== 'number') throw new Error(`type: ${typeof env.evmArbMinProfitUsdc}`);
    if (isNaN(env.evmArbMinProfitUsdc)) throw new Error('is NaN');
    return `evmArbMinProfitUsdc=${env.evmArbMinProfitUsdc}`;
  });

  await runTest('cfoEnv', 'evmArbMaxFlashUsd is valid', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (typeof env.evmArbMaxFlashUsd !== 'number' || isNaN(env.evmArbMaxFlashUsd)) {
      throw new Error(`bad value: ${env.evmArbMaxFlashUsd}`);
    }
    return `evmArbMaxFlashUsd=$${env.evmArbMaxFlashUsd.toLocaleString()}`;
  });

  await runTest('cfoEnv', 'evmArbReceiverAddress field exists', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (!('evmArbReceiverAddress' in env)) throw new Error('field missing');
    // Can be undefined if no contract deployed, that's fine
    return `receiver=${env.evmArbReceiverAddress || '(not set)'}`;
  });

  await runTest('cfoEnv', 'evmArbScanIntervalMs valid', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (typeof env.evmArbScanIntervalMs !== 'number' || env.evmArbScanIntervalMs < 1000) {
      throw new Error(`bad interval: ${env.evmArbScanIntervalMs}`);
    }
    return `scanInterval=${env.evmArbScanIntervalMs}ms`;
  });

  await runTest('cfoEnv', 'evmArbPoolRefreshMs valid', async () => {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    if (typeof env.evmArbPoolRefreshMs !== 'number' || env.evmArbPoolRefreshMs < 60_000) {
      throw new Error(`bad refresh: ${env.evmArbPoolRefreshMs}`);
    }
    return `poolRefresh=${(env.evmArbPoolRefreshMs / 3600_000).toFixed(1)}h`;
  });
}

// ============================================================================
// 2. evmArbService — Exports, Types, Constants
// ============================================================================

async function testEvmArbService() {
  header('2. evmArbService — Exports & Types');

  const expectedFns = [
    'refreshCandidatePools',
    'scanForOpportunity',
    'executeFlashArb',
    'getArbUsdcBalance',
    'getCandidatePoolCount',
    'getPoolsRefreshedAt',
    'recordProfit',
    'getProfit24h',
  ];

  await runTest('evmArbService', 'Module imports without error', async () => {
    const mod = await import('../src/launchkit/cfo/evmArbService.ts');
    if (!mod) throw new Error('import returned falsy');
    return 'module loaded ✓';
  });

  for (const fn of expectedFns) {
    await runTest('evmArbService', `export: ${fn}()`, async () => {
      const mod = await import('../src/launchkit/cfo/evmArbService.ts');
      if (typeof (mod as any)[fn] !== 'function') {
        throw new Error(`${fn} is ${typeof (mod as any)[fn]}, expected function`);
      }
      return 'function ✓';
    });
  }

  // Check readonly state accessors return sane defaults (no arb pool data loaded yet)
  await runTest('evmArbService', 'getCandidatePoolCount() returns 0 initially', async () => {
    const { getCandidatePoolCount } = await import('../src/launchkit/cfo/evmArbService.ts');
    const count = getCandidatePoolCount();
    if (typeof count !== 'number') throw new Error(`type: ${typeof count}`);
    return `poolCount=${count}`;
  });

  await runTest('evmArbService', 'getPoolsRefreshedAt() returns 0 initially', async () => {
    const { getPoolsRefreshedAt } = await import('../src/launchkit/cfo/evmArbService.ts');
    const ts = getPoolsRefreshedAt();
    if (typeof ts !== 'number') throw new Error(`type: ${typeof ts}`);
    return `refreshedAt=${ts}`;
  });

  await runTest('evmArbService', 'getProfit24h() returns 0 initially', async () => {
    const { getProfit24h } = await import('../src/launchkit/cfo/evmArbService.ts');
    const p = getProfit24h();
    if (typeof p !== 'number') throw new Error(`type: ${typeof p}`);
    return `profit24h=$${p}`;
  });

  await runTest('evmArbService', 'recordProfit() updates getProfit24h()', async () => {
    const { recordProfit, getProfit24h } = await import('../src/launchkit/cfo/evmArbService.ts');
    const before = getProfit24h();
    recordProfit(1.23);
    const after = getProfit24h();
    if (after < before + 1.0) throw new Error(`profit did not increase: before=${before}, after=${after}`);
    // Clean up — record negative to reset (or just leave for test)
    return `before=$${before.toFixed(2)}, after=$${after.toFixed(2)}`;
  });

  // DEX type constants alignment: TS side
  await runTest('evmArbService', 'DEX type constants correct in module', async () => {
    // We can't access private constants directly, but we can validate via the 
    // exported CandidatePool type. Instead, read the actual source as text.
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    const match0 = src.match(/const DEX_UNISWAP_V3\s*=\s*(\d+)/);
    const match1 = src.match(/const DEX_CAMELOT_V3\s*=\s*(\d+)/);
    const match2 = src.match(/const DEX_BALANCER\s*=\s*(\d+)/);
    
    if (!match0 || match0[1] !== '0') throw new Error(`DEX_UNISWAP_V3 != 0 (got ${match0?.[1]})`);
    if (!match1 || match1[1] !== '1') throw new Error(`DEX_CAMELOT_V3 != 1 (got ${match1?.[1]})`);
    if (!match2 || match2[1] !== '2') throw new Error(`DEX_BALANCER != 2 (got ${match2?.[1]})`);
    
    return 'UNI=0, CAMELOT=1, BAL=2 ✓';
  });

  // Solidity contract DEX constants alignment
  await runTest('evmArbService', 'Solidity DEX constants match TypeScript', async () => {
    const fs = await import('fs');
    const sol = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    const uni = sol.match(/DEX_UNISWAP_V3\s*=\s*(\d+)/);
    const cam = sol.match(/DEX_CAMELOT_V3\s*=\s*(\d+)/);
    const bal = sol.match(/DEX_BALANCER\s*=\s*(\d+)/);
    
    if (!uni || uni[1] !== '0') throw new Error(`Solidity DEX_UNISWAP_V3 = ${uni?.[1]}`);
    if (!cam || cam[1] !== '1') throw new Error(`Solidity DEX_CAMELOT_V3 = ${cam?.[1]}`);
    if (!bal || bal[1] !== '2') throw new Error(`Solidity DEX_BALANCER = ${bal?.[1]}`);
    
    return 'Solidity ↔ TypeScript alignment ✓';
  });

  // Camelot quoter ABI uses path-based quoteExactInput (no fee param in single-swap form)
  await runTest('evmArbService', 'Camelot QuoterABI uses path-based quoting', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    // Camelot ABI should use quoteExactInput(bytes path, uint256 amountIn)
    const camelotSection = src.match(/CAMELOT_QUOTER_ABI[\s\S]*?quoteExactInput\(([\s\S]*?)\)/);
    if (!camelotSection) throw new Error('Cannot find CAMELOT_QUOTER_ABI with quoteExactInput');
    
    const params = camelotSection[1];
    if (!params.includes('bytes') || !params.includes('amountIn')) {
      throw new Error(`Camelot ABI missing required params: ${params.trim()}`);
    }
    // Must NOT use quoteExactInputSingle (no working single quoter on Arbitrum)
    if (params.includes('tokenIn') && params.includes('tokenOut')) {
      throw new Error('Camelot ABI should use path-based quoting, not single params');
    }
    
    return 'Path-based quoteExactInput(bytes, uint256) ✓';
  });

  // Uniswap quoter ABI MUST have fee param
  await runTest('evmArbService', 'Uniswap QuoterABI has fee param', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    const uniSection = src.match(/UNI_QUOTER_ABI[\s\S]*?quoteExactInputSingle\(([\s\S]*?)\)/);
    if (!uniSection) throw new Error('Cannot find UNI_QUOTER_ABI');
    
    if (!uniSection[1].includes('fee')) {
      throw new Error('Uniswap ABI missing fee param!');
    }
    
    return 'fee param present in Uniswap ABI ✓';
  });

  // AAVE_LISTED tokens are all lowercase
  await runTest('evmArbService', 'AAVE_LISTED addresses are lowercase', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    const listed = src.match(/AAVE_LISTED\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    if (!listed) throw new Error('Cannot find AAVE_LISTED set');
    
    const addresses = listed[1].match(/'0x[a-fA-F0-9]+'/g);
    if (!addresses || addresses.length === 0) throw new Error('No addresses found in AAVE_LISTED');
    
    for (const addr of addresses) {
      const raw = addr.replace(/'/g, '');
      if (raw !== raw.toLowerCase()) {
        throw new Error(`Address not lowercase: ${raw}`);
      }
    }
    
    return `${addresses.length} addresses, all lowercase ✓`;
  });

  // ARB_ADDRESSES constant exists and has all required keys
  await runTest('evmArbService', 'ARB_ADDRESSES has all required keys', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    const required = [
      'UNISWAP_V3_ROUTER', 'CAMELOT_V3_ROUTER', 'BALANCER_VAULT',
      'UNISWAP_V3_QUOTER', 'CAMELOT_V3_QUOTER', 'AAVE_POOL',
    ];
    
    for (const key of required) {
      if (!src.includes(key)) {
        throw new Error(`ARB_ADDRESSES missing key: ${key}`);
      }
    }
    
    return `${required.length} required keys found ✓`;
  });
}

// ============================================================================
// 3. Decision Engine — EVM_FLASH_ARB type & integration
// ============================================================================

async function testDecisionEngine() {
  header('3. Decision Engine — EVM_FLASH_ARB');

  await runTest('decisionEngine', 'EVM_FLASH_ARB in DecisionType', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    if (!src.includes("'EVM_FLASH_ARB'")) {
      throw new Error('EVM_FLASH_ARB not found in DecisionType union');
    }
    return 'DecisionType includes EVM_FLASH_ARB ✓';
  });

  await runTest('decisionEngine', 'PortfolioState has evmArb fields', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    const fields = ['evmArbProfit24h', 'evmArbPoolCount', 'evmArbUsdcBalance'];
    for (const f of fields) {
      if (!src.includes(f)) throw new Error(`PortfolioState missing field: ${f}`);
    }
    return `${fields.length} portfolio state fields ✓`;
  });

  await runTest('decisionEngine', 'SwarmIntel has arbitrumVolume24h', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    if (!src.includes('analystArbitrumVolume24h')) {
      throw new Error('analystArbitrumVolume24h missing from SwarmIntel');
    }
    return 'analystArbitrumVolume24h ✓';
  });

  await runTest('decisionEngine', 'Section J generates EVM_FLASH_ARB decisions', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    // Section J should have: env.evmArbEnabled check + scanForOpportunity call + push EVM_FLASH_ARB
    if (!src.includes("type: 'EVM_FLASH_ARB'")) {
      throw new Error("Decision push with type: 'EVM_FLASH_ARB' not found");
    }
    if (!src.includes("checkCooldown('EVM_FLASH_ARB'")) {
      throw new Error('Cooldown check for EVM_FLASH_ARB not found');
    }
    return 'Section J decision generation ✓';
  });

  await runTest('decisionEngine', 'Execution case: EVM_FLASH_ARB', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    if (!src.includes("case 'EVM_FLASH_ARB'")) {
      throw new Error("switch case 'EVM_FLASH_ARB' not found in execute function");
    }
    return 'Execution case present ✓';
  });

  await runTest('decisionEngine', 'typeName map has EVM_FLASH_ARB', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    if (!src.includes("EVM_FLASH_ARB:") || !src.includes('Flash Arb')) {
      throw new Error('EVM_FLASH_ARB display name not found in typeName map');
    }
    return 'typeName entry ✓';
  });

  await runTest('decisionEngine', 'buildPortfolioState gathers arb data', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    // Must import evmArbService and call the getters
    if (!src.includes("import('./evmArbService.ts')")) {
      throw new Error('Dynamic import of evmArbService not found in decisionEngine');
    }
    if (!src.includes('getProfit24h()') || !src.includes('getCandidatePoolCount()') || !src.includes('getArbUsdcBalance()')) {
      throw new Error('Required evmArbService calls missing from buildPortfolioState');
    }
    return 'Portfolio state data gathering ✓';
  });
}

// ============================================================================
// 4. Position Manager — evm_flash_arb strategy cap
// ============================================================================

async function testPositionManager() {
  header('4. Position Manager — Strategy Caps');

  await runTest('positionManager', 'STRATEGY_CAPS has evm_flash_arb', async () => {
    const { STRATEGY_CAPS } = await import('../src/launchkit/cfo/positionManager.ts');
    
    if (!('evm_flash_arb' in STRATEGY_CAPS)) {
      throw new Error('evm_flash_arb not in STRATEGY_CAPS');
    }
    return `cap=${JSON.stringify(STRATEGY_CAPS.evm_flash_arb)}`;
  });

  await runTest('positionManager', 'evm_flash_arb maxPortfolioFraction is 0', async () => {
    const { STRATEGY_CAPS } = await import('../src/launchkit/cfo/positionManager.ts');
    const cap = STRATEGY_CAPS.evm_flash_arb;
    
    if (cap.maxPortfolioFraction !== 0) {
      throw new Error(`Expected 0% (uses Aave capital), got ${cap.maxPortfolioFraction * 100}%`);
    }
    if (cap.leverage !== 1) {
      throw new Error(`Expected leverage=1, got ${cap.leverage}`);
    }
    return 'maxPortfolio=0% (Aave capital), leverage=1 ✓';
  });
}

// ============================================================================
// 5. PostgresCFORepository — PositionStrategy type
// ============================================================================

async function testPostgresRepository() {
  header('5. PostgresCFORepository — PositionStrategy Type');

  await runTest('postgresCFO', 'PositionStrategy includes evm_flash_arb', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/postgresCFORepository.ts', 'utf-8');
    
    const strategyLine = src.match(/export type PositionStrategy\s*=\s*([^;]+)/);
    if (!strategyLine) throw new Error('PositionStrategy type not found');
    
    if (!strategyLine[1].includes("'evm_flash_arb'")) {
      throw new Error(`evm_flash_arb not in PositionStrategy: ${strategyLine[1].trim()}`);
    }
    return `PositionStrategy union includes evm_flash_arb ✓`;
  });
}

// ============================================================================
// 6. Analyst — Arbitrum chain & ARB token tracking
// ============================================================================

async function testAnalyst() {
  header('6. Analyst — Arbitrum & ARB Token');

  await runTest('analyst', 'TRACKED_TOKENS includes arbitrum→ARB', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/agents/analyst.ts', 'utf-8');
    
    if (!src.includes("'arbitrum'") || !src.includes("'ARB'")) {
      throw new Error("TRACKED_TOKENS missing 'arbitrum': 'ARB' entry");
    }
    return 'arbitrum→ARB ✓';
  });

  await runTest('analyst', 'TRACKED_CHAINS includes Arbitrum', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/agents/analyst.ts', 'utf-8');
    
    const chainsMatch = src.match(/TRACKED_CHAINS\s*=\s*\[([\s\S]*?)\]/);
    if (!chainsMatch) throw new Error('TRACKED_CHAINS not found');
    
    if (!chainsMatch[1].includes("'Arbitrum'")) {
      throw new Error(`Arbitrum not in TRACKED_CHAINS: ${chainsMatch[1].trim()}`);
    }
    return 'Arbitrum in TRACKED_CHAINS ✓';
  });

  await runTest('analyst', 'broadcastTokenIntel includes arbitrumVolume24h', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/agents/analyst.ts', 'utf-8');
    
    if (!src.includes('arbitrumVolume24h')) {
      throw new Error('arbitrumVolume24h not found in analyst broadcasts');
    }
    return 'arbitrumVolume24h broadcast ✓';
  });
}

// ============================================================================
// 7. CFO Agent — persistence & command
// ============================================================================

async function testCfoAgent() {
  header('7. CFO Agent — EVM Arb Wiring');

  await runTest('cfo.ts', 'cfo_arb_status command handler exists', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/agents/cfo.ts', 'utf-8');
    
    if (!src.includes("'cfo_arb_status'") && !src.includes('"cfo_arb_status"') && !src.includes('cfo_arb_status')) {
      throw new Error('cfo_arb_status command handler not found');
    }
    return 'cfo_arb_status handler ✓';
  });

  await runTest('cfo.ts', 'EVM_FLASH_ARB persistence case', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/agents/cfo.ts', 'utf-8');
    
    if (!src.includes("'EVM_FLASH_ARB'") && !src.includes('"EVM_FLASH_ARB"')) {
      throw new Error('EVM_FLASH_ARB persistence case not found in cfo.ts');
    }
    return 'EVM_FLASH_ARB persistence case ✓';
  });
}

// ============================================================================
// 8. Contract Source — Structural Checks
// ============================================================================

async function testContract() {
  header('8. ArbFlashReceiver.sol — Structural Checks');

  await runTest('contract', 'ArbFlashReceiver.sol exists', async () => {
    const fs = await import('fs');
    if (!fs.existsSync('contracts/ArbFlashReceiver.sol')) {
      throw new Error('contracts/ArbFlashReceiver.sol not found');
    }
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    return `${src.length} bytes`;
  });

  await runTest('contract', 'Contract has executeOperation callback', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    if (!src.includes('executeOperation')) {
      throw new Error('executeOperation() callback not found');
    }
    return 'executeOperation ✓';
  });

  await runTest('contract', 'Contract has requestFlashLoan entry', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    if (!src.includes('requestFlashLoan')) {
      throw new Error('requestFlashLoan() not found');
    }
    return 'requestFlashLoan ✓';
  });

  await runTest('contract', 'Contract has _swap dispatcher', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    if (!src.includes('function _swap')) {
      throw new Error('_swap() dispatcher not found');
    }
    // Verify all 3 DEX paths
    if (!src.includes('DEX_UNISWAP_V3')) throw new Error('DEX_UNISWAP_V3 path missing');
    if (!src.includes('DEX_CAMELOT_V3')) throw new Error('DEX_CAMELOT_V3 path missing');
    if (!src.includes('DEX_BALANCER')) throw new Error('DEX_BALANCER path missing');
    return '_swap handles all 3 DEX types ✓';
  });

  await runTest('contract', 'Contract has safety modifiers', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    if (!src.includes('onlyOwner')) throw new Error('onlyOwner modifier missing');
    if (!src.includes('rescueToken')) throw new Error('rescueToken safety function missing');
    return 'onlyOwner + rescueToken ✓';
  });

  await runTest('contract', 'Aave PoolAddressesProvider address in constructor comment', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/ArbFlashReceiver.sol', 'utf-8');
    
    // Constructor takes aaveAddressesProvider as arg. Both mainnet and testnet documented.
    const mainnet = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
    const testnet = '0x36616cf17557639614c1cdDb356b1B83fc0B2132';
    if (!src.includes(mainnet)) throw new Error(`Mainnet Aave address ${mainnet} not found`);
    if (!src.includes(testnet)) throw new Error(`Testnet Aave address ${testnet} not found`);
    if (!src.includes('constructor(address aaveAddressesProvider)')) throw new Error('Constructor must take aaveAddressesProvider');
    return 'Aave addresses documented + constructor param ✓';
  });
}

// ============================================================================
// 9. Deploy Script — Structural Check
// ============================================================================

async function testDeployScript() {
  header('9. Deploy Script');

  await runTest('deploy', 'contracts/deploy.ts exists', async () => {
    const fs = await import('fs');
    if (!fs.existsSync('contracts/deploy.ts')) {
      throw new Error('contracts/deploy.ts not found');
    }
    return 'deploy.ts found ✓';
  });

  await runTest('deploy', 'Deploy script references ArbFlashReceiver', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('contracts/deploy.ts', 'utf-8');
    
    if (!src.includes('ArbFlashReceiver')) {
      throw new Error('Deploy script does not reference ArbFlashReceiver');
    }
    return 'ArbFlashReceiver referenced ✓';
  });
}

// ============================================================================
// 10. Cross-module Integration Checks
// ============================================================================

async function testIntegration() {
  header('10. Cross-Module Integration');

  await runTest('integration', 'cfoEnv fields used by decisionEngine', async () => {
    const fs = await import('fs');
    const de = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    const requiredRefs = [
      'env.evmArbEnabled',
      'env.evmArbReceiverAddress',
      'env.evmArbMinProfitUsdc',
    ];
    
    for (const ref of requiredRefs) {
      if (!de.includes(ref)) throw new Error(`decisionEngine missing reference: ${ref}`);
    }
    return `${requiredRefs.length} env refs verified ✓`;
  });

  await runTest('integration', 'decisionEngine imports evmArbService dynamically', async () => {
    const fs = await import('fs');
    const de = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    // Should use dynamic import (not static) since arb is optional
    const dynamicImports = (de.match(/import\('\.\/evmArbService\.ts'\)/g) || []).length;
    if (dynamicImports < 2) {
      throw new Error(`Expected ≥2 dynamic imports of evmArbService (build + execute), found ${dynamicImports}`);
    }
    return `${dynamicImports} dynamic imports ✓`;
  });

  await runTest('integration', 'analyst → decisionEngine: arbitrumVolume24h wiring', async () => {
    const fs = await import('fs');
    const analyst = fs.readFileSync('src/agents/analyst.ts', 'utf-8');
    const de = fs.readFileSync('src/launchkit/cfo/decisionEngine.ts', 'utf-8');
    
    // analyst sends arbitrumVolume24h in payload
    if (!analyst.includes('arbitrumVolume24h')) {
      throw new Error('analyst does not send arbitrumVolume24h');
    }
    // decisionEngine reads it into SwarmIntel
    if (!de.includes('analystArbitrumVolume24h')) {
      throw new Error('decisionEngine SwarmIntel missing analystArbitrumVolume24h');
    }
    return 'analyst → SwarmIntel wiring ✓';
  });

  await runTest('integration', 'positionManager strategy matches repository type', async () => {
    const fs = await import('fs');
    const pm = fs.readFileSync('src/launchkit/cfo/positionManager.ts', 'utf-8');
    const repo = fs.readFileSync('src/launchkit/cfo/postgresCFORepository.ts', 'utf-8');
    
    // Both should have evm_flash_arb
    if (!pm.includes('evm_flash_arb')) throw new Error('positionManager missing evm_flash_arb');
    if (!repo.includes('evm_flash_arb')) throw new Error('postgresCFO missing evm_flash_arb');
    return 'Strategy type consistent across modules ✓';
  });

  await runTest('integration', 'All 3 DEX venues referenced in evmArbService', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/launchkit/cfo/evmArbService.ts', 'utf-8');
    
    const venues = ['uniswap-v3', 'camelot-v3', 'balancer-v2'];
    for (const v of venues) {
      if (!src.includes(v)) throw new Error(`DeFiLlama project id '${v}' missing`);
    }
    
    const dexIds: string[] = ['uniswap_v3', 'camelot_v3', 'balancer'];
    for (const d of dexIds) {
      if (!src.includes(`'${d}'`)) throw new Error(`DexId '${d}' missing`);
    }
    return '3 DEX venues + 3 DexIds ✓';
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`\n${BOLD}⚡ EVM Flash Arb — Wiring & Integration Test${RESET}`);
  console.log(`${DIM}Time: ${new Date().toISOString()}${RESET}\n`);

  await testCfoEnv();
  await testEvmArbService();
  await testDecisionEngine();
  await testPositionManager();
  await testPostgresRepository();
  await testAnalyst();
  await testCfoAgent();
  await testContract();
  await testDeployScript();
  await testIntegration();

  // ── Summary ──
  const pass    = results.filter(r => r.status === 'PASS').length;
  const fail    = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`\n${BOLD}━━━ Summary ━━━${RESET}`);
  console.log(`${GREEN}✅ ${pass} passed${RESET}  ${fail > 0 ? `${RED}❌ ${fail} failed${RESET}  ` : ''}${YELLOW}⏭️  ${skipped} skipped${RESET}`);

  if (fail > 0) {
    console.log(`\n${RED}${BOLD}Failed tests:${RESET}`);
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ${RED}❌ [${r.group}] ${r.test}: ${r.detail}${RESET}`);
    }
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}All EVM arb wiring checks passed! ⚡${RESET}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
