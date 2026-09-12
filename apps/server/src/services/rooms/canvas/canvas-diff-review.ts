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
 * - **Membership gates it**, like every other room read, and the route adds the
 *   archived refusal on the write.
 *
 * @module server/services/rooms/canvas/canvas-diff-review
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { RoomCanvasDiffReview, RoomCanvasDiffWriteResult } from '@dorkos/shared/room-files';
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
  const { file, sourcePath } = resolveReviewFile(deps, roomId, documentId);
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
  const { file } = resolveReviewFile(deps, roomId, documentId);
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
 * @returns The file and the repo-relative path it came from.
 * @throws {RoomError} `CANVAS_DOCUMENT_NOT_FOUND` for a document that is gone,
 *   `NOT_A_PROJECT_ROOM` for a room with no files, and
 *   `CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM` for a document that is not a
 *   worktree diff.
 */
function resolveReviewFile(
  deps: CanvasDiffReviewDeps,
  roomId: string,
  documentId: string
): { file: string; sourcePath: string } {
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
  // **Confined to a directory DorkOS made.** The row's value is a stored
  // string, so it is treated as an input rather than as truth: anything that is
  // not one of THIS room's working copies is refused, which also rules out the
  // room's own checkout (that one is read through the room's files route, which
  // has its own rules).
  if (tree === null || !isWithin(tree, worktrees)) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }
  // The path is the row's too, and it is joined rather than taken: a document
  // whose stored path escaped its own tree would be a traversal, so the result
  // is checked against the tree it was joined onto.
  const file = path.resolve(tree, document.sourcePath);
  if (!isWithin(file, tree)) {
    throw new RoomError('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM', NOT_THIS_ROOM_S_TREE);
  }
  return { file, sourcePath: document.sourcePath };
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

/**
 * Whether one absolute path sits inside another.
 *
 * Its own helper rather than a `startsWith`, which reads `/a/bc` as inside
 * `/a/b`.
 *
 * @param candidate - The path being placed.
 * @param root - The directory it must be under.
 * @returns Whether it is.
 */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
