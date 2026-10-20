/**
 * Messages held to the runtime's default level (DOR-3037): words DorkOS cannot
 * vouch for, such as a Wi-Fi sign-in's, carry `'runtime-default'` in their
 * turn's ceiling.
 *
 * Two things follow here. Their queue row is marked, so the hold survives a
 * restart and an edit (`MessageQueueStore.heldToDefault`, read at launch). And
 * they do not cut into a running turn that is looser than the hold: a running
 * turn cannot be lowered to a ceiling, so a steer joins only a turn already
 * held to the default, and a stage, which rides whatever turn runs next, never
 * does. Either one waits its turn on the queue instead.
 *
 * @module services/session/message-dispatcher/held-to-default
 */
import type { AgentRuntime, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { MessageDisposition } from '@dorkos/shared/schemas';
import { isNoLooserThan, resolveCeilingLevel } from '@dorkos/shared/permission-semantics';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';

/**
 * Whether a ceiling holds its turn to the runtime's default: it is, or lists,
 * `'runtime-default'`.
 *
 * @param ceiling - The turn's ceiling, if any.
 */
export function ceilingHoldsToDefault(ceiling: TurnPermissionCeiling | undefined): boolean {
  if (ceiling === undefined) return false;
  return Array.isArray(ceiling)
    ? ceiling.includes('runtime-default')
    : ceiling === 'runtime-default';
}

/**
 * Whether a held message may land as asked rather than queue: a steer only
 * into a turn on this session that was itself held to the default and read
 * words from outside; a stage never. Unknown levels never join.
 *
 * @param runtime - The session's runtime, for its declared modes.
 * @param sessionKey - The session's primary id, as its turns are recorded.
 * @param requested - The disposition asked for.
 */
export function heldMessageMayJoin(
  runtime: AgentRuntime,
  sessionKey: string,
  requested: Exclude<MessageDisposition, 'queue'>
): boolean {
  if (requested !== 'steer') return false;
  const running = lastTurnLevelOf(sessionKey);
  if (!running?.outsider) return false;
  try {
    const held = resolveCeilingLevel(runtime.getCapabilities().permissionModes, 'runtime-default');
    return (
      isNoLooserThan(held, running) &&
      (!running.auto || held.auto === true || held.asks === 'never')
    );
  } catch {
    return false;
  }
}
