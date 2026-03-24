import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RelayProgressPayload } from '@dorkos/shared/relay-schemas';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in RelayCore and ClaudeCodeAdapter.
 * Inlined here to avoid a runtime dependency on the @dorkos/relay dist output.
 */
function inferEndpointType(
  subject: string
): 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown' {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}

/** Guard that returns an error response when Relay is disabled. */
function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}

/** Send a message via Relay. */
export function createRelaySendHandler(deps: McpToolDeps) {
  return async (args: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = await deps.relayCore!.publish(args.subject, args.payload, {
        from: args.from,
        replyTo: args.replyTo,
        budget: args.budget,
      });
      return jsonContent({
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
        queued: result.deliveredTo === 0,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Publish failed';
      const code = message.includes('Access denied')
        ? 'ACCESS_DENIED'
        : message.includes('Invalid subject')
          ? 'INVALID_SUBJECT'
          : 'PUBLISH_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

/** Normalize maildir-style status aliases to the DB vocabulary used by SqliteIndex. */
function normalizeInboxStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  // Accept maildir-style ("new", "cur") and natural-language aliases ("unread", "read")
  // and map them to the DB statuses ("pending", "delivered", "failed").
  switch (status) {
    case 'new':
    case 'unread':
      return 'pending';
    case 'cur':
    case 'read':
      return 'delivered';
    default:
      return status; // 'pending', 'delivered', 'failed' pass through unchanged
  }
}

/** Read inbox messages for a Relay endpoint. */
export function createRelayInboxHandler(deps: McpToolDeps) {
  return async (args: { endpoint_subject: string; limit?: number; status?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = deps.relayCore!.readInbox(args.endpoint_subject, {
        limit: args.limit,
        status: normalizeInboxStatus(args.status),
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
 * Internally registers an ephemeral inbox, publishes the message with that
 * inbox as `replyTo`, then awaits the reply via RelayCore's in-process
 * `subscribe()` EventEmitter. Resolves in milliseconds once CCA publishes the
 * aggregated agent response — no polling required.
 *
 * Cleans up the ephemeral endpoint on success, timeout, or error.
 */
export function createRelayQueryHandler(deps: McpToolDeps) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    from: string;
    timeout_ms?: number;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    const relay = deps.relayCore!;
    const inboxSubject = `relay.inbox.query.${randomUUID()}`;

    try {
      await relay.registerEndpoint(inboxSubject);

      let sentMessageId: string;
      try {
        const result = await relay.publish(args.to_subject, args.payload, {
          from: args.from,
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
        const message = e instanceof Error ? e.message : 'Publish failed';
        const code = message.includes('Access denied')
          ? 'ACCESS_DENIED'
          : message.includes('Invalid subject')
            ? 'INVALID_SUBJECT'
            : 'PUBLISH_FAILED';
        return jsonContent({ error: message, code }, true);
      }

      const timeoutMs = args.timeout_ms ?? 60_000;
      const progressEvents: RelayProgressPayload[] = [];

      const reply = await new Promise<{
        payload: unknown;
        progress: RelayProgressPayload[];
        from: string;
        id: string;
      }>((resolve, reject) => {
        // `cleanup` is initialised before subscribe() so the timeout handler
        // can call it even if the timer fires during event-loop reentry.
        let cleanup: () => void = () => {};

        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(`relay_send_and_wait timed out after ${timeoutMs}ms (sent ${sentMessageId})`)
          );
        }, timeoutMs);

        const unsub = relay.subscribe(inboxSubject, (envelope) => {
          const payload = envelope.payload as Record<string, unknown>;

          // Accumulate progress events (type:progress, done:false) without resolving
          if (payload?.type === 'progress' && payload?.done === false) {
            progressEvents.push(payload as RelayProgressPayload);
            return;
          }

          // Any final message (agent_result with done:true, or plain payload for non-CCA compat)
          cleanup();
          resolve({ payload, progress: progressEvents, from: envelope.from, id: envelope.id });
        });

        cleanup = () => {
          clearTimeout(timer);
          unsub();
        };
      });

      return jsonContent({
        reply: reply.payload,
        progress: reply.progress,
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
export function createRelayDispatchHandler(deps: McpToolDeps) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    from: string;
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
        from: args.from,
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
        note: `Poll relay_inbox("${inboxSubject}") for progress. Call relay_unregister_endpoint("${inboxSubject}") when done:true is received.`,
      });
    } catch (e) {
      // Clean up inbox on publish error
      await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
      const message = e instanceof Error ? e.message : 'Dispatch failed';
      const code = message.includes('Access denied')
        ? 'ACCESS_DENIED'
        : message.includes('Invalid subject')
          ? 'INVALID_SUBJECT'
          : 'DISPATCH_FAILED';
      return jsonContent({ error: message, code }, true);
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

/** Send a message to a user on a bound external channel. */
export function createRelayNotifyUserHandler(deps: McpToolDeps) {
  return async (args: { message: string; channel?: string; agentId?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    if (!deps.bindingRouter || !deps.bindingStore) {
      return jsonContent(
        { error: 'Binding system not available', code: 'BINDINGS_DISABLED' },
        true
      );
    }

    const agentId = args.agentId;
    if (!agentId) {
      return jsonContent(
        {
          error: 'agentId is required. Pass your agent ID from <agent_identity>.',
          code: 'MISSING_AGENT_ID',
        },
        true
      );
    }

    const allBindings = deps.bindingStore.getAll();
    let myBindings = allBindings.filter((b) => b.agentId === agentId);

    if (args.channel) {
      const channel = args.channel.toLowerCase();

      // Tier 1: exact adapter ID match
      const exactIdMatches = myBindings.filter((b) => b.adapterId.toLowerCase() === channel);
      if (exactIdMatches.length > 0) {
        myBindings = exactIdMatches;
      } else if (deps.adapterManager) {
        // Tier 2: exact adapter type match (e.g., "telegram" matches all telegram adapters)
        const adapters = deps.adapterManager.listAdapters();
        const typeMatchIds = new Set(
          adapters.filter((a) => a.config.type.toLowerCase() === channel).map((a) => a.config.id)
        );
        const typeMatches = myBindings.filter((b) => typeMatchIds.has(b.adapterId));
        // Tier 3: substring ID match (fallback for partial IDs like "tele")
        myBindings =
          typeMatches.length > 0
            ? typeMatches
            : myBindings.filter((b) => b.adapterId.toLowerCase().includes(channel));
      } else {
        // No adapterManager — fall back to substring match
        myBindings = myBindings.filter((b) => b.adapterId.toLowerCase().includes(channel));
      }
    }

    if (myBindings.length === 0) {
      const available = allBindings.filter((b) => b.agentId === agentId).map((b) => b.adapterId);
      return jsonContent(
        {
          sent: false,
          error: args.channel
            ? `No binding found for channel "${args.channel}"`
            : 'No adapter bindings found for this agent',
          availableChannels: available,
          code: 'NO_BINDING',
        },
        true
      );
    }

    let bestSession: {
      bindingId: string;
      chatId: string;
      sessionId: string;
      adapterId: string;
    } | null = null;
    for (const binding of myBindings) {
      const sessions = deps.bindingRouter.getSessionsByBinding(binding.id);
      if (sessions.length > 0) {
        const latest = sessions[sessions.length - 1]!;
        bestSession = { ...latest, bindingId: binding.id, adapterId: binding.adapterId };
      }
    }

    if (!bestSession) {
      return jsonContent(
        {
          sent: false,
          error:
            'No active chat sessions found. The user must message the bot first to establish a chat.',
          availableAdapters: myBindings.map((b) => b.adapterId),
          code: 'NO_ACTIVE_SESSIONS',
        },
        true
      );
    }

    const adapters = deps.adapterManager?.listAdapters() ?? [];
    const adapter = adapters.find((a) => a.config.id === bestSession!.adapterId);
    const adapterType = adapter?.config?.type ?? 'unknown';
    const subject = `relay.human.${adapterType}.${bestSession.adapterId}.${bestSession.chatId}`;

    try {
      const result = await deps.relayCore!.publish(subject, args.message, {
        from: agentId,
      });
      return jsonContent({
        sent: true,
        subject,
        adapterId: bestSession.adapterId,
        adapterType,
        chatId: bestSession.chatId,
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Send failed';
      return jsonContent({ sent: false, error: message, code: 'SEND_FAILED' }, true);
    }
  };
}

/** Returns the Relay tool definitions for registration with the MCP server. */
export function getRelayTools(deps: McpToolDeps) {
  return [
    tool(
      'relay_send',
      'Send a message to a Relay subject. Delivers to all endpoints matching the subject pattern.',
      {
        subject: z.string().describe('Target subject (e.g., "relay.agent.backend")'),
        payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
        from: z.string().describe('Sender subject identifier'),
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
      createRelaySendHandler(deps)
    ),
    tool(
      'relay_inbox',
      'Read inbox messages for a Relay endpoint. Returns messages delivered to that endpoint.',
      {
        endpoint_subject: z.string().describe('Subject of the endpoint to read inbox for'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages to return'),
        status: z
          .string()
          .optional()
          .describe(
            'Filter by status. Use "unread" (or "new"/"pending") for unread messages, "read" (or "cur"/"delivered") for processed messages, "failed" for delivery failures. Omit to return all.'
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
        from: z.string().describe('Sender subject identifier'),
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
      createRelayQueryHandler(deps)
    ),
    tool(
      'relay_send_async',
      'Dispatch a message to an agent and return IMMEDIATELY with a dispatch inbox subject. ' +
        'Unlike relay_send_and_wait (which blocks), relay_send_async returns { messageId, inboxSubject } at once. ' +
        'Agent B runs asynchronously; CCA publishes incremental progress events and a final agent_result ' +
        'to the inbox. Poll relay_inbox(endpoint_subject=inboxSubject) for updates. ' +
        'When you receive a message with done:true, call relay_unregister_endpoint(inboxSubject) to clean up.',
      {
        to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
        payload: z.unknown().describe('Message payload'),
        from: z.string().describe('Sender subject identifier'),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional(),
            ttl: z.number().int().optional(),
            callBudgetRemaining: z.number().int().min(0).optional(),
          })
          .optional(),
      },
      createRelayDispatchHandler(deps)
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
        'specific adapter type (e.g., "telegram") or adapter ID (e.g., "telegram-lifeos").',
      {
        message: z.string().describe('Message text to send to the user'),
        channel: z
          .string()
          .optional()
          .describe(
            'Optional adapter type or ID to target (e.g., "telegram", "telegram-lifeos"). Omit for most recent.'
          ),
        agentId: z
          .string()
          .describe('Your agent ID from <agent_identity>. Required to identify your bindings.'),
      },
      createRelayNotifyUserHandler(deps)
    ),
  ];
}
