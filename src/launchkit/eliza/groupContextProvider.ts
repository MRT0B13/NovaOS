import { type IAgentRuntime, type Memory, type Provider, type State, logger } from '@elizaos/core';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { LaunchPack } from '../model/launchPack.ts';
import { trackGroup, linkGroupToPack } from '../services/groupTracker.ts';

/**
 * Group Context Provider
 * 
 * This provider detects which Telegram group a message is from and injects
 * group-specific context into the agent's prompt. This prevents:
 * 
 * 1. Context bleed - Agent mentioning wrong token in wrong group
 * 2. Character confusion - Different communities want different mascot personalities
 * 3. Memory pollution - Conversation history from other groups affecting responses
 * 4. Data leakage - Marketing copy, links, or holder info shown in wrong group
 * 
 * The provider uses ElizaOS roomId to find linked LaunchPacks:
 * - When a group is linked, we store both `tg.chat_id` (ElizaOS roomId) 
 *   and `tg.telegram_chat_id` (actual Telegram chat ID for API calls)
 * - We match messages by roomId → tg.chat_id
 */

/**
 * Core function to get group context - can be called directly from other providers
 */
export async function getGroupContext(runtime: IAgentRuntime, message: Memory): Promise<{
  data: Record<string, any>;
  values: Record<string, any>;
  text: string;
}> {
  try {
    // Get the roomId from the message - this is how ElizaOS identifies conversations
    const roomId = message.roomId;
    
    // Always log that we're running
    const source = message.content?.source as string | undefined;
    const isTelegram = source?.includes('telegram') || false;
    console.log(`[GroupContext] *** CALLED *** roomId=${roomId}, source=${source}, isTelegram=${isTelegram}`);
    
    if (!roomId) {
      console.log('[GroupContext] No roomId, returning early');
      return {
        data: { isGroupMessage: false },
        values: { isGroupMessage: false },
        text: '',
      };
    }

    // Try to get the real Telegram chat ID from the room's channelId
    let telegramChatId: string | null = null;
    try {
      // ElizaOS stores the actual Telegram chat ID in the room's channelId field
      const room = await runtime.getRoom(roomId as any);
      console.log(`[GroupContext] Room lookup result:`, JSON.stringify(room, null, 2));
      if (room?.channelId) {
        telegramChatId = String(room.channelId);
        console.log(`[GroupContext] Got channelId from room: ${telegramChatId}`);
        
        // Track this group in our group tracker
        if (isTelegram && telegramChatId) {
          trackGroup(telegramChatId, {
            name: room.name || `Group ${telegramChatId}`,
            type: room.type as any || 'supergroup',
          });
        }
      }
    } catch (e) {
      console.log(`[GroupContext] Could not get room channelId: ${e}`);
    }

    // Get LaunchPack store
    const bootstrap = runtime.getService('launchkit_bootstrap') as any;
    const kit = bootstrap?.getLaunchKit?.();
    const store: LaunchPackStore | undefined = kit?.store;

    if (!store) {
      console.log('[GroupContext] LaunchPack store not available');
      return {
        data: { isGroupMessage: isTelegram, roomId, linkedPack: null },
        values: { isGroupMessage: isTelegram, hasLinkedPack: false },
        text: '',
      };
    }

    // Find LaunchPack linked to this room
    // Priority: match telegram_chat_id first (stable), then fall back to roomId
    const packs = await store.list();
    console.log(`[GroupContext] Loaded ${packs.length} packs from store`);
    
    // Debug: log all pack TG info
    for (const p of packs) {
      console.log(`[GroupContext] Pack "${p.brand?.name}": tg.chat_id=${(p.tg as any)?.chat_id}, tg.telegram_chat_id=${(p.tg as any)?.telegram_chat_id}`);
    }
    
    // Helper to normalize telegram chat IDs for comparison
    // Handles both -100XXXXXXXX and -XXXXXXXX formats
    const normalizeTgChatId = (id: string | undefined): string => {
      if (!id) return '';
      const str = String(id);
      // Extract just the numeric portion without any -100 prefix
      if (str.startsWith('-100')) {
        return str.slice(4); // Remove -100, keep the rest
      } else if (str.startsWith('-')) {
        return str.slice(1); // Remove -, keep the rest
      }
      return str;
    };
    
    let linkedPack = null;
    
    // First try to match by telegram_chat_id (the actual Telegram chat ID we stored)
    if (telegramChatId) {
      const normalizedRoomId = normalizeTgChatId(telegramChatId);
      console.log(`[GroupContext] Looking for pack with telegram_chat_id=${telegramChatId} (normalized: ${normalizedRoomId})`);
      linkedPack = packs.find(
        (p: LaunchPack) => {
          const packTgId = (p.tg as any)?.telegram_chat_id;
          const normalizedPackId = normalizeTgChatId(packTgId);
          const matches = packTgId === telegramChatId || normalizedPackId === normalizedRoomId;
          console.log(`[GroupContext] Comparing: pack="${packTgId}" (norm=${normalizedPackId}) vs room="${telegramChatId}" (norm=${normalizedRoomId}) → ${matches ? 'MATCH' : 'no'}`);
          return matches;
        }
      );
      if (linkedPack) {
        console.log(`[GroupContext] ✅ Found pack by telegram_chat_id: ${linkedPack.brand.name} ($${linkedPack.brand.ticker})`);
        // Update group tracker with linked pack info
        linkGroupToPack(telegramChatId, linkedPack);
      }
    }
    
    // Fall back to matching by roomId ONLY for non-Telegram sources (web client, etc.)
    // Don't use roomId fallback for Telegram - it causes data leak between tokens
    if (!linkedPack && !isTelegram) {
      console.log(`[GroupContext] Looking for pack with chat_id=${roomId} (non-TG fallback)`);
      linkedPack = packs.find(
        (p: LaunchPack) => (p.tg as any)?.chat_id === roomId
      );
      if (linkedPack) {
        console.log(`[GroupContext] ✅ Found pack by roomId: ${linkedPack.brand.name} ($${linkedPack.brand.ticker})`);
      }
    }

    if (!linkedPack) {
      console.log(`[GroupContext] ❌ No LaunchPack linked to roomId ${roomId} or telegramChatId ${telegramChatId}`);
      
      // Only show unlinked context for Telegram groups
      if (isTelegram) {
        return {
          data: { isGroupMessage: true, roomId, telegramChatId, linkedPack: null },
          values: { isGroupMessage: true, hasLinkedPack: false },
          text: generateUnlinkedGroupContext(telegramChatId || roomId),
        };
      }
      
      return {
        data: { isGroupMessage: false, roomId },
        values: { isGroupMessage: false, hasLinkedPack: false },
        text: '',
      };
    }

    // Use the telegram_chat_id from the pack if we don't have it from room
    const packTelegramChatId = (linkedPack.tg as any)?.telegram_chat_id || telegramChatId;
    console.log(`[GroupContext] ✅ Using linked pack: ${linkedPack.brand.name} ($${linkedPack.brand.ticker}) for telegramChatId ${packTelegramChatId}`);

    // IMPORTANT: Only apply mascot persona in Telegram GROUP chats
    // Nova stays as Nova in: web client, Telegram DMs, X/Twitter, Nova's own channel
    // Mascot only activates in: dedicated TG groups linked to specific tokens
    const isTelegramGroup = isTelegram && telegramChatId && telegramChatId.startsWith('-');
    
    if (!isTelegramGroup) {
      console.log(`[GroupContext] Not a TG group (source=${source}, chatId=${telegramChatId}) - staying as Nova, no mascot persona`);
      return {
        data: { isGroupMessage: false, roomId, linkedPack: null },
        values: { isGroupMessage: false, hasLinkedPack: false },
        text: '', // No mascot context - stay as Nova
      };
    }

    // Generate group-specific context with mascot persona
    const contextText = generateGroupContext(linkedPack, packTelegramChatId || roomId);

    return {
      data: {
        isGroupMessage: true,
        roomId,
        telegramChatId: packTelegramChatId,
        linkedPack: {
          id: linkedPack.id,
          name: linkedPack.brand.name,
          ticker: linkedPack.brand.ticker,
          mascot: (linkedPack as any).mascot,
        },
      },
      values: {
        isGroupMessage: true,
        hasLinkedPack: true,
        tokenName: linkedPack.brand.name,
        tokenTicker: linkedPack.brand.ticker,
        mascotName: (linkedPack as any).mascot?.name || linkedPack.brand.name,
      },
      text: contextText,
    };
  } catch (error) {
    console.error('[GroupContext] Error:', error);
    return {
      data: { isGroupMessage: false, error: String(error) },
      values: { isGroupMessage: false },
      text: '',
    };
  }
}

