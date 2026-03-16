/**
 * Relay message bus routes — send messages, manage endpoints, query inbox, SSE stream,
 * and external adapter management.
 *
 * @module routes/relay
 */
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import type { RelayCore, WebhookAdapter, DeadLetterEntry } from '@dorkos/relay';
import {
  SendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
  CreateBindingRequestSchema,
  AdapterTestRequestSchema,
  AdapterCreateRequestSchema,
  AdapterConfigUpdateSchema,
  SessionStrategySchema,
  ChannelTypeSchema,
} from '@dorkos/shared/relay-schemas';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import { initSSEStream } from '../services/core/stream-adapter.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import { resolveSubjectLabels, type SubjectLabel } from '../services/relay/subject-resolver.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { readManifest } from '@dorkos/shared/manifest';

/** Allowed subject prefixes for SSE subscription patterns. */
const ALLOWED_PREFIXES = ['relay.human.console.', 'relay.system.', 'relay.signal.'];

/** Map adapter error codes to HTTP status codes. */
const ADAPTER_ERROR_STATUS: Record<string, number> = {
  DUPLICATE_ID: 409,
  UNKNOWN_TYPE: 400,
  MULTI_INSTANCE_DENIED: 400,
  NOT_FOUND: 404,
  REMOVE_BUILTIN_DENIED: 400,
};

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
 * Handle an AdapterError by mapping its code to an HTTP status via ADAPTER_ERROR_STATUS.
 *
 * @param res - Express response object
 * @param err - The AdapterError to handle
 */
function sendAdapterError(res: express.Response, err: AdapterError): void {
  const status = ADAPTER_ERROR_STATUS[err.code] ?? 500;
  res.status(status).json({ error: err.message, code: err.code });
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
  labelMap: Map<string, SubjectLabel>,
): Conversation[] {
  // O(1) dead-letter lookup by messageId
  const deadLetterMap = new Map(deadLetters.map((dl) => [dl.messageId, dl]));

  // Separate requests from response chunks
  const requests: RelayMsg[] = [];
  const responseChunksBySubject = new Map<string, RelayMsg[]>();

  for (const msg of messages) {
    if (
      msg.subject.startsWith('relay.agent.') ||
      msg.subject.startsWith('relay.system.')
    ) {
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
      } else if (req.subject.startsWith('relay.system.pulse.')) {
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

    const sessionId = req.subject.startsWith('relay.agent.')
      ? req.subject.slice('relay.agent.'.length)
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
        ? new Date(lastChunk.createdAt as string).getTime() -
          new Date(req.createdAt).getTime()
        : undefined,
      subject: req.subject,
      sessionId,
      traceId: req.id,
      failureReason: deadLetter?.reason as string | undefined,
    };
  });
}

/**
 * Create the Relay router with message, endpoint, and adapter management endpoints.
 *
 * @param relayCore - The RelayCore instance for message bus operations
 * @param adapterManager - Optional adapter lifecycle manager for external channel adapters
 * @param traceStore - Optional trace store for message delivery tracking
 */
