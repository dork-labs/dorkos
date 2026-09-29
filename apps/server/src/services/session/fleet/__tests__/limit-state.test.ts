/**
 * The pure rules of a limited session's state (spec `claude-account-fleet` D9):
 * each state from its condition, the precedence table, the earliest reset, the
 * default model fallback, and which launch origins may carry over.
 */
import { describe, it, expect } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { LimitPlan } from '@dorkos/shared/schemas';
import {
  CARRY_OVER_ORIGINS,
  carryOverAllowed,
  defaultModelFallback,
  deriveLimitState,
  type LimitStateInput,
} from '../limit-state.js';

const RESET = '2026-09-27T17:00:00.000Z';

function window(key: string, usedPct: number, status: 'rejected' | null = null) {
  return {
    key,
    label: key,
    usedPct,
    resetsAt: null,
    status,
    expired: false,
    observedAt: '2026-09-27T00:00:00.000Z',
    source: 'sdk_event' as const,
  };
}

const roomy: Pick<AccountUsage, 'windows'> = {
  windows: [
    window('five_hour', 20),
    window('seven_day', 50),
    window('seven_day_opus', 100, 'rejected'),
  ],
};

function input(overrides: Partial<LimitStateInput> & { plan?: LimitPlan } = {}): LimitStateInput {
  const { plan, ...rest } = overrides;
  return {
    limit: { accountId: 'main', resetsAt: RESET, scope: 'account', plan: plan ?? { mode: 'ask' } },
    modelFallback: undefined,
    accountUsage: null,
    candidates: [{ id: 'spare', eligible: true, resetsAt: null }],
    ...rest,
  };
}

describe('deriveLimitState: each state from its condition', () => {
  it('limited: ask, another account exists, one has room', () => {
    expect(deriveLimitState(input()).state).toBe('limited');
  });

  it('wait-only: carryOver false', () => {
    expect(deriveLimitState(input({ plan: { mode: 'ask', carryOver: false } })).state).toBe(
      'wait-only'
    );
  });

  it('wait-only: no other account (one account)', () => {
    expect(deriveLimitState(input({ candidates: [] })).state).toBe('wait-only');
  });

  it('all-accounts-out: others exist and none has room, naming the earliest reset', () => {
    const derived = deriveLimitState(
      input({
        candidates: [
          { id: 'a', eligible: false, resetsAt: '2026-09-28T10:00:00.000Z' },
          { id: 'b', eligible: false, resetsAt: '2026-09-27T13:00:00.000Z' },
          { id: 'c', eligible: false, resetsAt: null },
        ],
      })
    );
    expect(derived).toEqual({
      state: 'all-accounts-out',
      allOut: { accountId: 'b', resetsAt: '2026-09-27T13:00:00.000Z' },
    });
  });

  it('all-accounts-out: the limited account itself when it resets first', () => {
    const derived = deriveLimitState(
      input({ candidates: [{ id: 'a', eligible: false, resetsAt: '2026-09-30T00:00:00.000Z' }] })
    );
    expect(derived.allOut).toEqual({ accountId: 'main', resetsAt: RESET });
  });

  it('all-accounts-out: an unknown reset everywhere names the limited account', () => {
    const derived = deriveLimitState(
      input({
        limit: { accountId: 'main', resetsAt: null, scope: 'account', plan: { mode: 'ask' } },
        candidates: [{ id: 'a', eligible: false, resetsAt: null }],
      })
    );
    expect(derived.allOut).toEqual({ accountId: 'main', resetsAt: null });
  });

  it('model-limited: a model window, the account has room, and a fallback exists', () => {
    const base = input({ modelFallback: 'sonnet', accountUsage: roomy });
    base.limit.scope = 'model';
    expect(deriveLimitState(base).state).toBe('model-limited');
  });

  it('not model-limited without a fallback, or when the weekly window is out', () => {
    const noFallback = input({ accountUsage: roomy });
    noFallback.limit.scope = 'model';
    expect(deriveLimitState(noFallback).state).toBe('limited');
    const weeklyOut = input({
      modelFallback: 'sonnet',
      accountUsage: { windows: [window('seven_day', 100, 'rejected')] },
    });
    weeklyOut.limit.scope = 'model';
    expect(deriveLimitState(weeklyOut).state).toBe('limited');
  });

  it('handing-off, moved, waiting-reset and reset-ready from the plan', () => {
    expect(
      deriveLimitState(input({ plan: { mode: 'auto', target: 'spare', fireAt: RESET } })).state
    ).toBe('handing-off');
    expect(
      deriveLimitState(input({ plan: { mode: 'continued', sessionId: 'n', accountId: 'spare' } }))
        .state
    ).toBe('moved');
    expect(
      deriveLimitState(input({ plan: { mode: 'waiting', resumeAt: RESET, autoResume: false } }))
        .state
    ).toBe('waiting-reset');
    expect(
      deriveLimitState(
        input({
          plan: { mode: 'waiting', resumeAt: RESET, autoResume: false, resetConfirmedAt: RESET },
        })
      ).state
    ).toBe('reset-ready');
    expect(
      deriveLimitState(
        input({ plan: { mode: 'waiting', resumeAt: RESET, autoResume: false, unconfirmed: true } })
      ).state
    ).toBe('reset-ready');
  });
});

