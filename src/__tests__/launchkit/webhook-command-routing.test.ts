/**
 * Tests that known slash commands are NOT forwarded to ElizaOS.
 *
 * The actual webhook handler lives in server.ts.  We replicate the exact
 * command-detection logic here so we can verify it deterministically without
 * spinning up an HTTP server or mocking 10+ services.
 */
import { describe, expect, it } from 'bun:test';

// ─── Replicate the exact constant & extraction logic from server.ts ────────
const KNOWN_BOT_COMMANDS = new Set([
  '/ban', '/kick', '/roseban', '/banned',
  '/health', '/errors', '/repairs',
  '/scan', '/children',
  '/request_agent', '/approve_agent',
  '/reject_agent', '/my_agents', '/stop_agent',
  '/cfo', '/help',
]);

/** Mirrors the token extraction in the webhook handler */
function extractCommandToken(text: string): string {
  return text.split(/\s/)[0]?.split('@')[0] || '';
}

function shouldSkipElizaForward(msgText: string): boolean {
  const cmdToken = extractCommandToken(msgText);
  return KNOWN_BOT_COMMANDS.has(cmdToken);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook command routing – KNOWN_BOT_COMMANDS gate', () => {
  describe('slash commands that SHOULD be intercepted (not forwarded to Eliza)', () => {
    const intercepted = [
      '/cfo',
      '/cfo status',
      '/cfo portfolio',
      '/cfo@NovaBot status',
      '/health',
      '/health@NovaBot',
      '/errors',
      '/repairs',
      '/scan',
      '/scan 0xabc123',
      '/children',
      '/ban @spammer',
      '/kick @spammer',
      '/roseban @spammer reason',
      '/banned',
      '/request_agent MyAgent',
      '/approve_agent 123',
      '/reject_agent 123',
      '/my_agents',
      '/stop_agent 123',
      '/help',
    ];

    for (const msg of intercepted) {
      it(`skips Eliza forward for "${msg}"`, () => {
        expect(shouldSkipElizaForward(msg)).toBe(true);
      });
    }
  });

  describe('messages that SHOULD be forwarded to Eliza', () => {
    const forwarded = [
      '',
      'hello',
      'what is /cfo?',           // not at start
      'how do I use /health',    // not at start
      '/unknown_command',        // not in our set
      '/start',                  // Telegram default, not ours
      'gm everyone',
      '🚀 moon soon',
    ];

    for (const msg of forwarded) {
      it(`forwards to Eliza: "${msg || '(empty)'}"`, () => {
        expect(shouldSkipElizaForward(msg)).toBe(false);
      });
    }
  });

  describe('command token extraction', () => {
    it('strips @BotName suffix', () => {
      expect(extractCommandToken('/cfo@NovaBot status')).toBe('/cfo');
    });

    it('handles plain command', () => {
      expect(extractCommandToken('/cfo')).toBe('/cfo');
    });

    it('handles command with args', () => {
      expect(extractCommandToken('/ban @spammer reason')).toBe('/ban');
    });

    it('returns empty for empty string', () => {
      expect(extractCommandToken('')).toBe('');
    });

    it('returns word for non-command text', () => {
      expect(extractCommandToken('hello world')).toBe('hello');
    });
  });

  describe('KNOWN_BOT_COMMANDS completeness', () => {
    it('contains all 16 registered commands', () => {
      expect(KNOWN_BOT_COMMANDS.size).toBe(16);
    });

    // Cross-check against the bot.command() registrations in the codebase
    const expectedCommands = [
      // telegramBanHandler.ts
      '/ban', '/kick', '/roseban', '/banned',
      // telegramHealthCommands.ts
      '/health', '/errors', '/repairs',
      // telegramScanCommand.ts
      '/scan', '/children',
      // telegramFactoryCommands.ts
      '/request_agent', '/approve_agent', '/reject_agent',
      '/my_agents', '/stop_agent', '/cfo', '/help',
    ];

    for (const cmd of expectedCommands) {
      it(`includes ${cmd}`, () => {
        expect(KNOWN_BOT_COMMANDS.has(cmd)).toBe(true);
      });
    }
  });
});
