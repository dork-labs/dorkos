/**
 * The migration journal runs in one strict order (DOR-4089).
 *
 * drizzle applies a migration only when its `when` is newer than the last one a
 * database recorded, so an entry with an older or equal `when` is skipped on
 * every existing install, silently. Two branches that each take the next `idx`
 * collide the same way. #3536 nearly shipped both mistakes (Security M1).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journalPath = new URL('../../drizzle/meta/_journal.json', import.meta.url);

/**
 * Every way these entries break the order: `idx` must run 0..n-1 with no gap
 * or repeat, and each `when` must be strictly newer than the one before.
 */
function orderProblems(entries: readonly JournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(`${entry.tag}: idx ${entry.idx} at position ${position}`);
    }
    const before = entries[position - 1];
    if (before && entry.when <= before.when) {
      problems.push(`${entry.tag}: when ${entry.when} is not after ${before.tag} (${before.when})`);
    }
  });
  return problems;
}

/** Three entries in good order, for the cases below to break one at a time. */
function sample(): JournalEntry[] {
  return [
    { idx: 0, when: 100, tag: 'a' },
    { idx: 1, when: 200, tag: 'b' },
    { idx: 2, when: 300, tag: 'c' },
  ];
}

describe('the migration journal order (DOR-4089)', () => {
  it('runs idx 0..n with no gaps or repeats, and when strictly increasing', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(orderProblems(journal.entries)).toEqual([]);
  });

  it('refuses an equal when, which drizzle would skip on an existing install', () => {
    const entries = sample();
    entries[2]!.when = entries[1]!.when;
    expect(orderProblems(entries)).toEqual(['c: when 200 is not after b (200)']);
  });

  it('refuses a gap in idx', () => {
    const entries = sample();
    entries[2]!.idx = 3;
    expect(orderProblems(entries)).toEqual(['c: idx 3 at position 2']);
  });

  it('refuses a repeated idx, as two branches taking the same slot would write', () => {
    const entries = sample();
    entries[2]!.idx = 1;
    expect(orderProblems(entries)).toEqual(['c: idx 1 at position 2']);
  });
});
