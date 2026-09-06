/**
 * Where the keyboard goes when a drop takes the row out from under it
 * (DOR-1790).
 *
 * **dnd-kit restores focus to the node it was carrying, and after a
 * cross-section drop that node is gone.** Its `RestoreFocus` looks the dragged
 * item up by the id the drag started with (`draggableNodes.get(previousActiveId)`)
 * and returns without doing anything when there is no entry — and a row that
 * moves between sections is unmounted and mounted again under a NEW id, because
 * `sidebarRowDndId` prefixes the id with the row's home container. So a reader
 * who lifted a channel out of Channels with Space, walked it into a section and
 * put it down was left on `<body>`: no focus ring anywhere, and the next Tab
 * starting again from the top of the document. Measured in a real browser, twice
 * — `document.activeElement` was `<body>` immediately after the drop and still
 * `<body>` a second later.
 *
 * **The intended landing place is the row itself, in its new home.** It is the
 * thing the reader was carrying and the thing they will want to act on, and
 * every alternative — the section header, the row's old neighbour — asks them to
 * find it again.
 *
 * **jsdom cannot answer any of this.** The move is a real remount driven by a
 * server round trip, and "where did focus end up" is a browser default-action
 * question; the pin is
 * `apps/e2e/tests/dashboard-sidebar/sidebar-groups.spec.ts`. What lives here is
 * the arrival wait, which is testable on its own.
 *
 * @module features/dashboard-sidebar/ui/dnd/restore-drop-focus
 */
import { SIDEBAR_ROW_ATTRIBUTE } from '@/layers/shared/model';
import { SIDEBAR_DRAG_ROOT_ATTRIBUTE } from './SidebarDndPrimitives';

/**
 * How many frames the moved row gets to arrive before the attempt is dropped.
 *
 * The write is optimistic, so the row is usually there on the very next frame;
 * the budget covers a section that has to unfold to show it and a re-render that
 * lands behind a slower query. It expires rather than persisting because a row
 * that never arrives means the drop did something other than what was read here
 * — and stealing focus a second later, long after the reader has moved on, is
 * worse than not restoring it at all.
 *
 * **One case expires, and it is a known residual rather than a fix.** A row
 * dropped onto a section that is FOLDED is not drawn at all (`SidebarFoldBody`
 * unmounts a closed body), so there is no row to hand the keyboard to — and
 * where focus is left is `<body>`, the very place this module exists to stop a
 * reader landing on. Saying it plainly rather than calling it "wherever dnd-kit
 * put it", which reads as somewhere.
 *
 * It is left that way on purpose, for now. The only cheap alternative is the
 * destination section's header, and that answer can only be given for a drop
 * INTO a named section: `remove-from-group` and `unpin` land a row in whichever
 * of Channels, Direct messages or Agents it belongs to, which the drop does not
 * name — so the fallback would fire for one of the three relocating operations
 * and not the other two, and "sometimes the header, sometimes nothing" is
 * harder to rely on than one honest gap. Worth revisiting if a drop ever
 * unfolds the section it lands in, which would close this by making the row
 * exist.
 */
const ARRIVAL_FRAMES = 60;

/**
 * The row inside the drag root with this id, if it is on screen.
 *
 * Walks the roots and compares, rather than building an attribute selector: a
 * drag id carries an agent's absolute path, and a path is not a thing to
 * interpolate into a selector.
 *
 * @param dragRootId - The dnd id the row's new home renders it under.
 */
function rowIn(dragRootId: string): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>(`[${SIDEBAR_DRAG_ROOT_ATTRIBUTE}]`);
  for (const root of roots) {
    if (root.getAttribute(SIDEBAR_DRAG_ROOT_ATTRIBUTE) !== dragRootId) continue;
    return root.querySelector<HTMLElement>(`[${SIDEBAR_ROW_ATTRIBUTE}]`);
  }
  return null;
}

/**
 * Focus the row as soon as it turns up under `dragRootId`, and give up quietly
 * if it never does.
 *
 * @param dragRootId - The dnd id the row's new home renders it under.
 * @param frames - How many frames to keep looking. Defaults to
 *   {@link ARRIVAL_FRAMES}; exposed for the unit test, which cannot wait a
 *   second per case.
 */
export function focusRowOnArrival(dragRootId: string, frames: number = ARRIVAL_FRAMES): void {
  let left = frames;
  const look = () => {
    const row = rowIn(dragRootId);
    if (row !== null) {
      row.focus();
      return;
    }
    if (left-- > 0) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
