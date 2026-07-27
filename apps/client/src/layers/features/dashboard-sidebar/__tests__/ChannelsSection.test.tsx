// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChannelsSection } from '../ui/rooms/ChannelsSection';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdate = vi.fn<(updater: (prev: { channelsCollapsed: boolean }) => unknown) => void>();
let mockCollapsed = false;

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ channelsCollapsed: mockCollapsed }),
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  setChannelsCollapsed: (prev: object, collapsed: boolean) => ({
    ...prev,
    channelsCollapsed: collapsed,
  }),
}));

const mockCreate = vi.fn();
vi.mock('@/layers/entities/room', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/entities/room')>('@/layers/entities/room');
  return { ...actual, useCreateChannel: () => ({ mutate: mockCreate }) };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function channel(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    parentId: null,
    slug: 'general',
    title: '#general',
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

function renderSection(overrides: Partial<Parameters<typeof ChannelsSection>[0]> = {}) {
  return render(
    <ChannelsSection
      channels={[]}
      isLoading={false}
      error={null}
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
  mockCreate.mockClear();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelsSection', () => {
  it('offers a real empty state rather than a blank gap', () => {
    renderSection();
    expect(screen.getByText(/No channels yet/i)).toBeInTheDocument();
  });

  it('renders each channel by its #slug', () => {
    renderSection({ channels: [channel(), channel({ id: 'room-2', slug: 'backend' })] });
    expect(screen.getByText('#general')).toBeInTheDocument();
    expect(screen.getByText('#backend')).toBeInTheDocument();
  });

  it('shows skeletons, not an empty state, while the first list loads', () => {
    renderSection({ isLoading: true });
    expect(screen.queryByText(/No channels yet/i)).not.toBeInTheDocument();
  });

  it('says so when the list could not be read', () => {
    renderSection({ error: new Error('offline') });
    expect(screen.getByText(/Couldn't load your channels/i)).toBeInTheDocument();
  });

  it('badges a room with unread entries and leaves a non-member unbadged', () => {
    renderSection({
      channels: [
        channel({ id: 'a', slug: 'unread', unreadCount: 3 }),
        channel({ id: 'b', slug: 'caught-up', unreadCount: 0 }),
        channel({ id: 'c', slug: 'not-a-member', unreadCount: null }),
      ],
    });
    expect(screen.getByLabelText('3 unread in #unread')).toHaveTextContent('3');
    // 0 means "in it and caught up"; null means "not in it". Neither is a badge.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('opens the room a row names', () => {
    const onSelectRoom = vi.fn();
    const room = channel();
    renderSection({ channels: [room], onSelectRoom });
    fireEvent.click(screen.getByText('#general'));
    expect(onSelectRoom).toHaveBeenCalledWith(room);
  });

  it('persists the collapse toggle', () => {
    renderSection({ channels: [channel()] });
    fireEvent.click(screen.getByRole('button', { name: /channels/i }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]![0]({ channelsCollapsed: false })).toEqual({
      channelsCollapsed: true,
    });
  });

  it('hides its rows when collapsed but keeps the header reachable', () => {
    mockCollapsed = true;
    renderSection({ channels: [channel()] });
    expect(screen.queryByText('#general')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /channels/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('creates a channel from the inline input', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    const input = screen.getByLabelText('New channel name');
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockCreate).toHaveBeenCalledWith('Backend', expect.anything());
  });

  it('never creates a channel from a blank name', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    const input = screen.getByLabelText('New channel name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
