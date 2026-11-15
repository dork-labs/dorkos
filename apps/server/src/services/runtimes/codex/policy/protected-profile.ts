/** Codex named filesystem policies. Legacy sandbox flags must never accompany these. */
import fs from 'node:fs';
import os from 'node:os';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import path from 'node:path';
import { realPathOf } from '@dorkos/shared/directory-grants';
import type { CodexOptions } from '@openai/codex-sdk';
import type { SessionSettings } from '@dorkos/shared/types';
import { PROTECTED_PATHS } from '../../shared/policy/protected-paths.js';
import {
  isProtectedPath,
  type ProtectedPathRoots,
} from '../../shared/policy/protected-path-check.js';
import { protectedPathRoots } from '../../shared/policy/protected-path-roots.js';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import { readMountTargets, emptyOwnedMountTarget } from './mount-target-ledger.js';
import { collapseProtectedPaths } from './collapse-protected-paths.js';
import { keepScansOutOfHiddenFolders } from './hidden-folder-scans.js';

/** Stable reserved names; the profile selection is explicit on every thread load and turn. */
export function codexPermissionProfile(settings: Pick<SessionSettings, 'permissionMode'>): string {
  return `dorkos-files-${MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only'}`;
}

/** Where to grant writes and where to refuse native reads or writes on this turn. */
export interface CodexFilePolicy {
  roots: ProtectedPathRoots;
  writable: readonly string[];
}

