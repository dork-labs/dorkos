/**
 * Claim-feed routes (connection-scoping spec `specs/connection-scoping/`
 * §Part 3) — list/claim/ignore/block for chats an adapter heard from with no
 * binding to route to.
 *
 * - `GET  /api/relay/unclaimed-chats?status=pending` — list (default `pending`).
 * - `POST /api/relay/unclaimed-chats/:id/claim` — create a binding onto an
 *   agent, through the SAME uniqueness-checked `BindingStore.create()` path
 *   Part 2 uses — a race against a manually created binding 409s identically.
 * - `POST /api/relay/unclaimed-chats/:id/ignore` — mute (idempotent).
 * - `POST /api/relay/unclaimed-chats/:id/block` — drop future traffic
 *   recordless (idempotent).
 *
 * @module routes/unclaimed-chats
 */
import { Router } from 'express';
import { z } from 'zod';
import { SessionStrategySchema, ChannelTypeSchema } from '@dorkos/shared/relay-schemas';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import { BindingConflictError, type BindingStore } from '../services/relay/binding-store.js';
import type { UnclaimedChatStore } from '../services/relay/unclaimed-chat-store.js';

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
}

/** Body for `POST /:id/claim` — the binding fields `claim` cannot derive from the unclaimed row. */
const ClaimRequestSchema = z.object({
  agentId: z.string().min(1),
  sessionStrategy: SessionStrategySchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  label: z.string().optional(),
});

/**
 * Create the unclaimed-chats router.
 *
 * @param deps - Injected store + binding store; see {@link UnclaimedChatsRouterDeps}.
 * @returns An Express router to mount at `/api/relay/unclaimed-chats`.
 */
export function createUnclaimedChatsRouter(deps: UnclaimedChatsRouterDeps): Router {
  const router = Router();
  const { store, bindingStore, meshCore } = deps;

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

    try {
      const binding = await bindingStore.create({
        adapterId: chat.adapterId,
        agentId: result.data.agentId,
        chatId: chat.chatId,
        ...(channelType.success && { channelType: channelType.data }),
        ...(result.data.sessionStrategy && { sessionStrategy: result.data.sessionStrategy }),
        ...(result.data.permissionMode && { permissionMode: result.data.permissionMode }),
        ...(result.data.label && { label: result.data.label }),
      });
      store.claim(chat.id, result.data.agentId);
      res.status(201).json({ binding });
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
    }
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

  return router;
}
