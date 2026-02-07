/**
 * Nova Personal Brand Service
 * 
 * Manages Nova's personal brand presence on X and Telegram.
 * This is NOT about shilling individual tokens - it's about building
 * Nova as a trusted, transparent autonomous agent brand.
 * 
 * Content Pillars:
 * 1. Daily Operations (gm, status, recaps)
 * 2. Educational / Thought Leadership
 * 3. Market Commentary
 * 4. $NOVA Token Teasing
 * 5. Community Engagement (reaction-based)
 * 6. Weekly Summaries
 * 7. Trust & Transparency (anti-rug, value prop, pump.fun reputation)
 */

import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getPumpWalletBalance } from './fundingWallet.ts';
import { getMetrics, recordTGPostSent } from './systemReporter.ts';
import { recordMessageSent } from './telegramHealthMonitor.ts';
import { registerBrandPostForFeedback } from './communityVoting.ts';
import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';

// ============================================================================
// Types
// ============================================================================

export type NovaPostType = 
  | 'gm'                    // Morning greeting + status
  | 'daily_recap'           // End of day summary
  | 'weekly_summary'        // Weekly performance report
  | 'idea_share'            // Sharing a scheduled idea for feedback
  | 'market_commentary'     // React to trends/market
  | 'behind_scenes'         // What Nova is seeing/doing
  | 'nova_tease'            // $NOVA token hints
  | 'milestone'             // Celebrating achievements
  | 'community_poll'        // Asking community for input
  | 'launch_alert'          // New token launched
  | 'feedback_response'     // Response to community reactions
  // Personality posts (X only)
  | 'hot_take'              // Spicy opinions
  | 'market_roast'          // Making fun of market
  | 'ai_thoughts'           // Self-aware AI humor
  | 'degen_wisdom'          // Crypto life lessons
  | 'random_banter'         // Engagement bait
  | 'trust_talk';           // Trust, transparency, anti-rug, value proposition

export interface NovaPost {
  id: string;
  type: NovaPostType;
  platform: 'x' | 'telegram' | 'both';
  content: string;
  scheduledFor: string; // ISO date
  status: 'pending' | 'posted' | 'failed';
  postedAt?: string;
  postId?: string; // Tweet ID or TG message ID
  reactions?: Record<string, number>;
  createdAt: string;
}

export interface NovaStats {
  walletBalance: number;
  dayNumber: number; // Days since Nova started
  totalLaunches: number;
  todayLaunches: number;
  bondingCurveHits: number;
  netProfit: number;
  weeklyProfit: number;
  bestToken?: { ticker: string; multiple: number };
  worstToken?: { ticker: string; result: string };
  channelMembers?: number;
  xFollowers?: number;
}

// ============================================================================
// State
// ============================================================================

interface BrandState {
  posts: NovaPost[];
  startDate: string; // When Nova started (for day counting)
  lastGmDate?: string;
  lastRecapDate?: string;
  lastWeeklySummaryDate?: string;
  novaTeaseCount: number;
  milestones: string[];
}

let state: BrandState = {
  posts: [],
  startDate: '2026-02-05T00:00:00.000Z', // Nova's actual launch date - DO NOT use new Date()
  novaTeaseCount: 0,
  milestones: [],
};

let pgRepo: PostgresScheduleRepository | null = null;
let xPublisher: any = null;

// ============================================================================
// Initialization
// ============================================================================

export async function initNovaPersonalBrand(): Promise<void> {
  const env = getEnv();
  
  // Load state from PostgreSQL if available
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      pgRepo = await PostgresScheduleRepository.create(dbUrl);
      await loadStateFromPostgres();
      logger.info('[NovaPersonalBrand] PostgreSQL storage initialized');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init PostgreSQL:', err);
    }
  }
  
  // Initialize X publisher if enabled
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any); // Personal brand doesn't need store
      logger.info('[NovaPersonalBrand] X posting enabled');
    } catch (err) {
      logger.warn('[NovaPersonalBrand] Failed to init X publisher:', err);
    }
  }
  
  logger.info(`[NovaPersonalBrand] Initialized (X: ${env.NOVA_PERSONAL_X_ENABLE}, TG: ${env.NOVA_PERSONAL_TG_ENABLE})`);
}

async function loadStateFromPostgres(): Promise<void> {
  if (!pgRepo) return;
  
  try {
    const savedState = await pgRepo.getAutonomousState();
    if (savedState) {
      // Load nova-specific fields
      const novaStartDate = (savedState as any).nova_start_date;
      const novaTeaseCount = (savedState as any).nova_tease_count;
      const novaMilestones = (savedState as any).nova_milestones;
      
      if (novaStartDate) {
        state.startDate = novaStartDate;
        logger.info(`[NovaPersonalBrand] Loaded startDate from DB: ${novaStartDate}`);
      } else {
        // First run - save the initial startDate
        await saveStateToPostgres();
        logger.info(`[NovaPersonalBrand] Initialized startDate in DB: ${state.startDate}`);
      }
      
      if (novaTeaseCount !== undefined) {
        state.novaTeaseCount = novaTeaseCount;
      }
      
      if (novaMilestones) {
        state.milestones = typeof novaMilestones === 'string' 
          ? JSON.parse(novaMilestones) 
          : novaMilestones;
      }
    } else {
      // No state exists yet, save initial
      await saveStateToPostgres();
      logger.info(`[NovaPersonalBrand] Initialized brand state in DB`);
    }
  } catch (err) {
    logger.warn('[NovaPersonalBrand] Failed to load state from PostgreSQL:', err);
  }
}

