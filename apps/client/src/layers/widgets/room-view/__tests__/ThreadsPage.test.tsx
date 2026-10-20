// @vitest-environment jsdom
/**
 * The Threads page: every thread you are in, newest reply first, each one
 * answerable where it stands and one press from its room.
 *
 * The room pieces are real — `RoomMessage`, `ChannelComposer`, the room's own
 * history query — over a mock transport, so what a card draws is what the room
 * would draw.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  RoomEntry,
  RoomRosterEntry,
  RoomWithRoster,
  ThreadSummary,
} from '@dorkos/shared/room-schemas';
import { useRoomOpenThreadStore } from '@/layers/entities/room';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));

// The entry rows read route state to decide where an author face leads, and
// this file mounts them with no router (see `RoomThreadPanel.test.tsx`).
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

import { ThreadsPage } from '../ui/threads/ThreadsPage';

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

beforeEach(() => {
  mockNavigate.mockReset();
  useRoomOpenThreadStore.setState({ open: {} });
});
afterEach(() => cleanup());

/** One member of the room, as its roster carries them. */
function member(id: string, displayName: string, kind: 'agent' | 'human'): RoomRosterEntry {
  return {
    roomId: 'room-design',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-30T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id, kind, displayName },
  } as RoomRosterEntry;
}

const ROOM = {
  id: 'room-design',
  kind: 'channel',
  slug: 'design',
  title: 'design',
  topic: null,
  archived: false,
  createdAt: '2026-07-30T09:00:00.000Z',
  viewerAuthorId: 'reader',
  reactionFrequents: ['👍'],
  members: [member('reader', 'You', 'human'), member('ana', 'Ana', 'agent')],
} as unknown as RoomWithRoster;

/** One entry in the room's log. */
function entry(seq: number, text: string, root?: number): RoomEntry {
  return {
    roomId: 'room-design',
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: root === undefined ? null : `entry-${root}`,
    threadRootEntryId: root === undefined ? null : `entry-${root}`,
    signature: null,
    createdAt: `2026-07-30T10:0${seq}:00.000Z`,
  };
}

/** The thread the list carries for `entry-1`. */
const THREAD: ThreadSummary = {
  roomId: 'room-design',
  roomKind: 'channel',
  roomSlug: 'design',
  roomTitle: 'design',
  rootEntryId: 'entry-1',
  rootAuthorId: 'ana',
  rootPreview: 'Which logo do we ship?',
  replyCount: 4,
  unreadCount: 1,
  lastActivityAt: '2026-07-30T10:05:00.000Z',
};

/** Mount the page over a transport answering with `threads` and the room's log. */
function renderPage(threads: ThreadSummary[] = [THREAD]) {
  const transport = createMockTransport({
    listThreads: vi.fn().mockResolvedValue(threads),
    getRoom: vi.fn().mockResolvedValue(ROOM),
    listRoomEntries: vi.fn().mockResolvedValue({
      entries: [
        entry(1, 'Which logo do we ship?'),
        entry(2, 'reply two', 1),
        entry(3, 'reply three', 1),
        entry(4, 'reply four', 1),
        entry(5, 'reply five', 1),
      ],
      threadRoots: [],
    }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <EventStreamProvider>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <ThreadsPage />
          </TooltipProvider>
        </TransportProvider>
      </EventStreamProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('ThreadsPage', () => {
  it('says so in plain words when you are in no thread', async () => {
    renderPage([]);
    expect(await screen.findByText('No threads yet')).toBeInTheDocument();
  });

  it('draws one card per thread, in the order the server gave them', async () => {
    renderPage([
      THREAD,
      { ...THREAD, rootEntryId: 'entry-9', roomSlug: 'ops', roomTitle: 'ops', roomId: 'room-ops' },
    ]);
    const cards = await screen.findAllByTestId('thread-card');
    expect(cards.map((card) => card.getAttribute('data-thread-root'))).toEqual([
      'entry-1',
      'entry-9',
    ]);
  });

  it('draws twelve cards at first, and twelve more for each "Show more"', async () => {
    // Every card reads its room and its history, so fifty at once is a hundred
    // requests on open.
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...THREAD,
      rootEntryId: `entry-${100 + index}`,
    }));
    const transport = renderPage(many);
    expect(await screen.findAllByTestId('thread-card')).toHaveLength(12);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('thread-card')).toHaveLength(24);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('thread-card')).toHaveLength(30);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(transport.listThreads).toHaveBeenCalledTimes(1);
  });

  it('offers no "Show more" when every thread fits', async () => {
    renderPage();
    await screen.findAllByTestId('thread-card');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the room, the root, how many more replies, and the two newest', async () => {
    renderPage();
    const card = await screen.findByTestId('thread-card');
    expect(within(card).getByRole('button', { name: '#design' })).toBeInTheDocument();
    await within(card).findByText('reply five');
    expect(within(card).getByText('Which logo do we ship?')).toBeInTheDocument();
    expect(within(card).getByText('reply four')).toBeInTheDocument();
    expect(within(card).queryByText('reply three')).not.toBeInTheDocument();
    // Four replies on the server, two drawn.
    expect(within(card).getByTestId('thread-card-more')).toHaveTextContent('2 more replies');
    // Unread, said in words beside the room's name.
    expect(within(card).getByText('1 new')).toBeInTheDocument();
  });

  it('opens the thread in its room when the room’s name is pressed', async () => {
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId('thread-card');
    await user.click(within(card).getByRole('button', { name: '#design' }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { id: 'room-design', thread: 'entry-1' },
    });
    expect(useRoomOpenThreadStore.getState().open['room-design']?.rootEntryId).toBe('entry-1');
  });

  it('opens the thread from the root and from "N more replies" too', async () => {
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId('thread-card');
    await within(card).findByText('reply five');

    await user.click(within(card).getByText('Which logo do we ship?'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    await user.click(within(card).getByTestId('thread-card-more'));
    expect(mockNavigate).toHaveBeenCalledTimes(2);
  });

  it('turns "Reply…" into the room’s own composer, aimed at this thread', async () => {
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId('thread-card');
    await waitFor(() => expect(within(card).getByTestId('thread-card-reply')).toBeInTheDocument());

    await user.click(within(card).getByTestId('thread-card-reply'));

    expect(within(card).queryByTestId('thread-card-reply')).not.toBeInTheDocument();
    const box = within(card).getByRole('combobox');
    await waitFor(() => expect(box).toHaveFocus());
  });
});
