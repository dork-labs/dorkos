/**
 * What "live" means for the session switcher, and the one place it is answered.
 *
 * **Neither export subscribes to activity.** They read `lifecycle` only — the
 * coarse phase that changes when a turn starts and stops — so the verb churn
 * the sidebar is architected around (spec R1) never reaches them. The words
 * themselves arrive at the leaf, through `SessionVerbLine`.
 *
 * **The agent row's "N live" chip is NOT here, and it asks a different
 * question.** The chip reads `SidebarRowModel.liveCount`, which
 * `rules/live-sessions.ts` counts off `state.workingSessionIds` — turns that
 * are STREAMING. {@link isLiveLifecycle} below is wider: it also admits
 * `blocked`, so the switcher's "Live now" group holds a turn that has stopped
 * to ask the operator something.
 *
 * **They part on purpose, and the split is the honest one.** The chip is a busy
 * signal — "this agent is producing output in more than one place, here is the
 * door to those places" — and a turn waiting on an answer is not producing
 * anything; counting it would say an agent is busy when what it is, is stuck.
 * The switcher is a list of open turns, and a blocked one is open: closing it
 * is the whole reason somebody would go there. The blocked turn is not lost
 * either way, and that is what makes the narrower chip safe — it raises an
 * attention item in Heads up, which is the zone that exists for exactly it, and
 * the row's own dot goes to needs-you.
 *
 * So a chip reading "2 live" over a switcher listing three rows under Live now
 * is correct, not drift. What WOULD be drift is the two disagreeing about
 * origin, and they cannot: both exclude automated work through
 * `partitionSessionsByOrigin` — the switcher directly, the chip through
 * `humanOriginSessionIds`, which is built from it. A second origin rule lived
 * in this module once and did disagree (DOR-1137).
 *
 * @module features/dashboard-sidebar/model/use-live-sessions
 */
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
