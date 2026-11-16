/** Explicit git metadata restrictions that an overlapping writable temp root cannot reopen. */
import fs from 'node:fs';
import path from 'node:path';
import { findGitPlaces } from '@dorkos/shared/safe-git';
import {
  isProtectedPath,
  type ProtectedPathRoots,
} from '../../shared/policy/protected-path-check.js';

/** An unsupported metadata policy needs a different folder, not another retry. */
export class CodexGitMetadataPolicyError extends Error {
  constructor(cause: unknown) {
    super('Codex can’t protect this folder’s Git files. Choose another folder.', { cause });
    this.name = 'CodexGitMetadataPolicyError';
  }
}

/**
 * Keep existing repository metadata readable, including worktree pointers and shared git directories.
 * Secret metadata stays denied. No git process runs and no path is created; unreadable pointers refuse.
 *
 * @param folders - The turn's working folder and additional writable folders.
 * @param roots - The shared protected-file roots; a read rule must not reopen their secrets.
 * @param platform - Native sandbox strategy; Linux cannot mount these nested denials.
 */
export function gitMetadataReadRules(
  folders: readonly string[],
  roots: ProtectedPathRoots,
  platform: NodeJS.Platform = process.platform
): Record<string, 'read' | 'deny'> {
  const rules: Record<string, 'read' | 'deny'> = {};
  try {
    for (const folder of new Set(folders)) {
      const places = findGitPlaces(folder);
      if (!places) throw new Error('Git metadata could not be resolved.');
      for (const gitDir of places.gitDirs) {
        // The shared discovery treats an absent commondir as an ordinary repository.
        // If one exists but cannot be read, it must not hide a worktree's shared metadata.
        const common = path.join(gitDir, 'commondir');
        if (fs.lstatSync(common, { throwIfNoEntry: false })) fs.readFileSync(common);
      }
      for (const target of [
        ...places.gitDirs,
        ...places.folders.map((dir) => path.join(dir, '.git')),
      ]) {
        if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        for (const spelling of new Set([path.resolve(target), fs.realpathSync.native(target)])) {
          // Codex treats these as patterns, and does not support read-only wildcard entries.
          if (/[*?[\]{}]/.test(spelling)) throw new Error('Git metadata needs a literal path.');
          const denied = isProtectedPath(spelling, 'read', roots);
          // Bubblewrap applies this exact deny before re-binding a writable
          // root. Under an already hidden ancestor, creating its mountpoint
          // would fail on read-only tmpfs. Refuse before running any tools;
          // dropping this deny would reopen secrets through that writable root.
          if (denied && platform === 'linux')
            throw new Error('Git metadata is inside a protected folder.');
          rules[spelling.split(path.sep).join('/')] = denied ? 'deny' : 'read';
        }
      }
    }
  } catch (cause) {
    throw new CodexGitMetadataPolicyError(cause);
  }
  return rules;
}
