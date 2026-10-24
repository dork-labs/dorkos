/**
 * Relay adapter management routes — CRUD, enable/disable, events, chats and
 * bindings for external channel adapters.
 *
 * Extracted from {@link module:routes/relay} to keep route files under 500 lines.
 *
 * ## Who the Activity feed says changed a connection or a route
 *
 * Every Activity write here reads the caller (`readActivityActor`) rather than
 * asserting the person did it. Until DOR-1829 all six hardcoded `user` / `'You'`,
 * so an agent adding a Telegram connection or re-pointing somebody's chat route
 * showed up in the operator's own feed as their own action.
 *
 * No person bar was added, deliberately. `binding_create`, `binding_delete`,
 * `relay_enable_adapter` and `relay_disable_adapter` are all tier `act` in
 * `MCP_TOOL_TIERS` — the repo has already decided an agent may do this work —
 * and unlike the extensions toggles (DOR-1507) none of it writes a leaf of the
 * `operator-only` `extensions` section of `~/.dork/config.json`; adapters and
 * bindings live in Relay's own store. Barring the HTTP door would refuse what
 * the MCP door grants, which is a policy change rather than an attribution fix.
 *
 * @module routes/relay-adapters
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { honoRateLimit } from '../http/rate-limiter.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { validationFailureBody } from '../lib/route-utils.js';
import {
  CreateBindingRequestSchema,
  UpdateBindingRequestSchema,
  MoveBindingRequestSchema,
  AdapterTestRequestSchema,
  AdapterCreateRequestSchema,
  AdapterConfigUpdateSchema,
  bridgeAllowsChatId,
  BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
  type PlatformChatType,
} from '@dorkos/shared/relay-schemas';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import { broadcastBindingsChanged } from '../services/relay/relay-sse-events.js';
import { BindingConflictError, type BindingUpdate } from '../services/relay/binding-store.js';
import { RoomError } from '../services/rooms/room-errors.js';
import { ADAPTER_EVENTS_KEPT, type TraceStore } from '../services/relay/trace-store.js';
import { sendAdapterError, secretWriter } from './relay-adapter-http.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';

/** Resolve a human-readable name for an adapter, falling back to its ID. */
function resolveAdapterName(adapterManager: AdapterManager, adapterId: string): string {
  const info = adapterManager.getAdapter(adapterId);
  return info?.config.label || info?.config.id || adapterId;
}

/**
 * The reason a proven broadcast cannot be bridged. User-facing
 * (writing-for-humans): says what this chat is and why it can't become a
 * channel.
 */
const BRIDGE_BROADCAST_REASON =
  "This is a broadcast channel, not a two-way chat, so it can't become a " +
  'channel here: your agent would have no one to reply to, and a broadcast is a one-way ' +
  'feed by design.';

/**
 * The reason a binding whose platform type we never recorded cannot be bridged
 * unless it is a one-to-one chat. Old bindings (created before DOR-907) and
 * bindings made outside the claim flow carry no platform type; we bridge only
 * what we can prove is safe.
 */
const BRIDGE_UNKNOWN_TYPE_REASON =
  'We connected this chat before we started noting whether it is a one-to-one, a group, ' +
  "or a broadcast, so we can't safely turn it into a channel: a broadcast must never be " +
  'bridged, and from here we cannot yet rule that out. Re-connect this chat from a new ' +
  'message and it will carry what it is.';

/** The refusal codes {@link bridgeChatTypeForBinding} can return. */
type BridgeRefusalCode = 'BROADCAST_NOT_BRIDGEABLE' | 'BRIDGE_NOT_A_DM';

/**
 * The platform chat type and subject channel type a bridge needs from a stored
 * binding, or a precise refusal when the binding must not be bridged.
 *
 * The "Bridge to a channel" action fires against a stored binding with no live
 * message in hand. A binding now persists the RAW platform chat type it was
 * created from (`platformChatType`, DOR-907), captured through the claim feed
 * from `platformData.chatType`, so this can tell the cases apart that the
 * subject-level `channelType` folds together (a broadcast `channel` and a
 * `group` both arrive as `channelType: 'group'`):
 *
 * Exported so the claim route's "Answer in a channel" primary action
 * (DOR-882) can resolve the same `chatType`/`channelType` for the freshly
 * created binding it bridges — one resolution rule, not two.
 *
 * - `private` → bridges as a DM (`private`, no subject channel type).
 * - `group`/`supergroup` → bridges as a channel, mention-only-seeded by
 *   `createBridgedRoom` (spec §3.4). Now allowed, where DOR-878 refused it.
 * - `channel` → **refused** as `BROADCAST_NOT_BRIDGEABLE`: a broadcast is not a
 *   conversation and must never be bridged (spec §3.3, A3.7).
 * - **absent/unknown** (an old binding, or one made outside the claim flow) →
 *   the conservative DM-only rule: only a `channelType` of `dm` (a chat that
 *   cannot be a broadcast) bridges, everything else is refused as
 *   `BRIDGE_NOT_A_DM`. We never bridge a non-DM we cannot prove is a group.
 *
 * @param platformChatType - The binding's persisted raw platform chat type, or
 *   `undefined` when it carries none.
 * @param channelType - The binding's subject-level channel type, used only in
 *   the conservative fallback when `platformChatType` is absent.
 * @returns The resolved `chatType`/`channelType` to bridge with, or a `refusal`
 *   reason and its `code`.
 */
