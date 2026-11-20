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
import type { BindingChangedError } from '../services/relay/binding-store.js';
import { readJsonBody } from '../http/request-body.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { cardConnection, type CardConnection } from './relay-adapter-http.js';
import { chatModeWord } from '@dorkos/shared/permissions';
import type {
  AgentRaiseChange,
  AgentRaiseEffect,
  AgentRaiseWrite,
} from '../services/core/approvals/agent-raise/agent-raise-cards.js';

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
  run: () => Promise<Response>,
  agentCard?: () => Pick<AgentRaiseWrite, 'effect' | 'run'>
): Promise<Response> {
  if (!raises) return run();
  return runFrontDoorWrite(c, {
    kind: 'relay.binding',
    ...held,
    subject: 'what a chat connection may do',
    run,
    ...(agentCard ? { agentCard } : {}),
  });
}

/** Yes or No, for a card. */
const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

/**
 * The parts of a stored chat route a raise is judged on, as one comparable value.
 * An agent's card is judged on this, and its write lands only while it matches.
 *
 * @param route - The route as stored.
 */
export function bindingRaiseState(route: AdapterBinding): string {
  return JSON.stringify([
    route.permissionMode,
    route.canInitiate,
    route.canReply,
    route.canReceive,
    route.enabled,
    route.bridge ?? null,
    route.chatId ?? null,
    route.channelType ?? null,
    route.roomId ?? null,
  ]);
}

/**
 * What a chat-route change does, read against the stored route, for an agent's
 * card (DOR-4355 M4): each field it changes, from → to. Every word comes from the
 * stored route and the fields the change names.
 *
 * @param existing - The route as stored.
 * @param body - The request body, before validation.
 * @param card - The connection as `cardConnection` names it.
 */
export function bindingUpdateEffect(
  existing: AdapterBinding,
  body: unknown,
  card: CardConnection
): AgentRaiseEffect {
  const parsed = UpdateBindingRequestSchema.safeParse(body);
  const next = parsed.success ? parsed.data : {};
  const changes: AgentRaiseChange[] = [];
  const add = (what: string, from: string, to: string) => {
    if (from !== to) changes.push({ what, from, to });
  };
  // In the app's own level words ("Ask first → Act"), never the raw mode ids.
  if (next.permissionMode !== undefined)
    add(
      'Permission level',
      chatModeWord(existing.permissionMode),
      chatModeWord(next.permissionMode)
    );
  const flags = [
    ['canInitiate', 'May start chats'],
    ['canReply', 'May reply'],
    ['canReceive', 'May receive messages'],
    ['enabled', 'Turned on'],
  ] as const;
  for (const [key, what] of flags) {
    if (next[key] !== undefined) add(what, yesNo(existing[key]), yesNo(next[key]));
  }
  if (next.bridge !== undefined) add('Shown in a room', existing.bridge ?? 'none', next.bridge);
  const filter = (value: string | null | undefined) => value ?? 'Every chat';
  if (next.chatId !== undefined) add('Which chat', filter(existing.chatId), filter(next.chatId));
  if (next.channelType !== undefined)
    add('Which kind of chat', filter(existing.channelType), filter(next.channelType));
  if (next.roomId !== undefined) add('Room', existing.roomId ?? 'none', next.roomId ?? 'none');
  return {
    summary: `Let a chat route on ${card.headline} do more.`,
    changes,
    ...(card.note ? { notes: [card.note] } : {}),
  };
}

/**
 * One chat-route write, answering as its route does. `stillNarrows`, when
 * given, is checked against the stored route inside the write.
 */
type BindingWrite = (
  c: Context<ApiEnv>,
  stillNarrows?: (current: AdapterBinding) => boolean
) => Promise<Response>;

/**
 * The 409 for a change judged on a route that has since changed (Security S5
 * on DOR-4355 M3).
 *
 * @param c - The request.
 * @param err - The store's refusal.
 */
export function bindingChanged(c: Context<ApiEnv>, err: BindingChangedError): Response {
  return c.json({ error: err.message, code: 'BINDING_CHANGED' }, 409);
}

/**
 * Mount the chat-route writes, each run at once or held for the owner when it raises.
 *
 * @param router - The adapter routes' router.
 * @param adapterManager - Where the stored route is read for a change's direction.
 * @param writes - The create, move and update handlers.
 */
export function registerBindingWrites(
  router: Hono<ApiEnv>,
  adapterManager: Pick<AdapterManager, 'getBindingStore' | 'getAdapter' | 'getManifest'>,
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
  router.patch('/bindings/:id', (c) => {
    const body = readJsonBody(c);
    const existing = adapterManager.getBindingStore()?.getById(c.req.param('id'));
    const raises = bindingUpdateRaises(existing, body);
    return holdBindingRaise(
      c,
      raises,
      {
        target: c.req.param('id'),
        input: body,
        reason: 'Let this chat connection do more, or reach more chats.',
      },
      // A free change was judged on a read: it lands only if it still raises
      // nothing against the route as stored when it writes (Security S5).
      () => updateBinding(c, raises ? undefined : (current) => !bindingUpdateRaises(current, body)),
      // An agent's raise goes on a card, judged on the route as stored now; the write
      // lands only while the route still matches, checked inside the store's write.
      existing &&
        (() => {
          const shown = bindingRaiseState(existing);
          return {
            effect: bindingUpdateEffect(
              existing,
              body,
              cardConnection(adapterManager, existing.adapterId)
            ),
            run: async () => {
              const res = await updateBinding(c, (current) => bindingRaiseState(current) === shown);
              return { status: res.status, body: await res.json() };
            },
          };
        })
    );
  });
}
