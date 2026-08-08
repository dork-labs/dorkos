/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { mergeDialogSearch } from '@/layers/shared/model';

import { TourHost } from '../ui/TourHost';
import { TOUR_DEFINITIONS, type TourDefinition } from '../model/tour-definitions';

vi.mock('../model/use-tour-occasions', () => ({ useTourOccasions: () => {} }));

const runTour = vi.fn();
let mockRunningDefinition: TourDefinition | null = null;
vi.mock('../model/use-tours', () => ({
  useTours: () => ({
    runningDefinition: mockRunningDefinition,
    activeIndex: 0,
    advanceStep: vi.fn(),
    endTour: vi.fn(),
    runTour,
  }),
}));

// Only the app store is stubbed. `useSettingsDeepLink` stays real, so a
// settings-tab tour is judged by the tab it actually lands on rather than by
// the fact that some action fired (DOR-484).
const clearRequestedTour = vi.fn();
let mockRequestedTour: string | null = null;
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ requestedTour: mockRequestedTour, clearRequestedTour }),
  };
});

vi.mock('@/layers/shared/ui', () => ({
  TourSpotlight: (props: { activeIndex: number }) => (
    <div data-testid="spotlight" data-active={props.activeIndex} />
  ),
}));

// ── Router harness ───────────────────────────────────────────
//
// Tour deep links are real navigations — a route change or a `?settings=` write.
// Both routes validate the dialog params the way every real leaf route does
// (`mergeDialogSearch`); without that, validation would strip `?settings=` and
// the settings-tab assertion would prove nothing.

type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';

const searchSchema = mergeDialogSearch(z.object({}));

function buildHarness(initialUrl: string) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: () => <TourHost />,
  });
  const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    validateSearch: zodValidator(searchSchema),
    component: () => <TourHost />,
  });
  const connectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/connections',
    validateSearch: zodValidator(searchSchema),
    component: () => <TourHost />,
  });
  const history = createMemoryHistory({ initialEntries: [initialUrl] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute, connectionsRoute]),
    history,
  });

  const actions: HistoryActionType[] = [];
  history.subscribe(({ action }) => actions.push(action.type));

  return {
    router,
    actions,
    readSettingsTab: () => (router.state.location.search as { settings?: string }).settings,
  };
}

/** Mount TourHost on `initialUrl`, with the harness's action log starting clean. */
async function renderHost(initialUrl = '/') {
  const harness = buildHarness(initialUrl);
  await harness.router.load();
  harness.actions.length = 0;
  const view = render(<RouterProvider router={harness.router} />);
  await waitFor(() => expect(harness.router.state.status).toBe('idle'));
  return { ...harness, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunningDefinition = null;
  mockRequestedTour = null;
});

afterEach(() => cleanup());

describe('TourHost', () => {
  it('renders nothing when no tour is running', async () => {
    const { queryByTestId } = await renderHost();
    expect(queryByTestId('spotlight')).toBeNull();
  });

  it('starts a requested tour but HOLDS the request until it is running (deferred, never dropped)', async () => {
    // The request is set, but the engine has not started the tour yet.
    mockRequestedTour = 'general';
    mockRunningDefinition = null;
    await renderHost();

    // It starts the tour, but does NOT clear the request — so a settling
    // re-render that interrupts before the start commits cannot drop it.
    expect(runTour).toHaveBeenCalledWith('general');
    expect(clearRequestedTour).not.toHaveBeenCalled();
  });

  it('clears the request once the tour is actually running', async () => {
    mockRequestedTour = 'general';
    mockRunningDefinition = TOUR_DEFINITIONS.general; // running now reflects the request
    await renderHost();

    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('a re-render while the request is still pending never clears it', async () => {
    mockRequestedTour = 'general';
    mockRunningDefinition = null;
    const { rerender, router } = await renderHost();
    expect(runTour).toHaveBeenCalledTimes(1);
    expect(clearRequestedTour).not.toHaveBeenCalled();

    // A settling re-render lands while the tour has not started yet — the request
    // must survive it (this is the case that used to drop the launch).
    rerender(<RouterProvider router={router} />);
    expect(clearRequestedTour).not.toHaveBeenCalled();
  });

  it('ignores an unknown requested tour id but still clears it', async () => {
    mockRequestedTour = 'nope';
    await renderHost();
    expect(runTour).not.toHaveBeenCalled();
    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('deep-links a route tour (when not already there) and renders the spotlight', async () => {
    mockRunningDefinition = TOUR_DEFINITIONS.tasks; // route: /tasks
    const harness = await renderHost('/'); // not on /tasks yet
    await waitFor(() => expect(harness.router.state.location.pathname).toBe('/tasks'));
    expect(harness.getByTestId('spotlight')).toBeInTheDocument();
  });

  it('does not re-navigate when already on the target route (no redundant remount)', async () => {
    mockRunningDefinition = TOUR_DEFINITIONS.general; // route: /
    const harness = await renderHost('/'); // already home
    expect(harness.actions).toEqual([]);
  });

  it('takes the messaging tour to the page that surface now lives on', async () => {
    mockRunningDefinition = TOUR_DEFINITIONS.relay; // route: /connections
    const harness = await renderHost();
    // The tour's only step is anchored inside the Messaging region, so landing
    // anywhere else would spotlight nothing.
    await waitFor(() => expect(harness.router.state.location.pathname).toBe('/connections'));
  });

  it('takes the fleet tour to the Team page, where the roster it spotlights is', async () => {
    mockRunningDefinition = TOUR_DEFINITIONS.mesh; // route: /team
    const harness = await renderHost();
    await waitFor(() => expect(harness.router.state.location.pathname).toBe('/team'));
    // It opens no dialog on the way: the roster is the page, not a panel over it.
    expect(harness.readSettingsTab()).toBeUndefined();
  });
});
