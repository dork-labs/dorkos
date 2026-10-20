/**
 * The one door into the Work tab, and the turn the press asked for (DOR-3075).
 *
 * Show work under a reply and Watch on a live line both call
 * {@link openWorkPanel}: two writes to the shell's store to open the panel on
 * the tab, and one to this store saying which turn to scroll to.
 *
 * @module widgets/session/model/work-panel-focus
 */
import { create } from 'zustand';
import { useAppStore } from '@/layers/shared/model';

/**
 * The Work tab's contribution id, shared by its registration in
 * `init-extensions.ts` and by {@link openWorkPanel}, which selects it.
 */
export const WORK_PANEL_ID = 'work';

/** A request to show one turn in the Work tab. */
export interface WorkPanelFocusRequest {
  /** The session the turn belongs to. */
  sessionId: string;
  /**
   * The reply whose turn to show, by its message id, or `live` for the turn
   * running now.
   */
  turn: string | 'live';
}

interface WorkPanelFocusState {
  /** The unanswered request, or `null` once the tab has acted on it. */
  request: WorkPanelFocusRequest | null;
  /** Ask the tab for a turn. */
  ask: (request: WorkPanelFocusRequest) => void;
  /** Take the request, so a later remount does not act on it again. */
  consume: () => void;
}

/**
 * The pending request. A store rather than a prop: the tab is mounted by the
 * right-panel container from a lazy contribution, far from the transcript.
 * Each press stores a fresh object, so pressing Show work twice on one reply
 * scrolls to it twice.
 */
export const useWorkPanelFocusStore = create<WorkPanelFocusState>()((set) => ({
  request: null,
  ask: (request) => set({ request: { ...request } }),
  consume: () => set({ request: null }),
}));

/**
 * Open the Work tab on one turn.
 *
 * `setActiveRightPanelTab` rather than the view-only setter: this is always a
 * press, and a press is what may rewrite the stored layout (DOR-227).
 *
 * @param sessionId - The session behind the chat.
 * @param turn - The reply whose turn to show, or `live` for the turn running now.
 */
export function openWorkPanel(sessionId: string, turn: string | 'live'): void {
  const app = useAppStore.getState();
  app.setActiveRightPanelTab(WORK_PANEL_ID);
  app.setRightPanelOpen(true);
  useWorkPanelFocusStore.getState().ask({ sessionId, turn });
}
