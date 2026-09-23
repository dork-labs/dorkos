/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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

const communityRoom = vi.fn<(ref: string, roomId: string, enabled: boolean) => unknown>(
  () => undefined
);
vi.mock('@/layers/entities/community', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/community')>()),
  useRemoteCommunityRoom: (ref: string, roomId: string, enabled: boolean) => ({
    data: enabled ? communityRoom(ref, roomId, enabled) : undefined,
  }),
}));

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

const DASHBOARD: AppTab = { id: 't1', href: '/' };
const API_SESSION: AppTab = { id: 't2', href: '/session?session=abc&dir=%2FUsers%2Fkai%2Fapi' };
const AGENTS: AppTab = { id: 't3', href: '/team' };
const GENERAL_CHANNEL: AppTab = { id: 't4', href: '/channels?id=room-1' };

beforeEach(() => {
  vi.clearAllMocks();
  agentByPath.mockReturnValue(null);
  roomById.mockReturnValue(null);
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

  it('names a channel tab "#slug" once the room resolves', () => {
    roomById.mockImplementation((roomId) => (roomId === 'room-1' ? channelRoom() : null));
    renderStrip([GENERAL_CHANNEL]);
    expect(screen.getByRole('tab', { name: /#general/ })).toBeInTheDocument();
  });

  it('names a community channel tab from that community, never the local rooms', () => {
    // A community room id is not a local room id. Asking the local rooms route
    // for it answered 404 twice and left the tab reading "Channels".
    communityRoom.mockImplementation((ref, roomId) =>
      ref === 'alpha' && roomId === 'general'
        ? { kind: 'channel', slug: 'general', title: 'General' }
        : undefined
    );
    renderStrip([{ id: 't9', href: '/channels?community=alpha&id=general' }]);
    expect(screen.getByRole('tab', { name: /#general/ })).toBeInTheDocument();
    expect(roomById).not.toHaveBeenCalledWith('general');
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

  it('groups every tab under one labelled tablist', () => {
    renderStrip([DASHBOARD, API_SESSION, AGENTS]);
    expect(
      within(screen.getByRole('tablist', { name: 'Open tabs' })).getAllByRole('tab')
    ).toHaveLength(3);
  });
});
