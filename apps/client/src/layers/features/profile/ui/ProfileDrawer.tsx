/**
 * The profile panel — one component for every identity on this install.
 *
 * The card is the glance, the drawer is the look (spec `identity-consistency`
 * §W3.2). It reads the same descriptor family `IdentityHoverCard` does, and it
 * has no per-kind subclass: an agent and a person differ by which facts are
 * true of them, never by which component draws them.
 *
 * @module features/profile/ui/ProfileDrawer
 */
import type { TeamAgentFacts, TeamMember } from '@dorkos/shared/team-schemas';
import {
  Badge,
  Button,
  IdentityAvatar,
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { formatRuntimeIdentity } from '@/layers/entities/runtime';
import { platformLabel } from '@/layers/entities/room';
import { teamMemberFace, teamMemberLabel } from '@/layers/entities/team';

/**
 * How recently this agent was heard from, in words.
 *
 * **Words, never a dot.** `recentlyActive` means the mesh heard from this agent
 * within the hour — not that it is doing something right now — and the pulsing
 * dot on the disc is what says "right now". Wiring the two together would put a
 * live signal on an agent that finished forty minutes ago.
 *
 * `healthStatus` only shades the *absence*: the mesh's four tokens collapse to
 * one sentence per state rather than a second liveness statement beside the
 * first (`active` is exactly what `recentlyActive` already said).
 *
 * `stale` deliberately says "no recent activity" rather than naming a span:
 * the mesh returns it both for over a day and for **never heard from at all**
 * (`computeHealthStatus` maps a null `lastSeenAt` to `stale`), so "over a day"
 * would be a false sentence about an agent registered a minute ago.
 */
function livenessText(agent: TeamAgentFacts): string {
  if (agent.recentlyActive) return 'Active in the last hour';
  if (agent.healthStatus === 'unreachable') return 'Its folder can’t be found';
  if (agent.healthStatus === 'inactive') return 'Active in the last day';
  return 'No recent activity';
}

/** Where a person is, in the words the rest of the cockpit uses. */
function originText(member: TeamMember): string {
  if (member.origin === 'local') return 'On this machine';
  return `On ${platformLabel(member.origin.platform)}`;
}

/** A stored timestamp as a plain date, or `null` when it is not a date at all. */
function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One fact about the identity — a label and its value, never a control. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[7rem_1fr] sm:gap-3 sm:py-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground text-xs break-words">{value}</dd>
    </div>
  );
}

/**
 * The facts this identity actually has, in reading order.
 *
 * Built as a list rather than rendered inline so the drawer can ask whether
 * there is a body at all. Most rows have none: on a real install a person
 * carries no project, no namespace and no registration date, and only your own
 * row carries an email — so an unconditional scroll region is a framed void
 * running the height of the panel for nearly every person on the roster.
 */
function factsFor(member: TeamMember): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const registered = member.agent ? formatDate(member.agent.registeredAt) : null;
  if (member.agent?.projectPath) facts.push({ label: 'Project', value: member.agent.projectPath });
  if (member.agent?.namespace) facts.push({ label: 'Namespace', value: member.agent.namespace });
  if (registered) facts.push({ label: 'Joined', value: registered });
  // Only ever on your own row — the server sends it for nobody else, and this
  // refuses it anyway so that stays true.
  if (member.isSelf && member.person?.email) {
    facts.push({ label: 'Email', value: member.person.email });
  }
  return facts;
}

export interface ProfileDrawerProps {
  /** The identity this drawer describes. */
  member: TeamMember;
  /**
   * The person this identity belongs to, already resolved from the roster.
   *
   * Resolved by the caller for the same reason the Team card resolves it: a
   * drawer that could reach the whole roster is a drawer that starts making
   * decisions about it.
   */
  owner?: TeamMember;
  /** Whether the drawer is on screen. */
  open: boolean;
  /** Called when the drawer wants to close — Escape, the overlay, the X. */
  onOpenChange: (open: boolean) => void;
  /**
   * Start a session in the agent's own project directory.
   *
   * Takes the path rather than reading it back off the member, so the action is
   * only ever offered when there is somewhere to send it.
   */
  onOpenSession?: (projectPath: string) => void;
  /** Edit your own identity. Offered on your own row and nowhere else. */
  onEdit?: () => void;
}

