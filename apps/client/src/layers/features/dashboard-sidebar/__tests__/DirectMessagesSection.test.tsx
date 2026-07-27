// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomSummary } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import { DirectMessagesSection } from '../ui/rooms/DirectMessagesSection';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdate = vi.fn<(updater: (prev: { dmsCollapsed: boolean }) => unknown) => void>();
let mockCollapsed = false;

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ dmsCollapsed: mockCollapsed }),
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  setDmsCollapsed: (prev: object, collapsed: boolean) => ({ ...prev, dmsCollapsed: collapsed }),
}));

const mockStart = vi.fn();

vi.mock('@/layers/entities/room', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/entities/room')>('@/layers/entities/room');
  return {
    ...actual,
    useStartDirectMessage: () => ({ mutate: mockStart }),
  };
});

/**
 * The roster the list carries for a DM whose join succeeded: the human plus the
 * agent living at `agentPath`. The agent carries the same `agentRef` the server
 * derives from that directory, which is what the menu matches on.
 */
function rosterWithAgent(agentPath: string, displayName = 'Ana'): AuthorRef[] {
  return [
    { id: 'me', kind: 'human', displayName: 'You' },
    {
      id: `a-${displayName}`,
      kind: 'agent',
      displayName,
      emoji: '🐙',
      agentRef: agentAuthorRef(agentPath),
    },
  ];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dm(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'dm-1',
    kind: 'dm',
    parentId: null,
    slug: null,
    title: 'Ana',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: [],
    ...overrides,
  };
}

function renderSection(overrides: Partial<Parameters<typeof DirectMessagesSection>[0]> = {}) {
  return render(
    <DirectMessagesSection
      dms={[]}
      isLoading={false}
      error={null}
      displayNames={{}}
      activeRoomId={null}
      onSelectRoom={vi.fn()}
      {...overrides}
    />,
    { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
  );
}

beforeEach(() => {
  mockCollapsed = false;
  mockUpdate.mockClear();
  mockStart.mockClear();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DirectMessagesSection', () => {
  it('offers a real empty state rather than a blank gap', () => {
    renderSection();
    expect(screen.getByText(/No messages yet/i)).toBeInTheDocument();
  });

  it('renders one row per conversation, named after the agent', () => {
    renderSection({ dms: [dm(), dm({ id: 'dm-2', title: 'Bo' })] });
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
  });

  it("marks a conversation with the agent's own avatar, not a letter", () => {
    renderSection({ dms: [dm({ id: 'dm-1', participants: rosterWithAgent('/repo/ana') })] });
    expect(screen.getByText('🐙')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it("falls back to the room's initial when the list carries no agent", () => {
    renderSection({ dms: [dm({ id: 'dm-1', title: 'Ana', participants: [] })] });
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('says so when the list could not be read', () => {
    renderSection({ error: new Error('offline') });
    expect(screen.getByText(/Couldn't load your messages/i)).toBeInTheDocument();
  });

  it('persists the collapse toggle', () => {
    renderSection({ dms: [dm()] });
    fireEvent.click(screen.getByRole('button', { name: /direct messages/i }));
    expect(mockUpdate.mock.calls[0]![0]({ dmsCollapsed: false })).toEqual({ dmsCollapsed: true });
  });

  it('tells the person to add an agent first when the roster is empty, not that every agent is taken', () => {
    renderSection({ displayNames: {} });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    expect(screen.getByText(/have not added any agents yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/already have a conversation/i)).not.toBeInTheDocument();
  });

  it('starts a conversation with an agent that has none yet', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bo' }));
    expect(mockStart).toHaveBeenCalledWith(
      { agentPath: '/repo/bo', title: 'Bo' },
      expect.anything()
    );
  });

  it('leaves out agents already on a conversation roster', () => {
    renderSection({
      dms: [dm({ id: 'dm-1', participants: rosterWithAgent('/repo/ana') })],
      displayNames: { '/repo/ana': 'Ana' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    expect(screen.getByText(/already have a conversation with every agent/i)).toBeInTheDocument();
  });

  it('does not strand an agent behind a conversation its join never completed', () => {
    // The room exists and is titled after the agent, but the second call failed
    // so the roster holds only the human. Filtering on the title would hide this
    // agent from the menu for good, with no way in this release to undo it.
    renderSection({
      dms: [
        dm({
          id: 'dm-1',
          title: 'Ana',
          participants: [{ id: 'me', kind: 'human', displayName: 'You' }],
        }),
      ],
      displayNames: { '/repo/ana': 'Ana' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    // Scoped to the menu: the orphan DM's own row is also a button named "Ana".
    fireEvent.click(screen.getByTestId('dm-candidate'));
    expect(mockStart).toHaveBeenCalledWith(
      { agentPath: '/repo/ana', title: 'Ana' },
      expect.anything()
    );
  });

  it('ignores a renamed room title and believes the roster', () => {
    // A room's title is editable; who is in it is not. The agent is on the
    // roster, so it stays out of the menu whatever the room ended up called.
    renderSection({
      dms: [
        dm({ id: 'dm-1', title: 'Renamed by hand', participants: rosterWithAgent('/repo/ana') }),
      ],
      displayNames: { '/repo/ana': 'Ana' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    expect(screen.getByText(/already have a conversation with every agent/i)).toBeInTheDocument();
  });

  it('matches on the directory, not on any rendered name', () => {
    // Two agents both named "Ana" render as "Ana (alpha)" / "Ana (beta)". Only
    // the one you already have a conversation with leaves the menu; matching on
    // the name would have hidden both.
    renderSection({
      dms: [dm({ id: 'dm-1', participants: rosterWithAgent('/repo/alpha/ana') })],
      displayNames: { '/repo/alpha/ana': 'Ana (alpha)', '/repo/beta/ana': 'Ana (beta)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));

    const offered = screen.getAllByTestId('dm-candidate').map((el) => el.textContent);
    expect(offered).toEqual(['Ana (beta)']);
  });
});
