/**
 * Test: Send a message to community group and pin it.
 * Verifies the bot has Pin Messages admin permission.
 * 
 * Usage: bun scripts/test-pin.ts
 */
import 'dotenv/config';

const botToken = process.env.TG_BOT_TOKEN;
const communityId = process.env.TELEGRAM_COMMUNITY_CHAT_ID;
const channelId = process.env.NOVA_CHANNEL_ID;

console.log('=== Pin Test ===');
console.log(`Bot token: ${botToken ? 'SET' : 'MISSING'}`);
console.log(`Community ID: ${communityId || 'MISSING'}`);
console.log(`Channel ID: ${channelId || 'MISSING'}`);

if (!botToken) {
  console.error('❌ TG_BOT_TOKEN not set');
  process.exit(1);
}

async function testPin(chatId: string, label: string) {
  console.log(`\n--- Testing pin in ${label} (${chatId}) ---`);

  // 1. Check bot's admin status in this chat
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meJson = await meRes.json();
    const botId = meJson.result?.id;
    console.log(`Bot ID: ${botId}`);

    const memberRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: botId }),
    });
    const memberJson = await memberRes.json();
    if (memberJson.ok) {
      const m = memberJson.result;
      console.log(`Bot status: ${m.status}`);
      console.log(`can_pin_messages: ${m.can_pin_messages ?? 'N/A (not admin or creator)'}`);
      console.log(`can_edit_messages: ${m.can_edit_messages ?? 'N/A'}`);
    } else {
      console.log(`❌ getChatMember failed: ${memberJson.description}`);
    }
  } catch (err) {
    console.log(`⚠️ Could not check admin status: ${err}`);
  }

  // 2. Send a test message
  const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🧪 Pin test — ${new Date().toISOString()}`,
    }),
  });
  const sendJson = await sendRes.json();
  if (!sendJson.ok) {
    console.log(`❌ sendMessage failed: ${sendJson.description}`);
    return;
  }
  const messageId = sendJson.result.message_id;
  console.log(`✅ Sent message ${messageId}`);

  // 3. Try to pin it
  const pinRes = await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    }),
  });
  const pinJson = await pinRes.json();
  if (pinJson.ok) {
    console.log(`✅ Pin succeeded!`);
  } else {
    console.log(`❌ Pin FAILED: ${pinJson.description}`);
    console.log(`   → Fix: Make the bot an admin with "Pin Messages" permission in this group`);
  }

  // 4. Delete the test message
  await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  console.log(`🗑️ Cleaned up test message`);
}

// Test community first, then channel
if (communityId) await testPin(communityId, 'Community');
if (channelId && channelId !== communityId) await testPin(channelId, 'Channel');

console.log('\n=== Done ===');
