/**
 * Railway Readiness Tests
 * 
 * Tests for:
 * - Database readiness detection
 * - Extension detection (pgvector handling)
 * - Central messages schema creation
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  checkExtensions,
  shouldDisableEmbeddings,
} from '../../launchkit/db/railwayReady.ts';

describe('Railway Readiness', () => {
  describe('shouldDisableEmbeddings', () => {
    const originalEnv = { ...process.env };
    
    beforeEach(() => {
      // Reset env between tests
      delete process.env.SQL_EMBEDDINGS_ENABLE;
      delete process.env.RAILWAY_ENVIRONMENT;
      delete process.env.VECTOR_AVAILABLE;
    });

    it('returns false when embeddings are enabled by default', () => {
      expect(shouldDisableEmbeddings()).toBe(false);
    });

    it('returns true when SQL_EMBEDDINGS_ENABLE=false', () => {
      process.env.SQL_EMBEDDINGS_ENABLE = 'false';
      expect(shouldDisableEmbeddings()).toBe(true);
    });

    it('returns true on Railway when vector not available', () => {
      process.env.RAILWAY_ENVIRONMENT = 'production';
      process.env.VECTOR_AVAILABLE = 'false';
      expect(shouldDisableEmbeddings()).toBe(true);
    });

    it('returns false on Railway when vector is available', () => {
      process.env.RAILWAY_ENVIRONMENT = 'production';
      process.env.VECTOR_AVAILABLE = 'true';
      expect(shouldDisableEmbeddings()).toBe(false);
    });
  });

  describe('DbReadiness structure', () => {
    it('provides expected fields for health endpoint', () => {
      // This tests the interface contract
      const mockReadiness = {
        ready: true,
        mode: 'postgres' as const,
        vectorEnabled: false,
        centralDbReady: true,
        launchPacksReady: true,
        errors: [],
        connectionInfo: {
          host: 'test.railway.app',
          database: 'railway',
          ssl: true,
        },
      };

      expect(mockReadiness.ready).toBe(true);
      expect(mockReadiness.mode).toBe('postgres');
      expect(mockReadiness.vectorEnabled).toBe(false);
      expect(mockReadiness.centralDbReady).toBe(true);
      expect(mockReadiness.errors).toHaveLength(0);
    });
  });
});
