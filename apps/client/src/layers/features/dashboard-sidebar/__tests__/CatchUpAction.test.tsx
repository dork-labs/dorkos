// @vitest-environment jsdom
/**
 * "Catch up" — the one press that clears Today, and where the watermark goes
 * when it does (P4 AC-4, BC-41).
 *
 * The list it acts on is derived from real model rows built by the real
 * `buildSidebarModel` from the programme's own fixtures, not from a hand-typed
 * array of ids: "everything Today is holding" is a claim about the model, and a
 * fixture is the only thing that can falsify it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { buildSidebarModel } from '../model/build-sidebar-model';
import type { SidebarRowModel } from '../model/build-sidebar-model';
import { busyFixture } from '../model/fixtures';
import { CatchUpAction, unreadRoomIdsIn } from '../ui/TodayZone';

// ── The viewport, which decides whether this control exists at all ──────────
let phone = true;
function useEmulatedViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: maxWidth === null ? false : phone && 390 <= Number(maxWidth[1]),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

let transport: ReturnType<typeof createMockTransport>;

function renderAction(roomIds: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CatchUpAction roomIds={roomIds} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Today's rows, as the real model emits them for a fixture. */
function todayRows(): SidebarRowModel[] {
  const model = buildSidebarModel(busyFixture);
  const today = model.zones.find((zone) => zone.id === 'today');
  return today?.sections.find((section) => section.id === 'today')?.rows ?? [];
}

beforeEach(() => {
  phone = true;
  useEmulatedViewport();
  transport = createMockTransport();
  // One entry per room, so the sweep has a `seq` to move the cursor onto.
  transport.listRoomEntries = vi.fn().mockResolvedValue([{ id: 'e1', seq: 42 }]);
  window.localStorage.clear();
});
afterEach(cleanup);

describe('unreadRoomIdsIn', () => {
  it('names the rooms Today is holding, and nothing else', () => {
    const rows = todayRows();
    // The fixture has to actually contain the thing being filtered, or every
    // assertion below is about an empty list.
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.some((row) => row.unread.tier !== 'none')).toBe(true);
    expect(rows.some((row) => row.unread.tier === 'none')).toBe(true);

    const ids = unreadRoomIdsIn(rows);
    const expected = new Set(
      rows
        .filter((row) => row.unread.tier !== 'none' && row.target.kind === 'room')
        .map((row) => (row.target.kind === 'room' ? row.target.roomId : ''))
    );
    expect(new Set(ids)).toEqual(expected);
    expect(ids.length).toBe(expected.size);
  });

  it('leaves a caught-up room out — spending two requests to rewrite a cursor it already has', () => {
    const rows = todayRows();
    const quiet = rows.filter((row) => row.unread.tier === 'none' && row.target.kind === 'room');
    expect(quiet.length).toBeGreaterThan(0);
    const ids = unreadRoomIdsIn(rows);
    for (const row of quiet) {
      if (row.target.kind !== 'room') continue;
      // …unless another row of the SAME room is unread, which is the thread
      // case: one cursor, two rows.
      const alsoUnread = rows.some(
        (other) =>
          other.target.kind === 'room' &&
          row.target.kind === 'room' &&
          other.target.roomId === row.target.roomId &&
          other.unread.tier !== 'none'
      );
      if (!alsoUnread) expect(ids).not.toContain(row.target.roomId);
    }
  });

  it('counts a room once however many of its rows are in Today', () => {
    // A thread inherits its room's cursor, so a channel and a thread inside it
    // are two rows and ONE write.
    const rows: SidebarRowModel[] = [
      {
        key: 'a',
        target: { kind: 'room', roomId: 'r1', roomKind: 'channel' },
        glyph: { kind: 'hash' },
        primary: 'general',
        status: 'idle',
        unread: { tier: 'activity' },
        draggable: false,
        reason: 'today:interaction-recency',
      },
      {
        key: 'b',
        target: { kind: 'room', roomId: 'r1', roomKind: 'thread', rootEntryId: 'e9' },
        glyph: { kind: 'hash' },
        primary: 'general',
        status: 'idle',
        unread: { tier: 'directed', count: 2 },
        draggable: false,
        reason: 'today:interaction-recency',
      },
    ] as SidebarRowModel[];
    expect(unreadRoomIdsIn(rows)).toEqual(['r1']);
  });

  it('leaves out a room that is already caught up', () => {
    // **Fabricated rather than read off a fixture, on purpose.** The fixture
    // case above is real but it does not discriminate: every quiet ROOM in
    // `busy` shares its id with an unread row, so dropping the unread filter
    // entirely left that assertion green. This pair cannot be satisfied by a
    // function that returns every room it is handed.
    const rows: SidebarRowModel[] = [
      {
        key: 'read',
        target: { kind: 'room', roomId: 'quiet-room', roomKind: 'channel' },
        glyph: { kind: 'hash' },
        primary: 'random',
        status: 'idle',
        unread: { tier: 'none' },
        draggable: false,
        reason: 'today:interaction-recency',
      },
      {
        key: 'unread',
        target: { kind: 'room', roomId: 'loud-room', roomKind: 'channel' },
        glyph: { kind: 'hash' },
        primary: 'general',
        status: 'idle',
        unread: { tier: 'activity' },
        draggable: false,
        reason: 'today:interaction-recency',
      },
    ] as SidebarRowModel[];
    expect(unreadRoomIdsIn(rows)).toEqual(['loud-room']);
  });

  it('never names a session — a session row is not something a cursor measures', () => {
    const rows: SidebarRowModel[] = [
      {
        key: 's',
        target: { kind: 'session', sessionId: 'sess-1', agentPath: '/a', cwd: '/a' },
        glyph: { kind: 'icon', icon: 'session' },
        primary: 'Dashboard overhaul',
        status: 'idle',
        unread: { tier: 'directed', count: 3 },
        draggable: false,
        reason: 'today:interaction-recency',
      },
    ] as SidebarRowModel[];
    expect(unreadRoomIdsIn(rows)).toEqual([]);
  });
});

