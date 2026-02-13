import { IAgentRuntime, logger } from '@elizaos/core';
import { appendAudit } from './audit.ts';
import { addHoursIso, nextRoundedBaseDate } from './time.ts';
import { LaunchPack, LaunchPackUpdateInput } from '../model/launchPack.ts';
import { LaunchPackStore } from '../db/launchPackRepository.ts';

export interface GenerateOptions {
  theme?: string;
  keywords?: string[];
  tone?: string;
}

function fallbackText(prefix: string, theme?: string, keywords?: string[], tone?: string) {
  const parts = [prefix];
  if (theme) parts.push(`theme: ${theme}`);
  if (keywords?.length) parts.push(`keywords: ${keywords.join(', ')}`);
  if (tone) parts.push(`tone: ${tone}`);
  return parts.join(' | ');
}

/**
 * Replace placeholder tokens with actual URLs
 * Handles: [MINT_ADDRESS], [MINT], [TG_LINK], [TG], [WEBSITE], pump.fun/[MINT_ADDRESS], etc.
 */
function resolvePlaceholders(text: string, mint?: string, telegramUrl?: string, websiteUrl?: string): string {
  let result = text;
  
  // Build the actual pump.fun URL
  const pumpUrl = mint ? `https://pump.fun/coin/${mint}` : '';
  
  // Replace various placeholder patterns
  // Full URLs first
  result = result.replace(/pump\.fun\/\[MINT_ADDRESS\]/g, pumpUrl ? pumpUrl.replace('https://', '') : 'pump.fun/[pending]');
  result = result.replace(/pump\.fun\/\[MINT\]/g, pumpUrl ? pumpUrl.replace('https://', '') : 'pump.fun/[pending]');
  
  // Standalone placeholders
  result = result.replace(/\[MINT_ADDRESS\]/g, mint || '[pending]');
  result = result.replace(/\[MINT\]/g, mint || '[pending]');
  result = result.replace(/\[TG_LINK\]/g, telegramUrl || '');
  result = result.replace(/\[TG\]/g, telegramUrl || '');
  result = result.replace(/\[WEBSITE\]/g, websiteUrl || '');
  
  // Clean up empty lines
  result = result.replace(/\nTelegram: $/gm, '');
  result = result.replace(/\nWebsite: $/gm, '');
  result = result.replace(/\n\n+/g, '\n\n');
  
  return result.trim();
}

async function generate(runtime: IAgentRuntime | undefined, prompt: string) {
  // Skip API calls for now - just return structured placeholder text
  // User can edit these manually in the LaunchPack
  // This avoids making 19+ slow API calls during generation
  return prompt;
}

function buildSchedule(base: string, count: number, stepHours: number, textPrefix: string) {
  const items = [] as { when: string; text: string }[];
  const start = nextRoundedBaseDate();
  for (let i = 0; i < count; i++) {
    const when = addHoursIso(stepHours * i, start);
    items.push({ when, text: `${textPrefix} #${i + 1} ${base}` });
  }
  return items;
}

export class CopyGeneratorService {
  constructor(private store: LaunchPackStore, private runtime?: IAgentRuntime) {}

  async generateForLaunchPack(
    id: string,
    opts: GenerateOptions = {}
  ): Promise<LaunchPack> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error('LaunchPack not found');

    const { theme, keywords = [], tone } = opts;
    // Generate simple placeholder copy (skip slow API calls for now)
    const { name, ticker, description } = existing.brand;
    const hasWebsite = !!existing.links?.website;
    
    const welcome = `${name} ($${ticker})\n\n${description}\n\nFair launch on pump.fun\nNo presale. No team allocation. Community-owned.\nMint revoked. Freeze revoked.\n\nChart: pump.fun/[MINT_ADDRESS]\nTelegram: [TG_LINK]${hasWebsite ? '\nWebsite: [WEBSITE]' : ''}`;
    
    const howToBuy = `How to buy $${ticker}:\n\n1. Get a Solana wallet (Phantom recommended)\n2. Buy SOL on an exchange\n3. Go to pump.fun/[MINT_ADDRESS]\n4. Connect wallet & swap SOL for $${ticker}\n5. Set slippage 5-10%`;
    
    const memekit = `Meme Kit for ${name}\n\nCreate and share memes about ${name}.\n\nIdeas:\n• "${name} holders rn" reaction memes\n• Before/after buying $${ticker}\n• Wojak discovering $${ticker}\n\nTag us with #${ticker}`;
    
    const mainPost = `${name} ($${ticker})\n\n${description}\n\nFair launch on pump.fun\nNo presale. No team allocation.\nMint revoked ✅ Freeze revoked ✅\n\nChart: pump.fun/[MINT_ADDRESS]${hasWebsite ? '\nWebsite: [WEBSITE]' : ''}`;
    
    const thread = [
      `1/${5} ${name} ($${ticker})\n\n${description}`,
      `2/${5} Why ${name}?\n\nFair launch. Community-owned. Transparent dev.\nMint revoked. Freeze revoked.`,
      `3/${5} Tokenomics:\n\nSupply: 1B $${ticker}\nNo presale. No team tokens.\npump.fun fair launch.`,
      `4/${5} How to buy:\n\n1. Phantom wallet\n2. Buy SOL\n3. pump.fun/[MINT]\n4. Swap for $${ticker}`,
      `5/${5} Links:\n\nTelegram: [TG]\nChart: pump.fun/[MINT]${hasWebsite ? '\nWebsite: [WEBSITE]' : ''}`
    ];

    const replyBank = [
      'Chart link: pump.fun/[MINT_ADDRESS]',
      `$${ticker} — mint revoked, freeze revoked. Check the contract.`,
      `Still here. Still building $${ticker}.`,
      `$${ticker} holding. Numbers don't lie — check the chart.`,
      `Fair launch. No presale. Verify on-chain.`,
    ];

    const tgSchedule = buildSchedule(fallbackText('TG post', theme, keywords, tone), 6, 4, 'TG');
    const xSchedule = buildSchedule(fallbackText('X post', theme, keywords, tone), 4, 6, 'X');

    const pinsComplete = Boolean(welcome && howToBuy && memekit);

    const patch: LaunchPackUpdateInput = {
      tg: {
        pins: { welcome, how_to_buy: howToBuy, memekit },
        schedule: tgSchedule,
      },
      x: {
        main_post: mainPost,
        thread,
        reply_bank: replyBank,
        schedule: xSchedule,
      },
      ops: {
        checklist: {
          ...(existing.ops?.checklist || {}),
          copy_ready: true,
          tg_ready: pinsComplete,
          x_ready: Boolean(mainPost),
        },
        audit_log: appendAudit(existing.ops?.audit_log, 'Generated launch copy', 'eliza'),
      },
    };

    if (!pinsComplete) {
      throw new Error('Pin generation incomplete');
    }

    const updated = await this.store.update(id, patch);
    return updated;
  }
}
