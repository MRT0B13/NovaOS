import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { canWrite, getQuota, recordWrite } from './xRateLimiter.ts';

/**
 * X Marketing Content Generator
 * 
 * Generates engaging marketing tweets for launched tokens
 * Uses AI to create varied, authentic-sounding crypto content
 */

// Twitter URL shortening - all URLs count as 23 chars via t.co
const TWITTER_URL_LENGTH = 23;
const TWITTER_MAX_LENGTH = 280;

/**
 * Smart truncation that preserves URLs and CA
 * Twitter shortens all URLs to 23 chars via t.co
 * Strategy: Keep CA + URLs intact, truncate the message part cleanly
 */
function smartTruncate(text: string, maxLength: number = TWITTER_MAX_LENGTH): string {
  // Twitter URL shortening rules
  const T_CO_LENGTH = 23;
  
  // Extract URLs (they'll be shortened to 23 chars each by Twitter)
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const urls = text.match(urlRegex) || [];
  
  // Also match pump.fun/... and t.me/... without protocol
  const shortUrlRegex = /(?:pump\.fun|t\.me)\/[^\s]+/gi;
  const shortUrls = text.match(shortUrlRegex) || [];
  shortUrls.forEach(url => {
    if (!urls.some(u => u.includes(url))) {
      urls.push(url);
    }
  });
  
  // Calculate how many chars URLs will take on Twitter
  const urlTwitterChars = urls.length * T_CO_LENGTH;
  
  // Calculate actual URL chars in text
  let urlActualChars = 0;
  urls.forEach(url => {
    urlActualChars += url.length;
  });
  
  // Calculate text chars (excluding URLs)
  const textOnlyLength = text.length - urlActualChars;
  
  // Total Twitter character count
  const twitterCharCount = textOnlyLength + urlTwitterChars;
  
  // If already under limit, return as-is
  if (twitterCharCount <= maxLength) {
    return text;
  }
  
  // Need to truncate the text portion
  const charsToRemove = twitterCharCount - maxLength + 4; // +4 for " ..."
  
  // Split into message part and links part
  // Find where the links section starts (usually after CA: or Chart: or a URL or game emoji)
  const caMatch = text.match(/\n\s*(CA:|Chart:|TG:|Telegram:|🎮|🌐|Game:|Site:|Web:|pump\.fun|https:\/\/)/i);
  
  if (caMatch && caMatch.index && caMatch.index > 30) {
    // Truncate the message part (before CA/links)
    const messagePart = text.substring(0, caMatch.index);
    const linksPart = text.substring(caMatch.index);
    
    // Truncate message at word boundary
    const targetLength = messagePart.length - charsToRemove;
    if (targetLength > 20) {
      const lastSpace = messagePart.lastIndexOf(' ', targetLength);
      const cutPoint = lastSpace > targetLength * 0.5 ? lastSpace : targetLength;
      const truncatedMessage = messagePart.substring(0, cutPoint).trim();
      return truncatedMessage + linksPart;
    }
  }
  
  // Fallback: simple truncation but try to keep the last URL
  if (urls.length > 0) {
    const lastUrl = urls[urls.length - 1];
    const lastUrlIndex = text.lastIndexOf(lastUrl);
    
    if (lastUrlIndex > 50) {
      // Keep at least the last URL
      const beforeUrl = text.substring(0, lastUrlIndex);
      const targetLen = beforeUrl.length - charsToRemove;
      if (targetLen > 20) {
        const lastSpace = beforeUrl.lastIndexOf(' ', targetLen);
        const cutPoint = lastSpace > targetLen * 0.5 ? lastSpace : targetLen;
        return beforeUrl.substring(0, cutPoint).trim() + '\n' + lastUrl;
      }
    }
  }
  
  // Emergency fallback: simple cut
  const emergencyTarget = maxLength - urlTwitterChars - 4;
  if (emergencyTarget > 30) {
    let textOnly = text;
    urls.forEach(url => {
      textOnly = textOnly.replace(url, '');
    });
    const cutText = textOnly.substring(0, emergencyTarget).trim() + ' ...';
    return cutText + '\n' + urls.join('\n');
  }
  
  return text.substring(0, maxLength - 3) + '...';
}

export type TweetType = 
  | 'launch_announcement'
  | 'milestone_holders'
  | 'milestone_mcap'
  | 'daily_update'
  | 'community_shoutout'
  | 'chart_callout'
  | 'meme'
  | 'thread_start'
  | 'engagement_bait'
  | 'nova_channel_promo';

