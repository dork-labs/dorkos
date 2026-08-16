/**
 * "There is unsaved work in here" — the one signal the profile's exits ask
 * before they take you out (spec `profile-unification` §1.5).
 *
 * A module signal rather than a context, for the same reason `auth-signal` is
 * one: the editor that knows it is dirty (a convention page, deep inside a
 * pushed page) and the controls that can discard it (the page's ‹ Profile, the
 * sheet's close, the docked panel's) have no component between them worth
 * threading a provider through, and the two homes draw that stack differently.
 * Nothing renders from it — it is read once, in the handler, at the moment you
 * try to leave.
 *
 * **Counted per panel, not once for the app.** A docked profile and a sheet
 * over it are both on screen on `/session`, and a single global count let a
 * half-written SOUL.md in one refuse to close the other — a confirmation about
 * work that is not in the panel you are closing, which is worse than no
 * confirmation at all. The key is the same (home, identity) pair the face's
 * shared layout id uses (`profile-scope`).
 *
 * Only editors that save on a BUTTON register here. A field that commits on
 * blur — the About page's name and description — has nothing pending by the
 * time you reach for the way out, and a confirmation over nothing is the dead
 * affordance this design removes.
 *
 * @module features/profile/model/profile-leave-guard
 */
import { useEffect } from 'react';
import { profileScopeKey, useProfileScope, type ProfileScopeValue } from './profile-scope';

/** How many mounted editors hold unsaved text, per panel. */
const unsaved = new Map<string, number>();

/**
 * Whether this panel has edits that leaving would discard.
 *
 * @param scope - The panel asking. `null` — a profile drawn outside any scope —
 *   has no editors registered against it and so nothing to lose.
 */
export function hasUnsavedProfileEdits(scope: ProfileScopeValue | null): boolean {
  const key = profileScopeKey(scope);
  return key !== null && (unsaved.get(key) ?? 0) > 0;
}

/**
 * Whether ANY editor in this home holds unsaved text.
 *
 * For the docked home the two questions are the same — it draws one panel at a
 * time — but the store that resets its stack knows the agent's DIRECTORY and not
 * the identity behind it, and resolving one to the other is an async read it
 * cannot do inside an action. Asking by home is the honest form of the question
 * it can actually ask.
 *
 * @param home - Which of the two homes.
 */
export function homeHasUnsavedProfileEdits(home: 'docked' | 'sheet'): boolean {
  const prefix = `${home}:`;
  for (const [key, count] of unsaved) {
    if (count > 0 && key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Declare that this editor would lose something if its profile were left now.
 *
 * Counted rather than set, so two editors on screen cannot clear each other's
 * claim, and an unmount always withdraws exactly its own. The panel it counts
 * against is the one it is rendered in ({@link useProfileScope}).
 *
 * @param dirty - True while there is unsaved text.
 */
export function useProfileLeaveGuard(dirty: boolean): void {
  const key = profileScopeKey(useProfileScope());

  useEffect(() => {
    if (!dirty || key === null) return;
    unsaved.set(key, (unsaved.get(key) ?? 0) + 1);
    return () => {
      const left = (unsaved.get(key) ?? 1) - 1;
      // Deleted rather than left at zero, so a panel that has been closed and
      // reopened many times does not leave a key behind for each visit.
      if (left > 0) unsaved.set(key, left);
      else unsaved.delete(key);
    };
  }, [dirty, key]);
}
