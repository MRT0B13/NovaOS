import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Logo Generator Service
 * 
 * Generates eye-catching meme token logos using AI (DALL-E 3)
 * Falls back to DiceBear if no OpenAI key or on failure
 * 
 * NOTE: DALL-E URLs expire after ~2 hours, so we auto-download
 * and store them locally for permanent access.
 */

export interface LogoGenerationResult {
  url: string;
  source: 'dalle' | 'dicebear' | 'custom';
  prompt?: string;
  localPath?: string;
}

/**
 * Download an image from URL and save it locally
 * Returns the local URL that can be served by the web server
 */
async function downloadAndStoreImage(
  imageUrl: string,
  tokenName: string,
  agentId?: string
): Promise<string | null> {
  try {
    logger.info('[LogoGenerator] Downloading DALL-E image to local storage...');
    
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Determine storage path
    const baseDir = join(homedir(), '.eliza', 'data', 'uploads', 'logos');
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    
    // Generate filename
    const sanitizedName = tokenName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filename = `${sanitizedName}-${randomUUID().slice(0, 8)}.png`;
    const filePath = join(baseDir, filename);
    
    // Save the file
    writeFileSync(filePath, buffer);
    logger.info(`[LogoGenerator] ✅ Saved logo to ${filePath}`);
    
    // Return URL that can be served by the web server
    const serverPort = process.env.SERVER_PORT || '3000';
    const serverHost = process.env.SERVER_HOST || 'localhost';
    const localUrl = `http://${serverHost}:${serverPort}/media/uploads/logos/${filename}`;
    
    return localUrl;
  } catch (error: any) {
    logger.warn(`[LogoGenerator] Failed to download image: ${error.message}`);
    return null;
  }
}

/**
 * Generate a meme-style token logo using DALL-E 3
 */
export async function generateMemeLogo(
  tokenName: string,
  ticker: string,
  description?: string,
  style?: 'cartoon' | 'pixel' | '3d' | 'flat' | 'meme'
): Promise<LogoGenerationResult> {
  const env = getEnv();
  
  // Check if AI logos are enabled
  if (env.AI_LOGO_ENABLE !== 'true') {
    logger.info('[LogoGenerator] AI logos disabled, using DiceBear');
    return generateDiceBearLogo(tokenName, ticker);
  }
  
  // Check if OpenAI API key is available
  const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('[LogoGenerator] No OPENAI_API_KEY, falling back to DiceBear');
    return generateDiceBearLogo(tokenName, ticker);
  }
  
  try {
    const logoStyle = style || 'meme';
    const prompt = buildLogoPrompt(tokenName, ticker, description, logoStyle);
    
    logger.info('[LogoGenerator] Generating logo with DALL-E 3...');
    logger.info('[LogoGenerator] Prompt: ' + prompt.substring(0, 100) + '...');
    
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
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
      logger.warn('[LogoGenerator] DALL-E API error: ' + JSON.stringify(error));
      throw new Error(error.error?.message || 'DALL-E API error');
    }
    
    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    
    if (!imageUrl) {
      throw new Error('No image URL in DALL-E response');
    }
    
    logger.info('[LogoGenerator] ✅ Generated logo with DALL-E 3');
    
    // Download and store locally since DALL-E URLs expire after ~2 hours
    const localUrl = await downloadAndStoreImage(imageUrl, tokenName);
    
    if (localUrl) {
      logger.info('[LogoGenerator] ✅ Logo saved permanently: ' + localUrl);
      return {
        url: localUrl,
        source: 'dalle',
        prompt: prompt,
        localPath: localUrl,
      };
    }
    
    // Fall back to returning DALL-E URL if download fails (will expire)
    logger.warn('[LogoGenerator] Using temporary DALL-E URL (expires in ~2 hours)');
    return {
      url: imageUrl,
      source: 'dalle',
      prompt: prompt,
    };
    
  } catch (error: any) {
    logger.warn('[LogoGenerator] DALL-E generation failed: ' + error.message);
    logger.info('[LogoGenerator] Falling back to DiceBear');
    return generateDiceBearLogo(tokenName, ticker);
  }
}

/**
 * Build a prompt for meme token logo generation
 */
