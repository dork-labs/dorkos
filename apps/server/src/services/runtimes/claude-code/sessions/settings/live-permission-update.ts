/** Existing bounded live mode control, after the settings choice was persisted/published. */
import type { PermissionMode, SessionSettings } from '@dorkos/shared/types';
import { actsWithoutAsking, tightensDeclaredMode } from '@dorkos/shared/permission-semantics';
import type { AgentSession } from '../../agent-types.js';
import { CLAUDE_CODE_CAPABILITIES, narrowToClaudeCodeMode } from '../../runtime-constants.js';
import { observeQueryModeChange } from '../../tool-turn/query-mode.js';
import { gatePermissionMode, isPersonOnlyMode } from '../../turn-permission.js';
import { logger } from '../../../../../lib/logger.js';
import {
  awaitControlAck,
  PERMISSION_MODE_ACK_TIMEOUT_MS,
  type ControlAck,
} from '../bounded-control.js';

/** This runtime's own mode descriptors — the only meaning any mode id has. */
const CLAUDE_MODES = CLAUDE_CODE_CAPABILITIES.permissionModes.values ?? [];

/** Start the existing control and return its exact ACK promise without an async wrapper. */
export function startLivePermissionModeUpdate(
  session: AgentSession,
  query: NonNullable<AgentSession['activeQuery']>,
  permissionMode: string
) {
  // Bounded (DOR-1301): on a session winding down, DorkOS has already
  // ended this query's stdin, so the SDK drops the write in silence and
  // returns a promise nothing will settle. Awaiting it hung the PATCH —
  // and made the best-effort catch below unreachable, since a dropped
  // write never rejects either. The clock is what makes the best-effort
  // contract true rather than merely written down.
  // Only the SDK needs the narrow name (DOR-885): a mode id is whatever its
  // runtime declared, and the session above keeps the id as asked, but a
  // query can only be moved to a mode the SDK knows. Held to the ceilings
  // the running turn and its background work carry (`warm-ceiling.ts`): a
  // person loosening this chat mid-turn never loosens a stranger's turn.
  const liveMode = narrowToClaudeCodeMode(gatePermissionMode(session), 'default');
  const settle = observeQueryModeChange(query, permissionMode, liveMode);
  const ack = awaitControlAck(
    () => query.setPermissionMode(liveMode as Parameters<typeof query.setPermissionMode>[0]),
    PERMISSION_MODE_ACK_TIMEOUT_MS
  );
  return { ack, settle };
}

/** Compute the existing pending notice synchronously at the owner's ACK resumption. */
export function finishLivePermissionModeUpdate(
  sessionId: string,
  prevMode: AgentSession['permissionMode'],
  mode: NonNullable<SessionSettings['permissionMode']>,
  ack: ControlAck,
  permissionModePendingUntilNextTurn: boolean
): boolean {
  if (ack !== 'acked') {
    // Best-effort (ADR-0261): keep the new mode even when the live query
    // refuses the change or never answers — it is already persisted
    // (write-through above) and takes effect on the next turn. Never
    // revert or re-throw, so the PATCH route does not surface a spurious
    // 422.
    logger.warn('[updateSession] live setPermissionMode did not take; applies next turn', {
      sessionId,
      mode,
      ack,
    });
    // Best-effort is fine; SILENTLY best-effort is not (DOR-1435). Keeping
    // the mode is right, and reporting it as in force is wrong — the turn
    // on `activeQuery` is still running under `prevMode`, and when that is
    // the looser of the two nothing on this side can put the approval
    // prompts back for it (the CLI skips `canUseTool` entirely under a
    // mode that never asks). Only the tightening direction is carried up:
    // see `SessionUpdateResult.permissionModePendingUntilNextTurn`.
    //
    // `prevMode` is what the SESSION was set to, which is very nearly —
    // but not exactly — what the running turn is doing: the launcher can
    // coerce `auto` down to `default` for a model that cannot do Auto
    // without writing that back (`messaging/launch-resolver.ts`), so an
    // `auto` → `default` PATCH on such a model reports pending for a turn
    // that is already running `default`. Left standing deliberately. This
    // notice deliberately compares the stored previous choice, retaining
    // that conservative unconfirmed Auto-to-Default notice.
    permissionModePendingUntilNextTurn =
      permissionModePendingUntilNextTurn || tightensDeclaredMode(CLAUDE_MODES, prevMode, mode);
  }
  return permissionModePendingUntilNextTurn;
}

/**
 * Whether a suggested mode is one DorkOS may make DURABLE off a single click on
 * an approval card.
 *
 * Two questions, both asked of the runtime's own declaration rather than of the
 * id's name. Does claude-code declare this mode at all — persisting an
 * undeclared id would make the settings overlay display a posture the runtime
 * never adopted (`PATCH /api/sessions/:id`, same check). And does it act
 * without asking (`actsWithoutAsking`): a card that says "Always Allow" over one
 * Write is not a person choosing a session that never asks again; that is a
 * choice made on the dial.
 *
 * @param mode - The mode an accepted suggestion asks for.
 */
export function isAdoptableMode(mode: PermissionMode): boolean {
  // Nor "Never ask": a click that allowed one call is not a person choosing a
  // chat that refuses everything it would ask about (DOR-2838).
  if (isPersonOnlyMode(mode)) return false;
  const descriptor = CLAUDE_CODE_CAPABILITIES.permissionModes.values.find((d) => d.id === mode);
  return descriptor !== undefined && !actsWithoutAsking(descriptor);
}
