/**
 * Keeps the money list complete (DOR-4624). A snapshot of every Composio
 * action whose name or description says it may move money, and that is not a
 * read, sits in `fixtures/money-word-candidates.json`. Each one must be a
 * one-by-one pick already (a money app, a money name or a pinned slug), or be
 * listed in `fixtures/money-word-reviewed.ts` with why it moves no money. A
 * new match with neither fails; nothing passes by default.
 *
 * The trade-off, Security's condition for this test (numbers from the
 * 2026-11-18 catalog: 1,817 apps, 92,037 actions). The ticket's broad word
 * list (pay, charge, refund, payout, transfer, order, trade, credit, debit)
 * left 1,195 non-read actions in 400 apps needing a reason, too many to review
 * honestly. The tight matcher in `helpers/money-words.ts` matches 835 non-read
 * actions in 195 apps; after the money apps and pins of DOR-4624 it leaves 48
 * that need a reason. Skipped on purpose: "order" and "credit" on their own
 * (a sort order, a film's credits) and in descriptions, which count only
 * beside a spend verb in the name, and per-call credit wording ("costs 10
 * credits"), which the paid list (`PAID_BY_DEFAULT_TOOLKITS`) covers instead.
 *
 * Refresh the snapshot with `scripts/composio-money-word-candidates.mjs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyComposioAction } from '../action-classes.js';
import { MONEY_WORD_REVIEWED } from './fixtures/money-word-reviewed.js';
import { matchesMoneyWords } from './helpers/money-words.js';

interface CandidateRow {
  slug: string;
  tags: string[];
  description: string;
}

const snapshot = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'money-word-candidates.json'), 'utf8')
) as { checkedAt: string; matcher: string; toolkits: Record<string, CandidateRow[]> };

const rows = Object.entries(snapshot.toolkits).flatMap(([toolkit, actions]) =>
  actions.map((action) => ({ toolkit, ...action }))
);
const classify = (row: (typeof rows)[number]) =>
  classifyComposioAction(row.toolkit, row.slug, row.tags);

describe('money-word matches stay one-by-one picks or have a reason (DOR-4624)', () => {
  it('has a dated snapshot from the tight matcher', () => {
    expect(snapshot.matcher).toBe('tight');
    expect(snapshot.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('holds only rows the matcher still picks, and no reads', () => {
    // A hand-edited row can't hide an action: each must still be a non-read match.
    const misfits = rows
      .filter(
        (row) =>
          !matchesMoneyWords(row.slug, row.description, row.toolkit) || classify(row) === 'read'
      )
      .map((row) => `${row.toolkit} ${row.slug}`);
    expect(misfits).toEqual([]);
  });

  it('keeps every match a one-by-one pick unless it has a reason', () => {
    const unexplained = rows
      .filter((row) => classify(row) !== 'destructive' && !MONEY_WORD_REVIEWED[row.slug])
      .map(
        (row) =>
          `${row.slug}: pin it in action-classes.ts, or add why it moves no money to fixtures/money-word-reviewed.ts`
      );
    expect(unexplained).toEqual([]);
  });

  it('lists no stale reason', () => {
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    // Gone from the snapshot, or a one-by-one pick now: the reason explains nothing.
    const stale = Object.keys(MONEY_WORD_REVIEWED)
      .filter((slug) => {
        const row = bySlug.get(slug);
        return !row || classify(row) === 'destructive';
      })
      .map((slug) => `${slug}: remove the stale reason`);
    expect(stale).toEqual([]);
  });
});
