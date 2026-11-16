/**
 * Per-browser dismissals for schedule wrong-zone offers.
 *
 * @module features/tasks/model/wrong-timezone-dismissals
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface WrongTimezoneDismissalState {
  dismissed: Record<string, true>;
  dismiss: (taskId: string) => void;
}

/** Persistent task ids whose wrong-zone offer the person chose to keep. */
export const useWrongTimezoneDismissals = create<WrongTimezoneDismissalState>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: (taskId) => set((state) => ({ dismissed: { ...state.dismissed, [taskId]: true } })),
    }),
    {
      name: 'dorkos:wrong-timezone-dismissals-v1',
      storage: createJSONStorage(() => globalThis.localStorage),
      partialize: (state) => ({ dismissed: state.dismissed }),
    }
  )
);