/**
 * One profile panel, for a person or an agent.
 *
 * A right-side drawer on a pointer, a full-screen sheet on a phone — both from
 * `ResponsiveSheet`, so this component says nothing about viewports.
 *
 * **`isSelf` gates affordances, never code paths.** Your own row draws the same
 * drawer as everyone else's, plus a `you` chip, your email, and an Edit button.
 * Nothing branches on there being one person: a second person and a remote
 * member both arrive as more rows.
 *
 * Presentational — it renders the `TeamMember` it is handed. The caller resolves
 * the row and the owner, and decides what "open a session" and "edit" do.
 */
export function ProfileDrawer({
  member,
  owner,
  open,
  onOpenChange,
  onOpenSession,
  onEdit,
}: ProfileDrawerProps) {
  const face = teamMemberFace(member);

  const agent = member.agent;
  const person = member.person;
  const projectPath = agent?.projectPath;
  const facts = factsFor(member);

  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange}>
      <ResponsiveSheetContent
        data-slot="profile-drawer"
        data-member-id={member.id}
        className="flex flex-col gap-0 p-0"
      >
        {/* The rule under the header belongs to the body it separates — with no
            facts to draw, a hairline would fence off nothing. */}
        <ResponsiveSheetHeader className={cn('gap-3 p-4', facts.length > 0 && 'border-b')}>
          <div className="flex items-start gap-3">
            <IdentityAvatar
              size="lg"
              kind={face.kind}
              color={face.color}
              emoji={face.emoji}
              imageUrl={face.imageUrl}
              fallback={face.fallback}
              origin={face.origin}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <ResponsiveSheetTitle className="truncate text-base">
                  {member.displayName}
                </ResponsiveSheetTitle>
                {/* A flag on a row, never a branch: the drawer is the same drawer. */}
                {member.isSelf && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem]">
                    you
                  </Badge>
                )}
                {agent?.isDefault && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
                    default
                  </Badge>
                )}
                {agent?.isSystem && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
                    system
                  </Badge>
                )}
              </div>
              {/* Absent rather than `@` — an empty handle reaches nobody. */}
              {member.handle !== null && (
                <p className="text-muted-foreground truncate text-xs">@{member.handle}</p>
              )}
            </div>
          </div>
          <ResponsiveSheetDescription className="sr-only">
            Profile details for {member.displayName}
          </ResponsiveSheetDescription>
          <div className="flex flex-wrap gap-1.5 empty:hidden">
            {agent && <Badge variant="secondary">{formatRuntimeIdentity(agent).text}</Badge>}
            {agent && <Badge variant="secondary">{livenessText(agent)}</Badge>}
            {agent && owner && (
              <Badge variant="secondary">Managed by {teamMemberLabel(owner)}</Badge>
            )}
            {person?.role && <Badge variant="secondary">{person.role}</Badge>}
            {person && <Badge variant="secondary">{originText(member)}</Badge>}
          </div>
        </ResponsiveSheetHeader>

        {facts.length > 0 && (
          <div data-slot="profile-facts" className="min-h-0 flex-1 overflow-y-auto p-4">
            <dl className="divide-border divide-y">
              {facts.map((fact) => (
                <Fact key={fact.label} label={fact.label} value={fact.value} />
              ))}
            </dl>
          </div>
        )}

        <ResponsiveSheetFooter className="flex-row gap-2 border-t p-4 empty:hidden">
          {projectPath && onOpenSession && (
            <Button size="sm" onClick={() => onOpenSession(projectPath)}>
              Open a session
            </Button>
          )}
          {member.isSelf && onEdit && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit profile
            </Button>
          )}
        </ResponsiveSheetFooter>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
