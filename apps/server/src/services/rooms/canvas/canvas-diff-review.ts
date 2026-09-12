/**
 * Reading and writing the file behind a room's worktree diff (spec
 * `canvas-agent-seat` §8).
 *
 * **Why this is a room route and not the ordinary file API.** A member's
 * working copy of a room's files lives under the DorkOS data directory, and the
 * raw file surfaces are confined to the operator's configured project boundary
 * on purpose — `lib/boundary.ts` says so in as many words, and `{dorkHome}` is
 * deliberately NOT widened for reads, writes, terminal, git, diff or uploads,
 * because a sibling of it holds the encrypted credential store. So a client
 * asking `GET /api/files/content` for a room worktree is refused, correctly,
 * and the review surface would show "this file's changes couldn't be loaded"
 * on an install whose boundary is a project directory. Measured in the browser
 * before this module existed.
 *
 * What replaces it is narrower than the file API in every direction, and that
 * is the point:
 *
 * - **The caller never names a directory.** It names a room and a DOCUMENT, and
 *   the tree comes off that row's stored `resolvedCwd` — the same directory the
 *   boundary check ran against when the agent opened it.
 * - **That directory is confined to somewhere DorkOS made**, under this room's
 *   own `worktrees/`. A row holding anything else is refused rather than read.
 * - **The path comes off the row too**, from the `diff` content the document
 *   carries, so there is no path parameter to traverse with.
 * - **Every containment check runs on REALPATHS**, through `lib/boundary.ts`'s
 *   own resolution rather than a second one. A lexical `path.relative` is not
 *   containment: a symlink planted inside a working copy pointed at a file
 *   outside it, and both the read and the write followed it — measured before
 *   this used {@link resolveCanonicalPath}. The half a re-implementation always
 *   drops is the symlink half.
 * - **People only, and the route enforces it.** This is a write into somebody
 *   ELSE's working copy, so it is the person's to make: an agent is refused
 *   `PEOPLE_ONLY` exactly as it is on `PUT /:id/files/content` and
 *   `POST /:id/canvas/viewing`.
 *
 * @module server/services/rooms/canvas/canvas-diff-review
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { RoomCanvasDiffReview, RoomCanvasDiffWriteResult } from '@dorkos/shared/room-files';
import { isContained, resolveCanonicalPath } from '../../../lib/boundary.js';
import { sha256 } from '../../../lib/file-route-guards.js';
import { RoomError } from '../room-errors.js';

/** What the review reads and writes through, so a test can stand in for it. */
export interface CanvasDiffReviewDeps {
  /** One document on a room's canvas, as the table holds it. */
  document(roomId: string, documentId: string): { contentType: string; sourcePath: string } | null;
  /** The directory that document's path was resolved against, or `null`. */
  resolvedTree(roomId: string, documentId: string): string | null;
  /** Where this room keeps its members' working copies, or `null` for no repo. */
  worktreesPath(roomId: string): string | null;
  /** The room's own `main` copy of one file, or `null` when `main` has none. */
  mainCopy(roomId: string, sourcePath: string): Promise<string | null>;
}

/** What a caller is told when the document is not one that can be reviewed. */
const NOT_A_REVIEW =
  'That document is not a review of somebody’s working copy, so there is nothing to compare.';

/** What a caller is told when the row points somewhere this room does not own. */
const NOT_THIS_ROOM_S_TREE =
  'That document was opened somewhere this room does not keep working copies, so it cannot be reviewed here.';

/**
 * Read one worktree diff: the room's own copy of the file, and the member's.
 *
 * `base` is the empty string for a file the branch ADDS, which is the ordinary
 * case for new work and is not an error — the honest comparison is "nothing,
 * then this".
 *
 * @param deps - The seams this reads through.
 * @param roomId - The room whose `main` is the comparison.
 * @param documentId - The `diff` document on its canvas.
 * @returns Both copies, and the fingerprint a later write is conditional on.
 * @throws {RoomError} When the document is not a reviewable worktree diff.
 */
export async function readCanvasDiffReview(
  deps: CanvasDiffReviewDeps,
  roomId: string,
  documentId: string
): Promise<RoomCanvasDiffReview> {
  const { file, sourcePath } = await resolveReviewFile(deps, roomId, documentId);
  const [current, base] = await Promise.all([
    readTextOrThrow(file),
    deps.mainCopy(roomId, sourcePath),
  ]);
  return { path: sourcePath, base: base ?? '', current, currentHash: sha256(current) };
}