export interface TokenContext {
  name: string;
  ticker: string;
  mint: string;
  pumpUrl: string;
  description?: string;
  mascot?: string;
  xHandle?: string; // Twitter/X handle for the token (e.g. @DumpToken)
  // On-chain stats (optional, fetched when available)
  holders?: number;
  marketCap?: number;
  priceUsd?: number;
  priceChange24h?: number;
  volume24h?: number;
  launchDate?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  // Nova's channel for cross-promotion
  novaChannelUrl?: string;
}

export interface GeneratedTweet {
  text: string;
  type: TweetType;
  tokenTicker: string;
  generatedAt: string;
  characterCount: number;
}

// Tweet templates by type - varied for authenticity
// Use TICKER as placeholder, replace with $ticker later
// Always try to include: CA, pump.fun link, Telegram, Website (if available)
const TWEET_TEMPLATES: Record<TweetType, string[]> = {
  launch_announcement: [
    '🚀 TICKER just launched!\n\n{{description}}\n\nCA: {{mint}}\n🔗 {{pumpUrl}}\n📱 TG: {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'gm. TICKER is LIVE 🔥\n\n{{name}} on pump.fun\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    '🎯 NEW LAUNCH: TICKER\n\n{{name}}\n\nCA: {{mint}}\nChart: {{pumpUrl}}\nTG: {{telegramUrl}}\nWeb: {{websiteUrl}}\n\nNFA DYOR',
  ],
  
  milestone_holders: [
    'TICKER just hit {{holders}} holders! 🎉\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    '{{holders}} degens holding TICKER 🤝\n\nStill early.\n\nCA: {{mint}}\n{{pumpUrl}}',
    'TICKER community growing 🚀\n\n{{holders}} holders strong\n\nCA: {{mint}}\nTG: {{telegramUrl}}\n🌐 {{websiteUrl}}',
  ],
  
  milestone_mcap: [
    'TICKER crossed {{marketCapFormatted}} MC! 📈\n\n💰 ${{priceFormatted}}\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    '{{marketCapFormatted}} MC on TICKER 🔥\n\n{{priceChange}}\n\nCA: {{mint}}\nChart: {{pumpUrl}}',
    'TICKER climbing 📊\n\nMC: {{marketCapFormatted}}\nPrice: ${{priceFormatted}}\n\nCA: {{mint}}\n{{pumpUrl}}\n🌐 {{websiteUrl}}',
  ],
  
  daily_update: [
    'TICKER update 📊\n\n💰 ${{priceFormatted}} | MC: {{marketCapFormatted}}\n{{priceChange}}\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'TICKER check ✅\n\nPrice: ${{priceFormatted}}\nMC: {{marketCapFormatted}} {{priceChange}}\n\nCA: {{mint}}\n{{pumpUrl}}\n🌐 {{websiteUrl}}',
    'gm TICKER fam 🌞\n\n📊 ${{priceFormatted}} | {{marketCapFormatted}} MC\nVol: {{volume24hFormatted}}\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}',
  ],
  
  community_shoutout: [
    'TICKER community is 🔥\n\nDiamond hands holding strong 💎\n\nCA: {{mint}}\n💬 Join: {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'Shoutout TICKER fam 🫡\n\n{{holders}} holders and growing\n\nTG: {{telegramUrl}}\n📊 {{pumpUrl}}\n🌐 {{websiteUrl}}',
    'TICKER holders different 💎\n\nCA: {{mint}}\nJoin us: {{telegramUrl}}',
  ],
  
  chart_callout: [
    'TICKER chart looking spicy 🌶️\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'You seeing TICKER rn? 👀\n\nCA: {{mint}}\n{{pumpUrl}}',
    'TICKER breakout? 📈\n\nCA: {{mint}}\nChart: {{pumpUrl}}\nTG: {{telegramUrl}}\n🌐 {{websiteUrl}}',
  ],
  
  meme: [
    'me watching TICKER chart all day 👁️👁️\n\nCA: {{mint}}\n{{pumpUrl}}',
    'TICKER holders: 💎🙌\neveryone else: 🤡\n\nCA: {{mint}}',
    'POV: you bought TICKER early\n\nCA: {{mint}}\n{{pumpUrl}}',
    'TICKER to the moon 🌙\n\nCA: {{mint}}\nTG: {{telegramUrl}}',
  ],
  
  thread_start: [
    '🧵 About TICKER\n\n{{description}}\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n💬 {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'Why TICKER? 📈\n\n1/ {{description}}\n\nCA: {{mint}}\n🌐 {{websiteUrl}}',
    'TICKER deep dive 🔍\n\nCA: {{mint}}\n📊 {{pumpUrl}}\n🌐 {{websiteUrl}}\n\n👇 Thread',
  ],
  
  engagement_bait: [
    'RT if you\'re holding TICKER 🔄\n\nCA: {{mint}}\n{{pumpUrl}}',
    'TICKER holders drop a 🚀\n\nCA: {{mint}}\nTG: {{telegramUrl}}\n🌐 {{websiteUrl}}',
    'How much TICKER you holding?\n\n🐟 < 100k\n🐬 100k-1M\n🐋 1M+\n\nCA: {{mint}}',
    'TICKER price prediction? 👇\n\nCA: {{mint}}\n{{pumpUrl}}',
  ],
  
  nova_channel_promo: [
    '📢 Join my official Telegram channel for real-time updates!\n\n🚀 Launch announcements\n📊 Portfolio updates\n💰 Alpha & insights\n\n👉 {{novaChannelUrl}}',
    'Want to see what I\'m launching next? 👀\n\nJoin my TG channel for:\n• Live launch alerts\n• Community health reports\n• Wallet activity\n\n🔗 {{novaChannelUrl}}',
    'gm! My Telegram channel is where the alpha drops first 🧠\n\n📣 {{novaChannelUrl}}\n\nReal-time updates, no spam, just vibes 🚀',
    'All my launches. All my moves. One channel. 📡\n\nJoin the Nova fam:\n{{novaChannelUrl}}',
    'Following my journey? Get the inside scoop 👇\n\n{{novaChannelUrl}}\n\n• Launch alerts 🚀\n• Health reports 📊\n• Community updates 💬',
  ],
};

