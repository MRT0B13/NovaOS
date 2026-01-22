#!/usr/bin/env bun
/**
 * Setup Telegram Webhook
 * 
 * This script configures your Telegram bot to send updates to your webhook endpoint
 * instead of using long-polling. This allows us to intercept the raw updates and
 * cache user IDs before ElizaOS processes them.
 * 
 * IMPORTANT: You need a publicly accessible URL with HTTPS for webhooks.
 * Options:
 * 1. Use ngrok: ngrok http 3333 (then use the HTTPS URL)
 * 2. Deploy to a server with a domain
 * 3. Use Cloudflare Tunnel
 * 
 * Usage:
 *   bun run scripts/setup-telegram-webhook.ts https://your-domain.com/telegram-webhook
 *   bun run scripts/setup-telegram-webhook.ts --delete  # Remove webhook (go back to polling)
 *   bun run scripts/setup-telegram-webhook.ts --info    # Check current webhook status
 */

const BOT_TOKEN = process.env.TG_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TG_BOT_TOKEN environment variable not set');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgApi(method: string, params?: Record<string, any>): Promise<any> {
  const url = `${API_BASE}/${method}`;
  const res = await fetch(url, {
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

async function getWebhookInfo() {
  const info = await tgApi('getWebhookInfo');
  console.log('\n📡 Current Webhook Status:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`URL: ${info.url || '(not set - using long polling)'}`);
  if (info.url) {
    console.log(`Has custom certificate: ${info.has_custom_certificate}`);
    console.log(`Pending updates: ${info.pending_update_count}`);
    console.log(`Max connections: ${info.max_connections || 40}`);
    console.log(`Allowed updates: ${JSON.stringify(info.allowed_updates || 'all')}`);
    if (info.last_error_date) {
      const errorDate = new Date(info.last_error_date * 1000);
      console.log(`⚠️ Last error: ${info.last_error_message} (${errorDate.toISOString()})`);
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return info;
}

async function deleteWebhook() {
  console.log('🗑️ Deleting webhook...');
  await tgApi('deleteWebhook', { drop_pending_updates: false });
  console.log('✅ Webhook deleted. Bot will now use long polling.');
}

async function setWebhook(url: string) {
  console.log(`\n🔧 Setting webhook to: ${url}`);
  
  // Validate URL
  if (!url.startsWith('https://')) {
    console.error('❌ Webhook URL must use HTTPS');
    process.exit(1);
  }
  
  // Set webhook with allowed_updates including chat_member for join tracking
  await tgApi('setWebhook', {
    url,
    allowed_updates: [
      'message',
      'edited_message', 
      'channel_post',
      'edited_channel_post',
      'callback_query',
      'chat_member',  // Important: Get notified when users join/leave
      'my_chat_member', // When bot is added/removed from chats
    ],
    drop_pending_updates: false,
    max_connections: 40,
  });
  
  console.log('✅ Webhook set successfully!');
  console.log('\n📋 Allowed update types:');
  console.log('  - message: Regular messages (includes from.id!)');
  console.log('  - chat_member: User join/leave events (for preemptive caching)');
  console.log('  - callback_query: Inline button clicks');
  
  // Verify
  await getWebhookInfo();
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--info') || args.length === 0) {
  await getWebhookInfo();
} else if (args.includes('--delete')) {
  await deleteWebhook();
  await getWebhookInfo();
} else {
  const webhookUrl = args[0];
  await setWebhook(webhookUrl);
  
  console.log('📝 Next steps:');
  console.log('1. Your LaunchKit server must be running on port 3333');
  console.log('2. The webhook URL should point to /telegram-webhook');
  console.log('3. User IDs will now be cached when messages arrive');
  console.log('4. KICK_SPAMMER will be able to ban users directly\n');
}
