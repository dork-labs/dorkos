// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockRoomEntryPage } from '@dorkos/test-utils/mock-factories';
import { type RoomEntry, type RoomWithRoster } from '@dorkos/shared/room-schemas';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChannelsPage } from '../../ui/ChannelsPage';
import { route } from './channels-page.route';
import { installChannelsPageHarness, roomWith, staysOpen } from './channels-page.fixtures';

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, info: toastInfo } }));

// Plain boxes: jsdom lays nothing out, so the real resize handle swallows every
// click. The split has its own file (`RoomThreadSplit.test.tsx`).
vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div role="separator" />,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { route } = await import('./channels-page.route');
  return {
    ...(await importOriginal<typeof import('@tanstack/react-router')>()),
    useSearch: () => ({
      id: route.roomId,
      ...(route.entrySeq === undefined ? {} : { entry: route.entrySeq }),
    }),
    useNavigate: () => () => {},
    useRouter: () => ({
      state: { location: { pathname: '/channels', search: { id: route.roomId } } },
    }),
  };
});

installChannelsPageHarness();
afterEach(() => {
  toastError.mockClear();
  toastInfo.mockClear();
});

/**
 * The one rule the thread change had to not break (ADR 260728-022013).
 *
 * The timeline leaves a reply out of the room's flow and draws it under the
 * message it answers. The read cursor must still reach the room's true newest
 * `seq` — so the array handed to `useMarkRoomRead` has to arrive whole. Move
 * that filter one step earlier (into `listEntries`, or onto `entriesQuery.data`
 * before this page passes it on) and the badge on the open room freezes below
 * the reply with nothing in the product able to move it.
 */
describe('ChannelsPage — a thread reply still clears the badge', () => {
  /** A reply to `entry-1`, and the newest thing in the room. */
  const reply: RoomEntry = {
    roomId: 'room-1',
    seq: 2,
    id: 'entry-2',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'answering in a thread' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 1,
    parentEntryId: 'entry-1',
    threadRootEntryId: 'entry-1',
    signature: null,
    createdAt: '2026-07-26T10:01:00.000Z',
  };

  /** The entry it answers, at the room's top level. */
  const root: RoomEntry = {
    ...reply,
    seq: 1,
    id: 'entry-1',
    authorId: 'dorian',
    body: { text: 'the message it hangs off' },
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };

  /** The viewer, a member who has read nothing. */
  function readNothing(): RoomWithRoster {
    return {
      ...roomWith('room-1', 'backend'),
      members: [
        {
          roomId: 'room-1',
          authorId: 'you',
          responseMode: 'always',
          joinedAt: '2026-07-26T09:00:00.000Z',
          joinedSeq: 0,
          lastReadSeq: 0,
          author: { id: 'you', kind: 'human', displayName: 'You', handle: null },
          origin: 'local',
        },
      ],
      viewerAuthorId: 'you',
    };
  }

  function renderRoom() {
    const transport = createMockTransport({
      getRoom: vi.fn(() => Promise.resolve(readNothing())),
      listRoomEntries: vi.fn(() => Promise.resolve(mockRoomEntryPage([root, reply]))),
      subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      ),
    });
    render(
      <QueryClientProvider client={new QueryClient(createQueryClientConfig())}>
        <EventStreamProvider>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ChannelsPage />
            </TooltipProvider>
          </TransportProvider>
        </EventStreamProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('moves the cursor to the reply’s seq, not to the newest entry on screen', async () => {
    const transport = renderRoom();

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 2));
  });

  it('opens the thread beside the room when the row is pressed', async () => {
    const user = userEvent.setup();
    renderRoom();

    await user.click(await screen.findByTestId('room-thread-replies'));

    const panel = screen.getByTestId('room-thread-panel');
    // Root at the top, reply beneath it — and a composer that writes into it.
    expect(within(panel).getByText('the message it hangs off')).toBeInTheDocument();
    expect(within(panel).getByText('answering in a thread')).toBeInTheDocument();
    expect(
      within(panel).getByRole('combobox', { name: 'Reply in this thread…' })
    ).toBeInTheDocument();
  });

  it('closes the panel on Escape, and on its close button', async () => {
    const user = userEvent.setup();
    renderRoom();

    await user.click(await screen.findByTestId('room-thread-replies'));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('room-thread-replies'));
    await user.click(screen.getByRole('button', { name: 'Close thread' }));
    expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument();
  });
});

/**
 * Two threads in one room — the switching case, and the one the panel's own
 * unit tests cannot reach because the reuse happens a layer up.
 */
