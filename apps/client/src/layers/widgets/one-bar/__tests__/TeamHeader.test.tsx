// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import type { TeamViewMode } from '@/layers/shared/lib';
import { TeamHeader } from '../ui/TeamHeader';
import { BarHarness } from './bar-harness';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// The router is NOT mocked here. The view switcher is a strip of links now, so
// what it writes to the URL is only observable through a router that actually
// serves `/team` — a mocked `useNavigate` would let a strip that navigates
// nowhere pass.

let mockIsMobile = false;

// Records the layout id each strip is handed, while still rendering the REAL
// strip. `motion` keeps `layoutId` internal — it reaches no DOM attribute — so
// this seam is the only place the value is observable without asserting on
// geometry jsdom does not compute.
const { capturedIndicatorIds } = vi.hoisted(() => ({ capturedIndicatorIds: [] as string[] }));

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  const Real = actual.BarTabStrip;
  return {
    ...actual,
    BarTabStrip: (props: React.ComponentProps<typeof Real>) => {
      capturedIndicatorIds.push(props.indicatorLayoutId);
      return <Real {...props} />;
    },
  };
});

const mockOpenCreateDialog = vi.fn();
// Only the two the bar reads are replaced. The rest of the barrel stays REAL —
// the strip's overflow and reveal machinery lives there, and stubbing it would
// mean testing a tab strip this file invented rather than the one that ships.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useIsMobile: () => mockIsMobile,
  useAgentCreationStore: (selector: (s: { open: () => void }) => unknown) =>
    selector({ open: mockOpenCreateDialog }),
}));

vi.mock('@/layers/features/top-nav', () => ({
  CommandPaletteTrigger: () => (
    <button data-testid="command-palette-trigger" aria-label="Open command palette">
      Cmd
    </button>
  ),
}));
// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  mockIsMobile = false;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VIEW_LABELS = ['Cards', 'Table', 'Topology', 'Denied', 'Access'] as const;

/**
 * Mount the bar inside a router that really serves `/team`, so the links'
 * `href`s are the ones the app would build and clicking one moves the URL.
 */
function renderTeamBar(
  viewMode: TeamViewMode = 'cards',
  initialUrl = '/team',
  indicatorLayoutId?: string
): AnyRouter {
  const rootRoute = createRootRoute({
    staticData: { header: null },
    component: () => (
      <>
        <BarHarness teamViewMode={viewMode}>
          <TeamHeader indicatorLayoutId={indicatorLayoutId} />
        </BarHarness>
        <Outlet />
      </>
    ),
  });
  const teamRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/team',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <div data-testid="page">team</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([teamRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(<RouterProvider router={router} />);
  return router as unknown as AnyRouter;
}

const strip = () => screen.getByTestId('team-views');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('titles the page Team', async () => {
    renderTeamBar();
    await screen.findByTestId('page');
    // A <span>, queried as one so it does not collide with a view-switch tab
    // that happens to share a word.
    expect(screen.getByText('Team', { selector: 'span' })).toBeInTheDocument();
  });

  it('clicking New Agent calls useAgentCreationStore.open()', async () => {
    renderTeamBar();
    await screen.findByTestId('page');
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(mockOpenCreateDialog).toHaveBeenCalledTimes(1);
  });

  describe('view switcher', () => {
    it('renders the five views and the group rule, in order', async () => {
      renderTeamBar();
      await screen.findByTestId('page');

      // Six entries: five links and the hairline that splits the three ways of
      // reading the roster from the two rules surfaces. Asserted as a sequence
      // so a divider drawn in the wrong place cannot pass.
      const entries = [...strip().children].map((el) =>
        el.getAttribute('data-slot') === 'bar-tab-strip-divider' ? '│' : el.textContent
      );
      expect(entries).toEqual(['Cards', 'Table', 'Topology', '│', 'Denied', 'Access']);
    });

    it('points every view at /team?view=<mode>', async () => {
      renderTeamBar();
      await screen.findByTestId('page');

      for (const label of VIEW_LABELS) {
        expect(screen.getByRole('link', { name: label })).toHaveAttribute(
          'href',
          `/team?view=${label.toLowerCase()}`
        );
      }
    });

    it('clicking a view writes ?view= to the URL', async () => {
      const router = renderTeamBar('cards');
      await screen.findByTestId('page');

      fireEvent.click(screen.getByRole('link', { name: 'Topology' }));

      await waitFor(() => {
        expect(router.state.location.search).toEqual({ view: 'topology' });
      });
    });

    it('keeps the rest of the search params when the view changes', async () => {
      // The owner filter survives a view change: the same people are still the
      // subject, drawn a different way.
      const router = renderTeamBar('cards', '/team?view=cards&owner=person-1');
      await screen.findByTestId('page');

      fireEvent.click(screen.getByRole('link', { name: 'Table' }));

      await waitFor(() => {
        expect(router.state.location.search).toEqual({ view: 'table', owner: 'person-1' });
      });
    });

    it.each(VIEW_LABELS)('marks %s active when it is the view showing', async (label) => {
      renderTeamBar(label.toLowerCase() as TeamViewMode);
      await screen.findByTestId('page');

      expect(screen.getByRole('link', { name: label })).toHaveAttribute('data-active');
      for (const other of VIEW_LABELS.filter((l) => l !== label)) {
        expect(screen.getByRole('link', { name: other })).not.toHaveAttribute('data-active');
      }
    });
  });

  describe('the active marker', () => {
    it('defaults to one layout id, and lets a caller mounting several override it', async () => {
      // `motion` treats a `layoutId` as global, so two bars sharing one are the
      // same element to it and their underlines collapse onto a single box —
      // which is what the dev playground's eight bars did. jsdom cannot measure
      // the resulting rects, so what is pinned here is the input that decides
      // them: the id is per-instance and the caller can make it unique.
      capturedIndicatorIds.length = 0;

      renderTeamBar();
      await screen.findByTestId('page');
      cleanup();

      renderTeamBar('cards', '/team', 'playground-team-cards');
      await screen.findByTestId('page');
      // Asserted through the prop's observable effect rather than the prop
      // itself: two renders, two different ids reaching the strip.
      expect(capturedIndicatorIds).toEqual(['team-view-tabs', 'playground-team-cards']);
    });
  });

  describe('on a phone', () => {
    it('offers the same five views — no Select, nothing withheld', async () => {
      mockIsMobile = true;
      renderTeamBar();
      await screen.findByTestId('page');

      // The `<Select>` collapse is gone. It hid the table view behind a width
      // check and went blank on any view it did not list; the strip scrolls
      // instead, so every view stays reachable at 390px.
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      for (const label of VIEW_LABELS) {
        expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
      }
    });

    it('collapses New Agent to a labelled icon', async () => {
      mockIsMobile = true;
      renderTeamBar();
      await screen.findByTestId('page');

      const button = screen.getByRole('button', { name: 'New agent' });
      // Still reachable by name (the icon carries the aria-label), but the words
      // are gone — that is the width the phone gets back.
      expect(button).not.toHaveTextContent('New agent');
    });

    it('spells the words out on a desktop', async () => {
      renderTeamBar();
      await screen.findByTestId('page');
      expect(screen.getByRole('button', { name: /new agent/i })).toHaveTextContent('New agent');
    });
  });
});
