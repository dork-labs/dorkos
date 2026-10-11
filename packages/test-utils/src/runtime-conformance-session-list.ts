/**
 * The session-list half of the runtime conformance suite, as plain rules: the
 * session-list stream must say something valid (DOR-851), and
 * `Session.userLastMessageAt` must be either supplied honestly or declared
 * absent (spec `sidebar-now-today-library` BC-16).
 *
 * Kept apart from `runtime-conformance.ts` and exported so the suite and its
 * proofs of failure run the SAME rules; the suite only ever meets adapters
 * that are supposed to pass.
 *
 * @module test-utils/runtime-conformance-session-list
 */
import { SessionListEventSchema, type SessionListEvent } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';

/**
 * Whether a runtime has WAIVED the requirement to emit a session-list event.
 *
 * Whitespace does not waive, matching `autonomyDefaultReason`: the waiver has to
 * be a sentence somebody wrote, not a flag somebody flipped.
 *
 * @param silentReason - The runtime's `RuntimeConformanceOpts.sessionListSilentReason`.
 * @returns True when silence is an accepted answer for this runtime.
 */
export function sessionListSilenceWaived(silentReason: string | undefined): boolean {
  return (silentReason ?? '').trim().length > 0;
}

/**
 * How long the session-list case waits for a first event.
 *
 * Longer when an event is REQUIRED, because that wait now decides a real
 * assertion and must not fail a working stream that was merely slow; shorter
 * when silence is waived, so a runtime that will never emit is not taxed for it.
 * Both fit inside the default 5000ms `it` timeout with room for the turn — this
 * case must never be the thing that runs the clock out.
 *
 * @param silentReason - The runtime's `RuntimeConformanceOpts.sessionListSilentReason`.
 * @returns Milliseconds to wait before treating the stream as silent.
 */
export function sessionListWaitMs(silentReason: string | undefined): number {
  return sessionListSilenceWaived(silentReason) ? 500 : 2000;
}

/**
 * The session-list contract, applied to one subscribed stream.
 *
 * Reads at most one event, bounded by {@link sessionListWaitMs}, and answers the
 * two ways a list stream can be wrong: it said NOTHING when this runtime never
 * waived that, or it said something `SessionListEventSchema` rejects.
 *
 * Extracted and exported so the suite and its proof-of-failure
 * (`runtime-conformance-session-list.test.ts`) run the SAME rules — the suite
 * only ever meets adapters that are supposed to pass, so a green conformance run
 * is no evidence these rules fired at all. Nothing in that test re-implements
 * what is here.
 *
 * The caller owns closing the stream; this never does, because teardown belongs
 * on a different clock (see the call site).
 *
 * @param iterator - A subscribed `subscribeSessionList` iterator.
 * @param silentReason - The runtime's `RuntimeConformanceOpts.sessionListSilentReason`.
 * @returns Null when the stream satisfies the contract, else the failure message.
 */
