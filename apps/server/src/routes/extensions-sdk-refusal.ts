/**
 * How a mini app's `api.forward` and `api.rooms` refusals go out on the wire:
 * as problem documents (DOR-4979).
 *
 * The SDK throws its own small vocabulary (`ForwardErrorCode`,
 * `RoomAccessErrorCode` in `@dorkos/extension-api`). Each word maps to one
 * code on the problem code list, so the app's host code can throw the SDK word
 * back (`features/extensions/model/sdk-refusal-code.ts` in the client).
 *
 * @module routes/extensions-sdk-refusal
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { logger } from '../lib/logger.js';

/** Every word `api.forward` and `api.rooms` refuse with. */
export type SdkRefusalCode =
  | 'no_agent'
  | 'room_not_allowed'
  | 'not_found'
  | 'person_required'
  | 'extension_off'
  | 'invalid_input'
  | 'unavailable';

/** The problem code each SDK word goes out as: one code per word, read back one to one. */
const WIRE: Readonly<Record<SdkRefusalCode, ProblemCode>> = {
  no_agent: 'no_agent',
  extension_off: 'not_running',
  room_not_allowed: 'forbidden',
  not_found: 'not_found',
  person_required: 'person_only',
  invalid_input: 'invalid_request',
  unavailable: 'temporarily_unavailable',
};

/**
 * The fixed sentence a refusal THROWN by the forward or room service is
 * answered with. A thrown error's own message never reaches a body, even one
 * written for people (DOR-4979 security rule): it is logged instead.
 */
const FIXED_DETAIL: Readonly<Record<SdkRefusalCode, string>> = {
  no_agent: 'Pick an agent for this mini app first.',
  room_not_allowed: 'This mini app may not use that room. Pick it in Settings.',
  not_found: 'That isn’t here any more.',
  person_required: 'Only the person can do this, in their own DorkOS window.',
  extension_off: 'Turn on this mini app in Settings first.',
  invalid_input: 'Check what was sent, then try again.',
  unavailable: 'DorkOS couldn’t do that. Try again.',
};

/**
 * Answer a refusal the forward or room service threw: its code, a fixed
 * sentence for that code, and its own message in the server log only.
 *
 * @param c - The Hono context.
 * @param err - The thrown refusal: its SDK word and its message.
 * @param extensions - Anything else the host code acts on, such as a kept comment.
 * @returns The response.
 */
export function sdkErrorRefusal(
  c: Context,
  err: { code: SdkRefusalCode; message: string },
  extensions: Record<string, unknown> = {}
): Response {
  logger.info('[Extensions] A mini app call was refused', { code: err.code, why: err.message });
  return sdkRefusal(c, err.code, FIXED_DETAIL[err.code], extensions);
}

/**
 * Answer a refusal from `api.forward` or `api.rooms`, with a sentence written
 * in the route itself.
 *
 * @param c - The Hono context.
 * @param code - The SDK's word for the refusal.
 * @param detail - The sentence to show the person.
 * @param extensions - Anything else the host code acts on, such as a kept comment.
 * @returns The response.
 */
export function sdkRefusal(
  c: Context,
  code: SdkRefusalCode,
  detail: string,
  extensions: Record<string, unknown> = {}
): Response {
  return problem(c, WIRE[code], {
    detail,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  });
}
