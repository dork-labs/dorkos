/**
 * Read state — the wire contract for `PUT /api/read-cursors/:kind/:id`
 * (team-room-home spec §D4, ADR 260808-140956).
 *
 * Its own module rather than more surface on `room-schemas.ts`, because a read
 * cursor is deliberately not a room concept: the same route and the same table
 * answer for rooms, agent sessions and the inbox, and folding it into the rooms
 * slice would have made two of the three import a domain they have nothing to
 * do with.
 *
 * **The kind list is stated twice on purpose.** `READ_CURSOR_THREAD_KINDS` in
 * `@dorkos/db` types the column and builds its `CHECK`; this enum validates the
 * path segment. They cannot be one constant — `@dorkos/shared` reaches the
 * browser and `@dorkos/db` is `better-sqlite3`, so neither package may depend on
 * the other. Drift in the dangerous direction is caught at compile time anyway:
 * the route hands a value typed by THIS enum to a store typed by THAT one, so a
 * kind added here and not there fails to typecheck. The reverse (added there,
 * not here) only makes this route refuse a kind nothing sends yet.
 *
 * @module shared/read-cursor-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/** The kinds of thread a person can have read state in. */
export const ReadCursorThreadKindSchema = z
  .enum(['room', 'session', 'inbox'])
  .openapi('ReadCursorThreadKind');

/** What kind of thing a read cursor points into. */
export type ReadCursorThreadKind = z.infer<typeof ReadCursorThreadKindSchema>;

/**
 * The two path segments of `PUT /api/read-cursors/:kind/:id`.
 *
 * `id` is opaque and only checked for emptiness: it is a room id, a session id
 * or an inbox item id depending on `kind`, and those are minted by three
 * different things in three different shapes.
 */
export const ReadCursorParamsSchema = z.object({
  kind: ReadCursorThreadKindSchema,
  id: z.string().min(1),
});

/** The path segments, parsed. */
export type ReadCursorParams = z.infer<typeof ReadCursorParamsSchema>;

/**
 * Where the caller has now read to.
 *
 * A position, not a time: rooms number their entries with a monotonic `seq` and
 * sessions number their durable SSE events the same way, so both sides compare
 * integers rather than timestamps whose ordering depends on whose clock wrote
 * them.
 */
export const SetReadCursorPositionRequestSchema = z
  .object({ lastReadSeq: z.number().int().min(0) })
  .openapi('SetReadCursorPositionRequest');

/** A request to move the caller's cursor. */
export type SetReadCursorPositionRequest = z.infer<typeof SetReadCursorPositionRequestSchema>;

/** One person's position in one thread, as the route answers it. */
export const ReadCursorSchema = z
  .object({
    /** The person the cursor belongs to. */
    userId: z.string(),
    /** Which store `threadId` addresses. */
    threadKind: ReadCursorThreadKindSchema,
    /** Opaque id within `threadKind`. */
    threadId: z.string(),
    /** The highest position this person has read. Moves forward only. */
    lastReadSeq: z.number().int().min(0),
    /** ISO-8601 stamp of the write that last moved the cursor. */
    updatedAt: z.string(),
  })
  .openapi('ReadCursor');

/** One person's position in one thread. */
export type ReadCursor = z.infer<typeof ReadCursorSchema>;
