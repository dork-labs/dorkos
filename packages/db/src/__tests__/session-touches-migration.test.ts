/**
 * What `session_touches` holds on its own (spec `your-activity-first` D1): one
 * row per chat, both times optional. Which time wins is decided by the store in
 * `apps/server/src/services/session/origin/session-touch-store.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { sessionTouches } from '../schema/session/session-touches.js';

describe('session_touches', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('stores an opened-only row with no write time', () => {
    db.insert(sessionTouches)
      .values({ sessionId: 'chat-1', openedAt: '2026-10-08T09:00:00.000Z' })
      .run();
    expect(db.select().from(sessionTouches).all()).toEqual([
      { sessionId: 'chat-1', openedAt: '2026-10-08T09:00:00.000Z', wroteAt: null },
    ]);
  });

  it('keeps one row per chat', () => {
    db.insert(sessionTouches).values({ sessionId: 'chat-1' }).run();
    expect(() => db.insert(sessionTouches).values({ sessionId: 'chat-1' }).run()).toThrow(
      /UNIQUE/i
    );
  });
});