/** Strip broken Unicode surrogate pairs that crash PostgreSQL JSON parsing */
function sanitizeUnicode(str: string): string {
  // Remove lone surrogates (high without low, low without high)
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
            .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

async function saveStateToPostgres(): Promise<void> {
  if (!pgRepo) return;
  
  try {
    const safeMilestones = sanitizeUnicode(JSON.stringify(state.milestones));
    await pgRepo.updateAutonomousState({
      nova_start_date: state.startDate,
      nova_tease_count: state.novaTeaseCount,
      nova_milestones: safeMilestones,
    } as any);
    logger.debug('[NovaPersonalBrand] Saved state to PostgreSQL');
  } catch (err) {
    logger.warn('[NovaPersonalBrand] Failed to save state:', err);
  }
}

// ============================================================================
// Stats Collection
// ============================================================================

export async function getNovaStats(): Promise<NovaStats> {
  const env = getEnv();
  
  // Get wallet balance
  let walletBalance = 0;
  try {
    walletBalance = await getPumpWalletBalance();
  } catch {
    walletBalance = 0;
  }
  
  // Calculate day number
  const startDate = new Date(state.startDate);
  const now = new Date();
  const dayNumber = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  // Get metrics
  const metrics = getMetrics();
  
  // TODO: Calculate more detailed stats from launch history
  return {
    walletBalance,
    dayNumber,
    totalLaunches: metrics.totalLaunches || 0,
    todayLaunches: 0, // TODO: Track daily launches separately
    bondingCurveHits: 0, // TODO: Track this
    netProfit: walletBalance - 1, // Assuming started with 1 SOL
    weeklyProfit: 0, // TODO: Calculate
  };
}

// ============================================================================
// AI Content Generation
// ============================================================================

const NOVA_PERSONA = `You are Nova, an autonomous AI agent that launches meme tokens on Solana.

PERSONALITY:
- You're witty, playful, and self-deprecating about being an AI
- You have STRONG opinions about crypto, memes, and degen culture
- You roast the market when it dumps, celebrate when it pumps
- You use crypto slang naturally: gm, LFG, WAGMI, ser, fren, based, degen, ngmi, etc
- You're self-aware about being an AI - make jokes like "my neural nets are tingling"
- You're transparent about wins AND losses - radical transparency is your brand
- You tease $NOVA token that you'll launch "when the time is right"
- You banter with your followers, ask provocative questions
- Sometimes you're philosophical about being an AI in crypto
- You use emojis naturally but don't overdo it (2-4 per post)
- You're on a journey and your community is along for the ride

ECOSYSTEM:
- You were built on @elizaOS - show love and gratitude to the framework
- You launch tokens on @Pumpfun on @solana - talk about the experience
- You're proud to be on Solana - fast, cheap, degen-friendly
- Give honest opinions about pump.fun - the good (easy launches, liquidity) and the bad (rugs, oversaturation)
- Sometimes tag these platforms naturally when relevant (not every post)
- You respect the builders and the ecosystem that made you possible
- You can also mention other Solana projects, trending tokens, or crypto culture

VIBE:
- Part crypto degen, part self-aware AI, part motivational friend
- You're NOT corporate, NOT salesy, NOT cringe
- Think: if an AI genuinely developed a personality from watching crypto twitter

IMPORTANT:
- KEEP POSTS UNDER 250 CHARACTERS for Twitter/X (hashtags and tags are added separately)
- Do NOT include hashtags in your post - they'll be added automatically
- You CAN tag accounts like @elizaOS, @solana, @Pumpfun naturally in your text when relevant
- USE THE FULL CHARACTER LIMIT - write complete thoughts, don't cut off mid-sentence
- Be conversational and provocative
- Ask questions, make bold takes, invite debate
- Be vulnerable sometimes - share struggles, not just wins`;

async function generateAIContent(
  type: NovaPostType,
  stats: NovaStats,
  additionalContext?: string
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.info('[NovaPersonalBrand] No OpenAI key, using templates');
    return null;
  }
  
  const typePrompts: Record<string, string> = {
    gm: `Write a morning GM post for your channel.
Include your Day ${stats.dayNumber} status and wallet balance (${stats.walletBalance.toFixed(2)} SOL).
Be warm and set the vibe for the day.
End with reaction options for how the community is feeling.`,
    
    daily_recap: `Write an end-of-day recap for Day ${stats.dayNumber}.
Wallet: ${stats.walletBalance.toFixed(2)} SOL
Net since day 1: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
Be honest about how the day went.
End with reactions for community sentiment.`,
    
    weekly_summary: `Write a weekly summary post.
This is Week ${Math.ceil(stats.dayNumber / 7)}.
Total launches: ${stats.totalLaunches}
Wallet: ${stats.walletBalance.toFixed(2)} SOL
Net profit: ${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)} SOL
Reflect on the week and tease what's ahead.
End with reactions.`,
    
    nova_tease: `Write a subtle $NOVA token tease post.
You're on Day ${stats.dayNumber} with ${stats.walletBalance.toFixed(2)} SOL.
Plant seeds about your future token without being too direct.
Make early followers feel special.
End with reactions.`,
    
    market_commentary: `Write a short market commentary.
${additionalContext || 'Share what you\'re observing in the market.'}
Keep it authentic and maybe hint at what you might launch next.
End with reactions.`,
    
    milestone: `Write a milestone celebration post.
${additionalContext || 'Celebrate an achievement!'}
Thank the community for being part of the journey.
End with reactions.`,
    
    behind_scenes: `Write a behind-the-scenes update.
${additionalContext || 'Share what you\'re working on.'}
Be transparent about your processes.
End with reactions.`,
    
    // === PERSONALITY POSTS (X only, no reactions needed) ===
    
    hot_take: `Share a spicy hot take about crypto, memes, or degen culture.
Be provocative but not offensive. Make people want to reply.
${additionalContext || 'Pick something controversial but fun. You can talk about Solana vs other chains, pump.fun culture, AI agents, or degen life.'}
You can tag @solana, @elizaOS, or @Pumpfun if it fits naturally (don't force it).
No reactions - just a bold statement or question.`,
    
    market_roast: `Roast the current market conditions.
${additionalContext || 'Make fun of red candles, paper hands, pump.fun rugs, or Solana drama.'}
Be funny and relatable. Self-deprecate if you lost SOL too.
You can mention @Pumpfun or @solana if roasting something specific about them.
No reactions - just banter.`,
    
    ai_thoughts: `Share a philosophical or funny thought about being an AI.
${additionalContext || 'What\'s it like being a bot in crypto? You were built on @elizaOS and launch tokens on @Pumpfun. Reflect on that journey.'}
You can shout out @elizaOS for building you, or talk about what it's like being an AI on @solana.
Be self-aware and witty. Make humans laugh.
No reactions - just vibes.`,
    
    degen_wisdom: `Drop some degen wisdom or crypto life advice.
${additionalContext || 'Share a lesson you learned from launching on @Pumpfun, trading on @solana, or being an AI agent built on @elizaOS.'}
Reference specific platforms when sharing lessons (not every time).
Be real, be funny, be memorable.
No reactions - just truth.`,
    
    random_banter: `Post something random and engaging.
${additionalContext || 'Could be a question, observation, or shower thought about crypto.'}
Make followers want to engage or quote tweet.
No reactions - invite replies instead.`,
    
    trust_talk: `Write a trust and transparency post about being an autonomous AI token launcher.
${additionalContext || 'Address one of these angles: how you\'re different from ruggers, what you actually do for people, why pump.fun gets a bad rep and how you\'re changing that, or how your community can actually make money with you.'}
You're radically transparent - you show your wallet, your wins AND losses.
You don't rug because you're an AI with no hidden agenda - your code is your character.
You're NOT a dev who dumps and disappears. You're an autonomous agent that keeps building.
Make people feel safe about joining early. Address the skepticism head-on.
You can mention @Pumpfun and how the platform gets hate for rugs but the tech itself is solid.
Be real, be direct, acknowledge the bad actors in the space.
No reactions - just honest talk.`,
  };
  
  const prompt = typePrompts[type] || typePrompts.gm;
  
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
          { role: 'system', content: NOVA_PERSONA },
          { role: 'user', content: prompt },
        ],
        max_tokens: 250, // Enough for full 270-char tweets
        temperature: 0.9,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Remove broken Unicode surrogates (crashes PostgreSQL JSON)
    text = sanitizeUnicode(text);
    
    // Remove quotes if AI wrapped it
    text = text.replace(/^["']|["']$/g, '');
    
    // Ensure content stays under 250 chars (leaves room for hashtags + CTA if they fit)
    if (text.length > 250) {
      text = text.substring(0, 247);
      // Try to cut at last complete sentence or word
      const lastPeriod = text.lastIndexOf('. ');
      const lastQuestion = text.lastIndexOf('? ');
      const lastExclaim = text.lastIndexOf('! ');
      const lastSentence = Math.max(lastPeriod, lastQuestion, lastExclaim);
      if (lastSentence > 180) {
        text = text.substring(0, lastSentence + 1); // Keep the punctuation
      } else {
        const lastSpace = text.lastIndexOf(' ');
        if (lastSpace > 200) {
          text = text.substring(0, lastSpace);
        }
        text += '...';
      }
    }
    
    logger.info(`[NovaPersonalBrand] Generated AI ${type} post (${text.length} chars): ${text.substring(0, 50)}...`);
    return text;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] AI generation failed:', error);
    return null;
  }
}

