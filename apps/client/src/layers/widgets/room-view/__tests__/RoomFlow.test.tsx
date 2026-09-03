// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { AuthorOrigin, RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { authorColor } from '@/layers/entities/room';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { RoomFlow } from '../ui/RoomFlow';
import { unreadPlacement } from '@/layers/shared/lib';
import { toMessageAuthor, authorsById, groupByThread } from '../lib/room-timeline';

// Every row reads route state to decide where its author face leads
// (`useProfileDeepLink`), and this file mounts the timeline with no router.
// Where that link goes has its own file —
// `RoomMessage.click-to-profile.test.tsx`, which mounts a real router and
// asserts the id that travels.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

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

/** A roster member's optional render-cache and origin fields, for the tests that vary them. */
interface MemberOverrides {
  emoji?: string;
  color?: string;
  origin?: AuthorOrigin;
  /** The stable handle the fleet's faces are keyed by. Agents only. */
  agentRef?: string;
}

function member(
  id: string,
  displayName: string,
  kind: 'human' | 'agent' = 'agent',
  overrides: MemberOverrides = {}
): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: overrides.origin ?? 'local',
    author: {
      id,
      kind,
      displayName,
      handle: null,
      emoji: overrides.emoji,
      color: overrides.color,
      agentRef: overrides.agentRef,
    },
  };
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

/** The providers a room row needs: a query client, a transport and tooltips. */
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TransportProvider transport={createMockTransport()}>
        <TooltipProvider>
          {/* The same conversation the room mounts (`RoomSurface`): its rows read
              capabilities from it, so a bench without one is testing a component
              in a state the app never puts it in. */}
          <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
            {children}
          </Conversation.Root>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** The timeline with everything it needs supplied, so a test names only what it is about. */
function FeedHarness(overrides: Partial<Parameters<typeof RoomFlow>[0]> = {}) {
  return (
    <RoomFlow
      roomId="room-1"
      roomName="general"
      viewerAuthorId="reader"
      entries={[]}
      members={[member('ana', 'Ana')]}
      lastReadSeq={null}
      reactionFrequents={['👍', '❤️', '🎉']}
      isLoading={false}
      error={null}
      onAddAgents={vi.fn()}
      onOpenThread={vi.fn()}
      {...overrides}
    />
  );
}

function renderTimeline(overrides: Partial<Parameters<typeof RoomFlow>[0]> = {}) {
  return render(<FeedHarness {...overrides} />, { wrapper: Wrapper });
}

