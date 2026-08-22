/**
 * The one door into the room panel, and the part of it the presser asked for.
 *
 * Every entry point that used to raise the room sheet — the bar's members chip,
 * the empty room's "Add agents", the sidebar row's menu — calls
 * {@link openRoomPanel} instead. Opening the right panel is two writes to the
 * shell's store and one to this one, and nobody outside this module should have
 * to know that, or which of the two tab setters is the right one for a click.
 *
 * @module features/room-management/model/room-panel-focus
 */
import { create } from 'zustand';
import { useAppStore } from '@/layers/shared/model';
import type { RoomDetailsFocus } from './room-details';

/**
 * The Room tab's contribution id, shared by the registration in
 * `init-extensions.ts` and by {@link openRoomPanel}, which selects it.
 */
export const ROOM_PANEL_ID = 'room';

/** A request to show one part of the panel, and which press made it. */
export interface RoomPanelFocusRequest {
  /** The part the reader asked for. */
  focus: RoomDetailsFocus;
  /**
   * The room the press was about.
   *
   * The sidebar's menu opens a room you may not be looking at: the press
   * navigates first and the panel follows, and until it has, the panel on screen
   * is still describing the room you are leaving. Naming the room is what stops
   * that one answering a question it was not asked — and swallowing it, so the
   * room being opened never gets it.
   */
  roomId: string;
}

interface RoomPanelFocusState {
  /** The unanswered request, or `null` once the panel has acted on it. */
  request: RoomPanelFocusRequest | null;
  /** Ask the panel for a part of itself, on behalf of one room. */
  ask: (focus: RoomDetailsFocus, roomId: string) => void;
  /** Take the request, so a later remount does not act on it again. */
  consume: () => void;
}

/**
 * The pending focus request.
 *
 * A store rather than a prop or a context: the panel is mounted by the right-panel
 * container from a lazy contribution, and the three doors that open it are in
 * three different widgets with no shared ancestor below the shell.
 */
export const useRoomPanelFocusStore = create<RoomPanelFocusState>()((set) => ({
  request: null,
  // A fresh object every time, which is what makes a repeated press a NEW
  // request: "Add agents" pressed again after collapsing the picker names the
  // same focus and the same room, and the panel has to act on it again. An
  // effect only re-runs for a value that changed, and the identity IS that
  // change — which is why there is no counter here to keep in step.
  ask: (focus, roomId) => set({ request: { focus, roomId } }),
  consume: () => set({ request: null }),
}));

/**
 * Open the room panel on the part of it the reader asked for.
 *
 * `setActiveRightPanelTab` rather than the view-only setter, because this is
 * always a press: an explicit pick is what may rewrite the stored per-agent
 * layout (DOR-227), and the auto-select fallback is the only thing that may not.
 *
 * @param focus - Which part of the panel the press was about.
 * @param roomId - The room the press was about. A door on a room that is not the
 *   one on screen — the sidebar's row menu — navigates to it first; naming the
 *   room here is what keeps the panel it is leaving from answering.
 */
export function openRoomPanel(focus: RoomDetailsFocus, roomId: string): void {
  const app = useAppStore.getState();
  app.setActiveRightPanelTab(ROOM_PANEL_ID);
  app.setRightPanelOpen(true);
  useRoomPanelFocusStore.getState().ask(focus, roomId);
}
