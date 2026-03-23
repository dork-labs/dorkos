import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';
import { AppShell } from './AppShell';
import { DashboardPage } from '@/layers/widgets/dashboard';
import { SessionPage } from '@/layers/widgets/session';
import { AgentsPage } from '@/layers/widgets/agents';
import type { Session } from '@dorkos/shared/types';

// ── Router context ──────────────────────────────────────────
interface RouterContext {
  queryClient: QueryClient;
}

// ── Root route (minimal — just Outlet) ──────────────────────
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => <div>404 — Page not found</div>,
});

// ── Pathless layout route (app shell) ───────────────────────
// Uses `id` not `path` — no URL segment added.
// Sidebar, header, dialogs, toaster render here.
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
});

// ── Search param schemas ────────────────────────────────────
const sessionSearchSchema = z.object({
  session: z.string().optional(),
  dir: z.string().optional(),
});

/** Search params available on the `/session` route. */
export type SessionSearch = z.infer<typeof sessionSearchSchema>;

const dashboardSearchSchema = z.object({
  detail: z.enum(['dead-letter', 'failed-run', 'offline-agent']).optional(),
  itemId: z.string().optional(),
});

/** Search params available on the `/` (dashboard) route. */
export type DashboardSearch = z.infer<typeof dashboardSearchSchema>;

const agentsSearchSchema = z.object({
  view: z.enum(['list', 'topology']).optional().default('list'),
});

/** Search params available on the `/agents` route. */
export type AgentsSearch = z.infer<typeof agentsSearchSchema>;

// ── Dashboard at / ──────────────────────────────────────────
const indexRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  validateSearch: zodValidator(dashboardSearchSchema),
  component: DashboardPage,
  // Redirect to /session if ?session= param is present (backward compat for old bookmarks)
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

// ── Session/chat at /session ────────────────────────────────

/**
 * Loader for the /session route. Redirects to the most recent cached session
 * or generates a speculative UUID when no session param is provided.
 *
 * @internal Exported for testing only.
 */
export function sessionRouteLoader({
  context: { queryClient },
  location,
}: {
  context: { queryClient: QueryClient };
  location: { searchStr: string };
}) {
  const params = new URLSearchParams(location.searchStr);
  const session = params.get('session');

  // Session already specified — nothing to do
  if (session) return;

  // Read cached session list (may be stale or empty on first load)
  const dir = params.get('dir') ?? undefined;
  const sessions = queryClient.getQueryData<Session[]>(['sessions', dir ?? null]);

  if (sessions && sessions.length > 0) {
    // Auto-select most recent session
    throw redirect({
      to: '/session',
      search: { session: sessions[0].id, dir },
      replace: true,
    });
  }

  // No sessions cached — generate a fresh UUID for a new session
  throw redirect({
    to: '/session',
    search: { session: crypto.randomUUID(), dir },
    replace: true,
  });
}

const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
  loader: sessionRouteLoader,
});

// ── Agents fleet management at /agents ──────────────────────
const agentsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/agents',
  validateSearch: zodValidator(agentsSearchSchema),
  component: AgentsPage,
});

// ── Route tree ──────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([indexRoute, sessionRoute, agentsRoute]),
]);

/**
 * Create a configured TanStack Router instance with the full route tree.
 *
 * @param queryClient - The TanStack Query client to inject as router context
 */
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
  });
}

// ── Type registration ───────────────────────────────────────
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
