/**
 * Files an agent hands a room, by path (spec `canvas-agent-seat` §4).
 *
 * ## It opens no new door
 *
 * `POST /api/rooms/:id/attachments` stays `PEOPLE_ONLY`, and this is not a
 * second copy of it. An agent gets a field on the verb it already has, and what
 * that field may name is settled against the agent's OWN folders — not
 * `validateBoundary` alone, which confines to the GLOBAL boundary and in a
 * project room contains every other member's working copy:
 *
 * - its working directory (a room turn's is the agent's home, spec
 *   `agent-home-desk`), by {@link resolveWithinCwd};
 * - its own copies of rooms' files — the folders a room turn is granted to
 *   write (`<rooms>/<room>/worktrees/<name>-<digest of its home>`), found from
 *   its verified identity, never from the path it named.
 *
 * Every check is on real paths, so a symlink cannot carry a name out of the
 * folder it appears in. Nothing inside the rooms directory is attachable except
 * through the agent's own copy: never a room's shared `repo/`, never another
 * member's copy, even when the working directory happens to contain the rooms
 * directory (a DorkOS dev checkout keeps its data under the repo).
 *
 * ## It writes bytes before the entry, and gives them back if the entry fails
 *
 * Rows are inserted UNBOUND here and bound inside the entry's own transaction
 * by the caller, so the message and its files land together or neither does. A
 * failure part-way through this function undoes whatever it already committed;
 * a failure at the bind leaves unbound rows the existing 24-hour sweep reclaims.
 *
 * @module server/services/rooms/attachments/agent-attachments
 */
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulidx';
import { BoundaryError, validateBoundary } from '../../../lib/boundary.js';
import { resolveWithinCwd } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import { sniffImageContentType } from '../../identity/image-sniff.js';
import { RoomError } from '../room-errors.js';
import { RoomWorktreeManager } from '../repo/room-worktree-manager.js';
import { SAFE_ROOM_ID } from '../repo/room-repo-store.js';
import { sanitizeAttachmentName, storedExtension } from './attachment-paths.js';
import type { AttachmentRowStore } from './attachment-row-store.js';
import type { RoomAttachmentStore } from './room-attachment-store.js';

/** The upload bounds an agent's attachment answers to — the person's, exactly. */
export interface AgentAttachmentLimits {
  /** Most files one message may carry. */
  maxFiles: number;
  /** Biggest single file, in bytes. */
  maxFileSize: number;
  /** Media types this install accepts. The wildcard entry means all of them. */
  allowedTypes: string[];
}

/** Everything staging one post's files needs. */
export interface AgentAttachmentRequest {
  /** The room the files are going into. */
  roomId: string;
  /** The agent posting, resolved from its identity — never from the arguments. */
  authorId: string;
  /** The agent's own working directory. Relative paths resolve against it. */
  cwd: string;
  /**
   * The agent's own copy of the destination room's files, from {@link ownRoomCopy}.
   * Absolute paths really inside one of them are attachable too.
   */
  ownCopies?: readonly string[];
  /** The rooms directory, real or not; nothing under it is attachable but `ownCopies`. */
  roomsDir?: string;
  /** What the agent named, in the order it should render. */
  paths: readonly string[];
  /** Where the bytes go. */
  store: RoomAttachmentStore;
  /** Where the rows go. */
  rows: AttachmentRowStore;
  /** The person's own upload bounds. */
  limits: AgentAttachmentLimits;
  /** Cap on a stored filename, so one long path cannot fill a column. */
  nameMax: number;
}

/** How big a file is, said the way a person says it. */
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

/** Whether `target` is `root` or inside it; both are real paths. */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The agent's own copy of ONE room's files — the folder a turn in that room is
 * granted to write — by the exact name the worktree manager gives it
 * (`RoomWorktreeManager.slugFor`, from the same author label a room turn is
 * placed with), spelled under the rooms directory's real path. `null` when it
 * does not exist.
 *
 * Exact, never a suffix match: a copy in another room (one the agent has left,
 * say) or a folder someone named with the agent's digest is not this one. A
 * named file must REALLY be inside the spelling returned, so a copy folder
 * swapped for a symlink to someone else's contains nothing.
 *
 * @param roomsDir - The rooms directory.
 * @param roomId - The room being posted to.
 * @param agent - The posting agent's home and label, from its verified identity.
 */
