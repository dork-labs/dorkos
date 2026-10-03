/**
 * Settings › Profile, connected to the roster.
 *
 * The same split every surface in this feature uses: the panel renders a
 * `TeamMember`, this half finds which one is you.
 *
 * @module features/profile/ui/ProfilePanelContainer
 */
import { useTeamRoster } from '@/layers/entities/team';
import { ProfilePanel } from './ProfilePanel';

/** One sentence, centred, for each state that is not a form. */
function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground py-8 text-center text-sm">{children}</p>;
}

/**
 * Resolve your own roster row and hand it to the form.
 *
 * **Three states, because there are three different things going on**, and
 * collapsing them is what the first version of this did. Still reading says so
 * and waits. A read that FAILED says the read failed and invites a retry — the
 * fields would otherwise render empty and a save would overwrite your name with
 * a blank draft of it.
 */
export function ProfilePanelContainer() {
  const roster = useTeamRoster();
  const self = roster.data?.members.find((member) => member.isSelf);

  if (roster.isPending) return <Notice>Loading your profile…</Notice>;

  if (roster.isError) {
    return <Notice>Couldn’t load your profile. Reopen this tab to try again.</Notice>;
  }

  if (!self) return <Notice>Couldn’t find your profile. Reopen this tab to try again.</Notice>;

  return <ProfilePanel member={self} />;
}
