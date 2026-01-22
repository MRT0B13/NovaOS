import { logger } from '@elizaos/core';

/**
 * Telegram Marketing Content Generator
 * 
 * Generates engaging community posts for token Telegram groups
 * Uses AI to create varied, authentic content in the mascot's voice
 */

export type TGPostType = 
  | 'gm_post'           // Morning vibes
  | 'chart_update'      // Price/holder updates
  | 'community_hype'    // Engagement posts
  | 'meme_drop'         // Fun content
  | 'alpha_tease'       // Building anticipation
  | 'holder_appreciation' // Thanking community
  | 'question'          // Engagement questions
  | 'milestone';        // Celebrating achievements

export interface TokenContext {
  name: string;
  ticker: string;
  mint: string;
  pumpUrl: string;
  description?: string;
  mascot?: string;
  mascotPersonality?: string;
  holders?: number;
  marketCap?: number;
  priceUsd?: number;
  launchDate?: string;
  telegramUrl?: string;
  websiteUrl?: string;
}

export interface GeneratedTGPost {
  text: string;
  type: TGPostType;
  tokenTicker: string;
  generatedAt: string;
}

// Templates for each post type (used as fallback or when no AI key)
const TEMPLATES: Record<TGPostType, string[]> = {
  gm_post: [
    "gm {name} fam! 🌅 Another day, another opportunity to WAGMI! How we feeling today?",
    "GM holders! ☀️ {ticker} looking strong this morning. Who's awake?",
    "Rise and grind {name} community! 🚀 Ready for what today brings?",
    "gm gm! 🌞 The {ticker} family never sleeps. Drop a ☕ if you're up!",
    "Good morning legends! 💎 Diamond hands checking in for {ticker}!",
  ],
  chart_update: [
    "👀 Chart check for ${ticker}! We're looking healthy. Who's been accumulating?",
    "📊 ${ticker} update: The chart speaks for itself. DYOR but this is looking bullish!",
    "Price action looking spicy for ${ticker}! 🔥 What's your take?",
    "📈 Another day holding ${ticker}. This community is built different!",
  ],
  community_hype: [
    "This community is UNREAL! 🔥 ${ticker} holders are the most based in crypto. Prove me wrong.",
    "The energy in here is INSANE! 💪 ${name} to the moon isn't a meme, it's destiny!",
    "Can we talk about how amazing this community is? 🙌 ${ticker} fam hits different!",
    "WAGMI isn't just a word, it's a lifestyle! ${name} community understands! 🚀",
  ],
  meme_drop: [
    "POV: You're a ${ticker} holder watching paper hands sell 😂",
    "Me explaining ${name} to my friends who don't understand crypto yet 🧠",
    "That feeling when ${ticker} pumps and you didn't sell 💎🙌",
    "${ticker} holders vs the entire market right now 😤",
  ],
  alpha_tease: [
    "Something big is coming for ${name}... 👀 Stay tuned!",
    "Been working on something special for the ${ticker} community. More soon! 🔥",
    "You're early. Like, REALLY early. ${name} is just getting started! 🚀",
    "The best alpha is being in ${ticker} before everyone else figures it out 🧠",
  ],
  holder_appreciation: [
    "Shoutout to everyone who's been holding ${ticker} since day one! 💎 You're the real MVPs!",
    "Thank you ${name} community for being the most based holders in crypto! 🙏",
    "Diamond hands deserve recognition. ${ticker} holders, this one's for you! 💪",
    "The OG ${name} holders know what's coming. Thank you for believing! 🚀",
  ],
  question: [
    "What made you ape into ${ticker}? Drop your story below! 👇",
    "If you could describe ${name} in one word, what would it be? 🤔",
    "Where do you see ${ticker} in one month? Let's hear your predictions! 📈",
    "What's your favorite thing about the ${name} community? 💭",
    "How did you find out about ${ticker}? 🔍",
  ],
  milestone: [
    "🎉 MILESTONE ALERT! ${name} is hitting new heights! Thank you holders!",
    "We did it! 🚀 Another milestone crushed. ${ticker} community is unstoppable!",
    "📣 Big announcement: ${name} just hit a new milestone! LFG!",
  ],
};

/**
 * Generate a post using templates
 */
