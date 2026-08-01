/**
 * The refusal rule: every path that declines to do the obvious thing writes
 * exactly one line, saying why — and whether anybody was told.
 *
 * > On 2026-07-31 a room exchange ran forty-one minutes. Four notices were
 * > written, two approval prompts expired unanswered, a watchdog killed a turn,
 * > and the server wrote three log lines. The refusals that mattered most were
 * > the ones nobody could see, and those were exactly the ones that left no
 * > record at all.
 *
 * Two fields make a refusal answerable by `jq` rather than by reading prose:
 *
 * - **`reason`** comes from a CLOSED union ({@link RefusalReason}), never a
 *   free-form string, so `jq 'group_by(.reason)'` works without parsing English.
 * - **`visibility`** says whether the person was told: `shown`, `damped`
 *   (a notice was suppressed), or `silent` (there was never a notice).
 *
 * **Level follows visibility, and that is the load-bearing part.** A refusal
 * the user can see is `info` — the product already told them. A refusal that was
 * damped or silent is `warn`, because the log line is then the ONLY record that
 * anything happened. That is precisely the class of event that produced two
 * invisible ten-minute silences in the incident.
 *
 * @module services/observability/refusals
 */
import { currentDispatch } from '../../lib/dispatch-context.js';
import { logger } from '../../lib/logger.js';
import { recordRefusal } from './dispatch-buffers.js';

/**
 * Whether the person on the other end learned that something was declined.
 *
 * - `shown` — a notice, an error, or an HTTP status reached them.
 * - `damped` — a notice existed but was deliberately suppressed as a repeat.
 * - `silent` — there is no notice for this path; the log is the only record.
 */
export type RefusalVisibility = 'shown' | 'damped' | 'silent';

/**
 * Every reason DorkOS declines to do the obvious thing, as one closed set.
 *
 * Closed on purpose. A free-form reason string reads fine to a person and is
 * useless to the tool that has to group ten thousand lines, and it drifts: the
 * same refusal acquires three spellings across three files, and nothing notices.
 * Adding a reason here is a deliberate act, and the guide's table is generated
 * from the same list a call site picks from.
 */
export const REFUSAL_REASONS = {
  /** An agent was already mid-turn, so no second turn ran. */
  agent_busy: 'the agent was already working',
  /** A turn ran and ended in an error, or never finished at all. */
  turn_failed: 'the turn failed',
  /** The cascade guard stopped an exchange that had gone around enough times. */
  cascade_depth: 'the exchange reached its automatic-reply limit',
  /** The cascade guard refused an agent already inside this exchange. */
  cascade_ancestry: 'the agent was already in this exchange',
  /** The room has spent its automatic turns for the window. */
  room_budget: 'the room ran out of automatic turns',
  /** The `(room, agent)` session row could not be written, so no turn started. */
  session_bind_failed: 'the room session could not be bound',
  /** Another client holds the session write-lock. */
  session_locked: 'the session was locked by another client',
  /** A prompt only a person can answer expired, and was denied by the clock. */
  interaction_expired: 'nobody answered the prompt in time',
  /** An inbound chat message resolved to no binding at all. */
  no_binding: 'nothing connects this chat to an agent',
  /** An inbound chat subject could not be parsed. */
  unreadable_subject: 'the chat subject could not be read',
  /** The binding exists but is paused. */
  binding_paused: 'the connection is paused',
  /** The binding is set not to pass messages to its agent. */
  receive_denied: 'the connection may not send to its agent',
  /** The bound agent is not in the mesh registry. */
  agent_missing: 'the agent is not registered',
  /** A session for the inbound message could not be created. */
  session_failed: 'a session could not be created',
  /** The relay's per-sender rate limit refused the publish. */
  rate_limited: 'too many messages too quickly',
  /** The relay's authoritative budget gate refused the publish. */
  budget_exceeded: 'the message ran out of budget',
  /** Nothing accepted the turn — no subscriber, or a gate that named itself. */
  delivery_failed: 'the runtime did not accept the turn',
} as const;

/** One reason from {@link REFUSAL_REASONS}. */
export type RefusalReason = keyof typeof REFUSAL_REASONS;

/**
 * One refusal, in the shape both the log and the diagnostic buffer take.
 *
 * Everything optional is an id or a coarse enum, never content — the same
 * discipline the span allowlist enforces, applied to a log line.
 */
export interface Refusal {
  reason: RefusalReason;
  visibility: RefusalVisibility;
  /** The room it happened in, when it happened in one. */
  roomId?: string;
  /** The agent it happened to. */
  authorId?: string;
  /** The session it happened on. */
  sessionId?: string;
  /** The room entry that triggered it. */
  entryId?: string;
  /** Free-form-shaped but bounded extras — ids, counts, durations, coarse enums. */
  detail?: Record<string, string | number | boolean | undefined>;
}

/**
 * Write the one line a refusal owes, at the level its visibility earns.
 *
 * The `dispatchId` is NOT passed here: the file reporter adds it ambiently, so
 * a refusal inside a dispatch is correlated without this function knowing the
 * dispatch exists.
 *
 * @param message - The `'[tag] sentence'` line, in the same voice as every other.
 * @param refusal - Why, who it happened to, and whether they were told.
 */
export function logRefusal(message: string, refusal: Refusal): void {
  const { reason, visibility, detail, ...where } = refusal;
  const fields = {
    ...Object.fromEntries(Object.entries(where).filter(([, v]) => v !== undefined)),
    ...(detail
      ? Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined))
      : {}),
    reason,
    visibility,
  };
  // Level follows visibility. A refusal nobody saw is the only record that it
  // happened, and a record filed at `info` is a record nobody looks at.
  if (visibility === 'shown') logger.info(message, fields);
  else logger.warn(message, fields);
  // The same fact, kept in memory so `GET /api/debug/refusals` can answer
  // "why has nothing replied for ten minutes" without anyone opening a file.
  // The log is still the durable record; this is the last 256, for right now.
  const ctx = currentDispatch();
  recordRefusal(refusal, ctx ? { dispatchId: ctx.dispatchId, origin: ctx.origin } : undefined);
}
