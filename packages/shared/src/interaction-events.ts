/**
 * The Ask on the wire — one prompt an agent is parked on, addressed to whoever
 * may answer it (spec `unified-conversation` §3.1).
 *
 * A tool approval, a question and an MCP elicitation are one object here. They
 * are raised inside one session and broadcast to the whole cockpit, so the card
 * that answers one can be drawn anywhere: the header pill, the sidebar, the home
 * triage header, a room's live lane, and the session's own transcript.
 *
 * Two things are deliberately NOT on these events, and adding either would undo
 * the reason they are shaped this way:
 *
 * - **No denormalized identity.** No agent name, emoji or colour. Every client
 *   that draws this already holds the fleet session list off the same stream, so
 *   `sessionId` joins to the session that carries them. A name copied onto a hot
 *   event goes stale the moment an agent is renamed. `cwd` rides along precisely
 *   so the fallback (session not in the list yet → the basename of its
 *   directory) needs no name of its own.
 * - **No per-second countdown.** `startedAt` and `timeoutMs` ride inside the
 *   interaction; `remainingMs` is computed server-side when the event is emitted
 *   and again when the list is read, and the client ticks locally from
 *   `startedAt + timeoutMs`. Two events per parked turn is the whole budget.
 *
 * **Two things called `InteractionResolvedEvent` now exist, deliberately.** The
 * one here is the FLEET-wide announcement — a session id, an interaction id and
 * an outcome, addressed to every window. `session-stream.ts` exports another
 * under the same name: the seq'd event inside ONE session's own stream, which
 * carries the resolution, the kind and the timestamps the transcript's receipt
 * is built from. The names come from the spec and each is right in its own
 * module; nothing imports both, and a file that needed to would alias one.
 *
 * @module shared/interaction-events
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { PendingInteractionDTOSchema } from './schemas.js';

extendZodWithOpenApiOnce();

/**
 * One prompt an agent is parked on, addressed to whoever may answer it.
 *
 * The interaction itself is {@link PendingInteractionDTOSchema} **verbatim** —
 * the same object the per-session stream and the recovery snapshot already
 * carry, so the card that renders it cannot drift between the two paths and no
 * second shape has to be kept in step.
 */
export const InteractionPendingEventSchema = z
  .object({
    /** The session whose turn is parked. */
    sessionId: z.string().min(1),
    /** The session's working directory — the deep link, and the identity fallback. */
    cwd: z.string().min(1),
    /** What is being asked. Carries `type`, `id`, `startedAt`, `remainingMs`, and the kind's own fields. */
    interaction: PendingInteractionDTOSchema,
    /** The room this session answers in, when it is bound to one. */
    roomId: z.string().min(1).optional(),
    /** The agent's author id in that room, for correlating with the presence line. */
    roomAuthorId: z.string().min(1).optional(),
  })
  .openapi('InteractionPendingEvent');

/** One prompt an agent is parked on. See {@link InteractionPendingEventSchema}. */
export type InteractionPendingEvent = z.infer<typeof InteractionPendingEventSchema>;

/** How an Ask stopped being pending. */
export const InteractionOutcomeSchema = z.enum(['answered', 'cancelled', 'expired']);

/** How an Ask stopped being pending. See {@link InteractionOutcomeSchema}. */
export type InteractionOutcome = z.infer<typeof InteractionOutcomeSchema>;

/**
 * An Ask is over — answered by a person, cancelled under it, or timed out.
 *
 * Every copy of the card on every surface reads this one event and morphs into a
 * receipt. It is never a disappearance: a person who clicked Allow somewhere
 * else, a session that went away, and a clock that ran out are three different
 * things to say, and the outcome is which one to say.
 */
export const InteractionResolvedEventSchema = z
  .object({
    /** The session whose prompt this was. */
    sessionId: z.string().min(1),
    /** The interaction id — the same id `InteractionPendingEvent.interaction.id` carried. */
    interactionId: z.string().min(1),
    /** How it ended. */
    outcome: InteractionOutcomeSchema,
    /** ISO timestamp of the resolution, for the receipt line. */
    resolvedAt: z.string(),
    /**
     * A label for whoever answered, when the server knows one — the name this
     * install knows the person by, taken from their account or from the name
     * they told DorkOS to call them.
     *
     * The one denormalized name on these events, and it has no join to be read
     * from instead: a session id names the agent, and nothing on the wire names
     * the person. Absent for `cancelled` and `expired`, where nobody answered
     * at all, and absent on an install where the person never gave a name — the
     * receipt then says "Already answered at 2:01", which is still true.
     */
    resolvedBy: z.string().optional(),
  })
  .openapi('InteractionResolvedEvent');

/** An Ask is over. See {@link InteractionResolvedEventSchema}. */
export type InteractionResolvedEvent = z.infer<typeof InteractionResolvedEventSchema>;

/**
 * Every Ask waiting on a person right now — the seed a window reads on mount,
 * before the live stream can tell it anything.
 */
export const PendingInteractionsResponseSchema = z
  .object({
    /** One envelope per parked prompt, with server-authoritative time left. */
    interactions: z.array(InteractionPendingEventSchema),
    /** Per-source degradation, in the shape `GET /api/sessions` already uses (ADR-0310). */
    warnings: z.array(z.string()).optional(),
  })
  .openapi('PendingInteractionsResponse');

/** Every Ask waiting on a person. See {@link PendingInteractionsResponseSchema}. */
export type PendingInteractionsResponse = z.infer<typeof PendingInteractionsResponseSchema>;
