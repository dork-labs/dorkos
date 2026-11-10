/**
 * What the turn-context tables hold on their own (spec "Agent context viewer",
 * phase 1). Dedupe, retention and deletion are the store's, in
 * `apps/server/src/services/session/turn-context/turn-context-store.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('turn_context down-migration', () => {
  const DOWN = fileURLToPath(
    new URL('../down/20261109151737_turn_context.down.sql', import.meta.url)
  );
  const TABLES = ['turn_context_bodies', 'turn_context_parts', 'turn_contexts'];
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  /** Run the down file as the sqlite3 shell would, minus its dot-commands. */
  function runDown(): void {
    const sql = readFileSync(DOWN, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n');
    db.$client.exec(sql);
  }

  function tables(): string[] {
    return (
      db.$client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'turn_context%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  function ledger(): number {
    return (
      db.$client
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = 1794237457722')
        .get() as { n: number }
    ).n;
  }

  it('tells the sqlite3 shell to stop at the first error', () => {
    expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
  });

  it('drops the tables and every recorded body, and lets the migration run again', () => {
    db.insert(turnContextBodies)
      .values({ hash: 'h1', body: 'made-up memory', createdAt: '2026-11-08T00:00:00.000Z' })
      .run();
    expect(ledger()).toBe(1);

    runDown();

    expect(tables()).toEqual([]);
    expect(ledger()).toBe(0);
    runMigrations(db);
    expect(tables()).toEqual(TABLES);
    expect(db.select().from(turnContextBodies).all()).toEqual([]);
  });

  it('refuses, changing nothing, once a later migration has run', () => {
    db.insert(turnContextBodies)
      .values({ hash: 'h1', body: 'kept', createdAt: '2026-11-08T00:00:00.000Z' })
      .run();
    db.$client
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('later', Number.MAX_SAFE_INTEGER);

    expect(runDown).toThrow(/CHECK/);
    if (db.$client.inTransaction) db.$client.exec('ROLLBACK');

    expect(tables()).toEqual(TABLES);
    expect(ledger()).toBe(1);
    expect(db.select().from(turnContextBodies).all()).toHaveLength(1);
  });
});
