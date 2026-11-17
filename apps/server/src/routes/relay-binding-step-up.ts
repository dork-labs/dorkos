/**
 * Which chat-route writes raise what a chat connection may do, so they wait for
 * the owner to confirm it's them (DOR-4355). The reverse of each stays immediate.
 *
 * A raise is a looser permission mode, letting the agent start chats, receive or
 * reply where it could not, switching a paused route back on, bridging it into a
 * room, widening which chats it reaches, or pointing it at another chat or agent.
 * Where a write's result cannot be told, it counts as a raise.
 *
 * @module routes/relay-binding-step-up
 */
import type { Context, Hono } from 'hono';
import {
  CreateBindingRequestSchema,
  UpdateBindingRequestSchema,
  type AdapterBinding,
} from '@dorkos/shared/relay-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { modeRaises } from '../services/core/auth/sessions/wifi-raise-guard.js';
import { CLAUDE_CODE_CAPABILITIES } from '../services/runtimes/claude-code/runtime-constants.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { readJsonBody } from '../http/request-body.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** The mode ids a route carries are DorkOS's own; Claude Code declares every one of them. */
const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;

/**
 * Whether a change to a chat filter widens it: clearing it reaches every chat, and
 * changing it points the route elsewhere. Adding one where there was none narrows.
 *
 * @param after - The filter asked for; `undefined` leaves it, `null` clears it.
 * @param before - The filter as stored.
 */
function widensFilter(after: string | null | undefined, before: string | undefined): boolean {
  if (after === undefined || after === before) return false;
  return before !== undefined;
}

/**
 * Whether a new route's permission mode is looser than the default.
 *
 * @param mode - The mode asked for, or none.
 */
export function modeStartsLooser(mode: string | undefined): boolean {
  return mode !== undefined && modeRaises(MODES, 'default', mode);
}

/**
 * Whether a new chat route starts looser than a route's defaults.
 *
 * @param body - The request body, before validation.
 */
export function bindingCreateRaises(body: unknown): boolean {
  const parsed = CreateBindingRequestSchema.safeParse(body);
  if (!parsed.success) return false;
  const next = parsed.data;
  return (
    modeStartsLooser(next.permissionMode) || next.canInitiate === true || next.bridge === 'room'
  );
}

/**
 * Whether a change to a chat route raises what it may do.
 *
 * @param existing - The route as stored, or `undefined` when there is none.
 * @param body - The request body, before validation.
 */
export function bindingUpdateRaises(existing: AdapterBinding | undefined, body: unknown): boolean {
  const parsed = UpdateBindingRequestSchema.safeParse(body);
  if (!parsed.success || !existing) return false;
  const next = parsed.data;
  const turnsOn = (after: boolean | undefined, before: boolean) => after === true && !before;
  return (
    (next.permissionMode !== undefined &&
      modeRaises(MODES, existing.permissionMode, next.permissionMode)) ||
    turnsOn(next.canInitiate, existing.canInitiate) ||
    turnsOn(next.canReply, existing.canReply) ||
    turnsOn(next.canReceive, existing.canReceive) ||
    turnsOn(next.enabled, existing.enabled) ||
    (next.bridge === 'room' && existing.bridge !== 'room') ||
    widensFilter(next.chatId, existing.chatId) ||
    widensFilter(next.channelType, existing.channelType) ||
    (next.roomId !== undefined && next.roomId !== existing.roomId)
  );
}

/**
 * Run a chat-route write now, or hold it for the owner when it raises.
 *
 * @param c - The request asking for the write.
 * @param raises - Whether the write raises what the route may do.
 * @param held - What the hold records and the sheet says.
 * @param run - The write, with its own answer.
 */
export function holdBindingRaise(
  c: Context<ApiEnv>,
  raises: boolean,
  held: { target: string; input: unknown; reason: string },
  run: () => Promise<Response>
): Promise<Response> {
  if (!raises) return run();
  return runFrontDoorWrite(c, {
    kind: 'relay.binding',
    ...held,
    subject: 'what a chat connection may do',
    run,
  });
}

/** One chat-route write, answering as its route does. */
type BindingWrite = (c: Context<ApiEnv>) => Promise<Response>;

/**
 * Mount the chat-route writes, each run at once or held for the owner when it raises.
 *
 * @param router - The adapter routes' router.
 * @param adapterManager - Where the stored route is read for a change's direction.
 * @param writes - The create, move and update handlers.
 */
export function registerBindingWrites(
  router: Hono<ApiEnv>,
  adapterManager: Pick<AdapterManager, 'getBindingStore'>,
  writes: { createBinding: BindingWrite; moveBinding: BindingWrite; updateBinding: BindingWrite }
): void {
  const { createBinding, moveBinding, updateBinding } = writes;
  router.post('/bindings', (c) =>
    holdBindingRaise(
      c,
      bindingCreateRaises(readJsonBody(c)),
      {
        target: 'new-binding',
        input: readJsonBody(c),
        reason: 'Let a chat connection do more than a new one does by default.',
      },
      () => createBinding(c)
    )
  );
  // Pointing a chat at another agent is always held: it decides who answers that chat.
  router.post('/bindings/:id/move', (c) =>
    holdBindingRaise(
      c,
      true,
      {
        target: c.req.param('id'),
        input: readJsonBody(c),
        reason: 'Point this chat connection at another agent.',
      },
      () => moveBinding(c)
    )
  );
  router.patch('/bindings/:id', (c) =>
    holdBindingRaise(
      c,
      bindingUpdateRaises(
        adapterManager.getBindingStore()?.getById(c.req.param('id')),
        readJsonBody(c)
      ),
      {
        target: c.req.param('id'),
        input: readJsonBody(c),
        reason: 'Let this chat connection do more, or reach more chats.',
      },
      () => updateBinding(c)
    )
  );
}
