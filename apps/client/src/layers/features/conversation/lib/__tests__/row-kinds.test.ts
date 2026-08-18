/**
 * The row kinds both surfaces now share, against the grouping math that
 * produces them.
 *
 * `buildTimelineRows` was already surface-neutral before this programme — it is
 * the one piece of the two timelines that never forked. What is new is that its
 * output has a NAME on both surfaces: `ConversationRow`. These cases pin the
 * mapping, so a row kind cannot be added to one union and quietly missed by the
 * other.
 */
import { describe, expect, it } from 'vitest';
import { buildTimelineRows, unreadPlacement, type TimelineRow } from '@/layers/shared/lib';
import type { ConversationRow } from '../row-kinds';

/** Two minutes — inside the grouping gap. */
const CLOSE_MS = 2 * 60 * 1000;
/** Nine minutes — outside it. */
const FAR_MS = 9 * 60 * 1000;

const NOON = Date.parse('2026-08-18T12:00:00.000Z');
/** "Now" for the day labels, well after everything below. */
const NOW = Date.parse('2026-08-18T18:00:00.000Z');

/** One item on the timeline, at an offset from noon. */
function item(id: string, authorId: string, offsetMs: number) {
  return { id, authorId, timestamp: new Date(NOON + offsetMs).toISOString() };
}

/**
 * The kind a laid-out row becomes in `ConversationRow`'s union.
 *
 * The mapping a host performs, written once here so the assertions below read
 * as the union rather than as the grouping function's own vocabulary. A `notice`
 * or a `moment` is a MESSAGE row to the grouping math — the host reads
 * `body.notice` / `body.moment` off its own payload to tell them apart, which is
 * exactly why `payload` is opaque.
 */
function kindOf(row: TimelineRow): ConversationRow['kind'] {
  if (row.kind === 'day-divider') return 'day-divider';
  if (row.kind === 'unread-divider') return 'unread-divider';
  return 'message';
}

describe('ConversationRow — what the grouping math produces', () => {
  it('maps every laid-out row to a kind the union holds', () => {
    const rows = buildTimelineRows(
      [item('a', 'ana', -25 * 60 * 60 * 1000), item('b', 'ana', 0), item('c', 'kai', CLOSE_MS)],
      { now: NOW, lastSeenId: 'a', unreadFromStart: false }
    );

    // A day boundary (a is yesterday), the unread rule after the cursor item,
    // and the three messages themselves.
    expect(rows.map(kindOf)).toEqual([
      'day-divider',
      'message',
      'day-divider',
      'unread-divider',
      'message',
      'message',
    ]);
  });

  it('groups a run from one author, and breaks it when somebody else speaks', () => {
    const rows = buildTimelineRows(
      [item('a', 'ana', 0), item('b', 'ana', CLOSE_MS), item('c', 'kai', 2 * CLOSE_MS)],
      { now: NOW, lastSeenId: null }
    );
    const positions = rows.flatMap((row) => (row.kind === 'item' ? [row.grouping.position] : []));

    expect(positions).toEqual(['first', 'last', 'only']);
  });

  it('breaks a group on silence, however long the same person keeps talking', () => {
    // The case `GROUP_GAP_MS` exists for: same author, same day, nothing else
    // changed. Two rows that both read `only` means the gap opened a new group.
    const rows = buildTimelineRows([item('a', 'ana', 0), item('b', 'ana', FAR_MS)], {
      now: NOW,
      lastSeenId: null,
    });
    const positions = rows.flatMap((row) => (row.kind === 'item' ? [row.grouping.position] : []));

    expect(positions).toEqual(['only', 'only']);
  });

  it('puts the unread rule where unreadPlacement says, and re-opens the group under it', () => {
    const entries = [
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
      { id: 'c', seq: 3 },
    ];
    const placement = unreadPlacement(entries, 2);
    expect(placement).toEqual({ lastSeenId: 'b', fromStart: false });

    const rows = buildTimelineRows(
      [item('a', 'ana', 0), item('b', 'ana', CLOSE_MS), item('c', 'ana', 2 * CLOSE_MS)],
      { now: NOW, lastSeenId: placement.lastSeenId, unreadFromStart: placement.fromStart }
    );

    // Every list opens with the day it starts on. The rule then sits before
    // `c`, and `c` opens a group of its own rather than hanging nameless under
    // a full-bleed separator.
    expect(rows.map(kindOf)).toEqual([
      'day-divider',
      'message',
      'message',
      'unread-divider',
      'message',
    ]);
    const last = rows[4];
    expect(last?.kind === 'item' && last.grouping.position).toBe('only');
  });

  it('puts the rule above everything for a reader who has read nothing here', () => {
    const placement = unreadPlacement(
      [
        { id: 'a', seq: 1 },
        { id: 'b', seq: 2 },
      ],
      0
    );
    expect(placement).toEqual({ lastSeenId: null, fromStart: true });

    const rows = buildTimelineRows([item('a', 'ana', 0), item('b', 'ana', CLOSE_MS)], {
      now: NOW,
      lastSeenId: placement.lastSeenId,
      unreadFromStart: placement.fromStart,
    });

    expect(rows.map(kindOf)).toEqual(['day-divider', 'unread-divider', 'message', 'message']);
  });

  it('draws no rule at all for a reader with no cursor here', () => {
    const rows = buildTimelineRows([item('a', 'ana', 0)], {
      now: NOW,
      lastSeenId: unreadPlacement([{ id: 'a', seq: 1 }], null).lastSeenId,
    });

    expect(rows.map(kindOf)).toEqual(['day-divider', 'message']);
  });
});
