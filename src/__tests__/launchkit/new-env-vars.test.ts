/**
 * Tests for new env vars: X_READ_BUDGET_USD, TELEGRAM_COMMUNITY_CHAT_ID, etc.
 */
import { describe, expect, it } from 'bun:test';
import { getEnv } from '../../launchkit/env.ts';

describe('New env vars', () => {
  it('X_READ_BUDGET_USD defaults to 0 when env is empty', () => {
    // Clear the env var so default kicks in
    delete process.env.X_READ_BUDGET_USD;
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
      X_READ_BUDGET_USD: undefined as any,
    });
    expect((env as any).X_READ_BUDGET_USD).toBe(0);
  });

  it('X_READ_BUDGET_USD parses numeric value', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
      X_READ_BUDGET_USD: '5',
    });
    expect((env as any).X_READ_BUDGET_USD).toBe(5);
  });

  it('X_READ_BUDGET_USD handles decimal values', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
      X_READ_BUDGET_USD: '2.50',
    });
    expect((env as any).X_READ_BUDGET_USD).toBe(2.5);
  });

  it('X_MONTHLY_WRITE_LIMIT defaults to 500', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect((env as any).X_MONTHLY_WRITE_LIMIT).toBe(500);
  });

  it('X_MONTHLY_READ_LIMIT defaults to 100', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect((env as any).X_MONTHLY_READ_LIMIT).toBe(100);
  });

  it('X_REPLY_ENGINE_ENABLE defaults to false', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect(env.X_REPLY_ENGINE_ENABLE).toBe('false');
  });

  it('X_REPLY_MAX_PER_DAY defaults to 10', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect(env.X_REPLY_MAX_PER_DAY).toBe(10);
  });

  it('X_REPLY_INTERVAL_MINUTES defaults to 60', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect(env.X_REPLY_INTERVAL_MINUTES).toBe(60);
  });

  it('RUGCHECK_API_KEY is optional', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'false',
    });
    expect((env as any).RUGCHECK_API_KEY).toBeUndefined();
  });
});
