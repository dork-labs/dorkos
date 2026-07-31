// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomTimeline } from '../ui/RoomTimeline';
import { unreadPlacement, toMessageAuthor, authorsById, groupByThread } from '../lib/room-timeline';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

function member(id: string, displayName: string, kind: 'human' | 'agent' = 'agent') {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id, kind, displayName },
  } as RoomRosterEntry;
}

function entry(seq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

function renderTimeline(overrides: Partial<Parameters<typeof RoomTimeline>[0]> = {}) {
  return render(
    <RoomTimeline
      roomId="room-1"
      viewerAuthorId="reader"
      entries={[]}
      members={[member('ana', 'Ana')]}
      lastReadSeq={null}
      reactionFrequents={['👍', '❤️', '🎉']}
      isLoading={false}
      error={null}
      onAddAgents={vi.fn()}
      {...overrides}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            })
          }
        >
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>{children}</TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('RoomTimeline', () => {
  it('shows a loading state before any history arrives', () => {
    renderTimeline({ isLoading: true });
    expect(screen.getByTestId('room-timeline-loading')).toBeInTheDocument();
  });

  it('says the room keeps everything when the history could not be read', () => {
    renderTimeline({ error: new Error('offline') });
    expect(screen.getByText(/Couldn't load this conversation/i)).toBeInTheDocument();
  });

  it('invites you to add agents when nothing has been said', () => {
    renderTimeline();
    expect(screen.getByText(/Nothing said here yet/i)).toBeInTheDocument();
  });

  it('names the author from the roster, not from the entry', () => {
    renderTimeline({ entries: [entry(1)] });
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('line 1')).toBeInTheDocument();
  });

  it('groups consecutive entries from one author under a single header', () => {
    renderTimeline({ entries: [entry(1), entry(2), entry(3)] });
    expect(screen.getAllByTestId('room-entry')).toHaveLength(3);
    expect(screen.getAllByText('Ana')).toHaveLength(1);
  });

  it('opens a new group when someone else speaks', () => {
    renderTimeline({
      members: [member('ana', 'Ana'), member('bo', 'Bo')],
      entries: [entry(1), entry(2, { authorId: 'bo' })],
    });
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
  });

  it('renders a notice as the room speaking, with no author beside it', () => {
    renderTimeline({
      entries: [
        entry(1, {
          kind: 'notice',
          authorId: 'system',
          body: { text: 'Ana stopped replying here.', notice: 'cascade_stopped' },
        }),
      ],
    });
    expect(screen.getByTestId('room-notice')).toHaveTextContent('Ana stopped replying here.');
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
  });

  it('draws a day boundary between calendar days', () => {
    renderTimeline({
      entries: [
        entry(1, { createdAt: '2026-07-24T10:00:00.000Z' }),
        entry(2, { createdAt: '2026-07-26T10:00:00.000Z' }),
      ],
    });
    expect(screen.getAllByTestId('day-divider')).toHaveLength(2);
  });

  it('marks where the reader left off, from the membership cursor', () => {
    renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: 1 });
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
  });

  it('draws no unread rule for a reader who is not a member', () => {
    renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: null });
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });

  it('draws the rule above everything for a member who has read nothing', () => {
    // The sidebar badges a member at cursor 0 with a real count, so the room has
    // to show a line — "5 unread" beside a room with no marker is a contradiction
    // the reader can see.
    const { container } = renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: 0 });
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
    const rows = Array.from(
      container.querySelectorAll('[data-testid="unread-divider"], [data-testid="room-entry"]')
    );
    expect(rows[0]).toHaveAttribute('data-testid', 'unread-divider');
  });
});

/**
 * A thread is a relation between entries in this room's log, not a room of its
 * own (ADR 260728-022013): a reply carries a pointer at the entry it answers,
 * and the timeline draws it there.
 */
