// src/launchkit/health/singleton.ts
// Shared HeartbeatClient singleton — import from anywhere in Nova to report errors
//
// Usage:
//   import { getHealthbeat } from '../health/singleton';
//   const hb = getHealthbeat();
//   if (hb) await hb.reportError({ ... });

import { Pool } from 'pg';
import { HeartbeatClient } from './heartbeat-client';
import { HealthMonitor } from './monitor';
import { HealthDB } from './db';

let _pool: Pool | null = null;
let _heartbeat: HeartbeatClient | null = null;
let _monitor: HealthMonitor | null = null;
let _db: HealthDB | null = null;

/**
 * Initialize the shared health pool + heartbeat client.
 * Call once during Nova startup (from init.ts).
 */
export function initHealthSystem(databaseUrl: string): {
  pool: Pool;
  heartbeat: HeartbeatClient;
  monitor: HealthMonitor;
  db: HealthDB;
} {
  if (_heartbeat && _pool) {
    return { pool: _pool, heartbeat: _heartbeat, monitor: _monitor!, db: _db! };
  }

  _pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
  });

  _heartbeat = new HeartbeatClient(_pool, 'nova-main', '1.0.0');
  _db = new HealthDB(_pool);
  _monitor = new HealthMonitor(_pool, {
    repairEnabled: process.env.REPAIR_ENABLED !== 'false',
    repairModel: process.env.REPAIR_MODEL || 'claude-sonnet-4-20250514',
    adminChatId: process.env.ADMIN_CHAT_ID,
    reportToTelegram: process.env.REPORT_TO_TELEGRAM !== 'false',
  }, process.env.PROJECT_ROOT || process.cwd());

  return { pool: _pool, heartbeat: _heartbeat, monitor: _monitor, db: _db };
}

/**
 * Get the shared HeartbeatClient (returns null if not yet initialized).
 * Safe to call from any module — will gracefully return null before startup.
 */
export function getHealthbeat(): HeartbeatClient | null {
  return _heartbeat;
}

/**
 * Get the shared HealthMonitor (returns null if not yet initialized).
 */
export function getHealthMonitor(): HealthMonitor | null {
  return _monitor;
}

/**
 * Get the shared HealthDB (returns null if not yet initialized).
 */
export function getHealthDB(): HealthDB | null {
  return _db;
}

/**
 * Get the shared health pool (returns null if not yet initialized).
 */
export function getHealthPool(): Pool | null {
  return _pool;
}

/**
 * Stop the health system (call on shutdown).
 */
export async function stopHealthSystem(): Promise<void> {
  if (_heartbeat) _heartbeat.stop();
  if (_monitor) _monitor.stop();
  if (_pool) await _pool.end();
  _heartbeat = null;
  _monitor = null;
  _db = null;
  _pool = null;
}
