/**
 * Claim-feed routes (connection-scoping spec `specs/connection-scoping/`
 * §Part 3) — list/claim/ignore/block for chats an adapter heard from with no
 * binding to route to.
 *
 * - `GET  /api/relay/unclaimed-chats?status=pending` — list (default `pending`).
 * - `POST /api/relay/unclaimed-chats/:id/claim` — create a binding onto an
 *   agent, through the SAME uniqueness-checked `BindingStore.create()` path
 *   Part 2 uses — a race against a manually created binding 409s identically.
 *   `{ bridge: true }` is the claim card's primary action, "Answer in a
 *   channel" (chats-as-channels spec §3.1, task 2.1): the SAME
 *   `BridgeLifecycle.bridge()` path the "Bridge to a channel" action
 *   (DOR-878) uses, called with the binding this claim just created — there
 *   is no second create path. Omitted or `false` is "Answer privately",
 *   today's session-per-chat behaviour, unchanged.
 * - `POST /api/relay/unclaimed-chats/:id/ignore` — mute (idempotent).
 * - `POST /api/relay/unclaimed-chats/:id/block` — drop future traffic
 *   recordless (idempotent).
 * - `POST /api/relay/unclaimed-chats/:id/leave` — the group-add claim flow's
 *   "Leave" action (DOR-883, spec §12, design-decisions D-3 item 4): calls
 *   the platform's own leave, through the adapter, and writes NO room and NO
 *   binding — a real removal, not a mute. 501 when the adapter behind this
 *   chat cannot leave a chat (every adapter except Telegram today).
 *
 * @module routes/unclaimed-chats
 */
import { Router } from 'express';
import { z } from 'zod';
import { SessionStrategySchema, ChannelTypeSchema } from '@dorkos/shared/relay-schemas';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import { BindingConflictError, type BindingStore } from '../services/relay/binding-store.js';
import type { UnclaimedChatStore } from '../services/relay/unclaimed-chat-store.js';
import type { BridgeLifecycle } from '../services/relay/chat-bridge/index.js';
import { RoomError } from '../services/rooms/room-errors.js';
import { bridgeChatTypeForBinding } from './relay-adapters.js';

/** Minimal mesh lookup the claim route needs to validate an agent exists. */
export interface UnclaimedChatsMeshLike {
  getProjectPath(agentId: string): string | undefined;
}

/** Constructor dependencies for {@link createUnclaimedChatsRouter}. */
export interface UnclaimedChatsRouterDeps {
  /** The durable claim-feed store. */
  store: UnclaimedChatStore;
  /** Where `claim` creates the resulting binding. */
  bindingStore: BindingStore;
  /** Optional mesh lookup to validate `agentId` before claiming. */
  meshCore?: UnclaimedChatsMeshLike;
  /**
   * The bridge lifecycle coordinator (DOR-878) — required for the claim
   * card's "Answer in a channel" primary action (spec §3.1, task 2.1). Wired
   * only when the binding subsystem supports bridging. A claim that asks for
   * `bridge: true` with no lifecycle wired still claims the chat (today's
   * "Answer privately" behaviour) and reports that the channel could not be
   * created, rather than failing the claim.
   */
  lifecycle?: BridgeLifecycle;
  /**
   * Leave a chat on its platform — the group-add claim flow's "Leave" action
   * (DOR-883). Optional: an install whose adapter cannot leave a chat (every
   * adapter except Telegram today) still lists, claims, ignores, and blocks;
   * only `/leave` itself answers 501.
   *
   * @param adapterId - The adapter instance the chat lives on.
   * @param chatId - The platform chat id to leave.
   */
  leaveChat?: (adapterId: string, chatId: string) => Promise<void>;
}

/** Body for `POST /:id/claim` — the binding fields `claim` cannot derive from the unclaimed row. */
const ClaimRequestSchema = z.object({
  agentId: z.string().min(1),
  sessionStrategy: SessionStrategySchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  label: z.string().optional(),
  /** See {@link module:routes/unclaimed-chats}'s `POST /:id/claim` doc. */
  bridge: z.boolean().optional(),
});

/**
 * Create the unclaimed-chats router.
 *
 * @param deps - Injected store + binding store; see {@link UnclaimedChatsRouterDeps}.
 * @returns An Express router to mount at `/api/relay/unclaimed-chats`.
 */
