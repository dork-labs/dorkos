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

/**
 * Resolve your own roster row and hand it to the form.
 *
 * The three states are drawn apart because they are three different things.
 * Still reading says so and waits. A read that FAILED says the tab could not be
 * loaded — the fields would otherwise render empty and a save would overwrite
 * your name with a blank draft of it. A read that succeeded with no self row is
 * only reachable where there is no server behind the roster at all (the
 * Obsidian embed), and says that plainly rather than showing a form with
 * nothing behind it.
 */
export function ProfilePanelContainer() {
  const roster = useTeamRoster();
  const self = roster.data?.members.find((member) => member.isSelf);

  if (roster.isPending) {
    return <p className="text-muted-foreground py-8 text-center text-sm">Loading your profile…</p>;
  }

  if (!self) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        DorkOS could not read your profile just now. Try reopening this tab.
      </p>
    );
  }

  return <ProfilePanel member={self} />;
}
