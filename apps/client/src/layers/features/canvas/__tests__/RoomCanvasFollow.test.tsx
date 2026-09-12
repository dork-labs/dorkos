/**
 * @vitest-environment jsdom
 */
/**
 * Following a teammate's browser, and discussing a document, from the room's
 * canvas (spec `canvas-agent-seat` §6, §7).
 *
 * Four properties:
 *
 * - **Nothing goes out until somebody is following.** The room tells this
 *   viewer they are followed, and only then does a position leave the browser.
 * - **People only.** The list is everybody else in the room who is a person; an
 *   agent never appears, because it has no view to share.
 * - **A follower is moved, unless they are typing.** Room-canvas §9.3 outranks
 *   following: losing a draft is worse than losing the thread.
 * - **Discuss opens one conversation.** The server decides whether that is a
 *   fresh one or the one already there, and the panel lands on whichever it is.
 *
 * Seeded defects: dropping the `useIsFollowed` gate reddens "sends nothing";
 * dropping the `kind === 'human'` filter reddens "lists people only"; dropping
 * the editing check reddens "never moves somebody who is typing".
 *
 * @module features/canvas/tests/RoomCanvasFollow
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockCanvasDocument } from '@dorkos/test-utils';
import type { CanvasDocument, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { useRoomFollowStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { BrowserContent } from '../index';

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('streamdown/styles.css', () => ({}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const ROOM = 'room-1';
const VIEWER = 'author-you';
const KAI = 'author-kai';
const ANA = 'author-ana';

/** Two people and one agent, so "people only" has something to exclude. */
const ROSTER = {
  id: ROOM,
  viewerAuthorId: VIEWER,
  members: [
    { author: { id: VIEWER, kind: 'human', displayName: 'You', handle: 'you' } },
    { author: { id: KAI, kind: 'human', displayName: 'Kai', handle: 'kai' } },
    { author: { id: ANA, kind: 'agent', displayName: 'Ana', handle: 'ana' } },
  ],
} as unknown as RoomWithRoster;

let transport: Transport;
let queryClient: QueryClient;

/** Put one page on the room's table, exactly as a `canvas` frame would. */
function seed(overrides: Partial<CanvasDocument> = {}) {
  const document = mockCanvasDocument({
    roomId: ROOM,
    scope: `room:${ROOM}`,
    content: { type: 'browser', url: 'http://localhost:5173/' },
    ...overrides,
  });
  useAppStore
    .getState()
    .applyRoomCanvasFrame(
      ROOM,
      { type: 'canvas', documentId: document.id, document, change: 'opened' },
      VIEWER
    );
  return document;
}

function renderBrowserTab() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <BrowserContent />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The scroll container this view's document lives in.
 *
 * Addressed by the id the header and the body agree on, because that is what
 * the component's own ref points at — and `scrollTop` is the only observable a
 * follow position has beyond which tab is showing.
 */
function panelOf(view: 'canvas' | 'browser'): HTMLElement {
  const panel = document.getElementById(view === 'browser' ? 'browser-panel' : 'canvas-panel');
  if (panel === null) throw new Error(`the ${view} panel is not on screen`);
  return panel;
}

/** Deliver one `presence` signal into the follow store, as the stream would. */
function signal(over: Record<string, unknown>) {
  act(() => {
    useRoomFollowStore.getState().observe(ROOM, {
      type: 'signal',
      signal: 'presence',
      at: '2026-09-12T10:00:00.000Z',
      ...over,
    } as never);
  });
}

beforeEach(() => {
  transport = createMockTransport();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['rooms', 'detail', ROOM], ROSTER);
  useAppStore.setState({
    roomCanvasDocuments: {},
    roomCanvasActive: {},
    roomCanvasUnread: {},
    roomCanvasEditing: {},
    roomCanvasStale: {},
    browserHistories: {},
    roomCanvasLiveRoomId: ROOM,
  });
  useRoomFollowStore.setState({ intent: {}, claims: {}, positions: {} });
  useRoomOpenThreadStore.setState({ open: {} });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ roomCanvasLiveRoomId: null });
});

describe('sharing where you are looking', () => {
  it('sends nothing at all while nobody is following', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    // Long enough for a debounce to have fired several times over.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.publishRoomView).not.toHaveBeenCalled();
  });

  it('starts sending once the room says somebody is following', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    signal({ authorId: KAI, follows: VIEWER });

    await waitFor(() =>
      expect(transport.publishRoomView).toHaveBeenCalledWith(
        ROOM,
        expect.objectContaining({ documentId: 'page' })
      )
    );
  });

  it('stops sending when the last follower lets go', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    signal({ authorId: KAI, follows: VIEWER });
    await waitFor(() => expect(transport.publishRoomView).toHaveBeenCalled());

    vi.mocked(transport.publishRoomView).mockClear();
    signal({ authorId: KAI, follows: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.publishRoomView).not.toHaveBeenCalled();
  });
});

