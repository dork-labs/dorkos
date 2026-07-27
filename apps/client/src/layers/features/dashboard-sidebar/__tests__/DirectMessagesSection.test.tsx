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

/** Open the "+" picker beside the section heading. */
function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));
}

/** The section with everything defaulted, so a test names only what it varies. */
function section(overrides: Partial<Parameters<typeof DirectMessagesSection>[0]> = {}) {
  return (
    <DirectMessagesSection
      dms={[]}
      isLoading={false}
      error={null}
      displayNames={{}}
      activeRoomId={null}
      onSelectRoom={vi.fn()}
      {...overrides}
    />
  );
}

function renderSection(overrides: Partial<Parameters<typeof DirectMessagesSection>[0]> = {}) {
  return render(section(overrides), {
    wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
  });
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

  it('tells the person to add an agent first when the roster is empty', () => {
    renderSection({ displayNames: {} });
    openPicker();
    expect(screen.getByText(/have not added any agents yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('starts a conversation with one agent', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
      displayNames: { '/repo/ana': 'Ana' },
    });
    openPicker();

    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Ana']);
  });

  it('opens ONE conversation with everyone picked, titled after them', () => {
    renderSection({
      displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' },
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
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Bo']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ana' }));
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Ana', 'Bo']);
  });

  it('assembles and opens a conversation from the keyboard alone', () => {
    // Type, Enter to take the match, type, Enter, then Enter on an empty field
    // to go. Nothing is highlighted while the field is empty, which is what
    // leaves that last Enter free to mean "open this".
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/kai': 'Kai' } });
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
      displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' },
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
      displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo', '/repo/cy': 'Cy' },
    });
    openPicker();
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Bo' })).toHaveAttribute('aria-selected', 'true');

    rerender(section({ displayNames: { '/repo/ana': 'Ana', '/repo/cy': 'Cy' } }));
    // Cy is still offerable, so this is a vanished AIM and not an empty list.
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Cy']);

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
    // Aiming again is all it takes to recover — nothing is stuck.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove Cy' })).toBeInTheDocument();
  });

  it('drops a highlight that Backspace took off the list rather than sliding it', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
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
    renderSection({ displayNames: { '/repo/ana': 'Ana' } });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('forgets a half-assembled conversation when reopened', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana', '/repo/bo': 'Bo' } });
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    openPicker();
    expect(screen.queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['Ana', 'Bo']);
  });

  it('will not open a conversation with nobody in it', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana' } });
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
      displayNames: { '/repo/alpha/ana': 'Ana (alpha)', '/repo/beta/ana': 'Ana (beta)' },
    });
    openPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ana' } });

    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual([
      'Ana (alpha)',
      'Ana (beta)',
    ]);
  });

  it('says so when nothing matches what was typed', () => {
    renderSection({ displayNames: { '/repo/ana': 'Ana' } });
    openPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No agent by that name/i)).toBeInTheDocument();
  });
});
