import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import { recordSessionUsage, sessionSubscriptionUsage } from '../account-usage-feed.js';

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

describe('sessionSubscriptionUsage (spec claude-account-fleet §6 U)', () => {
  afterEach(() => setAccountUsageStore(undefined));

  function storeWithWindow() {
    const peekByRoot = vi.fn(() => ({
      runtime: 'claude-code',
      accountId: 'work',
      path: '/a',
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          usedPct: 40,
          resetsAt: null,
          status: null,
          expired: false,
          observedAt: '2026-09-26T10:00:00.000Z',
          source: 'sdk_usage',
        },
      ],
    }));
    setAccountUsageStore({ peekByRoot } as unknown as AccountUsageStore);
  }

  it('reads the account window for a session launched on the subscription', () => {
    storeWithWindow();
    expect(
      sessionSubscriptionUsage({ launchedAccountRoot: '/a', launchedPerToken: false })
    ).toMatchObject({ kind: 'subscription', utilization: 0.4 });
  });

  it('is undefined for a session billed per token (a stored API key or credits)', () => {
    storeWithWindow();
    expect(
      sessionSubscriptionUsage({ launchedAccountRoot: '/a', launchedPerToken: true })
    ).toBeUndefined();
  });

  it("follows the session's own subscription reading when it has not launched here", () => {
    storeWithWindow();
    expect(sessionSubscriptionUsage({ accountRoot: '/a' })).toBeUndefined();
    expect(
      sessionSubscriptionUsage({
        accountRoot: '/a',
        lastSubscriptionUsage: { kind: 'subscription', utilization: 0.1 },
      })
    ).toMatchObject({ utilization: 0.4 });
  });
});
