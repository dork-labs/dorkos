// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomEntry, RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomThreadPanel } from '../ui/RoomThreadPanel';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// The entry rows inside the panel read route state to decide where an author
// face leads (`useProfileDeepLink`), and this file mounts them with no router.
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

afterEach(() => {
  cleanup();
  useRoomPresenceStore.setState({ rooms: {} });
});

function member(id: string, displayName: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-30T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id, kind: 'agent', displayName },
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
    createdAt: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

/** A reply to `entry-<parentSeq>`, at depth one. */
function reply(seq: number, parentSeq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return entry(seq, {
    parentEntryId: `entry-${parentSeq}`,
    threadRootEntryId: `entry-${parentSeq}`,
    ...overrides,
  });
}

const room: RoomWithRoster = {
  id: 'room-1',
  kind: 'channel',
  slug: 'build',
  title: 'build',
  topic: null,
  archived: false,
  createdAt: '2026-07-30T09:00:00.000Z',
  viewerAuthorId: 'reader',
  reactionFrequents: ['👍', '❤️', '🎉'],
  // The reader themselves, on the roster — `RoomComposer` now reads
  // membership before offering a live composer at all (DOR-1233), and this
  // panel's thread composer is the same component.
  members: [
    { ...member('reader', 'You'), author: { id: 'reader', kind: 'human', displayName: 'You' } },
    member('ana', 'Ana'),
    member('bo', 'Bo'),
  ],
} as unknown as RoomWithRoster;

