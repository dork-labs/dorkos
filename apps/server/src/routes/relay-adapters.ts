/**
 * Relay adapter management routes — CRUD, enable/disable, events, chats,
 * bindings, and webhook ingestion for external channel adapters.
 *
 * Extracted from {@link module:routes/relay} to keep route files under 500 lines.
 *
 * @module routes/relay-adapters
 */
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import type { WebhookAdapter } from '@dorkos/relay';
import {
  CreateBindingRequestSchema,
  AdapterTestRequestSchema,
  AdapterCreateRequestSchema,
  AdapterConfigUpdateSchema,
  SessionStrategySchema,
  ChannelTypeSchema,
} from '@dorkos/shared/relay-schemas';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import type { TraceStore } from '../services/relay/trace-store.js';

/** Map adapter error codes to HTTP status codes. */
const ADAPTER_ERROR_STATUS: Record<string, number> = {
  DUPLICATE_ID: 409,
  UNKNOWN_TYPE: 400,
  MULTI_INSTANCE_DENIED: 400,
  NOT_FOUND: 404,
  REMOVE_BUILTIN_DENIED: 400,
};

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
 * Create a sub-router containing all adapter management endpoints.
 *
 * Mounts catalog, CRUD, enable/disable, event log, chat history, binding
 * management, and webhook ingestion routes. Intended to be mounted under the
 * relay router when an {@link AdapterManager} is available.
 *
 * @param adapterManager - Adapter lifecycle manager for external channel adapters
 * @param traceStore - Optional trace store for adapter event and chat tracking
 */
export function createAdapterRouter(
  adapterManager: AdapterManager,
  traceStore?: TraceStore
): Router {
  const router = Router();

  router.get('/adapters/catalog', (_req, res) => {
    try {
      res.json(adapterManager.getCatalog());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve adapter catalog';
      res.status(500).json({ error: message });
    }
  });

  router.post('/adapters/reload', async (_req, res) => {
    try {
      await adapterManager.reload();
      return res.json({ ok: true });
    } catch (err) {
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
    try {
      await adapterManager.enable(req.params.id);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Enable failed' });
    }
  });

  router.post('/adapters/:id/disable', async (req, res) => {
    try {
      await adapterManager.disable(req.params.id);
      return res.json({ ok: true });
    } catch (err) {
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
    if (
      !('handleInbound' in adapter) ||
      typeof (adapter as Record<string, unknown>).handleInbound !== 'function'
    ) {
      return res.status(500).json({ error: 'Adapter does not support webhook ingestion' });
    }
    const webhookAdapter = adapter as WebhookAdapter;
    const result = await webhookAdapter.handleInbound(
      req.body as Buffer,
      req.headers as Record<string, string | string[] | undefined>
    );
    if (result.ok) return res.status(200).json({ ok: true });
    return res.status(401).json({ error: result.error });
  });

  return router;
}