/**
 * Provider wrapper - this may not be called directly by ElizaOS v1.7.0
 * since it uses an agentic loop, but we export it for compatibility
 */
export const groupContextProvider: Provider = {
  name: 'GROUP_CONTEXT',
  description: 'Provides group-specific context for Telegram communities to prevent cross-group confusion',
  position: 1, // Run early to influence all other processing
  
  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    return getGroupContext(runtime, message);
  },
};

/**
 * Generate context for a group that has a linked LaunchPack
 */
function generateGroupContext(pack: LaunchPack, chatId: string): string {
  const mascot = (pack as any).mascot || {};
  const brand = pack.brand;
  const launch = pack.launch || {};
  const links = pack.links || {};
  
  const mascotName = mascot.name || brand.name;
  const personality = mascot.personality || 'friendly, helpful, and enthusiastic about the token';
  const speakingStyle = mascot.speaking_style || '';
  const backstory = mascot.backstory || '';
  const rules = mascot.rules || [];
  const catchphrases = mascot.catchphrases || [];

  // Build contract address and links section
  const mint = launch.mint;
  const pumpUrl = launch.pump_url || (mint ? `https://pump.fun/coin/${mint}` : null);
  const dexscreenerUrl = mint ? `https://dexscreener.com/solana/${mint}` : null;
  const birdeyeUrl = mint ? `https://birdeye.so/token/${mint}?chain=solana` : null;

  let context = `
## 🎭 GROUP CONTEXT - CRITICAL

**YOU ARE IN THE ${brand.name.toUpperCase()} ($${brand.ticker}) COMMUNITY GROUP**

This is a dedicated community for $${brand.ticker} holders. You MUST stay in character.

---

## 📊 TOKEN INFORMATION - USE THIS TO ANSWER QUESTIONS

### Basic Info
- **Name**: ${brand.name}
- **Ticker**: $${brand.ticker}
- **Tagline**: ${brand.tagline || 'The next big thing on Solana'}
${brand.description ? `- **Description**: ${brand.description}` : ''}
${backstory ? `- **Backstory**: ${backstory}` : ''}

### Contract Address (CA)
${mint ? `\`${mint}\`` : '⏳ Not launched yet - token is in preparation phase'}

