import { describe, it, expect } from 'vitest';
import {
  LimitPlanSchema,
  SessionLimitSchema,
  SessionStatusSchema,
  sessionAccountState,
  sessionDisplayState,
  type SessionLifecycle,
  type SessionLimit,
} from '../session-stream.js';
import { SessionListResponseSchema, SessionSchema, SessionStatusEventSchema } from '../schemas.js';

const coldStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default' as const,
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle' as const,
  lastError: null,
};

const limit: SessionLimit = {
  accountId: 'claude3',
  window: 'five_hour',
  resetsAt: '2026-09-26T19:00:00.000Z',
  since: '2026-09-26T16:04:10.000Z',
  plan: { mode: 'ask' },
  scope: 'account',
  state: 'limited',
};

const session = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'A session',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T11:00:00.000Z',
  permissionMode: 'default',
  runtime: 'claude-code',
};

describe('SessionStatusSchema limit', () => {
  it('parses an older snapshot with no limit to null', () => {
    expect(SessionStatusSchema.parse(coldStatus).limit).toBeNull();
  });

  it('carries a limit through', () => {
    expect(SessionStatusSchema.parse({ ...coldStatus, limit }).limit).toEqual(limit);
  });

  it('defaults a limit with no plan to ask', () => {
    const { plan: _plan, ...noPlan } = limit;
    expect(SessionLimitSchema.parse(noPlan).plan).toEqual({ mode: 'ask' });
  });

  it('reads an older limit with no scope or state as an account limit that is limited', () => {
    const { scope: _scope, state: _state, ...older } = limit;
    const parsed = SessionLimitSchema.parse(older);
    expect(parsed.scope).toBe('account');
    expect(parsed.state).toBe('limited');
  });

  it('carries the model fallback and the earliest reset when set', () => {
    const full = {
      ...limit,
      scope: 'model' as const,
      state: 'model-limited' as const,
      modelFallback: 'sonnet',
      allOut: { accountId: 'claude4', resetsAt: '2026-09-27T01:00:00.000Z' },
    };
    expect(SessionLimitSchema.parse(full)).toEqual(full);
    expect(SessionLimitSchema.safeParse({ ...limit, state: 'near-limit' }).success).toBe(false);
  });

  it('fills an older waiting plan with no reset time and no automatic resume', () => {
    expect(LimitPlanSchema.parse({ mode: 'waiting' })).toEqual({
      mode: 'waiting',
      resumeAt: null,
      autoResume: false,
    });
  });

  it('accepts every plan mode and refuses an incomplete one', () => {
    for (const plan of [
      { mode: 'ask' },
      { mode: 'ask', carryOver: false },
      { mode: 'auto', target: 'claude4', fireAt: '2026-09-26T16:05:00.000Z' },
      { mode: 'waiting', resumeAt: '2026-09-26T19:00:00.000Z', autoResume: true },
      {
        mode: 'waiting',
        resumeAt: null,
        autoResume: false,
        resetConfirmedAt: '2026-09-26T19:01:00.000Z',
        unconfirmed: true,
        carryOver: false,
      },
      { mode: 'continued', sessionId: 'abc', accountId: 'claude4' },
    ]) {
      expect(LimitPlanSchema.parse(plan)).toEqual(plan);
    }
    expect(LimitPlanSchema.safeParse({ mode: 'auto' }).success).toBe(false);
    expect(
      LimitPlanSchema.safeParse({ mode: 'auto', target: 'claude4', fireAt: 'soon' }).success
    ).toBe(false);
    expect(LimitPlanSchema.safeParse({ mode: 'later' }).success).toBe(false);
    expect(LimitPlanSchema.safeParse({ mode: 'ask', carryOver: true }).success).toBe(false);
  });

  it('lets a status event set, clear or say nothing about a limit', () => {
    expect(SessionStatusEventSchema.parse({ sessionId: 's', limit }).limit).toEqual(limit);
    expect(SessionStatusEventSchema.parse({ sessionId: 's', limit: null }).limit).toBeNull();
    expect('limit' in SessionStatusEventSchema.parse({ sessionId: 's' })).toBe(false);
  });
});

describe('sessionDisplayState', () => {
  const lifecycles: SessionLifecycle[] = ['idle', 'streaming', 'blocked', 'error', 'interrupted'];

  it.each(lifecycles)('is the lifecycle %s when there is no limit', (lifecycle) => {
    expect(sessionDisplayState({ lifecycle, limit: null })).toBe(lifecycle);
  });

  it.each(lifecycles)('is limited over the lifecycle %s when a limit is set', (lifecycle) => {
    expect(sessionDisplayState({ lifecycle, limit })).toBe('limited');
  });
});

describe('sessionAccountState', () => {
  it('is the limit state while a limit holds the session', () => {
    expect(sessionAccountState({ limit: { ...limit, state: 'moved' } }, { state: 'warning' })).toBe(
      'moved'
    );
  });

  it('is near-limit with no limit when the account reads warning', () => {
    expect(sessionAccountState({ limit: null }, { state: 'warning' })).toBe('near-limit');
  });

  it('is null with no limit and an account that is fine, unknown or not known', () => {
    expect(sessionAccountState({ limit: null }, { state: 'ok' })).toBeNull();
    expect(sessionAccountState({ limit: null }, { state: 'unknown' })).toBeNull();
    expect(sessionAccountState({ limit: null }, null)).toBeNull();
  });
});

describe('SessionSchema fleet fields', () => {
  it('parses a session without the new fields and adds none of them', () => {
    const parsed = SessionSchema.parse(session);
    expect(parsed).not.toHaveProperty('accountId');
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('trackerItem');
  });

  it('accepts accountId, status and trackerItem', () => {
    const full = {
      ...session,
      accountId: 'claude3',
      status: { lifecycle: 'idle', limit },
      trackerItem: { id: 'DOR-2380', stage: 'execute', runStatus: 'running' },
    };
    expect(SessionSchema.parse(full)).toEqual(full);
    expect(
      SessionSchema.parse({ ...session, status: { lifecycle: 'streaming', limit: null } }).status
    ).toEqual({ lifecycle: 'streaming', limit: null });
    expect(SessionSchema.parse({ ...session, trackerItem: { id: 'DOR-1' } }).trackerItem).toEqual({
      id: 'DOR-1',
    });
  });

  it('refuses a status whose lifecycle is limited (a display state, not a lifecycle)', () => {
    expect(
      SessionSchema.safeParse({ ...session, status: { lifecycle: 'limited', limit } }).success
    ).toBe(false);
  });
});

describe('SessionListResponseSchema accountUsage', () => {
  it('is optional, and carries account usage when present', () => {
    expect(SessionListResponseSchema.parse({ sessions: [] })).not.toHaveProperty('accountUsage');
    const accountUsage = [
      {
        runtime: 'claude-code',
        accountId: null,
        path: '/home/u/.claude',
        label: null,
        color: '#3b82f6',
        subscriptionType: null,
        plan: null,
        credits: null,
        spend: null,
        windows: [],
        state: 'unknown',
        limit: null,
        updatedAt: null,
      },
    ];
    expect(SessionListResponseSchema.parse({ sessions: [], accountUsage }).accountUsage).toEqual(
      accountUsage
    );
  });
});
