/**
 * The single authoritative grammar for Relay `relay.agent.*` subjects.
 *
 * Historically three vocabularies shared the third token of a `relay.agent.*`
 * subject and were told apart by a fragile "is token 3 a UUID?" heuristic. This
 * module replaces that heuristic with an explicit, closed discriminator and is
 * the ONLY place the grammar is defined — every builder and parser lives here.
 *
 * ## Grammar table
 *
 * | Shape                                     | Meaning                      | Discriminator                |
 * | ----------------------------------------- | ---------------------------- | ---------------------------- |
 * | `relay.agent.{namespace}.{agentId}`       | A mesh agent endpoint        | token3 is NOT a runtime type  |
 * | `relay.agent.{runtimeType}.{sessionId}`   | A runtime-scoped session     | token3 IS a runtime type      |
 * | `relay.agent.{sessionId}`                 | Legacy session (pre-runtime) | exactly 3 tokens              |
 *
 * The discriminator is a **closed set** of runtime types, not a shape guess.
 * {@link RUNTIME_TYPES} is the default set; a caller that ROUTES on the answer
 * passes the set it actually routes to, so the subjects it claims and the
 * subjects it can parse are the same subjects (see {@link parseAgentSubject}).
 * The one way the set could still be ambiguous — a mesh namespace whose value
 * equals a runtime type (e.g. a project directory named `claude-code`) — is made
 * **impossible by construction** for the default set: {@link guardNamespaceCollision}
 * is applied wherever a namespace is derived or a subject is built, so a
 * namespace can never equal one of {@link RUNTIME_TYPES}. Parsing is therefore
 * exact.
 *
 * @module relay/lib/subjects
 */

/** The Relay subject prefix shared by every agent/session subject. */
export const AGENT_SUBJECT_PREFIX = 'relay.agent.';

/**
 * The closed set of runtime types that may appear in slot 3 of a
 * runtime-scoped session subject. This is the discriminator that tells a
 * runtime-scoped subject (`relay.agent.{runtimeType}.{sessionId}`) apart from a
 * mesh agent subject (`relay.agent.{namespace}.{agentId}`).
 *
 * Keep in sync with the server's runtime registry (`services/runtimes/`). A new
 * runtime adapter SHOULD add its type here. Routing no longer depends on it —
 * the built-in adapter parses against its own registered keys, so a type missing
 * from this list still reaches the runtime it names (DOR-1614) — but two things
 * only this list gives: {@link guardNamespaceCollision} can keep a mesh
 * namespace from colliding with the type, and every caller that reports on a
 * subject without holding a runtime map reads it correctly.
 */
export const RUNTIME_TYPES = ['claude-code', 'codex', 'opencode', 'test-mode'] as const;

/** A runtime type drawn from the closed {@link RUNTIME_TYPES} set. */
export type RuntimeType = (typeof RUNTIME_TYPES)[number];

const RUNTIME_TYPE_SET: ReadonlySet<string> = new Set(RUNTIME_TYPES);

/**
 * Suffix appended to a namespace that would otherwise collide with a runtime
 * type. Applied by {@link guardNamespaceCollision}. Chosen so the guarded value
 * (e.g. `claude-code-ns`) still normalizes cleanly and can never itself be a
 * runtime type.
 */
export const RESERVED_RUNTIME_NAMESPACE_SUFFIX = '-ns';

/**
 * Return true when `token` is one of the closed {@link RUNTIME_TYPES}.
 *
 * @param token - The subject token to test
 */
export function isRuntimeType(token: string): token is RuntimeType {
  return RUNTIME_TYPE_SET.has(token);
}

/**
 * Ensure a namespace can never collide with a runtime type.
 *
 * A namespace equal to a runtime type (e.g. `claude-code`, a plausible project
 * basename) would make `relay.agent.claude-code.{id}` ambiguous between a mesh
 * agent subject and a runtime-scoped session subject. Appending
 * {@link RESERVED_RUNTIME_NAMESPACE_SUFFIX} removes the collision deterministically.
 * This is a pure function applied at every namespace-derivation and
 * subject-build site, so the parser never has to guess.
 *
 * @param namespace - The candidate namespace (already normalized)
 * @returns The namespace, suffixed only if it equals a runtime type
 */
export function guardNamespaceCollision(namespace: string): string {
  return isRuntimeType(namespace) ? `${namespace}${RESERVED_RUNTIME_NAMESPACE_SUFFIX}` : namespace;
}

/**
 * Build a mesh agent endpoint subject: `relay.agent.{namespace}.{agentId}`.
 *
 * The namespace is passed through {@link guardNamespaceCollision} so the result
 * can never be misparsed as a runtime-scoped subject.
 *
 * @param namespace - The agent's namespace segment
 * @param agentId - The agent's ULID
 */
export function agentSubject(namespace: string, agentId: string): string {
  return `${AGENT_SUBJECT_PREFIX}${guardNamespaceCollision(namespace)}.${agentId}`;
}

/**
 * Build a runtime-scoped session subject: `relay.agent.{runtimeType}.{sessionId}`.
 *
 * @param runtimeType - The session's runtime type (must be a {@link RuntimeType})
 * @param sessionId - The session identifier
 */
export function runtimeSessionSubject(runtimeType: string, sessionId: string): string {
  return `${AGENT_SUBJECT_PREFIX}${runtimeType}.${sessionId}`;
}