/** Render the shared protected list in Codex's absolute path/glob spelling. */
function protectedEntries(
  { roots, writable }: CodexFilePolicy,
  onMissingTargets?: (targets: string[]) => void
): Record<string, 'read' | 'deny'> {
  const entries: Record<string, 'read' | 'deny'> = {};
  // Codex's rg and internal walkers disagree on fixed-depth glob suffixes.
  // Capture existing homes literally; a new home is protected on next render.
  // Only directory Dirents are included; symlink entries are not followed.
  let discoveredHomes: string[];
  const savedCopies: string[] = [];
  try {
    const agents = path.join(roots.data, 'agents');
    discoveredHomes = fs
      .readdirSync(agents, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (!isInstallSiblingName(entry.name)) return true;
        // Saved installs are not active homes, but skipping their protection
        // would leave a full copy of an agent's setup writable at Full.
        savedCopies.push(path.join(agents, entry.name));
        return false;
      })
      .map((entry) => path.join(agents, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    discoveredHomes = [];
  }
  const agentHomes = [...new Set([...roots.agentHomes, ...discoveredHomes])];
  const spellings = (dir: string) => [...new Set([path.resolve(dir), realPathOf(dir)])];
  const activeFolders = [roots.cwd, ...roots.agentFolders].flatMap(spellings);
  const otherHomes = agentHomes
    .filter((home) =>
      spellings(home).every((base) =>
        activeFolders.every((active) => active !== base && !active.startsWith(base + path.sep))
      )
    )
    .flatMap(spellings);

  const collapseBases = [
    roots.home,
    roots.data,
    roots.cwd,
    ...writable,
    ...roots.agentFolders,
    ...agentHomes,
    ...savedCopies,
    ...roots.accounts,
  ];
  let listed: Set<string> | undefined;
  const canProtectBlocking = (target: string) =>
    otherHomes.some((home) => target.startsWith(home + path.sep)) ||
    ((listed ??= new Set(readMountTargets(roots.data))).has(target) &&
      emptyOwnedMountTarget(target) !== undefined);
  const protectedRead = (file: string): boolean => {
    try {
      return isProtectedPath(file, 'read', roots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      // The shared check cannot walk through a regular file. Resolve only a
      // provable blocking literal here, preserving the stronger rule on the
      // file itself. Active-home failures become the same typed refusal.
      const [target] = Object.keys(
        collapseProtectedPaths({ [file]: 'read' }, collapseBases, undefined, canProtectBlocking)
      );
      return isProtectedPath(target!, 'read', roots);
    }
  };
  // Write carve-outs go first; a secret that also grants power must stay unreadable.
  for (const entry of [...PROTECTED_PATHS].sort((a, b) =>
    a.deny === b.deny ? 0 : a.deny === 'write' ? -1 : 1
  )) {
    const bases =
      entry.root === 'data'
        ? [roots.data]
        : entry.root === 'home'
          ? [roots.home]
          : entry.root === 'account'
            ? roots.accounts
            : entry.root === 'agent-folder'
              ? roots.agentFolders
              : entry.root === 'agent-home'
                ? agentHomes
                : [
                    roots.home,
                    roots.data,
                    roots.cwd,
                    ...writable,
                    ...roots.agentFolders,
                    ...roots.agentHomes,
                    ...roots.accounts,
                  ];
    for (const base of bases)
      for (const spelling of new Set([path.resolve(base), realPathOf(base)])) {
        // Bubblewrap refuses globs without a non-root directory prefix.
        // Refuse this launch rather than silently dropping its protected paths.
        if (spelling === path.parse(spelling).root)
          throw new Error(
            'Codex cannot protect files from a filesystem root. Choose a folder inside it.'
          );
        const nested = entry.root === 'anywhere' || entry.root === 'agent-folder';
        const file = path
          .join(spelling, ...(nested ? ['**'] : []), entry.path)
          .split(path.sep)
          .join('/');
        // The pinned binary only supports deny access on wildcard paths.
        // Broader refusal preserves the shared policy where read-only cannot be expressed.
        const access =
          entry.deny === 'read' ||
          file.includes('*') ||
          protectedRead(file) ||
          entries[file] === 'deny'
            ? 'deny'
            : 'read';
        entries[file] = access;
        // A glob matching the folder itself does not cover files already inside it.
        if (entry.kind === 'folder' && file.includes('*')) entries[`${file}/**`] = 'deny';
      }
  }
  const missing = new Set<string>();
  for (const saved of savedCopies.sort())
    entries[saved] =
      entries[saved] === 'deny' || isProtectedPath(saved, 'read', roots) ? 'deny' : 'read';
  const collapsed = collapseProtectedPaths(
    entries,
    collapseBases,
    (target) => missing.add(target),
    // No rule is dropped: foreign or live listed blockers become exact
    // protected files. The current home/cwd keeps the folder refusal.
    canProtectBlocking
  );
  onMissingTargets?.([...missing]);
  // `:workspace` also opens /tmp and $TMPDIR (what os.tmpdir() reads) for
  // writes, so they count as opened too.
  const tmp = [...new Set(['/tmp', os.tmpdir()])];
  return keepScansOutOfHiddenFolders(collapsed, [
    ...activeFolders,
    ...writable.flatMap(spellings),
    ...tmp.flatMap(spellings),
  ]);
}

/**
 * All three modes carry the same refusals. Full grants broad access around
 * those refusals; it never switches to danger-full-access, which drops them.
 * The browser sign-in stores Full may write elsewhere (DOR-4136) stay shut here:
 * each is a read secret too, and Codex has no write-only access to give one.
 * Profile globs have the upstream process-start snapshot limits on Linux and Windows.
 * Anywhere rules are bounded to the captured roots: other volumes or temporary
 * folders outside every prefix are not covered by those native shell denies.
 */
export function codexProtectedConfig(
  cwd: string,
  policy: CodexFilePolicy = { roots: protectedPathRoots(cwd), writable: [] },
  settings: Pick<SessionSettings, 'permissionMode'> = {},
  onMissingTargets?: (targets: string[]) => void
): NonNullable<CodexOptions['config']> {
  const protectedFiles = protectedEntries(policy, onMissingTargets);
  const mode = MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only';
  const profile = codexPermissionProfile(settings);
  return {
    // Codex rebuilds this layer without the request's selection (ChatGPT
    // workspace routing, 0.163); a `[permissions]` table without its default
    // then fails every turn with "failed to load workspace requirements".
    default_permissions: profile,
    permissions: {
      [profile]: {
        ...(mode !== 'danger-full-access'
          ? { extends: mode === 'workspace-write' ? ':workspace' : ':read-only' }
          : {}),
        filesystem: {
          ':root': mode === 'danger-full-access' ? 'write' : 'read',
          // Codex otherwise synthesizes missing metadata mounts at / for a
          // root-wide write policy. These exact overrides are not recursive;
          // shared protected entries below still win on any overlap.
          ...(mode === 'danger-full-access'
            ? Object.fromEntries(
                ['.git', '.agents', '.codex', '.aws'].map((name) => [
                  path.join(path.parse(cwd).root, name).split(path.sep).join('/'),
                  'write',
                ])
              )
            : {}),
          ...protectedFiles,
        },
        ...(mode === 'workspace-write'
          ? { workspace_roots: Object.fromEntries(policy.writable.map((dir) => [dir, true])) }
          : {}),
        network: { enabled: mode === 'danger-full-access' },
      },
    },
  };
}