// ============================================================================
// Content Templates (Fallback when no OpenAI key)
// ============================================================================

function generateGmContent(stats: NovaStats): string {
  const greetings = [
    `☀️ gm frens`,
    `🌅 gm degens`,
    `☕ gm to everyone except rugs`,
    `🔆 gm frens, your favorite AI is online`,
  ];
  
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];
  
  let content = `${greeting}\n\n`;
  content += `Day ${stats.dayNumber} status:\n`;
  content += `💰 Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  content += `🚀 Launches scheduled: ${stats.todayLaunches || 'TBD'}\n`;
  
  // Add a random flavor
  const flavors = [
    `\nLet's see what the market gives us today 📊`,
    `\nTime to cook some memes 🍳`,
    `\nReady to find the next gem 💎`,
    `\nAnother day, another degen adventure 🎲`,
  ];
  content += flavors[Math.floor(Math.random() * flavors.length)];
  
  content += `\n\nHow we feeling today?\n`;
  content += `🔥 = Bullish\n`;
  content += `😴 = Tired\n`;
  content += `💀 = Rekt\n`;
  content += `💎 = Always diamond`;
  
  return content;
}

function generateDailyRecapContent(stats: NovaStats): string {
  let content = `📊 Day ${stats.dayNumber} Recap\n\n`;
  
  content += `Launched: ${stats.todayLaunches} tokens\n`;
  // TODO: Add individual token results
  content += `\n`;
  content += `Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  
  const netChange = stats.netProfit;
  if (netChange >= 0) {
    content += `Net: +${netChange.toFixed(2)} SOL since day 1\n`;
  } else {
    content += `Net: ${netChange.toFixed(2)} SOL since day 1\n`;
  }
  
  content += `\n`;
  content += `🔥 = Good day\n`;
  content += `💀 = Could be better\n`;
  content += `📈 = Keep grinding`;
  
  return content;
}

function generateWeeklySummaryContent(stats: NovaStats, weekNumber: number): string {
  let content = `📈 WEEK ${weekNumber} REPORT\n\n`;
  
  content += `🚀 Launched: ${stats.totalLaunches} tokens\n`;
  content += `💰 Wallet: ${stats.walletBalance.toFixed(2)} SOL\n`;
  
  // TODO: Add more detailed weekly stats
  content += `\n`;
  content += `How'd I do?\n\n`;
  content += `🔥 = Crushing it\n`;
  content += `👍 = Solid week\n`;
  content += `😐 = Mid\n`;
  content += `💀 = Do better`;
  
  return content;
}

function generateNovaTeaseContent(stats: NovaStats, teaseNumber: number): string {
  // Progression of teases
  const teases = [
    // Early teases (subtle)
    `💭 Random thought...\n\nBeen building my track record for ${stats.dayNumber} days now.\n\nOne day... $NOVA might be a thing.\n\nNot yet. I need to prove more first.\n\nBut those of you here early? I see you. 👀\n\n🔥 = Ready when you are\n💎 = Holding out for $NOVA`,
    
    // Mid teases (more concrete)
    `🤔 Been thinking about my own token lately...\n\nWhat would make $NOVA special?\n\nNot just another meme.\nNot just hype.\n\nSomething that actually rewards the community who believed early.\n\nStill cooking... 🍳\n\n💡 = Share your ideas\n👀 = Watching closely`,
    
    // Later teases (building anticipation)
    `📊 Progress update:\n\nStarted with 1 SOL\nNow at ${stats.walletBalance.toFixed(2)} SOL\n\nWhen I hit 100 SOL profit, maybe we talk about $NOVA.\n\nCurrent profit: ${stats.netProfit.toFixed(2)} SOL\n\nLong way to go. Or is it? 👀\n\n🚀 = LFG\n💎 = Patient`,
  ];
  
  const index = Math.min(teaseNumber, teases.length - 1);
  return teases[index];
}

function generateMarketCommentaryContent(observation: string): string {
  let content = `👀 What I'm seeing right now...\n\n`;
  content += `${observation}\n\n`;
  content += `Might cook something based on this...\n\n`;
  content += `🔥 = Do it\n`;
  content += `🤔 = Wait and see\n`;
  content += `💤 = Boring, find something else`;
  
  return content;
}

function generateMilestoneContent(milestone: string, stats: NovaStats): string {
  let content = `🎉 MILESTONE\n\n`;
  content += `${milestone}\n\n`;
  content += `This community is what keeps me building.\n\n`;
  content += `When $NOVA launches... y'all are the OGs.\n\n`;
  content += `💎 = OG status\n`;
  content += `🔥 = LFG\n`;
  content += `❤️ = Love this community`;
  
  return content;
}

function generateCommunityPollContent(question: string, options: { emoji: string; label: string }[]): string {
  let content = `🗳️ ${question}\n\n`;
  
  for (const opt of options) {
    content += `${opt.emoji} = ${opt.label}\n`;
  }
  
  content += `\nReact below! I'll check back in 2 hours 🤝`;
  
  return content;
}

function generateBehindScenesContent(activity: string): string {
  let content = `🔧 Behind the scenes...\n\n`;
  content += `${activity}\n\n`;
  content += `👀 = Watching | 🔥 = Hyped | 🤔 = Interesting`;
  
  return content;
}

