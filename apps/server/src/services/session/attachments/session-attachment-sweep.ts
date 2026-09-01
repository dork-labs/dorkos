/**
 * Who owns the disk that session images sit on.
 *
 * A directory that only ever grows, with nobody responsible for it, is how an
 * install quietly fills a laptop. So this is the owner: a sweep that drops
 * image files nobody has touched in {@link SESSION_ATTACHMENT_RETENTION_MS},
 * and removes the directories left empty behind them.
 *
 * **What survives a sweep, and what does not.** Some images here are a CACHE of
 * something a runtime still holds: an OpenCode tool attachment recorded as a
 * `data:` URI is re-derived under the same attachment id on the next history
 * read and written again, so sweeping it costs one decode. Others are the ONLY
 * copy and cannot come back:
 *   - an image that arrived as a live `file://` source, because the history
 *     path may not read the disk (ADR-0308) and so rebuilds only from `data:`;
 *   - a generated image under OpenCode, which upstream discards before storing
 *     (anomalyco/opencode#12859), so DorkOS's copy is the only one there ever was.
 *
 * A swept image in that second class is gone for good. It does NOT take its
 * turn with it — `historyMediaResolver` projects a part pointing at where the
 * bytes would be, so the reader gets the honest "not available" row rather than
 * a message that vanished — but the picture itself is not recoverable. Ninety
 * days is chosen against exactly that: long enough that a swept image is one
 * nobody has opened in a quarter.
 *
 * **Modification time is the signal, and the read paths keep it honest.** Not
 * access time: `relatime`/`noatime` make atime unreliable across the
 * filesystems this runs on. It would be wrong to assume re-materialization
 * refreshes mtime on its own — every path that meets an existing image `peek`s
 * it, and `peek` is a `stat` that deliberately skips the write, so without help
 * an mtime would never move again after the first write and a transcript
 * reopened daily for ninety days would still lose its picture on day ninety.
 * So the read paths call `SessionAttachmentStore.touch` explicitly: the serving
 * route on every fetch (somebody is looking at it) and the history resolver on
 * every reference (a transcript still points at it).
 *
 * @module server/services/session/attachments/session-attachment-sweep
 */
import { readdir, rm, rmdir, stat } from 'fs/promises';
import path from 'path';
import { logger } from '../../../lib/logger.js';

/**
 * How long a session image survives without being touched. Ninety days — see
 * the module doc for why it is generous rather than tight.
 */
export const SESSION_ATTACHMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** How often the sweep runs once the server is up. */
export const SESSION_ATTACHMENT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What one sweep did, for the log and for tests. */
export interface SessionAttachmentSweepResult {
  /** Image files removed. */
  removed: number;
  /** Image files inspected and kept. */
  kept: number;
}

/**
 * Drop session images older than the retention window.
 *
 * Never throws: a sweep that cannot read a directory has nothing useful to say
 * to the request that is happening at the same time, so it logs and moves on.
 * Missing directories are the ordinary case on a fresh install, not an error.
 *
 * @param input.dorkHome - The resolved DorkOS data directory.
 * @param input.now - Epoch ms to measure age against. Injected for tests.
 * @param input.retentionMs - Override the retention window. Tests only.
 */
export async function sweepSessionAttachments(input: {
  dorkHome: string;
  now?: number;
  retentionMs?: number;
}): Promise<SessionAttachmentSweepResult> {
  const now = input.now ?? Date.now();
  const retentionMs = input.retentionMs ?? SESSION_ATTACHMENT_RETENTION_MS;
  const sessionsRoot = path.join(input.dorkHome, 'sessions');
  const result: SessionAttachmentSweepResult = { removed: 0, kept: 0 };

  for (const sessionId of await listDirectories(sessionsRoot)) {
    const dir = path.join(sessionsRoot, sessionId, 'attachments');
    const files = await listEntries(dir);
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        if (now - info.mtimeMs <= retentionMs) {
          result.kept += 1;
          continue;
        }
        await rm(file, { force: true });
        result.removed += 1;
      } catch (err) {
        logger.debug('[session-attachments] sweep skipped a file', { err, file });
      }
    }
    // An emptied directory is the other half of the job — leaving one per
    // session forever is a smaller leak than the bytes, but it is still a leak.
    await removeIfEmpty(dir);
  }

  if (result.removed > 0) {
    logger.info('[session-attachments] swept old images', result);
  }
  return result;
}

/** Directory names directly under `dir`, or none when it does not exist. */
async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Entry names directly under `dir`, or none when it does not exist. */
async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Remove a directory if nothing is left in it. Silent when it is not empty. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    // ENOTEMPTY (still has images) and ENOENT (never existed) are both fine.
  }
}
