/**
 * Who an agent reports to, as the profile shows it (spec `heartbeats` §4.3).
 *
 * The server owns the chain (`services/heartbeats/reports-to.ts`); this is the
 * same rule read off the roster so the row can say a name without asking:
 * the agent `reportsTo` names, else whoever created it, else you. An id the
 * roster cannot name is skipped, exactly as the server skips a manager that no
 * longer exists.
 *
 * @module features/profile/lib/profile-reports-to
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';

/** One choice in the Reports to picker. */
export interface ReportsToOption {
  /** The account id saved as `reportsTo`. */
  accountId: string;
  /** What the picker calls it. */
  label: string;
  /** People are listed first, then agents. */
  kind: 'person' | 'agent';
  /** The roster row, for its face. */
  member: TeamMember;
}

/** The mesh id an agent row is known by. */
function agentIdOf(member: TeamMember): string {
  return member.agent?.manifestId ?? member.id;
}

/** The roster row for an agent id, if the roster has one. */
function agentRow(roster: readonly TeamMember[], id: string): TeamMember | undefined {
  return roster.find((member) => member.kind === 'agent' && agentIdOf(member) === id);
}

/** Your own account id, when the roster carries it. */
export function selfAccountId(roster: readonly TeamMember[]): string | null {
  return roster.find((member) => member.isSelf)?.person?.accountId ?? null;
}

/**
 * Everyone an agent could report to: you first, then every other agent by
 * name. The agent itself is left out; the server refuses the rest of what
 * would loop.
 *
 * @param agentId - The mesh id of the agent being changed.
 * @param roster - The team roster.
 */
export function reportsToOptions(
  agentId: string,
  roster: readonly TeamMember[]
): ReportsToOption[] {
  const people: ReportsToOption[] = roster
    .filter((member) => member.isSelf && member.person?.accountId)
    .map((member) => ({
      accountId: member.person!.accountId!,
      label: 'You',
      kind: 'person',
      member,
    }));
  const agents: ReportsToOption[] = roster
    .filter((member) => member.kind === 'agent' && agentIdOf(member) !== agentId)
    .map((member) => ({
      accountId: agentIdOf(member),
      label: member.displayName,
      kind: 'agent' as const,
      member,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...people, ...agents];
}

/** What the Reports to row says, and which option it amounts to. */
export interface ReportsToSummary {
  /** The row's value: "You", "Juno", "You (default)", "Juno (default)". */
  label: string;
  /** The account id the agent actually reports to, when the roster can name it. */
  accountId: string | null;
  /** True when nothing is set and the default chain decided. */
  isDefault: boolean;
}

/**
 * Who an agent reports to, in the words the row shows.
 *
 * @param agent - The agent's `reportsTo` and `createdBy`.
 * @param roster - The team roster.
 */
export function describeReportsTo(
  agent: Pick<AgentManifest, 'reportsTo' | 'createdBy'>,
  roster: readonly TeamMember[]
): ReportsToSummary {
  const self = selfAccountId(roster);
  const name = (id: string | null | undefined): { label: string; accountId: string } | null => {
    if (!id) return null;
    if (id === self) return { label: 'You', accountId: id };
    const row = agentRow(roster, id);
    return row ? { label: row.displayName, accountId: id } : null;
  };

  const explicit = name(agent.reportsTo);
  if (explicit) return { ...explicit, isDefault: false };
  const creator = name(agent.createdBy);
  if (creator)
    return { label: `${creator.label} (default)`, accountId: creator.accountId, isDefault: true };
  return { label: 'You (default)', accountId: self, isDefault: true };
}
