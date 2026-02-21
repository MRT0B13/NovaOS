import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  // Skip if central server is disabled
  if (process.env.ELIZA_DISABLE_SERVER === 'true') {
    console.log('Central server disabled; skipping schema check.');
    return;
  }
  
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('No DATABASE_URL set; skipping central schema check.');
    return;
  }

  const client = new Client({ connectionString: url, ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    // Install required extensions (non-fatal if they fail)
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      console.log('✓ pgcrypto extension ensured');
    } catch (err) {
      console.warn('Could not install pgcrypto (may already exist or lack permissions):', err.message);
    }
    
    // Check if vector extension is available before trying to install
    try {
      const vectorCheck = await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
      if (vectorCheck.rows.length > 0) {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
        console.log('✓ vector extension ensured');
      } else {
        console.log('ℹ vector extension not available on this Postgres version - embeddings will use fallback');
      }
    } catch (err) {
      console.warn('Could not check/install vector extension:', err.message);
    }

    await client.query(`
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
    await client.query(`
      CREATE INDEX IF NOT EXISTS central_messages_channel_id_idx ON central_messages(channel_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS central_messages_created_at_idx ON central_messages(created_at);
    `);
    
    // Add foreign key for channel_id if central_channels table exists
    // First clean up orphan rows that would violate the constraint
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'central_channels') THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'central_messages_channel_id_fkey'
          ) THEN
            -- Remove orphan messages whose channel_id doesn't exist in central_channels
            DELETE FROM central_messages 
            WHERE channel_id NOT IN (SELECT id FROM central_channels);
            
            ALTER TABLE central_messages 
            ADD CONSTRAINT central_messages_channel_id_fkey 
            FOREIGN KEY (channel_id) REFERENCES central_channels(id) ON DELETE CASCADE;
          END IF;
        END IF;
      END $$;
    `);
    console.log('central_messages schema ensured');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ensure-central-schema failed:', err);
  process.exitCode = 1;
});
