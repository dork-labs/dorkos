/**
 * The fleet-wide roll call of claude-code sessions on disk (DOR-1436).
 *
 * Every OTHER read in this directory asks where one session is, or what one
 * project holds. This asks the opposite question — which ids exist ANYWHERE —
 * because its caller, the boot reconcile in
 * `services/session/reconcile-session-rows.ts`, deletes rows on the strength of
 * an id being ABSENT. A project-scoped listing cannot answer that: every session
 * belonging to another project is absent from it, which is the ordinary case
 * rather than evidence of anything.
 *
 * Names only — one `readdir` per project directory, no `stat` and no parse — so
 * an install with hundreds of projects pays one cheap directory read each, once,
 * at boot.
 *
 * @module services/runtimes/claude-code/sessions/session-inventory
 */
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../../lib/logger.js';

/** The suffix every SDK transcript file carries; stripping it leaves the id. */
const TRANSCRIPT_EXTENSION = '.jsonl';

/** A roll call, and whether it managed to read everything it needed to. */
export interface SessionInventory {
  /** Every session id found on disk. */
  ids: Set<string>;
  /**
   * `false` when anything could not be enumerated. A caller may only conclude
   * "this session is gone" from a COMPLETE inventory.
   */
  complete: boolean;
}

/**
 * Every session id with a transcript under these accounts, across every
 * project, plus whether the enumeration was complete.
 *
 * **`complete` is the whole safety contract.** ANY failure to enumerate — an
 * unreadable account, an unreadable project directory, or an empty root set (a
 * `$CLAUDE_CONFIG_DIR` that moved, a HOME that is not there yet) — answers
 * `false`, leaving whatever WAS read as no more than a partial view. An empty
 * root set is deliberately not read as "this machine has no sessions": from
 * here the two are indistinguishable, and only one of them is safe to act on.
 *
 * The one thing that is NOT a failure is an entry the filesystem identifies as
 * something other than a directory (`ENOTDIR`/`ENOENT` from the read below): a
 * socket, a FIFO, a dangling symlink. Those cannot be hiding a transcript, so
 * passing over them costs the inventory nothing. Everything ambiguous counts
 * against `complete`.
 *
 * @param projectsRoots - Each account's `projects` directory, from
 *   `TranscriptReader.getProjectsRootSet()`.
 */
export async function inventorySessionIds(projectsRoots: string[]): Promise<SessionInventory> {
  const ids = new Set<string>();
  if (projectsRoots.length === 0) {
    logger.debug('[session-inventory] no Claude projects root to enumerate');
    return { ids, complete: false };
  }
  let complete = true;
  for (const projectsRoot of projectsRoots) {
    let slugDirs;
    try {
      slugDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch (err) {
      complete = false;
      logger.warn('[session-inventory] could not enumerate a Claude account', {
        projectsRoot,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const entry of slugDirs) {
      // Deliberately NOT `entry.isDirectory()`. `readdir` does not follow
      // symlinks, so a project directory reached through one reports
      // `isDirectory() === false` — and skipping it here would drop every
      // session inside it from the inventory while `complete` stayed `true`,
      // which is the exact silent omission this module promises never to
      // produce. Every other reader DOES follow the link (`SessionRootIndex`
      // probes with `fs.access`, the listing reads through the path), so those
      // sessions are live, listable and resumable. Only a regular FILE is
      // definitely not a project directory; everything else is handed to
      // `readdir`, which classifies it authoritatively.
      if (entry.isFile()) continue;
      const transcriptsDir = path.join(projectsRoot, entry.name);
      try {
        for (const file of await fs.readdir(transcriptsDir)) {
          if (file.endsWith(TRANSCRIPT_EXTENSION)) {
            ids.add(file.slice(0, -TRANSCRIPT_EXTENSION.length));
          }
        }
      } catch (err) {
        // Two codes are the readdir SAYING "not a project directory", which is
        // an answer rather than a failure: ENOTDIR is a socket, a FIFO, or a
        // symlink to a file, and ENOENT is a dangling symlink or an entry
        // deleted between the two reads. Neither can be hiding a transcript, so
        // neither costs the inventory its completeness. Anything else is an
        // enumeration that FAILED — a directory that exists and would not be
        // read — and that is exactly what `complete: false` is for.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR' || code === 'ENOENT') {
          logger.debug('[session-inventory] skipping an entry that is not a project directory', {
            transcriptsDir,
            code,
          });
          continue;
        }
        complete = false;
        logger.warn('[session-inventory] could not enumerate a project directory', {
          transcriptsDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { ids, complete };
}
