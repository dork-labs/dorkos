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
import { HomeRoomPage } from './app/HomeRoomPage';
import { HomeSurfaceLayout } from '@/layers/widgets/home';
import { SessionPage } from '@/layers/widgets/session';
import { TeamRoute } from '@/layers/widgets/team';
import { ActivityPage } from '@/layers/widgets/activity';
import { TasksPage } from '@/layers/widgets/tasks';
import { ChannelsPage } from '@/layers/widgets/room-view';
import { WorkspacesPage } from '@/layers/widgets/workspaces';
import { ConnectionsPage } from '@/layers/widgets/connections';
import { MarketplacePage, MarketplaceSourcesPage } from '@/layers/widgets/marketplace';
import { FeedbackRequestsPage } from '@/layers/widgets/feedback-requests';
import { agentFilterSchema, ATTENTION_SORT_FIELD } from '@/layers/features/agents-list';
import { marketplaceSearchSchema } from '@/layers/features/marketplace';
import { onboardingStageSearchSchema } from '@/layers/features/onboarding';
import { mergeDialogSearch } from '@/layers/shared/model/dialog-search-schema';
import { RouteErrorFallback, NotFoundFallback } from '@/layers/shared/ui';
import { DEFAULT_TEAM_VIEW, LEGACY_TABLE_VIEW, TEAM_VIEWS } from '@/layers/shared/lib';
import { resolveSessionForCwd, SESSION_LOOKUP_FAILED_MESSAGE } from '@/layers/entities/session';
import type { Transport } from '@dorkos/shared/transport';

// ── Router context ──────────────────────────────────────────
interface RouterContext {
  queryClient: QueryClient;
  /**
   * The app's transport. Loaders that have to ask the server before they can
   * decide where to send you — `/session` resolving which conversation a
   * directory opens on — read it from here.
   */
  transport: Transport;
}

// ── Root route (minimal — just Outlet) ──────────────────────
// Validates the optional `?onboarding=` stage param here (not on a leaf route)
// so the first-run overlay, which renders above whatever route is active, can
// read and write it from anywhere. Root search params are inherited by every
// child route, so this never strips a leaf route's own params.
const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: zodValidator(onboardingStageSearchSchema),
  component: () => <Outlet />,
  notFoundComponent: NotFoundFallback,
});

// ── Pathless layout route (app shell) ───────────────────────
// Uses `id` not `path` — no URL segment added.
// Sidebar, header, dialogs, toaster render here.
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
  /**
   * Retire `?relay=open`.
   *
   * That param opened a dialog, on any route, that the Connections page has
   * replaced. Links to it are in bookmarks, tours and old release notes, so
   * rather than breaking them it lands on the half of the page that took the
   * dialog's job. Handled on the shell route because the param was never
   * route-specific.
   */
  beforeLoad: ({ search }) => {
    const { relay, ...rest } = search as { relay?: string } & Record<string, unknown>;
    if (!relay) return;
    throw redirect({
      to: '/connections',
      search: { ...rest, region: 'messaging' },
      replace: true,
    });
  },
});

// ── Search param schemas ────────────────────────────────────

/**
 * Search params for the `/session` route.
 *
 * `runtime` is the launch-time runtime selection (e.g. `?runtime=opencode`):
 * it is carried into the first message POST as the `runtime` hint that binds a
 * brand-new session to that runtime (first-write-wins server-side).
 *
 * `prompt` seeds the composer of a freshly-launched session — the "Run this
 * with…" re-run carries the original prompt into a new session bound to another
 * runtime (ADR-0255: a switch is always a fresh session, never a history
 * transplant), and any link (docs, CLI, a marketplace page) can open DorkOS with
 * the question already written. It applies to a conversation with no messages
 * and to nothing else: a prompt aimed at a session that already has history is
 * ignored, by the loader below AND by `useLaunchPrompt` (which is the guard that
 * still holds for a URL somebody typed with a `session` id already in it).
 *
 * `send=1` turns that seed into a turn: the composer is filled and then
 * submitted through the composer's own handler, exactly once. Spelled as the
 * single literal `'1'` and `.catch()`ed, so `?send=0` or `?send=please` is
 * ignored rather than throwing the route — and so nothing that is not an
 * explicit opt-in can ever start a turn on somebody's behalf. Both params are
 * dropped from the URL the moment they are consumed, so a refresh or a Back does
 * not re-issue them.
 *
 * `continuedFrom` is the `/clear` intent's "linked back" reference (DOR-109) —
 * the id of the session this fresh one continues from. A lightweight client-side
 * link recorded in the URL only; there is no DB column.
 *
 * @internal Exported for testing only.
 */
