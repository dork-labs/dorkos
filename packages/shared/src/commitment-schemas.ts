/**
 * Zod schemas for commitments: what an agent promised, to whom, and by when
 * (spec `heartbeats` §12, canon PROACTIVE-AGENTS §5.5).
 *
 * DorkOS keeps the list, not the agent's chat, so anyone in the space can read
 * every agent's promises. `overdue` is computed when a commitment is read and is
 * never stored.
 *
 * @module shared/commitment-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The longest a promise's text may be. */
export const COMMITMENT_WHAT_MAX = 300;

/** The longest a note on a commitment may be. */
export const COMMITMENT_NOTE_MAX = 500;

/** The longest a `to` value may be. */
export const COMMITMENT_TO_MAX = 200;

/**
 * The prefix a `to` value carries when the promise was made to an outsider
 * (`external:Acme`), as opposed to a person's account or an agent id.
 */
export const COMMITMENT_EXTERNAL_PREFIX = 'external:';

/** Where a commitment stands. */
export const CommitmentStateSchema = z
  .enum(['open', 'kept', 'missed', 'dropped'])
  .openapi('CommitmentState');

/** A commitment's state. */
export type CommitmentState = z.infer<typeof CommitmentStateSchema>;

/** One commitment, as every reader sees it. */
export const CommitmentSchema = z
  .object({
    id: z.string(),
    /** The Mesh id of the agent that promised. */
    agentId: z.string(),
    /** To whom: an account, an agent id, or `external:<label>`; null when unnamed. */
    to: z.string().nullable(),
    /** What was promised. */
    what: z.string(),
    /** When it is due (ISO 8601), or null. */
    dueAt: z.string().nullable(),
    state: CommitmentStateSchema,
    /** Open with a due date in the past. Computed on read, never stored. */
    overdue: z.boolean(),
    /** The chat the promise was made in, or null. */
    sourceSessionId: z.string().nullable(),
    /** The room message the promise was made in, or null. */
    sourceRoomEntryId: z.string().nullable(),
    createdAt: z.string(),
    /** When it left `open`, or null while open. */
    closedAt: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi('Commitment');

/** One commitment. */
export type Commitment = z.infer<typeof CommitmentSchema>;

/** An ISO 8601 date-time with an offset, the form every due date takes. */
const DueAtSchema = z.string().datetime({ offset: true });

/** What a person sends to add a commitment for an agent. */
export const CreateCommitmentRequestSchema = z
  .object({
    what: z.string().trim().min(1).max(COMMITMENT_WHAT_MAX),
    to: z.string().trim().min(1).max(COMMITMENT_TO_MAX).optional(),
    dueAt: DueAtSchema.optional(),
  })
  .openapi('CreateCommitmentRequest');

/** A create-commitment request. */
export type CreateCommitmentRequest = z.infer<typeof CreateCommitmentRequestSchema>;

/**
 * What changes a commitment: its new state, and optionally a new due date and a
 * note. A new `dueAt` with state `open` moves the date.
 */
export const UpdateCommitmentRequestSchema = z
  .object({
    state: CommitmentStateSchema,
    dueAt: DueAtSchema.nullable().optional(),
    note: z.string().trim().max(COMMITMENT_NOTE_MAX).optional(),
    /** The state the caller believes it is in now; a mismatch is refused (`CONFLICT`). */
    from: CommitmentStateSchema.optional(),
  })
  .openapi('UpdateCommitmentRequest');

/** An update-commitment request. */
export type UpdateCommitmentRequest = z.infer<typeof UpdateCommitmentRequestSchema>;

/** The most rows one list request may ask for. */
export const COMMITMENT_LIST_MAX = 500;

/**
 * Filters for listing commitments. Every one is optional. Open promises are
 * never cut by `limit`; closed ones fill the rest, newest first.
 */
export const ListCommitmentsQuerySchema = z
  .object({
    agentId: z.string().min(1).optional(),
    state: CommitmentStateSchema.optional(),
    to: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(COMMITMENT_LIST_MAX).optional(),
  })
  .openapi('ListCommitmentsQuery');

/** A list-commitments query. */
export type ListCommitmentsQuery = z.infer<typeof ListCommitmentsQuerySchema>;

/** The answer to a list request. */
export const ListCommitmentsResponseSchema = z
  .object({ commitments: z.array(CommitmentSchema) })
  .openapi('ListCommitmentsResponse');

/** A list-commitments response. */
export type ListCommitmentsResponse = z.infer<typeof ListCommitmentsResponseSchema>;
