import { describe, it, expect } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { signatureOf } from '../account-usage-view.js';

/** An account's usage with one weekly window and, optionally, unknown windows. */
function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: 'acct-1',
    path: '/accounts/acct-1',
    label: 'Acct 1',
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'five_hour',
        label: '5-hour window',
        usedPct: 20,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-11-19T10:00:00.000Z',
        source: 'statusline',
      },
    ],
    state: 'ok',
    limit: null,
    updatedAt: '2026-11-19T10:00:00.000Z',
    ...over,
  };
}

const weekly = (since: string) => [{ key: 'seven_day', label: 'Weekly', since }];

describe('signatureOf', () => {
  // DOR-4620. Red when: a moving `since` makes the store broadcast on every reading.
  it('ignores when a window went unknown, but not which windows are unknown', () => {
    const a = usage({ unknown: weekly('2026-11-19T08:00:00.000Z') });
    const b = usage({ unknown: weekly('2026-11-19T09:00:00.000Z'), updatedAt: null });
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).not.toBe(signatureOf(usage()));
  });
});
