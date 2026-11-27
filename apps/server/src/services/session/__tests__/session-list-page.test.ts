/**
 * The chat lists' paging (DOR-4982): latest activity first, the order the
 * chat list and the sidebar showed before paging; the recent list's first page
 * keeps every chat you touched today; cursors are sealed to their reader.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import { recentSessionsPage, sessionListPage } from '../catalog/session-list-page.js';

function chat(id: string, updatedAt: string): Session {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    permissionMode: 'default',
    runtime: 'fake-a',
  };
}

const refuse = () => new Error('refused');
const options = (limit: number, cursor?: string, sealedFor = 'owner') => ({
  list: 'chats',
  query: { limit, ...(cursor && { cursor }) },
  sealedFor,
  refuse,
});

// Started oldest to newest, but active in another order, and one time spelled with an offset.
const rows = [
  chat('started-first', '2026-03-04T00:00:00.000Z'),
  chat('second', '2026-03-03T00:00:00.000Z'),
  chat('third', '2026-03-02T01:00:00+01:00'),
  chat('fourth', '2026-03-05T00:00:00.000Z'),
  chat('fifth', '2026-03-01T00:00:00.000Z'),
];

/** Every id, page by page, as a client following `nextCursor` reads them. */
function walk(page: (cursor?: string) => { items: Session[]; nextCursor: string | null }) {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const next = page(cursor);
    seen.push(...next.items.map((s) => s.id));
    cursor = next.nextCursor ?? undefined;
  } while (cursor);
  return seen;
}

describe('sessionListPage', () => {
  it('reads every page in the order the list showed before paging: updatedAt, newest first', () => {
    const before = [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const limit of [1, 2, 200]) {
      expect(walk((cursor) => sessionListPage(rows, options(limit, cursor)))).toEqual(
        before.map((s) => s.id)
      );
    }
  });

  it('refuses a cursor sealed for another reader instead of starting over', () => {
    const first = sessionListPage(rows, options(2, undefined, 'agent:a'));
    expect(() => sessionListPage(rows, options(2, first.nextCursor!, 'agent:b'))).toThrow(
      'refused'
    );
  });
});

describe('recentSessionsPage', () => {
  const recent = [
    chat('newest', '2026-03-04T00:00:00.000Z'),
    chat('newer', '2026-03-03T00:00:00.000Z'),
    chat('touched', '2026-03-02T00:00:00.000Z'),
    chat('dropped', '2026-03-01T00:00:00.000Z'),
  ];

  it('keeps a touched chat on the first page, in its place, and leaves it off later pages', () => {
    const kept = new Set(['touched']);
    const first = recentSessionsPage(recent, kept, options(1));
    expect(first.items.map((s) => s.id)).toEqual(['newest', 'touched']);
    expect(walk((cursor) => recentSessionsPage(recent, kept, options(1, cursor)))).toEqual([
      'newest',
      'touched',
      'newer',
      'dropped',
    ]);
  });

  it('adds a kept chat once, and not at all when the page already holds it', () => {
    // A chat two agent folders both claim is listed twice.
    const twice = [recent[0]!, recent[2]!, recent[0]!, recent[2]!];
    const first = recentSessionsPage(twice, new Set(['newest', 'touched']), options(1));
    expect(first.items.map((s) => s.id)).toEqual(['newest', 'touched']);
  });
});
