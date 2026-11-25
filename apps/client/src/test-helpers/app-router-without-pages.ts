/**
 * The app's router as `main.tsx` builds it, without its pages.
 *
 * Every page is a code-split chunk (`autoCodeSplitting` in `router-plugin.ts`),
 * and a load or navigation does not settle until the router has imported the
 * chunks of the routes it matched. The first `/_shell` match compiles the whole
 * app shell cold: about 2 s of a test's 5 s budget on an idle laptop, and all of
 * it on a busy CI shard. A suite that reads the router's state and renders
 * nothing through it drops the pages, and keeps what it is testing: the real
 * route tree, the app's search parsing, each route's `beforeLoad` and loaders.
 *
 * The route tree is the calling file's own module instance (Vitest isolates
 * each file), so no other suite sees the change. Every router that file builds
 * after the first call has no pages either: use it only in a file that never
 * renders a page through the router.
 *
 * @module test-helpers/app-router-without-pages
 */
import type { QueryClient } from '@tanstack/react-query';
import type { AnyRoute } from '@tanstack/react-router';
import type { Transport } from '@dorkos/shared/transport';
import { createAppRouter } from '../router';

/**
 * Build the app router with every route's page component removed.
 *
 * @param queryClient - The query client the routes' loaders read and fill
 * @param transport - The transport the routes' loaders call
 * @returns The router, with the real routes' search, `beforeLoad` and loaders
 */
export function createAppRouterWithoutPages(
  queryClient: QueryClient,
  transport: Transport
): ReturnType<typeof createAppRouter> {
  const router = createAppRouter(queryClient, transport);
  for (const route of Object.values(router.routesById) as AnyRoute[]) {
    delete route.options.component;
  }
  return router;
}
