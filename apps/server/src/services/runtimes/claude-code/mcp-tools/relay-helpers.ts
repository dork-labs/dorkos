/**
 * Shared helpers for Relay MCP tool handlers.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-helpers
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { isServerManagedSubject, parseAgentSubject } from '@dorkos/relay';
import type { RelayBudget } from '@dorkos/shared/relay-schemas';
import { logger } from '../../../../lib/logger.js';

/** Sender identity injected on the external `/mcp` surface (no per-session context). */
export const EXTERNAL_MCP_SENDER = 'relay.external.mcp';

/** Server-resolved identity of the principal behind a Relay tool call. */
export interface SenderIdentity {
  /**
   * Relay subject used as the publish `from`. Namespace deny/allow rules
   * (written by RelayBridge) match on the agent subject `relay.agent.{ns}.{id}`,
   * so this is the value access control keys on.
   */
  subject: string;
  /**
   * Mesh agent id — present only when the session maps to a registered agent.
   * Used by `relay_notify_user` to resolve the caller's own integration bindings.
   */
  agentId?: string;
}

/**
 * Resolve the trusted sender identity for a Relay publish, server-side.
 *
 * The relay `from` is an authorization principal, not a label: namespace
 * deny/allow rules match on the agent's subject `relay.agent.{ns}.{id}`. Letting
 * the LLM assert its own `from` (or `agentId`) lets any agent claim another
 * identity and bypass those rules, so identity is derived from the session's
 * working directory rather than from tool arguments.
 *
 * - Registered agent (a manifest at `cwd`): its canonical subject via
 *   `meshCore.getSubjectByPath()`, which reads the UN-stripped registry entry —
 *   the same resolved namespace RelayBridge registered the endpoint and ACL
 *   rules with. (`getByPath()` cannot be used here: it returns a public
 *   manifest with `namespace` stripped, which would silently degrade the
 *   subject to `basename(cwd)` and match no rule for nested or
 *   explicit-namespace agents.)
 * - Any other session (or the external `/mcp` surface, `cwd` undefined): a
 *   deterministic, non-agent identity so the sender is still stable and
 *   unspoofable — no agent ACL rules apply to it. Suffixed with a short hash
 *   of the FULL `cwd` (DOR-514), not bare `path.basename(cwd)`: two unrelated
 *   projects that happen to share a leaf directory name — `/a/project` and
 *   `/b/project` — used to collide on one `relay.session.project` identity.
 *   No agent ACL rule keys on this subject, so the collision was pre-existing
 *   and mild rather than the in-session escalation DOR-506 closed, but it is
 *   cheap to remove. Keeping the basename in front of the hash (rather than
 *   hashing it away entirely) is deliberate: `classify-origin.ts` renders
 *   this subject's last segment as a session's origin label (e.g. "myproject
 *   (agent)") — a bare hash there reads as "e549f2e8 (agent)", which answers
 *   "is this the same session as before" but not "whose session is this,"
 *   the question the label exists to answer. `${basename}-${hash}` keeps
 *   both: legible AND distinct even when two projects share a leaf name.
 *
 * @param deps - Tool dependencies, for the Mesh registry lookup
 * @param cwd - The session's working directory, when known
 */
export function resolveSenderIdentity(deps: McpToolDeps, cwd: string | undefined): SenderIdentity {
  if (cwd && deps.meshCore) {
    const identity = deps.meshCore.getSubjectByPath(cwd);
    if (identity) return identity;
  }
  return { subject: cwd ? `relay.session.${sessionSubjectSegment(cwd)}` : EXTERNAL_MCP_SENDER };
}

/**
 * A legible, deterministic, filesystem-path-safe stand-in for a full `cwd` in
 * a Relay subject: the directory's own leaf name, plus a short hash of the
 * FULL path so two directories sharing a leaf name never collide. The hash is
 * not for secrecy — a subject is not a secret — only for distinctness.
 *
 * @param cwd - The session's working directory.
 */
function sessionSubjectSegment(cwd: string): string {
  const hash = createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 8);
  return `${path.basename(cwd)}-${hash}`;
}

