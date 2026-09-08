/**
 * What is at a path — asked once, answered in the terms the apply stage needs,
 * and never by throwing.
 *
 * These are separated from `apply.ts` because a *dead symlink* is the shape that
 * answers differently to every question worth asking: it EXISTS (`lstat` sees
 * it), it is a SYMLINK, and it resolves to NOTHING. Reading it throws, following
 * it writes somewhere else, and treating it as an occupant protects a file that
 * is not there. A LIVE symlink is the mirror trap: reading and writing both
 * succeed, at a path that is not the one DorkOS was asked to write.
 *
 * {@link occupantKind} is the single probe; the three predicates below are
 * spellings of it, so no caller can classify a path one way here and another way
 * two lines later.
 *
 * @module apply/link-state
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';

/**
 * What occupies a path.
 *
 * `file` means anything real that is not a directory — a regular file, and also
 * the rare socket or FIFO. **A caller that goes on to READ the path must ask
 * `statSync().isFile()` first**: `readFileSync` on a FIFO with no writer blocks
 * in `open(2)` and nothing in the process can interrupt a synchronous block, so
 * "the read that follows will answer for it" is true of a socket and false of a
 * FIFO. `symlink-occupants.ts` carries that guard and says why.
 */
export type OccupantKind = 'absent' | 'dead-link' | 'live-link' | 'directory' | 'file';

/**
 * Classify what is at a path, following the link exactly once to tell a live
 * link from a dead one, and never throwing.
 *
 * @param absPath - the absolute path to probe.
 * @returns which of the five shapes occupies it.
 */
export function occupantKind(absPath: string): OccupantKind {
  let entry;
  try {
    entry = lstatSync(absPath);
  } catch {
    return 'absent';
  }
  if (entry.isSymbolicLink()) {
    try {
      statSync(absPath); // follows the link
      return 'live-link';
    } catch {
      return 'dead-link';
    }
  }
  return entry.isDirectory() ? 'directory' : 'file';
}

/**
 * Whether anything occupies a path, a broken symlink included.
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when `lstat` finds an entry there.
 */
export function pathExists(absPath: string): boolean {
  return occupantKind(absPath) !== 'absent';
}

/**
 * Whether the path is itself a symlink (never asked of its target).
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when the entry is a symlink, live or dead.
 */
export function isSymlink(absPath: string): boolean {
  const kind = occupantKind(absPath);
  return kind === 'live-link' || kind === 'dead-link';
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
  return occupantKind(absPath) === 'dead-link';
}

/**
 * The entry names in a directory, or `undefined` when it could not be listed at
 * all — the one primitive here that keeps "nothing is in it" apart from "nobody
 * could look".
 *
 * Most callers do not need the difference: a path that cannot be listed has
 * nothing to scan, which is what {@link listDir} answers. The difference matters
 * to anything that DELETES on an empty listing, because an empty array from a
 * failed read is a directory somebody's content may still be in — so that one
 * caller asks this instead (`apply.ts`'s wrapper-dir tidy-up).
 *
 * @param absDir - the absolute directory to list.
 * @returns the entry names, or `undefined` when the listing failed.
 */
export function tryListDir(absDir: string): string[] | undefined {
  try {
    return readdirSync(absDir);
  } catch {
    return undefined;
  }
}

/**
 * The entry names in a directory, or none when there is no directory to read.
 *
 * The skill projection dirs are scanned by both `--check` and `--fix`, and
 * "absent" is only the commonest way there is nothing to scan: the path may be a
 * FILE (ENOTDIR) or unreadable (EACCES). An `existsSync` guard answers the first
 * and throws on the other two, out of the middle of a report whose whole job is
 * to tell somebody what is wrong with their tree.
 *
 * Every failure collapses to "nothing to list", which is the safe answer for a
 * SCAN and the wrong one for a deletion — see {@link tryListDir}.
 *
 * @param absDir - the absolute directory to list.
 * @returns the entry names, or an empty array when it cannot be listed.
 */
export function listDir(absDir: string): string[] {
  return tryListDir(absDir) ?? [];
}

/**
 * The same listing as {@link listDir}, with each entry's kind attached — for the
 * scans that have to tell a directory from a file without a second `stat` per
 * entry.
 *
 * The command directories need this one. They are scanned by `--check` as well
 * as `--fix` now that every sweep has a `find*` half (DOR-1889), and a person
 * with a stray FILE at `.opencode/commands`, or a `.claude/commands` they cannot
 * read, was getting `ENOTDIR`/`EACCES` thrown out of the report instead of being
 * told what is wrong with their tree.
 *
 * @param absDir - the absolute directory to list.
 * @returns the entries, or an empty array when it cannot be listed.
 */
export function listDirEntries(absDir: string): Dirent[] {
  try {
    return readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
}
