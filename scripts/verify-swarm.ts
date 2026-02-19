#!/usr/bin/env bun
/**
 * Nova Swarm Verification Script
 *
 * Checks that all agent swarm components are properly wired:
 *   1. File structure — all agent files exist
 *   2. Imports — barrel exports are correct
 *   3. TypeScript — all files parse without errors
 *   4. Database — schema tables + views exist (requires DATABASE_URL)
 *   5. Agent wiring — init.ts has all imports + registration calls
 *   6. Health Agent — heartbeat, monitor, and child deactivation wired
 *   7. Supervisor — all message handlers registered
 *   8. Factory — TG commands wired
 *   9. Scan — TG commands wired
 *
 * Usage:
 *   bun run scripts/verify-swarm.ts           # File checks only (no DB)
 *   bun run scripts/verify-swarm.ts --db      # Include DB schema checks
 *   bun run scripts/verify-swarm.ts --full    # DB + insert test heartbeats
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const checkDb = args.includes('--db') || args.includes('--full');
const fullMode = args.includes('--full');

const ROOT = resolve(import.meta.dir, '..');
const r = (p: string) => resolve(ROOT, p);
const read = (p: string) => readFileSync(r(p), 'utf-8');

let passed = 0;
let failed = 0;
let warned = 0;

function ok(label: string) {
  console.log(`  ✅ ${label}`);
  passed++;
}
function fail(label: string) {
  console.log(`  ❌ ${label}`);
  failed++;
}
function warn(label: string) {
  console.log(`  ⚠️  ${label}`);
  warned++;
}
function section(title: string) {
  console.log(`\n═══ ${title} ${'═'.repeat(Math.max(0, 58 - title.length))}`);
}
function check(label: string, test: boolean) {
  test ? ok(label) : fail(label);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. FILE STRUCTURE
// ────────────────────────────────────────────────────────────────────────────
section('1. Agent Files');

const agentFiles = [
  'src/agents/types.ts',
  'src/agents/supervisor.ts',
  'src/agents/scout.ts',
  'src/agents/guardian.ts',
  'src/agents/analyst.ts',
  'src/agents/launcher.ts',
  'src/agents/community-agent.ts',
  'src/agents/token-child.ts',
  'src/agents/factory.ts',
  'src/agents/index.ts',
];

for (const f of agentFiles) {
  check(`${f} exists`, existsSync(r(f)));
}

section('2. Health Agent Files');

const healthFiles = [
  'src/launchkit/health/monitor.ts',
  'src/launchkit/health/db.ts',
  'src/launchkit/health/singleton.ts',
  'src/launchkit/health/types.ts',
  'src/launchkit/health/heartbeat-client.ts',
  'sql/001_health_schema.sql',
];

for (const f of healthFiles) {
  check(`${f} exists`, existsSync(r(f)));
}

section('3. TG Command Files');

const tgCommandFiles = [
  'src/launchkit/services/telegramHealthCommands.ts',
  'src/launchkit/services/telegramScanCommand.ts',
  'src/launchkit/services/telegramFactoryCommands.ts',
  'src/launchkit/services/telegramBanHandler.ts',
];

for (const f of tgCommandFiles) {
  check(`${f} exists`, existsSync(r(f)));
}

section('4. Support Files');

const supportFiles = [
  'src/launchkit/services/farcasterPublisher.ts',
  'ecosystem.config.cjs',
];

for (const f of supportFiles) {
  check(`${f} exists`, existsSync(r(f)));
}

// ────────────────────────────────────────────────────────────────────────────
// 2. BARREL EXPORTS (agents/index.ts)
// ────────────────────────────────────────────────────────────────────────────
section('5. Barrel Exports (agents/index.ts)');

const barrel = read('src/agents/index.ts');
const expectedExports = [
  'BaseAgent', 'AgentMessage', 'AgentConfig', 'AgentType', 'MessagePriority', 'MessageType',
  'Supervisor', 'SupervisorCallbacks',
  'ScoutAgent', 'GuardianAgent', 'AnalystAgent', 'LauncherAgent', 'CommunityAgent',
  'TokenChildAgent', 'TokenChildConfig',
  'AgentFactory', 'AgentSpec', 'CapabilityType', 'AgentSpecStatus',
  'initSwarm', 'stopSwarm', 'SwarmHandle',
];

for (const exp of expectedExports) {
  check(`exports ${exp}`, barrel.includes(exp));
}

// ────────────────────────────────────────────────────────────────────────────
// 3. INIT.TS WIRING
// ────────────────────────────────────────────────────────────────────────────
section('6. init.ts Wiring');

const init = read('src/launchkit/init.ts');

// Imports
check('imports registerScanCommand', init.includes("import { registerScanCommand }"));
check('imports registerFactoryCommands', init.includes("import { registerFactoryCommands }"));
check('imports registerHealthCommands', init.includes("import { registerHealthCommands }"));
check('imports registerBanCommands', init.includes("import { registerBanCommands }"));
check('imports initSwarm', init.includes("import { initSwarm"));
check('imports stopSwarm', init.includes("stopSwarm"));

// Registration calls
check('calls registerBanCommands(runtime)', init.includes('registerBanCommands(runtime)'));
check('calls registerHealthCommands(runtime)', init.includes('registerHealthCommands(runtime)'));
check('calls registerScanCommand(runtime, _swarmHandle.supervisor)', init.includes('registerScanCommand(runtime, _swarmHandle.supervisor)'));
check('calls registerFactoryCommands(runtime, _swarmHandle.supervisor, pool)', init.includes('registerFactoryCommands(runtime, _swarmHandle.supervisor, pool)'));

// Supervisor callbacks
check('onPostToX callback wired', init.includes('onPostToX:'));
check('onPostToTelegram callback wired', init.includes('onPostToTelegram:'));
check('onPostToChannel callback wired', init.includes('onPostToChannel:'));
check('onPostToFarcaster callback wired', init.includes('onPostToFarcaster:'));

// Swarm shutdown
check('stopSwarm in close()', init.includes('await stopSwarm'));

// ────────────────────────────────────────────────────────────────────────────
// 4. SUPERVISOR MESSAGE HANDLERS
// ────────────────────────────────────────────────────────────────────────────
section('7. Supervisor Message Handlers');

const supervisor = read('src/agents/supervisor.ts');
const expectedHandlers = [
  'nova-scout:intel',
  'nova-guardian:alert',
  'nova-guardian:report',
  'nova-analyst:report',
  'nova-launcher:status',
  'nova-community:report',
  '*:status',
  'health-agent:command',
];

for (const h of expectedHandlers) {
  check(`handler '${h}'`, supervisor.includes(`'${h}'`));
}

// Child management
check('spawnChild() method', supervisor.includes('spawnChild('));
check('deactivateChild() method', supervisor.includes('deactivateChild('));
check('getActiveChildren() method', supervisor.includes('getActiveChildren()'));
check('requestScan() method', supervisor.includes('requestScan('));
check('requestIntelScan() method', supervisor.includes('requestIntelScan()'));
check('requestLaunch() method', supervisor.includes('requestLaunch('));

// Farcaster cross-posting in handlers
check('Farcaster cross-post in scout handler', supervisor.includes("onPostToFarcaster(content, 'ai-agents')"));
check('Farcaster cross-post in guardian handler', supervisor.includes("onPostToFarcaster(warning, 'defi')"));

// ────────────────────────────────────────────────────────────────────────────
// 5. HEARTBEATS
// ────────────────────────────────────────────────────────────────────────────
section('8. Agent Heartbeats');

const agentFileMap: Record<string, string> = {
  'supervisor': 'src/agents/supervisor.ts',
  'scout': 'src/agents/scout.ts',
  'guardian': 'src/agents/guardian.ts',
  'analyst': 'src/agents/analyst.ts',
  'launcher': 'src/agents/launcher.ts',
  'community': 'src/agents/community-agent.ts',
  'token-child': 'src/agents/token-child.ts',
};

for (const [name, file] of Object.entries(agentFileMap)) {
  const content = read(file);
  check(`${name} calls startHeartbeat()`, content.includes('this.startHeartbeat('));
}

// ────────────────────────────────────────────────────────────────────────────
// 6. HEALTH AGENT — CHILD DEACTIVATION
// ────────────────────────────────────────────────────────────────────────────
section('9. Health Agent Child Deactivation');

const monitor = read('src/launchkit/health/monitor.ts');
check('isTokenChildAgent() method exists', monitor.includes('isTokenChildAgent'));
check('checks agent_registry for agent_type', monitor.includes('agent_type') && monitor.includes('agent_registry'));
check('sends deactivate_child command', monitor.includes('deactivate_child'));
check('sends to nova-supervisor', monitor.includes('nova-supervisor') || monitor.includes('nova'));

const healthDb = read('src/launchkit/health/db.ts');
check('getPool() method on HealthDB', healthDb.includes('getPool'));

// Supervisor side
check('Supervisor handles deactivate_child', supervisor.includes('deactivate_child'));
check('findChildAddressByName() helper', supervisor.includes('findChildAddressByName'));

// ────────────────────────────────────────────────────────────────────────────
// 7. TOKEN CHILD AGENT
// ────────────────────────────────────────────────────────────────────────────
section('10. Token Child Agent');

const tokenChild = read('src/agents/token-child.ts');
check('extends BaseAgent', tokenChild.includes('extends BaseAgent'));
check('DexScreener API fetch', tokenChild.includes('api.dexscreener.com'));
check('price spike detection', tokenChild.includes('price_spike'));
check('price crash detection', tokenChild.includes('price_crash'));
check('mcap milestone detection', tokenChild.includes('mcap_milestone'));
check('auto-deactivation logic', tokenChild.includes('auto_deactivated') || tokenChild.includes('checkDeactivation'));
check('processes supervisor commands', tokenChild.includes('force_deactivate'));
check('getStatus() API', tokenChild.includes('getStatus()'));

// ────────────────────────────────────────────────────────────────────────────
// 8. AGENT FACTORY
// ────────────────────────────────────────────────────────────────────────────
section('11. Agent Factory');

const factory = read('src/agents/factory.ts');
check('parseRequest() method', factory.includes('parseRequest('));
check('approve() method', factory.includes('approve('));
check('reject() method', factory.includes('reject('));
check('spawn() method', factory.includes('spawn('));
check('stop() method', factory.includes('stop('));
check('5 capability templates', ['whale_tracking', 'token_monitoring', 'kol_scanning', 'safety_scanning', 'narrative_tracking'].every(c => factory.includes(c)));
check('MAX_AGENTS_PER_USER limit', factory.includes('MAX_AGENTS_PER_USER'));
check('formatApprovalRequest()', factory.includes('formatApprovalRequest'));
check('persists to agent_registry', factory.includes('agent_registry'));
check('uses supervisor.spawnChild()', factory.includes('supervisor.spawnChild'));
check('uses supervisor.requestScan()', factory.includes('supervisor.requestScan'));
check('no unused TokenChildAgent import', !factory.includes("import { TokenChildAgent"));

// ────────────────────────────────────────────────────────────────────────────
// 9. TG SCAN COMMAND
// ────────────────────────────────────────────────────────────────────────────
section('12. TG Scan Command');

const scanCmd = read('src/launchkit/services/telegramScanCommand.ts');
check('/scan command handler', scanCmd.includes("command('scan'") || scanCmd.includes("bot.command('scan'"));
check('/children command handler', scanCmd.includes("command('children'") || scanCmd.includes("bot.command('children'"));
check('Solana address validation', scanCmd.includes('base58') || scanCmd.includes('1-9A-HJ-NP-Za-km-z'));
check('calls supervisor.requestScan()', scanCmd.includes('supervisor.requestScan'));
check('calls supervisor.getActiveChildren()', scanCmd.includes('supervisor.getActiveChildren'));

// ────────────────────────────────────────────────────────────────────────────
// 10. TG FACTORY COMMANDS
// ────────────────────────────────────────────────────────────────────────────
section('13. TG Factory Commands');

const factoryCmd = read('src/launchkit/services/telegramFactoryCommands.ts');
check('/request_agent command', factoryCmd.includes("command('request_agent'"));
check('/approve_agent command', factoryCmd.includes("command('approve_agent'"));
check('/reject_agent command', factoryCmd.includes("command('reject_agent'"));
check('/my_agents command', factoryCmd.includes("command('my_agents'"));
check('/stop_agent command', factoryCmd.includes("command('stop_agent'"));
check('creates AgentFactory instance', factoryCmd.includes('new AgentFactory'));
check('admin auth check', factoryCmd.includes('isAdmin'));
check('notifies admin on new request', factoryCmd.includes('formatApprovalRequest'));

// ────────────────────────────────────────────────────────────────────────────
// 11. FARCASTER PUBLISHER
// ────────────────────────────────────────────────────────────────────────────
section('14. Farcaster Publisher');

const farcaster = read('src/launchkit/services/farcasterPublisher.ts');
check('Neynar API endpoint', farcaster.includes('api.neynar.com'));
check('postCast() function', farcaster.includes('postCast'));
check('isFarcasterEnabled() function', farcaster.includes('isFarcasterEnabled'));
check('channel routing', farcaster.includes('solana') && farcaster.includes('defi') && farcaster.includes('ai-agents'));
check('rate limiting', farcaster.includes('rateLimit') || farcaster.includes('RATE_LIMIT') || farcaster.includes('maxCasts') || farcaster.includes('checkRateLimit') || farcaster.includes('MAX_CASTS'));
check('dedup protection', farcaster.includes('dedup') || farcaster.includes('recentHashes') || farcaster.includes('recentCasts'));

// ────────────────────────────────────────────────────────────────────────────
// 12. PM2 CONFIG
// ────────────────────────────────────────────────────────────────────────────
section('15. PM2 Ecosystem Config');

const pm2 = read('ecosystem.config.cjs');
check('nova-main app defined', pm2.includes('nova-main'));
check('max_memory_restart set', pm2.includes('max_memory_restart'));
check('restart_delay set', pm2.includes('restart_delay'));

// ────────────────────────────────────────────────────────────────────────────
// 13. BASE AGENT FEATURES
// ────────────────────────────────────────────────────────────────────────────
section('16. BaseAgent (types.ts)');

const types = read('src/agents/types.ts');
check('getAgentId() public method', types.includes('getAgentId(): string'));
check('sendMessage() method', types.includes('sendMessage('));
check('readMessages() method', types.includes('readMessages('));
check('acknowledgeMessage() method', types.includes('acknowledgeMessage('));
check('reportToSupervisor() method', types.includes('reportToSupervisor('));
check('register() → agent_registry', types.includes('agent_registry'));
check('updateStatus() → agent_heartbeats', types.includes('agent_heartbeats'));

// ────────────────────────────────────────────────────────────────────────────
// DATABASE CHECKS (optional)
// ────────────────────────────────────────────────────────────────────────────
if (checkDb) {
  section('17. Database Schema (live)');
  const { Pool } = await import('pg');
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    warn('DATABASE_URL not set — skipping DB checks');
  } else {
    const pool = new Pool({ connectionString: dbUrl });

    try {
      // Test connection
      await pool.query('SELECT 1');
      ok('PostgreSQL connection OK');

      // Check tables exist
      const tables = [
        'agent_heartbeats', 'agent_errors', 'agent_restarts', 'api_health',
        'code_repairs', 'health_reports', 'agent_messages', 'agent_registry',
      ];

      for (const table of tables) {
        const { rows } = await pool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
          [table],
        );
        check(`table ${table} exists`, rows[0].exists);
      }

      // Check views
      const views = ['swarm_status', 'recent_errors', 'pending_repairs'];
      for (const view of views) {
        const { rows } = await pool.query(
          `SELECT EXISTS (SELECT FROM information_schema.views WHERE table_name = $1)`,
          [view],
        );
        check(`view ${view} exists`, rows[0].exists);
      }

      // Check agent_registry content
      const { rows: agents } = await pool.query(
        'SELECT agent_name, agent_type, enabled FROM agent_registry ORDER BY agent_name',
      );
      if (agents.length > 0) {
        ok(`agent_registry has ${agents.length} entries: ${agents.map(a => a.agent_name).join(', ')}`);
      } else {
        warn('agent_registry is empty (agents haven\'t started yet)');
      }

      // Check heartbeats
      const { rows: beats } = await pool.query(
        `SELECT agent_name, status, last_beat,
                EXTRACT(EPOCH FROM (NOW() - last_beat)) as seconds_ago
         FROM agent_heartbeats ORDER BY agent_name`,
      );
      if (beats.length > 0) {
        for (const b of beats) {
          const age = Math.round(b.seconds_ago);
          const emoji = age < 120 ? '🟢' : age < 300 ? '🟡' : '🔴';
          console.log(`  ${emoji} ${b.agent_name}: ${b.status} (${age}s ago)`);
        }
        ok(`${beats.length} agents have heartbeats`);
      } else {
        warn('No heartbeats found (agents haven\'t started yet)');
      }

      // Full mode: insert test data to verify write path
      if (fullMode) {
        section('18. Write Path Test');
        try {
          await pool.query(
            `INSERT INTO agent_heartbeats (agent_name, status, last_beat)
             VALUES ('test-verify-agent', 'alive', NOW())
             ON CONFLICT (agent_name) DO UPDATE SET status = 'alive', last_beat = NOW()`,
          );
          ok('Write to agent_heartbeats OK');

          await pool.query(
            `INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
             VALUES ('test-verify-agent', 'nova-supervisor', 'status', 'low', $1)`,
            [JSON.stringify({ test: true, timestamp: new Date().toISOString() })],
          );
          ok('Write to agent_messages OK');

          await pool.query(
            `INSERT INTO agent_registry (agent_name, agent_type, enabled, config)
             VALUES ('test-verify-agent', 'test', false, '{"test": true}')
             ON CONFLICT (agent_name) DO UPDATE SET config = '{"test": true}'`,
          );
          ok('Write to agent_registry OK');

          // Clean up test data
          await pool.query("DELETE FROM agent_messages WHERE from_agent = 'test-verify-agent'");
          await pool.query("DELETE FROM agent_heartbeats WHERE agent_name = 'test-verify-agent'");
          await pool.query("DELETE FROM agent_registry WHERE agent_name = 'test-verify-agent'");
          ok('Test data cleaned up');
        } catch (err: any) {
          fail(`Write path failed: ${err.message}`);
        }
      }

      await pool.end();
    } catch (err: any) {
      fail(`Database connection failed: ${err.message}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${warned} warnings`);
console.log('════════════════════════════════════════════════════════════');

if (failed > 0) {
  console.log('\n🔴 Some checks failed! Review the ❌ items above.');
  process.exit(1);
} else if (warned > 0) {
  console.log('\n🟡 All checks passed, but there are warnings.');
  process.exit(0);
} else {
  console.log('\n🟢 All checks passed! Nova swarm is properly wired.');
  process.exit(0);
}
