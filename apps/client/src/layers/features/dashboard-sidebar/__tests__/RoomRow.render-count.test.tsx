// @vitest-environment jsdom
/**
 * The memo contract: a preferences write re-renders the rows it CHANGED, and no
 * others (`specs/sidebar-simplification` D8).
 *
 * Before this, every room row held its own `useSidebarPrefs()` subscription, so
 * muting one channel — or folding a section, or renaming one — re-rendered all
 * sixty of them and rebuilt seven mutation hooks apiece. The fix has two halves
 * and this file needs both to pass: `RoomRow` is `React.memo`, AND every prop it
 * is handed keeps its identity across a render it does not care about.
 *
 * **What makes it fail.** Drop the `memo()` wrapper, or hand any row a prop
 * built inline (a fresh `onSelect`, a fresh `moveTargetGroups` array, a
 * `visual` rebuilt per render) and the untouched row's count moves.
 */
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import {
  configKeys,
  moveTargetGroups,
  mutedRoomIds,
  muteItem,
  roomSectionIds,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import { RoomRow } from '../ui/rooms/RoomRow';
import type { SidebarItemVisual } from '../model/sidebar-item';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// One navigate, not a fresh one per call: TanStack's own is stable, and a mock
// that is not hides an update loop this file exists to catch.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));

/**
 * The render probe.
 *
 * `sidebarItemFaces` is called exactly once per `RoomRow` render and by nothing
 * else in this tree, so counting it counts renders of the component under test
 * without a wrapper that would render whether or not the memo held.
 */
const { renderCounts, actsMounts } = vi.hoisted(() => ({
  renderCounts: { current: [] as string[] },
  actsMounts: { current: 0 },
}));

/**
 * The lazy-menu probe.
 *
 * `useTeamRoster` is mounted by `useRoomRowMenu` and by nothing else a room row
 * reaches, so counting it counts rows that have woken their acts.
 */
vi.mock('@/layers/entities/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/team')>();
  return {
    ...actual,
    useTeamRoster: () => {
      actsMounts.current += 1;
      return { data: undefined };
    },
  };
});
vi.mock('../model/sidebar-item', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/sidebar-item')>();
  return {
    ...actual,
    sidebarItemFaces: (visual: SidebarItemVisual) => {
      // The mark carries the room's id in this file — see `SIGIL_FOR`.
      renderCounts.current.push((visual as { testRoomId?: string }).testRoomId ?? '?');
      return actual.sidebarItemFaces(visual);
    },
  };
});

/**
 * One stable mark per room, tagged so the probe above can say WHICH row drew.
 *
 * Module-level and never rebuilt, exactly as `SidebarChrome`'s own index hands
 * them out: a fresh object per render would move the prop and the memo could
 * never hold.
 */
const SIGIL_FOR: Record<string, SidebarItemVisual> = {
  'room-a': { kind: 'sigil', testRoomId: 'room-a' } as SidebarItemVisual,
  'room-b': { kind: 'sigil', testRoomId: 'room-b' } as SidebarItemVisual,
};

function room(id: string, slug: string): RoomSummary {
  return {
    id,
    kind: 'channel',
    slug,
    title: slug,
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
  };
}

/** Two rooms, held at module level so their identities never move either. */
const ROOMS: RoomSummary[] = [room('room-a', 'alpha'), room('room-b', 'beta')];

const NOOP = () => {};
const NOOP_OPENER = () => NOOP;

/**
 * The panel, reduced to the seam under test.
 *
 * It holds the ONE preferences subscription the real `SidebarChrome` holds and
 * derives each row's answer from it the same way, through the same three
 * helpers.
 */
function Panel() {
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  // Handed the stored list each one reads, exactly as `SidebarChrome` hands
  // them: given the whole `prefs` object, every write produces a fresh
  // `moveTargetGroups` array for every row and the memo below can never hold.
  // That seam has its own test — `SidebarChrome.memo.test.tsx`.
  const muted = useMemo(() => mutedRoomIds(prefs.muted), [prefs.muted]);
  const sections = useMemo(() => roomSectionIds(prefs.groups), [prefs.groups]);
  const targets = useMemo(() => moveTargetGroups(prefs.groups), [prefs.groups]);
  const viewAgentProfile = useCallback(() => NOOP, []);
  const onRequestNewGroup = useCallback(() => {}, []);
  return (
    <>
      <button
        type="button"
        onClick={() => update((prev) => muteItem(prev, { kind: 'room', roomId: 'room-a' }))}
      >
        mute alpha
      </button>
      {ROOMS.map((r) => (
        <RoomRow
          key={r.id}
          room={r}
          visual={SIGIL_FOR[r.id]!}
          isActive={false}
          isMuted={muted.has(r.id)}
          currentGroupId={sections.get(r.id) ?? null}
          moveTargetGroups={targets}
          onSelect={NOOP}
          viewAgentProfile={viewAgentProfile}
          onRequestNewGroup={onRequestNewGroup}
        />
      ))}
    </>
  );
}

function renderPanel() {
  const transport = createMockTransport();
  transport.getConfig = vi.fn().mockResolvedValue({ ui: { sidebar: SIDEBAR_PREFS_DEFAULTS } });
  // Never settles, so the optimistic write stands: a settle would invalidate the
  // config query and the refetch would answer with the defaults again, unmuting
  // the row this test is watching redraw.
  transport.updateConfig = vi.fn().mockReturnValue(new Promise<void>(() => {}));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(configKeys.current(), { ui: { sidebar: SIDEBAR_PREFS_DEFAULTS } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return render(<Panel />, { wrapper });
}

/** How many times each row has drawn since the counter was cleared. */
function drawsOf(roomId: string): number {
  return renderCounts.current.filter((id) => id === roomId).length;
}

describe('RoomRow render count', () => {
  beforeEach(() => {
    renderCounts.current = [];
  });
  afterEach(() => cleanup());

  it('mounts no row acts until the reader reaches for a menu', async () => {
    // The seven hooks behind a room's menu — six mutations and the preferences
    // writer — are the standing cost D8 removes. Red when `useRoomRowMenu` is
    // called unconditionally again, or when the wake latch stops latching.
    renderPanel();
    await screen.findByRole('button', { name: '#alpha' });
    expect(actsMounts.current).toBe(0);

    // Pressing the "⋮" is the earliest a menu can open, and the surface reports
    // the intent on the capture phase of that same press.
    fireEvent.pointerDown(screen.getByLabelText('#alpha actions'));
    // Exactly two, and both are alpha's: the bearer renders on mount and once
    // more after it publishes its acts into the row's state. Beta is on screen
    // with a menu of its own and is still asleep — waking it too would make this
    // four.
    expect(screen.getByLabelText('#beta actions')).toBeInTheDocument();
    expect(actsMounts.current).toBe(2);
  });

  it('re-renders only the row a preferences write changed', async () => {
    renderPanel();
    await screen.findByRole('button', { name: '#alpha' });
    renderCounts.current = [];

    fireEvent.click(screen.getByText('mute alpha'));

    // Alpha is now muted, so it must redraw — that is the write landing. Once:
    // the optimistic write is one commit, and nothing else about the row moved.
    await waitFor(() => expect(screen.getByLabelText('Muted')).toBeInTheDocument());
    expect(drawsOf('room-a')).toBe(1);
    // Beta's own data did not change, so beta must not have drawn at all.
    expect(drawsOf('room-b')).toBe(0);
  });
});
