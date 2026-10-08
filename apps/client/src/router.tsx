import { createRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { RouteErrorFallback, NotFoundFallback } from '@/layers/shared/ui';
import type { RouteHeader } from '@/layers/widgets/one-bar';
import { parseAppSearch, stringifyAppSearch } from '@/layers/shared/lib/router-search';
import { createCommunityRouteMemory } from './app/community-route-memory';
import { routeTree } from './routeTree.gen';
export * from './app/route-search';
export * from './app/session-route-loader';

/**
 * Create a configured TanStack Router instance with the full route tree.
 *
 * @param queryClient - The TanStack Query client to inject as router context
 * @param transport - The transport loaders reach the server through
 */
export function createAppRouter(queryClient: QueryClient, transport: Transport) {
  const router = createRouter({
    routeTree,
    context: { queryClient, transport },
    defaultPreload: 'intent',
    // Exact where TanStack's default is lossy (`?v=1.10` read as 1.1); see
    // `router-search.ts`. The app's own typed params read the same as before.
    parseSearch: parseAppSearch,
    stringifySearch: stringifyAppSearch,
    defaultErrorComponent: RouteErrorFallback,
    defaultNotFoundComponent: NotFoundFallback,
  });
  const rememberRoute = createCommunityRouteMemory(queryClient, transport);
  router.subscribe('onLoad', ({ toLocation }) => rememberRoute(toLocation));
  return router;
}

// ── Type registration ───────────────────────────────────────
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /**
   * Every route says what its bar is.
   *
   * TanStack makes `staticData` a REQUIRED route option the moment this
   * interface has a required member, so a route added without a `header` does
   * not compile — which is the whole point. Before this, header selection was a
   * `pathname` switch in `AppShell` that a new route never touched, so a route
   * with no case silently wore the dashboard's header (DOR-587, DOR-919).
   *
   * `null` is the honest answer for the routes that have no bar of their own:
   * the root, the two pathless layout routes, and `/agents`, which only
   * redirects. `AppShell` walks the match chain leaf-first and renders the first
   * non-null one.
   */
  interface StaticDataRouteOption {
    header: RouteHeader;
  }
}
