/**
 * What every room route on the Hono chain shares: who is asking, and how a
 * refusal is worded.
 *
 * {@link roomRoute} runs a handler with a lazily resolved caller and turns
 * anything it throws into the room refusal `routes/room-error-response.ts`
 * words. The caller is resolved at most once per request, by the handler and
 * at the moment it asks, so a route keeps its own order between "who is
 * this" and everything else (several parse their body first, some resolve the
 * caller before a query). Whether the refusal is worded for the install's
 * owner depends on whether a caller had been resolved when it was thrown,
 * which the route holds itself (DOR-2457).
 *
 * @module routes/room-route
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { validationFailureBody } from '../lib/route-utils.js';
import type { AuthorRecord } from '../services/rooms/index.js';
import { callerAccessOf } from './caller-access.js';
import { resolveCaller } from './room-caller.js';
import { isOwnerCaller, roomErrorReply } from './room-error-response.js';

/** The caller of one room request, resolved the first time it is asked for. */
export type RoomCaller = () => AuthorRecord;

/**
 * Answer a room refusal for a caller that may or may not have been resolved.
 *
 * @param c - The Hono context.
 * @param err - What was thrown.
 * @param context - Route label for the log line.
 * @param caller - The caller resolved before the throw, if any.
 * @returns The refusal.
 */
export function roomErrorResponse(
  c: Context,
  err: unknown,
  context: string,
  caller: AuthorRecord | undefined
): Response {
  const reply = roomErrorReply(err, context, () => isOwnerCaller(caller));
  return c.json(reply.body, reply.status as ContentfulStatusCode);
}

/**
 * Who a room request is: `resolveCaller` over the request's facts. For a route
 * that answers its own refusals; every other route asks {@link roomRoute}.
 *
 * @param c - The Hono context.
 * @returns The caller.
 * @throws {RoomError} `AGENT_IDENTITY_UNVERIFIED`, as `resolveCaller` does.
 */
export function resolveRoomCaller(c: Context<ApiEnv>): AuthorRecord {
  return resolveCaller(honoRequestFacts(c), callerAccessOf(c.req.method));
}

/**
 * Run one room handler, answering anything it throws as a room refusal.
 *
 * @param c - The Hono context.
 * @param context - Route label for the log line, e.g. `'GET /:id'`.
 * @param run - The handler. It resolves the caller by calling `caller()`.
 * @returns The handler's answer, or the refusal.
 */
export async function roomRoute(
  c: Context<ApiEnv>,
  context: string,
  run: (caller: RoomCaller) => Response | Promise<Response>
): Promise<Response> {
  let resolved: AuthorRecord | undefined;
  const caller: RoomCaller = () => (resolved ??= resolveRoomCaller(c));
  try {
    return await run(caller);
  } catch (err) {
    return roomErrorResponse(c, err, context, resolved);
  }
}

/**
 * Validate a body or query the way `parseBody` did on Express: the parsed
 * data, or the 400 to answer.
 *
 * @param c - The Hono context.
 * @param schema - The schema.
 * @param data - What to validate.
 * @returns The data, or the refusal.
 */
export function parseOrRefuse<T>(c: Context, schema: ZodType<T>, data: unknown): T | Response {
  const result = schema.safeParse(data);
  if (!result.success) return c.json(validationFailureBody(result.error), 400);
  return result.data;
}
