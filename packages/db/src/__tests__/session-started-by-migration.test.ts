/**
 * What `session_started_by` enforces on its own (spec `flow-multiproject`
 * §7.7): one row per chat, and only the two kinds of starter core knows. The
 * limits it backs are counted in `apps/server/src/services/extensions`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { sessionStartedBy } from '../schema/session/session-started-by.js';

const NOW = '2026-09-29T09:00:00.000Z';

function row(overrides: Partial<typeof sessionStartedBy.$inferInsert> = {}) {
  return {
    sessionId: 'chat-1',
    kind: 'extension' as const,
    extensionId: 'flow',
    startedBySessionId: null,
    originExtensionId: 'flow',
    reason: '12 new ideas were waiting to be sorted',
    carried: false,
    permissionMode: null,
    starterPermissionMode: null,
    permissionSameAsStarter: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('session_started_by', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('stores who started a chat and reads it back', () => {
    db.insert(sessionStartedBy).values(row()).run();
    expect(db.select().from(sessionStartedBy).all()).toEqual([row()]);
  });

  it('marks a row as a move only when told, so a start is never mistaken for one', () => {
    const { carried: _carried, ...withoutCarried } = row();
    db.insert(sessionStartedBy).values(withoutCarried).run();
    expect(db.select().from(sessionStartedBy).get()?.carried).toBe(false);
  });

  it('records the level a chat was started at, and leaves it null when it was not given', () => {
    db.insert(sessionStartedBy)
      .values(
        row({
          sessionId: 'chat-2',
          kind: 'chat',
          extensionId: null,
          startedBySessionId: 'chat-1',
          permissionMode: 'acceptEdits',
          starterPermissionMode: 'bypassPermissions',
          permissionSameAsStarter: false,
        })
      )
      .run();
    const {
      permissionMode: _m,
      starterPermissionMode: _s,
      permissionSameAsStarter: _p,
      ...old
    } = row({ sessionId: 'chat-3' });
    db.insert(sessionStartedBy).values(old).run();

    expect(
      db
        .select()
        .from(sessionStartedBy)
        .all()
        .map((r) => [r.permissionMode, r.starterPermissionMode, r.permissionSameAsStarter])
    ).toEqual([
      ['acceptEdits', 'bypassPermissions', false],
      [null, null, null],
    ]);
  });

  it('keeps one row per chat', () => {
    db.insert(sessionStartedBy).values(row()).run();
    expect(() => db.insert(sessionStartedBy).values(row()).run()).toThrow(/UNIQUE/i);
  });

  it('refuses a starter kind it does not know', () => {
    expect(() =>
      db
        .insert(sessionStartedBy)
        .values(row({ kind: 'agent' as 'chat' }))
        .run()
    ).toThrow(/CHECK/i);
  });

  it('indexes the limit query by origin extension and time', () => {
    const plan = db.$client
      .prepare(
        `EXPLAIN QUERY PLAN SELECT count(*) FROM session_started_by
         WHERE origin_extension_id = ? AND created_at >= ?`
      )
      .all('flow', NOW) as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join(' ')).toMatch(
      /session_started_by_origin_created_idx/
    );
  });
});
