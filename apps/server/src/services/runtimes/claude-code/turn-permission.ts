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
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
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
  return clampModeToCeiling(
    CLAUDE_CODE_CAPABILITIES.permissionModes,
    session.permissionMode,
    ceiling
  );
}
