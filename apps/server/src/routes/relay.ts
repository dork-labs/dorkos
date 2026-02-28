/**
 * Relay message bus routes — send messages, manage endpoints, query inbox, SSE stream,
 * and external adapter management.
 *
 * @module routes/relay
 */
import { Router } from 'express';
import express from 'express';
import type { RelayCore, WebhookAdapter } from '@dorkos/relay';
import {
  SendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
  CreateBindingRequestSchema,
} from '@dorkos/shared/relay-schemas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSSEStream } from '../services/core/stream-adapter.js';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import type { TraceStore } from '../services/relay/trace-store.js';

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
      const { resolveSubjectLabels } = await import(
        '../services/relay/subject-resolver.js'
      );
      const { transcriptReader } = await import(
        '../services/session/transcript-reader.js'
      );
      const { readManifest } = await import('@dorkos/shared/manifest');

      const messages = relayCore.listMessages({});
      const deadLetters = await relayCore.getDeadLetters();

      // Separate requests from response chunks
      type Msg = (typeof messages.messages)[number];
      const requests: Msg[] = [];
      const responseChunksBySubject = new Map<string, Msg[]>();

      for (const msg of messages.messages) {
        const subject = msg.subject;
        if (
          subject.startsWith('relay.agent.') ||
          subject.startsWith('relay.system.')
        ) {
          requests.push(msg);
        } else if (subject.startsWith('relay.human.console.')) {
          const existing = responseChunksBySubject.get(subject) ?? [];
          existing.push(msg);
          responseChunksBySubject.set(subject, existing);
        }
      }

      // Build per-request from subjects (dead letter envelope or inferred from pattern)
      const fromSubjects = new Map<string, string>();
      for (const req of requests) {
        const dl = deadLetters.find((d) => d.messageId === req.id);
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

      // Collect all unique subjects (to + from) and resolve labels
      const toSubjects = messages.messages.map((m) => m.subject);
      const allSubjects = [...toSubjects, ...fromSubjects.values()];
      const vaultRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../',
      );
      const resolverDeps = {
        getSession: async (id: string) =>
          transcriptReader.getSession(vaultRoot, id),
        readManifest: async (cwd: string) => readManifest(cwd),
      };
      const labelMap = await resolveSubjectLabels(allSubjects, resolverDeps);

      // Build conversations from requests
      const conversations = requests.map((req) => {
        const subject = req.subject;
        const messageId = req.id;
        const status = req.status;
        const createdAt = req.createdAt;

        const sessionId = subject.startsWith('relay.agent.')
          ? subject.slice('relay.agent.'.length)
          : undefined;

        const deadLetter = deadLetters.find(
          (dl) => dl.messageId === messageId,
        );

        const fromSubject = fromSubjects.get(messageId) ?? '';

        // Find response chunks by matching the request's replyTo/from
        const responseChunks =
          responseChunksBySubject.get(fromSubject) ?? [];
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
              ? text.slice(0, 120)
              : JSON.stringify(payload).slice(0, 120);
        }

        const fromLabel = labelMap.get(fromSubject) ?? {
          label: 'Unknown',
          raw: fromSubject,
        };
        const toLabel = labelMap.get(subject) ?? {
          label: subject,
          raw: subject,
        };

        return {
          id: messageId,
          direction: 'outbound' as const,
          status:
            status === 'delivered'
              ? ('delivered' as const)
              : status === 'failed'
                ? ('failed' as const)
                : ('pending' as const),
          from: fromLabel,
          to: toLabel,
          preview,
          payload,
          responseCount: responseChunks.length,
          sentAt: createdAt,
          completedAt: lastChunk?.createdAt as string | undefined,
          durationMs: lastChunk
            ? new Date(lastChunk.createdAt as string).getTime() -
              new Date(createdAt).getTime()
            : undefined,
          subject,
          sessionId,
          traceId: messageId,
          failureReason: deadLetter?.reason as string | undefined,
        };
      });

      return res.json({ conversations });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to build conversations';
      return res.status(500).json({ error: message });
    }
  });

  // GET /messages/:id — Get single message
  router.get('/messages/:id', (_req, res) => {
    const message = relayCore.getMessage(_req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.json(message);
  });

  // GET /endpoints — List registered endpoints
  router.get('/endpoints', (_req, res) => {
    const endpoints = relayCore.listEndpoints();
    return res.json(endpoints);
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

  // DELETE /endpoints/:subject — Unregister endpoint
  router.delete('/endpoints/:subject', async (req, res) => {
    const removed = await relayCore.unregisterEndpoint(req.params.subject);
    if (!removed) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    return res.json({ success: true });
  });

  // GET /endpoints/:subject/inbox — Read inbox for a specific endpoint
  router.get('/endpoints/:subject/inbox', (_req, res) => {
    const result = InboxQuerySchema.safeParse(_req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const messages = relayCore.readInbox(_req.params.subject, result.data);
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

  // GET /metrics — Relay system metrics (from RelayCore)
  router.get('/metrics', (_req, res) => {
    const metrics = relayCore.getMetrics();
    return res.json(metrics);
  });

  // GET /messages/:id/trace — Full trace for a message
  router.get('/messages/:id/trace', (_req, res) => {
    if (!traceStore) {
      return res.status(404).json({ error: 'Tracing not available' });
    }
    const span = traceStore.getSpanByMessageId(_req.params.id);
    if (!span) {
      return res.status(404).json({ error: 'Trace not found' });
    }
    const spans = traceStore.getTrace(span.traceId);
    return res.json({ traceId: span.traceId, spans });
  });

  // GET /trace/metrics — Aggregate delivery metrics from TraceStore
  router.get('/trace/metrics', (_req, res) => {
    if (!traceStore) {
      return res.status(404).json({ error: 'Tracing not available' });
    }
    const metrics = traceStore.getMetrics();
    return res.json(metrics);
  });

  // GET /stream — SSE event stream with server-side subject filtering
  router.get('/stream', (req, res) => {
    const pattern = (req.query.subject as string) || '>';

    initSSEStream(res);

    // Send connected event
    res.write(`event: relay_connected\n`);
    res.write(`data: ${JSON.stringify({ pattern, connectedAt: new Date().toISOString() })}\n\n`);

    // Subscribe to messages matching pattern
    const unsubMessages = relayCore.subscribe(pattern, (envelope) => {
      res.write(`id: ${envelope.id}\n`);
      res.write(`event: relay_message\n`);
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    });

    // Subscribe to signals (dead letters, backpressure)
    const unsubSignals = relayCore.onSignal(pattern, (_subject, signal) => {
      const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(signal)}\n\n`);
    });

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
      res.write(`: keepalive\n\n`);
    }, 15_000);

    // Cleanup on connection close
    req.on('close', () => {
      clearInterval(keepalive);
      unsubMessages();
      unsubSignals();
    });
  });

  // --- Adapter Management Routes ---
  if (adapterManager) {
    // GET /adapters/catalog must be defined before /:id routes to avoid param collision
    router.get('/adapters/catalog', (_req, res) => {
      try {
        const catalog = adapterManager.getCatalog();
        res.json(catalog);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to retrieve adapter catalog';
        res.status(500).json({ error: message });
      }
    });

    // POST /adapters/reload must be defined before /:id routes to avoid param collision
    router.post('/adapters/reload', async (_req, res) => {
      try {
        await adapterManager.reload();
        return res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reload failed';
        return res.status(500).json({ error: message });
      }
    });

    // GET /adapters — List all adapters with status
    router.get('/adapters', (_req, res) => {
      const adapters = adapterManager.listAdapters();
      return res.json(adapters);
    });

    // GET /adapters/:id — Get single adapter status
    router.get('/adapters/:id', (req, res) => {
      const adapter = adapterManager.getAdapter(req.params.id);
      if (!adapter) return res.status(404).json({ error: 'Adapter not found' });
      return res.json(adapter);
    });

    // POST /adapters/test — Test adapter connection (must be before /:id routes)
    router.post('/adapters/test', async (req, res) => {
      const { type, config } = req.body as { type?: string; config?: Record<string, unknown> };
      if (!type || !config) {
        return res.status(400).json({ error: 'Missing required fields: type, config' });
      }
      try {
        const result = await adapterManager.testConnection(type, config);
        return res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Test failed';
        return res.status(500).json({ error: message });
      }
    });

    // POST /adapters — Create a new adapter
    router.post('/adapters', async (req, res) => {
      const { type, id, config, enabled } = req.body as {
        type?: string;
        id?: string;
        config?: Record<string, unknown>;
        enabled?: boolean;
      };
      if (!type || !id || !config) {
        return res.status(400).json({ error: 'Missing required fields: type, id, config' });
      }
      try {
        await adapterManager.addAdapter(type, id, config, enabled);
        return res.status(201).json({ ok: true, id });
      } catch (err) {
        if (err instanceof AdapterError) {
          const statusMap: Record<string, number> = {
            DUPLICATE_ID: 409,
            UNKNOWN_TYPE: 400,
            MULTI_INSTANCE_DENIED: 400,
            NOT_FOUND: 404,
            REMOVE_BUILTIN_DENIED: 400,
          };
          return res.status(statusMap[err.code] ?? 500).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : 'Create failed';
        return res.status(500).json({ error: message });
      }
    });

    // DELETE /adapters/:id — Remove an adapter
    router.delete('/adapters/:id', async (req, res) => {
      try {
        await adapterManager.removeAdapter(req.params.id);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof AdapterError) {
          const statusMap: Record<string, number> = {
            NOT_FOUND: 404,
            REMOVE_BUILTIN_DENIED: 400,
          };
          return res.status(statusMap[err.code] ?? 500).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : 'Remove failed';
        return res.status(500).json({ error: message });
      }
    });

    // PATCH /adapters/:id/config — Update adapter config
    router.patch('/adapters/:id/config', async (req, res) => {
      const { config } = req.body as { config?: Record<string, unknown> };
      if (!config) {
        return res.status(400).json({ error: 'Missing required field: config' });
      }
      try {
        await adapterManager.updateConfig(req.params.id, config);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof AdapterError) {
          const statusMap: Record<string, number> = {
            NOT_FOUND: 404,
          };
          return res.status(statusMap[err.code] ?? 500).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : 'Update failed';
        return res.status(500).json({ error: message });
      }
    });

    // POST /adapters/:id/enable — Enable adapter
    router.post('/adapters/:id/enable', async (req, res) => {
      try {
        await adapterManager.enable(req.params.id);
        return res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Enable failed';
        return res.status(400).json({ error: message });
      }
    });

    // POST /adapters/:id/disable — Disable adapter
    router.post('/adapters/:id/disable', async (req, res) => {
      try {
        await adapterManager.disable(req.params.id);
        return res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Disable failed';
        return res.status(400).json({ error: message });
      }
    });

    // --- Binding Management Routes ---

    // GET /bindings — List all adapter-agent bindings
    router.get('/bindings', (_req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }
      return res.json({ bindings: bindingStore.getAll() });
    });

    // GET /bindings/:id — Get a single binding
    router.get('/bindings/:id', (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }
      const binding = bindingStore.getById(req.params.id);
      if (!binding) {
        return res.status(404).json({ error: 'Binding not found' });
      }
      return res.json({ binding });
    });

    // POST /bindings — Create a new binding
    router.post('/bindings', async (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }
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

    // DELETE /bindings/:id — Delete a binding
    router.delete('/bindings/:id', async (req, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }
      const deleted = await bindingStore.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Binding not found' });
      }

      // Clean up orphaned session mappings for the deleted binding
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
      if (!adapter) {
        return res.status(404).json({ error: 'Adapter not running' });
      }

      const webhookAdapter = adapter as WebhookAdapter;
      const result = await webhookAdapter.handleInbound(
        req.body as Buffer,
        req.headers as Record<string, string | string[] | undefined>,
      );

      if (result.ok) {
        return res.status(200).json({ ok: true });
      }
      return res.status(401).json({ error: result.error });
    });
  }

  return router;
}