export const sessionSearchSchema = mergeDialogSearch(
  z.object({
    session: z.string().optional(),
    dir: z.string().optional(),
    runtime: z.string().optional(),
    prompt: z.string().optional(),
    send: z.literal('1').optional().catch(undefined),
    continuedFrom: z.string().optional(),
  })
);

/** Search params available on the `/session` route. */
export type SessionSearch = z.infer<typeof sessionSearchSchema>;

/**
 * Search params for `/` — the home tab, which renders the #team room.
 *
 * `detail` + `itemId` are the attention deep links: a row in the pinned triage
 * header addresses `/?detail=failed-run&itemId=…`, and that URL opens the same
 * sheet for whoever it is pasted to.
 *
 * `thread` is the room's own param, spelled exactly as `/channels` spells it
 * (`channelsSearchSchema`) and meaning exactly the same thing — the entry a
 * thread hangs off. Home IS a room, so a thread opened here needs an address
 * for the same reason one opened there does: a refresh, or a link handed to
 * somebody, has to land on it.
 *
 * There is deliberately no room `id`: home is #team and nothing else. The room
 * is found by its well-known key, so a renamed channel — or a URL somebody
 * edited — cannot point Home at a different conversation.
 *
 * `detail` `.catch()`es rather than throwing, for the reason `teamSearchSchema`
 * gives below and one more: this is the address the app OPENS on. A stale
 * bookmark naming a sheet that no longer exists must show the room with no
 * sheet over it, not a "Something went wrong" page with a raw Zod dump where
 * the cockpit should be.
 *
 * @internal Exported for testing only.
 */
export const homeSearchSchema = mergeDialogSearch(
  z.object({
    detail: z.enum(['dead-letter', 'failed-run', 'offline-agent']).optional().catch(undefined),
    itemId: z.string().optional(),
    thread: z.string().optional(),
  })
);

/** Search params available on the `/` (home) route. */
export type HomeSearch = z.infer<typeof homeSearchSchema>;

/**
 * Search params for `/team` — and, unchanged, for the `/agents` alias, so the
 * redirect hands on an object the destination has already validated.
 *
 * `view` accepts `'list'` and answers `'table'`. That is not politeness toward
 * an old spelling: `/agents?view=list` is an address this repo does not own —
 * the media-capture pipeline opens it by hand, and so do bookmarks and old
 * release notes — so it normalizes rather than 404s.
 *
 * `sort` and the `agentFilterSchema` params are retained from the route this
 * replaces: the table view is the same fleet table, and its filter bar reads
 * them straight out of the URL.
 *
 * **Every enum here `.catch()`es rather than throwing.** A URL is something a
 * person can hand-edit, a bookmark can preserve past a rename, and an old
 * release note can outlive. A value this route no longer knows is a stale
 * address, not a broken app, so it falls back to the default and shows the
 * roster — the same forgiving read `normalizeTeamView` documents. Without this
 * the route threw, and `?view=bogus` rendered a "Something went wrong" page
 * with a raw Zod dump on it.
 *
 * @internal Exported for testing only.
 */
export const teamSearchSchema = mergeDialogSearch(
  z
    .object({
      view: z.preprocess(
        (value) => (value === LEGACY_TABLE_VIEW ? 'table' : value),
        z.enum(TEAM_VIEWS).catch(DEFAULT_TEAM_VIEW)
      ),
      /** The filter chips: everyone, only people, only agents. */
      kind: z.enum(['all', 'people', 'agents']).catch('all'),
      /** A person's roster id — narrows to them and the agents they own. */
      owner: z.string().optional(),
      /** Whether agent cards cluster under the person they belong to. */
      group: z.enum(['none', 'manager']).catch('none'),
      /** The roster search box. */
      q: z.string().optional(),
      // No `member` param, despite spec §W2.1 listing one for the profile
      // drawer: the drawer shipped on the app-wide `?profile=` param that
      // `dialogSearchSchema` already merges in (§W3.2, DOR-977). A second
      // address for the same subject is one that can disagree with the first.
      //
      // Attention order is the table's default: the agents that need you lead,
      // and the rows group by state. Any other field flattens the groups.
      sort: z.string().optional().default(`${ATTENTION_SORT_FIELD}:asc`),
      agent: z.string().optional(), // selected agent ID for topology detail panel
    })
    .merge(agentFilterSchema.searchValidator)
);

const marketplaceRouteSearchSchema = mergeDialogSearch(marketplaceSearchSchema);

/** Search params available on the `/marketplace` route. */
export type MarketplaceSearch = z.infer<typeof marketplaceRouteSearchSchema>;

