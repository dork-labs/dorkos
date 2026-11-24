// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { AuthorOrigin, RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { RoomFlow } from '../ui/RoomFlow';
import { unreadPlacement } from '@/layers/shared/lib';
import {
  displayAuthorIdOf,
  toMessageAuthor,
  authorsById,
  groupByThread,
} from '../lib/room-timeline';

// Every row reads route state to decide where its author face leads (`useProfileDeepLink`), and
// this file mounts the timeline with no router.
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

describe('a line the room wrote about somebody', () => {
  it('draws that somebody’s name in the feed, not "Unknown"', () => {
    // The Discuss button turns a rare agent-written line into one everybody presses, so the row
    // has to be signed.
    renderTimeline({
      members: [member('kai', 'Kai', 'human')],
      entries: [
        entry(1, {
          authorId: 'system-author',
          body: { text: 'Kai started a discussion about The plan.', subjectAuthorId: 'kai' },
        }),
      ],
    });
    const row = screen.getByTestId('room-entry');
    expect(within(row).getByText('Kai')).toBeInTheDocument();
    expect(within(row).queryByText('Unknown')).not.toBeInTheDocument();
  });
});

describe('an agent that left the team (DOR-2095)', () => {
  const retiredAna = {
    author: {
      id: 'ana',
      kind: 'agent' as const,
      displayName: 'Ana',
      handle: null,
      retired: true,
    },
    origin: 'local' as const,
  };

  it('keeps its messages signed with its name, marked retired', () => {
    renderTimeline({
      members: [member('kai', 'Kai', 'human')],
      formerAuthors: [retiredAna],
      entries: [entry(1, { authorId: 'ana', body: { text: 'shipped it' } })],
    });
    const row = screen.getByTestId('room-entry');
    expect(within(row).getByText('Ana')).toBeInTheDocument();
    expect(within(row).queryByText('Unknown')).not.toBeInTheDocument();
    expect(within(row).getByTestId('retired-mark')).toHaveTextContent('Retired');
  });
});

describe('RoomFlow', () => {
  it('shows a loading state before any history arrives', () => {
    renderTimeline({ isLoading: true });
    expect(screen.getByTestId('room-timeline-loading')).toBeInTheDocument();
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

  it('renders a moment as its own line, and lets the next message start fresh', () => {
    // A moment draws its own band rather than the message grid, so it must not become the head of
    // an author group: the message under it would inherit the continuation layout and arrive with
    // no name and no avatar beneath a row that never showed either.
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
    const message = screen.getByTestId('room-entry');
    expect(within(message).getByText('Ana')).toBeInTheDocument();
  });

  it('marks where the reader left off, from the membership cursor', () => {
    renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: 1 });
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
  });
});

/**
 * A thread is a relation between entries in this room's log, not a room of its own (ADR
 * 260728-022013).
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

  it('opens the thread when the row is pressed', async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    renderTimeline({ entries: [entry(1), reply(2, 1)], onOpenThread });

    await user.click(screen.getByTestId('room-thread-replies'));

    // The ROOT's id — the panel is opened on the thread's head.
    expect(onOpenThread).toHaveBeenCalledWith('entry-1');
  });

  it('accents the row and counts what arrived since the reader last looked', () => {
    // Derived from the same cursor the unread rule is drawn from — no schema,
    // and nothing that can disagree with the line a few pixels above it.
    renderTimeline({ entries: [entry(1), reply(2, 1), reply(3, 1)], lastReadSeq: 2 });

    const row = screen.getByTestId('room-thread-replies');
    expect(row).toHaveAttribute('data-unread');
    expect(row).toHaveTextContent('1 new');
  });
});

describe('groupByThread', () => {
  function reply(seq: number, rootId: string | null): RoomEntry {
    return entry(seq, { parentEntryId: rootId, threadRootEntryId: rootId });
  }

  /**
   * Every entry handed in comes back out somewhere — in the flow, or under an id that IS in the
   * flow.
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
    // The server refuses depth two today, but `threadPointers` says opening it is one `if` and
    // that "nothing else in the schema has an opinion".
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

  it('never loses a line: an orphaned reply joins the flow rather than vanishing', () => {
    // History paged past the thread's head, so this page cannot hang the reply anywhere.
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
});

describe('unreadPlacement', () => {
  it('puts the rule above everything for a member who has read nothing', () => {
    // The sidebar badges this room, so a room with no line would contradict it.
    expect(unreadPlacement([entry(1), entry(2)], 0)).toEqual({
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

  it('signs a line the room wrote about somebody WITH that somebody', () => {
    // The room's own voice is on no roster, so the row used to read "Unknown" under a sentence
    // that names a person — "You started a discussion about The plan".
    const authors = authorsById([member('kai', 'Kai', 'human')]);
    const line = entry(1, {
      authorId: 'system-author',
      body: { text: 'Kai started a discussion about The plan.', subjectAuthorId: 'kai' },
    });
    expect(displayAuthorIdOf(line, authors)).toBe('kai');
    expect(toMessageAuthor(displayAuthorIdOf(line, authors), authors)).toMatchObject({
      displayName: 'Kai',
    });
  });

  it('wears the face the fleet resolved off the agent’s own manifest', () => {
    // The loudest surface in a room, and the last one that was still drawing an agent as a letter
    // while the sidebar drew its face.
    const authors = authorsById([member('ana', 'Ana', 'agent', { agentRef: 'ref-ana' })]);
    const faces = new Map([['ref-ana', { color: '#15803d', emoji: '🦊' }]]);

    const author = toMessageAuthor('ana', authors, faces);

    expect(author.emoji).toBe('🦊');
    expect(author.color).toBe('#15803d');
    // Dropping the map is what this asserts against: the same call without it
    // is the bare letter-and-hash the gutter used to be stuck with.
    expect(toMessageAuthor('ana', authors).emoji).toBeUndefined();
  });
});

describe('RoomFlow — reading past the page the room opened on (DOR-1734)', () => {
  it('asks for the older page when pressed', async () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ entries: [entry(1)], canLoadOlder: true, onLoadOlder });

    await userEvent.click(screen.getByTestId('room-load-older'));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe('RoomFlow — the rows a room draws (Phase 4 rooms A)', () => {
  function notice(seq: number, code?: RoomEntry['body']['notice']): RoomEntry {
    return entry(seq, {
      kind: 'notice',
      authorId: 'system-author',
      body: { text: `notice ${seq}`, ...(code && { notice: code }) },
    });
  }

  it('folds three notices in a row to the latest, and opens them in place (P4)', async () => {
    const user = userEvent.setup();
    renderTimeline({ entries: [entry(1), notice(2), notice(3), notice(4), entry(5)] });

    // Only the latest notice is in the feed while folded, so Page Down can
    // never land on a line nobody can see.
    expect(screen.getAllByTestId('room-notice')).toHaveLength(1);
    expect(screen.getByText('notice 4')).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: 'Show 2 earlier notices' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    // A control, not a line of text: it carries the disclosure chevron.
    expect(fold.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expect(fold).toHaveTextContent('2 earlier');

    await user.click(fold);
    expect(screen.getAllByTestId('room-notice')).toHaveLength(3);
    const open = screen.getByRole('button', { name: 'Hide 2 earlier notices' });
    expect(open).toHaveAttribute('aria-expanded', 'true');

    await user.click(open);
    expect(screen.getAllByTestId('room-notice')).toHaveLength(1);
  });
});