function renderPanel(overrides: Partial<Parameters<typeof RoomThreadPanel>[0]> = {}) {
  return render(
    <RoomThreadPanel
      room={room}
      rootEntryId="entry-1"
      focusComposer={false}
      entries={[entry(1), reply(2, 1)]}
      reactionFrequents={['👍', '❤️', '🎉']}
      pushed={false}
      historyLoaded
      onClose={vi.fn()}
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
          <EventStreamProvider>
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
          </EventStreamProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('RoomThreadPanel', () => {
  it('shows the root at the top and its replies beneath it', () => {
    renderPanel();

    const panel = screen.getByTestId('room-thread-panel');
    const rows = within(panel).getAllByTestId('room-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('line 1');
    expect(rows[1]).toHaveTextContent('line 2');
  });

  it('gathers only ITS thread, not every reply in the room', () => {
    renderPanel({
      entries: [entry(1), reply(2, 1), entry(3), reply(4, 3)],
    });

    const panel = screen.getByTestId('room-thread-panel');
    expect(within(panel).getAllByTestId('room-entry')).toHaveLength(2);
    expect(within(panel).queryByText('line 4')).not.toBeInTheDocument();
  });

  it('gives the thread a composer that writes into it', () => {
    renderPanel();

    // The placeholder IS the accessible name, so "which conversation does this
    // box post to" is a question the accessibility tree answers.
    expect(screen.getByRole('combobox', { name: 'Reply in this thread…' })).toBeInTheDocument();
  });

  it('says the start is gone rather than dropping an orphaned thread', () => {
    // The root is older than the loaded history. Its replies are real and stay.
    renderPanel({ entries: [reply(2, 1), reply(3, 1)] });

    expect(screen.getByTestId('room-thread-orphan')).toHaveTextContent(
      'The start of this thread is gone'
    );
    expect(screen.getAllByTestId('room-entry')).toHaveLength(2);
  });

  it('does not call a thread orphaned while its history is still loading', () => {
    // A deep link mounts this panel before the room's entries arrive, so the
    // root is missing for a moment. Saying "the start of this thread is gone"
    // in that moment is a small lie that flashes on every shared link.
    renderPanel({ entries: [], historyLoaded: false });

    expect(screen.queryByTestId('room-thread-orphan')).not.toBeInTheDocument();
  });

  it('is a root and a composer when nothing has been said back', () => {
    // No invented empty state (design record §4): a thread with no replies yet
    // IS a root and a box, and a drawing saying so would be furniture.
    renderPanel({ entries: [entry(1)] });

    expect(screen.getAllByTestId('room-entry')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Reply in this thread…' })).toBeInTheDocument();
    expect(screen.queryByTestId('room-thread-orphan')).not.toBeInTheDocument();
  });

  it('closes on its close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });

    await user.click(screen.getByRole('button', { name: 'Close thread' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape, because it takes focus when it opens', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });

    // Not clicked into first: a panel opened from a reply row leaves focus up
    // in the timeline, so it has to take focus itself or Escape never reaches
    // it.
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('offers Back instead of Close on a phone, naming the room it returns to', () => {
    renderPanel({ pushed: true });

    expect(screen.getByRole('button', { name: 'Back to #build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close thread' })).not.toBeInTheDocument();
  });

  it('gives Back a target a finger can hit, without growing the header', () => {
    // 24px of button, and on a phone this is the control a reader reaches for
    // most. The glyph stays 16px so the header keeps its height; the reach
    // grows to 44px, and only below the breakpoint.
    renderPanel({ pushed: true });

    const back = screen.getByRole('button', { name: 'Back to #build' });
    expect(back.className).toContain('after:-inset-2.5');
    expect(back.className).toContain('md:after:hidden');
  });

  it('draws the working line for an agent answering inside this thread', () => {
    // Presence follows you in (design record §3.2). The claim's trigger is a
    // REPLY in this thread, so this is where it belongs.
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'bo',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-2',
      since: new Date().toISOString(),
    });

    renderPanel();

    expect(screen.getByTestId('thread-presence')).toHaveTextContent('Bo is working on it');
  });

  it('is a feed, named for the thread rather than the room', () => {
    // Both histories are on screen at once on a desktop, so two feeds called
    // the same thing would leave a reader unable to say which they landed in.
    renderPanel();

    expect(screen.getByRole('feed', { name: 'Thread in #build' })).toBeInTheDocument();
  });

  it('says it is busy while the thread’s history is still resolving', () => {
    // The deep-link case: `?thread=` mounts the panel before the room's
    // entries land.
    renderPanel({ entries: [], historyLoaded: false });
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'true');

    cleanup();
    renderPanel();
    // Written as false rather than left off, so the wait is announced as over.
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'false');
  });

  it('stops saying it is busy when the history fails to load', () => {
    // The failure this catches: "loading" was the absence of success, so a
    // fetch that ERRORED left the panel drawing a skeleton and promising a
    // wait that was never going to end.
    renderPanel({ entries: [], historyLoaded: false, historyFailed: true });

    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByText('Couldn’t load this thread')).toBeInTheDocument();
    expect(screen.queryByTestId('room-thread-orphan')).not.toBeInTheDocument();
  });

  it('numbers the root and its replies as one set', () => {
    renderPanel({ entries: [entry(1), reply(2, 1), reply(3, 1)] });
    const articles = screen.getAllByRole('article');

    expect(articles).toHaveLength(3);
    articles.forEach((article, index) => {
      expect(article).toHaveAttribute('aria-posinset', String(index + 1));
      expect(article).toHaveAttribute('aria-setsize', '3');
    });
  });

  it('numbers an orphaned thread over the replies it actually has', () => {
    // The missing root is not a phantom first article: promising three when
    // Page Down can only reach two is worse than saying two.
    renderPanel({ entries: [reply(2, 1), reply(3, 1)] });
    const articles = screen.getAllByRole('article');

    expect(articles).toHaveLength(2);
    // `-1`, not `2`: the panel reads this thread out of the room's loaded page,
    // and a root that is not in that page means the page begins somewhere
    // inside the thread. What is on screen is not what there is.
    expect(articles[0]).toHaveAttribute('aria-setsize', '-1');
    // And no position either — the two travel together. "1 of unknown" states a
    // position in the loaded page as though it were a position in the thread.
    expect(articles[0]).not.toHaveAttribute('aria-posinset');
  });

  it('numbers a thread exactly when its root is on the page', () => {
    // The complement, and why the rule above is about knowledge rather than
    // about threads: with the root loaded, every reply after it is loaded too,
    // so the set really is complete and Page Down can promise a total.
    renderPanel({ entries: [entry(1), reply(2, 1), reply(3, 1)] });
    const articles = screen.getAllByRole('article');

    expect(articles.map((a) => a.getAttribute('aria-posinset'))).toEqual(['1', '2', '3']);
    expect(articles.map((a) => a.getAttribute('aria-setsize'))).toEqual(['3', '3', '3']);
  });

  it('moves root to reply on Page Down and back on Page Up', () => {
    renderPanel({ entries: [entry(1), reply(2, 1), reply(3, 1)] });
    const [root, first, second] = screen.getAllByRole('article');

    root!.focus();
    fireEvent.keyDown(root!, { key: 'PageDown' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first!, { key: 'PageDown' });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second!, { key: 'PageUp' });
    expect(first).toHaveFocus();
  });

  it('lands on the panel’s own close button and composer on Ctrl+Home and Ctrl+End', () => {
    // WITHIN the panel: the room behind it is full of tab stops, and leaving
    // the thread for one of them is not what leaving a feed means here.
    renderPanel();
    const root = screen.getAllByRole('article')[0]!;

    root.focus();
    fireEvent.keyDown(root, { key: 'End', ctrlKey: true });
    expect(screen.getByRole('combobox', { name: 'Reply in this thread…' })).toHaveFocus();

    root.focus();
    fireEvent.keyDown(root, { key: 'Home', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Close thread' })).toHaveFocus();
  });

  it('still closes on Escape from an article the feed put focus on', () => {
    // The feed moves focus; Escape is one of the panel's three ways out and
    // has to survive being pressed wherever the feed left the reader.
    const onClose = vi.fn();
    renderPanel({ onClose });
    const root = screen.getAllByRole('article')[0]!;
    root.focus();

    fireEvent.keyDown(root, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('leaves work triggered by a ROOM message to the room’s own line', () => {
    // `entry-9` is not a reply in this thread, so the panel says nothing —
    // otherwise one claim would be announced in two places at once.
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'bo',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-9',
      since: new Date().toISOString(),
    });

    renderPanel();

    expect(screen.queryByTestId('thread-presence')).not.toBeInTheDocument();
  });
});
