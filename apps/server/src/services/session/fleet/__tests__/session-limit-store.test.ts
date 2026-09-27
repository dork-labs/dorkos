/**
 * A session's usage limit survives the process that saw it (spec
 * `claude-account-fleet` D4): the `session_limits` row, the projector that
 * holds `limit` like `lastError`, and the moves a rekey makes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { SessionLimit } from '@dorkos/shared/schemas';
import { SessionLimitStore, limitScopeOf, setSessionLimitStore } from '../session-limit-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  onProjectorLimitSet,
  rekeyProjector,
  type RawSessionEvent,
} from '../../session-state-projector.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LIMIT: SessionLimit = {
  accountId: 'work',
  window: 'seven_day',
  resetsAt: '2026-09-28T20:00:00.000Z',
  since: '2026-09-26T10:00:00.000Z',
  plan: { mode: 'ask' },
  scope: 'account',
  state: 'limited',
};

let db: Db;
let store: SessionLimitStore;
const used = new Set<string>();

function projectorFor(sessionId: string) {
  used.add(sessionId);
  return getOrCreateProjector(sessionId);
}

function write(sessionId: string, limit: SessionLimit = LIMIT) {
  store.upsert({ sessionId, limit, scope: 'account', accountPath: '/accounts/work' });
}

beforeEach(() => {
  db = createTestDb();
  store = new SessionLimitStore(db, () => new Date('2026-09-26T10:00:05.000Z'));
  setSessionLimitStore(store);
});

afterEach(() => {
  for (const id of used) disposeProjector(id);
  used.clear();
  setSessionLimitStore(undefined);
});

describe('SessionLimitStore', () => {
  it('round-trips a limit with its plan, scope, folder and state', () => {
    write('s-1');
    expect(store.get('s-1')).toEqual({
      sessionId: 's-1',
      limit: LIMIT,
      scope: 'account',
      accountPath: '/accounts/work',
      state: 'limited',
      cwd: null,
      claimedBy: null,
      planJson: JSON.stringify(LIMIT.plan),
      updatedAt: '2026-09-26T10:00:05.000Z',
    });
  });

  it('replaces a session’s row on a second write', () => {
    write('s-1');
    write('s-1', { ...LIMIT, window: 'five_hour' });
    expect(store.getMany(['s-1', 'missing'])).toEqual(
      new Map([['s-1', expect.objectContaining({ limit: { ...LIMIT, window: 'five_hour' } })]])
    );
  });

  it('updates the plan, state, fallback, earliest reset and claim of the episode it read', () => {
    write('s-1');
    const changed = store.update('s-1', LIMIT.since, {
      plan: { mode: 'ask', carryOver: false },
      state: 'all-accounts-out',
      modelFallback: 'sonnet',
      allOut: { accountId: 'home', resetsAt: '2026-09-27T00:00:00.000Z' },
      claimedBy: 'flow',
    });
    expect(changed).toBe(true);
    expect(store.get('s-1')).toMatchObject({
      state: 'all-accounts-out',
      claimedBy: 'flow',
      limit: {
        plan: { mode: 'ask', carryOver: false },
        state: 'all-accounts-out',
        modelFallback: 'sonnet',
        allOut: { accountId: 'home', resetsAt: '2026-09-27T00:00:00.000Z' },
      },
    });
    expect(store.list().map((s) => s.sessionId)).toEqual(['s-1']);
  });

  it('writes only over the plan the caller read, when asked to compare', () => {
    write('s-1');
    const read = store.get('s-1')!;
    expect(
      store.update(
        's-1',
        LIMIT.since,
        { plan: { mode: 'ask', carryOver: false } },
        {
          expectPlanJson: read.planJson,
        }
      )
    ).toBe(true);
    expect(
      store.update('s-1', LIMIT.since, { state: 'moved' }, { expectPlanJson: read.planJson })
    ).toBe(false);
    expect(store.get('s-1')?.state).toBe('limited');
  });

  it('leaves a newer episode alone, and a new episode starts unclaimed', () => {
    write('s-1');
    store.update('s-1', LIMIT.since, { claimedBy: 'flow', modelFallback: 'sonnet' });
    expect(store.update('s-1', '2026-01-01T00:00:00.000Z', { state: 'moved' })).toBe(false);
    expect(store.get('s-1')?.state).toBe('limited');
    write('s-1', { ...LIMIT, since: '2026-09-26T11:00:00.000Z' });
    expect(store.get('s-1')).toMatchObject({ claimedBy: null });
    expect(store.get('s-1')?.limit.modelFallback).toBeUndefined();
  });

  it('lists only the limits still waiting on something', () => {
    write('ask');
    write('waiting', { ...LIMIT, plan: { mode: 'waiting', resumeAt: null, autoResume: false } });
    write('auto', {
      ...LIMIT,
      plan: { mode: 'auto', target: 'home', fireAt: '2026-09-28T20:01:00.000Z' },
    });
    expect(
      store
        .listWaiting()
        .map((s) => s.sessionId)
        .sort()
    ).toEqual(['auto', 'waiting']);
  });

  it('moves a row on rekey, keeping the newer limit when both ids hold one', () => {
    write('old', { ...LIMIT, since: '2026-09-26T11:00:00.000Z' });
    write('new');
    store.rekeySession('old', 'new');
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')?.limit.since).toBe('2026-09-26T11:00:00.000Z');

    write('older', { ...LIMIT, since: '2026-09-25T00:00:00.000Z' });
    store.rekeySession('older', 'new');
    expect(store.get('new')?.limit.since).toBe('2026-09-26T11:00:00.000Z');
  });

  it('scopes per-model windows to the model and the rest to the account', () => {
    expect(limitScopeOf('seven_day_opus')).toBe('model');
    expect(limitScopeOf('model:claude-opus-5')).toBe('model');
    expect(limitScopeOf('seven_day')).toBe('account');
    expect(limitScopeOf('unknown')).toBe('account');
  });
});

describe('the projector holds a limit like lastError', () => {
  const statusChange = (limit: SessionLimit | null): RawSessionEvent =>
    ({ type: 'status_change', status: { limit } }) as RawSessionEvent;
  const turnStart = (): RawSessionEvent =>
    ({ type: 'turn_start', userMessage: 'go on' }) as RawSessionEvent;

  it('sets it from a status, keeps it on the snapshot, and clears it at turn_start', () => {
    const projector = projectorFor('p-1');
    write('p-1');
    projector.ingest(statusChange(LIMIT));
    expect(projector.getStatus().limit).toEqual(LIMIT);

    projector.ingest(turnStart());
    expect(projector.getStatus().limit).toBeNull();
    expect(store.get('p-1')).toBeUndefined();
  });

  it('comes back after a restart, from the table', () => {
    write('p-2');
    // A new store over the same database and a new projector: the process restarted.
    setSessionLimitStore(new SessionLimitStore(db));
    expect(projectorFor('p-2').getStatus().limit).toEqual(LIMIT);
  });

  it('announces a new limit once, never an update of it or one restored from the table', () => {
    const seen: string[] = [];
    const stop = onProjectorLimitSet(({ sessionId, limit }) =>
      seen.push(`${sessionId}@${limit.since}`)
    );
    try {
      const projector = projectorFor('p-3');
      projector.ingest(statusChange(LIMIT));
      // The planner's own update of the same episode is not a new limit.
      projector.ingest(statusChange({ ...LIMIT, state: 'wait-only' }));
      expect(seen).toEqual([`p-3@${LIMIT.since}`]);

      // A limit restored from the table is an old episode.
      write('p-4');
      projectorFor('p-4').ingest(turnStart());
      write('p-4');
      setSessionLimitStore(new SessionLimitStore(db));
      disposeProjector('p-4');
      projectorFor('p-4').ingest(statusChange({ ...LIMIT, state: 'limited' }));
      expect(seen).toEqual([`p-3@${LIMIT.since}`]);

      // The next episode is.
      const next = { ...LIMIT, since: '2026-09-26T12:00:00.000Z' };
      projector.ingest(statusChange(next));
      expect(seen).toEqual([`p-3@${LIMIT.since}`, `p-3@${next.since}`]);
    } finally {
      stop();
    }
  });

  it('follows a projector rekey', () => {
    projectorFor('uuid-1');
    write('uuid-1');
    rekeyProjector('uuid-1', 'canonical-1');
    used.add('canonical-1');
    expect(store.get('uuid-1')).toBeUndefined();
    expect(store.get('canonical-1')?.limit).toEqual(LIMIT);
  });
});
