// @vitest-environment jsdom
/**
 * Who leads a channel, and the one place to change it (DOR-2823).
 *
 * Pinned: only agent members are offered, a choice sends the author id and
 * "None" sends the explicit `null` that clears it, a direct message has no lead
 * at all, and #team names its lead without offering a choice the server would
 * refuse.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { RoomLeadSection } from '../ui/RoomLeadSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** One roster entry. */
function member(
  authorId: string,
  kind: 'human' | 'agent',
  displayName: string,
  retired = false
): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId,
    responseMode: 'engaged',
    joinedAt: '2026-10-01T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: { id: authorId, kind, displayName, handle: null, ...(retired ? { retired } : {}) },
  } as RoomRosterEntry;
}

const ME = member('author-me', 'human', 'Dorian');
const ANA = member('author-ana', 'human', 'Ana');
const SCOUT = member('author-scout', 'agent', 'Scout');
const KAI = member('author-kai', 'agent', 'Kai');
const OLD = member('author-old', 'agent', 'Old bot', true);

function room(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'backend',
    title: 'Backend',
    topic: null,
    archived: false,
    wellKnown: null,
    leadAuthorId: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    lastActivityAt: '2026-10-01T10:00:00.000Z',
    members: [ME, ANA, SCOUT, KAI, OLD],
    viewerAuthorId: 'author-me',
    ...overrides,
  } as unknown as RoomWithRoster;
}

function renderSection(subject: RoomWithRoster): { transport: Transport } {
  const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue(subject) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomLeadSection room={subject} />, { wrapper });
  return { transport };
}

beforeAll(() => {
  // Radix Select needs pointer-capture APIs jsdom lacks to open under userEvent.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RoomLeadSection', () => {
  it('offers None and the agent members only — no people, no retired agents', async () => {
    const user = userEvent.setup();
    renderSection(room());

    await user.click(screen.getByRole('combobox', { name: 'Lead' }));
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['None', 'Scout', 'Kai']);
  });

  it('shows the current lead as the chosen value', () => {
    renderSection(room({ leadAuthorId: 'author-kai' } as Partial<RoomWithRoster>));
    expect(screen.getByRole('combobox', { name: 'Lead' })).toHaveTextContent('Kai');
  });

  it('saves a chosen agent as leadAuthorId', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room());

    await user.click(screen.getByRole('combobox', { name: 'Lead' }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'Kai' })
    );

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { leadAuthorId: 'author-kai' })
    );
  });

  it('sends null when None is chosen', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(
      room({ leadAuthorId: 'author-scout' } as Partial<RoomWithRoster>)
    );

    await user.click(screen.getByRole('combobox', { name: 'Lead' }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'None' })
    );

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { leadAuthorId: null })
    );
  });

  it('draws nothing in a direct message', () => {
    renderSection(room({ kind: 'dm', slug: null, members: [ME, SCOUT] }));
    expect(screen.queryByText('Lead')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('names #team’s lead read-only and says where it is changed', () => {
    renderSection(
      room({ wellKnown: 'team', leadAuthorId: 'author-scout' } as Partial<RoomWithRoster>)
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(
      screen.getByText('Your default agent. Change it from an agent’s profile.')
    ).toBeInTheDocument();
  });

  it('is not offered to a reader who is an agent', () => {
    renderSection(room({ viewerAuthorId: 'author-scout' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
