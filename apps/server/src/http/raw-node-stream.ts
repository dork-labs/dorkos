/**
 * Writing a response straight to the Node socket, for a route on the Hono
 * chain that streams: an event stream it writes as it goes, rather than one
 * body Hono sends when the handler returns.
 *
 * A Hono `Response` with a streamed body works too, but it goes through the
 * Node adapter's own reader, and the code that writes these streams today
 * (`res.writeHead`, `res.write`, `res.end`, `res.on('close')`) is written
 * against the Node response. {@link streamToNodeResponse} hands the route that
 * response, so the writer moves over unchanged, and answers Hono with the
 * marker that tells the adapter the response is already being sent.
 *
 * What the route can rely on:
 *
 * - **The chain's headers are already on it.** CORS and `nosniff` are copied
 *   onto the raw response before any route runs
 *   (`carryHeadersToNodeResponse` in `http/api-chain.ts`), and `writeHead`
 *   keeps what was set, so a credentialed cross-origin `EventSource` is
 *   answered as Express answered it.
 * - **Nothing is buffered.** Each `write` goes to the socket as Node sends
 *   it; there is no compression and no Hono body in between.
 * - **A client that leaves aborts {@link RawNodeStreamControl.signal}**, so
 *   the writer can stop work nobody will read. The listener is removed when
 *   the writer finishes, so nothing outlives the request.
 * - **Signing out closes it.** A stream opened with a person's session cookie
 *   is registered under that sign-in while it runs, and ending the sign-in
 *   destroys the response (`services/core/auth/sessions/live-connections.ts`,
 *   DOR-2969). The client sees the stream drop, reconnects, and is refused.
 * - **A thrown error is the chain's.** Before anything was written, the chain
 *   answers it as JSON (`onError`); after, it closes the connection, as
 *   Express does.
 *
 * @module http/raw-node-stream
 */
import type { ServerResponse } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context, Env } from 'hono';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import {
  registerLiveConnection,
  type LiveConnectionKind,
} from '../services/core/auth/sessions/live-connections.js';

/** What a writer is handed beside the response. */
export interface RawNodeStreamControl {
  /** Aborted when the response closes before the writer finished: the client left. */
  readonly signal: AbortSignal;
}

/** The Hono environment {@link streamToNodeResponse} writes to: the raw Node pair. */
type RawNodeStreamEnv = { Bindings: HttpBindings };

/**
 * Hand the raw Node response to `write`, and answer Hono once it is done.
 *
 * `write` owns the response: it writes the head, the body and the end. The
 * returned promise settles when `write` does, so the handler lasts as long as
 * the stream (the audit scope and the request log see the whole of it).
 *
 * @param c - The Hono context.
 * @param write - Writes the response. Resolve once it has ended the response,
 *   or once {@link RawNodeStreamControl.signal} says nobody is reading.
 * @returns The marker to return from the handler.
 */
export async function streamToNodeResponse<E extends RawNodeStreamEnv>(
  c: Context<E>,
  write: (res: ServerResponse, control: RawNodeStreamControl) => Promise<void> | void
): Promise<Response> {
  const { outgoing } = c.env;
  const controller = new AbortController();
  const onClose = (): void => {
    // A response that ended closes too; only an early close is a departure.
    if (!outgoing.writableFinished) controller.abort();
  };
  outgoing.once('close', onClose);
  // Gone before the route got here: nothing will close again to say so.
  if (outgoing.destroyed) controller.abort();
  const unregister = registerWithSignIn(c, () => outgoing.destroy());
  try {
    await write(outgoing, { signal: controller.signal });
  } finally {
    outgoing.off('close', onClose);
    unregister();
  }
  // A fresh marker each time: the shared one has mutable headers, and a chain
  // step that sets one after the route would write it into every later answer.
  return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
}

/**
 * Register a long-lived response with the sign-in that opened it, when a
 * cookie session did: the gate set `user` with a session id. Anything else
 * (an API key, a gate that asked for nothing) names no sign-in to end.
 *
 * @param c - The Hono context, read for the gate's `user`.
 * @param close - Ends it.
 * @param kind - What it is (`live-connections.ts`); a stream by default.
 * @returns Unregister.
 */
export function registerWithSignIn<E extends Env>(
  c: Context<E>,
  close: () => void,
  kind: LiveConnectionKind = 'stream'
): () => void {
  const user = (c.var as { user?: RequestUser }).user;
  if (user?.credential !== 'cookie' || !user.sessionId) return () => {};
  return registerLiveConnection(user.sessionId, user.userId, close, kind);
}

/**
 * Close a response the route hands back as a `Response` (a streamed MCP or
 * A2A answer) when the sign-in that asked for it ends, for as long as the
 * Node response is open.
 *
 * @param c - The Hono context: the gate's `user` and the raw Node response.
 */
export function closeResponseWithSignIn<E extends RawNodeStreamEnv>(c: Context<E>): void {
  const { outgoing } = c.env;
  const unregister = registerWithSignIn(c, () => outgoing.destroy());
  outgoing.once('close', unregister);
}
