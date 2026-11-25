/**
 * The sentence a server wrote into a failed request, when it wrote one.
 *
 * A transport error's message is not always words meant for a person: a
 * network failure reads "Failed to fetch" or "Load failed", and a response
 * with no JSON body falls back to its status text or "HTTP 500". Only a
 * message the server wrote is passed through — the request got an answer (a
 * numeric `status`), the answer's own words about this failure are the
 * message (a problem document's `detail`, or the older body's `error`; never a
 * problem's generic `title`), and it is a sentence (status texts and bare codes
 * never end in one).
 *
 * @module shared/lib/server-sentence
 */
import { isProblem } from '@dorkos/shared/problem';

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
    writtenSentenceOf(body) === error.message &&
    /[.!?]$/.test(error.message.trim());
  return written ? error.message : null;
}

/**
 * What the server wrote about THIS failure: a problem document's `detail`, or
 * the older body's `error`. Never a problem's `title`, which is the same
 * generic line for every failure with that code, so a surface's own fallback
 * reads better than it ("DorkOS hit an error on its side." for every 500).
 */
function writtenSentenceOf(body: object): string | undefined {
  if (isProblem(body)) return body.detail;
  const said = (body as { error?: unknown }).error;
  return typeof said === 'string' ? said : undefined;
}

/**
 * Refusal codes for an action this device may not take by design: the Wi-Fi
 * level (`not_from_wifi`) and the owner-at-this-computer bar (`operator_only`).
 * Neither is a fault, so a surface shows the server's sentence calmly, never
 * as an error.
 * The SCREAMING spellings are read until the routes that still send them move
 * to problem documents (DOR-4979).
 */
const AWAY_FROM_THE_COMPUTER_CODES = new Set([
  'not_from_wifi',
  // Old spelling until the other Wi-Fi-refusing routes move (DOR-4979).
  'NOT_FROM_WIFI',
  'operator_only',
  // Old spelling until the other front-door routes move (DOR-4979).
  'NEEDS_PERSON_AT_THIS_COMPUTER',
]);

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
