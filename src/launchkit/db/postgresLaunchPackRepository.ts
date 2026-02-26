import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import {
  LaunchPack,
  LaunchPackCreateInput,
  LaunchPackUpdateInput,
  LaunchPackValidation,
} from '../model/launchPack.ts';
import type { LaunchPackStore } from './launchPackRepository.ts';

const PUBLISH_COOLDOWN_INTERVAL = `10 minutes`;

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function deepMerge(base: any, patch: any) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object') return patch;
  if (typeof base !== 'object' || base === null) return patch;

  const merged: Record<string, any> = { ...base };
  for (const key of Object.keys(patch)) {
    merged[key] = deepMerge(base[key], (patch as Record<string, any>)[key]);
  }
  return merged;
}

function buildPool(databaseUrl: string) {
  const sslNeeded = databaseUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (sslNeeded) {
    config.ssl = { rejectUnauthorized: false } as any;
  }
  return new Pool(config);
}

async function ensureSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS launch_packs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      launch_status TEXT DEFAULT 'draft',
      launch_requested_at TIMESTAMPTZ NULL
    );
  `);

  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS launch_packs_idempotency_key_idx
     ON launch_packs (idempotency_key) WHERE idempotency_key IS NOT NULL;`
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS launch_packs_launch_status_idx ON launch_packs (launch_status);`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS launch_packs_launch_requested_at_idx ON launch_packs (launch_requested_at);`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS launch_packs_status_requested_idx ON launch_packs (launch_status, launch_requested_at);`
  );
}

export class PostgresLaunchPackRepository implements LaunchPackStore {
  private constructor(private pool: Pool) {}

  static async create(databaseUrl: string): Promise<PostgresLaunchPackRepository> {
    const pool = buildPool(databaseUrl);
    await ensureSchema(pool);
    return new PostgresLaunchPackRepository(pool);
  }

  private rowToPack(row: any): LaunchPack {
    const stored = (row.data || {}) as LaunchPack;
    return {
      ...stored,
      id: row.id || stored.id,
      created_at: toIso(row.created_at) || stored.created_at,
      updated_at: toIso(row.updated_at) || stored.updated_at,
    } as LaunchPack;
  }

  async create(input: LaunchPackCreateInput): Promise<LaunchPack> {
    const parsed = LaunchPackValidation.create(input);
    const id = parsed.id ?? randomUUID();
    const idempotencyKey = parsed.idempotency_key;
    const timestamp = new Date().toISOString();
    const launchStatus = parsed.launch?.status ?? 'draft';
    const launchRequestedAt = parsed.launch?.requested_at ? new Date(parsed.launch.requested_at) : null;

    if (idempotencyKey) {
      const existing = await this.pool.query(
        `SELECT id, data, created_at, updated_at FROM launch_packs WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rows?.length) {
        return this.rowToPack(existing.rows[0]);
      }
    }

    const record: LaunchPack = {
      ...parsed,
      id,
      idempotency_key: idempotencyKey,
      version: parsed.version ?? 1,
      created_at: timestamp,
      updated_at: timestamp,
    } as LaunchPack;

    await this.pool.query(
      `INSERT INTO launch_packs (id, idempotency_key, data, created_at, updated_at, launch_status, launch_requested_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             idempotency_key = COALESCE(launch_packs.idempotency_key, EXCLUDED.idempotency_key),
             launch_status = EXCLUDED.launch_status,
             launch_requested_at = EXCLUDED.launch_requested_at,
             updated_at = EXCLUDED.updated_at`,
      [id, idempotencyKey ?? null, record, record.created_at, record.updated_at, launchStatus, launchRequestedAt]
    );

    return record;
  }

  async get(id: string): Promise<LaunchPack | null> {
    const result = await this.pool.query(
      `SELECT id, data, created_at, updated_at FROM launch_packs WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!result.rows?.length) return null;
    return this.rowToPack(result.rows[0]);
  }

  async list(): Promise<LaunchPack[]> {
    const result = await this.pool.query(
      `SELECT id, data, created_at, updated_at FROM launch_packs ORDER BY created_at DESC`
    );
    if (!result.rows?.length) return [];
    return result.rows.map(row => this.rowToPack(row));
  }

  async update(id: string, patch: LaunchPackUpdateInput): Promise<LaunchPack> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error('LaunchPack not found');
    }

    const parsedPatch = LaunchPackValidation.update(patch);
    const merged = deepMerge(existing, parsedPatch) as LaunchPack;
    const timestamp = new Date().toISOString();
    merged.id = id;
    merged.updated_at = timestamp;
    const currentVersion = existing.version ?? 1;
    merged.version = currentVersion + 1;
    const launchStatus = merged.launch?.status ?? 'draft';
    const launchRequestedAt = merged.launch?.requested_at ? new Date(merged.launch.requested_at) : null;

    await this.pool.query(
      `UPDATE launch_packs
         SET data = $2::jsonb,
             launch_status = $3,
             launch_requested_at = $4,
             updated_at = $5
       WHERE id = $1`,
      [id, merged, launchStatus, launchRequestedAt, merged.updated_at]
    );

    return merged;
  }

  async claimLaunch(
    id: string,
    fields: { requested_at: string; status: string }
  ): Promise<LaunchPack | null> {
    const result = await this.pool.query(
      `UPDATE launch_packs
       SET launch_status = $3,
           launch_requested_at = $2::timestamptz,
           data = jsonb_set(
                   jsonb_set(data, '{launch,requested_at}', $4::jsonb, true),
                   '{launch,status}', to_jsonb($3::text), true
                 ),
           updated_at = NOW()
       WHERE id = $1
         AND launch_status <> 'launched'
         AND (launch_requested_at IS NULL OR launch_status = 'failed')
       RETURNING id, data, created_at, updated_at, launch_status, launch_requested_at`,
      [id, fields.requested_at, fields.status, JSON.stringify(fields.requested_at)]
    );

    if (!result.rows?.length) return null;
    return this.rowToPack(result.rows[0]);
  }

  async claimTelegramPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null> {
    const force = Boolean(fields.force);
    const result = await this.pool.query(
      `UPDATE launch_packs
         SET data = jsonb_set(
                        jsonb_set(
                          jsonb_set(data, '{ops,tg_publish_status}', to_jsonb('in_progress'), true),
                          '{ops,tg_publish_attempted_at}', to_jsonb($2), true
                        ),
                        '{ops,tg_publish_error_code}', 'null'::jsonb, true
                      ),
             updated_at = NOW()
       WHERE id = $1
         AND COALESCE(data->'ops'->>'tg_publish_status', 'idle') <> 'published'
         AND COALESCE(data->'ops'->>'tg_publish_status', 'idle') <> 'in_progress'
         AND (
              COALESCE(data->'ops'->>'tg_publish_status', 'idle') = 'idle'
              OR (
                   COALESCE(data->'ops'->>'tg_publish_status', 'idle') = 'failed'
                   AND (
                        $3 = TRUE
                        OR COALESCE((data->'ops'->>'tg_publish_failed_at')::timestamptz, TO_TIMESTAMP(0)) <= NOW() - INTERVAL '${PUBLISH_COOLDOWN_INTERVAL}'
                      )
                 )
             )
       RETURNING id, data, created_at, updated_at` ,
      [id, fields.requested_at, force]
    );
    if (!result.rows?.length) return null;
    return this.rowToPack(result.rows[0]);
  }

  async claimXPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null> {
    const force = Boolean(fields.force);
    const result = await this.pool.query(
      `UPDATE launch_packs
         SET data = jsonb_set(
                        jsonb_set(
                          jsonb_set(data, '{ops,x_publish_status}', to_jsonb('in_progress'), true),
                          '{ops,x_publish_attempted_at}', to_jsonb($2), true
                        ),
                        '{ops,x_publish_error_code}', 'null'::jsonb, true
                      ),
             updated_at = NOW()
       WHERE id = $1
         AND COALESCE(data->'ops'->>'x_publish_status', 'idle') <> 'published'
         AND COALESCE(data->'ops'->>'x_publish_status', 'idle') <> 'in_progress'
         AND (
              COALESCE(data->'ops'->>'x_publish_status', 'idle') = 'idle'
              OR (
                   COALESCE(data->'ops'->>'x_publish_status', 'idle') = 'failed'
                   AND (
                        $3 = TRUE
                        OR COALESCE((data->'ops'->>'x_publish_failed_at')::timestamptz, TO_TIMESTAMP(0)) <= NOW() - INTERVAL '${PUBLISH_COOLDOWN_INTERVAL}'
                      )
                 )
             )
       RETURNING id, data, created_at, updated_at` ,
      [id, fields.requested_at, force]
    );
    if (!result.rows?.length) return null;
    return this.rowToPack(result.rows[0]);
  }

  async claimTreasuryWithdraw(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null> {
    const force = Boolean(fields.force);
    const result = await this.pool.query(
      `UPDATE launch_packs
         SET data = jsonb_set(
                        jsonb_set(
                          jsonb_set(data, '{ops,treasury_withdraw_status}', to_jsonb('in_progress'), true),
                          '{ops,treasury_withdraw_requested_at}', to_jsonb($2), true
                        ),
                        '{ops,treasury_withdraw_error_code}', 'null'::jsonb, true
                      ),
             updated_at = NOW()
       WHERE id = $1
         AND COALESCE(data->'ops'->>'treasury_withdraw_status', 'idle') <> 'in_progress'
         AND COALESCE(data->'ops'->>'treasury_withdraw_status', 'idle') <> 'success'
         AND (
              COALESCE(data->'ops'->>'treasury_withdraw_status', 'idle') = 'idle'
              OR (
                   COALESCE(data->'ops'->>'treasury_withdraw_status', 'idle') = 'failed'
                   AND (
                        $3 = TRUE
                        OR COALESCE((data->'ops'->>'treasury_withdraw_failed_at')::timestamptz, TO_TIMESTAMP(0)) <= NOW() - INTERVAL '${PUBLISH_COOLDOWN_INTERVAL}'
                      )
                 )
             )
       RETURNING id, data, created_at, updated_at` ,
      [id, fields.requested_at, force]
    );
    if (!result.rows?.length) return null;
    return this.rowToPack(result.rows[0]);
  }

  async findDueTelegramPublishes(nowIso: string, limit: number): Promise<LaunchPack[]> {
    const result = await this.pool.query(
      `SELECT id, data, created_at, updated_at
         FROM launch_packs
        WHERE (COALESCE(data->'ops'->>'tg_publish_status', 'idle') NOT IN ('in_progress', 'published'))
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'ops'->'tg_schedule_intent', data->'tg'->'schedule', '[]'::jsonb)) AS s
            WHERE (s->>'when')::timestamptz <= $1::timestamptz
          )
        ORDER BY updated_at ASC
        LIMIT $2`,
      [nowIso, limit]
    );
    return result.rows.map((row) => this.rowToPack(row));
  }

  async findDueXPublishes(nowIso: string, limit: number): Promise<LaunchPack[]> {
    const result = await this.pool.query(
      `SELECT id, data, created_at, updated_at
         FROM launch_packs
        WHERE (COALESCE(data->'ops'->>'x_publish_status', 'idle') NOT IN ('in_progress', 'published'))
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'ops'->'x_schedule_intent', data->'x'->'schedule', '[]'::jsonb)) AS s
            WHERE (s->>'when')::timestamptz <= $1::timestamptz
          )
        ORDER BY updated_at ASC
        LIMIT $2`,
      [nowIso, limit]
    );
    return result.rows.map((row) => this.rowToPack(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM launch_packs WHERE id = $1 RETURNING id`,
      [id]
    );
    return Boolean(result.rows?.length);
  }
}
