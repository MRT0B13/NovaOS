import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State, ModelType, logger } from '@elizaos/core';
import { z } from 'zod';
import { CopyGeneratorService } from '../services/copyGenerator.ts';
import { extractSocialLinks, TelegramSetupService } from '../services/telegramSetup.ts';
import { getLogoUrl, generateDiceBearLogo as generateDiceBearLogoService } from '../services/logoGenerator.ts';

/**
 * Find the most recent uploaded image for an agent
 * The web client uploads to ~/.eliza/data/uploads/agents/{agentId}/
 */
function findMostRecentUpload(agentId: string): string | undefined {
  try {
    const uploadsDir = join(homedir(), '.eliza', 'data', 'uploads', 'agents', agentId);
    const files = readdirSync(uploadsDir);
    
    // Filter for image files and sort by modification time (newest first)
    const imageFiles = files
      .filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f))
      .map(f => {
        const fullPath = join(uploadsDir, f);
        return { name: f, mtime: statSync(fullPath).mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);
    
    if (imageFiles.length > 0) {
      // Return as a URL that the server can serve
      const serverPort = process.env.SERVER_PORT || '3000';
      const serverHost = process.env.SERVER_HOST || 'localhost';
      const relativePath = `/media/uploads/agents/${agentId}/${imageFiles[0].name}`;
      const fullUrl = `http://${serverHost}:${serverPort}${relativePath}`;
      logger.info(`[GENERATE] Found recent upload: ${imageFiles[0].name} (${new Date(imageFiles[0].mtime).toISOString()})`);
      return fullUrl;
    }
  } catch (err) {
    // Directory doesn't exist or no permissions - that's fine
    logger.debug(`[GENERATE] No uploads found for agent ${agentId}`);
  }
  return undefined;
}

/**
 * DiceBear avatar styles for auto-generated token logos
 * Each style has unique visual characteristics suited for meme tokens
 * Users can create custom avatars at https://editor.dicebear.com/
 */
