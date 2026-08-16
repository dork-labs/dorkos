/**
 * What every `pick` popover is handed (spec `profile-unification` §1.4).
 *
 * Its own module so the registry and the popovers can both name it without the
 * registry importing a popover or a popover importing the registry.
 *
 * @module features/profile/ui/popovers/types
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';

/** The props a popover's content receives. The panel around it is `ProfileRow`'s. */
export interface ProfilePickContentProps {
  /** The identity whose setting this changes. */
  member: TeamMember;
  /** Close the popover — for a control that finishes in one choice. */
  onClose: () => void;
}
