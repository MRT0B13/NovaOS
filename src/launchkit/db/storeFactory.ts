import path from 'node:path';
import { logger } from '@elizaos/core';
import { LaunchPackRepository, type LaunchPackStore } from './launchPackRepository.ts';
import { PostgresLaunchPackRepository } from './postgresLaunchPackRepository.ts';
import { getEnv } from '../env.ts';
import { createSecretsStoreFromEnv, type SecretsStoreWithClose } from '../services/secrets.ts';
import { checkDatabaseReadiness, logDbReadinessSummary } from './railwayReady.ts';

export type LaunchPackStoreWithClose = LaunchPackStore & { close?: () => Promise<void> };

export async function createLaunchPackStoreFromEnv(): Promise<LaunchPackStoreWithClose> {
  const env = getEnv();
  if (env.DATABASE_URL) {
    // Log DB mode at startup
    logger.info('[StoreFactory] Using PostgreSQL (DATABASE_URL detected)');
    
    // Run Railway readiness check (ensures central_messages schema, etc.)
    const readiness = await checkDatabaseReadiness(env.DATABASE_URL);
    logDbReadinessSummary(readiness);
    
    // Set env flag for downstream code to know vector status
    if (!readiness.vectorEnabled) {
      process.env.VECTOR_AVAILABLE = 'false';
    }
    
    const store = await PostgresLaunchPackRepository.create(env.DATABASE_URL);
    return store as LaunchPackStoreWithClose;
  }

  // PGlite mode
  logger.info('[StoreFactory] Using PGlite (no DATABASE_URL)');
  const dataDir = env.PGLITE_DATA_DIR || '.pglite';
  const dbPath = path.join(dataDir, 'launchkit.db');
  const store = await LaunchPackRepository.create(dbPath);
  return store as LaunchPackStoreWithClose;
}

export async function createSecretsStore(): Promise<SecretsStoreWithClose> {
  return createSecretsStoreFromEnv();
}