export function generateTemplatePost(
  context: TokenContext,
  type: TGPostType
): GeneratedTGPost {
  const templates = TEMPLATES[type];
  const template = templates[Math.floor(Math.random() * templates.length)];
  
  const text = template
    .replace(/\{name\}/g, context.name)
    .replace(/\{ticker\}/g, context.ticker)
    .replace(/\$\{name\}/g, context.name)
    .replace(/\$\{ticker\}/g, context.ticker);
  
  return {
    text,
    type,
    tokenTicker: context.ticker,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate an AI-powered Telegram post
 */
export async function generateAITGPost(
  context: TokenContext,
  type: TGPostType,
  customPrompt?: string
): Promise<GeneratedTGPost> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.info('[TGMarketing] No OpenAI key, using template generation');
    return generateTemplatePost(context, type);
  }
  
  const mascotContext = context.mascotPersonality 
    ? `You are roleplaying as the mascot: ${context.mascot}. Personality: ${context.mascotPersonality}`
    : `You're the voice of ${context.name} ($${context.ticker}) community.`;
  
  // Format price data for prompt if available
  const priceInfo = context.priceUsd 
    ? `Current price: $${formatPriceForPrompt(context.priceUsd)}`
    : '';
  const mcInfo = context.marketCap 
    ? `Market cap: $${formatMcForPrompt(context.marketCap)}`
    : '';
  const statsLine = [priceInfo, mcInfo].filter(Boolean).join(' | ');
  
  // Format MC nicely for natural use (e.g. "$393" or "$3.6K")
  const mcForPrompt = context.marketCap 
    ? (context.marketCap >= 1000 ? `$${(context.marketCap / 1000).toFixed(1)}K` : `$${Math.round(context.marketCap)}`)
    : null;

  const systemPrompt = `${mascotContext}

You're posting in the project's Telegram group to engage the community.
Write authentic, fun messages that sound human - not corporate or robotic.
Use crypto slang naturally: gm, LFG, WAGMI, NFA, DYOR, ser, fren, based, ape, diamond hands, etc.
Use emojis but don't overdo it.
Be hype but genuine - the community can smell fake energy.
Never use hashtags (this is Telegram, not Twitter).
Keep messages casual and conversational.
You can use multiple lines for emphasis.
${context.websiteUrl ? `\n🎮 IMPORTANT: This project has a GAME/WEBSITE at ${context.websiteUrl}! Mention it frequently - encourage people to play it, share their scores, compete with each other. The game is a key part of this project's appeal!` : ''}

Token: ${context.name} ($${context.ticker})
${context.description ? `About: ${context.description}` : ''}
${mcForPrompt ? `Current MC: ${mcForPrompt}` : ''}
${context.websiteUrl ? `🎮 Game/Website: ${context.websiteUrl}` : ''}`;

  const typePrompts: Record<TGPostType, string> = {
    gm_post: 'Write a morning greeting message. Be warm, hype, and get the community engaged for the day.',
    chart_update: `Write an update about the chart/price.${mcForPrompt ? ` Mention we're at ${mcForPrompt} MC naturally (like "sitting at ${mcForPrompt}" or "vibing at ${mcForPrompt} rn").` : ''} Be bullish but not financial advice. Do NOT include raw token price - just market cap. Encourage diamond hands.`,
    community_hype: 'Write a hype message celebrating how amazing the community is. Make holders feel special.',
    meme_drop: 'Write a funny meme-style message or joke about the token/holders. Be creative and relatable.',
    alpha_tease: 'Write a teaser about something exciting coming. Build anticipation without promising anything specific.',
    holder_appreciation: 'Write a heartfelt thank you to the community and holders. Show genuine appreciation.',
    question: 'Write an engagement question to get the community talking. Make it fun and easy to answer.',
    milestone: `Write a celebration message for hitting a milestone.${mcForPrompt ? ` We hit ${mcForPrompt} MC! Weave this in naturally.` : ''} Make it exciting and thank the community.`,
  };

  const userPrompt = customPrompt || `Write a ${type.replace(/_/g, ' ')} message for the Telegram group.

${typePrompts[type]}

Just write the message directly. No quotes or labels. Keep it under 500 characters.`;

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
        temperature: 0.95, // Higher creativity for TG
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Remove quotes if AI wrapped it
    text = text.replace(/^["']|["']$/g, '');
    
    logger.info(`[TGMarketing] Generated AI post: ${text.substring(0, 50)}...`);
    
    return {
      text,
      type,
      tokenTicker: context.ticker,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn('[TGMarketing] AI generation failed, using template:', error);
    return generateTemplatePost(context, type);
  }
}

/**
 * Suggest best post type based on time of day and randomness
 */
export function suggestTGPostType(): TGPostType {
  const hour = new Date().getHours();
  const random = Math.random();
  
  // Morning: GM posts
  if (hour >= 6 && hour <= 10) {
    if (random < 0.7) return 'gm_post';
    return 'community_hype';
  }
  
  // Afternoon: Engagement
  if (hour >= 11 && hour <= 17) {
    if (random < 0.25) return 'chart_update';
    if (random < 0.45) return 'community_hype';
    if (random < 0.65) return 'question';
    if (random < 0.85) return 'meme_drop';
    return 'alpha_tease';
  }
  
  // Evening: Appreciation and hype
  if (hour >= 18 && hour <= 23) {
    if (random < 0.3) return 'holder_appreciation';
    if (random < 0.6) return 'community_hype';
    if (random < 0.8) return 'meme_drop';
    return 'chart_update';
  }
  
  // Late night
  return random < 0.5 ? 'community_hype' : 'alpha_tease';
}

/**
 * Generate a schedule of post types for X days
 */
export function generatePostSchedule(days: number = 5, postsPerDay: number = 4): TGPostType[] {
  const schedule: TGPostType[] = [];
  const types: TGPostType[] = [
    'gm_post', 'chart_update', 'community_hype', 'meme_drop',
    'alpha_tease', 'holder_appreciation', 'question'
  ];
  
  for (let day = 0; day < days; day++) {
    // Always start with GM
    schedule.push('gm_post');
    
    // Fill rest of day with varied content
    const remaining = postsPerDay - 1;
    const usedToday = new Set<TGPostType>(['gm_post']);
    
    for (let i = 0; i < remaining; i++) {
      // Pick a type we haven't used today
      const available = types.filter(t => !usedToday.has(t));
      const pick = available[Math.floor(Math.random() * available.length)] || 'community_hype';
      schedule.push(pick);
      usedToday.add(pick);
    }
  }
  
  return schedule;
}

/**
 * Format price for AI prompt (human readable)
 */
function formatPriceForPrompt(price: number): string {
  if (price < 0.00000001) return price.toExponential(2);
  if (price < 0.0001) return price.toFixed(8);
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(2);
  return price.toFixed(0);
}

/**
 * Format market cap for AI prompt
 */
function formatMcForPrompt(mc: number): string {
  if (mc >= 1_000_000_000) return `${(mc / 1_000_000_000).toFixed(1)}B`;
  if (mc >= 1_000_000) return `${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000) return `${(mc / 1_000).toFixed(1)}K`;
  return mc.toFixed(0);
}

export default {
  generateAITGPost,
  generateTemplatePost,
  suggestTGPostType,
  generatePostSchedule,
};
