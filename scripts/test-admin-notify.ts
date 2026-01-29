#!/usr/bin/env bun
/**
 * Test Admin Notification
 * 
 * Run with: bun scripts/test-admin-notify.ts
 */

import { testAdminNotify } from '../src/launchkit/services/adminNotify.ts';

console.log('🧪 Testing admin notification...\n');

const result = await testAdminNotify();

if (result.success) {
  console.log('✅', result.message);
  console.log('\nCheck your Telegram admin chat for the test message!');
} else {
  console.log('❌', result.message);
  console.log('\nMake sure you have set:');
  console.log('  ADMIN_CHAT_ID=your-chat-id');
  console.log('  TG_BOT_TOKEN=your-bot-token');
}
