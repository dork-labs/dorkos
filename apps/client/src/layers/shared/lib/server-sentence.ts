/**
 * The sentence a server wrote into a failed request, when it wrote one.
 *
 * A transport error's message is not always words meant for a person: a
 * network failure reads "Failed to fetch" or "Load failed", and a response
 * with no JSON body falls back to its status text or "HTTP 500". Only a
 * message the server wrote is passed through — the request got an answer (a
 * numeric `status`), the answer's own JSON `error` field is the message, and
 * it is a sentence (status texts and bare codes never end in one).
 *
 * @module shared/lib/server-sentence
 */

/**
 * The server's own sentence for a failed request, or `null`.
 *
 * @param error - What the transport rejected with.
 */
export function serverSentence(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const { status, body } = error as Error & { status?: unknown; body?: unknown };
  const written =
    typeof status === 'number' &&
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === error.message &&
    /[.!?]$/.test(error.message.trim());
  return written ? error.message : null;
}

/**
 * Refusal codes for an action this device may not take by design: the Wi-Fi
 * level (`NOT_FROM_WIFI`) and the owner-at-this-computer bar. Neither is a
 * fault, so a surface shows the server's sentence calmly, never as an error.
 */
const AWAY_FROM_THE_COMPUTER_CODES = new Set(['NOT_FROM_WIFI', 'NEEDS_PERSON_AT_THIS_COMPUTER']);

/**
 * The server's sentence for an action refused because of where this device
 * is, or `null` for any other failure.
 *
 * @param error - What the transport rejected with.
 */
export function awayFromTheComputerSentence(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== 'string' || !AWAY_FROM_THE_COMPUTER_CODES.has(code)) return null;
  const message = error.message.trim();
  return /[.!?]$/.test(message) ? message : null;
}