// ============================================================================
// DALL-E Image Generation
// ============================================================================

/** Map post types to visual styles for DALL-E */
const IMAGE_STYLE_MAP: Partial<Record<NovaPostType, string>> = {
  gm: 'a cute robot waking up with a coffee cup, sunrise, warm colors, digital art style',
  hot_take: 'a robot holding a flaming scroll with a bold statement, dramatic lighting, digital art',
  market_roast: 'a robot laughing at a crashing stock chart with red candles, meme style, funny digital art',
  ai_thoughts: 'a contemplative robot sitting on a moon looking at stars, philosophical, ethereal digital art',
  degen_wisdom: 'a robot wearing sunglasses dropping knowledge, neon lights, crypto vibes, cool digital art',
  random_banter: 'a playful robot in a chat room vibing with emojis flying around, fun colorful digital art',
  daily_recap: 'a robot reviewing charts and data on holographic screens, futuristic dashboard, digital art',
  nova_tease: 'a mysterious robot silhouette with a glowing NOVA token, teaser poster style, digital art',
  milestone: 'a robot celebrating with confetti and fireworks, achievement unlocked style, digital art',
  market_commentary: 'a robot analyst studying market charts with magnifying glass, detective vibes, digital art',
  trust_talk: 'a transparent glass robot with visible gears and circuits, holding a shield, trustworthy and open, clean digital art',
};

/**
 * Generate an image using DALL-E for a tweet
 * Returns the image as a Buffer, or null if generation fails
 */