export async function evaluateSessionListStream(
  iterator: AsyncIterator<SessionListEvent>,
  silentReason: string | undefined
): Promise<string | null> {
  const waitMs = sessionListWaitMs(silentReason);
  // Cleared in `finally` rather than left to expire: when the event wins the
  // race the timer is still armed, and an orphan 2s timer per conformance run
  // holds the event loop open past the assertion for no reason.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let race: { kind: 'event'; result: IteratorResult<SessionListEvent> } | { kind: 'timeout' };
  try {
    race = await Promise.race([
      iterator.next().then((result) => ({ kind: 'event' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (race.kind === 'timeout' || race.result.done) {
    if (sessionListSilenceWaived(silentReason)) return null;
    return (
      `subscribeSessionList emitted nothing within ${waitMs}ms, so SessionListEventSchema was ` +
      `never applied and this case asserted nothing — a dead stream, not a pass. A runtime that ` +
      `genuinely cannot produce an event here must say why via sessionListSilentReason.`
    );
  }

  const parsed = SessionListEventSchema.safeParse(race.result.value);
  if (parsed.success) return null;
  return (
    `subscribeSessionList produced an event that fails SessionListEventSchema ` +
    `(SessionListBroadcaster would silently drop it): ${parsed.error.message}`
  );
}

/**
 * Which of the two honest answers this runtime signed up for, if either.
 *
 * Exported and separate from the assertions below for the same reason
 * {@link evaluateSessionListStream} is: the suite only ever meets adapters that
 * are supposed to pass, so a green run is no evidence these rules fired.
 * `runtime-conformance-last-user-message.test.ts` drives them directly.
 *
 * @param supplies - Whether `RuntimeConformanceOpts.userLastMessageAtSession` was wired.
 * @param omittedReason - The runtime's `RuntimeConformanceOpts.userLastMessageAtOmittedReason`.
 * @returns Null when the runtime picked an arm, else the failure message.
 */
export function chooseUserLastMessageAtArm(
  supplies: boolean,
  omittedReason: string | undefined
): string | null {
  const declared = (omittedReason ?? '').trim().length > 0;
  if (supplies && declared) {
    return (
      'this runtime both supplies Session.userLastMessageAt and declares it cannot ' +
      '(userLastMessageAtSession + userLastMessageAtOmittedReason). Pick one — the ' +
      'reason string exists to be DELETED when the field is implemented.'
    );
  }
  if (supplies || declared) return null;
  return (
    'a runtime must either supply Session.userLastMessageAt (wire userLastMessageAtSession) ' +
    'or declare in a sentence why it cannot (userLastMessageAtOmittedReason). Choosing ' +
    'neither leaves the sidebar ordering Today on a field nobody decided about, and ' +
    'whitespace declares nothing.'
  );
}

/**
 * The presence half of the `Session.userLastMessageAt` contract, applied to one
 * probe session (spec `sidebar-now-today-library` BC-16).
 *
 * `userLastMessageAt < updatedAt` is asserted as a **fixture obligation, not a
 * runtime invariant**. Plenty of real conversations end on the person's turn
 * and have both facts legitimately equal; nothing forbids a runtime from
 * reporting that. But such a conversation proves nothing here, because a
 * runtime that simply renamed `updatedAt` would pass on it. So the probe is
 * required to hand over a conversation the agent worked on afterwards, and a
 * fixture that cannot discriminate is rejected rather than passing.
 *
 * @param session - The Session the runtime's list path reported for the probe.
 * @returns Null when the reading satisfies the contract, else the failure message.
 */
export function evaluateUserLastMessageAtPresence(session: Session): string | null {
  const reported = session.userLastMessageAt;
  if (reported === undefined) {
    return (
      'this runtime declares it can say when the person last wrote, but its probe ' +
      'session reports nothing'
    );
  }
  const at = Date.parse(reported);
  if (Number.isNaN(at)) return `userLastMessageAt '${reported}' is not a date`;
  const updated = Date.parse(session.updatedAt);
  if (Number.isNaN(updated)) return `updatedAt '${session.updatedAt}' is not a date`;
  if (at >= updated) {
    return (
      `userLastMessageAt (${reported}) is not EARLIER than updatedAt (${session.updatedAt}). ` +
      'Either your probe fixture has no agent activity after the person’s last message — ' +
      'in which case it cannot discriminate and needs one, since a runtime that renamed ' +
      'updatedAt would pass on it — or this runtime is in fact reporting updatedAt under ' +
      'a second name.'
    );
  }
  return null;
}

/**
 * The omission half: a runtime that declared it cannot say when the person last
 * wrote must report NOTHING even after a person has written.
 *
 * `undefined` is the only accepted answer. A null, an empty string or a
 * placeholder all reach the client as a value it would order Today on, which is
 * precisely the guess the contract forbids.
 *
 * A null session is a FAILURE, not a pass: the turn completed, so a runtime that
 * cannot resolve the session it just ran gives this case nothing to look at and
 * would report green having asserted nothing.
 *
 * @param session - What the runtime reported for a session that just took a user
 *   message.
 * @param omittedReason - The declared reason, quoted back in the failure.
 * @returns Null when the runtime honestly said nothing, else the failure message.
 */
export function evaluateUserLastMessageAtOmission(
  session: Session | null,
  omittedReason: string | undefined
): string | null {
  if (session === null) {
    return (
      'getSession returned null for a session that had just completed a turn, so this ' +
      'case had no reported field to look at and asserted nothing.'
    );
  }
  if (session.userLastMessageAt === undefined) return null;
  return (
    `this runtime declared it cannot say when the person last wrote ("${omittedReason}") ` +
    `but reported ${JSON.stringify(session.userLastMessageAt)} after a user message. ` +
    'Implementing the field means deleting that reason and wiring userLastMessageAtSession.'
  );
}
