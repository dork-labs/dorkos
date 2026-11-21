/** Final runtime options; pure synchronous projection after protected authority is claimed. */
import { joinSeatCarry } from '../../rooms/handoff/seat-message-prompt.js';
import type { DispatchHoldHandshake, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import type { TriggerTurnOpts } from '../trigger-turn.js';
import type { AsideCarry } from '../../rooms/room-trigger/aside.js';

/** Preserve ordinary turn options while adding the immutable handoff carry. */
export function dispatchOptions(
  opts: TriggerTurnOpts,
  additionalContext: AdditionalContext,
  snapshot: Pick<
    TriggerTurnOpts,
    | 'cwd'
    | 'roomTurn'
    | 'systemPromptAppend'
    | 'additionalDirectories'
    | 'accountHint'
    | 'clientId'
    | 'settings'
  > & {
    handoffCarry?: AsideCarry;
    dispatchHold?: DispatchHoldHandshake;
  }
): MessageOpts {
  const {
    cwd,
    roomTurn,
    systemPromptAppend,
    additionalDirectories,
    accountHint,
    clientId,
    settings,
    handoffCarry,
    dispatchHold,
  } = snapshot;
  return {
    ...(opts.turnStarter !== undefined ? { turnStarter: opts.turnStarter } : {}),
    // Conditional, on the same idiom as the three below it. A turn with no
    // opinion about its directory must hand the runtime NO cwd, not a `cwd`
    // key holding `undefined`: the session route takes care not to stamp one
    // (`routes/sessions.ts`, the `default` rung), and an unconditional key
    // here quietly undid that one layer down. Every runtime already reads
    // this as `!== undefined`, so nothing downstream changes behavior.
    ...(cwd !== undefined ? { cwd } : {}),
    additionalContext,
    // **Unconditional, `undefined` included.** A runtime that honours this
    // has to be able to CLEAR it: a marker set on a room turn and never
    // cleared would make every later direct turn in that session write to a
    // channel, so a person's own `open_canvas` would land in a room they are
    // not looking at. Absent-versus-undefined is not a distinction any
    // runtime draws here, and passing it always is what makes the clearing
    // path exist at all.
    roomTurn,
    ...(opts.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
    ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
    ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    ...(accountHint !== undefined ? { accountHint } : {}),
    ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    // A protected message comes from a server-owned source, never a person typing, so nobody is watching this turn
    // for an approval card and it must not hold for one (spec
    // `agent-permissions` D6). The card still reaches the inbox, and the
    // verdict wakes the session.
    ...(opts.privateReceiptId !== undefined || opts.unattended === true
      ? { unattendedApprovals: true }
      : {}),
    ...(opts.unattended === true ? { unattended: true } : {}),
    // Where the turn happens, for its context record only: a beat's chat and
    // a to-do's run are named by the client id their launchers dispatch under.
    ...(clientId === 'heartbeat' ? { contextPlace: 'heartbeat' as const } : {}),
    ...(clientId === 'todos' ? { contextPlace: 'task' as const } : {}),
    ...settings,
    // After `settings`, and it cannot collide with it: that type has no
    // permission key. See the field's docblock for why it is not in there.
    ...(opts.newSessionPermissionMode !== undefined
      ? { permissionMode: opts.newSessionPermissionMode }
      : {}),
    ...((handoffCarry?.permissionCeiling ?? opts.permissionCeiling) !== undefined
      ? { permissionCeiling: handoffCarry?.permissionCeiling ?? opts.permissionCeiling }
      : {}),
    ...(opts.continuationHold ? { continuationHold: true as const } : {}),
    ...(opts.carriedMarks?.outsider === true ||
    handoffCarry?.outsider ||
    handoffCarry?.externalAuthor
      ? { carriedMarks: { outsider: true as const } }
      : {}),
    ...(dispatchHold !== undefined ? { dispatchHold } : {}),
  };
}

/** Join immutable protected carry with current constraints without manufacturing a new cap. */
export function joinProtectedHandoffCarry(
  opts: Pick<TriggerTurnOpts, 'permissionCeiling' | 'carriedMarks'>,
  saved: AsideCarry | undefined
): AsideCarry | undefined {
  if (!saved) return undefined;
  if (Array.isArray(opts.permissionCeiling) && opts.permissionCeiling.length === 0) {
    throw new Error('Empty current ceiling is unsupported for handoff notices.');
  }
  return joinSeatCarry(saved, {
    externalAuthor: false,
    ...(opts.permissionCeiling !== undefined ? { permissionCeiling: opts.permissionCeiling } : {}),
    ...(opts.carriedMarks?.outsider ? { outsider: true } : {}),
  });
}
