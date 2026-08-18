/**
 * The six row kinds both surfaces share, against the host that actually emits
 * them.
 *
 * `ConversationRow` names six kinds. Three of them — `message`, `day-divider`,
 * `unread-divider` — fall out of `buildTimelineRows`, which was already
 * surface-neutral before this programme and is the one piece of the two
 * timelines that never forked. The other three — `notice`, `moment`,
 * `thread-reply` — have no producer inside `features/conversation` at all: they
 * are read off a room's own entries by `roomEntryRowKind` and off its thread
 * grouping by `groupByThread`, both in this widget.
 *
 * **Which is why this file lives here and not beside the union.** A test in
 * `features/conversation` cannot import a widget (FSD, and ESLint enforces it),
 * so a test written there could only ever mirror the host's rule in a local
 * helper — and a mirror that is never compared to the original is exactly the
 * check that cannot fail. This file sees both ends: the union it must cover,
 * and the code that covers it.
 *
 * Two defects, two different reds:
 *
 * - Drop `'moment'` from `ConversationRow` → `RoomRowKind`'s `Extract` resolves
 *   to `never` and `roomEntryRowKind` stops compiling. Typecheck red.
 * - Drop the `body.moment` branch from `roomEntryRowKind` → the table below
 *   produces five kinds where six are named. Test red.
 */
import { describe, expect, it } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { buildTimelineRows, unreadPlacement, type TimelineRow } from '@/layers/shared/lib';
import type { ConversationRow } from '@/layers/features/conversation';
import { groupByThread, roomEntryRowKind } from '../lib/room-timeline';

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
 * Every kind the union holds, as values a test can count.
 *
 * `satisfies` is half the guard and `Exhaustive` is the other half: a kind
 * removed from `ConversationRow` makes this array hold a name the union does
 * not, and a kind ADDED to it leaves `Exhaustive` with something left over.
 * Either way the file stops compiling, which is the only way a list of strings
 * can be kept honest about a type.
 */
const ALL_KINDS = [
  'message',
  'day-divider',
  'unread-divider',
  'notice',
  'moment',
  'thread-reply',
] as const satisfies readonly ConversationRow['kind'][];

/** Fails to compile if the union grows a kind this file does not account for. */
type Exhaustive = Exclude<ConversationRow['kind'], (typeof ALL_KINDS)[number]>;
const _exhaustive: Exhaustive[] = [];
void _exhaustive;

/** One entry of a room's log, with only what the two host rules read. */
function entry(overrides: Partial<RoomEntry> & { id: string; seq: number }): RoomEntry {
  return {
    roomId: 'room-1',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'what happened to the build?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: overrides.id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: new Date(NOON).toISOString(),
    ...overrides,
  };
}

/**
 * A room's log put through the host's OWN pipeline, kind by kind.
 *
 * The same three calls `RoomTimeline` makes, in the same order: split the
 * threads off, lay the remaining flow out, and ask each laid-out row what it
 * is. The only thing written here rather than imported is the `Fragment`
 * `RoomTimeline` draws — a message row, then a reply line under it when the
 * grouping found replies — because that is JSX and not a function.
 */
function kindsDrawnFor(
  entries: readonly RoomEntry[],
  options: { lastReadSeq?: number | null } = {}
): ConversationRow['kind'][] {
  const { topLevel, repliesByRoot } = groupByThread(entries);
  const placement = unreadPlacement(topLevel, options.lastReadSeq ?? null);
  const rows = buildTimelineRows(
    topLevel.map((e) => item(e.id, e.authorId, Date.parse(e.createdAt) - NOON)),
    { now: NOW, lastSeenId: placement.lastSeenId, unreadFromStart: placement.fromStart }
  );

  return rows.flatMap((row): ConversationRow['kind'][] => {
    if (row.kind === 'day-divider') return ['day-divider'];
    if (row.kind === 'unread-divider') return ['unread-divider'];
    const target = topLevel[row.index]!;
    const drawn: ConversationRow['kind'][] = [roomEntryRowKind(target).kind];
    if (repliesByRoot.get(target.id)) drawn.push('thread-reply');
    return drawn;
  });
}

/**
 * The kind a laid-out row becomes when nothing but the grouping math is in
 * play — the three kinds `buildTimelineRows` can produce on its own.
 *
 * Used only by the grouping cases below, which are about WHERE the dividers
 * land rather than about the union's coverage.
 */
function layoutKind(row: TimelineRow): ConversationRow['kind'] {
  if (row.kind === 'day-divider') return 'day-divider';
  if (row.kind === 'unread-divider') return 'unread-divider';
  return 'message';
}

