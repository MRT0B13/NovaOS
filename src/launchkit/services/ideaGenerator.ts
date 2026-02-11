import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { getCommunityPreferences, getThemeFeedback } from './communityVoting.ts';

/**
 * Idea Generator Service
 * 
 * The "creative brain" for autonomous mode.
 * Generates token concepts (name, ticker, description, mascot) using AI.
 * Integrates with the agent's personality for on-brand ideas.
 * 
 * NEW: Learns from community voting feedback to generate better ideas over time.
 */

export interface TokenIdea {
  name: string;
  ticker: string;
  description: string;
  mascot?: string;
  theme?: string;
  generatedAt: string;
  confidence: number; // 0-1 score of how good the idea seems
  // Optional extended fields used by community voting / personal brand
  status?: string;
  hooks?: string[];
  backstory?: string;
  source?: string;
  reasoning?: string;
}

export interface IdeaGeneratorConfig {
  agentName?: string;
  agentPersonality?: string;
  themes?: string[]; // Optional themes to focus on
  avoidTickers?: string[]; // Tickers already used
  trendContext?: string; // Optional trending topic to base idea on (reactive mode)
  useCommunityLearnings?: boolean; // Use community voting feedback to guide generation
}

// Default themes Nova might explore
const DEFAULT_THEMES = [
  'chaos and entropy',
  'absurdist humor',
  'internet culture',
  'crypto degen life',
  'AI sentience',
  'meme mashups',
  'surreal concepts',
  'anti-establishment',
  'self-aware tokens',
  'meta commentary',
];

// Fallback ideas if AI generation fails
const FALLBACK_IDEAS: TokenIdea[] = [
  {
    name: 'Chaos Coin',
    ticker: 'CHAOS',
    description: 'Embrace the entropy. Nothing makes sense and that\'s the point.',
    mascot: 'a glitchy pixel creature dissolving into static',
    theme: 'chaos and entropy',
    generatedAt: new Date().toISOString(),
    confidence: 0.5,
  },
  {
    name: 'Probably Nothing',
    ticker: 'NOTHING',
    description: 'It\'s probably nothing. Or is it? DYOR NFA.',
    mascot: 'an empty void with googly eyes',
    theme: 'absurdist humor',
    generatedAt: new Date().toISOString(),
    confidence: 0.5,
  },
  {
    name: 'Based Department',
    ticker: 'BASED',
    description: 'Hello? Yes, this is the based department. Your call has been accepted.',
    mascot: 'a rotary phone wearing sunglasses',
    theme: 'internet culture',
    generatedAt: new Date().toISOString(),
    confidence: 0.5,
  },
];

/**
 * Generate a token idea using OpenAI
 */
