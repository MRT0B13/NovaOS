// CRITICAL: ElizaOS uses POSTGRES_URL, but Railway injects DATABASE_URL
// Map DATABASE_URL → POSTGRES_URL before any ElizaOS code runs
if (process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
  console.log('[Nova] Mapped DATABASE_URL → POSTGRES_URL for ElizaOS compatibility');
}

// ── Silence Telegraf 409 webhook/polling conflict ──────────────────────────
// When Railway manages the webhook, ElizaOS's Telegram plugin may still try
// getUpdates (polling), which Telegram rejects with "409: terminated by
// setWebhook request". This is harmless — Railway delivers updates via webhook.
// Without this handler, Node crashes with an unhandled promise rejection.
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message ?? String(reason ?? '');
  if (msg.includes('409') && msg.includes('terminated by setWebhook')) {
    // Expected in webhook mode — Railway handles delivery, polling is dead
    return;
  }
  // Let everything else surface normally
  console.error('[unhandledRejection]', reason);
});

import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import launchkitPlugin from './plugin.ts';
import { character } from './character.ts';

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info('Initializing character');
  logger.info({ name: character.name }, 'Name:');
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [launchkitPlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export { character } from './character.ts';

export default project;