describe('RoomTimeline — replies', () => {
  /** A reply to `entry-<parentSeq>`, at depth one. */
  function reply(seq: number, parentSeq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
    return entry(seq, {
      parentEntryId: `entry-${parentSeq}`,
      threadRootEntryId: `entry-${parentSeq}`,
      ...overrides,
    });
  }

  it('draws a reply under the message it answers, out of the room’s flow', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1), entry(3)] });

    const flow = screen.getByTestId('room-timeline');
    const rows = Array.from(flow.children).filter((child) =>
      ['room-entry', 'room-thread'].includes(child.getAttribute('data-testid') ?? '')
    );
    // Two rows in the room's own flow — the reply is not one of them.
    expect(rows.filter((r) => r.getAttribute('data-testid') === 'room-entry')).toHaveLength(2);

    const thread = screen.getByRole('group', { name: '1 reply' });
    expect(within(thread).getByText('line 2')).toBeInTheDocument();
    // And it hangs off `entry-1`, not off the entry that happens to precede it.
    expect(rows[0]).toHaveTextContent('line 1');
    expect(rows[1]).toBe(thread);
  });

  it('counts a thread rather than repeating the word for every reply', () => {
    renderTimeline({
      members: [member('ana', 'Ana'), member('bo', 'Bo')],
      entries: [entry(1), reply(2, 1), reply(3, 1, { authorId: 'bo' })],
    });

    const thread = screen.getByRole('group', { name: '2 replies' });
    expect(within(thread).getAllByTestId('room-entry')).toHaveLength(2);
  });

  it('leaves a room with no threads exactly as it was', () => {
    renderTimeline({ entries: [entry(1), entry(2), entry(3)] });

    expect(screen.getAllByTestId('room-entry')).toHaveLength(3);
    expect(screen.queryByTestId('room-thread')).not.toBeInTheDocument();
  });

  it('shows three replies and puts the rest one press away', async () => {
    const user = userEvent.setup();
    // Forty inline runs 1,364px in the browser — 1.6 viewports — which buries
    // the room's own next message under one aside.
    const replies = Array.from({ length: 40 }, (_, i) => reply(i + 2, 1));
    renderTimeline({ entries: [entry(1), ...replies, entry(42)] });

    const thread = screen.getByRole('group', { name: '40 replies' });
    expect(within(thread).getAllByTestId('room-entry')).toHaveLength(3);

    // Named for what pressing it does, and the count is the number still hidden.
    const more = within(thread).getByRole('button', { name: 'Show 37 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    await user.click(more);

    expect(within(thread).getAllByTestId('room-entry')).toHaveLength(40);
    expect(within(thread).getByRole('button', { name: 'Show fewer replies' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('asks nothing when the whole thread already fits', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1), reply(3, 1), reply(4, 1)] });

    const thread = screen.getByRole('group', { name: '3 replies' });
    expect(within(thread).getAllByTestId('room-entry')).toHaveLength(3);
    // Named by what it would say rather than "no buttons at all": every reply
    // now carries its own action toolbar, so a bare `queryByRole('button')`
    // would be answering a question about the toolbar and not about the count.
    expect(within(thread).queryByRole('button', { name: /^Show / })).not.toBeInTheDocument();
  });

  it('names the reply group once, not twice', () => {
    // An `aria-label` carrying the same words as the visible line makes a
    // screen reader announce the count, then announce it again (DOR-583).
    renderTimeline({ entries: [entry(1), reply(2, 1)] });

    const thread = screen.getByRole('group', { name: '1 reply' });
    expect(thread).not.toHaveAttribute('aria-label');
    expect(thread).toHaveAttribute('aria-labelledby');
  });

  it('says a reply is a reply when its thread head is out of the window', () => {
    // The default for any thread whose head is older than the loaded page. It
    // renders in the flow — it must not read as a brand new remark.
    renderTimeline({ entries: [reply(9, 1), entry(10)] });

    const orphan = screen.getByTestId('room-entry-orphan');
    expect(orphan).toHaveTextContent('Replying to an earlier message');
    // Exactly one: the entry that is genuinely top-level says nothing.
    expect(screen.getAllByTestId('room-entry-orphan')).toHaveLength(1);
    expect(screen.queryByTestId('room-thread')).not.toBeInTheDocument();
  });

  it('keeps the unread rule between two rows the reader can see', () => {
    // The cursor sits on the root; the only thing above it is a reply, which is
    // off the flow. The rule belongs before the next top-level entry.
    const { container } = renderTimeline({
      entries: [entry(1), reply(2, 1), entry(3)],
      lastReadSeq: 1,
    });

    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid="room-timeline"] > [data-testid="unread-divider"], [data-testid="room-timeline"] > [data-testid="room-entry"]'
      )
    );
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'room-entry',
      'unread-divider',
      'room-entry',
    ]);
  });
});

