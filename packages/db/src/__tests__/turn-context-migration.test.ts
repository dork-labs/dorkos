/**
 * What the turn-context tables hold on their own (spec "Agent context viewer",
 * phase 1). Dedupe, retention and deletion are the store's, in
 * `apps/server/src/services/session/turn-context/turn-context-store.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import {
  turnContextBodies,
  turnContextParts,
  turnContexts,
} from '../schema/session/turn-context.js';

describe('turn_context tables', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  function insertTurn(id: string): void {
    db.insert(turnContexts)
      .values({
        id,
        sessionId: 's1',
        runtime: 'codex',
        place: 'chat',
        systemSentThisTurn: true,
        createdAt: '2026-11-08T00:00:00.000Z',
      })
      .run();
  }

  it('stores a body once per hash', () => {
    const row = { hash: 'h1', body: 'text', createdAt: '2026-11-08T00:00:00.000Z' };
    db.insert(turnContextBodies).values(row).run();
    expect(() => db.insert(turnContextBodies).values(row).run()).toThrow(/UNIQUE/i);
  });

  it('deletes a turn’s parts with the turn', () => {
    insertTurn('t1');
    db.insert(turnContextParts)
      .values({
        turnContextId: 't1',
        position: 0,
        slot: 'prompt',
        bodyHash: 'h1',
        bytes: 4,
        tokensEstimate: 1,
        redacted: false,
      })
      .run();
    db.delete(turnContexts).run();
    expect(db.select().from(turnContextParts).all()).toEqual([]);
  });
});
