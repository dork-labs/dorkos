/**
 * Telling a tap from the tail of a drag (DOR-1275).
 *
 * @module shared/model/interaction/use-drag-vs-tap-guard
 */
import { useCallback, useRef } from 'react';
import { LONG_PRESS_DRIFT_PX } from '@/layers/shared/lib';

/** The fields a guard needs off a pointer or click event. */
export interface DragVsTapPoint {
  /** Where the pointer was, in viewport coordinates. */
  clientX: number;
  /** Where the pointer was, in viewport coordinates. */
  clientY: number;
}

/** The extra field `travelled` needs to tell a keyboard click from a pointer's. */
export interface DragVsTapClick extends DragVsTapPoint {
  /**
   * `0` for a click a keyboard or screen reader made, `>0` for a pointer's. A
   * keyboard click carries no coordinates worth measuring, and one that landed
   * with a stale origin left behind by an unrelated earlier press would read
   * as a drag it never made.
   */
  detail: number;
}

/** What {@link useDragVsTapGuard} returns. */
export interface DragVsTapGuard {
  /** Record where the press began. Wire to the control's `onPointerDown`. */
  onPointerDown: (event: DragVsTapPoint) => void;
  /**
   * True when the press that just ended travelled past the drift threshold —
   * the tail of a drag, not a tap. Call once per `onClick`, before running the
   * control's own action; a `true` means bail rather than act.
   */
  travelled: (event: DragVsTapClick) => boolean;
}

/**
 * On a vaul drawer, a downward drag over the sheet ends where it started — the
 * whole drawer moves WITH the pointer, so the element under the finger at the
 * end of the gesture is the same one it began on, and the browser fires a
 * click on it. Any plain `<button>` under a thumb mid-drag-to-dismiss answers
 * a tap it was never given unless it checks how far the press travelled first.
 *
 * Extracted from the room sheet's profile control (`RoomMemberRow.tsx`'s
 * `ProfileLink`, spec `profile-unification`), which had this guard inline
 * while the loudness pill and the in-row Remove button beside it had none —
 * the same drag could open one control's action while leaving the other two
 * to fire on the drawer's own dismiss.
 *
 * @returns The pointer-down recorder and the per-click check. See
 *   {@link DragVsTapGuard}.
 */
export function useDragVsTapGuard(): DragVsTapGuard {
  // Where the press started, so a click can be told from the tail of a drag.
  // Read at `pointerdown` because that is the only moment the origin exists.
  const pressedAt = useRef<DragVsTapPoint | null>(null);

  const onPointerDown = useCallback((event: DragVsTapPoint) => {
    pressedAt.current = { clientX: event.clientX, clientY: event.clientY };
  }, []);

  const travelled = useCallback((event: DragVsTapClick) => {
    const from = pressedAt.current;
    pressedAt.current = null;
    return (
      event.detail > 0 &&
      from !== null &&
      (Math.abs(event.clientX - from.clientX) > LONG_PRESS_DRIFT_PX ||
        Math.abs(event.clientY - from.clientY) > LONG_PRESS_DRIFT_PX)
    );
  }, []);

  return { onPointerDown, travelled };
}
