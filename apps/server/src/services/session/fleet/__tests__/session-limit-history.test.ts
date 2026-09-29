/**
 * How a session's usage-limit episodes ended (spec `claude-account-ui` §7.1),
 * kept by the store that owns `session_limits` inside its own writes: a
 * `moved` row when the plan becomes `continued`, a `resumed-*` row when the
 * limit is cleared at the next `turn_start`, one row per episode, moved with
 * the session, swept after 30 days.
 *
 * Real tables over a temp database; the clock is the store's own, set per test
 * relative to the limit's reset, so nothing depends on today's date.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionLimits, sessionMetadata, type Db } from '@dorkos/db';
import type { LimitPlan, SessionLimit } from '@dorkos/shared/schemas';
import { SessionLimitStore } from '../session-limit-store.js';
import { LIMIT_HISTORY_PAGE, LIMIT_HISTORY_RETENTION_MS } from '../session-limit-history.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HOUR = 60 * 60 * 1000;
/** Every time in this file is an offset from here; the date itself never matters. */
const T0 = Date.UTC(2030, 0, 1);
const at = (offsetMs: number) => new Date(T0 + offsetMs);

let db: Db;
let store: SessionLimitStore;
let clock: Date;

function bind(sessionId: string, runtime: string | null, model: string | null = null): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime, model, createdAt: at(0).toISOString() })
    .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { runtime, model } })
    .run();
}

/** A limit hit at `sinceMs`, resetting at `sinceMs + 5h`. */
function limitAt(sinceMs: number, plan: LimitPlan = { mode: 'ask' }): SessionLimit {
  return {
    accountId: 'main',
    window: 'five_hour',
    resetsAt: at(sinceMs + 5 * HOUR).toISOString(),
    since: at(sinceMs).toISOString(),
    plan,
    scope: 'account',
    state: 'limited',
  };
}

function hit(sessionId: string, sinceMs = 0): SessionLimit {
  const limit = limitAt(sinceMs);
  store.upsert({ sessionId, limit, scope: 'account', accountPath: '/accounts/main' });
  return limit;
}

