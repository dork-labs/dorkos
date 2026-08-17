import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  InboxStatusFilterSchema,
  type InboxStatusFilter,
  type RelayProgressPayload,
} from '@dorkos/shared/relay-schemas';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import {
  inferEndpointType,
  requireRelay,
  publishErrorContent,
  ownsEndpoint,
  isReservedSubject,
  endpointAccessDeniedContent,
  type SenderIdentity,
} from './relay-helpers.js';
import { createRelayNotifyUserHandler } from './relay-notify-tools.js';

/**
 * Send a message via Relay.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-injected sender identity (never read from tool args)
 */
export function createRelaySendHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: {
    subject: string;
    payload: unknown;
    replyTo?: string;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = await deps.relayCore!.publish(args.subject, args.payload, {
        from: identity.subject,
        replyTo: args.replyTo,
        budget: args.budget,
      });
      // Rejected with no delivery (e.g. rate-limited) means the message was
      // dropped — report an error, never a success.
      if (result.deliveredTo === 0 && result.rejected && result.rejected.length > 0) {
        const reason = result.rejected[0]?.reason ?? 'unknown';
        return jsonContent(
          { error: `Message rejected: ${reason}`, code: 'REJECTED', rejected: result.rejected },
          true
        );
      }
      return jsonContent({
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
        queued: result.deliveredTo === 0,
        ...(result.rejected && result.rejected.length > 0 && { rejected: result.rejected }),
      });
    } catch (e) {
      return publishErrorContent(e, 'Publish failed', 'PUBLISH_FAILED');
    }
  };
}

/**
 * Read inbox messages (with payloads) for a Relay endpoint.
 *
 * The caller may only read an inbox it owns (see {@link ownsEndpoint}). The
 * `endpoint_subject` argument comes from the model, so without this gate any
 * agent could name another agent's subject and drain its mail — and with
 * `ack: true`, destroy it (DOR-506).
 *
 * Defaults `status` to `'pending'` when omitted — mirrors the HTTP inbox
 * route's contract (DOR-337/DOR-406) so budget-rejected `failed` messages
 * never surface silently next to real deliverables. Pass `status: 'all'`
 * to opt back into the unfiltered view.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved identity of the calling principal; the
 *   ownership check keys on it and it is never read from tool args
 */
export function createRelayInboxHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: {
    endpoint_subject: string;
    limit?: number;
    status?: InboxStatusFilter;
    ack?: boolean;
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    try {
      // Inside the try because getEndpoint asserts the core is open: a shutdown
      // race must return a structured error, not reject the handler.
      const endpoint = deps.relayCore!.getEndpoint(args.endpoint_subject);
      // No endpoint means nothing to disclose: the readInbox below performs the
      // same lookup and throws ENDPOINT_NOT_FOUND, which is the honest answer
      // and keeps idempotent cleanup loops working across a restart.
      if (endpoint && !ownsEndpoint(identity, endpoint.subject, endpoint.owner)) {
        return endpointAccessDeniedContent(
          args.endpoint_subject,
          'Read your own subject, the inbox subject relay_send_async gave you, or an inbox you registered yourself with relay_register_endpoint.'
        );
      }

      const result = await deps.relayCore!.readInbox(args.endpoint_subject, {
        limit: args.limit,
        status: args.status ?? 'pending',
        ack: args.ack,
      });
      return jsonContent({ messages: result.messages, nextCursor: result.nextCursor });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Inbox read failed';
      const code = message.includes('Endpoint not found')
        ? 'ENDPOINT_NOT_FOUND'
        : 'INBOX_READ_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

/** List all registered Relay endpoints. */
export function createRelayListEndpointsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireRelay(deps);
    if (err) return err;
    const relay = deps.relayCore!;
    const endpoints = relay.listEndpoints();
    const dispatchTtlMs = relay.getDispatchInboxTtlMs();
    const typed = endpoints.map((ep) => {
      const type = inferEndpointType(ep.subject);
      const expiresAt =
        type === 'dispatch'
          ? new Date(new Date(ep.registeredAt).getTime() + dispatchTtlMs).toISOString()
          : null;
      // `owner` is deliberately dropped. Agents need it for nothing, and naming
      // every mailbox's owner in one unrestricted call is the reconnaissance
      // step for impersonating one. The cockpit's HTTP route still returns it.
      const { owner: _owner, ...rest } = ep;
      return { ...rest, type, expiresAt };
    });
    return jsonContent({ endpoints: typed, count: typed.length });
  };
}

