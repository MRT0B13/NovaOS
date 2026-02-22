// src/health/index.ts
// Nova Health Agent — Entry Point
// Run as: npx ts-node src/health/index.ts
// Or via pm2: pm2 start src/health/index.ts --name health-agent

import { Pool } from 'pg';
import { HealthMonitor } from './monitor';

// Re-export everything for other agents to import
export { HealthMonitor } from './monitor';
export { HealthDB } from './db';
export { CodeRepairEngine } from './code-repair';
export { HeartbeatClient } from './heartbeat-client';
export * from './types';

// ============================================================
// STANDALONE STARTUP
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  🏥 Nova Health Agent v1.0.0');
  console.log('  Self-healing autonomous swarm monitor');
  console.log('═══════════════════════════════════════');

  // Connect to the same PostgreSQL as ElizaOS
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });

  // Verify DB connection
  try {
    await pool.query('SELECT NOW()');
    console.log('[HealthAgent] ✅ Database connected');
  } catch (err: any) {
    console.error('[HealthAgent] ❌ Database connection failed:', err.message);
    process.exit(1);
  }

  // Run schema migration if tables don't exist
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'agent_heartbeats')`
    );
    if (!rows[0].exists) {
      console.log('[HealthAgent] Running schema migration...');
      const fs = require('fs');
      const path = require('path');
      const schemaPath = path.join(__dirname, '..', 'sql', '001_health_schema.sql');

      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        await pool.query(schema);
        console.log('[HealthAgent] ✅ Schema migration complete');
      } else {
        console.warn('[HealthAgent] ⚠️ Schema file not found at', schemaPath);
        console.warn('[HealthAgent] Run the SQL migration manually from sql/001_health_schema.sql');
      }
    }
  } catch (err: any) {
    console.error('[HealthAgent] Schema check/migration failed:', err.message);
  }

  // Register health-monitor in the registry (renamed from health-agent)
  try {
    await pool.query(
      `INSERT INTO agent_registry (agent_name, agent_type, enabled, auto_restart)
       VALUES ('health-monitor', 'health', TRUE, FALSE)
       ON CONFLICT (agent_name) DO UPDATE SET enabled = TRUE, updated_at = NOW()`
    );
  } catch {
    // Registry table might not exist yet, that's fine
  }

  // Start the monitor
  const monitor = new HealthMonitor(pool, {
    repairEnabled: process.env.REPAIR_ENABLED !== 'false',
    repairModel: process.env.REPAIR_MODEL || 'claude-sonnet-4-20250514',
    adminChatId: process.env.ADMIN_CHAT_ID,
    reportToTelegram: process.env.REPORT_TO_TELEGRAM !== 'false',
  }, process.env.PROJECT_ROOT || process.cwd());

  monitor.start();

  // Generate initial report after 10 seconds (let all agents register)
  setTimeout(() => monitor.generateReport(), 10_000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[HealthAgent] Shutting down...');
    monitor.stop();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  console.log('[HealthAgent] 🏥 Running. Ctrl+C to stop.\n');
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('[HealthAgent] Fatal:', err);
    process.exit(1);
  });
}
