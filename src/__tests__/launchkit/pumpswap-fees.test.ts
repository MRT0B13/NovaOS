/**
 * Tests for pumpswapFees.ts — fee summary, formatting
 */
import { describe, expect, it } from 'bun:test';

describe('pumpswapFees', () => {
  describe('getFeesSummary()', () => {
    it('returns empty summary when no fees tracked', async () => {
      const { getFeesSummary } = await import('../../launchkit/services/pumpswapFees.ts');
      const summary = getFeesSummary();
      expect(summary.totalFeesSOL).toBe(0);
      expect(summary.feesByToken).toEqual([]);
      expect(summary.lastUpdated).toBeTruthy();
    });
  });

  describe('formatFeesForTweet()', () => {
    it('returns empty string when no fees', async () => {
      const { formatFeesForTweet } = await import('../../launchkit/services/pumpswapFees.ts');
      const text = formatFeesForTweet({
        totalFeesSOL: 0,
        totalFeesUSD: 0,
        feesByToken: [],
        lastUpdated: new Date().toISOString(),
      });
      expect(text).toBe('');
    });

    it('formats fee summary with SOL amounts', async () => {
      const { formatFeesForTweet } = await import('../../launchkit/services/pumpswapFees.ts');
      const text = formatFeesForTweet({
        totalFeesSOL: 0.0523,
        totalFeesUSD: 0,
        feesByToken: [
          { mint: 'abc', ticker: 'NOVA', feesSOL: 0.0523, feesUSD: 0 },
        ],
        lastUpdated: new Date().toISOString(),
      });
      expect(text).toContain('0.0523 SOL');
      expect(text).toContain('$NOVA');
      expect(text).toContain('PumpSwap');
      expect(text).toContain('verifiable');
    });

    it('limits to 3 tokens in tweet', async () => {
      const { formatFeesForTweet } = await import('../../launchkit/services/pumpswapFees.ts');
      const text = formatFeesForTweet({
        totalFeesSOL: 0.1,
        totalFeesUSD: 0,
        feesByToken: [
          { mint: 'a', ticker: 'A', feesSOL: 0.04, feesUSD: 0 },
          { mint: 'b', ticker: 'B', feesSOL: 0.03, feesUSD: 0 },
          { mint: 'c', ticker: 'C', feesSOL: 0.02, feesUSD: 0 },
          { mint: 'd', ticker: 'D', feesSOL: 0.01, feesUSD: 0 },
        ],
        lastUpdated: new Date().toISOString(),
      });
      expect(text).toContain('$A');
      expect(text).toContain('$B');
      expect(text).toContain('$C');
      expect(text).not.toContain('$D'); // Only top 3
    });
  });

  describe('formatFeesForTelegram()', () => {
    it('returns empty string when no fees', async () => {
      const { formatFeesForTelegram } = await import('../../launchkit/services/pumpswapFees.ts');
      const html = formatFeesForTelegram({
        totalFeesSOL: 0,
        totalFeesUSD: 0,
        feesByToken: [],
        lastUpdated: new Date().toISOString(),
      });
      expect(html).toBe('');
    });

    it('generates HTML with bold token amounts', async () => {
      const { formatFeesForTelegram } = await import('../../launchkit/services/pumpswapFees.ts');
      const html = formatFeesForTelegram({
        totalFeesSOL: 0.05,
        totalFeesUSD: 0,
        feesByToken: [
          { mint: 'abc', ticker: 'NOVA', feesSOL: 0.05, feesUSD: 0 },
        ],
        lastUpdated: new Date().toISOString(),
      });
      expect(html).toContain('<b>');
      expect(html).toContain('$NOVA');
      expect(html).toContain('0.0500 SOL');
    });
  });
});
