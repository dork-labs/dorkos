import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UnattendedAutonomyState } from '@dorkos/shared/permission-semantics';
import { useTransport, useEventSubscription } from '@/layers/shared/model';

/** Query key for the unattended-autonomy aggregate. */
const UNATTENDED_AUTONOMY_KEY = ['unattended-autonomy'] as const;

/**
 * How long the answer is trusted without asking again. Long, because the two
 * SSE signals below are the real freshness mechanism; this only backstops a
 * change made outside the cockpit — a `bindings.json` edited by hand, which
 * hot-reloads the store without a broadcast.
 */
const STALE_TIME_MS = 60_000;

/**
 * Every live binding and scheduled task currently set to run without asking.
 *
 * ## Why this is one aggregate and not two lists
 *
 * The standing banner has to be right on every route, and the honest inputs —
 * the binding list and the task list — are two full fetches that most routes
 * have no other use for. Asking for them app-wide is what kept this banner
 * unbuilt (spec `trust-dial`, "Follow-ups opened by the implementation"). The
 * server answers the question instead of shipping the evidence: two in-memory
 * filters, a handful of small objects, one fetch for the life of the page.
 *
 * Returns `undefined` until the first answer lands, which the banner treats as
 * "nothing to report" — a banner that flashes on during a page load and off
 * again is worse than one that arrives a beat late.
 */
export function useUnattendedAutonomy(): UnattendedAutonomyState | undefined {
  const transport = useTransport();

  const { data } = useQuery({
    queryKey: [...UNATTENDED_AUTONOMY_KEY],
    queryFn: () => transport.getUnattendedAutonomy(),
    staleTime: STALE_TIME_MS,
  });

  return data;
}

/**
 * Keep the aggregate live off the three server signals that can change it.
 *
 * A binding or a task moving to Full autonomy is a deliberate act somebody just
 * performed, usually in this very window, so the banner has to appear as the
 * form closes rather than on the next reload. The same goes for the act that
 * makes it stop being true.
 *
 * - `relay_bindings_changed` — a binding created, edited, deleted, or orphaned.
 * - `tasks_changed` — a task created, edited, or deleted, by a person or by an
 *   agent through MCP.
 * - `relay_adapters_changed` — an integration connected or disconnected. This
 *   one is easy to leave out and it is the reason the banner was wrong: a
 *   switched-off integration makes every binding behind it inert, so the answer
 *   changes without a single binding row being touched.
 *
 * All three ride the unified `/api/events` stream; in the router-less embed the
 * transport source yields no generic events and these subscriptions are inert,
 * which is correct there — the embed has neither bindings nor tasks.
 *
 * Mount once near the app root, beside the other `*Sync` hooks.
 */
export function useUnattendedAutonomySync(): void {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [...UNATTENDED_AUTONOMY_KEY] });
  };

  useEventSubscription('relay_bindings_changed', invalidate);
  useEventSubscription('tasks_changed', invalidate);
  useEventSubscription('relay_adapters_changed', invalidate);
}
