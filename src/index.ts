// CRITICAL: ElizaOS uses POSTGRES_URL, but Railway injects DATABASE_URL
// Map DATABASE_URL → POSTGRES_URL before any ElizaOS code runs
if (process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
  console.log('[Nova] Mapped DATABASE_URL → POSTGRES_URL for ElizaOS compatibility');
}

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
