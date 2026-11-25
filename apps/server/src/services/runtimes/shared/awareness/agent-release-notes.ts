/**
 * Compiled, reviewed facts about new agent-facing features. Never load prose
 * from fragments, files or the network at runtime. A build reads `next` as its
 * own version; the back-merge after a release stamps it.
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

/**
 * Notes ship with the feature as `version: 'next'`; a `next` note renders only
 * in a built release, as that release's version.
 */
export const AGENT_RELEASE_NOTES: readonly AgentReleaseNote[] = [
  {
    version: '0.133.0',
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

declare const __CLI_VERSION__: string | undefined;

/**
 * The version this build was made as, set by the CLI and desktop bundlers, or
 * `null` in a source run. A daily release can't edit code (DOR-5123), so a
 * `next` note it ships is read as this version; the back-merge then stamps it
 * on main (`scripts/release/stamp-release-notes.ts`).
 */
export const BUILT_VERSION: string | null =
  typeof __CLI_VERSION__ !== 'undefined' && valid(__CLI_VERSION__) ? __CLI_VERSION__ : null;

/**
 * Select notes in (seen, current], in their authored order. A `next` note
 * counts as `builtAs`, and stays silent when the build has no version.
 */
export function notesSince(
  seen: string,
  current: string,
  notes: readonly AgentReleaseNote[] = AGENT_RELEASE_NOTES,
  builtAs: string | null = BUILT_VERSION
): readonly AgentReleaseNote[] {
  if (!valid(seen) || !valid(current) || !gt(current, seen)) return [];
  return notes.filter((note) => {
    const version = note.version === 'next' ? builtAs : note.version;
    return version !== null && !!valid(version) && gt(version, seen) && lte(version, current);
  });
}