/**
 * Rewrite a bare `relay.agent.<agentId>` target to that agent's real address.
 *
 * An agent inbox is `relay.agent.{namespace}.{agentId}`, and every access rule
 * is written against that shape. A two-segment subject therefore matches only
 * the blanket cross-namespace deny, so a caller that addressed a peer by id
 * alone was refused with ACCESS_DENIED no matter which rules the operator had
 * written (DOR-1337 / F5). The prose taught exactly that shape for a long time,
 * and prose is not the only source of it — an id is the obvious thing to reach
 * for. Canonicalising here means an agent that guesses is routed instead of
 * refused, without loosening a single ACL rule: the rewritten subject is the
 * agent's own registered endpoint, so the same allow rule decides the send.
 *
 * The rewrite is deliberately narrow. It fires ONLY when:
 *
 * 1. the subject parses as the three-token `legacy` shape (`relay.agent.X`), and
 * 2. `X` is an id the mesh registry currently knows.
 *
 * Everything else is returned untouched, and the second condition is what keeps
 * the other meaning of that shape working: `relay.agent.<sessionId>` is the
 * legacy session-routing address (`routes/relay.ts`, `subject-resolver.ts`), and
 * a session id is not an agent id, so it never matches and never moves.
 * Four-token subjects — canonical agent subjects and runtime-scoped session
 * subjects alike — are already addressed correctly and are never touched.
 *
 * @param deps - Tool dependencies, for the Mesh registry lookup
 * @param subject - The target subject exactly as the caller wrote it
 * @returns The agent's canonical subject when the rewrite applies, else `subject`
 */
export function canonicalizeAgentSubject(deps: McpToolDeps, subject: string): string {
  const parsed = parseAgentSubject(subject);
  if (!parsed || parsed.format !== 'legacy') return subject;

  const canonical = deps.meshCore?.getSubject(parsed.sessionId);
  if (!canonical || canonical === subject) return subject;

  logger.debug(
    `[relay-tools] canonicalized agent subject "${subject}" -> "${canonical}" ` +
      `(bare agent id addressed by the caller)`
  );
  return canonical;
}

/**
 * Decide whether the caller owns the Relay endpoint at `subject`.
 *
 * An inbox is private mail. Reading one hands over another agent's undelivered
 * messages, and reading with `ack` deletes them for good, so every inbox tool
 * gates on this predicate rather than trusting the subject in the tool call.
 *
 * A caller owns an endpoint in exactly two cases:
 *
 * 1. The subject IS the caller's own identity subject. Mesh registers each
 *    agent's endpoint (`relay.agent.{ns}.{id}`) on the agent's behalf, so that
 *    endpoint carries no recorded owner; the caller's identity is the proof.
 * 2. The caller registered the endpoint, so Relay recorded it as `owner`. This
 *    covers the ephemeral inbox `relay_send_async` hands back and any
 *    persistent inbox the agent registered with `relay_register_endpoint`.
 *
 * Two properties this must keep:
 *
 * - **An unresolvable caller owns nothing.** `resolveSenderIdentity` always
 *   returns a concrete subject, and an empty one is rejected here, so there is
 *   no path where a missing credential turns into blanket access. An endpoint
 *   with no recorded owner (the system console, cockpit-created endpoints) is
 *   owned by nobody and is therefore denied, never allowed by default.
 * - **Comparison is exact.** Both checks are `===` on the whole subject string,
 *   never a prefix test and never a wildcard match, so a different case,
 *   stray whitespace, a trailing dot, a wildcard, or a subject that merely
 *   starts with the caller's own never matches.
 *
 * The exact comparison decides who owns a *subject*. That is only the same
 * question as who owns a *mailbox* because `EndpointRegistry` refuses to
 * register two subjects that differ only by letter case: APFS and NTFS are
 * case-insensitive, so without that rule `relay.inbox.alice` and
 * `relay.inbox.ALICE` would be two subjects sharing one directory, and a check
 * that is sound on the string would still be unsound on the resource. This
 * function's guarantee rests on that registry rule, not on the string
 * comparison alone.
 *
 * @param identity - The server-resolved identity of the calling principal
 * @param subject - The endpoint subject the caller asked for
 * @param owner - The endpoint's recorded owner, or `undefined` when it has none
 * @returns `true` only when the caller may read or remove this endpoint
 */
