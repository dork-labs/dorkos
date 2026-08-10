// @vitest-environment jsdom
/**
 * Every anchor a tour spotlights has to be on the screen the tour opens — at
 * every width.
 *
 * A tour step whose anchor is missing does not crash and does not complain. The
 * spotlight polls for it, gives up after four seconds, and skips, so a broken
 * step reads to the user as several seconds of nothing. Two ways that happens:
 *
 * 1. **The element is gone.** Nothing type-checks a `data-testid`, so deleting
 *    the component that stamped one leaves the tour pointing at an empty room.
 * 2. **The element is not rendered at this width.** The sidebar is a Radix
 *    Sheet on a phone and is unmounted while closed, so a step anchored inside
 *    it works on a desktop and shows a phone nothing at all. This is not
 *    hypothetical: it is exactly what two re-pointed steps did before this file
 *    existed, and the source-scan half below stayed green through it.
 *
 * So there are two halves. The scan is fast and covers every anchor; the render
 * half mounts each tour's real surface inside the real chrome, at a desktop
 * width and a phone width, and asserts the anchors resolve.
 *
 * It lives at the app-shell root rather than beside the tours feature because a
 * feature may not import a widget (the FSD layer rule) and these surfaces span
 * every layer.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  REACTION_FREQUENTS_DEFAULT,
  TEAM_ROOM_WELL_KNOWN,
  type RoomEvent,
} from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { Sidebar, SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import { TOUR_ANCHORS, type TourAnchorId, type TourAnchorKey } from '@/layers/shared/config';
import { TOUR_DEFINITIONS, type TourId } from '@/layers/features/tours';
import { SidebarFooterStrip } from '@/layers/features/dashboard-sidebar';
import { TasksList } from '@/layers/features/tasks';
import { TeamRosterGrid } from '@/layers/features/team-roster';
import { HomeSurfaceLayout } from '@/layers/widgets/home';
import { MessagingRegion } from '@/layers/widgets/connections';
import { HomeRoomPage } from '../app/HomeRoomPage';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

// The home surface renders its page through an `Outlet`. On `/` that page is
// the #team room, so the mock puts the real one there and the general tour gets
// the composition it actually runs against: tab bar above, room below.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/' } }),
  useSearch: () => ({}),
  useLocation: () => ({ pathname: '/' }),
  // The thread-URL sync reads the current location through `useInPlaceNavigate`.
  useRouter: () => ({ state: { location: { pathname: '/', search: {} } } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Outlet: () => <HomeRoomPage />,
}));

// The global `/api/events` fan-out needs the app-level `EventStreamProvider`.
// Nothing here is about that stream, so it is stubbed rather than dragged in —
// the same approach `ClaimFeed.test.tsx` and `DashboardSidebar.test.tsx` take.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventStream: () => ({ connectionState: 'connected', failedAttempts: 0 }),
    useEventSubscription: () => {},
  };
});

// ---------------------------------------------------------------------------
// Half one: the scan. Cheap, and it covers anchors on surfaces too expensive to
// mount here.
// ---------------------------------------------------------------------------

/**
 * The application source a tour can spotlight: the FSD layers only. The dev
 * playground sits outside this tree on purpose — it stamps throwaway anchors of
 * its own to demo the spotlight, and counting those would let a tour point at
 * an element no real screen draws.
 */
const LAYERS_DIR = join(__dirname, '../layers');

/** Every `.tsx` under the layers tree, tests excluded. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * The anchor keys some component actually stamps on a DOM node, found by the
 * three spellings that reach the DOM: `data-testid={TOUR_ANCHORS.x}` on an
 * element, `testId={TOUR_ANCHORS.x}` on a wrapper that forwards it, and
 * `testId: TOUR_ANCHORS.x` in a data table a component maps over — which is how
 * the footer strip declares its destinations, and which the first two spellings
 * would have silently missed.
 */
function stampedAnchorKeys(): Set<string> {
  const stamped = new Set<string>();
  const pattern = /(?:data-testid|testId)\s*[=:]\s*\{?TOUR_ANCHORS\.(\w+)\}?/g;
  for (const file of componentFiles(LAYERS_DIR)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      stamped.add(match[1]);
    }
  }
  return stamped;
}

/** The authoring key behind an anchor's `data-testid` value. */
function anchorKey(anchor: TourAnchorId): TourAnchorKey {
  const entry = Object.entries(TOUR_ANCHORS).find(([, value]) => value === anchor);
  if (!entry) throw new Error(`No TOUR_ANCHORS key holds "${anchor}"`);
  return entry[0] as TourAnchorKey;
}

