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
import { ProfileRolesField } from './fields/ProfileRolesField';

export interface ProfilePanelProps {
  /** The operator's own roster row. */
  member: TeamMember;
}

/**
 * Edit your photo, your name, your handle, and what kind of work you do.
 *
 * Each field saves on its own and reports on its own, because they fail for
 * unrelated reasons: a handle can be taken while a name is perfectly fine, and
 * one shared "save" button would make the person re-submit the part that worked.
 *
 * Roles is the odd one out among the four identity fields above it — it isn't
 * how you appear, it's what DorkBot tells your other agents about who they
 * work for — but it lives here too (DOR-1972) because this is the one place
 * every onboarding prompt that asks the question now points back to.
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
      <ProfileRolesField />
    </div>
  );
}
