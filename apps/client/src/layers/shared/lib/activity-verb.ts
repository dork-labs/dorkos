/**
 * The honesty ladder: what a row is allowed to say a session is doing.
 *
 * One function, so the sidebar, the session switcher, ⌘K's Continue row and the
 * chat status strip cannot end up describing the same turn four ways
 * (design-decisions §5, BC-37).
 *
 * **Degrade down the ladder, never guess.** Each rung is reached only when the
 * one above it cannot be answered honestly, and the bottom rung is silence. A
 * verb that outlives its turn is a lie, and a lying verb is worse than none —
 * which is why an idle session gets `null` rather than a stale phrase.
 *
 * **This is the only place in the client that turns a session's state into
 * words.** The sidebar reaches it through `SessionVerbLine` and the chat status
 * strip calls it directly. `tool-labels.ts` — the tool-naming rung underneath —
 * is reachable from here and from nowhere else: `formatActivityLabel` (the
 * session's finished sentence) is not called outside this module at all, and
 * `activityClause` travels outward through the barrel because a room needs the
 * same reading in a different grammar (DOR-1351). A test reads the sources and
 * fails if either name is taken straight off `tool-labels`, because the failure
 * mode here is not a crash: it is two surfaces quietly describing one turn two
 * ways.
 *
 * @module shared/lib/activity-verb
 */
import type { SessionActivity, SessionLifecycle } from '@dorkos/shared/session-stream';
import { activityClause, formatActivityLabel } from './tool-labels';

/**
 * The clause a room's sentence puts after "is" — `reading standup.md`.
 *
 * Re-exported from the rung rather than re-derived, so the room lane and the
 * session lane cannot describe one tool call two ways (BC-37). `null` means the
 * caller should say its own less specific truth, never that it should invent
 * one.
 */
export { activityClause };

/**
 * The same reading as a standalone line — `Reading standup.md` — or `null` when
 * nothing is known.
 *
 * Capitalised and WITHOUT the trailing ellipsis {@link activityVerb}'s session
 * framing carries: the ellipsis says "this line is a status that keeps moving",
 * which is true of a strip that is always on screen and false of a row inside a
 * card somebody opened on purpose.
 *
 * @param activity - The reading, or `null`/`undefined` when there is none.
 */
export function activitySentence(activity: SessionActivity | null | undefined): string | null {
  const clause = activityClause(activity);
  return clause === null ? null : `${clause[0]!.toUpperCase()}${clause.slice(1)}`;
}

/**
 * What a blocked session says, and the one phrase the ladder writes itself.
 *
 * Lower case and without an ellipsis, unlike every rung above it: the tool
 * verbs describe something in motion, and this describes something that has
 * stopped and is waiting for a person.
 */
export const WAITING_ON_YOU_VERB = 'waiting on you';

/**
 * Say what a session is doing right now, or nothing at all.
 *
 * The ladder:
 *
 * 1. `blocked` — "waiting on you". The strongest reading there is, and the only
 *    one that is about the reader rather than the agent.
 * 2. `streaming` with a recognizable tool — the specific verb, from
 *    {@link formatActivityLabel} ("Editing lane-state.ts…", "Using Slack…").
 * 3. `streaming` with nothing known — "Working…", which is all a streaming
 *    lifecycle on its own can honestly support. Guaranteed on every runtime by
 *    the lifecycle contract, which is why the sidebar can always say something
 *    about a live turn.
 * 4. Anything else — `null`. An idle, interrupted or errored session has no
 *    verb: it is not doing anything, and a row that keeps talking about a turn
 *    that ended is the churn this whole architecture exists to prevent.
 *
 * **`error` deliberately returns `null` rather than a verb.** A wedged session
 * is a Heads up item — it needs a person, and Heads up is where things that need a person
 * live (BC-5). Spending the row's second line on it would say the same thing
 * twice, in the weaker of the two places.
 *
 * @param lifecycle - The session's coarse phase, as its runtime reports it.
 * @param activity - The tool the session most recently started, when the server
 *   knows one. Absent for an idle session, a turn before its first tool, or a
 *   server that predates the field.
 */
export function activityVerb(
  lifecycle: 'streaming' | 'blocked',
  activity?: SessionActivity | null
): string;
/**
 * Say what a session is doing right now, or nothing at all.
 *
 * A live turn ALWAYS has something honest to say — rung 3 is the floor, and the
 * lifecycle contract guarantees every runtime reaches it — so the overload
 * above narrows the return to `string` for the two lifecycles that are moving.
 * That is a promise about the ladder, not a convenience: a caller inside a
 * `status === 'streaming'` branch would otherwise need a `?? fallback`, and a
 * fallback is a second phrasing rule, which is the exact drift this module
 * exists to prevent. A test pins the promise at runtime.
 *
 * @param lifecycle - The session's coarse phase, as its runtime reports it.
 * @param activity - The tool the session most recently started, when known.
 */
export function activityVerb(
  lifecycle: SessionLifecycle | null | undefined,
  activity?: SessionActivity | null
): string | null;
/**
 * The ladder itself. See the overloads above for the contract callers see.
 *
 * @param lifecycle - The session's coarse phase, as its runtime reports it.
 * @param activity - The tool the session most recently started, when known.
 */
export function activityVerb(
  lifecycle: SessionLifecycle | null | undefined,
  activity?: SessionActivity | null
): string | null {
  if (lifecycle === 'blocked') return WAITING_ON_YOU_VERB;
  if (lifecycle === 'streaming') return formatActivityLabel(activity);
  return null;
}
