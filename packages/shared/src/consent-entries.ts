/**
 * How each standing consent decision is keyed in `~/.dork/config.json` (spec
 * `computer-side-starts-alone` §5.4, §5.7).
 *
 * The space side writes these entries when a person answers a card; the
 * computer side reads them to decide what a launch or a projection may run.
 * Both must key a decision the same way, so the formats live here and neither
 * side imports the other for them. Each entry names who or what it is about in
 * front, so a person can read their own config and see what they decided; the
 * digest behind it is what makes the entry stop matching the moment any of
 * those facts change.
 *
 * Node only (`node:crypto`, `node:fs`, `node:path`).
 *
 * @module shared/consent-entries
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  FOLDER_CONFIG_PARTS,
  type FolderAllowRequest,
  type FolderConfigDigests,
  type HookProjectionRequest,
  type RepoConfigKind,
} from './computer-asks.js';

// === Package hooks (`harness.approvedHooks`, `harness.refusedHooks`) ===

/**
 * The commands half of a hook entry, `<packageName>@<digest>`: the project
 * (resolved, so `/x/proj` and `/x/proj/` are one), and every hook's event,
 * matcher and command. Every entry for the same commands starts with it,
 * whatever files they ran when it was recorded.
 *
 * @param request - The package, project, and hooks to identify.
 * @returns The entry with no files pinned; compare with {@link sameHookCommands}.
 */
export function hookCommandsKey(request: HookProjectionRequest): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        path.resolve(request.projectPath),
        request.hooks.map((hook) => [hook.event, hook.matcher ?? null, hook.command]),
      ]),
      'utf8'
    )
    .digest('hex');
  return `${request.packageName}@${digest}`;
}

/**
 * The stored form of one hook decision: the commands key, then a digest of the
 * files those commands run when they name any. The same function keys a yes
 * and a no, which is what makes the two lists comparable.
 *
 * @param request - The package, project, and hooks to identify.
 * @returns The entry as it is stored in `harness.approvedHooks` or `harness.refusedHooks`.
 */
export function hookApprovalEntry(request: HookProjectionRequest): string {
  const commands = hookCommandsKey(request);
  const scripts = request.scripts ?? [];
  if (scripts.length === 0) return commands;
  const pinned = createHash('sha256').update(JSON.stringify(scripts), 'utf8').digest('hex');
  return `${commands}.${pinned}`;
}

/**
 * Whether a stored entry is about the same commands as `key`, whatever files it
 * pinned.
 *
 * @param stored - A stored entry.
 * @param key - An entry with no files pinned (`<packageName>@<digest>`).
 * @returns True when both name the same package, project and commands.
 */
export function sameHookCommands(stored: string, key: string): boolean {
  return stored === key || stored.startsWith(`${key}.`);
}

/**
 * The package name half of a stored entry. Split on the LAST `@`, because a
 * scoped package name carries one of its own (`@acme/tools@<digest>`) and the
 * digest never does.
 *
 * @param entry - A stored `<packageName>@<digest>` entry.
 * @returns The package name, or the whole entry when it carries no `@`.
 */
export function hookEntryPackageName(entry: string): string {
  const at = entry.lastIndexOf('@');
  return at <= 0 ? entry : entry.slice(0, at);
}

// === An agent folder's allow list (`permissions.approvedFolderAllows`, `refusedFolderAllows`) ===

/** What sits between the agent id and the digest in a folder allow list entry. */
export const FOLDER_ALLOWS_ENTRY_MARKER = '@folder-allows-';

/**
 * The stored form of one decision about one agent's list: keyed by agent id,
 * not folder, so a new agent registered at an old folder starts unapproved.
 *
 * @param request - The agent, its home and its rules.
 */
export function folderAllowEntry(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ home: path.resolve(request.home), rules: request.rules }))
    .digest('hex');
  return `${request.agentId}${FOLDER_ALLOWS_ENTRY_MARKER}${digest}`;
}

// === An agent folder's settings (`harness.approvedFolderConfig`, `refusedFolderConfig`) ===

/** What sits between the agent id and the digest in a folder settings entry. */
export const FOLDER_CONFIG_ENTRY_MARKER = '@folder-config-';

/** A home by its real path, or as resolved when it is not there. */
function canonicalHome(home: string): string {
  const resolved = path.resolve(home);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The stored form of one decision about one state of one agent's settings.
 *
 * @param state - The agent, its home and the part digests.
 */
export function folderConfigEntry(state: {
  agentId: string;
  home: string;
  digests: FolderConfigDigests;
}): string {
  const parts = Object.fromEntries(FOLDER_CONFIG_PARTS.map((p) => [p, state.digests[p]]));
  const digest = createHash('sha256')
    .update(JSON.stringify({ home: canonicalHome(state.home), parts }))
    .digest('hex');
  return `${state.agentId}${FOLDER_CONFIG_ENTRY_MARKER}${digest}`;
}

// === A repo's settings (`harness.approvedRepoConfig`, `refusedRepoConfig`) ===

/** What sits between the kind and the digest in a repo settings entry. */
export const REPO_CONFIG_ENTRY_MARKER = '@repo-config-';

/**
 * The stored form of one decision about one repo setting's content. Keyed by
 * content alone, so the yes covers exactly this content wherever it appears.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function repoConfigEntry(kind: RepoConfigKind, digest: string): string {
  return `${kind}${REPO_CONFIG_ENTRY_MARKER}${digest}`;
}

/**
 * A worktree's name, as a card and an Activity line say it: its folder's name.
 *
 * @param cwd - The worktree's folder.
 */
export function worktreeName(cwd: string): string {
  return path.basename(path.resolve(cwd)) || cwd;
}
