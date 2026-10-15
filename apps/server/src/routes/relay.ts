/**
 * Relay message bus routes — send messages, manage endpoints, query inbox, SSE stream,
 * and external adapter management.
 *
 * @module routes/relay
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type { RelayCore, DeadLetterEntry } from '@dorkos/relay';
import {
  extractSessionIdFromSubject,
  isServerManagedSubject,
  SERVER_MANAGED_PREFIXES,
} from '@dorkos/relay';
import {
  SendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  DeadLetterQuerySchema,
  EndpointRegistrationSchema,
  reachesServerDestination,
  SERVER_DESTINATION_REFUSAL,
} from '@dorkos/shared/relay-schemas';
import { initSSEStream } from '../services/core/streams/stream-adapter.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import { resolveSubjectLabels, type SubjectLabel } from '../services/relay/subject-resolver.js';
import { isServerOnlyPrincipal } from '../services/relay/initiate-consent.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { readHomeManifest } from '../services/core/agent-identity/index.js';
import { createAdapterRoutes } from './relay-adapters.js';
import { createRelayWebhookRoutes } from './relay-webhooks.js';
import { logger } from '../lib/logger.js';
import {
  createReceiptStatusHandler,
  publishRelayMessage,
  type RelayPublishDeps,
} from './relay-delivery-receipts.js';

/** Allowed subject prefixes for SSE subscription patterns. */
const ALLOWED_PREFIXES = ['relay.human.console.', 'relay.system.', 'relay.signal.'];

/** Maximum characters for conversation preview text. */
const PREVIEW_MAX_CHARS = 120;

/** Minimal relay message shape used by conversation builder. */
interface RelayMsg {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
}

/** Structured conversation returned by the conversations endpoint. */
interface Conversation {
  id: string;
  direction: 'outbound';
  status: 'delivered' | 'failed' | 'pending';
  from: SubjectLabel;
  to: SubjectLabel;
  preview: string;
  payload: unknown;
  responseCount: number;
  sentAt: string;
  completedAt: string | undefined;
  durationMs: number | undefined;
  subject: string;
  sessionId: string | undefined;
  traceId: string;
  failureReason: string | undefined;
}

/** Validate that a subscription pattern starts with an allowed prefix. */
function validateSubscriptionPattern(pattern: string): boolean {
  if (pattern === '>') return false;
  return ALLOWED_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}

/**
 * Build structured conversations from relay messages, dead letters, and subject labels.
 *
 * Uses a pre-built Map for O(1) dead-letter lookups instead of repeated Array.find() calls.
 *
 * @param messages - Flat list of relay messages (newest first)
 * @param deadLetters - Dead letter entries for failed/expired messages
 * @param labelMap - Resolved human-readable labels keyed by subject string
 * @internal Exported for testing only.
 */
export function buildConversations(
  messages: RelayMsg[],
  deadLetters: DeadLetterEntry[],
  labelMap: Map<string, SubjectLabel>
): Conversation[] {
  // O(1) dead-letter lookup by messageId
  const deadLetterMap = new Map(deadLetters.map((dl) => [dl.messageId, dl]));

  // Separate requests from response chunks
  const requests: RelayMsg[] = [];
  const responseChunksBySubject = new Map<string, RelayMsg[]>();

  for (const msg of messages) {
    if (msg.subject.startsWith('relay.agent.') || msg.subject.startsWith('relay.system.')) {
      requests.push(msg);
    } else if (msg.subject.startsWith('relay.human.console.')) {
      const existing = responseChunksBySubject.get(msg.subject) ?? [];
      existing.push(msg);
      responseChunksBySubject.set(msg.subject, existing);
    }
  }

  // Build per-request from subjects using the Map for O(1) lookup
  const fromSubjects = new Map<string, string>();
  for (const req of requests) {
    const dl = deadLetterMap.get(req.id);
    let from = dl?.envelope?.from ?? '';
    if (!from) {
      if (req.subject.startsWith('relay.agent.')) {
        from = 'relay.human.console.inferred';
      } else if (req.subject.startsWith('relay.system.tasks.')) {
        from = 'relay.system.console';
      }
    }
    fromSubjects.set(req.id, from);
  }

  return requests.map((req) => {
    const deadLetter = deadLetterMap.get(req.id);
    const fromSubject = fromSubjects.get(req.id) ?? '';
    const responseChunks = responseChunksBySubject.get(fromSubject) ?? [];
    const lastChunk = responseChunks[0]; // messages are sorted newest-first

    // Build preview from dead letter envelope (has full payload)
    let preview = '';
    let payload: unknown = undefined;
    if (deadLetter?.envelope?.payload) {
      payload = deadLetter.envelope.payload;
      const p = payload as Record<string, unknown>;
      const text = p?.content ?? p?.text ?? p?.message;
      preview =
        typeof text === 'string'
          ? text.slice(0, PREVIEW_MAX_CHARS)
          : JSON.stringify(payload).slice(0, PREVIEW_MAX_CHARS);
    }

    // Use the shared parser so conversation session IDs are extracted
    // correctly from both the legacy shape (`relay.agent.<sessionId>`) and
    // the new runtime-scoped shape (`relay.agent.<runtimeType>.<sessionId>`).
    const sessionId = req.subject.startsWith('relay.agent.')
      ? (extractSessionIdFromSubject(req.subject) ?? undefined)
      : undefined;

    return {
      id: req.id,
      direction: 'outbound' as const,
      status:
        req.status === 'delivered'
          ? ('delivered' as const)
          : req.status === 'failed'
            ? ('failed' as const)
            : ('pending' as const),
      from: labelMap.get(fromSubject) ?? { label: 'Unknown', raw: fromSubject },
      to: labelMap.get(req.subject) ?? { label: req.subject, raw: req.subject },
      preview,
      payload,
      responseCount: responseChunks.length,
      sentAt: req.createdAt,
      completedAt: lastChunk?.createdAt as string | undefined,
      durationMs: lastChunk
        ? new Date(lastChunk.createdAt as string).getTime() - new Date(req.createdAt).getTime()
        : undefined,
      subject: req.subject,
      sessionId,
      traceId: req.id,
      failureReason: deadLetter?.reason as string | undefined,
    };
  });
}

