import type { Action, HandlerCallback, IAgentRuntime, Memory, State, ActionExample } from '@elizaos/core';
import { composePromptFromState, ModelType, logger, parseKeyValueXml } from '@elizaos/core';
import { recordMessageReceived } from '../services/telegramHealthMonitor.ts';

/**
 * Custom REPLY action that skips itself when certain other actions should handle the response.
 * This prevents duplicate messages when actions like VERIFY_TELEGRAM_SETUP handle their own responses.
 */

const replyTemplate = `# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

// Actions that handle their own responses - REPLY should skip when these are active
const SELF_RESPONDING_ACTIONS = [
  'VERIFY_TELEGRAM_SETUP',
  'VERIFY_TG',
  'LINK_TELEGRAM_GROUP',
  'CHECK_WALLET_BALANCES',
  'PRE_LAUNCH_CHECKLIST',
  'DELETE_LAUNCHPACK',
  'LIST_LAUNCHPACKS',
];

export const customReplyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description: 'Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action.',
  
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    // Record that we received a message (for health monitoring)
    recordMessageReceived();
    
    const text = String(message.content?.text ?? '').toLowerCase();
    
    // Check if this message should be handled by a self-responding action instead
    const hasVerifyIntent = /verif|check.*telegram|telegram.*setup|telegram.*status/i.test(text);
    const hasLinkIntent = /link.*telegram|link.*-\d{10,}|connect.*group/.test(text);
    const hasWalletIntent = /check.*wallet|wallet.*balance|show.*balance/i.test(text);
    const hasChecklistIntent = /checklist|pre.*launch.*check/i.test(text);
    const hasDeleteIntent = /delete.*all|clear.*token|remove.*launchpack/i.test(text);
    const hasListIntent = /list.*launchpack|show.*launchpack|my.*token/i.test(text);
    
    // If any self-responding action should handle this, skip REPLY
    if (hasVerifyIntent || hasLinkIntent || hasWalletIntent || hasChecklistIntent || hasDeleteIntent || hasListIntent) {
      logger.debug('[CUSTOM_REPLY] Skipping REPLY - another action will handle response');
      return false;
    }
    
    return true;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) => {
    // Check if any responses had providers associated with them
    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];

    // Compose state with providers
    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      'RECENT_MESSAGES',
      'ACTION_STATE',
    ]);

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate,
    });

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response
      const parsedXml = parseKeyValueXml(response);
      const thought = typeof parsedXml?.thought === 'string' ? parsedXml.thought : '';
      const text = typeof parsedXml?.text === 'string' ? parsedXml.text : '';

      const responseContent = {
        thought,
        text,
        actions: ['REPLY'] as string[],
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        text: `Generated reply: ${responseContent.text}`,
        values: {
          success: true,
          responded: true,
          lastReply: responseContent.text,
          lastReplyTime: Date.now(),
          thoughtProcess: thought,
        },
        data: {
          actionName: 'REPLY',
          response: responseContent,
          thought,
          messageGenerated: true,
        },
        success: true,
      };
    } catch (error) {
      logger.error(
        {
          src: 'launchkit:action:custom_reply',
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error generating response'
      );

      return {
        text: 'Error generating reply',
        values: {
          success: false,
          responded: false,
          error: true,
        },
        data: {
          actionName: 'REPLY',
          error: error instanceof Error ? error.message : String(error),
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
  
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hello there!',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Hi! How can I help you today?',
          actions: ['REPLY'],
        },
      },
    ],
  ] as ActionExample[][],
};