export function createUnclaimedChatsRouter(deps: UnclaimedChatsRouterDeps): Router {
  const router = Router();
  const { store, bindingStore, meshCore, lifecycle, leaveChat } = deps;

  router.get('/', (req, res) => {
    const statusParam = req.query.status;
    const status =
      typeof statusParam === 'string' &&
      ['pending', 'claimed', 'ignored', 'blocked'].includes(statusParam)
        ? (statusParam as 'pending' | 'claimed' | 'ignored' | 'blocked')
        : 'pending';
    res.json({ chats: store.list(status) });
  });

  router.post('/:id/claim', async (req, res) => {
    const chat = store.getById(req.params.id);
    if (!chat) {
      res.status(404).json({ error: 'Unclaimed chat not found' });
      return;
    }
    const result = ClaimRequestSchema.safeParse(req.body ?? {});
    if (!result.success) {
      res.status(400).json({ error: 'Validation failed', details: z.flattenError(result.error) });
      return;
    }
    if (meshCore && !meshCore.getProjectPath(result.data.agentId)) {
      res.status(400).json({ error: `Agent '${result.data.agentId}' not found in mesh registry` });
      return;
    }

    // The unclaimed row's `channelType` is subject-derived (`human-subject.ts`
    // only ever writes `'group'` or leaves it unset), so it always parses as
    // a valid `ChannelType` when present — this is a defensive narrowing, not
    // an expected failure path.
    const channelType = ChannelTypeSchema.safeParse(chat.channelType ?? undefined);

    let binding: Awaited<ReturnType<typeof bindingStore.create>>;
    try {
      binding = await bindingStore.create({
        adapterId: chat.adapterId,
        agentId: result.data.agentId,
        chatId: chat.chatId,
        ...(channelType.success && { channelType: channelType.data }),
        // Carry the raw platform chat type from the sighting onto the binding,
        // so the "Bridge to a channel" action can later tell a real group from
        // a broadcast without a live probe (DOR-907). Null on the row (an
        // adapter that reported none, or a pre-migration sighting) is simply
        // omitted — the binding then has no platform type, and the bridge
        // action falls back to its conservative DM-only rule.
        ...(chat.platformChatType && { platformChatType: chat.platformChatType }),
        ...(result.data.sessionStrategy && { sessionStrategy: result.data.sessionStrategy }),
        ...(result.data.permissionMode && { permissionMode: result.data.permissionMode }),
        ...(result.data.label && { label: result.data.label }),
      });
    } catch (err) {
      // The exact race the spec calls out: a manually created binding took
      // this chat between the card being shown and the claim being clicked.
      if (err instanceof BindingConflictError) {
        res.status(409).json({
          error: err.message,
          code: 'CHAT_ALREADY_BOUND',
          conflict: {
            bindingId: err.conflict.id,
            agentId: err.conflict.agentId,
            label: err.conflict.label,
          },
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Claim failed' });
      return;
    }
    store.claim(chat.id, result.data.agentId);

    // "Answer privately" (the default): the claim above IS the whole act,
    // unchanged from before this task.
    if (!result.data.bridge) {
      res.status(201).json({ binding });
      return;
    }

    // "Answer in a channel" (spec §3.1, task 2.1): claim, binding, and bridge
    // in one call, through the SAME `BridgeLifecycle.bridge()` path task 1.14
    // (DOR-878) already uses — there is no second create path to keep
    // honest. The claim above already stands on its own as "Answer
    // privately", so a bridge failure below degrades to that rather than
    // leaving anything half-built: the binding keeps `bridge: 'off'`, and the
    // reason rides alongside it as `bridgeError` rather than failing the
    // claim (spec §3.1).
    if (!lifecycle) {
      res.status(201).json({
        binding,
        bridgeError:
          'Channels are not available on this install, so this chat was answered privately instead.',
      });
      return;
    }

    const typed = bridgeChatTypeForBinding(binding.platformChatType, binding.channelType);
    if ('refusal' in typed) {
      res.status(201).json({ binding, bridgeError: typed.refusal });
      return;
    }

    const agentPath = meshCore?.getProjectPath(result.data.agentId);
    if (!agentPath) {
      res.status(201).json({
        binding,
        bridgeError: `Agent '${result.data.agentId}' not found in mesh registry`,
      });
      return;
    }

    try {
      await lifecycle.bridge({
        adapterId: binding.adapterId,
        chatId: chat.chatId,
        bindingId: binding.id,
        agentId: result.data.agentId,
        chatType: typed.chatType,
        channelType: typed.channelType,
        // Prefer the sighting's own platform title over the raw chat id — the
        // only reason the claim route (unlike the PATCH-based "Bridge to a
        // channel" toggle in `relay-adapters.ts`) can afford to: `chat` is
        // this row's own unclaimed-chat sighting, still in hand here, and it
        // carries `chatTitle` off the adapter's payload (`extractChannelName`
        // in `inbound.ts`) whenever the platform gave one — a group's real
        // name rather than its numeric chat id. `createBridgedRoom` sanitizes
        // it at creation (`room-service.ts`'s own doc comment), so this is
        // the raw value on purpose.
        title: binding.label || chat.chatTitle || chat.chatId,
        agentPath,
      });
    } catch (err) {
      const message =
        err instanceof RoomError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Bridge failed';
      res.status(201).json({ binding, bridgeError: message });
      return;
    }

    // The lifecycle flipped `bridge`/`roomId` on the binding; read it back so
    // the response carries the room the person is about to land in.
    const bridged = bindingStore.getById(binding.id) ?? binding;
    res.status(201).json({ binding: bridged });
  });

  router.post('/:id/ignore', (req, res) => {
    const chat = store.getById(req.params.id);
    if (!chat) {
      res.status(404).json({ error: 'Unclaimed chat not found' });
      return;
    }
    store.ignore(chat.id);
    res.status(204).end();
  });

  router.post('/:id/block', (req, res) => {
    const chat = store.getById(req.params.id);
    if (!chat) {
      res.status(404).json({ error: 'Unclaimed chat not found' });
      return;
    }
    store.block(chat.id);
    res.status(204).end();
  });

  router.post('/:id/leave', async (req, res) => {
    const chat = store.getById(req.params.id);
    if (!chat) {
      res.status(404).json({ error: 'Unclaimed chat not found' });
      return;
    }
    if (!leaveChat) {
      res.status(501).json({ error: 'This adapter cannot leave a chat on its platform yet.' });
      return;
    }
    try {
      // The platform call runs BEFORE the row is touched: if it throws, the
      // card stays exactly as it was — visible, still pending — rather than
      // silently hiding a chat the bot never actually left.
      await leaveChat(chat.adapterId, chat.chatId);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Leave failed' });
      return;
    }
    // Leaving is stronger than Block, not a second name for it: the bot is no
    // longer in the chat at all, so nothing further CAN arrive. `block` is the
    // one existing status that already means "stop recording this chat" — no
    // new status is needed to say a platform-level thing the store never has
    // to enforce itself.
    store.block(chat.id);
    res.status(204).end();
  });

  return router;
}