describe('ConversationRow — every kind has a producer, and the host is it', () => {
  it('draws all six kinds from one room, and no kind the union does not name', () => {
    // One log holding a reason for each, and one reason each: the list opens
    // with the day it starts on, the cursor at seq 1 opens the rule, the room
    // speaks about itself, a milestone is posted, and the last post is
    // answered in a thread.
    const entries = [
      entry({
        id: 'the-notice',
        seq: 1,
        kind: 'notice',
        authorId: 'system',
        body: { text: 'The cascade was stopped.', notice: 'cascade_stopped' },
      }),
      entry({
        id: 'the-moment',
        seq: 2,
        authorId: 'system',
        createdAt: new Date(NOON + FAR_MS).toISOString(),
        body: {
          text: 'tangerines joined your team',
          moment: {
            kind: 'joined_team',
            source: {
              kind: 'agent',
              ref: '/agents/tangerines',
              observedAt: '2026-08-18T09:00:00.000Z',
            },
            mintedByAgentRef: null,
          },
          subjectAuthorId: 'tangerines',
        },
      }),
      entry({
        id: 'the-root',
        seq: 3,
        createdAt: new Date(NOON + 2 * FAR_MS).toISOString(),
      }),
      entry({
        id: 'the-reply',
        seq: 4,
        authorId: 'kai',
        threadRootEntryId: 'the-root',
        createdAt: new Date(NOON + 3 * FAR_MS).toISOString(),
      }),
    ];

    const drawn = kindsDrawnFor(entries, { lastReadSeq: 1 });
    const counted = new Map<string, number>();
    for (const kind of drawn) counted.set(kind, (counted.get(kind) ?? 0) + 1);

    // Each of the six, exactly once. A kind missing here has no producer left
    // in the app, and a kind appearing that ALL_KINDS does not name is a row
    // the union has no word for.
    expect(
      Object.fromEntries([...counted].sort()),
      'every kind ConversationRow names must be reachable from a real room log'
    ).toEqual({
      'day-divider': 1,
      'unread-divider': 1,
      message: 1,
      notice: 1,
      moment: 1,
      'thread-reply': 1,
    });
    expect([...counted.keys()].sort()).toEqual([...ALL_KINDS].sort());
  });

  it('reads a notice off `kind` and a moment off the body, never the other way round', () => {
    // A moment is a POST, so `kind` cannot tell it apart from somebody talking
    // — the one rule a client that only read `kind` would get wrong, and the
    // reason this mapping has a name at all.
    const plain = entry({ id: 'a', seq: 1 });
    const notice = entry({ id: 'b', seq: 2, kind: 'notice', body: { text: 'ana joined' } });
    const moment = entry({
      id: 'c',
      seq: 3,
      body: {
        text: 'tangerines joined your team',
        moment: {
          kind: 'joined_team',
          source: {
            kind: 'agent',
            ref: '/agents/tangerines',
            observedAt: '2026-08-18T09:00:00.000Z',
          },
          mintedByAgentRef: null,
        },
      },
    });

    expect(roomEntryRowKind(plain).kind).toBe('message');
    expect(roomEntryRowKind(notice).kind).toBe('notice');

    const drawn = roomEntryRowKind(moment);
    expect(drawn.kind).toBe('moment');
    // The row it hands back carries the moment, so the caller never re-reads
    // the body to find what it already found.
    expect(drawn.kind === 'moment' && drawn.moment.kind).toBe('joined_team');
  });

  it('draws a reply line under the entry it answers, and under no other', () => {
    const entries = [
      entry({ id: 'answered', seq: 1 }),
      entry({ id: 'ignored', seq: 2, createdAt: new Date(NOON + FAR_MS).toISOString() }),
      entry({ id: 'reply', seq: 3, authorId: 'kai', threadRootEntryId: 'answered' }),
    ];

    // The reply itself is off the room's flow — it lives in the panel — so the
    // room draws two messages and exactly one reply line.
    expect(kindsDrawnFor(entries)).toEqual(['day-divider', 'message', 'thread-reply', 'message']);
  });
});

describe('ConversationRow — where the grouping math puts the dividers', () => {
  // `buildTimelineRows` predates this programme and is not changed by it. These
  // cases certify that pre-existing math still holds under the shared union —
  // the `GROUP_GAP_MS` defect below is what proves they can fail.

  it('maps every laid-out row to a kind the union holds', () => {
    const rows = buildTimelineRows(
      [item('a', 'ana', -25 * 60 * 60 * 1000), item('b', 'ana', 0), item('c', 'kai', CLOSE_MS)],
      { now: NOW, lastSeenId: 'a', unreadFromStart: false }
    );

    // A day boundary (a is yesterday), the unread rule after the cursor item,
    // and the three messages themselves.
    expect(rows.map(layoutKind)).toEqual([
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
    expect(rows.map(layoutKind)).toEqual([
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

    expect(rows.map(layoutKind)).toEqual(['day-divider', 'unread-divider', 'message', 'message']);
  });

  it('draws no rule at all for a reader with no cursor here', () => {
    const rows = buildTimelineRows([item('a', 'ana', 0)], {
      now: NOW,
      lastSeenId: unreadPlacement([{ id: 'a', seq: 1 }], null).lastSeenId,
    });

    expect(rows.map(layoutKind)).toEqual(['day-divider', 'message']);
  });
});
