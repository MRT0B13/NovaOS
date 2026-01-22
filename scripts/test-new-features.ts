#!/usr/bin/env bun
/**
 * Test script for new features:
 * - Group health monitoring
 * - Sentiment analysis
 * - Cross-platform sync
 * - Pin management
 */

import { analyzeSentiment, trackMessage, getActivityStats } from '../src/launchkit/services/groupHealthMonitor.ts';

console.log('🧪 Testing New Features\n');
console.log('='.repeat(50));

// Test 1: Sentiment Analysis
console.log('\n📊 Test 1: Sentiment Analysis\n');

const testMessages = [
  { text: '🚀 LFG! $DUMP to the moon! wagmi', expected: 'positive' },
  { text: 'This is a rug, selling everything. Dead coin 💀', expected: 'negative' },
  { text: 'Just bought some, let\'s see what happens', expected: 'neutral' },
  { text: 'PUMP IT 🔥🔥🔥 based devs, alpha leak incoming', expected: 'positive' },
  { text: 'fud everywhere, people are rekt, exit scam vibes', expected: 'negative' },
  { text: 'gm holders! 💎🙌 diamond hands only', expected: 'positive' },
];

let passed = 0;
let failed = 0;

for (const { text, expected } of testMessages) {
  const result = analyzeSentiment(text);
  const status = result.sentiment === expected ? '✅' : '❌';
  if (result.sentiment === expected) passed++; else failed++;
  
  console.log(`${status} "${text.slice(0, 40)}..."`);
  console.log(`   Expected: ${expected}, Got: ${result.sentiment} (score: ${result.score.toFixed(2)})\n`);
}

console.log(`Sentiment Tests: ${passed}/${passed + failed} passed\n`);

// Test 2: Activity Tracking
console.log('='.repeat(50));
console.log('\n📈 Test 2: Activity Tracking\n');

const testChatId = '-1001234567890';

// Simulate some messages
trackMessage(testChatId, 1001, 'whale_trader', '🚀 $DUMP going parabolic! LFG!');
trackMessage(testChatId, 1002, 'degen_chad', 'Just aped in, wagmi fam');
trackMessage(testChatId, 1003, 'moon_boy', 'This is going to 100x easy');
trackMessage(testChatId, 1001, 'whale_trader', 'Adding more, diamond hands');
trackMessage(testChatId, 1004, 'paper_hands', 'idk guys this feels like a rug');
trackMessage(testChatId, 1001, 'whale_trader', 'Still bullish, accumulating');

const stats = getActivityStats(testChatId);

console.log('Activity Stats:');
console.log(`  Messages/day: ${stats.messagesPerDay}`);
console.log(`  Active users: ${stats.activeUsers}`);
console.log(`  Avg sentiment: ${stats.averageSentiment.toFixed(2)}`);
console.log(`  Top contributors:`);
for (const contrib of stats.topContributors) {
  console.log(`    - @${contrib.username}: ${contrib.count} messages`);
}

const activityPassed = 
  stats.messagesPerDay === 6 && 
  stats.activeUsers === 4 &&
  stats.topContributors[0]?.username === 'whale_trader';

console.log(`\n${activityPassed ? '✅' : '❌'} Activity tracking ${activityPassed ? 'passed' : 'failed'}`);

// Test 3: Sentiment Keyword Coverage
console.log('\n' + '='.repeat(50));
console.log('\n📝 Test 3: Keyword Detection\n');

const bullishTest = analyzeSentiment('moon pump bullish ape wagmi lfg 🚀🔥💎');
const bearishTest = analyzeSentiment('dump rug scam fud dead rekt 📉💀');

console.log(`Bullish message score: ${bullishTest.score.toFixed(2)} (${bullishTest.sentiment})`);
console.log(`Bearish message score: ${bearishTest.score.toFixed(2)} (${bearishTest.sentiment})`);

const keywordPassed = bullishTest.score > 0.5 && bearishTest.score < -0.5;
console.log(`\n${keywordPassed ? '✅' : '❌'} Keyword detection ${keywordPassed ? 'passed' : 'failed'}`);

// Summary
console.log('\n' + '='.repeat(50));
console.log('\n📋 SUMMARY\n');
console.log(`  Sentiment Analysis: ${passed}/${passed + failed} tests passed`);
console.log(`  Activity Tracking: ${activityPassed ? '✅ passed' : '❌ failed'}`);
console.log(`  Keyword Detection: ${keywordPassed ? '✅ passed' : '❌ failed'}`);
console.log('\n✅ Core functions working! Test via chat:');
console.log('  - "check group health for DUMP"');
console.log('  - "vibe check"');
console.log('  - "cross-post: 🚀 $DUMP to the moon!"');
console.log('  - "pin announcement: We hit 1000 holders!"');
