/**
 * Tests for xReplyEngine.ts — engine lifecycle, status, pay-per-use awareness
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const envSnapshot = { ...process.env } as Record<string, string>;

beforeEach(() => {
  process.env.X_REPLY_ENGINE_ENABLE = 'false'; // Keep disabled so engine doesn't actually start
  process.env.X_ENABLE = 'false';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
});

describe('xReplyEngine', () => {
  describe('getReplyEngineStatus()', () => {
    it('returns status object', async () => {
      const { getReplyEngineStatus } = await import('../../launchkit/services/xReplyEngine.ts');
      const status = getReplyEngineStatus();
      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('repliesToday');
      expect(status).toHaveProperty('lastReplyAt');
      expect(status).toHaveProperty('trackedCount');
      expect(typeof status.running).toBe('boolean');
      expect(typeof status.repliesToday).toBe('number');
    });
  });

  describe('startReplyEngine()', () => {
    it('does not start when X_REPLY_ENGINE_ENABLE=false', async () => {
      process.env.X_REPLY_ENGINE_ENABLE = 'false';
      const { startReplyEngine, getReplyEngineStatus } = await import('../../launchkit/services/xReplyEngine.ts');
      startReplyEngine();
      expect(getReplyEngineStatus().running).toBe(false);
    });

    it('does not start when X_ENABLE=false', async () => {
      process.env.X_REPLY_ENGINE_ENABLE = 'true';
      process.env.X_ENABLE = 'false';
      const { startReplyEngine, getReplyEngineStatus } = await import('../../launchkit/services/xReplyEngine.ts');
      startReplyEngine();
      expect(getReplyEngineStatus().running).toBe(false);
    });
  });

  describe('stopReplyEngine()', () => {
    it('sets running to false', async () => {
      const { stopReplyEngine, getReplyEngineStatus } = await import('../../launchkit/services/xReplyEngine.ts');
      stopReplyEngine();
      expect(getReplyEngineStatus().running).toBe(false);
    });
  });
});
