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
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { RoomMembersDialog } from '../ui/RoomMembersDialog';

/**
 * The fleet this surface reads for itself.
 *
 * Mocked at the hook rather than injected as a prop, because the component now
 * fetches it — which is the point of the slice owning it. Every test names the
 * state it is about; the hook's own three-state behaviour is asserted in
 * `use-agent-picker-candidates.test.tsx`, and the rendering of each state in
 * `AgentRosterPicker.test.tsx`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

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
  return { ...ROOM, members, viewerAuthorId: HUMAN.authorId };
}

/**
 * A fleet that has been read successfully. Named for the state rather than
 * defaulted into one — see `AgentRosterPicker.test.tsx` for the loading and
 * failed rosters, which render something else entirely.
 */
function settled(candidates: AgentPickerCandidate[]) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

const FLEET = settled([
  { agentPath: '/repo/ana', displayName: 'Ana' },
  { agentPath: '/repo/bo', displayName: 'Bo' },
]);

function renderPanel(
  opts: {
    transport?: Transport;
    intent?: 'roster' | 'add';
    agents?: ReturnType<typeof settled>;
    onOpenChange?: (open: boolean) => void;
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
  // Set before render: the picker reads the roster on its first pass.
  mockRosterRef.current = opts.agents ?? FLEET;
  const utils = render(
    <RoomMembersDialog
      room={ROOM}
      open
      onOpenChange={opts.onOpenChange ?? vi.fn()}
      intent={opts.intent ?? 'roster'}
    />,
    { wrapper }
  );
  return { ...utils, transport };
}

/** The roster list, once it has loaded. */
async function rosterList(): Promise<HTMLElement> {
  return within(await screen.findByRole('region', { name: 'Current members' })).findByRole('list');
}

/**
 * The add-agents half of the panel. Scoped deliberately: a chip and a roster
 * row both offer to "Remove Ana", and they are opposite verbs — one takes back
 * a selection, the other takes an agent out of the room.
 */
function addSection() {
  return within(screen.getByRole('region', { name: 'Add agents' }));
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
    const confirm = screen.getByRole('group', { name: 'Remove Ana from #general?' });
    expect(confirm).toHaveTextContent('Adding it back starts a fresh session.');
    expect(transport.removeRoomMember).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(transport.removeRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana')
    );
  });

  it('confirms in place, so the panel the reader is working in stays open', async () => {
    // A dialog over a dialog closed BOTH when answered. The panel has to
    // survive its own confirmation, which is the whole reason this is inline.
    const { transport } = renderPanel();
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Remove',
      })
    );

    await waitFor(() => expect(transport.removeRoomMember).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toHaveTextContent('Members of #general');
  });

  it('puts the focus on the confirmation so it can be answered from the keyboard', async () => {
    renderPanel();
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      ).toHaveFocus()
    );
  });

  it('leaves the roster alone when the removal is refused', async () => {
    const { transport } = renderPanel();
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Cancel',
      })
    );

    expect(transport.removeRoomMember).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /^Remove Ana/ })).not.toBeInTheDocument();
  });

  it('lets Escape answer the confirmation without closing the panel', async () => {
    const onOpenChange = vi.fn();
    renderPanel({ onOpenChange });
    await rosterList();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    // Radix listens for Escape on the document in the capture phase, which is
    // where the panel's own handler has to intercept it — so this is dispatched
    // there rather than at the confirmation.
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('group', { name: /^Remove Ana/ })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Members of #general');
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

  it('keeps the chip for the agent that failed, and only that one', async () => {
    // A partial success is progress worth keeping, so the selection empties at
    // the rate the writes actually land: the reader is left holding the failure,
    // and the button offers a retry rather than adding the others a second time.
    let members = [HUMAN];
    const transport = createMockTransport({
      getRoom: vi.fn().mockImplementation(() => Promise.resolve(roster(members))),
      addRoomMember: vi.fn().mockImplementation((_roomId: string, body: { agentPath: string }) => {
        if (body.agentPath === '/repo/bo') return Promise.reject(new Error('nope'));
        const joined = agentMember('Ana', '/repo/ana');
        members = [...members, joined];
        return Promise.resolve(joined);
      }),
    });
    renderPanel({ transport });
    await screen.findByText(/No agents in here yet/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }));

    await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(addSection().queryByText('Ana')).not.toBeInTheDocument());
    expect(addSection().getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
    expect(addSection().getByRole('button', { name: 'Add agent' })).toBeEnabled();
  });

  it('does not put a chip back when the agent it added is removed again', async () => {
    // The picker forgets a committed agent for good rather than deriving its
    // chips from whoever happens to be offerable. Otherwise taking Ana back out
    // of the room — from the same open panel — would re-select her, and the
    // panel would offer to add somebody the reader had just removed.
    let members = [HUMAN];
    const transport = createMockTransport({
      getRoom: vi.fn().mockImplementation(() => Promise.resolve(roster(members))),
      addRoomMember: vi.fn().mockImplementation(() => {
        const joined = agentMember('Ana', '/repo/ana');
        members = [...members, joined];
        return Promise.resolve(joined);
      }),
      removeRoomMember: vi.fn().mockImplementation(() => {
        members = [HUMAN];
        return Promise.resolve();
      }),
    });
    renderPanel({ transport });
    await screen.findByText(/No agents in here yet/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await waitFor(() => expect(addSection().queryByText('Ana')).not.toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ana' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Remove',
      })
    );

    await waitFor(() => expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument());
    expect(addSection().queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument();
  });

  // Where focus lands is asserted in `RoomRow.test.tsx`, through the menu that
  // opens this panel. Rendering it directly here cannot see the thing that
  // actually breaks it: the menu closes a commit later and restores focus to
  // its own trigger, so a panel that focuses correctly in isolation still
  // leaves the reader typing into the sidebar.

  it('lands on the search field even when the fleet is still being read', async () => {
    // "Add agents…" asks for the picker, and the picker is not there yet when
    // the panel opens on a cold read — it draws a shape while the fleet lands.
    // `onOpenAutoFocus` fires once, at open, so without a second pass the
    // reader is left with focus on the dialog and nowhere to type.
    const loading = { candidates: [], isLoading: true, isError: false, retry: vi.fn() };
    const { rerender } = renderPanel({ intent: 'add', agents: loading });

    expect(screen.queryByRole('combobox', { name: 'Search agents' })).not.toBeInTheDocument();

    mockRosterRef.current = FLEET;
    rerender(<RoomMembersDialog room={ROOM} open onOpenChange={vi.fn()} intent="add" />);

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('says there is nobody left to add rather than showing an empty picker', async () => {
    renderPanel({ agents: settled([{ agentPath: '/repo/ana', displayName: 'Ana' }]) });
    await rosterList();

    expect(screen.getByText('Every agent you have is already in here.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
