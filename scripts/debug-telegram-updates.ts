#!/usr/bin/env bun
/**
 * Debug: Check what data ElizaOS passes for Telegram messages
 * 
 * This script fetches recent updates from Telegram and shows what data is available
 * vs what ElizaOS passes to actions.
 * 
 * Run: bun run scripts/debug-telegram-updates.ts
 */

const BOT_TOKEN = process.env.TG_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TG_BOT_TOKEN environment variable not set');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgApi(method: string, params?: Record<string, any>): Promise<any> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });
  const json = await res.json() as any;
  if (!json.ok) {
    throw new Error(`Telegram API error: ${json.description || 'Unknown error'}`);
  }
  return json.result;
}

async function main() {
  console.log('\n📡 Fetching recent Telegram updates...\n');
  
  // Get webhook info first to check mode
  const webhookInfo = await tgApi('getWebhookInfo');
  console.log('🔧 Current Mode:', webhookInfo.url ? `Webhook (${webhookInfo.url})` : 'Long Polling');
  
  if (webhookInfo.url) {
    console.log('⚠️  Cannot fetch updates while webhook is set.');
    console.log('    Updates are being sent to your webhook URL.');
    console.log('\nTo switch to long polling for testing:');
    console.log('    bun run scripts/setup-telegram-webhook.ts --delete');
    process.exit(0);
  }
  
  // Fetch recent updates (peek mode - doesn't confirm them)
  const updates = await tgApi('getUpdates', {
    limit: 5,
    timeout: 1,
    offset: -5, // Get last 5 updates
  });
  
  if (!updates || updates.length === 0) {
    console.log('📭 No recent updates found.');
    console.log('\n💡 Tip: Send a message to your bot or in a group where the bot is a member.');
    process.exit(0);
  }
  
  console.log(`\n📬 Found ${updates.length} recent update(s):\n`);
  console.log('━'.repeat(60));
  
  for (const update of updates) {
    console.log(`\n📩 Update ID: ${update.update_id}`);
    console.log('─'.repeat(40));
    
    // Check what type of update
    const updateType = Object.keys(update).filter(k => k !== 'update_id')[0];
    console.log(`Type: ${updateType}`);
    
    const data = update[updateType];
    
    // For messages, show key fields
    if (data?.from) {
      console.log('\n👤 FROM (User):');
      console.log(`   id: ${data.from.id} ← THIS IS THE user_id WE NEED!`);
      console.log(`   username: ${data.from.username || '(none)'}`);
      console.log(`   first_name: ${data.from.first_name || '(none)'}`);
      console.log(`   is_bot: ${data.from.is_bot}`);
    }
    
    if (data?.chat) {
      console.log('\n💬 CHAT:');
      console.log(`   id: ${data.chat.id}`);
      console.log(`   type: ${data.chat.type}`);
      console.log(`   title: ${data.chat.title || '(private)'}`);
    }
    
    if (data?.message_id) {
      console.log(`\n📝 message_id: ${data.message_id} ← THIS IS NEEDED FOR /ban REPLY`);
    }
    
    if (data?.text) {
      const preview = data.text.length > 100 ? data.text.slice(0, 100) + '...' : data.text;
      console.log(`\n📄 Text: "${preview}"`);
    }
    
    console.log('\n─'.repeat(40));
    
    // Show what ElizaOS would pass vs what's actually available
    console.log('\n🔍 COMPARISON:');
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│ Telegram provides    │ ElizaOS passes to actions       │');
    console.log('├──────────────────────┼──────────────────────────────────┤');
    console.log(`│ from.id: ${String(data?.from?.id || 'N/A').padEnd(10)} │ ❌ NOT PASSED (stripped)          │`);
    console.log(`│ message_id: ${String(data?.message_id || 'N/A').padEnd(7)} │ ❌ NOT PASSED (stripped)          │`);
    console.log(`│ from.username        │ ✅ Sometimes in metadata          │`);
    console.log(`│ from.first_name      │ ✅ entity.names[]                 │`);
    console.log(`│ text                 │ ✅ message.content.text           │`);
    console.log(`│ chat.id              │ ✅ room.channelId                 │`);
    console.log('└─────────────────────────────────────────────────────────┘');
  }
  
  console.log('\n\n📋 SUMMARY:');
  console.log('━'.repeat(60));
  console.log('The critical issue is that ElizaOS v1.7.0 does NOT pass:');
  console.log('  • from.id (user_id) - Required for banChatMember API');
  console.log('  • message_id - Required for replying to spam with /ban');
  console.log('');
  console.log('SOLUTIONS:');
  console.log('  1. Use @username with /ban command (if spammer has username)');
  console.log('  2. Switch to webhook mode to intercept raw updates');
  console.log('  3. Human admin manually replies to spam with /ban');
  console.log('━'.repeat(60));
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
