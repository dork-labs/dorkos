/**
 * The sentences and problem documents the Relay and connection routes share
 * (DOR-4979): one fixed sentence per case, never an error's own text, an id
 * or an address the caller sent. The cause goes to the log.
 *
 * @module routes/relay-problems
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { BindingConflictError } from '../services/relay/binding-store.js';

/** A connection id that names no connection. */
export const CONNECTION_NOT_FOUND = 'That connection doesn’t exist.';

/** A chat route id that names no chat route. */
export const BINDING_NOT_FOUND = 'That chat route doesn’t exist.';

/** The chat routes' store or router isn't up yet. */
export const BINDINGS_STARTING = 'Chat routes aren’t ready yet. Try again soon.';

/** An agent id the agent registry doesn't know. */
export const UNKNOWN_AGENT = 'That agent isn’t registered here.';

/** A channel needs one chat: a route for every chat can't become one. */
export const BRIDGE_NEEDS_ONE_CHAT = 'Pick one chat before turning this route into a channel.';

/** This server keeps no delivery traces. */
export const TRACING_OFF = 'Delivery tracing is off here.';

/**
 * The `409 chat_already_bound` for a chat another agent already answers
 * ("one chat, one agent", connection-scoping spec §Part 2), carrying the
 * route that holds it, so the client can offer to move it.
 *
 * @param c - The Hono context.
 * @param err - The store's refusal.
 * @returns The response.
 */
export function chatAlreadyBound(c: Context, err: BindingConflictError): Response {
  return problem(c, 'chat_already_bound', {
    detail: 'Another agent already answers that chat. Move it, or pick another chat.',
    extensions: {
      conflict: {
        bindingId: err.conflict.id,
        agentId: err.conflict.agentId,
        label: err.conflict.label,
      },
    },
  });
}
