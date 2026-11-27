import { describe, expect, it } from 'vitest';
import { isInvalidCursor, keysetPage } from '../keyset-page.js';

const rows = [
  { id: 'a', at: '2026-01-01T00:00:00.000Z' },
  { id: 'c', at: '2026-01-03T00:00:00.000Z' },
  { id: 'b', at: '2026-01-03T00:00:00.000Z' },
  { id: 'd', at: '2026-01-02T00:00:00.000Z' },
];
const keyOf = (row: (typeof rows)[number]) => [row.at, row.id] as const;

describe('keysetPage', () => {
  it('walks every row once, newest first with the higher id first on a tie', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = keysetPage('list', rows, keyOf, { limit: 3, ...(cursor && { cursor }) });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['c', 'b', 'd', 'a']);
  });

  it('ends with a null cursor when the last page is exactly full', () => {
    expect(keysetPage('list', rows, keyOf, { limit: 4 }).nextCursor).toBeNull();
  });

  it('refuses a cursor another list gave, or one it cannot read, instead of starting over', () => {
    const other = keysetPage('other', rows, keyOf, { limit: 1 }).nextCursor!;
    for (const cursor of [other, 'not-a-cursor']) {
      let thrown: unknown;
      try {
        keysetPage('list', rows, keyOf, { cursor, limit: 2 });
      } catch (error) {
        thrown = error;
      }
      expect(isInvalidCursor(thrown)).toBe(true);
    }
  });
});
