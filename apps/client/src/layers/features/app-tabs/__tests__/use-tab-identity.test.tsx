/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createMockSessionLimit, createMockTransport } from '@dorkos/test-utils';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createInitialSlots, TransportProvider, useExtensionRegistry } from '@/layers/shared/model';
import { setSessionRouteContext, useSessionListStore } from '@/layers/entities/session';
import { pendingInteractionsQueryOptions } from '@/layers/entities/attention';

const agentByPath = vi.fn<(cwd: string | null) => AgentManifest | null>(() => null);
vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: (cwd: string | null) => ({ data: agentByPath(cwd) }),
}));

import { useTabIdentity } from '../model/use-tab-identity';
import { useTabSignalsStore } from '../model/tab-signals';
import { TabStatusMark } from '../ui/TabStatusMark';

const transport = createMockTransport();

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A live status as the global stream would deliver it. */
function status(overrides: Partial<SessionStatus>): SessionStatus {
  return { lifecycle: 'idle', limit: null, ...overrides } as SessionStatus;
}

const SCOUT = { id: 'scout', name: 'scout', displayName: 'Scout', icon: '🔍' } as AgentManifest;

beforeEach(() => {
  vi.clearAllMocks();
  agentByPath.mockImplementation((cwd) => (cwd === '/Users/kai/api' ? SCOUT : null));
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    unseen: {},
    limits: {},
  });
  useTabSignalsStore.setState({ needsYouCount: 0, routeBadges: {} });
  vi.mocked(transport.getSession).mockReturnValue(new Promise(() => {}));
});

