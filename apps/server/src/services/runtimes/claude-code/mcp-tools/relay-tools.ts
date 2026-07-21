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
  type SenderIdentity,
} from './relay-helpers.js';
import { resolveNotifyTarget } from '../../../relay/notify-target.js';

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
 * Defaults `status` to `'pending'` when omitted — mirrors the HTTP inbox
 * route's contract (DOR-337/DOR-406) so budget-rejected `failed` messages
 * never surface silently next to real deliverables. Pass `status: 'all'`
 * to opt back into the unfiltered view.
 */
export function createRelayInboxHandler(deps: McpToolDeps) {
  return async (args: {
    endpoint_subject: string;
    limit?: number;
    status?: InboxStatusFilter;
    ack?: boolean;
  }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
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
      return { ...ep, type, expiresAt };
    });
    return jsonContent({ endpoints: typed, count: typed.length });
  };
}

/** Register a new Relay endpoint. */
export function createRelayRegisterEndpointHandler(deps: McpToolDeps) {
  return async (args: { subject: string; description?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const info = await deps.relayCore!.registerEndpoint(args.subject);
      return jsonContent({ endpoint: info, note: args.description ?? 'Endpoint registered' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      const code = message.includes('Invalid subject') ? 'INVALID_SUBJECT' : 'REGISTRATION_FAILED';
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
      await relay.registerEndpoint(inboxSubject);

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
      await relay.registerEndpoint(inboxSubject);
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

/** Unregister a named Relay endpoint. */
export function createRelayUnregisterEndpointHandler(deps: McpToolDeps) {
  return async (args: { subject: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
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
 * Send a message to a user on a bound external channel.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-injected sender identity; its `agentId` selects the
 *   caller's own channel bindings (never taken from tool args)
 */
export function createRelayNotifyUserHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: { message: string; channel?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    if (!deps.bindingRouter || !deps.bindingStore) {
      return jsonContent(
        { error: 'Binding system not available', code: 'BINDINGS_DISABLED' },
        true
      );
    }

    const agentId = identity.agentId;
    if (!agentId) {
      return jsonContent(
        {
          error:
            'This session is not a registered agent, so it has no channel bindings to notify through.',
          code: 'NOT_AN_AGENT',
        },
        true
      );
    }

    // Resolve the channel via the shared resolver (also used by the system-level
    // TaskCompletionNotifier, DOR-240) so both proactive paths honor identical
    // binding, active-session, and `canInitiate` (DOR-239) rules.
    const target = resolveNotifyTarget(agentId, {
      bindingStore: deps.bindingStore,
      bindingRouter: deps.bindingRouter,
      adapterManager: deps.adapterManager,
      channel: args.channel,
    });

    if (!target.ok) {
      switch (target.reason) {
        case 'NO_BINDING':
          return jsonContent(
            {
              sent: false,
              error: args.channel
                ? `No binding found for channel "${args.channel}"`
                : 'No adapter bindings found for this agent',
              availableChannels: target.availableChannels,
              code: 'NO_BINDING',
            },
            true
          );
        case 'NO_ACTIVE_SESSIONS':
          return jsonContent(
            {
              sent: false,
              error:
                'No active chat sessions found. The user must message the bot first to establish a chat.',
              availableAdapters: target.availableAdapters,
              code: 'NO_ACTIVE_SESSIONS',
            },
            true
          );
        case 'INITIATE_NOT_ALLOWED':
          // relay_notify_user always INITIATES a message — it is never how an
          // agent replies to an inbound chat message (replies to a
          // <relay_context> turn are forwarded automatically by the runtime
          // adapter, see context-builder.ts). So a false canInitiate on the
          // resolved binding unconditionally blocks this call; it never blocks
          // the automatic reply-forwarding path.
          return jsonContent(
            {
              sent: false,
              error:
                "This channel doesn't allow the agent to start conversations; reply routing still works.",
              code: 'INITIATE_NOT_ALLOWED',
              bindingId: target.bindingId,
              adapterId: target.adapterId,
            },
            true
          );
      }
    }

    try {
      // Same server-injected principal as every other send tool — the bare
      // agentId is not a relay subject and would not match any access rule.
      const result = await deps.relayCore!.publish(target.subject, args.message, {
        from: identity.subject,
      });
      return jsonContent({
        sent: true,
        subject: target.subject,
        adapterId: target.adapterId,
        adapterType: target.adapterType,
        chatId: target.chatId,
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Send failed';
      return jsonContent({ sent: false, error: message, code: 'SEND_FAILED' }, true);
    }
  };
}

/**
 * Returns the Relay tool definitions for registration with the MCP server.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved sender identity. Injected as the publish
 *   `from` for every send tool, so the LLM cannot assert (spoof) its own
 *   identity to bypass namespace access rules.
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
      'Read inbox messages for a Relay endpoint. Each message includes the sender payload: ' +
        '{ id, subject, status, createdAt, sender, payload }. For agent dispatch inboxes the payload is ' +
        'a progress event { type: "progress", step, step_type, text, done: false } or the final ' +
        '{ type: "agent_result", text, done: true }. Defaults to status="pending" (deliverable, unread ' +
        'messages) so budget-rejected failures never surface silently next to real deliverables. Pass ' +
        'ack=true when polling so returned messages are marked read and the next poll only returns new ones.',
      {
        endpoint_subject: z.string().describe('Subject of the endpoint to read inbox for'),
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
            'Acknowledge returned unread messages (mark them read). Set true when polling a dispatch inbox so each message is returned exactly once.'
          ),
      },
      createRelayInboxHandler(deps)
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
      'Register a new Relay endpoint to receive messages on a subject.',
      {
        subject: z.string().describe('Subject for the new endpoint (e.g., "relay.agent.mybot")'),
        description: z.string().optional().describe('Human-readable description of the endpoint'),
      },
      createRelayRegisterEndpointHandler(deps)
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
      'Unregister a Relay endpoint. Use to clean up dispatch inboxes after relay_send_async completes (when done:true received).',
      {
        subject: z.string().describe('Subject of the endpoint to unregister'),
      },
      createRelayUnregisterEndpointHandler(deps)
    ),
    tool(
      'relay_notify_user',
      'Send a message to the user on a bound external channel (Telegram, Slack, etc.). ' +
        'Automatically resolves the best active chat. If channel is omitted, sends to the ' +
        'most recently active chat across all bound adapters. Specify channel to target a ' +
        'specific adapter type (e.g., "telegram") or adapter ID (e.g., "telegram-lifeos"). ' +
        'This always INITIATES a message — replying to an inbound chat message happens ' +
        'automatically and does not need this tool. Fails with code INITIATE_NOT_ALLOWED ' +
        'when the resolved binding has "Agent can start conversations" turned off.',
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