describe('choosing somebody to follow', () => {
  it('lists the other people in the room, and no agent', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    await userEvent.click(screen.getByRole('button', { name: 'Follow' }));

    expect(await screen.findByText('Kai')).toBeInTheDocument();
    expect(screen.queryByText('Ana')).not.toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  it('claims the follow with the room, and says who is being followed', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    await userEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await userEvent.click(await screen.findByText('Kai'));

    await waitFor(() => expect(transport.followRoomMember).toHaveBeenCalledWith(ROOM, KAI));
    expect(await screen.findByRole('button', { name: 'Following Kai' })).toBeInTheDocument();
  });
});

describe('being moved by somebody you follow', () => {
  it('moves to the document they are on', async () => {
    seed({ id: 'page', title: 'localhost' });
    seed({ id: 'other', title: 'other page', content: { type: 'browser', url: 'http://a/' } });
    renderBrowserTab();
    act(() => {
      useRoomFollowStore.getState().startFollowing(ROOM, KAI, Date.now());
    });
    signal({ authorId: KAI, view: { documentId: 'other' } });

    await waitFor(() =>
      expect(useAppStore.getState().roomCanvasActive[ROOM]?.browser).toBe('other')
    );
  });

  it('never moves somebody who is in the middle of typing', async () => {
    seed({ id: 'page', title: 'localhost' });
    seed({ id: 'other', title: 'other page', content: { type: 'browser', url: 'http://a/' } });
    renderBrowserTab();
    act(() => {
      // Room-canvas §9.3: a viewer editing a document is never moved off it.
      useAppStore.getState().setRoomCanvasEditing(ROOM, 'page');
      useRoomFollowStore.getState().startFollowing(ROOM, KAI, Date.now());
    });
    const before = useAppStore.getState().roomCanvasActive[ROOM]?.browser;
    signal({ authorId: KAI, view: { documentId: 'other' } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.browser).toBe(before);
  });

  it('scrolls to where they are on the document this viewer is already showing', async () => {
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    const panel = panelOf('browser');
    panel.scrollTop = 0;
    act(() => {
      useRoomFollowStore.getState().startFollowing(ROOM, KAI, Date.now());
    });

    signal({ authorId: KAI, view: { documentId: 'page', scrollY: 240 } });

    await waitFor(() => expect(panel.scrollTop).toBe(240));
  });

  it('leaves this viewer’s own scroll alone when the position names a document they closed', async () => {
    // A follow claim outlives the last frame by thirty seconds, so a position
    // naming a document this viewer has closed — or that their own LRU evicted
    // — arrives while they are reading something else. Acting on it would take
    // their scroll away, repeatedly, over a document not on their screen.
    seed({ id: 'page', title: 'localhost' });
    renderBrowserTab();
    const panel = panelOf('browser');
    panel.scrollTop = 90;
    act(() => {
      useRoomFollowStore.getState().startFollowing(ROOM, KAI, Date.now());
    });

    signal({ authorId: KAI, view: { documentId: 'gone-from-here', scrollY: 240 } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(panel.scrollTop).toBe(90);
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.browser).toBe('page');
  });

  it('moves to another open document first, and scrolls only once it is showing', async () => {
    // The offset was measured inside the document it names, so applying it to
    // whatever happens to be on screen would scroll the wrong thing for one
    // render. The activation lands first; the scroll rides the next pass.
    seed({ id: 'page', title: 'localhost' });
    seed({ id: 'other', title: 'other page', content: { type: 'browser', url: 'http://a/' } });
    renderBrowserTab();
    const panel = panelOf('browser');
    panel.scrollTop = 0;
    act(() => {
      useRoomFollowStore.getState().startFollowing(ROOM, KAI, Date.now());
    });

    signal({ authorId: KAI, view: { documentId: 'other', scrollY: 160 } });

    await waitFor(() =>
      expect(useAppStore.getState().roomCanvasActive[ROOM]?.browser).toBe('other')
    );
    await waitFor(() => expect(panel.scrollTop).toBe(160));
  });
});

describe('discussing a document', () => {
  it('opens the discussion and shows it', async () => {
    seed({ id: 'page', title: 'localhost' });
    vi.mocked(transport.discussCanvasDocument).mockResolvedValue({
      threadRootEntryId: 'root-1',
      created: true,
    });
    renderBrowserTab();

    await userEvent.click(screen.getByRole('button', { name: 'Discuss' }));

    await waitFor(() => expect(transport.discussCanvasDocument).toHaveBeenCalledWith(ROOM, 'page'));
    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open[ROOM]?.rootEntryId).toBe('root-1')
    );
  });

  it('lands in the same discussion the second time', async () => {
    seed({ id: 'page', title: 'localhost' });
    vi.mocked(transport.discussCanvasDocument).mockResolvedValue({
      threadRootEntryId: 'root-1',
      created: false,
    });
    renderBrowserTab();

    await userEvent.click(screen.getByRole('button', { name: 'Discuss' }));
    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open[ROOM]?.rootEntryId).toBe('root-1')
    );
  });
});