export async function generateIdea(config: IdeaGeneratorConfig = {}): Promise<TokenIdea> {
  const env = getEnv();
  const apiKey = env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.warn('[IdeaGenerator] No OpenAI key, using fallback idea');
    return getRandomFallback(config.avoidTickers);
  }
  
  // If we have a trend context (reactive mode), use it as the theme
  const theme = config.trendContext 
    || config.themes?.[Math.floor(Math.random() * config.themes.length)] 
    || DEFAULT_THEMES[Math.floor(Math.random() * DEFAULT_THEMES.length)];
  
  const avoidList = config.avoidTickers?.length 
    ? `\n\nDO NOT use these tickers (already taken): ${config.avoidTickers.join(', ')}`
    : '';
  
  // Add trend context instruction if this is a reactive launch
  const trendInstruction = config.trendContext 
    ? `\n\n🔥 TRENDING TOPIC: "${config.trendContext}"\nCreate an idea that cleverly riffs on this trending topic. Make it timely and relevant while adding a crypto/degen spin.`
    : '';
  
  // Add community learning context if available
  let communityLearningsText = '';
  if (config.useCommunityLearnings !== false) {
    try {
      const prefs = getCommunityPreferences();
      if (prefs.totalVotes > 0) {
        communityLearningsText = '\n\n📊 COMMUNITY FEEDBACK (from previous ideas):';
        
        if (prefs.preferredStyles.length > 0) {
          communityLearningsText += `\n✅ Themes the community LOVES: ${prefs.preferredStyles.join(', ')}`;
        }
        if (prefs.avoidStyles.length > 0) {
          communityLearningsText += `\n❌ Themes to AVOID (low approval): ${prefs.avoidStyles.join(', ')}`;
        }
        
        communityLearningsText += `\nOverall approval rate: ${(prefs.avgApprovalRate * 100).toFixed(0)}%`;
        communityLearningsText += `\nUse this feedback to generate ideas more likely to resonate!`;
        
        // Check if current theme has feedback
        const themeFeedback = getThemeFeedback(theme);
        if (themeFeedback.approved + themeFeedback.rejected >= 2) {
          if (themeFeedback.rate >= 0.7) {
            communityLearningsText += `\n\n💡 "${theme}" has ${(themeFeedback.rate * 100).toFixed(0)}% approval - good choice!`;
          } else if (themeFeedback.rate <= 0.3) {
            communityLearningsText += `\n\n⚠️ "${theme}" has only ${(themeFeedback.rate * 100).toFixed(0)}% approval - consider making it extra compelling!`;
          }
        }
      }
    } catch {
      // Community voting module may not be available
    }
  }
  
  const systemPrompt = `You are a creative meme coin idea generator for an AI agent named ${config.agentName || 'Nova'}.

${config.agentPersonality || 'Nova is a data-driven, self-aware AI that launches meme tokens on Solana. Nova is blunt, transparent, and has opinions backed by launch data. Not a hype bot — a builder learning in public.'}

Generate a unique, creative meme coin concept. The idea should be:
- Memorable and catchy
- Tied to a REAL cultural moment, trending narrative, or event people are emotionally invested in
- Something 50 people in a Telegram group would want to share the contract address with friends
- Able to sustain interest for hours/days, not just minutes
- NOT a random shock-value joke or offensive for laughs
- NOT a copy of existing major meme coins (no DOGE, SHIB, PEPE clones)

CULTURAL RESONANCE FILTER — evaluate before proposing:
1. Is this a moment people are ALREADY emotionally invested in? (news event, cultural moment, viral meme) → GOOD
2. Is this just a random shock-value joke with no cultural hook? → SKIP, generate something else
3. Would real people want to share this CA with friends? → If no, SKIP
4. Does this ride a narrative that could sustain interest for hours/days? → If just minutes, SKIP
5. AVOID: Offensive/criminal themes, overly niche inside jokes, anything that could create legal issues

OPTIMIZE FOR: Real cultural moments, trending memes with legs, events with emotional investment, themes that make people want to PARTICIPATE not just laugh.

Theme for this idea: ${theme}${avoidList}${trendInstruction}${communityLearningsText}

Respond in this exact JSON format:
{
  "name": "Full Token Name",
  "ticker": "TICKER",
  "description": "A compelling 1-2 sentence description that would make degens curious",
  "mascot": "Visual description of mascot/logo concept for DALL-E",
  "confidence": 0.8
}

Rules:
- Ticker must be 2-6 uppercase letters
- Mascot description should be vivid and image-generation friendly. Style: bold, clean, meme-native, dark background, single neon accent color, NO text overlay
- Confidence is your self-assessment (0.5-1.0) of cultural resonance and shareability`;

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
          { role: 'user', content: `Generate a creative meme coin idea with the theme: "${theme}"` },
        ],
        temperature: 0.9, // High creativity
        max_tokens: 500,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[IdeaGenerator] OpenAI API error: ${response.status} - ${errorText}`);
      return getRandomFallback(config.avoidTickers);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      logger.warn('[IdeaGenerator] Empty response from OpenAI');
      return getRandomFallback(config.avoidTickers);
    }
    
    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    const parsed = JSON.parse(jsonStr.trim());
    
    // Validate required fields
    if (!parsed.name || !parsed.ticker || !parsed.description) {
      logger.warn('[IdeaGenerator] Invalid idea structure from AI');
      return getRandomFallback(config.avoidTickers);
    }
    
    // Normalize ticker
    parsed.ticker = parsed.ticker.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
    if (parsed.ticker.length < 2) {
      parsed.ticker = 'NOVA' + Math.floor(Math.random() * 100);
    }
    
    // Check if ticker is in avoid list
    if (config.avoidTickers?.includes(parsed.ticker)) {
      logger.info(`[IdeaGenerator] Generated ticker ${parsed.ticker} is taken, regenerating...`);
      // Add suffix to make unique
      parsed.ticker = parsed.ticker.slice(0, 4) + Math.floor(Math.random() * 100);
    }
    
    const idea: TokenIdea = {
      name: parsed.name,
      ticker: parsed.ticker,
      description: parsed.description,
      mascot: parsed.mascot,
      theme,
      generatedAt: new Date().toISOString(),
      confidence: Math.min(1, Math.max(0.5, parsed.confidence || 0.7)),
    };
    
    logger.info(`[IdeaGenerator] ✨ Generated idea: $${idea.ticker} - ${idea.name} (confidence: ${idea.confidence})`);
    return idea;
    
  } catch (err) {
    logger.error('[IdeaGenerator] Error generating idea:', err);
    return getRandomFallback(config.avoidTickers);
  }
}

/**
 * Generate multiple ideas and pick the best one
 */
export async function generateBestIdea(
  config: IdeaGeneratorConfig = {},
  count: number = 3
): Promise<TokenIdea> {
  const ideas: TokenIdea[] = [];
  
  for (let i = 0; i < count; i++) {
    try {
      const idea = await generateIdea(config);
      ideas.push(idea);
      // Small delay between generations
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      logger.warn(`[IdeaGenerator] Failed to generate idea ${i + 1}/${count}`);
    }
  }
  
  if (ideas.length === 0) {
    return getRandomFallback(config.avoidTickers);
  }
  
  // Sort by confidence and return best
  ideas.sort((a, b) => b.confidence - a.confidence);
  const best = ideas[0];
  
  logger.info(`[IdeaGenerator] Selected best idea from ${ideas.length}: $${best.ticker} (confidence: ${best.confidence})`);
  return best;
}

/**
 * Get a random fallback idea
 */
function getRandomFallback(avoidTickers?: string[]): TokenIdea {
  const available = FALLBACK_IDEAS.filter(
    idea => !avoidTickers?.includes(idea.ticker)
  );
  
  if (available.length === 0) {
    // All fallbacks taken, generate random
    const suffix = Math.floor(Math.random() * 1000);
    return {
      name: `Nova Coin ${suffix}`,
      ticker: `NOVA${suffix}`,
      description: 'Another day, another token. Such is the way.',
      mascot: 'a pixelated robot with a question mark for a head',
      theme: 'meta',
      generatedAt: new Date().toISOString(),
      confidence: 0.4,
    };
  }
  
  const idea = { ...available[Math.floor(Math.random() * available.length)] };
  idea.generatedAt = new Date().toISOString();
  return idea;
}

/**
 * Validate an idea meets basic requirements
 */
export function validateIdea(idea: TokenIdea): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  if (!idea.name || idea.name.length < 2) {
    issues.push('Name too short');
  }
  if (idea.name.length > 50) {
    issues.push('Name too long (max 50 chars)');
  }
  
  if (!idea.ticker || idea.ticker.length < 2) {
    issues.push('Ticker too short (min 2 chars)');
  }
  if (idea.ticker.length > 6) {
    issues.push('Ticker too long (max 6 chars)');
  }
  if (!/^[A-Z]+$/.test(idea.ticker)) {
    issues.push('Ticker must be uppercase letters only');
  }
  
  if (!idea.description || idea.description.length < 10) {
    issues.push('Description too short');
  }
  if (idea.description.length > 500) {
    issues.push('Description too long (max 500 chars)');
  }
  
  return {
    valid: issues.length === 0,
    issues,
  };
}

export default {
  generateIdea,
  generateBestIdea,
  validateIdea,
};
