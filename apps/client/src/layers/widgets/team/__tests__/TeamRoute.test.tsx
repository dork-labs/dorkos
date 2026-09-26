/**
 * @vitest-environment jsdom
 *
 * `TeamRoute`'s whole-page empty state against the query-restore pause
 * (DOR-1914). The table and topology views swap the page for "Bring in existing
 * projects" when the fleet is empty, and a paused query with no data yet is not
 * an empty fleet.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TeamRoute } from '../ui/TeamRoute';

/**
 * A router carrying the one route id `TeamRoute` reads its search from.
 *
 * `useSearch({ from: '/_shell/team' })` resolves by route id at runtime, so the
 * pathless `_shell` layout plus a `/team` child is the smallest tree that
 * answers it. The app's real `teamSearchSchema` lives in `router.tsx`, which
 * would drag the whole app shell into this test; `TeamRoute` narrows every
 * param it reads (`normalizeTeamView` for `view`), so the raw query string is
 * enough here.
 */
function buildTeamRouter(initialUrl: string) {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_shell',
    staticData: { header: null },
    component: () => <Outlet />,
  });
  const teamRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/team',
    staticData: { header: null },
    component: TeamRoute,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([shellRoute.addChildren([teamRoute])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
}

function renderTeamRoute({ view, isRestoring }: { view: string; isRestoring: boolean }) {
  const transport = createMockTransport({} as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = buildTeamRouter(`/team?view=${view}`);

  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={isRestoring}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </IsRestoringProvider>
      </QueryClientProvider>
    );
  }

  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );

  return { transport, router };
}

afterEach(() => {
  cleanup();
});

describe('TeamRoute — the empty-fleet invitation', () => {
  it('shows it once the topology answers with no agents', async () => {
    // The control for the test below: with no restore in flight, the same
    // harness and the same empty topology DO paint the invitation, so its
    // absence under restore is a statement about the restore window and not
    // about a page that never rendered.
    const { transport } = renderTeamRoute({ view: 'table', isRestoring: false });

    expect(await screen.findByText('Bring in existing projects')).toBeInTheDocument();
    expect(transport.getMeshTopology).toHaveBeenCalled();
  });

  it.each(['table', 'topology'])(
    'does not show it in the %s view while a persisted cache is restoring',
    async (view) => {
      // `IsRestoringProvider` is the context `PersistQueryClientProvider` sets
      // while its restore is in flight. Every query is paused under it: pending,
      // not fetching, so `isLoading` reads FALSE with nothing in hand, and the
      // bare `!isLoading` gate painted "Bring in existing projects" over an
      // install with a full fleet (DOR-1914).
      const { transport, router } = renderTeamRoute({ view, isRestoring: true });

      await waitFor(() => expect(router.state.status).toBe('idle'));
      expect(screen.getByRole('heading', { name: 'Team' })).toBeInTheDocument();

      expect(screen.queryByText('Bring in existing projects')).toBeNull();
      // Never called: the loading state above is read off `isRestoring`, not
      // off a real request that happened to still be in flight.
      expect(transport.getMeshTopology).not.toHaveBeenCalled();
    }
  );
});