/**
 * Register a new Relay endpoint, owned by the caller.
 *
 * Recording the owner is what later lets the caller (and only the caller) read
 * this inbox. Registering a subject that already exists throws, so an endpoint's
 * owner can never be taken over by a second registration.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved identity of the calling principal, stored
 *   as the new endpoint's owner
 */
export function createRelayRegisterEndpointHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: { subject: string; description?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;

    if (isReservedSubject(args.subject, identity)) {
      return jsonContent(
        {
          error:
            `"${args.subject}" is in a namespace the server manages, so it cannot be registered ` +
            'by an agent. Register your own inbox under relay.inbox.* instead.',
          code: 'RESERVED_SUBJECT',
        },
        true
      );
    }

    try {
      const info = await deps.relayCore!.registerEndpoint(args.subject, {
        owner: identity.subject,
      });
      return jsonContent({ endpoint: info, note: args.description ?? 'Endpoint registered' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      const code = message.includes('Invalid subject')
        ? 'INVALID_SUBJECT'
        : message.includes('belongs to another owner') || message.includes('collides with')
          ? 'ENDPOINT_ACCESS_DENIED'
          : 'REGISTRATION_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

/**
 * Send a message to an agent and wait synchronously for the reply.
 *
 * Internally registers an ephemeral inbox, subscribes to it BEFORE
 * publishing (so progress events emitted while the target agent's turn runs
 * are never lost), then publishes the message with that inbox as `replyTo`
 * and awaits the final reply. Resolves as soon as CCA publishes the
 * aggregated agent response — no polling required.
 *
 * Cleans up the subscription and ephemeral endpoint on success, timeout,
 * or error.
 */
export function createRelayQueryHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    timeout_ms?: number;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    const relay = deps.relayCore!;
    const inboxSubject = `relay.inbox.query.${randomUUID()}`;
    let unsub: (() => void) | undefined;

    try {
      // Owned by the caller so nothing else can drain the reply it is waiting on.
      await relay.registerEndpoint(inboxSubject, { owner: identity.subject });

      const progressEvents: RelayProgressPayload[] = [];

      // Subscribe BEFORE publishing. The target agent starts streaming
      // progress to the reply inbox as soon as delivery is accepted; a
      // subscription registered after publish would miss those events.
      let settleReply: (reply: { payload: unknown; from: string; id: string }) => void = () => {};
      const replyPromise = new Promise<{ payload: unknown; from: string; id: string }>(
        (resolve) => {
          settleReply = resolve;
        }
      );

      unsub = relay.subscribe(inboxSubject, (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;

        // Accumulate progress events (type:progress, done:false) without resolving
        if (payload?.type === 'progress' && payload?.done === false) {
          progressEvents.push(payload as RelayProgressPayload);
          return;
        }

        // Any final message: an error StreamEvent (crashed/aborted turn),
        // agent_result with done:true, or a plain payload for non-CCA compat.
        settleReply({ payload, from: envelope.from, id: envelope.id });
      });

      let sentMessageId: string;
      try {
        const result = await relay.publish(args.to_subject, args.payload, {
          from: identity.subject,
          replyTo: inboxSubject,
          budget: args.budget,
        });
        // If the message was rejected before reaching any recipient (e.g. rate-limit),
        // return immediately rather than waiting the full timeout.
        if (result.deliveredTo === 0 && result.rejected && result.rejected.length > 0) {
          const reason = result.rejected[0]?.reason ?? 'unknown';
          return jsonContent(
            { error: `Message rejected: ${reason}`, code: 'REJECTED', reason },
            true
          );
        }
        sentMessageId = result.messageId;
      } catch (e) {
        return publishErrorContent(e, 'Publish failed', 'PUBLISH_FAILED');
      }

      const timeoutMs = args.timeout_ms ?? 60_000;

      const reply = await new Promise<{ payload: unknown; from: string; id: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `relay_send_and_wait timed out after ${timeoutMs}ms (sent ${sentMessageId})`
              )
            );
          }, timeoutMs);

          void replyPromise.then((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        }
      );

      // A terminal error StreamEvent means the target agent's turn crashed or
      // was aborted — return an error result, never a success-shaped reply
      // that would pass partial output off as a completed answer.
      const replyPayload = reply.payload as Record<string, unknown> | null;
      if (replyPayload?.type === 'error') {
        const errData = replyPayload.data as { message?: string } | undefined;
        return jsonContent(
          {
            error: `Agent turn failed: ${errData?.message ?? 'unknown error'}`,
            code: 'AGENT_ERROR',
            from: reply.from,
            progress: progressEvents,
            sentMessageId,
          },
          true
        );
      }

      return jsonContent({
        reply: reply.payload,
        progress: progressEvents,
        from: reply.from,
        replyMessageId: reply.id,
        sentMessageId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Query failed';
      const code = message.includes('timed out')
        ? 'TIMEOUT'
        : message.includes('Access denied')
          ? 'ACCESS_DENIED'
          : message.includes('Invalid subject')
            ? 'INVALID_SUBJECT'
            : 'QUERY_FAILED';
      return jsonContent({ error: message, code }, true);
    } finally {
      // Best-effort cleanup — watcher and disk dirs are freed by unregisterEndpoint
      unsub?.();
      await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
    }
  };
}

/**
 * Dispatch a message to an agent asynchronously.
 *
 * Unlike relay_send_and_wait, relay_send_async returns immediately with a dispatch inbox
 * subject. Agent A can then poll relay_inbox() for progress events and the
 * final agent_result. Call relay_unregister_endpoint() to clean up when done.
 *
 * Early rejection (deliveredTo=0 && rejected.length>0): auto-unregisters inbox,
 * returns { error, code: 'REJECTED', rejected }.
 */
export function createRelayDispatchHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    const relay = deps.relayCore!;
    const inboxSubject = `relay.inbox.dispatch.${randomUUID()}`;

    try {
      // Owned by the caller: only this agent may poll the dispatch inbox, and
      // only this agent may ack (and so delete) what lands in it.
      await relay.registerEndpoint(inboxSubject, { owner: identity.subject });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      return jsonContent({ error: message, code: 'REGISTRATION_FAILED' }, true);
    }

    try {
      const result = await relay.publish(args.to_subject, args.payload, {
        from: identity.subject,
        replyTo: inboxSubject,
        budget: args.budget,
      });

      // Early rejection: auto-unregister the inbox to prevent leaks
      if (result.deliveredTo === 0 && result.rejected && result.rejected.length > 0) {
        const reason = result.rejected[0]?.reason ?? 'unknown';
        await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
        return jsonContent(
          { error: `Message rejected: ${reason}`, code: 'REJECTED', rejected: result.rejected },
          true
        );
      }

      return jsonContent({
        messageId: result.messageId,
        inboxSubject,
        note: `Poll relay_inbox(endpoint_subject="${inboxSubject}", ack=true) for progress (defaults to pending/unread messages). Call relay_unregister_endpoint("${inboxSubject}") when a payload with done:true is received.`,
      });
    } catch (e) {
      // Clean up inbox on publish error
      await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
      return publishErrorContent(e, 'Dispatch failed', 'DISPATCH_FAILED');
    }
  };
}

