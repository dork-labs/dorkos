/**
 * One protected-file deny for every DorkOS tool that opens, reads or copies a
 * local file on an agent's behalf (DOR-4060): the canvas openers, its two
 * readers, and room attachments and canvas media.
 *
 * Those tools confine a path to the chat's folder, which says nothing about a
 * protected file inside that folder. So they also ask the SAME list the native
 * file tools deny (`PROTECTED_PATHS`, through {@link isProtectedPath}), against the
 * real path, symlinks resolved.
 *
 * And a file with more than one hard link is refused outright. A hard link is
 * the same file under a second name, so its path cannot say what it is; the
 * only tell is the link count, read off the descriptor that is then read.
 *
 * @module services/runtimes/shared/policy/protected-file-guard
 */
import { statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { isProtectedPath } from './protected-path-check.js';
import { protectedPathRoots } from './protected-path-roots.js';

/** Which rule refused the file. */
export type ProtectedFileRefusalCode = 'PROTECTED_FILE' | 'LINKED_FILE';

/** A file this guard refused, with the sentence the agent reads as-is. */
export interface ProtectedFileRefusal {
  /** Which rule refused it. */
  code: ProtectedFileRefusalCode;
  /** The sentence. */
  message: string;
}

/** The name a refusal shows: the file's own name, never the folder it sits in. */
function labelOf(target: string): string {
  return path.basename(target) || target;
}

/**
 * Why a DorkOS tool may not open this file for an agent, by its path, or `null`.
 * Fails closed: a path that cannot be checked is refused.
 *
 * @param target - The file, absolute or relative to `cwd`.
 * @param cwd - The folder the chat stands in.
 * @param folders - More folders the agent may name files in (its own copies of
 *   a room's files), so their folder-secret names are refused too.
 */
export function protectedPathRefusal(
  target: string,
  cwd: string,
  folders: readonly string[] = []
): ProtectedFileRefusal | null {
  let refused: boolean;
  try {
    const roots = protectedPathRoots(cwd);
    refused = isProtectedPath(target, 'read', {
      ...roots,
      agentFolders: [...new Set([...roots.agentFolders, ...folders])],
    });
  } catch {
    refused = true;
  }
  if (!refused) return null;
  return {
    code: 'PROTECTED_FILE',
    message: `${labelOf(target)} is a protected file, so DorkOS tools can't open or share it.`,
  };
}

/**
 * Why a DorkOS tool may not read this file, by its link count, or `null`.
 * Ask it of the descriptor that will be read, so the file cannot change between.
 *
 * @param stat - The file's stat, from the open descriptor.
 * @param target - The file's path, for the sentence.
 */
export function linkedFileRefusal(
  stat: Pick<Stats, 'isFile' | 'nlink'>,
  target: string
): ProtectedFileRefusal | null {
  if (!stat.isFile() || stat.nlink <= 1) return null;
  return {
    code: 'LINKED_FILE',
    message:
      `${labelOf(target)} has more than one hard link, so DorkOS tools can't open or share it. ` +
      'Open a plain copy instead.',
  };
}

/**
 * Why a document may not name this file at all, asked before anything is
 * recorded: its path, then its link count when it is there now. A file that is
 * not there yet passes; the readers ask again when they read it.
 *
 * @param target - The file, absolute or relative to `cwd`.
 * @param cwd - The folder the chat stands in.
 */
export function protectedSourceRefusal(target: string, cwd: string): ProtectedFileRefusal | null {
  const byPath = protectedPathRefusal(target, cwd);
  if (byPath) return byPath;
  try {
    return linkedFileRefusal(statSync(path.resolve(cwd, target)), target);
  } catch {
    return null;
  }
}
