// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { ChannelsSection } from '../ui/rooms/ChannelsSection';

/**
 * The fleet the create dialog reads for itself. Mocked at the hook, because the
 * dialog fetches it rather than taking it from this section — see the module
 * doc on `features/room-management`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('@/layers/features/room-management/model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

/** A fleet that has been read successfully. The state is named, never defaulted. */
function settled(candidates: { agentPath: string; displayName: string }[] = []) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdate = vi.fn<(updater: (prev: { channelsCollapsed: boolean }) => unknown) => void>();
let mockCollapsed = false;

// Partial-over-actual, NOT a hand-written barrel. Every row this section draws
// reads its own organization state out of the same module (`muted`, `groups`),
// and a stub listing only the keys the SECTION happens to use crashed the row
// the moment it started reading one more (rooms-in-groups, DOR-581). Only the
// two hooks that must be observable are replaced; the pure helpers stay real.
vi.mock('@/layers/entities/config', async () => {
  const actual = await vi.importActual<typeof import('@/layers/entities/config')>(
    '@/layers/entities/config'
  );
  return {
    ...actual,
    useSidebarPrefs: () => ({ ...SIDEBAR_PREFS_DEFAULTS, channelsCollapsed: mockCollapsed }),
    useUpdateSidebarPrefs: () => ({
      update: mockUpdate,
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
  };
});

// The create call now belongs to `ChannelCreateDialog`, which this section
// mounts — so the mock stays where it was and the assertion moves through one
// more component, which is exactly the seam worth covering here.
const mockCreate = vi.fn();
vi.mock('@/layers/entities/room', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/entities/room')>('@/layers/entities/room');
  return { ...actual, useCreateChannel: () => ({ mutate: mockCreate, isPending: false }) };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function channel(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

/**
 * The providers a room row needs: rows read and write through the Transport
 * port, and their tooltips need a provider. Every read on the mock answers
 * empty, so nothing here reaches a network.
 */
function roomsWrapper(transport: ReturnType<typeof createMockTransport> = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderSection(
  overrides: Partial<Parameters<typeof ChannelsSection>[0]> = {},
  transport?: ReturnType<typeof createMockTransport>
) {
  return render(
    <ChannelsSection
      channels={[]}
      hasGroupedChannels={false}
      unreadChannelIds={[]}
      visualOf={() => ({ kind: 'sigil' })}
      isLoading={false}
      error={null}
      activeRoomId={null}
      onSelectRoom={vi.fn()}
      onOpenAgentProfile={vi.fn()}
      onRequestNewGroup={vi.fn()}
      {...overrides}
    />,
    { wrapper: roomsWrapper(transport) }
  );
}

/** Open the header's "…" menu — Radix opens on pointerdown, not on click. */
function openHeaderMenu(): HTMLElement {
  fireEvent.pointerDown(screen.getByLabelText('Channels section actions'));
  return screen.getByRole('menu');
}

beforeEach(() => {
  mockRosterRef.current = settled();
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

  it('writes each channel name once, beside the mark that supplies its #', () => {
    renderSection({ channels: [channel(), channel({ id: 'room-2', slug: 'backend' })] });

    // A row is `#` (a glyph) then `general` — never `# #general`. Asserting the
    // row merely *contains* `#general` would pass on the doubled version too,
    // so the two halves are named apart: what the row draws, and what it says.
    const general = screen.getByRole('button', { name: '#general' });
    expect(general.querySelector('svg.lucide-hash')).not.toBeNull();
    expect(within(general).getByText('general')).toHaveAttribute('aria-hidden', 'true');
    expect(within(general).getByText('#general')).toHaveClass('sr-only');

    expect(screen.getByRole('button', { name: '#backend' })).toBeInTheDocument();
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
    expect(screen.getByLabelText('3 unread')).toHaveTextContent('3');
    // 0 means "in it and caught up"; null means "not in it". Neither is a badge.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('names an UNREAD row once too — the badge does not repeat the room', () => {
    // The read row was already asserted above, which is why the doubled name on
    // this one went unseen: the badge's own label used to end "in #general", so
    // the row read "#general 3 unread in #general" — the same defect as the
    // doubled `#`, one element further along.
    renderSection({ channels: [channel({ unreadCount: 3 })] });

    // How an accessible name's parts are joined is the environment's call —
    // jsdom loads no CSS, so it never blockifies the flex children a browser
    // does, and inserts no separator. So this asserts the parts, not the joins.
    let observed = '';
    screen.getByRole('button', {
      name: (accessibleName: string) => {
        if (!accessibleName.includes('unread')) return false;
        observed = accessibleName;
        return true;
      },
    });

    expect(observed).toMatch(/3 unread/);
    expect(observed.match(/#general/g)).toHaveLength(1);
  });

  it('opens the room a row names', () => {
    const onSelectRoom = vi.fn();
    const room = channel();
    renderSection({ channels: [room], onSelectRoom });
    fireEvent.click(screen.getByRole('button', { name: '#general' }));
    expect(onSelectRoom).toHaveBeenCalledWith(room);
  });

  it('persists the collapse toggle', () => {
    renderSection({ channels: [channel()] });
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]![0]({ channelsCollapsed: false })).toEqual({
      channelsCollapsed: true,
    });
  });

  it('hides its rows when collapsed but keeps the header reachable', () => {
    mockCollapsed = true;
    renderSection({ channels: [channel()] });
    expect(screen.queryByRole('button', { name: '#general' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Channels' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('asks for the agents as well as the name, in one pass', () => {
    // The whole point of DOR-599: the "+" no longer drops an inline name field
    // that can only ever make an empty channel. It opens the dialog that asks
    // both questions, with the fleet in it.
    mockRosterRef.current = settled([{ agentPath: '/w/ana', displayName: 'Ana' }]);
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Channel name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Search agents')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Channel name'), {
      target: { value: 'Backend' },
    });
    fireEvent.change(within(dialog).getByLabelText('Search agents'), { target: { value: 'Ana' } });
    fireEvent.click(within(dialog).getByRole('option', { name: 'Ana' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel with 1 agent' }));

    expect(mockCreate).toHaveBeenCalledWith(
      { title: 'Backend', agentPaths: ['/w/ana'] },
      expect.anything()
    );
  });

  it('keeps the empty-state row visible behind the dialog', () => {
    // The inline input REPLACED this line; a modal sits over it. A person who
    // opened the dialog by mistake should still see where they were.
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByText(/No channels yet/i)).toBeInTheDocument();
  });

  it('opens the same create dialog from the header menu as from the "+"', () => {
    mockRosterRef.current = settled([{ agentPath: '/w/ana', displayName: 'Ana' }]);
    renderSection();

    fireEvent.click(within(openHeaderMenu()).getByText('New channel…'));

    expect(within(screen.getByRole('dialog')).getByLabelText('Channel name')).toBeInTheDocument();
  });

  it('collapses the section from the header menu', () => {
    renderSection({ channels: [channel()] });

    fireEvent.click(within(openHeaderMenu()).getByText('Collapse'));

    expect(mockUpdate.mock.calls[0]![0]({ channelsCollapsed: false })).toEqual({
      channelsCollapsed: true,
    });
  });

  it('marks every unread channel read, including the ones filed into groups', async () => {
    // The list handed in is the whole kind, not this section's rows — "Mark all
    // channels read" that quietly skipped grouped channels would leave badges
    // behind on rooms the person just told it to clear.
    const transport = createMockTransport({
      listRoomEntries: vi
        .fn()
        .mockImplementation((roomId: string) => Promise.resolve([{ roomId, seq: 7 }])),
    });
    renderSection(
      { channels: [channel({ unreadCount: 3 })], unreadChannelIds: ['room-1', 'room-9'] },
      transport
    );

    fireEvent.click(within(openHeaderMenu()).getByText('Mark all channels read'));

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 7));
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-9', 7);
  });

  it('withholds Mark all channels read when nothing is behind', () => {
    renderSection({ channels: [channel()] });

    expect(within(openHeaderMenu()).queryByText('Mark all channels read')).not.toBeInTheDocument();
  });
});
