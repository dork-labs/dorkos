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
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useExtensionRegistry } from '@/layers/shared/model';
import { Sidebar, SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import { TOUR_ANCHORS, type TourAnchorId, type TourAnchorKey } from '@/layers/shared/config';
import { TOUR_DEFINITIONS, type TourId } from '@/layers/features/tours';
import { SidebarNavHeader } from '@/layers/features/dashboard-sidebar';
import { TasksList } from '@/layers/features/tasks';
import { TeamRosterGrid } from '@/layers/features/team-roster';
import { HomeSurfaceLayout } from '@/layers/widgets/home';
import { DashboardPage, DASHBOARD_SECTION_CONTRIBUTIONS } from '@/layers/widgets/dashboard';
import { MessagingRegion } from '@/layers/widgets/connections';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

// The home surface renders its page through an `Outlet`. On `/` that page is
// the dashboard, so the mock puts the real one there and the general tour gets
// the composition it actually runs against: tab bar above, page below.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/' } }),
  useSearch: () => ({}),
  useLocation: () => ({ pathname: '/' }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Outlet: () => <DashboardPage />,
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
 * two spellings that reach the DOM: `data-testid={TOUR_ANCHORS.x}` on an
 * element, and `testId={TOUR_ANCHORS.x}` on a wrapper that forwards it.
 */
function stampedAnchorKeys(): Set<string> {
  const stamped = new Set<string>();
  const pattern = /(?:data-testid|testId)=\{TOUR_ANCHORS\.(\w+)\}/g;
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

/** Mount one tour's surface inside the real app chrome at one width. */
function renderSurface(tourId: TourId, isMobile: boolean) {
  setViewport(isMobile);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const surface = TOUR_SURFACES[tourId]();

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>
        <TooltipProvider>
          <SidebarProvider>
            {/* The real sidebar, not just its contents: on a phone this is the
                Sheet that leaves everything inside it unmounted. */}
            <Sidebar>
              <SidebarNavHeader />
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
  // The dashboard draws whatever the registry holds for its slot, exactly as
  // `initializeExtensions` fills it at startup. Without this the page renders
  // an empty div and the composer step would pass by rendering nothing.
  const { register } = useExtensionRegistry.getState();
  for (const section of DASHBOARD_SECTION_CONTRIBUTIONS) register('dashboard.sections', section);
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

describe.each([
  ['a desktop', false],
  ['a phone', true],
])('tour anchors on %s', (_label, isMobile) => {
  it.each(Object.values(TOUR_DEFINITIONS).map((tour) => [tour.id, tour] as const))(
    'the %s tour spotlights elements its surface actually renders',
    (_id, tour) => {
      renderSurface(tour.id, isMobile);

      const missing = tour.steps
        .filter((step) => screen.queryByTestId(step.anchor) === null)
        .map((step) => step.anchor);

      expect(missing).toEqual([]);
    }
  );
});