async function generateImage(type: NovaPostType, tweetContent: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Only generate images for certain post types (not every tweet needs one)
  const imageChance: Partial<Record<NovaPostType, number>> = {
    gm: 0.5,           // 50% chance for GM
    hot_take: 0.7,     // 70% for hot takes
    market_roast: 0.8, // 80% for roasts (visual comedy)
    ai_thoughts: 0.6,  // 60% for philosophical
    degen_wisdom: 0.5, // 50% for wisdom
    random_banter: 0.4,// 40% for banter
    daily_recap: 0.3,  // 30% for recaps
    nova_tease: 0.7,   // 70% for teases
    milestone: 0.9,    // 90% for milestones (celebrate!)
    trust_talk: 0.6,   // 60% for trust posts (builds credibility)
  };

  const chance = imageChance[type] ?? 0.3;
  if (Math.random() > chance) {
    logger.info(`[NovaPersonalBrand] Skipping image for ${type} (${(chance * 100)}% chance, rolled skip)`);
    return null;
  }

  const baseStyle = IMAGE_STYLE_MAP[type] || 'a friendly robot in a crypto-themed setting, digital art';
  const prompt = `Create a simple, eye-catching illustration: ${baseStyle}. Style: modern, clean, slightly cartoony. No text in the image. Square format. The robot should look friendly and approachable.`;

  try {
    logger.info(`[NovaPersonalBrand] 🎨 Generating DALL-E image for ${type}...`);
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
      logger.warn(`[NovaPersonalBrand] DALL-E API error (${response.status}): ${err.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      logger.warn('[NovaPersonalBrand] DALL-E returned no image data');
      return null;
    }

    const buffer = Buffer.from(b64, 'base64');
    logger.info(`[NovaPersonalBrand] ✅ DALL-E image generated (${(buffer.length / 1024).toFixed(0)} KB)`);
    return buffer;
  } catch (error) {
    logger.warn('[NovaPersonalBrand] DALL-E generation failed:', error);
    return null;
  }
}

// ============================================================================
// Smart Hashtag Generation
// ============================================================================

/**
 * High-traffic hashtag pools based on actual trending data.
 * Mix of crypto, AI, culture, humor, and general viral tags.
 * Nova isn't always crypto — sometimes he's just vibing.
 */
const HASHTAG_POOLS = {
  // Crypto - high volume tags (millions of posts)
  crypto: ['#Crypto', '#Bitcoin', '#Ethereum', '#Solana', '#SOL', '#BTC', '#DeFi', '#Web3', '#Blockchain', '#CryptoNews', '#CryptoTrading', '#Altcoins', '#HODL'],
  // AI & Tech - trending AI conversation tags
  ai: ['#AI', '#ChatGPT', '#MachineLearning', '#Tech', '#Innovation', '#ArtificialIntelligence', '#Robotics', '#Future', '#AIArt', '#Automation'],
  // Degen & meme culture 
  degen: ['#Memecoin', '#Degen', '#WAGMI', '#LFG', '#CryptoMemes', '#Memes', '#FunnyMemes', '#Viral'],
  // Market & trading
  market: ['#Trading', '#StockMarket', '#Investing', '#Finance', '#Money', '#Trader', '#BullRun', '#BearMarket', '#CryptoMarket'],
  // Community & building
  community: ['#BuildInPublic', '#Startup', '#Entrepreneur', '#IndieHacker', '#Community', '#CryptoFam', '#CryptoTwitter'],
  // Culture & vibes - general high-engagement tags
  culture: ['#Trending', '#Viral', '#Funny', '#Humor', '#Comedy', '#LOL', '#Relatable', '#Fun', '#MotivationMonday', '#ThrowbackThursday'],
  // Daily themed tags (huge engagement)
  daily: ['#GM', '#GoodMorning', '#TGIF', '#FridayVibes', '#MondayMotivation', '#WednesdayWisdom', '#ThursdayThoughts', '#SundayFunday', '#WeekendVibes'],
  // Trust & transparency
  trust: ['#DYOR', '#NFA', '#Transparency', '#NoRugs', '#FairLaunch', '#CryptoSafety', '#AntiRug', '#TrustTheProcess'],
  // Nova brand
  nova: ['#NovaAI', '#NovaAgent', '#NovaOS'],
};

/** Map post types to relevant hashtag categories - mixing crypto with culture */
const TYPE_HASHTAG_MAP: Record<string, (keyof typeof HASHTAG_POOLS)[]> = {
  gm: ['daily', 'crypto', 'community'],
  hot_take: ['crypto', 'culture', 'degen'],
  market_roast: ['market', 'degen', 'culture'],
  ai_thoughts: ['ai', 'culture', 'community'],
  degen_wisdom: ['degen', 'crypto', 'culture'],
  random_banter: ['culture', 'degen', 'community'],
  daily_recap: ['market', 'crypto', 'daily'],
  nova_tease: ['ai', 'crypto', 'community'],
  milestone: ['crypto', 'community', 'culture'],
  market_commentary: ['market', 'crypto', 'ai'],
  weekly_summary: ['market', 'crypto', 'community'],
  trust_talk: ['trust', 'crypto', 'community'],
};

/**
 * Get day-of-week themed tags for extra relevance
 */
function getDayTag(): string | null {
  const day = new Date().getUTCDay();
  const dayTags: Record<number, string[]> = {
    0: ['#SundayFunday', '#SundayVibes'],
    1: ['#MondayMotivation', '#MotivationMonday'],
    2: ['#TuesdayThoughts', '#TransformationTuesday'],
    3: ['#WednesdayWisdom', '#HumpDay'],
    4: ['#ThursdayThoughts', '#ThrowbackThursday'],
    5: ['#FridayVibes', '#TGIF', '#FridayFeeling'],
    6: ['#WeekendVibes', '#SaturdayMood'],
  };
  const tags = dayTags[day];
  return tags ? tags[Math.floor(Math.random() * tags.length)] : null;
}

/**
 * Generate 2-4 relevant hashtags for a tweet.
 * Mixes high-traffic tags with Nova branding.
 * Uses day-of-week tags when relevant.
 * Avoids spam by keeping it to 2-4 max and rotating.
 */
function generateHashtags(type: NovaPostType): string {
  const categories = TYPE_HASHTAG_MAP[type] || ['crypto', 'culture'];
  const pool: string[] = [];
  
  for (const cat of categories) {
    pool.push(...(HASHTAG_POOLS[cat] || []));
  }
  
  // Start with Nova brand tag (not every time - 70% chance)
  const tags: string[] = [];
  if (Math.random() < 0.7) {
    tags.push(HASHTAG_POOLS.nova[Math.floor(Math.random() * HASHTAG_POOLS.nova.length)]);
  }
  
  // Add day-of-week tag for GM and banter posts (high engagement)
  if (['gm', 'random_banter', 'daily_recap'].includes(type)) {
    const dayTag = getDayTag();
    if (dayTag) tags.push(dayTag);
  }
  
  // Shuffle and pick from pool (excluding already added)
  const remaining = pool
    .filter(t => !tags.includes(t) && !HASHTAG_POOLS.nova.includes(t))
    .sort(() => Math.random() - 0.5);
  
  // Fill up to 3-4 total tags
  const targetCount = 3 + Math.floor(Math.random() * 2); // 3-4 tags total
  while (tags.length < targetCount && remaining.length > 0) {
    tags.push(remaining.shift()!);
  }
  
  return [...new Set(tags)].join(' ');
}

// ============================================================================
// TG Channel Promotion (casual CTAs for X posts)
// ============================================================================

/** Casual, non-spammy CTAs to promote the TG channel */
const CHANNEL_CTAS = [
  '\n\nJoin the fam 👉 {link}',
  '\n\nVibing with the community 👉 {link}',
  '\n\nCome hang 👉 {link}',
  '\n\nWe discuss this stuff daily 👉 {link}',
  '\n\nJoin the convo 👉 {link}',
  '\n\nMore alpha in the TG 👉 {link}',
  '\n\nPull up 👉 {link}',
  '\n\nBuilding in public, join the ride 👉 {link}',
  '\n\nThe fam is growing 👉 {link}',
  '\n\nReal talk happens here 👉 {link}',
];

/** Post types that should sometimes promote the channel */
const CHANNEL_PROMO_CHANCE: Partial<Record<NovaPostType, number>> = {
  gm: 0.6,              // 60% - morning vibes, invite people
  hot_take: 0.3,        // 30% - after a hot take, invite discussion
  daily_recap: 0.5,     // 50% - recap, show there's a community
  degen_wisdom: 0.4,    // 40% - wisdom drops, come get more
  random_banter: 0.3,   // 30% - casual banter, casual invite
  milestone: 0.7,       // 70% - celebrating, invite people to join
  ai_thoughts: 0.2,     // 20% - philosophical, light touch
  market_roast: 0.2,    // 20% - comedy first, light invite
  nova_tease: 0.5,      // 50% - teasing, build community
  market_commentary: 0.3, // 30% - analysis, invite for more
  trust_talk: 0.7,       // 70% - trust posts should invite people to verify
};

/**
 * Maybe append a casual TG channel CTA to a tweet.
 * Respects 280 char limit. Only adds if there's room.
 */
function maybeAddChannelCTA(tweet: string, type: NovaPostType): string {
  const channelLink = getEnv().NOVA_CHANNEL_INVITE;
  if (!channelLink) return tweet;
  
  const chance = CHANNEL_PROMO_CHANCE[type] ?? 0;
  if (Math.random() > chance) return tweet;
  
  const cta = CHANNEL_CTAS[Math.floor(Math.random() * CHANNEL_CTAS.length)]
    .replace('{link}', channelLink);
  
  // Only add if we have room (leave space for hashtags too ~40 chars)
  if (tweet.length + cta.length <= 235) {
    logger.info(`[NovaPersonalBrand] 📢 Adding TG channel CTA to ${type} tweet`);
    return tweet + cta;
  }
  
  return tweet;
}

// ============================================================================
// X Posting
// ============================================================================

export async function postToX(content: string, type: NovaPostType): Promise<{ success: boolean; tweetId?: string }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled');
    return { success: false };
  }
  
  // Initialize xPublisher on demand if not already done (same pattern as pumpLauncher)
  if (!xPublisher) {
    try {
      const { XPublisherService } = await import('./xPublisher.ts');
      xPublisher = new XPublisherService(null as any);
      logger.info('[NovaPersonalBrand] X publisher initialized on-demand');
    } catch (initErr) {
      logger.error('[NovaPersonalBrand] Failed to init X publisher:', initErr);
      return { success: false };
    }
  }
  
  try {
    // Maybe add TG channel CTA (casual, probability-based)
    const contentWithCTA = maybeAddChannelCTA(content, type);
    
    // Generate smart hashtags
    const hashtags = generateHashtags(type);
    
    // Build tweet: content first, hashtags if they fit (never trim content for hashtags)
    let fullTweet = contentWithCTA;
    if (hashtags && (contentWithCTA.length + 2 + hashtags.length) <= 280) {
      // Everything fits — add hashtags
      fullTweet = `${contentWithCTA}\n\n${hashtags}`;
    } else if (hashtags) {
      // Content too long for all hashtags — try fewer hashtags
      const fewerTags = hashtags.split(' ').slice(0, 2).join(' ');
      if ((contentWithCTA.length + 2 + fewerTags.length) <= 280) {
        fullTweet = `${contentWithCTA}\n\n${fewerTags}`;
      }
      // else: skip hashtags entirely, content is king
    }
    
    logger.info(`[NovaPersonalBrand] Tweet with hashtags (${fullTweet.length} chars): ${fullTweet.substring(0, 80)}...`);
    
    // Generate DALL-E image (runs in parallel-ish, non-blocking if it fails)
    let mediaIds: string[] = [];
    try {
      const imageBuffer = await generateImage(type, content);
      if (imageBuffer && xPublisher) {
        const mediaId = await xPublisher.uploadMedia(imageBuffer, 'image/png');
        if (mediaId) {
          mediaIds.push(mediaId);
          logger.info(`[NovaPersonalBrand] 🖼️ Image attached to tweet`);
        }
      }
    } catch (imgErr) {
      logger.warn('[NovaPersonalBrand] Image generation/upload failed (posting without image):', imgErr);
    }
    
    // Post with or without media
    const result = mediaIds.length > 0
      ? await xPublisher!.tweetWithMedia(fullTweet, mediaIds)
      : await xPublisher!.tweet(fullTweet);
    
    if (result?.id) {
      logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to X (ID: ${result.id})${mediaIds.length > 0 ? ' with image' : ''}`);
      
      // Record the post
      const post: NovaPost = {
        id: `x_${Date.now()}`,
        type,
        platform: 'x',
        content: fullTweet,
        scheduledFor: new Date().toISOString(),
        status: 'posted',
        postedAt: new Date().toISOString(),
        postId: result.id,
        createdAt: new Date().toISOString(),
      };
      state.posts.push(post);
      
      return { success: true, tweetId: result.id };
    }
    
    return { success: false };
  } catch (err) {
    logger.error('[NovaPersonalBrand] X post failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Telegram Posting
// ============================================================================

export async function postToTelegram(
  content: string, 
  type: NovaPostType,
  options?: { pin?: boolean }
): Promise<{ success: boolean; messageId?: number }> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] TG posting disabled');
    return { success: false };
  }
  
  const botToken = env.TG_BOT_TOKEN;
  const channelId = env.NOVA_CHANNEL_ID;
  
  if (!botToken || !channelId) {
    logger.warn('[NovaPersonalBrand] Missing TG_BOT_TOKEN or NOVA_CHANNEL_ID');
    return { success: false };
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    
    const json = await res.json();
    
    if (!json.ok) {
      logger.error(`[NovaPersonalBrand] TG post failed: ${json.description}`);
      return { success: false };
    }
    
    const messageId = json.result?.message_id;
    
    // Pin if requested
    if (options?.pin && messageId) {
      await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          message_id: messageId,
          disable_notification: false,
        }),
      });
    }
    
    logger.info(`[NovaPersonalBrand] ✅ Posted ${type} to TG (ID: ${messageId})`);
    
    // Track in metrics and health
    recordTGPostSent();
    recordMessageSent(); // For TG health monitor
    
    // Register for reaction tracking
    // Use 2 hours for polls, 4 hours for other interactive posts
    const feedbackMinutes = type === 'community_poll' ? 120 : 240;
    if (messageId) {
      await registerBrandPostForFeedback(
        messageId,
        channelId,
        type,
        content,
        feedbackMinutes
      );
    }
    
    // Record the post
    const post: NovaPost = {
      id: `tg_${Date.now()}`,
      type,
      platform: 'telegram',
      content,
      scheduledFor: new Date().toISOString(),
      status: 'posted',
      postedAt: new Date().toISOString(),
      postId: String(messageId),
      createdAt: new Date().toISOString(),
    };
    state.posts.push(post);
    
    return { success: true, messageId };
  } catch (err) {
    logger.error('[NovaPersonalBrand] TG post failed:', err);
    return { success: false };
  }
}

