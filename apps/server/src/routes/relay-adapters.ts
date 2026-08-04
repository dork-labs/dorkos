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
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { WebhookAdapter } from '@dorkos/relay';
import {
  CreateBindingRequestSchema,
  UpdateBindingRequestSchema,
  MoveBindingRequestSchema,
  AdapterTestRequestSchema,
  AdapterCreateRequestSchema,
  AdapterConfigUpdateSchema,
  bridgeAllowsChatId,
  BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
} from '@dorkos/shared/relay-schemas';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import { broadcastBindingsChanged } from '../services/relay/relay-sse-events.js';
import { BindingConflictError, type BindingUpdate } from '../services/relay/binding-store.js';
import { RoomError } from '../services/rooms/room-errors.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import type { ActivityService } from '../services/activity/activity-service.js';

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

/** Resolve a human-readable name for an adapter, falling back to its ID. */
function resolveAdapterName(adapterManager: AdapterManager, adapterId: string): string {
  const info = adapterManager.getAdapter(adapterId);
  return info?.config.label || info?.config.id || adapterId;
}

/**
 * The reason a non-DM binding cannot be bridged from the detail sheet yet.
 * User-facing (writing-for-humans): says what works and what does not.
 */
const BRIDGE_NON_DM_REASON =
  'Right now you can bridge a one-to-one chat into a channel. A group or broadcast ' +
  "chat can't be bridged from here yet: on Telegram a broadcast channel looks exactly " +
  'like a group once it reaches us, so we cannot yet tell them apart to keep a broadcast out.';

/**
 * The platform chat type a bridge needs from a stored binding, or a refusal when
 * the binding cannot be **proven** to be a two-way conversation.
 *
 * The "Bridge to a channel" action fires against a stored binding with no live
 * message in hand. A live message carries the raw platform type on
 * `platformData.chatType`, but that is deliberately **not persisted**: the
 * unclaimed-chat store and trace store both fold it into the subject-level
 * `channelType` (dm/group), and `isGroupChat` folds a Telegram broadcast
 * (`chat.type === 'channel'`) into `channelType: 'group'`
 * (`packages/relay/src/adapters/telegram/inbound.ts:355`). So a stored **group**
 * binding is byte-identical to a stored **broadcast** binding, and neither the
 * binding nor anything it derives from records which it is.
 *
 * A broadcast is not a conversation and must not be bridged (spec §3.3, A3.7).
 * The only stored binding we can prove is not a broadcast is a **DM** — a private
 * chat cannot be a broadcast. So from this entry point a DM bridges as `private`
 * and everything else is refused, rather than fabricating a `group` type that
 * would sail a broadcast straight past `createBridgedRoom`'s refusal. Enabling
 * group bridging here waits on persisting the raw platform chat type through
 * binding creation (DOR-907).
 *
 * @param channelType - The stored binding's subject-level channel type.
 * @returns The `private` chat type for a DM, or a `refusal` reason otherwise.
 */
function bridgeChatTypeForBinding(
  channelType: string | null | undefined
): { chatType: 'private' } | { refusal: string } {
  if (channelType == null || channelType === 'dm') return { chatType: 'private' };
  return { refusal: BRIDGE_NON_DM_REASON };
}