function buildLogoPrompt(
  tokenName: string,
  ticker: string,
  description?: string,
  style: string = 'meme'
): string {
  const styleGuides: Record<string, string> = {
    meme: 'viral meme style, bold colors, funny and eye-catching, internet culture aesthetic, perfect for a crypto token',
    cartoon: 'cartoon character style, vibrant colors, friendly and appealing, mascot-like design',
    pixel: '8-bit pixel art style, retro gaming aesthetic, bright colors, nostalgic feel',
    '3d': '3D rendered character, glossy and polished, modern CGI style, professional quality',
    flat: 'flat design illustration, minimal and clean, modern vector art style, bold shapes',
  };
  
  const styleGuide = styleGuides[style] || styleGuides.meme;
  
  // Build context from description
  let context = '';
  if (description) {
    // Extract key themes from description
    const themes = description.toLowerCase();
    if (themes.includes('dog') || themes.includes('doge')) context = 'featuring a cute dog character, ';
    else if (themes.includes('cat')) context = 'featuring a cute cat character, ';
    else if (themes.includes('frog') || themes.includes('pepe')) context = 'featuring a frog character, ';
    else if (themes.includes('ai') || themes.includes('robot')) context = 'featuring a robot or AI character, ';
    else if (themes.includes('moon')) context = 'with moon and space themes, ';
    else if (themes.includes('bull')) context = 'featuring a bull character, ';
    else if (themes.includes('bear')) context = 'featuring a bear character, ';
    else if (themes.includes('ape') || themes.includes('monkey')) context = 'featuring an ape character, ';
  }
  
  return `Create a logo for a cryptocurrency meme token called "${tokenName}" ($${ticker}). ` +
    `${context}` +
    `Style: ${styleGuide}. ` +
    `The logo should be a single iconic image suitable for a token profile picture. ` +
    `No text or letters in the image. ` +
    `Centered composition, simple background, highly memorable and shareable. ` +
    `Think viral meme coin aesthetic like Dogecoin, Pepe, or Shiba Inu.`;
}

/**
 * Generate a DiceBear avatar as fallback
 */
export function generateDiceBearLogo(
  tokenName: string,
  ticker: string
): LogoGenerationResult {
  const seed = tokenName + '-' + ticker + '-' + Date.now();
  
  // Use a more interesting DiceBear style
  const styles = ['bottts', 'fun-emoji', 'lorelei', 'notionists', 'thumbs'];
  const randomStyle = styles[Math.floor(Math.random() * styles.length)];
  
  const url = `https://api.dicebear.com/9.x/${randomStyle}/png?seed=${encodeURIComponent(seed)}&size=400&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;
  
  logger.info('[LogoGenerator] Generated DiceBear logo: ' + randomStyle);
  
  return {
    url,
    source: 'dicebear',
  };
}

/**
 * Validate a custom logo URL
 */
export async function validateCustomLogo(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    
    if (!response.ok) {
      logger.warn('[LogoGenerator] Custom logo URL returned ' + response.status);
      return false;
    }
    
    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      logger.warn('[LogoGenerator] Custom logo URL is not an image: ' + contentType);
      return false;
    }
    
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 8 * 1024 * 1024) {
      logger.warn('[LogoGenerator] Custom logo too large: ' + contentLength + ' bytes');
      return false;
    }
    
    return true;
  } catch (error: any) {
    logger.warn('[LogoGenerator] Failed to validate custom logo: ' + error.message);
    return false;
  }
}

/**
 * Get a logo URL - either custom, AI-generated, or fallback
 */
export async function getLogoUrl(
  tokenName: string,
  ticker: string,
  options?: {
    customUrl?: string;
    description?: string;
    style?: 'cartoon' | 'pixel' | '3d' | 'flat' | 'meme';
    preferAI?: boolean;
  }
): Promise<LogoGenerationResult> {
  // If custom URL provided, validate and use it
  if (options?.customUrl) {
    const isValid = await validateCustomLogo(options.customUrl);
    if (isValid) {
      logger.info('[LogoGenerator] Using custom logo URL');
      return {
        url: options.customUrl,
        source: 'custom',
      };
    }
    logger.warn('[LogoGenerator] Custom URL invalid, generating new logo');
  }
  
  // Check if we should try AI generation
  const useAI = options?.preferAI !== false && !!process.env.OPENAI_API_KEY;
  
  if (useAI) {
    return generateMemeLogo(tokenName, ticker, options?.description, options?.style);
  }
  
  // Fallback to DiceBear
  return generateDiceBearLogo(tokenName, ticker);
}
