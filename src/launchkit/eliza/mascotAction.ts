import { Action, ActionResult, IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';
import type { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { LaunchPack } from '../model/launchPack.ts';

/**
 * SET_MASCOT Action
 * 
 * Configures the mascot/character personality for a LaunchPack's community.
 * This allows each token to have a unique personality when the agent
 * interacts in that community's Telegram group.
 */
export const setMascotAction: Action = {
  name: 'SET_MASCOT',
  similes: ['CONFIGURE_MASCOT', 'UPDATE_MASCOT', 'SET_CHARACTER', 'SET_PERSONALITY'],
  description: 'Configure the mascot personality for a token community',
  
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Match mascot configuration requests
    const mascotKeywords = [
      'mascot', 'personality', 'character', 'catchphrase', 
      'speaking style', 'forbidden', 'competitor', 'rule',
      'set the .* name', 'set the .* personality'
    ];
    
    return mascotKeywords.some(kw => {
      if (kw.includes('.*')) {
        return new RegExp(kw, 'i').test(text);
      }
      return text.includes(kw);
    });
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
        logger.info('[SET_MASCOT] Removed REPLY from actions');
      }
    }

    try {
      const text = String(message.content?.text ?? '');
      
      // Get LaunchPack store
      const bootstrap = runtime.getService('launchkit_bootstrap') as any;
      const kit = bootstrap?.getLaunchKit?.();
      const store: LaunchPackStore | undefined = kit?.store;

      if (!store) {
        await callback({
          text: '❌ LaunchPack store not available',
          source: message.content?.source,
        });
        return { text: 'Store not available', success: false };
      }

      // Find the LaunchPack - try to get from context or use most recent
      const packs = await store.list();
      
      if (packs.length === 0) {
        await callback({
          text: `❌ No LaunchPacks found. Create a token first with "create a token called [NAME]"`,
          source: message.content?.source,
        });
        return { text: 'No LaunchPacks found', success: false };
      }

      // Try to find pack mentioned in message, otherwise use most recent
      let targetPack: LaunchPack | undefined;
      
      for (const pack of packs) {
        if (text.toLowerCase().includes(pack.brand.name.toLowerCase()) ||
            text.toLowerCase().includes(pack.brand.ticker.toLowerCase())) {
          targetPack = pack;
          break;
        }
      }
      
      if (!targetPack) {
        // Use most recent pack
        targetPack = packs[0];
      }

      // Parse mascot from natural language
      // Handle multiple formats:
      // 1. "set mascot [Name] - [description]"
      // 2. "Mascot Configuration for [Token Name] ($TICKER)...\n• Name:\n[Name]\n• Personality:..."
      const fullMascotMatch = text.match(/set\s+mascot\s+([A-Za-z0-9_]+)\s*[-–,]\s*(.+)/is);
      
      // Check for structured "Mascot Configuration" format (pasted from template)
      const configMatch = text.match(/mascot\s*configuration\s*for\s+([^($\n]+)/i);
      
      // Extract sections from the structured format
      const nameSection = text.match(/•?\s*name:?\s*\n?\s*([^\n•]+)/i);
      const personalitySection = text.match(/•?\s*personality:?\s*\n?\s*([\s\S]*?)(?=•\s*(?:speaking|backstory|catchphrase|rule|forbidden|competitor)|$)/i);
      const speakingSection = text.match(/•?\s*speaking\s*style:?\s*\n?\s*([\s\S]*?)(?=•\s*(?:personality|backstory|catchphrase|rule|forbidden|competitor)|$)/i);
      const catchphrasesSection = text.match(/•?\s*catchphrases?:?\s*\n?\s*([\s\S]*?)(?=•\s*(?:personality|speaking|backstory|rule|forbidden|competitor)|$)/i);
      const rulesSection = text.match(/•?\s*rules?\s*(?:\(custom\s*rules?\))?:?\s*\n?\s*([\s\S]*?)(?=•\s*(?:personality|speaking|backstory|catchphrase|forbidden|competitor)|$)/i);
      
      // If we have the structured format with sections
      if ((configMatch || nameSection) && (personalitySection || speakingSection || catchphrasesSection)) {
        console.log('[SET_MASCOT] Detected structured mascot configuration format');
        
        // Extract name
        let mascotName = nameSection ? nameSection[1].trim() : targetPack.brand.name;
        mascotName = mascotName.replace(/^\*+|\*+$/g, '').trim(); // Remove markdown
        
        // Extract personality (clean it up)
        let personality = personalitySection ? personalitySection[1].trim() : '';
        personality = personality.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        if (personality.length > 1000) personality = personality.substring(0, 1000);
        
        // Extract speaking style
        let speakingStyle = speakingSection ? speakingSection[1].trim() : '';
        speakingStyle = speakingStyle.replace(/\n+/g, '; ').trim();
        if (speakingStyle.length > 500) speakingStyle = speakingStyle.substring(0, 500);
        
        // Extract catchphrases (look for quoted lines or bullet points)
        const catchphrases: string[] = [];
        if (catchphrasesSection) {
          const raw = catchphrasesSection[1];
          // Find all quoted phrases
          const quoted = raw.match(/"([^"]+)"/g);
          if (quoted) {
            catchphrases.push(...quoted.map(q => q.replace(/"/g, '').trim()));
          }
          // Also check for lines starting with quotes
          const lines = raw.split('\n').filter(l => l.trim().startsWith('"'));
          lines.forEach(l => {
            const phrase = l.replace(/^["\s]+|["\s]+$/g, '').trim();
            if (phrase && !catchphrases.includes(phrase)) {
              catchphrases.push(phrase);
            }
          });
        }
        
        // Extract rules (look for lines with actual content)
        const rules: string[] = [];
        if (rulesSection) {
          const raw = rulesSection[1];
          const lines = raw.split('\n')
            .map(l => l.replace(/^[\s-*•]+/, '').trim())
            .filter(l => l.length > 10 && !l.startsWith('•'));
          rules.push(...lines);
        }
        
        console.log('[SET_MASCOT] Parsed structured config:', {
          mascotName,
          personalityLen: personality.length,
          speakingStyleLen: speakingStyle.length,
          catchphrasesCount: catchphrases.length,
          rulesCount: rules.length,
        });
        
        // Build the mascot object
        const mascot = {
          name: mascotName,
          personality: personality || undefined,
          speaking_style: speakingStyle || undefined,
          catchphrases: catchphrases.length > 0 ? catchphrases : undefined,
          rules: rules.length > 0 ? rules : undefined,
        };
        
        // Save to store
        await store.update(targetPack.id, { mascot });
        
        // Build response
        let response = `🎭 **Mascot Updated for ${targetPack.brand.name} ($${targetPack.brand.ticker})**\n\n`;
        response += `• **Name:** ${mascot.name}\n`;
        response += `• **Personality:** ${(mascot.personality || '').substring(0, 200)}${(mascot.personality || '').length > 200 ? '...' : ''}\n`;
        if (mascot.speaking_style) {
          response += `• **Speaking style:** ${mascot.speaking_style.substring(0, 100)}${mascot.speaking_style.length > 100 ? '...' : ''}\n`;
        }
        if (mascot.catchphrases && mascot.catchphrases.length > 0) {
          response += `• **Catchphrases:** ${mascot.catchphrases.length} (e.g., "${mascot.catchphrases[0]}")\n`;
        }
        if (mascot.rules && mascot.rules.length > 0) {
          response += `• **Rules:** ${mascot.rules.length} custom rules\n`;
        }
        response += `\nThe agent will now use this personality when interacting in the ${targetPack.brand.name} community group.`;
        
        await callback({
          text: response,
          source: message.content?.source,
          actions: [],
        });
        
        return { text: `Mascot configured for ${targetPack.brand.name}`, success: true };
      }
      
      if (fullMascotMatch) {
        // Full mascot definition in one message
        const mascotName = fullMascotMatch[1].trim();
        const description = fullMascotMatch[2].trim();
        
        console.log('[SET_MASCOT] Parsing mascot:', mascotName);
        console.log('[SET_MASCOT] Full description length:', description.length);
        
        // Use a section-based parser - split by known section headers
        const sectionHeaders = [
          'personality:',
          'speaking style:',
          'speaking_style:',
          'backstory:',
          'catchphrases:',
          'catchphrase:',
          'rules:',
          'rule:',
          'forbidden:',
          'forbidden topics:',
          'competitors:',
          'competitor:',
        ];
        
        // Helper to extract a section's content
        const extractSection = (text: string, sectionName: string): string => {
          // Build regex to find this section and capture until next section or end
          const sectionRegex = new RegExp(
            sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([\\s\\S]*?)(?=' + 
            sectionHeaders.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + 
            '|$)',
            'i'
          );
          const match = text.match(sectionRegex);
          return match ? match[1].trim() : '';
        };
        
        // Extract each section
        let personality = extractSection(description, 'personality:');
        let speakingStyle = extractSection(description, 'speaking style:') || extractSection(description, 'speaking_style:');
        let backstory = extractSection(description, 'backstory:');
        let catchphrasesRaw = extractSection(description, 'catchphrases:') || extractSection(description, 'catchphrase:');
        let rulesRaw = extractSection(description, 'rules:') || extractSection(description, 'rule:');
        let forbiddenRaw = extractSection(description, 'forbidden:') || extractSection(description, 'forbidden topics:');
        let competitorsRaw = extractSection(description, 'competitors:') || extractSection(description, 'competitor:');
        
        // If no personality section found, take everything before first section header
        if (!personality) {
          const firstHeaderIndex = Math.min(
            ...sectionHeaders.map(h => {
              const idx = description.toLowerCase().indexOf(h);
              return idx === -1 ? Infinity : idx;
            })
          );
          if (firstHeaderIndex !== Infinity) {
            personality = description.substring(0, firstHeaderIndex).trim();
          } else {
            // No sections at all, use the whole description
            personality = description;
          }
        }
        
        // Clean up personality - remove trailing periods
        personality = personality.replace(/\.\s*$/, '').trim();
        if (personality.length > 1000) personality = personality.substring(0, 1000);
        
        // Clean up speaking style
        speakingStyle = speakingStyle.replace(/\.\s*$/, '').trim();
        if (speakingStyle.length > 500) speakingStyle = speakingStyle.substring(0, 500);
        
        // Clean up backstory
        backstory = backstory.replace(/\.\s*$/, '').trim();
        if (backstory.length > 500) backstory = backstory.substring(0, 500);
        
        // Parse catchphrases - look for quoted strings or comma-separated
        const catchphrases: string[] = [];
        if (catchphrasesRaw) {
          // First try to extract quoted phrases
          const quotedPhrases = catchphrasesRaw.match(/"([^"]+)"/g);
          if (quotedPhrases && quotedPhrases.length > 0) {
            catchphrases.push(...quotedPhrases.map(p => p.replace(/"/g, '').trim()));
          } else {
            // Try comma-separated (but not if commas are inside phrases)
            const parts = catchphrasesRaw.split(/",\s*"|,\s*(?=")/);
            if (parts.length > 1) {
              catchphrases.push(...parts.map(p => p.replace(/"/g, '').trim()).filter(p => p.length > 3));
            }
          }
        }
        
        // Parse rules - split by commas or line breaks
        const rules: string[] = [];
        if (rulesRaw) {
          // Split by commas followed by "Never" or "Always" or by line breaks
          const ruleParts = rulesRaw.split(/,\s*(?=never|always)|[\n;]/i);
          rules.push(...ruleParts.map(r => r.trim()).filter(r => r.length > 5));
        }
        
        // Parse forbidden topics
        const forbidden: string[] = [];
        if (forbiddenRaw) {
          forbidden.push(...forbiddenRaw.split(/[,;]/).map(f => f.trim()).filter(f => f.length > 2));
        }
        
        // Parse competitors
        const competitors: string[] = [];
        if (competitorsRaw) {
          competitors.push(...competitorsRaw.split(/[,;]/).map(c => c.trim()).filter(c => c.length > 1));
        }
        
        console.log('[SET_MASCOT] Parsed sections:', {
          personality: personality.substring(0, 80) + '...',
          speakingStyle: speakingStyle.substring(0, 80) + '...',
          backstory: backstory ? backstory.substring(0, 50) + '...' : 'none',
          catchphrases: catchphrases.length,
          rules: rules.length,
          forbidden: forbidden.length,
          competitors: competitors.length,
        });
        
        // Build the mascot object
        const mascot = {
          name: mascotName,
          personality: personality,
          speaking_style: speakingStyle || undefined,
          backstory: backstory || undefined,
          catchphrases: catchphrases.length > 0 ? catchphrases : undefined,
          rules: rules.length > 0 ? rules : undefined,
          forbidden_topics: forbidden.length > 0 ? forbidden : undefined,
          competitors: competitors.length > 0 ? competitors : undefined,
        };
        
        // Save to store
        await store.update(targetPack.id, { mascot });
        
        // Build detailed response showing what was saved
        let response = `🎭 **Mascot Updated for ${targetPack.brand.name} ($${targetPack.brand.ticker})**\n\n`;
        response += `• **Name:** ${mascot.name}\n`;
        response += `• **Personality:** ${mascot.personality}\n`;
        if (mascot.speaking_style) {
          response += `• **Speaking style:** ${mascot.speaking_style}\n`;
        }
        if (mascot.backstory) {
          response += `• **Backstory:** ${mascot.backstory}\n`;
        }
        if (mascot.catchphrases && mascot.catchphrases.length > 0) {
          response += `• **Catchphrases (${mascot.catchphrases.length}):**\n`;
          mascot.catchphrases.forEach(c => {
            response += `  - "${c}"\n`;
          });
        }
        if (mascot.rules && mascot.rules.length > 0) {
          response += `• **Rules (${mascot.rules.length}):**\n`;
          mascot.rules.slice(0, 5).forEach(r => {
            response += `  - ${r}\n`;
          });
        }
        if (mascot.forbidden_topics && mascot.forbidden_topics.length > 0) {
          response += `• **Forbidden topics:** ${mascot.forbidden_topics.join(', ')}\n`;
        }
        if (mascot.competitors && mascot.competitors.length > 0) {
          response += `• **Competitors to avoid:** ${mascot.competitors.join(', ')}\n`;
        }
        
        response += `\n✅ The agent will now use this personality when interacting in the ${targetPack.brand.name} community group.`;
        
        await callback({
          text: response,
          source: message.content?.source,
          actions: [],
        });
        
        return { 
          text: `Set mascot ${mascotName} for ${targetPack.brand.name}`, 
          success: true,
          data: { packId: targetPack.id, mascot }
        };
      }

      // Fall back to individual field parsing
      const updates: any = {};
      let updateDescription = '';

      // Mascot name
      const nameMatch = text.match(/mascot\s*name\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i) ||
                       text.match(/name\s*(?:the\s*)?mascot\s*["']?([^"'\n]+)["']?/i) ||
                       text.match(/call\s*(?:the\s*)?mascot\s*["']?([^"'\n]+)["']?/i);
      if (nameMatch) {
        updates.name = nameMatch[1].trim();
        updateDescription += `• Name: ${updates.name}\n`;
      }

      // Personality
      const personalityMatch = text.match(/personality\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i);
      if (personalityMatch) {
        updates.personality = personalityMatch[1].trim();
        updateDescription += `• Personality: ${updates.personality}\n`;
      }

      // Speaking style
      const styleMatch = text.match(/speaking\s*style\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i) ||
                        text.match(/talks?\s*(?:like|in\s*a)?\s*["']?([^"'\n]+)["']?/i);
      if (styleMatch) {
        updates.speaking_style = styleMatch[1].trim();
        updateDescription += `• Speaking style: ${updates.speaking_style}\n`;
      }

      // Backstory
      const backstoryMatch = text.match(/backstory\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i);
      if (backstoryMatch) {
        updates.backstory = backstoryMatch[1].trim();
        updateDescription += `• Backstory: ${updates.backstory}\n`;
      }

      // Catchphrase (add to array)
      const catchphraseMatch = text.match(/(?:add\s*)?catchphrase\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i);
      if (catchphraseMatch) {
        const existing = targetPack.mascot?.catchphrases || [];
        updates.catchphrases = [...existing, catchphraseMatch[1].trim()];
        updateDescription += `• Added catchphrase: "${catchphraseMatch[1].trim()}"\n`;
      }

      // Rule (add to array)
      const ruleMatch = text.match(/(?:add\s*)?rule\s*(?:to|is|:)?\s*["']?([^"'\n]+)["']?/i);
      if (ruleMatch) {
        const existing = targetPack.mascot?.rules || [];
        updates.rules = [...existing, ruleMatch[1].trim()];
        updateDescription += `• Added rule: "${ruleMatch[1].trim()}"\n`;
      }

      // Forbidden topic (add to array)
      const forbiddenMatch = text.match(/(?:never\s*mention|forbidden|don'?t\s*(?:talk|mention))\s*(?:about)?\s*["']?([^"'\n]+)["']?/i);
      if (forbiddenMatch) {
        const existing = targetPack.mascot?.forbidden_topics || [];
        updates.forbidden_topics = [...existing, forbiddenMatch[1].trim()];
        updateDescription += `• Forbidden topic: "${forbiddenMatch[1].trim()}"\n`;
      }

      // Competitor (add to array)
      const competitorMatch = text.match(/competitor\s*(?:token|is|:)?\s*["']?([^"'\n]+)["']?/i);
      if (competitorMatch) {
        const existing = targetPack.mascot?.competitors || [];
        updates.competitors = [...existing, competitorMatch[1].trim()];
        updateDescription += `• Competitor to avoid: "${competitorMatch[1].trim()}"\n`;
      }

      if (Object.keys(updates).length === 0) {
        await callback({
          text: `🎭 **Mascot Configuration for ${targetPack.brand.name} ($${targetPack.brand.ticker})**\n\n` +
            `Current settings:\n` +
            `• Name: ${targetPack.mascot?.name || '(not set)'}\n` +
            `• Personality: ${targetPack.mascot?.personality || '(not set)'}\n` +
            `• Speaking style: ${targetPack.mascot?.speaking_style || '(not set)'}\n` +
            `• Catchphrases: ${(targetPack.mascot?.catchphrases || []).join(', ') || '(none)'}\n` +
            `• Rules: ${(targetPack.mascot?.rules || []).length} custom rules\n\n` +
            `To configure, try:\n` +
            `• "Set mascot name to Ruggy"\n` +
            `• "Set personality to chaotic and meme-loving"\n` +
            `• "Add catchphrase: LFG!"\n` +
            `• "Never mention DOGE in this group"`,
          source: message.content?.source,
        });
        return { text: 'Showed current mascot config', success: true };
      }

      // Apply updates
      const currentMascot = targetPack.mascot || {};
      await store.update(targetPack.id, {
        mascot: { ...currentMascot, ...updates },
      });

      await callback({
        text: `🎭 **Mascot Updated for ${targetPack.brand.name} ($${targetPack.brand.ticker})**\n\n` +
          `${updateDescription}\n` +
          `The agent will now use this personality when interacting in the ${targetPack.brand.name} community group.`,
        source: message.content?.source,
        actions: [],
      });

      return { 
        text: `Updated mascot for ${targetPack.brand.name}`, 
        success: true,
        data: { packId: targetPack.id, updates }
      };
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error('[SET_MASCOT] Error:', errMsg);
      await callback({
        text: `❌ Error configuring mascot: ${errMsg}`,
        source: message.content?.source,
      });
      return { text: `Error: ${errMsg}`, success: false };
    }
  },
  
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'set the mascot name to Ruggy' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Setting mascot name...',
          action: 'SET_MASCOT',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'set personality to chaotic, meme-obsessed, always bullish' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Updating mascot personality...',
          action: 'SET_MASCOT',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'add catchphrase: Rug or be rugged!' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Adding catchphrase...',
          action: 'SET_MASCOT',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'never mention DOGE in this group' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Adding forbidden topic...',
          action: 'SET_MASCOT',
        },
      },
    ],
  ],
};

export default setMascotAction;
