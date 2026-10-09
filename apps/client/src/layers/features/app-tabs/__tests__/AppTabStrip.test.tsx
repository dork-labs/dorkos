/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { AppTab } from '@/layers/shared/model';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';

const agentByPath = vi.fn<(cwd: string | null) => AgentManifest | null>(() => null);
const roomById = vi.fn<(roomId: string | null) => RoomWithRoster | null>(() => null);

vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  // The real hook is a query; pinning it keeps the label assertions about the
  // strip rather than about fetch timing.
  useCurrentAgent: (cwd: string | null) => ({ data: agentByPath(cwd) }),
}));

vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  // Same reasoning as the agent mock above: pin the room query so the label
  // assertions are about the strip, not about fetch timing.
  useRoom: (roomId: string | null) => ({ data: roomById(roomId) }),
}));

const communityRoom = vi.fn<(ref: string, roomId: string, fingerprint: string) => unknown>(
  () => undefined
);
/** The listed connection's access; `null` lists no connection at all. */
let connectionAccess: unknown = null;
vi.mock('@/layers/entities/community', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/community')>()),
  useCommunityConnections: () => ({
    data: connectionAccess === null ? [] : [{ ref: 'alpha', access: connectionAccess }],
  }),
  // Enabled and keyed the way the real query is: a disabled read has no data.
  useRemoteCommunityRoom: (ref: string, roomId: string, enabled: boolean, fingerprint: string) => ({
    data: enabled ? communityRoom(ref, roomId, fingerprint) : undefined,
  }),
}));

const readable = { read: true, post: true, enrollAgent: true, stream: true };
const nothing = { read: false, post: false, enrollAgent: false, stream: false };

import { communityAccessState } from '@/layers/entities/community';
import { setSessionRouteContext, useSessionListStore } from '@/layers/entities/session';
import { AppTabStrip } from '../ui/AppTabStrip';
import { APP_TAB_PANEL_ID } from '../ui/AppTabItem';

const transport = createMockTransport();

/** A minimal channel room, enough for {@link roomDisplayTitle} to name it. */
function channelRoom(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: 'general',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-10T09:00:00.000Z',
    lastActivityAt: '2026-08-10T09:00:00.000Z',
    reactionFrequents: [],
    viewerAuthorId: 'author-you',
    members: [],
    ...overrides,
  } as RoomWithRoster;
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const onActivate = vi.fn();
const onClose = vi.fn();
const onCreate = vi.fn();

function renderStrip(tabs: AppTab[], activeId: string | null = tabs[0]?.id ?? null) {
  return render(
    <AppTabStrip
      tabs={tabs}
      activeId={activeId}
      onActivate={onActivate}
      onClose={onClose}
      onCreate={onCreate}
    />,
    { wrapper: Wrapper }
  );
}

/** A tab with nothing behind it — the strip reads only `id` and `href`. */
function tab(id: string, href: string): AppTab {
  return { id, href, history: [href], cursor: 0 };
}

const DASHBOARD: AppTab = tab('t1', '/');
const API_SESSION: AppTab = tab('t2', '/session?session=abc&dir=%2FUsers%2Fkai%2Fapi');
const AGENTS: AppTab = tab('t3', '/team');
const GENERAL_CHANNEL: AppTab = tab('t4', '/channels?id=room-1');

beforeEach(() => {
  vi.clearAllMocks();
  agentByPath.mockReturnValue(null);
  roomById.mockReturnValue(null);
  communityRoom.mockReset().mockReturnValue(undefined);
  connectionAccess = null;
});

afterEach(cleanup);

