/**
 * What "live" means for an agent, and the one place the sidebar answers it.
 *
 * Two surfaces ask the question and they must not answer it differently: the
 * agent row's "N live" chip counts live sessions it has never fetched, and the
 * session switcher sorts an agent's fetched sessions into Live now / Recent.
 * A chip saying "2 live" over a switcher showing one live row is the kind of
 * quiet disagreement that costs an operator their trust in the readout — and it
 * shipped once already, when the chip counted every live session by `cwd` and
 * the switcher's Live-now group counted only the human ones. Both now apply the
 * SAME two rules, in this module: live lifecycle, and human origin.
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
import type { SessionOrigin } from '@dorkos/shared/types';
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
          if (!isLiveLifecycle(s.statuses[id]?.lifecycle)) continue;
          // Presence first, THEN origin. `sessions[id]?.origin` would collapse
          // the two things `undefined` means here — "known session, unmarked,
          // therefore a conversation" and "no metadata, origin unknowable" —
          // and counting the second as the first is exactly the over-count this
          // guard exists to prevent.
          const metadata = s.sessions[id];
          if (metadata === undefined) continue;
          if (!isConversation(metadata.origin)) continue;
          count += 1;
        }
        return count;
      },
      [agentPath]
    )
  );
}

/**
 * Whether a session is a conversation with a person, as opposed to something
 * that started on its own.
 *
 * **The chip is an attention badge, and automated work is not allowed to fire
 * one** — `design-decisions.md` §18, the Signal → Rendering table at line 353:
 * *"Automated session activity → Nothing. No bold, no badge."* Ruled explicitly
 * for this task and for BC-9's "N working" rollup at the same time, so the chip,
 * the switcher and the rollup share one definition of live.
 *
 * **The written contract does not carry this exclusion** — BC-9's text has none
 * — which is exactly why the reasoning lives here rather than being
 * re-litigated by the next reader.
 *
 * **The blocking carve-out is NOT weakened by this.** §353 continues "Blocking
 * states go to Heads up like the rest": an automated session that blocks still
 * raises an attention item, and it does so in the Heads up zone, which is a
 * different surface with a different rule. Only the LIVENESS count excludes
 * automation.
 *
 * It is also what keeps the chip and the switcher telling the same story: the
 * switcher's "Live now" group is built from
 * `partitionSessionsByOrigin(...).conversations`, so a chip that counted a
 * scheduled run would promise a live row the switcher then refuses to draw —
 * two nightly tasks rendering a green "2 live" over a dialog whose only content
 * is a collapsed "+ 2 automated".
 *
 * **Unknown origin does not count**, and the asymmetry is deliberate. The
 * session-list store learns an origin from `session_upserted`; until it has one
 * there is no honest way to tell a conversation from a task. Under-counting
 * costs a chip that appears a beat late — the row still carries its status dot
 * — while over-counting breaks a locked rule. The cheaper mistake wins.
 *
 * Absent means `user` — the unmarked default the whole origin vocabulary is
 * built on — so this must accept it, exactly as `partitionSessionsByOrigin`
 * does. The two are the same rule read from two sides, and a test pins them
 * together.
 *
 * @param origin - The session's origin, absent for the ordinary human case.
 */
function isConversation(origin: SessionOrigin | undefined): boolean {
  return origin === undefined || origin === 'user';
}
