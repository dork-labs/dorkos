import { describe, it, expect } from 'vitest';
import { AccountUsageSchema } from '@dorkos/shared/account-usage';
import { SessionSchema } from '@dorkos/shared/schemas';
import { SessionLimitSchema, type LimitPlan } from '@dorkos/shared/session-stream';
import {
  createMockAccountUsage,
  createMockSession,
  createMockSessionLimit,
} from '../mock-factories.js';

describe('createMockAccountUsage', () => {
  it('builds an ok Claude Code account that the wire schema accepts', () => {
    const usage = createMockAccountUsage();
    expect(AccountUsageSchema.parse(usage)).toEqual(usage);
    expect(usage.state).toBe('ok');
    expect(usage.windows.map((w) => [w.key, w.usedPct])).toEqual([
      ['five_hour', 40],
      ['seven_day', 72],
    ]);
  });

  it('applies overrides', () => {
    expect(createMockAccountUsage({ state: 'warning', label: null })).toMatchObject({
      state: 'warning',
      label: null,
    });
  });
});

describe('createMockSessionLimit', () => {
  const modes: LimitPlan['mode'][] = ['ask', 'auto', 'waiting', 'continued'];

  it.each(modes)('builds a %s limit that the session limit schema accepts', (mode) => {
    const limit = createMockSessionLimit(mode);
    expect(limit.plan.mode).toBe(mode);
    expect(SessionLimitSchema.parse(limit)).toEqual(limit);
  });

  it('defaults to ask and applies overrides', () => {
    expect(createMockSessionLimit(undefined, { window: 'five_hour' })).toMatchObject({
      window: 'five_hour',
      plan: { mode: 'ask' },
    });
  });
});

describe('createMockSession account fields', () => {
  it('passes runtime, accountId, status and trackerItem through and parses', () => {
    const session = createMockSession({
      id: '5c2f7d9e-0a4b-4c3d-9e8f-1a2b3c4d5e6f',
      runtime: 'codex',
      accountId: 'acct-4',
      status: { lifecycle: 'idle', limit: createMockSessionLimit('waiting') },
      trackerItem: { id: 'DOR-1', stage: 'execute', runStatus: 'running' },
    });
    const parsed = SessionSchema.parse(session);
    expect(parsed.runtime).toBe('codex');
    expect(parsed.accountId).toBe('acct-4');
    expect(parsed.status).toEqual(session.status);
    expect(parsed.trackerItem).toEqual({ id: 'DOR-1', stage: 'execute', runStatus: 'running' });
  });
});
