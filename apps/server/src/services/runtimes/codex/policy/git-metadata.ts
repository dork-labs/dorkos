/** Explicit git metadata restrictions that an overlapping writable temp root cannot reopen. */
import fs from 'node:fs';
import path from 'node:path';
import { realPathOf } from '@dorkos/shared/directory-grants';
import { findGitPlaces, type BrokenGitPointer } from '@dorkos/shared/safe-git';
import {
  isProtectedPath,
  type ProtectedPathRoots,
} from '../../../core/protected-paths/protected-path-check.js';

/** Why Codex can't keep a folder's Git or secret files safe. */
export type GitMetadataRefusal =
  'inside-git-folder' | 'missing-git-folder' | 'protected-folder' | 'unreadable' | 'backslash-path';

const REFUSAL_COPY: Record<GitMetadataRefusal, string> = {
  'inside-git-folder': 'Codex can’t work inside a Git folder. Choose the project folder instead.',
  'missing-git-folder':
    'This worktree’s Git folder is missing. Repair the worktree, or choose another folder.',
  'protected-folder':
    'Codex can’t keep Git files safe inside a protected folder on Linux. Choose another folder.',
  unreadable: 'Codex can’t read this folder’s Git files. Choose another folder.',
  'backslash-path':
    'Codex can’t protect a folder with a backslash in its path. Choose another folder.',
};

/**
 * An unsupported file policy needs a different folder, not another retry: the
 * folder's Git files, or (`backslash-path`) its secret files, can't be protected.
 */
export class CodexGitMetadataPolicyError extends Error {
  /**
   * Build the refusal; its message is the reason's own headline.
   *
   * @param reason - What stops the protection; it picks the headline.
   * @param cause - The specific path and failure, shown as the details.
   */
  constructor(
    readonly reason: GitMetadataRefusal,
    cause: Error
  ) {
    super(REFUSAL_COPY[reason], { cause });
    this.name = 'CodexGitMetadataPolicyError';
  }
}

/** How {@link gitMetadataReadRules} renders for one turn. */
export interface GitMetadataOptions {
  /** Whether the rules are applied: below Full. Full writes Git files anyway. */
  enforced?: boolean;
  /** Folders this turn's commands may write; a missing git folder in one could be made. */
  writable?: readonly string[];
  /** Native sandbox strategy; Linux cannot mount these nested denials. */
  platform?: NodeJS.Platform;
}

/** Whether a command allowed to write `dirs` could create `missing`. */
function creatable(missing: string, dirs: readonly string[]): boolean {
  const spellings = [path.resolve(missing), realPathOf(path.resolve(missing))];
  return dirs
    .flatMap((dir) => [path.resolve(dir), realPathOf(dir)])
    .some((dir) => spellings.some((file) => file === dir || file.startsWith(dir + path.sep)));
}

function refuse(reason: GitMetadataRefusal, detail: string): never {
  throw new CodexGitMetadataPolicyError(reason, new Error(detail));
}

/**
 * Keep existing repository metadata readable, including worktree pointers and shared git directories.
 * Secret metadata stays denied. No git process runs and no path is created. A `.git` file git can't
 * follow stays read-only and leads nowhere, unless the folder it names could be made by this turn.
 *
 * @param folders - The turn's working folder and additional writable folders.
 * @param roots - The shared protected-file roots; a read rule must not reopen their secrets.
 * @param options - Whether the rules apply, what this turn can write, and the platform.
 */
export function gitMetadataReadRules(
  folders: readonly string[],
  roots: ProtectedPathRoots,
  { enforced = true, writable = [], platform = process.platform }: GitMetadataOptions = {}
): Record<string, 'read' | 'deny'> {
  const rules: Record<string, 'read' | 'deny'> = {};
  try {
    for (const folder of new Set(folders)) {
      const broken: BrokenGitPointer[] = [];
      const places = findGitPlaces(folder, { brokenPointers: broken });
      if (!places) refuse('inside-git-folder', `${folder} is inside a Git folder.`);
      // Git stops at such a file and reads no repository through it. The file
      // stays read-only below, so a command can't point it somewhere new.
      for (const { file, missing } of broken)
        if (enforced && missing && creatable(missing, writable))
          refuse('missing-git-folder', `${file} names ${missing}, which this chat could create.`);
      for (const gitDir of places.gitDirs) {
        // The shared discovery treats an absent commondir as an ordinary repository.
        // If one exists but cannot be read, it must not hide a worktree's shared metadata.
        const common = path.join(gitDir, 'commondir');
        try {
          if (fs.lstatSync(common, { throwIfNoEntry: false })) fs.readFileSync(common);
        } catch {
          refuse('unreadable', `${common} can’t be read.`);
        }
      }
      for (const target of [
        ...places.gitDirs,
        ...places.folders.map((dir) => path.join(dir, '.git')),
      ]) {
        if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        for (const spelling of new Set([path.resolve(target), fs.realpathSync.native(target)])) {
          const denied = isProtectedPath(spelling, 'read', roots);
          // Bubblewrap applies this exact deny before re-binding a writable
          // root. Under an already hidden ancestor, creating its mountpoint
          // would fail on read-only tmpfs. Refuse before running any tools;
          // dropping this deny would reopen secrets through that writable root.
          if (denied && enforced && platform === 'linux')
            refuse('protected-folder', `${spelling} is inside a protected folder.`);
          rules[spelling.split(path.sep).join('/')] = denied ? 'deny' : 'read';
        }
      }
    }
  } catch (cause) {
    if (cause instanceof CodexGitMetadataPolicyError) throw cause;
    throw new CodexGitMetadataPolicyError(
      'unreadable',
      cause instanceof Error ? cause : new Error(String(cause))
    );
  }
  return rules;
}