/**
 * Unregister a named Relay endpoint the caller owns.
 *
 * Gated by the same ownership rule as the inbox read, and for a stronger
 * reason: unregistering deletes the endpoint's whole Maildir tree, so an
 * ungated call would let one agent throw away every message another agent has
 * waiting (DOR-506).
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved identity of the calling principal
 */
export function createRelayUnregisterEndpointHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: { subject: string }) => {
    const err = requireRelay(deps);
    if (err) return err;

    try {
      // Inside the try because getEndpoint asserts the core is open (see the
      // inbox handler). No endpoint means there is no mailbox to delete, so the
      // unregisterEndpoint below reports ENDPOINT_NOT_FOUND and a cleanup retry
      // after a restart still terminates.
      const endpoint = deps.relayCore!.getEndpoint(args.subject);
      if (endpoint && !ownsEndpoint(identity, endpoint.subject, endpoint.owner)) {
        return endpointAccessDeniedContent(
          args.subject,
          'Only the agent that registered an endpoint can remove it. Clean up the inbox subjects relay_send_async gave you instead.'
        );
      }

      const removed = await deps.relayCore!.unregisterEndpoint(args.subject);
      if (!removed) {
        return jsonContent(
          { error: `Endpoint not found: ${args.subject}`, code: 'ENDPOINT_NOT_FOUND' },
          true
        );
      }
      return jsonContent({ success: true, subject: args.subject });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unregistration failed';
      return jsonContent({ error: message, code: 'UNREGISTER_FAILED' }, true);
    }
  };
}

