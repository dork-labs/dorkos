// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockRoomEntryPage } from '@dorkos/test-utils/mock-factories';
import {
  agentAuthorRef,
  type PostToRoomResponse,
  type RoomEntry,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { EventStreamProvider, TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ROOM_PANEL_ID, useRoomPanelFocusStore } from '@/layers/features/room-management';
import { ChannelsPage } from '../../ui/ChannelsPage';
import { route } from './channels-page.route';
import {
  installChannelsPageHarness,
  renderPage,
  roomWith,
  staysOpen,
} from './channels-page.fixtures';

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
      listRoomEntries: vi.fn().mockResolvedValue(mockRoomEntryPage()),
    });

    expect(await screen.findByText(/Nothing answers until you add an agent/i)).toBeInTheDocument();
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
        'Couldn’t send your message',
        expect.objectContaining({ description: 'This room is archived' })
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
  it('draws the rule from the viewer’s cursor, not the first human’s', async () => {
    route.roomId = 'room-1';
    const transport = createMockTransport({
      getRoom: vi.fn(() =>
        Promise.resolve({
          ...roomWith('room-1', 'backend'),
          members: [member('dorian', 'Dorian', 2), member('priya', 'Priya', 0)],
          viewerAuthorId: 'priya',
        })
      ),
      listRoomEntries: vi.fn(() => Promise.resolve(mockRoomEntryPage([post(1), post(2)]))),
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
