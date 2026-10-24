import { useNow } from '@/layers/shared/model';
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
import { Suspense, useRef, type CSSProperties } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Skeleton } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useDmViewEnabled } from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useOpenDirectChat, useRoomBoundSession } from '@/layers/entities/room';
import { useSessionListStore } from '@/layers/entities/session';
import { findTeamOwner, teamMemberFace, useMemberRooms } from '@/layers/entities/team';
import { useCommitments } from '@/layers/entities/commitment';
import { useAgentHeartbeat } from '@/layers/entities/heartbeat';
import { useAgentLevel } from '@/layers/entities/permissions';
import { deriveRelationship } from '../lib/profile-relationship';
import { messageTarget } from '../lib/profile-message';
import { rowsFor, type ProfileRowsContext } from '../lib/profile-rows';
import { describeReportsTo } from '../lib/profile-reports-to';
import { useManagedAgentFacts } from '../model/use-managed-agent-facts';
import { useOpenFoldFor, useShowProfileRow } from '../model/use-profile-fold-links';
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
import { toSession } from '@/layers/shared/lib';

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
  /**
   * Leave out the model, account and chat count (DOR-3075): docked beside a
   * DM while Show sessions is off.
   */
  quietSessionDetail?: boolean;
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
  quietSessionDetail = false,
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
  // The Commitments row's counts. Asked for on every agent's profile: anyone
  // may read any agent's promises (spec `heartbeats` §12). The page it pushes
  // reads the same key, so opening it is a cache hit.
  const commitmentAgentId = member.agent?.manifestId;
  const commitments = useCommitments(
    { agentId: commitmentAgentId ?? '' },
    { enabled: Boolean(commitmentAgentId) }
  );
  // The Heartbeat row's words, read for every agent for the same reason. The
  // page reads the same key live, so opening it is a cache hit too.
  const heartbeat = useAgentHeartbeat(commitmentAgentId ?? null);
  // The Level row: what the agent actually runs at, resolved by the server.
  // Asked only where the Permissions row is drawn — the same audience.
  const level = useAgentLevel(ownsWork ? member.id : undefined);
  // How many of this agent's chats are mid-turn, for the status line. A count,
  // so the selector's answer is a stable primitive.
  const agentPath = member.agent?.projectPath ?? null;
  const runningChats = useSessionListStore((state) =>
    agentPath === null
      ? 0
      : Object.entries(state.statusCwds).filter(
          ([id, cwd]) => cwd === agentPath && state.statuses[id]?.lifecycle === 'streaming'
        ).length
  );
  // Ticks the row's "next in 12 min", which moves with no new data.
  const now = useNow(30_000);
  // Where this agent works in the room the page is showing, when one is. Answers
  // `null` everywhere else, which is what leaves the docked home — and every
  // route that is not a room — resolving exactly as it always did.
  const resolveRoomSession = useRoomBoundSession();
  const openDirectChat = useOpenDirectChat();
  // With the DM view on, Message is always the DM (DOR-3074): the agent's
  // session in this room moved to its card, behind Show sessions.
  const dmView = useDmViewEnabled();

  const ctx: ProfileRowsContext = {
    relationship,
    manages: roster.filter((row) => row.kind === 'agent' && row.ownerId === member.id),
    description: manifest.data?.description ?? null,
    rooms: rooms.data ? { count: rooms.data.rooms.length, rooms: rooms.data.rooms } : null,
    facts,
    reportsTo: manifest.data ? describeReportsTo(manifest.data, roster, member).label : null,
    commitments: commitments.data
      ? {
          open: commitments.data.filter((c) => c.state === 'open').length,
          overdue: commitments.data.filter((c) => c.overdue).length,
        }
      : null,
    heartbeat: heartbeat.data ?? null,
    level: level.data ?? null,
    now,
    quietSessionDetail,
  };
  const groups = rowsFor(member, ctx);
  // Folds are remembered per viewer, so the person looking is the key.
  const viewerId = roster.find((row) => row.isSelf)?.id ?? 'local';

  // Three ways to have no button, and they are all the same answer: don't draw
  // one. Nowhere to open a session (every person today — §8), your own profile,
  // and the profile docked in the very session the button would open.
  const target = messageTarget(member);
  const canOpenSession =
    target !== null && relationship !== 'self' && !inOwnSession && navigate !== null;

  async function openSession() {
    if (!target || !navigate) return;
    // The roster's door into a conversation (DOR-1156): it names a directory,
    // not a session, so the AGENT is the only honest thing to record — and it
    // is what ⌘K's ranking and the New menu's "last used" read.
    useInteractionStore.getState().recordOpened('agent', target.projectPath);
    // Opened from inside a room, this button means "take me to what this agent
    // is doing HERE" (DOR-1974). Every other door into the profile from a room
    // — a mention pill, the face beside a message, a roster row — arrives
    // through this one button, so naming the room's session here is what fixes
    // all of them at once.
    const inRoom = dmView ? null : await resolveRoomSession(target.projectPath);
    if (inRoom !== null) {
      // The session id ALONE, no `dir` — the same shape the live lane's own
      // link uses. A room turn does not necessarily run in the agent's own
      // directory (it can run in the room's worktree), and every per-session
      // read is addressed by id AND directory, so pairing the room's session
      // with the agent's folder is how a real conversation reads as an empty
      // one (DOR-1836). Omitting it is a complete question the server answers
      // from the session's own binding.
      void navigate(toSession({ session: inRoom }));
      return;
    }
    // Everywhere else it is Talk: the agent's one standing Direct chat with
    // you (rule S12, DOR-2997), never whichever chat happens to be newest.
    // The agent's own runtime, for a chat made now (a computer-placed agent).
    const runtime = member.agent?.effectiveRuntimeId;
    await openDirectChat({ agentPath: target.projectPath }, runtime ? { runtime } : {});
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
  // The Handle page has a row on your own profile; on an agent you manage its
  // control is the pencil beside the @handle, gated the same way.
  const canEditHandle = relationship === 'managed';
  const reachable =
    page !== null &&
    (page === 'appearance'
      ? canEditAppearance
      : (page === 'handle' && canEditHandle) ||
        groups.some((group) => group.rows.some((row) => row.kind === 'nav' && row.page === page)));
  // What is actually on screen, which is what the frame is keyed on — a page
  // the gate turned away is the root, and must animate and remount like one.
  const shown = reachable ? page : null;
  const definition = shown ? profilePage(shown) : null;
  // A page pushed from inside a fold — by a deep link, ⌘K or a tap — opens that
  // fold, so popping back lands focus on the row that pushed it.
  useOpenFoldFor({
    groups,
    viewerId,
    match: shown ? (row) => row.kind === 'nav' && row.page === shown : null,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  useShowProfileRow({ groups, viewerId, rootRef, memberId: member.id });
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
      ref={rootRef}
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
                onOpenSession={canOpenSession ? () => void openSession() : undefined}
                // Only an agent you manage: DorkBot's face is part of DorkOS
                // (its About row says so), and nobody else's identity is yours
                // to restyle. Its VOICE is a different question and is yours —
                // the Personality row opens. A face that opened nothing would be
                // the dead affordance this design exists to remove.
                onFaceActivate={
                  canEditAppearance ? () => onPush({ kind: 'page', page: 'appearance' }) : undefined
                }
                actionsMenu={<ProfileActionsMenu member={member} relationship={relationship} />}
                runningChats={runningChats}
                // An agent you manage: a person may rename it (DOR-3156).
                onEditHandle={
                  canEditHandle ? () => onPush({ kind: 'page', page: 'handle' }) : undefined
                }
              />
              <ProfileRows member={member} ctx={ctx} onPush={onPush} viewerId={viewerId} />
            </div>
          )}
        </ProfileStack>
      </ProfileScope>
    </div>
  );
}
