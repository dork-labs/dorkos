/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactNode } from 'react';

// ── Mock page components ──────────────────────────────────────
function MockDashboard() {
  return <div data-testid="dashboard-page">Dashboard</div>;
}

function MockSession() {
  return <div data-testid="session-page">Session</div>;
}

function MockShell() {
  return (
    <div data-testid="app-shell">
      <Outlet />
    </div>
  );
}

// ── Route tree (mirrors router.tsx but with mock components) ──
const sessionSearchSchema = z.object({
  session: z.string().optional(),
  dir: z.string().optional(),
});

interface RouterContext {
  queryClient: QueryClient;
}

function buildRouteTree() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => <Outlet />,
    notFoundComponent: () => <div data-testid="not-found">404 — Page not found</div>,
  });

  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_shell',
    component: MockShell,
  });

  const indexRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/',
    component: MockDashboard,
    beforeLoad: ({ location }) => {
      const params = new URLSearchParams(location.searchStr);
      const session = params.get('session');
      if (session) {
        throw redirect({
          to: '/session',
          search: { session, dir: params.get('dir') ?? undefined },
        });
      }
    },
  });

  const sessionRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/session',
    validateSearch: zodValidator(sessionSearchSchema),
    component: MockSession,
  });

  return rootRoute.addChildren([shellRoute.addChildren([indexRoute, sessionRoute])]);
}

function renderWithRouter(initialUrl: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const memoryHistory = createMemoryHistory({ initialEntries: [initialUrl] });

  const router = createRouter({
    routeTree: buildRouteTree(),
    history: memoryHistory,
    context: { queryClient },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>
  );

  return { router, queryClient };
}

describe('Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders DashboardPage at /', async () => {
    renderWithRouter('/');

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    });
  });

  it('renders SessionPage at /session', async () => {
    renderWithRouter('/session');

    await waitFor(() => {
      expect(screen.getByTestId('session-page')).toBeInTheDocument();
    });
  });

  it('parses search params on /session', async () => {
    const { router } = renderWithRouter('/session?session=abc&dir=/path');

    await waitFor(() => {
      expect(screen.getByTestId('session-page')).toBeInTheDocument();
    });

    const currentLocation = router.state.location;
    expect(currentLocation.search).toEqual(
      expect.objectContaining({ session: 'abc', dir: '/path' })
    );
  });

  it('redirects /?session=abc to /session?session=abc', async () => {
    // beforeLoad reads location.searchStr from TanStack Router context (not window.location)
    const { router } = renderWithRouter('/?session=abc');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/session');
    });

    expect(router.state.location.search).toEqual(expect.objectContaining({ session: 'abc' }));
  });

  it('shows 404 for unknown routes', async () => {
    renderWithRouter('/unknown-route-that-does-not-exist');

    await waitFor(() => {
      expect(screen.getByTestId('not-found')).toBeInTheDocument();
    });

    expect(screen.getByText(/404/)).toBeInTheDocument();
  });
});
