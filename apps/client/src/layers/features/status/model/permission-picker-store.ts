/**
 * A handle on the session's permission picker for surfaces that are not the
 * status line.
 *
 * ## Why this exists rather than a click on the trigger
 *
 * The read-only notice offers a way through to the picker, and the obvious
 * implementation — find the trigger by `data-testid` and click it, as
 * `ChatPanel` does for the model picker — is a dead button at narrow widths.
 * The status line is budgeted: `applyStatusBudget` does not hide an item that
 * does not fit, it drops it from the array, so the element is simply not in the
 * DOM. On a phone the budget is two or three items and the permission item
 * reads QUIET at the ask stop, so it is routinely the one that goes. A
 * `querySelector(...)?.click()` then finds nothing and the button silently does
 * nothing, which is worse than not offering it.
 *
 * So the picker publishes itself here instead. Two facts, and both are needed:
 *
 * - **`available`** — an interactive picker is mounted right now. A caller that
 *   offers a way in must not draw it when this is false. The picker is the only
 *   writer, and it says `false` for the states that render no popover at all
 *   (a runtime with no permission modes, and a session with no first turn yet).
 * - **`open`** — the picker's panel state, owned here so anybody can ask for it.
 *
 * One store for the one picker: `PermissionModeItem` is rendered in exactly one
 * place in the app (`status-item-nodes.tsx`), inside the composer that belongs
 * to the session being looked at.
 *
 * @module features/status/model/permission-picker-store
 */
import { create } from 'zustand';

/** The picker's published state, plus the two writes that maintain it. */
interface PermissionPickerState {
  /**
   * Whether an interactive picker is mounted. False while none is, which is the
   * resting state on any page without a session composer.
   */
  available: boolean;
  /** Whether the picker's panel is showing. */
  open: boolean;
  /**
   * Published by the picker itself as it mounts, unmounts, and moves between
   * its interactive and non-interactive shapes. Going unavailable also shuts the
   * panel, so a request that arrived a moment before the item was dropped cannot
   * leave the store claiming an open picker that no longer exists.
   */
  setAvailable: (available: boolean) => void;
  /** Ask the picker to show or hide its panel. */
  setOpen: (open: boolean) => void;
}

/**
 * The session permission picker's shared handle.
 *
 * Select narrowly (`useSessionPermissionPicker((s) => s.available)`) — a
 * component that subscribes to the whole store re-renders on every open and
 * close of a popover it may not even be drawing.
 */
export const useSessionPermissionPicker = create<PermissionPickerState>()((set) => ({
  available: false,
  open: false,
  setAvailable: (available) => set(available ? { available } : { available, open: false }),
  setOpen: (open) => set({ open }),
}));
