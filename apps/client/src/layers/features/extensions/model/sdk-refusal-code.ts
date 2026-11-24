/**
 * Read a refusal from `api.forward` or `api.rooms` back into the SDK's own
 * word for it (`ForwardErrorCode`, `RoomAccessErrorCode`).
 *
 * The server answers with a problem document (DOR-4979) whose code maps one to
 * one onto an SDK word. The server's side of this mapping is
 * `routes/extensions-sdk-refusal.ts`.
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

/** The SDK word for each problem code. */
const FROM_CODE: Readonly<Record<string, SdkRefusalCode>> = {
  no_agent: 'no_agent',
  not_running: 'extension_off',
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
 * @returns The word to throw with.
 */
export function sdkRefusalCode(status: number, code: string | undefined): SdkRefusalCode {
  if (code !== undefined && Object.hasOwn(FROM_CODE, code)) return FROM_CODE[code]!;
  if (status === 404) return 'not_found';
  if (status === 403) return 'person_required';
  return 'unavailable';
}
