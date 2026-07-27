// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { RoomRow } from '../ui/rooms/RoomRow';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function channel(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    parentId: null,
    slug: 'general',
    title: 'General',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

/** A one-to-one conversation with the agent living at `agentPath`. */
function oneToOne(agentPath: string): RoomSummary {
  const participants: AuthorRef[] = [
    { id: 'me', kind: 'human', displayName: 'You' },
    { id: 'a-ana', kind: 'agent', displayName: 'Ana', agentRef: agentAuthorRef(agentPath) },
  ];
  return channel({
    id: 'dm-1',
    kind: 'dm',
    slug: null,
    title: 'Ana',
    participants,
  });
}

const FLEET = [{ agentPath: '/repo/ana', displayName: 'Ana' }];

function renderRow(
  room: RoomSummary,
  opts: { transport?: Transport; onOpenAgentProfile?: (path: string) => void } = {}
) {
  const transport = opts.transport ?? createMockTransport();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const utils = render(
    <RoomRow
      room={room}
      isActive={false}
      onSelect={vi.fn()}
      agents={FLEET}
      onOpenAgentProfile={opts.onOpenAgentProfile ?? vi.fn()}
    />,
    { wrapper }
  );
  return { ...utils, transport };
}

/** Open the "…" affordance and return its menu. */
function openDropdown(name = '#general actions'): HTMLElement {
  fireEvent.pointerDown(screen.getByLabelText(name));
  return screen.getByRole('menu');
}

/** Right-click the row and return the resulting context menu. */
function openContextMenu(): HTMLElement {
  fireEvent.contextMenu(screen.getByRole('button', { name: '#general' }));
  return screen.getByRole('menu');
}

/** Every menu item's text, in order. */
function itemLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomRow menus', () => {
  it('renders the SAME items into the right-click menu and the "…" dropdown', () => {
    const { unmount } = renderRow(channel());
    const fromDropdown = itemLabels(openDropdown());
    unmount();

    renderRow(channel());
    expect(itemLabels(openContextMenu())).toEqual(fromDropdown);
  });

  it('writes the ellipsis onto exactly the items that open something', () => {
    renderRow(channel());
    expect(itemLabels(openDropdown())).toEqual([
      'Add agents…',
      'Members…',
      'Rename…',
      'Edit topic…',
      'Archive channel',
    ]);
  });

  it('offers Mark as read only while the reader is behind', () => {
    const { unmount } = renderRow(channel({ unreadCount: 0 }));
    expect(itemLabels(openDropdown())).not.toContain('Mark as read');
    unmount();

    renderRow(channel({ unreadCount: 3 }));
    expect(itemLabels(openDropdown())).toContain('Mark as read');
  });

  it('marks read by moving the cursor onto the newest entry, not past it', async () => {
    const transport = createMockTransport({
      listRoomEntries: vi.fn().mockResolvedValue([
        {
          roomId: 'room-1',
          seq: 42,
          id: 'entry-42',
          authorId: 'a',
          kind: 'post',
          body: { text: 'hi' },
          mentions: [],
          sessionId: null,
          cascadeRoot: 'entry-42',
          cascadeDepth: 0,
          signature: null,
          createdAt: '2026-07-26T10:00:00.000Z',
        },
      ]),
    });
    renderRow(channel({ unreadCount: 3 }), { transport });

    fireEvent.click(within(openDropdown()).getByText('Mark as read'));

    await waitFor(() => expect(transport.setRoomReadCursor).toHaveBeenCalledWith('room-1', 42));
  });

  it('jumps to the agent a one-to-one is with, matched on its directory handle', () => {
    const onOpenAgentProfile = vi.fn();
    renderRow(oneToOne('/repo/ana'), { onOpenAgentProfile });

    const menu = openDropdown('Ana actions');
    fireEvent.click(within(menu).getByText('Agent profile'));

    expect(onOpenAgentProfile).toHaveBeenCalledWith('/repo/ana');
  });

  it('offers no Agent profile for an agent the fleet no longer knows', () => {
    // A mesh rebuild can retire an agent under an open sidebar. Nothing should
    // offer a profile it cannot resolve to a directory.
    renderRow(oneToOne('/repo/departed'));
    expect(itemLabels(openDropdown('Ana actions'))).not.toContain('Agent profile');
  });
});

describe('RoomRow rename', () => {
  it('opens an inline editor seeded with the title behind the #slug', () => {
    renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    expect(screen.getByRole('textbox', { name: 'Rename #general' })).toHaveValue('General');
  });

  it('writes the new name through the Transport port on Enter', async () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { title: 'Backend' })
    );
  });

  it('writes nothing on Escape, and puts the row back', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(transport.updateRoom).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#general' })).toBeInTheDocument();
  });

  it('writes nothing when the name comes back unchanged or empty', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename #general' }), { key: 'Enter' });
    expect(transport.updateRoom).not.toHaveBeenCalled();

    fireEvent.click(within(openDropdown()).getByText('Rename…'));
    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(transport.updateRoom).not.toHaveBeenCalled();
  });
});

describe('RoomRow archive', () => {
  it('archives nothing until the confirmation is accepted', async () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Archive channel'));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Archive #general?');
    expect(transport.updateRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: true })
    );
  });

  it('leaves the room alone when the confirmation is refused', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Archive channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(transport.updateRoom).not.toHaveBeenCalled();
  });
});
