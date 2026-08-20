/**
 * "What needs me right now?", answered once for the whole cockpit.
 *
 * The sidebar's Heads up zone and the home surface's triage header ask the same
 * question of the same sources; before this they each assembled their own
 * answer inside a feature the other could not import. This is the shared one.
 *
 * **Referential stability is a contract here, not a nicety.** The sidebar folds
 * this list into a snapshot that must not change identity when an agent calls a
 * tool (spec §H) — so every source is put behind a stability guard and the
 * result is memoized. A fresh array per render would rebuild the entire sidebar
 * every couple of seconds per working session.
 *
 * @module entities/attention/model/use-attention-signals
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useRecentSessions, useSessionListStore } from '@/layers/entities/session';
import type { AttentionSignal } from './attention-signal';
import { deriveAttentionSignals } from './derive-attention-signals';
import { usePendingApprovals } from './use-pending-approvals';
import { usePendingInteractions } from './use-pending-interactions';
import { usePendingScheduleApprovals } from './use-pending-schedule-approvals';

/** Shared empties, so an unanswered query never mints a fresh array identity. */
const NO_SESSIONS: readonly Session[] = [];
const NO_APPROVALS: readonly PendingApproval[] = [];

/**
 * Everything needing the operator, oldest source first and dismissals applied.
 *
 * Ordering is not decided here — {@link deriveAttentionSignals} returns
 * membership and the sidebar's `rankNowItems` decides priority (BC-6), so a
 * second consumer is free to order it differently without two orderings
 * disagreeing about what is in the list.
 */
export function useAttentionSignals(): readonly AttentionSignal[] {
  const { approvals } = usePendingApprovals();
  // The schedules an agent parked. A first-class signal since DOR-1391 rather
  // than a list each surface joined on afterwards — `useAttentionRows`, the
  // arrival watch behind the knock and the banner, and the sidebar's Heads up
  // zone each used to compose it separately, and three compositions of one
  // question are three chances to answer it differently.
  const { schedules } = usePendingScheduleApprovals();
  const recent = useRecentSessions();
  const sessions = recent.data?.sessions ?? NO_SESSIONS;

  // **Lifecycle only, never `activity`.** The status objects in the store carry
  // the live verb, so selecting them whole would put a new identity in front of
  // the memo on every tool call — the exact churn this hook exists to survive.
  const lifecycles = useSessionListStore(
    useShallow((state): Record<string, SessionLifecycle> => {
      const out: Record<string, SessionLifecycle> = {};
      for (const [id, status] of Object.entries(state.statuses)) out[id] = status.lifecycle;
      return out;
    })
  );

  // What every session in the fleet is blocked on — not just the one this window
  // attached to. `usePendingInteractions` holds a query cache, so the array
  // keeps its identity between renders and the memo below survives status churn.
  const { interactions } = usePendingInteractions();

  // The roster, for the one thing a signal needs from it: what to call the
  // agent. Both queries are ones the cockpit already holds, so this is a cache
  // read and the net request count is unchanged.
  const { data: meshData } = useMeshAgentPaths();
  const rawPaths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(rawPaths);
  const agentNames = useMemo(
    () => disambiguateDisplayNames(rawPaths, manifests ?? {}),
    [rawPaths, manifests]
  );

  return useMemo(
    () =>
      deriveAttentionSignals({
        approvals: approvals.length === 0 ? NO_APPROVALS : approvals,
        schedules,
        sessions,
        lifecycles,
        interactions,
        agentNames,
      }),
    [approvals, schedules, sessions, lifecycles, interactions, agentNames]
  );
}

/**
 * Whether {@link useAttentionSignals} has enough to be believed yet.
 *
 * A companion rather than a second return value, because the sidebar assigns
 * that array straight into its own snapshot and an object would not fit.
 *
 * Only the four QUERIES can be mid-first-load. The lifecycle map comes from the
 * session-list store, which is fed by the stream and is simply empty until it
 * is not — there is no "still loading" to report about a store. So a surface
 * gating an all-clear on this waits for the session listing, the approval
 * queue, the prompt queue and the schedule queue, which are the four reads that
 * make an empty list a lie rather than an answer.
 *
 * **The prompt queue is not optional here, and leaving it out was a real bug.**
 * `deriveAttentionSignals` reads a blocked session's PROMPT to decide both the
 * signal's kind and its id: with the prompt in hand the id is
 * `blocked:<interactionId>`, and without one it falls back to
 * `blocked:<sessionId>`. So during the window where sessions had resolved and
 * `usePendingInteractions` had not, this reported "believable" for a list in
 * which every blocked session carried a placeholder id — and the moment the
 * prompts landed, each of those ids CHANGED. Anything watching for arrivals saw
 * a departure and an arrival for an Ask that had been sitting there the whole
 * time, which is a knock and an OS banner for nothing (DOR-1385 review).
 */
export function useAttentionSignalsLoading(): boolean {
  const { isLoading: sessionsLoading } = useRecentSessions();
  const { isLoading: approvalsLoading } = usePendingApprovals();
  const { isLoading: interactionsLoading } = usePendingInteractions();
  const { isLoading: schedulesLoading } = usePendingScheduleApprovals();
  return sessionsLoading || approvalsLoading || interactionsLoading || schedulesLoading;
}
