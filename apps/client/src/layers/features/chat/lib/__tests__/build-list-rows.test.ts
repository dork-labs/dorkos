import { describe, it, expect } from 'vitest';
import type { ChatMessage, MessageAuthor } from '@/layers/shared/model';
import { buildListRows, createListRowsCache, GROUP_GAP_MS, type ListRow } from '../build-list-rows';

/** Fixed "now": 2026-07-25 12:00 local, so day 25 reads as Today and 24 as Yesterday. */
const NOW = new Date(2026, 6, 25, 12, 0).getTime();

/** Local-time ISO timestamp in July 2026, so day keys are timezone-independent. */
function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 6, day, hour, minute).toISOString();
}

function msg(id: string, timestamp: string): ChatMessage {
  return { id, role: 'assistant', content: id, parts: [], timestamp };
}

/** Author resolver stub: message id -> author id, defaulting every message to one author. */
function authorsFrom(map: Record<string, string> = {}) {
  return (message: ChatMessage): MessageAuthor => {
    const id = map[message.id] ?? 'agent-a';
    return { kind: 'agent', id, displayName: id };
  };
}

function positions(rows: ListRow[]): string[] {
  return rows.filter((r) => r.kind === 'message').map((r) => r.grouping.position);
}

function kinds(rows: ListRow[]): string[] {
  return rows.map((r) => r.kind);
}

describe('buildListRows', () => {
  it('returns no rows for an empty transcript', () => {
    expect(buildListRows([], { resolveAuthor: authorsFrom(), now: NOW })).toEqual([]);
  });

  it('renders a single message as its own group behind a day divider', () => {
    const rows = buildListRows([msg('m1', at(25, 10))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message']);
    expect(rows[0]).toEqual({ kind: 'day-divider', key: 'day-2026-7-25-0', label: 'Today' });
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'msg-m1',
      messageIndex: 0,
      grouping: { position: 'only' },
      author: { id: 'agent-a' },
    });
  });

  it('keeps close messages from one author in a single group', () => {
    const rows = buildListRows(
      [msg('m1', at(25, 10)), msg('m2', at(25, 10, 1)), msg('m3', at(25, 10, 2))],
      { resolveAuthor: authorsFrom(), now: NOW }
    );

    expect(positions(rows)).toEqual(['first', 'middle', 'last']);
  });

  it('breaks the group when the author changes', () => {
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom({ m2: 'agent-b' }),
      now: NOW,
    });

    expect(positions(rows)).toEqual(['only', 'only']);
    // A new author does not add a day divider — same day.
    expect(kinds(rows)).toEqual(['day-divider', 'message', 'message']);
  });

  it('breaks the group on a gap longer than the threshold, but not at the threshold', () => {
    const start = at(25, 10);
    const exactly = new Date(Date.parse(start) + GROUP_GAP_MS).toISOString();
    const beyond = new Date(Date.parse(start) + GROUP_GAP_MS + 1).toISOString();

    expect(
      positions(
        buildListRows([msg('m1', start), msg('m2', exactly)], {
          resolveAuthor: authorsFrom(),
          now: NOW,
        })
      )
    ).toEqual(['first', 'last']);

    expect(
      positions(
        buildListRows([msg('m1', start), msg('m2', beyond)], {
          resolveAuthor: authorsFrom(),
          now: NOW,
        })
      )
    ).toEqual(['only', 'only']);
  });

  it('inserts a day divider at each boundary and breaks the group there', () => {
    const rows = buildListRows(
      [msg('m1', at(24, 23, 58)), msg('m2', at(24, 23, 59)), msg('m3', at(25, 0, 1))],
      { resolveAuthor: authorsFrom(), now: NOW }
    );

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'message', 'day-divider', 'message']);
    expect(positions(rows)).toEqual(['first', 'last', 'only']);
    expect((rows[0] as { label: string }).label).toBe('Yesterday');
    expect((rows[3] as { label: string }).label).toBe('Today');
  });

  it('labels older days with the weekday, and adds the year outside the current one', () => {
    const rows = buildListRows(
      [msg('m1', at(20, 9)), msg('m2', new Date(2025, 6, 20, 9).toISOString())],
      {
        resolveAuthor: authorsFrom(),
        now: NOW,
      }
    );

    const labels = rows.filter((r) => r.kind === 'day-divider').map((r) => r.label);
    expect(labels).toEqual(['Monday, July 20', 'July 20, 2025']);
  });

  it('places the unread rule before the first message after the cursor', () => {
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
      lastSeenMessageId: 'm1',
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'unread-divider', 'message']);
    expect(rows[2]).toEqual({ kind: 'unread-divider', key: 'unread-m2' });
  });

  it('re-opens the author group under the unread rule', () => {
    // Same author, same day, one minute apart — a pair that would otherwise be
    // one group. The rule between them must not orphan the second message as a
    // nameless, avatar-less continuation.
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
      lastSeenMessageId: 'm1',
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'unread-divider', 'message']);
    expect(positions(rows)).toEqual(['only', 'only']);
  });

  it('renders no unread rule when the cursor is the newest message', () => {
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
      lastSeenMessageId: 'm2',
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'message']);
  });

  it('puts the rule above everything when the whole transcript is unread', () => {
    // A reader who has read none of this session has a real cursor sitting at
    // zero, and `unreadPlacement` answers `fromStart` for it — the same answer a
    // room gives. This is the pass-through that makes the two draw the same line.
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
      lastSeenMessageId: null,
      unreadFromStart: true,
    });

    expect(kinds(rows)).toEqual(['day-divider', 'unread-divider', 'message', 'message']);
  });

  it('renders no unread rule when no cursor is supplied', () => {
    const rows = buildListRows([msg('m1', at(25, 10)), msg('m2', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'message']);
  });

  it('survives a cursor whose message is gone, with no rule rendered', () => {
    const rows = buildListRows([msg('m2', at(25, 10)), msg('m3', at(25, 10, 1))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
      lastSeenMessageId: 'm1-compacted-away',
    });

    expect(kinds(rows)).toEqual(['day-divider', 'message', 'message']);
  });

  it('places at most one unread rule', () => {
    const rows = buildListRows(
      [msg('m1', at(25, 10)), msg('m2', at(25, 10, 1)), msg('m3', at(25, 10, 2))],
      { resolveAuthor: authorsFrom(), now: NOW, lastSeenMessageId: 'm1' }
    );

    expect(rows.filter((r) => r.kind === 'unread-divider')).toHaveLength(1);
  });

  it('keeps messageIndex pointing into the original array across every divider', () => {
    const messages = [
      msg('m1', at(24, 9)),
      msg('m2', at(24, 9, 1)),
      msg('m3', at(25, 9)),
      msg('m4', at(25, 9, 1)),
    ];
    const rows = buildListRows(messages, {
      resolveAuthor: authorsFrom({ m4: 'agent-b' }),
      now: NOW,
      lastSeenMessageId: 'm2',
    });

    const messageRows = rows.filter((r) => r.kind === 'message');
    expect(messageRows.map((r) => r.messageIndex)).toEqual([0, 1, 2, 3]);
    for (const row of messageRows) {
      expect(row.message).toBe(messages[row.messageIndex]);
    }
    // Rows outnumber messages, so row index and message index have diverged.
    expect(rows.length).toBeGreaterThan(messages.length);
  });

  it('skips the day divider for a message with no usable timestamp', () => {
    const rows = buildListRows([msg('m1', ''), msg('m2', 'not-a-date'), msg('m3', at(25, 10))], {
      resolveAuthor: authorsFrom(),
      now: NOW,
    });

    expect(kinds(rows)).toEqual(['message', 'message', 'day-divider', 'message']);
    // The two undated messages still group together; the dated one opens a day.
    expect(positions(rows)).toEqual(['first', 'last', 'only']);
  });
});