describe('useTabIdentity', () => {
  describe('an agent’s Direct chat (DOR-3074)', () => {
    /** The config answer, with the DM view on or off. */
    function dmView(enabled: boolean) {
      vi.mocked(transport.getConfig).mockResolvedValue({
        experiments: [
          { key: 'ui.dmView', title: '', description: '', enabled, lockedByEnv: false },
        ],
      } as never);
    }

    beforeEach(() => {
      setSessionRouteContext('direct-1', { cwd: '/somewhere/else', draft: false });
      vi.mocked(transport.getSession).mockResolvedValue({
        id: 'direct-1',
        cwd: '/somewhere/else',
        title: 'Direct',
        updatedAt: '2026-10-09T09:00:00.000Z',
      } as unknown as Session);
      vi.mocked(transport.findDirectChat).mockResolvedValue({
        sessionId: 'direct-1',
        sessionIds: ['direct-1'],
        roomId: 'dm-scout',
        agentPath: '/Users/kai/api',
      });
    });

    it('is named for the agent alone with the DM view on', async () => {
      dmView(true);
      const { result } = renderHook(() => useTabIdentity('/session?session=direct-1'), {
        wrapper,
      });
      await waitFor(() => expect(result.current.primary).toBe('Scout'));
      expect(result.current.secondary).toBeUndefined();
    });

    it('says Session on the session view behind the DM', async () => {
      dmView(true);
      const { result } = renderHook(
        () => useTabIdentity('/session?session=direct-1&view=session'),
        { wrapper }
      );
      await waitFor(() => expect(result.current.secondary).toBe('Session'));
      expect(result.current.primary).toBe('Scout');
    });

    it('reads exactly as before, and never asks, with the DM view off', async () => {
      dmView(false);
      const { result } = renderHook(() => useTabIdentity('/session?session=direct-1'), {
        wrapper,
      });
      await waitFor(() => expect(result.current.secondary).toBe('Direct'));
      expect(transport.findDirectChat).not.toHaveBeenCalled();
    });
  });

  describe('a chat', () => {
    beforeEach(() => {
      setSessionRouteContext('chat-1', { cwd: '/Users/kai/api', draft: false });
    });

    it('is named after its agent, in its emoji', () => {
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      expect(result.current).toMatchObject({
        primary: 'Scout',
        icon: { kind: 'emoji', emoji: '🔍' },
        agentKey: 'scout',
      });
    });

    it('says Paused once its account runs out of usage', () => {
      useSessionListStore
        .getState()
        .setSessionStatus('chat-1', status({ limit: createMockSessionLimit('waiting') }));
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      expect(result.current.status).toBe('paused');
      expect(result.current.statusSentence).toMatch(/^Out of usage/);
    });

    it('says what it is doing while it works', () => {
      useSessionListStore.setState({
        statuses: { 'chat-1': status({ lifecycle: 'streaming' }) },
      });
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      expect(result.current.status).toBe('working');
      expect(result.current.accessibleName).toMatch(/^Scout, Working/);
    });

    it('says working, not Paused, once the stream clears a limit the row still carries', async () => {
      vi.mocked(transport.getSession).mockResolvedValue({
        id: 'chat-1',
        cwd: '/Users/kai/api',
        title: 'Fix the login bug',
        updatedAt: '2026-10-09T09:00:00.000Z',
        status: { lifecycle: 'idle', limit: createMockSessionLimit('waiting') },
      } as unknown as Session);
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      await waitFor(() => expect(result.current.status).toBe('paused'));
      act(() =>
        useSessionListStore.getState().applyListEvent({
          type: 'session_status',
          sessionId: 'chat-1',
          status: status({ lifecycle: 'streaming', limit: null }),
        } as never)
      );
      expect(result.current.status).toBe('working');
    });

    it('says Paused for a background chat that runs out of usage while idle', async () => {
      vi.mocked(transport.getSession).mockResolvedValue({
        id: 'chat-1',
        cwd: '/Users/kai/api',
        title: 'Fix the login bug',
        updatedAt: '2026-10-09T09:00:00.000Z',
      } as unknown as Session);
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      await waitFor(() => expect(result.current.secondary).toBe('Fix the login bug'));
      expect(result.current.status).toBeUndefined();
      // Idle statuses are pruned from the liveness map; the limit must survive.
      act(() =>
        useSessionListStore.getState().applyListEvent({
          type: 'session_status',
          sessionId: 'chat-1',
          status: status({ lifecycle: 'idle', limit: createMockSessionLimit('waiting') }),
        } as never)
      );
      expect(result.current.status).toBe('paused');
    });

    it('leaves the shared prompt list refetchable after a chat tab observes it', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.mocked(transport.listPendingInteractions).mockResolvedValue({ interactions: [] });
      const shared = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
      // The Inbox's own reader first, then the tab, which renders last.
      renderHook(
        () => {
          useQuery(pendingInteractionsQueryOptions(transport));
          return useTabIdentity('/session?session=chat-1');
        },
        { wrapper: shared }
      );
      await waitFor(() => expect(transport.listPendingInteractions).toHaveBeenCalledTimes(1));
      await act(() => client.invalidateQueries({ queryKey: ['pending-interactions'] }));
      expect(transport.listPendingInteractions).toHaveBeenCalledTimes(2);
      expect(client.getQueryState(['pending-interactions'])?.status).toBe('success');
    });

    it('puts a failure ahead of a pause', () => {
      useSessionListStore
        .getState()
        .setSessionStatus(
          'chat-1',
          status({ lifecycle: 'error', limit: createMockSessionLimit('ask') })
        );
      const { result } = renderHook(() => useTabIdentity('/session?session=chat-1'), { wrapper });
      expect(result.current.status).toBe('failed');
    });
  });

  it('counts what is waiting on you on Home', () => {
    const { result } = renderHook(() => useTabIdentity('/'), { wrapper });
    expect(result.current.count).toBeUndefined();
    act(() => useTabSignalsStore.getState().setNeedsYouCount(3));
    expect(result.current).toMatchObject({ primary: 'Home', count: 3, status: 'needs-you' });
  });

  it('counts the agents working on Team', () => {
    useSessionListStore.setState({
      statuses: {
        a: status({ lifecycle: 'streaming' }),
        b: status({ lifecycle: 'streaming' }),
        c: status({ lifecycle: 'streaming' }),
      },
      // Two chats with one agent are one agent working.
      statusCwds: { a: '/Users/kai/api', b: '/Users/kai/api', c: '/Users/kai/web' },
    });
    const { result } = renderHook(() => useTabIdentity('/team'), { wrapper });
    expect(result.current).toMatchObject({
      primary: 'Team',
      secondary: '2 working',
      status: 'working',
    });
  });

  describe('the Team label says what its dot says (DOR-3533)', () => {
    /** The class list of the dot the strip would draw for this identity. */
    function dotClass(identity: Parameters<typeof TabStatusMark>[0]['identity']): string {
      const { container } = render(<TabStatusMark identity={identity} />);
      return container.querySelector('[data-slot="tab-status"]')?.className ?? '';
    }

    it('says "needs you" beside the amber dot when an agent is waiting, not "working"', () => {
      // The Dev Playground's Verb Ladder: three live turns and one blocked chat.
      useSessionListStore.setState({
        statuses: {
          a: status({ lifecycle: 'streaming' }),
          b: status({ lifecycle: 'streaming' }),
          c: status({ lifecycle: 'streaming' }),
          d: status({ lifecycle: 'blocked' }),
        },
      });
      const { result } = renderHook(() => useTabIdentity('/team'), { wrapper });
      expect(result.current).toMatchObject({
        secondary: '1 needs you',
        status: 'needs-you',
        statusSentence: '1 agent is waiting on you\u00a0· 3\u00a0working',
      });
      expect(dotClass(result.current)).toContain('bg-status-warning-dot');
    });

    it('counts agents, not chats, and says "need you" for more than one', () => {
      useSessionListStore.setState({
        statuses: {
          a: status({ lifecycle: 'blocked' }),
          b: status({ lifecycle: 'blocked' }),
          c: status({ lifecycle: 'blocked' }),
        },
        statusCwds: { a: '/Users/kai/api', b: '/Users/kai/api', c: '/Users/kai/web' },
      });
      const { result } = renderHook(() => useTabIdentity('/team'), { wrapper });
      expect(result.current).toMatchObject({ secondary: '2 need you', status: 'needs-you' });
    });

    it('keeps "working" with the green dot when nobody is waiting', () => {
      useSessionListStore.setState({
        statuses: { a: status({ lifecycle: 'streaming' }) },
      });
      const { result } = renderHook(() => useTabIdentity('/team'), { wrapper });
      expect(result.current).toMatchObject({ secondary: '1 working', status: 'working' });
      const dot = dotClass(result.current);
      expect(dot).toContain('bg-status-success');
      expect(dot).not.toContain('bg-status-warning');
    });
  });

  it('does not count a scheduled run as an agent working, but still says it needs you', () => {
    useSessionListStore.setState({
      sessions: {
        sched: { id: 'sched', origin: 'task' } as Session,
        blocked: { id: 'blocked', origin: 'task' } as Session,
      },
      statuses: {
        sched: status({ lifecycle: 'streaming' }),
        blocked: status({ lifecycle: 'blocked' }),
      },
      statusCwds: { sched: '/Users/kai/api', blocked: '/Users/kai/web' },
    });
    const { result } = renderHook(() => useTabIdentity('/team'), { wrapper });
    expect(result.current).toMatchObject({
      secondary: '1 needs you',
      status: 'needs-you',
      statusSentence: '1 agent is waiting on you',
    });
  });

  it('names the Settings dialog open over any page after its section', () => {
    const { result } = renderHook(() => useTabIdentity('/team?settings=appearance'), { wrapper });
    expect(result.current).toMatchObject({ primary: 'Settings', secondary: 'Appearance' });
  });

  it('names an open profile after whose it is', async () => {
    vi.mocked(transport.getTeamRoster).mockResolvedValue({
      members: [
        {
          id: 'agent-1',
          kind: 'agent',
          displayName: 'Scout',
          handle: null,
          isSelf: false,
          ownerId: null,
          origin: 'local',
        } as unknown as TeamMember,
      ],
    });
    const { result } = renderHook(() => useTabIdentity('/channels?profile=agent-1'), { wrapper });
    expect(result.current.primary).toBe('Profile');
    await waitFor(() =>
      expect(result.current).toMatchObject({ primary: 'Scout', secondary: 'Profile' })
    );
  });

  it('wears the badge a page reports for its own tab', () => {
    act(() =>
      useTabSignalsStore.getState().setRouteBadge('/tasks', { status: 'failed', count: 1 })
    );
    const { result } = renderHook(() => useTabIdentity('/tasks'), { wrapper });
    expect(result.current).toMatchObject({ primary: 'Schedules', status: 'failed', count: 1 });
    act(() => useTabSignalsStore.getState().setRouteBadge('/tasks', null));
    expect(result.current.status).toBeUndefined();
  });

  it('wears the badge an extension page sets for itself', () => {
    useExtensionRegistry.setState({ slots: createInitialSlots(), pageBadges: {} });
    const unregister = useExtensionRegistry.getState().register('pages', {
      id: 'flow:',
      extensionId: 'flow',
      path: '',
      component: () => null,
      title: 'Flow',
      menu: true,
    });
    act(() =>
      useExtensionRegistry
        .getState()
        .setPageBadge('flow:', { status: 'needs-you', count: 2, sentence: '2 ideas wait for you' })
    );
    const { result } = renderHook(() => useTabIdentity('/x/flow'), { wrapper });
    expect(result.current).toMatchObject({
      primary: 'Flow',
      status: 'needs-you',
      count: 2,
      accessibleName: 'Flow, Needs you: 2 ideas wait for you',
    });
    // Gone with its page: a badge never outlives what it was set on.
    act(() => unregister());
    expect(result.current).toMatchObject({ primary: 'Add-on', status: undefined });
  });

  describe('a room (DOR-3593)', () => {
    /** One channel the viewer is in, with this much unread. */
    function channelRoom(unreadCount: number, mentionCount?: number) {
      vi.mocked(transport.getRoom).mockResolvedValue({
        id: 'r1',
        kind: 'channel',
        slug: 'general',
        title: 'general',
      } as never);
      vi.mocked(transport.listRooms).mockResolvedValue([
        {
          id: 'r1',
          kind: 'channel',
          slug: 'general',
          title: 'general',
          unreadCount,
          participants: null,
          ...(mentionCount === undefined ? {} : { mentionCount }),
        },
      ] as never);
    }

    /** The sidebar prefs, with these rooms muted. */
    function mutedRooms(...roomIds: string[]) {
      vi.mocked(transport.getConfig).mockResolvedValue({
        ui: { sidebar: { muted: roomIds.map((roomId) => ({ kind: 'room', roomId })) } },
      } as never);
    }

    it('is bold with no number for a busy channel, and counts only mentions', async () => {
      mutedRooms();
      channelRoom(40);
      const { result } = renderHook(() => useTabIdentity('/channels?id=r1'), { wrapper });
      await waitFor(() => expect(result.current.emphasized).toBe(true));
      expect(result.current.count).toBeUndefined();

      channelRoom(40, 2);
      const { result: mentioned } = renderHook(() => useTabIdentity('/channels?id=r1'), {
        wrapper,
      });
      await waitFor(() => expect(mentioned.current.count).toBe(2));
      expect(mentioned.current.countTone).toBe('you');
    });

    it('goes quiet when the room is muted, but a mention still counts', async () => {
      mutedRooms('r1');
      channelRoom(40);
      const { result } = renderHook(() => useTabIdentity('/channels?id=r1'), { wrapper });
      await waitFor(() => expect(result.current.primary).toMatch(/general/));
      await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
      await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
      // Let both answers land: a muted room must still be quiet once they have.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(result.current.emphasized).toBeUndefined();
      expect(result.current.count).toBeUndefined();

      channelRoom(40, 1);
      const { result: mentioned } = renderHook(() => useTabIdentity('/channels?id=r1'), {
        wrapper,
      });
      await waitFor(() => expect(mentioned.current.count).toBe(1));
      expect(mentioned.current.accessibleName).toMatch(/, 1 mention$/);
    });
  });

  it('names the Marketplace after what is open in it', () => {
    const { result } = renderHook(() => useTabIdentity('/marketplace?pkg=flow'), { wrapper });
    expect(result.current).toMatchObject({ primary: 'Marketplace', secondary: 'flow' });
  });
});
