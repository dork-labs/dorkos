/**
 * Which relay subjects a person's consent has to cover.
 *
 * One definition, used from both sides of the seam: the publish pipeline asks
 * it "is this a subject I must not deliver to without a consent gate?", and the
 * host's binding-aware gate asks it "is this a subject I have an opinion
 * about?". A second copy of this predicate is how the two ends drift until one
 * of them stops covering a channel the other still gates.
 *
 * @module relay/lib/consent-scope
 */

/** Prefix of every subject that reaches a person on a chat platform. */
export const HUMAN_SUBJECT_PREFIX = 'relay.human.';

/**
 * Prefix of the in-app console's own subjects.
 *
 * The console is the operator's own UI on their own machine: there is no
 * external channel behind it, no binding to consent with, and no "starting a
 * conversation" to consent to. It is carved out so that a machine with no
 * consent gate can still talk to itself.
 */
export const CONSOLE_SUBJECT_PREFIX = 'relay.human.console';

/**
 * Whether reaching this subject requires a resolved initiate-consent decision.
 *
 * True for every bound external human channel (`relay.human.telegram.…`,
 * `relay.human.slack.…`, …) and false for everything else — agent and system
 * subjects, and the in-app console.
 *
 * @param subject - The target subject of a publish.
 */
export function requiresInitiateConsent(subject: string): boolean {
  if (!subject.startsWith(HUMAN_SUBJECT_PREFIX)) return false;
  return !isConsoleSubject(subject);
}

/**
 * Whether a subject belongs to the in-app console.
 *
 * The console token is matched WHOLE — `relay.human.console` itself, or
 * anything under `relay.human.console.`. A bare `startsWith` on the prefix
 * would also match `relay.human.consolidated.chat-1`, handing an adapter named
 * like that the console's carve-out.
 *
 * @param subject - A relay subject.
 */
export function isConsoleSubject(subject: string): boolean {
  return subject === CONSOLE_SUBJECT_PREFIX || subject.startsWith(`${CONSOLE_SUBJECT_PREFIX}.`);
}
