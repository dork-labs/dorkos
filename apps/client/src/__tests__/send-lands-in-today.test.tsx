// @vitest-environment jsdom
/**
 * The operator's ruling, driven end to end in one process: **submitting a
 * prompt puts the conversation in Today** (DOR-1156).
 *
 * Every link in the chain is the real one — the real `useChatSession` send, the
 * real `entities/interactions` store it writes to, the real `useSidebarState`
 * that reads it, and the real `buildSidebarModel` that turns it into rows. It
 * lives at the app-shell level because it spans three layers, and only this
 * level may import all of them.
 *
 * **Why the composition, when both halves already have suites.** The seam
 * between them is a string key (`session:<id>`) and a unit (`ISO-8601`), and
 * both sides type-check against `string`. A send that recorded the right thing
 * under a key nothing reads, or wrote epoch milliseconds, would leave the send
 * suite green, the sidebar suite green, and Today empty —
 * `interaction-seam.test.ts` exists because that exact mismatch fails silently.
 * This carries the send's own output all the way to a row.
 *
 * @module __tests__/send-lands-in-today
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';

// Hoisted with the mock factories that close over them: `vi.mock` runs before
// module-scope initializers, and a plain `const` read from a factory throws
// "cannot access before initialization".
const { AGENT_PATH, FIXED_NOW, SESSION } = vi.hoisted(() => {
  const now = 1_786_000_000_000;
  const agentPath = '/projects/alpha';
  return {
    FIXED_NOW: now,
    AGENT_PATH: agentPath,
    /** The session the operator writes into. On the wire, never opened. */
    SESSION: {
      id: 's1',
      title: 'The one nobody clicked',
      cwd: agentPath,
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
      permissionMode: 'default',
      runtime: 'claude-code',
    },
  };
});

vi.mock('@tanstack/react-router', () => ({
  // Present, because these cases render inside a routed cockpit. The safe-router
  // wrappers ask before reading route state (DOR-1444).
  useRouter: () => ({ stores: {} }),
  // The home surface: nothing conversational is open, so Today has no anchor
  // and cannot draw `s1` for free (BC-21). That is what makes the before-state
  // below an honest "not in Today".
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

// The durable stream never opens a real connection here; the send path only
// needs `attachSession` to exist.
vi.mock('@/layers/shared/lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/transport')>()),
  streamManager: {
    connectList: vi.fn(),
    setListeners: vi.fn(),
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    releaseSession: vi.fn(),
    getAttachedSessionId: vi.fn().mockReturnValue(null),
    subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const appState = { selectedCwd: AGENT_PATH, enableMessagePolling: false };
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(appState) : appState,
    { getState: () => appState }
  );
  return { ...actual, useAppStore, useNow: () => FIXED_NOW };
});

const AGENT_PATHS = [{ id: 'm1', name: 'alpha', projectPath: AGENT_PATH }];
const MANIFESTS = { [AGENT_PATH]: null };
const RECENT = { sessions: [SESSION], agentActivity: {}, warnings: [] };
/** A channel on the wire that nobody has opened — the room half of the ruling. */
const ROOM = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: '#general',
  topic: null,
  archived: false,
  ambientMaxEntries: 50,
  wellKnown: null,
  createdAt: new Date(FIXED_NOW - 72 * 60 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString(),
  unreadCount: 0,
  participants: null,
  working: 0,
};
const ROOMS: unknown[] = [ROOM];
const THREADS = { data: [] as unknown[], isLoading: false, error: null };
const ATTENTION: unknown[] = [];

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENT_PATHS }, isSuccess: true }),
}));
vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => ATTENTION,
  usePendingInteractions: () => ({ interactions: [], isLoading: false }),
  // Heads up's other two sources, settled — they are boot-gate members since
  // D6, and a panel whose gate never opens draws no Today rows to assert on.
  usePendingApprovals: () => ({ approvals: [], isLoading: false }),
  usePendingScheduleApprovals: () => ({ schedules: [], isLoading: false }),
}));
vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useResolvedAgents: () => ({ data: MANIFESTS, isSuccess: true }),
  useExecutionExceptions: () => ({
    exceptions: [],
    brokenPaths: [],
    defaultRuntime: 'claude-code',
  }),
}));
// The SUBMODULE, not the barrel — `agent-attention.ts` reaches for this path
// directly, so a barrel mock would leave the real hook wanting a transport.
vi.mock('@/layers/entities/session/model/query/use-recent-sessions', () => ({
  useRecentSessions: () => ({ data: RECENT, isLoading: false, isSuccess: true }),
}));
vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRooms: () => ({ data: ROOMS, isLoading: false }),
  useThreads: () => THREADS,
}));
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  const PREFS = {
    pinned: [],
    groups: [],
    muted: [],
    sections: {},
    gettingStarted: { retired: [] },
    digest: {},
  };
  return {
    ...actual,
    useSidebarPrefs: () => PREFS,
    useUpdateSidebarPrefs: () => ({
      update: vi.fn(),
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useWelcomeBack: () => ({
      enabled: false,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: false,
      setEnabled: vi.fn(),
      setOffersEnabled: vi.fn(),
      isAvailable: true,
      isPending: false,
    }),
  };
});

