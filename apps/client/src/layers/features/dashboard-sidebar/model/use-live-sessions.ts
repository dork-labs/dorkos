/**
 * What "live" means for an agent, and the one place the sidebar answers it.
 *
 * Two surfaces ask the question and they must not answer it differently: the
 * agent row's "N live" chip counts live sessions it has never fetched, and the
 * session switcher sorts an agent's fetched sessions into Live now / Recent.
 * A chip saying "2 live" over a switcher showing one live row is the kind of
 * quiet disagreement that costs an operator their trust in the readout.
 *
 * **Neither hook subscribes to activity.** They read `lifecycle` only — the
 * coarse phase that changes when a turn starts and stops — so the verb churn
 * the sidebar is architected around (spec R1) never reaches them. The words
 * themselves arrive at the leaf, through `SessionVerbLine`.
 *
 * @module features/dashboard-sidebar/model/use-live-sessions
 */
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '@/layers/entities/session';

/**
 * Whether a lifecycle is one an operator would call "live".
 *
 * `streaming` is a turn producing output; `blocked` is a turn stopped on a
 * question for the operator. Both are turns IN FLIGHT — the work is not
 * finished and the row belongs under "Live now". `error` and `interrupted` are
 * not: they are outcomes, and an outcome belongs in Recent where the reader can
 * see what became of it.
 *
 * @param lifecycle - The session's coarse phase, or nothing when unknown.
 */
export function isLiveLifecycle(lifecycle: SessionLifecycle | null | undefined): boolean {
  return lifecycle === 'streaming' || lifecycle === 'blocked';
}

/**
 * The coarse phase of each session in `sessionIds`, positionally aligned.
 *
 * An array rather than a map, and `useShallow` rather than a raw selector: a
 * fresh object every render loops forever under zustand v5's
 * `useSyncExternalStore`, while an array of primitives compares element-wise and
 * hands back the previous reference whenever nothing actually moved. That is
 * what keeps an activity event — which writes the SAME lifecycle back onto the
 * status — from re-rendering the whole switcher to change four characters in
 * one row.
 *
 * @param sessionIds - The sessions to read, in the caller's own order.
 */
export function useSessionLifecycles(sessionIds: readonly string[]): (SessionLifecycle | null)[] {
  return useSessionListStore(
    useShallow((s) => sessionIds.map((id) => s.statuses[id]?.lifecycle ?? null))
  );
}

/**
 * How many of an agent's sessions are live right now.
 *
 * Counted by `cwd` match against the fleet-wide status fan-out, NOT from a
 * session list — which is the whole reason a collapsed agent row can carry the
 * chip at all. The sidebar fetches session metadata for the agent you are
 * looking at and nobody else, but `session_status` carries every live session's
 * directory regardless, so the count is available for all sixty rows at the
 * cost of one store read each. (Same mechanism as `useAgentHottestStatus`,
 * which needs it for the same reason.)
 *
 * A number, so the subscription settles on a primitive: the count changes when
 * a turn starts or stops and at no other time.
 *
 * @param agentPath - The agent's project directory.
 */
export function useLiveSessionCount(agentPath: string): number {
  return useSessionListStore(
    useCallback(
      (s) => {
        let count = 0;
        for (const [id, cwd] of Object.entries(s.statusCwds)) {
          if (cwd !== agentPath) continue;
          if (isLiveLifecycle(s.statuses[id]?.lifecycle)) count += 1;
        }
        return count;
      },
      [agentPath]
    )
  );
}
