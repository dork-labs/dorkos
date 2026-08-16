/**
 * The popovers a `pick` row opens — the ▾ half of the property list (spec
 * `profile-unification` §1.4).
 *
 * The same seam the page registry is: a `pick` row with nothing registered
 * behind it draws as the plain fact it already carries rather than as a control
 * that opens nothing. Registering a popover is the whole of turning the row back
 * into a control.
 *
 * @module features/profile/ui/popovers/registry
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ProfileRowModel } from '../../lib/profile-rows';
import type { ProfilePickContentProps } from './types';

/** Which popover a row opens. */
export type ProfilePickId = NonNullable<ProfileRowModel['pick']>;

/** One registered popover: what it is called, and the control inside it. */
export interface ProfilePickDefinition {
  /** The heading the mobile drawer needs and the desktop popover repeats. */
  title: string;
  /** The control, code-split — a profile that opens no popover loads none of them. */
  component: LazyExoticComponent<ComponentType<ProfilePickContentProps>>;
}

/** Every popover this build has. */
const PROFILE_PICKS: Partial<Record<ProfilePickId, ProfilePickDefinition>> = {
  'runs-on': {
    title: 'Runs on',
    component: lazy(() => import('./RunsOnPopover').then((m) => ({ default: m.RunsOnPopover }))),
  },
  personality: {
    title: 'Personality',
    component: lazy(() =>
      import('./PersonalityPopover').then((m) => ({ default: m.PersonalityPopover }))
    ),
  },
};

/**
 * The popover behind a `pick`, or `null` when this build does not have it.
 *
 * @param pick - Which popover the row wants.
 */
export function profilePick(pick: ProfilePickId): ProfilePickDefinition | null {
  return PROFILE_PICKS[pick] ?? null;
}

/**
 * Is there a popover behind this `pick` row?
 *
 * @param pick - Which popover the row wants.
 * @returns True when it exists and the row may be drawn as a control.
 */
export function isProfilePickAvailable(pick: ProfilePickId): boolean {
  return PROFILE_PICKS[pick] !== undefined;
}
