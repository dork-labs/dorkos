/**
 * A turn's folder grants on OpenCode, enforced where the sidecar asks (spec
 * `agent-home-desk` §4.4, the ask-handler route).
 *
 * The sidecar raises `external_directory` whenever a tool reaches outside the
 * session's directory, and `edit` for every file write (DorkOS spawns it with
 * `edit: 'ask'`). {@link resolveGrantVerdict} answers both from THIS turn's
 * grants: a reach inside a grant is allowed, and a file write inside a `read`
 * grant is refused in every permission mode, bypass included. Anything the
 * grants say nothing about falls through to the session's mode, exactly as
 * before.
 *
 * ## Why not per-session rules (`session.update({ permission })`)
 *
 * The spec's first choice. Run against a live 1.18.31 sidecar with a local
 * model on 2026-09-26 (DOR-2408):
 *
 * - An `external_directory: allow` rule set that way DID stop the ask for a
 *   read inside the grant (the control, with no rule, asked).
 * - But `session.update` APPENDS to the stored ruleset: a later update with a
 *   different set, with `[]`, or with `null` left every earlier rule in place.
 *   Taking a grant away needs a counter-rule appended after it, and the stored
 *   list only grows — and a server restart forgets which rules it wrote.
 * - And an `edit: deny` rule on the granted folder did NOT stop the write ask:
 *   the edit tools ask with a path relative to the project's worktree, never
 *   the absolute one a grant names, so the rule never matched.
 *
 * Answering the ask needs neither: the decision is made from the grants the
 * turn carries, so a grant an earlier turn had is simply not consulted (I5),
 * and nothing is left behind in the sidecar's store. A subagent's asks reach
 * the same pass, so its reach is bounded by the same grants.
 *
 * @module services/runtimes/opencode/messaging/directory-grants
 */
import path from 'node:path';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import {
  assertValidDirectoryGrants,
  isSameOrInside,
  realPathOf,
} from '@dorkos/shared/directory-grants';
import type { ApprovalEvent } from '@dorkos/shared/types';

/** How this turn's grants answer one ask; `undefined` means they say nothing. */
export type GrantVerdict = 'allow' | 'deny' | undefined;

/** The metadata fields the 1.18.x tools put on the asks this module answers. */
interface AskDetails {
  patterns?: unknown;
  filepath?: unknown;
  parentDir?: unknown;
  directories?: unknown;
  files?: unknown;
}

/** An absolute path, or nothing. */
function absolute(value: unknown): string | undefined {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value) : undefined;
}

/**
 * Whether `asked` really sits in `folder`: judged on where the filesystem
 * resolves it, so a symlink committed inside a granted folder cannot stretch
 * the grant to wherever it points (spec §10, room content cannot widen a grant).
 */
function reallyWithin(asked: string, folder: string): boolean {
  return isSameOrInside(realPathOf(asked), realPathOf(folder));
}

/**
 * Whether `asked` touches `folder` by either spelling — the refusal side, where
 * erring toward refusing is the safe way round.
 */
function touches(asked: string, folder: string): boolean {
  return isSameOrInside(asked, folder) || reallyWithin(asked, folder);
}

/** Every absolute path an ask names, from wherever the tool put one. */
function askedPaths(permission: string, details: AskDetails): string[] {
  const found: (string | undefined)[] = [absolute(details.filepath)];
  if (permission === 'external_directory') {
    found.push(absolute(details.parentDir));
    if (Array.isArray(details.directories)) found.push(...details.directories.map(absolute));
    // `<dir>/*` — the pattern the sidecar matches rules against.
    if (Array.isArray(details.patterns)) {
      for (const pattern of details.patterns) {
        if (typeof pattern === 'string') found.push(absolute(pattern.replace(/[\\/]\*+$/, '')));
      }
    }
  } else if (Array.isArray(details.files)) {
    // `apply_patch` lists its files here; its `filepath` is worktree-relative.
    for (const file of details.files as { filePath?: unknown; movePath?: unknown }[]) {
      found.push(absolute(file?.filePath), absolute(file?.movePath));
    }
  }
  return found.filter((entry): entry is string => entry !== undefined);
}

/**
 * Answer one sidecar ask from this turn's grants.
 *
 * - `external_directory`: `allow` when every folder it names is inside a grant.
 * - `edit`: `deny` when any file it names is inside a `read` grant. A `read`
 *   folder wins over a `write` grant nested in it, matching the path-prefix
 *   deny rules claude-code gets (spec §4.1).
 *
 * @param approval - The mapped ask (`toolName` is the permission key, `input` its details as JSON).
 * @param grants - The grants THIS turn carries.
 */
export function resolveGrantVerdict(
  approval: Pick<ApprovalEvent, 'toolName' | 'input'>,
  grants: readonly DirectoryGrant[]
): GrantVerdict {
  if (grants.length === 0) return undefined;
  if (approval.toolName !== 'external_directory' && approval.toolName !== 'edit') return undefined;
  let details: AskDetails;
  try {
    details = JSON.parse(approval.input) as AskDetails;
  } catch {
    return undefined;
  }
  if (typeof details !== 'object' || details === null) return undefined;
  const paths = askedPaths(approval.toolName, details);
  if (paths.length === 0) return undefined;
  if (approval.toolName === 'external_directory') {
    const covered = paths.every((asked) => grants.some((grant) => reallyWithin(asked, grant.path)));
    return covered ? 'allow' : undefined;
  }
  const readOnly = grants.filter((grant) => grant.access === 'read');
  const refused = paths.some((asked) => readOnly.some((grant) => touches(asked, grant.path)));
  return refused ? 'deny' : undefined;
}

/**
 * This turn's grants, checked before anything reaches the sidecar.
 *
 * @param grants - The turn's grants; absent means none.
 * @param cwd - The directory the turn runs in.
 * @throws DirectoryGrantError when the set is invalid.
 */
export function validatedGrants(
  grants: readonly DirectoryGrant[] | undefined,
  cwd: string
): readonly DirectoryGrant[] {
  if (!grants || grants.length === 0) return [];
  assertValidDirectoryGrants(grants, cwd);
  return grants;
}
