// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  agentAuthorRef,
  type RoomRosterEntry,
  type RoomSummary,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { RoomMembersDialog } from '../ui/rooms/RoomMembersDialog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM: RoomSummary = {
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
};

function agentMember(
  displayName: string,
  agentPath: string,
  responseMode: RoomRosterEntry['responseMode'] = 'mention-only'
): RoomRosterEntry {
  return {
    roomId: ROOM.id,
    authorId: `author-${displayName}`,
    responseMode,
    joinedAt: '2026-07-26T10:00:00.000Z',
    lastReadSeq: 0,
    author: {
      id: `author-${displayName}`,
      kind: 'agent',
      displayName,
      agentRef: agentAuthorRef(agentPath),
    },
  };
}

const HUMAN: RoomRosterEntry = {
  roomId: ROOM.id,
  authorId: 'me',
  responseMode: 'always',
  joinedAt: '2026-07-26T10:00:00.000Z',
  lastReadSeq: 0,
  author: { id: 'me', kind: 'human', displayName: 'You' },
};

function roster(members: RoomRosterEntry[]): RoomWithRoster {
  return { ...ROOM, members };
}

const FLEET = [
  { agentPath: '/repo/ana', displayName: 'Ana' },
  { agentPath: '/repo/bo', displayName: 'Bo' },
];

function renderPanel(
  opts: {
    transport?: Transport;
    intent?: 'roster' | 'add';
    agents?: { agentPath: string; displayName: string }[];
  } = {}
) {
  const transport =
    opts.transport ??
    createMockTransport({
      getRoom: vi.fn().mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana')])),
    });
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
    <RoomMembersDialog
      room={ROOM}
      open
      onOpenChange={vi.fn()}
      intent={opts.intent ?? 'roster'}
      agents={opts.agents ?? FLEET}
    />,
    { wrapper }
  );
  return { ...utils, transport };
}

/** The roster list, once it has loaded. */
async function rosterList(): Promise<HTMLElement> {
  return within(await screen.findByRole('region', { name: 'Current members' })).findByRole('list');
}

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — both browser APIs jsdom does not implement at all, and
// without them the listbox never opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomMembersDialog', () => {
  it('lists the agents in the room and leaves the operator out of the roster', async () => {
    renderPanel({
      transport: createMockTransport({
        getRoom: vi
          .fn()
          .mockResolvedValue(
            roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
          ),
      }),
    });

    const list = await rosterList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Ana')).toBeInTheDocument();
    // There is no verb for the person — they are the room's other side, not a
    // member you manage — so "You" never gets a response mode or a remove.
    expect(within(list).queryByText('You')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the roster loads, then the roster', async () => {
    let resolve!: (value: RoomWithRoster) => void;
    renderPanel({
      transport: createMockTransport({
        getRoom: vi.fn().mockReturnValue(
          new Promise<RoomWithRoster>((r) => {
            resolve = r;
          })
        ),
      }),
    });

    expect(screen.getByRole('region', { name: 'Current members' })).toHaveAttribute('aria-busy');
    resolve(roster([HUMAN, agentMember('Ana', '/repo/ana')]));
    await waitFor(() => expect(screen.getByText('Ana')).toBeInTheDocument());
  });

  it('says so when the roster could not be read, without claiming anyone left', async () => {
    renderPanel({
      transport: createMockTransport({ getRoom: vi.fn().mockRejectedValue(new Error('offline')) }),
    });

    expect(await screen.findByText(/Couldn't read who is in here/i)).toBeInTheDocument();
  });

  it('offers an empty room a way out of being empty', async () => {
    renderPanel({
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roster([HUMAN])) }),
    });

    expect(await screen.findByText(/No agents in here yet/i)).toBeInTheDocument();
  });

  it('renders the stored response mode in words, not as its enum value', async () => {
    renderPanel();
    await rosterList();

    expect(screen.getByRole('combobox', { name: 'When Ana replies' })).toHaveTextContent(
      'Replies only when @mentioned'
    );
  });

  it('writes the chosen response-mode override through the Transport port', async () => {
    const { transport } = renderPanel();
    await rosterList();

    const trigger = screen.getByRole('combobox', { name: 'When Ana replies' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Never replies on its own' }));

    await waitFor(() =>
      expect(transport.updateRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana', {
        responseMode: 'silent',
      })
    );
  });

  it('removes nobody until the confirmation is accepted', async () => {
    const { transport } = renderPanel();
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove Ana from #general?');
    expect(transport.removeRoomMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    await waitFor(() =>
      expect(transport.removeRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana')
    );
  });

  it('leaves the roster alone when the removal is refused', async () => {
    const { transport } = renderPanel();
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(transport.removeRoomMember).not.toHaveBeenCalled();
  });

  it('offers only agents that are not already in the room', async () => {
    renderPanel();
    await rosterList();

    // Ana is on the roster; Bo is not.
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Bo']);
  });

  it('adds every agent picked, one call each', async () => {
    const { transport } = renderPanel({
      transport: createMockTransport({
        getRoom: vi.fn().mockResolvedValue(roster([HUMAN])),
        addRoomMember: vi.fn().mockResolvedValue(agentMember('Ana', '/repo/ana')),
      }),
    });
    await screen.findByText(/No agents in here yet/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }));

    await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(2));
    expect(transport.addRoomMember).toHaveBeenNthCalledWith(1, 'room-1', {
      agentPath: '/repo/ana',
    });
    expect(transport.addRoomMember).toHaveBeenNthCalledWith(2, 'room-1', { agentPath: '/repo/bo' });
  });

  it('puts the cursor in the search field only when the reader asked to add', async () => {
    const { unmount } = renderPanel({ intent: 'add' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Search agents' })).toHaveFocus()
    );
    unmount();

    renderPanel({ intent: 'roster' });
    await rosterList();
    expect(screen.getByRole('combobox', { name: 'Search agents' })).not.toHaveFocus();
  });

  it('says there is nobody left to add rather than showing an empty picker', async () => {
    renderPanel({ agents: [{ agentPath: '/repo/ana', displayName: 'Ana' }] });
    await rosterList();

    expect(screen.getByText('Every agent you have is already in here.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
