const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Open positions
  const r1 = await pool.query("SELECT id, strategy, description, chain, status, cost_basis_usd, current_value_usd, unrealized_pnl_usd FROM cfo_positions WHERE status = 'OPEN' LIMIT 5");
  console.log('=== OPEN POSITIONS (' + r1.rows.length + ') ===');
  console.log(JSON.stringify(r1.rows, null, 2));

  // kv_store portfolio summary
  const r2 = await pool.query("SELECT key, substring(data::text, 1, 200) as data_preview FROM kv_store WHERE key LIKE 'cfo:%' LIMIT 10");
  console.log('=== KV_STORE CFO ENTRIES ===');
  console.log(JSON.stringify(r2.rows, null, 2));

  // kv_store columns
  const r3 = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kv_store' ORDER BY ordinal_position");
  console.log('=== KV_STORE COLUMNS ===');
  r3.rows.forEach(r => console.log('  ' + r.column_name + ' (' + r.data_type + ')'));

  // agent_skills sample
  const r4 = await pool.query('SELECT * FROM agent_skills LIMIT 3');
  console.log('=== AGENT_SKILLS SAMPLE ===');
  console.log(JSON.stringify(r4.rows, null, 2));

  // agent_skill_assignments
  const r5 = await pool.query('SELECT * FROM agent_skill_assignments LIMIT 3');
  console.log('=== AGENT_SKILL_ASSIGNMENTS SAMPLE ===');
  console.log(JSON.stringify(r5.rows, null, 2));

  // cfo_daily_snapshots
  const r6 = await pool.query('SELECT count(*) as cnt FROM cfo_daily_snapshots');
  console.log('=== CFO_DAILY_SNAPSHOTS COUNT ===');
  console.log(r6.rows[0].cnt);

  // message type distribution
  const r7 = await pool.query("SELECT message_type, count(*) as cnt FROM agent_messages GROUP BY message_type ORDER BY cnt DESC LIMIT 10");
  console.log('=== MESSAGE TYPE DISTRIBUTION ===');
  console.log(JSON.stringify(r7.rows, null, 2));

  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
