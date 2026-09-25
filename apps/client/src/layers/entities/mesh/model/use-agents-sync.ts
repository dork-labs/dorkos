/**
 * Keep every window's agent list honest the moment an agent appears, is
 * renamed, or goes.
 *
 * @module entities/mesh/model/use-agents-sync
 */
import {
  useEventSubscription,
  useCoalescedInvalidation,
  type QueryInvalidation,
} from '@/layers/shared/model';

/**
 * Every cache an agent's identity can move, spelled as literals.
 *
 * Literals rather than the key factories they mirror, for the reason
 * `use-mesh-update.ts` gives at length: `entities/agent` already imports this
 * slice, so reaching back for `agentKeys.all` would close a cycle, and
 * `import-x/no-cycle` runs at `error` over `entities/**`. `['team']` is a
 * sibling entity's constant and may not be imported at all. Each prefix is one
 * or two segments and the set is pinned by this slice's test, which is the
 * cheaper of the two ways to keep two spellings honest.
 *
 * - `['mesh']` — a PREFIX on purpose. The sidebar's rows come from
 *   `['mesh','agent-paths']`, the Team page from `['mesh','agents']`, and
 *   status, topology and per-agent health all sit under the same root; a
 *   registration can move any of them.
 * - `['agents']` — also a prefix, covering both `agentKeys.resolved` and
 *   `agentKeys.byPath`, which is where the status bar reads the manifest a new
 *   session will run under.
 * - `['team']` — also a prefix, matching what `useRegisterAgent`,
 *   `useUnregisterAgent` and `useDeleteAgentData` already sweep. `entities/team`
 *   nests one member's rooms under it deliberately, and says so: everything
 *   that invalidates the roster can change who is in a room, "so a prefix match
 *   refreshing both is the behaviour rather than a side effect". An earlier cut
 *   of this file pinned it `exact` on the theory that a prefix would reset a
 *   live list — it would not; invalidation marks stale and refetches, it does
 *   not clear. Nothing writes THROUGH this prefix (`setQueriesData` over a
 *   mixed-shape family would be the real trap), which is what makes it safe.
 */
const AGENT_IDENTITY_CACHES: readonly QueryInvalidation[] = [
  { queryKey: ['mesh'] },
  { queryKey: ['agents'] },
  { queryKey: ['team'] },
];

/**
 * Trailing-edge coalescing window (ms).
 *
 * A scan adopting a folder of agents, or a marketplace install registering
 * several at once, arrives as a burst of `agents_changed`; one flush for the
 * burst is all any of these caches needs. Short enough that a person who just
 * asked DorkBot to register a project sees the row appear as part of the same
 * moment.
 */
const COALESCE_MS = 400;

/**
 * Follow `agents_changed` on the unified `/api/events` stream.
 *
 * The server broadcasts it once per committed identity write at the mesh
 * registry seam, so EVERY path that registers, renames or removes an agent is
 * covered by construction: the HTTP routes, the in-session and external
 * `mesh_register` / `mesh_unregister` tools, `create_agent`, a marketplace
 * install, an agent editing itself, and the five-minute reconciler adopting a
 * `.dork/agent.json` it found on disk.
 *
 * Without it the sidebar drew its rows from a 30-second stale time that only
 * refetches on window focus or a stream reconnect — so an agent registered from
 * a terminal, from a second window, or by DorkBot in the window you were
 * looking at simply was not there, and DorkBot took to telling people to
 * refresh the page (DOR-2052).
 *
 * @param coalesceMs - Debounce window in milliseconds (default
 *   {@link COALESCE_MS}); parameterised for deterministic testing.
 */
export function useAgentsSync(coalesceMs: number = COALESCE_MS): void {
  const schedule = useCoalescedInvalidation({ coalesceMs });

  useEventSubscription('agents_changed', () => schedule(AGENT_IDENTITY_CACHES));
}

export { AGENT_IDENTITY_CACHES };
