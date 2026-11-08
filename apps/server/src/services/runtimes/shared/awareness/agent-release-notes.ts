/**
 * Compiled, reviewed facts about new agent-facing features. Never load prose
 * from fragments, files or the network at runtime. Release stamps `next`.
 * @module runtimes/shared/awareness/agent-release-notes
 */
import { gt, lte, valid } from 'semver';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { getPermissionArea } from '@dorkos/shared/permissions';

/** A release fact with an explicit permission area or a static gate. */
export type AgentReleaseNote = {
  readonly version: string;
  readonly name: string;
  readonly can: string;
  readonly covers: readonly string[];
} & (
  | { readonly areas: readonly [PermissionAreaId, ...PermissionAreaId[]]; readonly gate?: string }
  | { readonly areas: readonly []; readonly gate: string }
);

/** Notes ship with the feature; unstamped notes can never render early. */
export const AGENT_RELEASE_NOTES: readonly AgentReleaseNote[] = [
  {
    version: 'next',
    name: 'New since you last ran',
    can: 'read a short note about new DorkOS features after an update.',
    covers: [],
    areas: [],
    gate: 'information only',
  },
];

/** Format the same static permission wording as the areas block, never a live level. */
export function releaseNoteLine(note: AgentReleaseNote): string {
  const labels = note.areas.map((id) => getPermissionArea(id)?.label ?? id);
  const permission = [...labels, ...(note.gate ? [note.gate] : [])].join('; ');
  return `${note.name}: ${note.can} [${permission}]`;
}

/** Select stamped notes in (seen, current], in their authored order. */
export function notesSince(
  seen: string,
  current: string,
  notes: readonly AgentReleaseNote[] = AGENT_RELEASE_NOTES
): readonly AgentReleaseNote[] {
  if (!valid(seen) || !valid(current) || !gt(current, seen)) return [];
  return notes.filter(
    (note) =>
      note.version !== 'next' &&
      valid(note.version) &&
      gt(note.version, seen) &&
      lte(note.version, current)
  );
}
