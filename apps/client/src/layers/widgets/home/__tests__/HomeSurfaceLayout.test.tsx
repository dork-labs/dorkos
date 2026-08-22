/**
 * @vitest-environment jsdom
 *
 * What is left of the home surface layout once its tabs moved into the bar.
 *
 * The tab-strip assertions this file used to carry live in
 * `widgets/one-bar/__tests__/HomeSurfaceBar.test.tsx` now — same claims, one row
 * up. What stays here is the claim that matters at this seam: the four pages
 * render through this layout, and it draws no header row of its own. A second
 * tab row reappearing under the bar is the regression phase H1 exists to
 * prevent, and it is invisible to a suite that only looks at the bar.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { HomeSurfaceLayout } from '../ui/HomeSurfaceLayout';

/** A stand-in page: this file is about the seam, not about what Activity draws. */
function page(name: string) {
  return function MockPage() {
    return <div data-testid={`${name}-page`}>{name}</div>;
  };
}

function renderAt(initialUrl: string) {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const homeSurfaceRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    id: '_home',
    component: HomeSurfaceLayout,
  });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => homeSurfaceRoute,
    path: '/',
    component: page('home'),
  });
  const workspacesRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => homeSurfaceRoute,
    path: '/workspaces',
    component: page('workspaces'),
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([homeSurfaceRoute.addChildren([indexRoute, workspacesRoute])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });

  // The test tree is not the app's registered router; the cast is only so the
  // provider's generic accepts it.
  render(<RouterProvider router={router as never} />);
  return router;
}

afterEach(() => {
  cleanup();
});

describe('HomeSurfaceLayout', () => {
  it('renders the page at the address it was asked for', async () => {
    renderAt('/workspaces');
    expect(await screen.findByTestId('workspaces-page')).toBeInTheDocument();
  });

  it('draws no tab row of its own — the bar carries them (phase H1)', async () => {
    renderAt('/');
    await screen.findByTestId('home-page');

    // Structural, not by label: a row that came back under a different name
    // would still be a second header row, which is the thing being prevented.
    expect(screen.queryByTestId('home-tabs')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="bar-tab-strip"]')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
