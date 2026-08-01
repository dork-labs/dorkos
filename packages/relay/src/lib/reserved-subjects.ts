/**
 * Subject namespaces the server owns, and the one nothing may own a mailbox in.
 *
 * The single list, held in the bus itself rather than in one of its callers, so
 * every surface that lets somebody register a mailbox answers the same question
 * the same way — the MCP tool, the HTTP route, and whatever is added next.
 *
 * @module relay/lib/reserved-subjects
 */

/**
 * Subject namespaces the server manages, which a caller acting for an agent (or
 * for a person over HTTP) may not register a mailbox in.
 *
 * `relay.agent.*` addresses are how messages reach an agent, so letting one
 * agent register another's would intercept its mail outright, not merely read
 * it. `relay.system.*` and `relay.human.*` belong to the server and the person
 * using it. The two ephemeral inbox namespaces are minted per tool call by
 * `relay_send_and_wait` and `relay_send_async`, which register them directly.
 */
export const SERVER_MANAGED_PREFIXES = [
  'relay.agent.',
  'relay.system.',
  'relay.human.',
  'relay.control.',
  'relay.inbox.dispatch.',
  'relay.inbox.query.',
] as const;

/**
 * The namespace carrying the server's control signals — today, stopping a task
 * run (DOR-808).
 *
 * A control signal is delivered by SUBSCRIPTION, never by mailbox, so an
 * endpoint here can only ever be a mistake or an attack. See
 * {@link isControlSubject} for what a mailbox here would actually do.
 */
export const CONTROL_SUBJECT_PREFIX = 'relay.control.';

/**
 * Whether `subject` is in a namespace the server manages.
 *
 * Says nothing about who is asking — callers that have their own notion of a
 * caller's own address (the MCP tool lets a principal register the address it
 * already receives mail on) apply that exception themselves.
 *
 * @param subject - The subject a caller asked to register.
 */
export function isServerManagedSubject(subject: string): boolean {
  return SERVER_MANAGED_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

/**
 * Whether `subject` carries a control signal, which no mailbox may ever hold.
 *
 * What a mailbox here would do is worth stating precisely, because the obvious
 * guess is wrong. It would NOT swallow the signal: `publish` writes to the
 * matching mailbox and skips the synchronous subscriber fan-out, but the
 * Maildir watcher then re-dispatches the message to those same subscribers, so
 * the handler still runs and the run still stops.
 *
 * What breaks is the COUNT. `deliveredTo` reports the mailbox delivery, and the
 * publisher reads that number as "a runner took this" — so a stop for a run
 * that nothing is executing comes back confirmed, and the honest "nobody took
 * it" answer becomes unreachable. A false confirmation is the whole failure
 * class this namespace exists to close, so the refusal is unconditional: there
 * is no legitimate caller, including the server itself.
 *
 * @param subject - The subject a caller asked to register.
 */
export function isControlSubject(subject: string): boolean {
  return subject.startsWith(CONTROL_SUBJECT_PREFIX);
}