describe('AppTabStrip', () => {
  it('names each tab after its route, and a chat tab after its project', () => {
    renderStrip([DASHBOARD, API_SESSION]);
    expect(screen.getByRole('tab', { name: /Home/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /api/ })).toBeInTheDocument();
  });

  it('prefers the agent that lives in the project over the folder name', () => {
    agentByPath.mockImplementation((cwd) =>
      cwd === '/Users/kai/api'
        ? ({ id: 'scout', displayName: 'Scout', icon: '\u{1F50D}' } as AgentManifest)
        : null
    );
    renderStrip([API_SESSION]);
    expect(screen.getByRole('tab', { name: /Scout/ })).toBeInTheDocument();
  });

  // The href the app really writes: since #2682 a chat URL carries no `dir`.
  // Every earlier test used `&dir=`, so they passed while every real chat tab
  // read "Session" with a generic icon (DOR-2820).
  describe('a chat tab on the real dir-less href', () => {
    const scout = { id: 'scout', displayName: 'Scout', icon: '\u{1F50D}' } as AgentManifest;
    beforeEach(() => {
      agentByPath.mockImplementation((cwd) => (cwd === '/Users/kai/api' ? scout : null));
    });

    it('names the agent and the chat title from the chat row the server resolves', async () => {
      vi.mocked(transport.getSession).mockResolvedValue({
        id: 'dirless-1',
        cwd: '/Users/kai/api',
        title: 'Fix the login bug',
      } as Awaited<ReturnType<typeof transport.getSession>>);
      renderStrip([tab('t9', '/session?session=dirless-1')]);
      const chat = await screen.findByRole('tab', { name: /Scout/ });
      expect(chat).toHaveTextContent('Scout · Fix the login bug');
      expect(chat).not.toHaveTextContent('Session');
      expect(transport.getSession).toHaveBeenCalledWith('dirless-1', undefined);
    });

    it('names the agent from the route context the loader installed, before any fetch lands', () => {
      vi.mocked(transport.getSession).mockReturnValue(new Promise(() => {}));
      setSessionRouteContext('dirless-2', { cwd: '/Users/kai/api', draft: false });
      renderStrip([tab('t9', '/session?session=dirless-2')]);
      expect(screen.getByRole('tab', { name: /Scout/ })).toBeInTheDocument();
    });

    it('says "Chat", never "Session", while nothing about the chat is known yet', () => {
      vi.mocked(transport.getSession).mockReturnValue(new Promise(() => {}));
      renderStrip([tab('t9', '/session?session=dirless-3')]);
      expect(screen.getByRole('tab', { name: /^Chat/ })).toBeInTheDocument();
    });

    it('does not ask the server for a draft that has no row yet', () => {
      setSessionRouteContext('draft-1', { cwd: '/Users/kai/api', draft: true });
      renderStrip([tab('t9', '/session?session=draft-1')]);
      expect(screen.getByRole('tab', { name: /Scout/ })).toBeInTheDocument();
      expect(transport.getSession).not.toHaveBeenCalled();
    });
  });

  it('trusts the route context over a stale ?dir= and the row, as useDirectoryState does', () => {
    agentByPath.mockImplementation((cwd) =>
      cwd === '/Users/kai/api'
        ? ({ id: 'scout', displayName: 'Scout' } as AgentManifest)
        : cwd === '/Users/kai/web'
          ? ({ id: 'pixel', displayName: 'Pixel' } as AgentManifest)
          : null
    );
    vi.mocked(transport.getSession).mockResolvedValue({
      id: 'moved-1',
      cwd: '/Users/kai/web',
      title: 'x',
    } as Awaited<ReturnType<typeof transport.getSession>>);
    setSessionRouteContext('moved-1', { cwd: '/Users/kai/api', draft: false });
    renderStrip([tab('t9', '/session?session=moved-1&dir=%2FUsers%2Fkai%2Fweb')]);
    expect(screen.getByRole('tab', { name: /Scout/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Pixel/ })).toBeNull();
  });

  it('does not ask the server for a restored draft tab, whose route context died with the reload', () => {
    renderStrip([tab('t9', '/session?session=draft-2&draft=1')]);
    expect(transport.getSession).not.toHaveBeenCalled();
  });

  it('names a channel tab "#slug" once the room resolves', () => {
    roomById.mockImplementation((roomId) => (roomId === 'room-1' ? channelRoom() : null));
    renderStrip([GENERAL_CHANNEL]);
    expect(screen.getByRole('tab', { name: /#general/ })).toBeInTheDocument();
  });

  it('names a community channel tab from that community, never the local rooms', () => {
    // A community room id is not a local room id. Asking the local rooms route
    // for it answered 404 twice and left the tab reading "Channels".
    connectionAccess = {
      state: 'verified',
      effective: readable,
      lastKnown: {
        lifecycle: 'active',
        capabilities: readable,
        verifiedAt: '2026-09-23T00:00:00Z',
      },
    };
    communityRoom.mockImplementation((ref, roomId) =>
      ref === 'alpha' && roomId === 'general'
        ? { kind: 'channel', slug: 'general', title: 'General' }
        : undefined
    );
    renderStrip([tab('t9', '/channels?community=alpha&id=general')]);
    expect(screen.getByRole('tab', { name: /#general/ })).toBeInTheDocument();
    expect(roomById).not.toHaveBeenCalledWith('general');
    // The same cache key the channel bar reads: keyed by the access fingerprint.
    expect(communityRoom).toHaveBeenCalledWith(
      'alpha',
      'general',
      communityAccessState(connectionAccess as never).fingerprint
    );
  });

  it('drops a community channel tab title once that community revokes read access', () => {
    connectionAccess = { state: 'reconnect-required', effective: nothing, lastKnown: null };
    communityRoom.mockImplementation(() => ({
      kind: 'channel',
      slug: 'general',
      title: 'General',
    }));
    renderStrip([tab('t9', '/channels?community=alpha&id=general')]);
    expect(screen.queryByRole('tab', { name: /#general/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Channels/ })).toBeInTheDocument();
  });

  it('names a DM channel tab after its title, with no # mark', () => {
    roomById.mockImplementation((roomId) =>
      roomId === 'room-1' ? channelRoom({ kind: 'dm', slug: null, title: 'Scout' }) : null
    );
    renderStrip([GENERAL_CHANNEL]);
    expect(screen.getByRole('tab', { name: 'Scout' })).toBeInTheDocument();
  });

  it('falls back to the route label before the room resolves, not a flash of "DorkOS"', () => {
    renderStrip([GENERAL_CHANNEL]);
    expect(screen.getByRole('tab', { name: /Channels/ })).toBeInTheDocument();
  });

  it('marks the active tab and points it at the content region', () => {
    renderStrip([DASHBOARD, AGENTS], AGENTS.id);
    const active = screen.getByRole('tab', { name: /Team/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('aria-controls', APP_TAB_PANEL_ID);
    const other = screen.getByRole('tab', { name: /Home/ });
    expect(other).toHaveAttribute('aria-selected', 'false');
    expect(other).not.toHaveAttribute('aria-controls');
  });

  it('activates a clicked tab', () => {
    renderStrip([DASHBOARD, AGENTS]);
    fireEvent.click(screen.getByRole('tab', { name: /Team/ }));
    expect(onActivate).toHaveBeenCalledWith(AGENTS.id, 'pointer');
  });

  it('opens another tab from the + button', () => {
    renderStrip([DASHBOARD]);
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('offers no close control on the last tab', () => {
    renderStrip([DASHBOARD]);
    expect(screen.queryByRole('button', { name: /^Close/ })).not.toBeInTheDocument();
  });

  it('closes a tab from its close control once there is more than one', () => {
    renderStrip([DASHBOARD, AGENTS]);
    fireEvent.click(screen.getByRole('button', { name: 'Close Team' }));
    expect(onClose).toHaveBeenCalledWith(AGENTS.id, 'pointer');
  });

  it('is one Tab stop: arrows move and switch, keyboard-source', () => {
    renderStrip([DASHBOARD, AGENTS]);
    const active = screen.getByRole('tab', { name: /Home/ });
    expect(active).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Team/ })).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith(AGENTS.id, 'keyboard');
  });

  it('closes the focused tab with Delete', () => {
    renderStrip([DASHBOARD, AGENTS]);
    fireEvent.keyDown(screen.getByRole('tab', { name: /Home/ }), { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith(DASHBOARD.id, 'keyboard');
  });

  it('advertises no Delete shortcut when the last tab cannot be closed', () => {
    renderStrip([DASHBOARD]);
    const only = screen.getByRole('tab', { name: /Home/ });
    expect(only).not.toHaveAttribute('aria-keyshortcuts');
    fireEvent.keyDown(only, { key: 'Delete' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a live badge on a chat tab only when it wants attention', () => {
    renderStrip([API_SESSION]);
    const tab = screen.getByRole('tab', { name: /api/ });
    // Nothing is streaming or blocked in a fresh store — an idle tab stays quiet.
    expect(within(tab).queryByText(/Working|approval|Error|New activity/)).not.toBeInTheDocument();
  });

  describe('smart names (DOR-2820)', () => {
    const scout = { id: 'scout', displayName: 'Scout', icon: '\u{1F50D}' } as AgentManifest;
    beforeEach(() => {
      agentByPath.mockImplementation((cwd) => (cwd === '/Users/kai/api' ? scout : null));
      vi.mocked(transport.getSession).mockImplementation(
        async (id) =>
          ({
            id,
            cwd: '/Users/kai/api',
            title: id === 'c1' ? 'Fix the login bug' : 'Write the docs',
            updatedAt: '2026-10-09T09:00:00.000Z',
          }) as Awaited<ReturnType<typeof transport.getSession>>
      );
    });

    it('leads with the chat title when two tabs share an agent, and keeps the full name for screen readers', async () => {
      renderStrip([tab('a', '/session?session=c1'), tab('b', '/session?session=c2')]);
      const first = await screen.findByRole('tab', { name: 'Scout, Fix the login bug' });
      await waitFor(() => expect(first).toHaveTextContent(/^\S*Fix the login bug$/u));
      expect(first).not.toHaveTextContent('Scout');
    });

    it('leads with the agent when it is the only tab with it', async () => {
      renderStrip([tab('a', '/session?session=c1'), DASHBOARD]);
      const chat = await screen.findByRole('tab', { name: 'Scout, Fix the login bug' });
      expect(chat).toHaveTextContent('Scout · Fix the login bug');
    });
  });

  it('names a working chat’s status in its accessible name', () => {
    setSessionRouteContext('busy-1', { cwd: '/Users/kai/api', draft: false });
    vi.mocked(transport.getSession).mockReturnValue(new Promise(() => {}));
    useSessionListStore.setState({
      statuses: { 'busy-1': { lifecycle: 'streaming', limit: null } as never },
    });
    renderStrip([tab('t9', '/session?session=busy-1')]);
    expect(screen.getByRole('tab', { name: 'api, Working' })).toBeInTheDocument();
    useSessionListStore.setState({ statuses: {} });
  });

  it('groups every tab under one labelled tablist', () => {
    renderStrip([DASHBOARD, API_SESSION, AGENTS]);
    expect(
      within(screen.getByRole('tablist', { name: 'Open tabs' })).getAllByRole('tab')
    ).toHaveLength(3);
  });
});