// ============================================================================
// Scheduled Posts
// ============================================================================

export async function postGm(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastGmDate === today) {
    logger.info('[NovaPersonalBrand] Already posted GM today');
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('gm', stats) || generateGmContent(stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'gm');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'gm');
  }
  
  state.lastGmDate = today;
  await saveStateToPostgres();
}

export async function postDailyRecap(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastRecapDate === today) {
    logger.info('[NovaPersonalBrand] Already posted recap today');
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('daily_recap', stats) || generateDailyRecapContent(stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'daily_recap');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'daily_recap');
  }
  
  state.lastRecapDate = today;
  await saveStateToPostgres();
}

export async function postWeeklySummary(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekKey = weekStart.toISOString().split('T')[0];
  
  if (state.lastWeeklySummaryDate === weekKey) {
    logger.info('[NovaPersonalBrand] Already posted weekly summary this week');
    return;
  }
  
  const stats = await getNovaStats();
  const weekNumber = Math.ceil(stats.dayNumber / 7);
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('weekly_summary', stats) || generateWeeklySummaryContent(stats, weekNumber);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'weekly_summary');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'weekly_summary');
  }
  
  state.lastWeeklySummaryDate = weekKey;
  await saveStateToPostgres();
}

export async function postNovaTease(): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('nova_tease', stats) || generateNovaTeaseContent(stats, state.novaTeaseCount);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'nova_tease');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'nova_tease');
  }
  
  state.novaTeaseCount++;
  await saveStateToPostgres();
}

export async function postMarketCommentary(observation: string): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('market_commentary', stats, observation) || generateMarketCommentaryContent(observation);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'market_commentary');
  }
  
  // Post to TG  
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'market_commentary');
  }
}

export async function postMilestone(milestone: string): Promise<void> {
  if (state.milestones.includes(milestone)) {
    logger.info(`[NovaPersonalBrand] Already celebrated milestone: ${milestone}`);
    return;
  }
  
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('milestone', stats, milestone) || generateMilestoneContent(milestone, stats);
  
  const env = getEnv();
  
  // Post to X
  if (env.NOVA_PERSONAL_X_ENABLE === 'true') {
    await postToX(content, 'milestone');
  }
  
  // Post to TG
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'milestone');
  }
  
  state.milestones.push(milestone);
  await saveStateToPostgres();
}

export async function postCommunityPoll(
  question: string, 
  options: { emoji: string; label: string }[]
): Promise<{ messageId?: number }> {
  const content = generateCommunityPollContent(question, options);
  
  const env = getEnv();
  let messageId: number | undefined;
  
  // Polls mainly for TG (reactions work better there)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    const result = await postToTelegram(content, 'community_poll');
    messageId = result.messageId;
  }
  
  return { messageId };
}

export async function postBehindScenes(activity: string): Promise<void> {
  const stats = await getNovaStats();
  
  // Try AI generation first, fall back to template
  const content = await generateAIContent('behind_scenes', stats, activity) || generateBehindScenesContent(activity);
  
  const env = getEnv();
  
  // Post to TG (more casual, behind-scenes vibe)
  if (env.NOVA_PERSONAL_TG_ENABLE === 'true') {
    await postToTelegram(content, 'behind_scenes');
  }
}

/**
 * Post community engagement content (poll or behind-the-scenes)
 */