export async function ownRoomCopy(
  roomsDir: string,
  roomId: string,
  agent: { agentPath: string; agentName: string }
): Promise<string | null> {
  if (!SAFE_ROOM_ID.test(roomId)) return null;
  const realRooms = await fs.realpath(roomsDir).catch(() => null);
  if (!realRooms) return null;
  const copy = path.join(
    realRooms,
    roomId,
    'worktrees',
    RoomWorktreeManager.slugFor(agent.agentName, agent.agentPath)
  );
  const stat = await fs.lstat(copy).catch(() => null);
  return stat?.isDirectory() ? copy : null;
}

/**
 * Where a named file really is, when it is somewhere the agent may attach
 * from: its working directory or one of its own copies, and — inside the
 * rooms directory — only its own copies.
 */
async function resolveOwnPath(
  cwd: string,
  ownCopies: readonly string[],
  roomsDir: string | undefined,
  named: string
): Promise<string> {
  let resolved: string | null = null;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, named));
  } catch (err) {
    if (!(err instanceof BoundaryError) || !path.isAbsolute(named)) throw err;
  }
  if (resolved === null) {
    for (const copy of ownCopies) {
      try {
        resolved = await validateBoundary(named, copy);
        break;
      } catch (err) {
        if (!(err instanceof BoundaryError)) throw err;
      }
    }
  }
  if (resolved === null) {
    throw new BoundaryError('Access denied: path outside your own folders', 'OUTSIDE_BOUNDARY');
  }
  const realRooms = roomsDir ? await fs.realpath(roomsDir).catch(() => null) : null;
  if (realRooms && isWithin(realRooms, resolved) && !ownCopies.some((c) => isWithin(c, resolved))) {
    throw new BoundaryError('Access denied: a room folder that is not yours', 'OUTSIDE_BOUNDARY');
  }
  return resolved;
}

/**
 * Read one named file, refusing anything outside the agent's own folders.
 *
 * @param roots - The agent's working directory, its own copies and the rooms directory.
 * @param named - The path the agent wrote, absolute or relative to the working directory.
 * @returns The bytes and the name to store them under.
 */
async function readOwnFile(
  roots: { cwd: string; ownCopies: readonly string[]; roomsDir?: string },
  named: string
): Promise<{ bytes: Buffer; name: string }> {
  const label = path.basename(named) || named;
  let resolved: string;
  try {
    resolved = await resolveOwnPath(roots.cwd, roots.ownCopies, roots.roomsDir, named);
  } catch (err) {
    if (err instanceof BoundaryError) {
      throw new RoomError(
        'ATTACHMENT_PATH_REFUSED',
        `${label} is not in your own folder or your own copy of a room's files, so you cannot ` +
          'attach it. Copy it into one of those first, then attach it from there.'
      );
    }
    throw new RoomError('ATTACHMENT_UNREADABLE', `${label} could not be opened.`);
  }

  // One open, never followed through a symlink, and every later question asked
  // of THAT descriptor: the path cannot be swapped between the check and the read.
  const handle = await fs
    .open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        throw new RoomError('ATTACHMENT_UNREADABLE', `There is no file at ${named}.`);
      }
      throw new RoomError('ATTACHMENT_UNREADABLE', `${label} is not a file you can attach.`);
    });
  let bytes: Buffer | null;
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw new RoomError('ATTACHMENT_UNREADABLE', `${label} is a folder, not a file.`);
    }
    if (!stat.isFile()) {
      throw new RoomError('ATTACHMENT_UNREADABLE', `${label} is not a file you can attach.`);
    }
    bytes = await handle.readFile().catch(() => null);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!bytes) throw new RoomError('ATTACHMENT_UNREADABLE', `${label} could not be read.`);
  return { bytes, name: label };
}

/**
 * Undo staging: take the bytes and the unbound rows back.
 *
 * **Exported because the caller needs it too.** Staging happens before the
 * entry is written, and the write can still refuse — a mistyped `roomId`, the
 * per-turn post ceiling, a stopped turn, an archived room. Without this the
 * files stay on disk with nothing referencing them, in a room where the only
 * sweep runs on the person's upload route, which an agent-only room never
 * reaches. So the caller runs the same cleanup this module runs on its own
 * failures, and there is one expression of it rather than two.
 *
 * Best-effort by necessity: a cleanup failure must not replace the refusal the
 * agent actually needs to read.
 *
 * @param request.roomId - The room the files were staged in.
 * @param request.ids - The attachment ids to take back.
 * @param request.store - Where the bytes went.
 * @param request.rows - Where the rows went.
 */
