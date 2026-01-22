/**
 * Railway Database Readiness Module
 *
 * Handles:
 * - Database connection validation
 * - Central messages schema creation
 * - pgvector extension detection (graceful fallback)
 * - Startup readiness reporting
 *
 * Safe for Railway Postgres (no pgvector requirement).
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '@elizaos/core';

// ==========================================
// Types
// ==========================================

export interface DbReadiness {
  ready: boolean;
  mode: 'postgres' | 'pglite';
  vectorEnabled: boolean;
  centralDbReady: boolean;
  launchPacksReady: boolean;
  errors: string[];
  connectionInfo?: {
    host: string;
    database: string;
    ssl: boolean;
  };
}

export interface ExtensionStatus {
  pgcrypto: boolean;
  vector: boolean;
}

// ==========================================
// Extension Detection
// ==========================================

/**
 * Check which extensions are available on the connected Postgres
 */
export async function checkExtensions(pool: Pool): Promise<ExtensionStatus> {
  const status: ExtensionStatus = {
    pgcrypto: false,
    vector: false,
  };

  try {
    // Check pgcrypto
    const pgcryptoResult = await pool.query(`
      SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto'
    `);
    status.pgcrypto = (pgcryptoResult.rows?.length ?? 0) > 0;

    // Check vector (pgvector)
    const vectorResult = await pool.query(`
      SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
    `);
    status.vector = (vectorResult.rows?.length ?? 0) > 0;
  } catch (err) {
    logger.warn('[RailwayReady] Could not query pg_available_extensions:', err);
  }

  return status;
}

/**
 * Install extensions if available (non-fatal if fails)
 */
export async function installExtensionsIfAvailable(pool: Pool): Promise<ExtensionStatus> {
  const available = await checkExtensions(pool);
  const installed: ExtensionStatus = { pgcrypto: false, vector: false };

  // Try to install pgcrypto
  if (available.pgcrypto) {
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      installed.pgcrypto = true;
      logger.info('[RailwayReady] ✓ pgcrypto extension installed');
    } catch (err) {
      logger.warn('[RailwayReady] Could not install pgcrypto (may need superuser)');
    }
  }

  // Try to install vector (only if available)
  if (available.vector) {
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      installed.vector = true;
      logger.info('[RailwayReady] ✓ vector extension installed');
    } catch (err) {
      logger.warn('[RailwayReady] Could not install vector (may need superuser or not available on Postgres 17)');
    }
  } else {
    logger.info('[RailwayReady] vector extension not available - embeddings will use fallback storage');
  }

  return installed;
}

// ==========================================
// Central Messages Schema
// ==========================================

/**
 * Ensure central_messages table exists for message bus persistence
 * This is required by @elizaos/server for the /submit endpoint
 */
export async function ensureCentralMessagesSchema(pool: Pool): Promise<boolean> {
  try {
    // Create central_channels table first (messages references it)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS central_channels (
        id TEXT PRIMARY KEY,
        name TEXT,
        server_id TEXT,
        type TEXT DEFAULT 'text',
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // Create central_messages table with all columns used by /submit
    await pool.query(`
      CREATE TABLE IF NOT EXISTS central_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_message JSONB,
        in_reply_to_root_message_id TEXT,
        source_type TEXT,
        source_id TEXT DEFAULT '',
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS central_messages_channel_id_idx 
      ON central_messages(channel_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS central_messages_created_at_idx 
      ON central_messages(created_at);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS central_messages_author_id_idx 
      ON central_messages(author_id);
    `);

    // Create default channel if none exists
    await pool.query(`
      INSERT INTO central_channels (id, name, server_id, type)
      VALUES ('00000000-0000-0000-0000-000000000000', 'default', '00000000-0000-0000-0000-000000000000', 'text')
      ON CONFLICT (id) DO NOTHING;
    `);

    logger.info('[RailwayReady] ✓ central_messages schema ensured');
    return true;
  } catch (err) {
    logger.error('[RailwayReady] Failed to ensure central_messages schema:', err);
    return false;
  }
}

// ==========================================
// Connection Parsing
// ==========================================

function parseConnectionInfo(url: string): { host: string; database: string; ssl: boolean } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'unknown',
      database: parsed.pathname?.replace('/', '') || 'unknown',
      ssl: url.includes('sslmode=require') || process.env.PGSSLMODE === 'require',
    };
  } catch {
    return { host: 'unknown', database: 'unknown', ssl: false };
  }
}

// ==========================================
// Readiness Check
// ==========================================

/**
 * Run full database readiness check
 * Returns structured status for /health endpoint and startup logging
 */
export async function checkDatabaseReadiness(databaseUrl?: string): Promise<DbReadiness> {
  const result: DbReadiness = {
    ready: false,
    mode: databaseUrl ? 'postgres' : 'pglite',
    vectorEnabled: false,
    centralDbReady: false,
    launchPacksReady: false,
    errors: [],
  };

  // If no DATABASE_URL, we're using pglite - always ready
  if (!databaseUrl) {
    result.ready = true;
    result.centralDbReady = true;
    result.launchPacksReady = true;
    logger.info('[RailwayReady] Using PGlite (no DATABASE_URL)');
    return result;
  }

  result.connectionInfo = parseConnectionInfo(databaseUrl);

  // Create pool for checks
  const sslNeeded = databaseUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslNeeded ? { rejectUnauthorized: false } : undefined,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    // Test basic connectivity
    const client = await pool.connect();
    client.release();

    // Install extensions if available
    const extensions = await installExtensionsIfAvailable(pool);
    result.vectorEnabled = extensions.vector;

    // Ensure central_messages schema
    result.centralDbReady = await ensureCentralMessagesSchema(pool);

    // Check launch_packs table exists
    try {
      const lpCheck = await pool.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'launch_packs' LIMIT 1
      `);
      result.launchPacksReady = (lpCheck.rows?.length ?? 0) > 0;
    } catch {
      result.launchPacksReady = false;
    }

    result.ready = result.centralDbReady;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`Database connection failed: ${message}`);
    logger.error('[RailwayReady] Database connection failed:', message);
  } finally {
    await pool.end();
  }

  return result;
}

/**
 * Log database readiness summary in a single line
 */
export function logDbReadinessSummary(status: DbReadiness): void {
  const parts = [
    `mode=${status.mode}`,
    `vector=${status.vectorEnabled ? 'enabled' : 'disabled'}`,
    `central_db=${status.centralDbReady ? 'ready' : 'not_ready'}`,
    `launch_packs=${status.launchPacksReady ? 'ready' : 'pending'}`,
  ];

  if (status.connectionInfo) {
    parts.push(`host=${status.connectionInfo.host}`);
    parts.push(`ssl=${status.connectionInfo.ssl}`);
  }

  if (status.errors.length > 0) {
    logger.error(`[RailwayReady] DB Status: ${parts.join(', ')} | ERRORS: ${status.errors.join('; ')}`);
  } else {
    logger.info(`[RailwayReady] DB Status: ${parts.join(', ')}`);
  }
}

/**
 * Environment variable for disabling embeddings/vector when not available
 */
export function shouldDisableEmbeddings(): boolean {
  // Check explicit env flag
  if (process.env.SQL_EMBEDDINGS_ENABLE === 'false') {
    return true;
  }
  // Auto-disable on Railway if vector not available (set during readiness check)
  if (process.env.RAILWAY_ENVIRONMENT && process.env.VECTOR_AVAILABLE === 'false') {
    return true;
  }
  return false;
}