const DICEBEAR_STYLES = [
  // Fun & Playful
  { style: 'bottts-neutral', name: 'Cute Robots', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'fun-emoji', name: 'Fun Emoji', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'thumbs', name: 'Thumbs Up', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'lorelei', name: 'Illustrated Faces', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  
  // Character-based
  { style: 'adventurer-neutral', name: 'Adventurer', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'big-ears-neutral', name: 'Big Ears', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'avataaars-neutral', name: 'Cartoon Avatar', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'micah', name: 'Illustrated Portrait', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'notionists-neutral', name: 'Notion Style', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'open-peeps', name: 'Open Peeps', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'personas', name: 'Personas', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  
  // Artistic & Abstract
  { style: 'pixel-art-neutral', name: 'Pixel Art', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'croodles-neutral', name: 'Hand Drawn Doodles', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
  { style: 'shapes', name: 'Abstract Shapes', colors: '0a5cf5,ff6b6b,feca57,48dbfb,1dd1a1' },
  { style: 'rings', name: 'Ring Patterns', colors: '0a5cf5,ff6b6b,feca57,48dbfb,1dd1a1' },
  { style: 'glass', name: 'Glassmorphism', colors: '0a5cf5,ff6b6b,feca57,48dbfb,1dd1a1' },
  
  // Minimalist
  { style: 'initials', name: 'Letter Initials', colors: '0a5cf5,ff6b6b,feca57,48dbfb,1dd1a1,9b59b6' },
  { style: 'identicon', name: 'GitHub Style', colors: '' }, // identicon has its own colors
  { style: 'icons', name: 'Simple Icons', colors: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' },
];

/**
 * Generate a unique DiceBear avatar URL for a token
 * Picks a random style for variety
 */
function generateDiceBearLogo(tokenName: string, ticker?: string): { url: string; styleName: string } {
  const styleConfig = DICEBEAR_STYLES[Math.floor(Math.random() * DICEBEAR_STYLES.length)];
  const seed = `${tokenName}-${ticker || ''}-${Date.now()}`;
  
  let url = `https://api.dicebear.com/9.x/${styleConfig.style}/png?seed=${encodeURIComponent(seed)}&size=400`;
  
  if (styleConfig.colors) {
    url += `&backgroundColor=${styleConfig.colors}`;
  }
  
  return { url, styleName: styleConfig.name };
}

/**
 * Generate an engaging token description using the LLM
 */
async function generateTokenDescription(runtime: IAgentRuntime, name: string, ticker: string, context: string): Promise<string> {
  const prompt = `You are a crypto marketing expert. Generate a short, punchy, and engaging description for a new memecoin token launching on pump.fun.

Token Name: ${name}
Token Ticker: $${ticker}
User Context: ${context}

Requirements:
- MAXIMUM 140 characters (this is critical - must be under 140 chars)
- Make it catchy, fun, and memorable
- Include emojis to make it pop
- Convey the token's vibe/personality
- Don't use generic phrases like "go ahead" or "let's do it"
- Make it sound exciting and shareable
- Focus on community and meme potential

Examples of good descriptions:
- "🐕 The goodest doge on Solana! Join the pack and ride to the moon together! 🚀💎"
- "🔥 Born from chaos, built for legends. $YOLO gang takes no prisoners! 💪"
- "✨ When the rug pulls YOU. $RUG is the anti-rug revolution. LFG! 🛡️"

Respond with ONLY the description text, nothing else.`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    // Clean up and ensure it's under 140 chars
    const cleaned = String(response).trim().replace(/^["']|["']$/g, '').slice(0, 140);
    if (cleaned && cleaned.length > 10) {
      logger.info(`[GENERATE] Generated token description: ${cleaned}`);
      return cleaned;
    }
  } catch (err) {
    logger.warn('[GENERATE] Failed to generate token description via LLM:', err);
  }
  
  // Fallback to a dynamic default based on the token name
  const fallbacks = [
    `🚀 ${name} ($${ticker}) - The next big thing on Solana! Join the community! 💎`,
    `🔥 $${ticker} is here! Fair launch on pump.fun. No presale. Pure meme energy! 🎯`,
    `✨ ${name} to the moon! Community-owned, fairly launched. LFG! 🌙`,
    `💎 $${ticker} gang rise up! Born on pump.fun, destined for greatness! 🦍`,
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)].slice(0, 140);
}

const dataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  name: z.string().optional(),
  ticker: z.string().optional(),
  theme: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  tone: z.string().optional(),
});

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/;

function extractLaunchPackId(message: Memory): string | undefined {
  const data = (message.content?.data ?? {}) as any;
  if (typeof data.launchPackId === 'string' && UUID_RE.test(data.launchPackId)) return data.launchPackId;

  const text = String(message.content?.text ?? '');
  const match = text.match(UUID_RE);
  return match?.[0];
}

function deriveNameAndTicker(text: string, providedName?: string, providedTicker?: string): { name: string; ticker: string } {
  // If name/ticker explicitly provided, use them
  if (providedName && providedTicker) {
    return { name: providedName, ticker: providedTicker.toUpperCase().slice(0, 6) };
  }
  
  // Try to extract token name from natural language patterns
  const patterns = [
    // "called X", "named X", "token called X" - MUST match first
    /(?:called|named)\s+["']?([A-Za-z][A-Za-z0-9]*)["']?/i,
    // "create X token", "launch X coin", "a X token"
    /(?:create|launch|make|build|a)\s+(?:a\s+)?["']?([A-Za-z][A-Za-z0-9]*)["']?\s+(?:token|coin|meme)/i,
    // "token called X"
    /token\s+called\s+["']?([A-Za-z][A-Za-z0-9]*)["']?/i,
    // "$TICKER" or "ticker: TICKER"
    /\$([A-Za-z]{2,6})\b/i,
    /ticker[:\s]+["']?([A-Za-z]{2,6})["']?/i,
    // "X ($TICKER)" pattern
    /([A-Za-z][A-Za-z0-9]*)\s*\(\$?([A-Za-z]{2,6})\)/i,
    // Capitalized words that look like token names (e.g., "Moondog", "DogeCoin")
    /\b([A-Z][a-z]+(?:[A-Z][a-z]+)?)\b/,
  ];
  
  let extractedName = providedName;
  let extractedTicker = providedTicker;
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (pattern.source.includes('\\$') || pattern.source.includes('ticker')) {
        // Ticker pattern
        extractedTicker = extractedTicker || match[1];
      } else if (match[2]) {
        // Name + ticker pattern like "Moondog ($MOON)"
        extractedName = extractedName || match[1];
        extractedTicker = extractedTicker || match[2];
      } else {
        // Name pattern
        extractedName = extractedName || match[1];
      }
    }
    if (extractedName && extractedTicker) break;
  }
  
  // Generate ticker from name if not found
  if (extractedName && !extractedTicker) {
    // Take first letters of each word or first 4 chars
    const words = extractedName.split(/\s+/);
    if (words.length > 1) {
      extractedTicker = words.map(w => w[0]).join('').toUpperCase().slice(0, 4);
    } else {
      extractedTicker = extractedName.toUpperCase().slice(0, 4);
    }
  }
  
  // Fallback to old behavior if nothing found
  if (!extractedName) {
    const words = text
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !/^(the|and|for|but|not|you|all|can|her|was|one|our|out|are|has|have|had|been|this|that|with|they|from|will|would|could|should|about|which|their|there|these|those|other|into|over|just|only|also|back|after|first|most|well|very|even|much|some|such|like|make|want|need|help|create|launch|build|token|coin|meme|call|name|simple|something|cartoon|style|space|themed|happy|dog|take|off|logo|telegram|group|here|https|its)$/i.test(w));
    extractedName = (words.slice(0, 1).join(' ') || 'Auto Launch').trim();
    const base = (words.find((w) => w.length >= 3) || 'AUTO').toUpperCase();
    extractedTicker = base.slice(0, 4);
  }
  
  // Capitalize first letter of name
  const capitalizedName = extractedName.charAt(0).toUpperCase() + extractedName.slice(1).toLowerCase();
  
  return { 
    name: capitalizedName, 
    ticker: (extractedTicker || 'AUTO').toUpperCase().slice(0, 6) 
  };
}

/**
 * Extract token name and ticker from conversation context using LLM
 * This helps when the user mentioned the token in earlier messages
 */
async function extractTokenFromContext(runtime: IAgentRuntime, message: Memory): Promise<{ name?: string; ticker?: string }> {
  try {
    // Get recent messages for context
    const memories = await runtime.getMemories({
      roomId: message.roomId as any,
      tableName: 'messages',
      count: 20,
    });
    
    // Build conversation context
    const recentContext = memories
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(-10)
      .map(m => String(m.content?.text || ''))
      .filter(t => t.length > 0)
      .join('\n');
    
    if (!recentContext || recentContext.length < 10) {
      return {};
    }
    
    const prompt = `Extract the token/meme coin name and ticker from this conversation. The user is trying to create a token.

Conversation:
${recentContext}

Rules:
- Look for character names, meme references, or token names mentioned
- Common patterns: "called X", "named X", "for X", "X token", "$TICKER"
- If a character name is mentioned (like "Ferb", "Pepe", "Doge"), use that as the token name
- Generate a 3-4 letter ticker from the name if not explicitly given
- If nothing clear is found, respond with NONE

Respond in this exact format (no other text):
NAME: [token name]
TICKER: [ticker symbol]

Or if nothing found:
NONE`;

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const text = String(response).trim();
    
    if (text.includes('NONE') || !text.includes('NAME:')) {
      return {};
    }
    
    const nameMatch = text.match(/NAME:\s*(.+)/i);
    const tickerMatch = text.match(/TICKER:\s*\$?([A-Za-z]{2,6})/i);
    
    const name = nameMatch?.[1]?.trim();
    const ticker = tickerMatch?.[1]?.toUpperCase();
    
    if (name && name.length > 0 && name !== 'NONE') {
      logger.info(`[GENERATE] Extracted from context: ${name} ($${ticker || 'auto'})`);
      return { name, ticker };
    }
    
    return {};
  } catch (err) {
    logger.warn('[GENERATE] Failed to extract token from context:', err);
    return {};
  }
}

async function createLaunchPack(runtime: IAgentRuntime, message: Memory, providedName?: string, providedTicker?: string) {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  const store = kit?.store;
  if (!store) {
    const err = new Error('LaunchKit store unavailable');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  const text = String(message.content?.text ?? '');
  
  // ALWAYS check conversation context first for explicitly stated name/ticker
  // The user may have said "call it Ferb $FRB" earlier in the conversation
  let name: string | undefined;
  let ticker: string | undefined;
  
  if (providedName) {
    // Name was explicitly provided as parameter
    name = providedName;
    ticker = providedTicker || providedName.slice(0, 4).toUpperCase();
    logger.info(`[GENERATE] Using provided name: ${name} ($${ticker})`);
  } else {
    // Always try conversation context first - user may have stated the name earlier
    logger.info(`[GENERATE] Checking conversation context for token name...`);
    const contextResult = await extractTokenFromContext(runtime, message);
    
    if (contextResult.name) {
      name = contextResult.name;
      ticker = contextResult.ticker || name.slice(0, 4).toUpperCase();
      logger.info(`[GENERATE] Found name in context: ${name} ($${ticker})`);
    } else {
      // Fallback to deriving from current message
      const derived = deriveNameAndTicker(text);
      name = derived.name;
      ticker = derived.ticker;
      logger.info(`[GENERATE] No name in context, derived from message: ${name} ($${ticker})`);
    }
  }
  
  // Generate an engaging description using LLM instead of raw text
  const description = await generateTokenDescription(runtime, name, ticker, text);
  
  // Check for user-provided logo in multiple places:
  // 1. content.attachments (Telegram/Discord/web client)
  // 2. metadata.attachments (some clients use this)
  // 3. content.url (direct image URL in content)
  // 4. URL in message text (logo: https://example.com/image.png)
  // 5. Any image URL in text
  const contentAny = message.content as any;
  const metadataAny = (message as any).metadata;
  
  // Debug: log what we're receiving
  logger.info(`[GENERATE] Checking for attachments...`);
  logger.info(`[GENERATE]   content keys: ${Object.keys(contentAny || {}).join(', ')}`);
  logger.info(`[GENERATE]   content.attachments: ${JSON.stringify(contentAny?.attachments || 'none')}`);
  logger.info(`[GENERATE]   content.images: ${JSON.stringify(contentAny?.images || 'none')}`);
  logger.info(`[GENERATE]   content.files: ${JSON.stringify(contentAny?.files || 'none')}`);
  logger.info(`[GENERATE]   metadata: ${JSON.stringify(metadataAny || 'none')}`);
  logger.info(`[GENERATE]   content.url: ${contentAny?.url || 'none'}`);
  
  // Check multiple possible locations for attachments
  // Web client may use: content.attachments, content.images, content.files
  // Telegram uses: content.attachments with url field
  const possibleAttachments = [
    ...(contentAny?.attachments || []),
    ...(contentAny?.images || []),
    ...(contentAny?.files || []),
    ...(metadataAny?.attachments || []),
  ];
  
  // Also check if content itself has image properties (some clients embed directly)
  if (contentAny?.image) {
    possibleAttachments.push({ url: contentAny.image, contentType: 'image/png' });
  }
  if (contentAny?.imageUrl) {
    possibleAttachments.push({ url: contentAny.imageUrl, contentType: 'image/png' });
  }
  if (contentAny?.file?.url) {
    possibleAttachments.push(contentAny.file);
  }
  
  logger.info(`[GENERATE]   Found ${possibleAttachments.length} potential attachments`);
  
  const imageAttachment = possibleAttachments.find((a: any) => 
    a?.url && (
      a.contentType?.startsWith('image/') || 
      a.type?.startsWith('image/') ||
      a.mimeType?.startsWith('image/') ||
      a.title?.includes('Image') || 
      /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(a.url) ||
      a.url.includes('api.telegram.org/file') || // Telegram file URLs
      a.url.startsWith('data:image/') || // Base64 data URLs
      a.url.includes('/uploads/') || // Common upload path
      a.url.includes('blob:') // Blob URLs from file picker
    )
  );
  
  if (imageAttachment) {
    logger.info(`[GENERATE]   ✅ Found image attachment: ${JSON.stringify(imageAttachment).substring(0, 100)}...`);
  }
  
  // Check for direct url on content (some clients put image URL here)
  const contentUrl = contentAny?.url as string | undefined;
  const isContentUrlImage = contentUrl && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(contentUrl);
  
  // Also check for image URLs in the text
  const urlMatch = text.match(/logo[:\s]+([^\s]+\.(png|jpg|jpeg|gif|svg|webp))/i);
  const anyImageUrl = text.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|svg|webp))/i);
  
  // Priority: attachment > content.url > explicit logo URL > any image URL in text
  let userProvidedLogo = imageAttachment?.url || (isContentUrlImage ? contentUrl : undefined) || urlMatch?.[1] || anyImageUrl?.[1];
  
  // Web client workaround: when user shares file via web client, message is just "shared X file(s)."
  // but the file is uploaded to ~/.eliza/data/uploads/agents/{agentId}/ - check there
  if (!userProvidedLogo && /shared \d+ file/i.test(text)) {
    const agentId = runtime.agentId;
    const recentUpload = findMostRecentUpload(agentId);
    if (recentUpload) {
      userProvidedLogo = recentUpload;
      logger.info(`[GENERATE] Using recent web client upload: ${recentUpload}`);
    }
  }
  
  // Convert relative paths to full URLs (web client uploads to /media/uploads/...)
  if (userProvidedLogo && userProvidedLogo.startsWith('/')) {
    // Get the server base URL from environment or use default
    const serverPort = process.env.SERVER_PORT || '3000';
    const serverHost = process.env.SERVER_HOST || 'localhost';
    userProvidedLogo = `http://${serverHost}:${serverPort}${userProvidedLogo}`;
    logger.info(`[GENERATE] Converted relative path to full URL: ${userProvidedLogo}`);
  }
  
  if (userProvidedLogo) {
    logger.info(`[GENERATE] Using user-provided logo: ${userProvidedLogo.substring(0, 60)}...`);
  }
  
  // Auto-generate logo using AI (DALL-E) if available, otherwise DiceBear fallback
  let logoUrl = userProvidedLogo;
  let logoStyle: string | undefined;
  let logoSource: string = 'custom';
  
  if (!userProvidedLogo) {
    // Try AI-generated logo first (if OPENAI_API_KEY is set)
    try {
      logger.info(`[GENERATE] Generating AI logo for ${name} ($${ticker})...`);
      const logoResult = await getLogoUrl(name, ticker, {
        description: description,
        preferAI: true,
        style: 'meme',
      });
      logoUrl = logoResult.url;
      logoSource = logoResult.source;
      if (logoResult.source === 'dalle') {
        logger.info(`[GENERATE] ✨ AI-generated meme logo for ${name}`);
      } else {
        logoStyle = 'DiceBear';
        logger.info(`[GENERATE] Auto-generated DiceBear logo for ${name}`);
      }
    } catch (err: any) {
      // Fallback to local DiceBear function
      logger.warn(`[GENERATE] Logo generation failed, using fallback: ${err.message}`);
      const generated = generateDiceBearLogo(name, ticker);
      logoUrl = generated.url;
      logoStyle = generated.styleName;
      logoSource = 'dicebear';
    }
  }
  
  // Extract social links using improved detection
  const socialLinks = extractSocialLinks(text);
  const { website, x: xLink, telegram: telegramLink, telegramChatId } = socialLinks;
  
  // Also check for direct chat_id format
  const chatIdMatch = text.match(/(?:chat_?id)[:\s]+(-?\d{10,})/i);
  const chatId = telegramChatId || chatIdMatch?.[1];
  
  // Detect if telegram link is a private invite (t.me/+xxx or t.me/joinchat/xxx)
  const tgService = new TelegramSetupService();
  const parsedTg = telegramLink ? tgService.parseTelegramLink(telegramLink) : null;
  const isPrivateInvite = parsedTg?.type === 'private';
  
  const created = await store.create({
    brand: { name, ticker, description },
    assets: { logo_url: logoUrl },
    links: (website || xLink || telegramLink) ? {
      website: website,
      x: xLink,
      telegram: telegramLink,
    } : undefined,
    ops: { checklist: {}, audit_log: [] },
    tg: chatId 
      ? { chat_id: chatId, pins: { welcome: '', how_to_buy: '', memekit: '' }, schedule: [] } 
      : isPrivateInvite 
        ? { pending_verification: true, pins: { welcome: '', how_to_buy: '', memekit: '' }, schedule: [] }
        : undefined,
  });
  return { id: created.id as string, isPrivateInvite, telegramLink };
}

async function getMostRecentLaunchPack(runtime: IAgentRuntime, roomId: string): Promise<string | null> {
  try {
    // Look for recent memories containing LaunchPack IDs in this room
    const memories = await runtime.getMemories({
      roomId: roomId as any,
      tableName: 'messages',
      count: 100, // Check more messages
    });
    
    // Sort by createdAt timestamp (most recent first)
    const sortedMemories = memories.sort((a, b) => {
      const timeA = a.createdAt || 0;
      const timeB = b.createdAt || 0;
      return timeB - timeA; // Descending order (newest first)
    });
    
    // Search for LaunchPack IDs in agent response messages (most recent first)
    for (const memory of sortedMemories) {
      const data = memory.content?.data as any;
      const text = memory.content?.text || '';
      const userId = (memory as any).userId;
      const agentId = memory.agentId;
      
      // Only check agent messages (not user messages)
      if (userId && userId !== agentId) {
        continue; // Skip user messages
      }
      
      // Check if agent message contains a LaunchPack ID in data
      if (data?.launchPackId && UUID_RE.test(data.launchPackId)) {
        // Verify this is from a LaunchPack generation
        if (text.includes('LaunchPack') || text.includes('Created') || text.includes('ready')) {
          return data.launchPackId;
        }
      }
    }
  } catch (err) {
    // If memory lookup fails, return null
  }
  
  return null;
}

function getCopyService(runtime: IAgentRuntime): CopyGeneratorService {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  const copyService = kit?.copyService;
  if (!copyService) {
    const err = new Error('LaunchKit not initialized');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  return copyService as CopyGeneratorService;
}

export const generateLaunchPackCopyAction: Action = {
  name: 'GENERATE_LAUNCHPACK_COPY',
  similes: ['GENERATE_COPY', 'WRITE_LAUNCH_COPY', 'CREATE_TOKEN', 'LAUNCH_TOKEN', 'PREPARE_LAUNCH', 'SETUP_TOKEN'],
  description: 'Generate TG pins, schedules, and X posts for a LaunchPack - also auto-creates LaunchPack from token concept',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Exclude checklist/status queries - those should go to PRE_LAUNCH_CHECKLIST
    if (/\b(am i|are we|is it|can i|can we|should i|should we)\b.*(ready|prepared|good|set|able)\b.*(launch|go|start|deploy)/i.test(text)) {
      return false;
    }
    if (/\b(checklist|status|ready|readiness|prepared|check|verify|confirm)\b/i.test(text) && !/\b(generate|create|make|write)\b/i.test(text)) {
      return false;
    }
    
    // If LaunchPackId is present, always allow
    if (extractLaunchPackId(message)) {
      return true;
    }
    
    // STRICT validation: Require EXPLICIT launch intent
    // Must contain both a launch verb AND token noun in same sentence
    const launchVerbs = ['launch', 'create', 'make', 'build', 'deploy', 'mint', 'generate'];
    const tokenNouns = ['token', 'coin', 'meme', 'memecoin', 'shitcoin', 'crypto'];
    
    // Check for EXPLICIT launch patterns only
    const hasExplicitLaunch = launchVerbs.some(verb => 
      tokenNouns.some(noun => 
        new RegExp(`\\b${verb}\\s+(a|an|the|new)?\\s*${noun}\\b`, 'i').test(text) ||
        new RegExp(`\\b${noun}\\s+${verb}\\b`, 'i').test(text)
      )
    );
    
    // Marketing generation (only with LaunchPack context)
    const marketingKeywords = ['generate copy', 'generate pins', 'generate posts', 'create marketing'];
    const hasMarketingIntent = marketingKeywords.some(kw => text.includes(kw));
    
    // Reject casual conversation patterns that accidentally match
    const casualPhrases = [
      /^(ok|okay|yes|no|sure|thanks|test|send|question|wait|check)/i,
      /^(publish a|send a|try a|do a) test/i,
      /quick question/i,
      /^go\s*(ahead)?$/i,  // "go ahead", "go"
      /^(proceed|continue|yes please|do it|let'?s go|yep|yeah|yea|alright|fine)$/i,  // Affirmations
      /^(link|connect|linking)/i,  // Linking requests should NOT trigger generate
    ];
    if (casualPhrases.some(pattern => pattern.test(text.trim()))) {
      return false;
    }
    
    return hasExplicitLaunch || hasMarketingIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Remove REPLY from actions array to prevent duplicate messages
    if (responses?.[0]?.content?.actions) {
      const actions = responses[0].content.actions as string[];
      const replyIndex = actions.indexOf('REPLY');
      if (replyIndex !== -1) {
        actions.splice(replyIndex, 1);
        console.log('[GENERATE] Removed REPLY from actions to prevent duplicate message');
      }
    }

    const parsedData = dataSchema.parse(message.content?.data ?? {});
    
    const text = String(message.content?.text ?? '').toLowerCase();
    const isRegenerateRequest = /regenerate|redo|remake|refresh/i.test(text);
    
    // Check if this is a "generate copy" for existing pack (not new creation)
    const isGenerateCopyOnly = /generate\s*(copy|pins|posts|marketing)/i.test(text) && 
                               !/launch|create|make|build|deploy|mint|new token/i.test(text);
    
    let launchPackId: string | undefined;
    
    // For "generate copy" commands, ALWAYS look up from store first (ignore stale IDs from LLM)
    if (isGenerateCopyOnly) {
      console.log('[GENERATE] Generate copy request - looking up pack from store');
      const bootstrap = runtime.getService('launchkit_bootstrap') as any;
      const kit = bootstrap?.getLaunchKit?.();
      const store = kit?.store;
      if (store) {
        const packs = await store.list();
        console.log('[GENERATE] Store has', packs.length, 'packs');
        const recentPack = packs.find((p: any) => p.launch?.status !== 'launched') || packs[0];
        if (recentPack) {
          launchPackId = recentPack.id;
          console.log('[GENERATE] Using pack from store:', recentPack.brand?.name, '(', launchPackId, ')');
        }
      }
      
      if (!launchPackId) {
        // No pack found for "generate copy" - prompt user to create one first
        await callback({
          text: `⚠️ **No LaunchPack Found**\n\nI don't have a token to generate marketing copy for yet!\n\n` +
            `**First, create a token:**\n` +
            `• "Create a token called MoonDog"\n` +
            `• "Launch a new $DOGE clone"\n\n` +
            `Then say "generate copy" to create marketing materials.`,
          source: message.content?.source,
        });
        return {
          text: "No LaunchPack found - need to create one first",
          success: false,
        };
      }
    } else {
      // For other requests, extract from message
      launchPackId = extractLaunchPackId(message);
    }
    
    // If regenerating, look up most recent LaunchPack
    if (!launchPackId && isRegenerateRequest) {
      const roomId = message.roomId || message.agentId;
      launchPackId = (await getMostRecentLaunchPack(runtime, roomId)) || undefined;
      
      // Also try getting from store
      if (!launchPackId) {
        const bootstrap = runtime.getService('launchkit_bootstrap') as any;
        const kit = bootstrap?.getLaunchKit?.();
        const store = kit?.store;
        if (store) {
          const packs = await store.list();
          const recentPack = packs.find((p: any) => p.launch?.status !== 'launched') || packs[0];
          if (recentPack) {
            launchPackId = recentPack.id;
            console.log('[GENERATE] Found existing pack from store:', recentPack.brand?.name);
          }
        }
      }
      
      if (launchPackId) {
        await callback({
          text: `♻️ Regenerating marketing content...`,
          data: { launchPackId },
          source: message.content?.source,
        });
      }
    }
    
    // Create LaunchPack if it doesn't exist and not a regenerate/copy-only request
    let isNewLaunchPack = false;
    let privateInviteTgLink: string | undefined;
    if (!launchPackId) {
      const result = await createLaunchPack(runtime, message);
      launchPackId = result.id;
      isNewLaunchPack = true;
      
      // Track if user provided a private TG invite link
      if (result.isPrivateInvite && result.telegramLink) {
        privateInviteTgLink = result.telegramLink;
      }
    }

    const copyService = getCopyService(runtime);

    let updated;
    try {
      updated = await copyService.generateForLaunchPack(launchPackId, {
        theme: parsedData.theme,
        keywords: parsedData.keywords,
        tone: parsedData.tone,
      });
    } catch (error) {
      await callback({
        text: `❌ Error generating copy: ${error instanceof Error ? error.message : String(error)}`,
        source: message.content?.source,
      });
      return {
        text: 'Failed to generate LaunchPack copy',
        success: false,
        data: { launchPackId, error: String(error) },
      };
    }

    const pins = updated.tg?.pins ?? {};
    const tgScheduleCount = updated.tg?.schedule?.length ?? 0;
    const xThreadCount = updated.x?.thread?.length ?? 0;
    const xReplyCount = updated.x?.reply_bank?.length ?? 0;
    const xScheduleCount = updated.x?.schedule?.length ?? 0;

    // Build concise response - single message with all info
    const createdLine = isNewLaunchPack ? `✅ Created **${updated.brand.name}** ($${updated.brand.ticker})\n\n` : '';
    
    // Add TG setup guidance if user provided a private invite link
    let tgGuidance = '';
    if (privateInviteTgLink) {
      const tgService = new TelegramSetupService();
      const botUsername = await tgService.getBotUsername().catch(() => '@YourBot');
      tgGuidance = `\n\n📱 **Telegram Setup Required**\nYou provided a private invite link. To enable TG auto-posting:\n` +
        `1️⃣ Add ${botUsername} to your group as admin\n` +
        `2️⃣ Say **"verify telegram"** when done`;
    }
    
    // Check if mascot is already configured
    const hasMascot = updated.mascot?.name && updated.mascot?.personality;
    const mascotSection = hasMascot 
      ? `\n🎭 **Mascot:** ${updated.mascot.name} configured`
      : `\n\n🎭 **Mascot Setup (Optional)**\nWant your bot to roleplay as a character in your TG community?\nSay "set mascot" to configure a custom personality!`;
    
    // For new LaunchPacks, ask if token is already launched
    const alreadyLaunchedPrompt = isNewLaunchPack 
      ? `\n\n❓ **Is this token already on pump.fun?**\nIf yes, reply with: "already launched at [MINT_ADDRESS]"\nIf not, say "launch" when ready to deploy!`
      : `\n\nSay "am I ready to launch?" to check status, or "launch" when ready!`;
    
    const responseText = `${createdLine}📦 Marketing content generated:
• Telegram: 3 pins + ${tgScheduleCount} scheduled posts
• X/Twitter: Main post + ${xThreadCount}-part thread + ${xReplyCount} replies + ${xScheduleCount} scheduled

🎯 LaunchPack ID: \`${updated.id}\`${tgGuidance}${mascotSection}${alreadyLaunchedPrompt}`;

    await callback({
      text: responseText,
      data: {
        launchPackId: updated.id,
        brand: { name: updated.brand.name, ticker: updated.brand.ticker },
      },
      source: message.content?.source,
    });

    // Return minimal ActionResult - callback already sent the message
    return {
      text: `LaunchPack ${updated.id} ready`,
      success: true,
      data: { launchPackId: updated.id },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'generate launchpack copy for 00000000-0000-4000-8000-000000000000',
          data: {},
        },
      },
      {
        name: 'eliza',
        content: {
          text: 'LaunchPack copy generated',
          actions: ['GENERATE_LAUNCHPACK_COPY'],
        },
      },
    ],
  ],
};