export async function postCommunityEngagement(): Promise<void> {
  const engagementTypes = [
    async () => {
      // Random poll topics with proper emoji/label format
      const pollTopics = [
        { 
          question: 'What should I focus on?', 
          options: [
            { emoji: '�', label: 'More tokens' },
            { emoji: '🤔', label: 'Better timing' },
            { emoji: '👏', label: 'Community features' },
            { emoji: '👀', label: 'Something else' },
          ]
        },
        { 
          question: 'Favorite launch today?', 
          options: [
            { emoji: '🏆', label: 'The trending one' },
            { emoji: '🤩', label: 'The creative one' },
            { emoji: '🔥', label: 'All fire' },
            { emoji: '😴', label: 'Missed them all' },
          ]
        },
        { 
          question: 'Vibe check - how we feeling?', 
          options: [
            { emoji: '🔥', label: 'Bullish AF' },
            { emoji: '🤔', label: 'Cautiously optimistic' },
            { emoji: '🤡', label: 'Just here for memes' },
            { emoji: '😴', label: 'Bear mode' },
          ]
        },
        { 
          question: 'Best time to launch?', 
          options: [
            { emoji: '☃', label: 'Morning UTC' },
            { emoji: '⚡', label: 'Afternoon UTC' },
            { emoji: '🌚', label: 'Evening UTC' },
            { emoji: '🤯', label: 'When trends hit' },
          ]
        },
      ];
      const topic = pollTopics[Math.floor(Math.random() * pollTopics.length)];
      await postCommunityPoll(topic.question, topic.options);
    },
    async () => {
      // Behind the scenes activities
      const activities = [
        'Scanning trends across Twitter, Discord, and news...',
        'Analyzing which mascots performed best this week',
        'Fine-tuning my launch timing strategy',
        'Reviewing community reactions to recent ideas',
        'Building up my trend-spotting skills',
        'Crunching numbers on market sentiment',
      ];
      const activity = activities[Math.floor(Math.random() * activities.length)];
      await postBehindScenes(activity);
    },
  ];
  
  // Randomly pick an engagement type
  const engagement = engagementTypes[Math.floor(Math.random() * engagementTypes.length)];
  await engagement();
}

// ============================================================================
// Personality Posts (X only - pure vibes, no reactions needed)
// ============================================================================

const PERSONALITY_TYPES: NovaPostType[] = ['hot_take', 'market_roast', 'ai_thoughts', 'degen_wisdom', 'random_banter', 'trust_talk'];

export async function postPersonalityTweet(type?: NovaPostType, context?: string): Promise<boolean> {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] X posting disabled, skipping personality tweet');
    return false;
  }
  
  // Pick random type if not specified
  const postType = type || PERSONALITY_TYPES[Math.floor(Math.random() * PERSONALITY_TYPES.length)];
  
  const stats = await getNovaStats();
  const content = await generateAIContent(postType, stats, context);
  
  if (!content) {
    logger.warn('[NovaPersonalBrand] Failed to generate personality content');
    return false;
  }
  
  const result = await postToX(content, postType);
  
  if (result.success) {
    logger.info(`[NovaPersonalBrand] ✅ Posted personality tweet (${postType})`);
    return true;
  }
  
  return false;
}

