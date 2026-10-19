/**
 * What the runtime connect routes (`routes/runtimes.ts`) share: the two
 * locality refusals, the scheme a request arrived on, and the SSE scaffold
 * every install and pull streams through.
 *
 * @module routes/runtimes-http
 */
import type { ServerResponse } from 'node:http';
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';

/**
 * Refuse non-local requests with 403: the refusal to return, or `undefined`
 * when the request may go on.
 *
 * The locality question itself lives in `services/core/auth/gate-policy.ts`
 * (`isAtThisComputer`), because
 * `GET /api/config` now asks it too — to TELL the app what this refusal would
 * do, so a phone over the tunnel is given honest guidance instead of a button
 * that 403s (DOR-1655). Read that module for what the answer rests on; the two
 * surfaces share it so the report can never promise what this refuses.
 *
 * @param c - The request's context.
 * @returns The 403, or `undefined` for a caller at this computer.
 */
export function refuseNonLoopback(c: Context<ApiEnv>): Response | undefined {
  if (isAtThisComputer(honoRequestFacts(c))) return undefined;
  return c.json({ error: 'Runtime connect actions are only available locally' }, 403);
}

/**
 * Refuse a change to a runtime's credential or sign-in from anyone but the
 * install's owner at this computer: the locality refusal above, then the
 * front-door bar (`refuseFrontDoorChange`, DOR-2969), which also turns away
 * an agent, an API key, and a signed-in person who is not the owner.
 *
 * @param c - The request's context.
 * @returns The 403, or `undefined` for the owner at this computer.
 */
export function refuseCredentialChange(c: Context<ApiEnv>): Response | undefined {
  const notLocal = refuseNonLoopback(c);
  if (notLocal) return notLocal;
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), "a runtime's sign-in");
  return refusal ? c.json({ error: refusal.error, code: refusal.code }, 403) : undefined;
}

/**
 * Refuse non-local requests to a HOST-MUTATING install with 403: the refusal
 * to return, or `undefined` when the request may go on.
 *
 * Separate from {@link refuseNonLoopback} only for its wording: an install
 * refusal says "provisioning", a connect refusal says "connect actions". Same
 * locality question underneath.
 *
 * @param c - The request's context.
 * @returns The 403, or `undefined` for a caller at this computer.
 */
export function refuseNonLocalProvisioning(c: Context<ApiEnv>): Response | undefined {
  if (isAtThisComputer(honoRequestFacts(c))) return undefined;
  return c.json({ error: 'Runtime provisioning is only available locally' }, 403);
}

/**
 * The scheme Express reported as `req.protocol` under `trust proxy, 1`: the
 * first `X-Forwarded-Proto` entry, trimmed, or the connection's own. With one
 * trusted hop the socket peer is always trusted, so the header always counts,
 * as it did.
 *
 * @param c - The request's context.
 * @returns `http` or `https`, or whatever scheme the header named.
 */
export function requestProtocol(c: Context<ApiEnv>): string {
  const facts = honoRequestFacts(c);
  const raw = facts.headers['x-forwarded-proto'];
  const header = (Array.isArray(raw) ? raw.join(', ') : raw) || '';
  if (!header) return facts.connectionEncrypted ? 'https' : 'http';
  const comma = header.indexOf(',');
  return (comma === -1 ? header : header.substring(0, comma)).trim();
}

/** Write one SSE frame, no-op once the response has ended. */
function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Run one long action and stream it over SSE: `progress` frames while it runs,
 * then a single terminal `result` frame carrying the outcome. Every streaming
 * endpoint in the runtimes routes shares this scaffold, so the client renders one flow
 * for all of them — its `postSseAction` (`shared/lib/transport/system-methods.ts`)
 * is the mirror image on the other side of the wire.
 *
 * The locality check deliberately stays at the call site, ABOVE this call: a
 * 403 is a JSON body, and it can only be written before the SSE headers go out.
 *
 * Every action here reports its own failures as a result rather than throwing,
 * so the catch is a defensive guard: it answers with {@link fallback} so the
 * client always gets its terminal frame instead of a stream that just stops.
 *
 * The frames are written straight to the Node response
 * (`http/raw-node-stream.ts`), so each one reaches the client as it is sent.
 *
 * @param c - The request's context; its raw response carries the SSE frames.
 * @param run - The action, handed the emitter for its `progress` frames.
 * @param fallback - The terminal result to send if the action throws anyway.
 * @param failureLabel - What to log when it does.
 * @returns The marker the handler returns once the stream has ended.
 */
export function streamSseAction<TProgress, TResult>(
  c: Context<ApiEnv>,
  run: (onProgress: (progress: TProgress) => void) => Promise<TResult>,
  fallback: TResult,
  failureLabel: string
): Promise<Response> {
  return streamToNodeResponse(c, async (res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const result = await run((progress) => sendEvent(res, 'progress', progress));
      sendEvent(res, 'result', result);
    } catch (err) {
      logger.error(failureLabel, err);
      sendEvent(res, 'result', fallback);
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}