describe('groupByThread', () => {
  function reply(seq: number, rootId: string | null): RoomEntry {
    return entry(seq, { parentEntryId: rootId, threadRootEntryId: rootId });
  }

  /**
   * Every entry handed in comes back out somewhere — in the flow, or under an
   * id that IS in the flow. This is the invariant the two-pass shape exists to
   * make structural, so it is asserted directly rather than case by case.
   */
  function expectNothingLost(input: RoomEntry[], result: ReturnType<typeof groupByThread>) {
    const flowIds = new Set(result.topLevel.map((e) => e.id));
    const placed = [...result.topLevel];
    for (const [rootId, replies] of result.repliesByRoot) {
      expect(flowIds.has(rootId)).toBe(true);
      placed.push(...replies);
    }
    expect(placed.map((e) => e.seq).sort((a, b) => a - b)).toEqual(input.map((e) => e.seq));
  }

  it('splits the log into the room’s flow and what hangs off it', () => {
    const input = [entry(1), reply(2, 'entry-1'), entry(3), reply(4, 'entry-1')];
    const result = groupByThread(input);

    expect(result.topLevel.map((e) => e.seq)).toEqual([1, 3]);
    expect(result.repliesByRoot.get('entry-1')?.map((e) => e.seq)).toEqual([2, 4]);
    expect(result.orphaned.size).toBe(0);
    expectNothingLost(input, result);
  });

  it('flattens a reply-to-a-reply under the thread’s head instead of eating it', () => {
    // The server refuses depth two today, but `threadPointers` says opening it
    // is one `if` and that "nothing else in the schema has an opinion". Keying
    // on `parentEntryId` would have made that false: this entry would be
    // written under `entry-2`, which is not in the flow, and never read back.
    const input = [
      entry(1),
      reply(2, 'entry-1'),
      entry(3, { parentEntryId: 'entry-2', threadRootEntryId: 'entry-1' }),
    ];
    const result = groupByThread(input);

    expect(result.topLevel.map((e) => e.seq)).toEqual([1]);
    expect(result.repliesByRoot.get('entry-1')?.map((e) => e.seq)).toEqual([2, 3]);
    expectNothingLost(input, result);
  });

  it('falls back to parentEntryId when only the scope pointer is missing', () => {
    // The two pointers are written together and pinned equal by a test, but
    // that is not yet a CHECK constraint, so a hand-written row can carry one.
    const input = [entry(1), entry(2, { parentEntryId: 'entry-1', threadRootEntryId: null })];
    const result = groupByThread(input);

    expect(result.topLevel.map((e) => e.seq)).toEqual([1]);
    expect(result.repliesByRoot.get('entry-1')?.map((e) => e.seq)).toEqual([2]);
  });

  it('does not let an entry pointing at itself disappear', () => {
    const input = [entry(1, { parentEntryId: 'entry-1', threadRootEntryId: 'entry-1' })];
    const result = groupByThread(input);

    expect(result.topLevel.map((e) => e.seq)).toEqual([1]);
    expect(result.orphaned.has('entry-1')).toBe(true);
    expectNothingLost(input, result);
  });

  it('never loses a line: an orphaned reply joins the flow rather than vanishing', () => {
    // History paged past the thread's head, so this page cannot hang the reply
    // anywhere. Showing it in the wrong place is recoverable; dropping it is
    // not — and it has already been marked read either way.
    const input = [reply(9, 'entry-1'), entry(10)];
    const result = groupByThread(input);

    expect(result.topLevel.map((e) => e.seq)).toEqual([9, 10]);
    expect(result.repliesByRoot.size).toBe(0);
    expect(result.orphaned.has('entry-9')).toBe(true);
    expect(result.orphaned.has('entry-10')).toBe(false);
    expectNothingLost(input, result);
  });
});

describe('unreadPlacement', () => {
  it('draws no rule when the reader is caught up', () => {
    expect(unreadPlacement([entry(1), entry(2)], 2)).toEqual({
      lastSeenId: null,
      fromStart: false,
    });
  });

  it('draws no rule for a non-member, matching the badge they also do not get', () => {
    expect(unreadPlacement([entry(1)], null)).toEqual({ lastSeenId: null, fromStart: false });
  });

  it('draws no rule in an empty room', () => {
    expect(unreadPlacement([], 0)).toEqual({ lastSeenId: null, fromStart: false });
  });

  it('puts the rule above everything for a member who has read nothing', () => {
    // The sidebar badges this room, so a room with no line would contradict it.
    expect(unreadPlacement([entry(1), entry(2)], 0)).toEqual({
      lastSeenId: null,
      fromStart: true,
    });
  });

  it('puts the rule above everything when the page starts past the cursor', () => {
    expect(unreadPlacement([entry(8), entry(9)], 3)).toEqual({
      lastSeenId: null,
      fromStart: true,
    });
  });

  it('names the newest entry at or below the cursor', () => {
    expect(unreadPlacement([entry(1), entry(4), entry(7)], 5)).toEqual({
      lastSeenId: 'entry-4',
      fromStart: false,
    });
  });
});

describe('toMessageAuthor', () => {
  it('renders a member from the roster', () => {
    const authors = authorsById([member('ana', 'Ana')]);
    expect(toMessageAuthor('ana', authors)).toMatchObject({
      id: 'ana',
      kind: 'agent',
      displayName: 'Ana',
    });
  });

  it('keeps a departed member’s words rather than dropping them', () => {
    expect(toMessageAuthor('gone', new Map())).toMatchObject({ displayName: 'Unknown' });
  });

  it('gives every author a stable color derived from their id', () => {
    const first = toMessageAuthor('ana', new Map());
    const second = toMessageAuthor('ana', new Map());
    expect(first.color).toBe(second.color);
    expect(first.color).not.toBe(toMessageAuthor('bo', new Map()).color);
  });
});
