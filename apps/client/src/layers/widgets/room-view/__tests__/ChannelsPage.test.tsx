// @vitest-environment jsdom
/**
 * Room switching, asserted at the page — the only level that can see it.
 *
 * `ChannelComposer` in isolation always looks correct: it is mounted once per
 * test, with one room. The bug these cover is that the PAGE re-renders the same
 * composer instance for a different room, so a draft (and an in-flight latch)
 * outlive the conversation they belong to. Nothing inside the component can
 * observe that; only mounting the page and changing its search param can.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  agentAuthorRef,
  REACTION_FREQUENTS_DEFAULT,
  type PostToRoomResponse,
  type RoomEntry,
  type RoomEvent,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import {
  usePendingPostStore,
  useRoomDraftStore,
  useRoomOpenThreadStore,
} from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { EventStreamProvider, TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ROOM_PANEL_ID, useRoomPanelFocusStore } from '@/layers/features/room-management';
import { ChannelsPage } from '../ui/ChannelsPage';

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, info: toastInfo } }));

/** The `?id=` the page reads, swapped between renders to change rooms. */
let openRoomId = 'room-1';
/** The `?entry=` the page reads — a search hit's seq, or nothing. */
let openEntrySeq: number | undefined;
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({
    id: openRoomId,
    ...(openEntrySeq === undefined ? {} : { entry: openEntrySeq }),
  }),
  useNavigate: () => () => {},
  // `useInPlaceNavigate` (the thread-URL sync) reads the current location.
  useRouter: () => ({ state: { location: { pathname: '/channels', search: { id: openRoomId } } } }),
}));

/**
 * Whether this test is running on a phone-sized viewport.
 *
 * The page branches on it — on a phone the thread panel REPLACES the room
 * rather than sitting beside it — so it is a per-test choice, not a fixture.
 * Reset to the desktop in `afterEach`.
 */
let phoneViewport = false;

/** Run the rest of this test below the 768px breakpoint. */
function onPhone() {
  phoneViewport = true;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // A phone is a viewport AND a pointer, and both halves matter here: the
      // composer's autofocus-on-mount is gated on `useIsTouchOnly`, so a
      // fixture that reported a phone-sized window with a mouse attached would
      // have the room's composer grab the caret the moment the room came back
      // — which is not what a phone does. `(pointer: coarse)` matches and
      // `(any-pointer: fine)` does not, which is exactly a phone.
      matches:
        phoneViewport && (query.includes('max-width') || query.includes('(pointer: coarse)')),
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
  toastError.mockClear();
  toastInfo.mockClear();
  // Module state shared by the whole graph: an unanswered request left here
  // would be read by whatever mounts a room panel next.
  useRoomPanelFocusStore.setState({ request: null });
  useAppStore.setState({ rightPanelOpen: false, activeRightPanelTab: null });
  openRoomId = 'room-1';
  openEntrySeq = undefined;
  phoneViewport = false;
  // The open thread outlives an unmounted page on purpose — it is per-room
  // state, not per-render — so a test that opened one has to put it back, or
  // the next test starts with a panel already beside its room.
  useRoomOpenThreadStore.setState({ open: {} });
  // Drafts outlive an unmounted composer by design — that is what lets a
  // refused message find its way back. So a test that typed into one has to put
  // it back, or the next test starts with words in a box it believes is empty.
  useRoomDraftStore.setState({ drafts: {} });
  // Pending rows outlive their composer for the same reason drafts do — a
  // refusal has to find something still standing — so they outlive tests too.
  usePendingPostStore.setState({ posts: [] });
});

function roomWith(id: string, slug: string): RoomWithRoster {
  return {
    id,
    kind: 'channel',
    slug,
    title: `#${slug}`,
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    // The viewer themselves, on the roster — `ChannelComposer` now reads
    // membership to decide whether to offer a live composer at all
    // (DOR-1233), and every test below assumes one.
    members: [
      {
        roomId: id,
        authorId: 'author-you',
        responseMode: 'always',
        joinedAt: '2026-07-26T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
        origin: 'local',
      },
    ],
    viewerAuthorId: 'author-you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

/** A live but silent room stream, so the page is not busy reconnecting. */
function staysOpen(signal: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

function renderPage(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getRoom: vi.fn((id: string) =>
      Promise.resolve(roomWith(id, id === 'room-1' ? 'dm' : 'random'))
    ),
    subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal)),
    ...overrides,
  });
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false },
      mutations: { retry: false },
    },
  });
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <EventStreamProvider>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <ChannelsPage />
          </TooltipProvider>
        </TransportProvider>
      </EventStreamProvider>
    </QueryClientProvider>
  );

  /** Point the page at another room and wait for its composer. */
  const openRoom = async (id: string) => {
    openRoomId = id;
    rerender(
      <QueryClientProvider client={queryClient}>
        <EventStreamProvider>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ChannelsPage />
            </TooltipProvider>
          </TransportProvider>
        </EventStreamProvider>
      </QueryClientProvider>
    );
    await screen.findByRole('combobox');
    return screen.getByRole('combobox') as HTMLTextAreaElement;
  };

  return { transport, openRoom };
}

