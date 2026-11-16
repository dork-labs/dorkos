/**
 * A one-time, idempotent fix for `ROOM.md` files seeded before DOR-4453 (Security on #3832).
 *
 * A room's files start with `# <title>` (`room-md.ts`), and a bridged group is titled by its
 * far-end chat's name, which anyone in that chat can set. Since #3832 a new bridged room is seeded
 * under "Bridged channel" instead, but a file seeded earlier still carries the chat's name, and
 * the file rides every member agent's turns. So at boot, for every bridged room, a heading that is
 * still exactly the one DorkOS seeded from the chat's name is rewritten and committed on `main`:
 * to `# Bridged channel` while the room keeps that name, or to the room's own name once the owner
 * has renamed it (renaming the room never touched the file).
 *
 * It touches only what DorkOS wrote: the first line must still be exactly the seeded heading, so a
 * heading a person edited is left alone. It skips a room whose files have anything uncommitted
 * (somebody is mid-edit, and a commit would sweep their work in) or are off `main`, and tries
 * again at the next boot. A failed commit puts the file back the way `HEAD` has it, so the fix can
 * never be what leaves a room's files dirty. Once rewritten, the heading no longer matches, so
 * every later boot is a no-op.
 *
 * @module server/services/rooms/repo/bridged-room-md-heading
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../lib/logger.js';
import { PLATFORM_NAMED_ROOM } from '../agent-facing-room-name.js';
import type { Bridge } from '../../relay/chat-bridge/bridge-store.js';
import {
  commitStaged,
  GitUnavailableError,
  hasStagedChanges,
  restoreFromHead,
  stagePaths,
  type GitIdentity,
} from './room-repo-git.js';
import { readMainCheckoutState } from './room-main-checkout.js';
import { ROOM_MD_FILENAME } from './room-md.js';

/** The subject of the commit that renames the heading. */
export const BRIDGED_HEADING_COMMIT_MESSAGE = 'Take the chat’s own name out of this room’s notes';

/**
 * The file with its seeded heading replaced, or `null` when the first line is not exactly the
 * heading DorkOS seeded for `staleTitle` (a person edited it, or it was already replaced). A
 * trailing `\r` on that line is kept, so a file saved with Windows line endings still matches.
 *
 * @param body - The `ROOM.md` contents.
 * @param staleTitle - The far-end chat's title the file was seeded under.
 * @param replacement - The title the heading should carry instead.
 */
export function fencedRoomMdHeading(
  body: string,
  staleTitle: string,
  replacement: string
): string | null {
  const end = body.indexOf('\n');
  const line = end === -1 ? body : body.slice(0, end);
  const cr = line.endsWith('\r') ? '\r' : '';
  if (line.slice(0, line.length - cr.length) !== `# ${staleTitle}`) return null;
  const fenced = `# ${replacement}${cr}${end === -1 ? '' : body.slice(end)}`;
  return fenced === body ? null : fenced;
}

/** Where one room's files live, and who the rename commit is attributed to. */
export interface RoomMdHeadingTarget {
  /** The room's main checkout. */
  repoDir: string;
  /** The room home directory git's search may not climb past. */
  ceiling: string;
  /** The commit's author: the operator, as every commit DorkOS makes on their behalf. */
  identity: GitIdentity;
}

/**
 * Replace one room's seeded heading and commit it. Run while holding the room's repo queue.
 *
 * @param target - The room's checkout and the commit identity.
 * @param staleTitle - The far-end chat's title the file was seeded under.
 * @param replacement - The title the heading should carry instead.
 * @returns Whether a commit was made.
 */
export async function fenceRoomMdHeadingAt(
  target: RoomMdHeadingTarget,
  staleTitle: string,
  replacement: string
): Promise<boolean> {
  const state = await readMainCheckoutState(target.repoDir, target.ceiling);
  // Anything uncommitted means somebody is working, and the commit below takes the whole index.
  if (state.branch !== 'main' || state.strays.length > 0) return false;
  const file = path.join(target.repoDir, ROOM_MD_FILENAME);
  let body: string;
  try {
    body = await fs.readFile(file, 'utf-8');
  } catch {
    return false;
  }
  const fenced = fencedRoomMdHeading(body, staleTitle, replacement);
  if (fenced === null) return false;
  try {
    await fs.writeFile(file, fenced, 'utf-8');
    await stagePaths(target.repoDir, [ROOM_MD_FILENAME], target.ceiling);
    if (!(await hasStagedChanges(target.repoDir, target.ceiling))) return false;
    await commitStaged(
      target.repoDir,
      BRIDGED_HEADING_COMMIT_MESSAGE,
      target.identity,
      target.ceiling
    );
    return true;
  } catch (err) {
    // The tree was clean before the write, so `HEAD` holds exactly what was there.
    await restoreFromHead(target.repoDir, [ROOM_MD_FILENAME], target.ceiling).catch(() => {});
    throw err;
  }
}

/** What {@link fenceStaleBridgedRoomMdHeadings} reads. */
export interface StaleHeadingSweepDeps {
  /** Every live bridge, with the chat title it recorded. */
  bridges: { listLiveBridges(): Bridge[] };
  /** A room's current title, or `null` when it is gone. */
  titleOf(roomId: string): string | null;
  /** Replace one room's heading under its queue; `false` when it has no files or nothing to do. */
  fence(roomId: string, staleTitle: string, replacement: string): Promise<boolean>;
}

/**
 * Replace the seeded chat-name heading in every bridged group's notes. Never throws: a room that
 * fails is logged and skipped, so one stuck repo never stops the rest, and a failure to read the
 * bridges at all is logged too, so this can run unawaited at boot.
 *
 * @param deps - See {@link StaleHeadingSweepDeps}.
 * @returns How many rooms were changed.
 */
export async function fenceStaleBridgedRoomMdHeadings(
  deps: StaleHeadingSweepDeps
): Promise<number> {
  let changed = 0;
  try {
    for (const bridge of deps.bridges.listLiveBridges()) {
      if (bridge.platformTitle === null) continue;
      const title = deps.titleOf(bridge.roomId);
      if (title === null) continue;
      const replacement = title === bridge.platformTitle ? PLATFORM_NAMED_ROOM : title;
      try {
        if (await deps.fence(bridge.roomId, bridge.platformTitle, replacement)) changed += 1;
      } catch (err) {
        logger.warn('[rooms] could not take the chat’s name out of a room’s notes', {
          roomId: bridge.roomId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Without git no room can be fixed; one line says so, not one per room.
        if (err instanceof GitUnavailableError) break;
      }
    }
  } catch (err) {
    logger.warn('[rooms] could not check bridged rooms’ notes headings', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (changed > 0) logger.info('[rooms] took chat names out of rooms’ notes', { changed });
  return changed;
}