describe('RoomFlow', () => {
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

  it('renders a moment as its own line, and lets the next message start fresh', () => {
    // A moment draws its own band rather than the message grid, so it must not
    // become the head of an author group: the message under it would inherit
    // the continuation layout and arrive with no name and no avatar beneath a
    // row that never showed either.
    renderTimeline({
      entries: [
        entry(1, {
          body: {
            text: 'Ana opened your first pull request.',
            moment: {
              kind: 'first_pr',
              source: {
                kind: 'pull_request',
                ref: 'https://example.test/pull/1',
                observedAt: '2026-07-26T10:00:00.000Z',
              },
              mintedByAgentRef: null,
            },
          },
        }),
        entry(2),
      ],
    });

    expect(screen.getByTestId('room-moment')).toHaveTextContent(
      'Ana opened your first pull request.'
    );
    // The message below it is a group START: its own author line is on screen.
    // Scoped to the message row, because the moment above it names the identity
    // it is about too — an unscoped query would pass on the moment's label
    // while the message under it stayed anonymous.
    const message = screen.getByTestId('room-entry');
    expect(within(message).getByText('Ana')).toBeInTheDocument();
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
 * own (ADR 260728-022013). The timeline no longer draws the replies themselves
 * — the inline gathering was retired for the side panel (design record §3) —
 * so what it owes each thread root is one quiet, honest row.
 */
describe('RoomFlow — thread reply rows', () => {
  /** A reply to `entry-<parentSeq>`, at depth one. */
  function reply(seq: number, parentSeq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
    return entry(seq, {
      parentEntryId: `entry-${parentSeq}`,
      threadRootEntryId: `entry-${parentSeq}`,
      ...overrides,
    });
  }

  it('shows a reply row under the root and keeps the replies out of the flow', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1), entry(3)] });

    // Two rows in the room's own flow. The reply is not one of them, and its
    // text is nowhere on screen — that is the whole point of the panel.
    expect(screen.getAllByTestId('room-entry')).toHaveLength(2);
    expect(screen.queryByText('line 2')).not.toBeInTheDocument();

    const row = screen.getByTestId('room-thread-replies');
    expect(row).toHaveTextContent('1 reply');
  });

  it('grows its own box on a phone rather than reaching invisibly past it', () => {
    // On a phone this row is the ONLY way into a thread. It briefly claimed a
    // 44px target with an invisible `::after`, and that stole from the pills
    // above it — so it takes real padding below the breakpoint instead, which
    // cannot overlap anything because everything under it moves down.
    //
    // **Geometry is the evidence; these assertions are only its fingerprint.**
    // Measured in Chromium at 390×844, on a message carrying both reactions and
    // a thread, with `elementFromPoint` scanned a pixel at a time down the
    // centre of each control:
    //
    //   before — pill reach y128–178, this row's reach y160–208. The 18px they
    //     shared went to this row, so the pill's real target was 30px of the
    //     50px it claimed and a tap meant for a reaction opened a thread. The
    //     top of the pill's reach also sat over the last 8px of message text
    //     (text ended y136), and the bottom of this row's landed 2px inside the
    //     next message's text (y206).
    //   after  — msg text ⋯136 │ 4px │ pill 140–166 (26px) │ 6px │ this row
    //     172–208 (36px) │ 10px │ next msg text 218⋯. The column scan is
    //     strictly ordered with a non-interactive gap between every control:
    //     pill 26px effective, this row 35px, nothing overlapping anything.
    //
    // Rerun by rendering this component at 390×844 with the built CSS and
    // walking `document.elementFromPoint` down each control's centre line.
    renderTimeline({ entries: [entry(1), reply(2, 1)] });

    const row = screen.getByTestId('room-thread-replies');
    expect(row.className).toContain('px-2 py-2');
    expect(row.className).toContain('md:px-1 md:py-0.5');
    // No invisible reach, at any breakpoint.
    expect(row.className).not.toContain('after:');
  });

  it('carries the last reply’s whole date, not just a clock reading', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1)] });

    const stamp = within(screen.getByTestId('room-thread-replies')).getByText(/^\d{1,2}:\d\d/);
    expect(stamp.tagName).toBe('TIME');
    expect(stamp).toHaveAttribute('datetime', '2026-07-26T10:00:00.000Z');
    expect(stamp.getAttribute('title')).toMatch(/2026/);
  });

  it('hangs the row off its own root, not off whatever precedes it', () => {
    const { container } = renderTimeline({ entries: [entry(1), reply(2, 1), entry(3)] });

    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid="room-timeline"] [data-testid="room-entry"], [data-testid="room-timeline"] [data-testid="room-thread-replies"]'
      )
    );
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'room-entry',
      'room-thread-replies',
      'room-entry',
    ]);
    expect(rows[0]).toHaveTextContent('line 1');
  });

  it('counts the thread rather than repeating the word for every reply', () => {
    renderTimeline({
      members: [member('ana', 'Ana'), member('bo', 'Bo')],
      entries: [entry(1), reply(2, 1), reply(3, 1, { authorId: 'bo' })],
    });

    expect(screen.getByTestId('room-thread-replies')).toHaveTextContent('2 replies');
  });

  it('stays one quiet row however long the thread gets', () => {
    // The reason the inline gathering was retired: forty replies used to run
    // 1,364px — 1.6 viewports — and bury the room's own next message.
    const replies = Array.from({ length: 40 }, (_, i) => reply(i + 2, 1));
    renderTimeline({ entries: [entry(1), ...replies, entry(42)] });

    expect(screen.getAllByTestId('room-thread-replies')).toHaveLength(1);
    expect(screen.getByTestId('room-thread-replies')).toHaveTextContent('40 replies');
    expect(screen.getAllByTestId('room-entry')).toHaveLength(2);
  });

  it('dates the thread by its newest reply', () => {
    renderTimeline({
      entries: [
        entry(1),
        reply(2, 1, { createdAt: '2026-07-26T08:00:00.000Z' }),
        reply(3, 1, { createdAt: '2026-07-26T11:30:00.000Z' }),
      ],
    });

    const row = screen.getByTestId('room-thread-replies');
    const expected = new Date('2026-07-26T11:30:00.000Z').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(row).toHaveTextContent(`last ${expected}`);
  });

  it('opens the thread when the row is pressed', async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    renderTimeline({ entries: [entry(1), reply(2, 1)], onOpenThread });

    await user.click(screen.getByTestId('room-thread-replies'));

    // The ROOT's id — the panel is opened on the thread's head.
    expect(onOpenThread).toHaveBeenCalledWith('entry-1');
  });

  it('says which thread is already open', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1)], openThreadId: 'entry-1' });

    expect(screen.getByTestId('room-thread-replies')).toHaveAttribute('aria-expanded', 'true');
  });

  it('accents the row and counts what arrived since the reader last looked', () => {
    // Derived from the same cursor the unread rule is drawn from — no schema,
    // and nothing that can disagree with the line a few pixels above it.
    renderTimeline({ entries: [entry(1), reply(2, 1), reply(3, 1)], lastReadSeq: 2 });

    const row = screen.getByTestId('room-thread-replies');
    expect(row).toHaveAttribute('data-unread');
    expect(row).toHaveTextContent('1 new');
  });

  it('leaves a read thread unaccented and says nothing about new replies', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1)], lastReadSeq: 9 });

    const row = screen.getByTestId('room-thread-replies');
    expect(row).not.toHaveAttribute('data-unread');
    expect(row).not.toHaveTextContent('new');
  });

  it('claims nothing unread for a reader who is not a member', () => {
    renderTimeline({ entries: [entry(1), reply(2, 1)], lastReadSeq: null });

    expect(screen.getByTestId('room-thread-replies')).not.toHaveAttribute('data-unread');
  });

  it('leaves a room with no threads exactly as it was', () => {
    renderTimeline({ entries: [entry(1), entry(2), entry(3)] });

    expect(screen.getAllByTestId('room-entry')).toHaveLength(3);
    expect(screen.queryByTestId('room-thread-replies')).not.toBeInTheDocument();
  });

  it('says a reply is a reply when its thread head is out of the window', () => {
    // The default for any thread whose head is older than the loaded page. It
    // renders in the flow — it must not read as a brand new remark.
    renderTimeline({ entries: [reply(9, 1), entry(10)] });

    expect(screen.getByTestId('room-entry-orphan')).toHaveTextContent(
      'Replying to an earlier message'
    );
    expect(screen.getAllByTestId('room-entry-orphan')).toHaveLength(1);
    expect(screen.queryByTestId('room-thread-replies')).not.toBeInTheDocument();
  });

  it('draws a whole page of replies as one thread once their root rides along', () => {
    // DOR-690, at the size it actually happened. A page of fifty replies to one
    // much older root used to be fifty flat rows with nothing on them saying
    // they answered anything; the page now arrives with the root in front of it
    // (`listRoomEntries`), and fifty rows collapse to a message and its thread.
    const root = entry(1);
    const replies = Array.from({ length: 50 }, (_, i) => reply(152 + i, 1));

    renderTimeline({ entries: [root, ...replies] });

    expect(screen.getAllByTestId('room-entry')).toHaveLength(1);
    expect(screen.getByTestId('room-thread-replies')).toHaveTextContent('50 replies');
    expect(screen.queryByTestId('room-entry-orphan')).not.toBeInTheDocument();
  });

  it('keeps the unread rule between two rows the reader can see', () => {
    // The cursor sits on the root; the only thing above it is a reply, which is
    // off the flow. The rule belongs before the next top-level entry.
    const { container } = renderTimeline({
      entries: [entry(1), reply(2, 1), entry(3)],
      lastReadSeq: 1,
    });

    // Not a direct-child selector: the timeline is virtualized now, so every
    // row sits inside the positioning box the virtualizer measures it by. What
    // is being asserted — which rows the flow holds, in what order — is
    // unchanged; only how deep they sit is.
    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid="room-timeline"] [data-testid="unread-divider"], [data-testid="room-timeline"] [data-testid="room-entry"]'
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

  it('never stores an empty reply list, which is what makes the row safe', () => {
    // `threadReplySummary` requires at least one reply and throws otherwise.
    // This is the other half of that contract: a key exists here only because
    // something hangs off it, so the row can never be asked to summarise
    // nothing.
    const input = [entry(1), reply(2, 'entry-1'), entry(3)];
    const result = groupByThread(input);

    for (const replies of result.repliesByRoot.values()) {
      expect(replies.length).toBeGreaterThan(0);
    }
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

describe('RoomFlow as a feed', () => {
  /** Three messages from two people, so there are articles to move between. */
  const THREE = [
    entry(1),
    entry(2, { authorId: 'bo' }),
    entry(3, { authorId: 'ana', createdAt: '2026-07-26T11:00:00.000Z' }),
  ];
  const ROSTER = [member('ana', 'Ana'), member('bo', 'Bo')];

  it('is a feed, named for the room it is a history of', () => {
    // A page can hold two histories at once — the room and an open thread — so
    // an unnamed feed leaves a reader unable to tell which one they are in.
    renderTimeline({ entries: THREE, members: ROSTER });

    expect(screen.getByRole('feed', { name: 'Messages in general' })).toBeInTheDocument();
  });

  it('says it is busy while the history is still arriving, and not once it has', () => {
    renderTimeline({ isLoading: true });
    expect(screen.getByTestId('room-timeline-loading')).toHaveAttribute('aria-busy', 'true');

    cleanup();
    renderTimeline({ entries: THREE, members: ROSTER });
    // Written as false rather than left off: a feed that only ever GAINS the
    // attribute is one that announces a wait after the wait is over.
    expect(screen.getByTestId('room-timeline')).toHaveAttribute('aria-busy', 'false');
  });

  it('numbers every message in the room’s flow', () => {
    renderTimeline({ entries: THREE, members: ROSTER });
    const articles = screen.getAllByRole('article');

    expect(articles).toHaveLength(3);
    articles.forEach((article) => {
      // `-1` — the APG's "unknown". This is the trailing page of a room's
      // history, so "3 of 3" over a month-old room would tell a reader they
      // were at the end of a conversation that has barely started.
      expect(article).toHaveAttribute('aria-setsize', '-1');
      // And NO position. "Message 1 of unknown" over the 471st message in a
      // room states where the row sits in what happens to be loaded as though
      // it were where the message sits in the conversation.
      expect(article).not.toHaveAttribute('aria-posinset');
    });
  });

  it('gives every message row a DOM id, so a closing thread can find it again', () => {
    // The fallback the reply row cannot be: a thread opened from the capsule
    // has no replies, so no "↳ N replies" row exists to hand focus back to.
    renderTimeline({ entries: THREE, members: ROSTER });

    expect(screen.getAllByRole('article').map((row) => row.id)).toEqual([
      'room-entry-entry-1',
      'room-entry-entry-2',
      'room-entry-entry-3',
    ]);
  });

  it('names each message from the author line already on screen', () => {
    // The DOR-583 rule holds: the name is the visible one, pointed at, never a
    // second sentence invented for a screen reader.
    renderTimeline({ entries: THREE, members: ROSTER });

    expect(screen.getAllByRole('article')[1]).toHaveAccessibleName(/Bo/);
  });

  it('leaves the day and unread rules as separators between articles', () => {
    // They are real to a reader and there is nothing in them to stand on, so
    // they stay out of the set Page Down walks.
    renderTimeline({ entries: THREE, members: ROSTER, lastReadSeq: 1 });

    expect(screen.getByTestId('unread-divider')).toHaveAttribute('role', 'separator');
    expect(screen.getByTestId('unread-divider')).not.toHaveAttribute('aria-posinset');
  });

  it('counts a notice as an article, named by what it says', () => {
    // A fixed name like "Room notice" would be a live hazard rather than a tidy
    // default: `aria-label` REPLACES the element's own text for naming, so
    // landing on a one-line paragraph would announce three words that say
    // nothing in place of the line itself.
    renderTimeline({
      entries: [
        entry(1),
        entry(2, { kind: 'notice', body: { text: 'Ana stopped replying here' } }),
      ],
      members: ROSTER,
    });

    const notice = screen.getByTestId('room-notice');
    expect(notice).toHaveAttribute('role', 'article');
    // In the set, and — like every other row in this feed — without a claimed
    // position in it, because the room's own size is unknown. It is still an
    // article Page Down lands on, which is what this test is about.
    expect(notice).toHaveAttribute('aria-setsize', '-1');
    expect(notice).toHaveAccessibleName('Ana stopped replying here');
  });

  it('cuts a long notice’s name on a word, not mid-word', () => {
    const long = `Ana stopped replying here because ${'the queue backed up '.repeat(8)}badly`;
    renderTimeline({
      entries: [entry(1, { kind: 'notice', body: { text: long } })],
      members: ROSTER,
    });

    const name = screen.getByTestId('room-notice').getAttribute('aria-label')!;
    expect(name.length).toBeLessThanOrEqual(81);
    expect(name.endsWith('…')).toBe(true);
    // A prefix of the real line, ending on a word rather than through one.
    expect(long.startsWith(name.slice(0, -1))).toBe(true);
    expect(name).not.toMatch(/\s…$/);
    expect(long[name.length - 1]).toBe(' ');
  });

  it('moves message to message on Page Down and Page Up', () => {
    renderTimeline({ entries: THREE, members: ROSTER });
    const [first, second, third] = screen.getAllByRole('article');

    first!.focus();
    fireEvent.keyDown(first!, { key: 'PageDown' });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second!, { key: 'PageDown' });
    expect(third).toHaveFocus();

    fireEvent.keyDown(third!, { key: 'PageUp' });
    expect(second).toHaveFocus();
  });

  it('stops at the ends rather than wrapping round', () => {
    // A feed is a stretch of history. Jumping from its end back to its start
    // would tell a reader they had arrived somewhere they had not.
    renderTimeline({ entries: THREE, members: ROSTER });
    const articles = screen.getAllByRole('article');
    const last = articles[articles.length - 1]!;

    last.focus();
    fireEvent.keyDown(last, { key: 'PageDown' });
    expect(last).toHaveFocus();

    articles[0]!.focus();
    fireEvent.keyDown(articles[0]!, { key: 'PageUp' });
    expect(articles[0]).toHaveFocus();
  });

  it('moves on from wherever inside a message the focus happens to be', () => {
    // The composition the roving toolbar has to survive: Page Down pressed with
    // focus on one of a message's own buttons is still a feed command.
    renderTimeline({ entries: THREE, members: ROSTER });
    const [first, second] = screen.getAllByRole('article');

    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowRight' });
    const button = screen.getAllByRole('button', { name: 'React with thumbsup' })[0]!;
    expect(button).toHaveFocus();

    fireEvent.keyDown(button, { key: 'PageDown' });
    expect(second).toHaveFocus();
  });

  it('leaves the feed for the controls around it on Ctrl+Home and Ctrl+End', () => {
    render(
      <>
        <button type="button">above</button>
        <FeedHarness entries={THREE} members={ROSTER} />
        <button type="button">below</button>
      </>,
      { wrapper: Wrapper }
    );
    const articles = screen.getAllByRole('article');

    articles[1]!.focus();
    fireEvent.keyDown(articles[1]!, { key: 'End', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'below' })).toHaveFocus();

    articles[1]!.focus();
    fireEvent.keyDown(articles[1]!, { key: 'Home', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'above' })).toHaveFocus();
  });

  it('leaves the feed even from a message’s own toolbar', () => {
    // Ctrl+End has to work from wherever focus is, and inside a message that is
    // a button belonging to a roving group. (Whether the group also grabs the
    // press on the way past is invisible from here — the container's answer
    // lands second either way — so `RoomMessage` pins that half on a row
    // rendered without a feed around it.)
    render(
      <>
        <FeedHarness entries={THREE} members={ROSTER} />
        <button type="button">below</button>
      </>,
      { wrapper: Wrapper }
    );

    const first = screen.getAllByRole('article')[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const button = screen.getAllByRole('button', { name: 'React with thumbsup' })[0]!;

    fireEvent.keyDown(button, { key: 'End', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'below' })).toHaveFocus();
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

  it("passes through the roster's own emoji and color rather than guessing over them", () => {
    const authors = authorsById([
      member('ana', 'Ana', 'agent', { emoji: '🎨', color: 'hsl(210 70% 55%)' }),
    ]);
    const author = toMessageAuthor('ana', authors);
    expect(author.emoji).toBe('🎨');
    expect(author.color).toBe('hsl(210 70% 55%)');
  });

  it('falls back to the seeded color and no emoji when the roster stores neither', () => {
    // The path every agent created before faces were seeded still renders
    // through. Its colour is the one DorkOS would have seeded for that id
    // (DOR-949) — the same colour the roster and the sidebar give it — while the
    // EMOJI stays absent, because a letter is honest about a face nobody knows
    // and an invented emoji is not.
    const authors = authorsById([member('ana', 'Ana')]);
    const author = toMessageAuthor('ana', authors);
    expect(author.emoji).toBeUndefined();
    expect(author.color).toBe(seedAgentFace('ana').color);
  });

  it('marks a bridged member external, and a local one not', () => {
    const authors = authorsById([
      member('ana', 'Ana', 'agent'),
      member('bo', 'Bo', 'human', { origin: { platform: 'telegram' } }),
    ]);
    expect(toMessageAuthor('ana', authors).isExternal).toBe(false);
    expect(toMessageAuthor('bo', authors).isExternal).toBe(true);
  });

  it('treats a departed member as local rather than as an unknown platform', () => {
    expect(toMessageAuthor('gone', new Map()).isExternal).toBe(false);
  });

  it('wears the face the fleet resolved off the agent’s own manifest', () => {
    // The loudest surface in a room, and the last one that was still drawing an
    // agent as a letter while the sidebar drew its face. Nothing is cached on
    // this author row — the common case — so without the fleet's answer the
    // gutter has no emoji at all to draw.
    const authors = authorsById([member('ana', 'Ana', 'agent', { agentRef: 'ref-ana' })]);
    const faces = new Map([['ref-ana', { color: '#15803d', emoji: '🦊' }]]);

    const author = toMessageAuthor('ana', authors, faces);

    expect(author.emoji).toBe('🦊');
    expect(author.color).toBe('#15803d');
    // Dropping the map is what this asserts against: the same call without it
    // is the bare letter-and-hash the gutter used to be stuck with.
    expect(toMessageAuthor('ana', authors).emoji).toBeUndefined();
  });

  it('lets the fleet outrank a stale face cached on the author row', () => {
    // Precedence. The manifest is the fresher source, so an agent that changed
    // its icon must not keep drawing the old one here while the sidebar has
    // already moved on.
    const authors = authorsById([
      member('ana', 'Ana', 'agent', { agentRef: 'ref-ana', emoji: '🎨', color: '#7c3aed' }),
    ]);
    const faces = new Map([['ref-ana', { color: '#15803d', emoji: '🦊' }]]);

    expect(toMessageAuthor('ana', authors, faces)).toMatchObject({
      emoji: '🦊',
      color: '#15803d',
    });
  });

  it('joins on agentRef — a face filed under the author id reaches nobody', () => {
    // The two ids a room holds are different ULIDs, and the author one is the
    // wrong key. Seeding the map under it must change nothing, or an agent
    // would wear a face no other surface draws.
    const authors = authorsById([member('ana', 'Ana', 'agent', { agentRef: 'ref-ana' })]);
    const misfiled = new Map([['ana', { color: '#15803d', emoji: '🦊' }]]);

    expect(toMessageAuthor('ana', authors, misfiled).emoji).toBeUndefined();
  });

  it('leaves everyone else alone: a person, and an agent the fleet never named', () => {
    // A person has no `agentRef` to look up, and an agent the fleet could not
    // resolve is absent from the map. Both keep the honest letter — the ladder
    // never invents an emoji, whatever a caller passes.
    const authors = authorsById([
      member('dorian', 'Dorian', 'human'),
      member('bo', 'Bo', 'agent', { agentRef: 'ref-bo' }),
    ]);
    const faces = new Map([['ref-ana', { color: '#15803d', emoji: '🦊' }]]);

    expect(toMessageAuthor('dorian', authors, faces).emoji).toBeUndefined();
    expect(toMessageAuthor('bo', authors, faces).emoji).toBeUndefined();
    expect(toMessageAuthor('bo', authors, faces).color).toBe(seedAgentFace('bo').color);
    // A person keeps the hashed hue: the seeded palette is the agents' own
    // vocabulary, and DorkOS never picks a face for a human being.
    expect(toMessageAuthor('dorian', authors, faces).color).toBe(authorColor('dorian'));
  });
});
