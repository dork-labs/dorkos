// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
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
  return { ...actual, useStartDirectMessage: () => ({ mutate: mockStart }) };
});

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

  it('says so when the list could not be read', () => {
    renderSection({ error: new Error('offline') });
    expect(screen.getByText(/Couldn't load your messages/i)).toBeInTheDocument();
  });

  it('persists the collapse toggle', () => {
    renderSection({ dms: [dm()] });
    fireEvent.click(screen.getByRole('button', { name: /direct messages/i }));
    expect(mockUpdate.mock.calls[0]![0]({ dmsCollapsed: false })).toEqual({ dmsCollapsed: true });
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

  it('leaves out agents you already have a conversation with', () => {
    renderSection({ dms: [dm({ title: 'Ana' })], displayNames: { '/repo/ana': 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
    expect(screen.getByText(/already have a conversation with every agent/i)).toBeInTheDocument();
  });
});
