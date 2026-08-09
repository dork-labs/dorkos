// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { AuthorRef, RoomSummary } from '@dorkos/shared/room-schemas';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import { DirectMessagesSection } from '../ui/rooms/DirectMessagesSection';

/**
 * What a screen reader reads out for each offered agent, in order.
 *
 * Raw `textContent` would pick up the face the picker now draws — an emoji, or
 * a fallback letter — which is `aria-hidden` and is not part of what is
 * announced. Reading it made the list assert "AAna" for an agent called Ana.
 * Same helper, same reason, as `AgentChipPicker.test.tsx`.
 */
function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => {
    const clone = option.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return clone.textContent?.trim() ?? '';
  });
}

/**
 * The fleet the membership surfaces read for themselves.
 *
 * Mocked at the hook rather than injected as a prop, because these components
 * now fetch it — which is the point of the slice owning it. Each test that
 * cares sets the roster to the state it is about; the hook's own three-state
 * behaviour is asserted in `use-agent-picker-candidates.test.tsx`, and the
 * rendering of each state in `AgentRosterPicker.test.tsx`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('@/layers/features/room-management/model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

/** A fleet that has been read successfully. The state is named, never defaulted. */
function settled(candidates: { agentPath: string; displayName: string }[]) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Which viewport the next render happens at. jsdom has no layout engine and
 * loads no CSS, so this decides only which SHELL the picker mounts — an
 * anchored panel or a sheet. Whether either is usable at a given width is a
 * browser question and is answered in a browser, never here.
 */
let onAPhone = false;

