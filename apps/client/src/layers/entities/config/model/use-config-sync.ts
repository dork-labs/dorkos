/**
 * Keep every window's settings honest the moment they are written anywhere.
 *
 * @module entities/config/model/use-config-sync
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  useEventSubscription,
  useCoalescedInvalidation,
  CONFIG_WRITE_MUTATION_KEY,
  type QueryInvalidation,
} from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';

/**
 * Trailing-edge coalescing window (ms).
 *
 * A sidebar drag writes `ui.sidebar` several times in a second and each write
 * broadcasts, so the window has to outlast a gesture rather than fire inside
 * one.
 */
const COALESCE_MS = 500;

/**
 * Follow `config_changed` on the unified `/api/events` stream.
 *
 * Settings are one object behind one query key, so any section moving means the
 * same single refetch — there is nothing to filter on and the event's `sections`
 * are for readers who want to know WHAT moved, not for deciding whether to look.
 * This is what makes a sidebar section created in one window appear in the
 * other, and what makes `dorkos config set` or an agent's `config_patch` land
 * without anyone reloading (DOR-2052).
 *
 * **It stands down while this window is mid-write, and then catches up.** Every
 * config write in the entity layer carries {@link CONFIG_WRITE_MUTATION_KEY},
 * and the sidebar's is OPTIMISTIC: it paints the next state, sends the whole
 * `ui.sidebar`, and re-reads on settle. A drag is a rapid sequence of those, so
 * a refetch fired by the broadcast of an earlier write in the sequence would
 * answer with a state the later writes have already moved past, and the tail of
 * the gesture would appear to revert.
 *
 * The veto DEFERS rather than drops — see
 * {@link CoalescedInvalidationOptions.shouldFlush}, which holds the pending keys
 * and re-arms. It has to: three config mutations invalidate on `onSuccess`
 * alone, so "the mutation will re-read anyway" is false for a REFUSED write, and
 * a dropped broadcast would leave this window showing a value nothing corrects.
 *
 * Mount once near the app root, beside the other `*Sync` hooks. In embedded
 * mode (Obsidian) the in-process transport yields no generic events, so the
 * subscription is an inert no-op there.
 *
 * @param coalesceMs - Debounce window in milliseconds (default
 *   {@link COALESCE_MS}); parameterised for deterministic testing.
 */
export function useConfigSync(coalesceMs: number = COALESCE_MS): void {
  const queryClient = useQueryClient();
  const schedule = useCoalescedInvalidation({
    coalesceMs,
    // Asked at FLUSH time, not when the event arrives: a gesture that is still
    // going when the first broadcast lands is exactly the case this protects.
    shouldFlush: () => queryClient.isMutating({ mutationKey: CONFIG_WRITE_MUTATION_KEY }) === 0,
  });

  useEventSubscription('config_changed', () => {
    const target: QueryInvalidation = { queryKey: configKeys.current() };
    schedule([target]);
  });
}
