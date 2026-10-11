/**
 * The mode a Claude Code turn really runs at once its per-turn ceiling is
 * applied (spec `trusted-by-default-flip` §4, "power flows downstream, never
 * up").
 *
 * A session's `permissionMode` is the level a person chose for the
 * conversation. A turn another agent's post or a stranger's message started may
 * carry a lower ceiling (`MessageOpts.permissionCeiling`), and that turn runs at
 * the stricter of the two without the session's choice being rewritten. Every
 * reader that decides what a turn may do asks here: the launch (which sets the
 * SDK's mode, and through the warm process's fingerprint moves a live process
 * down and back up), the tool-approval callback, and `session_start`'s ceiling.
 *
 * @module services/runtimes/claude-code/turn-permission
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from './runtime-constants.js';

/**
 * The mode this turn runs at: the session's own mode, held to the turn's
 * ceiling when it carries one.
 *
 * @param session - The session's chosen mode and the current turn's ceiling.
 */
export function turnPermissionMode<M extends string | undefined>(session: {
  permissionMode: M;
  turnPermissionCeiling?: TurnPermissionCeiling;
}): M | string {
  const ceiling = session.turnPermissionCeiling;
  if (ceiling === undefined || session.permissionMode === undefined) return session.permissionMode;
  return clampClaudeMode(session.permissionMode, ceiling);
}

/**
 * One Claude Code mode held to one ceiling, by what each mode declares.
 *
 * `dontAsk` is the one mode the SDK takes that DorkOS does not declare, so the generic clamp has
 * nothing to weigh it by and would fall back to the runtime's default, which ASKS: looser than a
 * mode that runs only what the agent's own allow rules permit and refuses everything else. So
 * wherever a ceiling admits the default it admits `dontAsk` too, and a stranger's turn keeps an
 * agent set to `dontAsk` there (spec `official-community-space` D10, D11). Under a stricter
 * ceiling, such as another agent's Plan, it is clamped like any other mode.
 *
 * @param mode - The mode a person chose for the conversation.
 * @param ceiling - The ceiling the turn or its background work carries.
 */
export function clampClaudeMode(mode: string, ceiling: TurnPermissionCeiling): string {
  const declared = CLAUDE_CODE_CAPABILITIES.permissionModes;
  if (mode === 'dontAsk' && clampModeToCeiling(declared, 'default', ceiling) === 'default')
    return mode;
  return clampModeToCeiling(declared, mode, ceiling);
}

/** A session's chosen mode with both ceilings the tool gate reads. */
export interface CeilingedMode<M extends string | undefined> {
  /** The mode a person chose for the conversation. */
  permissionMode: M;
  /** This turn's ceiling, assigned on every send. */
  turnPermissionCeiling?: TurnPermissionCeiling;
  /** The ceiling background work an earlier ceilinged turn left running carries. */
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}

/**
 * The mode the TOOL GATE answers at, read at call time: {@link turnPermissionMode},
 * further held to the ceiling a stranger's (or another agent's) earlier turn left on
 * background work that may still be running in the warm process.
 *
 * Apart from the launch on purpose. The launch sets the mode of the turn about to
 * run; a helper or shell an earlier, ceilinged turn started keeps calling the gate
 * after that turn ended, including while the next turn waits to restart the
 * process, and must not be answered at the next turn's looser level.
 *
 * @param session - The session's chosen mode, this turn's ceiling, and the
 *   ceiling still carried by background work.
 */
export function gatePermissionMode<M extends string | undefined>(
  session: CeilingedMode<M>
): M | string {
  const mode = turnPermissionMode(session);
  const carried = session.backgroundPermissionCeiling;
  if (carried === undefined || mode === undefined) return mode;
  return clampClaudeMode(mode, carried);
}

/**
 * Whether anything the gate answers right now is held to a ceiling: this turn,
 * or background work an earlier ceilinged turn left running.
 *
 * @param session - This turn's ceiling and the one background work carries.
 */
export function heldToACeiling(session: {
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}): boolean {
  return (
    session.turnPermissionCeiling !== undefined || session.backgroundPermissionCeiling !== undefined
  );
}

/**
 * Both ceilings at once, as one list ceiling every bound of which holds. Either
 * may be absent; identical bounds are kept once.
 *
 * @param a - One ceiling.
 * @param b - Another.
 */
export function bothCeilings(
  a: TurnPermissionCeiling | undefined,
  b: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const list = (c: TurnPermissionCeiling): readonly TurnPermissionBound[] =>
    Array.isArray(c) ? c : [c as TurnPermissionBound];
  // Deduplicated, so a run of ceilinged turns over long-lived work stays one short list.
  const bounds = new Map([...list(a), ...list(b)].map((bound) => [JSON.stringify(bound), bound]));
  return bounds.size === 1 ? [...bounds.values()][0]! : [...bounds.values()];
}

/**
 * What bounds the tool gate right now: `'none'`, `'held'` for a ceiling ({@link heldToACeiling}),
 * or `'stranger'` when this turn's ceiling, or the one background work carries, holds the
 * `runtime-default` bound only a message from off this machine sets (spec
 * `official-community-space` D10). Under a stranger's, the read-only tools the CLI asks about
 * (a file outside the agent's folder, a web page) need a person, as the mode that asks would.
 *
 * @param session - This turn's ceiling and the one background work carries.
 */
export function ceilingOn(session: {
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}): 'none' | 'held' | 'stranger' {
  const stranger = (ceiling: TurnPermissionCeiling | undefined) =>
    ceiling !== undefined &&
    (Array.isArray(ceiling) ? ceiling.includes('runtime-default') : ceiling === 'runtime-default');
  if (stranger(session.turnPermissionCeiling) || stranger(session.backgroundPermissionCeiling))
    return 'stranger';
  return heldToACeiling(session) ? 'held' : 'none';
}
