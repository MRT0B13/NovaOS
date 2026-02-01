/**
 * Migrate data from old Postgres to pgvector database
 * Run with: bun run scripts/migrate-to-pgvector.ts
 */
import pg from 'pg';
const { Pool } = pg;

// Old Postgres (has data, no pgvector extension)
const SOURCE_URL = 'postgresql://postgres:ASssVhBOlXNAoLjttHgogTidXNxckNth@turntable.proxy.rlwy.net:10924/railway';

// pgvector database (has extension, needs data)
const TARGET_URL = 'postgres://postgres:budQTGqhASnqCj3CoFZSVd0sXjn0sHdZ@hopper.proxy.rlwy.net:56852/railway';

async function migrate() {
  console.log('🔄 Starting migration from old Postgres to pgvector...\n');
  
  const source = new Pool({ connectionString: SOURCE_URL, ssl: false });
  const target = new Pool({ connectionString: TARGET_URL, ssl: false });
  
  try {
    // Test connections
    await source.query('SELECT 1');
    console.log('✅ Connected to source (old Postgres)');
    await target.query('SELECT 1');
    console.log('✅ Connected to target (pgvector)\n');
    
    // Migrate launch_packs
    console.log('📦 Migrating launch_packs...');
    const packs = await source.query('SELECT * FROM launch_packs');
    console.log(`   Found ${packs.rows.length} launch packs`);
    
    for (const row of packs.rows) {
      await target.query(`
        INSERT INTO launch_packs (id, data, launch_status, launch_requested_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          launch_status = EXCLUDED.launch_status,
          launch_requested_at = EXCLUDED.launch_requested_at,
          updated_at = EXCLUDED.updated_at
      `, [row.id, row.data, row.launch_status, row.launch_requested_at, row.created_at, row.updated_at]);
    }
    console.log(`   ✅ Migrated ${packs.rows.length} launch packs\n`);
    
    // Migrate secrets
    console.log('🔐 Migrating secrets...');
    try {
      const secrets = await source.query('SELECT * FROM secrets');
      console.log(`   Found ${secrets.rows.length} secrets`);
      
      for (const row of secrets.rows) {
        await target.query(`
          INSERT INTO secrets (key, value_encrypted, created_at, updated_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (key) DO UPDATE SET
            value_encrypted = EXCLUDED.value_encrypted,
            updated_at = EXCLUDED.updated_at
        `, [row.key, row.value_encrypted, row.created_at, row.updated_at]);
      }
      console.log(`   ✅ Migrated ${secrets.rows.length} secrets\n`);
    } catch (err: any) {
      console.log(`   ⚠️ No secrets table or error: ${err.message}\n`);
    }
    
    // Migrate sched_system_metrics
    console.log('📊 Migrating system metrics...');
    try {
      const metrics = await source.query('SELECT * FROM sched_system_metrics WHERE id = $1', ['main']);
      if (metrics.rows.length > 0) {
        const m = metrics.rows[0];
        await target.query(`
          INSERT INTO sched_system_metrics (id, start_time, session_start_time, tweets_sent_today, tg_posts_sent_today, 
            trends_detected_today, errors_24h, warnings_24h, last_report_time, last_daily_report_date, 
            total_messages_received, banned_users, failed_attempts)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO UPDATE SET
            tweets_sent_today = EXCLUDED.tweets_sent_today,
            tg_posts_sent_today = EXCLUDED.tg_posts_sent_today,
            trends_detected_today = EXCLUDED.trends_detected_today,
            total_messages_received = EXCLUDED.total_messages_received
        `, [m.id, m.start_time, m.session_start_time, m.tweets_sent_today, m.tg_posts_sent_today,
            m.trends_detected_today, m.errors_24h, m.warnings_24h, m.last_report_time, m.last_daily_report_date,
            m.total_messages_received, m.banned_users, m.failed_attempts]);
        console.log('   ✅ Migrated system metrics\n');
      }
    } catch (err: any) {
      console.log(`   ⚠️ No metrics or error: ${err.message}\n`);
    }
    
    // Migrate sched_trend_pool
    console.log('📈 Migrating trend pool...');
    try {
      const trends = await source.query('SELECT * FROM sched_trend_pool');
      console.log(`   Found ${trends.rows.length} trends`);
      
      for (const row of trends.rows) {
        await target.query(`
          INSERT INTO sched_trend_pool (id, topic, source, base_score, current_score, context, 
            first_seen_at, last_seen_at, seen_count, boost_count, token_address, dismissed, triggered, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (id) DO UPDATE SET
            current_score = EXCLUDED.current_score,
            last_seen_at = EXCLUDED.last_seen_at,
            seen_count = EXCLUDED.seen_count
        `, [row.id, row.topic, row.source, row.base_score, row.current_score, row.context,
            row.first_seen_at, row.last_seen_at, row.seen_count, row.boost_count, row.token_address,
            row.dismissed, row.triggered, row.metadata]);
      }
      console.log(`   ✅ Migrated ${trends.rows.length} trends\n`);
    } catch (err: any) {
      console.log(`   ⚠️ No trends or error: ${err.message}\n`);
    }
    
    // Migrate sched_autonomous_state
    console.log('🤖 Migrating autonomous state...');
    try {
      const state = await source.query('SELECT * FROM sched_autonomous_state WHERE id = $1', ['main']);
      if (state.rows.length > 0) {
        const s = state.rows[0];
        await target.query(`
          INSERT INTO sched_autonomous_state (id, launches_today, reactive_launches_today, last_launch_date,
            next_scheduled_time, pending_idea, pending_vote_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            launches_today = EXCLUDED.launches_today,
            reactive_launches_today = EXCLUDED.reactive_launches_today,
            last_launch_date = EXCLUDED.last_launch_date,
            next_scheduled_time = EXCLUDED.next_scheduled_time
        `, [s.id, s.launches_today, s.reactive_launches_today, s.last_launch_date,
            s.next_scheduled_time, s.pending_idea, s.pending_vote_id]);
        console.log('   ✅ Migrated autonomous state\n');
      }
    } catch (err: any) {
      console.log(`   ⚠️ No autonomous state or error: ${err.message}\n`);
    }
    
    console.log('🎉 Migration complete!');
    console.log('\nNext steps:');
    console.log('1. Update Railway variables to point to pgvector:');
    console.log('   DATABASE_URL=${{pgvector.DATABASE_URL}}');
    console.log('   POSTGRES_URL=${{pgvector.DATABASE_URL}}');
    console.log('2. Redeploy NovaOS');
    console.log('3. Delete the old Postgres service to save money');
    
  } catch (err) {
    console.error('❌ Migration failed:', err);
  } finally {
    await source.end();
    await target.end();
  }
}

migrate();
