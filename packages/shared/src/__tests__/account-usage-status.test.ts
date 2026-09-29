import { describe, it, expect } from 'vitest';
import {
  subscriptionUsageOf,
  withAccountSubscription,
  type AccountUsage,
} from '../account-usage.js';

type Window = AccountUsage['windows'][number];

function win(key: string, usedPct: number | null, extra: Partial<Window> = {}): Window {
  return {
    key,
    label: key,
    usedPct,
    resetsAt: null,
    status: null,
    expired: false,
    observedAt: '2026-09-27T10:00:00.000Z',
    source: 'sdk_usage',
    ...extra,
  };
}

function account(windows: Window[]): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: 'work',
    path: '/h/.claude3',
    label: 'Work',
    color: '#000',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows,
    state: 'ok',
    limit: null,
    updatedAt: null,
  };
}

describe('subscriptionUsageOf', () => {
  it('picks the plan window with the highest share used, as a 0..1 fraction', () => {
    const usage = subscriptionUsageOf(
      account([
        win('five_hour', 20),
        win('seven_day', 64, { label: 'Weekly', resetsAt: '2026-10-01T00:00:00.000Z' }),
        // A model-scoped slice never stands for the plan, however high.
        win('model:opus', 99),
      ])
    );
    expect(usage).toEqual({
      kind: 'subscription',
      utilization: 0.64,
      windowLabel: 'Weekly',
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('reads a rejected or full window as exhausted and a warned one as warning', () => {
    expect(subscriptionUsageOf(account([win('five_hour', 100)]))?.state).toBe('exhausted');
    expect(
      subscriptionUsageOf(account([win('five_hour', 40, { status: 'rejected' })]))?.state
    ).toBe('exhausted');
    expect(
      subscriptionUsageOf(account([win('five_hour', 91, { status: 'allowed_warning' })]))?.state
    ).toBe('warning');
  });

  it('is undefined with no plan window that has a percentage', () => {
    expect(subscriptionUsageOf(account([]))).toBeUndefined();
    expect(subscriptionUsageOf(account([win('five_hour', null)]))).toBeUndefined();
  });
});

describe('withAccountSubscription', () => {
  it("keeps the session's own cost beside the account's window", () => {
    expect(
      withAccountSubscription(
        { kind: 'pay-as-you-go', costUsd: 1.5, costBasis: 'list' },
        account([win('five_hour', 50)])
      )
    ).toEqual({
      kind: 'subscription',
      utilization: 0.5,
      windowLabel: 'five_hour',
      costUsd: 1.5,
      costBasis: 'list',
    });
  });

  it("keeps the session's detail line, so an overage note survives an account update", () => {
    expect(
      withAccountSubscription(
        { kind: 'subscription', utilization: 0.2, detail: 'Using overage capacity' },
        account([win('five_hour', 50)])
      )
    ).toMatchObject({ utilization: 0.5, detail: 'Using overage capacity' });
  });

  it('leaves the held usage alone when the account has no plan window', () => {
    const held = { kind: 'pay-as-you-go' as const, costUsd: 1 };
    expect(withAccountSubscription(held, account([]))).toBe(held);
    expect(withAccountSubscription(null, account([]))).toBeNull();
  });
});
