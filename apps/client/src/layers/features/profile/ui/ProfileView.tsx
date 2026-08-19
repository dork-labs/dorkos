/**
 * One Profile — the whole surface, for every identity on this install (spec
 * `profile-unification` §1.1).
 *
 * The component both homes render: a right sheet everywhere, and (W2.3) the
 * `/session` right panel. It knows nothing about either — it is handed an
 * identity, the roster it came from, and a stack, and it draws the portrait,
 * the property list, and whatever page is pushed on top.
 *
 * @module features/profile/ui/ProfileView
 */
import { Suspense, type CSSProperties } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Skeleton } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useInteractionStore } from '@/layers/entities/interactions';
import { findTeamOwner, teamMemberFace, useMemberRooms } from '@/layers/entities/team';
import { deriveRelationship } from '../lib/profile-relationship';
import { messageTarget } from '../lib/profile-message';
import { rowsFor, type ProfileRowsContext } from '../lib/profile-rows';
import { useManagedAgentFacts } from '../model/use-managed-agent-facts';
import {
  beneathMemberId,
  currentPage,
  profileFrameKey,
  type ProfileStackEntry,
  type ProfileStackState,
} from '../model/profile-stack';
import { ProfileActionsMenu } from './ProfileActionsMenu';
import { ProfileScope } from '../model/profile-scope';
import { ProfileBackBar } from './ProfileBackBar';
import { ProfileHeader } from './ProfileHeader';
import { ProfilePage } from './ProfilePage';
import { ProfileRows } from './ProfileRows';
import { ProfileStack } from './ProfileStack';
import { profilePage } from './pages/registry';

export interface ProfileViewProps {
  /** The identity being shown — any roster row. */
  member: TeamMember;
  /** The whole roster, for resolving the owner and what this identity manages. */
  roster: TeamMember[];
  /** Which home is drawing this. */
  home: 'docked' | 'sheet';
  /**
   * True when the profile is docked inside the session that IS this agent's
   * session. Hides Message: the composer is right there.
   */
  inOwnSession?: boolean;
  /** What is pushed on top of the profile. */
  stack: ProfileStackState;
  /** Push a page, or a chained profile. */
  onPush: (entry: ProfileStackEntry) => void;
  /** Pop the top of the stack. */
  onPop: () => void;
}

/**
 * Draw a profile.
 *
 * **`relationship` is derived, never passed** (§1.1): the same panel draws your
 * own row, a teammate's, an agent you manage and one you do not, and what
 * changes between them is which facts are true — not which component runs.
 */