describe('deriveLimitState: precedence', () => {
  const modelInput = (plan: LimitPlan) => {
    const base = input({
      plan,
      modelFallback: 'sonnet',
      accountUsage: roomy,
      candidates: [],
    });
    base.limit.scope = 'model';
    return base;
  };

  it.each([
    [{ mode: 'continued', sessionId: 'n', accountId: 'spare' }, 'moved'],
    [{ mode: 'auto', target: 'spare', fireAt: RESET }, 'handing-off'],
    [
      { mode: 'waiting', resumeAt: RESET, autoResume: false, resetConfirmedAt: RESET },
      'reset-ready',
    ],
    [{ mode: 'waiting', resumeAt: RESET, autoResume: false }, 'waiting-reset'],
    [{ mode: 'ask', carryOver: false }, 'model-limited'],
  ] as const)('%o wins as %s', (plan, expected) => {
    expect(deriveLimitState(modelInput(plan as LimitPlan)).state).toBe(expected);
  });

  it('wait-only beats all-accounts-out', () => {
    expect(
      deriveLimitState(
        input({
          plan: { mode: 'ask', carryOver: false },
          candidates: [{ id: 'a', eligible: false, resetsAt: null }],
        })
      ).state
    ).toBe('wait-only');
  });
});

describe('defaultModelFallback', () => {
  it.each([
    ['seven_day_opus', 'sonnet'],
    ['model:claude-opus-5', 'sonnet'],
    ['model:claude-sonnet-5', undefined],
    ['seven_day_sonnet', undefined],
    ['seven_day', undefined],
    ['five_hour', undefined],
  ])('%s → %s', (key, expected) => {
    expect(defaultModelFallback(key)).toBe(expected);
  });
});

describe('carryOverAllowed', () => {
  it('allows exactly a person’s session, an agent or extension launch, and a carry-over', () => {
    expect([...CARRY_OVER_ORIGINS].sort()).toEqual([
      'account-handoff',
      'agent-launch',
      'extension-start',
      'interactive',
    ]);
    for (const kind of CARRY_OVER_ORIGINS) expect(carryOverAllowed(kind)).toBe(true);
  });

  it.each(['room', 'schedule', 'relay-binding', 'agent-dm', 'connector-event', 'test-harness'])(
    'refuses %s',
    (kind) => {
      expect(carryOverAllowed(kind)).toBe(false);
    }
  );

  it('refuses a session with no recorded origin', () => {
    expect(carryOverAllowed(null)).toBe(false);
  });
});
