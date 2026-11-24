/**
 * Read a refusal from `api.forward` or `api.rooms` back into the SDK's own
 * word for it (`ForwardErrorCode`, `RoomAccessErrorCode`).
 *
 * The server answers with a problem document (DOR-4979): a code on the
 * problem code list, and a `reason` for the three words that list has no
 * code for (`no_agent`, `extension_off`, `room_not_allowed`). The server's
 * side of this mapping is `routes/extensions-sdk-refusal.ts`.
 *
 * @module features/extensions/model/sdk-refusal-code
 */

/** Every word `api.forward` and `api.rooms` throw. */
type SdkRefusalCode =
  | 'no_agent'
  | 'room_not_allowed'
  | 'not_found'
  | 'person_required'
  | 'extension_off'
  | 'invalid_input'
  | 'unavailable';

/** The SDK words a problem's `reason` may name. */
const REASONS: ReadonlySet<string> = new Set(['no_agent', 'extension_off', 'room_not_allowed']);

/** The SDK word for each problem code. */
const FROM_CODE: Readonly<Record<string, SdkRefusalCode>> = {
  not_found: 'not_found',
  person_only: 'person_required',
  person_session_required: 'person_required',
  invalid_request: 'invalid_input',
  temporarily_unavailable: 'unavailable',
};

/**
 * The SDK word for a refused response.
 *
 * @param status - The response's HTTP status.
 * @param code - The problem's code, when it had one.
 * @param body - The parsed body, read for its `reason`.
 * @returns The word to throw with.
 */
export function sdkRefusalCode(
  status: number,
  code: string | undefined,
  body: unknown
): SdkRefusalCode {
  const reason = (body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === 'string' && REASONS.has(reason)) return reason as SdkRefusalCode;
  if (code !== undefined && Object.hasOwn(FROM_CODE, code)) return FROM_CODE[code]!;
  if (status === 404) return 'not_found';
  if (status === 403) return 'person_required';
  return 'unavailable';
}