export function ProfileView({
  member,
  roster,
  home,
  inOwnSession,
  stack,
  onPush,
  onPop,
}: ProfileViewProps) {
  const relationship = deriveRelationship(member, roster);
  const owner = findTeamOwner(member, roster);
  const face = teamMemberFace(member);
  const page = currentPage(stack);
  const navigate = useSafeNavigate();

  // The agent's own manifest, for the description the About row and page show.
  // Gated on the roster knowing where the agent lives, so this asks for nothing
  // on a person's profile — or on any agent whose folder is not ours to know.
  const manifest = useCurrentAgent(member.agent?.projectPath ?? null);
  // The Rooms row's value. Read here rather than in the page, so the row can
  // say where somebody is before you open it — and so the page it pushes is a
  // cache hit rather than a second wait.
  const rooms = useMemberRooms(member.id);
  // The counts the work and toolkit rows carry. Only asked for on the two
  // relationships that draw those rows — a teammate's agent shows none of this
  // and must not be asked about it.
  const ownsWork = relationship === 'managed' || relationship === 'system';
  const facts = useManagedAgentFacts(member, ownsWork);

  const ctx: ProfileRowsContext = {
    relationship,
    manages: roster.filter((row) => row.kind === 'agent' && row.ownerId === member.id),
    description: manifest.data?.description ?? null,
    rooms: rooms.data ? { count: rooms.data.rooms.length, rooms: rooms.data.rooms } : null,
    facts,
  };

  // Three ways to have no button, and they are all the same answer: don't draw
  // one. Nowhere to open a session (every person today — §8), your own profile,
  // and the profile docked in the very session the button would open.
  const target = messageTarget(member);
  const canOpenSession =
    target !== null && relationship !== 'self' && !inOwnSession && navigate !== null;

  function openSession() {
    if (!target || !navigate) return;
    // The roster's door into a conversation (DOR-1156): it names a directory,
    // not a session, so the AGENT is the only honest thing to record — and it
    // is what ⌘K's ranking and the New menu's "last used" read.
    useInteractionStore.getState().recordOpened('agent', target.projectPath);
    void navigate({ to: '/session', search: { dir: target.projectPath } });
  }

  // A page is only reachable when a row of THIS profile pushes it. The row
  // table is the permission model (§1.4), and `?profilePage=` is an address
  // anyone can type — without this gate, `?profile=<someone else>&profilePage=name`
  // drew the operator's own Name editor seeded with that person's name, and
  // its Save renamed the operator. A link naming a page this identity has no
  // row for lands on the root, the same self-healing a stale `?profile=` gets.
  // Appearance is the one page no row pushes: its control is the face itself
  // (§1.4), and it is offered on exactly the identities the face is a button
  // on. Gated on the same condition rather than waved through, because it is an
  // editor and `?profilePage=appearance` is an address anyone can type.
  const canEditAppearance = relationship === 'managed';
  const reachable =
    page !== null &&
    (page === 'appearance'
      ? canEditAppearance
      : rowsFor(member, ctx).some((group) =>
          group.rows.some((row) => row.kind === 'nav' && row.page === page)
        ));
  // What is actually on screen, which is what the frame is keyed on — a page
  // the gate turned away is the root, and must animate and remount like one.
  const shown = reachable ? page : null;
  const definition = shown ? profilePage(shown) : null;
  const PageContent = definition?.component;

  // A chained profile is a frame like a page is, and needs the same way out.
  // Only on this profile's own root: from a page pushed off it, `ProfilePage`'s
  // own bar is the way back, one step at a time.
  const beneath = beneathMemberId(stack);
  const beneathMember = beneath === null ? undefined : roster.find((row) => row.id === beneath);
  // The frame the stack is on, derived from what is SHOWN. Reading the stack's
  // top entry instead would name a page the gate turned away — leaving a chained
  // profile keyed on a page that is not on screen, so the next push neither
  // remounts nor animates.
  const frameKey = shown ?? (beneath === null ? null : profileFrameKey(member.id));

  return (
    <div
      data-slot="profile"
      data-member-id={member.id}
      data-home={home}
      // The panel wears this identity's colour, so the wash behind the face and
      // the rule above the property list can both be drawn in it.
      style={{ '--identity-color': face.color } as CSSProperties}
      // The group is NAMED: a bare `group` matches any `.group` ancestor, and
      // this one is read from inside the header for the kebab's corner.
      className="group/profile flex min-h-0 flex-1 flex-col"
    >
      {/* Two homes can be on screen at once — the docked profile of the session
          you are in, and a sheet over it for somebody else. Everything that
          would otherwise be "the profile" as a global — the face's shared-layout
          id, the count of unsaved editors — is keyed on this pair instead. */}
      <ProfileScope home={home} memberId={member.id}>
        <ProfileStack frameKey={frameKey} depth={stack.entries.length}>
          {definition && PageContent ? (
            <ProfilePage member={member} title={definition.title} onBack={onPop}>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <PageContent member={member} roster={roster} onPush={onPush} />
              </Suspense>
            </ProfilePage>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {beneathMember && <ProfileBackBar label={beneathMember.displayName} onBack={onPop} />}
              <ProfileHeader
                member={member}
                relationship={relationship}
                owner={owner}
                onOpenOwner={
                  owner ? () => onPush({ kind: 'profile', memberId: owner.id }) : undefined
                }
                onOpenSession={canOpenSession ? openSession : undefined}
                // Only an agent you manage: DorkBot's face is part of DorkOS
                // (its About row says so), and nobody else's identity is yours
                // to restyle. Its VOICE is a different question and is yours —
                // the Personality row opens. A face that opened nothing would be
                // the dead affordance this design exists to remove.
                onFaceActivate={
                  canEditAppearance ? () => onPush({ kind: 'page', page: 'appearance' }) : undefined
                }
                actionsMenu={<ProfileActionsMenu member={member} relationship={relationship} />}
              />
              <ProfileRows member={member} ctx={ctx} onPush={onPush} />
            </div>
          )}
        </ProfileStack>
      </ProfileScope>
    </div>
  );
}
