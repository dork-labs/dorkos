/**
 * Turn a failed Remote Access settings write into one sentence a person can act
 * on.
 *
 * @module features/settings/lib/tunnel-errors
 */

/**
 * Login is on and this caller proved itself with something other than a browser
 * session — so DorkOS knows who it is, but not that it is a person at the
 * keyboard (`caller-authority.ts`).
 */
const OPERATOR_COOKIE_REQUIRED = 'operator_cookie_required';

/**
 * The caller named itself an agent, and `tunnel.authtoken` / `tunnel.domain` are
 * `operator-only` leaves (`config-write-policy.ts`).
 */
const OPERATOR_ONLY_CONFIG = 'operator_only_config';

/** The shape `fetchJSON` throws for a non-OK response. */
interface TransportFailure {
  code?: string;
  status?: number;
  body?: { details?: string[] };
}

/**
 * Describe a refused or failed `tunnel.*` config write.
 *
 * ## What `PATCH /api/config` actually sends, exit by exit
 *
 * The rule below is shaped around the real bodies rather than a wish about them,
 * because the obvious rule — "always prefer the server's own sentence" — turns
 * out to have nothing to prefer on two of these four exits:
 *
 * | Exit | `error` (becomes `.message`) | Where the useful text is |
 * | --- | --- | --- |
 * | Schema reject (400) | `'Validation failed'` | `body.details[]`, one entry per field |
 * | Bad body / guard (4xx) | a real sentence | `.message` |
 * | Anything thrown (500) | `'Internal server error'` | nowhere |
 * | Never reached the server | `'Failed to fetch'`, or the timeout line | nowhere |
 *
 * So the sentence is taken from a **4xx** only, where the server is describing
 * something about THIS request: `body.details[0]` first, because a 400's
 * `.message` is the constant `'Validation failed'` and the field problem is the
 * whole point, then `.message` for the 4xx exits that do write one.
 *
 * A 500 and a network throw both fall back. That is deliberate and it is the
 * narrow case where showing the server's string would be WORSE than the generic
 * line it replaced: "Internal server error" and "Failed to fetch" are jargon
 * that tell a person nothing they can act on, and the second is not even the
 * server speaking.
 *
 * ## The two refusal codes are decided before any of that
 *
 * They do NOT get the server's sentence, for a reason that is a property of this
 * route rather than a preference about wording:
 *
 * - **`PATCH /api/config` sends the SAME `error` for both.** Its 403 body pairs
 *   one shared `error` — "Only a person can change those settings" — with a
 *   per-code `message`, and `fetchJSON` builds `.message` from `error`. So the
 *   sentence that reaches here cannot tell the two refusals apart, and neither
 *   of them says what to do about it.
 * - **`operator_only_config`'s detail is addressed to a model, not a person.**
 *   `describeOperatorOnlyRefusal` writes "These settings are the person's to
 *   choose, not yours… Ask the person to change them in DorkOS Settings" — text
 *   deliberately aimed at an agent reading a tool result. Piping it into a
 *   dialog would tell somebody they are not themselves.
 *
 * Both replacements are worded for the token field and the domain field alike,
 * because one helper serves both saves.
 *
 * @param err - Whatever the transport rejected with.
 * @param fallback - What to say when nothing the failure carries was written for
 *   a person: a 500, a network-level throw, or a rejection that is not an
 *   `Error` at all.
 * @returns The sentence to show.
 */
export function describeTunnelWriteFailure(err: unknown, fallback: string): string {
  const failure = (err ?? {}) as TransportFailure;

  if (failure.code === OPERATOR_COOKIE_REQUIRED) {
    return 'Sign in to DorkOS first — only a signed-in person can change Remote Access settings.';
  }

  if (failure.code === OPERATOR_ONLY_CONFIG) {
    return 'Only you can change Remote Access settings — an agent cannot. Nothing changed.';
  }

  const status = failure.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const detail = failure.body?.details?.[0];
    if (detail) return detail;
    if (err instanceof Error && err.message) return err.message;
  }

  return fallback;
}
