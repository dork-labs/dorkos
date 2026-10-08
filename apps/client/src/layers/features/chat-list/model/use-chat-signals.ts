/**
 * The live facts a chat list needs beside the session records: each chat's
 * coarse phase, and which chats have a prompt waiting on a person.
 *
 * All of it comes from sources the rest of the app already reads, so the list
 * says "needs you" exactly when Heads up does: the session list store's
 * lifecycle (`blocked`, `error`, `streaming`) and usage limit, and the
 * fleet-wide pending-prompt list (`entities/attention`). No new request is
 * made here.
 *
 * @module features/chat-list/model/use-chat-signals
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@dorkos/shared/types';
import { usePendingInteractions } from '@/layers/entities/attention';
import { sessionLimitDisplay, useSessionListStore } from '@/layers/entities/session';
import type { ChatSignals } from './build-chat-list';

/**
 * Read the live signals for `sessions`.
 *
 * **Lifecycle only, never activity.** The store's status objects carry the
 * live verb too; selecting them whole would re-render the list on every tool
 * call. The verb arrives at the leaf, through `SessionVerbLine`. The positional
 * array under `useShallow` hands back the previous reference whenever no phase
 * moved, which is what keeps the memo below stable.
 *
 * @param sessions - The chats the list shows.
 */
export function useChatSignals(sessions: readonly Session[]): ChatSignals {
  const phases = useSessionListStore(
    useShallow((state) => sessions.map((s) => state.statuses[s.id]?.lifecycle ?? null))
  );
  // Whether each chat ran out of usage and still needs you, positionally, by
  // the same rule the session header's account badge follows. The live limit
  // wins over the one the list row carried.
  const outOfUsage = useSessionListStore(
    useShallow((state) =>
      sessions.map(
        (s) =>
          sessionLimitDisplay(state.statuses[s.id]?.limit ?? s.status?.limit ?? null)
            ?.needsAction === true
      )
    )
  );
  const { interactions } = usePendingInteractions();

  const lifecycles = useMemo(() => {
    const out: Record<string, (typeof phases)[number]> = {};
    sessions.forEach((session, index) => {
      out[session.id] = phases[index] ?? null;
    });
    return out;
  }, [sessions, phases]);

  const waitingIds = useMemo(
    () => new Set(interactions.map((pending) => pending.sessionId)),
    [interactions]
  );

  const outOfUsageIds = useMemo(
    () => new Set(sessions.filter((_, index) => outOfUsage[index]).map((s) => s.id)),
    [sessions, outOfUsage]
  );

  return useMemo(
    () => ({ lifecycles, waitingIds, outOfUsageIds }),
    [lifecycles, waitingIds, outOfUsageIds]
  );
}