export function ownsEndpoint(
  identity: SenderIdentity,
  subject: string,
  owner: string | undefined
): boolean {
  const caller = identity.subject;
  if (!caller) return false;
  if (subject === caller) return true;
  return owner === caller;
}

/**
 * Whether `subject` is in a namespace an agent may not register for itself.
 *
 * The namespaces themselves are defined once, in the bus
 * (`isServerManagedSubject`), so this surface and the HTTP route cannot drift
 * apart. What lives here is the part only this surface knows: a caller
 * registering its OWN address is allowed, because that is the agent asking for
 * the mailbox it already receives mail on, which grants it nothing new.
 *
 * @param subject - The subject the caller asked to register
 * @param identity - The server-resolved identity of the calling principal
 * @returns `true` when the registration must be refused
 */
export function isReservedSubject(subject: string, identity: SenderIdentity): boolean {
  if (subject === identity.subject) return false;
  return isServerManagedSubject(subject);
}

/**
 * The error response for a Relay endpoint the caller does not own.
 *
 * Says what to do next instead of only saying no: the same response covers an
 * endpoint that belongs to another agent and one that was never registered,
 * and neither case tells the caller which it was.
 *
 * @param subject - The endpoint subject that was refused
 * @param guidance - One sentence telling the caller how to reach their own
 */
export function endpointAccessDeniedContent(subject: string, guidance: string) {
  return jsonContent(
    {
      error: `You do not own the endpoint "${subject}", so you cannot use it. ${guidance}`,
      code: 'ENDPOINT_ACCESS_DENIED',
    },
    true
  );
}

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in RelayCore and ClaudeCodeAdapter.
 * Inlined here to avoid a runtime dependency on the @dorkos/relay dist output.
 */
export function inferEndpointType(
  subject: string
): 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown' {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}

/** Guard that returns an error response when Relay is disabled. */
export function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}

/**
 * Actionable guidance attached to ACCESS_DENIED publish errors.
 *
 * Cross-namespace messaging is denied by default (ADR-0033); the denial must
 * tell the agent (and through it, the user) how to open the path rather than
 * failing opaquely. Two remedies, cheapest first: the mesh-wide switch (one
 * click, opens every pair) or a single directional grant.
 */
export const ACCESS_DENIED_HINT =
  'Cross-namespace agent messaging is denied by default. Ask the user to turn on ' +
  '"Let all my agents talk to each other" in Team → Access, which opens every pair at once ' +
  '(or to allow just this namespace pair in the same view). Either can also be done with ' +
  'PUT /api/mesh/topology/access — { sourceNamespace: "*", targetNamespace: "*", ' +
  'action: "allow" } for the switch, or the two concrete namespaces for the pair. Use ' +
  'mesh_query_topology() to see current namespaces, rules, and whether the switch (openMesh) ' +
  'is on.';

/**
 * Map a relay publish failure to an MCP error response, attaching the
 * cross-namespace remediation hint on access denials.
 *
 * @param e - The thrown publish error
 * @param fallback - Message used when the error is not an Error instance
 * @param fallbackCode - Code used when the message matches no known failure
 */
export function publishErrorContent(e: unknown, fallback: string, fallbackCode: string) {
  const message = e instanceof Error ? e.message : fallback;
  const code = message.includes('Access denied')
    ? 'ACCESS_DENIED'
    : message.includes('Invalid subject')
      ? 'INVALID_SUBJECT'
      : fallbackCode;
  return jsonContent(
    { error: message, code, ...(code === 'ACCESS_DENIED' && { hint: ACCESS_DENIED_HINT }) },
    true
  );
}

/**
 * What the model may say about a send's budget.
 *
 * The same three fields every `relay_send*` tool advertises. Deliberately a
 * subset of {@link RelayBudget}: `hopCount` and `ancestorChain` are the
 * pipeline's own bookkeeping and were never writable from a tool argument.
 */
