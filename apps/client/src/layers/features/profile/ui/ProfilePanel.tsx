/**
 * Settings › Profile — the form door onto your own identity.
 *
 * **Two doors, one room** (spec `profile-unification` D8, amending ADR
 * `260806-222547`): your own rows in the profile are controls now, and this
 * panel stays as the form for people who look for it in Settings. Both draw the
 * same field cards (`ui/fields/ProfileFields`), so a fix lands in both.
 *
 * **The identity edited here is the LOCAL one** (`identity-consistency` §W3.6).
 * The "DorkOS account" tab is a separate device link for analytics and update
 * notices; this panel neither reads it, writes it, nor implies the two are the
 * same account.
 *
 * @module features/profile/ui/ProfilePanel
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  ProfileEmailField,
  ProfileHandleField,
  ProfileNameField,
  ProfilePhotoField,
} from './fields/ProfileFields';

export interface ProfilePanelProps {
  /** The operator's own roster row. */
  member: TeamMember;
}

/**
 * Edit your photo, your name and your handle.
 *
 * Each field saves on its own and reports on its own, because they fail for
 * unrelated reasons: a handle can be taken while a name is perfectly fine, and
 * one shared "save" button would make the person re-submit the part that worked.
 */
export function ProfilePanel({ member }: ProfilePanelProps) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        How you appear across DorkOS: on your team page, in every room, and beside everything you
        write.
      </p>
      <ProfilePhotoField member={member} />
      <ProfileNameField member={member} />
      <ProfileHandleField member={member} />
      <ProfileEmailField member={member} />
    </div>
  );
}
