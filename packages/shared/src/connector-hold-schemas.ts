/**
 * The cancel window before an agent's irreversible action in a connected app
 * (spec `trusted-by-default-flip` §5.6, DOR-2739).
 *
 * On a Trusted install, an agent whose chat never asks does not raise an
 * approval card for `connectors.execute_destructive`. The call waits
 * {@link DESTRUCTIVE_HOLD_MS} instead, everyone is told, and anyone but the
 * agent that asked may cancel it. A hold is not an undo: once it runs, it ran.
 *
 * @module shared/connector-hold-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** How long a held action waits before it runs, unless someone cancels it. */
export const DESTRUCTIVE_HOLD_MS = 60_000;

/** Path parameters of `POST /api/connectors/holds/{holdId}/cancel`. */
export const CancelHeldActionParamsSchema = z
  .object({
    /** The hold, as its notification and the agent's tool call name it. */
    holdId: z.string().min(1),
  })
  .openapi('CancelHeldActionParams');

/** The answer when a held action was cancelled. It will not run. */
export const CancelHeldActionResponseSchema = z
  .object({
    status: z.literal('cancelled'),
    holdId: z.string(),
  })
  .openapi('CancelHeldActionResponse');

/** The answer when a held action was cancelled. */
export type CancelHeldActionResponse = z.infer<typeof CancelHeldActionResponseSchema>;

/**
 * Why a cancel did nothing.
 *
 * - `HOLD_NOT_FOUND` — no action is waiting under that id: it already ran, was
 *   already cancelled, or DorkOS restarted and dropped it.
 * - `HOLD_REQUESTER` — the agent that asked for the action may not cancel it;
 *   anyone else may.
 */
export const CancelHeldActionErrorSchema = z
  .object({
    error: z.string(),
    code: z.enum(['HOLD_NOT_FOUND', 'HOLD_REQUESTER']),
  })
  .openapi('CancelHeldActionError');

/** Why a cancel did nothing. */
export type CancelHeldActionError = z.infer<typeof CancelHeldActionErrorSchema>;