/**
 * Write a reviewed file back into the member's working copy, conditional on the
 * hash the diff was computed against.
 *
 * **A conflict is control flow, not a failure.** A file that moved underneath
 * the diff comes back as one, carrying what it holds now, so the reviewer
 * recomputes instead of clobbering an agent that carried on working.
 *
 * @param deps - The seams this writes through.
 * @param roomId - The room.
 * @param documentId - The `diff` document on its canvas.
 * @param input.content - The whole file, as the review leaves it.
 * @param input.expectedHash - The hash the diff was computed against.
 * @returns The new hash, or the conflict.
 * @throws {RoomError} When the document is not a reviewable worktree diff.
 */
export async function writeCanvasDiffReview(
  deps: CanvasDiffReviewDeps,
  roomId: string,
  documentId: string,
  input: { content: string; expectedHash: string }
): Promise<RoomCanvasDiffWriteResult> {
  const { file } = await resolveReviewFile(deps, roomId, documentId);
  const current = await readTextOrThrow(file);
  const currentHash = sha256(current);
  if (currentHash !== input.expectedHash) {
    return { ok: false, conflict: { currentHash, currentContent: current } };
  }
  await fs.writeFile(file, input.content, 'utf-8');
  return { ok: true, hash: sha256(input.content) };
}

/**
 * The absolute file one review is about, refusing every document that is not
 * one.
 *
 * @param deps - The seams.
 * @param roomId - The room.
 * @param documentId - The document.
 * @returns The canonical file and the repo-relative path it came from.
 * @throws {RoomError} `CANVAS_DOCUMENT_NOT_FOUND` for a document that is gone,
 *   `NOT_A_PROJECT_ROOM` for a room with no files, and
 *   `CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM` for a document that is not a
 *   worktree diff, whose tree is not one this room keeps, or whose path leaves
 *   that tree — through a symlink included.
 */
async function resolveReviewFile(
  deps: CanvasDiffReviewDeps,
  roomId: string,
  documentId: string
): Promise<{ file: string; sourcePath: string }> {
  const document = deps.document(roomId, documentId);
  if (!document) {
    throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this room’s canvas');
  }
  if (document.contentType !== 'diff') {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_A_REVIEW);
  }
  const worktrees = deps.worktreesPath(roomId);
  if (worktrees === null) {
    throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
  }
  const tree = deps.resolvedTree(roomId, documentId);
  if (tree === null) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }

  // **Confined to a directory DorkOS made, on REALPATHS.** The row's value is a
  // stored string, so it is treated as an input rather than as truth: anything
  // that is not one of THIS room's working copies is refused, which also rules
  // out the room's own checkout (that one is read through the room's files
  // route, which has its own rules). Both sides are canonicalized first,
  // because a lexical comparison judges a path by its spelling and a symlink is
  // exactly the case where the spelling lies.
  const worktreesReal = await resolveCanonicalPath(worktrees);
  const treeReal = await resolveCanonicalPath(tree);
  // **`isContained` counts a path equal to the root as contained**, which the
  // lexical helper it replaced did not — so the ROOT is refused here by name.
  // A row storing `<roomHome>/worktrees` itself is not reachable today (the
  // server only ever writes one specific copy), and the file check below would
  // still confine the target; refusing it explicitly keeps "one of THIS room's
  // working copies" the literal rule rather than one that happens to hold.
  if (treeReal === worktreesReal || !isContained(treeReal, worktreesReal)) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }

  // **A stored path that is absolute, or that climbs, is refused before it is
  // joined** — never normalized into something that looks fine. Collapsing `..`
  // as text is only correct on a path with no symlinks left in it, and the
  // components of `sourcePath` are exactly where one would be planted. A
  // document's `sourcePath` is repo-relative by construction, so neither shape
  // is a case to support.
  if (path.isAbsolute(document.sourcePath) || climbs(document.sourcePath)) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }

  // Resolved through every link on the way, and then checked — so a link INSIDE
  // the working copy pointing anywhere else is refused rather than followed.
  const file = await resolveCanonicalPath(path.join(treeReal, document.sourcePath));
  if (!isContained(file, treeReal)) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }
  return { file, sourcePath: document.sourcePath };
}

/**
 * Whether a repo-relative path has a `..` component in it.
 *
 * Its own predicate rather than a `includes('..')`, which reads a file honestly
 * called `..config` as a climb.
 *
 * @param relative - The stored path.
 * @returns Whether any segment is exactly `..`.
 */
function climbs(relative: string): boolean {
  return relative.split(/[\\/]/).includes('..');
}

/**
 * Read a file as text, answering a missing or unreadable one as a refusal the
 * screen can show rather than a stack trace.
 *
 * @param file - The absolute path.
 * @returns Its contents.
 * @throws {RoomError} `ROOM_FILE_NOT_FOUND` when it cannot be read as text.
 */
async function readTextOrThrow(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    throw new RoomError(
      'ROOM_FILE_NOT_FOUND',
      'That file is not in the working copy any more, so there is nothing to review.'
    );
  }
}
