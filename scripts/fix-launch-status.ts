import { LaunchPackRepository } from '../src/launchkit/db/launchPackRepository.ts';

async function fixLaunchStatus() {
  const store = await LaunchPackRepository.create('./data/pglite');
  const packs = await store.list();
  
  for (const pack of packs) {
    if (pack.launch?.mint && pack.launch?.status !== 'launched') {
      console.log(`Fixing ${pack.brand?.name} ($${pack.brand?.ticker}): has mint ${pack.launch.mint} but status is "${pack.launch?.status}"`);
      
      await store.update(pack.id, {
        launch: {
          ...pack.launch,
          status: 'launched',
          launched_at: pack.launch.launched_at || pack.launch.completed_at || new Date().toISOString(),
        }
      });
      
      console.log(`  ✅ Updated status to "launched"`);
    }
  }
  
  console.log('Done!');
  process.exit(0);
}

fixLaunchStatus().catch(console.error);