/**
 * The relay tool definitions: name, description, input schema, and handler
 * (8 tools, including `relay_notify_user`).
 *
 * The single source for all of that on BOTH MCP servers. The external `/mcp`
 * server projects the other 7 (the subject-facing send/inbox/endpoint tools)
 * through `registerFromDefinitions` rather than typing them out again, which is
 * what stops the two surfaces describing them differently (DOR-499).
 * `relay_notify_user` has no entry in the external config, which is what keeps
 * it in-session-only. Unguarded, so it needs no separate definitions function.
 *
 * Because one description now reaches both servers, WORD CHOICE HERE HAS TO BE
 * TRUE ON BOTH. Say "caller", not "agent": an in-session caller is always an
 * agent, but the external `/mcp` surface has no per-session identity and acts as
 * one server-controlled external principal that may not be an agent at all (see
 * `resolveSenderIdentity(deps, undefined)` in `core/mcp-server.ts`). The two
 * files briefly disagreed on exactly that word before they shared a source.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved sender identity. Injected as the publish
 *   `from` for every send tool, so the LLM cannot assert (spoof) its own
 *   identity to bypass namespace access rules, and as the principal the
 *   endpoint tools check ownership against (see {@link ownsEndpoint}).
 */
export function getRelayTools(deps: McpToolDeps, identity: SenderIdentity) {
  return [
    tool(
      'relay_send',
      'Send a message to a Relay subject. Delivers to all endpoints matching the subject pattern. ' +
        'Your sender identity is set automatically by the server — there is no "from" parameter. ' +
        'Returns { messageId, deliveredTo, queued }. queued:true means no live consumer matched — ' +
        'the message was buffered for a late subscriber or dead-lettered, not delivered. ' +
        'Rejected sends (e.g. rate-limited) return an error with code REJECTED; they are NOT queued.',
      {
        subject: z.string().describe('Target subject (e.g., "relay.agent.backend")'),
        payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
        replyTo: z.string().optional().describe('Subject to send replies to'),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional().describe('Max hop count'),
            ttl: z.number().int().optional().describe('Unix timestamp (ms) expiry'),
            callBudgetRemaining: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe('Remaining call budget'),
          })
          .optional()
          .describe('Optional budget constraints'),
      },
      createRelaySendHandler(deps, identity)
    ),
    tool(
      'relay_inbox',
      'Read inbox messages for a Relay endpoint you own: your own agent subject, an inbox subject ' +
        'relay_send_async returned, or one you registered with relay_register_endpoint. Naming another ' +
        "agent's endpoint fails with code ENDPOINT_ACCESS_DENIED. Each message includes the sender payload: " +
        '{ id, subject, status, createdAt, sender, payload }. For agent dispatch inboxes the payload is ' +
        'a progress event { type: "progress", step, step_type, text, done: false } or the final ' +
        '{ type: "agent_result", text, done: true }. Defaults to status="pending" (deliverable, unread ' +
        'messages) so budget-rejected failures never surface silently next to real deliverables. Pass ' +
        'ack=true when polling so each message is returned once — note that ack PERMANENTLY DELETES the ' +
        'message content, so read what you need out of the response before your next call.',
      {
        endpoint_subject: z
          .string()
          .describe('Subject of the endpoint to read inbox for. Must be an endpoint you own.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages to return'),
        status: InboxStatusFilterSchema.optional().describe(
          'Filter messages by status. Defaults to "pending" (deliverable, unread messages). Pass ' +
            '"failed" to see budget-rejected/dead-lettered messages, "delivered" for already-read ones ' +
            '(metadata only — the payload is removed once a message completes), or "all" for every status.'
        ),
        ack: z
          .boolean()
          .optional()
          .describe(
            'Acknowledge returned unread messages. This DESTROYS them: the message content is deleted ' +
              'from disk and cannot be recovered, and only the record (id, sender, timestamps) remains, ' +
              'with payload null on later reads. Set true when polling a dispatch inbox so each message ' +
              'is returned exactly once; leave it off to peek without destroying anything.'
          ),
      },
      createRelayInboxHandler(deps, identity)
    ),
    tool(
      'relay_list_endpoints',
      'List all registered Relay endpoints. Each endpoint includes subject, hash, maildirPath, ' +
        "registeredAt, type ('dispatch'|'query'|'persistent'|'agent'|'unknown'), and expiresAt " +
        '(ISO timestamp for dispatch endpoints indicating 30-min TTL expiry; null for others).',
      {},
      createRelayListEndpointsHandler(deps)
    ),
    tool(
      'relay_register_endpoint',
      'Register a new Relay endpoint to receive messages on a subject. The endpoint belongs to you, ' +
        'so you are the only caller that can read or unregister it, and it keeps belonging to you ' +
        'across server restarts. Use the relay.inbox.* namespace: relay.agent.*, relay.system.* and ' +
        'relay.human.* are managed by the server and fail with code RESERVED_SUBJECT. A subject that ' +
        'differs from an existing endpoint only by letter case is refused, because the two would ' +
        'share one mailbox on macOS and Windows.',
      {
        subject: z.string().describe('Subject for the new endpoint (e.g., "relay.inbox.mybot")'),
        description: z.string().optional().describe('Human-readable description of the endpoint'),
      },
      createRelayRegisterEndpointHandler(deps, identity)
    ),
    tool(
      'relay_send_and_wait',
      'Send a message to an agent and WAIT for the reply in a single call. Preferred over relay_send + relay_inbox polling for request/reply patterns. Internally registers an ephemeral inbox, sends the message with replyTo set, and blocks until the target agent replies or the timeout elapses. ' +
        'Response shape: { reply, progress, from, replyMessageId, sentMessageId }. ' +
        'progress: array of intermediate steps emitted before the final reply (empty [] for quick replies; populated for multi-step CCA tasks). ' +
        'Each progress step: { type: "progress", step: number, step_type: "message"|"tool_result", text: string, done: false }. ' +
        'Callers that only use { reply, from, replyMessageId } are unaffected — progress is additive.',
      {
        to_subject: z
          .string()
          .describe('Target subject for the message (e.g., "relay.agent.{agentId}")'),
        payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(600000)
          .optional()
          .describe(
            'Max milliseconds to wait for a reply (default: 60000, max: 600000). For tasks longer than 10 min, use relay_send_async instead.'
          ),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional().describe('Max hop count'),
            ttl: z.number().int().optional().describe('Unix timestamp (ms) expiry'),
            callBudgetRemaining: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe('Remaining call budget'),
          })
          .optional()
          .describe('Optional budget constraints'),
      },
      createRelayQueryHandler(deps, identity)
    ),
    tool(
      'relay_send_async',
      'Dispatch a message to an agent and return IMMEDIATELY with a dispatch inbox subject. ' +
        'Unlike relay_send_and_wait (which blocks), relay_send_async returns { messageId, inboxSubject } at once. ' +
        'Agent B runs asynchronously; CCA publishes incremental progress events and a final agent_result ' +
        'to the inbox. Poll relay_inbox(endpoint_subject=inboxSubject, ack=true) for updates (defaults ' +
        'to pending/unread messages). When you receive a payload with done:true, call ' +
        'relay_unregister_endpoint(inboxSubject) to clean up.',
      {
        to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
        payload: z.unknown().describe('Message payload'),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional(),
            ttl: z.number().int().optional(),
            callBudgetRemaining: z.number().int().min(0).optional(),
          })
          .optional(),
      },
      createRelayDispatchHandler(deps, identity)
    ),
    tool(
      'relay_unregister_endpoint',
      'Unregister a Relay endpoint you own, deleting its mailbox and every message still in it. Use to ' +
        'clean up dispatch inboxes after relay_send_async completes (when done:true received). ' +
        "Another caller's endpoint fails with code ENDPOINT_ACCESS_DENIED.",
      {
        subject: z.string().describe('Subject of the endpoint to unregister. Must be one you own.'),
      },
      createRelayUnregisterEndpointHandler(deps, identity)
    ),
    tool(
      'relay_notify_user',
      'Send a message to the user on a bound external channel (Telegram, Slack, etc.). ' +
        'Automatically resolves the best active chat. If channel is omitted, sends to the ' +
        'most recently active chat across all bound adapters, and — when no external chat ' +
        'is connected at all — to your direct message with the user inside DorkOS. The ' +
        'reply says which one it used as "surface": "integration" or "dorkos-dm". Specify ' +
        'channel to target a specific adapter type (e.g., "telegram") or adapter ID (e.g., ' +
        '"telegram-lifeos"); naming one means that channel or nothing, never the DorkOS ' +
        'direct message. This always INITIATES a message — replying to an inbound chat ' +
        'message happens automatically and does not need this tool. Fails with code ' +
        'INITIATE_NOT_ALLOWED when the resolved binding has "Agent can start conversations" ' +
        'turned off. You have a limited number of these per hour, so send one when something ' +
        'actually needs the person — anything you could say in the conversation you are ' +
        'already in belongs there instead. The chat you are bound to may be a GROUP or a ' +
        'conversation with someone other than your operator: write the message to be read by ' +
        'whoever is in that chat, never as a private aside.',
      {
        message: z.string().describe('Message text to send to the user'),
        channel: z
          .string()
          .optional()
          .describe(
            'Optional adapter type or ID to target (e.g., "telegram", "telegram-lifeos"). Omit for most recent.'
          ),
      },
      createRelayNotifyUserHandler(deps, identity)
    ),
  ];
}
