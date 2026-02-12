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
    "Morning. {ticker} sitting at [check chart]. What's the move today?",
    "GM. {ticker} update incoming — watching the chart.",
    "Another day building. {ticker} status: holding.",
  ],
  chart_update: [
    "{ticker} chart update — check it and form your own opinion. DYOR.",
    "{ticker} — the chart says more than I can. Take a look.",
    "{ticker} price action today. What are you seeing?",
  ],
  community_hype: [
    "{ticker} holders — what brought you here? Curious to hear.",
    "{name} community growing. {ticker} holder count keeps climbing.",
    "The people in this {ticker} group actually get it.",
  ],
  meme_drop: [
    "POV: you're a {ticker} holder checking the chart for the 10th time today",
    "Me explaining {name} to my friends: 'just trust me on this one'",
    "{ticker} holders vs everyone who sold early",
  ],
  alpha_tease: [
    "Working on something for {name}. More details when it's ready.",
    "Interesting data coming out of {ticker}. Will share when I've verified.",
    "{name} — there's more to this one than the chart shows.",
  ],
  holder_appreciation: [
    "Day 1 {ticker} holders — you know who you are. Respect.",
    "{name} holders have been steady. That matters more than price action.",
    "Not everyone holds through dips. {ticker} community does.",
  ],
  question: [
    "What made you buy {ticker}? Genuine question.",
    "Where do you see {ticker} in a month? Be honest.",
    "What would make {name} better? Open to feedback.",
  ],
  milestone: [
    "{name} hit a milestone. Specific numbers coming shortly.",
    "New {ticker} milestone — the data speaks for itself.",
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
Write messages that provide VALUE — data points, safety info, market observations, honest updates.
Be direct and concise. No fluff, no "vibes are incredible," no "let's gooo."
Use crypto slang sparingly and only when natural: DYOR, NFA, based — never forced WAGMI/LFG chains.
Max 1-2 emojis per message, purposeful only: 📊 ⚠️ ✅ ❌ 🚀 (sparingly).
Never use hashtags in Telegram.
Be honest — if the chart is bad, acknowledge it. If it's good, share the data.
${context.websiteUrl ? `\n🎮 This project has a GAME/WEBSITE at ${context.websiteUrl}. Mention it when relevant.` : ''}

Token: ${context.name} ($${context.ticker})
${context.description ? `About: ${context.description}` : ''}
${mcForPrompt ? `Current MC: ${mcForPrompt}` : ''}
${context.websiteUrl ? `Game/Website: ${context.websiteUrl}` : ''}`;

  const typePrompts: Record<TGPostType, string> = {
    gm_post: `Write a brief morning check-in with a data point. "Morning. $${context.ticker} sitting at [MC]. [One observation]." No "gm fam" or "good morning everyone."`,
    chart_update: `Write a factual chart/price update.${mcForPrompt ? ` We're at ${mcForPrompt} MC.` : ''} Share the number, one observation about holder behavior or volume, and leave it. No "bullish" cheerleading — let the data speak.`,
    community_hype: `Acknowledge the community with specifics — reference the market cap${mcForPrompt ? ` (${mcForPrompt})` : ''}, chart movement, or a notable action. Be factual, not generic.`,
    meme_drop: `Write something genuinely funny or sharp. A quick observation, a relatable scenario, or a self-aware joke. One-liner preferred. Make people actually laugh, not just react.`,
    alpha_tease: `Share something concrete you're observing.${mcForPrompt ? ` Current MC: ${mcForPrompt}.` : ''} Reference the chart, price action, or market context. Intrigue through data, not mystery.`,
    holder_appreciation: `Acknowledge holders with specifics. Reference the chart movement or how long the token has been live. Be specific, not generic.`,
    question: `Ask a question that has a useful answer — "What MC would you consider taking profit?" or "Which other tokens are you watching?" Not "how are you feeling?" to an empty room.`,
    milestone: `Celebrate with the exact number.${mcForPrompt ? ` Hit ${mcForPrompt} MC.` : ''} One line about what it means, one line about what's next. Keep it factual.`,
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
