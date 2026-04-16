/**
 * Shared parser for `relay.agent.*` subjects.
 *
 * Callers must tolerate BOTH of the following subject shapes:
 *
 * - Legacy: `relay.agent.<sessionId>` — emitted by `BindingRouter` when no
 *   `runtimeResolver` is wired (early boot, some tests).
 * - New: `relay.agent.<runtimeType>.<sessionId>` — emitted by `BindingRouter`
 *   when the resolver successfully resolves the session's runtime type.
 *
 * Rather than coding a runtime-type allowlist (which would defeat the purpose
 * of runtime-neutral dispatch), the parser disambiguates by inspecting the
 * shape of the third subject segment: DorkOS sessionIds are UUIDs, so a
 * UUID at index 2 always indicates the legacy shape.
 *
 * @module relay/lib/subject-parser
 */

/**
 * Canonical UUID regex — matches RFC 4122 v1-v5 and the permissive "non-strict"
 * v0 / v7 variants the DorkOS session layer produces. Intentionally loose on
 * the version/variant nibble so we do not falsely reject valid sessionIds.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parsed components of a `relay.agent.*` subject. */
export interface ParsedAgentSubject {
  /** The session identifier (always present when parsing succeeds). */
  sessionId: string;
  /**
   * The runtime type segment when the subject uses the new
   * `relay.agent.<runtimeType>.<sessionId>` shape. Absent for legacy subjects.
   */
  runtimeType?: string;
  /** The subject shape the parser matched. */
  format: 'legacy' | 'runtime-scoped';
}

/** Return true when `s` looks like a UUID (tolerant of v1-v5 and non-strict variants). */
export function isUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

/**
 * Parse a `relay.agent.*` subject into its components.
 *
 * Returns `null` if the subject is not a `relay.agent.*` subject or if it has
 * fewer than three dot-separated tokens (the minimum for a legacy subject).
 *
 * Disambiguation heuristic:
 * - 3 tokens (`relay.agent.X`) → legacy, `sessionId = X`
 * - 4+ tokens and token[2] is a UUID → legacy (sessionId is at index 2;
 *   any trailing tokens are preserved on the sessionId via rejoin)
 * - 4+ tokens and token[2] is NOT a UUID → runtime-scoped, `runtimeType = token[2]`
 *   and `sessionId = token[3..].join('.')`
 *
 * @param subject - The full subject string, e.g. `'relay.agent.claude-code.<uuid>'`.
 */
export function parseAgentSubject(subject: string): ParsedAgentSubject | null {
  const parts = subject.split('.');
  if (parts.length < 3 || parts[0] !== 'relay' || parts[1] !== 'agent') {
    return null;
  }

  const third = parts[2];
  if (!third) return null;

  // Three-part subjects are unambiguously legacy.
  if (parts.length === 3) {
    return { sessionId: third, format: 'legacy' };
  }

  // A UUID at index 2 means this is legacy with a trailing suffix (rare).
  // We still treat parts[2] as the sessionId so downstream lookups work.
  if (isUuid(third)) {
    return { sessionId: third, format: 'legacy' };
  }

  // Otherwise: parts[2] is the runtime type, parts[3..] is the sessionId.
  const sessionId = parts.slice(3).join('.');
  if (!sessionId) return null;
  return { sessionId, runtimeType: third, format: 'runtime-scoped' };
}

/**
 * Extract just the sessionId from a `relay.agent.*` subject.
 *
 * Thin wrapper over {@link parseAgentSubject} for the many call sites that
 * only need the sessionId. Returns `null` when the subject cannot be parsed.
 */
export function extractSessionIdFromSubject(subject: string): string | null {
  const parsed = parseAgentSubject(subject);
  return parsed?.sessionId ?? null;
}
