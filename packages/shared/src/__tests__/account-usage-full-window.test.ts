import { describe, expect, it } from 'vitest';
import { toAccountUsage, type LedgerEntry, type UsageLedger } from '../account-usage.js';

const NOW = new Date('2026-11-20T07:00:00.000Z');
const RESET = '2026-11-21T07:00:00.000Z';
const identity = { accountId: 'work', path: '/accounts/work', label: null, color: '#123456' };

function usage(key: string, overrides: Partial<LedgerEntry> = {}) {
  const ledger: UsageLedger = {
    v: 1,
    runtime: 'claude-code',
    accountId: 'work',
    updatedAt: NOW.toISOString(),
    windows: {
      [key]: {
        usedPct: 100,
        resetsAt: RESET,
        status: null,
        observedAt: NOW.toISOString(),
        source: 'sdk_usage',
        ...overrides,
      },
    },
  };
  return toAccountUsage(ledger, identity, NOW);
}

describe('account state at a full usage window', () => {
  it.each(['five_hour', 'seven_day', 'seven_day_opus', 'window:300', 'model:sonnet'])(
    'marks a current full %s window limited with its reset',
    (key) => {
      expect(usage(key)).toMatchObject({
        state: 'limited',
        limit: { window: key, resetsAt: RESET },
      });
    }
  );

  it.each([null, 'allowed', 'allowed_warning'] as const)(
    'marks a full window limited even with status %s',
    (status) => {
      expect(usage('seven_day', { status }).state).toBe('limited');
    }
  );

  it('keeps 99% as warning without a limit', () => {
    expect(usage('seven_day', { usedPct: 99 })).toMatchObject({ state: 'warning', limit: null });
  });

  it('limits a full window whose reset is unknown', () => {
    expect(usage('seven_day', { resetsAt: null })).toMatchObject({
      state: 'limited',
      limit: { window: 'seven_day', resetsAt: null },
    });
  });

  it('does not limit an expired 100% window', () => {
    expect(usage('seven_day', { resetsAt: NOW.toISOString() })).toMatchObject({
      state: 'ok',
      limit: null,
      windows: [{ usedPct: 0, expired: true }],
    });
  });

  it('does not limit a stale 100% reading', () => {
    expect(
      usage('five_hour', { observedAt: '2026-11-19T00:00:00.000Z', resetsAt: null })
    ).toMatchObject({
      state: 'unknown',
      limit: null,
      windows: [],
    });
  });
});
