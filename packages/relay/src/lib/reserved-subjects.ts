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

/**
 * Destination namespaces only the server may send to (DOR-2432).
 *
 * `relay.system.*` carries the server's own traffic: a scheduled run's
 * dispatch (`relay.system.tasks.*`), a tool approval's answer
 * (`relay.system.approval.*`), and the notices DorkOS posts. `relay.control.*`
 * carries its stop signals. A handler on one of these subjects acts on what the
 * message says, so an agent that can send here can forge a task run or answer
 * its own approval (DOR-2416, DOR-2431). Those handlers also check the sender;
 * this is the door in front of them.
 *
 * Refusing registration here ({@link SERVER_MANAGED_PREFIXES}) is a separate
 * rule: that one stops an agent owning a mailbox, this one stops it sending.
 */
export const SERVER_DESTINATION_PREFIXES = ['relay.system.', 'relay.control.'] as const;

/** One server-owned subject agents may still send to, with the reason it is safe. */
export interface AgentSendableServerSubject {
  /** The exact subject. Never a prefix or a pattern. */
  readonly subject: string;
  /** Why an agent needs it, and why no handler there trusts what it says. */
  readonly reason: string;
}

/**
 * The server-owned subjects an agent may send to anyway. Empty on purpose.
 *
 * Audited 2026-09 (DOR-2432): no agent workflow sends to either namespace.
 * The scheduler, the stop paths, the approval bridges and the notifiers all
 * publish as server principals, and the only mailbox there,
 * `relay.system.console`, has no reader that acts on it. An entry added here
 * must name the exact subject and say why its handler is safe to reach, and the
 * test that pins this list must change with it.
 */
export const AGENT_SENDABLE_SERVER_SUBJECTS: readonly AgentSendableServerSubject[] = [];

/** The refusal every agent-facing send path returns for a server-owned address. */
export const SERVER_DESTINATION_REFUSAL =
  'relay.system.* and relay.control.* addresses belong to DorkOS; agents cannot send to them.';

/**
 * Principals that speak for an agent rather than for the server.
 *
 * - `relay.agent.*` — a registered agent's own identity.
 * - `relay.session.*` — a session with no registered agent behind it.
 * - `relay.external.*` — the external `/mcp` surface (`relay.external.mcp`).
 * - `agent:*` — an agent's turn answering an envelope's `replyTo`, which is how
 *   an agent would reach a server subject by naming it as the reply address of
 *   a message it sends to another agent.
 */
export const AGENT_PRINCIPAL_PREFIXES = [
  'relay.agent.',
  'relay.session.',
  'relay.external.',
  'agent:',
] as const;

/**
 * Whether `from` speaks for an agent. See {@link AGENT_PRINCIPAL_PREFIXES}.
 *
 * @param from - The publish `from` principal.
 */
export function isAgentPrincipal(from: string): boolean {
  return AGENT_PRINCIPAL_PREFIXES.some((prefix) => from.startsWith(prefix));
}

/**
 * Whether a message sent to `subject` could land in a server-owned namespace,
 * and is not on {@link AGENT_SENDABLE_SERVER_SUBJECTS}.
 *
 * A subject may carry wildcards (`relay.*.console`, `relay.>`), and a publish
 * delivers to every mailbox its pattern matches, so this asks whether the
 * pattern COULD match a server subject, not only whether it is written as one.
 * Tokens compare without regard to case: the bus matches case-sensitively
 * today, and refusing `relay.SYSTEM.*` as well costs nothing legitimate.
 *
 * @param subject - The destination (or reply address) a caller asked for.
 */
export function reachesServerDestination(subject: string): boolean {
  if (AGENT_SENDABLE_SERVER_SUBJECTS.some((entry) => entry.subject === subject)) return false;
  const tokens = subject.split('.');
  return SERVER_DESTINATION_PREFIXES.some((prefix) => {
    const prefixTokens = prefix.slice(0, -1).split('.');
    for (let i = 0; i < prefixTokens.length; i++) {
      const token = tokens[i];
      if (token === undefined) return false;
      if (token === '>') return true;
      if (token === '*') continue;
      if (token.toLowerCase() !== prefixTokens[i]) return false;
    }
    // A server subject has at least one token past the prefix.
    return tokens.length > prefixTokens.length;
  });
}
