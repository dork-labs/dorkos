/**
 * Codex's rate limits reach the usage store as (`codex`, `default`), and a
 * limit they imply becomes the session's `limit` (spec `claude-account-fleet`
 * §6 R, D4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { LedgerObservation } from '@dorkos/shared/account-usage';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../../session/fleet/session-limit-store.js';
import { codexLimitOf, isCodexUsageLimitMessage, noteCodexTurnUsage } from '../account-usage.js';

const NOW = new Date('2026-09-10T23:50:36.000Z');

/**
 * Pinned from a real rollout `token_count` line (Codex, Pro plan, 2026-09-10),
 * with a 5-hour primary added beside its weekly window: `resets_at` is epoch
 * seconds, `balance` the CLI's own string.
 */
function realRateLimits(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1789560000 },
    secondary: { used_percent: 25.0, window_minutes: 10080, resets_at: 1789663865 },
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: 'pro',
    rate_limit_reached_type: null,
    ...overrides,
  };
}

/** A real model-specific limit record (its own `limit_id` and `limit_name`). */
const SPARK_LIMIT = {
  limit_id: 'codex_bengalfox',
  limit_name: 'GPT-5.3-Codex-Spark',
  primary: { used_percent: 40.0, window_minutes: 300, resets_at: 1789560100 },
  secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: 1789753399 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  plan_type: 'pro',
  rate_limit_reached_type: null,
};

let record: ReturnType<typeof vi.fn>;
let limits: SessionLimitStore;

beforeEach(() => {
  record = vi.fn();
  setAccountUsageStore({
    record,
    peek: (runtime: string, ids: readonly string[]) =>
      runtime === 'codex' && ids.includes('default')
        ? [{ runtime: 'codex', accountId: 'default', path: '/Users/dev/.codex' }]
        : [],
  } as unknown as AccountUsageStore);
  limits = new SessionLimitStore(createTestDb());
  setSessionLimitStore(limits);
});

afterEach(() => {
  setAccountUsageStore(undefined);
  setSessionLimitStore(undefined);
});

/** Every observation the store was handed, in order. */
function recorded(): LedgerObservation[] {
  return record.mock.calls.flatMap((call) => call[2] as LedgerObservation[]);
}

function windowOf(key: string) {
  return recorded().find((o) => 'key' in o && o.key === key) as
    Extract<LedgerObservation, { key: string }> | undefined;
}

