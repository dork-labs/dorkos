// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomTimeline } from '../ui/RoomTimeline';
import { lastSeenEntryId, toMessageAuthor, authorsById } from '../lib/room-timeline';

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
afterEach(cleanup);

function member(id: string, displayName: string, kind: 'human' | 'agent' = 'agent') {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id, kind, displayName },
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
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

function renderTimeline(overrides: Partial<Parameters<typeof RoomTimeline>[0]> = {}) {
  return render(
    <RoomTimeline
      entries={[]}
      members={[member('ana', 'Ana')]}
      lastReadSeq={null}
      isLoading={false}
      error={null}
      {...overrides}
    />,
    { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
  );
}

describe('RoomTimeline', () => {
  it('shows a loading state before any history arrives', () => {
    renderTimeline({ isLoading: true });
    expect(screen.getByTestId('room-timeline-loading')).toBeInTheDocument();
  });

  it('says the room keeps everything when the history could not be read', () => {
    renderTimeline({ error: new Error('offline') });
    expect(screen.getByText(/Couldn't load this conversation/i)).toBeInTheDocument();
  });

  it('invites you to add agents when nothing has been said', () => {
    renderTimeline();
    expect(screen.getByText(/Nothing said here yet/i)).toBeInTheDocument();
  });

  it('names the author from the roster, not from the entry', () => {
    renderTimeline({ entries: [entry(1)] });
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('line 1')).toBeInTheDocument();
  });

  it('groups consecutive entries from one author under a single header', () => {
    renderTimeline({ entries: [entry(1), entry(2), entry(3)] });
    expect(screen.getAllByTestId('room-entry')).toHaveLength(3);
    expect(screen.getAllByText('Ana')).toHaveLength(1);
  });

  it('opens a new group when someone else speaks', () => {
    renderTimeline({
      members: [member('ana', 'Ana'), member('bo', 'Bo')],
      entries: [entry(1), entry(2, { authorId: 'bo' })],
    });
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
  });

  it('renders a notice as the room speaking, with no author beside it', () => {
    renderTimeline({
      entries: [
        entry(1, {
          kind: 'notice',
          authorId: 'system',
          body: { text: 'Ana stopped replying here.', notice: 'cascade_stopped' },
        }),
      ],
    });
    expect(screen.getByTestId('room-notice')).toHaveTextContent('Ana stopped replying here.');
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
  });

  it('draws a day boundary between calendar days', () => {
    renderTimeline({
      entries: [
        entry(1, { createdAt: '2026-07-24T10:00:00.000Z' }),
        entry(2, { createdAt: '2026-07-26T10:00:00.000Z' }),
      ],
    });
    expect(screen.getAllByTestId('day-divider')).toHaveLength(2);
  });

  it('marks where the reader left off, from the membership cursor', () => {
    renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: 1 });
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
  });

  it('draws no unread rule for a reader who is not a member', () => {
    renderTimeline({ entries: [entry(1), entry(2)], lastReadSeq: null });
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });
});

describe('lastSeenEntryId', () => {
  it('is null when the reader is caught up', () => {
    expect(lastSeenEntryId([entry(1), entry(2)], 2)).toBeNull();
  });

  it('is null when the reader is not a member', () => {
    expect(lastSeenEntryId([entry(1)], null)).toBeNull();
  });

  it('is null when the reader has read nothing at all', () => {
    expect(lastSeenEntryId([entry(1)], 0)).toBeNull();
  });

  it('names the newest entry at or below the cursor', () => {
    expect(lastSeenEntryId([entry(1), entry(4), entry(7)], 5)).toBe('entry-4');
  });
});

describe('toMessageAuthor', () => {
  it('renders a member from the roster', () => {
    const authors = authorsById([member('ana', 'Ana')]);
    expect(toMessageAuthor('ana', authors)).toMatchObject({
      id: 'ana',
      kind: 'agent',
      displayName: 'Ana',
    });
  });

  it('keeps a departed member’s words rather than dropping them', () => {
    expect(toMessageAuthor('gone', new Map())).toMatchObject({ displayName: 'Unknown' });
  });

  it('gives every author a stable color derived from their id', () => {
    const first = toMessageAuthor('ana', new Map());
    const second = toMessageAuthor('ana', new Map());
    expect(first.color).toBe(second.color);
    expect(first.color).not.toBe(toMessageAuthor('bo', new Map()).color);
  });
});