describe('tour anchors: the source scan', () => {
  it('every anchor a tour spotlights is stamped by a real component', () => {
    const stamped = stampedAnchorKeys();

    const orphans = Object.values(TOUR_DEFINITIONS).flatMap((tour) =>
      tour.steps
        .map((step) => anchorKey(step.anchor))
        .filter((key) => !stamped.has(key))
        .map((key) => `${tour.id}: ${key}`)
    );

    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Half two: the render. What the scan cannot see — whether the element is on
// the screen this tour opens, at this width.
// ---------------------------------------------------------------------------

/** A roster with agents in it, which is the only state the fleet tour fires in. */
const ROSTER = MOCK_TEAM_ROSTER;

/**
 * What each tour opens onto, as the real components.
 *
 * The chrome around them is added by {@link renderSurface} — every tour runs
 * with the sidebar mounted, because that is the arrangement in which a step
 * anchored inside the sidebar looks fine on a desktop.
 */
const TOUR_SURFACES: Record<TourId, () => ReactNode> = {
  general: () => <HomeSurfaceLayout />,
  tasks: () => <TasksList tasks={[]} isLoading={false} agentMap={new Map()} onEditTask={vi.fn()} />,
  relay: () => <MessagingRegion />,
  mesh: () => <TeamRosterGrid members={ROSTER} roster={ROSTER} grouped={false} />,
};

/** Point `matchMedia` at one width. The sidebar reads it to decide sheet-or-rail. */
function setViewport(isMobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // `useIsMobile` asks for `(max-width: 767px)`, so a phone matches and a
      // desktop does not. Everything else (reduced motion, colour scheme) says
      // no, which is the default this suite wants.
      matches: isMobile && query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/**
 * A cockpit with a #team room in it.
 *
 * The general tour opens on `/`, which IS that room — so without it the home
 * page draws its honest "not open yet" notice and the composer step would pass
 * by spotlighting nothing.
 */
function transportWithTeamRoom() {
  const team = {
    id: 'team-room',
    kind: 'channel' as const,
    slug: 'team',
    title: '#team',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: TEAM_ROOM_WELL_KNOWN,
    createdAt: '2026-08-08T09:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
  };
  return createMockTransport({
    listRooms: vi.fn().mockResolvedValue([{ ...team, unreadCount: 0, participants: null }]),
    getRoom: vi.fn().mockResolvedValue({
      ...team,
      members: [],
      viewerAuthorId: 'author-you',
      reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    }),
    listRoomEntries: vi.fn().mockResolvedValue([]),
    // A live but silent stream, so the room is not busy reconnecting.
    subscribeRoom: vi.fn(
      (_id: string, _cursor: number, signal: AbortSignal): AsyncIterable<RoomEvent> =>
        (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
    ),
  });
}

/** Mount one tour's surface inside the real app chrome at one width. */
function renderSurface(tourId: TourId, isMobile: boolean) {
  setViewport(isMobile);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const surface = TOUR_SURFACES[tourId]();

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transportWithTeamRoom()}>
        <TooltipProvider>
          <SidebarProvider>
            {/* The real sidebar, not just its contents: on a phone this is the
                Sheet that leaves everything inside it unmounted. The strip is
                what carries the panel's navigation now — the header nav that
                used to stamp `nav-agents` was retired, and the anchor moved
                with the buttons rather than dying with the file. */}
            <Sidebar>
              <SidebarFooterStrip />
            </Sidebar>
            <main>{surface}</main>
          </SidebarProvider>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeAll(() => {
  setViewport(false);
  // Radix measures and scrolls things jsdom does not implement.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

describe('the sidebar navigation anchor', () => {
  it('still resolves after the header nav that used to stamp it was retired', async () => {
    // `nav-agents` is what the Team e2e specs click and what the typed registry
    // promises resolves. It survived the death of `SidebarNavHeader` only
    // because the footer strip re-stamps it, and nothing in the type system
    // would have said otherwise — a `data-testid` is a string.
    renderSurface('general', false);

    await waitFor(() => {
      expect(screen.queryByTestId(TOUR_ANCHORS.navAgents)).not.toBeNull();
    });
    expect(screen.getByTestId(TOUR_ANCHORS.navAgents)).toHaveAttribute('aria-label', 'Team');
  });
});

describe.each([
  ['a desktop', false],
  ['a phone', true],
])('tour anchors on %s', (_label, isMobile) => {
  it.each(Object.values(TOUR_DEFINITIONS).map((tour) => [tour.id, tour] as const))(
    'the %s tour spotlights elements its surface actually renders',
    async (_id, tour) => {
      renderSurface(tour.id, isMobile);

      // Waited for, not read once: the home tab resolves its room before it can
      // draw a composer, and a spotlight polls for its anchor anyway. What this
      // asserts is that the element ARRIVES, which is the honest version of the
      // claim — a step whose anchor never lands is the four-second silent skip
      // this file exists to catch.
      await waitFor(() => {
        const missing = tour.steps
          .filter((step) => screen.queryByTestId(step.anchor) === null)
          .map((step) => step.anchor);

        expect(missing).toEqual([]);
      });
    }
  );
});
