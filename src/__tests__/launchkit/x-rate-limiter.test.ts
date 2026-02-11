/**
 * Tests for xRateLimiter.ts — pay-per-use read budget + free-tier write tracking
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// Snapshot env
const envSnapshot = { ...process.env } as Record<string, string>;

beforeEach(() => {
  // Reset module-level state by clearing env and re-importing
  process.env.X_MONTHLY_WRITE_LIMIT = '500';
  process.env.X_MONTHLY_READ_LIMIT = '100';
  delete process.env.X_READ_BUDGET_USD;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
});

// ============================================================================
// Tests — we dynamically import to pick up env changes
// ============================================================================

describe('xRateLimiter', () => {
  describe('canWrite()', () => {
    it('returns true when writes are under limit', async () => {
      const { canWrite, getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      // Fresh state: 0 writes used out of 500
      expect(canWrite()).toBe(true);
      const quota = getQuota();
      expect(quota.writes.limit).toBe(500);
    });
  });

  describe('canRead() — hard cap mode (X_READ_BUDGET_USD=0)', () => {
    it('uses X_MONTHLY_READ_LIMIT when no budget set', async () => {
      delete process.env.X_READ_BUDGET_USD;
      process.env.X_MONTHLY_READ_LIMIT = '100';
      const { getQuota, isPayPerUseReads } = await import('../../launchkit/services/xRateLimiter.ts');
      expect(isPayPerUseReads()).toBe(false);
      const quota = getQuota();
      expect(quota.reads.limit).toBe(100);
    });
  });

  describe('canRead() — pay-per-use mode (X_READ_BUDGET_USD > 0)', () => {
    it('derives read limit from budget at $0.005/read', async () => {
      process.env.X_READ_BUDGET_USD = '5';
      const { getQuota, isPayPerUseReads } = await import('../../launchkit/services/xRateLimiter.ts');
      expect(isPayPerUseReads()).toBe(true);
      const quota = getQuota();
      // $5 / $0.005 per read = 1000 reads
      expect(quota.reads.limit).toBe(1000);
    });

    it('$10 budget = 2000 reads', async () => {
      process.env.X_READ_BUDGET_USD = '10';
      const { getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      expect(getQuota().reads.limit).toBe(2000);
    });

    it('$1 budget = 200 reads', async () => {
      process.env.X_READ_BUDGET_USD = '1';
      const { getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      expect(getQuota().reads.limit).toBe(200);
    });
  });

  describe('getReadSpendUsd()', () => {
    it('tracks spend in dollars', async () => {
      const { recordRead, getReadSpendUsd } = await import('../../launchkit/services/xRateLimiter.ts');
      const spendBefore = getReadSpendUsd();
      await recordRead();
      const spendAfter = getReadSpendUsd();
      // Each read costs $0.005
      expect(spendAfter - spendBefore).toBeCloseTo(0.005, 4);
    });
  });

  describe('recordWrite()', () => {
    it('increments write counter', async () => {
      const { recordWrite, getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      const before = getQuota().writes.used;
      await recordWrite('test tweet');
      const after = getQuota().writes.used;
      expect(after).toBe(before + 1);
    });

    it('stores write history', async () => {
      const { recordWrite, getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      await recordWrite('test tweet text');
      expect(getQuota().lastWrite).not.toBeNull();
    });
  });

  describe('getPostingAdvice()', () => {
    it('returns canPost=true when quota available', async () => {
      const { getPostingAdvice } = await import('../../launchkit/services/xRateLimiter.ts');
      const advice = getPostingAdvice();
      expect(advice.canPost).toBe(true);
      expect(advice.shouldPost).toBe(true);
    });
  });

  describe('getUsageSummary()', () => {
    it('shows dollar spend in pay-per-use mode', async () => {
      process.env.X_READ_BUDGET_USD = '5';
      const { getUsageSummary } = await import('../../launchkit/services/xRateLimiter.ts');
      const summary = getUsageSummary();
      expect(summary).toContain('$');
      expect(summary).toContain('budget');
      expect(summary).toContain('[FREE]');
    });

    it('shows count/limit in hard cap mode', async () => {
      delete process.env.X_READ_BUDGET_USD;
      const { getUsageSummary } = await import('../../launchkit/services/xRateLimiter.ts');
      const summary = getUsageSummary();
      expect(summary).toContain('/');
      expect(summary).toContain('% used');
    });
  });

  describe('safeTweet()', () => {
    it('calls tweetFn and records write on success', async () => {
      const { safeTweet, getQuota } = await import('../../launchkit/services/xRateLimiter.ts');
      const beforeWrites = getQuota().writes.used;
      const result = await safeTweet(
        async () => ({ id: '12345' }),
        'safe tweet test'
      );
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ id: '12345' });
      expect(getQuota().writes.used).toBe(beforeWrites + 1);
    });

    it('returns error when tweetFn throws', async () => {
      const { safeTweet } = await import('../../launchkit/services/xRateLimiter.ts');
      const result = await safeTweet(
        async () => { throw new Error('API error'); },
        'failing tweet'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });
  });
});
