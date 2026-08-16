/**
 * The popovers a `pick` row opens — the ▾ half of the property list (spec
 * `profile-unification` §1.4).
 *
 * **Empty in this slice, and that is the seam.** "Runs on" (runtime · model ·
 * effort) and "Personality" are ported from the Agent Hub in W2.2; until they
 * are registered here, a `pick` row draws as the plain fact it already carries
 * rather than as a control that opens nothing. Registering a popover is the
 * whole of turning the row back into a control.
 *
 * @module features/profile/ui/popovers/registry
 */
import type { ProfileRowModel } from '../../lib/profile-rows';

/** Which popover a row opens. */
export type ProfilePickId = NonNullable<ProfileRowModel['pick']>;

/**
 * The popovers this build has. Filled by W2.2; see the module note.
 *
 * @internal
 */
const PROFILE_PICKS: Partial<Record<ProfilePickId, true>> = {};

/**
 * Is there a popover behind this `pick` row yet?
 *
 * @param pick - Which popover the row wants.
 * @returns True when it exists and the row may be drawn as a control.
 */
export function isProfilePickAvailable(pick: ProfilePickId): boolean {
  return PROFILE_PICKS[pick] === true;
}
