import { type IAgentRuntime, type Memory, type Provider, type State } from '@elizaos/core';
import { getGroupContext } from '../eliza/groupContextProvider.ts';
import { cacheTelegramUser } from '../services/telegramCommunity.ts';

/**
 * Minimal recent messages provider - fetches conversation history without world/server dependencies
 * Also injects group-specific context for Telegram communities
 * AND caches Telegram user info for kick/ban functionality
 */
export const recentMessagesProvider: Provider = {
  name: 'RECENT_MESSAGES',
  description: 'Recent conversation messages and group context',
  position: 100,
  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    try {
      const { roomId } = message;
      const conversationLength = runtime.getConversationLength();
      
      // Try to extract and cache Telegram user info from the message
      // This helps the kick action find user IDs later
      if (message.content?.source === 'telegram' && message.entityId) {
        try {
          const room = await runtime.getRoom(roomId as any);
          const chatId = room?.channelId;
          
          if (chatId) {
            // Get entity to find user name
            const entity = await runtime.getEntityById(message.entityId as any);
            const userName = entity?.names?.[0] || (entity?.metadata as any)?.telegram?.name;
            
            // Check if there's raw Telegram data in the message
            const rawTg = (message as any).rawTelegram || 
                          (message.content as any).rawTelegram ||
                          (message.content as any).telegram ||
                          (message.content as any).originalMessage;
            
            if (rawTg?.from?.id) {
              // We have the Telegram user ID! Cache it
              cacheTelegramUser(chatId, {
                id: rawTg.from.id,
                username: rawTg.from.username,
                firstName: rawTg.from.first_name,
                lastName: rawTg.from.last_name,
              }, rawTg.message_id, message.entityId as string);
            } else if (userName) {
              // Log that we don't have the ID but we have a name
              console.log(`[RECENT_MESSAGES] TG user "${userName}" - no raw user_id available (entityId: ${message.entityId})`);
            }
          }
        } catch (e) {
          // Don't fail the provider if caching fails
          console.log('[RECENT_MESSAGES] Could not cache TG user:', e);
        }
      }

      // Get group-specific context (mascot personality, token info, etc.)
      const groupContext = await getGroupContext(runtime, message);
      console.log(`[RECENT_MESSAGES] Group context: hasLinkedPack=${groupContext?.values?.hasLinkedPack}, text length=${groupContext?.text?.length || 0}`);

      // Fetch recent messages from the room
      const recentMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: Math.max(conversationLength, 10),
        unique: false,
      });

      if (!recentMessages || recentMessages.length === 0) {
        return {
          data: { recentMessages: [], groupContext: groupContext?.data },
          values: { hasRecentMessages: false, ...groupContext?.values },
          text: groupContext?.text || 'No recent messages available.',
        };
      }

      // Sort by timestamp
      const sortedMessages = recentMessages.sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
      );

      // Internal jargon that should never leak into community prompts
      const INTERNAL_JARGON = [
        'launchpack', 'launch pack', 'link this group', 'link a group',
        'linked to a', 'chat_id', 'chat id', 'numeric chat', 'telegram chat id',
        'getidsbot', '@getidsbot', 'link an existing', 'set up a new token',
        'brainstorm a killer token', 'get one off the ground',
      ];

      // Sanitize: redact Nova's own messages that contain internal jargon
      // so the LLM doesn't continue those threads from memory
      function sanitizeMessage(text: string, isAgent: boolean): string | null {
        if (!isAgent || !text) return text;
        const lower = text.toLowerCase();
        if (INTERNAL_JARGON.some(term => lower.includes(term))) {
          return null; // Drop the message entirely — it's contaminated
        }
        return text;
      }

      // Format messages for display
      const formattedMessages = sortedMessages
        .slice(-10) // Last 10 messages
        .map((mem) => {
          const isAgent = mem.entityId === runtime.agentId;
          const sender = isAgent ? runtime.character.name : 'User';
          const text = sanitizeMessage(mem.content.text as string, isAgent);
          if (!text) return null; // Skip contaminated messages
          return `${sender}: ${text}`;
        })
        .filter(Boolean)
        .join('\n');

      // Combine group context with recent messages
      const contextParts = [];
      if (groupContext?.text) {
        contextParts.push(groupContext.text);
      }
      contextParts.push(`# Recent Conversation\n${formattedMessages}`);

      return {
        data: {
          recentMessages: sortedMessages,
          messageCount: sortedMessages.length,
          groupContext: groupContext?.data,
        },
        values: {
          hasRecentMessages: true,
          messageCount: sortedMessages.length,
          recentMessagesText: formattedMessages,
          ...groupContext?.values,
        },
        text: contextParts.join('\n\n'),
      };
    } catch (error) {
      console.error('Error in recentMessagesProvider:', error);
      return {
        data: { recentMessages: [] },
        values: { hasRecentMessages: false },
        text: 'Error retrieving recent messages.',
      };
    }
  },
};
