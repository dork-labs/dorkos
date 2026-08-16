/**
 * What every pushed page is handed (spec `profile-unification` §1.5).
 *
 * Its own module so the registry and the pages can both name it without the
 * registry importing a page or a page importing the registry.
 *
 * @module features/profile/ui/pages/types
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { ProfileStackEntry } from '../../model/profile-stack';

/** The props a page's content receives. The shell around it is `ProfilePage`. */
export interface ProfilePageContentProps {
  /** The identity this page is about. */
  member: TeamMember;
  /** The whole roster, for pages that resolve other identities (Manages). */
  roster: TeamMember[];
  /** Push another entry — a chained profile from a list row. */
  onPush: (entry: ProfileStackEntry) => void;
}
