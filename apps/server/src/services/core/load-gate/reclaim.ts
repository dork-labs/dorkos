/**
 * How the load gate decides a record has gone quiet, and how it takes one away
 * without taking anyone else's (DOR-4209).
 *
 * ## Quiet is something this reader saw, not a timestamp it compared
 *
 * A record's file time is its owner's heartbeat, but wall clocks jump: a Mac
 * that slept for an hour wakes with every file an hour old. So a record is
 * quiet only when THIS reader has watched its file time stay exactly the same
 * for a full lease, timed on a monotonic clock that does not run while the
 * machine sleeps. A reader's first sight of a record never counts as quiet, and
 * any change to the file time starts the watch again.
 *
 * ## Taking a record away
 *
 * A slot's file name is reused, so a reader that decided slot 0 is stale must
 * not unlink a slot 0 another process linked a moment later. It renames the
 * file aside first, which no one else can then claim under that name, checks the
 * moved file is still exactly the record it judged (same id, same file time),
 * and links it back when it is not.
 *
 * @module services/core/load-gate/reclaim
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOMB_BYTES = 8;

/** Watches other processes' file times for a lease measured on a monotonic clock. */
export class LeaseWatch {
  private readonly seen = new Map<string, { mtimeMs: number; at: number }>();
  private readonly leaseMs: number;
  private readonly monoNow: () => number;

  /**
   * Start watching.
   *
   * @param leaseMs - How long a file time must stay unchanged before its record is quiet.
   * @param monoNow - A monotonic clock in milliseconds.
   */
  constructor(leaseMs: number, monoNow: () => number) {
    this.leaseMs = leaseMs;
    this.monoNow = monoNow;
  }

  /**
   * Whether the record in `name` has kept this file time for a full lease, as
   * this reader has watched it.
   *
   * @param name - The record's file name.
   * @param mtimeMs - Its file time now.
   */
  quiet(name: string, mtimeMs: number): boolean {
    const at = this.monoNow();
    const seen = this.seen.get(name);
    if (seen === undefined || seen.mtimeMs !== mtimeMs) {
      this.seen.set(name, { mtimeMs, at });
      return false;
    }
    return at - seen.at >= this.leaseMs;
  }

  /**
   * Stop watching every file not in `present`, so the map holds only what exists.
   *
   * @param present - The file names in the folder now.
   */
  retain(present: ReadonlySet<string>): void {
    for (const name of this.seen.keys()) if (!present.has(name)) this.seen.delete(name);
  }
}

/** A record as it was judged: its id (or `null` when unreadable) and its file time. */
export interface JudgedRecord {
  /** The id it held. */
  id: string | null;
  /** Its file time when judged. */
  mtimeMs: number;
}

/**
 * The file time of a file, or `null` when it is gone.
 *
 * @param file - The file's path.
 */
export function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove `name` from `dir` only if, once moved aside, `meant` says it is still
 * the record that was judged. Otherwise link it back. If the name was claimed
 * again in that same instant, the link-back fails and the moved record is lost:
 * its job runs on uncounted until it ends, which is rare and never holds a slot
 * forever.
 *
 * @param dir - The folder.
 * @param name - The file to take away.
 * @param meant - Given the moved file's path, whether it is the record judged stale.
 * @returns Whether the file was taken away.
 */
export function takeAway(
  dir: string,
  name: string,
  meant: (movedPath: string) => boolean
): boolean {
  const tomb = path.join(dir, `.tomb-${randomBytes(TOMB_BYTES).toString('hex')}`);
  try {
    fs.renameSync(path.join(dir, name), tomb);
  } catch {
    return false;
  }
  try {
    if (meant(tomb)) return true;
    fs.linkSync(tomb, path.join(dir, name));
    return false;
  } catch {
    // Claimed again meanwhile; see above.
    return false;
  } finally {
    fs.rmSync(tomb, { force: true });
  }
}
