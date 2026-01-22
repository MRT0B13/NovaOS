import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Meme Generator Service
 * 
 * Generates meme images for TG shilling using DALL-E 3
 * Auto-downloads to local storage since DALL-E URLs expire after ~2 hours
 */

// Copyrighted/trademarked names to filter out
const BLOCKED_TERMS = [
  // Disney/Pixar
  'ferb', 'phineas', 'mickey', 'disney', 'pixar', 'marvel', 'avengers',
  // Warner Bros / DC
  'batman', 'superman', 'looney', 'bugs bunny', 'tweety',
  // Nintendo
  'mario', 'luigi', 'pokemon', 'pikachu', 'zelda', 'link',
  // Other
  'spongebob', 'nickelodeon', 'simpsons', 'family guy', 'south park',
  'shrek', 'dreamworks', 'minions', 'hello kitty', 'sanrio',
  // Crypto scam-sounding terms
  'pump', 'rug', 'scam', 'ponzi', 'scheme', 'guaranteed', 'profit',
];

/**
 * Sanitize text for DALL-E to avoid content policy violations
 */
function sanitizeForDallE(text: string): string {
  if (!text) return '';
  
  let sanitized = text.toLowerCase();
  
  // Remove blocked terms
  for (const term of BLOCKED_TERMS) {
    const regex = new RegExp(term, 'gi');
    sanitized = sanitized.replace(regex, '');
  }
  
  // Clean up extra spaces
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  
  // If nothing left, return empty
  if (sanitized.length < 3) return '';
  
  return sanitized;
}

export interface MemeGenerationResult {
  url: string;
  prompt: string;
  success: boolean;
  error?: string;
  localPath?: string;
}

/**
 * Download an image from URL and save it locally
 * Returns the local URL that can be served by the web server
 */
async function downloadAndStoreMeme(
  imageUrl: string,
  ticker: string
): Promise<string | null> {
  try {
    logger.info('[MemeGen] Downloading meme to local storage...');
    
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Determine storage path
    const baseDir = join(homedir(), '.eliza', 'data', 'uploads', 'memes');
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    
    // Generate filename with timestamp
    const timestamp = Date.now();
    const filename = `${ticker.toLowerCase()}-${timestamp}-${randomUUID().slice(0, 6)}.png`;
    const filePath = join(baseDir, filename);
    
    // Save the file
    writeFileSync(filePath, buffer);
    logger.info(`[MemeGen] ✅ Saved meme to ${filePath}`);
    
    // Return URL that can be served by the web server
    const serverPort = process.env.SERVER_PORT || '3000';
    const serverHost = process.env.SERVER_HOST || 'localhost';
    const localUrl = `http://${serverHost}:${serverPort}/media/uploads/memes/${filename}`;
    
    return localUrl;
  } catch (error: any) {
    logger.warn(`[MemeGen] Failed to download meme: ${error.message}`);
    return null;
  }
}

/**
 * Generate a meme image for TG marketing
 */
export async function generateMeme(
  tokenName: string,
  ticker: string,
  postType: string,
  description?: string,
  mascot?: string
): Promise<MemeGenerationResult | null> {
  const env = getEnv();
  
  // Check if meme generation is enabled
  if (env.AI_MEME_ENABLE !== 'true') {
    return null; // Memes disabled
  }
  
  const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('[MemeGen] No OPENAI_API_KEY, skipping meme generation');
    return null;
  }
  
  try {
    const prompt = buildMemePrompt(tokenName, ticker, postType, description, mascot);
    
    logger.info(`[MemeGen] Generating meme for $${ticker} (${postType})...`);
    
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'url',
      }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      logger.warn('[MemeGen] DALL-E API error:', error);
      return { url: '', prompt, success: false, error: error.error?.message };
    }
    
    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    
    if (!imageUrl) {
      return { url: '', prompt, success: false, error: 'No image URL returned' };
    }
    
    logger.info(`[MemeGen] ✅ Generated meme for $${ticker}`);
    
    // Download and store locally since DALL-E URLs expire after ~2 hours
    const localUrl = await downloadAndStoreMeme(imageUrl, ticker);
    
    if (localUrl) {
      logger.info(`[MemeGen] ✅ Meme saved permanently: ${localUrl}`);
      return {
        url: localUrl,
        prompt,
        success: true,
        localPath: localUrl,
      };
    }
    
    // Fall back to DALL-E URL if download fails (will expire)
    logger.warn('[MemeGen] Using temporary DALL-E URL (expires in ~2 hours)');
    return {
      url: imageUrl,
      prompt,
      success: true,
    };
    
  } catch (error: any) {
    logger.warn(`[MemeGen] Failed to generate meme: ${error.message}`);
    return { url: '', prompt: '', success: false, error: error.message };
  }
}

/**
 * Build a meme prompt based on post type
 */
function buildMemePrompt(
  tokenName: string,
  ticker: string,
  postType: string,
  description?: string,
  mascot?: string
): string {
  // Sanitize inputs to avoid DALL-E content policy violations
  // Remove copyrighted character names and potentially problematic terms
  const sanitizedMascot = sanitizeForDallE(mascot || '');
  const mascotDesc = sanitizedMascot || 'a friendly cartoon animal character';
  const baseStyle = 'Colorful meme-style cartoon image, funny, positive vibes, no text or words in the image.';
  
  const typePrompts: Record<string, string> = {
    gm_post: `${mascotDesc} waking up happy, stretching, sunrise in background, morning coffee vibes. ${baseStyle}`,
    
    chart_update: `${mascotDesc} looking at a chart going up, excited expression, green candles, moon in background. ${baseStyle}`,
    
    community_hype: `${mascotDesc} celebrating with confetti, party hat, super excited, jumping for joy. ${baseStyle}`,
    
    meme_drop: `${mascotDesc} doing something silly and funny, absurd humor, meme worthy pose. ${baseStyle}`,
    
    alpha_tease: `${mascotDesc} with a mysterious expression, wearing sunglasses, looking cool and secretive. ${baseStyle}`,
    
    holder_appreciation: `${mascotDesc} hugging diamonds, grateful expression, hearts around, wholesome vibes. ${baseStyle}`,
    
    question: `${mascotDesc} with a thinking pose, question marks around, curious expression. ${baseStyle}`,
    
    milestone: `${mascotDesc} on a rocket ship, celebration, fireworks, champagne, epic achievement vibes. ${baseStyle}`,
  };
  
  // Get specific prompt or use default
  let prompt = typePrompts[postType] || typePrompts['community_hype'];
  
  // Add token context only if it's safe (no copyrighted content)
  const sanitizedName = sanitizeForDallE(tokenName);
  const sanitizedDesc = sanitizeForDallE(description || '');
  
  if (sanitizedDesc && sanitizedDesc.length > 10 && sanitizedName) {
    prompt = `A cute original cartoon character inspired by "${sanitizedName}" theme. ${prompt}`;
  }
  
  // Ensure no text is generated in the image
  prompt += ' IMPORTANT: No text, no words, no letters, no numbers in the image. Original character design only.';
  
  return prompt;
}

/**
 * Check if meme generation is enabled and available
 */
export function isMemeGenerationAvailable(): boolean {
  const env = getEnv();
  return env.AI_MEME_ENABLE === 'true' && !!(env.OPENAI_API_KEY || process.env.OPENAI_API_KEY);
}

export default {
  generateMeme,
  isMemeGenerationAvailable,
};
