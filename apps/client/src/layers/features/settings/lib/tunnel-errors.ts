/**
 * Turn a failed Remote Access settings write into one sentence a person can act
 * on.
 *
 * @module features/settings/lib/tunnel-errors
 */

/**
 * Not a person at the keyboard: the caller named itself an agent
 * (`tunnel.authtoken` / `tunnel.domain` are `operator-only` leaves,
 * `config-write-policy.ts`), or login is on and it proved itself with something
 * other than a browser session (`caller-authority.ts`).
 */
const PERSON_ONLY = 'person_only';

/** The shape `fetchJSON` throws for a non-OK response. */
interface TransportFailure {
  code?: string;
  status?: number;
}

/**
 * Describe a refused or failed `tunnel.*` config write.
 *
 * ## What `PATCH /api/config` actually sends, exit by exit
 *
 * Every refusal is a problem document, whose `detail` becomes `.message`:
 *
 * | Exit | Where the useful text is |
 * | --- | --- |
 * | Schema reject (400 `invalid_request`) | `.message`: `detail` names the first field and what was wrong (`issues` lists them all) |
 * | Bad body / guard (4xx) | `.message`, a sentence about this request |
 * | Anything thrown (500 `internal_error`) | nowhere useful to a person |
 * | Never reached the server | nowhere: `'Failed to fetch'`, or the timeout line |
 *
 * So the sentence is taken from a **4xx** only, where the server is describing
 * something about THIS request.
 *
 * A 500 and a network throw both fall back. That is deliberate: a fault says
 * nothing a person can act on, and "Failed to fetch" is not even the server
 * speaking.
 *
 * ## The not-a-person refusal is decided before any of that
 *
 * It does NOT get the server's sentence: for an agent caller that sentence is
 * addressed to a model, not a person (`describeOperatorOnlyRefusal` writes
 * "These settings are the person's to choose, not yours… Ask the person to
 * change them in DorkOS Settings"), and piping it into a dialog would tell
 * somebody they are not themselves. The replacement is worded for the token
 * field and the domain field alike, because one helper serves both saves.
 *
 * @param err - Whatever the transport rejected with.
 * @param fallback - What to say when nothing the failure carries was written for
 *   a person: a 500, a network-level throw, or a rejection that is not an
 *   `Error` at all.
 * @returns The sentence to show.
 */
export function describeTunnelWriteFailure(err: unknown, fallback: string): string {
  const failure = (err ?? {}) as TransportFailure;

  if (failure.code === PERSON_ONLY) {
    return 'Nothing changed. Only you can change Remote access, signed in to DorkOS.';
  }

  const status = failure.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (err instanceof Error && err.message) return err.message;
  }

  return fallback;
}
