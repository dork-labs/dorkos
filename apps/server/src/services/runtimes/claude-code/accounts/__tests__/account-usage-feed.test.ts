import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import { recordSessionUsage } from '../account-usage-feed.js';

vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => '/accounts/active',
}));

function fakeStore() {
  const record = vi.fn();
  setAccountUsageStore({ record } as unknown as AccountUsageStore);
  return record;
}

const obs = [
  {
    key: 'five_hour',
    usedPct: 10,
    observedAt: '2026-09-26T10:00:00.000Z',
    source: 'sdk_event' as const,
  },
];

describe('recordSessionUsage', () => {
  afterEach(() => setAccountUsageStore(undefined));

  it('is a no-op without a store', () => {
    expect(() => recordSessionUsage({}, obs)).not.toThrow();
  });

  it('attributes by launchedAccountRoot, then accountRoot, then the active root', () => {
    const record = fakeStore();
    recordSessionUsage({ launchedAccountRoot: '/a', accountRoot: '/b' }, obs);
    recordSessionUsage({ accountRoot: '/b' }, obs);
    recordSessionUsage({}, obs, { subscriptionType: 'max' });
    expect(record.mock.calls.map((c) => c[1])).toEqual([
      { path: '/a' },
      { path: '/b' },
      { path: '/accounts/active' },
    ]);
    expect(record.mock.calls[2]![3]).toEqual({ subscriptionType: 'max' });
    expect(record.mock.calls.every((c) => c[0] === 'claude-code')).toBe(true);
  });

  it('never throws into a turn', () => {
    const record = fakeStore();
    record.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => recordSessionUsage({ accountRoot: '/b' }, obs)).not.toThrow();
  });
});