beforeAll(() => {
  // jsdom ships no matchMedia, which is what `useIsMobile` reads.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: onAPhone,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const mockUpdate = vi.fn<(updater: (prev: { dmsCollapsed: boolean }) => unknown) => void>();
let mockCollapsed = false;

// Partial-over-actual — see the note on the same mock in ChannelsSection.test.
vi.mock('@/layers/entities/config', async () => {
  const actual = await vi.importActual<typeof import('@/layers/entities/config')>(
    '@/layers/entities/config'
  );
  return {
    ...actual,
    useSidebarPrefs: () => ({ ...SIDEBAR_PREFS_DEFAULTS, dmsCollapsed: mockCollapsed }),
    useUpdateSidebarPrefs: () => ({
      update: mockUpdate,
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
  };
});

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
    { id: 'me', kind: 'human', displayName: 'You', handle: null },
    {
      id: `a-${displayName}`,
      handle: null,
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
    slug: null,
    title: 'Ana',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: [],
    ...overrides,
  };
}

/**
 * The providers a room row needs: rows read and write through the Transport
 * port, and their tooltips need a provider. Every read on the mock answers
 * empty, so nothing here reaches a network.
 */
/** The read-cursor write "Mark all read" ends in, one room at a time. */
const mockSetReadCursor = vi.fn().mockResolvedValue(undefined);

function roomsWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const transport = createMockTransport({
    listRoomEntries: vi
      .fn()
      .mockImplementation((roomId: string) => Promise.resolve([{ roomId, seq: 7 }])),
    setReadCursor: mockSetReadCursor,
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Open the "+" picker beside the section heading. */
function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
}

/** Open the header's "…" menu — Radix opens on pointerdown, not on click. */
function openHeaderMenu(): HTMLElement {
  fireEvent.pointerDown(screen.getByLabelText('Direct messages section actions'));
  return screen.getByRole('menu');
}

/**
 * A successfully-read fleet, written as `{ directory: name }` and handed over
 * in the sorted shape the section takes — the sidebar sorts once and every picker under it
 * offers the same agents in the same order.
 */
function settledFleet(names: Record<string, string>) {
  return settled(
    Object.entries(names)
      .map(([agentPath, displayName]) => ({ agentPath, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  );
}

/** The section with everything defaulted, so a test names only what it varies. */
/** Props the section really takes, plus the fleet its pickers will read. */
type SectionOverrides = Partial<Parameters<typeof DirectMessagesSection>[0]> & {
  __fleet?: ReturnType<typeof settled>;
};

function section({ __fleet, ...overrides }: SectionOverrides = {}) {
  // Set before render, because the pickers read it on their first pass.
  if (__fleet) mockRosterRef.current = __fleet;
  return (
    <DirectMessagesSection
      dms={[]}
      hasGroupedDms={false}
      unreadDmIds={[]}
      visualOf={() => ({ kind: 'sigil' })}
      isLoading={false}
      error={null}
      activeRoomId={null}
      onSelectRoom={vi.fn()}
      onOpenAgentProfile={vi.fn()}
      onRequestNewGroup={vi.fn()}
      {...overrides}
    />
  );
}

function renderSection(overrides: SectionOverrides = {}) {
  return render(section(overrides), { wrapper: roomsWrapper() });
}

beforeEach(() => {
  mockCollapsed = false;
  onAPhone = false;
  mockRosterRef.current = settled([]);
  mockUpdate.mockClear();
  mockStart.mockClear();
  mockSetReadCursor.mockClear();
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

  it("draws the face the sidebar resolved, in preference to the roster's cached emoji", () => {
    // The resolved visual is the new path (sidebar-groups §3.1); `AuthorRef.emoji`
    // is the server-side render cache the old mark depended on, and the reason
    // DOR-582 was invisible — it is populated for the few agents that have an
    // emoji stored, so a fixture that sets it passes either way. Setting BOTH,
    // differently, is what tells the two apart.
    renderSection({
      dms: [dm({ id: 'dm-1', participants: rosterWithAgent('/repo/ana') })],
      visualOf: () => ({ kind: 'identity', visual: { color: 'hsl(120 50% 50%)', emoji: '🦋' } }),
    });
    expect(screen.getByText('🦋')).toBeInTheDocument();
    expect(screen.queryByText('🐙')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Direct messages' }));
    expect(mockUpdate.mock.calls[0]![0]({ dmsCollapsed: false })).toEqual({ dmsCollapsed: true });
  });

  it('tells the person to add an agent first when the roster is empty', () => {
    renderSection({ __fleet: settledFleet({}) });
    openPicker();
    expect(screen.getByText(/have not added any agents yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('starts a conversation with one agent', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));

    expect(mockStart).toHaveBeenCalledWith(
      { agentPaths: ['/repo/bo'], title: 'Bo' },
      expect.anything()
    );
  });

  it('still offers an agent you already have a conversation with', () => {
    // Ana alone and Ana + Kai are different conversations, so hiding Ana once
    // she has one would make the second unreachable. The duplicate a filter used
    // to prevent is the server's job now: it matches a DM on its member set.
    renderSection({
      dms: [dm({ id: 'dm-1', participants: rosterWithAgent('/repo/ana') })],
      __fleet: settledFleet({ '/repo/ana': 'Ana' }),
    });
    openPicker();

    expect(optionNames()).toEqual(['Ana']);
  });

  it('opens ONE conversation with everyone picked, titled after them', () => {
    renderSection({
      __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' }),
    });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Cy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start group conversation' }));

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(
      { agentPaths: ['/repo/ana', '/repo/cy'], title: 'Ana and Cy' },
      expect.anything()
    );
  });

  it('takes an agent out of the list once it is a chip, and offers it again when removed', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    expect(optionNames()).toEqual(['Bo']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(optionNames()).toEqual(['Ana', 'Bo']);
  });

  it('assembles and opens a conversation from the keyboard alone', () => {
    // Type, Enter to take the match, type, Enter, then Enter on an empty field
    // to go. Nothing is highlighted while the field is empty, which is what
    // leaves that last Enter free to mean "open this".
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'an' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockStart).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockStart).toHaveBeenCalledWith(
      { agentPaths: ['/repo/ana', '/repo/bo'], title: 'Ana and Bo' },
      expect.anything()
    );
  });

  it('takes back the last agent on Backspace in an empty field', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByRole('button', { name: 'Remove Bo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  it('leaves the chips alone when Backspace has text to delete instead', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.change(input, { target: { value: 'b' } });

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  it('does nothing on Enter when the query matches nobody', () => {
    // Typing "Kia" for Kai and pressing Enter to try again must not open the
    // half-assembled conversation. "Open this" is gated on the FIELD being
    // empty, never on "no agent is highlighted" — those differ exactly here.
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/kai': 'Kai' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.change(input, { target: { value: 'Kia' } });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockStart).not.toHaveBeenCalled();
    // Still open, still holding what was typed and who was picked.
    expect(screen.getByRole('combobox')).toHaveValue('Kia');
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  it('keeps the highlight on the agent it was pointed at when the list moves under it', () => {
    // Pick Ana (list: Bo, Cy), highlight Bo, then take Ana back — the list
    // becomes Ana, Bo, Cy and index 0 now means Ana. A positional highlight
    // would add Ana here; the highlight is keyed on the agent instead.
    renderSection({
      __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' }),
    });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Bo' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(screen.getByRole('option', { name: 'Bo' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument();
  });

  it('does nothing on Enter when the agent it was aimed at has left the roster', () => {
    // A mesh rebuild can take an agent out from under an open picker. The aim
    // then points at nobody, which everywhere else falls harmlessly through to
    // the first match — but on an empty field that fall-through is the rung
    // that OPENS the conversation, so "aimed at somebody who is gone" would be
    // indistinguishable from "never aimed at anyone" at the one gate that acts.
    const { rerender } = renderSection({
      __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' }),
    });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Bo' })).toHaveAttribute('aria-selected', 'true');

    rerender(section({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/cy': 'Cy' }) }));
    // Cy is still offerable, so this is a vanished AIM and not an empty list.
    expect(optionNames()).toEqual(['Cy']);

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
    // Aiming again is all it takes to recover — nothing is stuck.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove Cy' })).toBeInTheDocument();
  });

  it('drops a highlight that Backspace took off the list rather than sliding it', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Backspace' });

    // Bo is still the one aimed at, and it is still on the list, so it stays lit.
    expect(screen.getByRole('option', { name: 'Bo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Ana' })).toHaveAttribute('aria-selected', 'false');
  });

  it('tells assistive technology there is no list when nothing matches', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // …and the reason is still readable, not stranded inside an empty listbox.
    expect(screen.getByText('No agent by that name.')).toBeInTheDocument();
  });

  it('moves the highlight with the arrow keys', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');

    // Nothing is highlighted until asked for, so the first ArrowDown lands on Ana.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('closes on Escape without starting anything', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('forgets a half-assembled conversation when reopened', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    openPicker();
    expect(screen.queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument();
    expect(optionNames()).toEqual(['Ana', 'Bo']);
  });

  it('will not open a conversation with nobody in it', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();
    const start = screen.getByRole('button', { name: 'Start conversation' });
    expect(start).toBeDisabled();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('offers two agents that render under the same name as separate rows', () => {
    // "Ana (alpha)" and "Ana (beta)" are one agent each. They are told apart by
    // directory everywhere that matters; the menu just has to offer both.
    renderSection({
      __fleet: settledFleet({ '/repo/alpha/ana': 'Ana (alpha)', '/repo/beta/ana': 'Ana (beta)' }),
    });
    openPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ana' } });

    expect(optionNames()).toEqual(['Ana (alpha)', 'Ana (beta)']);
  });

  it('says so when nothing matches what was typed', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No agent by that name/i)).toBeInTheDocument();
  });
});

/**
 * What jsdom can honestly say about the phone: which shell mounts, that it is
 * named, and that it can be dismissed without a keyboard. Everything about
 * whether it FITS — the field clearing the on-screen keyboard, the list having
 * room to scroll — needs layout and CSS, and was checked in a browser at
 * 390×844 instead (DOR-602).
 */
describe('DirectMessagesSection on a phone', () => {
  beforeEach(() => {
    onAPhone = true;
  });

  it('opens as a named sheet rather than a panel pinned to an off-screen button', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();

    expect(screen.getByRole('dialog', { name: 'New message' })).toBeInTheDocument();
  });

  it('offers a way out that is not the Escape key a phone does not have', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });
    openPicker();

    // Presence only. The sheet leaves on a CSS transition whose end event jsdom
    // never fires, so nothing here — or in any vaul drawer — can watch it go;
    // the dismissal itself was driven in a browser at 390×844.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('is the same picker: typeahead, chips and one conversation at the end', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/bo': 'Bo' }) });
    openPicker();
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(mockStart).toHaveBeenCalledWith(
      { agentPaths: ['/repo/bo'], title: 'Bo' },
      expect.anything()
    );
  });

  it('still refuses to open anything on Enter after a typo', () => {
    // The rung that costs an action is the one worth checking on both shells:
    // "Kia" for "Kai" must not throw away a half-assembled conversation.
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana', '/repo/kai': 'Kai' }) });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.change(input, { target: { value: 'Kia' } });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockStart).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveValue('Kia');
  });
  it('opens the same picker from the header menu as from the "+"', () => {
    renderSection({ __fleet: settledFleet({ '/repo/ana': 'Ana' }) });

    fireEvent.click(within(openHeaderMenu()).getByText('New message…'));

    expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument();
  });

  it('marks every unread conversation read, including the ones filed into groups', async () => {
    renderSection({ dms: [dm({ unreadCount: 2 })], unreadDmIds: ['dm-1', 'dm-9'] });

    fireEvent.click(within(openHeaderMenu()).getByText('Mark all read'));

    await waitFor(() => expect(mockSetReadCursor).toHaveBeenCalledWith('room', 'dm-1', 7));
    expect(mockSetReadCursor).toHaveBeenCalledWith('room', 'dm-9', 7);
  });

  it('withholds Mark all read when nothing is behind', () => {
    renderSection({ dms: [dm()] });

    expect(within(openHeaderMenu()).queryByText('Mark all read')).not.toBeInTheDocument();
  });
});