export function bridgeChatTypeForBinding(
  platformChatType: PlatformChatType | undefined,
  channelType: string | null | undefined
):
  | { chatType: PlatformChatType; channelType: 'group' | null }
  | { refusal: string; code: BridgeRefusalCode } {
  switch (platformChatType) {
    case 'private':
      return { chatType: 'private', channelType: null };
    case 'group':
    case 'supergroup':
      return { chatType: platformChatType, channelType: 'group' };
    case 'channel':
      return { refusal: BRIDGE_BROADCAST_REASON, code: 'BROADCAST_NOT_BRIDGEABLE' };
    default:
      // No persisted platform type: fall back to the DM-only rule DOR-878
      // shipped. A `dm` (or absent) subject channel type is the only stored
      // shape provably not a broadcast; anything else is refused rather than
      // risk bridging a broadcast we cannot rule out.
      if (channelType == null || channelType === 'dm') {
        return { chatType: 'private', channelType: null };
      }
      return { refusal: BRIDGE_UNKNOWN_TYPE_REASON, code: 'BRIDGE_NOT_A_DM' };
  }
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

/** What the connection routes read. */
export interface AdapterRouteDeps {
  /** Adapter lifecycle manager for external channel adapters. */
  adapterManager: AdapterManager;
  /** Optional trace store for adapter event and chat tracking. */
  traceStore?: TraceStore;
  /** Where connection and chat-route changes are recorded. */
  activity?: ActivityService;
}

/**
 * The connection routes: catalog, CRUD, enable/disable, event log, chat
 * history and chat routes (bindings). Mounted under the Relay routes when an
 * {@link AdapterManager} is available, beside the webhook receiver
 * (`routes/relay-webhooks.ts`).
 *
 * @param deps - See {@link AdapterRouteDeps}.
 * @returns The routes.
 */
export function createAdapterRoutes(deps: AdapterRouteDeps): Hono<ApiEnv> {
  const { adapterManager, traceStore, activity } = deps;
  const router = new Hono<ApiEnv>();

  router.get('/adapters/catalog', (c) => {
    try {
      return c.json(adapterManager.getCatalog());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve adapter catalog';
      return c.json({ error: message }, 500);
    }
  });

  router.post('/adapters/reload', async (c) => {
    try {
      await adapterManager.reload();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reload failed';
      return c.json({ error: message }, 500);
    }
  });

  router.get('/adapters', (c) => c.json(adapterManager.listAdapters()));

  router.get('/adapters/:id', (c) => {
    const adapter = adapterManager.getAdapter(c.req.param('id'));
    if (!adapter) return c.json({ error: 'Adapter not found' }, 404);
    return c.json(adapter);
  });

  router.post('/adapters/test', async (c) => {
    const result = AdapterTestRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    try {
      const testResult = await adapterManager.testConnection(
        result.data.type,
        result.data.config,
        secretWriter(c)
      );
      return c.json(testResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed';
      return c.json({ error: message }, 500);
    }
  });

  router.post('/adapters', async (c) => {
    const result = AdapterCreateRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { type, id, config, enabled, label: topLabel } = result.data;
    // The client may embed label inside config (Transport interface doesn't have a separate
    // label param). Fall back to config.label if the top-level field wasn't provided.
    const label = topLabel ?? (typeof config.label === 'string' ? config.label : undefined);
    try {
      await adapterManager.addAdapter(type, id, config, enabled, label, secretWriter(c));

      if (activity) {
        const adapterName = adapterManager.resolveAdapterName(id);
        await activity.emit({
          ...readActivityActor(honoRequestFacts(c)),
          category: 'relay',
          eventType: 'relay.adapter_added',
          resourceType: 'adapter',
          resourceId: id,
          resourceLabel: adapterName,
          summary: `Added ${adapterName} adapter`,
          linkPath: '/',
        });
      }

      return c.json({ ok: true, id }, 201);
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(c, err);
      const message = err instanceof Error ? err.message : 'Create failed';
      return c.json({ error: message }, 500);
    }
  });

  router.delete('/adapters/:id', async (c) => {
    try {
      // Capture name before removal since the config will be deleted
      const adapterName = adapterManager.resolveAdapterName(c.req.param('id'));
      // A person removed it, so its delivery records and chat names go too
      // (DOR-2604), and so do the chats it recorded for the claim feed
      // (DOR-2608). Internal removals (package update, install rollback) keep them.
      await adapterManager.removeAdapter(c.req.param('id'), { forgetHistory: true });

      if (activity) {
        await activity.emit({
          ...readActivityActor(honoRequestFacts(c)),
          category: 'relay',
          eventType: 'relay.adapter_removed',
          resourceType: 'adapter',
          resourceId: c.req.param('id'),
          resourceLabel: adapterName,
          summary: `Removed ${adapterName} adapter`,
        });
      }

      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(c, err);
      const message = err instanceof Error ? err.message : 'Remove failed';
      return c.json({ error: message }, 500);
    }
  });

  router.patch('/adapters/:id/config', async (c) => {
    const result = AdapterConfigUpdateSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    try {
      await adapterManager.updateConfig(c.req.param('id'), result.data.config, secretWriter(c));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(c, err);
      const message = err instanceof Error ? err.message : 'Update failed';
      return c.json({ error: message }, 500);
    }
  });

  router.post('/adapters/:id/enable', async (c) => {
    try {
      await adapterManager.enable(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Enable failed' }, 400);
    }
  });

  router.post('/adapters/:id/disable', async (c) => {
    try {
      await adapterManager.disable(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Disable failed' }, 400);
    }
  });

  // GET /adapters/:id/events — Get adapter event log
  router.get('/adapters/:id/events', (c) => {
    if (!traceStore) return c.json({ error: 'Tracing not available' }, 404);
    const { id } = c.req.param();
    const limitParam = parseInt(readQuery(c).limit as string);
    // Bounded to what the store keeps per adapter (the Relay sweep drops the rest).
    const limit = Number.isNaN(limitParam)
      ? 100
      : Math.min(Math.max(limitParam, 1), ADAPTER_EVENTS_KEPT);
    const events = traceStore.getAdapterEvents(id, limit);
    return c.json({ events });
  });

  // GET /adapters/:id/chats — Observed chats from trace data
  router.get('/adapters/:id/chats', (c) => {
    if (!traceStore) return c.json({ error: 'Tracing not available' }, 404);
    const { id } = c.req.param();
    const limitParam = parseInt(readQuery(c).limit as string);
    const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
    const chats = traceStore.getObservedChats(id, limit);
    return c.json({ chats });
  });

  // --- Binding Management Routes ---
  router.get('/bindings', (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return c.json({ error: 'Binding subsystem not available' }, 503);
    return c.json({ bindings: bindingStore.getAll() });
  });

  router.get('/bindings/:id', (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return c.json({ error: 'Binding subsystem not available' }, 503);
    const binding = bindingStore.getById(c.req.param('id'));
    if (!binding) return c.json({ error: 'Binding not found' }, 404);
    return c.json({ binding });
  });

  router.post('/bindings', async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return c.json({ error: 'Binding subsystem not available' }, 503);
    const result = CreateBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    // Validate adapter exists
    const adapterExists = adapterManager.getAdapter(result.data.adapterId);
    if (!adapterExists) {
      return c.json(
        {
          error: `Adapter '${result.data.adapterId}' not found`,
        },
        400
      );
    }

    // Validate agent exists in mesh registry
    const meshCore = adapterManager.getMeshCore();
    if (meshCore && result.data.agentId) {
      const projectPath = meshCore.getProjectPath(result.data.agentId);
      if (!projectPath) {
        return c.json(
          {
            error: `Agent '${result.data.agentId}' not found in mesh registry`,
          },
          400
        );
      }
    }

    try {
      const binding = await bindingStore.create(result.data);

      // Push a freshness signal so other clients/tabs re-fetch their binding list.
      broadcastBindingsChanged();

      // Fire-and-forget activity event for binding creation
      if (activity) {
        const adapterName = resolveAdapterName(adapterManager, binding.adapterId);
        await activity.emit({
          ...readActivityActor(honoRequestFacts(c)),
          category: 'config',
          eventType: 'config.binding_created',
          resourceType: 'binding',
          resourceId: binding.id,
          resourceLabel: `${binding.agentId} \u2192 ${binding.adapterId}`,
          summary: `Created binding: ${binding.agentId} \u2192 ${adapterName}`,
          linkPath: '/',
        });
      }

      return c.json({ binding }, 201);
    } catch (err) {
      // "One chat, one agent" (connection-scoping spec §Part 2): a
      // `(adapterId, chatId)` collision is a 409, carrying the conflicting
      // binding so the client can offer a move rather than a bare rejection.
      if (err instanceof BindingConflictError) {
        return c.json(
          {
            error: err.message,
            code: 'CHAT_ALREADY_BOUND',
            conflict: {
              bindingId: err.conflict.id,
              agentId: err.conflict.agentId,
              label: err.conflict.label,
            },
          },
          409
        );
      }
      const message = err instanceof Error ? err.message : 'Create failed';
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Re-point an existing binding to a different agent (connection-scoping
   * spec §Part 2 Move semantics) — the client's answer to "This chat reaches
   * X. Move it to Y?" after a 409 above. Clears the binding's stale session
   * mappings (created under the OLD agent's project) so the next inbound
   * message starts fresh under the new one.
   */
  router.post('/bindings/:id/move', async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return c.json({ error: 'Binding subsystem not available' }, 503);
    const result = MoveBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }

    const meshCore = adapterManager.getMeshCore();
    if (meshCore && !meshCore.getProjectPath(result.data.agentId)) {
      return c.json(
        {
          error: `Agent '${result.data.agentId}' not found in mesh registry`,
        },
        400
      );
    }

    const moved = await bindingStore.moveToAgent(c.req.param('id'), result.data.agentId);
    if (!moved) return c.json({ error: 'Binding not found' }, 404);

    const bindingRouter = adapterManager.getBindingRouter();
    if (bindingRouter) await bindingRouter.clearSessionsForBinding(moved.id);

    broadcastBindingsChanged();

    if (activity) {
      const adapterName = resolveAdapterName(adapterManager, moved.adapterId);
      await activity.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.binding_updated',
        resourceType: 'binding',
        resourceId: moved.id,
        resourceLabel: `${moved.agentId} → ${moved.adapterId}`,
        summary: `Moved binding: ${moved.chatId ?? moved.adapterId} → ${adapterName} (${moved.agentId})`,
        linkPath: '/',
      });
    }

    return c.json({ binding: moved });
  });

  router.patch('/bindings/:id', async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) {
      return c.json({ error: 'Binding subsystem not available' }, 503);
    }

    const result = UpdateBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }

    // `bridge: 'room'` requires a `chatId` (spec §3.1), but a PATCH body is
    // partial — the update may set `bridge` without resending `chatId`, or
    // clear `chatId` without touching `bridge`. Checked against the MERGED
    // state, which `AdapterBindingSchema`'s own refinement cannot see because
    // it only ever validates a full object.
    const existing = bindingStore.getById(c.req.param('id'));
    if (existing) {
      const mergedBridge = result.data.bridge ?? existing.bridge;
      const mergedChatId = result.data.chatId !== undefined ? result.data.chatId : existing.chatId;
      if (!bridgeAllowsChatId({ bridge: mergedBridge, chatId: mergedChatId })) {
        return c.json(
          {
            error: 'Validation failed',
            details: { message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE },
          },
          400
        );
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
        return c.json(
          {
            error: 'Validation failed',
            details: { message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE },
          },
          400
        );
      }
      // Resolve what this binding bridges as from its persisted raw platform
      // type (DOR-907): a DM bridges private, a group/supergroup bridges as a
      // channel, a broadcast is refused precisely, and a binding with no
      // recorded type falls back to the conservative DM-only rule. Runs BEFORE
      // the lifecycle, so a refused binding is left untouched.
      const typed = bridgeChatTypeForBinding(existing.platformChatType, existing.channelType);
      if ('refusal' in typed) {
        return c.json({ error: typed.refusal, code: typed.code }, 400);
      }
      const agentPath = adapterManager.getMeshCore()?.getProjectPath(existing.agentId);
      if (!agentPath) {
        return c.json(
          {
            error: `Agent '${existing.agentId}' not found in mesh registry`,
          },
          400
        );
      }
      try {
        await lifecycle.bridge({
          adapterId: existing.adapterId,
          chatId,
          bindingId: existing.id,
          agentId: existing.agentId,
          // Resolved from the binding's persisted platform type: a DM bridges
          // `private` with no subject channel type; a group/supergroup bridges
          // with `channelType: 'group'`, which seeds the channel mention-only
          // (§3.3, §3.4).
          chatType: typed.chatType,
          channelType: typed.channelType,
          title: existing.label || chatId,
          agentPath,
        });
      } catch (err) {
        if (err instanceof RoomError) {
          const status = (BRIDGE_ROOM_ERROR_STATUS[err.code] ?? 500) as ContentfulStatusCode;
          return c.json({ error: err.message, code: err.code }, status);
        }
        const message = err instanceof Error ? err.message : 'Bridge failed';
        return c.json({ error: message }, 500);
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
        updated = await bindingStore.update(c.req.param('id'), updates as BindingUpdate);
      } catch (err) {
        // "One chat, one agent": changing `chatId` onto a value another binding
        // already owns is the same 409 the create path gives (see above).
        if (err instanceof BindingConflictError) {
          return c.json(
            {
              error: err.message,
              code: 'CHAT_ALREADY_BOUND',
              conflict: {
                bindingId: err.conflict.id,
                agentId: err.conflict.agentId,
                label: err.conflict.label,
              },
            },
            409
          );
        }
        // The store re-validates the MERGED result independently of the
        // pre-check above (any in-process caller can reach `update`, not just
        // this route) — so a drift between the two checks lands here rather
        // than as an unhandled 500.
        const message = err instanceof Error ? err.message : 'Update failed';
        return c.json({ error: 'Validation failed', details: { message } }, 400);
      }
    }
    if (!updated) {
      return c.json({ error: 'Binding not found' }, 404);
    }

    // Push a freshness signal so other clients/tabs re-fetch their binding list.
    broadcastBindingsChanged();

    // Fire-and-forget activity event for binding update
    if (activity) {
      const adapterName = resolveAdapterName(adapterManager, updated.adapterId);
      await activity.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.binding_updated',
        resourceType: 'binding',
        resourceId: updated.id,
        resourceLabel: `${updated.agentId} \u2192 ${updated.adapterId}`,
        summary: `Updated binding: ${updated.agentId} \u2192 ${adapterName}`,
        linkPath: '/',
      });
    }

    return c.json({ binding: updated });
  });

  router.delete('/bindings/:id', async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return c.json({ error: 'Binding subsystem not available' }, 503);

    // Capture binding metadata before deletion for the activity event
    const binding = bindingStore.getById(c.req.param('id'));

    const deleted = await bindingStore.delete(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Binding not found' }, 404);
    const bindingRouter = adapterManager.getBindingRouter();
    if (bindingRouter) {
      const activeBindingIds = new Set(bindingStore.getAll().map((b) => b.id));
      await bindingRouter.cleanupOrphanedSessions(activeBindingIds);
    }

    // Push a freshness signal so other clients/tabs re-fetch their binding list.
    broadcastBindingsChanged();

    // Fire-and-forget activity event for binding deletion
    if (activity && binding) {
      const adapterName = resolveAdapterName(adapterManager, binding.adapterId);
      await activity.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.binding_deleted',
        resourceType: 'binding',
        resourceId: c.req.param('id'),
        summary: `Deleted binding: ${binding.agentId} \u2192 ${adapterName}`,
      });
    }

    return c.json({ ok: true });
  });

  // Rate limiter for binding test endpoint — 10 tests per minute per caller.
  // Keys through the shared `rateLimitKey`, like every other limiter here: the
  // TCP peer address, not the spoofable `X-Forwarded-For` that `req.ip` derives
  // from `trust proxy` (DOR-1711).
  const testRateLimiter = honoRateLimit({
    windowMs: 60_000,
    limit: 10,
    headers: 'standard',
    message: { error: 'Too many test requests, try again in a minute' },
  });

  // POST /bindings/:id/test — Synthetic routing test probe
  router.post('/bindings/:id/test', testRateLimiter, async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) {
      return c.json({ error: 'Binding subsystem not available' }, 503);
    }

    const binding = bindingStore.getById(c.req.param('id'));
    if (!binding) {
      return c.json({ error: 'Binding not found' }, 404);
    }

    if (binding.enabled === false) {
      return c.json(
        {
          error: 'Binding is paused. Resume to run a test.',
        },
        409
      );
    }

    const bindingRouter = adapterManager.getBindingRouter();
    if (!bindingRouter) {
      return c.json({ error: 'Binding router not available' }, 503);
    }

    try {
      const result = bindingRouter.testBinding(binding.id);

      return c.json({
        ok: result.ok,
        resolved: result.resolved,
        latencyMs: result.latencyMs,
        wouldDeliverTo: result.wouldDeliverTo,
        reason: result.reason,
        details: result.details,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Internal routing error',
        },
        500
      );
    }
  });

  return router;
}