export async function discardStagedAttachments(request: {
  roomId: string;
  ids: readonly string[];
  store: RoomAttachmentStore;
  rows: AttachmentRowStore;
}): Promise<void> {
  const { roomId, ids, store, rows } = request;
  for (const id of ids) {
    try {
      // Read the extension back off the row before deleting it: the store needs
      // it to name the file, and the row is the only place it was written down.
      const extension = rows.get(roomId, id)?.extension ?? '';
      // **Claim the row first, and only touch the bytes if the claim won.** The
      // delete re-checks `entry_id IS NULL`, so a row that got bound in the
      // meantime keeps both halves and a message never loses the file it is
      // about. Same rule the 24-hour sweep follows, for the same reason.
      if (rows.deleteUnbound(roomId, [id]) !== 1) continue;
      await store.delete(roomId, id, extension);
    } catch (cleanupErr) {
      logger.warn('[rooms] could not clean up a half-finished agent attachment', {
        roomId,
        attachmentId: id,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
  }
}

/**
 * Store an agent's files and answer with the unbound attachment ids.
 *
 * Every refusal happens before the entry exists, so a post that cannot carry
 * its files is a post that never happened. On any failure the bytes and rows
 * this call already committed are removed.
 *
 * @param request - The room, the agent, its directory, the paths and the stores.
 * @returns The attachment ids, in the order the agent named them.
 */
export async function stageAgentAttachments(request: AgentAttachmentRequest): Promise<string[]> {
  const { roomId, authorId, cwd, paths, store, rows, limits, nameMax } = request;
  const roots = { cwd, ownCopies: request.ownCopies ?? [], roomsDir: request.roomsDir };
  if (paths.length === 0) return [];
  if (paths.length > limits.maxFiles) {
    throw new RoomError(
      'TOO_MANY_ATTACHMENTS',
      `A message can carry at most ${limits.maxFiles} ${limits.maxFiles === 1 ? 'file' : 'files'}.`
    );
  }

  const committed: Array<{ id: string; extension: string }> = [];
  try {
    const ids: string[] = [];
    for (const named of paths) {
      const { bytes, name: original } = await readOwnFile(roots, named);
      if (bytes.byteLength > limits.maxFileSize) {
        throw new RoomError(
          'ATTACHMENT_TOO_LARGE',
          `${original} is ${megabytes(bytes.byteLength)}, and the limit is ` +
            `${megabytes(limits.maxFileSize)}.`
        );
      }
      // THE safety line, the same one the person's route draws: `preview` comes
      // from the BYTES. A `.png` that is not one is an attachment, never an
      // inline image. Everything that is not a recognised image is stored as an
      // opaque stream, which is also what the serve route sends it back as.
      const sniffed = sniffImageContentType(bytes);
      const mimeType = sniffed ?? 'application/octet-stream';
      if (!limits.allowedTypes.includes('*/*') && !limits.allowedTypes.includes(mimeType)) {
        throw new RoomError(
          'ATTACHMENT_UNREADABLE',
          `${original} is not a kind of file this room accepts.`
        );
      }

      const name = sanitizeAttachmentName(original, nameMax);
      const extension = storedExtension(name);
      const id = ulid();
      const { url } = await store.put(roomId, id, extension, bytes);
      committed.push({ id, extension });
      rows.create(
        {
          roomId,
          id,
          authorId,
          name,
          extension,
          mimeType,
          size: bytes.byteLength,
          preview: sniffed ? ('image' as const) : null,
          url,
        },
        new Date().toISOString()
      );
      ids.push(id);
    }
    return ids;
  } catch (err) {
    // All-or-nothing: the caller gets no ids, so nothing here may survive to be
    // referenced later. The same cleanup the CALLER runs when the write refuses
    // after this returned — one expression, so the two cannot drift.
    await discardStagedAttachments({ roomId, ids: committed.map((file) => file.id), store, rows });
    throw err;
  }
}
