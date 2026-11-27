import { describe, expect, it } from 'vitest';
import { keysetPage } from '../keyset-page.js';

const rows = [
  { id: 'a', at: '2026-01-01T00:00:00.000Z' },
  { id: 'c', at: '2026-01-03T00:00:00.000Z' },
  { id: 'b', at: '2026-01-03T00:00:00.000Z' },
  { id: 'd', at: '2026-01-02T00:00:00.000Z' },
];
const keyOf = (row: (typeof rows)[number]) => [row.at, row.id] as const;
const refuse = () => new Error('refused');

/** Every id, page by page at `limit`, following `nextCursor`. */
function walk(limit: number): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = keysetPage('list', rows, keyOf, { limit, ...(cursor && { cursor }) }, refuse);
    seen.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return seen;
}

describe('keysetPage', () => {
  it('walks every row once, newest first with the higher id first on a tie', () => {
    expect(walk(3)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('cuts a page between two rows with the same time and loses neither', () => {
    const first = keysetPage('list', rows, keyOf, { limit: 1 }, refuse);
    expect(first.items.map((row) => row.id)).toEqual(['c']);
    const second = keysetPage('list', rows, keyOf, { limit: 1, cursor: first.nextCursor! }, refuse);
    expect(second.items.map((row) => row.id)).toEqual(['b']);
    expect(walk(1)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('ends with a null cursor when the last page is exactly full', () => {
    expect(keysetPage('list', rows, keyOf, { limit: 4 }, refuse).nextCursor).toBeNull();
  });

  it('refuses a cursor another list gave, or one it cannot read, instead of starting over', () => {
    const other = keysetPage('other', rows, keyOf, { limit: 1 }, refuse).nextCursor!;
    for (const cursor of [other, 'not-a-cursor']) {
      expect(() => keysetPage('list', rows, keyOf, { cursor, limit: 2 }, refuse)).toThrow(
        'refused'
      );
    }
  });

  it('seals a reader-bound cursor that walks the same order and opens for no other reader', () => {
    const first = keysetPage('list', rows, keyOf, { limit: 2 }, refuse, 'agent:a');
    expect(first.nextCursor).not.toContain('list');
    const next = { limit: 2, cursor: first.nextCursor! };
    expect(keysetPage('list', rows, keyOf, next, refuse, 'agent:a').items.map((r) => r.id)).toEqual(
      ['d', 'a']
    );
    for (const reader of ['agent:b', 'owner', undefined]) {
      expect(() => keysetPage('list', rows, keyOf, next, refuse, reader)).toThrow('refused');
    }
  });
});
