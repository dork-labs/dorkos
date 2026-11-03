/**
 * "My order" keys (DOR-3088): a key always fits between two neighbours, sorts the same under the
 * server's `localeCompare`, and a move rewrites only the moved to-do once a list is ordered.
 */
import { describe, expect, it } from 'vitest';
import { planMove, rankBetween } from '../lib/todo-rank';

describe('rankBetween', () => {
  it('fits between any two keys it made, however many times in a row', () => {
    let low: string | null = null;
    let high: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 40; i++) {
      const key: string = rankBetween(low, high)!;
      expect(key).not.toBeNull();
      if (low !== null) expect(key > low).toBe(true);
      if (high !== null) expect(key < high).toBe(true);
      expect(key.endsWith('a')).toBe(false);
      keys.push(key);
      // Squeeze alternately from the top and the bottom.
      if (i % 2 === 0) high = key;
      else low = key;
    }
    const byCode = [...keys].sort();
    const byLocale = [...keys].sort((a, b) => a.localeCompare(b));
    expect(byLocale).toEqual(byCode);
  });

  it('starts a list in the middle, and goes above and below it', () => {
    const first = rankBetween(null, null)!;
    expect(rankBetween(null, first)! < first).toBe(true);
    expect(rankBetween(first, null)! > first).toBe(true);
  });

  it('says so when a key from elsewhere leaves no room', () => {
    expect(rankBetween('a', 'a')).toBeNull();
  });
});

describe('planMove', () => {
  it('rewrites only the moved to-do in an ordered list', () => {
    const rows = [
      { id: 'a', rank: 'f' },
      { id: 'b', rank: 'm' },
      { id: 'c', rank: 't' },
    ];
    const changes = planMove(rows, 2, 0);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.id).toBe('c');
    expect(changes[0]!.rank < 'f').toBe(true);
  });

  it('keys the unranked to-dos above the new place the first time', () => {
    const rows = [
      { id: 'a', rank: null },
      { id: 'b', rank: null },
      { id: 'c', rank: null },
    ];
    const changes = planMove(rows, 0, 1);
    expect(changes.map((change) => change.id)).toEqual(['b', 'a']);
    expect(changes[0]!.rank < changes[1]!.rank).toBe(true);
  });

  it('does nothing for a move to the same place', () => {
    expect(planMove([{ id: 'a', rank: null }], 0, 0)).toEqual([]);
  });
});