/** Map a {@link RoomError} raised while bridging to its HTTP status. */
const BRIDGE_ROOM_ERROR_STATUS: Record<string, number> = {
  BROADCAST_NOT_BRIDGEABLE: 400,
  UNKNOWN_CHAT_TYPE: 400,
  OPERATOR_ONLY: 403,
  SLUG_TAKEN: 409,
  ROOM_NOT_FOUND: 404,
  ROOM_ARCHIVED: 409,
};

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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    const { type, id, config, enabled, label: topLabel } = result.data;
    // The client may embed label inside config (Transport interface doesn't have a separate
    // label param). Fall back to config.label if the top-level field wasn't provided.
    const label = topLabel ?? (typeof config.label === 'string' ? config.label : undefined);
    try {
      await adapterManager.addAdapter(type, id, config, enabled, label);

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        const adapterName = adapterManager.resolveAdapterName(id);
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'relay',
          eventType: 'relay.adapter_added',
          resourceType: 'adapter',
          resourceId: id,
          resourceLabel: adapterName,
          summary: `Added ${adapterName} adapter`,
          linkPath: '/',
        });
      }

      return res.status(201).json({ ok: true, id });
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(res, err);
      const message = err instanceof Error ? err.message : 'Create failed';
      return res.status(500).json({ error: message });
    }
  });

  router.delete('/adapters/:id', async (req, res) => {
    try {
      // Capture name before removal since the config will be deleted
      const adapterName = adapterManager.resolveAdapterName(req.params.id);
      await adapterManager.removeAdapter(req.params.id);

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'relay',
          eventType: 'relay.adapter_removed',
          resourceType: 'adapter',
          resourceId: req.params.id,
          resourceLabel: adapterName,
          summary: `Removed ${adapterName} adapter`,
        });
      }

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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    // Validate adapter exists
    const adapterExists = adapterManager.getAdapter(result.data.adapterId);
    if (!adapterExists) {
      return res.status(400).json({
        error: `Adapter '${result.data.adapterId}' not found`,
      });
    }

    // Validate agent exists in mesh registry
    const meshCore = adapterManager.getMeshCore();
    if (meshCore && result.data.agentId) {
      const projectPath = meshCore.getProjectPath(result.data.agentId);
      if (!projectPath) {
        return res.status(400).json({
          error: `Agent '${result.data.agentId}' not found in mesh registry`,
        });
      }
    }

    try {
      const binding = await bindingStore.create(result.data);

      // Push a freshness signal so other clients/tabs re-fetch their binding list.
      broadcastBindingsChanged();

      // Fire-and-forget activity event for binding creation
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        const adapterName = resolveAdapterName(adapterManager, binding.adapterId);
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.binding_created',
          resourceType: 'binding',
          resourceId: binding.id,
          resourceLabel: `${binding.agentId} \u2192 ${binding.adapterId}`,
          summary: `Created binding: ${binding.agentId} \u2192 ${adapterName}`,
          linkPath: '/',
        });
      }

      return res.status(201).json({ binding });
    } catch (err) {
      // "One chat, one agent" (connection-scoping spec §Part 2): a
      // `(adapterId, chatId)` collision is a 409, carrying the conflicting
      // binding so the client can offer a move rather than a bare rejection.
      if (err instanceof BindingConflictError) {
        return res.status(409).json({
          error: err.message,
          code: 'CHAT_ALREADY_BOUND',
          conflict: {
            bindingId: err.conflict.id,
            agentId: err.conflict.agentId,
            label: err.conflict.label,
          },
        });
      }
      const message = err instanceof Error ? err.message : 'Create failed';
      return res.status(500).json({ error: message });
    }
  });

  /**
   * Re-point an existing binding to a different agent (connection-scoping
   * spec §Part 2 Move semantics) — the client's answer to "This chat reaches
   * X. Move it to Y?" after a 409 above. Clears the binding's stale session
   * mappings (created under the OLD agent's project) so the next inbound
   * message starts fresh under the new one.
   */
  router.post('/bindings/:id/move', async (req, res) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });
    const result = MoveBindingRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }

    const meshCore = adapterManager.getMeshCore();
    if (meshCore && !meshCore.getProjectPath(result.data.agentId)) {
      return res.status(400).json({
        error: `Agent '${result.data.agentId}' not found in mesh registry`,
      });
    }

    const moved = await bindingStore.moveToAgent(req.params.id, result.data.agentId);
    if (!moved) return res.status(404).json({ error: 'Binding not found' });

    const bindingRouter = adapterManager.getBindingRouter();
    if (bindingRouter) await bindingRouter.clearSessionsForBinding(moved.id);

    broadcastBindingsChanged();

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      const adapterName = resolveAdapterName(adapterManager, moved.adapterId);
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.binding_updated',
        resourceType: 'binding',
        resourceId: moved.id,
        resourceLabel: `${moved.agentId} → ${moved.adapterId}`,
        summary: `Moved binding: ${moved.chatId ?? moved.adapterId} → ${adapterName} (${moved.agentId})`,
        linkPath: '/',
      });
    }

    return res.json({ binding: moved });
  });

  router.patch('/bindings/:id', async (req, res) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) {
      return res.status(503).json({ error: 'Binding subsystem not available' });
    }

    const result = UpdateBindingRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }

    // `bridge: 'room'` requires a `chatId` (spec §3.1), but a PATCH body is
    // partial — the update may set `bridge` without resending `chatId`, or
    // clear `chatId` without touching `bridge`. Checked against the MERGED
    // state, which `AdapterBindingSchema`'s own refinement cannot see because
    // it only ever validates a full object.
    const existing = bindingStore.getById(req.params.id);
    if (existing) {
      const mergedBridge = result.data.bridge ?? existing.bridge;
      const mergedChatId = result.data.chatId !== undefined ? result.data.chatId : existing.chatId;
      if (!bridgeAllowsChatId({ bridge: mergedBridge, chatId: mergedChatId })) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE },
        });
      }
    }

    // Flipping `bridge` is not a plain field write: turning it on mints the
    // channel, adopts any live session, and only then sets `bridge`/`roomId`;
    // turning it off archives the room first (spec §3.1–§3.5). That coordination
    // is `BridgeLifecycle`'s, and this route is its first caller (DOR-878). A
    // bare `bindingStore.update({ bridge: 'room' })` would flip a flag over no
    // room — the exact "flag over a half-built room" §3.2 forbids — so a bridge
    // TRANSITION is routed through the lifecycle here, and `bridge`/`roomId` are
    // never written to the store directly from a client PATCH.
    const lifecycle = adapterManager.getBridgeLifecycle?.();
    const wantBridge = result.data.bridge;
    const bridgingOn =
      !!lifecycle && !!existing && wantBridge === 'room' && existing.bridge !== 'room';
    const bridgingOff =
      !!lifecycle && !!existing && wantBridge === 'off' && existing.bridge === 'room';

    // Convert null to undefined for clearing optional fields; absent fields
    // are dropped so they don't clobber existing values in the store's spread.
    // `roomId` is exempt: it is nullable, not optional, and `null` is its
    // valid persisted "not bridged" value (`BindingUpdate`'s doc explains why
    // converting it would be wrong, not merely redundant).
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.data)) {
      if (value !== undefined) {
        updates[key] = key === 'roomId' ? value : value === null ? undefined : value;
      }
    }
    // The lifecycle owns `bridge`/`roomId` on a transition, so never let them
    // also ride the direct-write path — that would double-write, or (with no
    // transition) let a client set `roomId` by hand.
    if (bridgingOn || bridgingOff) {
      delete updates.bridge;
      delete updates.roomId;
    }

    let updated: Awaited<ReturnType<typeof bindingStore.update>>;

    if (bridgingOn && existing && lifecycle) {
      // A bridged binding must carry a `chatId` — the merged-state check above
      // already refused a wildcard, so this is present. The platform title is
      // reconstructed from the binding (no inbound message is in hand); the
      // room half sanitizes it (spec §9.2).
      const chatId = existing.chatId;
      if (!chatId) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE },
        });
      }
      // Refuse anything we cannot prove is a two-way chat: a stored group binding
      // is indistinguishable from a folded Telegram broadcast, and a broadcast
      // must not be bridged (spec §3.3, A3.7). Only a DM is provably safe. This
      // runs BEFORE the lifecycle, so a refused binding is left untouched.
      const typed = bridgeChatTypeForBinding(existing.channelType);
      if ('refusal' in typed) {
        return res.status(400).json({ error: typed.refusal, code: 'BRIDGE_NOT_A_DM' });
      }
      const agentPath = adapterManager.getMeshCore()?.getProjectPath(existing.agentId);
      if (!agentPath) {
        return res.status(400).json({
          error: `Agent '${existing.agentId}' not found in mesh registry`,
        });
      }
      try {
        await lifecycle.bridge({
          adapterId: existing.adapterId,
          chatId,
          bindingId: existing.id,
          agentId: existing.agentId,
          // A DM: `private` chat type, and no subject-level channel type (§3.3).
          chatType: typed.chatType,
          channelType: null,
          title: existing.label || chatId,
          agentPath,
        });
      } catch (err) {
        if (err instanceof RoomError) {
          const status = BRIDGE_ROOM_ERROR_STATUS[err.code] ?? 500;
          return res.status(status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : 'Bridge failed';
        return res.status(500).json({ error: message });
      }
      // The lifecycle already flipped `bridge`/`roomId`; apply any other fields
      // the same PATCH carried on top, then read back the fully-updated row.
      if (Object.keys(updates).length > 0) {
        await bindingStore.update(existing.id, updates as BindingUpdate);
      }
      updated = bindingStore.getById(existing.id);
    } else if (bridgingOff && existing && lifecycle) {
      await lifecycle.unbridge(existing.id);
      if (Object.keys(updates).length > 0) {
        await bindingStore.update(existing.id, updates as BindingUpdate);
      }
      updated = bindingStore.getById(existing.id);
    } else {
      try {
        updated = await bindingStore.update(req.params.id, updates as BindingUpdate);
      } catch (err) {
        // "One chat, one agent": changing `chatId` onto a value another binding
        // already owns is the same 409 the create path gives (see above).
        if (err instanceof BindingConflictError) {
          return res.status(409).json({
            error: err.message,
            code: 'CHAT_ALREADY_BOUND',
            conflict: {
              bindingId: err.conflict.id,
              agentId: err.conflict.agentId,
              label: err.conflict.label,
            },
          });
        }
        // The store re-validates the MERGED result independently of the
        // pre-check above (any in-process caller can reach `update`, not just
        // this route) — so a drift between the two checks lands here rather
        // than as an unhandled 500.
        const message = err instanceof Error ? err.message : 'Update failed';
        return res.status(400).json({ error: 'Validation failed', details: { message } });
      }
    }
    if (!updated) {
      return res.status(404).json({ error: 'Binding not found' });
    }

    // Push a freshness signal so other clients/tabs re-fetch their binding list.
    broadcastBindingsChanged();

    // Fire-and-forget activity event for binding update
    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      const adapterName = resolveAdapterName(adapterManager, updated.adapterId);
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.binding_updated',
        resourceType: 'binding',
        resourceId: updated.id,
        resourceLabel: `${updated.agentId} \u2192 ${updated.adapterId}`,
        summary: `Updated binding: ${updated.agentId} \u2192 ${adapterName}`,
        linkPath: '/',
      });
    }

    return res.json({ binding: updated });
  });

  router.delete('/bindings/:id', async (req, res) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });

    // Capture binding metadata before deletion for the activity event
    const binding = bindingStore.getById(req.params.id);

    const deleted = await bindingStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Binding not found' });
    const bindingRouter = adapterManager.getBindingRouter();
    if (bindingRouter) {
      const activeBindingIds = new Set(bindingStore.getAll().map((b) => b.id));
      await bindingRouter.cleanupOrphanedSessions(activeBindingIds);
    }

    // Push a freshness signal so other clients/tabs re-fetch their binding list.
    broadcastBindingsChanged();

    // Fire-and-forget activity event for binding deletion
    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService && binding) {
      const adapterName = resolveAdapterName(adapterManager, binding.adapterId);
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.binding_deleted',
        resourceType: 'binding',
        resourceId: req.params.id,
        summary: `Deleted binding: ${binding.agentId} \u2192 ${adapterName}`,
      });
    }

    return res.json({ ok: true });
  });

  // Rate limiter for binding test endpoint — 10 tests per minute per IP
  const testRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many test requests, try again in a minute' },
  });

  // POST /bindings/:id/test — Synthetic routing test probe
  router.post(
    '/bindings/:id/test',
    testRateLimiter,
    async (req: express.Request<{ id: string }>, res) => {
      const bindingStore = adapterManager.getBindingStore();
      if (!bindingStore) {
        return res.status(503).json({ error: 'Binding subsystem not available' });
      }

      const binding = bindingStore.getById(req.params.id);
      if (!binding) {
        return res.status(404).json({ error: 'Binding not found' });
      }

      if (binding.enabled === false) {
        return res.status(409).json({
          error: 'Binding is paused. Resume to run a test.',
        });
      }

      const bindingRouter = adapterManager.getBindingRouter();
      if (!bindingRouter) {
        return res.status(503).json({ error: 'Binding router not available' });
      }

      try {
        const result = bindingRouter.testBinding(binding.id);

        return res.json({
          ok: result.ok,
          resolved: result.resolved,
          latencyMs: result.latencyMs,
          wouldDeliverTo: result.wouldDeliverTo,
          reason: result.reason,
          details: result.details,
        });
      } catch (err) {
        return res.status(500).json({
          error: err instanceof Error ? err.message : 'Internal routing error',
        });
      }
    }
  );

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
    return res.status(result.status ?? 401).json({ error: result.error });
  });

  return router;
}