describe('ChannelsPage — switching between threads', () => {
  /** `entry-<seq>`, a reply when `rootId` is given. */
  function make(seq: number, rootId: string | null, text: string): RoomEntry {
    return {
      roomId: 'room-1',
      seq,
      id: `entry-${seq}`,
      authorId: 'ana',
      kind: 'post',
      body: { text },
      mentions: [],
      sessionId: null,
      cascadeRoot: rootId ?? `entry-${seq}`,
      cascadeDepth: rootId === null ? 0 : 1,
      parentEntryId: rootId,
      threadRootEntryId: rootId,
      signature: null,
      createdAt: '2026-07-26T10:00:00.000Z',
    };
  }

  // Two roots, one reply each — deliberately the SAME reply count, because a
  // panel reused across a switch also keys its scroll effect on that number.
  const history = [
    make(1, null, 'first question'),
    make(2, 'entry-1', 'answering the first'),
    make(3, null, 'second question'),
    make(4, 'entry-3', 'answering the second'),
    // A message nobody has answered, so it draws NO reply row — the one shape
    // the focus restore used to have nothing to aim at.
    make(5, null, 'nobody answered this'),
  ];

  function renderRoom() {
    const transport = createMockTransport({
      getRoom: vi.fn(() => Promise.resolve(roomWith('room-1', 'backend'))),
      listRoomEntries: vi.fn(() => Promise.resolve(mockRoomEntryPage(history))),
      subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      ),
    });
    render(
      <QueryClientProvider client={new QueryClient(createQueryClientConfig())}>
        <EventStreamProvider>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ChannelsPage />
            </TooltipProvider>
          </TransportProvider>
        </EventStreamProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('does not replay the second thread as though it had just arrived', async () => {
    const user = userEvent.setup();
    renderRoom();

    const rows = await screen.findAllByTestId('room-thread-replies');
    await user.click(rows[0]!);
    expect(await screen.findByTestId('room-thread-panel')).toBeInTheDocument();

    // Switch. A reused panel keeps `useThreadArrivals`'s memory of the FIRST
    // thread, so every reply of the second is classified as a fresh arrival and
    // the whole thread bounces in at once — motion that lies about what just
    // happened.
    await user.click(screen.getAllByTestId('room-thread-replies')[1]!);

    const panel = screen.getByTestId('room-thread-panel');
    expect(within(panel).getByText('answering the second')).toBeInTheDocument();
    const animated = panel.querySelectorAll(
      '[class*="animate-thread-reply-in"], [class*="animate-reply-settle"]'
    );
    expect(animated).toHaveLength(0);
  });

  it('puts the caret back on the row that opened the thread', async () => {
    // Closing used to drop focus on `document.body`, which for a keyboard
    // reader loses their place in the room entirely.
    const user = userEvent.setup();
    renderRoom();

    const row = (await screen.findAllByTestId('room-thread-replies'))[0]!;
    await user.click(row);
    expect(await screen.findByTestId('room-thread-panel')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close thread' }));

    await waitFor(() => expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument());
    // Awaited, because the restore looks for its row on an animation frame
    // rather than in the commit that removed the panel — the room is not
    // necessarily back by then. See `useRestoreThreadFocus`.
    await waitFor(() => expect(screen.getAllByTestId('room-thread-replies')[0]!).toHaveFocus());
  });

  it('leaves an Escape the mention palette answered to the palette', async () => {
    // The composer's Escape ladder dismisses the palette and the key keeps
    // bubbling. Without the panel honouring `defaultPrevented` — and without the
    // ladder setting it — one Escape aimed at an autocomplete shut the whole
    // thread and lost the reader's place.
    const user = userEvent.setup();
    renderRoom();

    await user.click((await screen.findAllByTestId('room-thread-replies'))[0]!);
    const composer = await screen.findByRole('combobox', { name: 'Reply in this thread…' });

    await user.click(composer);
    await user.keyboard('@');
    // The palette is open over the room's roster.
    await waitFor(() => expect(composer).toHaveAttribute('aria-expanded', 'true'));

    await user.keyboard('{Escape}');

    await waitFor(() => expect(composer).toHaveAttribute('aria-expanded', 'false'));
    // The thread is still open. That is the whole finding.
    expect(screen.getByTestId('room-thread-panel')).toBeInTheDocument();
  });
});

describe('ChannelsPage — landing on the message a search hit named (DOR-687)', () => {
  /** One committed post, numbered the way a room numbers its own log. */
  function post(seq: number, text: string): RoomEntry {
    return {
      seq,
      id: `entry-${seq}`,
      authorId: 'author-you',
      kind: 'post',
      body: { text },
      mentions: [],
      sessionId: null,
      cascadeRoot: `entry-${seq}`,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      signature: null,
      createdAt: '2026-07-26T10:00:00.000Z',
    } as unknown as RoomEntry;
  }

  const history = [post(1, 'first'), post(2, 'the port question'), post(3, 'last')];
  /** The tree the page renders in, kept so a test can re-render it in place. */
  function pageTree(entries: RoomEntry[] = history) {
    return (
      <QueryClientProvider client={new QueryClient(createQueryClientConfig())}>
        <EventStreamProvider>
          <TransportProvider
            transport={createMockTransport({
              getRoom: vi.fn(() => Promise.resolve(roomWith('room-1', 'backend'))),
              listRoomEntries: vi.fn(() => Promise.resolve(mockRoomEntryPage(entries))),
              subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) =>
                staysOpen(signal)
              ),
            })}
          >
            <TooltipProvider>
              <ChannelsPage />
            </TooltipProvider>
          </TransportProvider>
        </EventStreamProvider>
      </QueryClientProvider>
    );
  }

  function openRoomWithHistory(entries: RoomEntry[] = history) {
    render(pageTree(entries));
  }

  /** What the timeline decided, which only its own wrapper publishes. */
  async function landedOn(): Promise<string | null> {
    openRoomWithHistory();
    await screen.findByText('the port question');
    return (
      document
        .querySelector('[data-slot="conversation-timeline"]')
        ?.getAttribute('data-landed-on') ?? null
    );
  }

  it('opens on the message rather than at the newest one', async () => {
    // The whole client half, end to end at the level that can see it: the
    // address reaches the page, the page reaches the room, the room resolves a
    // `seq` to a row, and the timeline lands on it instead of the bottom.
    // Every unit below this passes with any one of those four links cut.
    route.entrySeq = 2;

    expect(await landedOn()).toBe('requested');
  });
});
