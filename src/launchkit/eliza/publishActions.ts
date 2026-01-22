import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { z } from 'zod';
import { PumpLauncherService } from '../services/pumpLauncher.ts';
import { extractSocialLinks, TelegramSetupService } from '../services/telegramSetup.ts';
import { getPumpWalletBalance, getFundingWalletBalance, depositToPumpWallet } from '../services/fundingWallet.ts';
import { TelegramPublisherService } from '../services/telegramPublisher.ts';
import { TelegramCommunityService } from '../services/telegramCommunity.ts';
import { XPublisherService } from '../services/xPublisher.ts';
import { getEnv } from '../env.ts';
import { getQuota, getPostingAdvice, getUsageSummary } from '../services/xRateLimiter.ts';

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
      console.log(`[PUBLISH] Found recent upload: ${imageFiles[0].name} (${new Date(imageFiles[0].mtime).toISOString()})`);
      return fullUrl;
    }
  } catch (err) {
    // Directory doesn't exist or no permissions - that's fine
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

const launchDataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  force: z.boolean().optional(),
});

const publishDataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  force: z.boolean().optional(),
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

/**
 * Find LaunchPack ID from conversation context (recent messages in room)
 * Falls back to most recent unlaunched pack in database
 */
async function findLaunchPackFromContext(runtime: IAgentRuntime, message: Memory, store: any): Promise<string | null> {
  // 1. Check message content/data first
  let id = extractLaunchPackId(message);
  if (id) return id;
  
  // 2. Search conversation memory for recently mentioned LaunchPack
  try {
    const memories = await runtime.getMemories({
      roomId: message.roomId as any,
      tableName: 'messages',
      count: 50,
    });
    
    const sorted = memories.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    for (const mem of sorted) {
      const data = mem.content?.data as any;
      if (data?.launchPackId && UUID_RE.test(data.launchPackId)) {
        // Verify it exists in store
        const exists = await store?.get(data.launchPackId);
        if (exists) return data.launchPackId;
      }
      // Check text for UUID
      const textMatch = String(mem.content?.text ?? '').match(UUID_RE);
      if (textMatch?.[0]) {
        const exists = await store?.get(textMatch[0]);
        if (exists) return textMatch[0];
      }
    }
  } catch {
    // Memory lookup failed
  }
  
  // 3. Fall back to most recent unlaunched pack
  if (store) {
    const packs = await store.list();
    const notLaunched = packs.filter((p: any) => p.launch?.status !== 'launched');
    if (notLaunched.length > 0) {
      const sorted = notLaunched.sort((a: any, b: any) => 
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
      return sorted[0].id;
    }
  }
  
  return null;
}

/**
 * Find LaunchPack linked to room OR any pack with telegram_chat_id configured
 * Used for PUBLISH_TELEGRAM to find the right pack to send messages to
 */
async function findTelegramLinkedPack(runtime: IAgentRuntime, message: Memory, store: any): Promise<string | null> {
  if (!store) return null;
  
  const roomId = String(message.roomId);
  const packs = await store.list();
  
  // 1. Check if any pack is linked to this room by chat_id
  const linkedByRoom = packs.find((p: any) => p.tg?.chat_id === roomId);
  if (linkedByRoom) {
    console.log(`[PUBLISH_TELEGRAM] Found pack linked by roomId: ${linkedByRoom.brand?.name}`);
    return linkedByRoom.id;
  }
  
  // 2. Find a pack with telegram_chat_id configured (has TG group linked)
  const withTelegram = packs.filter((p: any) => p.tg?.telegram_chat_id);
  if (withTelegram.length > 0) {
    // Prefer launched packs, then most recent
    const sorted = withTelegram.sort((a: any, b: any) => {
      // Launched first
      if (a.launch?.status === 'launched' && b.launch?.status !== 'launched') return -1;
      if (b.launch?.status === 'launched' && a.launch?.status !== 'launched') return 1;
      // Then by date
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
    console.log(`[PUBLISH_TELEGRAM] Found pack with telegram_chat_id: ${sorted[0].brand?.name}`);
    return sorted[0].id;
  }
  
  return null;
}

function deriveNameAndTicker(text: string): { name: string; ticker: string } {
  const words = text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const name = (words.slice(0, 3).join(' ') || 'Auto Launch').trim();
  const base = (words.find((w) => w.length >= 3) || 'AUTO').toUpperCase();
  const ticker = (base + randomUUID().replace(/-/g, '')).slice(0, 4).toUpperCase();
  return { name, ticker };
}

async function createLaunchPack(runtime: IAgentRuntime, message: Memory) {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  const store = kit?.store;
  if (!store) {
    const err = new Error('LaunchKit store unavailable');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  const text = String(message.content?.text ?? '');
  const { name, ticker } = deriveNameAndTicker(text);
  
  // Check for user-provided logo in multiple places:
  // 1. content.attachments (Telegram/Discord/web client)
  // 2. metadata.attachments (some clients use this)
  // 3. content.url (direct image URL in content)
  // 4. URL in message text (logo: https://example.com/image.png)
  // 5. Any image URL in text
  const contentAny = message.content as any;
  const metadataAny = (message as any).metadata;
  
  // Check multiple possible locations for attachments
  // Web client may use: content.attachments, content.images, content.files
  // Telegram uses: content.attachments with url field
  const possibleAttachments = [
    ...(contentAny?.attachments || []),
    ...(contentAny?.images || []),
    ...(contentAny?.files || []),
    ...(metadataAny?.attachments || []),
  ];
  
  // Also check if content itself has image properties
  if (contentAny?.image) {
    possibleAttachments.push({ url: contentAny.image, contentType: 'image/png' });
  }
  if (contentAny?.imageUrl) {
    possibleAttachments.push({ url: contentAny.imageUrl, contentType: 'image/png' });
  }
  if (contentAny?.file?.url) {
    possibleAttachments.push(contentAny.file);
  }
  
  console.log(`[PUBLISH] Found ${possibleAttachments.length} potential attachments`);
  
  const imageAttachment = possibleAttachments.find((a: any) => 
    a?.url && (
      a.contentType?.startsWith('image/') || 
      a.type?.startsWith('image/') ||
      a.mimeType?.startsWith('image/') ||
      a.title?.includes('Image') || 
      /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(a.url) ||
      a.url.includes('api.telegram.org/file') ||
      a.url.startsWith('data:image/') ||
      a.url.includes('/uploads/') ||
      a.url.includes('blob:')
    )
  );
  
  if (imageAttachment) {
    console.log(`[PUBLISH] ✅ Found image: ${imageAttachment.url?.substring(0, 60)}...`);
  }
  
  // Check for direct url on content (some clients put image URL here)
  const contentUrl = contentAny?.url as string | undefined;
  const isContentUrlImage = contentUrl && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(contentUrl);
  
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
      console.log(`[PUBLISH] Using recent web client upload: ${recentUpload}`);
    }
  }
  
  // Convert relative paths to full URLs (web client uploads to /media/uploads/...)
  if (userProvidedLogo && userProvidedLogo.startsWith('/')) {
    const serverPort = process.env.SERVER_PORT || '3000';
    const serverHost = process.env.SERVER_HOST || 'localhost';
    userProvidedLogo = `http://${serverHost}:${serverPort}${userProvidedLogo}`;
    console.log(`[PUBLISH] Converted relative path to full URL: ${userProvidedLogo}`);
  }
  
  if (userProvidedLogo) {
    console.log(`[PUBLISH] Using user-provided logo: ${userProvidedLogo.substring(0, 60)}...`);
  }
  
  // Auto-generate logo using DiceBear with random style if user didn't provide one
  // Users can customize their own at https://editor.dicebear.com/
  let logoUrl = userProvidedLogo;
  
  if (!userProvidedLogo) {
    const generated = generateDiceBearLogo(name, ticker);
    logoUrl = generated.url;
    console.log(`[PUBLISH] Auto-generated ${generated.styleName} logo for ${name}`);
  }
  
  // Extract social links using improved detection
  const socialLinks = extractSocialLinks(text);
  const { website, x: xLink, telegram: telegramLink, telegramChatId } = socialLinks;
  
  // Also check for direct chat_id format
  const chatIdMatch = text.match(/(?:chat_?id)[:\s]+(-?\d{10,})/i);
  const chatId = telegramChatId || chatIdMatch?.[1];
  
  const created = await store.create({
    brand: { name, ticker, description: text.slice(0, 140) },
    assets: { logo_url: logoUrl },
    links: (website || xLink || telegramLink) ? {
      website: website,
      x: xLink,
      telegram: telegramLink,
    } : undefined,
    ops: { checklist: {}, audit_log: [] },
    tg: chatId ? { chat_id: chatId, pins: { welcome: '', how_to_buy: '', memekit: '' }, schedule: [] } : undefined,
  });
  return created.id as string;
}

function requireLaunchKit(runtime: IAgentRuntime): any {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  if (!kit) {
    const err = new Error('LaunchKit not initialized');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  return kit;
}

function requireService<T>(svc: T | undefined, code: string, message: string): T {
  if (!svc) {
    const err = new Error(message);
    (err as any).code = code;
    throw err;
  }
  return svc;
}

export const launchLaunchPackAction: Action = {
  name: 'LAUNCH_LAUNCHPACK',
  similes: ['LAUNCH', 'LAUNCH_TOKEN', 'DEPLOY_TOKEN', 'GO_LIVE', 'EXECUTE_LAUNCH'],
  description: 'Launch a token for a LaunchPack using pump.fun',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Execution keywords - user is ready to GO (more flexible matching)
    const executionKeywords = [
      'launch', 'deploy', 'go live', 'send it', 'execute', 'do it', 
      'let\'s go', 'ship it', 'release it', 'publish', 'drop it', 
      'make it happen', 'i\'m ready', 'ready', 'confirmed', 
      'yes', 'proceed', 'go ahead', 'yea', 'yeah'
    ];
    
    // Check if message contains "deploy" or "launch" in any form
    const hasDeployIntent = /\b(deploy|launch|go live|execute|ready|yes|yea|yeah)\b/.test(text);
    
    // Also check for UUID (means they have a prepared LaunchPack)
    const hasLaunchPack = Boolean(extractLaunchPackId(message));
    
    try {
      launchDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    
    // Trigger if they say deploy/launch/ready OR have UUID
    return hasLaunchPack || hasDeployIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = launchDataSchema.parse(message.content?.data ?? {});
    const text = String(message.content?.text ?? '').toLowerCase();
    const skipTgCheck = parsed.force || /skip|anyway|proceed|force|no tg|no telegram/.test(text);
    
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    
    // Find LaunchPack from conversation context - DON'T create a new one
    let launchPackId = await findLaunchPackFromContext(runtime, message, store);
    
    if (!launchPackId) {
      return {
        text: '❌ No LaunchPack found to launch! Create one first by saying something like "create a token called MoonDog"',
        success: false,
      };
    }
    
    // Get the LaunchPack to check setup status
    const pack = await store?.get(launchPackId);
    
    // Pre-launch check: Ask about Telegram if not configured
    if (pack && !skipTgCheck) {
      const hasTelegramLink = Boolean(pack.links?.telegram);
      const hasTelegramGroup = Boolean(pack.tg?.chat_id);
      const telegramVerified = Boolean(pack.tg?.verified);
      
      // If no TG at all, prompt user
      if (!hasTelegramLink && !hasTelegramGroup) {
        const tgService = new TelegramSetupService();
        let botUsername = '[YourBot]';
        try {
          botUsername = await tgService.getBotUsername();
        } catch {}
        
        await callback({
          text: `📱 **Quick question before launch!**\n\n` +
                `Do you have a Telegram group for your community?\n\n` +
                `**If yes:**\n` +
                `1. Share your t.me link (e.g., "telegram: t.me/yourgroup")\n` +
                `2. Add ${botUsername} to your group and make it admin\n` +
                `3. Say "verify telegram" to confirm\n\n` +
                `**If no:**\n` +
                `Say "launch anyway" or "skip telegram" to proceed without it.\n\n` +
                `💡 Having a Telegram group helps build community and is shown on pump.fun!`,
          data: { launchPackId, promptingForTelegram: true },
          source: message.content?.source,
        });
        
        return {
          text: 'Awaiting Telegram setup or skip confirmation',
          success: true,
          data: { launchPackId, awaitingTelegramSetup: true },
        };
      }
      
      // If TG link provided but not verified, offer to verify first
      if (hasTelegramLink && !telegramVerified && !hasTelegramGroup) {
        const tgService = new TelegramSetupService();
        
        // Try to verify automatically
        const parsed = tgService.parseTelegramLink(pack.links.telegram);
        if (parsed?.type === 'public') {
          const result = await tgService.verifyBotInGroup(parsed.value);
          
          if (!result.success) {
            let botUsername = '[YourBot]';
            try {
              botUsername = await tgService.getBotUsername();
            } catch {}
            
            await callback({
              text: `⚠️ **Telegram Setup Incomplete**\n\n` +
                    `I see you have a Telegram link (${pack.links.telegram}) but I'm not in that group yet.\n\n` +
                    `**To enable community features:**\n` +
                    `1. Add ${botUsername} to your Telegram group\n` +
                    `2. Make ${botUsername} an admin\n` +
                    `3. Say "verify telegram"\n\n` +
                    `Or say "launch anyway" to proceed without Telegram features.`,
              data: { launchPackId, telegramNotVerified: true },
              source: message.content?.source,
            });
            
            return {
              text: 'Telegram not verified - awaiting setup or skip',
              success: true,
              data: { launchPackId, awaitingTelegramVerification: true },
            };
          } else {
            // Auto-update with verified info
            await store.update(launchPackId, {
              tg: {
                ...(pack.tg || {}),
                chat_id: result.chatId,
                verified: true,
                verified_at: new Date().toISOString(),
                chat_title: result.chatTitle,
              },
            });
            
            await callback({
              text: `✅ Telegram verified: ${result.chatTitle}\n\nProceeding with launch...`,
              data: { launchPackId, telegramVerified: true, chatId: result.chatId },
              source: message.content?.source,
            });
          }
        }
      }
    }
    
    const pumpService = requireService<PumpLauncherService>(kit.pumpService, 'PUMP_SERVICE_UNAVAILABLE', 'Pump service unavailable');

    // === PRE-LAUNCH WALLET CHECK ===
    // Check wallet balance BEFORE attempting launch
    const REQUIRED_SOL = 0.35; // Min required for launch (devBuy + fees)
    
    // Only auto-deposit if user explicitly says "deposit X sol AND launch" or "deposit X sol THEN launch"
    // This prevents conflict when DEPOSIT_TO_PUMP_WALLET action also runs
    const depositMatch = text.match(/deposit\s+(\d+\.?\d*)\s*sol\s+(?:and|then|&)\s*(?:launch|deploy|go)/i);
    const requestedDeposit = depositMatch ? parseFloat(depositMatch[1]) : null;
    
    try {
      let pumpBalance = await getPumpWalletBalance();
      const fundingWallet = await getFundingWalletBalance();
      
      console.log(`[LAUNCH] Pump wallet: ${pumpBalance.toFixed(4)} SOL, Funding wallet: ${fundingWallet.balance.toFixed(4)} SOL`);
      
      // Format amount consistently (2 decimal places minimum)
      const formatAmount = (n: number) => n.toFixed(Math.max(2, (n.toString().split('.')[1] || '').length));
      
      // Only auto-deposit if:
      // 1. User specified deposit amount AND
      // 2. Pump wallet actually needs more funds (below required)
      // This prevents double-deposit when DEPOSIT action already ran
      if (requestedDeposit !== null && requestedDeposit > 0 && pumpBalance < REQUIRED_SOL) {
        const displayDeposit = formatAmount(requestedDeposit);
        if (fundingWallet.balance < requestedDeposit + 0.01) {
          await callback({
            text: `❌ **Insufficient funds for deposit**\n\n` +
                  `You requested ${displayDeposit} SOL but funding wallet only has ${fundingWallet.balance.toFixed(4)} SOL.\n\n` +
                  `Fund your wallet first:\n\`${fundingWallet.address}\``,
            data: { launchPackId, insufficientFunds: true },
            source: message.content?.source,
          });
          return { text: 'Insufficient funds', success: false };
        }
        
        // Perform deposit
        console.log(`[LAUNCH] Auto-depositing ${displayDeposit} SOL before launch...`);
        await callback({
          text: `💰 Depositing ${displayDeposit} SOL to pump wallet...`,
          source: message.content?.source,
        });
        
        const { depositToPumpWallet } = await import('../services/fundingWallet.ts');
        const depositResult = await depositToPumpWallet(requestedDeposit);
        pumpBalance = depositResult.balance;
        
        console.log(`[LAUNCH] ✅ Deposited ${displayDeposit} SOL. Pump balance: ${pumpBalance.toFixed(4)} SOL`);
        await callback({
          text: `✅ Deposited ${displayDeposit} SOL (Balance: ${pumpBalance.toFixed(4)} SOL)\n\n🚀 Now launching...`,
          source: message.content?.source,
        });
      } else if (requestedDeposit !== null && pumpBalance >= REQUIRED_SOL) {
        // User mentioned deposit but pump wallet already has enough (DEPOSIT action probably already ran)
        console.log(`[LAUNCH] Pump wallet already has ${pumpBalance.toFixed(4)} SOL (>= ${REQUIRED_SOL}), skipping deposit`);
      }
      
      if (pumpBalance < REQUIRED_SOL) {
        const deficit = REQUIRED_SOL - pumpBalance + 0.15; // Add buffer
        
        // Check if funding wallet has enough to cover
        if (fundingWallet.balance >= deficit + 0.01) {
          // Funding wallet has enough - ask user to specify deposit amount or use "deposit X sol and launch"
          await callback({
            text: `💰 **Wallet Funding Required**\n\n` +
                  `Your pump wallet has ${pumpBalance.toFixed(4)} SOL but launch requires ~${REQUIRED_SOL} SOL.\n\n` +
                  `**Your balances:**\n` +
                  `• Pump wallet: ${pumpBalance.toFixed(4)} SOL\n` +
                  `• Funding wallet: ${fundingWallet.balance.toFixed(4)} SOL\n\n` +
                  `**Quick options:**\n` +
                  `• "deposit ${deficit.toFixed(2)} sol and launch" (one command!)\n` +
                  `• "deposit 0.5 sol and launch" (recommended)\n` +
                  `• Or just "deposit 0.5 sol" then "launch"`,
            data: { 
              launchPackId, 
              awaitingDeposit: true,
              pumpBalance,
              fundingBalance: fundingWallet.balance,
              minimumDeposit: deficit,
            },
            source: message.content?.source,
          });
          
          return {
            text: 'Awaiting deposit confirmation',
            success: true,
            data: { launchPackId, awaitingDeposit: true },
          };
        } else {
          // Neither wallet has enough
          const totalNeeded = REQUIRED_SOL - pumpBalance - fundingWallet.balance + 0.15;
          
          await callback({
            text: `❌ **Insufficient Funds**\n\n` +
                  `Launch requires ~${REQUIRED_SOL} SOL but you don't have enough:\n\n` +
                  `• Pump wallet: ${pumpBalance.toFixed(4)} SOL\n` +
                  `• Funding wallet: ${fundingWallet.balance.toFixed(4)} SOL\n` +
                  `• **Total needed**: ${totalNeeded.toFixed(4)} more SOL\n\n` +
                  `Please fund your wallet:\n` +
                  `\`${fundingWallet.address}\`\n\n` +
                  `Once funded, say "launch" to try again.`,
            data: { 
              launchPackId, 
              insufficientFunds: true,
              fundingAddress: fundingWallet.address,
              amountNeeded: totalNeeded,
            },
            source: message.content?.source,
          });
          
          return {
            text: 'Insufficient funds for launch',
            success: false,
            data: { launchPackId, insufficientFunds: true },
          };
        }
      }
      
      // Wallet check passed - proceed with launch
      console.log(`[LAUNCH] ✅ Wallet check passed (${pumpBalance.toFixed(4)} SOL). Proceeding...`);
      
    } catch (walletErr: any) {
      console.error('[LAUNCH] Wallet check error:', walletErr);
      // Continue anyway - let pumpService.launch() handle it
    }

    try {
      const updated = await pumpService.launch(launchPackId, { 
        force: Boolean(parsed.force),
        skipTelegramCheck: skipTgCheck // Pass the skip flag to the service
      });
      
      const statusText = updated.launch?.status ?? 'unknown';
      const mintText = updated.launch?.mint ?? 'N/A';
      const urlText = updated.launch?.pump_url ?? '';
      
      // Auto-publish to Telegram and X after successful launch
      if (updated.launch?.status === 'launched') {
        const telegramPublisher = kit.telegramPublisher;
        const telegramCommunity = kit.telegramCommunity;
        const xPublisher = kit.xPublisher;
        
        // NEW: Send post-launch announcement with token details
        if (telegramCommunity && (updated.tg?.telegram_chat_id || updated.tg?.chat_id)) {
          try {
            const announcementResult = await telegramCommunity.postLaunchAnnouncement(launchPackId);
            if (announcementResult.welcomePinned) {
              await callback({
                text: `📌 Pinned welcome message to Telegram group!`,
                data: { launchPackId, welcomePinned: true },
                source: message.content?.source,
              });
            }
            if (announcementResult.announcementId) {
              await callback({
                text: `📢 Posted launch announcement with logo to Telegram!`,
                data: { launchPackId, announcementSent: true },
                source: message.content?.source,
              });
            }
            if (announcementResult.error) {
              console.error('[LAUNCH] Announcement error:', announcementResult.error);
            }
          } catch (err: any) {
            console.error('Telegram announcement failed:', err);
          }
        }
        
        // Publish scheduled pins to Telegram if available and telegram_chat_id configured
        if (telegramPublisher && (updated.tg?.telegram_chat_id || updated.tg?.chat_id)) {
          try {
            await telegramPublisher.publish(launchPackId, { force: false });
            await callback({
              text: `✅ Published to Telegram group!`,
              data: { launchPackId, publishedTo: 'telegram' },
              source: message.content?.source,
            });
          } catch (err: any) {
            console.error('Telegram auto-publish failed:', err);
            await callback({
              text: `⚠️ Telegram publish failed: ${err.message}`,
              source: message.content?.source,
            });
          }
        }
        
        // Publish to X if available
        if (xPublisher) {
          try {
            await xPublisher.publish(launchPackId, { force: false });
            await callback({
              text: `✅ Published to X/Twitter!`,
              data: { launchPackId, publishedTo: 'x' },
              source: message.content?.source,
            });
          } catch (err: any) {
            console.error('X auto-publish failed:', err);
            await callback({
              text: `⚠️ X publish failed: ${err.message}`,
              source: message.content?.source,
            });
          }
        }
      }
      
      return {
        text: `🚀 Launch ${statusText}!\n\nMint: ${mintText}\n${urlText}`,
        success: true,
      };
    } catch (launchErr: any) {
      // === FAILSAFE ERROR HANDLING ===
      // Catch validation errors and provide clear feedback
      console.error('[LAUNCH] Launch failed:', launchErr);
      
      const errorCode = launchErr.code || 'LAUNCH_FAILED';
      const details = launchErr.details;
      
      // Handle specific validation errors with helpful messages
      if (errorCode === 'LAUNCH_REQUIREMENTS_MISSING') {
        const missingList = (details?.missingRequirements || []).join('\n• ');
        const warningsList = (details?.warnings || []).join('\n• ');
        
        let errorMessage = `❌ **Launch Blocked - Missing Requirements**\n\n`;
        errorMessage += `The following issues must be fixed before launch:\n• ${missingList}\n\n`;
        
        if (warningsList) {
          errorMessage += `⚠️ **Warnings:**\n• ${warningsList}\n\n`;
        }
        
        errorMessage += `**How to fix:**\n`;
        errorMessage += `• Make sure your token has a name, ticker, and logo\n`;
        errorMessage += `• If using Telegram, add the bot to your group and verify it\n`;
        errorMessage += `• Use "launch anyway" or "skip telegram" to bypass TG check\n`;
        
        await callback({
          text: errorMessage,
          data: { launchPackId, error: errorCode, details },
          source: message.content?.source,
        });
        
        return {
          text: 'Launch blocked - missing requirements',
          success: false,
          error: errorCode,
          data: { launchPackId, missingRequirements: details?.missingRequirements },
        };
      }
      
      // Handle other launch errors
      await callback({
        text: `❌ **Launch Failed**\n\n${launchErr.message}`,
        data: { launchPackId, error: errorCode },
        source: message.content?.source,
      });
      
      return {
        text: `Launch failed: ${launchErr.message}`,
        success: false,
        error: errorCode,
      };
    }
  },
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'launch 00000000-0000-4000-8000-000000000000',
          data: { force: false },
        },
      },
      {
        name: 'eliza',
        content: {
          text: 'Launch executed',
          actions: ['LAUNCH_LAUNCHPACK'],
        },
      },
    ],
  ],
};

