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
 * What the MCP door cannot do is raise a route: `binding_create` takes no mode,
 * start-chats switch or bridge. So a chat-route write that raises what a route
 * may do, or points it at another chat or agent, waits for the owner to confirm
 * it's them (DOR-4355, `relay-binding-step-up.ts`); everything else runs at once.
 *
 * @module routes/relay-adapters
 */
import { Hono, type Context } from 'hono';
import { honoRateLimit } from '../http/rate-limiter.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  CreateBindingRequestSchema,
  UpdateBindingRequestSchema,
  MoveBindingRequestSchema,
  bridgeAllowsChatId,
  type AdapterBinding,
  type PlatformChatType,
} from '@dorkos/shared/relay-schemas';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import { broadcastBindingsChanged } from '../services/relay/relay-sse-events.js';
import {
  BindingChangedError,
  BindingConflictError,
  type BindingUpdate,
} from '../services/relay/binding-store.js';
import { sendRoomError } from './room-error-response.js';
import { ADAPTER_EVENTS_KEPT, type TraceStore } from '../services/relay/trace-store.js';
import {
  failedProblem,
  registerConfirmReferencesRoute,
  registerEnableRoute,
  sendAdapterError,
} from './relay-adapter-http.js';
import {
  BINDING_NOT_FOUND,
  BINDINGS_STARTING,
  BRIDGE_NEEDS_ONE_CHAT,
  CONNECTION_NOT_FOUND,
  TRACING_OFF,
  UNKNOWN_AGENT,
  chatAlreadyBound,
} from './relay-problems.js';
import { registerSettingRoutes } from './relay-adapter-setting-routes.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { bindingChanged, registerBindingWrites } from './relay-binding-step-up.js';

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

/** The problem codes {@link bridgeChatTypeForBinding} can refuse with. */
type BridgeRefusalCode = 'broadcast_not_bridgeable' | 'chat_type_unknown';

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
 * - `channel` → **refused** as `broadcast_not_bridgeable`: a broadcast is not a
 *   conversation and must never be bridged (spec §3.3, A3.7).
 * - **absent/unknown** (an old binding, or one made outside the claim flow) →
 *   the conservative DM-only rule: only a `channelType` of `dm` (a chat that
 *   cannot be a broadcast) bridges, everything else is refused as
 *   `chat_type_unknown`. We never bridge a non-DM we cannot prove is a group.
 *
 * @param platformChatType - The binding's persisted raw platform chat type, or
 *   `undefined` when it carries none.
 * @param channelType - The binding's subject-level channel type, used only in
 *   the conservative fallback when `platformChatType` is absent.
 * @returns The resolved `chatType`/`channelType` to bridge with, or a `refusal`
 *   reason (the claim card's note) and its problem `code`.
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
      return { refusal: BRIDGE_BROADCAST_REASON, code: 'broadcast_not_bridgeable' };
    default:
      // No persisted platform type: fall back to the DM-only rule DOR-878
      // shipped. A `dm` (or absent) subject channel type is the only stored
      // shape provably not a broadcast; anything else is refused rather than
      // risk bridging a broadcast we cannot rule out.
      if (channelType == null || channelType === 'dm') {
        return { chatType: 'private', channelType: null };
      }
      return { refusal: BRIDGE_UNKNOWN_TYPE_REASON, code: 'chat_type_unknown' };
  }
}

