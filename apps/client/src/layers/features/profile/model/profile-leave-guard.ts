/**
 * "There is unsaved work in here" — the one signal the profile's exits ask
 * before they take you out (spec `profile-unification` §1.5).
 *
 * A module signal rather than a context, for the same reason `auth-signal` is
 * one: the editor that knows it is dirty (a convention page, deep inside a
 * pushed page) and the controls that can discard it (the page's ‹ Profile, the
 * sheet's close) have no component between them worth threading a provider
 * through, and the two homes draw that stack differently. Nothing renders from
 * it — it is read once, in the handler, at the moment you try to leave.
 *
 * Only editors that save on a BUTTON register here. A field that commits on
 * blur — the About page's name and description — has nothing pending by the
 * time you reach for the way out, and a confirmation over nothing is the dead
 * affordance this design removes.
 *
 * @module features/profile/model/profile-leave-guard
 */
import { useEffect } from 'react';

/** How many mounted editors currently hold unsaved text. */
let unsaved = 0;

/** Whether anything in the profile has edits that leaving would discard. */
export function hasUnsavedProfileEdits(): boolean {
  return unsaved > 0;
}

/**
 * Declare that this editor would lose something if the profile were left now.
 *
 * Counted rather than set, so two editors on screen cannot clear each other's
 * claim, and an unmount always withdraws exactly its own.
 *
 * @param dirty - True while there is unsaved text.
 */
export function useProfileLeaveGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    unsaved += 1;
    return () => {
      unsaved -= 1;
    };
  }, [dirty]);
}