export const publishTelegramAction: Action = {
  name: 'PUBLISH_TELEGRAM',
  similes: ['PUBLISH_TG', 'TELEGRAM_PUBLISH'],
  description: 'Publish LaunchPack copy to Telegram',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /telegram|tg|publish/.test(text);
    try {
      publishDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = publishDataSchema.parse(message.content?.data ?? {});
    const kit = requireLaunchKit(runtime);
    
    // Try to find a LaunchPack with telegram configured
    let launchPackId = extractLaunchPackId(message) || parsed.launchPackId;
    
    if (!launchPackId) {
      // Look for a pack linked to TG, don't create a new one
      launchPackId = await findTelegramLinkedPack(runtime, message, kit.store);
    }
    
    if (!launchPackId) {
      // No pack found - user needs to link a TG group first
      return {
        text: "No LaunchPack with Telegram group linked. Please link a Telegram group first using 'link telegram' or provide a LaunchPack ID.",
        success: false,
        error: 'NO_TELEGRAM_LINKED_PACK',
      };
    }

    const telegramPublisher = requireService<TelegramPublisherService>(
      kit.telegramPublisher,
      'TELEGRAM_SERVICE_UNAVAILABLE',
      'Telegram publisher unavailable'
    );

    const updated = await telegramPublisher.publish(launchPackId, { force: Boolean(parsed.force) });
    await callback({
      text: `Telegram publish recorded for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        tg: {
          publishedAt: updated.ops?.tg_published_at,
          messageIds: updated.ops?.tg_message_ids,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['PUBLISH_TELEGRAM'],
      source: message.content?.source,
    });

    return {
      text: 'Telegram publish recorded',
      success: true,
      data: {
        launchPackId: updated.id,
        tgPublishedAt: updated.ops?.tg_published_at,
        tgMessageIds: updated.ops?.tg_message_ids,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'publish telegram for 00000000-0000-4000-8000-000000000000' },
      },
      {
        name: 'eliza',
        content: { text: 'Telegram publish recorded', actions: ['PUBLISH_TELEGRAM'] },
      },
    ],
  ],
};

/**
 * SEND_TELEGRAM_MESSAGE - Send a message to the linked Telegram group
 * This is different from PUBLISH_TELEGRAM which does the full checklist publish
 * This action just sends a single message to the TG group
 */
export const sendTelegramMessageAction: Action = {
  name: 'SEND_TELEGRAM_MESSAGE',
  similes: ['POST_TO_TELEGRAM', 'MESSAGE_TELEGRAM', 'SEND_TG', 'TG_MESSAGE', 'SEND_TO_GROUP'],
  description: 'Send a message to the linked Telegram group. Use this when the user wants to send a specific message to their TG community.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Detect intent to send a message to TG
    const hasIntent = /(send|post|message).*(telegram|tg|group)|(telegram|tg|group).*(message|send|post)/i.test(text);
    return hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    
    // Find the pack with telegram linked
    const launchPackId = await findTelegramLinkedPack(runtime, message, kit.store);
    
    if (!launchPackId) {
      return {
        text: "No LaunchPack with Telegram group linked. Please link a Telegram group first.",
        success: false,
        error: 'NO_TELEGRAM_LINKED_PACK',
      };
    }
    
    const pack = await kit.store.get(launchPackId);
    const telegramChatId = pack?.tg?.telegram_chat_id;
    
    if (!telegramChatId) {
      return {
        text: "LaunchPack found but no Telegram chat_id configured.",
        success: false,
        error: 'NO_TELEGRAM_CHAT_ID',
      };
    }
    
    // Get the TG community service
    const telegramCommunity = requireService<TelegramCommunityService>(
      kit.telegramCommunity,
      'TELEGRAM_SERVICE_UNAVAILABLE',
      'Telegram community service unavailable'
    );
    
    // Get the message content from the LLM's response in the state
    // The LLM should have generated a message to send
    const stateText = (state as any)?.text || (state as any)?.responseText || '';
    
    // Extract the message the LLM wants to send - look in recent context
    // The user is asking to "send X to telegram" where X is the content
    const userText = String(message.content?.text ?? '');
    
    // Try to extract the message content from user's request
    // Patterns like "send [message] to telegram" or "post [message] to the group"
    let messageContent = userText
      .replace(/^(send|post|message)\s+/i, '')
      .replace(/\s+(to|in|on)\s+(the\s+)?(telegram|tg|group).*$/i, '')
      .trim();
    
    // If we didn't extract a clear message, use the LLM's generated text
    if (!messageContent || messageContent.length < 10) {
      messageContent = stateText;
    }
    
    // If still no content, generate a default mascot greeting
    if (!messageContent || messageContent.length < 10) {
      const mascot = pack?.mascot;
      if (mascot?.name) {
        messageContent = `gm degens! ${mascot.name} has entered the chat 😈🚀`;
      } else {
        messageContent = `gm! Your agent is now active in this group! 🚀`;
      }
    }
    
    try {
      console.log(`[SEND_TELEGRAM_MESSAGE] Sending to chat ${telegramChatId}: ${messageContent.substring(0, 50)}...`);
      
      await telegramCommunity.sendMessageToChatId(telegramChatId, messageContent);
      
      await callback({
        text: `✅ Message sent to Telegram group!`,
        data: { telegramChatId, messageSent: true },
      });
      
      return {
        text: 'Message sent to Telegram',
        success: true,
        data: { telegramChatId, messageContent },
      };
    } catch (err: any) {
      console.error(`[SEND_TELEGRAM_MESSAGE] Failed:`, err);
      return {
        text: `Failed to send message: ${err.message}`,
        success: false,
        error: err.code || 'SEND_FAILED',
      };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'send a message to the telegram group' } },
      { name: 'eliza', content: { text: '✅ Message sent to Telegram group!', actions: ['SEND_TELEGRAM_MESSAGE'] } },
    ],
    [
      { name: 'user', content: { text: 'post gm to telegram' } },
      { name: 'eliza', content: { text: '✅ Message sent to Telegram group!', actions: ['SEND_TELEGRAM_MESSAGE'] } },
    ],
    [
      { name: 'user', content: { text: 'send a greeting to the tg group' } },
      { name: 'eliza', content: { text: '✅ Message sent to Telegram group!', actions: ['SEND_TELEGRAM_MESSAGE'] } },
    ],
  ],
};

/**
 * RETRY_TELEGRAM_ANNOUNCEMENT - Retry posting the launch announcement to Telegram
 * Use this when the initial announcement failed after a successful launch
 */
export const retryTelegramAnnouncementAction: Action = {
  name: 'RETRY_TELEGRAM_ANNOUNCEMENT',
  similes: ['ANNOUNCE_LAUNCH', 'RETRY_ANNOUNCEMENT', 'POST_ANNOUNCEMENT', 'SEND_ANNOUNCEMENT', 'TELEGRAM_ANNOUNCE'],
  description: 'Retry sending the launch announcement to Telegram. Use when the announcement failed after a successful token launch.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /retry|announce|announcement/.test(text) && /telegram|tg|launch/.test(text);
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    
    // Find the launched pack
    let launchPackId = extractLaunchPackId(message);
    
    if (!launchPackId) {
      // Look for a pack with telegram configured that has been launched OR has a mint address
      const packs = await kit.store.list();
      const launchedPack = packs
        .filter((p: any) => {
          const hasTelegram = p.tg?.telegram_chat_id || p.tg?.chat_id;
          const isLaunched = p.launch?.status === 'launched' || p.launch?.mint;
          return hasTelegram && isLaunched;
        })
        .sort((a: any, b: any) => {
          const aTime = a.launch?.launched_at || a.updated_at || '';
          const bTime = b.launch?.launched_at || b.updated_at || '';
          return bTime.localeCompare(aTime);
        })[0];
      
      // If no launched pack, just find any pack with telegram configured
      const anyTelegramPack = launchedPack || packs
        .filter((p: any) => p.tg?.telegram_chat_id || p.tg?.chat_id)
        .sort((a: any, b: any) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
      
      if (anyTelegramPack) {
        launchPackId = anyTelegramPack.id;
        console.log(`[RETRY_ANNOUNCEMENT] Found pack: ${anyTelegramPack.brand?.name} (${launchPackId}), status=${anyTelegramPack.launch?.status}, mint=${anyTelegramPack.launch?.mint}`);
      }
    }
    
    if (!launchPackId) {
      return {
        text: "No LaunchPack with Telegram group found. Please link a Telegram group first.",
        success: false,
        error: 'NO_TELEGRAM_PACK',
      };
    }
    
    const pack = await kit.store.get(launchPackId);
    if (!pack) {
      return {
        text: "LaunchPack not found.",
        success: false,
        error: 'PACK_NOT_FOUND',
      };
    }
    
    const telegramChatId = pack.tg?.telegram_chat_id || pack.tg?.chat_id;
    if (!telegramChatId) {
      return {
        text: "No Telegram group linked to this LaunchPack. Please link a group first.",
        success: false,
        error: 'NO_TELEGRAM_LINKED',
      };
    }
    
    const telegramCommunity = requireService<TelegramCommunityService>(
      kit.telegramCommunity,
      'TELEGRAM_SERVICE_UNAVAILABLE',
      'Telegram community service unavailable'
    );
    
    try {
      await callback({
        text: `📢 Retrying announcement for ${pack.brand?.name || 'token'}...`,
        source: message.content?.source,
      });
      
      const result = await telegramCommunity.postLaunchAnnouncement(launchPackId);
      
      if (result.error) {
        return {
          text: `❌ Announcement failed: ${result.error}`,
          success: false,
          error: 'ANNOUNCEMENT_FAILED',
        };
      }
      
      let successText = '✅ Launch announcement sent!';
      if (result.welcomePinned) {
        successText += '\n📌 Welcome message pinned.';
      }
      
      await callback({
        text: successText,
        data: { launchPackId, ...result },
        source: message.content?.source,
      });
      
      return {
        text: successText,
        success: true,
        data: result,
      };
    } catch (err: any) {
      console.error('[RETRY_ANNOUNCEMENT] Failed:', err);
      return {
        text: `❌ Announcement failed: ${err.message}`,
        success: false,
        error: err.code || 'ANNOUNCEMENT_ERROR',
      };
    }
  },
  examples: [
    [
      { name: 'user', content: { text: 'retry the telegram announcement' } },
      { name: 'eliza', content: { text: '✅ Launch announcement sent!', actions: ['RETRY_TELEGRAM_ANNOUNCEMENT'] } },
    ],
    [
      { name: 'user', content: { text: 'announce the launch to telegram' } },
      { name: 'eliza', content: { text: '✅ Launch announcement sent!', actions: ['RETRY_TELEGRAM_ANNOUNCEMENT'] } },
    ],
  ],
};

export const publishXAction: Action = {
  name: 'PUBLISH_X',
  similes: ['PUBLISH_TWITTER', 'POST_X'],
  description: 'Publish LaunchPack copy to X',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /publish|post|twitter|x /.test(text);
    try {
      publishDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = publishDataSchema.parse(message.content?.data ?? {});
    let launchPackId = extractLaunchPackId(message) || parsed.launchPackId;
    if (!launchPackId) {
      launchPackId = await createLaunchPack(runtime, message);
      await callback({
        text: `Created LaunchPack ${launchPackId}. Publishing to X now...`,
        data: { launchPackId },
        actions: ['PUBLISH_X'],
        source: message.content?.source,
      });
    }

    const kit = requireLaunchKit(runtime);
    const xPublisher = requireService<XPublisherService>(kit.xPublisher, 'X_SERVICE_UNAVAILABLE', 'X publisher unavailable');

    // Get Twitter client from plugin
    const twitterService = runtime.getService('twitter') as any;
    if (!twitterService?.twitterClient) {
      throw new Error('Twitter plugin not available. Ensure @elizaos/plugin-twitter is loaded and configured.');
    }
    xPublisher.setTwitterClient(twitterService.twitterClient);

    const updated = await xPublisher.publish(launchPackId, { force: Boolean(parsed.force) });
    await callback({
      text: `X publish recorded for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        x: {
          publishedAt: updated.ops?.x_published_at,
          postIds: updated.ops?.x_post_ids,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['PUBLISH_X'],
      source: message.content?.source,
    });

    return {
      text: 'X publish recorded',
      success: true,
      data: {
        launchPackId: updated.id,
        xPublishedAt: updated.ops?.x_published_at,
        xPostIds: updated.ops?.x_post_ids,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'post launchpack to x 00000000-0000-4000-8000-000000000000' },
      },
      {
        name: 'eliza',
        content: { text: 'X publish recorded', actions: ['PUBLISH_X'] },
      },
    ],
  ],
};