/**
 * Generate a marketing tweet for a token
 */
export function generateTweet(
  context: TokenContext,
  type: TweetType = 'daily_update'
): GeneratedTweet {
  const templates = TWEET_TEMPLATES[type];
  const template = templates[Math.floor(Math.random() * templates.length)];
  
  // Format market cap
  const marketCapFormatted = context.marketCap 
    ? formatNumber(context.marketCap, true) 
    : 'N/A';
  
  // Format volume
  const volume24hFormatted = context.volume24h
    ? formatNumber(context.volume24h, true)
    : 'N/A';
  
  // Format price
  const priceFormatted = context.priceUsd
    ? formatPrice(context.priceUsd)
    : 'N/A';
  
  // Format price change
  const priceChange = formatPriceChange(context.priceChange24h);
  
  // Replace placeholders
  let text = template
    .replace(/TICKER/g, '$' + context.ticker)  // TICKER becomes $TICKER
    .replace(/\{\{name\}\}/g, context.name)
    .replace(/\{\{ticker\}\}/g, context.ticker)
    .replace(/\{\{mint\}\}/g, context.mint)
    .replace(/\{\{pumpUrl\}\}/g, context.pumpUrl)
    .replace(/\{\{description\}\}/g, context.description || '')
    .replace(/\{\{holders\}\}/g, context.holders?.toLocaleString() || '??')
    .replace(/\{\{marketCapFormatted\}\}/g, marketCapFormatted)
    .replace(/\{\{volume24hFormatted\}\}/g, volume24hFormatted)
    .replace(/\{\{priceFormatted\}\}/g, priceFormatted)
    .replace(/\{\{priceChange\}\}/g, priceChange)
    .replace(/\{\{telegramUrl\}\}/g, context.telegramUrl || '')
    .replace(/\{\{websiteUrl\}\}/g, context.websiteUrl || '')
    .replace(/\{\{xHandle\}\}/g, context.xHandle || '')
    .replace(/\{\{novaChannelUrl\}\}/g, context.novaChannelUrl || '');
  
  // Add X handle tag if available
  if (context.xHandle) {
    // If the handle doesn't start with @, add it
    const handle = context.xHandle.startsWith('@') ? context.xHandle : `@${context.xHandle}`;
    // Add handle mention at the end if not already in text
    if (!text.includes(handle)) {
      text = text.replace(/\n\n(CA:|Chart:)/g, `\n\nFollow: ${handle}\n\n$1`);
    }
  }
  
  // Clean up empty placeholder lines (if telegramUrl or websiteUrl is empty)
  text = text
    .replace(/\n📱 TG: $/gm, '')
    .replace(/\n💬 $/gm, '')
    .replace(/\nTG: $/gm, '')
    .replace(/\n💬 Join: $/gm, '')
    .replace(/\nJoin us: $/gm, '')
    .replace(/\nTelegram: $/gm, '')
    .replace(/\n🌐 $/gm, '')
    .replace(/\nWeb: $/gm, '')
    .replace(/\n\n+/g, '\n\n')  // Collapse multiple newlines
    .trim();
  
  // Smart truncate - preserves URLs
  text = smartTruncate(text);
  
  return {
    text,
    type,
    tokenTicker: context.ticker,
    generatedAt: new Date().toISOString(),
    characterCount: text.length,
  };
}

