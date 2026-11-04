/** Codex named filesystem policies. Legacy sandbox flags must never accompany these. */
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
import { collapseProtectedPaths } from './collapse-protected-paths.js';

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
function protectedEntries({ roots, writable }: CodexFilePolicy): Record<string, 'read' | 'deny'> {
  const entries: Record<string, 'read' | 'deny'> = {};
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
                ? [...roots.agentHomes, path.join(roots.data, 'agents', '*')]
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
          isProtectedPath(file, 'read', roots) ||
          entries[file] === 'deny'
            ? 'deny'
            : 'read';
        entries[file] = access;
        // A glob matching the folder itself does not cover files already inside it.
        if (entry.kind === 'folder' && file.includes('*')) entries[`${file}/**`] = 'deny';
      }
  }
  return collapseProtectedPaths(entries, [
    roots.home,
    roots.data,
    roots.cwd,
    ...writable,
    ...roots.agentFolders,
    ...roots.agentHomes,
    ...roots.accounts,
  ]);
}

/**
 * All three modes carry the same refusals. Full grants broad access around
 * those refusals; it never switches to danger-full-access, which drops them.
 * Profile globs have the upstream process-start snapshot limits on Linux and Windows.
 * Anywhere rules are bounded to the captured roots: other volumes or temporary
 * folders outside every prefix are not covered by those native shell denies.
 */
export function codexProtectedConfig(
  cwd: string,
  policy: CodexFilePolicy = { roots: protectedPathRoots(cwd), writable: [] },
  settings: Pick<SessionSettings, 'permissionMode'> = {}
): NonNullable<CodexOptions['config']> {
  const protectedFiles = protectedEntries(policy);
  const mode = MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only';
  return {
    permissions: {
      [codexPermissionProfile(settings)]: {
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
