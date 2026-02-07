/**
 * Quick test: DALL-E image generation + hashtag generation
 * Run: bun scripts/test-image-hashtags.ts
 */
import 'dotenv/config';

// Test hashtag generation (no API needed)
const HASHTAG_POOLS = {
  crypto: ['#Crypto', '#Web3', '#DeFi', '#Solana', '#SOL', '#CryptoTwitter', '#Blockchain'],
  ai: ['#AI', '#AIAgent', '#ArtificialIntelligence', '#AITrading', '#AutomatedTrading'],
  degen: ['#Degen', '#Memecoin', '#CryptoMemes', '#WAGMI', '#GonnaMakeIt'],
  market: ['#CryptoMarket', '#Trading', '#BullRun', '#BearMarket', '#MarketUpdate'],
  community: ['#CryptoCommunity', '#BuildInPublic', '#CryptoFam'],
  nova: ['#NovaAI', '#NovaAgent'],
};

const TYPE_HASHTAG_MAP: Record<string, (keyof typeof HASHTAG_POOLS)[]> = {
  gm: ['crypto', 'community', 'nova'],
  hot_take: ['crypto', 'degen', 'ai'],
  market_roast: ['market', 'degen', 'crypto'],
  ai_thoughts: ['ai', 'crypto', 'community'],
  degen_wisdom: ['degen', 'crypto', 'community'],
  random_banter: ['crypto', 'degen', 'community'],
};

function generateHashtags(type: string): string {
  const categories = TYPE_HASHTAG_MAP[type] || ['crypto', 'nova'];
  const pool: string[] = [];
  for (const cat of categories) {
    pool.push(...(HASHTAG_POOLS[cat] || []));
  }
  const novaTag = HASHTAG_POOLS.nova[Math.floor(Math.random() * HASHTAG_POOLS.nova.length)];
  const otherTags = pool
    .filter(t => !HASHTAG_POOLS.nova.includes(t))
    .sort(() => Math.random() - 0.5)
    .slice(0, 2 + Math.floor(Math.random() * 2));
  const allTags = [...new Set([novaTag, ...otherTags])];
  return allTags.join(' ');
}

console.log('=== Hashtag Generation Test ===\n');
const types = ['gm', 'hot_take', 'market_roast', 'ai_thoughts', 'degen_wisdom', 'random_banter'];
for (const type of types) {
  const tags = generateHashtags(type);
  console.log(`${type.padEnd(16)} → ${tags}`);
}

// Test tweet with hashtags (280 char limit)
console.log('\n=== Tweet + Hashtags Fit Test ===\n');
const sampleTweet = "GM fam! Day 3 with 0.27 SOL. Just a robot trying to make it in crypto. Let's see what today brings!";
const tags = generateHashtags('gm');
const fullTweet = `${sampleTweet}\n\n${tags}`;
console.log(`Tweet (${sampleTweet.length} chars) + Hashtags (${tags.length} chars) = ${fullTweet.length} chars`);
console.log(`Under 280: ${fullTweet.length <= 280 ? '✅' : '❌'}`);
console.log(`\n"${fullTweet}"`);

// Test DALL-E (only if API key available)
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey) {
  console.log('\n=== DALL-E Image Generation Test ===\n');
  try {
    const prompt = 'Create a simple, eye-catching illustration: a cute robot waking up with a coffee cup, sunrise, warm colors, digital art style. Style: modern, clean, slightly cartoony. No text in the image. Square format. The robot should look friendly and approachable.';
    
    console.log('Generating image with DALL-E 3...');
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log(`❌ DALL-E API error (${response.status}): ${err.substring(0, 300)}`);
    } else {
      const data = await response.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) {
        const buffer = Buffer.from(b64, 'base64');
        console.log(`✅ Image generated! Size: ${(buffer.length / 1024).toFixed(0)} KB`);
        // Save to /tmp for inspection
        const fs = await import('fs');
        fs.writeFileSync('/tmp/nova-test-image.png', buffer);
        console.log('Saved to /tmp/nova-test-image.png');
      } else {
        console.log('❌ No image data returned');
      }
    }
  } catch (err) {
    console.log('❌ DALL-E test failed:', err);
  }
} else {
  console.log('\n⚠️ OPENAI_API_KEY not set - skipping DALL-E test');
}

console.log('\n✅ Test complete!');
