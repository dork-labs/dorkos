/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';
import { HomeSurfaceLayout } from '../ui/HomeSurfaceLayout';

// The pages are stand-ins: this file is about the tab bar and the layout seam,
// not about what Activity or Workspaces render. The real wiring — that these
// four routes hang off the layout in the shipped router — is pinned by
// `src/__tests__/home-surface-routes.test.ts`.
function page(name: string) {
  return function MockPage() {
    return <div data-testid={`${name}-page`}>{name}</div>;
  };
}

const activitySearchSchema = z.object({ categories: z.string().optional() });

function renderAt(initialUrl: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeSurfaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_home',
    component: HomeSurfaceLayout,
  });
  const indexRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/',
    component: page('home'),
  });
  const activityRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/activity',
    validateSearch: zodValidator(activitySearchSchema),
    component: page('activity'),
  });
  const tasksRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/tasks',
    component: page('tasks'),
  });
  const workspacesRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/workspaces',
    component: page('workspaces'),
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      homeSurfaceRoute.addChildren([indexRoute, activityRoute, tasksRoute, workspacesRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });

  // The test tree is not the app's registered router; the cast is only so the
  // provider's generic accepts it.
  render(<RouterProvider router={router as never} />);
  return router;
}

/**
 * The label of every tab this component is drawing as active.
 *
 * Deliberately NOT `aria-current`: `Link` sets that itself from its own route
 * matching, and its value wins over anything the component passes. Asserting on
 * it tests TanStack, not `resolveHomeTabId` — a resolver that returned `null`
 * for everything once passed all of these. `data-active` is the attribute this
 * component derives from the resolver, so it is the one that can fail.
 */
function activeTabLabels(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.hasAttribute('data-active'))
    .map((link) => link.textContent ?? '');
}

/** How many tabs are drawing the sliding underline. */
function indicatorCount(): number {
  return document.querySelectorAll('[data-slot="home-tab-indicator"]').length;
}

describe('HomeSurfaceLayout', () => {
  it('renders the four tabs in order', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Home',
      'Activity',
      'Scheduled',
      'Workspaces',
    ]);
  });

  it('labels the /tasks tab "Scheduled" and links it to /tasks', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getByRole('link', { name: 'Scheduled' })).toHaveAttribute('href', '/tasks');
  });

  it.each([
    ['/', 'Home', 'home'],
    ['/activity', 'Activity', 'activity'],
    ['/tasks', 'Scheduled', 'tasks'],
    ['/workspaces', 'Workspaces', 'workspaces'],
    // The router serves these spellings too — it tolerates a trailing slash and
    // matches case-insensitively — and reports the pathname back exactly as
    // typed. A hand-edited or copied link must still light its tab.
    ['/activity/', 'Activity', 'activity'],
    ['/tasks//', 'Scheduled', 'tasks'],
    ['/Activity', 'Activity', 'activity'],
  ])('draws exactly one tab active at %s', async (url, label, testId) => {
    renderAt(url);

    await screen.findByTestId(`${testId}-page`);
    expect(activeTabLabels()).toEqual([label]);
    expect(indicatorCount()).toBe(1);
  });

  it('keeps a deep link’s search params and still lands on the right tab', async () => {
    const router = renderAt('/activity?categories=session');

    await screen.findByTestId('activity-page');
    expect(activeTabLabels()).toEqual(['Activity']);
    expect(indicatorCount()).toBe(1);
    expect(router.state.location.search).toEqual(
      expect.objectContaining({ categories: 'session' })
    );
  });

  it('navigates to /tasks when the Scheduled tab is clicked', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    await screen.findByTestId('home-page');

    await user.click(screen.getByRole('link', { name: 'Scheduled' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(await screen.findByTestId('tasks-page')).toBeInTheDocument();
    expect(activeTabLabels()).toEqual(['Scheduled']);
  });
});
