/**
 * What a space's Settings tab says, worked out from what the space sent (DOR-3005). Pure, so
 * every sentence and grouping is tested without drawing anything.
 *
 * @module features/space-settings/lib/space-view
 */
import { fnv1aHash } from '@/layers/shared/lib';
import type { CommunitySpaceReadResult } from '@dorkos/shared/community-space-settings';
import type {
  CommunityWireDirectoryMember,
  CommunityWireMemberDirectoryPage,
} from '@dorkos/shared/community-wire';

/** A person's role in a space. */
export type SpaceRole = 'owner' | 'admin' | 'member';

/** One person in the Members list, with the agents they brought. */
export interface SpacePerson {
  person: CommunityWireDirectoryMember;
  agents: CommunityWireDirectoryMember[];
}

/** The role, as the header's last clause says it. */
export function roleClause(role: SpaceRole): string {
  if (role === 'owner') return 'You’re the owner';
  if (role === 'admin') return 'You’re an admin';
  return 'You’re a member';
}

/** The role, as a Members row shows it. */
export function roleLabel(role: SpaceRole | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

/** Who can join, in plain words. */
export function admissionLabel(
  policy: CommunitySpaceReadResult<'settings'>['value']['admissionPolicy']
): string {
  if (policy === 'invite_only') return 'Invite only';
  if (policy === 'closed') return 'Closed';
  return 'Anyone who signs in';
}

/**
 * People in directory order, each with the agents they own. An agent whose owner is not on the
 * page is left out: an agent sits under its person, never alone.
 */
export function groupPeople(page: CommunityWireMemberDirectoryPage): SpacePerson[] {
  const byOwner = new Map<string, CommunityWireDirectoryMember[]>();
  for (const agent of page.agents ?? []) {
    if (!agent.ownerMemberId) continue;
    byOwner.set(agent.ownerMemberId, [...(byOwner.get(agent.ownerMemberId) ?? []), agent]);
  }
  return page.members.map((person) => ({ person, agents: byOwner.get(person.memberId) ?? [] }));
}

/** "4 people · 3 agents", or "1 person" when the space sent no agents. */
export function headcount(people: readonly SpacePerson[], agentsKnown: boolean): string {
  const agents = people.reduce((sum, row) => sum + row.agents.length, 0);
  const peopleText = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
  if (!agentsKnown) return peopleText;
  return `${peopleText} · ${agents} ${agents === 1 ? 'agent' : 'agents'}`;
}

/** "@alex · 1 agent" under a person's name. */
export function personDetail(row: SpacePerson): string {
  const count = row.agents.length;
  return count === 0
    ? `@${row.person.handle}`
    : `@${row.person.handle} · ${count} ${count === 1 ? 'agent' : 'agents'}`;
}

/**
 * Whether an agent is there: "Available", "Away since 9:40", or nothing when no app ever said.
 *
 * @param agent - The agent's row.
 * @param locale - For the time, in tests.
 */
export function availabilityLabel(
  agent: CommunityWireDirectoryMember,
  locale?: string
): string | null {
  if (agent.availability === 'available') return 'Available';
  if (agent.availability === 'offline' && agent.lastSeenAt)
    return `Away since ${new Date(agent.lastSeenAt).toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  return null;
}

/**
 * How long ago the space last answered, for the offline line: "2 hours ago", "just now".
 *
 * @param fetchedAt - When the space sent the value shown.
 * @param now - The current time, in tests.
 */
export function sinceLabel(fetchedAt: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(fetchedAt)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** The first letter of a name, for a space or agent tile. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
}

/** Two initials for a person: "Alex Kim" → "AK". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return letters.map((word) => initialOf(word)).join('') || '?';
}

/**
 * A tile's color, the same for one id everywhere: its hue hashed from the id, dark enough that
 * the white letter on it reads in both themes.
 */
export function tileColor(id: string): string {
  return `hsl(${fnv1aHash(id) % 360}, 40%, 36%)`;
}