/**
 * The two entry points spec §14.3 puts inside the room itself (DOR-600).
 *
 * Both must land on the SAME panel the sidebar row's menu opens. A second
 * surface that happened to look similar is the failure this covers: one place
 * to learn, one place a change lands.
 */
describe('ChannelsPage — saying the room has stopped hearing', () => {
  it('has the announcer up and empty BEFORE anything goes wrong', async () => {
    // The whole of the fix. The stall line used to be `role="status"` mounted at
    // the moment it had something to say, and a live region that ARRIVES with
    // its text in it is the classic case assistive technology never announces.
    // So the announcer is here from the start, empty, watching.
    //
    // It is the LANE's announcer now, not a second one of the stall's own: the
    // live lane says one thing at a time and carries one live region, so a
    // stalled room and a working agent cannot both be read out at once
    // (`design-system.md` §Zones, "One live region"). The guarantee this test
    // was written for is unchanged — mounted first, empty, watching.
    renderPage();
    await screen.findByRole('combobox', { name: /Message/ });

    const announcer = screen.getByTestId('room-presence-announcer');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toBeEmptyDOMElement();
    // And nothing is drawn, because nothing is wrong.
    expect(screen.queryByTestId('room-stalled')).not.toBeInTheDocument();
  });
});

describe('ChannelsPage members-panel entry points', () => {
  /**
   * A fleet the page can offer, read through the same two transport calls the
   * sidebar reads — so this also proves the open room builds its own candidate
   * list rather than waiting on a sidebar that may be a closed drawer.
   */
  const fleet = {
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: '/w/Ana' }] }),
    resolveAgents: vi.fn().mockResolvedValue({}),
  };

  /**
   * A room with somebody in it, so the header has a roster to draw.
   *
   * @param id - The room id.
   * @param slug - Its channel slug.
   * @param withAgent - Put an agent in it too. A room with NO agents opens the
   *   sheet's picker by itself, which is the right behaviour and the wrong
   *   fixture for anything asking what a particular door does.
   */
  function peopled(id: string, slug: string, withAgent = false): RoomWithRoster {
    const room = roomWith(id, slug);
    return {
      ...room,
      members: [
        {
          roomId: id,
          authorId: 'author-you',
          responseMode: 'silent',
          joinedAt: '2026-07-26T09:00:00.000Z',
          joinedSeq: 0,
          lastReadSeq: 0,
          author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
          origin: 'local',
        },
        ...(withAgent
          ? [
              {
                roomId: id,
                authorId: 'author-ana',
                responseMode: 'engaged' as const,
                joinedAt: '2026-07-26T09:00:00.000Z',
                joinedSeq: 0,
                lastReadSeq: 0,
                author: {
                  id: 'author-ana',
                  kind: 'agent' as const,
                  displayName: 'Ana',
                  handle: 'ana',
                  agentRef: agentAuthorRef('/w/Ana'),
                },
                origin: 'local' as const,
              },
            ]
          : []),
      ],
    };
  }

  // **The roster door is not on this page any more.** It moved to the bar's
  // members chip with the masthead (phase R1): `ChannelsBar.test.tsx` proves the
  // press asks for the members focus, and `RoomPanel.test.tsx` proves that focus
  // draws the roster. What remains here is the empty state's door, which is
  // still this page's own.
  it('makes the empty state say what is wrong, and gives it the button it promises', async () => {
    // A channel with no agents in it answers nothing. The empty state used to
    // tell you to add some and offer no way to do it.
    renderPage({
      ...fleet,
      getRoom: vi.fn((id: string) => Promise.resolve(peopled(id, 'general'))),
      listRoomEntries: vi.fn().mockResolvedValue([]),
    });

    expect(
      await screen.findByText(/no agents in here, so nothing will answer/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add agents' }));

    // Since phase R2 the button opens the right panel's Room tab with its
    // picker already expanded. The panel is mounted by the shell, which this
    // page test does not render — so what is asserted here is the request that
    // reaches it, naming this room and the part of the panel the promise was
    // about. That the request opens the picker is `RoomPanel.test.tsx`.
    await waitFor(() =>
      expect(useRoomPanelFocusStore.getState().request).toMatchObject({ focus: 'add' })
    );
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe(ROOM_PANEL_ID);
  });

  it('stops telling a peopled room it is empty of agents', async () => {
    renderPage({
      getRoom: vi.fn((id: string) => {
        const room = peopled(id, 'general');
        return Promise.resolve({
          ...room,
          members: [
            ...room.members,
            {
              roomId: id,
              authorId: 'author-ana',
              responseMode: 'mention-only' as const,
              joinedAt: '2026-07-26T09:00:00.000Z',
              joinedSeq: 0,
              lastReadSeq: 0,
              author: {
                id: 'author-ana',
                kind: 'agent' as const,
                displayName: 'Ana',
                handle: 'ana',
              },
              origin: 'local' as const,
            },
          ],
        });
      }),
      listRoomEntries: vi.fn().mockResolvedValue([]),
    });

    expect(await screen.findByText(/Say something to get it going/i)).toBeInTheDocument();
    expect(screen.queryByText(/no agents in here/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add more agents' })).toBeInTheDocument();
  });
});

describe('ChannelsPage room switching', () => {
  it('leaves a half-typed message behind in the room it was typed in', async () => {
    const { transport, openRoom } = renderPage();

    // Visit both rooms first, so the second switch finds room-2 cached and
    // takes NONE of the loading early-returns. That is the whole condition for
    // the bug: an early return would unmount the composer and hide it.
    await openRoom('room-1');
    await openRoom('room-2');
    const dmField = await openRoom('room-1');

    fireEvent.change(dmField, { target: { value: 'something private' } });
    expect(dmField.value).toBe('something private');

    const channelField = await openRoom('room-2');

    expect(channelField.value).toBe('');
    fireEvent.keyDown(channelField, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('does not let a post in one room latch the composer shut in another', async () => {
    // The first room's post never settles, so its latch is still raised when
    // the reader moves on.
    const { transport, openRoom } = renderPage({
      postToRoom: vi.fn(() => new Promise<PostToRoomResponse>(() => {})),
    });

    await openRoom('room-1');
    await openRoom('room-2');
    const dmField = await openRoom('room-1');

    fireEvent.change(dmField, { target: { value: 'still sending' } });
    fireEvent.keyDown(dmField, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    const channelField = await openRoom('room-2');
    fireEvent.change(channelField, { target: { value: 'still sending' } });
    fireEvent.keyDown(channelField, { key: 'Enter' });

    // Same words, different room: it has to go. A shared latch would drop this
    // one on the floor — no send, no clear, no toast.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));
    expect(transport.postToRoom).toHaveBeenNthCalledWith(2, 'room-2', { text: 'still sending' });
  });

  it('sends to the room on screen, addressed by that room', async () => {
    const { transport, openRoom } = renderPage();

    await openRoom('room-1');
    const channelField = await openRoom('room-2');

    fireEvent.change(channelField, { target: { value: 'hello #random' } });
    fireEvent.keyDown(channelField, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-2', { text: 'hello #random' });
  });
});

/**
 * The two ways a refusal arrives with nobody listening.
 *
 * TanStack dispatches per-call `mutate(…, { onError })` callbacks only while
 * the observer still has listeners (`mutationObserver.js:77`), and both of
 * these detach it — leaving the room unmounts the composer, and a second
 * `mutate()` removes the observer from the first mutation (`:56-58`). Handling
 * a refusal at the call site therefore loses it completely: no words, no toast.
 */
describe('ChannelsPage — a refusal nobody is listening for', () => {
  it('keeps a refused message in the room it was written for, after the reader has left it', async () => {
    let refuse: (err: Error) => void = () => {};
    const { transport, openRoom } = renderPage({
      postToRoom: vi.fn(
        () =>
          new Promise<PostToRoomResponse>((_resolve, reject) => {
            refuse = reject;
          })
      ),
    });

    await openRoom('room-1');
    await openRoom('room-2');
    const dmField = await openRoom('room-1');

    fireEvent.change(dmField, { target: { value: 'the message that will fail' } });
    fireEvent.keyDown(dmField, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    // Leave before the server answers. The composer that sent it is now gone.
    const channelField = await openRoom('room-2');
    refuse(new Error('This room is archived'));

    await waitFor(() =>
      // `expect.anything()` covers the shared "Report" action every
      // mutation-error toast carries; query-client.test.ts owns its content.
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't send your message",
        expect.objectContaining({ description: "This room is archived" })
      )
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    // The room the reader is standing in is untouched — its composer is not a
    // dumping ground for another conversation's refusal, and neither is its log.
    expect(channelField.value).toBe('');
    expect(screen.queryByTestId('room-pending')).not.toBeInTheDocument();

    // ...and the words are waiting in the room they were written for, on the
    // row that has been holding them since they were typed.
    await openRoom('room-1');
    const held = await screen.findByTestId('room-pending');
    expect(held).toHaveAttribute('data-status', 'failed');
    expect(held).toHaveTextContent('the message that will fail');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('reports a refusal nothing is listening for any more', async () => {
    const settlers: Array<(err: Error) => void> = [];
    const { transport, openRoom } = renderPage({
      postToRoom: vi.fn(
        () =>
          new Promise<PostToRoomResponse>((_resolve, reject) => {
            settlers.push(reject);
          })
      ),
    });

    const field = await openRoom('room-1');

    fireEvent.change(field, { target: { value: 'first' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    // The second `mutate()` detaches the observer from the first mutation.
    fireEvent.change(field, { target: { value: 'second' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));

    // The server refuses the FIRST one, which nothing is watching any more.
    settlers[0]!(new Error('Not a member of this room'));

    // TanStack dispatches per-call callbacks only while the observer still has
    // listeners, and the second `mutate` took them — so this is the case that
    // used to fail in silence. The row says which of the two did not get there.
    await waitFor(() => {
      const failed = usePendingPostStore.getState().posts.filter((p) => p.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.text).toBe('first');
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't send your message",
      expect.objectContaining({ description: "Not a member of this room" })
    );
  });

  it('leaves whatever was typed while it was in the air completely alone', async () => {
    let refuse: (err: Error) => void = () => {};
    const { transport, openRoom } = renderPage({
      postToRoom: vi.fn(
        () =>
          new Promise<PostToRoomResponse>((_resolve, reject) => {
            refuse = reject;
          })
      ),
    });

    const field = await openRoom('room-1');
    fireEvent.change(field, { target: { value: 'the refused one' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    fireEvent.change(field, { target: { value: 'typed while waiting' } });
    refuse(new Error('offline'));

    // Two sentences, one place each. Merging the refused one into the box on
    // top of the half-typed one meant a reader who then pressed Enter sent both
    // at once, as one message.
    await waitFor(() =>
      expect(usePendingPostStore.getState().posts[0]).toMatchObject({
        text: 'the refused one',
        status: 'failed',
      })
    );
    expect(field.value).toBe('typed while waiting');
  });

  it('keeps a draft while you read another room, and hands it back on return', async () => {
    const { openRoom } = renderPage();

    await openRoom('room-1');
    const dmField = await openRoom('room-2');
    fireEvent.change(dmField, { target: { value: 'half a thought' } });

    await openRoom('room-1');
    const returned = await openRoom('room-2');

    expect(returned.value).toBe('half a thought');
  });
});

describe('ChannelsPage — whose unread rule is this', () => {
  /** One member of a room, human by default. */
  function member(
    id: string,
    displayName: string,
    lastReadSeq: number
  ): RoomWithRoster['members'][number] {
    return {
      roomId: 'room-1',
      authorId: id,
      responseMode: 'always',
      joinedAt: '2026-07-26T09:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq,
      author: { id, kind: 'human', displayName, handle: null },
      origin: 'local',
    };
  }

  /** One post in the room, so the timeline has something to draw a rule between. */
  function post(seq: number): RoomEntry {
    return {
      roomId: 'room-1',
      seq,
      id: `entry-${seq}`,
      authorId: 'dorian',
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
    };
  }

  /**
   * With two people in a room, `find(kind === 'human')` returned whichever
   * sorted first — so Priya's "New messages" rule was drawn from Dorian's
   * cursor. Dorian is listed first and has read everything; Priya, the viewer,
   * has read nothing, so she must see the rule.
   */
  it("draws the rule from the viewer's cursor, not the first human's", async () => {
    openRoomId = 'room-1';
    const transport = createMockTransport({
      getRoom: vi.fn(() =>
        Promise.resolve({
          ...roomWith('room-1', 'backend'),
          members: [member('dorian', 'Dorian', 2), member('priya', 'Priya', 0)],
          viewerAuthorId: 'priya',
        })
      ),
      listRoomEntries: vi.fn(() => Promise.resolve([post(1), post(2)])),
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

    expect(await screen.findByTestId('unread-divider')).toBeInTheDocument();
  });
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
      listRoomEntries: vi.fn(() => Promise.resolve([root, reply])),
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

  it("moves the cursor to the reply's seq, not to the newest entry on screen", async () => {
    const transport = renderRoom();

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 2));
  });

  it('keeps the reply out of the room’s flow and offers it as a row', async () => {
    renderRoom();

    // The room's flow holds the root and nothing else...
    await screen.findByText('the message it hangs off');
    const timeline = screen.getByTestId('room-timeline');
    // Read by descent rather than by direct children: the timeline is
    // virtualized now, so each row sits inside the box the virtualizer
    // positions it with. The claim — the flow holds the root and nothing else —
    // is the same one.
    const flow = timeline.querySelectorAll('[data-testid="room-entry"]');
    expect(flow).toHaveLength(1);

    // ...and the reply itself is in the panel, which is not open yet — the row
    // is the whole of what a thread costs the room (design record §3).
    expect(screen.queryByText('answering in a thread')).not.toBeInTheDocument();
    expect(screen.getByTestId('room-thread-replies')).toHaveTextContent('1 reply');
    expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument();
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
      listRoomEntries: vi.fn(() => Promise.resolve(history)),
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
      '[class*="animate-thread-reply-in"], [class*="animate-reply-settle"], [class*="animate-thread-line-draw"]'
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

  it('puts the caret back on the MESSAGE when the thread has no reply row', async () => {
    // "Reply in thread" from the capsule opens a thread on a message nobody has
    // answered, so there is no "↳ N replies" row under it — the only thing the
    // restore used to look for. Focus went to `document.body` on every close of
    // a thread opened that way, which is the commonest way to open one.
    const user = userEvent.setup();
    renderRoom();

    const rows = await screen.findAllByTestId('room-entry');
    const unanswered = rows.find((row) => row.textContent?.includes('nobody answered this'))!;
    await user.click(within(unanswered).getByRole('button', { name: 'Reply in thread' }));

    expect(await screen.findByTestId('room-thread-panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close thread' }));

    await waitFor(() => expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument());
    await waitFor(() => expect(unanswered).toHaveFocus());
  });

  it('puts the caret back on a phone, where the room is unmounted while the thread is open', async () => {
    // The mobile shape is a different code path, not a narrower one: the room
    // and the panel are siblings under one `AnimatePresence` in `mode="wait"`,
    // so the room does not exist at all while the thread is up and the restore
    // has to survive the panel's exit. Every other test in this file runs on
    // the desktop branch, where the room never leaves.
    //
    // What jsdom can and cannot show here is worth stating: `motion` resolves
    // its exit immediately without a compositor, so this proves the mobile
    // BRANCH restores focus, not that it survives a 150ms animation. The
    // frame-by-frame proof of that is `use-restore-thread-focus.test.tsx`.
    onPhone();
    const user = userEvent.setup();
    renderRoom();

    const row = (await screen.findAllByTestId('room-thread-replies'))[0]!;
    await user.click(row);
    expect(await screen.findByTestId('room-thread-panel')).toBeInTheDocument();
    // The room really is gone — the push replaced it rather than covering it.
    expect(screen.queryByTestId('room-timeline')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Back to/ }));

    await waitFor(() => expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByTestId('room-thread-replies')[0]!).toHaveFocus());
  });

  it('gives the room’s presence announcer and the thread’s different names', async () => {
    // Two `role="status"` regions are on the page while a thread is open — the
    // room speaks for everything outside it, the panel for everything inside.
    // Sharing one testid made "did the ROOM announce it?" unaskable.
    const user = userEvent.setup();
    renderRoom();

    await user.click((await screen.findAllByTestId('room-thread-replies'))[0]!);

    // `getByTestId` throws on a second match, so this only passes if each name
    // belongs to exactly one of them.
    expect(screen.getByTestId('room-presence-announcer')).toBeInTheDocument();
    expect(screen.getByTestId('thread-presence-announcer')).toBeInTheDocument();
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

  it('still closes on Escape once the palette is out of the way', async () => {
    // The other half: Escape in a composer that has nothing to answer it must
    // still reach the panel, or the box becomes a trap.
    const user = userEvent.setup();
    renderRoom();

    await user.click((await screen.findAllByTestId('room-thread-replies'))[0]!);
    const composer = await screen.findByRole('combobox', { name: 'Reply in this thread…' });

    await user.click(composer);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('room-thread-panel')).not.toBeInTheDocument());
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
  /** A reply hanging off `entry-2`, which the room's own flow never draws. */
  const reply = {
    ...post(4, 'answering the port question'),
    parentEntryId: 'entry-2',
    threadRootEntryId: 'entry-2',
  } as unknown as RoomEntry;

  /** The tree the page renders in, kept so a test can re-render it in place. */
  function pageTree(entries: RoomEntry[] = history) {
    return (
      <QueryClientProvider client={new QueryClient(createQueryClientConfig())}>
        <EventStreamProvider>
          <TransportProvider
            transport={createMockTransport({
              getRoom: vi.fn(() => Promise.resolve(roomWith('room-1', 'backend'))),
              listRoomEntries: vi.fn(() => Promise.resolve(entries)),
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

  /** Answer a second search without remounting — the defect's exact shape. */
  let rerenderPage: () => void = () => {};

  function openRoomWithHistory(entries: RoomEntry[] = history) {
    const { rerender } = render(pageTree(entries));
    rerenderPage = () => rerender(pageTree(entries));
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
    openEntrySeq = 2;

    expect(await landedOn()).toBe('requested');
  });

  it('opens at the newest message when the address names none', async () => {
    // The positive control. Without it a page that always reported `requested`
    // would pass the test above.
    expect(await landedOn()).toBe('end');
  });

  it('opens at the newest message when the history no longer reaches that far', async () => {
    // A hit outside the room's trailing page. The link must not swallow the
    // landing, and the reader is told rather than left to wonder why the room
    // opened at the bottom.
    openEntrySeq = 4200;

    expect(await landedOn()).toBe('end');
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "DorkOS can't find that message in what's open here",
        expect.anything()
      )
    );
  });

  it('says nothing about reach when the message is right there', async () => {
    // The positive control for the sentence above.
    openEntrySeq = 2;
    await landedOn();

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('moves again when a second search names another message in the SAME room', async () => {
    // **The defect that made this feature a no-op for its commonest case.**
    // Clicking a hit in the room you are already reading is an in-place
    // search-param navigation: the room does not change, so the timeline's arm
    // guard never lifted. The URL said one thing and the room sat where it was.
    //
    // Asserted at the page, because only the page can do the thing that broke —
    // change `?entry=` without changing the room — and asserted on the MARK,
    // because `data-landed-on` reads `requested` both times and cannot tell two
    // landings apart.
    openEntrySeq = 1;
    openRoomWithHistory();
    await screen.findByText('the port question');
    await waitFor(() =>
      expect(document.getElementById('room-entry-entry-1')).toHaveAttribute('data-landed', 'true')
    );

    openEntrySeq = 3;
    rerenderPage();

    await waitFor(() =>
      expect(document.getElementById('room-entry-entry-3')).toHaveAttribute('data-landed', 'true')
    );
    // And the first one has stopped claiming to be the answer.
    expect(document.getElementById('room-entry-entry-1')).not.toHaveAttribute('data-landed');
  });

  it('opens the thread a reply lives in, so the message is actually on screen', async () => {
    // A reply is not drawn in the room's flow — the flow draws the "↳ N
    // replies" row of its thread — so landing the room and stopping there puts
    // a reader on a collapsed count with the message they searched for nowhere
    // in the document. The panel is where the reply IS.
    openEntrySeq = 4;
    openRoomWithHistory([...history, reply]);

    await waitFor(() => expect(screen.getByTestId('room-thread-feed')).toBeInTheDocument());
    // Drawn under the PANEL's own row id, which is the proof it is on screen
    // rather than merely loaded.
    await waitFor(() =>
      expect(document.getElementById('thread-panel-entry-entry-4')).not.toBeNull()
    );
    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('entry-2');
  });

  it('opens no thread panel for a top-level hit', async () => {
    // The positive control: a room that opened a thread for every hit would
    // put a panel over itself on the commonest case of all.
    openEntrySeq = 2;
    openRoomWithHistory([...history, reply]);
    await screen.findByText('the port question');

    expect(screen.queryByTestId('room-thread-feed')).not.toBeInTheDocument();
  });
});
