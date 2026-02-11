/**
 * Quick live test: send a test message to the Telegram community group
 * Run: bun run scripts/test-community-group.ts
 */

async function main() {
  const botToken = process.env.TG_BOT_TOKEN;
  const communityId = process.env.TELEGRAM_COMMUNITY_CHAT_ID;
  const channelId = process.env.NOVA_CHANNEL_ID;
  
  console.log('=== Community Group Routing Test ===\n');
  console.log(`Bot token: ${botToken ? botToken.slice(0, 10) + '...' : 'MISSING'}`);
  console.log(`Community group ID: ${communityId || 'NOT SET'}`);
  console.log(`Channel ID (fallback): ${channelId || 'NOT SET'}`);
  
  if (!botToken) {
    console.error('❌ TG_BOT_TOKEN not set');
    process.exit(1);
  }
  
  // Target: community group first, fallback to channel
  const targetId = communityId || channelId;
  if (!targetId) {
    console.error('❌ Neither TELEGRAM_COMMUNITY_CHAT_ID nor NOVA_CHANNEL_ID set');
    process.exit(1);
  }
  
  const targetLabel = communityId ? 'COMMUNITY GROUP' : 'CHANNEL (fallback)';
  console.log(`\nTarget: ${targetLabel} (${targetId})\n`);
  
  // --- Test 1: getChat to verify bot has access ---
  console.log('1. Testing bot access (getChat)...');
  try {
    const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: targetId }),
    });
    const chatData = await chatRes.json();
    
    if (chatData.ok) {
      const chat = chatData.result;
      console.log(`   ✅ Bot has access to: "${chat.title}" (type: ${chat.type})`);
      if (chat.invite_link) console.log(`   Invite: ${chat.invite_link}`);
    } else {
      console.log(`   ❌ Bot cannot access chat: ${chatData.description}`);
      console.log('   → Make sure the bot is added to the group as an admin');
      process.exit(1);
    }
  } catch (err) {
    console.error(`   ❌ API call failed:`, err);
    process.exit(1);
  }
  
  // --- Test 2: Send a test message ---
  console.log('\n2. Sending test message...');
  const testMessage = `🧪 <b>Community Group Test</b>\n\n` +
    `This is an automated routing test from Nova.\n` +
    `Timestamp: ${new Date().toISOString()}\n\n` +
    `If you see this, the community group routing is ✅ working.\n\n` +
    `<i>This message will be deleted shortly.</i>`;
  
  try {
    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetId,
        text: testMessage,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const sendData = await sendRes.json();
    
    if (sendData.ok) {
      const msgId = sendData.result.message_id;
      console.log(`   ✅ Message sent! (message_id: ${msgId})`);
      
      // --- Test 3: Delete the test message after 5 seconds ---
      console.log('\n3. Waiting 5s then deleting test message...');
      await new Promise(r => setTimeout(r, 5000));
      
      const delRes = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetId, message_id: msgId }),
      });
      const delData = await delRes.json();
      
      if (delData.ok) {
        console.log(`   ✅ Test message deleted`);
      } else {
        console.log(`   ⚠️ Could not delete (${delData.description}) — delete manually`);
      }
    } else {
      console.log(`   ❌ Send failed: ${sendData.description}`);
      if (sendData.description?.includes('not enough rights')) {
        console.log('   → Bot needs "Send Messages" permission in the group');
      }
      if (sendData.description?.includes('chat not found')) {
        console.log('   → Chat ID may be wrong. Try adding -100 prefix: -100' + targetId.replace('-', ''));
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`   ❌ API call failed:`, err);
    process.exit(1);
  }
  
  // --- Test 4: Verify novaChannel routing code ---
  console.log('\n4. Testing novaChannel.ts routing...');
  try {
    const { initNovaChannel, getCommunityGroupId, getCommunityLink, sendToCommunity } = await import('../src/launchkit/services/novaChannel.ts');
    
    initNovaChannel();
    
    const groupId = getCommunityGroupId();
    const link = getCommunityLink();
    
    console.log(`   getCommunityGroupId() → ${groupId}`);
    console.log(`   getCommunityLink() → ${link}`);
    
    if (groupId === communityId) {
      console.log(`   ✅ Routes to community group (not channel)`);
    } else if (groupId === channelId) {
      console.log(`   ⚠️ Falls back to channel (community group ID not detected)`);
    } else {
      console.log(`   ❌ Unexpected routing: ${groupId}`);
    }
    
    // Send via the actual service
    console.log('\n5. Testing sendToCommunity()...');
    const result = await sendToCommunity(
      `🔧 <b>Routing Verification</b>\n\nThis confirms <code>sendToCommunity()</code> routes correctly.\n\n<i>Auto-deleting...</i>`,
      { parseMode: 'HTML' }
    );
    
    if (result.success) {
      console.log(`   ✅ sendToCommunity() succeeded (messageId: ${result.messageId})`);
      
      // Clean up
      if (result.messageId) {
        await new Promise(r => setTimeout(r, 3000));
        await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: targetId, message_id: result.messageId }),
        });
        console.log(`   ✅ Cleanup: message deleted`);
      }
    } else {
      console.log(`   ❌ sendToCommunity() failed`);
    }
  } catch (err) {
    console.error(`   ❌ Import/routing error:`, (err as Error).message);
  }
  
  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
