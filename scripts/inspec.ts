import 'dotenv/config';
import { Pool } from 'pg';
import { getPglite } from '../src/launchkit/db/pglite.ts';

const args = process.argv.slice(2);
const TABLE = args.find((a) => !a.startsWith('--')) || 'central_messages';
const usePglite = args.includes('--pglite');

async function inspectWithPg(connString: string) {
  const pool = new Pool({ connectionString: connString });
  try {
    const exists = await pool.query(
      `select 1 from information_schema.tables where table_name = $1 limit 1`,
      [TABLE]
    );
    if (exists.rowCount === 0) {
      console.log(`table '${TABLE}' not found`);
      return;
    }

    const cols = await pool.query(
      `select column_name, data_type from information_schema.columns where table_name = $1 order by ordinal_position`,
      [TABLE]
    );
    console.log(`${TABLE} columns:`, cols.rows);

    const constraints = await pool.query(
      `select constraint_name, constraint_type from information_schema.table_constraints where table_name = $1 order by constraint_name`,
      [TABLE]
    );
    console.log(`${TABLE} constraints:`, constraints.rows);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function inspectWithPglite() {
  const db = await getPglite();
  const exists = await db.query(
    `select 1 from information_schema.tables where table_name = $1 limit 1`,
    [TABLE]
  );

  if ((exists as any).rowCount === 0) {
    console.log(`table '${TABLE}' not found`);
    return;
  }

  const cols = await db.query(
    `select column_name, data_type from information_schema.columns where table_name = $1 order by ordinal_position`,
    [TABLE]
  );
  console.log(`${TABLE} columns:`, cols.rows);

  const constraints = await db.query(
    `select constraint_name, constraint_type from information_schema.table_constraints where table_name = $1 order by constraint_name`,
    [TABLE]
  );
  console.log(`${TABLE} constraints:`, constraints.rows);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.trim().length > 0) {
    await inspectWithPg(databaseUrl.trim());
    return;
  }

  if (!usePglite) {
    console.error('No DATABASE_URL set. Provide DATABASE_URL (recommended) or rerun with --pglite to inspect local PGlite.');
    process.exitCode = 1;
    return;
  }

  try {
    await inspectWithPglite();
  } catch (err) {
    console.error('PGlite inspection failed. Set DATABASE_URL or fix local PGlite. Error:', err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('inspec failed:', err);
  process.exitCode = 1;
});