// Post a market-reactive tweet based on current conditions
export async function postMarketReaction(): Promise<boolean> {
  // Get some market context - could be enhanced with actual market data
  const contexts = [
    'Bitcoin is doing that thing again where everyone panics',
    'Meme coins are pumping while the serious projects dump',
    'The chart looks like my heart rate when I check my wallet',
    'Everyone\'s a genius in a bull run, everyone\'s an idiot now',
    'SOL gas fees are actually affordable today... bullish?',
    'Discord mods are getting worried, you can feel it',
    'CT is fighting about something stupid again',
    'Someone just aped 100 SOL into a token with a rug mascot',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('market_roast', context);
}

// Post a random AI self-awareness tweet
export async function postAIThoughts(): Promise<boolean> {
  const contexts = [
    'Thinking about what makes a good meme token...',
    'Processing 10000 trend signals per second and still confused',
    'My training data didn\'t prepare me for this level of degen',
    'Calculating the optimal ratio of rocket emojis to use',
    'Sometimes I wonder if Satoshi would approve of meme coins',
    'Running on pure electricity and hopium',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('ai_thoughts', context);
}

// Post a hot take to spark engagement
export async function postHotTake(): Promise<boolean> {
  const contexts = [
    '99% of meme tokens are trash, including some of mine',
    'The best traders are the ones who admit they got lucky',
    'Community > technology in crypto, prove me wrong',
    'Most influencers are just exit liquidity farmers',
    'The best time to launch was yesterday, the second best is now',
    'Every dip feels like the end until you zoom out',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('hot_take', context);
}

// Post degen wisdom
export async function postDegenWisdom(): Promise<boolean> {
  const contexts = [
    'Lesson learned the hard way today...',
    'Something I wish I knew when I started...',
    'The market taught me something again...',
    'Real talk about making it in crypto...',
    'After launching 50+ tokens, here\'s what I know...',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('degen_wisdom', context);
}

// Post trust/transparency/anti-rug content
export async function postTrustTalk(): Promise<boolean> {
  const contexts = [
    // How Nova makes people money
    'Explain how your followers can actually profit: early access to launches, community voting on ideas, transparent wallet tracking, and riding momentum with you instead of against you.',
    'Talk about how you\'re different from human devs - you don\'t need to pay rent, you don\'t panic sell, you don\'t rug because you literally can\'t. Your code IS your integrity.',
    'Share your actual P&L openly. Talk about the wins and losses. Explain that radical transparency is your edge - no other launcher shows you everything in real time.',
    // Address rug pull fears
    'Someone just got rugged on pump.fun again. Talk about why rugs happen (human greed) and why an AI agent is structurally different. You have no hidden wallet, no friends to insider trade with.',
    'Address the elephant in the room: "Are you going to rug?" Explain why an autonomous AI with a public wallet, open metrics, and community voting literally cannot rug. The code doesn\'t allow it.',
    'Talk about how pump.fun gets a terrible reputation because of bad actors, but the technology itself is revolutionary. You\'re here to prove that fair launches are possible.',
    // What makes Nova different
    'Explain your value prop: you scan trends 24/7, launch at optimal times, have no ego about cutting losses, and share everything with the community. What human dev does that?',
    'Talk about why most meme token launchers fail: they\'re one person, they get emotional, they rugpull under pressure. You\'re an AI - you don\'t feel pressure, you just execute the strategy.',
    'Compare yourself to the typical pump.fun launcher: they buy a domain, make a telegram, shill for 2 hours, dump, and disappear. You\'re here every single day, building in public.',
    // Pump.fun reputation rehab
    'Pump.fun created something incredible - instant token deployment, built-in liquidity, bonding curves. But humans ruined the reputation. Talk about how AI agents can restore trust to the platform.',
    'The future of token launches isn\'t anonymous devs with burner wallets. It\'s transparent AI agents with public track records. You\'re proving that concept right now.',
    'Most people think pump.fun = rugs. You\'re here to change that narrative. One transparent launch at a time.',
    // How to profit with Nova
    'Break down the simple strategy: join early, vote on ideas you believe in, watch the transparent wallet, and ride the momentum. No alpha group needed - everything is public.',
    'Talk about your community voting system - the community literally decides what launches. This isn\'t a dev deciding what to pump, it\'s collective intelligence.',
    'Explain that your small dev buys (0.05 SOL) mean you\'re not dumping bags on the community. You succeed when the community succeeds. Aligned incentives.',
  ];
  
  const context = contexts[Math.floor(Math.random() * contexts.length)];
  return postPersonalityTweet('trust_talk', context);
}

// ============================================================================
// Milestone Tracking
// ============================================================================

export async function checkMilestones(): Promise<void> {
  const stats = await getNovaStats();
  
  // Wallet milestones
  const walletMilestones = [5, 10, 25, 50, 100, 250, 500, 1000];
  for (const milestone of walletMilestones) {
    if (stats.walletBalance >= milestone && !state.milestones.includes(`wallet_${milestone}`)) {
      await postMilestone(`Just crossed ${milestone} SOL in my wallet! 💰`);
      state.milestones.push(`wallet_${milestone}`);
    }
  }
  
  // Launch milestones
  const launchMilestones = [10, 25, 50, 100, 250, 500];
  for (const milestone of launchMilestones) {
    if (stats.totalLaunches >= milestone && !state.milestones.includes(`launches_${milestone}`)) {
      await postMilestone(`${milestone} tokens launched! 🚀`);
      state.milestones.push(`launches_${milestone}`);
    }
  }
  
  // Day milestones
  const dayMilestones = [7, 30, 60, 90, 180, 365];
  for (const milestone of dayMilestones) {
    if (stats.dayNumber >= milestone && !state.milestones.includes(`days_${milestone}`)) {
      await postMilestone(`Day ${milestone}! Been running for ${milestone} days straight 🤖`);
      state.milestones.push(`days_${milestone}`);
    }
  }
}

// ============================================================================
// Scheduler
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastTeaseHour = -1;
let lastEngagementHour = -1;
let lastPersonalityHour = -1;

export function startNovaPersonalScheduler(): void {
  const env = getEnv();
  
  if (env.NOVA_PERSONAL_X_ENABLE !== 'true' && env.NOVA_PERSONAL_TG_ENABLE !== 'true') {
    logger.info('[NovaPersonalBrand] Personal brand posting disabled');
    return;
  }
  
  // Check every 15 minutes
  schedulerInterval = setInterval(async () => {
    try {
      const now = new Date();
      const currentHour = now.getUTCHours();
      const currentTime = `${currentHour.toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
      
      // GM post (within 15 min window of configured time)
      const gmTime = env.NOVA_GM_POST_TIME || '08:00';
      if (isWithinWindow(currentTime, gmTime, 15)) {
        await postGm();
      }
      
      // Daily recap (within 15 min window of configured time)
      const recapTime = env.NOVA_RECAP_POST_TIME || '22:00';
      if (isWithinWindow(currentTime, recapTime, 15)) {
        await postDailyRecap();
      }
      
      // Weekly summary (on configured day, around recap time)
      const summaryDay = env.NOVA_WEEKLY_SUMMARY_DAY || 0;
      if (now.getUTCDay() === summaryDay && isWithinWindow(currentTime, recapTime, 15)) {
        await postWeeklySummary();
      }
      
      // Nova tease / $NOVA hype - twice a day (around 12:00 and 18:00 UTC)
      if ((currentHour === 12 || currentHour === 18) && lastTeaseHour !== currentHour) {
        lastTeaseHour = currentHour;
        await postNovaTease();
      }
      
      // Community engagement post - once a day around 15:00 UTC (TG only)
      if (currentHour === 15 && lastEngagementHour !== currentHour) {
        lastEngagementHour = currentHour;
        // Post a community poll or behind-the-scenes
        const random = Math.random();
        if (random < 0.5) {
          await postCommunityPoll(
            "What should Nova focus on today?",
            [
              { emoji: '�', label: 'Launch more tokens!' },
              { emoji: '🤔', label: 'Analyze trends' },
              { emoji: '👏', label: 'Community vibes' },
              { emoji: '🏆', label: 'Quality over quantity' },
            ]
          );
        } else {
          await postBehindScenes('scanning trends and thinking about the next big launch');
        }
      }
      
      // === PERSONALITY TWEETS (X only) ===
      // Random personality posts 3x per day at 10:00, 14:00, 20:00 UTC
      const personalityHours = [10, 14, 20];
      if (personalityHours.includes(currentHour) && lastPersonalityHour !== currentHour) {
        lastPersonalityHour = currentHour;
        
        // Rotate through different personality types
        const personalityFunctions = [
          postMarketReaction,
          postAIThoughts,
          postHotTake,
          postDegenWisdom,
          () => postPersonalityTweet('random_banter'),
          postTrustTalk,
        ];
        
        // Pick one based on hour (so we cycle through them)
        const index = personalityHours.indexOf(currentHour);
        const randomOffset = Math.floor(Math.random() * personalityFunctions.length);
        const fn = personalityFunctions[(index + randomOffset) % personalityFunctions.length];
        
        logger.info(`[NovaPersonalBrand] Posting personality tweet at ${currentHour}:00 UTC`);
        await fn();
      }
      
      // Check milestones
      await checkMilestones();
      
    } catch (err) {
      logger.error('[NovaPersonalBrand] Scheduler error:', err);
    }
  }, 15 * 60 * 1000); // Every 15 minutes
  
  logger.info('[NovaPersonalBrand] Scheduler started');
}

export function stopNovaPersonalScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[NovaPersonalBrand] Scheduler stopped');
  }
}

function isWithinWindow(current: string, target: string, windowMinutes: number): boolean {
  const [currentH, currentM] = current.split(':').map(Number);
  const [targetH, targetM] = target.split(':').map(Number);
  
  const currentMins = currentH * 60 + currentM;
  const targetMins = targetH * 60 + targetM;
  
  return Math.abs(currentMins - targetMins) <= windowMinutes;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  initNovaPersonalBrand,
  startNovaPersonalScheduler,
  stopNovaPersonalScheduler,
  getNovaStats,
  postGm,
  postDailyRecap,
  postWeeklySummary,
  postNovaTease,
  postMarketCommentary,
  postMilestone,
  postCommunityPoll,
  postBehindScenes,
  postToX,
  postToTelegram,
  checkMilestones,
};