export const listLaunchPacksAction: Action = {
  name: 'LIST_LAUNCHPACKS',
  similes: ['SHOW_LAUNCHPACKS', 'LIST_TOKENS', 'SHOW_TOKENS', 'SHOW_ALL_TOKENS'],
  description: 'List all LaunchPacks with their status and Telegram groups',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    return /show|list|view/.test(text) && /(all|launchpack|token|my)s?/.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    const packs = await store.list();
    
    if (packs.length === 0) {
      return {
        text: 'No LaunchPacks created yet. Create one by saying "generate token called [NAME]"',
        success: true,
      };
    }

    let response = `📦 LaunchPacks (${packs.length} total):\n\n`;
    
    for (const pack of packs) {
      const name = pack.brand?.name || 'Unnamed';
      const ticker = pack.brand?.ticker || 'N/A';
      const status = pack.launch?.status || 'not launched';
      const tgGroup = pack.tg?.chat_id ? `✅ Linked (${pack.tg.chat_id})` : '❌ No group';
      const mintAddr = pack.launch?.mint ? `\n   Mint: ${pack.launch.mint.slice(0, 8)}...` : '';
      
      response += `🪙 **${name}** ($${ticker})\n`;
      response += `   Status: ${status}${mintAddr}\n`;
      response += `   Telegram: ${tgGroup}\n`;
      response += `   ID: ${pack.id}\n\n`;
    }

    await callback({
      text: response,
      data: { launchPacks: packs.map((p: any) => ({ id: p.id, name: p.brand?.name, telegram: p.tg?.chat_id })) },
    });

    return {
      text: response,
      success: true,
      data: { count: packs.length },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'list launchpacks' } },
      { name: 'eliza', content: { text: '📦 LaunchPacks (2 total)...', actions: ['LIST_LAUNCHPACKS'] } },
    ],
    [
      { name: 'user', content: { text: 'show all tokens' } },
      { name: 'eliza', content: { text: '📦 LaunchPacks (2 total)...', actions: ['LIST_LAUNCHPACKS'] } },
    ],
    [
      { name: 'user', content: { text: 'show telegram groups' } },
      { name: 'eliza', content: { text: '📦 LaunchPacks (2 total)...', actions: ['LIST_LAUNCHPACKS'] } },
    ],
  ],
};

