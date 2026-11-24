// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { RoomEntry, RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomThreadPanel } from '../ui/RoomThreadPanel';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// The entry rows inside the panel read route state to decide where an author face leads
// (`useProfileDeepLink`), and this file mounts them with no router.
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
  useRoomPresenceStore.getState().reset();
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
  // The reader themselves, on the roster — `ChannelComposer` now reads membership before offering
  // a live composer at all (DOR-1233), and this panel's thread composer is the same component.
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

describe('a discussion the room opened about a document', () => {
  it('heads the panel with the person who started it, not "Unknown"', () => {
    // This is the heading of the panel the Discuss button opens, so it is the most-read instance
    // of a room-voiced post.
    renderPanel({
      entries: [
        entry(1, {
          authorId: 'system-author',
          body: { text: 'Ana started a discussion about The plan.', subjectAuthorId: 'ana' },
        }),
      ],
    });

    const panel = screen.getByTestId('room-thread-panel');
    const root = within(panel).getAllByTestId('room-entry')[0]!;
    expect(within(root).getByText('Ana')).toBeInTheDocument();
    expect(within(root).queryByText('Unknown')).not.toBeInTheDocument();
  });
});

describe('RoomThreadPanel', () => {
  it('shows the root at the top and its replies beneath it', () => {
    renderPanel();

    const panel = screen.getByTestId('room-thread-panel');
    const rows = within(panel).getAllByTestId('room-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('line 1');
    expect(rows[1]).toHaveTextContent('line 2');
  });

  it('draws replies flush with the root, with nothing beside them', () => {
    // DOR-2110: the panel IS the thread, so a reply is not indented under a
    // connector rule. jsdom lays nothing out, so this reads what would: every
    // box between the feed and the reply, none of which may hold a sibling
    // beside the reply or push it in from the left.
    renderPanel({ entries: [entry(1), reply(2, 1)] });

    const feed = screen.getByTestId('room-thread-feed');
    const firstReply = within(feed).getAllByTestId('room-entry')[1]!;
    const indentOf = (box: Element) => {
      const style = getComputedStyle(box);
      return [
        style.marginLeft,
        style.paddingLeft,
        style.marginInlineStart,
        style.paddingInlineStart,
      ]
        .filter((value) => value !== '' && value !== '0px' && value !== '0')
        .join(' ');
    };
    for (let box = firstReply.parentElement; box && box !== feed; box = box.parentElement) {
      // A utility class that indents, an inline style that indents, or a
      // sibling drawn beside the reply (the old connector) — any one fails.
      expect(box.className).not.toMatch(/(^|\s)-?(ml|pl|ms|ps|mx|px|m|p)-/);
      expect(indentOf(box)).toBe('');
      expect(box.querySelectorAll(':scope > [aria-hidden]')).toHaveLength(0);
    }
    // And the reply's own box starts where the root's does.
    const root = within(feed).getAllByTestId('room-entry')[0]!;
    expect(firstReply.className).toBe(root.className);
    expect(indentOf(firstReply)).toBe(indentOf(root));
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
      'This thread’s first message is gone'
    );
    expect(screen.getAllByTestId('room-entry')).toHaveLength(2);
  });

  it('closes on Escape, because it takes focus when it opens', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });

    // Not clicked into first: a panel opened from a reply row leaves focus up in the timeline, so
    // it has to take focus itself or Escape never reaches it.
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('offers Back instead of Close on a phone, naming the room it returns to', () => {
    renderPanel({ pushed: true });

    expect(screen.getByRole('button', { name: 'Back to #build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close thread' })).not.toBeInTheDocument();
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

  it('numbers the root and its replies as one set', () => {
    renderPanel({ entries: [entry(1), reply(2, 1), reply(3, 1)] });
    const articles = screen.getAllByRole('article');

    expect(articles).toHaveLength(3);
    articles.forEach((article, index) => {
      expect(article).toHaveAttribute('aria-posinset', String(index + 1));
      expect(article).toHaveAttribute('aria-setsize', '3');
    });
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
});
