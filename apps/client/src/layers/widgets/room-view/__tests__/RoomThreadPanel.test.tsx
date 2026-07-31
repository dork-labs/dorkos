// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomEntry, RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomThreadPanel } from '../ui/RoomThreadPanel';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

afterEach(() => {
  cleanup();
  useRoomPresenceStore.setState({ rooms: {} });
});

function member(id: string, displayName: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-30T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id, kind: 'agent', displayName },
  } as RoomRosterEntry;
}

function entry(seq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

/** A reply to `entry-<parentSeq>`, at depth one. */
function reply(seq: number, parentSeq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return entry(seq, {
    parentEntryId: `entry-${parentSeq}`,
    threadRootEntryId: `entry-${parentSeq}`,
    ...overrides,
  });
}

const room: RoomWithRoster = {
  id: 'room-1',
  kind: 'channel',
  slug: 'build',
  title: 'build',
  topic: null,
  archived: false,
  createdAt: '2026-07-30T09:00:00.000Z',
  viewerAuthorId: 'reader',
  reactionFrequents: ['👍', '❤️', '🎉'],
  members: [member('ana', 'Ana'), member('bo', 'Bo')],
} as unknown as RoomWithRoster;

function renderPanel(overrides: Partial<Parameters<typeof RoomThreadPanel>[0]> = {}) {
  return render(
    <RoomThreadPanel
      room={room}
      rootEntryId="entry-1"
      focusComposer={false}
      entries={[entry(1), reply(2, 1)]}
      reactionFrequents={['👍', '❤️', '🎉']}
      pushed={false}
      historyLoaded
      onClose={vi.fn()}
      {...overrides}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            })
          }
        >
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>{children}</TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('RoomThreadPanel', () => {
  it('shows the root at the top and its replies beneath it', () => {
    renderPanel();

    const panel = screen.getByTestId('room-thread-panel');
    const rows = within(panel).getAllByTestId('room-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('line 1');
    expect(rows[1]).toHaveTextContent('line 2');
  });

  it('gathers only ITS thread, not every reply in the room', () => {
    renderPanel({
      entries: [entry(1), reply(2, 1), entry(3), reply(4, 3)],
    });

    const panel = screen.getByTestId('room-thread-panel');
    expect(within(panel).getAllByTestId('room-entry')).toHaveLength(2);
    expect(within(panel).queryByText('line 4')).not.toBeInTheDocument();
  });

  it('gives the thread a composer that writes into it', () => {
    renderPanel();

    // The placeholder IS the accessible name, so "which conversation does this
    // box post to" is a question the accessibility tree answers.
    expect(screen.getByRole('combobox', { name: 'Reply in this thread…' })).toBeInTheDocument();
  });

  it('says the start is gone rather than dropping an orphaned thread', () => {
    // The root is older than the loaded history. Its replies are real and stay.
    renderPanel({ entries: [reply(2, 1), reply(3, 1)] });

    expect(screen.getByTestId('room-thread-orphan')).toHaveTextContent(
      'The start of this thread is gone'
    );
    expect(screen.getAllByTestId('room-entry')).toHaveLength(2);
  });

  it('does not call a thread orphaned while its history is still loading', () => {
    // A deep link mounts this panel before the room's entries arrive, so the
    // root is missing for a moment. Saying "the start of this thread is gone"
    // in that moment is a small lie that flashes on every shared link.
    renderPanel({ entries: [], historyLoaded: false });

    expect(screen.queryByTestId('room-thread-orphan')).not.toBeInTheDocument();
  });

  it('is a root and a composer when nothing has been said back', () => {
    // No invented empty state (design record §4): a thread with no replies yet
    // IS a root and a box, and a drawing saying so would be furniture.
    renderPanel({ entries: [entry(1)] });

    expect(screen.getAllByTestId('room-entry')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Reply in this thread…' })).toBeInTheDocument();
    expect(screen.queryByTestId('room-thread-orphan')).not.toBeInTheDocument();
  });

  it('closes on its close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });

    await user.click(screen.getByRole('button', { name: 'Close thread' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape, because it takes focus when it opens', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });

    // Not clicked into first: a panel opened from a reply row leaves focus up
    // in the timeline, so it has to take focus itself or Escape never reaches
    // it.
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('offers Back instead of Close on a phone, naming the room it returns to', () => {
    renderPanel({ pushed: true });

    expect(screen.getByRole('button', { name: 'Back to #build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close thread' })).not.toBeInTheDocument();
  });

  it('draws the working line for an agent answering inside this thread', () => {
    // Presence follows you in (design record §3.2). The claim's trigger is a
    // REPLY in this thread, so this is where it belongs.
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'bo',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-2',
      since: new Date().toISOString(),
    });

    renderPanel();

    expect(screen.getByTestId('room-presence')).toHaveTextContent('Bo is working on it');
  });

  it('leaves work triggered by a ROOM message to the room’s own line', () => {
    // `entry-9` is not a reply in this thread, so the panel says nothing —
    // otherwise one claim would be announced in two places at once.
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'bo',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-9',
      since: new Date().toISOString(),
    });

    renderPanel();

    expect(screen.queryByTestId('room-presence')).not.toBeInTheDocument();
  });
});
