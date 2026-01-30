#!/usr/bin/env npx ts-node
/**
 * Sync LaunchPacks to Railway
 * 
 * This script creates LaunchPacks on Railway with the necessary data
 * for TG scheduler to work (token mint + TG chat ID).
 */

const RAILWAY_URL = 'https://novaos-production.up.railway.app';
const ADMIN_TOKEN = '7d9f4a2b1c6e8f0d3a5c9e1b4f7a0d2c8b6e1f3a9d5c2e7b0a4f8c1d6e3b9a0f';

// LaunchPack data extracted from tg_scheduled_posts.json
// Using the correct schema with 'brand' instead of 'idea'
const launchPacks = [
  {
    id: '4a3a21b1-515d-40be-8f21-97b44f4fd03a',
    brand: {
      name: 'Sir Dumps-A-Lot',
      ticker: 'DUMP',
      tagline: 'The noble knight of crypto dumps',
      description: 'A medieval meme token featuring Sir Dumps-A-Lot, the legendary knight who dumps bags and takes names.',
    },
    links: {
      website: 'https://candlejoust.com/',
    },
    launch: {
      status: 'launched' as const,
      mint: 'Dewdpg1yyVsHAzGvQM8t9zxynvuek6ubszY4bP6Fpump',
      launched_at: '2026-01-22T00:00:00.000Z',
    },
    tg: {
      telegram_chat_id: '-1003324210820',
      invite_link: 'https://t.me/+YajfYqB7vO43MmM0',
      verified: true,
    },
  },
  {
    id: '800e4afd-31da-420b-a410-d011744e64c5',
    brand: {
      name: 'GPTRug',
      ticker: 'RUG',
      tagline: 'Embrace the chaos',
      description: 'A meme token that embraces the chaotic nature of crypto with humor and community spirit.',
    },
    launch: {
      status: 'launched' as const,
      mint: 'CHWDAsq6XEeDGxpxNqCrFZEZcZpGuZemNjAxUXQu99ZT',
      launched_at: '2026-01-22T00:00:00.000Z',
    },
    tg: {
      telegram_chat_id: '-1003663256702',
      invite_link: 'https://t.me/+3d_8oPSu7Ms3ZmM0',
      verified: true,
    },
  },
  {
    id: '37efea55-2d88-4ec5-8a13-7f90e9ed1818',
    brand: {
      name: 'Ferb',
      ticker: 'FRB',
      tagline: 'Building a meme empire',
      description: 'A meme token inspired by the builder spirit, constructing gains one block at a time.',
    },
    launch: {
      status: 'launched' as const,
      mint: 'HqCURvzMryReDqabn56CPFUepK76EvGWyWPvMXJiHo23',
      launched_at: '2026-01-22T00:00:00.000Z',
    },
    tg: {
      telegram_chat_id: '-1003519261621',
      invite_link: 'https://t.me/+1e8LuP6k_WpjNDM0',
      verified: true,
    },
  },
];

async function syncLaunchPacks() {
  console.log('🚀 Syncing LaunchPacks to Railway...\n');

  for (const pack of launchPacks) {
    console.log(`📦 Creating ${pack.brand.ticker} (${pack.id})...`);
    
    try {
      // First check if it exists
      const checkRes = await fetch(`${RAILWAY_URL}/v1/launchpacks/${pack.id}`, {
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      
      if (checkRes.ok) {
        console.log(`   ✅ Already exists, updating TG chat ID...`);
        // Update with TG info
        const updateRes = await fetch(`${RAILWAY_URL}/v1/launchpacks/${pack.id}`, {
          method: 'PATCH',
          headers: {
            'x-admin-token': ADMIN_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tg: pack.tg,
            launch: pack.launch,
          }),
        });
        
        if (updateRes.ok) {
          console.log(`   ✅ Updated successfully`);
        } else {
          const err = await updateRes.text();
          console.log(`   ❌ Update failed: ${err}`);
        }
      } else {
        // Create new
        const createRes = await fetch(`${RAILWAY_URL}/v1/launchpacks`, {
          method: 'POST',
          headers: {
            'x-admin-token': ADMIN_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(pack),
        });
        
        if (createRes.ok) {
          const result = await createRes.json();
          console.log(`   ✅ Created successfully`);
        } else {
          const err = await createRes.text();
          console.log(`   ❌ Create failed: ${err}`);
        }
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error}`);
    }
  }

  console.log('\n✨ Sync complete!');
  
  // Verify
  console.log('\n📋 Verifying LaunchPacks on Railway...');
  const listRes = await fetch(`${RAILWAY_URL}/v1/launchpacks`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  const list = await listRes.json();
  console.log(`Found ${list.data?.length || 0} LaunchPacks:`);
  for (const p of (list.data || [])) {
    console.log(`   - ${p.brand?.ticker || 'Unknown'}: mint=${p.launch?.mint ? 'YES' : 'NO'}, tg_chat=${p.tg?.telegram_chat_id ? 'YES' : 'NO'}`);
  }
}

syncLaunchPacks().catch(console.error);