beforeEach(() => {
  db = createTestDb();
  clock = at(HOUR);
  store = new SessionLimitStore(db, () => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moved', () => {
  it('records where the work went when the plan becomes continued', () => {
    bind('s-1', 'claude-code');
    const limit = hit('s-1');
    expect(store.history('s-1')).toEqual([]);

    store.update('s-1', limit.since, {
      plan: { mode: 'continued', sessionId: 's-2', accountId: 'spare' },
    });

    expect(store.history('s-1')).toEqual([
      {
        id: expect.any(String),
        sessionId: 's-1',
        since: limit.since,
        runtime: 'claude-code',
        accountId: 'main',
        window: 'five_hour',
        scope: 'account',
        resetsAt: limit.resetsAt,
        resolution: 'moved',
        resolvedAt: clock.toISOString(),
        toSessionId: 's-2',
        toAccountId: 'spare',
        modelFrom: null,
        modelTo: null,
      },
    ]);
  });

  it('records nothing for a plan change that is not a move', () => {
    bind('s-1', 'claude-code');
    const limit = hit('s-1');
    store.update('s-1', limit.since, {
      plan: { mode: 'auto', target: 'spare', fireAt: clock.toISOString() },
    });
    store.update('s-1', limit.since, { plan: { mode: 'ask' } });
    expect(store.history('s-1')).toEqual([]);
  });

  it('records nothing when the continued write does not land (a newer episode)', () => {
    bind('s-1', 'claude-code');
    hit('s-1');
    expect(
      store.update('s-1', at(-HOUR).toISOString(), {
        plan: { mode: 'continued', sessionId: 's-2', accountId: 'spare' },
      })
    ).toBe(false);
    expect(store.history('s-1')).toEqual([]);
  });

  it('stays moved when the old session later takes another turn', () => {
    bind('s-1', 'claude-code');
    const limit = hit('s-1');
    store.update('s-1', limit.since, {
      plan: { mode: 'continued', sessionId: 's-2', accountId: 'spare' },
    });
    clock = at(10 * HOUR);
    store.delete('s-1');
    expect(store.history('s-1').map((e) => e.resolution)).toEqual(['moved']);
  });
});

describe('resumed at the next turn_start', () => {
  it('is resumed-model when the session’s model changed since the limit', () => {
    bind('s-1', 'claude-code', 'opus');
    hit('s-1');
    bind('s-1', 'claude-code', 'sonnet');
    store.delete('s-1');
    expect(store.history('s-1')).toEqual([
      expect.objectContaining({
        resolution: 'resumed-model',
        modelFrom: 'opus',
        modelTo: 'sonnet',
        resolvedAt: clock.toISOString(),
      }),
    ]);
  });

  it('is resumed-model from the runtime’s default to a chosen model', () => {
    bind('s-1', 'claude-code');
    hit('s-1');
    bind('s-1', 'claude-code', 'sonnet');
    store.delete('s-1');
    expect(store.history('s-1')).toEqual([
      expect.objectContaining({ resolution: 'resumed-model', modelFrom: null, modelTo: 'sonnet' }),
    ]);
  });

  it('never reads a limit whose model was not recorded as a model switch', () => {
    bind('s-1', 'claude-code');
    hit('s-1');
    // A row that predates the column and escaped the backfill.
    db.update(sessionLimits).set({ model: null }).run();
    bind('s-1', 'claude-code', 'opus');
    store.delete('s-1');
    expect(store.history('s-1')).toEqual([
      expect.objectContaining({ resolution: 'resumed-early', modelFrom: null, modelTo: null }),
    ]);
  });

  it('is resumed-reset when a reading confirmed the reset, even before its time', () => {
    bind('s-1', 'claude-code');
    const limit = hit('s-1');
    store.update('s-1', limit.since, {
      plan: {
        mode: 'waiting',
        resumeAt: limit.resetsAt,
        autoResume: false,
        resetConfirmedAt: clock.toISOString(),
      },
    });
    store.delete('s-1');
    expect(store.history('s-1').map((e) => e.resolution)).toEqual(['resumed-reset']);
  });

  it('is resumed-reset when the reset time has passed', () => {
    bind('s-1', 'claude-code');
    hit('s-1');
    clock = at(5 * HOUR);
    store.delete('s-1');
    expect(store.history('s-1').map((e) => e.resolution)).toEqual(['resumed-reset']);
  });

  it('is resumed-early before the reset, on the same model', () => {
    bind('s-1', 'claude-code', 'opus');
    hit('s-1');
    clock = at(5 * HOUR - 1);
    store.delete('s-1');
    expect(store.history('s-1')).toEqual([
      expect.objectContaining({ resolution: 'resumed-early', modelFrom: null, modelTo: null }),
    ]);
  });

  it('names the session’s runtime, and unknown when it has no binding on record', () => {
    bind('s-codex', 'codex');
    hit('s-codex');
    hit('s-bare');
    store.delete('s-codex');
    store.delete('s-bare');
    expect(store.history('s-codex')[0]?.runtime).toBe('codex');
    expect(store.history('s-bare')[0]?.runtime).toBe('unknown');
  });

  it('records nothing for a turn_start with no limit to clear', () => {
    bind('s-1', 'claude-code');
    expect(store.delete('s-1')).toBe(false);
    expect(store.history('s-1')).toEqual([]);
  });
});

describe('one row per episode', () => {
  it('ignores a second resolution for the same since', () => {
    bind('s-1', 'claude-code');
    const limit = hit('s-1');
    store.delete('s-1');
    // The same episode reported again (a replayed limit) and cleared again.
    store.upsert({ sessionId: 's-1', limit, scope: 'account', accountPath: null });
    clock = at(6 * HOUR);
    store.delete('s-1');
    expect(store.history('s-1').map((e) => e.resolution)).toEqual(['resumed-early']);
  });

  it('serves the last 20 episodes, oldest first', () => {
    bind('s-1', 'claude-code');
    for (let i = 0; i < LIMIT_HISTORY_PAGE + 3; i += 1) {
      hit('s-1', i * HOUR);
      clock = at(i * HOUR + 1);
      store.delete('s-1');
    }
    const sinces = store.history('s-1').map((e) => e.since);
    expect(sinces).toHaveLength(LIMIT_HISTORY_PAGE);
    expect(sinces[0]).toBe(at(3 * HOUR).toISOString());
    expect(sinces.at(-1)).toBe(at((LIMIT_HISTORY_PAGE + 2) * HOUR).toISOString());
  });
});

describe('sweep and rekey', () => {
  it('sweeps episodes resolved more than 30 days ago, and keeps the rest', () => {
    bind('s-1', 'claude-code');
    hit('s-1', 0);
    clock = at(HOUR);
    store.delete('s-1');
    hit('s-1', 2 * HOUR);
    clock = at(3 * HOUR);
    store.delete('s-1');

    clock = at(2 * HOUR + LIMIT_HISTORY_RETENTION_MS);
    expect(store.sweepHistory()).toBe(1);
    expect(store.history('s-1').map((e) => e.since)).toEqual([at(2 * HOUR).toISOString()]);
  });

  it('moves the history with the session, with or without a live limit', () => {
    bind('old', 'claude-code');
    hit('old', 0);
    store.delete('old');
    store.rekeySession('old', 'new');
    expect(store.history('old')).toEqual([]);
    expect(store.history('new')).toEqual([
      expect.objectContaining({ sessionId: 'new', since: at(0).toISOString() }),
    ]);

    // With a live limit too, and idempotently.
    hit('old', 2 * HOUR);
    store.update('old', at(2 * HOUR).toISOString(), {
      plan: { mode: 'continued', sessionId: 'next', accountId: 'spare' },
    });
    store.rekeySession('old', 'new');
    store.rekeySession('old', 'new');
    expect(store.history('new').map((e) => e.resolution)).toEqual(['resumed-early', 'moved']);
    expect(store.get('new')?.limit.plan.mode).toBe('continued');
  });

  it('keeps the new id’s row when both ids hold the same episode', () => {
    bind('old', 'claude-code');
    bind('new', 'codex');
    hit('old', 0);
    hit('new', 0);
    store.delete('old');
    store.delete('new');
    store.rekeySession('old', 'new');
    expect(store.history('new').map((e) => e.runtime)).toEqual(['codex']);
    expect(store.history('old')).toEqual([]);
  });
});

describe('knowsSession', () => {
  it('knows a session with settings, a live limit, or history, and nothing else', () => {
    bind('bound', 'claude-code');
    hit('limited');
    hit('past');
    store.delete('past');
    db.delete(sessionMetadata).run();
    expect(store.knowsSession('limited')).toBe(true);
    expect(store.knowsSession('past')).toBe(true);
    expect(store.knowsSession('bound')).toBe(false);
    bind('bound', null);
    expect(store.knowsSession('bound')).toBe(true);
    expect(store.knowsSession('nobody')).toBe(false);
  });
});
