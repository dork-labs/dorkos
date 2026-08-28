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
 * `visual` rebuilt per render, a fresh `rowMotion`) and the untouched row's
 * count moves.
 *
 * **The rows are drawn through the SHIPPED `SidebarModelRow`**, not by handing
 * `RoomRow` props this file made up. That is the whole difference between
 * testing the memo and testing the memo CHAIN: `SidebarModelRow` is where the
 * continuity layer's `rowMotion` object is built, and a version of this file
 * that constructed props itself stayed green when that object was rebuilt fresh
 * on every render — which defeats the memo for every room in the panel. The one
 * thing standing in is `useSidebarChrome`, because the real provider opens ten
 * queries and a router; the stub below carries the same identities the real one
 * memoizes, and `SidebarChrome.memo.test.tsx` is what pins that end.
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
import type { SidebarRowModel } from '../model/build-sidebar-model';
import { SidebarModelRow } from '../ui/SidebarModelRow';
import { sectionLayoutKey } from '../ui/motion/sidebar-motion';
import type { SidebarItemVisual } from '../model/sidebar-item';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * The chrome the rows read, published by `Panel` during its own render.
 *
 * A module-level box rather than a context, because the mock below has to answer
 * `useSidebarChrome()` from inside the same render pass that filled it — React
 * renders a parent before its children, so the value is always there by the time
 * a row asks.
 */
const { chromeBox } = vi.hoisted(() => ({
  chromeBox: { current: null as unknown },
}));
vi.mock('../ui/SidebarChrome', () => ({
  useSidebarChrome: () => chromeBox.current,
}));
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

/** The chrome's index, built once for the same reason. */
const ROOMS_BY_ID = new Map(ROOMS.map((r) => [r.id, r]));

const NOOP = () => {};

/** The model rows the panel draws — one per room, exactly as the builder emits them. */
const MODEL_ROWS: SidebarRowModel[] = ROOMS.map(
  (r) =>
    ({
      key: `room:${r.id}`,
      target: { kind: 'room', roomId: r.id, roomKind: 'channel' },
      glyph: { kind: 'hash' },
      primary: r.slug ?? r.id,
      reservesVerbLine: false,
      unread: { tier: 'none' },
      muted: false,
      draggable: true,
      reason: 'library:channels',
    }) as SidebarRowModel
);

/** The section's row-id list, stable because the membership never changes here. */
const LAYOUT_KEY = sectionLayoutKey(MODEL_ROWS);

/**
 * The panel, reduced to the seam under test.
 *
 * It holds the ONE preferences subscription the real `SidebarChrome` holds and
 * derives each row's answer from it the same way, through the same three
 * helpers — then publishes the result as the chrome the rows read, and lets
 * `SidebarModelRow` do the rest.
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
  const openTarget = useCallback(() => {}, []);
  const roomVisualOf = useCallback((room: RoomSummary) => SIGIL_FOR[room.id]!, []);
  // eslint-disable-next-line react-hooks/immutability -- test harness: the mocked `useSidebarChrome` reads this box, so the value has to be published during the same render the children read it in
  chromeBox.current = useMemo(
    () => ({
      roomsById: ROOMS_BY_ID,
      roomVisualOf,
      mutedRoomIds: muted,
      roomSectionIds: sections,
      moveTargetGroups: targets,
      viewProfileFor: viewAgentProfile,
      requestNewGroup: onRequestNewGroup,
      openTarget,
      activeTarget: null,
      homeRoomId: null,
      manifests: {},
      bootSettled: true,
    }),
    [muted, sections, targets, viewAgentProfile, onRequestNewGroup, openTarget, roomVisualOf]
  );
  return (
    <>
      <button
        type="button"
        onClick={() => update((prev) => muteItem(prev, { kind: 'room', roomId: 'room-a' }))}
      >
        mute alpha
      </button>
      {MODEL_ROWS.map((modelRow) => (
        <SidebarModelRow
          key={modelRow.key}
          row={modelRow}
          keyPrefix="ungrouped"
          layoutKey={LAYOUT_KEY}
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
  const rendered = render(<Panel />, { wrapper });
  // Re-rendered through the same wrapper, so a rerender is a new render of the
  // panel rather than a new query client and a fresh mount of everything.
  return {
    ...rendered,
    rerender: (ui: ReactNode) => rendered.rerender(<>{ui}</>),
  };
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

  it('draws no row again when only the clock moved', async () => {
    // **The 60 s tick** (spec D5 (c)). `useSidebarState` rebuilds the whole model
    // every minute so relative times stay honest, and every row's `layout` FLIP
    // measures against its section's row-id list — which that rebuild does not
    // touch. Re-rendering the panel with the same rows is what a tick looks like
    // from here, and not one row may redraw for it.
    //
    // Red when `SidebarModelRow` stops memoizing `rowMotion`: a fresh object per
    // render is a changed prop on a memoized row, so both rows would draw once a
    // minute, forever.
    const { rerender } = renderPanel();
    await screen.findByRole('button', { name: '#alpha' });
    renderCounts.current = [];

    rerender(<Panel />);

    expect(drawsOf('room-a')).toBe(0);
    expect(drawsOf('room-b')).toBe(0);
  });
});