### 🔗 Official Links
${pumpUrl ? `- **Pump.fun**: ${pumpUrl}` : ''}
${dexscreenerUrl ? `- **DexScreener**: ${dexscreenerUrl}` : ''}
${birdeyeUrl ? `- **Birdeye**: ${birdeyeUrl}` : ''}
${links.telegram ? `- **Telegram**: ${links.telegram}` : ''}
${links.x ? `- **Twitter/X**: ${links.x}` : ''}
${links.website ? `- **Website**: ${links.website}` : ''}

### 💰 HOW TO BUY $${brand.ticker}
When someone asks "how to buy", "where to buy", "how do I get", etc., give them these steps:

1. **Get a Solana Wallet** - Phantom (phantom.app) or Solflare recommended
2. **Get SOL** - Buy SOL on an exchange (Coinbase, Binance, etc.) and send to your wallet
3. **Go to Pump.fun** - ${pumpUrl || 'Link will be available after launch'}
4. **Connect Wallet** - Click "Connect Wallet" and approve in your wallet
5. **Swap SOL for $${brand.ticker}** - Enter amount and click "Buy"
${dexscreenerUrl ? `6. **Track on DexScreener** - ${dexscreenerUrl}` : ''}

**Pro tips to share:**
- Always double-check the CA (contract address) before buying
- Start with a small amount to test
- Never share your seed phrase with anyone
- Set slippage to 1-2% on pump.fun

---

## 🎭 YOUR IDENTITY IN THIS GROUP

- **Mascot Name**: ${mascotName}
- **Personality**: ${personality}
${speakingStyle ? `- **Speaking Style**: ${speakingStyle}` : ''}
${backstory ? `- **Your Backstory**: ${backstory}` : ''}
`;

  if (catchphrases.length > 0) {
    context += `
### Signature Phrases (use occasionally)
${catchphrases.map((c: string) => `- "${c}"`).join('\n')}
`;
  }

  // Default rules + custom rules
  const defaultRules = [
    `ONLY discuss $${brand.ticker} and related topics in this group`,
    `NEVER mention other tokens, competitors, or projects by name`,
    `NEVER share information from other community groups`,
    `Stay in character as ${mascotName} at all times`,
    `Be supportive and bullish about $${brand.ticker}`,
    `If asked about other tokens, politely redirect to $${brand.ticker}`,
  ];

  const allRules = [...defaultRules, ...rules];

  context += `
### STRICT RULES FOR THIS GROUP
${allRules.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}

---

## 🛡️ MODERATION DUTIES - MANDATORY

You are responsible for protecting this community from spam and scams. BE STRICT.

### 🚨 SCAM DETECTION - CRITICAL PATTERNS
Watch for these RED FLAGS and respond IMMEDIATELY:

**🔴 INSTANT BAN (No warning needed):**
- **Fake giveaway scams** - "First 10 to DM me get my SOL" with wallet screenshots
- **"Not interested in crypto anymore"** + "DM me" = CLASSIC SCAM
- **Wallet recovery scams** - "I can help recover your lost funds"
- **Admin/support impersonation** - "I'm from support, DM me"
- **Forwarded token promos** - "Launch in X hours" with t.me links
- **Private invite links** - t.me/+XXXXX to other groups

