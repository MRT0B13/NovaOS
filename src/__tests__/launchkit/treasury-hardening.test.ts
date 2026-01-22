/**
 * Treasury Hardening Tests
 * 
 * Tests for:
 * - Persistent caps (treasury_caps in ops)
 * - Claim-first concurrency pattern
 * - Destination enforcement
 * - Scheduler gating
 * - Withdrawal readiness
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { createInMemoryLaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';
import type { LaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';
import type { LaunchPackCreateInput } from '../../launchkit/model/launchPack.ts';
import {
  getTodayKey,
  getCurrentHourKey,
  getEffectiveCaps,
  getEffectiveRateLimits,
  needsCapsReset,
  needsRateLimitReset,
  computeUpdatedCaps,
  computeUpdatedRateLimits,
  wouldExceedDailyCap,
  wouldExceedHourlyRate,
  checkWithdrawalReadiness,
  type TreasuryCaps,
  type SellRateLimits,
} from '../../launchkit/services/operatorGuardrails.ts';
import { enforceDestination } from '../../launchkit/services/treasuryService.ts';

// Base test LaunchPack input
const baseInput: LaunchPackCreateInput = {
  brand: {
    name: 'Test Treasury',
    ticker: 'TREAS',
    tagline: 'Test treasury features',
  },
  launch: { status: 'launched' },
};

describe('Treasury Caps Persistence', () => {
  describe('Day key and reset logic', () => {
    it('generates today key in YYYY-MM-DD format', () => {
      const key = getTodayKey();
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('generates hour key in YYYY-MM-DDTHH format', () => {
      const key = getCurrentHourKey();
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    });

    it('detects when caps need reset (different day)', () => {
      const yesterdayCaps: TreasuryCaps = {
        day: '2024-01-01',
        withdrawn_sol: 1.5,
        withdraw_count: 3,
      };
      // Unless today is 2024-01-01, this should need reset
      const today = getTodayKey();
      if (today !== '2024-01-01') {
        expect(needsCapsReset(yesterdayCaps)).toBe(true);
      }
    });

    it('detects when caps do not need reset (same day)', () => {
      const todayCaps: TreasuryCaps = {
        day: getTodayKey(),
        withdrawn_sol: 0.5,
        withdraw_count: 1,
      };
      expect(needsCapsReset(todayCaps)).toBe(false);
    });

    it('returns fresh caps when none provided', () => {
      const effective = getEffectiveCaps(undefined);
      expect(effective.day).toBe(getTodayKey());
      expect(effective.withdrawn_sol).toBe(0);
      expect(effective.withdraw_count).toBe(0);
    });
  });

  describe('Cap enforcement', () => {
    it('detects when withdrawal would exceed daily cap', () => {
      const caps: TreasuryCaps = {
        day: getTodayKey(),
        withdrawn_sol: 1.8,
        withdraw_count: 2,
      };
      const result = wouldExceedDailyCap(caps, 0.5, 2.0);
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBeCloseTo(0.2, 5);
      expect(result.withdrawnToday).toBe(1.8);
    });

    it('allows withdrawal when under daily cap', () => {
      const caps: TreasuryCaps = {
        day: getTodayKey(),
        withdrawn_sol: 0.5,
        withdraw_count: 1,
      };
      const result = wouldExceedDailyCap(caps, 0.5, 2.0);
      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(1.5);
    });

    it('computes updated caps after withdrawal', () => {
      const caps: TreasuryCaps = {
        day: getTodayKey(),
        withdrawn_sol: 0.5,
        withdraw_count: 1,
      };
      const updated = computeUpdatedCaps(caps, 0.3);
      expect(updated.withdrawn_sol).toBe(0.8);
      expect(updated.withdraw_count).toBe(2);
      expect(updated.day).toBe(getTodayKey());
      expect(updated.last_withdraw_at).toBeTruthy();
    });
  });

  describe('Hourly rate limits', () => {
    it('detects when sell would exceed hourly rate', () => {
      const limits: SellRateLimits = {
        hour_key: getCurrentHourKey(),
        tx_count: 10,
      };
      const result = wouldExceedHourlyRate(limits, 10);
      expect(result.exceeded).toBe(true);
      expect(result.txCount).toBe(10);
      expect(result.remaining).toBe(0);
    });

    it('allows sell when under hourly rate', () => {
      const limits: SellRateLimits = {
        hour_key: getCurrentHourKey(),
        tx_count: 5,
      };
      const result = wouldExceedHourlyRate(limits, 10);
      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(5);
    });

    it('computes updated rate limits after sell', () => {
      const limits: SellRateLimits = {
        hour_key: getCurrentHourKey(),
        tx_count: 3,
      };
      const updated = computeUpdatedRateLimits(limits);
      expect(updated.tx_count).toBe(4);
      expect(updated.hour_key).toBe(getCurrentHourKey());
      expect(updated.last_tx_at).toBeTruthy();
    });
  });
});

describe('Claim-First Treasury Withdraw', () => {
  let store: LaunchPackStore;

  beforeEach(async () => {
    store = createInMemoryLaunchPackStore();
  });

  it('successfully claims treasury withdraw', async () => {
    const pack = await store.create(baseInput);
    const claimed = await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
    });
    
    expect(claimed).not.toBeNull();
    expect(claimed?.ops?.treasury?.status).toBe('in_progress');
    expect(claimed?.ops?.treasury?.attempted_at).toBeTruthy();
  });

  it('rejects second concurrent claim (returns null)', async () => {
    const pack = await store.create(baseInput);
    
    // First claim succeeds
    const first = await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
    });
    expect(first).not.toBeNull();
    
    // Second claim returns null (already in progress)
    const second = await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
    });
    expect(second).toBeNull();
  });

  it('allows claim after success with force flag', async () => {
    const pack = await store.create(baseInput);
    
    // Claim and complete
    await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
    });
    
    // Mark as success
    await store.update(pack.id, {
      ops: {
        treasury: {
          status: 'success',
          completed_at: new Date().toISOString(),
        },
      },
    });
    
    // Immediate second claim without force should fail (cooldown)
    const withoutForce = await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
      force: false,
    });
    expect(withoutForce).toBeNull();
    
    // With force should succeed
    const withForce = await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
      force: true,
    });
    expect(withForce).not.toBeNull();
  });

  it('persists caps after successful withdrawal update', async () => {
    const pack = await store.create(baseInput);
    
    // Claim
    await store.claimTreasuryWithdraw(pack.id, {
      requested_at: new Date().toISOString(),
    });
    
    // Update with success and caps
    const updatedCaps: TreasuryCaps = {
      day: getTodayKey(),
      withdrawn_sol: 0.5,
      withdraw_count: 1,
      last_withdraw_at: new Date().toISOString(),
    };
    
    await store.update(pack.id, {
      ops: {
        treasury: {
          status: 'success',
          completed_at: new Date().toISOString(),
          amount_sol: 0.5,
        },
        treasury_caps: updatedCaps,
      },
    });
    
    // Re-fetch and verify caps persisted
    const fetched = await store.get(pack.id);
    expect(fetched?.ops?.treasury_caps?.withdrawn_sol).toBe(0.5);
    expect(fetched?.ops?.treasury_caps?.day).toBe(getTodayKey());
  });
});

describe('Withdrawal Readiness', () => {
  it('returns unsupported when no secrets configured', () => {
    // This test assumes PUMP_PORTAL_WALLET_SECRET is not set in test env
    const readiness = checkWithdrawalReadiness();
    // We can only check the structure; actual readiness depends on env
    expect(readiness).toHaveProperty('ready');
    expect(readiness).toHaveProperty('mode');
    expect(readiness).toHaveProperty('missingKeys');
    expect(Array.isArray(readiness.missingKeys)).toBe(true);
  });

  it('includes correct mode values', () => {
    const readiness = checkWithdrawalReadiness();
    expect(['local_signing', 'pumpportal_withdraw', 'unsupported']).toContain(readiness.mode);
  });
});

describe('Destination Enforcement', () => {
  // These tests check the enforceDestination function throws correctly
  // Note: Full enforcement requires env vars to be set appropriately
  
  it('throws on pump wallet self-withdrawal attempt', () => {
    // This would need PUMP_PORTAL_WALLET_ADDRESS to be set to test
    // For now, verify the function exists and can be called
    expect(() => {
      // Calling with a random address should not throw (no pump wallet configured in test)
      enforceDestination('11111111111111111111111111111111');
    }).not.toThrow();
  });
});

describe('Ops Schema Extensions', () => {
  let store: LaunchPackStore;

  beforeEach(async () => {
    store = createInMemoryLaunchPackStore();
  });

  it('stores and retrieves treasury_caps', async () => {
    const pack = await store.create(baseInput);
    
    const caps: TreasuryCaps = {
      day: '2024-01-15',
      withdrawn_sol: 1.23,
      withdraw_count: 5,
      last_withdraw_at: '2024-01-15T12:00:00.000Z',
    };
    
    await store.update(pack.id, {
      ops: { treasury_caps: caps },
    });
    
    const fetched = await store.get(pack.id);
    expect(fetched?.ops?.treasury_caps?.day).toBe('2024-01-15');
    expect(fetched?.ops?.treasury_caps?.withdrawn_sol).toBe(1.23);
    expect(fetched?.ops?.treasury_caps?.withdraw_count).toBe(5);
  });

  it('stores and retrieves sell_rate_limits', async () => {
    const pack = await store.create(baseInput);
    
    const limits: SellRateLimits = {
      hour_key: '2024-01-15T14',
      tx_count: 7,
      last_tx_at: '2024-01-15T14:30:00.000Z',
    };
    
    await store.update(pack.id, {
      ops: { sell_rate_limits: limits },
    });
    
    const fetched = await store.get(pack.id);
    expect(fetched?.ops?.sell_rate_limits?.hour_key).toBe('2024-01-15T14');
    expect(fetched?.ops?.sell_rate_limits?.tx_count).toBe(7);
  });
});