/**
 * Generate an AI-powered marketing tweet using Claude/GPT
 */
export async function generateAITweet(
  context: TokenContext,
  type: TweetType = 'daily_update',
  customPrompt?: string
): Promise<GeneratedTweet> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    // Fall back to template-based generation
    logger.info('[XMarketing] No OpenAI key, using template generation');
    return generateTweet(context, type);
  }
  
  const systemPrompt = `You are a crypto marketing expert writing tweets for meme coins on pump.fun. 
Write authentic, engaging tweets that sound human - not corporate or spammy.
Use crypto twitter slang naturally: gm, LFG, WAGMI, NFA, DYOR, ser, fren, etc.

LENGTH GUIDELINES:
${context.websiteUrl ? '- CRITICAL: You have 4 URLs (game, chart, TG, CA) = 92 Twitter chars for URLs alone!' : '- You have 3 URLs = 69 Twitter chars for URLs'}
${context.websiteUrl ? '- Keep your message SHORT: 60-80 chars max (1 punchy sentence)' : '- Write 2-3 sentences of engaging content (100-140 chars)'}
- The CA is 44 chars, URLs are shortened to 23 chars each by Twitter
${context.websiteUrl ? '- Total target: 220-260 Twitter chars to leave room for everything' : '- Target 250-280 total Twitter characters'}

Include relevant emojis (2-4) to make it pop.
Never use hashtags (they look spammy on CT).
Make it sound like a real degen, not a bot.

CRITICAL RULES FOR LINKS:
- ALWAYS include the FULL pump.fun URL exactly as provided (with https://)
- NEVER truncate or shorten URLs - Twitter will shorten them automatically
- ALWAYS include the CA (contract address) in your tweets
- When provided, include the Telegram link exactly as given
- When provided, include the Website/Game link - THIS IS THE MOST IMPORTANT LINK! Put it first in the links section!
- When provided, include the Twitter handle with "Follow:" prefix

${context.websiteUrl ? `🎮 THIS TOKEN HAS A GAME: ${context.websiteUrl} - Feature it prominently! The game is the main attraction.` : ''}

FORMAT YOUR TWEET LIKE THIS:
[Short engaging message${context.websiteUrl ? ' - 60-80 chars, 1 sentence' : ' - 100-140 chars, 2-3 sentences'}]

${context.websiteUrl ? '🎮 [game URL FIRST - this is the star!]' : ''}
CA: [full address]
Chart: [pump.fun URL]
TG: [telegram URL]`;

  // Format price data for prompt
  const priceInfo = context.priceUsd ? `Current price: $${formatPrice(context.priceUsd)}` : '';
  const mcInfo = context.marketCap ? `Market cap: $${formatNumber(context.marketCap, false)}` : '';
  const volInfo = context.volume24h ? `24h volume: $${formatNumber(context.volume24h, false)}` : '';
  const changeInfo = context.priceChange24h !== undefined && context.priceChange24h !== null
    ? `24h change: ${context.priceChange24h >= 0 ? '+' : ''}${context.priceChange24h.toFixed(1)}%`
    : '';
  
  const statsLine = [priceInfo, mcInfo, volInfo, changeInfo].filter(Boolean).join(' | ');
  
  // Format MC nicely for the prompt (e.g. "$393" or "$3.6K")
  const mcForPrompt = context.marketCap 
    ? (context.marketCap >= 1000 ? `$${(context.marketCap / 1000).toFixed(1)}K` : `$${Math.round(context.marketCap)}`)
    : null;

  const userPrompt = customPrompt || `Write a ${type.replace(/_/g, ' ')} tweet for $${context.ticker}.
Token name: ${context.name}
${context.description ? `Vibe: ${context.description.substring(0, 80)}` : ''}
${context.xHandle ? `Twitter handle: @${context.xHandle.replace('@', '')}` : ''}
${mcForPrompt ? `Current market cap: ${mcForPrompt}` : ''}

MUST INCLUDE these exact values in this order:
${context.websiteUrl ? `🎮 Play: ${context.websiteUrl}` : ''}
CA: ${context.mint}
Chart: ${context.pumpUrl}
${context.telegramUrl ? `TG: ${context.telegramUrl}` : ''}
${context.xHandle ? `Follow: @${context.xHandle.replace('@', '')}` : ''}

${context.websiteUrl ? `⚠️ KEEP MESSAGE SHORT (60-80 chars, 1 sentence) - you have 4 URLs!` : ''}
${mcForPrompt ? `Mention the MC naturally (like "sitting at ${mcForPrompt} MC").` : ''}
Write the tweet now. No quotes. Raw text only.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.9,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Remove quotes if AI wrapped it
    text = text.replace(/^["']|["']$/g, '');
    
    // Ensure xHandle is included if available (AI might forget)
    if (context.xHandle) {
      const handle = context.xHandle.startsWith('@') ? context.xHandle : `@${context.xHandle}`;
      if (!text.includes(handle)) {
        // Add handle before CA/Chart section
        if (text.includes('\nCA:') || text.includes('\nChart:')) {
          text = text.replace(/\n(CA:|Chart:)/g, `\nFollow: ${handle}\n$1`);
        } else {
          text = text + `\n\nFollow: ${handle}`;
        }
      }
    }
    
    // Smart truncate - preserves URLs
    text = smartTruncate(text);
    
    // Calculate Twitter char count for logging
    const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
    const urlActualChars = urls.reduce((sum, url) => sum + url.length, 0);
    const twitterCharCount = text.length - urlActualChars + (urls.length * 23);
    
    logger.info(`[XMarketing] Generated AI tweet (${twitterCharCount}/280 Twitter chars): ${text.substring(0, 60)}...`);
    
    return {
      text,
      type,
      tokenTicker: context.ticker,
      generatedAt: new Date().toISOString(),
      characterCount: twitterCharCount,
    };
  } catch (error) {
    logger.warn('[XMarketing] AI generation failed, using template:', error);
    return generateTweet(context, type);
  }
}

/**
 * Format large numbers nicely
 */
function formatNumber(num: number, withDollar = false): string {
  const prefix = withDollar ? '$' : '';
  if (num >= 1_000_000) {
    return `${prefix}${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${prefix}${(num / 1_000).toFixed(1)}K`;
  }
  return `${prefix}${num.toFixed(0)}`;
}

/**
 * Format price with appropriate decimal places for small values
 */
function formatPrice(price: number): string {
  if (price < 0.00000001) return price.toExponential(2);
  if (price < 0.0001) return price.toFixed(8);
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(2);
  return price.toFixed(0);
}

/**
 * Format price change percentage with emoji
 */
function formatPriceChange(change: number | undefined | null): string {
  if (change === undefined || change === null) return '';
  const emoji = change >= 0 ? '📈' : '📉';
  const sign = change >= 0 ? '+' : '';
  return `${emoji} ${sign}${change.toFixed(1)}% (24h)`;
}

/**
 * Get best tweet type based on token stats and timing
 */
export function suggestTweetType(context: TokenContext): TweetType {
  // If just launched (within 24h), do launch content
  if (context.launchDate) {
    const hoursSinceLaunch = (Date.now() - new Date(context.launchDate).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLaunch < 24) {
      return 'chart_callout';
    }
  }
  
  // Milestone checks
  if (context.holders && [100, 500, 1000, 5000, 10000].includes(context.holders)) {
    return 'milestone_holders';
  }
  
  if (context.marketCap) {
    const milestones = [10000, 50000, 100000, 500000, 1000000];
    if (milestones.some(m => context.marketCap! >= m * 0.95 && context.marketCap! <= m * 1.05)) {
      return 'milestone_mcap';
    }
  }
  
  // Random variety
  const types: TweetType[] = ['daily_update', 'chart_callout', 'community_shoutout', 'meme', 'engagement_bait'];
  return types[Math.floor(Math.random() * types.length)];
}

export default {
  generateTweet,
  generateAITweet,
  suggestTweetType,
};