/**
 * Action to view a specific LaunchPack's full details
 * Shows name, description, logo, marketing copy, social links, etc.
 */
export const viewLaunchPackAction: Action = {
  name: 'VIEW_LAUNCHPACK',
  similes: ['SHOW_LAUNCHPACK', 'SHOW_TOKEN', 'VIEW_TOKEN', 'LAUNCHPACK_DETAILS', 'TOKEN_DETAILS'],
  description: 'View full details of a LaunchPack including name, description, logo, and generated marketing copy',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Match "show me the launch pack", "view launchpack", "show token details", etc.
    // But NOT "show all" or "list" which go to LIST_LAUNCHPACKS
    const hasViewIntent = /\b(show|view|see|display|details?|what('?s| is))\b/.test(text);
    const hasPackRef = /\b(launch\s*pack|token|pack)\b/.test(text);
    const isNotList = !/\b(all|list|every)\b/.test(text);
    const isNotChecklist = !/\b(checklist|ready|status)\b/.test(text);
    
    return hasViewIntent && hasPackRef && isNotList && isNotChecklist;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return {
        text: '❌ LaunchKit store unavailable',
        success: false,
      };
    }

    // Find the LaunchPack from context or message
    const launchPackId = await findLaunchPackFromContext(runtime, message, store);
    
    if (!launchPackId) {
      await callback({
        text: `📦 **No LaunchPack Found**\n\nYou haven't created a LaunchPack yet.\n\nSay "create a token called [NAME]" to get started!`,
      });
      return { text: 'No LaunchPack found', success: false };
    }

    const pack = await store.get(launchPackId);
    if (!pack) {
      return { text: '❌ LaunchPack not found.', success: false };
    }

    // Build the detailed view
    const name = pack.brand?.name || 'Unnamed';
    const ticker = pack.brand?.ticker || 'N/A';
    const description = pack.brand?.description || 'No description set';
    const logo = pack.assets?.logo_url || 'Not set';
    const status = pack.launch?.status || 'not launched';
    const mintAddr = pack.launch?.mint || null;
    
    // Social links - from links object, not brand
    const website = pack.links?.website || null;
    const twitter = pack.links?.x || null;
    const telegram = pack.tg?.telegram_chat_id || pack.tg?.chat_id || null;
    
    // Marketing copy - pins is an object with welcome/how_to_buy/memekit, thread is an array
    const tgPins = pack.tg?.pins || {};
    const hasTgPins = tgPins.welcome || tgPins.how_to_buy || tgPins.memekit;
    const xThread = pack.x?.thread || [];
    const xMainPost = pack.x?.main_post || '';
    const schedule = pack.x?.schedule || [];
    
    let response = `📦 **LaunchPack: ${name} ($${ticker})**\n\n`;
    
    // Basic info
    response += `**📝 Description:**\n${description}\n\n`;
    response += `**🖼️ Logo:** ${logo}\n\n`;
    response += `**📊 Status:** ${status}\n`;
    if (mintAddr) {
      response += `**🪙 Mint Address:** \`${mintAddr}\`\n`;
    }
    response += `**🔗 LaunchPack ID:** \`${launchPackId}\`\n\n`;
    
    // Social links
    response += `**🌐 Social Links:**\n`;
    response += `• Website: ${website || 'Not set'}\n`;
    response += `• Twitter/X: ${twitter || 'Not set'}\n`;
    response += `• Telegram: ${telegram || 'No group linked'}\n\n`;
    
    // Marketing copy summary
    if (hasTgPins || xThread.length > 0 || xMainPost) {
      response += `**📢 Generated Marketing Copy:**\n`;
      const pinCount = [tgPins.welcome, tgPins.how_to_buy, tgPins.memekit].filter(Boolean).length;
      response += `• Telegram Pins: ${pinCount} post(s)\n`;
      response += `• X/Twitter: Main post + ${xThread.length}-part thread\n`;
      if (schedule.length > 0) {
        response += `• Scheduled Posts: ${schedule.length}\n`;
      }
      response += `\n`;
      
      // Show welcome pin as preview
      if (tgPins.welcome) {
        response += `**📌 Telegram Welcome Preview:**\n\`\`\`\n${tgPins.welcome.slice(0, 200)}${tgPins.welcome.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
      }
      
      // Show main X post as preview
      if (xMainPost) {
        response += `**🐦 X/Twitter Post Preview:**\n\`\`\`\n${xMainPost.slice(0, 200)}${xMainPost.length > 200 ? '...' : ''}\n\`\`\`\n`;
      }
    } else {
      response += `**📢 Marketing Copy:** Not generated yet. Say "generate copy" to create.\n`;
    }

    await callback({
      text: response,
      data: { launchPackId, pack },
    });

    return {
      text: `Displayed LaunchPack: ${name}`,
      success: true,
      data: { launchPackId },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'show me the launch pack' } },
      { name: 'eliza', content: { text: '📦 **LaunchPack: Ferb ($FRB)**...', actions: ['VIEW_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'view launchpack' } },
      { name: 'eliza', content: { text: '📦 **LaunchPack: Moondog ($MOON)**...', actions: ['VIEW_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'show token details' } },
      { name: 'eliza', content: { text: '📦 **LaunchPack: Degen ($DGEN)**...', actions: ['VIEW_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'what is the launchpack' } },
      { name: 'eliza', content: { text: '📦 **LaunchPack: Pepe ($PEPE)**...', actions: ['VIEW_LAUNCHPACK'] } },
    ],
  ],
};

/**
 * Action to delete a LaunchPack (for cleanup)
 */
export const deleteLaunchPackAction: Action = {
  name: 'DELETE_LAUNCHPACK',
  similes: ['REMOVE_LAUNCHPACK', 'DELETE_TOKEN', 'CLEANUP', 'DELETE_ALL', 'CLEAR_ALL'],
  description: 'Delete a LaunchPack by name, ticker, or ID. Say "delete all" to remove all unlaunched tokens.',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Match any delete intent - we'll figure out what to delete in the handler
    // Examples: "delete all", "delete moondog", "delete $RUG", "delete to the telegram", etc.
    const hasDeleteIntent = /\b(delete|remove)\b/.test(text);
    return hasDeleteIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return { text: '❌ LaunchKit store unavailable', success: false };
    }

    const text = String(message.content?.text ?? '');
    
    // Check for force/override flags (delete even launched tokens)
    const forceDelete = /force|dont preserve|don't preserve|including launched|even launched|all of them/i.test(text);
    
    // Check for UUID first
    let launchPackId = extractLaunchPackId(message);
    
    // Check for "all" - delete all packs (or just unlaunched if not forced)
    // Match: "delete all", "delete them", "delete both", "delete everything", "clear all", etc.
    if (/delete (all|them|both|everything)|clear (all|everything)|remove (all|everything)/i.test(text)) {
      const packs = await store.list();
      
      // If force, delete ALL. Otherwise only unlaunched.
      const toDelete = forceDelete 
        ? packs 
        : packs.filter((p: any) => p.launch?.status !== 'launched');
      
      if (toDelete.length === 0) {
        const msg = forceDelete 
          ? '✅ No LaunchPacks to delete.' 
          : '✅ No unlaunched tokens to delete. Say "delete all force" to also delete launched tokens.';
        return { text: msg, success: true };
      }
      
      for (const pack of toDelete) {
        await store.delete(pack.id);
      }
      
      const preserved = packs.length - toDelete.length;
      const preserveMsg = preserved > 0 ? ` ${preserved} launched tokens preserved.` : '';
      
      await callback({
        text: `🗑️ Deleted ${toDelete.length} LaunchPack(s).${preserveMsg}`,
      });
      
      return { text: `Deleted ${toDelete.length} LaunchPacks`, success: true };
    }
    
    // Try to find by name/ticker if no UUID
    if (!launchPackId) {
      // Get all packs first to match against
      const packs = await store.list();
      
      // Try to extract what the user wants to delete
      // Match patterns like: "delete X", "delete the X", "delete launchpack X"
      const nameMatch = text.match(/(?:delete|remove)\s+(?:the\s+)?(?:launchpack|token|pack)?\s*["']?(.+?)["']?\s*$/i);
      
      if (nameMatch) {
        const searchTerm = nameMatch[1].toLowerCase().trim();
        
        // Try exact name match first
        let found = packs.find((p: any) => 
          p.brand?.name?.toLowerCase() === searchTerm ||
          p.brand?.ticker?.toLowerCase() === searchTerm ||
          p.brand?.ticker?.toLowerCase() === searchTerm.replace('$', '')
        );
        
        // Try partial/fuzzy match if no exact match
        if (!found) {
          found = packs.find((p: any) => 
            p.brand?.name?.toLowerCase().includes(searchTerm) ||
            searchTerm.includes(p.brand?.name?.toLowerCase()) ||
            p.brand?.ticker?.toLowerCase().includes(searchTerm) ||
            searchTerm.includes(p.brand?.ticker?.toLowerCase())
          );
        }
        
        // Try matching by ticker only (common pattern: "delete $RUG" or "delete RUG")
        if (!found) {
          const tickerOnly = searchTerm.replace(/^\$/, '').toUpperCase();
          found = packs.find((p: any) => p.brand?.ticker?.toUpperCase() === tickerOnly);
        }
        
        if (found) {
          launchPackId = found.id;
          console.log(`[DELETE] Found pack by search: "${searchTerm}" -> ${found.brand?.name} (${found.id})`);
        } else {
          console.log(`[DELETE] No pack found matching: "${searchTerm}"`);
        }
      }
    }
    
    if (!launchPackId) {
      // If there are LaunchPacks, list them with delete options
      const packs = await store.list();
      if (packs.length > 0) {
        const packList = packs.map((p: any) => `• ${p.brand?.name || 'Unnamed'} ($${p.brand?.ticker || 'N/A'})`).join('\n');
        await callback({
          text: `🗑️ **Which LaunchPack do you want to delete?**\n\n` +
            `Current LaunchPacks:\n${packList}\n\n` +
            `Say:\n` +
            `• "delete [name]" - delete a specific token\n` +
            `• "delete all" - delete all unlaunched tokens\n` +
            `• "delete all force" - delete ALL tokens (including launched)`,
        });
      }
      return {
        text: 'Please specify which LaunchPack to delete',
        success: false,
      };
    }
    
    const pack = await store.get(launchPackId);
    if (!pack) {
      return { text: '❌ LaunchPack not found.', success: false };
    }
    
    // Don't delete launched tokens unless forced
    if (pack.launch?.status === 'launched' && !forceDelete) {
      return { 
        text: `❌ Cannot delete **${pack.brand?.name}** - it's marked as launched. Say "delete ${pack.brand?.name} force" to override.`, 
        success: false 
      };
    }
    
    await store.delete(launchPackId);
    
    await callback({
      text: `🗑️ Deleted LaunchPack **${pack.brand?.name}** ($${pack.brand?.ticker})`,
    });
    
    return { text: `Deleted ${pack.brand?.name}`, success: true };
  },
  examples: [
    [
      { name: 'user', content: { text: 'delete token moondog' } },
      { name: 'eliza', content: { text: '🗑️ Deleted LaunchPack **Moondog** ($MOON)', actions: ['DELETE_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'delete all launchpacks' } },
      { name: 'eliza', content: { text: '🗑️ Deleted 3 unlaunched LaunchPack(s)', actions: ['DELETE_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'delete all' } },
      { name: 'eliza', content: { text: '🗑️ Deleted 5 unlaunched LaunchPack(s)', actions: ['DELETE_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'clear all tokens' } },
      { name: 'eliza', content: { text: '🗑️ Deleted 10 unlaunched LaunchPack(s)', actions: ['DELETE_LAUNCHPACK'] } },
    ],
    [
      { name: 'user', content: { text: 'remove everything' } },
      { name: 'eliza', content: { text: '🗑️ Deleted 8 unlaunched LaunchPack(s)', actions: ['DELETE_LAUNCHPACK'] } },
    ],
  ],
};

// Import rate limiter for X quota action
import { getQuota, getPostingAdvice, getUsageSummary } from '../services/xRateLimiter.ts';

/**
 * CHECK_X_QUOTA - Check X/Twitter rate limit status
 * Shows remaining tweets, reads, and posting advice
 */
export const checkXQuotaAction: Action = {
  name: 'CHECK_X_QUOTA',
  similes: ['X_QUOTA', 'TWITTER_QUOTA', 'TWEET_LIMIT', 'X_USAGE', 'TWITTER_USAGE', 'HOW_MANY_TWEETS'],
  description: 'Check X/Twitter API rate limit status and remaining quota',
  
  validate: async () => true,
  
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const env = getEnv();
    
    if (env.X_ENABLE !== 'true') {
      await callback({
        text: '❌ X/Twitter integration is disabled. Set `X_ENABLE=true` in .env to enable.',
      });
      return { text: 'X disabled', success: false };
    }
    
    const quota = getQuota();
    const advice = getPostingAdvice();
    const summary = getUsageSummary();
    
    let statusEmoji = '✅';
    if (advice.urgency === 'medium') statusEmoji = '⚠️';
    if (advice.urgency === 'high') statusEmoji = '🚨';
    if (!advice.canPost) statusEmoji = '❌';
    
    const text = `${statusEmoji} **X/Twitter Quota Status**

📊 **Monthly Usage (${quota.month})**
• Tweets: **${quota.writes.used}** / ${quota.writes.limit} (${quota.writes.remaining} remaining)
• Reads: **${quota.reads.used}** / ${quota.reads.limit} (${quota.reads.remaining} remaining)

${quota.lastWrite ? `🕐 Last tweet: ${new Date(quota.lastWrite).toLocaleString()}` : '📭 No tweets this month yet'}

💡 **Posting Advice**
${advice.reason}

${advice.urgency === 'high' ? '⚠️ **WARNING**: Save remaining tweets for critical announcements only!' : ''}
${!advice.canPost ? '❌ **LIMIT REACHED**: Cannot post until next month!' : ''}`;

    await callback({ text });
    
    return { text: summary, success: true };
  },
  
  examples: [
    [
      { name: 'user', content: { text: 'check twitter quota' } },
      { name: 'eliza', content: { text: '✅ **X/Twitter Quota Status**\n\n📊 **Monthly Usage**\n• Tweets: **12** / 500 (488 remaining)', actions: ['CHECK_X_QUOTA'] } },
    ],
    [
      { name: 'user', content: { text: 'how many tweets left' } },
      { name: 'eliza', content: { text: '✅ You have 488 tweets remaining this month', actions: ['CHECK_X_QUOTA'] } },
    ],
    [
      { name: 'user', content: { text: 'x usage' } },
      { name: 'eliza', content: { text: '📊 X/Twitter usage: 12/500 tweets used', actions: ['CHECK_X_QUOTA'] } },
    ],
  ],
};

/**
 * MARK_AS_LAUNCHED - Import/mark an existing token as launched
 * Used when user has a token already on pump.fun and wants Nova to manage it
 */
export const markAsLaunchedAction: Action = {
  name: 'MARK_AS_LAUNCHED',
  similes: ['IMPORT_TOKEN', 'SET_MINT', 'ALREADY_LAUNCHED', 'ADD_EXISTING_TOKEN', 'TOKEN_ALREADY_LAUNCHED'],
  description: 'Mark a LaunchPack as already launched with an existing mint address - for importing existing tokens',
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    // Match "already launched", "mark as launched", "set mint", "import token"
    const hasLaunchIntent = /already\s+launch|mark.*launch|set\s+mint|import.*token|existing.*mint/.test(text);
    // Check for Solana address pattern (base58, 32-44 chars)
    const hasMintAddress = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(message.content?.text ?? '');
    return hasLaunchIntent || hasMintAddress;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const kit = requireLaunchKit(runtime);
    const store = kit?.store;
    if (!store) {
      return { text: '❌ LaunchKit store unavailable', success: false };
    }

    const text = String(message.content?.text ?? '');
    
    // Extract mint address (Solana base58: 32-44 chars)
    const mintMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (!mintMatch) {
      await callback({
        text: `❌ **No mint address found**\n\nPlease provide the Solana mint address:\n\n"$DUMP is already launched at [MINT_ADDRESS]"\n\nor\n\n"mark as launched: [MINT_ADDRESS]"`,
      });
      return { text: 'No mint address provided', success: false };
    }
    
    const mintAddress = mintMatch[0];
    
    // Find LaunchPack to update
    let launchPackId: string | undefined;
    const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      launchPackId = uuidMatch[0];
    } else {
      // Try to find by ticker in message
      const tickerMatch = text.match(/\$([A-Z]{1,10})/i);
      if (tickerMatch) {
        const ticker = tickerMatch[1].toUpperCase();
        const packs = await store.list();
        const match = packs.find((p: any) => p.brand?.ticker?.toUpperCase() === ticker);
        if (match) launchPackId = match.id;
      }
      
      // Fall back to most recent pack
      if (!launchPackId) {
        const packs = await store.list();
        if (packs.length > 0) {
          const sorted = packs.sort((a: any, b: any) => 
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
          );
          launchPackId = sorted[0].id;
        }
      }
    }
    
    if (!launchPackId) {
      await callback({
        text: `❌ No LaunchPack found. Create one first by describing your token!`,
      });
      return { text: 'No LaunchPack found', success: false };
    }
    
    const pack = await store.get(launchPackId);
    if (!pack) {
      return { text: '❌ LaunchPack not found', success: false };
    }
    
    // Update with launch info
    const pumpUrl = `https://pump.fun/coin/${mintAddress}`;
    await store.update(launchPackId, {
      launch: {
        status: 'launched',
        mint: mintAddress,
        pump_url: pumpUrl,
        launched_at: new Date().toISOString(),
      },
    });
    
    await callback({
      text: `✅ **${pack.brand?.name} ($${pack.brand?.ticker}) marked as launched!**\n\n` +
        `🪙 Mint: \`${mintAddress}\`\n` +
        `🔗 Chart: ${pumpUrl}\n\n` +
        `The agent will now manage marketing for this token.\n\n` +
        `Next steps:\n` +
        `• "start TG scheduler" - Begin auto-posting in Telegram\n` +
        `• "start X marketing" - Begin Twitter posting`,
    });
    
    return {
      text: `Marked ${pack.brand?.name} as launched`,
      success: true,
      data: { launchPackId, mintAddress },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: '$DUMP is already launched at CHWDAsq6XEeDGxpxNqCrFZEZcZpGuZemNjAxUXQu99ZT' } },
      { name: 'eliza', content: { text: '✅ **Sir Dumps-A-Lot ($DUMP) marked as launched!**', actions: ['MARK_AS_LAUNCHED'] } },
    ],
    [
      { name: 'user', content: { text: 'mark as launched: HqCURvzMryReDqabn56CPFUepK76EvGWyWPvMXJiHo23' } },
      { name: 'eliza', content: { text: '✅ Marked as launched with mint HqCURv...', actions: ['MARK_AS_LAUNCHED'] } },
    ],
    [
      { name: 'user', content: { text: 'import existing token ABC123...' } },
      { name: 'eliza', content: { text: '✅ Token imported and marked as launched', actions: ['MARK_AS_LAUNCHED'] } },
    ],
  ],
};