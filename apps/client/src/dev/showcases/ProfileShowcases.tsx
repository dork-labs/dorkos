import { useState } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Button } from '@/layers/shared/ui';
import { findTeamOwner } from '@/layers/entities/team';
import { ProfileDrawer } from '@/layers/features/profile';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_TEAM_ROSTER } from '../mock-samples';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

/**
 * The roster the drawer is shown against.
 *
 * One agent is given a `projectPath` here, which nothing production serves fills
 * yet (the mesh strips it from its public listing) — without it there is nowhere
 * to open a session, so the action would never be drawn and its state would go
 * unshown.
 */
const FIXTURE_ROSTER: TeamMember[] = MOCK_TEAM_ROSTER.map((member) =>
  member.id === 'agent-warden' && member.agent
    ? { ...member, agent: { ...member.agent, projectPath: '/Users/dorian/code/dorkos' } }
    : member
);

/** The states worth opening: an agent, someone bridged in, and your own row. */
const STATES: { id: string; label: string }[] = [
  { id: 'agent-warden', label: 'An agent' },
  { id: 'agent-cartographer', label: 'An agent with no handle' },
  { id: 'person-miguel', label: 'Someone on Telegram' },
  { id: 'person-dorian', label: 'Your own row' },
];

/**
 * Showcases for the one profile panel: the same component for every identity.
 *
 * Opening one here draws it exactly as the app does — a right-side drawer on a
 * pointer, full-screen below 768px. Narrow the browser to see the second.
 */
export function ProfileShowcases() {
  const [openId, setOpenId] = useState<string | null>(null);
  const member = openId ? byId(openId) : undefined;
  const fixture = member
    ? (FIXTURE_ROSTER.find((row) => row.id === member.id) ?? member)
    : undefined;

  return (
    <PlaygroundSection
      title="Profile Drawer"
      description="One panel for any identity — a person or an agent, the same component either way. An agent says how it runs, how recently it was heard from (in words, never a live dot) and who it belongs to; a person says their role and where they are. Your own row is the only one carrying an email and an Edit button."
    >
      <ShowcaseLabel>Agent, someone bridged in, and your own row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-2">
          {STATES.map((state) => (
            <Button key={state.id} variant="outline" onClick={() => setOpenId(state.id)}>
              {state.label}
            </Button>
          ))}
        </div>
        {fixture && (
          <ProfileDrawer
            member={fixture}
            owner={findTeamOwner(fixture, FIXTURE_ROSTER)}
            open
            onOpenChange={(open) => !open && setOpenId(null)}
            // The playground mounts no router and no Settings dialog, so both
            // actions are drawn and inert here rather than wired to somewhere
            // that does not exist on this page.
            onOpenSession={() => undefined}
            onEdit={() => undefined}
          />
        )}
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