// ── Pathless layout route (home surface) ────────────────────
// Uses `id` not `path` — no URL segment added, so `/`, `/activity`, `/tasks`
// and `/workspaces` keep the exact addresses they have always had. All this
// route contributes is the tab bar above them and the fact that they are now
// one surface rather than four sidebar destinations. It declares no
// `validateSearch`, so each child keeps its own search schema untouched and a
// deep link like `/activity?categories=session` arrives with its filter intact.
const homeSurfaceRoute = createRoute({
  getParentRoute: () => appShellRoute,
  id: '_home',
  component: HomeSurfaceLayout,
});

// ── The #team room at / ─────────────────────────────────────
const indexRoute = createRoute({
  getParentRoute: () => homeSurfaceRoute,
  path: '/',
  validateSearch: zodValidator(homeSearchSchema),
  component: HomeRoomPage,
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
 * The search params {@link sessionRouteLoader} reads. Declaring them is what
 * makes the loader re-run when they change: without `loaderDeps` a loader runs
 * on entry to the route and never again, so navigating from
 * `/session?session=A&dir=X` to `/session?dir=Y` **within** `/session` left the
 * URL session-less — a page where the durable stream never attaches and the
 * composer cannot accept text. Dialog params (`?settings=`, `?agent=`) are
 * deliberately absent: opening a dialog must not re-run session selection.
 *
 * @internal Exported for testing only.
 */
export function sessionLoaderDeps({ search }: { search: SessionSearch }) {
  return {
    session: search.session,
    dir: search.dir,
    runtime: search.runtime,
    prompt: search.prompt,
    send: search.send,
  };
}

/** What {@link sessionRouteLoader} receives, mirroring {@link sessionLoaderDeps}. */
export type SessionLoaderDeps = ReturnType<typeof sessionLoaderDeps>;

/**
 * Loader for the /session route. Redirects to the directory's most recent
 * session, or to a fresh one when it genuinely has none.
 *
 * Reads its inputs from `deps` rather than re-parsing the URL, so the values it
 * acts on are exactly the ones {@link sessionLoaderDeps} declared — a param
 * read here but missing there would silently stop triggering a re-run.
 *
 * Resolution goes through the shared `resolveSessionForCwd`, the same answer
 * every other agent-switch surface uses. The loader used to decide for itself
 * from this tab's query cache, which meant a directory the window had never
 * displayed looked exactly like a directory with no conversations (DOR-928).
 *
 * @internal Exported for testing only.
 */
export async function sessionRouteLoader({
  context,
  deps,
}: {
  context: RouterContext;
  deps: SessionLoaderDeps;
}) {
  // Session already specified — nothing to do
  if (deps.session) return;

  const { dir, runtime } = deps;
  // `runtime` is the launch-time runtime selection: it must survive both
  // redirects below so the first message can carry it as the session's runtime
  // hint.
  //
  // `prompt` is the launch-time seed ("Run this with…", a docs try-it link),
  // carried ONLY when the session is brand-new so its composer is pre-filled —
  // and `send` with it, since a seed that must not ride an existing conversation
  // must certainly not START a turn on one. Both are deliberately dropped when
  // this resolves to a session that already exists (defense-in-depth atop
  // `useLaunchPrompt`'s empty-conversation guard).
  const resolved = await resolveSessionForCwd(context, dir ?? null);
  // The lookup failed. There is no "stay put" for a loader — this URL IS where
  // the person asked to be — so the honest move is the route's error boundary,
  // which says something went wrong and offers a retry. Redirecting to a minted
  // id would instead show a blank chat for an agent that may have work, which
  // is the defect this whole path exists to remove (DOR-928).
  if (resolved === null) {
    throw new Error(SESSION_LOOKUP_FAILED_MESSAGE);
  }

  throw redirect({
    to: '/session',
    search: {
      session: resolved.sessionId,
      dir,
      runtime,
      prompt: resolved.isNew ? deps.prompt : undefined,
      send: resolved.isNew ? deps.send : undefined,
    },
    replace: true,
  });
}

const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
  loaderDeps: sessionLoaderDeps,
  loader: sessionRouteLoader,
});

// ── Everyone on this install at /team ───────────────────────
const teamRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/team',
  validateSearch: zodValidator(teamSearchSchema),
  component: TeamRoute,
});

/**
 * `/agents` is an alias for `/team` and nothing else.
 *
 * AGENTS.md says a superseded thing is removed, and the page behind this path
 * was: every in-repo caller moved to `/team` in the same change. What survives
 * is for the addresses this repo does not control — a bookmark, a docs link,
 * a `dorkos://agents` deep link, and the Electron shell's persisted tab list,
 * which stores raw pathnames. A persisted tab pointing at a dead route is a
 * blank window on next launch.
 *
 * It validates with the same schema as its destination, so the search object it
 * hands on is already normalized (`?view=list` arrives at `/team` as
 * `?view=table`) and nothing is dropped on the way.
 */
const agentsAliasRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/agents',
  validateSearch: zodValidator(teamSearchSchema),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/team', search, replace: true });
  },
});

// ── Tasks at /tasks — the "Scheduled" tab ────────────────────
const tasksRoute = createRoute({
  getParentRoute: () => homeSurfaceRoute,
  path: '/tasks',
  component: TasksPage,
});

// ── Channels and DMs at /channels ────────────────────────────

/**
 * Search params for the `/channels` route.
 *
 * A room's identity travels as a search param, the same way `/session` carries
 * `?session=` rather than a path segment (`sessionSearchSchema` above). Discord
 * addresses a DM the same way, so `/channels?id=<dmId>` is precedented rather
 * than odd.
 *
 * Two params: the room, and the thread it has open beside it.
 *
 * `?thread=` is the entry a thread hangs off — NOT a room id, which is what the
 * same spelling meant under the retired threads-as-rooms model. That version
 * was dropped from this schema when a thread became a relation between entries
 * (ADR 260728-022013) and nothing read it in between; it is back because the
 * thread panel gave a thread somewhere to be, and a place needs an address so a
 * refresh or a shared link lands on it (design record §3).
 *
 * Optional, so every link that only names a room still works untouched.
 *
 * @internal Exported for testing only.
 */
export const channelsSearchSchema = mergeDialogSearch(
  z.object({
    id: z.string().optional(),
    thread: z.string().optional(),
  })
);

/** Search params available on the `/channels` route. */
export type ChannelsSearch = z.infer<typeof channelsSearchSchema>;

const channelsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/channels',
  validateSearch: zodValidator(channelsSearchSchema),
  component: ChannelsPage,
});

// ── Workspaces at /workspaces ────────────────────────────────
const workspacesRoute = createRoute({
  getParentRoute: () => homeSurfaceRoute,
  path: '/workspaces',
  component: WorkspacesPage,
});

// ── Connections at /connections ──────────────────────────────
/**
 * Which half of the page to scroll to. Not a tab: both regions are always
 * rendered, and this only says where to start.
 */
const connectionsSearchSchema = mergeDialogSearch(
  z.object({ region: z.enum(['messaging', 'accounts']).optional() })
);

const connectionsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/connections',
  validateSearch: zodValidator(connectionsSearchSchema),
  component: ConnectionsPage,
});

// ── Marketplace at /marketplace ─────────────────────────────────
const marketplaceRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/marketplace',
  validateSearch: zodValidator(marketplaceRouteSearchSchema),
  component: MarketplacePage,
});

// ── Marketplace sources at /marketplace/sources ──────────────
const marketplaceSourcesRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/marketplace/sources',
  component: MarketplaceSourcesPage,
});

// ── Activity feed at /activity ───────────────────────────────
const activitySearchSchema = mergeDialogSearch(
  z.object({
    categories: z.string().optional(),
    actorType: z.string().optional(),
    actorId: z.string().optional(),
    since: z.string().optional(),
  })
);

/** Search params available on the `/activity` route. */
export type ActivitySearch = z.infer<typeof activitySearchSchema>;

const activityRoute = createRoute({
  getParentRoute: () => homeSurfaceRoute,
  path: '/activity',
  validateSearch: zodValidator(activitySearchSchema),
  component: ActivityPage,
});

// ── Feedback & requests at /feedback-requests ────────────────
const feedbackRequestsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/feedback-requests',
  component: FeedbackRequestsPage,
});

// ── Route tree ──────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([
    homeSurfaceRoute.addChildren([indexRoute, activityRoute, tasksRoute, workspacesRoute]),
    sessionRoute,
    teamRoute,
    agentsAliasRoute,
    channelsRoute,
    connectionsRoute,
    marketplaceRoute,
    marketplaceSourcesRoute,
    feedbackRequestsRoute,
  ]),
]);

/**
 * Create a configured TanStack Router instance with the full route tree.
 *
 * @param queryClient - The TanStack Query client to inject as router context
 * @param transport - The transport loaders reach the server through
 */
export function createAppRouter(queryClient: QueryClient, transport: Transport) {
  return createRouter({
    routeTree,
    context: { queryClient, transport },
    defaultPreload: 'intent',
    defaultErrorComponent: RouteErrorFallback,
    defaultNotFoundComponent: NotFoundFallback,
  });
}

// ── Type registration ───────────────────────────────────────
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
