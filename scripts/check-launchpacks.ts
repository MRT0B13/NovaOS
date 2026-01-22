#!/usr/bin/env bun
import { PGlite } from '@electric-sql/pglite';
import { join } from 'path';

const dbPath = join(process.cwd(), 'data', 'pglite');
const db = new PGlite(dbPath);

console.log('🔍 Checking LaunchPacks in database...\n');

const result = await db.query(`
  SELECT 
    id, 
    created_at,
    brand->>'name' as name,
    brand->>'ticker' as ticker,
    brand->>'description' as description,
    ops->>'checklist' as checklist,
    tg->>'pins' as tg_pins
  FROM launchpacks 
  ORDER BY created_at DESC 
  LIMIT 5
`);

if (result.rows.length === 0) {
  console.log('❌ No LaunchPacks found in database');
} else {
  console.log(`✅ Found ${result.rows.length} LaunchPack(s):\n`);
  
  for (const row of result.rows) {
    console.log(`📦 LaunchPack: ${row.id}`);
    console.log(`   Name: ${row.name} (${row.ticker})`);
    console.log(`   Description: ${row.description}`);
    console.log(`   Created: ${row.created_at}`);
    
    if (row.checklist) {
      const checklist = JSON.parse(row.checklist);
      console.log(`   Checklist:`, checklist);
    }
    
    if (row.tg_pins) {
      const pins = JSON.parse(row.tg_pins);
      console.log(`   TG Pins:`, {
        welcome: pins.welcome?.substring(0, 50) + '...',
        how_to_buy: pins.how_to_buy?.substring(0, 50) + '...',
        memekit: pins.memekit?.substring(0, 50) + '...'
      });
    }
    
    console.log('');
  }
}

await db.close();
