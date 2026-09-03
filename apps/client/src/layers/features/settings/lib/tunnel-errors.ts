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

/**
 * Describe a refused or failed `tunnel.*` config write.
 *
 * ## The server's own sentence is the default, and that is the whole bug fix
 *
 * `PATCH /api/config` answers a bad patch with a specific 400, and `fetchJSON`
 * puts that sentence on the thrown error as `.message`. The Remote Access dialog
 * used to `catch {}` all of it and show "Could not save token. Try again."
 * instead — which is why #1458 spent 15+ attempts across several hours retrying
 * a save whose real reason was sitting in the response the whole time. So the
 * server's wording wins by default, matching `ClaudeAccountsSection`'s
 * `describeWriteFailure` for the same class of write.
 *
 * ## Why the two refusal codes are the exception
 *
 * These two do NOT get the server's sentence, and the reason is a property of
 * this route rather than a preference about wording:
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
 * Both replacements are checked against the same bar the server's own copy is,
 * and both are worded for the token field and the domain field alike, because
 * one helper serves both saves.
 *
 * @param err - Whatever the transport rejected with.
 * @param fallback - What to say when the failure carries no message at all — a
 *   network-level throw, or a transport that rejects with a non-`Error`.
 * @returns The sentence to show.
 */
export function describeTunnelWriteFailure(err: unknown, fallback: string): string {
  const code = (err as { code?: string } | null)?.code;

  if (code === OPERATOR_COOKIE_REQUIRED) {
    return 'Sign in to DorkOS first — only a signed-in person can change Remote Access settings.';
  }

  if (code === OPERATOR_ONLY_CONFIG) {
    return 'Only you can change Remote Access settings — an agent cannot. Nothing changed.';
  }

  return (err instanceof Error && err.message) || fallback;
}
