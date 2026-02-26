import { Pool } from 'pg';
import { getEnv } from '../env.ts';
import { getPglite } from '../db/pglite.ts';

export interface LauncherSecrets {
  apiKey: string;
  wallet: string;
  walletSecret: string;
}

export interface SecretsStore {
  get(): Promise<LauncherSecrets | null>;
  set(secrets: LauncherSecrets): Promise<void>;
}

export interface SecretsStoreWithClose extends SecretsStore {
  close?: () => Promise<void>;
}

const SECRETS_KEY = 'pumpportal';

class EnvSecretsStore implements SecretsStore {
  async get(): Promise<LauncherSecrets | null> {
    const env = getEnv();
    if (env.PUMP_PORTAL_API_KEY && env.PUMP_PORTAL_WALLET_ADDRESS && env.PUMP_PORTAL_WALLET_SECRET) {
      return {
        apiKey: env.PUMP_PORTAL_API_KEY,
        wallet: env.PUMP_PORTAL_WALLET_ADDRESS,
        walletSecret: env.PUMP_PORTAL_WALLET_SECRET,
      };
    }
    return null;
  }

  async set(_secrets: LauncherSecrets): Promise<void> {
    // Env-based secrets are read-only; ignore writes.
  }
}

async function ensurePgTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS launcher_secrets (
      name TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      wallet TEXT NOT NULL,
      wallet_secret TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE launcher_secrets
    ADD COLUMN IF NOT EXISTS wallet_secret TEXT NOT NULL DEFAULT ''
  `);
}

class PostgresSecretsStore implements SecretsStoreWithClose {
  constructor(private pool: Pool) {}

  static async create(databaseUrl: string): Promise<PostgresSecretsStore> {
    const pool = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    await ensurePgTable(pool);
    return new PostgresSecretsStore(pool);
  }

  async get(): Promise<LauncherSecrets | null> {
    const res = await this.pool.query('SELECT api_key, wallet, wallet_secret FROM launcher_secrets WHERE name = $1 LIMIT 1', [
      SECRETS_KEY,
    ]);
    if (!res.rows?.length) return null;
    const row = res.rows[0] as any;
    return { apiKey: row.api_key, wallet: row.wallet, walletSecret: row.wallet_secret } as LauncherSecrets;
  }

  async set(secrets: LauncherSecrets): Promise<void> {
    await this.pool.query(
      `INSERT INTO launcher_secrets (name, api_key, wallet, wallet_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET api_key = EXCLUDED.api_key, wallet = EXCLUDED.wallet, wallet_secret = EXCLUDED.wallet_secret, updated_at = NOW()`,
      [SECRETS_KEY, secrets.apiKey, secrets.wallet, secrets.walletSecret]
    );
  }

  async close() {
    await this.pool.end();
  }
}

async function ensurePgliteTable() {
  const db = await getPglite();
  await db.query(`
    CREATE TABLE IF NOT EXISTS launcher_secrets (
      name TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      wallet TEXT NOT NULL,
      wallet_secret TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    ALTER TABLE launcher_secrets
    ADD COLUMN IF NOT EXISTS wallet_secret TEXT NOT NULL DEFAULT ''
  `);
}

class PGliteSecretsStore implements SecretsStoreWithClose {
  private initialized = false;

  private async ensureSchema() {
    if (this.initialized) return;
    await ensurePgliteTable();
    this.initialized = true;
  }

  async get(): Promise<LauncherSecrets | null> {
    await this.ensureSchema();
    const db = await getPglite();
    const res = await db.query('SELECT api_key, wallet, wallet_secret FROM launcher_secrets WHERE name = $1 LIMIT 1', [
      SECRETS_KEY,
    ]);
    if (!res.rows?.length) return null;
    const row = res.rows[0] as any;
    return { apiKey: row.api_key as string, wallet: row.wallet as string, walletSecret: row.wallet_secret as string };
  }

  async set(secrets: LauncherSecrets): Promise<void> {
    await this.ensureSchema();
    const db = await getPglite();
    await db.query(
      `INSERT INTO launcher_secrets (name, api_key, wallet, wallet_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET api_key = EXCLUDED.api_key, wallet = EXCLUDED.wallet, wallet_secret = EXCLUDED.wallet_secret, updated_at = NOW()`,
      [SECRETS_KEY, secrets.apiKey, secrets.wallet, secrets.walletSecret]
    );
  }
}

export async function createSecretsStoreFromEnv(): Promise<SecretsStoreWithClose> {
  const env = getEnv();
  if (env.PUMP_PORTAL_API_KEY && env.PUMP_PORTAL_WALLET_ADDRESS && env.PUMP_PORTAL_WALLET_SECRET) {
    return new EnvSecretsStore();
  }
  if (env.DATABASE_URL) {
    return await PostgresSecretsStore.create(env.DATABASE_URL);
  }
  return new PGliteSecretsStore();
}