export function createRelayRouter(
  relayCore: RelayCore,
  adapterManager?: AdapterManager,
  traceStore?: TraceStore,
): Router {
  const router = Router();

  // POST /messages — Send a message
  router.post('/messages', async (req, res) => {
    const result = SendMessageRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const publishResult = await relayCore.publish(result.data.subject, result.data.payload, {
        from: result.data.from,
        replyTo: result.data.replyTo,
        budget: result.data.budget,
      });
      return res.json(publishResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed';
      return res
        .status(422)
        .json({ error: message, code: (err as Error & { code?: string })?.code ?? 'PUBLISH_FAILED' });
    }
  });

  // GET /messages — List with filters and cursor pagination
  router.get('/messages', (_req, res) => {
    const result = MessageListQuerySchema.safeParse(_req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const messages = relayCore.listMessages(result.data);
    return res.json(messages);
  });

  // GET /conversations — Grouped request/response exchanges with human labels
  router.get('/conversations', async (_req, res) => {
    try {
      const messages = relayCore.listMessages({});
      const deadLetters = await relayCore.getDeadLetters();

      // Collect all unique subjects and resolve human-readable labels
      const allSubjects = [...new Set(messages.messages.map((m) => m.subject))];
      const vaultRoot = DEFAULT_CWD;
      const resolverDeps = {
        getSession: async (id: string) => {
          const runtime = runtimeRegistry.getDefault();
          return runtime.getSession(vaultRoot, id);
        },
        readManifest: async (cwd: string) => readManifest(cwd),
      };
      const labelMap = await resolveSubjectLabels(allSubjects, resolverDeps);

      const conversations = buildConversations(messages.messages, deadLetters, labelMap);
      return res.json({ conversations });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build conversations';
      return res.status(500).json({ error: message });
    }
  });

  // GET /messages/:id — Get single message
  router.get('/messages/:id', (_req, res) => {
    const message = relayCore.getMessage(_req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    return res.json(message);
  });

  // GET /endpoints — List registered endpoints
  router.get('/endpoints', (_req, res) => {
    return res.json(relayCore.listEndpoints());
  });

  // POST /endpoints — Register an endpoint
  router.post('/endpoints', async (req, res) => {
    const result = EndpointRegistrationSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const endpoint = await relayCore.registerEndpoint(result.data.subject);
      return res.status(201).json(endpoint);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return res.status(422).json({ error: message });
    }
  });

  // DELETE /endpoints/:subject — Unregister endpoint (regex matches dots in subjects)
  router.delete(/^\/endpoints\/(.+)$/, async (req, res) => {
    const removed = await relayCore.unregisterEndpoint(req.params[0]);
    if (!removed) return res.status(404).json({ error: 'Endpoint not found' });
    return res.json({ success: true });
  });

  // GET /endpoints/:subject/inbox — Read inbox (regex matches dots in subjects)
  router.get(/^\/endpoints\/(.+)\/inbox$/, (_req, res) => {
    const result = InboxQuerySchema.safeParse(_req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const messages = relayCore.readInbox(_req.params[0], result.data);
      return res.json(messages);
    } catch (err) {
      if ((err as Error & { code?: string })?.code === 'ENDPOINT_NOT_FOUND') {
        return res.status(404).json({ error: 'Endpoint not found' });
      }
      throw err;
    }
  });

  // GET /dead-letters — List dead-letter messages
  router.get('/dead-letters', async (_req, res) => {
    const endpointHash = _req.query.endpointHash as string | undefined;
    const deadLetters = await relayCore.getDeadLetters(
      endpointHash ? { endpointHash } : undefined,
    );
    return res.json(deadLetters);
  });

  // GET /dead-letters/aggregated — Dead letters grouped by source + reason
  router.get('/dead-letters/aggregated', async (_req, res) => {
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

    return res.json({ groups: [...groups.values()] });
  });

  // DELETE /dead-letters — Remove dead letters matching a source + reason group
  router.delete('/dead-letters', async (req, res) => {
    const { source, reason } = req.body as { source: string; reason: string };
    if (!source || !reason) {
      return res.status(400).json({ error: 'source and reason are required' });
    }
    const deadLetters = await relayCore.getDeadLetters();
    const toRemove = deadLetters.filter(
      (dl) => (dl.envelope?.from ?? 'unknown') === source && dl.reason === reason,
    );
    for (const dl of toRemove) {
      await relayCore.removeDeadLetter(dl.endpointHash, dl.messageId);
    }
    return res.json({ removed: toRemove.length });
  });

  // GET /metrics — Relay system metrics (from RelayCore)
  router.get('/metrics', (_req, res) => res.json(relayCore.getMetrics()));

  // GET /messages/:id/trace — Full trace for a message
  router.get('/messages/:id/trace', (_req, res) => {
    if (!traceStore) return res.status(404).json({ error: 'Tracing not available' });
    const span = traceStore.getSpanByMessageId(_req.params.id);
    if (!span) return res.status(404).json({ error: 'Trace not found' });
    const spans = traceStore.getTrace(span.traceId);
    return res.json({ traceId: span.traceId, spans });
  });

  // GET /trace/metrics — Aggregate delivery metrics from TraceStore
  router.get('/trace/metrics', (_req, res) => {
    if (!traceStore) return res.status(404).json({ error: 'Tracing not available' });
    return res.json(traceStore.getMetrics());
  });

  // GET /stream — SSE event stream with server-side subject filtering
  router.get('/stream', (req, res) => {
    const pattern = (req.query.subject as string) || 'relay.human.console.>';
    if (!validateSubscriptionPattern(pattern)) {
      return res.status(400).json({ error: 'Invalid subscription pattern', allowedPrefixes: ALLOWED_PREFIXES });
    }
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
          res.once('drain', () => { paused = false; });
        }
      } catch {
        // Write failure — cleaned up on close
      }
    });

    const unsubSignals = relayCore.onSignal(pattern, (_subject, signal) => {
      if (res.writableEnded || paused) return;
      try {
        const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
        res.write(`event: ${eventType}\n`);
        const canContinue = res.write(`data: ${JSON.stringify(signal)}\n\n`);
        if (!canContinue) {
          paused = true;
          res.once('drain', () => { paused = false; });
        }
      } catch {
        // Write failure — cleaned up on close
      }
    });

    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      try { res.write(`: keepalive\n\n`); } catch { clearInterval(keepalive); }
    }, 15_000);

    req.on('close', () => { clearInterval(keepalive); unsubMessages(); unsubSignals(); });
  });

  // --- Adapter Management Routes ---
  if (adapterManager) {
    router.get('/adapters/catalog', (_req, res) => {
      try { res.json(adapterManager.getCatalog()); } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to retrieve adapter catalog';
        res.status(500).json({ error: message });
      }
    });

    router.post('/adapters/reload', async (_req, res) => {
      try { await adapterManager.reload(); return res.json({ ok: true }); } catch (err) {
        const message = err instanceof Error ? err.message : 'Reload failed';
        return res.status(500).json({ error: message });
      }
    });

    router.get('/adapters', (_req, res) => res.json(adapterManager.listAdapters()));

    router.get('/adapters/:id', (req, res) => {
      const adapter = adapterManager.getAdapter(req.params.id);
      if (!adapter) return res.status(404).json({ error: 'Adapter not found' });
      return res.json(adapter);
    });

    router.post('/adapters/test', async (req, res) => {
      const result = AdapterTestRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      try {
        const testResult = await adapterManager.testConnection(result.data.type, result.data.config);
        return res.json(testResult);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Test failed';
        return res.status(500).json({ error: message });
      }
    });

    router.post('/adapters', async (req, res) => {
      const result = AdapterCreateRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      const { type, id, config, enabled, label: topLabel } = result.data;
      // The client may embed label inside config (Transport interface doesn't have a separate
      // label param). Fall back to config.label if the top-level field wasn't provided.
      const label = topLabel ?? (typeof config.label === 'string' ? config.label : undefined);
      try {
        await adapterManager.addAdapter(type, id, config, enabled, label);
        return res.status(201).json({ ok: true, id });
      } catch (err) {
        if (err instanceof AdapterError) return sendAdapterError(res, err);
        const message = err instanceof Error ? err.message : 'Create failed';
        return res.status(500).json({ error: message });
      }
    });

    router.delete('/adapters/:id', async (req, res) => {
      try {
        await adapterManager.removeAdapter(req.params.id);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof AdapterError) return sendAdapterError(res, err);
        const message = err instanceof Error ? err.message : 'Remove failed';
        return res.status(500).json({ error: message });
      }
    });

    router.patch('/adapters/:id/config', async (req, res) => {
      const result = AdapterConfigUpdateSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      try {
        await adapterManager.updateConfig(req.params.id, result.data.config);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof AdapterError) return sendAdapterError(res, err);
        const message = err instanceof Error ? err.message : 'Update failed';
        return res.status(500).json({ error: message });
      }
    });

    router.post('/adapters/:id/enable', async (req, res) => {
      try { await adapterManager.enable(req.params.id); return res.json({ ok: true }); } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Enable failed' });
      }
    });

    router.post('/adapters/:id/disable', async (req, res) => {
      try { await adapterManager.disable(req.params.id); return res.json({ ok: true }); } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Disable failed' });
      }
    });

    // GET /adapters/:id/events — Get adapter event log
    router.get('/adapters/:id/events', (_req, res) => {
      if (!traceStore) return res.status(404).json({ error: 'Tracing not available' });
      const { id } = _req.params;
      const limitParam = parseInt(_req.query.limit as string);
      // Validate limit bounds (1-500) to prevent DoS
      const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
      const events = traceStore.getAdapterEvents(id, limit);
      return res.json({ events });
    });

    // GET /adapters/:id/chats — Observed chats from trace data
    router.get('/adapters/:id/chats', (_req, res) => {
      if (!traceStore) return res.status(404).json({ error: 'Tracing not available' });
      const { id } = _req.params;
      const limitParam = parseInt(_req.query.limit as string);
      const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
      const chats = traceStore.getObservedChats(id, limit);
      return res.json({ chats });
    });

    // --- Binding Management Routes ---
    router.get('/bindings', (_req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });
      return res.json({ bindings: bindingStore.getAll() });
    });

    router.get('/bindings/:id', (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });
      const binding = bindingStore.getById(req.params.id);
      if (!binding) return res.status(404).json({ error: 'Binding not found' });
      return res.json({ binding });
    });

    router.post('/bindings', async (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });
      const result = CreateBindingRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      try {
        const binding = await bindingStore.create(result.data);
        return res.status(201).json({ binding });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Create failed';
        return res.status(500).json({ error: message });
      }
    });

    router.patch('/bindings/:id', async (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }

      const UpdateBindingSchema = z.object({
        sessionStrategy: SessionStrategySchema.optional(),
        label: z.string().optional(),
        chatId: z.string().optional().nullable(),
        channelType: ChannelTypeSchema.optional().nullable(),
        canInitiate: z.boolean().optional(),
        canReply: z.boolean().optional(),
        canReceive: z.boolean().optional(),
        permissionMode: PermissionModeSchema.optional(),
      });

      const result = UpdateBindingSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }

      // Convert null to undefined for clearing optional fields
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.data)) {
        if (value !== undefined) {
          updates[key] = value === null ? undefined : value;
        }
      }

      const updated = await bindingStore.update(req.params.id, updates);
      if (!updated) {
        return res.status(404).json({ error: 'Binding not found' });
      }
      return res.json({ binding: updated });
    });

    router.delete('/bindings/:id', async (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });
      const deleted = await bindingStore.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Binding not found' });
      const bindingRouter = adapterManager.getBindingRouter();
      if (bindingRouter) {
        const activeBindingIds = new Set(bindingStore.getAll().map((b) => b.id));
        await bindingRouter.cleanupOrphanedSessions(activeBindingIds);
      }
      return res.json({ ok: true });
    });

    // POST /webhooks/:adapterId — Inbound webhook receiver
    router.post('/webhooks/:adapterId', express.raw({ type: '*/*' }), async (req, res) => {
      const adapterInfo = adapterManager.getAdapter(req.params.adapterId);
      if (!adapterInfo || adapterInfo.config.type !== 'webhook') {
        return res.status(404).json({ error: 'Webhook adapter not found' });
      }
      const registry = adapterManager.getRegistry();
      const adapter = registry.get(req.params.adapterId);
      if (!adapter) return res.status(404).json({ error: 'Adapter not running' });
      if (!('handleInbound' in adapter) || typeof (adapter as Record<string, unknown>).handleInbound !== 'function') {
        return res.status(500).json({ error: 'Adapter does not support webhook ingestion' });
      }
      const webhookAdapter = adapter as WebhookAdapter;
      const result = await webhookAdapter.handleInbound(
        req.body as Buffer,
        req.headers as Record<string, string | string[] | undefined>,
      );
      if (result.ok) return res.status(200).json({ ok: true });
      return res.status(401).json({ error: result.error });
    });
  }

  return router;
}
