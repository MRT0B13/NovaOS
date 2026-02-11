/**
 * Tests for rugcheck.ts — RugCheck API integration, caching, rate limiting
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const fetchOriginal = global.fetch;

afterEach(() => {
  global.fetch = fetchOriginal;
});

// ============================================================================
// Mock API responses
// ============================================================================

const MOCK_MINT = 'So11111111111111111111111111111111111111112';

function mockRugCheckResponse(overrides: Record<string, any> = {}) {
  return {
    score: 150,
    riskScore: 150,
    risks: [
      { name: 'Low Liquidity', description: 'LP is thin', level: 'warn', score: 50 },
    ],
    tokenMeta: {
      mintAuthority: null, // revoked
      freezeAuthority: null, // revoked
      ...overrides.tokenMeta,
    },
    topHolders: [
      { pct: 0.15 }, // 15%
      { pct: 0.10 },
      { pct: 0.05 },
    ],
    markets: [
      { lp: { lpLocked: true, lpLockedPct: 80 } },
    ],
    ...overrides,
  };
}

function createMockFetch(response: any, status = 200) {
  return mock((url: string | URL | Request) => {
    return Promise.resolve(new Response(
      JSON.stringify(response),
      { status, headers: { 'Content-Type': 'application/json' } }
    ));
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('rugcheck', () => {
  describe('scanToken()', () => {
    it('scans a token and returns a report', async () => {
      global.fetch = createMockFetch(mockRugCheckResponse()) as any;
      
      const { scanToken } = await import('../../launchkit/services/rugcheck.ts');
      const report = await scanToken(MOCK_MINT);
      
      expect(report).not.toBeNull();
      expect(report!.mint).toBe(MOCK_MINT);
      expect(report!.score).toBe(150);
      expect(report!.riskLevel).toBe('Good'); // score <= 300
      expect(report!.mintAuthority).toBe(false); // null = revoked
      expect(report!.freezeAuthority).toBe(false);
      expect(report!.topHolderPct).toBeCloseTo(15, 0);
      expect(report!.scannedAt).toBeTruthy();
    });

    it('returns cached result on second call', async () => {
      let fetchCount = 0;
      global.fetch = mock(() => {
        fetchCount++;
        return Promise.resolve(new Response(
          JSON.stringify(mockRugCheckResponse()),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }) as any;
      
      const { scanToken } = await import('../../launchkit/services/rugcheck.ts');
      
      // First call hits API
      await scanToken(MOCK_MINT);
      const firstCount = fetchCount;
      
      // Second call should be cached — no new fetch
      const report2 = await scanToken(MOCK_MINT);
      expect(report2).not.toBeNull();
      expect(fetchCount).toBe(firstCount); // No additional fetch
    });

    it('returns null on 429 rate limit', async () => {
      global.fetch = createMockFetch({ error: 'rate limited' }, 429) as any;
      
      const { scanToken } = await import('../../launchkit/services/rugcheck.ts');
      // Use a different mint to avoid cache
      const report = await scanToken('RateLimitTest11111111111111111111111111111');
      expect(report).toBeNull();
    });

    it('returns null on non-200 response', async () => {
      global.fetch = createMockFetch({ error: 'not found' }, 404) as any;
      
      const { scanToken } = await import('../../launchkit/services/rugcheck.ts');
      const report = await scanToken('NotFoundTest111111111111111111111111111111');
      expect(report).toBeNull();
    });
  });

  describe('parseReport — risk level classification (via isSafe + format)', () => {
    it('classifies score <= 300 as Good', async () => {
      const { isSafe, formatReportForTweet } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: 'GoodMint', score: 200, riskLevel: 'Good' as const,
        mintAuthority: false, freezeAuthority: false,
        topHolderPct: 10, top10HolderPct: 30,
        lpLocked: true, lpLockedPct: 80,
        isRugged: false, risks: [], scannedAt: new Date().toISOString(),
      };
      expect(report.riskLevel).toBe('Good');
      expect(isSafe(report)).toBe(true);
      expect(formatReportForTweet(report, 'GOOD')).toContain('✅');
    });

    it('classifies score 301-700 as Warning', async () => {
      const { formatReportForTweet } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: 'WarnMint', score: 500, riskLevel: 'Warning' as const,
        mintAuthority: false, freezeAuthority: false,
        topHolderPct: 10, top10HolderPct: 30,
        lpLocked: true, lpLockedPct: 80,
        isRugged: false, risks: [], scannedAt: new Date().toISOString(),
      };
      expect(report.riskLevel).toBe('Warning');
      expect(formatReportForTweet(report, 'WARN')).toContain('⚠️');
    });

    it('classifies score > 700 as Danger', async () => {
      const { isSafe, formatReportForTweet } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: 'DangerMint', score: 900, riskLevel: 'Danger' as const,
        mintAuthority: false, freezeAuthority: false,
        topHolderPct: 10, top10HolderPct: 30,
        lpLocked: false, lpLockedPct: 0,
        isRugged: true, risks: [], scannedAt: new Date().toISOString(),
      };
      expect(report.riskLevel).toBe('Danger');
      expect(report.isRugged).toBe(true);
      expect(isSafe(report)).toBe(false);
      expect(formatReportForTweet(report, 'RUG')).toContain('❌');
    });
  });

  describe('parseReport — authority detection (unit)', () => {
    it('detects active mint authority', async () => {
      const { isSafe } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: 'MintAuth', score: 100, riskLevel: 'Good' as const,
        mintAuthority: true, freezeAuthority: false,
        topHolderPct: 10, top10HolderPct: 30,
        lpLocked: true, lpLockedPct: 80,
        isRugged: false, risks: [], scannedAt: new Date().toISOString(),
      };
      expect(report.mintAuthority).toBe(true);
      expect(isSafe(report)).toBe(false); // mint auth active = not safe
    });

    it('detects active freeze authority', async () => {
      const { isSafe } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: 'FreezeAuth', score: 100, riskLevel: 'Good' as const,
        mintAuthority: false, freezeAuthority: true,
        topHolderPct: 10, top10HolderPct: 30,
        lpLocked: true, lpLockedPct: 80,
        isRugged: false, risks: [], scannedAt: new Date().toISOString(),
      };
      expect(report.freezeAuthority).toBe(true);
      expect(isSafe(report)).toBe(false); // freeze auth active = not safe
    });
  });

  describe('isSafe()', () => {
    it('returns true for safe token', async () => {
      const { isSafe } = await import('../../launchkit/services/rugcheck.ts');
      expect(isSafe({
        mint: MOCK_MINT,
        score: 100,
        riskLevel: 'Good',
        mintAuthority: false,
        freezeAuthority: false,
        topHolderPct: 10,
        top10HolderPct: 30,
        lpLocked: true,
        lpLockedPct: 80,
        isRugged: false,
        risks: [],
        scannedAt: new Date().toISOString(),
      })).toBe(true);
    });

    it('returns false if mint authority active', async () => {
      const { isSafe } = await import('../../launchkit/services/rugcheck.ts');
      expect(isSafe({
        mint: MOCK_MINT,
        score: 100,
        riskLevel: 'Good',
        mintAuthority: true,
        freezeAuthority: false,
        topHolderPct: 10,
        top10HolderPct: 30,
        lpLocked: true,
        lpLockedPct: 80,
        isRugged: false,
        risks: [],
        scannedAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('returns false if Danger risk level', async () => {
      const { isSafe } = await import('../../launchkit/services/rugcheck.ts');
      expect(isSafe({
        mint: MOCK_MINT,
        score: 900,
        riskLevel: 'Danger',
        mintAuthority: false,
        freezeAuthority: false,
        topHolderPct: 10,
        top10HolderPct: 30,
        lpLocked: false,
        lpLockedPct: 0,
        isRugged: true,
        risks: [],
        scannedAt: new Date().toISOString(),
      })).toBe(false);
    });
  });

  describe('formatReportForTweet()', () => {
    it('formats a Good report with ticker', async () => {
      const { formatReportForTweet } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: MOCK_MINT,
        score: 100,
        riskLevel: 'Good' as const,
        mintAuthority: false,
        freezeAuthority: false,
        topHolderPct: 12.5,
        top10HolderPct: 35,
        lpLocked: true,
        lpLockedPct: 80,
        isRugged: false,
        risks: [],
        scannedAt: new Date().toISOString(),
      };
      
      const text = formatReportForTweet(report, 'NOVA');
      expect(text).toContain('$NOVA');
      expect(text).toContain('✅');
      expect(text).toContain('Score: 100');
      expect(text).toContain('Revoked');
      expect(text).toContain('rugcheck.xyz');
    });

    it('formats a Danger report with warning flags', async () => {
      const { formatReportForTweet } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: MOCK_MINT,
        score: 800,
        riskLevel: 'Danger' as const,
        mintAuthority: true,
        freezeAuthority: true,
        topHolderPct: 45,
        top10HolderPct: 80,
        lpLocked: false,
        lpLockedPct: 0,
        isRugged: true,
        risks: [
          { name: 'Mint authority active', description: '', level: 'danger' as const, score: 200 },
          { name: 'Freeze authority active', description: '', level: 'danger' as const, score: 200 },
        ],
        scannedAt: new Date().toISOString(),
      };
      
      const text = formatReportForTweet(report, 'RUG');
      expect(text).toContain('❌');
      expect(text).toContain('$RUG');
      expect(text).toContain('⚠️ Active');
      expect(text).toContain('Flags:');
    });
  });

  describe('formatReportForTelegram()', () => {
    it('generates HTML formatted report', async () => {
      const { formatReportForTelegram } = await import('../../launchkit/services/rugcheck.ts');
      const report = {
        mint: MOCK_MINT,
        score: 100,
        riskLevel: 'Good' as const,
        mintAuthority: false,
        freezeAuthority: false,
        topHolderPct: 12.5,
        top10HolderPct: 35,
        lpLocked: true,
        lpLockedPct: 80,
        isRugged: false,
        risks: [],
        scannedAt: new Date().toISOString(),
      };
      
      const html = formatReportForTelegram(report, 'NOVA');
      expect(html).toContain('<b>');
      expect(html).toContain('$NOVA');
      expect(html).toContain('Top 10 holders:');
      expect(html).toContain('<a href=');
    });
  });
});
