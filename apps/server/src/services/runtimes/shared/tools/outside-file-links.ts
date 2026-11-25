/**
 * Where a search that follows links reaches (DOR-5240): `grep -R`, `rg -L`, `find -L` and
 * `fd --follow` go through a link to a folder elsewhere, so a link to the temp folder inside a
 * project makes a search of the project a search of the temp folder.
 *
 * One command line shares one walk: each folder is listed once, whatever root or spelling reaches
 * it, and once the line has read {@link MAX_ENTRIES} entries or listed {@link MAX_FOLDERS} folders
 * the search counts as reaching outside files.
 *
 * @module services/runtimes/shared/tools/outside-file-links
 */
import { opendirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** The most entries one command line's walks read. */
export const MAX_ENTRIES = 5_000;
/** The most folders one command line's walks list. */
export const MAX_FOLDERS = 500;

/** One command line's walk: what it has spent, and every folder it has listed. */
export interface LinkWalk {
  /** Entries read so far. */
  entries: number;
  /** Folders listed so far. */
  folders: number;
  /** Each folder listed, by where it resolves. A search stops at its first answer, so all led nowhere. */
  readonly walked: Set<string>;
}

/**
 * A fresh walk for one command line.
 *
 * @returns An empty walk.
 */
export function newLinkWalk(): LinkWalk {
  return { entries: 0, folders: 0, walked: new Set() };
}

/**
 * Whether any link below `root` leads to a place `reaches` says holds outside files, or above one.
 * A folder a link leads to is walked too, once per command line.
 *
 * @param root - The search's root, absolute.
 * @param reaches - Whether a search rooted at a resolved, absolute path reaches outside files.
 * @param walk - The command line's walk, shared by all its roots.
 */
export function linksReach(
  root: string,
  reaches: (absolute: string) => boolean,
  walk: LinkWalk = newLinkWalk()
): boolean {
  let start: string;
  try {
    start = realpathSync.native(root);
  } catch {
    return false;
  }
  const pending = [start];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    if (walk.walked.has(folder)) continue;
    walk.walked.add(folder);
    walk.folders += 1;
    if (walk.folders > MAX_FOLDERS) return true;
    let listing;
    try {
      listing = opendirSync(folder);
    } catch {
      continue;
    }
    try {
      for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
        walk.entries += 1;
        if (walk.entries > MAX_ENTRIES) return true;
        const at = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          pending.push(at);
          continue;
        }
        if (!entry.isSymbolicLink()) continue;
        let target: string;
        try {
          target = realpathSync.native(at);
        } catch {
          continue;
        }
        if (reaches(target)) return true;
        try {
          if (statSync(target).isDirectory()) pending.push(target);
        } catch {
          // Gone between the two reads: nothing to walk.
        }
      }
    } finally {
      listing.closeSync();
    }
  }
  return false;
}