import { useChatSession } from '@/layers/features/chat';
// Deep-imported, like `one-live-definition.test.tsx` next door: the model and
// its state assembly are the sidebar's internals, and a cross-layer guard is
// the one caller with a reason to reach them.
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { useSidebarState } from '@/layers/features/dashboard-sidebar/model/use-sidebar-state';
import { ChannelComposerBench } from '@/test-helpers/channel-composer';
import { useInteractionStore } from '@/layers/entities/interactions';
import { usePendingPostStore, useRoomDraftStore } from '@/layers/entities/room';
import {
  resetSessionStreamBinding,
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';

function wrapper(transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The row keys Today is currently showing. */
function todayKeys(state: ReturnType<typeof useSidebarState>): string[] {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'today');
  return zone?.sections.flatMap((section) => section.rows.map((row) => row.key)) ?? [];
}

describe('a submitted prompt reaches Today', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useInteractionStore.getState().reset();
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
    resetSessionStreamBinding();
  });
  afterEach(cleanup);

  it('puts a conversation nobody opened into Today, on the send alone', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(
      () => ({ chat: useChatSession(SESSION.id), sidebar: useSidebarState() }),
      { wrapper: wrapper(transport) }
    );

    // BEFORE. The session is on the wire and has been for an hour; nobody has
    // opened it and nothing is anchored on it, so Today does not have it. If
    // this expectation ever passes trivially — because the row arrived some
    // other way — the assertion after the send proves nothing.
    expect(todayKeys(result.current.sidebar)).not.toContain(`session:${SESSION.id}`);

    act(() => {
      result.current.chat.setInput('Do the thing.');
    });
    await waitFor(() => expect(result.current.chat.input).toBe('Do the thing.'));
    await act(async () => {
      await result.current.chat.handleSubmit();
    });

    // AFTER. One act, and the conversation is in Today — through the real
    // store, the real state assembly and the real rules.
    await waitFor(() => {
      expect(todayKeys(result.current.sidebar)).toContain(`session:${SESSION.id}`);
    });
  });

  it('orders Today by the send — the row the operator wrote in comes first', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    // A channel opened a minute ago. It holds Today's only row, and its first
    // place, until the send earns that place for `s1`.
    useInteractionStore.getState().recordOpened('room', ROOM.id, Date.now() - 60_000);

    const { result } = renderHook(
      () => ({ chat: useChatSession(SESSION.id), sidebar: useSidebarState() }),
      { wrapper: wrapper(transport) }
    );

    expect(todayKeys(result.current.sidebar)).toEqual([`room:${ROOM.id}`]);

    act(() => {
      result.current.chat.setInput('Mine now.');
    });
    await waitFor(() => expect(result.current.chat.input).toBe('Mine now.'));
    await act(async () => {
      await result.current.chat.handleSubmit();
    });

    // Membership AND order, from one act. The channel keeps its row and loses
    // its place — which is what "ordered by that instant" means.
    await waitFor(() => {
      expect(todayKeys(result.current.sidebar)).toEqual([
        `session:${SESSION.id}`,
        `room:${ROOM.id}`,
      ]);
    });
  });
});

describe('a posted message reaches Today', () => {
  // A desktop pointer, so Enter sends the message rather than inserting a
  // newline — the same setup `ChannelComposer.test.tsx` runs on.
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
    vi.clearAllMocks();
    useInteractionStore.getState().reset();
    useRoomDraftStore.setState({ drafts: {} });
    usePendingPostStore.setState({ posts: [] });
  });
  afterEach(cleanup);

  it('puts a channel nobody opened into Today, on the post alone', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useSidebarState(), { wrapper: wrapper(transport) });

    // BEFORE. The channel is on the wire and has been for three days; nobody
    // has opened it and the home surface is not anchored on it.
    expect(todayKeys(result.current)).not.toContain(`room:${ROOM.id}`);

    // The composer takes the room WITH its roster; the sidebar takes the
    // summary. Same room, two views of it, exactly as the app has them — and
    // the operator is on that roster, because the composer reads membership
    // now (DOR-1233) and offers a Join line rather than a field to anyone
    // who is not. A poster is a member; an empty roster would describe a room
    // the server would refuse this post from.
    const withRoster = {
      ...ROOM,
      members: [
        {
          roomId: ROOM.id,
          authorId: 'author-you',
          responseMode: 'always',
          joinedAt: ROOM.createdAt,
          joinedSeq: 0,
          lastReadSeq: 0,
          author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
          origin: 'local',
        },
      ],
      viewerAuthorId: 'author-you',
    };
    render(<ChannelComposerBench room={withRoster as unknown as RoomWithRoster} />, {
      wrapper: wrapper(transport),
    });
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'morning all' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(todayKeys(result.current)).toContain(`room:${ROOM.id}`);
    });
  });
});