/** What the Relay routes read. */
export interface RelayRouteDeps extends RelayPublishDeps {
  /** Delivery traces, behind the trace reads and a connection's events and chats. */
  traceStore?: TraceStore;
}

/**
 * The Relay routes, mounted at `/api/relay`: messages, endpoints, dead letters,
 * metrics, traces and the event stream, plus the connection routes when an
 * adapter manager is handed over.
 *
 * @param deps - The bus, and the optional adapter manager, traces and activity feed.
 * @returns The routes.
 */
export function createRelayRoutes(deps: RelayRouteDeps): Hono<ApiEnv> {
  const { relayCore, adapterManager, traceStore } = deps;
  const router = new Hono<ApiEnv>();

  // POST /messages — Send a message
  router.post('/messages', async (c) => {
    const result = SendMessageRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) return c.json(validationFailureBody(result.error), 400);

    // This route takes a client-supplied `from`. It must not let an untrusted
    // caller assert a principal the initiate-consent gate trusts as exempt
    // (reply-forwarding, system, inbound adapter echo) — doing so would let a
    // local caller deliver to a bound human channel with `canInitiate` off,
    // bypassing DOR-277. Server-injected principals never travel this route, so
    // rejecting them here is safe. Ordinary principals (`relay.human.console`,
    // `relay.agent.*`, …) still flow and remain subject to the gate.
    //
    // DOR-871: also rejects `relay.bridge.*`, which the gate evaluates
    // (non-exempt) rather than skips — see `isServerOnlyPrincipal`'s doc for
    // why that principal must still be unassertable here.
    if (isServerOnlyPrincipal(result.data.from)) {
      return c.json(
        {
          error:
            `Sender "${result.data.from}" is a reserved server principal and cannot be ` +
            `asserted by a client. Send from your own principal (e.g. relay.human.console).`,
          code: 'RESERVED_SENDER',
        },
        403
      );
    }

    // DOR-2432: nothing on this route is a server publisher — the scheduler,
    // the stop paths and the approval bridges publish in process — and the
    // route cannot tell an agent with a shell from the person at the keyboard,
    // so a server-owned destination or reply address is refused for everyone.
    const refused = [result.data.subject, result.data.replyTo].find(
      (subject): subject is string => subject !== undefined && reachesServerDestination(subject)
    );
    if (refused !== undefined) {
      return c.json(
        {
          error: `Cannot send to "${refused}": ${SERVER_DESTINATION_REFUSAL}`,
          code: 'RESERVED_SUBJECT',
        },
        403
      );
    }

    return publishRelayMessage(c, deps, result.data);
  });

  router.get('/messages/:messageId/status', createReceiptStatusHandler(relayCore));

  // GET /messages — List with filters and cursor pagination
  router.get('/messages', (c) => {
    const result = MessageListQuerySchema.safeParse(readQuery(c));
    if (!result.success) return c.json(validationFailureBody(result.error), 400);
    return c.json(relayCore.listMessages(result.data));
  });

  // GET /conversations — Grouped request/response exchanges with human labels
  router.get('/conversations', async (c) => {
    try {
      const messages = relayCore.listMessages({});
      const deadLetters = await relayCore.getDeadLetters();

      // Collect all unique subjects and resolve human-readable labels
      const allSubjects = [...new Set(messages.messages.map((m) => m.subject))];
      const vaultRoot = DEFAULT_CWD;
      const resolverDeps = {
        getSession: async (id: string) => {
          // Label resolution is best-effort. If the session's runtime is not
          // currently registered (e.g., a stored codex session pre-rollout),
          // skip labeling rather than 500-ing the whole /conversations response.
          try {
            const runtime = await runtimeRegistry.resolveForSession(id);
            return runtime.getSession(vaultRoot, id);
          } catch {
            return null;
          }
        },
        readManifest: readHomeManifest,
      };
      const labelMap = await resolveSubjectLabels(allSubjects, resolverDeps);

      const conversations = buildConversations(messages.messages, deadLetters, labelMap);
      return c.json({ conversations });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build conversations';
      return c.json({ error: message }, 500);
    }
  });

  // GET /messages/:id — Get single message with its full per-endpoint delivery
  // breakdown (all rows join on the envelope id after identity unification).
  router.get('/messages/:id', (c) => {
    const message = relayCore.getMessageDetail(c.req.param('id'));
    if (!message) return c.json({ error: 'Message not found' }, 404);
    return c.json(message);
  });

  // GET /endpoints — List registered endpoints
  router.get('/endpoints', (c) => c.json(relayCore.listEndpoints()));

  // POST /endpoints — Register an endpoint
  router.post('/endpoints', async (c) => {
    const result = EndpointRegistrationSchema.safeParse(readJsonBody(c));
    if (!result.success) return c.json(validationFailureBody(result.error), 400);

    // This route takes a client-supplied subject and, with login off by
    // default, is reachable by anything that can reach the port. A mailbox in a
    // namespace the server manages intercepts mail addressed to an agent, to
    // the person, or to the server — and on a subject the server publishes
    // control signals to it manufactures a false confirmation (see
    // `isControlSubject`). The same list the agent tool surface enforces, asked
    // here too rather than trusted to a caller.
    if (isServerManagedSubject(result.data.subject)) {
      return c.json(
        {
          error:
            `Subject "${result.data.subject}" is in a namespace DorkOS manages and cannot be ` +
            'registered here. Use a subject outside ' +
            `${SERVER_MANAGED_PREFIXES.join(', ')}.`,
        },
        403
      );
    }

    try {
      const endpoint = await relayCore.registerEndpoint(result.data.subject);
      return c.json(endpoint, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return c.json({ error: message }, 422);
    }
  });

  // GET /endpoints/:subject/inbox — Read inbox. The subject takes every
  // remaining segment but the last, as dots and slashes alike may sit in it.
  router.get('/endpoints/:subject{.+}/inbox', async (c) => {
    const result = InboxQuerySchema.safeParse(readQuery(c));
    if (!result.success) return c.json(validationFailureBody(result.error), 400);
    try {
      const messages = await relayCore.readInbox(c.req.param('subject'), result.data);
      return c.json(messages);
    } catch (err) {
      if ((err as Error & { code?: string })?.code === 'ENDPOINT_NOT_FOUND') {
        return c.json({ error: 'Endpoint not found' }, 404);
      }
      logger.error('[relay] GET /endpoints/:subject/inbox failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // DELETE /endpoints/:subject — Unregister endpoint (the subject takes every
  // remaining segment)
  router.delete('/endpoints/:subject{.+}', async (c) => {
    const removed = await relayCore.unregisterEndpoint(c.req.param('subject'));
    if (!removed) return c.json({ error: 'Endpoint not found' }, 404);
    return c.json({ success: true });
  });

  // GET /dead-letters — List dead-letter messages
  router.get('/dead-letters', async (c) => {
    const result = DeadLetterQuerySchema.safeParse(readQuery(c));
    if (!result.success) return c.json(validationFailureBody(result.error), 400);
    const { endpointHash } = result.data;
    const deadLetters = await relayCore.getDeadLetters(endpointHash ? { endpointHash } : undefined);
    return c.json(deadLetters);
  });

  // GET /dead-letters/aggregated — Dead letters grouped by source + reason
  router.get('/dead-letters/aggregated', async (c) => {
    const deadLetters = await relayCore.getDeadLetters();

    const groups = new Map<
      string,
      {
        source: string;
        reason: string;
        count: number;
        firstSeen: string;
        lastSeen: string;
        sample: unknown;
      }
    >();

    for (const dl of deadLetters) {
      const source = dl.envelope?.from ?? 'unknown';
      const key = `${source}::${dl.reason}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (dl.failedAt < existing.firstSeen) existing.firstSeen = dl.failedAt;
        if (dl.failedAt > existing.lastSeen) existing.lastSeen = dl.failedAt;
      } else {
        groups.set(key, {
          source,
          reason: dl.reason,
          count: 1,
          firstSeen: dl.failedAt,
          lastSeen: dl.failedAt,
          sample: dl.envelope,
        });
      }
    }

    return c.json({ groups: [...groups.values()] });
  });

  // DELETE /dead-letters — Remove dead letters matching a source + reason group
  router.delete('/dead-letters', async (c) => {
    const { source, reason } = readJsonBody(c, { emptyAs: {} }) as {
      source: string;
      reason: string;
    };
    if (!source || !reason) {
      return c.json({ error: 'source and reason are required' }, 400);
    }
    const deadLetters = await relayCore.getDeadLetters();
    const toRemove = deadLetters.filter(
      (dl) => (dl.envelope?.from ?? 'unknown') === source && dl.reason === reason
    );
    for (const dl of toRemove) {
      await relayCore.removeDeadLetter(dl.endpointHash, dl.messageId);
    }
    return c.json({ removed: toRemove.length });
  });

  // GET /metrics — Relay system metrics (from RelayCore)
  router.get('/metrics', (c) => c.json(relayCore.getMetrics()));

  // GET /messages/:id/trace — Full trace for a message
  router.get('/messages/:id/trace', (c) => {
    if (!traceStore) return c.json({ error: 'Tracing not available' }, 404);
    const span = traceStore.getSpanByMessageId(c.req.param('id'));
    if (!span) return c.json({ error: 'Trace not found' }, 404);
    const spans = traceStore.getTrace(span.traceId);
    return c.json({ traceId: span.traceId, spans });
  });

  // GET /trace/metrics — Aggregate delivery metrics from TraceStore
  router.get('/trace/metrics', (c) => {
    if (!traceStore) return c.json({ error: 'Tracing not available' }, 404);
    return c.json(traceStore.getMetrics());
  });

  // GET /stream — SSE event stream with server-side subject filtering
  router.get('/stream', (c) => {
    logger.warn('[DEPRECATED] GET /api/relay/stream — use GET /api/events instead');
    const pattern = (readQuery(c).subject as string) || 'relay.human.console.>';
    if (!validateSubscriptionPattern(pattern)) {
      return c.json(
        { error: 'Invalid subscription pattern', allowedPrefixes: ALLOWED_PREFIXES },
        400
      );
    }
    return streamToNodeResponse(c, (res, { signal }) =>
      streamRelayEvents(relayCore, pattern, res, signal)
    );
  });

  // --- Adapter Management Routes ---
  if (adapterManager) {
    router.route('/', createAdapterRoutes({ adapterManager, traceStore, activity: deps.activity }));
    router.route('/', createRelayWebhookRoutes(adapterManager));
  }

  return router;
}

/**
 * Write relay messages and signals matching `pattern` as an event stream until
 * the client leaves.
 */
function streamRelayEvents(
  relayCore: RelayCore,
  pattern: string,
  res: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  initSSEStream(res);
  res.write(`event: relay_connected\n`);
  res.write(`data: ${JSON.stringify({ pattern, connectedAt: new Date().toISOString() })}\n\n`);

  // Backpressure: skip events until the client drains its buffer
  let paused = false;

  const unsubMessages = relayCore.subscribe(pattern, (envelope) => {
    if (res.writableEnded || paused) return;
    try {
      res.write(`id: ${envelope.id}\n`);
      res.write(`event: relay_message\n`);
      const canContinue = res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      if (!canContinue) {
        paused = true;
        res.once('drain', () => {
          paused = false;
        });
      }
    } catch {
      // Write failure — cleaned up on close
    }
  });

  const unsubSignals = relayCore.onSignal(pattern, (_subject, relaySignal) => {
    if (res.writableEnded || paused) return;
    try {
      const eventType = relaySignal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      res.write(`event: ${eventType}\n`);
      const canContinue = res.write(`data: ${JSON.stringify(relaySignal)}\n\n`);
      if (!canContinue) {
        paused = true;
        res.once('drain', () => {
          paused = false;
        });
      }
    } catch {
      // Write failure — cleaned up on close
    }
  });

  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      clearInterval(keepalive);
    }
  }, 15_000);

  return new Promise((resolve) => {
    const stop = (): void => {
      clearInterval(keepalive);
      unsubMessages();
      unsubSignals();
      resolve();
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
