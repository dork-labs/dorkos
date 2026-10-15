/**
 * Who an agent reports to, as the profile shows it (spec `heartbeats` §4.3).
 *
 * The server owns the chain (`services/heartbeats/reports-to.ts`); this is the
 * same rule read off the roster so the row can say a name without asking:
 * the agent `reportsTo` names, else whoever created it, else the owner. An id
 * the roster cannot name is skipped, exactly as the server skips a manager that
 * no longer exists.
 *
 * The owner is the one person the chain knows today. They read as "You" only
 * to the owner; anyone else reading sees the owner's name.
 *
 * @module features/profile/lib/profile-reports-to
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { findTeamOwner } from '@/layers/entities/team';

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

/** The owner as the picker needs them: their row, their account id, their label. */
interface OwnerView {
  member: TeamMember;
  accountId: string | null;
  label: string;
}

/** The mesh id an agent row is known by. */
function agentIdOf(member: TeamMember): string {
  return member.agent?.manifestId ?? member.id;
}

/** The roster row for an agent id, if the roster has one. */
function agentRow(roster: readonly TeamMember[], id: string): TeamMember | undefined {
  return roster.find((member) => member.kind === 'agent' && agentIdOf(member) === id);
}

/**
 * The owner of `agent` (or of the install, when the agent names none): "You"
 * when the owner is the one reading, their name otherwise.
 */
function ownerOf(agent: TeamMember | undefined, roster: readonly TeamMember[]): OwnerView | null {
  const member =
    (agent ? findTeamOwner(agent, [...roster]) : undefined) ??
    roster.find((candidate) => candidate.isSelf);
  if (!member) return null;
  return {
    member,
    accountId: member.person?.accountId ?? null,
    label: member.person?.isViewer ? 'You' : member.displayName,
  };
}

/**
 * Whether an account id names the owner: their account id, or one of the
 * aliases the server also reads as the owner (`owner`, `install:<id>`).
 */
function isOwnerId(id: string, owner: OwnerView | null): boolean {
  return id === owner?.accountId || id === 'owner' || id.startsWith('install:');
}

/**
 * Everyone an agent could report to: the owner first, then every other agent
 * by name. The agent itself is left out; the server refuses the rest of what
 * would loop.
 *
 * @param agentId - The mesh id of the agent being changed.
 * @param roster - The team roster.
 * @param agent - The agent's roster row, to find its owner.
 */
export function reportsToOptions(
  agentId: string,
  roster: readonly TeamMember[],
  agent?: TeamMember
): ReportsToOption[] {
  const owner = ownerOf(agent, roster);
  const people: ReportsToOption[] =
    owner?.accountId != null
      ? [{ accountId: owner.accountId, label: owner.label, kind: 'person', member: owner.member }]
      : [];
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
  /** The row's value: "You", "Juno", "You (default)", "Dorian (default)". */
  label: string;
  /** The account id the agent actually reports to, when the roster can name it. */
  accountId: string | null;
  /** True when nothing is set and the default chain decided. */
  isDefault: boolean;
}

/**
 * Who an agent reports to, in the words the row shows.
 *
 * @param manifest - The agent's `reportsTo` and `createdBy`.
 * @param roster - The team roster.
 * @param agent - The agent's roster row, to find its owner.
 */
export function describeReportsTo(
  manifest: Pick<AgentManifest, 'reportsTo' | 'createdBy'>,
  roster: readonly TeamMember[],
  agent?: TeamMember
): ReportsToSummary {
  const owner = ownerOf(agent, roster);
  const ownerLabel = owner?.label ?? 'You';
  const name = (
    id: string | null | undefined
  ): { label: string; accountId: string | null } | null => {
    if (!id) return null;
    if (isOwnerId(id, owner)) return { label: ownerLabel, accountId: owner?.accountId ?? id };
    const row = agentRow(roster, id);
    return row ? { label: row.displayName, accountId: id } : null;
  };

  const explicit = name(manifest.reportsTo);
  if (explicit) return { ...explicit, isDefault: false };
  const creator = name(manifest.createdBy);
  if (creator)
    return { label: `${creator.label} (default)`, accountId: creator.accountId, isDefault: true };
  return { label: `${ownerLabel} (default)`, accountId: owner?.accountId ?? null, isDefault: true };
}