export interface DeclaredBudget {
  maxHops?: number;
  ttl?: number;
  callBudgetRemaining?: number;
}

/**
 * The budget an outbound send actually travels on.
 *
 * ## Why the model's answer is not the whole answer
 *
 * A `relay_send` that omits `budget` gets a FRESH full one from the publish
 * pipeline. That is right for a turn a person started by typing, and wrong for
 * every turn the bus itself started: A messages B, B's turn sends back to A
 * with no budget, and the hop counter that was supposed to end the exchange is
 * back at zero. The budget an agent-triggered turn should continue is a fact the
 * server already knows — which envelope that turn is answering — so it is read
 * from there rather than asked of the model, exactly as the publish `from` is
 * (see {@link resolveSenderIdentity}).
 *
 * ## What is inherited, and the one field that is not
 *
 * `hopCount`, `maxHops`, `ttl` and `callBudgetRemaining` all carry: the chain
 * keeps counting, keeps its deadline, and keeps spending down the same
 * allowance. `ancestorChain` deliberately does NOT.
 *
 * Carrying it would hand the publish gate's cycle detector a chain containing
 * the peer that just wrote, so the very first reply back would be refused as a
 * cycle and every agent-to-agent exchange would be exactly two messages long.
 * Two messages is not a conversation — the rooms ceiling learned the same
 * lesson at a cost (ADR 260823-000218: a bound "chosen to be obviously safe"
 * turned out to stop the exchanges people had asked for, and a bound that fires
 * during ordinary work teaches people to switch bounds off). What bounds the
 * chain instead is what bounds every chain: the hop ceiling, the call budget,
 * the TTL — and, above all of them, the hourly turn ceiling at the dispatch,
 * which no chain can restart its way out of.
 *
 * ## A declared budget may only shrink an inherited one
 *
 * An agent that wants a shorter leash gets it; an agent that asks for a longer
 * one gets the inherited number, because a bound the bounded party can raise is
 * not a bound. With nothing inherited the declared budget stands as written —
 * that is a fresh chain, and the pipeline's own ceilings apply to it.
 *
 * @param inherited - The budget of the envelope this turn is answering, if any.
 * @param declared - What the tool call asked for, if anything.
 * @returns The budget to publish with, or `undefined` for "pipeline default".
 */
export function resolveOutboundBudget(
  inherited: RelayBudget | undefined,
  declared: DeclaredBudget | undefined
): Partial<RelayBudget> | undefined {
  if (!inherited) return declared;
  return {
    hopCount: inherited.hopCount,
    maxHops:
      declared?.maxHops !== undefined
        ? Math.min(declared.maxHops, inherited.maxHops)
        : inherited.maxHops,
    ttl: declared?.ttl !== undefined ? Math.min(declared.ttl, inherited.ttl) : inherited.ttl,
    callBudgetRemaining:
      declared?.callBudgetRemaining !== undefined
        ? Math.min(declared.callBudgetRemaining, inherited.callBudgetRemaining)
        : inherited.callBudgetRemaining,
  };
}

/**
 * What a caller is told when the hourly turn ceiling refused their message.
 *
 * One sentence in one place because three tools say it: they differ in what
 * else they return, never in what happened.
 */
export const TURN_CEILING_ERROR =
  'Delivered to the inbox, but no turn was started: this DorkOS has run its hourly limit ' +
  'of turns for agent messaging. Nobody will answer until the hour rolls or the limit is raised.';

/**
 * Whether the turn ceiling refused this publish.
 *
 * Needed because a ceiling refusal is not a failed delivery: it refuses the
 * TURN and leaves the mailbox copy standing, so `deliveredTo` is 1 and the
 * ordinary "rejected with nothing delivered" check waves it through as a
 * success. The caller who most needs to hear "nobody is going to answer" is an
 * agent in an accidental loop — precisely the caller a `deliveredTo: 1` teaches
 * to send again.
 *
 * @param rejected - The publish result's rejection list, if it had one.
 */
export function refusedByTurnCeiling(rejected: { reason: string }[] | undefined): boolean {
  return rejected?.some((r) => r.reason === 'turn_ceiling') === true;
}
