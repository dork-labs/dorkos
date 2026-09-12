/**
 * What one document on a canvas looks like on the wire.
 *
 * **Its own module, and that placement is load-bearing.** A room's stream and a
 * session's stream both carry this shape (spec `canvas-agent-seat` §1.3), so
 * `session-stream.ts` needs it — and `room-schemas.ts` already imports
 * `session-stream.ts` for `SessionActivitySchema`. Declaring it there and
 * importing it here would close a module cycle, and a Zod schema read during one
 * evaluates to `undefined` rather than throwing: every parse would silently
 * fail. A leaf module both sides import has no cycle to close.
 *
 * `room-schemas.ts` re-exports it, so every existing importer is unchanged.
 *
 * @module shared/canvas-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { UiCanvasContentSchema } from './schemas.js';

extendZodWithOpenApiOnce();

/**
 * One document on a canvas — a room's shared table or a person's own session
 * canvas — as every reader is handed it.
 *
 * **Content travels with it**, because a viewer that has the row has to be able
 * to draw the document, and the ceiling on how many rows a room holds is what
 * keeps that affordable. The one thing that does NOT travel is a file's
 * contents: a file-backed document carries the path it resolved to and nothing
 * more, and each viewer reads the bytes through the route it already uses.
 *
 * **`rev` orders two frames racing for one document** — a lower `rev` never
 * overwrites a higher one — and is deliberately not a stream cursor. The room
 * stream has exactly one cursor and it is the highest durable entry a reader
 * holds (see `RoomCanvasEventSchema`).
 */
export const CanvasDocumentSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Who owns this document: `room:<roomId>` or `session:<sessionId>`.
     *
     * Carried so a client holding both can tell one table from another, and so a
     * frame that arrived on the wrong stream is recognisable rather than merged.
     */
    scope: z.string().min(1),
    /**
     * The room this document is on, or `null` when it is on a session's own
     * canvas (spec `canvas-agent-seat` §1.1).
     *
     * Nullable rather than absent, so a reader that branches on it has one shape
     * to handle: `null` says "this belongs to a session", which is a different
     * claim from "this field was not sent".
     */
    roomId: z.string().min(1).nullable(),
    content: UiCanvasContentSchema,
    title: z.string(),
    contentType: z.string().min(1),
    /** Who put it here — a room author id, or the session's own owner or agent. */
    authorId: z.string().min(1),
    /** Pinned documents sort first and are never evicted to make room. */
    pinned: z.boolean(),
    rev: z.number().int().nonnegative(),
    /** Who last opened or updated it. */
    lastTouchedBy: z.string().min(1),
    /** When they did, ISO 8601. */
    lastTouchedAt: z.string().min(1),
    /**
     * The member holding the edit lock right now, or absent when nobody is.
     *
     * Evaluated lazily against the lock's own TTL, so a browser that crashed
     * mid-edit simply stops being a lock rather than wedging the document.
     */
    editingBy: z.string().min(1).optional(),
    /** Where a file document came from, for the reader: `Ana's copy · 3 ahead of main`. */
    sourceLabel: z.string().optional(),
    /**
     * WHICH tree a file document's path was resolved against, so a reader can be
     * told whose copy they are looking at.
     *
     * - `room-main` — the room's own shared copy. Every member can read it.
     * - `worktree` — one member's working copy of the room's files.
     * - `agent-cwd` — somebody's own project, in a room with no files of its own.
     *
     * Absent for a document that names no file. Recorded at OPEN time, so a room
     * that gains or loses a repo later never relabels what is already on the
     * table.
     */
    treeKind: z.enum(['room-main', 'worktree', 'agent-cwd']).optional(),
    /**
     * Commits that member's copy had which the room's `main` did not, when the
     * document was opened — a snapshot, never a live number.
     *
     * `null` means "not measured" rather than "level with the room". A label
     * that said a copy was up to date when nothing checked is one somebody would
     * act on.
     */
    aheadOfMain: z.number().int().nonnegative().nullable().optional(),
    /**
     * The directory a `worktree` document's path was resolved against — and
     * ONLY a `worktree` one (spec `canvas-agent-seat` §8).
     *
     * The review surface needs it: a worktree-backed diff is read and its
     * rejected hunks are written against the tree the document was opened
     * against, never a re-derived one, which is what makes a reject land where
     * the work is.
     *
     * **Withheld for every other tree kind**, because a room's working copies
     * are the ROOM's — DorkOS made them, under the room's own home, and every
     * member can already read their slugs off the repo status — whereas
     * `agent-cwd` is somebody's own project directory, which is not the room's
     * to publish and which nothing in the app could open anyway.
     */
    resolvedCwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The working copy a `worktree` document\u2019s path was resolved against \u2014 and only a `worktree` one. The review surface reads and writes there, so a rejected hunk lands in the tree the document was opened against rather than a re-derived one. Withheld for every other tree kind: a room\u2019s working copies are the room\u2019s own, while an `agent-cwd` is somebody\u2019s own project directory.'
      ),
    openedAt: z.string().min(1),
    lastActiveAt: z.string().min(1),
  })
  .openapi('CanvasDocument');

/** One document on a room's canvas. See {@link CanvasDocumentSchema}. */
export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>;
