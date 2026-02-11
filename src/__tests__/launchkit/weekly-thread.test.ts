/**
 * Tests for weeklyThread.ts — thread time check, stats formatting
 */
import { describe, expect, it } from 'bun:test';

describe('weeklyThread', () => {
  describe('isWeeklyThreadTime()', () => {
    it('returns boolean', async () => {
      const { isWeeklyThreadTime } = await import('../../launchkit/services/weeklyThread.ts');
      const result = isWeeklyThreadTime();
      expect(typeof result).toBe('boolean');
    });

    // Note: can't easily mock Date without side effects, so we just test the shape
    it('checks for Sunday 18:00 UTC', async () => {
      const { isWeeklyThreadTime } = await import('../../launchkit/services/weeklyThread.ts');
      const now = new Date();
      const isSunday18 = now.getUTCDay() === 0 && now.getUTCHours() === 18;
      expect(isWeeklyThreadTime()).toBe(isSunday18);
    });
  });

  describe('postWeeklyThread()', () => {
    it('returns null when X is disabled', async () => {
      // Ensure X is disabled
      process.env.X_ENABLE = 'false';
      const { postWeeklyThread } = await import('../../launchkit/services/weeklyThread.ts');
      
      const result = await postWeeklyThread({
        launchCount: 5,
        totalTweets: 20,
        totalTgPosts: 15,
        walletBalance: 1.5,
        startBalance: 1.0,
        graduatedCount: 2,
        rugcheckScans: 5,
        avgRugcheckScore: 150,
        totalReplies: 10,
        feesEarned: 0.01,
      });
      
      expect(result).toBeNull();
    });
  });
});