describe('buildListRows with a layout cache (DOR-2912)', () => {
  it('reuses the rows a streamed word did not change, and answers exactly as a fresh layout', () => {
    const settled = Array.from({ length: 30 }, (_, i) =>
      msg(`m${i}`, at(24 + Math.floor(i / 20), 9, i))
    );
    const options = { resolveAuthor: authorsFrom({ m3: 'agent', m4: 'agent' }), now: NOW };
    const cache = createListRowsCache();
    const first = buildListRows([...settled, msg('live', at(25, 10))], { ...options, cache });
    const after = [...settled, { ...msg('live', at(25, 10)), content: 'more' }];
    const next = buildListRows(after, { ...options, cache });
    expect(next).toEqual(buildListRows(after, options));
    // Every row before the live message's group is the very same object.
    expect(next[0]).toBe(first[0]);
    expect(next.at(-1)).not.toBe(first.at(-1));
  });

  it('lays out from scratch when what the layout depends on changes', () => {
    const messages = [msg('a', at(25, 9)), msg('b', at(25, 9, 1))];
    const cache = createListRowsCache();
    const options = { resolveAuthor: authorsFrom(), now: NOW, cache };
    const first = buildListRows(messages, options);
    const moved = buildListRows(messages, { ...options, lastSeenMessageId: 'a' });
    expect(moved[0]).not.toBe(first[0]);
    expect(moved.map((row) => row.kind)).toContain('unread-divider');
  });

  it('answers exactly after a removal, after an older array, and for a new author resolver', () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, at(25, 9, i)));
    const resolveAuthor = authorsFrom({ m5: 'agent-b' });
    const cache = createListRowsCache();
    buildListRows(messages, { resolveAuthor, now: NOW, cache });
    // A message removed.
    const removed = [...messages.slice(0, 6), ...messages.slice(7)];
    expect(buildListRows(removed, { resolveAuthor, now: NOW, cache })).toEqual(
      buildListRows(removed, { resolveAuthor, now: NOW })
    );
    // A discarded render's older array, after a newer one filled the cache.
    expect(buildListRows(messages, { resolveAuthor, now: NOW, cache })).toEqual(
      buildListRows(messages, { resolveAuthor, now: NOW })
    );
    // A different resolver means different authors: nothing is reused.
    const other = authorsFrom({ m1: 'agent-c' });
    const fresh = buildListRows(messages, { resolveAuthor: other, now: NOW, cache });
    expect(fresh).toEqual(buildListRows(messages, { resolveAuthor: other, now: NOW }));
  });
});
