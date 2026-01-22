import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';

async function main() {
  // Try both potential locations
  const paths = [
    '.pglite/launchkit',
    'data/pglite',
    '.pglite'
  ];
  
  for (const dbPath of paths) {
    console.log(`\n--- Checking: ${dbPath} ---`);
    try {
      const db = new PGlite(dbPath);
      
      // List tables
      const tables = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      console.log('Tables:', tables.rows.map(r => r.table_name));
      
      // Try different table names
      for (const tableName of ['launch_packs', 'launchpacks', 'packs']) {
        try {
          const result = await db.query(`
            SELECT id, data->'brand'->>'name' as name, data->'launch' as launch
            FROM ${tableName}
          `);
          console.log(`\n${tableName} rows:`, result.rows.length);
          for (const row of result.rows) {
            console.log(`- ${row.name}: launch =`, row.launch);
            
            // Clear lock if needed
            const launch = row.launch as any;
            if (launch && launch.requested_at && launch.status !== 'launched') {
              console.log(`  ⚠️  Clearing lock...`);
              await db.query(`
                UPDATE ${tableName} 
                SET data = jsonb_set(data, '{launch}', '{}')
                WHERE id = $1
              `, [row.id]);
              console.log(`  ✅ Cleared!`);
            }
          }
        } catch {}
      }
      
      await db.close();
    } catch (e) {
      console.log('Error:', (e as Error).message);
    }
  }
  
  console.log('\nDone!');
  process.exit(0);
}

main();
