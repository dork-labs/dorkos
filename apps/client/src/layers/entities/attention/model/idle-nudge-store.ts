/**
 * Idle nudges the operator has waved away, for as long as this window lives
 * (BC-10).
 *
 * **Deliberately not persisted config.** An idle episode's id does not survive
 * a restart meaningfully — the session goes quiet again and the next episode is
 * a different one — so writing dismissals to `~/.dork/config.json` would
 * accumulate ids nothing ever reads or prunes, forever. The accepted cost is
 * stated in the contract itself: a restart may re-surface at most one nudge.
 *
 * @module entities/attention/model/idle-nudge-store
 */
import { create } from 'zustand';

/** The dismissed set, and the one act that grows it. */
interface IdleNudgeState {
  /**
   * Ids of the idle nudges waved away in this window.
   *
   * A `Set` rather than an array because the only question ever asked of it is
   * membership, and it is asked once per candidate on every rebuild.
   */
  dismissed: ReadonlySet<string>;
  /** Wave one away. Idempotent — dismissing twice is not an error. */
  dismiss: (signalId: string) => void;
  /** Forget every dismissal. Tests only; nothing in the product un-dismisses. */
  reset: () => void;
}

/**
 * The in-memory dismissal store.
 *
 * There is no `undismiss`: BC-42 rules out snooze, and a nudge the operator
 * waved away comes back only when the agent does something worth saying — which
 * is a new episode with a new id, not this one returning.
 */
export const useIdleNudgeStore = create<IdleNudgeState>((set) => ({
  dismissed: new Set<string>(),
  dismiss: (signalId) =>
    set((state) => {
      if (state.dismissed.has(signalId)) return state;
      const next = new Set(state.dismissed);
      next.add(signalId);
      return { dismissed: next };
    }),
  reset: () => set({ dismissed: new Set<string>() }),
}));

/**
 * Wave an idle nudge away from outside React.
 *
 * The sidebar's row menus are built in render and fire in event handlers, so
 * they reach the store through this rather than subscribing to it — a row that
 * subscribed would re-render every time any OTHER nudge was dismissed.
 *
 * @param signalId - The nudge's {@link AttentionSignal.id}.
 */
export function dismissIdleNudge(signalId: string): void {
  useIdleNudgeStore.getState().dismiss(signalId);
}