describe('CatchUpAction (P4 AC-4)', () => {
  it('marks every unread Today room read in one press', async () => {
    const user = userEvent.setup();
    renderAction(['r1', 'r2', 'r3']);
    await user.click(screen.getByTestId('today-catch-up'));

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(3));
    // Through the cursor API, at the room's real newest `seq` — not a
    // watermark of the sidebar's own and not a "set it very high" shortcut,
    // which would swallow the next message to arrive as already read.
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'r1', 42);
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'r2', 42);
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'r3', 42);
  });

  it('writes no watermark of its own to this browser (BC-41)', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderAction(['r1']);
    await user.click(screen.getByTestId('today-catch-up'));

    // The observable half first: the press really did do its work, so the
    // silence below is about where it wrote rather than about whether it ran.
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(1));
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    setItem.mockRestore();
  });

  it('is not there when there is nothing to catch up on', () => {
    renderAction([]);
    expect(screen.queryByTestId('today-catch-up')).toBeNull();
  });

  it('is not there under a pointer — per-item triage is the desktop behaviour', () => {
    phone = false;
    useEmulatedViewport();
    renderAction(['r1', 'r2']);
    expect(screen.queryByTestId('today-catch-up')).toBeNull();

    // The pair: the identical list at phone width DOES draw it, so the absence
    // above is the viewport rather than the list.
    cleanup();
    phone = true;
    useEmulatedViewport();
    renderAction(['r1', 'r2']);
    expect(screen.getByTestId('today-catch-up')).toBeInTheDocument();
  });

  it('says how much it is about to do, and opens with the words on the button', () => {
    renderAction(['r1', 'r2']);
    const button = screen.getByTestId('today-catch-up');
    expect(button).toHaveTextContent('Catch up');
    // WCAG 2.5.3: the accessible name starts with the visible label, so voice
    // control that hears "Catch up" reaches it.
    expect(button.getAttribute('aria-label')).toMatch(/^Catch up/);
    expect(button).toHaveAccessibleName('Catch up — mark 2 unread conversations in Today as read');
  });
});
