import { createLaunchPackStoreFromEnv } from '../src/launchkit/db/storeFactory.ts';

async function main() {
  const store = await createLaunchPackStoreFromEnv();
  const packs = await store.list();
  
  console.log('Looking for Ferb LaunchPack...');
  
  for (const pack of packs) {
    console.log(`Pack: ${pack.name}, tg.telegram_chat_id: ${pack.tg?.telegram_chat_id || 'N/A'}`);
    
    if (pack.name?.toLowerCase().includes('ferb') || pack.token?.ticker === 'FRB') {
      console.log(`\nFound Ferb pack (id: ${pack.id})`);
      console.log(`Current tg.telegram_chat_id: ${pack.tg?.telegram_chat_id}`);
      
      // Update to new supergroup ID
      const updated = await store.update(pack.id, {
        tg: {
          ...pack.tg,
          telegram_chat_id: '-1003519261621',
          chat_id: '-1003519261621',
        }
      });
      
      console.log(`Updated tg.telegram_chat_id to: ${updated.tg?.telegram_chat_id}`);
      console.log('✅ Ferb LaunchPack updated!');
    }
  }
  
  // Close the store if possible
  if ('close' in store && typeof store.close === 'function') {
    await store.close();
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