/**
 * Build a legacy (pre-runtime) session subject: `relay.agent.{sessionId}`.
 *
 * Emitted only when no runtime resolver is wired (early boot, some tests). New
 * code should prefer {@link runtimeSessionSubject}.
 *
 * @param sessionId - The session identifier
 */
export function legacyAgentSubject(sessionId: string): string {
  return `${AGENT_SUBJECT_PREFIX}${sessionId}`;
}

/** The subject shape {@link parseAgentSubject} matched. */
export type AgentSubjectFormat = 'legacy' | 'runtime-scoped' | 'agent-scoped';

/** Parsed components of a `relay.agent.*` subject. */
export interface ParsedAgentSubject {
  /**
   * The trailing identifier — a sessionId for `legacy`/`runtime-scoped`
   * subjects, an agentId for `agent-scoped` (mesh) subjects. Always present.
   * Named `sessionId` for backward compatibility with the many call sites that
   * only need "the id at the end".
   */
  sessionId: string;
  /**
   * Present for `runtime-scoped` subjects: the runtime type from slot 3.
   *
   * A `string` rather than {@link RuntimeType} because the discriminator is a
   * PARAMETER (see {@link parseAgentSubject}): a caller that knows a wider set
   * of runtime types than the built-in default gets those back, and a type that
   * promised otherwise would be lying to it.
   */
  runtimeType?: string;
  /** Present for `agent-scoped` (mesh) subjects: the namespace from slot 3. */
  namespace?: string;
  /** The subject shape the parser matched. */
  format: AgentSubjectFormat;
}

/**
 * Parse a `relay.agent.*` subject into its components using a closed
 * runtime-type discriminator (no heuristics).
 *
 * Returns `null` when the subject is not a `relay.agent.*` subject or has fewer
 * than three tokens.
 *
 * - 3 tokens (`relay.agent.X`) → `legacy`, `sessionId = X`
 * - 4+ tokens, token3 ∈ `knownRuntimeTypes` → `runtime-scoped`,
 *   `runtimeType = token3`, `sessionId = token4..`
 * - 4+ tokens, token3 ∉ `knownRuntimeTypes` → `agent-scoped`,
 *   `namespace = token3`, `sessionId (=agentId) = token4..`
 *
 * ## Why the discriminator is a parameter
 *
 * The set is closed — the point of this module is that parsing never guesses —
 * but WHICH closed set is the caller's to say, because a caller that routes on
 * the answer knows the real one and {@link RUNTIME_TYPES} is only a default.
 *
 * The built-in adapter is that caller. It claims one subject prefix per runtime
 * it actually holds, and that map is open: `test-mode-b` exists today under
 * `DORKOS_TEST_RUNTIME`, and any runtime added without editing the literal list
 * would join it. While this took the literal list, such a subject was CLAIMED by
 * the adapter and then parsed as a mesh namespace, so the turn ran silently on
 * the default runtime — the wrong program answering under the right agent's
 * name, which is the exact failure DOR-1614 exists to remove. Passing the
 * adapter's own keys makes the claimed set and the parsed set the same set by
 * construction, rather than two lists someone has to remember to keep equal.
 *
 * Callers that only need the id, or that report on a subject rather than route
 * it (dead-letter notices, the MCP relay helpers), pass nothing and get the
 * built-in default — which is right for them: they have no map to be wrong
 * about, and the trailing id is identical under either reading.
 *
 * **Residual, and deliberately not closed here.**
 * {@link guardNamespaceCollision} still guards only {@link RUNTIME_TYPES}, so a
 * mesh namespace equal to an EXTRA registered runtime type (a project directory
 * literally named `test-mode-b`) is ambiguous to a caller passing the wider set.
 * The guard is not made dynamic on purpose: a namespace that changed shape
 * depending on which runtimes happened to be registered would make an agent's
 * subject unstable across boots, which `packages/mesh`'s namespace-stability
 * suite exists to prevent. A runtime that ships for real belongs in
 * {@link RUNTIME_TYPES}, and then the guard covers it too.
 *
 * @param subject - The full subject string, e.g. `relay.agent.claude-code.<uuid>`
 * @param knownRuntimeTypes - The exact set slot 3 is tested against. Defaults to
 *   {@link RUNTIME_TYPES}. Pass the set you route on.
 */
export function parseAgentSubject(
  subject: string,
  knownRuntimeTypes: ReadonlySet<string> = RUNTIME_TYPE_SET
): ParsedAgentSubject | null {
  const parts = subject.split('.');
  if (parts.length < 3 || parts[0] !== 'relay' || parts[1] !== 'agent') {
    return null;
  }

  const third = parts[2];
  if (!third) return null;

  // Three-token subjects are unambiguously legacy.
  if (parts.length === 3) {
    return { sessionId: third, format: 'legacy' };
  }

  const trailing = parts.slice(3).join('.');
  if (!trailing) return null;

  // Closed-set discriminator: slot 3 is a runtime type XOR a namespace.
  if (knownRuntimeTypes.has(third)) {
    return { sessionId: trailing, runtimeType: third, format: 'runtime-scoped' };
  }
  return { sessionId: trailing, namespace: third, format: 'agent-scoped' };
}

/**
 * Extract just the trailing identifier from a `relay.agent.*` subject.
 *
 * Thin wrapper over {@link parseAgentSubject} for the many call sites that only
 * need the sessionId/agentId. Returns `null` when the subject cannot be parsed.
 *
 * @param subject - The full subject string
 */
export function extractSessionIdFromSubject(subject: string): string | null {
  return parseAgentSubject(subject)?.sessionId ?? null;
}