describe('noteCodexTurnUsage', () => {
  it('maps a real-shaped record to five_hour and seven_day, with plan and credits facts, for codex:default', () => {
    const status = noteCodexTurnUsage({ sessionId: 's-1' }, [realRateLimits()], false, NOW);

    expect(status).toBeNull();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toBe('codex');
    expect(record.mock.calls[0]![1]).toEqual({ accountId: 'default' });
    expect(windowOf('five_hour')).toMatchObject({
      usedPct: 12,
      windowMinutes: 300,
      resetsAt: new Date(1789560000 * 1000).toISOString(),
      status: null,
      source: 'rollout',
      observedAt: NOW.toISOString(),
    });
    expect(windowOf('seven_day')).toMatchObject({ usedPct: 25, windowMinutes: 10080 });
    expect(recorded()).toContainEqual(expect.objectContaining({ kind: 'plan', name: 'pro' }));
    expect(recorded()).toContainEqual(
      expect.objectContaining({
        kind: 'credits',
        hasCredits: false,
        unlimited: false,
        balance: '0',
      })
    );
  });

  it('keeps a model-specific limit in its own model:<slug> bucket, never on five_hour or seven_day', () => {
    noteCodexTurnUsage({ sessionId: 's-1' }, [realRateLimits(), SPARK_LIMIT], false, NOW);

    const keys = recorded().flatMap((o) => ('key' in o ? [o.key] : []));
    expect(keys.filter((k) => k === 'five_hour')).toHaveLength(1);
    expect(keys.filter((k) => k === 'seven_day')).toHaveLength(1);
    expect(windowOf('five_hour')).toMatchObject({ usedPct: 12 });
    expect(keys.filter((k) => k.startsWith('model:'))).toEqual(['model:gpt-5.3-codex-spark']);
  });

  it('keys a window of an unknown length by its minutes', () => {
    noteCodexTurnUsage(
      { sessionId: 's-1' },
      [
        realRateLimits({
          primary: { used_percent: 5, window_minutes: 1440, resets_at: 1789560000 },
          secondary: null,
        }),
      ],
      false,
      NOW
    );
    expect(windowOf('window:1440')).toMatchObject({ usedPct: 5, windowMinutes: 1440 });
  });

  it('a reached limit records the window rejected and sets the session limit', () => {
    const status = noteCodexTurnUsage(
      { sessionId: 's-1' },
      [
        realRateLimits({
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1789560000 },
          rate_limit_reached_type: 'rate_limit_reached',
        }),
      ],
      false,
      NOW
    );

    expect(windowOf('five_hour')).toMatchObject({ status: 'rejected' });
    const expected = {
      accountId: 'default',
      window: 'five_hour',
      resetsAt: new Date(1789560000 * 1000).toISOString(),
      since: NOW.toISOString(),
      plan: { mode: 'ask' },
      scope: 'account',
      state: 'limited',
    };
    expect(status).toEqual({ type: 'session_status', data: { sessionId: 's-1', limit: expected } });
    expect(limits.get('s-1')).toMatchObject({
      limit: expected,
      scope: 'account',
      accountPath: '/Users/dev/.codex',
    });
  });

  it('a record at 100% with a null rate_limit_reached_type still sets the session limit', () => {
    const status = noteCodexTurnUsage(
      { sessionId: 's-1' },
      [
        realRateLimits({
          primary: null,
          secondary: { used_percent: 100.0, window_minutes: 10080, resets_at: 1789243480 },
        }),
      ],
      false,
      NOW
    );
    expect(status?.data).toMatchObject({
      limit: { window: 'seven_day', resetsAt: new Date(1789243480 * 1000).toISOString() },
    });
  });

  it('a turn without rate_limits records nothing and sets no limit', () => {
    expect(noteCodexTurnUsage({ sessionId: 's-1' }, [], false, NOW)).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(limits.get('s-1')).toBeUndefined();
  });

  it('a turn that failed on Codex’s usage limit sets the limit even with nothing to name its window', () => {
    const status = noteCodexTurnUsage({ sessionId: 's-1' }, [], true, NOW);
    expect(status?.data).toMatchObject({ limit: { window: 'unknown', resetsAt: null } });
  });

  it('reports one limit per turn', () => {
    const state = { sessionId: 's-1' };
    expect(noteCodexTurnUsage(state, [], true, NOW)).not.toBeNull();
    expect(noteCodexTurnUsage(state, [], true, NOW)).toBeNull();
  });
});

describe('codexLimitOf', () => {
  const at = (
    key: string,
    usedPct: number | null,
    resetsAt: string | null,
    status = null as never
  ) =>
    ({
      key,
      usedPct,
      resetsAt,
      status,
      observedAt: NOW.toISOString(),
      source: 'rollout',
    }) as LedgerObservation;

  it('prefers a rejected plain window, the one with the latest reset', () => {
    expect(
      codexLimitOf(
        [
          at('five_hour', 100, '2026-09-11T02:00:00.000Z', 'rejected' as never),
          at('seven_day', 100, '2026-09-15T00:00:00.000Z', 'rejected' as never),
        ],
        false
      )
    ).toEqual({ window: 'seven_day', resetsAt: '2026-09-15T00:00:00.000Z' });
  });

  it('never stops the account on a model bucket alone', () => {
    expect(codexLimitOf([at('model:spark', 100, null, 'rejected' as never)], false)).toBeNull();
    expect(codexLimitOf([at('model:spark', 100, null, 'rejected' as never)], true)).toEqual({
      window: 'model:spark',
      resetsAt: null,
    });
  });

  it('finds no limit below 100% on a turn that did not fail on one', () => {
    expect(codexLimitOf([at('five_hour', 99, null)], false)).toBeNull();
  });
});

describe('isCodexUsageLimitMessage', () => {
  it('matches Codex’s own usage-limit wording, straight or curly', () => {
    expect(
      isCodexUsageLimitMessage(
        'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 11:09 AM.'
      )
    ).toBe(true);
    expect(isCodexUsageLimitMessage("You've hit your usage limit.")).toBe(true);
  });

  it('a plain 429 throttle is not the account running out, so it sets no limit', () => {
    const message = 'exceeded retry limit, last status: 429 Too Many Requests';
    expect(isCodexUsageLimitMessage(message)).toBe(false);
    expect(
      noteCodexTurnUsage({ sessionId: 's-1' }, [], isCodexUsageLimitMessage(message), NOW)
    ).toBeNull();
  });

  it('does not match an ordinary failure', () => {
    expect(isCodexUsageLimitMessage('command failed with exit code 1')).toBe(false);
    expect(isCodexUsageLimitMessage('Reconnecting... 2/5')).toBe(false);
  });
});