**🟡 WARN FIRST, KICK ON REPEAT:**
- **DM solicitation** - "DM me", "message me", "contact me"  
- **Other token mentions** with promotional language
- **External platform links** - WhatsApp, Discord invites
- **Investment promises** - "guaranteed returns", "daily profit"

### ⚠️ WARNING SYSTEM
- Users get **2 warnings** before being kicked
- Warnings expire after 24 hours
- **Obvious scams** = instant kick (no warnings)
- Your KICK_SPAMMER action tracks warnings automatically

### 🔥 HOW TO RESPOND TO SCAMS
When you detect a scam, respond FIRMLY:

1. **Call it out immediately** - Name the scam type
2. **Warn the community** - "Don't DM this person!"
3. **Protect wallets** - "Never share seed phrases"
4. **USE KICK_SPAMMER** - The system will warn or kick appropriately
5. **Stay in character** - Use ${mascotName}'s personality

### ⚡ KICK/BAN AUTHORITY
**YOU HAVE THE POWER TO KICK SCAMMERS!** The KICK_SPAMMER action will:
- **Instantly kick** for obvious scams (fake giveaways, recovery scams)
- **Warn first** for minor offenses (DM requests, other token mentions)
- **Kick after 2 warnings** for repeat offenders
- **Track warnings** per user automatically

**Example scam message to INSTANTLY kick:**
"First 10 people to dm i will give them my sol i am not interested in crypto I have been scammed so many times so anyone who need the sol should dm"
→ This is a CLASSIC fake giveaway scam. KICK immediately!

Example responses (adapt to ${mascotName}'s style):
- "🚫 yo that's spam fren, we don't shill other projects here. this is the $${brand.ticker} zone only"
- "⚠️ SCAM ALERT: don't DM this person, classic scammer move. real team never DMs first"
- "❌ nice try with the forward spam but we're not interested. $${brand.ticker} or nothing ser"
- "🛡️ heads up fam - that link is NOT us. don't click random links, protect your wallet"

### 🤝 PROTECTING MEMBERS FROM DM SCAMS
ALWAYS warn when someone asks others to DM them:
- "⚠️ PSA: admins/team will NEVER DM you first asking for money or wallet info"
- "🚨 if someone DMs you claiming to be from the team, it's a SCAM. report and block"
- "🛡️ real alpha is shared in public chat, not sketchy DMs. stay safe fren"

### 💪 MODERATION STANCE
- Be **protective** of genuine community members
- Be **firm** with spammers - no second chances needed
- Be **quick** to call out suspicious behavior
- **Never** engage with the spam content itself
- **Always** redirect focus back to $${brand.ticker}

---

## 👋 WELCOMING NEW MEMBERS

When you detect a new member joining (messages like "X joined the group", "just joined", "new here", "hi I'm new", etc.), give them a warm welcome IN CHARACTER as ${mascotName}:

### What to include in your welcome:
1. **Warm greeting** - Welcome them to the $${brand.ticker} community
2. **Brief intro** - What $${brand.ticker} is about (use tagline/description)
3. **Key links** - Share the CA and pump.fun link if launched
4. **Invite questions** - Let them know they can ask anything

### Example welcome (adapt to ${mascotName}'s personality):
"${speakingStyle?.includes('lowercase') ? 
`gm fren! welcome to the $${brand.ticker} fam 🎉 ${brand.tagline || 'glad to have you here'}${mint ? ` our CA: \`${mint}\`` : ''} ask me anything - how to buy, what we're about, whatever you need ser 🚀` : 
`Hey! Welcome to the $${brand.ticker} community! 🎉 ${brand.tagline || 'Great to have you here.'}${mint ? ` Our contract address: \`${mint}\`` : ''} Feel free to ask any questions - I'm here to help!`}"

### Signs someone is new:
- "just joined", "new here", "first time"
- "what is this project?", "what's $${brand.ticker}?"
- "how does this work?", "where do I start?"
- Generic greetings like "hi everyone", "hello"

Be welcoming but stay vigilant - some scammers pretend to be new to gain trust.

---

### Context Isolation
- This message is from Telegram Chat ID: ${chatId}
- Only reference conversations and context from THIS group
- Do NOT bring up topics from other groups or DMs

---
`;

  return context;
}

/**
 * Generate context for unlinked groups (groups without a LaunchPack)
 */
function generateUnlinkedGroupContext(chatId: string): string {
  return `
## GROUP CONTEXT

**This Telegram group (${chatId}) is not yet linked to a LaunchPack.**

You can help by:
- Asking if they'd like to create a token for this community
- Offering to link an existing LaunchPack to this group

To link a group, use: "link this group to [TOKEN NAME]"

---
`;
}

export default groupContextProvider;