/** The short sentence each bridge refusal answers with; `refusal` is the claim card's longer note. */
const BRIDGE_REFUSAL_DETAIL: Record<BridgeRefusalCode, string> = {
  broadcast_not_bridgeable: 'A broadcast is a one-way feed, so it can’t become a channel.',
  chat_type_unknown: 'Connect this chat again from a new message, then try again.',
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
      logger.error('[relay] GET /adapters/catalog failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t list connections. Try again.' });
    }
  });

  router.post('/adapters/reload', async (c) => {
    try {
      await adapterManager.reload();
      return c.json({ ok: true });
    } catch (err) {
      logger.error('[relay] POST /adapters/reload failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t reload connections. Try again.' });
    }
  });

  router.get('/adapters', (c) => c.json(adapterManager.listAdapters()));

  router.get('/adapters/:id', (c) => {
    const adapter = adapterManager.getAdapter(c.req.param('id'));
    if (!adapter) return problem(c, 'not_found', { detail: CONNECTION_NOT_FOUND });
    return c.json(adapter);
  });

  // Test, add and save: held for "Confirm it's you" when they hand a
  // connection a person's setting (DOR-3234).
  registerSettingRoutes(router, { adapterManager, activity });

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
      return sendProblem(c, failedProblem(err, 'Couldn’t remove that connection. Try again.'));
    }
  });

  registerConfirmReferencesRoute(router, adapterManager);

  registerEnableRoute(router, adapterManager);

  router.post('/adapters/:id/disable', async (c) => {
    try {
      await adapterManager.disable(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(c, err);
      return sendProblem(c, failedProblem(err, 'Couldn’t turn that connection off. Try again.'));
    }
  });

  // GET /adapters/:id/events — Get adapter event log
  router.get('/adapters/:id/events', (c) => {
    if (!traceStore) return problem(c, 'not_found', { detail: TRACING_OFF });
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
    if (!traceStore) return problem(c, 'not_found', { detail: TRACING_OFF });
    const { id } = c.req.param();
    const limitParam = parseInt(readQuery(c).limit as string);
    const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
    const chats = traceStore.getObservedChats(id, limit);
    return c.json({ chats });
  });

  // --- Binding Management Routes ---
  router.get('/bindings', (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    return c.json({ bindings: bindingStore.getAll() });
  });

  router.get('/bindings/:id', (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    const binding = bindingStore.getById(c.req.param('id'));
    if (!binding) return problem(c, 'not_found', { detail: BINDING_NOT_FOUND });
    return c.json({ binding });
  });

  const createBinding = async (c: Context<ApiEnv>): Promise<Response> => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    const result = CreateBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return validationProblem(c, result.error);
    }
    // Validate adapter exists
    const adapterExists = adapterManager.getAdapter(result.data.adapterId);
    if (!adapterExists) {
      return problem(c, 'invalid_request', { detail: CONNECTION_NOT_FOUND });
    }

    // Validate agent exists in mesh registry
    const meshCore = adapterManager.getMeshCore();
    if (meshCore && result.data.agentId) {
      const projectPath = meshCore.getProjectPath(result.data.agentId);
      if (!projectPath) {
        return problem(c, 'invalid_request', { detail: UNKNOWN_AGENT });
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
        return chatAlreadyBound(c, err);
      }
      logger.error('[relay] creating a chat route failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t add that chat route. Try again.' });
    }
  };

  /**
   * Re-point an existing binding to a different agent (connection-scoping
   * spec §Part 2 Move semantics) — the client's answer to "This chat reaches
   * X. Move it to Y?" after a 409 above. Clears the binding's stale session
   * mappings (created under the OLD agent's project) so the next inbound
   * message starts fresh under the new one.
   */
  const moveBinding = async (c: Context<ApiEnv>): Promise<Response> => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    const result = MoveBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return validationProblem(c, result.error);
    }

    const meshCore = adapterManager.getMeshCore();
    if (meshCore && !meshCore.getProjectPath(result.data.agentId)) {
      return problem(c, 'invalid_request', { detail: UNKNOWN_AGENT });
    }

    const moved = await bindingStore.moveToAgent(c.req.param('id') ?? '', result.data.agentId);
    if (!moved) return problem(c, 'not_found', { detail: BINDING_NOT_FOUND });

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
  };

  const updateBinding = async (
    c: Context<ApiEnv>,
    stillNarrows?: (current: AdapterBinding) => boolean
  ): Promise<Response> => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) {
      return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    }

    const result = UpdateBindingRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return validationProblem(c, result.error);
    }

    // `bridge: 'room'` requires a `chatId` (spec §3.1), but a PATCH body is
    // partial — the update may set `bridge` without resending `chatId`, or
    // clear `chatId` without touching `bridge`. Checked against the MERGED
    // state, which `AdapterBindingSchema`'s own refinement cannot see because
    // it only ever validates a full object.
    const existing = bindingStore.getById(c.req.param('id') ?? '');
    if (existing) {
      const mergedBridge = result.data.bridge ?? existing.bridge;
      const mergedChatId = result.data.chatId !== undefined ? result.data.chatId : existing.chatId;
      if (!bridgeAllowsChatId({ bridge: mergedBridge, chatId: mergedChatId })) {
        return problem(c, 'invalid_request', { detail: BRIDGE_NEEDS_ONE_CHAT });
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
        return problem(c, 'invalid_request', { detail: BRIDGE_NEEDS_ONE_CHAT });
      }
      // Resolve what this binding bridges as from its persisted raw platform
      // type (DOR-907): a DM bridges private, a group/supergroup bridges as a
      // channel, a broadcast is refused precisely, and a binding with no
      // recorded type falls back to the conservative DM-only rule. Runs BEFORE
      // the lifecycle, so a refused binding is left untouched.
      const typed = bridgeChatTypeForBinding(existing.platformChatType, existing.channelType);
      if ('refusal' in typed) {
        return problem(c, typed.code, { detail: BRIDGE_REFUSAL_DETAIL[typed.code] });
      }
      const agentPath = adapterManager.getMeshCore()?.getProjectPath(existing.agentId);
      if (!agentPath) {
        return problem(c, 'invalid_request', { detail: UNKNOWN_AGENT });
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
        // The rooms domain's own table words a refusal and logs anything else.
        return sendRoomError(
          c,
          err,
          'bridge a chat route',
          () => refuseUnlessAccountOwner(honoRequestFacts(c)) === undefined
        );
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
        try {
          await bindingStore.update(existing.id, updates as BindingUpdate, stillNarrows);
        } catch (err) {
          if (err instanceof BindingChangedError) return bindingChanged(c, err);
          throw err;
        }
      }
      updated = bindingStore.getById(existing.id);
    } else {
      try {
        updated = await bindingStore.update(
          c.req.param('id') ?? '',
          updates as BindingUpdate,
          stillNarrows
        );
      } catch (err) {
        if (err instanceof BindingChangedError) return bindingChanged(c, err);
        // "One chat, one agent": changing `chatId` onto a value another binding
        // already owns is the same 409 the create path gives (see above).
        if (err instanceof BindingConflictError) {
          return chatAlreadyBound(c, err);
        }
        // The store re-validates the MERGED result independently of the
        // pre-check above (any in-process caller can reach `update`, not just
        // this route) — so a drift between the two checks lands here rather
        // than as an unhandled 500.
        logger.info('[relay] a chat route change was refused', { err });
        return problem(c, 'invalid_request', {
          detail: 'That change doesn’t fit this chat route. Check it, then try again.',
        });
      }
    }
    if (!updated) {
      return problem(c, 'not_found', { detail: BINDING_NOT_FOUND });
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
  };
  registerBindingWrites(router, adapterManager, { createBinding, moveBinding, updateBinding });

  router.delete('/bindings/:id', async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });

    // Capture binding metadata before deletion for the activity event
    const binding = bindingStore.getById(c.req.param('id'));

    const deleted = await bindingStore.delete(c.req.param('id'));
    if (!deleted) return problem(c, 'not_found', { detail: BINDING_NOT_FOUND });
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
    // Never sent: `onLimited` answers every refusal as a problem.
    message: {},
    onLimited: (c) =>
      problem(c, 'rate_limited', { detail: 'Too many tests. Wait a minute, then try again.' }),
  });

  // POST /bindings/:id/test — Synthetic routing test probe
  router.post('/bindings/:id/test', testRateLimiter, async (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) {
      return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    }

    const binding = bindingStore.getById(c.req.param('id'));
    if (!binding) {
      return problem(c, 'not_found', { detail: BINDING_NOT_FOUND });
    }

    if (binding.enabled === false) {
      return problem(c, 'chat_route_paused', {
        detail: 'This chat route is paused. Resume it to run a test.',
      });
    }

    const bindingRouter = adapterManager.getBindingRouter();
    if (!bindingRouter) {
      return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
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
      logger.error('[relay] testing a chat route failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t test that chat route. Try again.' });
    }
  });

  return router;
}
