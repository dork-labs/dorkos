/**
 * Reading the roster: what the page filters, searches and clusters it by.
 *
 * Every function here takes the roster as a **list** and returns a list. That
 * is the spec's binding rule for the Buzz future (§W2.6) rather than a style
 * preference: nothing may branch on "there is exactly one person", so there is
 * no `operator` argument, no self-vs-others split, and no shape that gets
 * harder to fill when a second person arrives.
 *
 * @module entities/team/lib/team-roster-selectors
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';

/** Which kinds of identity the roster is showing. */
export type TeamKindFilter = 'all' | 'people' | 'agents';

/** Whether agent cards cluster under the person they belong to. */
export type TeamGrouping = 'none' | 'manager';

/**
 * Everything the roster is filtered by — the shape `/team`'s search params
 * carry, so a filtered roster is an address someone can send.
 *
 * A superset is accepted everywhere this is read (the route also carries
 * `view`, `member` and `sort`), so the router can hand its whole `search`
 * object straight in.
 */
export interface TeamRosterFilters {
  /** The kind chips. */
  kind: TeamKindFilter;
  /** A person's roster id — narrows to them and the agents they own. */
  owner?: string;
  /** The group-by-manager toggle. */
  group: TeamGrouping;
  /** Free text, matched against display names and handles. */
  q?: string;
}

/** What the roster shows before anyone touches a control. */
export const DEFAULT_TEAM_FILTERS: TeamRosterFilters = { kind: 'all', group: 'none' };

/**
 * Does this row survive the kind chips?
 *
 * `system` (a room's own voice) is neither a person nor an agent, so it shows
 * under `all` and under neither of the two narrowing chips. Nothing serves one
 * on the roster today; it is handled rather than assumed away, because
 * `AuthorKind` admits it and a silent miscategorisation is worse than a row
 * that only appears when nothing is filtered.
 */
function matchesKind(member: TeamMember, kind: TeamKindFilter): boolean {
  if (kind === 'people') return member.kind === 'human';
  if (kind === 'agents') return member.kind === 'agent';
  return true;
}

/**
 * Does this row belong to the person the roster is narrowed to?
 *
 * The person themselves counts, which is what makes "click a person" read as
 * "them and their agents" rather than "their agents, and where did they go".
 */
function matchesOwner(member: TeamMember, owner: string | undefined): boolean {
  if (!owner) return true;
  return member.id === owner || member.ownerId === owner;
}

/**
 * Does this row match the search box?
 *
 * Display name and handle, case-insensitively. A leading `@` is stripped from
 * the query because typing one is how people write a handle, and a search that
 * went dead the moment someone did would be the kind of small wrongness this
 * page is supposed to not have.
 */
function matchesQuery(member: TeamMember, q: string | undefined): boolean {
  const needle = q?.trim().replace(/^@/, '').toLowerCase();
  if (!needle) return true;
  if (member.displayName.toLowerCase().includes(needle)) return true;
  return member.handle !== null && member.handle.toLowerCase().includes(needle);
}

/**
 * Narrow the roster by the chips, the owner filter and the search box.
 *
 * Order is preserved, because order is the endpoint's contract: the operator
 * first, then everyone else, then the agents (`aggregate-team.ts`). Re-sorting
 * here would fight a decision already made on the server.
 *
 * @param members - The roster, as the endpoint returned it.
 * @param filters - What the page's controls currently say.
 */
export function filterTeamMembers(members: TeamMember[], filters: TeamRosterFilters): TeamMember[] {
  return members.filter(
    (member) =>
      matchesKind(member, filters.kind) &&
      matchesOwner(member, filters.owner) &&
      matchesQuery(member, filters.q)
  );
}

/** One cluster of the roster: a person, and the identities that belong to them. */
export interface TeamOwnerGroup {
  /**
   * The person this cluster belongs to, or `null` for the trailing cluster of
   * identities nobody owns — a system agent, and anyone who owns nothing.
   */
  owner: TeamMember | null;
  /** The rows drawn under the header, in roster order. */
  members: TeamMember[];
}

/**
 * Cluster the roster under the person each identity belongs to.
 *
 * A person who heads a cluster is drawn as its header and **not** repeated as a
 * card inside the trailing group — the cluster header is that person's own
 * lockup, and drawing them twice would say the same thing twice.
 *
 * Owners are looked up in the **whole** roster rather than the filtered slice,
 * so narrowing to Agents still names who each cluster belongs to instead of
 * collapsing every cluster into "unowned".
 *
 * @param members - The already-filtered rows to cluster.
 * @param roster - The whole roster, for resolving owners the filter removed.
 */
export function groupTeamByOwner(members: TeamMember[], roster: TeamMember[]): TeamOwnerGroup[] {
  const byId = new Map(roster.map((member) => [member.id, member]));

  // Cluster order follows first appearance in the already-ordered rows, which
  // puts the operator's cluster first for the same reason their card is first.
  const clusters = new Map<string, TeamMember[]>();
  for (const member of members) {
    if (member.ownerId === null) continue;
    const bucket = clusters.get(member.ownerId);
    if (bucket) bucket.push(member);
    else clusters.set(member.ownerId, [member]);
  }

  const groups: TeamOwnerGroup[] = [...clusters].map(([ownerId, owned]) => ({
    owner: byId.get(ownerId) ?? null,
    members: owned,
  }));

  const unowned = members.filter((member) => member.ownerId === null && !clusters.has(member.id));
  if (unowned.length > 0) groups.push({ owner: null, members: unowned });

  return groups;
}

/**
 * The person an agent belongs to, or `undefined` when nothing owns it or the
 * owner is not on this roster.
 *
 * @param member - The row whose owner is wanted.
 * @param roster - The whole roster to resolve against.
 */
export function findTeamOwner(member: TeamMember, roster: TeamMember[]): TeamMember | undefined {
  if (member.ownerId === null) return undefined;
  return roster.find((candidate) => candidate.id === member.ownerId);
}

/**
 * How many agents on this roster belong to one person.
 *
 * Counts agents and only agents. The owner's own card is not one of their
 * agents, and a person cannot own a person — so this answers "how many things
 * would still be here if you narrowed to them", which is the sentence the
 * roster's attribution previews.
 *
 * Counted over the **whole** roster rather than the filtered slice, for the
 * same reason owners are resolved against it: a number that shrank as you typed
 * in the search box would be describing the search, not the person.
 *
 * @param ownerId - The person whose agents are being counted.
 * @param roster - The whole roster to count within.
 */
export function countOwnedAgents(ownerId: string, roster: TeamMember[]): number {
  return roster.filter((member) => member.kind === 'agent' && member.ownerId === ownerId).length;
}

/**
 * How to name an identity in one short string: its handle when it has one,
 * its display name when it does not.
 *
 * The fallback is the spec's own degradation for an install where handles have
 * not been claimed yet (§W0) — never a bare `@`, which would name nobody and
 * reach nobody.
 *
 * @param member - The identity to name.
 */
export function teamMemberLabel(member: TeamMember): string {
  return member.handle === null ? member.displayName : `@${member.handle}`;
}
