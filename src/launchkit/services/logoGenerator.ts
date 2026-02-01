import { logger } from '@elizaos/core';
import { getEnv } from '../env.ts';
import { randomUUID } from 'node:crypto';

/**
 * Logo Generator Service
 * 
 * Generates eye-catching meme token logos using AI (DALL-E 3)
 * Falls back to DiceBear if no OpenAI key or on failure
 * 
 * NOTE: Images are uploaded to IPFS for permanent storage
 */

export interface LogoGenerationResult {
  url: string;
  source: 'dalle' | 'dicebear' | 'custom';
  prompt?: string;
  localPath?: string;
}

/**
 * Detect image format from magic bytes
 */
function detectImageFormat(buffer: Buffer): { format: string; mime: string } | null {
  if (buffer.length < 4) return null;
  
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { format: 'png', mime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { format: 'jpeg', mime: 'image/jpeg' };
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { format: 'gif', mime: 'image/gif' };
  }
  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return { format: 'webp', mime: 'image/webp' };
  }
  
  return null;
}

/**
 * Upload an image to IPFS via Bonk's free service
 * Returns a permanent IPFS URL
 * NOTE: Only PNG, JPEG, and GIF are supported - WebP will be rejected
 */
async function uploadToIPFS(
  imageBuffer: Buffer,
  tokenName: string
): Promise<string | null> {
  try {
    logger.info('[LogoGenerator] Uploading image to IPFS...');
    
    // Detect actual image format from magic bytes
    const detected = detectImageFormat(imageBuffer);
    if (!detected) {
      throw new Error('Could not detect image format');
    }
    
    logger.info(`[LogoGenerator] Detected format: ${detected.format}`);
    
    // WebP is not supported by Bonk's IPFS - would need conversion
    if (detected.format === 'webp') {
      throw new Error('WebP format not supported - PNG, JPEG, or GIF required');
    }
    
    // Create form data with correct MIME type
    const form = new FormData();
    const blob = new Blob([imageBuffer], { type: detected.mime });
    const ext = detected.format === 'jpeg' ? 'jpg' : detected.format;
    form.append('image', new File([blob], `logo.${ext}`, { type: detected.mime }));
    
    // Upload to Bonk's IPFS service (free, no API key needed)
    const response = await fetch('https://nft-storage.letsbonk22.workers.dev/upload/img', {
      method: 'POST',
      body: form,
    });
    
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`IPFS upload failed (${response.status}): ${errText}`);
    }
    
    const ipfsUrl = await response.text();
    if (!ipfsUrl || !ipfsUrl.includes('ipfs')) {
      throw new Error('Invalid IPFS URL returned');
    }
    
    // Convert to faster dweb.link gateway (ipfs.io can be slow on first fetch)
    // ipfs.io/ipfs/CID -> CID.ipfs.dweb.link
    let fastUrl = ipfsUrl;
    const cidMatch = ipfsUrl.match(/ipfs\.io\/ipfs\/([a-zA-Z0-9]+)/);
    if (cidMatch) {
      fastUrl = `https://${cidMatch[1]}.ipfs.dweb.link`;
    }
    
    logger.info(`[LogoGenerator] ✅ Uploaded to IPFS: ${fastUrl}`);
    return fastUrl;
  } catch (error: any) {
    logger.warn(`[LogoGenerator] Failed to upload to IPFS: ${error.message}`);
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
    
    // Download the image and upload to IPFS for permanent storage
    // DALL-E URLs expire after ~2 hours
    const dalleResponse = await fetch(imageUrl);
    if (!dalleResponse.ok) {
      throw new Error('Failed to download DALL-E image');
    }
    const imageBuffer = Buffer.from(await dalleResponse.arrayBuffer());
    
    const ipfsUrl = await uploadToIPFS(imageBuffer, tokenName);
    
    if (ipfsUrl) {
      logger.info('[LogoGenerator] ✅ Logo saved to IPFS: ' + ipfsUrl);
      return {
        url: ipfsUrl,
        source: 'dalle',
        prompt: prompt,
      };
    }
    
    // Fall back to returning DALL-E URL if IPFS upload fails (will expire)
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
