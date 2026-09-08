/**
 * What is at a path — asked in the three ways the apply stage needs, and never
 * by throwing.
 *
 * These are separated from `apply.ts` because a *dead symlink* is the one shape
 * that answers differently to each question: it EXISTS (`lstat` sees it), it is
 * a SYMLINK, and it resolves to NOTHING. Reading it throws, following it writes
 * somewhere else, and treating it as an occupant protects a file that is not
 * there. Every caller in this package that touches a target has to be explicit
 * about which of the three it means, so the questions live together.
 *
 * @module apply/link-state
 */
import { lstatSync, statSync } from 'node:fs';

/**
 * Whether anything occupies a path, a broken symlink included.
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when `lstat` finds an entry there.
 */
export function pathExists(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the path is itself a symlink (never asked of its target).
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when the entry is a symlink.
 */
export function isSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether the path is a symlink pointing at something that is not there.
 *
 * A dead link is not content. Nothing can be read through it to decide who owns
 * it, and a write through it lands wherever the link says rather than at the
 * path DorkOS was asked to write — so every caller removes the link first.
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when the entry is a symlink whose target does not resolve.
 */
export function isDanglingSymlink(absPath: string): boolean {
  if (!isSymlink(absPath)) return false;
  try {
    statSync(absPath); // follows the link
    return false;
  } catch {
    return true;
  }
}
