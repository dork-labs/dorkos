/**
 * What `work_links` refuses on its own (DOR-4968): an unknown relation, an
 * empty or oversized end, an edge from a thing to itself, a bad source, and a
 * second row for one edge. The spelling of each end is the server store's
 * (`apps/server/src/services/work-graph/work-link-ref.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { workLinks } from '../schema/work-graph/work-links.js';

type Row = typeof workLinks.$inferInsert;

let db: Db;
let seq = 0;

function row(overrides: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `01JWORKLINK${String(seq).padStart(15, '0')}`,
    fromRef: 'dork:chat:new-chat',
    toRef: 'dork:chat:old-chat',
    relation: 'rekeyed_from',
    recordedAt: '2026-11-24T12:00:00.000Z',
    recordingChatId: null,
    source: 'server',
    ...overrides,
  };
}

function insert(overrides: Partial<Row> = {}): void {
  db.insert(workLinks).values(row(overrides)).run();
}

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
});

describe('work_links', () => {
  it('stores an edge as written', () => {
    insert({ recordingChatId: 'chat-1', source: 'open-pr' });
    expect(db.select().from(workLinks).all()).toEqual([
      expect.objectContaining({
        fromRef: 'dork:chat:new-chat',
        toRef: 'dork:chat:old-chat',
        relation: 'rekeyed_from',
        recordingChatId: 'chat-1',
        source: 'open-pr',
      }),
    ]);
  });

  it('takes every relation it names', () => {
    for (const relation of [
      'started',
      'claims',
      'opened',
      'works_on',
      'belongs_to',
      'produced',
      'forked_from',
      'rekeyed_from',
    ] as const)
      insert({ relation });
    expect(db.select().from(workLinks).all()).toHaveLength(8);
  });

  it('refuses a relation it does not name', () => {
    expect(() => insert({ relation: 'mentions' as Row['relation'] })).toThrow(
      /work_links_relation/
    );
  });

  it('refuses an empty or oversized end', () => {
    expect(() => insert({ fromRef: '' })).toThrow(/work_links_from_length/);
    expect(() => insert({ toRef: '' })).toThrow(/work_links_to_length/);
    expect(() => insert({ fromRef: `worktree:${'w'.repeat(292)}` })).toThrow(
      /work_links_from_length/
    );
    insert({ fromRef: `worktree:${'w'.repeat(291)}` });
  });

  it('refuses an edge from a thing to itself', () => {
    expect(() => insert({ toRef: 'dork:chat:new-chat' })).toThrow(/work_links_not_self/);
  });

  it('refuses an empty or oversized source, and an oversized recording chat', () => {
    expect(() => insert({ source: '' })).toThrow(/work_links_source/);
    expect(() => insert({ source: 's'.repeat(33) })).toThrow(/work_links_source/);
    expect(() => insert({ recordingChatId: 'c'.repeat(65) })).toThrow(
      /work_links_recording_chat_length/
    );
  });

  it('keeps one row per edge', () => {
    insert();
    expect(() => insert()).toThrow(/UNIQUE/i);
    insert({ relation: 'forked_from' });
  });
});
