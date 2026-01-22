#!/usr/bin/env bun
/**
 * Direct test of GroupHealthMonitor with real LaunchPack store
 */

import { initLaunchKit } from '../src/launchkit/init.ts';
import { getHealthMonitor, analyzeSentiment, trackMessage, getActivityStats } from '../src/launchkit/services/groupHealthMonitor.ts';

async function test() {
  console.log('🧪 Testing Group Health Monitor (Direct)\n');
  
  // Initialize LaunchKit to get the store
  console.log('📦 Initializing LaunchKit...');
  const { store } = await initLaunchKit();
  
  if (!store) {
    console.error('❌ Store not initialized');
    process.exit(1);
  }
  
  // List packs
  const packs = await store.list();
  console.log(`✅ Found ${packs.length} packs\n`);
  
  for (const pack of packs) {
    console.log(`📋 ${pack.brand?.name} ($${pack.brand?.ticker})`);
    console.log(`   Status: ${pack.launch?.status || 'not launched'}`);
    console.log(`   TG Chat: ${pack.tg?.telegram_chat_id || 'not linked'}`);
    
    if (pack.tg?.telegram_chat_id) {
      // Test health monitor
      const healthMonitor = getHealthMonitor(store);
      
      console.log('\n   📊 Fetching health report...');
      const health = await healthMonitor.getHealthReport(pack.tg.telegram_chat_id);
      
      if (health) {
        console.log(`   👥 Members: ${health.memberCount}`);
        console.log(`   💬 Messages/day: ${health.messagesPerDay}`);
        console.log(`   📈 Sentiment: ${health.sentiment} (${(health.sentimentScore * 100).toFixed(0)}%)`);
        console.log(`   📊 Trend: ${health.trend}`);
      } else {
        console.log('   ⚠️ Could not fetch health (bot may not be in group)');
      }
    }
    console.log('');
  }
  
  // Test sentiment directly
  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Sentiment Tests:\n');
  
  const tests = [
    '🚀 $DUMP to the moon! LFG wagmi',
    'this is dead, rug incoming, selling all',
    'just bought some, curious to see what happens',
  ];
  
  for (const text of tests) {
    const result = analyzeSentiment(text);
    const emoji = result.sentiment === 'positive' ? '🟢' : result.sentiment === 'negative' ? '🔴' : '🟡';
    console.log(`${emoji} "${text.slice(0, 40)}..."`);
    console.log(`   Sentiment: ${result.sentiment}, Score: ${result.score.toFixed(2)}\n`);
  }
  
  console.log('✅ Tests complete!');
  process.exit(0);
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
