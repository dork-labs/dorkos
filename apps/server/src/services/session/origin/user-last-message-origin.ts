/**
 * The session-level half of `Session.userLastMessageAt`'s honesty rule: a
 * session no operator ever typed into reports nothing (BC-16).
 *
 * `userLastMessageAt` is half the sidebar's Today order key, and its whole
 * value is that it moves only when a PERSON writes. The per-record classifier
 * (`isPersonAuthoredUserRecord`) catches the machine traffic that carries a
 * marker — tool results, relay hand-offs from other agents, DorkOS's own
 * notes — but two shipped paths deliver machine text with no marker at all:
 *
 * - **Scheduled tasks.** `task-scheduler-service.ts` sends `task.prompt` as
 *   plain user content, so a cron task would bump the field on every fire with
 *   nobody present — exactly the churn BC-16 exists to prevent.
 * - **Room posts by other agents.** `room-turn-runner.ts` sends the post byte
 *   for byte as the prompt (the `room_context` block rides `additionalContext`,
 *   not the message), so another agent's words are indistinguishable from
 *   yours inside the record.
 *
 * Neither is answerable from message content, so it is answered from the
 * session instead: an `agent`, `task` or `room` origin means the operator never
 * wrote here, and the field is dropped whole.
 *
 * **Why not `channel` or `external`.** A `channel` session is a person writing
 * from Telegram, Slack or a webhook — still you, still an interaction, so the
 * reading stands. An `external` session (A2A client, external MCP client)
 * receives its content through a relay record, which the per-record classifier
 * already rejects on its `From:` line; the session-level gate would be
 * redundant there.
 *
 * Applied in three places, all of which decide an origin: the claude-code
 * transcript reader (`agent`/`task` from the transcript head) and the two
 * route-level overlays (`room` and Pulse `task`, neither of which the head
 * classifier can see). Runtime-agnostic on purpose — a runtime that starts
 * supplying the field later inherits the rule for free.
 *
 * @module services/session/origin/user-last-message-origin
 */
import type { Session, SessionOrigin } from '@dorkos/shared/types';

/**
 * Origins that mean no operator ever wrote in this session.
 *
 * `room` never comes from a transcript — it is assigned by
 * {@link applyRoomOriginOverlay} from the `room_sessions` binding, the server's
 * own record of which sessions ARE room turns.
 */
const ORIGINS_WITH_NO_OPERATOR: readonly SessionOrigin[] = ['agent', 'task', 'room'];

/**
 * Whether a session's origin says its traffic came from something other than a
 * person.
 *
 * @param origin - The session's resolved origin; absent means user-initiated,
 *   the unmarked default.
 */
function originHasNoOperator(origin: SessionOrigin | undefined): boolean {
  return origin !== undefined && ORIGINS_WITH_NO_OPERATOR.includes(origin);
}

/**
 * Drop `userLastMessageAt` in place when the session's origin says no operator
 * ever wrote in it. Leaves every other field alone, and leaves the reading
 * alone for sessions a person did write in.
 *
 * Deleting the key rather than setting it to `undefined` matters: `res.json`
 * omits `undefined` but a client reading `'userLastMessageAt' in session` would
 * still see it, and "omission, never a guess" has to survive both readings.
 *
 * @param session - The session row to correct, mutated in place.
 */
export function dropUserLastMessageAtWithoutOperator(session: Session): void {
  if (session.userLastMessageAt !== undefined && originHasNoOperator(session.origin)) {
    delete session.userLastMessageAt;
  }
}
